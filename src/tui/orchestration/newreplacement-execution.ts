/**
 * Bounded 0.1.7 standalone restore/replacement engine.
 *
 * This module consumes one completed standalone restore plan and performs only
 * the mutations that the owner-approved 0.1.7 local policy allows:
 *
 * - A frozen preview is built before any write. It names exact destination
 *   targets (`id === plan.sourceSessionID`), titles, and one of four actions:
 *   `replace`, `copy`, `import`, or `skip`.
 * - No import, recovery write, or DELETE occurs unless the injected UI
 *   `confirm(preview)` resolves with exactly `true` for that frozen preview.
 * - Every import is exactly one injected `importSession` call. There is no
 *   retry. The full candidate record is read back and passed through the real
 *   core projection verifier before any deletion is considered.
 * - An old target is deleted only for a confirmed `replace` entry, after the
 *   candidate is complete/verified, a fresh target read shows the preview
 *   fingerprint unchanged, a fresh complete metadata inventory shows no
 *   incoming references, the target is standalone/settled, and the injected
 *   encrypted recovery `writeAndVerify` succeeds.
 * - A `DELETE` is issued at most once for one exact old target. A thrown or
 *   ambiguous outcome is reconciled by exactly one readback; there is no retry
 *   loop, no candidate cleanup, and no rollback.
 * - Any unsafe, incomplete, linked, changed, or unverifiable condition keeps
 *   the old target and reports a fixed `kept`/`failed`/`uncertain` reason.
 *   Independent entries continue; imported records are flattened parentless.
 *
 * Crypto, password handling, I/O, host calls, and record parsing live outside
 * this module. The real `src/core/restore/replacement.ts` exports are wired
 * directly: `prepareStandaloneRecord`, `fingerprintSessionRecord`,
 * `classifyReplacement` (`{mode:"replace"|"copy"}`), and
 * `verifyImportedRecord` (`{verified,reason?}`). No placeholder classifier or
 * verifier shim is injected.
 *
 * No CAS, atomicity, TOCTOU-safety, or live-host claim is made. Manual
 * quiescence is required. This module performs no console output and never
 * exposes raw host errors, records, message payloads, passwords, or candidate
 * IDs in reports.
 */

import type { JsonObject, SessionRecord } from "../../core/contracts/index.ts";
import {
	classifyReplacement,
	fingerprintSessionRecord,
	prepareStandaloneRecord,
	verifyImportedRecord,
	type ImportedRecordVerification,
	type ReplacementClassification,
} from "../../core/restore/replacement.ts";
import type { SessionImportAdapter } from "../adapters/index.ts";
import { createSessionDeletePort } from "../adapters/session-delete.ts";
import type {
	SessionReferenceInventoryPort,
	SessionReferenceInventoryResult,
} from "../adapters/session-reference-inventory.ts";
import { isRecordValue, requireCallable, requireNonEmptyString } from "./shared.ts";

/* ------------------------------------------------------------------------- */
/* Public display-safe types (structurally compatible with the TUI dialog)    */
/* ------------------------------------------------------------------------- */

/** Preview action for one standalone plan entry. */
export type RestoreReplacementAction = "replace" | "copy" | "import" | "skip";

/** Fixed local reason labels; never host error text. */
export type RestoreReplacementReason =
	| "exact-duplicate"
	| "confirmation-cancelled"
	| "candidate-collision"
	| "target-absent"
	| "safe-replace"
	| "original-fork-or-revert"
	| "original-parent"
	| "target-unsettled"
	| "destination-child-reference"
	| "incoming-reference"
	| "inventory-incomplete"
	| "delete-capability-unavailable"
	| "classifier-copy"
	| "classifier-skip"
	| "classifier-unavailable"
	| "fingerprint-unavailable"
	| "prepared-record-invalid"
	| "clock-invalid"
	| "import-failed"
	| "import-response-invalid"
	| "import-project-mismatch"
	| "import-time-window-invalid"
	| "candidate-readback-failed"
	| "candidate-verification-failed"
	| "target-readback-failed"
	| "target-changed"
	| "target-unsettled-at-delete"
	| "recovery-unverified"
	| "delete-capability-missing"
	| "delete-not-performed"
	| "delete-unverified-present"
	| "delete-unverified-unreadable"
	| "delete-uncertain-present"
	| "delete-uncertain-unreadable"
	| "delete-uncertain-absence-verified"
	| "old-already-absent"
	| "already-absent";

/** Frozen preview entry. `sessionID` is the exact old destination target or, when absent, the planned candidate. */
export interface RestoreReplacementPreviewEntry {
	readonly sessionID: string;
	readonly title: string;
	readonly action: RestoreReplacementAction;
	readonly reason?: RestoreReplacementReason;
}

/** Display-safe preview; contains IDs, titles, and fixed labels only. */
export interface RestoreReplacementPreview {
	readonly entries: readonly RestoreReplacementPreviewEntry[];
	readonly recoveryRequired: boolean;
}

/** Fixed report outcomes. */
export type RestoreReplacementOutcome =
	| "replaced"
	| "copied"
	| "imported"
	| "skipped"
	| "kept"
	| "failed"
	| "uncertain";

/** Display-safe report entry. No candidate IDs, records, or host errors are exposed. */
export interface RestoreReplacementReportEntry {
	readonly sessionID: string;
	readonly title: string;
	readonly outcome: RestoreReplacementOutcome;
	readonly reason?: RestoreReplacementReason;
}

/** Display-safe report. `recoveryPath` is a local encrypted artifact path only. */
export interface RestoreReplacementReport {
	readonly entries: readonly RestoreReplacementReportEntry[];
	readonly recoveryPath?: string;
}

/* ------------------------------------------------------------------------- */
/* Standalone plan (core is imported directly, not injected)                 */
/* ------------------------------------------------------------------------- */

/**
 * One completed standalone plan entry. `record` is the already-selected
 * standalone candidate; `sourceSessionID` is the exact old destination target
 * the user is considering replacing. `classification: "skipped"` is an exact
 * planner skip and is never imported or deleted.
 */
