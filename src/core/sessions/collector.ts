import {
	snapshotJsonValue,
	type CheckpointPayload,
	type JsonObject,
	type JsonValue,
	type SessionRecord,
} from "../contracts/index.ts";
import { SessionCollectionError, type SessionCollectionErrorCode } from "./errors.ts";
import { errorText, isJsonObject } from "./guards.ts";
import { validateSessionCollectionPolicy, type SessionCollectionPolicy } from "./policy.ts";
import type { MessageListPageRequest, SessionListPageRequest, SessionReadPort } from "./port.ts";
import { findUnsettledMessageReason } from "./unsettled.ts";

/** Input for one checkpoint payload collection. The project and every bound are explicit. */
export interface CollectCheckpointPayloadRequest {
	/** Explicit project scope; current-project resolution is out of scope (OQ-10). */
	readonly projectID: string;
	/** Explicit local limits; no defaults are applied. */
	readonly policy: SessionCollectionPolicy;
}

/**
 * Collects a complete `CheckpointPayload` for one explicit project by paging
 * the session list and each session's message list to exhaustion.
 *
 * Behavior (v2.0.22 declarations/source research, E13–E15):
 * - Follows `cursor.next` until it is absent or `null`; page size always comes
 *   from the explicit policy.
 * - Includes every session the API returns. Archived sessions are not
 *   filtered and child links are not inferred; child-association semantics and
 *   legacy fork semantics remain OPEN (OQ-10).
 * - First message page requests `order: "asc"`; subsequent pages pass only the
 *   opaque cursor (the API cannot combine `order` with `cursor`). No `type`
 *   filter is ever sent, and `session.export` is never used because it drops
 *   unsettled entries silently (E15).
 * - Every item is validated into a detached JSON-only snapshot via the shared
 *   `snapshotJsonValue` contract; opaque `info`/message fields and all
 *   IDs/references are preserved unchanged (no canonicalization or remapping
 *   here — O-04/O-05 are OPEN).
 * - Returned sessions are bound to the requested scope fail-closed: every
 *   session from the list must carry a present `projectID` exactly equal to
 *   the requested project; missing or mismatched values reject the whole
 *   collection and out-of-scope sessions are neither filtered out nor
 *   included.
 * - Message association is endpoint-scoped instead of per-record: the
 *   collector addresses each session's messages through
 *   `listMessages(sessionID, ...)`, and the v2.0.22 route
 *   `GET /api/session/:sessionID/message` scopes returned records to that path
 *   session. v2.0.22 `Session.Message.Info` carries no per-message
 *   `sessionID` (its common Base is `id`/metadata/`time`), so each message
 *   record cannot independently assert its owning session. This collector
 *   therefore does not require, validate, normalize, or invent a per-message
 *   `sessionID`; message records are retained verbatim and unknown fields
 *   (including any future `sessionID`-shaped field) stay opaque.
 * - The `maxTotalMessages` bound spans every session and every message page:
 *   before a page is accumulated, the number already collected plus that whole
 *   page must not exceed the bound, or the entire collection fails with
 *   `total-message-limit-exceeded`. A page that would push the collection over
 *   the bound is rejected, never truncated.
 * - Any unsettled message (assistant without `time.completed`; running
 *   shell/compaction), duplicate session/message id, repeated cursor, API
 *   failure, malformed page/record, session scope-binding violation (missing
 *   or mismatched session `projectID`), or exceeded bound fails the whole
 *   collection. It never returns a partial payload or truncated history.
 *
 * Caveat (O-21 / OQ-23): the upstream list APIs document no snapshot
 * consistency, so this is a best-effort page sequence, not an atomic snapshot,
 * and it defines no retry policy. This function is one step of a checkpoint,
 * not a complete checkpoint transaction; compression, encryption, and artifact
 * writing are separate concerns.
 */
