/**
 * Host read adapter: maps the core `SessionReadPort` onto the actual public
 * TUI client methods `context.client.session.list` and
 * `context.client.message.list`.
 *
 * Mapping contract (v2.0.22 declaration/source research, E13/E14/E18):
 * - `listSessions` sends exactly `{ project, limit }`, plus the opaque
 *   `cursor` only when the core request carries one. The project scope is
 *   always explicit and the page size is always explicit; no API default is
 *   relied on and no extra filter (`directory`, `search`, `parentID`,
 *   `subpath`, `order`) is ever invented.
 * - `listMessages` sends `{ sessionID, limit, order: "asc" }` for the first
 *   page and `{ sessionID, limit, cursor }` for later pages, mirroring the
 *   declared constraint that `order` and `cursor` cannot be combined. No
 *   `type` filter is ever sent, so every message variant (including secret-
 *   shaped or tool-bearing records) is preserved; the endpoint-scoped
 *   `sessionID` is the ownership boundary.
 * - Responses are returned to the caller as the raw `unknown` value the
 *   client resolved. This adapter does not parse, validate, filter, truncate,
 *   clone, or coerce pages or records: envelope validation, snapshotting, and
 *   fail-closed completeness checks belong to the core collector, and a
 *   malformed or partial page must fail there, never be silently repaired
 *   here.
 *
 * Capability behavior: construction fails closed with a `HostAdapterError`
 * (`capability-unavailable`) when either method is missing or not callable,
 * before any request is made. Method errors propagate unchanged (no wrapping)
 * so collection failures stay truthful.
 *
 * Evidence boundary: declaration/source research and synthetic fake-client
 * tests only. Runtime pagination/scope behavior against a live host is
 * untested (OQ-10); no snapshot-consistency claim is made (O-21/OQ-23), and
 * no cross-version or support claim follows.
 */

import type { MessageListPageRequest, SessionListPageRequest, SessionReadPort } from "../../core/sessions/index.ts";
import {
	HostAdapterError,
	requireNonEmptyString,
	requirePositiveSafeInteger,
	resolveUnaryMethod,
	type MessageListCallInput,
	type SessionListCallInput,
} from "./host-client.ts";

/**
 * Creates a `SessionReadPort` backed by the public TUI client.
 *
 * `client` is accepted as `unknown` (it is the host-provided
 * `context.client`): the two required methods are resolved and validated at
 * construction time. The returned port satisfies `SessionReadPort` exactly.
 */
export function createSessionReadAdapter(client: unknown): SessionReadPort {
	const sessionList = resolveUnaryMethod<SessionListCallInput>(client, "session", "list");
	if (sessionList === undefined) {
		throw new HostAdapterError(
			"capability-unavailable",
			"The installed TUI client does not expose a callable session.list; cannot enumerate project sessions",
		);
	}
	const messageList = resolveUnaryMethod<MessageListCallInput>(client, "message", "list");
	if (messageList === undefined) {
		throw new HostAdapterError(
			"capability-unavailable",
			"The installed TUI client does not expose a callable message.list; cannot enumerate session messages",
		);
	}

	return {
		async listSessions(request: SessionListPageRequest): Promise<unknown> {
			return sessionList(mapSessionListRequest(request));
		},
		async listMessages(request: MessageListPageRequest): Promise<unknown> {
			return messageList(mapMessageListRequest(request));
		},
	};
}

/**
 * Maps one core session page request onto the declared `session.list` input.
 * The request is validated fail-closed first: a missing/blank project or a
 * non-explicit page size would otherwise silently broaden the query scope or
 * fall back to an API default.
 */
export function mapSessionListRequest(request: SessionListPageRequest): SessionListCallInput {
	const project = requireNonEmptyString(request?.project, "SessionListPageRequest.project");
	const limit = requirePositiveSafeInteger(request?.limit, "SessionListPageRequest.limit");
	if (request.cursor === undefined) {
		return { project, limit };
	}
	const cursor = requireNonEmptyString(request.cursor, "SessionListPageRequest.cursor");
	return { project, limit, cursor };
}

/**
 * Maps one core message page request onto the declared `message.list` input.
 * The first page carries `order: "asc"` and no cursor; later pages carry only
 * the opaque cursor. No `type` filter is ever added. The request is validated
 * fail-closed first (explicit session scope and page size).
 */
export function mapMessageListRequest(request: MessageListPageRequest): MessageListCallInput {
	const sessionID = requireNonEmptyString(request?.sessionID, "MessageListPageRequest.sessionID");
	const limit = requirePositiveSafeInteger(request?.limit, "MessageListPageRequest.limit");
	if ("cursor" in request) {
		const cursor = requireNonEmptyString(request.cursor, "MessageListPageRequest.cursor");
		return { sessionID, limit, cursor };
	}
	if (request.order !== "asc") {
		throw new HostAdapterError(
			"invalid-request",
			'MessageListPageRequest must carry order "asc" on the first page (the declared API cannot combine order with cursor)',
		);
	}
	return { sessionID, limit, order: "asc" };
}