export interface StandaloneRestorePlanEntry {
	readonly sourceSessionID: string;
	readonly record: SessionRecord;
	readonly classification?: "imported" | "renamed" | "skipped";
	readonly skipReason?: string;
}

/** Completed standalone restore plan in deterministic entry order. */
export interface StandaloneRestorePlan {
	readonly entries: readonly StandaloneRestorePlanEntry[];
}

/* The executor deliberately has no replacement-core injection seam. */

/* ------------------------------------------------------------------------- */
/* Injected ports                                                            */
/* ------------------------------------------------------------------------- */

/** Complete or explicitly incomplete runtime reference inventory. */
export interface ReplacementReferenceInventory {
	readonly infos: readonly JsonObject[];
	readonly complete: boolean;
}

/** One encrypted recovery write + decrypt-verify result. */
export interface ReplacementRecoveryResult {
	readonly verified: boolean;
	readonly path?: string;
}

/** Injected crypto-backed recovery boundary; implementation stays outside this module. */
export interface ReplacementRecoveryPort {
	/**
	 * Writes and verifies an encrypted recovery artifact for the current full
	 * target baseline. The caller may batch/canonicalize this work in composition.
	 */
	writeAndVerify(records: readonly SessionRecord[]): Promise<ReplacementRecoveryResult>;
}

/** Fixed delete outcome; adapter-specific extra fields are ignored. */
export interface ReplacementDeleteOutcome {
	readonly status: "deleted" | "refused" | "not-retried" | "capability-unavailable" | "uncertain";
}

/** Narrow native-delete port; must be scoped to authorized old target IDs. */
export interface ReplacementDeletePort {
	readonly capability: { readonly available: boolean };
	removeSession(sessionID: string): Promise<ReplacementDeleteOutcome>;
}

/** Explicit, fully injected execution input. No defaults are applied. */
export interface RestoreReplacementExecutionInput {
	readonly plan: StandaloneRestorePlan;
	/** Raw original checkpoint records; used only for graph/fork/revert warnings. */
	readonly sourceRecords: readonly SessionRecord[];
	/** Complete destination snapshot used for exact old-target lookup and recovery baseline. */
	readonly destination: readonly SessionRecord[];
	/** Global metadata snapshot at preview time (`infos` plus explicit completeness). */
	readonly globalInventory: ReplacementReferenceInventory;
	/** Fixed destination target supplied on every import and to core verification. */
	readonly target: {
		readonly directory: string;
		readonly projectID: string;
		readonly canonicalProjectID: string;
	};
	/** Must resolve with exactly `true` to perform any write. */
	readonly confirm: (preview: RestoreReplacementPreview) => boolean | Promise<boolean>;
	readonly importer: SessionImportAdapter;
	/** Exact full record read; `undefined` means confirmed absence. */
	readonly readSession: (sessionID: string) => Promise<SessionRecord | undefined>;
	/** Fresh complete/incomplete metadata inventory read immediately before delete. */
	readonly readReferenceInventory: () => Promise<ReplacementReferenceInventory>;
	readonly recovery: ReplacementRecoveryPort;
	/** Creates one frozen delete scope for the exact old target IDs. */
	readonly deletePortFactory: (authorizedTargetIDs: readonly string[]) => ReplacementDeletePort;
	/** Explicit clock; no default. */
	readonly clock: () => number;
}

/** Complete engine result: the frozen preview plus the truthful report. */
export interface RestoreReplacementExecutionResult {
	readonly preview: RestoreReplacementPreview;
	readonly report: RestoreReplacementReport;
}

/* ------------------------------------------------------------------------- */
/* Real adapter wiring helpers                                               */
/* ------------------------------------------------------------------------- */

/**
 * Adapts the real `createSessionDeletePort` factory to this engine's frozen
 * `deletePortFactory(authorizedTargetIDs)` seam. The adapter itself enforces
 * the exact allowed-ID scope and at-most-once attempt policy.
 */
export function createReplacementDeletePortFactory(
	client: unknown,
): (authorizedTargetIDs: readonly string[]) => ReplacementDeletePort {
	return (authorizedTargetIDs) =>
		createSessionDeletePort(client, { allowedSessionIDs: authorizedTargetIDs });
}

/**
 * Maps the real reference-inventory result to the engine's explicit
 * `{infos,complete}` input. Incomplete results deliberately expose no entries,
 * so a partial scan can never authorize a delete.
 */
export function referenceInventoryFromAdapter(
	result: SessionReferenceInventoryResult,
): ReplacementReferenceInventory {
	if (result.status === "complete" && result.deleteEligible === true) {
		return { infos: result.entries.map((entry) => entry.info), complete: true };
	}
	return { infos: [], complete: false };
}

/** Adapts the real bounded inventory port into the engine's fresh-read seam. */
export function createReplacementReferenceInventoryReader(
	port: SessionReferenceInventoryPort,
): () => Promise<ReplacementReferenceInventory> {
	return async () => referenceInventoryFromAdapter(await port.readIncomingReferences());
}

/* ------------------------------------------------------------------------- */
/* Internal shapes                                                           */
/* ------------------------------------------------------------------------- */

interface PlannedEntry {
	readonly sourceSessionID: string;
	readonly candidateSessionID: string;
	readonly record: SessionRecord;
	readonly skip: boolean;
}

interface PreviewDecision {
	readonly entry: RestoreReplacementPreviewEntry;
	readonly candidateSessionID: string;
	readonly baselineFingerprint?: string;
}

interface PreparedImport {
	readonly prepared: SessionRecord;
	/** Full host readback used in the recovery baseline. */
	readonly actual: SessionRecord;
	readonly importStartedAt: number;
	readonly importFinishedAt: number;
}

type ImportResult = { readonly ok: true; readonly value: PreparedImport } | { readonly ok: false; readonly reason: RestoreReplacementReason };

type RecordRead =
	| { readonly kind: "record"; readonly record: SessionRecord }
	| { readonly kind: "absent" }
	| { readonly kind: "unreadable" };

interface DeleteReconciliation {
	readonly outcome: RestoreReplacementOutcome;
	readonly reason?: RestoreReplacementReason;
}

