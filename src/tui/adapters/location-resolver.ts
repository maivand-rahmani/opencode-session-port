/**
 * Experimental project-location resolver over the public TUI client
 * `context.client.location.get` method (experimental wiring lane).
 *
 * Scope and boundaries (owner decision 2026-10-11, decision-log F):
 * - `Plugin.Context.location` carries only a directory, so the experimental
 *   checkpoint path resolves that active directory through public
 *   `location.get({ location: { directory } })`; restore calls `location.get`
 *   only for the user-selected candidate (never speculatively, never to
 *   enumerate candidates).
 * - Responses are validated fail-closed: the returned `directory`, the
 *   `project.directory`, and the `project.id` must be present, non-blank, and
 *   exactly equal to the requested values. Absent/malformed/mismatched
 *   responses reject before any artifact read, decrypt, write, or import.
 * - E42 observed that `location.get` can persist/upsert project state in the
 *   host store; that is a deliberate, bounded side effect of this one explicit
 *   call per flow (checkpoint: active directory; restore: selected candidate).
 *   OQ-16 remains OPEN for general/current-project and cross-runtime mapping,
 *   and no project-ID algorithm, stability, or canonical-path generalization
 *   is claimed.
 * - Host/API errors propagate unchanged (never wrapped, retried, or
 *   swallowed); this module adds no retry and no fallback resolution.
 *
 * Method invocation follows the `host-client.ts` resolver convention:
 * `resolveUnaryMethod` resolves `client.location.get` and invokes it with the
 * owning `client.location` object preserved as the receiver.
 *
 * Evidence boundary: pinned v2.0.22 declaration assertions plus synthetic
 * fake-client tests only. No live host call is made by this module, and no
 * cross-version, compatibility, or support claim follows.
 */

import type { Plugin } from "@opencode/plugin/tui";
import { isObjectRecord, resolveUnaryMethod } from "./host-client.ts";

/* ------------------------------------------------------------------------- */
/* Errors                                                                    */
/* ------------------------------------------------------------------------- */

/** Stable machine-readable failure codes for project-location resolution. */
export type LocationResolutionErrorCode =
	/** The installed client does not expose a callable `location.get`. */
	| "capability-unavailable"
	/** The caller supplied a blank or missing explicit directory/project ID. */
	| "invalid-request"
	/** The host response did not carry the declared fields as non-blank strings. */
	| "invalid-response"
	/** The host response did not exactly match the requested directory/project ID. */
	| "mismatch";

/** Fail-closed resolution error; host API errors are never wrapped in it. */
export class LocationResolutionError extends Error {
	readonly code: LocationResolutionErrorCode;

	constructor(code: LocationResolutionErrorCode, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "LocationResolutionError";
		this.code = code;
	}
}

/* ------------------------------------------------------------------------- */
/* Narrow client surface (documentation + compile-time assertions)           */
/* ------------------------------------------------------------------------- */

/** One `location.get` request as sent by this adapter. */
export interface LocationGetCallInput {
	readonly location: { readonly directory: string };
}

/**
 * Narrow structural view of the public location surface. `location` and `get`
 * are optional because capability absence is a real runtime state; the factory
 * fails closed with a clear `LocationResolutionError` when the method is
 * missing or not callable.
 */
export interface LocationGetClientLike {
	readonly location?: {
		get?(input: LocationGetCallInput): Promise<unknown>;
	};
}

type HostTuiClient = Plugin.Context["client"];
type AssertTrue<T extends true> = T;

/**
 * The installed v2.0.22 TUI client must satisfy the narrow `location.get`
 * surface; if a future pinned declaration drifts, `tsc` fails here instead of
 * failing at runtime.
 */
type _AssertHostLocationGetClientCompatible = AssertTrue<HostTuiClient extends LocationGetClientLike ? true : false>;

/**
 * The declared `location.get` output must keep exposing the fields this
 * adapter validates (`directory`, `project.id`, `project.directory`). Drift in
 * those fields is a compile error, not a silent runtime fallback.
 */
type HostLocationGetOutput = Awaited<ReturnType<HostTuiClient["location"]["get"]>>;
type _AssertHostLocationGetOutputHasFields = AssertTrue<
	HostLocationGetOutput extends {
		readonly directory: string;
		readonly project: { readonly id: string; readonly directory: string };
	}
		? true
		: false
>;

/* ------------------------------------------------------------------------- */
/* Public types                                                              */
/* ------------------------------------------------------------------------- */

/**
 * One exact, verified project location. `directory` is the requested directory
 * that the host response confirmed verbatim; `projectID` is the host-returned
 * project ID (for the selected-candidate flow it is also required to equal the
 * candidate's declared project ID).
 */
export interface ResolvedProjectLocation {
	readonly projectID: string;
	readonly directory: string;
}

/** One selected destination candidate to verify against the host. */
export interface SelectedProjectCandidate {
	readonly projectID: string;
	readonly targetDirectory: string;
}

/** Location-resolution surface. One `location.get` call per resolution; no caching. */
export interface LocationResolver {
	/**
	 * Resolves the active project for an explicit directory via
	 * `location.get({ location: { directory } })`. Requires the response
	 * `directory` and `project.directory` to equal the requested directory and
	 * `project.id` to be a non-blank string.
	 */
	resolveActiveProject(directory: string): Promise<ResolvedProjectLocation>;

