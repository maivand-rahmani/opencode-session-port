/**
 * Dependency-injected read surface for session enumeration.
 *
 * This is the only host boundary the session core lane needs (no TUI/OpenCode
 * imports here). Implementations live outside this module and map these calls
 * onto the host client; tests inject synthetic ports.
 *
 * Expected upstream behavior (OpenCode v2.0.22 declarations/source research,
 * E13/E14; declarations vs. runtime behavior still partially unvalidated —
 * OQ-10):
 * - `listSessions` maps to `GET /api/session`: declared filters include
 *   `project`/`directory`; default page size 50; opaque cursor pagination with
 *   no total/hasMore. Responses are `{ data: [...], cursor: { next?: string | null } }`.
 * - `listMessages` maps to `GET /api/session/:sessionID/message`: declared
 *   default page size 50, cap 200, default order `desc`; `order` cannot be
 *   combined with `cursor`; secret-type filtering is possible and must be
 *   omitted to preserve every message variant. The `:sessionID` path
 *   parameter is the ownership boundary: the endpoint scopes returned records
 *   to that session, and v2.0.22 message records carry no per-message
 *   `sessionID` (their common Base is `id`/metadata/`time`), so a record
 *   cannot independently assert session association.
 *
 * Response values are treated as untrusted `unknown` and are validated into
 * detached JSON-only snapshots by the collector; a port must not pre-filter,
 * pre-truncate, or coerce API data.
 *
 * Consistency caveat (O-21 / OQ-23): the upstream list APIs document no atomic
 * snapshot or snapshot-consistency guarantee. A successful collection is a
 * sequence of page reads, not a consistent point-in-time capture; no retry or
 * re-read policy is defined here. Do not describe this utility as a complete
 * checkpoint transaction — compression/encryption/writing remain separate.
 */
export interface SessionReadPort {
	/**
	 * Requests one page of the session list scoped to the explicit project.
	 * Expected response: `{ data: unknown[]; cursor?: { next?: string | null } | null }`.
	 */
	listSessions(request: SessionListPageRequest): Promise<unknown>;

	/**
	 * Requests one page of messages for exactly one session, addressed by the
	 * `sessionID` field of `MessageListPageRequest`. That request target is the
	 * ownership boundary: the upstream route scopes returned records to the
	 * path session and v2.0.22 message records carry no `sessionID`, so
	 * per-record association cannot be independently asserted and must not be
	 * inferred, required, or normalized. The first call must use `order: "asc"`;
	 * later calls pass the opaque `cursor` and no `order`. No `type` filter is
	 * ever sent.
	 * Expected response: `{ data: unknown[]; cursor?: { next?: string | null } | null }`.
	 */
	listMessages(request: MessageListPageRequest): Promise<unknown>;
}

/**
 * Dependency-capable read surface for checkpoint collection (owner-approved
 * 2026-10-18 amendment): the project-scoped list/message reads plus an explicit
 * single-session fetch used only to resolve schema-referenced `parentID` /
 * `fork.sessionID` dependencies.
 *
 * `getSession` maps to the public `session.get` route addressed by exact
 * session ID and is the only approved way to read a referenced session that
 * the project-scoped list did not return; the collector never scans other
 * projects and never calls `listSessions` for a dependency. The pinned v2.0.22
 * generated client declares `get(input: { sessionID }) => Promise<SessionInfo>`
 * and resolves the already-unwrapped `SessionInfo` directly (the raw protocol
 * `{ data: sessionInfo }` envelope is unwrapped by the generated promise
 * client before the port sees it), so the resolved value is returned as raw
 * `unknown`. The core collector validates whatever value the port resolves as
 * a direct session info object whose `id` equals the exact requested ID, or
 * the whole collection fails closed; an enveloped `{ data: ... }` value is not
 * the declared shape and is rejected. A port must not pre-filter,
 * pre-truncate, or coerce API data.
 */
export interface SessionDependencyReadPort extends SessionReadPort {
	/**
	 * Requests exactly one session record by its exact session ID.
	 * Expected resolved value: the direct unwrapped session info object
	 * (`{ id, ... }`). No other request fields exist.
	 */
	getSession(sessionID: string): Promise<unknown>;
}

/** One session list page request. The project scope is always explicit; the collector never infers it. */
export interface SessionListPageRequest {
	/** Explicit project scope; mapped to the list route's `project` filter. */
	readonly project: string;
	/** Explicit page size from `SessionCollectionPolicy`; the API default is never relied on. */
	readonly limit: number;
	/** Opaque `cursor.next` from the previous page; absent on the first request. */
	readonly cursor?: string;
}

/**
 * One message list page request.
 *
 * `sessionID` is the endpoint-scoped ownership boundary (the route path
 * parameter) and is always the session currently being collected; returned
 * records are not expected to repeat it (v2.0.22 message records have no
 * `sessionID` field). The union mirrors the declared API constraint that
 * `order` and `cursor` cannot be combined: the first page is `{ order: "asc" }`
 * with no cursor, and every subsequent page carries only the opaque cursor. No
 * `type` filter is ever sent so all message variants and tool content are
 * preserved.
 */
export type MessageListPageRequest =
	| {
			readonly sessionID: string;
			readonly limit: number;
			/** First page only: ascending order. */
			readonly order: "asc";
	  }
	| {
			readonly sessionID: string;
			readonly limit: number;
			/** Subsequent pages only: opaque cursor; no `order`, no `type` filter. */
			readonly cursor: string;
	  };