/* ------------------------------------------------------------------------- */
/* Fail-closed validation helpers                                            */
/* ------------------------------------------------------------------------- */

function requireSessionRecord(value: unknown, label: string): SessionRecord {
	if (!isRecordValue(value)) throw new TypeError(`${label} must be a session record object`);
	const info = value["info"];
	if (!isRecordValue(info)) throw new TypeError(`${label}.info must be an object`);
	requireNonEmptyString(info["id"], `${label}.info.id`);
	if (!Array.isArray(value["messages"])) throw new TypeError(`${label}.messages must be an array`);
	return value as unknown as SessionRecord;
}

function requireJsonObjects(value: unknown, label: string): readonly JsonObject[] {
	if (!Array.isArray(value)) throw new TypeError(`${label} must be an explicit array of metadata objects`);
	return value.map((entry, index) => {
		if (!isRecordValue(entry)) throw new TypeError(`${label}[${index}] must be a metadata object`);
		return entry as unknown as JsonObject;
	});
}

function requireInventory(value: unknown, label: string): ReplacementReferenceInventory {
	if (!isRecordValue(value)) throw new TypeError(`${label} must be an object with infos and complete`);
	const infos = requireJsonObjects(value["infos"], `${label}.infos`);
	if (typeof value["complete"] !== "boolean") throw new TypeError(`${label}.complete must be an explicit boolean`);
	return { infos, complete: value["complete"] };
}

function infoObject(record: SessionRecord): { readonly [key: string]: unknown } {
	return record.info as unknown as { readonly [key: string]: unknown };
}

function stringInfo(info: { readonly [key: string]: unknown }, key: string): string | undefined {
	const value = info[key];
	return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/** Nonempty known graph links; null-valued host placeholders are treated as absent. */
function hasBlockingGraphMetadata(info: { readonly [key: string]: unknown }): boolean {
	const parentID = info["parentID"];
	if (typeof parentID === "string" && parentID.trim().length > 0) return true;
	const fork = info["fork"];
	if (fork !== undefined && fork !== null) return true;
	const revert = info["revert"];
	if (revert !== undefined && revert !== null) return true;
	return false;
}

/** True when `info` carries a known session reference to `targetID`. */
function referencesTarget(info: { readonly [key: string]: unknown }, targetID: string): boolean {
	if (info["id"] === targetID) return false;
	if (info["parentID"] === targetID) return true;
	const fork = info["fork"];
	if (isRecordValue(fork) && fork["sessionID"] === targetID) return true;
	const revert = info["revert"];
	if (isRecordValue(revert) && revert["sessionID"] === targetID) return true;
	return false;
}

function titleOf(info: { readonly [key: string]: unknown }): string {
	const title = info["title"];
	return typeof title === "string" ? title : "";
}

function cloneJsonRecord(record: SessionRecord): SessionRecord {
	return {
		info: JSON.parse(JSON.stringify(record.info)) as JsonObject,
		messages: record.messages.map((message) => JSON.parse(JSON.stringify(message)) as JsonObject),
	};
}

function stableJson(value: unknown): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value) ?? "null";
	}
	if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
	const object = value as { readonly [key: string]: unknown };
	return `{${Object.keys(object)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
		.join(",")}}`;
}

interface ReferenceSignature {
	readonly present: boolean;
	readonly canonical: string;
	readonly parentID?: string;
	readonly forkSessionID?: string;
	readonly boundaryMessageID?: string;
	readonly revertMessageID?: string;
	readonly malformed: boolean;
}

function referenceSignature(info: JsonObject): ReferenceSignature {
	const parentIDRaw = info["parentID"];
	const forkRaw = info["fork"];
	const revertRaw = info["revert"];
	const present =
		(parentIDRaw !== undefined && parentIDRaw !== null) ||
		(forkRaw !== undefined && forkRaw !== null) ||
		(revertRaw !== undefined && revertRaw !== null);
	let malformed = false;
	let parentID: string | undefined;
	if (parentIDRaw !== undefined && parentIDRaw !== null) {
		if (typeof parentIDRaw === "string" && parentIDRaw.length > 0) parentID = parentIDRaw;
		else malformed = true;
	}
	let forkSessionID: string | undefined;
	let boundaryMessageID: string | undefined;
	if (forkRaw !== undefined && forkRaw !== null) {
		if (isRecordValue(forkRaw)) {
			const sessionID = forkRaw["sessionID"];
			if (typeof sessionID === "string" && sessionID.length > 0) forkSessionID = sessionID;
			else malformed = true;
			const boundary = forkRaw["boundary"];
			if (isRecordValue(boundary)) {
				const messageID = boundary["messageID"];
				const type = boundary["type"];
				if (typeof messageID === "string" && messageID.length > 0) boundaryMessageID = messageID;
				if (type !== "before" && type !== "through") malformed = true;
			} else {
				malformed = true;
			}
		} else {
			malformed = true;
		}
	}
	let revertMessageID: string | undefined;
	if (revertRaw !== undefined && revertRaw !== null) {
		if (isRecordValue(revertRaw)) {
			const messageID = revertRaw["messageID"];
			if (typeof messageID === "string" && messageID.length > 0) revertMessageID = messageID;
			else malformed = true;
		} else {
			malformed = true;
		}
	}
	return {
		present,
		canonical: present ? stableJson({ parentID: parentIDRaw ?? null, fork: forkRaw ?? null, revert: revertRaw ?? null }) : "none",
		...(parentID !== undefined ? { parentID } : {}),
		...(forkSessionID !== undefined ? { forkSessionID } : {}),
		...(boundaryMessageID !== undefined ? { boundaryMessageID } : {}),
		...(revertMessageID !== undefined ? { revertMessageID } : {}),
		malformed,
	};
}

interface ReferenceMerge {
	readonly infos: readonly JsonObject[];
	readonly restrictedTargetIDs: ReadonlySet<string>;
	readonly unresolved: boolean;
}