export async function collectCheckpointPayload(
	port: SessionReadPort,
	input: CollectCheckpointPayloadRequest,
): Promise<CheckpointPayload> {
	if (!isJsonObject(input)) {
		throw new SessionCollectionError(
			"invalid-request",
			"collectCheckpointPayload requires an input object with an explicit projectID and SessionCollectionPolicy",
		);
	}
	if (typeof port?.listSessions !== "function" || typeof port?.listMessages !== "function") {
		throw new SessionCollectionError("invalid-request", "SessionReadPort must provide listSessions and listMessages");
	}
	validateSessionCollectionPolicy(input.policy);
	const projectID = input.projectID;
	if (typeof projectID !== "string" || projectID.length === 0) {
		throw new SessionCollectionError(
			"invalid-request",
			"collectCheckpointPayload requires an explicit non-empty projectID string; current-project resolution is out of scope (OQ-10)",
		);
	}

	const sessions: SessionRecord[] = [];
	const sessionIds = new Set<string>();
	const usedSessionCursors = new Set<string>();
	let sessionCursor: string | undefined;
	/** Messages accumulated across every session and page so far; enforced against `maxTotalMessages`. */
	let collectedMessageCount = 0;

	for (;;) {
		const pageRequest: SessionListPageRequest =
			sessionCursor === undefined
				? { project: projectID, limit: input.policy.sessionPageSize }
				: { project: projectID, limit: input.policy.sessionPageSize, cursor: sessionCursor };
		const label = `Session list for project ${JSON.stringify(projectID)}`;
		const rawPage = await callPort(() => port.listSessions(pageRequest), "session-list-failed", `${label} request failed`);
		const page = parsePageEnvelope(rawPage, "malformed-session-page", `${label} response`);

		for (const rawSession of page.items) {
			const info = snapshotJsonRecord(rawSession, "malformed-session-record", `Session list item ${sessions.length}`);
			const id = info["id"];
			if (typeof id !== "string" || id.length === 0) {
				throw new SessionCollectionError("malformed-session-record", "Session list item did not contain a non-empty string id");
			}
			const boundProjectID = info["projectID"];
			if (typeof boundProjectID !== "string" || boundProjectID !== projectID) {
				throw new SessionCollectionError(
					"session-project-mismatch",
					`${label} returned session ${JSON.stringify(id)} with ${
						boundProjectID === undefined ? "no projectID" : `projectID ${JSON.stringify(boundProjectID)}`
					}; refusing to include a session outside the requested project scope`,
				);
			}
			if (sessionIds.has(id)) {
				throw new SessionCollectionError(
					"duplicate-session-id",
					`Session list returned session id ${JSON.stringify(id)} more than once; refusing to continue`,
				);
			}
			if (sessions.length >= input.policy.maxSessions) {
				throw new SessionCollectionError(
					"session-limit-exceeded",
					`Session list exceeded SessionCollectionPolicy.maxSessions=${input.policy.maxSessions}; refusing to emit a partial checkpoint`,
				);
			}
			sessionIds.add(id);
			const messages = await collectSessionMessages(port, id, input.policy, collectedMessageCount);
			collectedMessageCount += messages.length;
			sessions.push({ info, messages });
		}

		if (page.next === undefined) break;
		if (usedSessionCursors.has(page.next)) {
			throw new SessionCollectionError(
				"repeated-session-cursor",
				`Session list returned a cursor that was already used: ${JSON.stringify(page.next)}; refusing to loop`,
			);
		}
		usedSessionCursors.add(page.next);
		sessionCursor = page.next;
	}

	return { sessions };
}

/**
 * Pages one session's messages to exhaustion in server order.
 *
 * The first request is explicitly ascending; every later request carries only
 * the opaque cursor (the API cannot combine `order` with `cursor`). The
 * `sessionID` in the request is the ownership boundary: the v2.0.22 route
 * scopes records to its `:sessionID` path parameter, and message records
 * carry no `sessionID` of their own, so association is endpoint-scoped and is
 * deliberately not re-asserted or normalized per record. Duplicate message
 * ids, repeated cursors, malformed records, unsettled messages, API failures,
 * the per-session bound, and the cross-session `maxTotalMessages` bound all
 * fail closed. The total bound is checked against
 * `alreadyCollectedMessages + messages collected so far in this session + whole
 * page size` before the page is accumulated: a page that would push the
 * collection over the bound rejects the whole collection instead of being
 * truncated.
 */
