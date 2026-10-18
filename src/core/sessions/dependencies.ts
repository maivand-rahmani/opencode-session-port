/**
 * Checkpoint-only recursive dependency closure (owner-approved 2026-10-18
 * amendment; decision-log change control).
 *
 * `collectCheckpointPayloadWithDependencies` starts from the exact existing
 * project-scoped collection (`collectCheckpointPayload`, unchanged) and then
 * follows only the schema-defined session references of the collected records:
 * `info.parentID` and `info.fork.sessionID`. Each newly referenced session is
 * fetched once through the explicit `getSession(sessionID)` port method and its
 * complete message history is collected with the same pagination, settled-
 * message, duplicate, and bound rules used for seeds. This closes the
 * cross-machine `dangling-session-reference` gap where a project-scoped listing
 * omits a referenced parent/fork session that lives outside the selected
 * project.
 *
 * Policy boundaries (2026-10-18 amendment):
 * - Seed sessions keep the exact project-scope binding: every session returned
 *   by the project-scoped list must carry a `projectID` exactly equal to the
 *   requested project or the whole collection fails with
 *   `session-project-mismatch`. Dependency sessions are accepted only as the
 *   explicit result of `getSession(requestedID)`; their `projectID` must be a
 *   present nonblank string but is never compared to the seed project (a
 *   foreign-project dependency is the point), and the returned `id` must equal
 *   the exact requested ID or the collection fails closed.
 * - No whole-project scan, no dependency `listSessions` call, no retry, and no
 *   concurrent fetch: the closure is sequential and deduplicated by session
 *   ID, so a shared/diamond reference is fetched exactly once.
 * - The aggregate `maxSessions` / `maxTotalMessages` bounds span seeds plus
 *   dependencies; `maxMessagesPerSession` is unchanged. The session bound is
 *   checked before an extra `getSession` call, so a closure whose session
 *   count is already known to exceed the bound fails without fetching.
 * - Schema references are validated with the same shared rules the restore
 *   planner uses (`findSchemaReferenceViolation`): malformed or null
 *   reference fields fail closed instead of being stripped, normalized, or
 *   treated as absent. `info.fork.boundary.messageID` and
 *   `info.revert.messageID` must resolve to a message collected in this
 *   payload; a dangling message reference fails closed.
 * - Reference cycles (self-references and multi-session parent/fork cycles)
 *   are rejected before any payload is returned, using the planner's
 *   parent/fork dependency edges. No ordering is emitted here: the restore
 *   planner owns import order.
 * - Everything else is preserved verbatim: records and messages are detached
 *   JSON snapshots with no canonicalization, remapping, filtering, or field
 *   normalization, and no hashing/crypto is performed in this lane.
 *
 * Fail-closed error codes reuse the existing `SessionCollectionError` set (no
 * new codes): a missing/non-callable `getSession` is `invalid-request`; a
 * `getSession` call that throws is `session-list-failed` (cause preserved);
 * a malformed, non-JSON, enveloped, wrong-ID, or projectID-less response, a
 * malformed reference, an unresolved message reference, or a reference cycle
 * is `malformed-session-record`. Error messages carry IDs/labels only and
 * never dump a raw response record.
 *
 * Consistency caveat (O-21 / OQ-23): the upstream list/get APIs document no
 * atomic snapshot, so this remains a best-effort read sequence, not a
 * consistent point-in-time capture, and it defines no retry policy.
 */

import type { CheckpointPayload, JsonObject, SessionRecord } from "../contracts/index.ts";
import {
	callPort,
	collectCheckpointPayload,
	collectSessionMessages,
	snapshotJsonRecord,
	type CollectCheckpointPayloadRequest,
} from "./collector.ts";
import { SessionCollectionError } from "./errors.ts";
import { isJsonObject } from "./guards.ts";
import { validateSessionCollectionPolicy } from "./policy.ts";
import type { SessionDependencyReadPort } from "./port.ts";
import { findSchemaReferenceViolation } from "./references.ts";

/**
 * Collects a complete `CheckpointPayload` for one explicit project, including
 * the recursive schema-referenced dependency closure.
 *
 * Behavior:
 * 1. Seeds: the unchanged project-scoped `collectCheckpointPayload` (explicit
 *    project binding, cursor exhaustion, settled messages, per-session and
 *    aggregate seed bounds).
 * 2. Closure: every collected record's `info.parentID` and
 *    `info.fork.sessionID` are validated against the shared schema rules and
 *    enqueued in discovery order (parent before fork, seeds before
 *    dependencies). Each not-yet-collected ID is fetched exactly once through
 *    `port.getSession(id)` — never through `listSessions` — and its complete
 *    message history is collected with the reused per-session pagination.
 * 3. Validation: message references (`info.fork.boundary.messageID`,
 *    `info.revert.messageID`) must resolve within the collected payload, and
 *    the parent/fork reference graph must be acyclic.
 *
 * The returned payload is seeds first (project list order), then dependencies
 * in first-discovery order. Any failure throws before a payload exists; no
 * partial or truncated payload is ever returned.
 */