/**
 * Fail-closed reference-version merge. ordinary source/destination field
 * differences (title, time, project, ...) are expected and ignored here;
 * only reference-bearing fields and their malformed/unknown shapes are
 * compared. If two versions of the same session disagree on parent/fork/revert
 * metadata, the preferred display info cannot erase the other version: the
 * session and every referenced target become non-deletable. An unresolvable
 * message-boundary target makes the merge conservatively unresolved.
 */
function mergeReferenceInventory(
	sourceRecords: readonly SessionRecord[],
	destinationRecords: readonly SessionRecord[],
	globalInfos: readonly JsonObject[],
): ReferenceMerge {
	const versionsByID = new Map<string, JsonObject[]>();
	let malformedIdentity = false;
	const addVersion = (info: JsonObject): void => {
		const id = info["id"];
		if (typeof id !== "string" || id.length === 0) {
			malformedIdentity = true;
			return;
		}
		const versions = versionsByID.get(id) ?? [];
		versions.push(info);
		versionsByID.set(id, versions);
	};
	for (const record of sourceRecords) addVersion(record.info);
	for (const record of destinationRecords) addVersion(record.info);
	for (const info of globalInfos) addVersion(info);

	const messageOwner = new Map<string, string | null>();
	for (const record of [...sourceRecords, ...destinationRecords]) {
		const sessionID = infoObject(record)["id"];
		if (typeof sessionID !== "string" || sessionID.length === 0) continue;
		for (const message of record.messages) {
			const messageID = message["id"];
			if (typeof messageID !== "string" || messageID.length === 0) continue;
			const existing = messageOwner.get(messageID);
			if (existing === undefined) messageOwner.set(messageID, sessionID);
			else if (existing !== sessionID) messageOwner.set(messageID, null);
		}
	}

	const restrictedTargetIDs = new Set<string>();
	let unresolved = malformedIdentity;
	const infos: JsonObject[] = [];
	for (const [sessionID, versions] of versionsByID) {
		const signatures = versions.map((info) => referenceSignature(info));
		const distinct = new Set(signatures.map((signature) => signature.canonical));
		if (distinct.size > 1) {
			restrictedTargetIDs.add(sessionID);
			for (const signature of signatures) {
				if (!signature.present) continue;
				if (signature.malformed) unresolved = true;
				if (signature.parentID !== undefined) restrictedTargetIDs.add(signature.parentID);
				if (signature.forkSessionID !== undefined) restrictedTargetIDs.add(signature.forkSessionID);
				if (signature.boundaryMessageID !== undefined) {
					const owner = messageOwner.get(signature.boundaryMessageID);
					if (owner !== undefined && owner !== null) restrictedTargetIDs.add(owner);
				}
				if (signature.revertMessageID !== undefined) {
					const owner = messageOwner.get(signature.revertMessageID);
					if (owner === undefined || owner === null) unresolved = true;
					else restrictedTargetIDs.add(owner);
				}
			}
		}
		infos.push(versions[versions.length - 1]!);
	}
	return { infos, restrictedTargetIDs, unresolved };
}

function makePreviewEntry(entry: {
	readonly sessionID: string;
	readonly title: string;
	readonly action: RestoreReplacementAction;
	readonly reason?: RestoreReplacementReason;
}): RestoreReplacementPreviewEntry {
	return Object.freeze({
		sessionID: entry.sessionID,
		title: entry.title,
		action: entry.action,
		...(entry.reason !== undefined ? { reason: entry.reason } : {}),
	});
}

function isVerified(value: ImportedRecordVerification | boolean): boolean {
	return value === true || (isRecordValue(value) && value["verified"] === true);
}

/* ------------------------------------------------------------------------- */
/* Engine                                                                    */
/* ------------------------------------------------------------------------- */

/**
 * Executes one completed standalone restore plan under the 0.1.7 policy.
 *
 * Malformed plans, malformed snapshots, missing injected seams, or malformed
 * global metadata fail closed with `TypeError` before any write. Unsafe
 * per-entry conditions do not abort the batch; they downgrade that entry to a
 * copy/import or keep the old target.
 */
