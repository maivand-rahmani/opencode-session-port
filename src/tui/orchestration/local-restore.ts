/**
 * Local-first 0.1.7 restore flow.
 *
 * This module owns the complete local restore lifecycle so one authenticated
 * password can be reused for the encrypted recovery backup:
 *
 * 1. `session.import` capability is probed by the caller before this flow.
 * 2. Up to three password attempts authenticate the existing artifact. Only
 *    the stable `authentication-failed` code is retried.
 * 3. The authenticated JSON is strictly parsed. The ORIGINAL payload is planned
 *    with the real `planRestore` BEFORE any reference is stripped, so a
 *    malformed/unsupported graph fails closed instead of being silently
 *    flattened into something importable.
 * 4. The destination snapshot and the cross-project collision inventory are
 *    read once. Only then are importable sources flattened with
 *    `prepareStandaloneRecord` and planned again, which derives every target
 *    session/message ID from the authenticated artifact identity.
 * 5. A complete global metadata-only reference inventory is passed to the
 *    replacement executor. An incomplete global inventory downgrades every
 *    replace to copy; a collision-inventory failure still aborts preflight.
 * 6. `runRestoreReplacementExecution` freezes the preview, obtains explicit
 *    confirmation, verifies each candidate by full readback, writes an
 *    encrypted recovery artifact of the FULL current destination baseline,
 *    authenticates that file back with the same password, and only then may
 *    delete one confirmed old target.
 *
 * The password bytes stay flow-owned from the successful authentication until
 * the recovery port has finished; every path best-effort zeroes them in
 * `finally`. No password string, environment variable, log, or plaintext
 * temporary file is created. Recovery plaintext is staged only in memory by
 * the existing crypto boundary.
 */

import {
	encodeJson,
	type ByteSource,
	type CheckpointCryptoFactory,
	type CheckpointPayload,
	type CryptoPolicy,
	type SessionRecord,
} from "../../core/contracts/index.ts";
import {
	fingerprintSessionRecord,
	planRestore,
	prepareStandaloneRecord,
	type RemappedIdDeriver,
} from "../../core/restore/index.ts";
import type { SessionImportAdapter } from "../adapters/index.ts";
import {
	runRestoreReplacementExecution,
	type ReplacementDeletePort,
	type ReplacementRecoveryPort,
	type ReplacementReferenceInventory,
	type RestoreReplacementExecutionResult,
	type RestoreReplacementPreview,
	type RestoreReplacementReport,
	type StandaloneRestorePlanEntry,
} from "./newreplacement-execution.ts";
import { isAuthenticationFailure, RESTORE_PASSWORD_ATTEMPT_LIMIT } from "./restore-auth.ts";
import {
	asOneShotByteSource,
	isRecordValue,
	requireCallable,
	requireNonEmptyString,
	zeroPasswordBestEffort,
	type PasswordProvider,
} from "./shared.ts";

/* ------------------------------------------------------------------------- */
/* Public types                                                              */
/* ------------------------------------------------------------------------- */

/** UI port; the designer-owned dialog is structurally compatible. */
export interface LocalRestoreUiPort {
	confirm(preview: RestoreReplacementPreview): Promise<boolean>;
	report(result: RestoreReplacementReport): Promise<void>;
}

/** Explicit, fully injected local-restore dependencies. No defaults are applied. */
export interface LocalRestoreInput {
	readonly artifactPath: string;
	readonly destinationProjectID: string;
	readonly targetDirectory: string;
	readonly cryptoFactory: CheckpointCryptoFactory;
	readonly cryptoPolicy: CryptoPolicy;
	readonly readEncryptedArtifact: (targetPath: string) => ByteSource;
	readonly requestPassword: PasswordProvider;
	/** Complete destination snapshot for the already-resolved project ID. */
	readonly readDestination: (projectID: string) => Promise<readonly SessionRecord[]>;
	/** Cross-project metadata-only session-ID collision inventory. */
	readonly readGloballyVisibleSessionIDs: () => Promise<readonly string[]>;
	/** Exact full-record read using session.get plus bounded message.list. */
	readonly readSession: (sessionID: string) => Promise<SessionRecord | undefined>;
	/** One complete/incomplete global incoming-reference inventory read. */
	readonly readReferenceInventory: () => Promise<ReplacementReferenceInventory>;
	readonly importer: SessionImportAdapter;
	readonly deletePortFactory: (authorizedTargetIDs: readonly string[]) => ReplacementDeletePort;
	readonly resolveRecoveryPath: (options: { readonly projectDirectory: string; readonly now: Date }) => Promise<string>;
	readonly writeEncryptedArtifact: (targetPath: string, source: ByteSource) => Promise<number>;
	readonly idDeriver: RemappedIdDeriver;
	readonly ui: LocalRestoreUiPort;
	readonly clock: () => number;
	readonly maxPasswordAttempts?: number;
}

