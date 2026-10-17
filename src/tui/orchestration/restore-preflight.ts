/**
 * Injected restore preflight (Phase 4, bounded orchestration; `fix-57`).
 *
 * `runRestorePreflight` performs capability detection, one password attempt,
 * artifact authentication, strict payload parsing, the destination snapshot,
 * the required cross-project session-ID occupancy inventory, and the pure
 * `planRestore` preflight — and then stops. It never calls an
 * importer and never touches destination history.
 *
 * Exact sequence (each step short-circuits the later ones):
 *
 *   1. `probeSessionImportCapability(client)` — the first externally
 *      observable action. If `session.import` is not callable, return a clear
 *      `capability-unavailable` outcome before the password provider, the
 *      artifact read, crypto creation, the destination snapshot, or any
 *      importer (O-12 policy).
 *   2. `requestPassword("restore")` — one attempt. `undefined` ⇒ `canceled`
 *      outcome; the artifact is not read and crypto is not created. The
 *      owner-decided three-attempt TUI loop lives in the caller, and this
 *      helper deliberately does not classify crypto rejections as wrong
 *      password versus corrupt artifact; those errors propagate unchanged.
 *   3. `readEncryptedArtifact(artifactPath)` — lazily constructs the
 *      ciphertext source (no file IO yet).
 *   4. `cryptoFactory.create(cryptoPolicy)` — explicit injected policy only.
 *   5. `crypto.openAndStage(artifact, password)` — full authentication and
 *      decompression must pass before any byte is parsed.
 *   6. Strict UTF-8 decode (`fatal: true`, no BOM stripping, no Unicode
 *      normalization) followed by `JSON.parse` to `unknown`; invalid bytes or
 *      JSON fail closed before any destination read.
 *   7. `readDestination(destinationProjectID)` — the complete destination
 *      `SessionRecord[]` snapshot, only after successful authentication and
 *      parse. The destination project ID is an explicit, caller-supplied
 *      input: a `SessionReadPort` requires a known project ID and cannot
 *      resolve an arbitrary target directory (OQ-10), so the source
 *      `info.projectID` is never substituted for the destination scope and no
 *      project/directory mapping is claimed.
 *   8. `readGloballyVisibleSessionIDs()` — one required, bounded,
 *      metadata-only cross-project session-ID inventory (owner-approved
 *      2026-10-14 amendment), invoked after authentication/parse and the
 *      destination snapshot and before planning. The returned IDs are
 *      occupancy evidence only; they can never satisfy destination references,
 *      classify an exact duplicate, or classify a retry (the planner enforces
 *      that), and a malformed inventory fails closed. Inventory errors
 *      propagate unchanged (their existing sanitized `SessionCollectionError`
 *      taxonomy) and the whole preflight stops with no import and no retry.
 *   9. `planRestore({ payload, artifactIdentity, destination,
 *      globallyVisibleSessionIDs, idDeriver })` — schema validation, canonical
 *      duplicate classification, ID remapping (including deterministic
 *      cross-project collision renames), collision/dangling-reference checks,
 *      and the parent-before-child `plan.importOrder` run to completion before
 *      anything else happens.
 *
 * The password bytes are treated as flow-owned from the provider's resolution
 * and are always best-effort zeroed in `finally` (success, auth failure,
 * parse failure, destination failure, inventory failure, or planner failure).
 * Best effort only — not secure deletion (A-07).
 *
 * Returned facts: the plan plus the explicit `targetDirectory` required by the
 * caller (O-16: V1 always supplies an explicit import target and accepts the
 * host assigning target project scope; no source `projectID`/`location`
 * preservation is claimed). `plan.importOrder` is the only import-related
 * output; no import executor, retry handling, partial-failure reporting, or
 * product command exists in this lane (O-06/O-11/O-15 remain OPEN), and the
 * adapter `createSessionImportAdapter` is deliberately not imported here.
 *
 * Evidence boundary: exercised only by fake clients, fake crypto, fake
 * artifact sources, fake destination callbacks, and a fake inventory callback.
 * No real host call, artifact read, KDF, destination enumeration, inventory
 * scan, or import is performed by this lane, and no runtime or compatibility
 * claim follows.
 */

import {
	type ByteSource,
	type CheckpointCryptoFactory,
	type CheckpointPayload,
	type CryptoPolicy,
	type SessionRecord,
} from "../../core/contracts/index.ts";
import {
	planRestore,
	type RemappedIdDeriver,
	type RestorePlan,
} from "../../core/restore/index.ts";
import { probeSessionImportCapability } from "../adapters/index.ts";
import {
	isRecordValue,
	requireCallable,
	requireNonEmptyString,
	zeroPasswordBestEffort,
	type PasswordProvider,
} from "./shared.ts";