export async function runRestoreReplacementExecution(
	input: RestoreReplacementExecutionInput,
): Promise<RestoreReplacementExecutionResult> {
	/* -- 1. Fail-closed input and plan validation. No write happens here. -- */
	if (!isRecordValue(input)) throw new TypeError("runRestoreReplacementExecution requires an explicit input object");
	if (!isRecordValue(input.plan)) throw new TypeError("input.plan must be a completed standalone restore plan");
	const rawEntries = input.plan["entries"];
	if (!Array.isArray(rawEntries)) throw new TypeError("input.plan.entries must be an explicit array");
	requireCallable(input.confirm, "input.confirm");
	requireCallable(input.readSession, "input.readSession");
	requireCallable(input.readReferenceInventory, "input.readReferenceInventory");
	requireCallable(input.deletePortFactory, "input.deletePortFactory");
	requireCallable(input.clock, "input.clock");
	if (!isRecordValue(input.importer) || typeof input.importer.importSession !== "function") {
		throw new TypeError("input.importer must expose importSession(request)");
	}
	if (!isRecordValue(input.recovery) || typeof input.recovery.writeAndVerify !== "function") {
		throw new TypeError("input.recovery must expose writeAndVerify(records)");
	}
	if (!isRecordValue(input.target)) throw new TypeError("input.target must be an explicit destination object");
	const targetDirectory = requireNonEmptyString(input.target["directory"], "input.target.directory");
	const targetProjectID = requireNonEmptyString(input.target["projectID"], "input.target.projectID");
	const canonicalProjectID = requireNonEmptyString(input.target["canonicalProjectID"], "input.target.canonicalProjectID");
	const globalInventory = requireInventory(input.globalInventory, "input.globalInventory");

	if (!Array.isArray(input.sourceRecords)) throw new TypeError("input.sourceRecords must be an explicit array");
	if (!Array.isArray(input.destination)) throw new TypeError("input.destination must be an explicit array");

	// Detached snapshots keep the reference-bearing originals stable even if a
	// caller mutates its arrays/records while the UI confirmation is pending.
	const sourceRecordsSnapshot: SessionRecord[] = [];
	const sourceByID = new Map<string, SessionRecord>();
	for (let index = 0; index < input.sourceRecords.length; index++) {
		const record = cloneJsonRecord(requireSessionRecord(input.sourceRecords[index], `input.sourceRecords[${index}]`));
		const id = infoObject(record)["id"] as string;
		if (sourceByID.has(id)) throw new TypeError(`input.sourceRecords repeats session id ${JSON.stringify(id)}`);
		sourceByID.set(id, record);
		sourceRecordsSnapshot.push(record);
	}

	const destinationSnapshot: SessionRecord[] = [];
	const destinationByID = new Map<string, SessionRecord>();
	for (let index = 0; index < input.destination.length; index++) {
		const record = cloneJsonRecord(requireSessionRecord(input.destination[index], `input.destination[${index}]`));
		const id = infoObject(record)["id"] as string;
		if (destinationByID.has(id)) throw new TypeError(`input.destination repeats session id ${JSON.stringify(id)}`);
		destinationByID.set(id, record);
		destinationSnapshot.push(record);
	}

	const planned: PlannedEntry[] = [];
	const sourceIDs = new Set<string>();
	const candidateIDs = new Set<string>();
	for (let index = 0; index < rawEntries.length; index++) {
		const raw = rawEntries[index];
		if (!isRecordValue(raw)) throw new TypeError(`input.plan.entries[${index}] must be an object`);
		const sourceSessionID = requireNonEmptyString(raw["sourceSessionID"], `input.plan.entries[${index}].sourceSessionID`);
		const record = cloneJsonRecord(requireSessionRecord(raw["record"], `input.plan.entries[${index}].record`));
		const candidateSessionID = infoObject(record)["id"] as string;
		const classification = raw["classification"];
		if (classification !== undefined && classification !== "imported" && classification !== "renamed" && classification !== "skipped") {
			throw new TypeError(`input.plan.entries[${index}].classification must be imported, renamed, or skipped when present`);
		}
		if (sourceIDs.has(sourceSessionID)) {
			throw new TypeError(`input.plan.entries repeats sourceSessionID ${JSON.stringify(sourceSessionID)}`);
		}
		if (candidateIDs.has(candidateSessionID)) {
			throw new TypeError(`input.plan.entries repeats candidate session id ${JSON.stringify(candidateSessionID)}`);
		}
		sourceIDs.add(sourceSessionID);
		candidateIDs.add(candidateSessionID);
		planned.push({
			sourceSessionID,
			candidateSessionID,
			record,
			skip: classification === "skipped",
		});
	}

	/* -- 2. Freeze the preview before any write. -- */
	// Merge every reference-bearing version (source, destination, global). The
	// merge keeps ordinary field differences eligible but never discards a
	// disagreeing parent/fork/revert version.
	const previewMerge = mergeReferenceInventory(
		sourceRecordsSnapshot,
		destinationSnapshot,
		globalInventory.infos,
	);
	const combinedInventory: readonly JsonObject[] = previewMerge.infos;
	const decisions: PreviewDecision[] = [];

	for (const entry of planned) {
		const oldTarget = destinationByID.get(entry.sourceSessionID);
		const candidateInfo = infoObject(entry.record);
		const displayID = oldTarget !== undefined ? entry.sourceSessionID : entry.candidateSessionID;
		const displayTitle = titleOf(oldTarget !== undefined ? infoObject(oldTarget) : candidateInfo);

		if (entry.skip) {
			decisions.push({
				entry: makePreviewEntry({
					sessionID: displayID,
					title: displayTitle,
					action: "skip",
					reason: "exact-duplicate",
				}),
				candidateSessionID: entry.candidateSessionID,
			});
			continue;
		}
		if (entry.sourceSessionID === entry.candidateSessionID) {
			decisions.push({
				entry: makePreviewEntry({
					sessionID: displayID,
					title: displayTitle,
					action: "skip",
					reason: "candidate-collision",
				}),
				candidateSessionID: entry.candidateSessionID,
			});
			continue;
		}
		if (
			destinationByID.has(entry.candidateSessionID) ||
			sourceByID.has(entry.candidateSessionID) ||
			globalInventory.infos.some((info) => info["id"] === entry.candidateSessionID)
		) {
			decisions.push({
				entry: makePreviewEntry({
					sessionID: displayID,
					title: displayTitle,
					action: "skip",
					reason: "candidate-collision",
				}),
				candidateSessionID: entry.candidateSessionID,
			});
			continue;
		}
		if (oldTarget === undefined) {
			decisions.push({
				entry: makePreviewEntry({
					sessionID: displayID,
					title: displayTitle,
					action: "import",
					reason: "target-absent",
				}),
				candidateSessionID: entry.candidateSessionID,
			});
			continue;
		}

		/* Old target exists: only a fully settled, verified replace may delete it. */
		let action: RestoreReplacementAction = "copy";
		let reason: RestoreReplacementReason = "safe-replace";
		let baselineFingerprint: string | undefined;

		if (previewMerge.unresolved || previewMerge.restrictedTargetIDs.has(entry.sourceSessionID)) {
			reason = "incoming-reference";
		} else if (!globalInventory.complete) {
			reason = "inventory-incomplete";
		} else {
			const original = sourceByID.get(entry.sourceSessionID);
			const originalInfo = original !== undefined ? infoObject(original) : undefined;
			const oldInfo = infoObject(oldTarget);
			const destinationChild = [...destinationByID.values()].some(
				(record) => referencesTarget(infoObject(record), entry.sourceSessionID),
			);
			const sourceIncoming = [...sourceByID.values()].some(
				(record) => referencesTarget(infoObject(record), entry.sourceSessionID),
			);
			const globalIncoming = globalInventory.infos.some((info) => referencesTarget(info, entry.sourceSessionID));

			if (originalInfo !== undefined && hasBlockingGraphMetadata(originalInfo)) {
				reason = typeof originalInfo["parentID"] === "string" ? "original-parent" : "original-fork-or-revert";
			} else if (hasBlockingGraphMetadata(oldInfo)) {
				reason = "target-unsettled";
			} else if (destinationChild) {
				reason = "destination-child-reference";
			} else if (sourceIncoming || globalIncoming) {
				reason = "incoming-reference";
			} else {
				let classifierMode: ReplacementClassification["mode"] | undefined;
				try {
					const classification = classifyReplacement({
						source: original ?? entry.record,
						target: oldTarget,
						authorizedTargetID: entry.sourceSessionID,
						referenceInventory: combinedInventory,
						inventoryComplete: globalInventory.complete,
					});
					if (isRecordValue(classification) && (classification["mode"] === "replace" || classification["mode"] === "copy")) {
						classifierMode = classification["mode"];
					}
				} catch {
					classifierMode = undefined;
				}

				if (classifierMode === undefined) {
					reason = "classifier-unavailable";
				} else if (classifierMode !== "replace") {
					reason = "classifier-copy";
				} else {
					try {
						const fingerprint = fingerprintSessionRecord(oldTarget);
						if (typeof fingerprint !== "string" || fingerprint.length === 0) {
							reason = "fingerprint-unavailable";
						} else {
							baselineFingerprint = fingerprint;
							action = "replace";
							reason = "safe-replace";
						}
					} catch {
						reason = "fingerprint-unavailable";
					}
				}
			}
		}

		decisions.push({
			entry: makePreviewEntry({
				sessionID: displayID,
				title: displayTitle,
				action,
				reason,
			}),
			candidateSessionID: entry.candidateSessionID,
			...(baselineFingerprint !== undefined ? { baselineFingerprint } : {}),
		});
	}

	const provisionalReplaceTargetIDs: string[] = [];
	for (const decision of decisions) {
		if (decision.entry.action !== "replace") continue;
		const plannedEntry = planned.find((entry) => entry.sourceSessionID === decision.entry.sessionID);
		if (plannedEntry !== undefined && !provisionalReplaceTargetIDs.includes(plannedEntry.sourceSessionID)) {
			provisionalReplaceTargetIDs.push(plannedEntry.sourceSessionID);
		}
	}

	let deletePort: ReplacementDeletePort | undefined;
	let deleteCapability = true;
	if (provisionalReplaceTargetIDs.length > 0) {
		try {
			deletePort = input.deletePortFactory([...provisionalReplaceTargetIDs]);
			deleteCapability =
				isRecordValue(deletePort) &&
				isRecordValue(deletePort.capability) &&
				deletePort.capability.available === true &&
				typeof deletePort.removeSession === "function";
			if (!deleteCapability) deletePort = undefined;
		} catch {
			deleteCapability = false;
			deletePort = undefined;
		}
	}

	// Capability is proven before the preview is frozen. A missing delete
	// surface never aborts imports: confirmed replace targets become copies.
	const finalDecisions: PreviewDecision[] = [];
	for (const decision of decisions) {
		if (decision.entry.action !== "replace" || deleteCapability) {
			finalDecisions.push(decision);
			continue;
		}
		finalDecisions.push({
			...decision,
			entry: makePreviewEntry({
				sessionID: decision.entry.sessionID,
				title: decision.entry.title,
				action: "copy",
				reason: "delete-capability-unavailable",
			}),
		});
	}

	const preview: RestoreReplacementPreview = Object.freeze({
		entries: Object.freeze(finalDecisions.map((decision) => decision.entry)),
		recoveryRequired: finalDecisions.some((decision) => decision.entry.action === "replace"),
	});

	/* -- 3. Explicit confirmation gate. No write on any non-true answer. -- */
	let confirmed = false;
	try {
		confirmed = (await input.confirm(preview)) === true;
	} catch {
		confirmed = false;
	}
	if (!confirmed) {
		return {
			preview,
			report: Object.freeze({
				entries: Object.freeze(
					finalDecisions.map((decision) =>
						Object.freeze({
							sessionID: decision.entry.sessionID,
							title: decision.entry.title,
							outcome: "skipped" as const,
							reason:
								decision.entry.reason === "exact-duplicate"
									? ("exact-duplicate" as const)
									: ("confirmation-cancelled" as const),
						}),
					),
				),
			}),
		};
	}

	/* -- 4. Execute entries independently. No parent/child blocking exists. -- */
	const reportEntries: RestoreReplacementReportEntry[] = [];
	const workingTargetRecords: SessionRecord[] = [...destinationSnapshot];
	let recoveryPath: string | undefined;
	const attemptedDeleteIDs = new Set<string>();

	for (let index = 0; index < planned.length; index++) {
		const entry = planned[index]!;
		const decision = finalDecisions[index]!;
		const action = decision.entry.action;

		if (action === "skip") {
			reportEntries.push(
				Object.freeze({
					sessionID: decision.entry.sessionID,
					title: decision.entry.title,
					outcome: "skipped",
					reason: decision.entry.reason,
				}),
			);
			continue;
		}

		const imported = await importCandidate({
			entry,
			importer: input.importer,
			readSession: input.readSession,
			clock: input.clock,
			targetDirectory,
			targetProjectID,
			canonicalProjectID,
			preparedRecord: entry.record,
		});
		if (!imported.ok) {
			reportEntries.push(
				Object.freeze({
					sessionID: decision.entry.sessionID,
					title: decision.entry.title,
					outcome: "failed",
					reason: imported.reason,
				}),
			);
			continue;
		}

		workingTargetRecords.push(imported.value.actual);

		if (action === "import") {
			reportEntries.push(
				Object.freeze({
					sessionID: decision.entry.sessionID,
					title: decision.entry.title,
					outcome: "imported",
					reason: "target-absent",
				}),
			);
			continue;
		}

		if (action === "copy") {
			reportEntries.push(
				Object.freeze({
					sessionID: decision.entry.sessionID,
					title: decision.entry.title,
					outcome: "copied",
					reason: decision.entry.reason,
				}),
			);
			continue;
		}

		/* Confirmed replace: candidate is complete/verified. Re-prove every gate. */
		const oldSessionID = entry.sourceSessionID;
		const freshTarget = await readExact(input.readSession, oldSessionID);
		if (freshTarget.kind === "absent") {
			// Confirmed absence: import only. This engine did not delete anything.
			reportEntries.push(
				Object.freeze({
					sessionID: decision.entry.sessionID,
					title: decision.entry.title,
					outcome: "imported",
					reason: "old-already-absent",
				}),
			);
			continue;
		}
		if (freshTarget.kind === "unreadable" || decision.baselineFingerprint === undefined) {
			reportEntries.push(
				Object.freeze({
					sessionID: decision.entry.sessionID,
					title: decision.entry.title,
					outcome: "kept",
					reason: "target-readback-failed",
				}),
			);
			continue;
		}

		let freshFingerprint: string;
		try {
			freshFingerprint = fingerprintSessionRecord(freshTarget.record);
		} catch {
			reportEntries.push(
				Object.freeze({
					sessionID: decision.entry.sessionID,
					title: decision.entry.title,
					outcome: "kept",
					reason: "target-readback-failed",
				}),
			);
			continue;
		}
		if (typeof freshFingerprint !== "string" || freshFingerprint !== decision.baselineFingerprint) {
			reportEntries.push(
				Object.freeze({
					sessionID: decision.entry.sessionID,
					title: decision.entry.title,
					outcome: "kept",
					reason: "target-changed",
				}),
			);
			continue;
		}

		if (hasBlockingGraphMetadata(infoObject(freshTarget.record))) {
			reportEntries.push(
				Object.freeze({
					sessionID: decision.entry.sessionID,
					title: decision.entry.title,
					outcome: "kept",
					reason: "target-unsettled-at-delete",
				}),
			);
			continue;
		}

		let freshInventory: ReplacementReferenceInventory;
		try {
			freshInventory = requireInventory(await input.readReferenceInventory(), "readReferenceInventory()");
		} catch {
			reportEntries.push(
				Object.freeze({
					sessionID: decision.entry.sessionID,
					title: decision.entry.title,
					outcome: "kept",
					reason: "inventory-incomplete",
				}),
			);
			continue;
		}
		if (!freshInventory.complete) {
			reportEntries.push(
				Object.freeze({
					sessionID: decision.entry.sessionID,
					title: decision.entry.title,
					outcome: "kept",
					reason: "inventory-incomplete",
				}),
			);
			continue;
		}
		// Reuse the exact fail-closed merge for the fresh gate. A late version
		// that drops/changes B's parent/fork/revert cannot erase the original
		// artifact version and hide an incoming reference to this target.
		const freshMerge = mergeReferenceInventory(
			sourceRecordsSnapshot,
			[...workingTargetRecords, freshTarget.record],
			freshInventory.infos,
		);
		const candidateInventoryInfo = freshInventory.infos.find((info) => info["id"] === decision.candidateSessionID);
		const incoming =
			freshMerge.unresolved ||
			freshMerge.restrictedTargetIDs.has(oldSessionID) ||
			freshInventory.infos.some(
				(info) => info["id"] !== decision.candidateSessionID && referencesTarget(info, oldSessionID),
			) ||
			(candidateInventoryInfo !== undefined && referencesTarget(candidateInventoryInfo, oldSessionID));
		if (incoming) {
			reportEntries.push(
				Object.freeze({
					sessionID: decision.entry.sessionID,
					title: decision.entry.title,
					outcome: "kept",
					reason: "incoming-reference",
				}),
			);
			continue;
		}

		// Re-run the core eligibility classifier against the fresh complete
		// inventory. This re-proves message-level graph references, unsupported
		// tool states, and unsettled records immediately before the delete gate.
		let freshClassification: ReplacementClassification | undefined;
		try {
			freshClassification = classifyReplacement({
				source: sourceByID.get(oldSessionID) ?? imported.value.prepared,
				target: freshTarget.record,
				authorizedTargetID: oldSessionID,
				referenceInventory: freshMerge.infos,
				inventoryComplete: true,
			});
		} catch {
			freshClassification = undefined;
		}
		if (freshClassification === undefined || freshClassification.mode !== "replace") {
			reportEntries.push(
				Object.freeze({
					sessionID: decision.entry.sessionID,
					title: decision.entry.title,
					outcome: "kept",
					reason: freshClassification === undefined ? "classifier-unavailable" : "classifier-copy",
				}),
			);
			continue;
		}

		/* Encrypted recovery of the current full target baseline, then verify. */
		let recoveryVerified = false;
		let recoveryArtifactPath: string | undefined;
		try {
			const recovery = await input.recovery.writeAndVerify([...workingTargetRecords]);
			if (isRecordValue(recovery) && recovery["verified"] === true) {
				recoveryVerified = true;
				const path = recovery["path"];
				if (typeof path === "string" && path.length > 0) {
					recoveryArtifactPath = path;
					if (recoveryPath === undefined) recoveryPath = path;
				}
			}
		} catch {
			recoveryVerified = false;
		}
		if (!recoveryVerified) {
			reportEntries.push(
				Object.freeze({
					sessionID: decision.entry.sessionID,
					title: decision.entry.title,
					outcome: "kept",
					reason: "recovery-unverified",
				}),
			);
			continue;
		}

		if (
			deletePort === undefined ||
			typeof deletePort.removeSession !== "function" ||
			attemptedDeleteIDs.has(oldSessionID)
		) {
			reportEntries.push(
				Object.freeze({
					sessionID: decision.entry.sessionID,
					title: decision.entry.title,
					outcome: "kept",
					reason: "delete-capability-missing",
				}),
			);
			continue;
		}

		attemptedDeleteIDs.add(oldSessionID);
		const reconciliation = await reconcileDelete(deletePort, oldSessionID, input.readSession);
		if (reconciliation.outcome === "replaced") {
			const workingIndex = workingTargetRecords.findIndex((record) => infoObject(record)["id"] === oldSessionID);
			if (workingIndex >= 0) workingTargetRecords.splice(workingIndex, 1);
		}
		reportEntries.push(
			Object.freeze({
				sessionID: decision.entry.sessionID,
				title: decision.entry.title,
				outcome: reconciliation.outcome,
				...(reconciliation.reason !== undefined ? { reason: reconciliation.reason } : {}),
			}),
		);
	}

	return {
		preview,
		report: Object.freeze({
			entries: Object.freeze(reportEntries),
			...(recoveryPath !== undefined ? { recoveryPath } : {}),
		}),
	};
}

