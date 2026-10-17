/**
 * Host import adapter: feature-detects and invokes the public TUI client
 * `context.client.session.import` method for one planned session record.
 *
 * V1 policy boundaries:
 * - O-12/OQ-12: the required capability is probed at restore start via
 *   `probeSessionImportCapability`, before the artifact is read or decrypted.
 *   The probe never throws; an absent or non-callable `session.import` is
 *   reported as `{ available: false, reason }` so the caller can show a clear
 *   "capability unavailable, no sessions were changed" message and stop.
 * - O-16: every invocation supplies an explicit target
 *   (`location: { directory }`) provided by the caller. The adapter never
 *   infers a target and never derives one from the source record. It makes no
 *   promise that the source `info.projectID` or `info.location` survives; the
 *   host assigns target project scope (bounded E28/E31/E33 observations only).
 * - The planned record's `info` and `messages` are passed through verbatim:
 *   this adapter performs no remapping, filtering, or field stripping.
 * - Response hardening (fail closed at this dynamic boundary): the pinned
 *   v2.0.22 public client unwraps the raw protocol `{ data: SessionInfo }`
 *   envelope and resolves the declared `SessionInfo` directly, but the
 *   generated client casts the JSON body to that declared type without runtime
 *   validation. The adapter therefore re-proves the fields SessionPort relies
 *   on and fails closed with `invalid-response` unless the resolved value is a
 *   non-null, non-array object with nonblank string `id` and `projectID` and an
 *   object `location` with a nonblank string `directory`, and the returned
 *   `id` equals the planned record's `info.id`. It never expects or unwraps a
 *   `.data` envelope, never requires the returned directory to equal the
 *   requested target, and never requires `projectID` to equal any selected or
 *   source ID (no such equality is contract/runtime-proven here). On success
 *   the original response value is returned unchanged after narrowing.
 * - Host/API errors (for example a conflict or validation rejection) propagate
 *   unchanged; this adapter never wraps, retries, or swallows them, so
 *   per-session failure reporting stays truthful. No retry semantics are
 *   implemented here (O-06 remains OPEN).
 *
 * Evidence boundary: the public import route is Experimental and the
 * installed declaration mismatch (`SessionDomain` omits `import`) is bounded-
 * addressed at runtime on one Windows v2.0.22 actual-TUI host (E33, one run,
 * one import, no retry). These adapters are validated with synthetic
 * fake-client tests only; no real host calls or imports are made by this lane,
 * and no cross-version or support claim follows.
 */

import type { SessionRecord } from "../../core/contracts/index.ts";
import {
	HostAdapterError,
	isObjectRecord,
	requireNonEmptyString,
	resolveUnaryMethod,
	type SessionImportCallInput,
	type SessionImportResult,
} from "./host-client.ts";

/** One import request: the final planned record plus the caller's explicit target. */
export interface SessionImportRequest {
	/**
	 * Final planned record from restore preflight (`planRestore`). Passed
	 * through verbatim; the caller owns preflight validation.
	 */
	readonly record: SessionRecord;
	/** Explicit destination target; always required, never inferred (O-16). */
	readonly target: { readonly directory: string };
}

/** Capability probe outcome (O-12). `reason` is technical detail for the caller's message. */
export type SessionImportProbe = { readonly available: true } | { readonly available: false; readonly reason: string };

/** Single-session import surface. One call per planned record; no batching or retry. */
export interface SessionImportAdapter {
	/**
	 * Invokes the public `session.import` once with `{ info, messages, location }`.
	 * Resolves with the validated narrow `SessionImportResult`: the original
	 * unwrapped host response value unchanged after fail-closed narrowing
	 * (`invalid-response` when the response violates the declared `SessionInfo`
	 * fields or its `id` does not match the planned record). Rejects with the
	 * unchanged host/API error.
	 */
	importSession(request: SessionImportRequest): Promise<SessionImportResult>;
}

/**
 * Feature-detects `client.session.import` as a callable. Never throws; callers
 * must stop without importing when `available` is false.
 */
