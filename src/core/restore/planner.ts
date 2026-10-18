/**
 * Pure restore preflight and planning (Phase 3; O-04/O-05/O-22).
 *
 * `planRestore` is a side-effect-free planning step: it snapshots and validates
 * the checkpoint payload and the local destination snapshot, classifies every
 * unique artifact session (`skipped` / `imported` / `renamed`), deterministically
 * rederives every message ID of every session that will be imported, rewrites
 * only the schema-defined references, detects ID collisions and dangling
 * external references, and returns a parent-before-child import order. It never
 * calls a host API, touches the filesystem, runs an LLM, or performs an import.
 *
 * Policy boundaries (see `docs/v1/decision-log.md` O-04/O-05/O-22):
 * - Canonical comparison is the complete `{info,messages}` record serialized as
 *   JSON with object keys sorted recursively; values, array order, IDs, and
 *   absent-vs-null distinctions are preserved (O-04).
 * - Every message ID of every session planned for import is rederived through
 *   the injected `RemappedIdDeriver` (owner clarification 2026-10-10, O-05),
 *   even when it does not currently collide with destination history. Only an
 *   exact source-record duplicate that is skipped keeps its message IDs.
 * - A divergent local session under the same session ID derives a new session
 *   ID (`renamed`); new nonconflicting sessions keep their session ID. A
 *   planned ID that collides with different destination data fails preflight
 *   and is never regenerated.
 * - Final target IDs are unique across all unique artifact entries, including
 *   exact-local and exact-planned-retry skips: two distinct source sessions can
 *   never coalesce onto one target session ID or one final target message ID,
 *   even when a deriver collision makes their transformed records identical.
 *   Destination-occupancy checks apply only to entries actually being imported;
 *   exact-local/retry records already exist in the destination by definition.
 * - Exact-content retry detection only recognizes a destination record that is
 *   exactly the deterministic planned record at the planned session ID. Retry
 *   classification is iterated to a fixed point in deterministic session-ID
 *   order so the result does not depend on payload order. Broader
 *   partial-import retry/reporting semantics remain OPEN (O-06); this planner
 *   deliberately makes no claim about them.
 * - Cross-project collision policy (owner-approved 2026-10-14 amendment): the
 *   optional `globallyVisibleSessionIDs` inventory carries session-ID
 *   occupancy outside the selected destination only — never records, messages,
 *   or retry evidence. An exact source-record duplicate in the destination is
 *   still skipped unchanged. Otherwise a source ID occupied in the destination
 *   or in the global inventory is renamed with the same deterministic session
 *   derivation, and all-message rederivation plus parent/fork/revert rewriting
 *   are unchanged. A derived target ID that is globally occupied but absent
 *   from the selected destination fails closed: it is never re-derived and
 *   never treated as a retry. The global inventory can never satisfy a
 *   reference, classify a duplicate, or classify a retry — those matches
 *   require the exact planned record in the selected destination. Destination
 *   IDs naturally overlap the global inventory, and that overlap is valid.
 *   Inventory shape/blank/duplicate violations fail closed as `invalid-input`.
 * - The payload root must have exactly the top-level `sessions` key; any
 *   additional root key fails closed so unsupported payload data is never
 *   silently omitted. A record must have exactly the top-level `info` and
 *   `messages` keys; any additional top-level key fails closed. When present,
 *   `info.fork` must carry
 *   a string `sessionID`, an object `boundary`, a `boundary.type` that is
 *   exactly `before`/`through`, and a string `boundary.messageID`; `info.revert`
 *   must carry a string `messageID`. Present reference IDs must use their
 *   `ses`/`msg_` schema prefixes.
 * - Only `info.id`, `info.parentID`, `info.fork.sessionID`, every message `id`,
 *   `info.fork.boundary.messageID`, and `info.revert.messageID` are rewritten.
 *   Snapshot IDs, `revert.partID`, tool/shell/skill/part IDs, and every other
 *   opaque field are preserved unchanged.
 * - Full-preflight reference resolution (O-05) covers every artifact session.
 *   Exact-local skipped records are never rewritten: their unchanged session
 *   references must already exist in the destination or resolve to an artifact
 *   session that keeps its source ID, and their unchanged message references
 *   must already exist at their original IDs in the destination. Exact-retry
 *   records are the deterministic planned records built when the retry match
 *   was detected, so their references were resolved at that point.
 *
 * All inputs are snapshotted into detached JSON-only copies before validation,
 * so caller-owned objects are never mutated and non-JSON values (undefined,
 * functions, class instances, accessors, cycles, non-finite numbers, `-0`,
 * sparse arrays) are rejected instead of being silently dropped or coerced.
 * The caller's artifact identity is likewise copied on entry, and every
 * `derive` call receives its own fresh copy, so a deriver can neither mutate
 * caller-owned bytes nor influence later derivations through a shared buffer.
 */

import {
	ARTIFACT_IDENTITY_BYTES,
	snapshotJsonValue,
	type ArtifactIdentity,
	type CheckpointPayload,
	type JsonObject,
	type JsonValue,
	type SessionRecord,
} from "../contracts/index.ts";
import { findSchemaReferenceViolation } from "../sessions/references.ts";
import type { RemappedIdDeriver } from "./identity.ts";

/* ------------------------------------------------------------------------- */
/* Public error taxonomy and plan shape                                      */
/* ------------------------------------------------------------------------- */