/* ------------------------------------------------------------------------- */
/* Execution helpers                                                         */
/* ------------------------------------------------------------------------- */

async function importCandidate(input: {
	readonly entry: PlannedEntry;
	readonly importer: SessionImportAdapter;
	readonly readSession: (sessionID: string) => Promise<SessionRecord | undefined>;
	readonly clock: () => number;
	readonly targetDirectory: string;
	readonly targetProjectID: string;
	readonly canonicalProjectID: string;
	readonly preparedRecord: SessionRecord;
}): Promise<ImportResult> {
	let prepared: SessionRecord;
	try {
		prepared = requireSessionRecord(
			prepareStandaloneRecord(input.preparedRecord),
			"prepareStandaloneRecord(record)",
		);
	} catch {
		return { ok: false, reason: "prepared-record-invalid" };
	}
	if (infoObject(prepared)["id"] !== input.entry.candidateSessionID) {
		return { ok: false, reason: "prepared-record-invalid" };
	}
	if (hasBlockingGraphMetadata(infoObject(prepared))) {
		return { ok: false, reason: "prepared-record-invalid" };
	}

	let importStartedAt: number;
	try {
		importStartedAt = input.clock();
	} catch {
		return { ok: false, reason: "clock-invalid" };
	}
	if (typeof importStartedAt !== "number" || !Number.isFinite(importStartedAt)) {
		return { ok: false, reason: "clock-invalid" };
	}

	let response: unknown;
	try {
		response = await input.importer.importSession({
			record: prepared,
			target: { directory: input.targetDirectory },
		});
	} catch {
		return { ok: false, reason: "import-failed" };
	}

	let importFinishedAt: number;
	try {
		importFinishedAt = input.clock();
	} catch {
		return { ok: false, reason: "clock-invalid" };
	}
	if (
		typeof importFinishedAt !== "number" ||
		!Number.isFinite(importFinishedAt) ||
		importFinishedAt < importStartedAt
	) {
		return { ok: false, reason: "import-time-window-invalid" };
	}

	if (!isRecordValue(response)) return { ok: false, reason: "import-response-invalid" };
	const responseID = response["id"];
	const responseProjectID = response["projectID"];
	const responseLocation = response["location"];
	if (typeof responseID !== "string" || responseID !== input.entry.candidateSessionID) {
		return { ok: false, reason: "import-response-invalid" };
	}
	if (typeof responseProjectID !== "string" || responseProjectID.length === 0) {
		return { ok: false, reason: "import-response-invalid" };
	}
	if (!isRecordValue(responseLocation) || typeof responseLocation["directory"] !== "string" || responseLocation["directory"].length === 0) {
		return { ok: false, reason: "import-response-invalid" };
	}
	if (responseProjectID !== input.targetProjectID && responseProjectID !== input.canonicalProjectID) {
		return { ok: false, reason: "import-project-mismatch" };
	}

	const readback = await readExact(input.readSession, input.entry.candidateSessionID);
	if (readback.kind !== "record") return { ok: false, reason: "candidate-readback-failed" };
	if (infoObject(readback.record)["id"] !== input.entry.candidateSessionID) {
		return { ok: false, reason: "candidate-readback-failed" };
	}

	let verified: ImportedRecordVerification | boolean;
	try {
		verified = verifyImportedRecord({
			expected: prepared,
			actual: readback.record,
			canonicalProjectID: input.canonicalProjectID,
			locationDirectory: input.targetDirectory,
			importStartedAt,
			importFinishedAt,
		});
	} catch {
		return { ok: false, reason: "candidate-verification-failed" };
	}
	if (!isVerified(verified)) return { ok: false, reason: "candidate-verification-failed" };

	return { ok: true, value: { prepared, actual: readback.record, importStartedAt, importFinishedAt } };
}