/** Terminal local-restore outcome. */
export type LocalRestoreOutcome =
	| { readonly status: "canceled" }
	| { readonly status: "authentication-failed" }
	| { readonly status: "empty" }
	| {
			readonly status: "completed";
			readonly preview: RestoreReplacementPreview;
			readonly report: RestoreReplacementReport;
			readonly reportDisplayFailed: boolean;
	  };

/* ------------------------------------------------------------------------- */
/* Flow                                                                      */
/* ------------------------------------------------------------------------- */

/** Runs one complete local restore: auth, full preflight, preview, execution. */
export async function runLocalRestore(input: LocalRestoreInput): Promise<LocalRestoreOutcome> {
	validateInput(input);

	let password: Uint8Array | undefined;
	let authenticated: { readonly bytes: Uint8Array; readonly artifactIdentity: Uint8Array } | undefined;
	const maxAttempts = input.maxPasswordAttempts ?? RESTORE_PASSWORD_ATTEMPT_LIMIT;
	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		const candidate = await input.requestPassword("restore");
		if (candidate === undefined) return { status: "canceled" };
		if (!(candidate instanceof Uint8Array)) {
			throw new TypeError("The restore password provider must resolve with Uint8Array bytes or undefined");
		}
		try {
			const crypto = await input.cryptoFactory.create(input.cryptoPolicy);
			authenticated = await crypto.openAndStage(input.readEncryptedArtifact(input.artifactPath), candidate);
		} catch (error) {
			zeroPasswordBestEffort(candidate);
			if (!isAuthenticationFailure(error)) throw error;
			if (attempt === maxAttempts) return { status: "authentication-failed" };
			continue;
		}
		password = candidate;
		break;
	}
	if (password === undefined || authenticated === undefined) {
		return { status: "authentication-failed" };
	}

	try {
		const payload = parseStrictPayload(authenticated.bytes);
		// Capture the destination once, after full authentication/parse.
		const destination = await input.readDestination(input.destinationProjectID);
		const destinationIDs = new Set(
			destination.map((record) => record.info["id"]).filter((id): id is string => typeof id === "string"),
		);
		const collisionInventory = await input.readGloballyVisibleSessionIDs();

		// Validate the ORIGINAL graph before stripping anything. A malformed or
		// unsupported reference must fail closed here, never become valid by
		// flattening.
		const originalPlan = planRestore({
			payload,
			artifactIdentity: authenticated.artifactIdentity,
			destination,
			globallyVisibleSessionIDs: collisionInventory,
			idDeriver: input.idDeriver,
		});

		const rawByID = new Map<string, SessionRecord>();
		for (const record of payload.sessions) {
			const id = record.info["id"];
			if (typeof id !== "string" || id.length === 0) {
				throw new TypeError("The authenticated checkpoint contains a session without a usable id");
			}
			if (!rawByID.has(id)) rawByID.set(id, record);
		}
		const importSources: SessionRecord[] = [];
		for (const entry of originalPlan.importOrder) {
			const raw = rawByID.get(entry.sourceSessionID);
			if (raw === undefined) {
				throw new TypeError("The checkpoint plan referenced a session that is not in the payload");
			}
			importSources.push(prepareStandaloneRecord(raw));
		}

		// Second planning pass over the flattened/standalone payload rederives
		// every target session and message ID and resolves all remaining refs.
		const flattenedPlan = planRestore({
			payload: { sessions: importSources },
			artifactIdentity: authenticated.artifactIdentity,
			destination,
			globallyVisibleSessionIDs: collisionInventory,
			idDeriver: input.idDeriver,
		});

		const planEntries: StandaloneRestorePlanEntry[] = [];
		for (let index = 0; index < flattenedPlan.entries.length; index += 1) {
			const entry = flattenedPlan.entries[index]!;
			planEntries.push({
				// The executor treats `sourceSessionID` as an old destination target
				// and rejects source===candidate as a collision. For a verified absent
				// target the import legitimately keeps its original ID, so the internal
				// lookup token must be distinct; the preview/report display the planned
				// candidate ID when no old target exists.
				sourceSessionID: destinationIDs.has(entry.sourceSessionID)
					? entry.sourceSessionID
					: `local-absent-target-${index}-${entry.sourceSessionID}`,
				record: entry.record,
				classification: entry.classification,
				...(entry.skipReason !== undefined ? { skipReason: entry.skipReason } : {}),
			});
		}
		// Preserve exact-plaintext skip reporting without importing or deleting.
		for (const entry of originalPlan.entries) {
			if (entry.classification !== "skipped" || entry.skipReason !== "exact-local-duplicate") continue;
			planEntries.push({
				sourceSessionID: entry.sourceSessionID,
				record: entry.record,
				classification: "skipped",
				...(entry.skipReason !== undefined ? { skipReason: entry.skipReason } : {}),
			});
		}

		if (planEntries.length === 0) return { status: "empty" };

		let globalInventory: ReplacementReferenceInventory;
		try {
			globalInventory = await input.readReferenceInventory();
		} catch {
			// The bounded port already maps failures to a typed incomplete result.
			// A thrown read is treated the same way: copy only, never delete.
			globalInventory = { infos: [], complete: false };
		}
		const freshReferenceInventory = async (): Promise<ReplacementReferenceInventory> => {
			try {
				return await input.readReferenceInventory();
			} catch {
				return { infos: [], complete: false };
			}
		};

		const recovery = createEncryptedRecoveryPort({
			password,
			cryptoFactory: input.cryptoFactory,
			cryptoPolicy: input.cryptoPolicy,
			targetDirectory: input.targetDirectory,
			resolveRecoveryPath: input.resolveRecoveryPath,
			writeEncryptedArtifact: input.writeEncryptedArtifact,
			readEncryptedArtifact: input.readEncryptedArtifact,
			clock: input.clock,
		});

		// Original raw records are needed only for warning about the graph context
		// of a target that actually exists locally; including an absent import's
		// own raw record would look like a candidate-ID collision to the engine.
		const sourceRecords = [...rawByID.values()].filter((record) =>
			destinationIDs.has(record.info["id"] as string),
		);

		const result: RestoreReplacementExecutionResult = await runRestoreReplacementExecution({
			plan: { entries: planEntries },
			sourceRecords,
			destination,
			globalInventory,
			target: {
				directory: input.targetDirectory,
				projectID: input.destinationProjectID,
				canonicalProjectID: input.destinationProjectID,
			},
			confirm: async (preview) => {
				try {
					return (await input.ui.confirm(preview)) === true;
				} catch {
					return false;
				}
			},
			importer: input.importer,
			readSession: input.readSession,
			readReferenceInventory: freshReferenceInventory,
			recovery,
			deletePortFactory: input.deletePortFactory,
			clock: input.clock,
		});

		if (isConfirmationCancellation(result.report)) return { status: "canceled" };

		try {
			await input.ui.report(result.report);
			return { status: "completed", preview: result.preview, report: result.report, reportDisplayFailed: false };
		} catch {
			return { status: "completed", preview: result.preview, report: result.report, reportDisplayFailed: true };
		}
	} finally {
		// Best-effort only (A-07): clear both the flow-owned password and the
		// authenticated plaintext buffer. Parsed records are independent snapshots.
		zeroPasswordBestEffort(password);
		if (authenticated !== undefined) {
			try {
				authenticated.bytes.fill(0);
			} catch {
				// Best effort only.
			}
		}
	}
}