/** Stable machine-readable failure codes for restore preflight/planning. */
export type RestorePlanErrorCode =
	| "invalid-input"
	| "malformed-payload"
	| "malformed-destination"
	| "divergent-artifact-session"
	| "duplicate-artifact-message-id"
	| "ambiguous-destination"
	| "dangling-session-reference"
	| "dangling-message-reference"
	| "session-id-collision"
	| "message-id-collision"
	| "dependency-cycle"
	| "derivation-failure";

/**
 * Fail-closed planning error. Messages carry IDs/labels only; they never echo
 * an entire session record or message and are never truncated.
 */
export class RestorePlanError extends Error {
	readonly code: RestorePlanErrorCode;

	constructor(code: RestorePlanErrorCode, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "RestorePlanError";
		this.code = code;
	}
}

/** Outcome for one unique artifact session. */
export type RestoreClassification = "skipped" | "imported" | "renamed";

/** Stable reasons for a `skipped` entry. */
export type RestoreSkipReason = "exact-local-duplicate" | "exact-planned-retry";

/**
 * One unique artifact session, in source order. `record` is the final planned
 * record: the unchanged source record for an exact local duplicate, the exact
 * deterministic planned record for an exact retry, and the fully remapped
 * record for imported/renamed sessions.
 */
export interface RestorePlanEntry {
	readonly sourceSessionID: string;
	readonly targetSessionID: string;
	readonly classification: RestoreClassification;
	readonly record: SessionRecord;
	readonly skipReason?: RestoreSkipReason;
}

export interface RestorePlan {
	/** One entry per unique artifact session (after identical-record collapse), in source order. */
	readonly entries: readonly RestorePlanEntry[];
	/** Only `imported`/`renamed` entries, in deterministic parent-before-child order. */
	readonly importOrder: readonly RestorePlanEntry[];
	/** Number of fully identical repeated artifact session records that were collapsed. */
	readonly collapsedDuplicateCount: number;
}

export interface PlanRestoreInput {
	readonly payload: CheckpointPayload;
	readonly artifactIdentity: ArtifactIdentity;
	/** Full local session snapshot used for classification and collision checks. */
	readonly destination: readonly SessionRecord[];
	/**
	 * Optional host-visible session-ID inventory across projects, including the
	 * selected destination (occupancy only; never records or messages). Absent
	 * means an empty inventory, preserving isolated core callers. Entries must
	 * be unique non-blank strings; violations fail closed as `invalid-input`.
	 */
	readonly globallyVisibleSessionIDs?: readonly string[];
	readonly idDeriver: RemappedIdDeriver;
}

/* ------------------------------------------------------------------------- */
/* Internal helpers                                                          */
/* ------------------------------------------------------------------------- */

interface UniqueSession {
	/** Position among unique sessions (source order); used for stable tie-breaking. */
	readonly sourceIndex: number;
	/** Position in `payload.sessions`; used only in error labels. */
	readonly payloadIndex: number;
	readonly sourceSessionID: string;
	readonly record: SessionRecord;
	readonly canonical: string;
	readonly messageIDs: readonly string[];
}

interface SessionPlan {
	readonly session: UniqueSession;
	classification: RestoreClassification;
	targetSessionID: string;
	skipReason: RestoreSkipReason | undefined;
	record: SessionRecord;
	messageTargets: string[];
	planned: boolean;
}

interface DestinationSession {
	readonly record: SessionRecord;
	readonly canonical: string;
}