async function readExact(
	readSession: (sessionID: string) => Promise<SessionRecord | undefined>,
	sessionID: string,
): Promise<RecordRead> {
	let value: unknown;
	try {
		value = await readSession(sessionID);
	} catch {
		return { kind: "unreadable" };
	}
	if (value === undefined) return { kind: "absent" };
	try {
		const record = requireSessionRecord(value, "readSession result");
		if (infoObject(record)["id"] !== sessionID) return { kind: "unreadable" };
		return { kind: "record", record };
	} catch {
		return { kind: "unreadable" };
	}
}

async function reconcileDelete(
	port: ReplacementDeletePort,
	sessionID: string,
	readSession: (sessionID: string) => Promise<SessionRecord | undefined>,
): Promise<DeleteReconciliation> {
	let result: unknown;
	try {
		result = await port.removeSession(sessionID);
	} catch {
		result = { status: "uncertain" };
	}
	const status = isRecordValue(result) ? result["status"] : undefined;

	if (status === "deleted") {
		const readback = await readExact(readSession, sessionID);
		if (readback.kind === "absent") {
			return { outcome: "replaced" };
		}
		if (readback.kind === "unreadable") {
			return { outcome: "uncertain", reason: "delete-unverified-unreadable" };
		}
		return { outcome: "failed", reason: "delete-unverified-present" };
	}

	// A known refusal or missing capability never issued a DELETE, so there is
	// nothing to reconcile. Every thrown/uncertain/retried/unknown result is
	// reconciled exactly once; there is no second DELETE attempt.
	if (status === "refused" || status === "capability-unavailable") {
		return { outcome: "kept", reason: "delete-not-performed" };
	}
	const readback = await readExact(readSession, sessionID);
	if (readback.kind === "absent") {
		return { outcome: "replaced", reason: "delete-uncertain-absence-verified" };
	}
	if (readback.kind === "record") {
		return { outcome: "kept", reason: "delete-uncertain-present" };
	}
	return { outcome: "uncertain", reason: "delete-uncertain-unreadable" };
}
