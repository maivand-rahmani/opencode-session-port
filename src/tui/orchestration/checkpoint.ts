/**
 * Injected checkpoint flow (Phase 4, bounded orchestration; `fix-57`).
 *
 * `runCheckpointFlow` wires the completed Phase 2/3 core and Phase 4 adapters
 * into one testable sequence and returns only low-level structured facts:
 *
 *   collectCheckpointPayloadWithDependencies(port, { projectID, policy })
 *     → recursive owner-approved dependency closure (2026-10-18 amendment):
 *       sessions referenced by `parentID`/`fork.sessionID` (and their complete
 *       message histories) are included even when they live outside the seed
 *       project; missing/malformed/wrong-ID dependencies, unresolved
 *       references, cycles rejected by restore semantics, and cap violations
 *       fail closed before any password, path, crypto, or write step
 *     → zero sessions ⇒ `no-sessions` outcome (P-04), before the password
 *       prompt, path resolution, crypto creation, and any filesystem write
 *     → requestPassword("checkpoint")
 *       → cancel ⇒ `canceled` outcome, before path resolution and write
 *     → resolveCheckpointOutputPath({ projectDirectory, explicitPath? }) (P-15)
 *     → cryptoFactory.create(cryptoPolicy) (explicit injected policy only)
 *     → crypto.seal(asOneShotByteSource(serializeCheckpointPayload(payload)), password)
 *     → writeEncryptedArtifact(path, sealedSource)
 *
 * Password handling: the resolved `Uint8Array` is treated as flow-owned and is
 * held until `writeEncryptedArtifact` has consumed the sealed iterable (the
 * real container's KDF/framing may pull the plaintext lazily), then
 * best-effort zeroed in `finally` on success and every failure path. There is
 * no plaintext fallback, no plaintext temp file (A-03), and no secure-deletion
 * promise (A-07).
 *
 * Truthful outcomes: only `no-sessions`, `canceled`, and `written` are
 * returned. Collection, path, crypto, and write failures propagate unchanged
 * (for example `SessionCollectionError`, `CryptoContainerError`, `EEXIST`,
 * `ArtifactFileError`) so an error, cancel, or empty collection can never be
 * reported as a created artifact. No O-15 report/UX format is produced here —
 * the caller owns the final report.
 *
 * Policy boundaries (all still OPEN; nothing inferred):
 * - O-01/O-02/O-03: no production numeric policy, format, or cap exists in
 *   this module. `CryptoPolicy` and the `CheckpointCryptoFactory` are injected
 *   by the caller; tests use clearly test-only fakes.
 * - O-10 (2026-10-18 amendment): collection starts from the existing
 *   project-scoped enumeration and adds no unrelated-project scan; only
 *   recursively referenced `parentID`/`fork.sessionID` dependencies (and each
 *   dependency's complete message history) are additionally fetched through
 *   the port's `getSession`. Child-association semantics beyond the
 *   schema-referenced closure remain OPEN.
 * - O-15: report formats remain OPEN; only path/session-count/encrypted-byte
 *   facts cross this boundary.
 * - P-15/O-08: the path itself comes from the injected
 *   `resolveCheckpointOutputPath`; this module never invents a path and never
 *   overwrites an existing artifact.
 *
 * Evidence boundary: exercised only by fake ports, fake password providers,
 * fake crypto factories, and fake store functions. Dependency-closure
 * behavior (external referenced sessions) is covered synthetically only; no
 * real host call, filesystem write, KDF, or import is performed by this lane,
 * and no runtime or compatibility claim follows.
 */

import {
	collectCheckpointPayloadWithDependencies,
	serializeCheckpointPayload,
	type SessionCollectionPolicy,
	type SessionDependencyReadPort,
} from "../../core/sessions/index.ts";
import type { ByteSource, CheckpointCryptoFactory, CryptoPolicy } from "../../core/contracts/index.ts";
import type { ResolveCheckpointOutputPathOptions } from "../artifacts/files.ts";
import {
	asOneShotByteSource,
	isRecordValue,
	requireCallable,
	requireNonEmptyString,
	zeroPasswordBestEffort,
	type PasswordProvider,
} from "./shared.ts";