async function collectSessionMessages(
	port: SessionReadPort,
	sessionID: string,
	policy: SessionCollectionPolicy,
	alreadyCollectedMessages: number,
): Promise<readonly JsonObject[]> {
	const messages: JsonObject[] = [];
	const messageIds = new Set<string>();
	const usedCursors = new Set<string>();
	let cursor: string | undefined;

	for (;;) {
		const pageRequest: MessageListPageRequest =
			cursor === undefined
				? { sessionID, limit: policy.messagePageSize, order: "asc" }
				: { sessionID, limit: policy.messagePageSize, cursor };
		const label = `Message list for session ${JSON.stringify(sessionID)}`;
		const rawPage = await callPort(() => port.listMessages(pageRequest), "message-list-failed", `${label} request failed`);
		const page = parsePageEnvelope(rawPage, "malformed-message-page", `${label} response`);

		// Fail closed before accumulating this page when the collection would
		// exceed the cross-session total. The page is counted whole (every item
		// either becomes a message or rejects the collection), so a partially
		// fitting page is never truncated.
		const pageTotal = alreadyCollectedMessages + messages.length + page.items.length;
		if (pageTotal > policy.maxTotalMessages) {
			throw new SessionCollectionError(
				"total-message-limit-exceeded",
				`${label} would bring the total message count to ${pageTotal}, exceeding SessionCollectionPolicy.maxTotalMessages=${policy.maxTotalMessages}; refusing to emit a partial checkpoint`,
			);
		}

		for (const rawMessage of page.items) {
			const message = snapshotJsonRecord(rawMessage, "malformed-message-record", `${label} item ${messages.length}`);
			const id = message["id"];
			if (typeof id !== "string" || id.length === 0) {
				throw new SessionCollectionError("malformed-message-record", `${label} returned a message without a non-empty string id`);
			}
			if (messageIds.has(id)) {
				throw new SessionCollectionError(
					"duplicate-message-id",
					`${label} returned message id ${JSON.stringify(id)} more than once; refusing to continue`,
				);
			}
			if (messages.length >= policy.maxMessagesPerSession) {
				throw new SessionCollectionError(
					"message-limit-exceeded",
					`${label} exceeded SessionCollectionPolicy.maxMessagesPerSession=${policy.maxMessagesPerSession}; refusing to emit a partial checkpoint`,
				);
			}
			messageIds.add(id);
			const unsettled = findUnsettledMessageReason(message);
			if (unsettled !== undefined) {
				throw new SessionCollectionError(
					"unsettled-message",
					`${label} message ${JSON.stringify(id)} is unsettled (${unsettled}); official transfer/import would drop it, so the checkpoint fails closed with no artifact`,
				);
			}
			messages.push(message);
		}

		if (page.next === undefined) break;
		if (usedCursors.has(page.next)) {
			throw new SessionCollectionError(
				"repeated-message-cursor",
				`${label} returned a cursor that was already used: ${JSON.stringify(page.next)}; refusing to loop`,
			);
		}
		usedCursors.add(page.next);
		cursor = page.next;
	}

	return messages;
}

interface ParsedPage {
	readonly items: readonly unknown[];
	/** `cursor.next` when present and non-null; `undefined` means the page sequence is complete. */
	readonly next: string | undefined;
}

/**
 * Validates the untrusted `{ data, cursor }` envelope. Unknown *items* are
 * returned as-is and are snapshotted individually afterwards; the envelope's
 * `next` is only ever used as an opaque string or as a stop signal.
 */
function parsePageEnvelope(value: unknown, code: SessionCollectionErrorCode, label: string): ParsedPage {
	if (!isJsonObject(value)) {
		throw new SessionCollectionError(code, `${label} was not an object`);
	}
	const data = value["data"];
	if (!Array.isArray(data)) {
		throw new SessionCollectionError(code, `${label} did not contain a data array`);
	}

	let next: string | undefined;
	const cursor = value["cursor"];
	if (cursor !== undefined && cursor !== null) {
		if (!isJsonObject(cursor)) {
			throw new SessionCollectionError(code, `${label} cursor was not an object`);
		}
		const rawNext = cursor["next"];
		if (rawNext !== undefined && rawNext !== null) {
			if (typeof rawNext !== "string" || rawNext.length === 0) {
				throw new SessionCollectionError(code, `${label} cursor.next was not a non-empty string or null`);
			}
			next = rawNext;
		}
	}

	if (next !== undefined && data.length === 0) {
		throw new SessionCollectionError(
			code,
			`${label} returned no items with a next cursor; refusing to guess at an unbounded page sequence`,
		);
	}

	return { items: data, next };
}

/** Copies one API record into a detached JSON-only object, rejecting anything JSON would omit or coerce. */
function snapshotJsonRecord(value: unknown, code: SessionCollectionErrorCode, label: string): JsonObject {
	if (!isJsonObject(value)) {
		throw new SessionCollectionError(code, `${label} was not an object`);
	}
	let snapshot: JsonValue;
	try {
		snapshot = snapshotJsonValue(value, label);
	} catch (cause) {
		throw new SessionCollectionError(code, `${label} is not JSON-stable: ${errorText(cause)}`, { cause });
	}
	if (!isJsonObject(snapshot)) {
		throw new SessionCollectionError(code, `${label} did not snapshot to an object`);
	}
	return snapshot as JsonObject;
}

/** Awaits one port call and converts non-collection failures into a coded error while preserving the cause. */
async function callPort(
	call: () => Promise<unknown>,
	code: SessionCollectionErrorCode,
	label: string,
): Promise<unknown> {
	try {
		return await call();
	} catch (cause) {
		if (cause instanceof SessionCollectionError) throw cause;
		throw new SessionCollectionError(code, `${label}: ${errorText(cause)}`, { cause });
	}
}
