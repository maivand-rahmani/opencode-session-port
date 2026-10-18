/**
 * SessionPort V1 TUI host adapters (Phase 4, non-visual lane).
 *
 * Public surface for orchestration integration:
 * - `createSessionReadAdapter(client)` → list-only core `SessionReadPort`
 *   backed by `context.client.session.list` / `context.client.message.list`.
 *   Used by the restore destination snapshot and the session-ID inventory; it
 *   never resolves `session.get`.
 * - `createSessionDependencyReadAdapter(client)` → core
 *   `SessionDependencyReadPort` (list/message reads plus `getSession`) for the
 *   checkpoint flow's dependency closure (owner-approved 2026-10-18
 *   amendment). Construction fails closed when any required method is
 *   missing; `getSession` maps exactly `{ sessionID }` and returns the raw
 *   resolved value unchanged. The adapter never fetches dependencies on its
 *   own: only core-requested schema references are resolved.
 * - `probeSessionImportCapability(client)` → O-12 restore-start capability
 *   probe (never throws).
 * - `createSessionImportAdapter(client)` → single-session import adapter that
 *   always supplies the caller's explicit `{ directory }` target (O-16) and
 *   fail-closed validates the unwrapped host response before treating an
 *   import as confirmed (`invalid-response`; see `SessionImportResult`).
 * - `createProjectDestinationsAdapter(client)` → restore destination
 *   candidates from `context.client.project.list` as declaration-derived
 *   `{ projectID, targetDirectory, label }` pairs; the pairs are not
 *   runtime-verified and require runtime pair validation before restore use
 *   (OQ-16 stays OPEN).
 * - `createSessionIdInventory(input)` → bounded metadata-only cross-project
 *   session-ID inventory over the validated project-list candidates and an
 *   injected `SessionReadPort` (only `session.list` is called; no message,
 *   location, or import surface is touched). The returned IDs are occupancy
 *   evidence only (2026-10-14 owner-approved collision amendment).
 * - `createLocationResolver(client)` → experimental explicit-directory project
 *   resolution through `context.client.location.get` with exact, non-blank
 *   response matching and fail-closed absence/mismatch handling; `location.get`
 *   may persist project state as one deliberate, bounded side effect (E42;
 *   OQ-16 stays OPEN).
 *
 * All client-facing factories accept the host-provided client as an untrusted
 * `unknown` value; see `host-client.ts` for the narrow typed boundary, runtime
 * resolution, and the compile-time assertions against the installed v2.0.22
 * TUI client declaration. `createSessionIdInventory` resolves no client surface
 * at all: it consumes the already-validated candidates plus an injected
 * `SessionReadPort`. No host types are imported at runtime and no host calls
 * are made by this module.
 */

export { HostAdapterError } from "./host-client.ts";
export type {
	HostAdapterErrorCode,
	MessageListCallInput,
	SessionGetCallInput,
	SessionImportCallInput,
	SessionImportResult,
	SessionListCallInput,
} from "./host-client.ts";
export { createLocationResolver, LocationResolutionError } from "./location-resolver.ts";
export type {
	LocationGetCallInput,
	LocationResolutionErrorCode,
	LocationResolver,
	ResolvedProjectLocation,
	SelectedProjectCandidate,
} from "./location-resolver.ts";
export {
	createProjectDestinationsAdapter,
	mapProjectListResponse,
	ProjectDestinationError,
} from "./project-destinations.ts";
export type {
	ProjectDestinationCandidate,
	ProjectDestinationErrorCode,
	ProjectDestinationsAdapter,
} from "./project-destinations.ts";
export { createSessionIdInventory } from "./session-id-inventory.ts";
export type {
	SessionIdInventory,
	SessionIdInventoryInput,
	SessionIdInventoryProject,
} from "./session-id-inventory.ts";
export {
	createSessionDependencyReadAdapter,
	createSessionReadAdapter,
	mapMessageListRequest,
	mapSessionListRequest,
} from "./session-read.ts";
export { buildSessionImportCall, createSessionImportAdapter, probeSessionImportCapability } from "./session-import.ts";
export type { SessionImportAdapter, SessionImportProbe, SessionImportRequest } from "./session-import.ts";