export async function collectCheckpointPayloadWithDependencies(
	port: SessionDependencyReadPort,
	input: CollectCheckpointPayloadRequest,
): Promise<CheckpointPayload> {
	if (!isJsonObject(input)) {
		throw new SessionCollectionError(
			"invalid-request",
			"collectCheckpointPayloadWithDependencies requires an input object with an explicit projectID and SessionCollectionPolicy",
		);
	}
	if (
		typeof port?.listSessions !== "function" ||
		typeof port?.listMessages !== "function" ||
		typeof port?.getSession !== "function"
	) {
		throw new SessionCollectionError(
			"invalid-request",
			"SessionDependencyReadPort must provide listSessions, listMessages, and getSession",
		);
	}
	validateSessionCollectionPolicy(input.policy);
	const projectID = input.projectID;
	if (typeof projectID !== "string" || projectID.length === 0) {
		throw new SessionCollectionError(
			"invalid-request",
			"collectCheckpointPayloadWithDependencies requires an explicit non-empty projectID string; current-project resolution is out of scope (OQ-10)",
		);
	}

	/* -- 1. Seeds: exact existing project-scoped collection (unchanged). -- */
	const seedPayload = await collectCheckpointPayload(port, input);

	/* -- 2. Sequential, deduplicated closure over schema session references. -- */
	const sessions: SessionRecord[] = [...seedPayload.sessions];
	const sessionIds = new Set<string>();
	/** Aggregate message count across seeds and dependencies; enforced by the reused per-session collector. */
	let collectedMessageCount = 0;
	for (const record of sessions) {
		sessionIds.add(record.info["id"] as string);
		collectedMessageCount += record.messages.length;
	}

	/** Session references per collected record (planner parent/fork dependency edges). */
	const sessionReferencesByID = new Map<string, readonly string[]>();
	const pendingIDs: string[] = [];
	const pending = new Set<string>();

	/**
	 * Validates one record's schema references with the shared planner rules and
	 * enqueues its `parentID`/`fork.sessionID` references in that order. Dedup
	 * happens at enqueue time so a shared dependency is fetched exactly once.
	 */
	const enqueueSessionReferences = (record: SessionRecord, label: string): void => {
		const info = record.info;
		const violation = findSchemaReferenceViolation(info, label);
		if (violation !== undefined) {
			throw new SessionCollectionError("malformed-session-record", violation);
		}
		const references: string[] = [];
		const parentID = info["parentID"];
		if (typeof parentID === "string") references.push(parentID);
		const fork = info["fork"];
		if (isJsonObject(fork)) {
			const forkSessionID = fork["sessionID"];
			if (typeof forkSessionID === "string") references.push(forkSessionID);
		}
		sessionReferencesByID.set(info["id"] as string, references);
		for (const referencedID of references) {
			if (sessionIds.has(referencedID) || pending.has(referencedID)) continue;
			pending.add(referencedID);
			pendingIDs.push(referencedID);
		}
	};

	// Every seed is validated before any dependency fetch, so a malformed seed
	// reference fails without touching the dependency read surface.
	for (const record of sessions) {
		enqueueSessionReferences(record, `Session ${JSON.stringify(record.info["id"])}`);
	}

	// Sequential fetch loop (no retries, no concurrency). `pendingIDs` grows
	// while it is walked, so dependencies of dependencies are resolved too.
	for (let index = 0; index < pendingIDs.length; index++) {
		const referencedID = pendingIDs[index]!;
		if (sessionIds.has(referencedID)) continue;
		if (sessions.length >= input.policy.maxSessions) {
			throw new SessionCollectionError(
				"session-limit-exceeded",
				`Dependency closure needs session ${JSON.stringify(referencedID)} but the aggregate session count would exceed SessionCollectionPolicy.maxSessions=${input.policy.maxSessions}; refusing to fetch beyond the bound or emit a partial checkpoint`,
			);
		}
		const label = `Session fetch for ${JSON.stringify(referencedID)}`;
		const rawResponse = await callPort(
			() => port.getSession(referencedID),
			"session-list-failed",
			`${label} request failed`,
		);
		const info = parseDependencyResponse(rawResponse, referencedID, label);
		const messages = await collectSessionMessages(port, referencedID, input.policy, collectedMessageCount);
		collectedMessageCount += messages.length;
		const record: SessionRecord = { info, messages };
		sessions.push(record);
		sessionIds.add(referencedID);
		enqueueSessionReferences(record, label);
	}

	/* -- 3a. Schema message references must resolve inside this payload. -- */
	const collectedMessageIDs = new Set<string>();
	for (const record of sessions) {
		for (const message of record.messages) {
			collectedMessageIDs.add(message["id"] as string);
		}
	}
	for (const record of sessions) {
		const info = record.info;
		const label = `Session ${JSON.stringify(info["id"])}`;
		const fork = info["fork"];
		if (isJsonObject(fork)) {
			const boundary = fork["boundary"];
			if (isJsonObject(boundary)) {
				requireCollectedMessageReference(
					boundary["messageID"] as string,
					`${label}.fork.boundary.messageID`,
					collectedMessageIDs,
				);
			}
		}
		const revert = info["revert"];
		if (isJsonObject(revert)) {
			requireCollectedMessageReference(revert["messageID"] as string, `${label}.revert.messageID`, collectedMessageIDs);
		}
	}

	/* -- 3b. Cycle rejection with the planner's parent/fork dependency edges.
	 * Every reference was fetched above, so each edge points at a collected
	 * session; a session that can never become "ready" (self-reference or a
	 * multi-session cycle) rejects the whole collection before any payload is
	 * returned. -- */
	const remaining = new Set<string>(sessionIds);
	while (remaining.size > 0) {
		let picked: string | undefined;
		for (const record of sessions) {
			const id = record.info["id"] as string;
			if (!remaining.has(id)) continue;
			let ready = true;
			for (const referencedID of sessionReferencesByID.get(id) ?? []) {
				if (remaining.has(referencedID)) {
					ready = false;
					break;
				}
			}
			if (ready) {
				picked = id;
				break;
			}
		}
		if (picked === undefined) {
			throw new SessionCollectionError(
				"malformed-session-record",
				`Session reference closure contains a parent/fork cycle among ${remaining.size} session(s); restore semantics would reject it, so the checkpoint fails closed`,
			);
		}
		remaining.delete(picked);
	}

	return { sessions };
}