export function probeSessionImportCapability(client: unknown): SessionImportProbe {
	const importMethod = resolveUnaryMethod<SessionImportCallInput>(client, "session", "import");
	if (importMethod === undefined) {
		return {
			available: false,
			reason: "The installed TUI client does not expose a callable session.import",
		};
	}
	return { available: true };
}

/**
 * Creates the import adapter. Fails closed with `capability-unavailable` when
 * the probe would report unavailable; callers should probe first and surface
 * the probe reason, but this factory re-checks so an import can never be
 * attempted through an unverified surface.
 */
export function createSessionImportAdapter(client: unknown): SessionImportAdapter {
	const importMethod = resolveUnaryMethod<SessionImportCallInput>(client, "session", "import");
	if (importMethod === undefined) {
		throw new HostAdapterError(
			"capability-unavailable",
			"The installed TUI client does not expose a callable session.import; refusing to import (no sessions were changed)",
		);
	}
	return {
		async importSession(request: SessionImportRequest): Promise<SessionImportResult> {
			const response: unknown = await importMethod(buildSessionImportCall(request));
			if (!isSessionImportResult(response)) {
				throw new HostAdapterError(
					"invalid-response",
					`session.import did not return an unwrapped SessionInfo-shaped object with a nonblank string id, a nonblank string projectID, and a location.directory; received ${describeValue(response)}`,
				);
			}
			if (response.id !== request.record.info["id"]) {
				throw new HostAdapterError(
					"invalid-response",
					"session.import returned an id that does not match the imported record id",
				);
			}
			return response;
		},
	};
}

/**
 * Builds the exact public-client import payload: the planned record's `info`
 * and `messages` verbatim plus the explicit `location` target. Validates the
 * request shape fail-closed before any host call so malformed data is never
 * handed to the host as a confusing API error.
 */
export function buildSessionImportCall(request: SessionImportRequest): SessionImportCallInput {
	const rawRequest: unknown = request;
	if (!isObjectRecord(rawRequest)) {
		throw new HostAdapterError("invalid-request", "SessionImportRequest must be an object with record and target");
	}
	const rawRecord = rawRequest["record"];
	if (!isObjectRecord(rawRecord) || !isObjectRecord(rawRecord["info"]) || !Array.isArray(rawRecord["messages"])) {
		throw new HostAdapterError("invalid-request", "SessionImportRequest.record must be an object with info and messages");
	}
	const rawTarget = rawRequest["target"];
	if (!isObjectRecord(rawTarget)) {
		throw new HostAdapterError("invalid-request", "SessionImportRequest.target must be an object with a directory");
	}
	const directory = requireNonEmptyString(rawTarget["directory"], "SessionImportRequest.target.directory");
	return { info: request.record.info, messages: request.record.messages, location: { directory } };
}

/* ------------------------------------------------------------------------- */
/* Response validation (fail closed, sanitized messages)                     */
/* ------------------------------------------------------------------------- */

/**
 * Fail-closed narrowing of one untrusted `session.import` response.
 *
 * The pinned v2.0.22 public client resolves the already-unwrapped `SessionInfo`
 * (the raw protocol `{ data }` envelope is unwrapped by the generated promise
 * client), and the generated client casts the JSON body to the declared type
 * without runtime validation. This guard is therefore the runtime proof behind
 * `SessionImportResult`: a non-null, non-array object with nonblank string `id`
 * and `projectID` and an object `location` carrying a nonblank string
 * `directory`. It never unwraps a `{ data }`-shaped object (that is not the
 * declared unwrapped contract) and never compares directories or project IDs;
 * the caller compares the returned `id` to the planned record separately. The
 * predicate is trusted only after every check in this body, and the response
 * value itself is returned unchanged (same object identity).
 */
function isSessionImportResult(value: unknown): value is SessionImportResult {
	if (!isObjectRecord(value)) return false;
	const id = value["id"];
	if (typeof id !== "string" || id.trim().length === 0) return false;
	const projectID = value["projectID"];
	if (typeof projectID !== "string" || projectID.trim().length === 0) return false;
	const location = value["location"];
	if (!isObjectRecord(location)) return false;
	const directory = location["directory"];
	return typeof directory === "string" && directory.trim().length > 0;
}

/** Type-only description for error messages; never includes the value itself. */
function describeValue(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	return typeof value;
}