/* ------------------------------------------------------------------------- */
/* Recovery backup                                                           */
/* ------------------------------------------------------------------------- */

function createEncryptedRecoveryPort(input: {
	readonly password: Uint8Array;
	readonly cryptoFactory: CheckpointCryptoFactory;
	readonly cryptoPolicy: CryptoPolicy;
	readonly targetDirectory: string;
	readonly resolveRecoveryPath: LocalRestoreInput["resolveRecoveryPath"];
	readonly writeEncryptedArtifact: LocalRestoreInput["writeEncryptedArtifact"];
	readonly readEncryptedArtifact: LocalRestoreInput["readEncryptedArtifact"];
	readonly clock: () => number;
}): ReplacementRecoveryPort {
	return {
		async writeAndVerify(records: readonly SessionRecord[]) {
			try {
				if (!Array.isArray(records)) return { verified: false };
				const expectedFingerprints: string[] = [];
				for (let index = 0; index < records.length; index += 1) {
					expectedFingerprints.push(fingerprintSessionRecord(records[index]!));
				}
				const plaintext = encodeJson({ sessions: records });
				let readbackBytes: Uint8Array | undefined;
				try {
					const nowValue = input.clock();
					if (typeof nowValue !== "number" || !Number.isFinite(nowValue)) return { verified: false };
					const recoveryPath = await input.resolveRecoveryPath({
						projectDirectory: input.targetDirectory,
						now: new Date(nowValue),
					});
					const crypto = await input.cryptoFactory.create(input.cryptoPolicy);
					const sealed = await crypto.seal(asOneShotByteSource(plaintext), input.password);
					await input.writeEncryptedArtifact(recoveryPath, sealed);
					const readback = await crypto.openAndStage(
						input.readEncryptedArtifact(recoveryPath),
						input.password,
					);
					readbackBytes = readback.bytes;
					const parsed = parseRecoveryPayload(readback.bytes);
					if (parsed.length !== expectedFingerprints.length) return { verified: false };
					for (let index = 0; index < parsed.length; index += 1) {
						if (fingerprintSessionRecord(parsed[index]!) !== expectedFingerprints[index]) {
							return { verified: false };
						}
					}
					return { verified: true, path: recoveryPath };
				} finally {
					try {
						plaintext.fill(0);
						readbackBytes?.fill(0);
					} catch {
						// Best effort only.
					}
				}
			} catch {
				// The old target is kept. A file that was already written is never
				// overwritten or removed: existing artifacts are retained.
				return { verified: false };
			}
		},
	};
}