	/**
	 * Resolves one user-selected candidate via
	 * `location.get({ location: { directory: candidate.targetDirectory } })`.
	 * Requires the response `directory` and `project.directory` to equal the
	 * candidate directory and `project.id` to equal the candidate project ID.
	 */
	resolveSelectedProject(candidate: SelectedProjectCandidate): Promise<ResolvedProjectLocation>;
}

/* ------------------------------------------------------------------------- */
/* Factory                                                                   */
/* ------------------------------------------------------------------------- */

/**
 * Creates the location resolver. Fails closed with
 * `LocationResolutionError` (`capability-unavailable`) when `location.get` is
 * absent or not callable, before any host call.
 */
export function createLocationResolver(client: unknown): LocationResolver {
	const locationGet = resolveUnaryMethod<LocationGetCallInput>(client, "location", "get");
	if (locationGet === undefined) {
		throw new LocationResolutionError(
			"capability-unavailable",
			"The installed TUI client does not expose a callable location.get; cannot resolve a project",
		);
	}
	return {
		async resolveActiveProject(directory: string): Promise<ResolvedProjectLocation> {
			const requestedDirectory = requireExplicitDirectory(directory, "active project directory");
			const response = await locationGet({ location: { directory: requestedDirectory } });
			return validateResolution(response, requestedDirectory, undefined);
		},
		async resolveSelectedProject(candidate: SelectedProjectCandidate): Promise<ResolvedProjectLocation> {
			if (!isObjectRecord(candidate)) {
				throw new LocationResolutionError(
					"invalid-request",
					"resolveSelectedProject requires a candidate object with projectID and targetDirectory",
				);
			}
			const requestedProjectID = requireNonBlankString(candidate.projectID, "candidate project ID");
			const requestedDirectory = requireExplicitDirectory(candidate.targetDirectory, "candidate target directory");
			const response = await locationGet({ location: { directory: requestedDirectory } });
			return validateResolution(response, requestedDirectory, requestedProjectID);
		},
	};
}

/* ------------------------------------------------------------------------- */
/* Response validation (fail closed, no data in error messages)              */
/* ------------------------------------------------------------------------- */

/**
 * Validates one `location.get` response against the requested directory and,
 * for the selected-candidate flow, the requested project ID. Returns only
 * exactly verified values; any absence, malformed field, or mismatch rejects.
 * Error messages carry field labels and value types only — never directory
 * paths, project IDs, or raw host data.
 */
function validateResolution(
	response: unknown,
	requestedDirectory: string,
	expectedProjectID: string | undefined,
): ResolvedProjectLocation {
	if (!isObjectRecord(response)) {
		throw new LocationResolutionError(
			"invalid-response",
			`location.get did not return an object; received ${describeValue(response)}`,
		);
	}
	const responseDirectory = response["directory"];
	if (typeof responseDirectory !== "string" || responseDirectory.trim().length === 0) {
		throw new LocationResolutionError(
			"invalid-response",
			`location.get response must carry a non-blank string directory; received ${describeValue(responseDirectory)}`,
		);
	}
	if (responseDirectory !== requestedDirectory) {
		throw new LocationResolutionError(
			"mismatch",
			"location.get returned a directory that does not exactly match the requested directory",
		);
	}
	const project = response["project"];
	if (!isObjectRecord(project)) {
		throw new LocationResolutionError(
			"invalid-response",
			`location.get response must carry a project object; received ${describeValue(project)}`,
		);
	}
	const projectID = project["id"];
	if (typeof projectID !== "string" || projectID.trim().length === 0) {
		throw new LocationResolutionError(
			"invalid-response",
			`location.get response project must carry a non-blank string id; received ${describeValue(projectID)}`,
		);
	}
	if (expectedProjectID !== undefined && projectID !== expectedProjectID) {
		throw new LocationResolutionError(
			"mismatch",
			"location.get returned a project ID that does not exactly match the selected candidate",
		);
	}
	const projectDirectory = project["directory"];
	if (typeof projectDirectory !== "string" || projectDirectory.trim().length === 0) {
		throw new LocationResolutionError(
			"invalid-response",
			`location.get response project must carry a non-blank string directory; received ${describeValue(projectDirectory)}`,
		);
	}
	if (projectDirectory !== requestedDirectory) {
		throw new LocationResolutionError(
			"mismatch",
			"location.get returned a project directory that does not exactly match the requested directory",
		);
	}
	return { projectID, directory: requestedDirectory };
}

/** Requires an explicit non-blank directory; the value is returned verbatim. */
function requireExplicitDirectory(value: unknown, label: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new LocationResolutionError(
			"invalid-request",
			`${label} must be an explicit non-blank string; no default is applied`,
		);
	}
	return value;
}

/** Requires a non-blank string; the value is returned verbatim (never trimmed). */
function requireNonBlankString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new LocationResolutionError("invalid-request", `${label} must be a non-blank string`);
	}
	return value;
}

/** Type-only description for error messages; never includes the value itself. */
function describeValue(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	return typeof value;
}