/** Explicit, fully injected checkpoint dependencies. Every field is required; no defaults exist. */
export interface CheckpointFlowInput {
	/** Explicit project scope for collection; the collector re-validates it and never resolves "current". */
	readonly projectID: string;
	/** Current project directory used by the P-15 path policy (default `.sessionport/` location). */
	readonly projectDirectory: string;
	/** Explicit collection bounds; no defaults are applied (O-03). */
	readonly policy: SessionCollectionPolicy;
	/** Caller-supplied crypto factory; no production factory or profile is created here. */
	readonly cryptoFactory: CheckpointCryptoFactory;
	/** Explicit allow-listed policy for `factory.create`; never taken from an artifact. */
	readonly cryptoPolicy: CryptoPolicy;
	/** Injected `resolveCheckpointOutputPath` (P-15); the real function is passed by the product wiring. */
	readonly resolveCheckpointOutputPath: (options: ResolveCheckpointOutputPathOptions) => Promise<string>;
	/** Injected `writeEncryptedArtifact`; receives already-sealed ciphertext bytes only. */
	readonly writeEncryptedArtifact: (targetPath: string, source: ByteSource) => Promise<number>;
	/** Interactive password provider; called once per run, `undefined` means canceled. */
	readonly requestPassword: PasswordProvider;
	/** Optional explicit output-path override (P-15); omitted uses the default location. */
	readonly explicitOutputPath?: string;
}

/** Low-level checkpoint outcome. No O-15 report format is implied. */
export type CheckpointOutcome =
	/** P-04: the explicit project scope returned zero sessions; nothing was prompted, resolved, or written. */
	| { readonly status: "no-sessions" }
	/** The user canceled the password prompt; nothing was resolved, encrypted, or written. */
	| { readonly status: "canceled" }
	/** The sealed artifact was written; the facts below are raw observations, not a UX report. */
	| {
			readonly status: "written";
			readonly artifactPath: string;
			readonly sessionCount: number;
			readonly encryptedBytes: number;
	  };

/**
 * Runs one checkpoint to a completed encrypted artifact or to a clear
 * no-sessions/canceled outcome. The port must provide the dependency read
 * surface (`SessionDependencyReadPort`); collection uses the
 * dependency-closure collector so schema-referenced sessions are included.
 * Errors propagate unchanged; see the module comment for the exact sequence
 * and policy boundaries.
 */
export async function runCheckpointFlow(
	port: SessionDependencyReadPort,
	input: CheckpointFlowInput,
): Promise<CheckpointOutcome> {
	if (!isRecordValue(input)) {
		throw new TypeError(
			"runCheckpointFlow requires an input object with explicit projectID, projectDirectory, policy, cryptoFactory, cryptoPolicy, resolveCheckpointOutputPath, writeEncryptedArtifact, and requestPassword",
		);
	}
	requireCallable(input.requestPassword, "requestPassword");
	requireCallable(input.resolveCheckpointOutputPath, "resolveCheckpointOutputPath");
	requireCallable(input.writeEncryptedArtifact, "writeEncryptedArtifact");
	if (!isRecordValue(input.cryptoFactory) || typeof input.cryptoFactory.create !== "function") {
		throw new TypeError("runCheckpointFlow requires a CheckpointCryptoFactory with a create(policy) function");
	}
	const projectID = requireNonEmptyString(input.projectID, "projectID");
	requireNonEmptyString(input.projectDirectory, "projectDirectory");

	const payload = await collectCheckpointPayloadWithDependencies(port, { projectID, policy: input.policy });
	if (payload.sessions.length === 0) {
		// P-04: no empty checkpoints. Nothing is prompted, resolved, encrypted, or written.
		return { status: "no-sessions" };
	}

	const password = await input.requestPassword("checkpoint");
	if (password === undefined) {
		return { status: "canceled" };
	}
	if (!(password instanceof Uint8Array)) {
		throw new TypeError("The checkpoint password provider must resolve with Uint8Array bytes or undefined");
	}

	try {
		const artifactPath = await input.resolveCheckpointOutputPath({
			projectDirectory: input.projectDirectory,
			...(input.explicitOutputPath !== undefined ? { explicitPath: input.explicitOutputPath } : {}),
		});
		const crypto = await input.cryptoFactory.create(input.cryptoPolicy);
		// `serializeCheckpointPayload` returns bytes; `seal` consumes a ByteSource,
		// so the serialized payload is handed over as a one-shot borrowed chunk.
		const sealed = await crypto.seal(asOneShotByteSource(serializeCheckpointPayload(payload)), password);
		const encryptedBytes = await input.writeEncryptedArtifact(artifactPath, sealed);
		if (typeof encryptedBytes !== "number" || !Number.isSafeInteger(encryptedBytes) || encryptedBytes < 0) {
			throw new TypeError("writeEncryptedArtifact must resolve with the exact non-negative integer byte count written");
		}
		return { status: "written", artifactPath, sessionCount: payload.sessions.length, encryptedBytes };
	} finally {
		// Best-effort only (A-07): the password is zeroed after the sealed
		// iterable has been consumed (or the write failed), never before.
		zeroPasswordBestEffort(password);
	}
}