function isObjectValue(value: unknown): value is { readonly [key: string]: unknown } {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonRecordValue(value: unknown): value is { readonly [key: string]: JsonValue } {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeError(value: unknown): string {
	return value instanceof Error ? value.message : String(value);
}

/** Exact selected target-ID shapes (O-22): lowercase hex digests only. */
const TARGET_ID_PATTERNS: Readonly<Record<"session" | "message", RegExp>> = Object.freeze({
	session: /^ses_[0-9a-f]{64}$/,
	message: /^msg_[0-9a-f]{64}$/,
});

/**
 * Canonical JSON string: object keys sorted recursively at every level; array
 * order, primitive values, IDs, and absent-vs-null are preserved exactly.
 * Iterative (explicit stack) so deep payloads cannot overflow the call stack.
 */
function canonicalJson(root: JsonValue): string {
	type WorkItem = { readonly kind: "value"; readonly value: JsonValue } | { readonly kind: "text"; readonly text: string };
	const parts: string[] = [];
	const stack: WorkItem[] = [{ kind: "value", value: root }];

	while (stack.length > 0) {
		const item = stack.pop()!;
		if (item.kind === "text") {
			parts.push(item.text);
			continue;
		}

		const value = item.value;
		if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
			const encoded = JSON.stringify(value);
			if (encoded === undefined) {
				throw new RestorePlanError("malformed-payload", "internal canonicalization failure: a JSON primitive could not be serialized");
			}
			parts.push(encoded);
			continue;
		}

		if (Array.isArray(value)) {
			stack.push({ kind: "text", text: "]" });
			for (let index = value.length - 1; index >= 0; index--) {
				stack.push({ kind: "value", value: value[index]! });
				if (index > 0) stack.push({ kind: "text", text: "," });
			}
			stack.push({ kind: "text", text: "[" });
			continue;
		}

		const objectValue = value as { readonly [key: string]: JsonValue };
		const keys = Object.keys(objectValue).sort();
		stack.push({ kind: "text", text: "}" });
		for (let index = keys.length - 1; index >= 0; index--) {
			const key = keys[index]!;
			stack.push({ kind: "value", value: objectValue[key]! });
			stack.push({ kind: "text", text: `${JSON.stringify(key)}:` });
			if (index > 0) stack.push({ kind: "text", text: "," });
		}
		stack.push({ kind: "text", text: "{" });
	}

	return parts.join("");
}

/** Detached JSON-only snapshot; non-JSON values reject the plan instead of being dropped. */
function snapshotValue(value: unknown, code: RestorePlanErrorCode, label: string): JsonValue {
	try {
		return snapshotJsonValue(value, label);
	} catch (cause) {
		throw new RestorePlanError(code, `${label} is not a JSON-stable value: ${describeError(cause)}`, { cause });
	}
}

function validateSessionRecords(
	values: readonly JsonValue[],
	code: RestorePlanErrorCode,
	label: string,
	validateReferences: boolean,
): SessionRecord[] {
	const records: SessionRecord[] = [];
	for (let index = 0; index < values.length; index++) {
		records.push(validateSessionRecord(values[index], code, `${label}[${index}]`, validateReferences));
	}
	return records;
}

function validateSessionRecord(
	value: JsonValue | undefined,
	code: RestorePlanErrorCode,
	label: string,
	validateReferences: boolean,
): SessionRecord {
	if (!isJsonRecordValue(value)) {
		throw new RestorePlanError(code, `${label} must be an object with info and messages`);
	}
	for (const key of Object.keys(value)) {
		if (key !== "info" && key !== "messages") {
			throw new RestorePlanError(
				code,
				`${label} has unsupported top-level key ${JSON.stringify(key)}; expected exactly "info" and "messages"`,
			);
		}
	}
	const info = value["info"];
	if (!isJsonRecordValue(info)) {
		throw new RestorePlanError(code, `${label}.info must be an object`);
	}
	const id = info["id"];
	if (typeof id !== "string" || !id.startsWith("ses")) {
		throw new RestorePlanError(code, `${label}.info.id must be a string starting with "ses"`);
	}
	const rawMessages = value["messages"];
	if (!Array.isArray(rawMessages)) {
		throw new RestorePlanError(code, `${label}.messages must be an array`);
	}
	const messages: JsonObject[] = [];
	for (let index = 0; index < rawMessages.length; index++) {
		const rawMessage = rawMessages[index];
		if (!isJsonRecordValue(rawMessage)) {
			throw new RestorePlanError(code, `${label}.messages[${index}] must be an object`);
		}
		const messageID = rawMessage["id"];
		if (typeof messageID !== "string" || !messageID.startsWith("msg_")) {
			throw new RestorePlanError(code, `${label}.messages[${index}].id must be a string starting with "msg_"`);
		}
		messages.push(rawMessage);
	}

	const record: SessionRecord = { info, messages };
	if (validateReferences) validateSchemaReferences(record, code, label);
	return record;
}

/**
 * Validates the schema-defined reference fields and their required nested
 * shape via the shared validator in `../sessions/references.ts` (also used by
 * the checkpoint dependency collector, so reference rules cannot drift). The
 * violation message is identical to the previous local implementation.
 */
function validateSchemaReferences(record: SessionRecord, code: RestorePlanErrorCode, label: string): void {
	const violation = findSchemaReferenceViolation(record.info, `${label}.info`);
	if (violation !== undefined) {
		throw new RestorePlanError(code, violation);
	}
}

function cloneJsonObject(source: JsonObject): { [key: string]: JsonValue } {
	const copy = Object.create(null) as { [key: string]: JsonValue };
	for (const key of Object.keys(source)) {
		copy[key] = source[key]!;
	}
	return copy;
}

function resolveSessionReference(
	original: string,
	sourceSessionID: string,
	targetSessionID: string,
	sessionTargets: ReadonlyMap<string, string>,
	destinationSessionIDs: ReadonlySet<string>,
	label: string,
): string {
	if (original === sourceSessionID) return targetSessionID;
	const internal = sessionTargets.get(original);
	if (internal !== undefined) return internal;
	if (destinationSessionIDs.has(original)) return original;
	throw new RestorePlanError(
		"dangling-session-reference",
		`${label} references session ${JSON.stringify(original)}, which is neither part of this artifact nor present in the destination`,
	);
}

function resolveMessageReference(
	original: string,
	messageTargets: ReadonlyMap<string, string>,
	destinationMessageIDs: ReadonlySet<string>,
	label: string,
): string {
	const internal = messageTargets.get(original);
	if (internal !== undefined) return internal;
	if (destinationMessageIDs.has(original)) return original;
	throw new RestorePlanError(
		"dangling-message-reference",
		`${label} references message ${JSON.stringify(original)}, which is neither part of this artifact nor present in the destination`,
	);
}

/**
 * Builds the planned record: `info.id` set to the target session ID, every
 * message `id` set to its planned target, and only the schema-defined
 * references rewritten. All other fields are preserved as detached copies.
 */
function buildPlannedRecord(
	session: UniqueSession,
	targetSessionID: string,
	plannedMessageTargets: readonly string[],
	sessionTargets: ReadonlyMap<string, string>,
	messageTargets: ReadonlyMap<string, string>,
	destinationSessionIDs: ReadonlySet<string>,
	destinationMessageIDs: ReadonlySet<string>,
): SessionRecord {
	const label = `payload.sessions[${session.payloadIndex}]`;
	const info = session.record.info;
	const nextInfo = cloneJsonObject(info);
	nextInfo["id"] = targetSessionID;

	const parentID = info["parentID"] as string | undefined;
	if (parentID !== undefined) {
		nextInfo["parentID"] = resolveSessionReference(
			parentID,
			session.sourceSessionID,
			targetSessionID,
			sessionTargets,
			destinationSessionIDs,
			`${label}.info.parentID`,
		);
	}

	const fork = info["fork"] as JsonObject | undefined;
	if (fork !== undefined) {
		const nextFork = cloneJsonObject(fork);
		const forkSessionID = fork["sessionID"] as string | undefined;
		if (forkSessionID !== undefined) {
			nextFork["sessionID"] = resolveSessionReference(
				forkSessionID,
				session.sourceSessionID,
				targetSessionID,
				sessionTargets,
				destinationSessionIDs,
				`${label}.info.fork.sessionID`,
			);
		}
		const boundary = fork["boundary"] as JsonObject | undefined;
		if (boundary !== undefined) {
			const nextBoundary = cloneJsonObject(boundary);
			const boundaryMessageID = boundary["messageID"] as string | undefined;
			if (boundaryMessageID !== undefined) {
				nextBoundary["messageID"] = resolveMessageReference(
					boundaryMessageID,
					messageTargets,
					destinationMessageIDs,
					`${label}.info.fork.boundary.messageID`,
				);
			}
			nextFork["boundary"] = nextBoundary;
		}
		nextInfo["fork"] = nextFork;
	}

	const revert = info["revert"] as JsonObject | undefined;
	if (revert !== undefined) {
		const nextRevert = cloneJsonObject(revert);
		const revertMessageID = revert["messageID"] as string | undefined;
		if (revertMessageID !== undefined) {
			nextRevert["messageID"] = resolveMessageReference(
				revertMessageID,
				messageTargets,
				destinationMessageIDs,
				`${label}.info.revert.messageID`,
			);
		}
		nextInfo["revert"] = nextRevert;
	}

	const messages: JsonObject[] = [];
	for (let index = 0; index < session.record.messages.length; index++) {
		const nextMessage = cloneJsonObject(session.record.messages[index]!);
		nextMessage["id"] = plannedMessageTargets[index]!;
		messages.push(nextMessage);
	}

	return { info: nextInfo, messages };
}

/**
 * Full-preflight reference resolution for an unchanged skipped record (an
 * exact local duplicate). The record is never rewritten, so every unchanged
 * reference must still resolve after the restore:
 * - a session reference is acceptable when the referenced session already
 *   exists in the destination, or when it references an artifact session that
 *   this plan keeps at its source ID (imported/skipped targets);
 * - a message reference is acceptable only when the referenced message ID
 *   already exists in the destination, because every imported message ID is
 *   rederived and the skipped record cannot be rewritten to a remapped ID.
 */
function validateSkippedRecordReferences(
	plan: SessionPlan,
	planBySessionID: ReadonlyMap<string, SessionPlan>,
	destinationSessionIDs: ReadonlySet<string>,
	destinationMessageIDs: ReadonlySet<string>,
): void {
	const label = `payload.sessions[${plan.session.payloadIndex}]`;

	const requireUnchangedSessionReference = (original: string, context: string): void => {
		if (destinationSessionIDs.has(original)) return;
		const referenced = planBySessionID.get(original);
		if (referenced !== undefined && referenced.targetSessionID === original) return;
		throw new RestorePlanError(
			"dangling-session-reference",
			`${context} references session ${JSON.stringify(original)}, which is neither present in the destination nor kept at the same id by this plan; an unchanged skipped session cannot be rewritten`,
		);
	};
	const requireUnchangedMessageReference = (original: string, context: string): void => {
		if (destinationMessageIDs.has(original)) return;
		throw new RestorePlanError(
			"dangling-message-reference",
			`${context} references message ${JSON.stringify(original)}, which is not present in the destination; an unchanged skipped session cannot be rewritten to a remapped message id`,
		);
	};

	const info = plan.session.record.info;
	const parentID = info["parentID"] as string | undefined;
	if (parentID !== undefined) requireUnchangedSessionReference(parentID, `${label}.info.parentID`);

	const fork = info["fork"] as JsonObject | undefined;
	if (fork !== undefined) {
		requireUnchangedSessionReference(fork["sessionID"] as string, `${label}.info.fork.sessionID`);
		const boundary = fork["boundary"] as JsonObject;
		requireUnchangedMessageReference(boundary["messageID"] as string, `${label}.info.fork.boundary.messageID`);
	}

	const revert = info["revert"] as JsonObject | undefined;
	if (revert !== undefined) {
		requireUnchangedMessageReference(revert["messageID"] as string, `${label}.info.revert.messageID`);
	}
}

/* ------------------------------------------------------------------------- */
/* planRestore                                                               */
/* ------------------------------------------------------------------------- */

/**
 * Plans a restore from one authenticated checkpoint payload against the full
 * local destination snapshot. Pure and deterministic for identical inputs; it
 * performs no host call, file IO, or import. See the module comment for the
 * exact policy boundaries.
 */
export function planRestore(input: PlanRestoreInput): RestorePlan {
	if (!isObjectValue(input)) {
		throw new RestorePlanError(
			"invalid-input",
			"planRestore requires an input object with payload, artifactIdentity, destination, and idDeriver",
		);
	}

	const rawDeriver: unknown = input.idDeriver;
	if (!isObjectValue(rawDeriver) || typeof rawDeriver["derive"] !== "function") {
		throw new RestorePlanError(
			"invalid-input",
			"planRestore requires an idDeriver with a derive(namespace, artifactIdentity, originalID) function",
		);
	}
	const idDeriver = rawDeriver as unknown as RemappedIdDeriver;

	const rawIdentity: unknown = input.artifactIdentity;
	if (!(rawIdentity instanceof Uint8Array) || rawIdentity.length !== ARTIFACT_IDENTITY_BYTES) {
		throw new RestorePlanError(
			"invalid-input",
			`planRestore requires an artifactIdentity Uint8Array of exactly ${ARTIFACT_IDENTITY_BYTES} bytes`,
		);
	}
	const artifactIdentity = Uint8Array.from(rawIdentity);

	const rawDestination: unknown = input.destination;
	if (!Array.isArray(rawDestination)) {
		throw new RestorePlanError("invalid-input", "planRestore requires destination to be an array of local session records");
	}

	/* -- Global occupancy inventory (2026-10-14 owner amendment): session IDs
	 * visible outside the selected destination project, occupancy only. It is
	 * snapshotted into a set immediately, must be a duplicate-free list of
	 * non-blank string IDs, and is never used to satisfy references, classify
	 * duplicates, or classify retries. -- */
	const rawGlobalInventory: unknown = input.globallyVisibleSessionIDs;
	const globalSessionIDs = new Set<string>();
	if (rawGlobalInventory !== undefined) {
		if (!Array.isArray(rawGlobalInventory)) {
			throw new RestorePlanError(
				"invalid-input",
				"planRestore requires globallyVisibleSessionIDs to be an array of session ids when provided",
			);
		}
		for (let index = 0; index < rawGlobalInventory.length; index++) {
			const sessionID: unknown = rawGlobalInventory[index];
			if (typeof sessionID !== "string" || sessionID.trim().length === 0) {
				throw new RestorePlanError(
					"invalid-input",
					`globallyVisibleSessionIDs[${index}] must be a non-blank string session id`,
				);
			}
			if (globalSessionIDs.has(sessionID)) {
				throw new RestorePlanError(
					"invalid-input",
					`globallyVisibleSessionIDs repeats session id ${JSON.stringify(sessionID)}; refusing to plan against an ambiguous global inventory`,
				);
			}
			globalSessionIDs.add(sessionID);
		}
	}

	/* -- 1. Snapshot/validate the artifact payload (fail closed, no mutation). -- */
	const payloadSnapshot = snapshotValue(input.payload, "malformed-payload", "payload");
	if (!isJsonRecordValue(payloadSnapshot)) {
		throw new RestorePlanError("malformed-payload", "payload must be a JSON object with a sessions array");
	}
	const sessionsValue = payloadSnapshot["sessions"];
	if (!Array.isArray(sessionsValue)) {
		throw new RestorePlanError("malformed-payload", "payload.sessions must be an array of session records");
	}
	for (const key of Object.keys(payloadSnapshot)) {
		if (key !== "sessions") {
			throw new RestorePlanError(
				"malformed-payload",
				`payload has unsupported top-level key ${JSON.stringify(key)}; expected exactly "sessions"`,
			);
		}
	}
	const sourceRecords = validateSessionRecords(sessionsValue, "malformed-payload", "payload.sessions", true);

	/* -- 2. Collapse identical repeated artifact records; reject divergence and message-ID reuse. -- */
	const uniqueSessions: UniqueSession[] = [];
	const artifactBySessionID = new Map<string, { canonical: string; uniqueIndex: number }>();
	let collapsedDuplicateCount = 0;

	for (let index = 0; index < sourceRecords.length; index++) {
		const record = sourceRecords[index]!;
		const sourceSessionID = record.info["id"] as string;
		const canonical = canonicalJson(record as unknown as JsonValue);
		const existing = artifactBySessionID.get(sourceSessionID);
		if (existing !== undefined) {
			if (existing.canonical === canonical) {
				collapsedDuplicateCount += 1;
				continue;
			}
			throw new RestorePlanError(
				"divergent-artifact-session",
				`payload.sessions[${index}] repeats session id ${JSON.stringify(sourceSessionID)} with different content`,
			);
		}

		const messageIDs: string[] = [];
		for (let messageIndex = 0; messageIndex < record.messages.length; messageIndex++) {
			messageIDs.push(record.messages[messageIndex]!["id"] as string);
		}

		artifactBySessionID.set(sourceSessionID, { canonical, uniqueIndex: uniqueSessions.length });
		uniqueSessions.push({
			sourceIndex: uniqueSessions.length,
			payloadIndex: index,
			sourceSessionID,
			record,
			canonical,
			messageIDs,
		});
	}

	const artifactMessageOwner = new Map<string, number>();
	for (const session of uniqueSessions) {
		for (const messageID of session.messageIDs) {
			if (artifactMessageOwner.has(messageID)) {
				throw new RestorePlanError(
					"duplicate-artifact-message-id",
					`message id ${JSON.stringify(messageID)} appears more than once among the unique artifact session records`,
				);
			}
			artifactMessageOwner.set(messageID, session.sourceIndex);
		}
	}

	/* -- 3. Snapshot/validate the destination; reject ambiguous duplicates. -- */
	const destinationSnapshot = snapshotValue(rawDestination, "malformed-destination", "destination");
	if (!Array.isArray(destinationSnapshot)) {
		throw new RestorePlanError("malformed-destination", "destination must be an array of session records");
	}
	const destinationRecords = validateSessionRecords(destinationSnapshot, "malformed-destination", "destination", false);

	const destinationBySessionID = new Map<string, DestinationSession>();
	const destinationSessionIDs = new Set<string>();
	const destinationMessageIDs = new Set<string>();
	for (let index = 0; index < destinationRecords.length; index++) {
		const record = destinationRecords[index]!;
		const sessionID = record.info["id"] as string;
		if (destinationBySessionID.has(sessionID)) {
			throw new RestorePlanError(
				"ambiguous-destination",
				`destination repeats session id ${JSON.stringify(sessionID)}; refusing to classify against an ambiguous local snapshot`,
			);
		}
		destinationBySessionID.set(sessionID, { record, canonical: canonicalJson(record as unknown as JsonValue) });
		destinationSessionIDs.add(sessionID);
		for (let messageIndex = 0; messageIndex < record.messages.length; messageIndex++) {
			const messageID = record.messages[messageIndex]!["id"] as string;
			if (destinationMessageIDs.has(messageID)) {
				throw new RestorePlanError(
					"ambiguous-destination",
					`destination repeats message id ${JSON.stringify(messageID)}; refusing to classify against an ambiguous local snapshot`,
				);
			}
			destinationMessageIDs.add(messageID);
		}
	}

	/* -- Derivation helper: deterministic, fail closed, never regenerates.
	 * Each call gets a fresh copy of the identity so a mutating deriver cannot
	 * influence later derivations or reach caller-owned bytes. -- */
	const deriveTargetID = (namespace: "session" | "message", originalID: string, context: string): string => {
		let derived: unknown;
		try {
			derived = idDeriver.derive(namespace, Uint8Array.from(artifactIdentity), originalID);
		} catch (cause) {
			throw new RestorePlanError(
				"derivation-failure",
				`remapped ${namespace} ID derivation failed for ${context}: ${describeError(cause)}`,
				{ cause },
			);
		}
		const pattern = TARGET_ID_PATTERNS[namespace];
		if (typeof derived !== "string" || !pattern.test(derived)) {
			throw new RestorePlanError(
				"derivation-failure",
				`remapped ${namespace} ID derivation for ${context} must return a string matching ${pattern.source}`,
			);
		}
		return derived;
	};

	/* -- 4. Classify each unique session; derive every message ID for imports. -- */
	const plans: SessionPlan[] = [];
	for (const session of uniqueSessions) {
		const destinationMatch = destinationBySessionID.get(session.sourceSessionID);
		if (destinationMatch !== undefined && destinationMatch.canonical === session.canonical) {
			plans.push({
				session,
				classification: "skipped",
				targetSessionID: session.sourceSessionID,
				skipReason: "exact-local-duplicate",
				record: session.record,
				messageTargets: [...session.messageIDs],
				planned: false,
			});
			continue;
		}

		/* Occupied in the selected destination or visible outside it: derive a
		 * new session ID with the existing deterministic derivation. */
		const conflict = destinationMatch !== undefined || globalSessionIDs.has(session.sourceSessionID);
		plans.push({
			session,
			classification: conflict ? "renamed" : "imported",
			targetSessionID: conflict
				? deriveTargetID("session", session.sourceSessionID, `session ${JSON.stringify(session.sourceSessionID)}`)
				: session.sourceSessionID,
			skipReason: undefined,
			record: session.record,
			messageTargets: [],
			planned: true,
		});
	}

	for (const plan of plans) {
		if (!plan.planned) continue;
		const targets: string[] = [];
		for (const messageID of plan.session.messageIDs) {
			targets.push(
				deriveTargetID(
					"message",
					messageID,
					`message ${JSON.stringify(messageID)} in session ${JSON.stringify(plan.session.sourceSessionID)}`,
				),
			);
		}
		plan.messageTargets = targets;
	}

	const sessionTargets = new Map<string, string>();
	const messageTargets = new Map<string, string>();
	for (const plan of plans) {
		sessionTargets.set(plan.session.sourceSessionID, plan.targetSessionID);
		for (let index = 0; index < plan.session.messageIDs.length; index++) {
			messageTargets.set(plan.session.messageIDs[index]!, plan.messageTargets[index]!);
		}
	}

	/* -- 5. Exact deterministic retry detection, iterated to a fixed point
	 * (bounded exact-content only; O-06 stays OPEN). Plans are re-evaluated in
	 * deterministic source-session-ID order until no classification changes, so
	 * a retry whose planned record depends on another plan that only became an
	 * exact retry in an earlier pass is still recognized and the result does not
	 * depend on payload order. Classification only ever moves `renamed` ->
	 * `skipped`, so the loop terminates after at most one full pass per plan.
	 * Every retry match requires the exact planned record in the selected
	 * destination (at the source ID, or at the derived target for a global-only
	 * conflict); the global inventory is never retry evidence. -- */
	const retryEvaluationOrder = [...plans].sort((left, right) => {
		const leftID = left.session.sourceSessionID;
		const rightID = right.session.sourceSessionID;
		return leftID < rightID ? -1 : leftID > rightID ? 1 : 0;
	});
	let classificationChanged = true;
	while (classificationChanged) {
		classificationChanged = false;
		for (const plan of retryEvaluationOrder) {
			if (!plan.planned || plan.classification !== "renamed") continue;
			const destinationMatch = destinationBySessionID.get(plan.session.sourceSessionID);

			/* A destination record at the source ID can only be an exact retry
			 * at the source ID; a global-only conflict has no such record, so
			 * only the derived target is checked for it. */
			if (destinationMatch !== undefined) {
				const retryAtSource = buildPlannedRecord(
					plan.session,
					plan.session.sourceSessionID,
					plan.messageTargets,
					sessionTargets,
					messageTargets,
					destinationSessionIDs,
					destinationMessageIDs,
				);
				if (destinationMatch.canonical === canonicalJson(retryAtSource as unknown as JsonValue)) {
					plan.classification = "skipped";
					plan.targetSessionID = plan.session.sourceSessionID;
					plan.skipReason = "exact-planned-retry";
					plan.record = retryAtSource;
					plan.planned = false;
					sessionTargets.set(plan.session.sourceSessionID, plan.session.sourceSessionID);
					classificationChanged = true;
					continue;
				}
			}

			const derivedMatch = destinationBySessionID.get(plan.targetSessionID);
			if (derivedMatch === undefined) continue;
			const retryAtDerived = buildPlannedRecord(
				plan.session,
				plan.targetSessionID,
				plan.messageTargets,
				sessionTargets,
				messageTargets,
				destinationSessionIDs,
				destinationMessageIDs,
			);
			if (derivedMatch.canonical === canonicalJson(retryAtDerived as unknown as JsonValue)) {
				plan.classification = "skipped";
				plan.skipReason = "exact-planned-retry";
				plan.record = retryAtDerived;
				plan.planned = false;
				classificationChanged = true;
			}
		}
	}

	/* -- 5b. A still-renamed plan whose derived target already exists with
	 * different content is a collision. Deferred until the retry fixed point
	 * settles so a state-dependent retry match is never missed. -- */
	for (const plan of plans) {
		if (!plan.planned || plan.classification !== "renamed") continue;
		if (destinationSessionIDs.has(plan.targetSessionID)) {
			throw new RestorePlanError(
				"session-id-collision",
				`planned remapped session id ${JSON.stringify(plan.targetSessionID)} for source session ${JSON.stringify(plan.session.sourceSessionID)} already exists in the destination with different content`,
			);
		}
	}

	/* -- 5c. A planned target session ID that is globally occupied but absent
	 * from the selected destination fails closed (2026-10-14 owner amendment):
	 * the derived ID is never re-derived and never retried. Entries whose
	 * target already exists in the selected destination are exempt because the
	 * destination's own IDs are naturally part of the global inventory; exact
	 * planned retries therefore remain recognized only at the selected
	 * destination. -- */
	for (const plan of plans) {
		if (!plan.planned) continue;
		if (!destinationSessionIDs.has(plan.targetSessionID) && globalSessionIDs.has(plan.targetSessionID)) {
			throw new RestorePlanError(
				"session-id-collision",
				`planned target session id ${JSON.stringify(plan.targetSessionID)} for source session ${JSON.stringify(plan.session.sourceSessionID)} is already occupied by a session outside the selected destination; refusing to re-derive or retry`,
			);
		}
	}

	/* -- 6. Build final records for imported/renamed sessions; validate references. -- */
	for (const plan of plans) {
		if (!plan.planned) continue;
		plan.record = buildPlannedRecord(
			plan.session,
			plan.targetSessionID,
			plan.messageTargets,
			sessionTargets,
			messageTargets,
			destinationSessionIDs,
			destinationMessageIDs,
		);
	}

	/* -- 6b. Full-preflight resolution for unchanged skipped (exact local
	 * duplicate) records: nothing is rewritten for them, so every schema-defined
	 * reference must already resolve after the restore. -- */
	const planBySessionID = new Map<string, SessionPlan>();
	for (const plan of plans) planBySessionID.set(plan.session.sourceSessionID, plan);
	for (const plan of plans) {
		if (plan.classification !== "skipped" || plan.skipReason !== "exact-local-duplicate") continue;
		validateSkippedRecordReferences(plan, planBySessionID, destinationSessionIDs, destinationMessageIDs);
	}

	/* -- 7. Collision detection: final target IDs must be unique across every
	 * unique artifact entry (exact-local and exact-retry skips included), so two
	 * distinct source sessions can never coalesce onto one target even when a
	 * deriver collision makes their transformed records identical. Destination
	 * occupancy is only checked for entries that are actually imported: exact
	 * local/retry records necessarily already exist in the destination. -- */
	const artifactSessionTargets = new Map<string, string>();
	for (const plan of plans) {
		const prior = artifactSessionTargets.get(plan.targetSessionID);
		if (prior !== undefined) {
			throw new RestorePlanError(
				"session-id-collision",
				`artifact sessions ${JSON.stringify(prior)} and ${JSON.stringify(plan.session.sourceSessionID)} map to the same target session id ${JSON.stringify(plan.targetSessionID)}`,
			);
		}
		artifactSessionTargets.set(plan.targetSessionID, plan.session.sourceSessionID);
	}
	for (const plan of plans) {
		if (!plan.planned) continue;
		if (destinationSessionIDs.has(plan.targetSessionID)) {
			throw new RestorePlanError(
				"session-id-collision",
				`planned target session id ${JSON.stringify(plan.targetSessionID)} for source session ${JSON.stringify(plan.session.sourceSessionID)} already exists in the destination`,
			);
		}
	}

	const artifactMessageTargets = new Map<string, string>();
	for (const plan of plans) {
		for (const target of plan.messageTargets) {
			const prior = artifactMessageTargets.get(target);
			if (prior !== undefined) {
				throw new RestorePlanError(
					"message-id-collision",
					`artifact sessions ${JSON.stringify(prior)} and ${JSON.stringify(plan.session.sourceSessionID)} map to the same target message id ${JSON.stringify(target)}`,
				);
			}
			artifactMessageTargets.set(target, plan.session.sourceSessionID);
		}
	}
	for (const plan of plans) {
		if (!plan.planned) continue;
		for (const target of plan.messageTargets) {
			if (destinationMessageIDs.has(target)) {
				throw new RestorePlanError(
					"message-id-collision",
					`planned target message id ${JSON.stringify(target)} for session ${JSON.stringify(plan.session.sourceSessionID)} already exists in the destination`,
				);
			}
		}
	}

	/* -- 8. Deterministic parent-before-child import order. -- */
	const plannedPlans = plans.filter((plan) => plan.planned);
	const planByMessageID = new Map<string, SessionPlan>();
	for (const plan of plans) {
		for (const messageID of plan.session.messageIDs) planByMessageID.set(messageID, plan);
	}

	const dependencies = new Map<SessionPlan, Set<SessionPlan>>();
	for (const plan of plannedPlans) dependencies.set(plan, new Set());

	const requireSessionDependency = (plan: SessionPlan, referenced: SessionPlan, kind: string): void => {
		if (referenced === plan) {
			throw new RestorePlanError(
				"dependency-cycle",
				`${kind} of session ${JSON.stringify(plan.session.sourceSessionID)} references the same session; refusing an ambiguous self-dependency`,
			);
		}
		if (referenced.planned) dependencies.get(plan)!.add(referenced);
	};
	const requireMessageDependency = (plan: SessionPlan, referenced: SessionPlan): void => {
		// A message reference into the same session is part of the same import
		// unit (for example a session reverting to its own message), so it adds
		// no cross-session ordering constraint.
		if (referenced === plan) return;
		if (referenced.planned) dependencies.get(plan)!.add(referenced);
	};

	for (const plan of plannedPlans) {
		const info = plan.session.record.info;
		const parentID = info["parentID"] as string | undefined;
		if (parentID !== undefined) {
			const referenced = planBySessionID.get(parentID);
			if (referenced !== undefined) requireSessionDependency(plan, referenced, "info.parentID");
		}
		const fork = info["fork"] as JsonObject | undefined;
		if (fork !== undefined) {
			const forkSessionID = fork["sessionID"] as string | undefined;
			if (forkSessionID !== undefined) {
				const referenced = planBySessionID.get(forkSessionID);
				if (referenced !== undefined) requireSessionDependency(plan, referenced, "info.fork.sessionID");
			}
			const boundary = fork["boundary"] as JsonObject | undefined;
			if (boundary !== undefined) {
				const boundaryMessageID = boundary["messageID"] as string | undefined;
				if (boundaryMessageID !== undefined) {
					const referenced = planByMessageID.get(boundaryMessageID);
					if (referenced !== undefined) requireMessageDependency(plan, referenced);
				}
			}
		}
		const revert = info["revert"] as JsonObject | undefined;
		if (revert !== undefined) {
			const revertMessageID = revert["messageID"] as string | undefined;
			if (revertMessageID !== undefined) {
				const referenced = planByMessageID.get(revertMessageID);
				if (referenced !== undefined) requireMessageDependency(plan, referenced);
			}
		}
	}

	const orderedPlans: SessionPlan[] = [];
	const remaining = new Set<SessionPlan>(plannedPlans);
	while (remaining.size > 0) {
		let picked: SessionPlan | undefined;
		for (const candidate of plannedPlans) {
			if (!remaining.has(candidate)) continue;
			let ready = true;
			for (const dependency of dependencies.get(candidate)!) {
				if (remaining.has(dependency)) {
					ready = false;
					break;
				}
			}
			if (ready) {
				picked = candidate;
				break;
			}
		}
		if (picked === undefined) {
			throw new RestorePlanError(
				"dependency-cycle",
				`import order cannot be resolved: ${remaining.size} session(s) form a reference cycle or ambiguous dependency`,
			);
		}
		orderedPlans.push(picked);
		remaining.delete(picked);
	}

	const entries: RestorePlanEntry[] = plans.map((plan) => {
		const entry: RestorePlanEntry = {
			sourceSessionID: plan.session.sourceSessionID,
			targetSessionID: plan.targetSessionID,
			classification: plan.classification,
			record: plan.record,
			...(plan.skipReason !== undefined ? { skipReason: plan.skipReason } : {}),
		};
		return entry;
	});

	const entryByPlan = new Map<SessionPlan, RestorePlanEntry>();
	for (let index = 0; index < plans.length; index++) entryByPlan.set(plans[index]!, entries[index]!);
	const importOrder = orderedPlans.map((plan) => entryByPlan.get(plan)!);

	return { entries, importOrder, collapsedDuplicateCount };
}
