/**
 * SessionPort V1 core session lane (Phase 2).
 *
 * Bounded session enumeration, detached JSON snapshotting, and payload
 * serialization against the approved shared contracts. Session records are
 * bound to the requested scope fail-closed: each session `projectID` must
 * equal the requested project or the whole collection rejects. Message
 * association is endpoint-scoped through `listMessages(sessionID, ...)`: the
 * v2.0.22 route scopes messages to its `:sessionID` path parameter, message
 * records carry no `sessionID` of their own, and no per-record association
 * check or normalization is invented. No TUI/OpenCode imports; the host API
 * is reached only through the injected `SessionReadPort`.
 *
 * Consistency caveat (O-21 / OQ-23): upstream list APIs document no atomic
 * snapshot. A successful collection is a best-effort page sequence, not a
 * consistent point-in-time capture, and this lane invents no retry policy.
 * Canonical duplicate comparison (O-04) and ID/reference conflict remapping
 * (O-05) are intentionally not implemented here.
 */
export { collectCheckpointPayload } from "./collector.ts";
export type { CollectCheckpointPayloadRequest } from "./collector.ts";
export { SessionCollectionError } from "./errors.ts";
export type { SessionCollectionErrorCode } from "./errors.ts";
export { MESSAGE_PAGE_SIZE_CAP, validateSessionCollectionPolicy } from "./policy.ts";
export type { SessionCollectionPolicy } from "./policy.ts";
export type { MessageListPageRequest, SessionListPageRequest, SessionReadPort } from "./port.ts";
export { serializeCheckpointPayload } from "./serialize.ts";
export { findUnsettledMessageReason } from "./unsettled.ts";
export type { UnsettledMessageReason } from "./unsettled.ts";