/**
 * Fail-closed narrowing of one untrusted `getSession` response.
 *
 * The pinned v2.0.22 generated client declares
 * `get(input: { sessionID }) => Promise<SessionInfo>` and resolves the
 * already-unwrapped `SessionInfo` directly — the raw protocol
 * `{ data: sessionInfo }` envelope is unwrapped by the generated promise
 * client before the adapter sees it, and the adapter passes that raw resolved
 * value through unchanged. This function therefore validates the direct
 * session info object only: no envelope fallback or unwrapping happens here.
 * The value is snapshotted into a detached JSON-only record; the returned `id`
 * must equal the exact requested ID and `projectID` must be a present nonblank
 * string (the same readable-session-info contract the seed list and the
 * import adapter enforce). A foreign `projectID` value is accepted — it is
 * never compared to the seed project — and the field is validated, never
 * normalized or rewritten. Anything else (including a `{ data }`-shaped value,
 * which has no direct string `id`) fails closed with
 * `malformed-session-record`. Error messages never echo the raw response.
 */
function parseDependencyResponse(value: unknown, requestedID: string, label: string): JsonObject {
	if (!isJsonObject(value)) {
		throw new SessionCollectionError(
			"malformed-session-record",
			`${label} did not resolve to a direct session info object; refusing an unreadable dependency`,
		);
	}
	const info = snapshotJsonRecord(value, "malformed-session-record", label);
	const id = info["id"];
	if (typeof id !== "string" || id !== requestedID) {
		throw new SessionCollectionError(
			"malformed-session-record",
			`${label} resolved to session ${
				typeof id === "string" ? JSON.stringify(id) : "without a string id"
			} instead of the exact requested id; refusing an ambiguous dependency`,
		);
	}
	const projectID = info["projectID"];
	if (typeof projectID !== "string" || projectID.trim().length === 0) {
		throw new SessionCollectionError(
			"malformed-session-record",
			`${label} resolved to a session without a nonblank string projectID; refusing a dependency record that is not a readable session info object`,
		);
	}
	return info;
}

/** Requires one schema message reference to resolve to a collected message; otherwise fails closed. */
function requireCollectedMessageReference(
	messageID: string,
	label: string,
	collectedMessageIDs: ReadonlySet<string>,
): void {
	if (collectedMessageIDs.has(messageID)) return;
	throw new SessionCollectionError(
		"malformed-session-record",
		`${label} references message ${JSON.stringify(messageID)}, which is not part of the collected checkpoint payload; refusing an unresolved schema reference`,
	);
}