/** Explicit, fully injected restore-preflight dependencies. Every field is required; no defaults exist. */
export interface RestorePreflightInput {
	/** Artifact path to open; passed verbatim to the injected lazy reader. */
	readonly artifactPath: string;
	/** Known destination project scope for the local snapshot; never taken from the artifact (OQ-10). */
	readonly destinationProjectID: string;
	/** Explicit import target directory the caller will use after a successful plan (O-16). */
	readonly targetDirectory: string;
	/** Caller-supplied crypto factory; no production factory or profile is created here. */
	readonly cryptoFactory: CheckpointCryptoFactory;
	/** Explicit allow-listed policy for `factory.create`; never taken from an artifact. */
	readonly cryptoPolicy: CryptoPolicy;
	/** Injected `readEncryptedArtifact`; must return a lazy ciphertext source. */
	readonly readEncryptedArtifact: (targetPath: string) => ByteSource;
	/** Interactive password provider; called once per run, `undefined` means canceled. */
	readonly requestPassword: PasswordProvider;
	/** Complete local session snapshot for the explicit destination project ID, called only after auth+parse. */
	readonly readDestination: (projectID: string) => Promise<readonly SessionRecord[]>;
	/**
	 * Required cross-project session-ID occupancy inventory (owner-approved
	 * 2026-10-14 amendment), called once after auth+parse and the destination
	 * snapshot and before planning. Production wiring must supply the bounded
	 * metadata-only inventory (`createSessionIdInventory`); this dependency is
	 * deliberately not optional, so no production path can silently skip the
	 * cross-project collision check. Errors fail the whole preflight unchanged
	 * (existing sanitized taxonomy) with no import and no retry.
	 */
	readonly readGloballyVisibleSessionIDs: () => Promise<readonly string[]>;
	/** Injected deterministic ID deriver; `planRestore` validates its outputs (O-22/OQ-24). */
	readonly idDeriver: RemappedIdDeriver;
}

/** Restore-preflight outcome; imports remain unimplemented (O-06/O-11/O-15 OPEN). */
export type RestorePreflightOutcome =
	/** O-12: `session.import` is not callable; nothing was read, decrypted, or changed. */
	| { readonly status: "capability-unavailable"; readonly reason: string }
	/** The user canceled the password prompt; the artifact was not read. */
	| { readonly status: "canceled" }
	/** Preflight completed; the caller owns the import target and any later import execution. */
	| {
			readonly status: "planned";
			readonly plan: RestorePlan;
			readonly targetDirectory: string;
	  };

/**
 * Runs one restore preflight to a completed `RestorePlan` or to a clear
 * capability-unavailable/canceled outcome. Errors (crypto rejection, invalid
 * UTF-8/JSON, destination/planner failures) propagate unchanged; see the
 * module comment for the exact sequence and policy boundaries.
 */
export async function runRestorePreflight(
	client: unknown,
	input: RestorePreflightInput,
): Promise<RestorePreflightOutcome> {
	if (!isRecordValue(input)) {
		throw new TypeError(
			"runRestorePreflight requires an input object with explicit artifactPath, destinationProjectID, targetDirectory, cryptoFactory, cryptoPolicy, readEncryptedArtifact, requestPassword, readDestination, readGloballyVisibleSessionIDs, and idDeriver",
		);
	}
	requireCallable(input.requestPassword, "requestPassword");
	requireCallable(input.readEncryptedArtifact, "readEncryptedArtifact");
	requireCallable(input.readDestination, "readDestination");
	requireCallable(input.readGloballyVisibleSessionIDs, "readGloballyVisibleSessionIDs");
	if (!isRecordValue(input.cryptoFactory) || typeof input.cryptoFactory.create !== "function") {
		throw new TypeError("runRestorePreflight requires a CheckpointCryptoFactory with a create(policy) function");
	}
	if (!isRecordValue(input.idDeriver) || typeof input.idDeriver.derive !== "function") {
		throw new TypeError("runRestorePreflight requires a RemappedIdDeriver with a derive(namespace, identity, id) function");
	}
	requireNonEmptyString(input.artifactPath, "artifactPath");
	requireNonEmptyString(input.destinationProjectID, "destinationProjectID");
	requireNonEmptyString(input.targetDirectory, "targetDirectory");

	// O-12: the capability probe is the first externally observable action.
	const probe = probeSessionImportCapability(client);
	if (!probe.available) {
		return { status: "capability-unavailable", reason: probe.reason };
	}

	const password = await input.requestPassword("restore");
	if (password === undefined) {
		return { status: "canceled" };
	}
	if (!(password instanceof Uint8Array)) {
		throw new TypeError("The restore password provider must resolve with Uint8Array bytes or undefined");
	}

	try {
		// Lazy ciphertext source: constructing it performs no IO; openAndStage pulls it.
		const artifact = input.readEncryptedArtifact(input.artifactPath);
		const crypto = await input.cryptoFactory.create(input.cryptoPolicy);
		// Full authentication and decompression must pass before any parsing.
		const authenticated = await crypto.openAndStage(artifact, password);
		const payload = parseAuthenticatedJson(authenticated.bytes);
		// The complete destination snapshot is read only after auth+parse.
		const destination = await input.readDestination(input.destinationProjectID);
		// Required cross-project session-ID occupancy inventory (2026-10-14
		// owner amendment): metadata only, after auth+parse and the destination
		// snapshot, before planning. Failures propagate unchanged with no import
		// and no retry.
		const globallyVisibleSessionIDs = await input.readGloballyVisibleSessionIDs();
		// planRestore enforces payload/destination/inventory schema and the full
		// preflight; the cast only satisfies the static boundary (the runtime
		// value is unknown).
		const plan = planRestore({
			payload: payload as CheckpointPayload,
			artifactIdentity: authenticated.artifactIdentity,
			destination,
			globallyVisibleSessionIDs,
			idDeriver: input.idDeriver,
		});
		return { status: "planned", plan, targetDirectory: input.targetDirectory };
	} finally {
		// Best-effort only (A-07); always zeroed on success and every failure path.
		zeroPasswordBestEffort(password);
	}
}

/**
 * Strict UTF-8 decode of the authenticated payload bytes, then `JSON.parse`
 * to `unknown`. `fatal: true` rejects invalid byte sequences; `ignoreBOM:
 * true` keeps a leading BOM as a character instead of silently stripping it,
 * so it fails JSON parsing rather than being normalized away. No Unicode
 * normalization is applied. Schema validation is left to `planRestore`.
 */
function parseAuthenticatedJson(bytes: Uint8Array): unknown {
	const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
	return JSON.parse(text) as unknown;
}
