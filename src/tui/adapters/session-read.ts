/**
 * Host read adapters: map the core session read ports onto the actual public
 * TUI client methods `context.client.session.list`, `context.client.message.list`,
 * and (checkpoint dependency closure only) `context.client.session.get`.
 *
 * Two factories exist with distinct capability requirements:
 * - `createSessionReadAdapter` — list-only `SessionReadPort` used by the
 *   restore destination snapshot and the cross-project session-ID inventory.
 *   It resolves and calls only `session.list` / `message.list`; it never reads
 *   or calls `session.get`, so a list-only client remains sufficient for
 *   restore.
 * - `createSessionDependencyReadAdapter` — `SessionDependencyReadPort` for the
 *   checkpoint flow (owner-approved 2026-10-18 dependency-closure amendment).
 *   It additionally requires callable `session.get`, which the core collector
 *   may use to resolve schema-referenced `parentID`/`fork.sessionID`
 *   dependencies. The adapter never decides when to fetch a dependency: it
 *   only maps the core's explicit `getSession(sessionID)` calls, so no
 *   session is fetched proactively or outside the core-requested closure.
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
 * - `getSession` sends exactly `{ sessionID }`. The pinned v2.0.22 generated
 *   client declares `get(input: SessionGetInput) => Promise<SessionInfo>` with
 *   `SessionGetInput` exactly `{ readonly sessionID: string }` and resolves the
 *   already-unwrapped `SessionInfo` (no `{ data }` envelope), so the resolved
 *   value is returned to the core as the raw `unknown` result unchanged: no
 *   envelope fallback, unwrapping, validation, or normalization happens here.
 * - Responses are returned to the caller as the raw `unknown` value the
 *   client resolved. These adapters do not parse, validate, filter, truncate,
 *   clone, or coerce pages or records: envelope validation, snapshotting, and
 *   fail-closed completeness checks belong to the core collector, and a
 *   malformed or partial page must fail there, never be silently repaired
 *   here.
 *
 * Capability behavior: construction fails closed with a `HostAdapterError`
 * (`capability-unavailable`) when a required method is missing or not callable,
 * before any request is made (`session.get` is required only by the dependency
 * adapter). Method errors propagate unchanged (no wrapping) so collection
 * failures stay truthful.
 *
 * Evidence boundary: declaration/source research and synthetic fake-client
 * tests only. Runtime pagination/scope/dependency behavior against a live host
 * is untested (OQ-10); no snapshot-consistency claim is made (O-21/OQ-23), and
 * no cross-version or support claim follows.
 */

import type {
	MessageListPageRequest,
	SessionDependencyReadPort,
	SessionListPageRequest,
	SessionReadPort,
} from "../../core/sessions/index.ts";
import {
	HostAdapterError,
	requireNonEmptyString,
	requirePositiveSafeInteger,
	resolveUnaryMethod,
	type MessageListCallInput,
	type SessionGetCallInput,
	type SessionListCallInput,
} from "./host-client.ts";

/**
 * Creates a list-only `SessionReadPort` backed by the public TUI client.
 *
 * `client` is accepted as `unknown` (it is the host-provided
 * `context.client`): the two required methods are resolved and validated at
 * construction time. The returned port satisfies `SessionReadPort` exactly and
 * deliberately does not resolve `session.get`: this factory remains the
 * restore destination-snapshot / inventory read surface.
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
 * Creates a `SessionDependencyReadPort` backed by the public TUI client for
 * the checkpoint flow: the list-only read surface plus `getSession`.
 *
 * `client` is accepted as `unknown`; `session.list`, `message.list`, and
 * `session.get` are resolved and validated at construction time, and a missing
 * or non-callable method fails closed with `HostAdapterError`
 * (`capability-unavailable`) before any request is made. The core collector
 * decides when a dependency must be fetched; this adapter only maps the
 * explicit `getSession(sessionID)` call to exactly `{ sessionID }` and returns
 * the raw resolved value unchanged (the pinned client already unwraps the
 * protocol envelope), with no normalization or envelope fallback. Method
 * errors propagate unchanged.
 */
export function createSessionDependencyReadAdapter(client: unknown): SessionDependencyReadPort {
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
	const sessionGet = resolveUnaryMethod<SessionGetCallInput>(client, "session", "get");
	if (sessionGet === undefined) {
		throw new HostAdapterError(
			"capability-unavailable",
			"The installed TUI client does not expose a callable session.get; cannot resolve checkpoint session dependencies",
		);
	}

	return {
		async listSessions(request: SessionListPageRequest): Promise<unknown> {
			return sessionList(mapSessionListRequest(request));
		},
		async listMessages(request: MessageListPageRequest): Promise<unknown> {
			return messageList(mapMessageListRequest(request));
		},
		async getSession(sessionID: string): Promise<unknown> {
			// Exactly one field is ever sent, and the resolved raw value is
			// passed back to the core unchanged.
			return sessionGet({ sessionID: requireNonEmptyString(sessionID, "getSession sessionID") });
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