/* ------------------------------------------------------------------------- */
/* Strict parsing                                                            */
/* ------------------------------------------------------------------------- */

function parseStrictPayload(bytes: Uint8Array): CheckpointPayload {
	const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
	const value: unknown = JSON.parse(text);
	if (!isRecordValue(value) || !Array.isArray(value["sessions"])) {
		throw new TypeError("The authenticated checkpoint payload is not a session payload");
	}
	return value as unknown as CheckpointPayload;
}

function parseRecoveryPayload(bytes: Uint8Array): readonly SessionRecord[] {
	const payload = parseStrictPayload(bytes);
	const keys = Object.keys(payload as unknown as Record<string, unknown>);
	if (keys.length !== 1) throw new TypeError("The recovery payload has unexpected fields");
	return payload.sessions;
}

/* ------------------------------------------------------------------------- */
/* Validation                                                                */
/* ------------------------------------------------------------------------- */

function validateInput(input: LocalRestoreInput): void {
	if (!isRecordValue(input)) throw new TypeError("runLocalRestore requires an explicit input object");
	requireNonEmptyString(input.artifactPath, "artifactPath");
	requireNonEmptyString(input.destinationProjectID, "destinationProjectID");
	requireNonEmptyString(input.targetDirectory, "targetDirectory");
	requireCallable(input.readEncryptedArtifact, "readEncryptedArtifact");
	requireCallable(input.requestPassword, "requestPassword");
	requireCallable(input.readDestination, "readDestination");
	requireCallable(input.readGloballyVisibleSessionIDs, "readGloballyVisibleSessionIDs");
	requireCallable(input.readSession, "readSession");
	requireCallable(input.readReferenceInventory, "readReferenceInventory");
	requireCallable(input.deletePortFactory, "deletePortFactory");
	requireCallable(input.resolveRecoveryPath, "resolveRecoveryPath");
	requireCallable(input.writeEncryptedArtifact, "writeEncryptedArtifact");
	requireCallable(input.clock, "clock");
	if (!isRecordValue(input.cryptoFactory) || typeof input.cryptoFactory.create !== "function") {
		throw new TypeError("runLocalRestore requires a CheckpointCryptoFactory with create(policy)");
	}
	if (!isRecordValue(input.importer) || typeof input.importer.importSession !== "function") {
		throw new TypeError("runLocalRestore requires an importer with importSession(request)");
	}
	if (!isRecordValue(input.idDeriver) || typeof input.idDeriver.derive !== "function") {
		throw new TypeError("runLocalRestore requires a RemappedIdDeriver");
	}
	if (!isRecordValue(input.ui) || typeof input.ui.confirm !== "function" || typeof input.ui.report !== "function") {
		throw new TypeError("runLocalRestore requires ui.confirm(preview) and ui.report(report)");
	}
	if (
		input.maxPasswordAttempts !== undefined &&
		(typeof input.maxPasswordAttempts !== "number" ||
			!Number.isSafeInteger(input.maxPasswordAttempts) ||
			input.maxPasswordAttempts < 1)
	) {
		throw new TypeError("maxPasswordAttempts must be a positive safe integer when provided");
	}
}

function isConfirmationCancellation(report: RestoreReplacementReport): boolean {
	if (report.entries.length === 0) return false;
	return report.entries.every(
		(entry) => entry.outcome === "skipped" && entry.reason === "confirmation-cancelled",
	);
}
