/**
 * Host project-destinations adapter: lists candidate restore destinations from
 * the public TUI client `context.client.project.list` method.
 *
 * Candidates are declaration/source-derived, not runtime-verified (OQ-16 stays
 * OPEN). Each candidate pairs the declared `Project.id` with the declared
 * `Project.canonical` path proposed as the import `targetDirectory`. The pinned
 * v2.0.22 declaration/source research (`lib-31`) describes `canonical` as an
 * absolute stored/main-checkout path that may be another clone and is NOT
 * guaranteed to be current, existing, unique, or to map back to the listed
 * project ID when used as a `session.import.location.directory` target. This
 * adapter therefore makes no canonical→ID mapping claim and never asserts the
 * pair is valid: callers MUST runtime-validate the selected
 * `{ projectID, targetDirectory }` pair before restore use and fail closed
 * whenever the pair cannot be resolved unambiguously.
 *
 * Scope and data rules:
 * - Returns destination candidates only; no restore or import behavior.
 * - Reads only `Project.id`, `Project.canonical`, and `Project.name`.
 *   `Project.sandboxes`, artifact fields, and any source project/location
 *   field are never read or returned.
 * - Paths are never normalized, resolved, joined, or trimmed: `canonical` is
 *   carried verbatim into `targetDirectory`, and blank values fail closed.
 * - `label` is `name` when it is a non-blank string, otherwise the verbatim
 *   `canonical` path, so the label is always non-empty.
 *
 * Fail-closed behavior (invalid entries are never silently skipped):
 * - missing or non-callable `project.list` → `HostAdapterError`
 *   (`capability-unavailable`) before any host call, matching the other host
 *   adapters;
 * - non-array responses, non-object records, missing/blank/non-string `id` or
 *   `canonical`, and non-string `name` values → `ProjectDestinationError`
 *   (`invalid-response`);
 * - conflicting `projectID` ↔ `targetDirectory` pairs (one ID mapping to
 *   different paths, one path mapping to different IDs, or a repeated pair
 *   with different labels) → `ProjectDestinationError` (`invalid-response`);
 *   only entries that are unambiguously identical (same ID, same canonical,
 *   same label) are deduplicated.
 * - Error messages carry only record positions/counts and value types, never
 *   project IDs, paths, or names.
 *
 * Method invocation follows the `host-client.ts` resolver convention:
 * `resolveUnaryMethod` resolves `client.project.list` and invokes it with the
 * owning `client.project` object preserved as the receiver via `Reflect.apply`.
 * `project.list` takes no required argument; the pinned declaration types its
 * only parameter as optional (`requestOptions?`), so the resolver's single
 * `undefined` argument is declaration-equivalent to `client.project.list()`.
 * Host/API rejections propagate unchanged; this adapter never wraps, retries,
 * or swallows them.
 *
 * Evidence boundary: pinned v2.0.22 declaration/source research (`lib-31`) and
 * synthetic fake-client tests only. This module makes no live host call and no
 * cross-version, mapping, compatibility, or support claim follows from it.
 */

import type { Plugin } from "@opencode/plugin/tui";
import { HostAdapterError, isObjectRecord, resolveUnaryMethod } from "./host-client.ts";

/* ------------------------------------------------------------------------- */
/* Errors                                                                    */
/* ------------------------------------------------------------------------- */

/**
 * Stable machine-readable failure code for project-list response validation.
 * Capability absence reuses `HostAdapterError("capability-unavailable")`;
 * this code covers a response that violated the declared `Project` record
 * shape or contained an ambiguous `projectID` ↔ `canonical` pair. The shared
 * `HostAdapterErrorCode` also includes `invalid-response` for other boundaries,
 * but this module retains its specific `ProjectDestinationError` type and
 * taxonomy for project-list failures.
 */
export type ProjectDestinationErrorCode = "invalid-response";

/** Fail-closed project-list response error; host API errors are never wrapped in it. */
export class ProjectDestinationError extends Error {
	readonly code: ProjectDestinationErrorCode;

	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "ProjectDestinationError";
		this.code = "invalid-response";
	}
}

/* ------------------------------------------------------------------------- */
/* Narrow client surface (documentation + compile-time assertions)           */
/* ------------------------------------------------------------------------- */

/**
 * Narrow structural view of the public project surface used for destination
 * enumeration. `project` and `list` are optional because capability absence is
 * a real runtime state; the factory fails closed with a clear
 * `HostAdapterError` when the method is missing or not callable.
 */
export interface ProjectListClientLike {
	readonly project?: {
		list?(): Promise<unknown>;
	};
}

type HostTuiClient = Plugin.Context["client"];
type AssertTrue<T extends true> = T;

/**
 * The installed v2.0.22 TUI client (`Plugin.Context["client"]`) must satisfy
 * the narrow project-list surface; if a future pinned declaration drifts,
 * `tsc` fails here instead of failing at runtime.
 */
type _AssertHostProjectListClientCompatible = AssertTrue<HostTuiClient extends ProjectListClientLike ? true : false>;

/**
 * The declared `project.list` output must keep exposing the candidate source
 * fields (`id`, `canonical`, optional `name`) this adapter maps from. Drift in
 * those fields is a compile error, not a silent runtime fallback.
 */
type HostProjectListOutput = Awaited<ReturnType<HostTuiClient["project"]["list"]>>;
type _AssertHostProjectListOutputHasCandidateFields = AssertTrue<
	HostProjectListOutput extends readonly { readonly id: string; readonly canonical: string; readonly name?: string }[]
		? true
		: false
>;

/* ------------------------------------------------------------------------- */
/* Public types                                                              */
/* ------------------------------------------------------------------------- */

/**
 * One destination candidate. `projectID` and `targetDirectory` are the
 * declaration-derived proposed pair (`Project.id` / `Project.canonical`);
 * `targetDirectory` is verbatim, never normalized. The pair requires runtime
 * validation before restore use — see the module header (OQ-16 OPEN).
 */
export interface ProjectDestinationCandidate {
	readonly projectID: string;
	/** `Project.canonical`, verbatim, proposed as the explicit import target. */
	readonly targetDirectory: string;
	/** Non-empty display label: `Project.name` when non-blank, else `canonical`. */
	readonly label: string;
}

/** Destination-candidate listing surface. One call per selection flow; no caching. */
export interface ProjectDestinationsAdapter {
	/**
	 * Calls the public `project.list` once and maps the response to candidates.
	 * Rejects with `HostAdapterError` (`capability-unavailable`) only when the
	 * method is unavailable (checked at construction), with
	 * `ProjectDestinationError` (`invalid-response`) for malformed/ambiguous
	 * responses, and with the unchanged host error for host rejections.
	 */
	listDestinations(): Promise<readonly ProjectDestinationCandidate[]>;
}

/* ------------------------------------------------------------------------- */
/* Factory                                                                   */
/* ------------------------------------------------------------------------- */

/**
 * Creates the destination-candidates adapter. Fails closed with
 * `HostAdapterError` (`capability-unavailable`) when `project.list` is absent
 * or not callable, before any host call.
 */
export function createProjectDestinationsAdapter(client: unknown): ProjectDestinationsAdapter {
	const projectList = resolveUnaryMethod<undefined>(client, "project", "list");
	if (projectList === undefined) {
		throw new HostAdapterError(
			"capability-unavailable",
			"The installed TUI client does not expose a callable project.list; cannot enumerate destination candidates",
		);
	}
	return {
		async listDestinations(): Promise<readonly ProjectDestinationCandidate[]> {
			// The resolver always applies exactly one argument; the pinned
			// declaration's only parameter is optional, so `undefined` is the
			// declaration-equivalent of calling `client.project.list()`.
			const response = await projectList(undefined);
			return mapProjectListResponse(response);
		},
	};
}

/* ------------------------------------------------------------------------- */
/* Response mapping (fail closed, no silent skips)                           */
/* ------------------------------------------------------------------------- */

/**
 * Maps a raw `project.list` response to destination candidates.
 *
 * Strict and fail-closed: any non-array response or any malformed record
 * rejects the entire list (no filtering, no partial results). Duplicate
 * entries are collapsed only when unambiguously identical; every other
 * repeated `projectID` or `canonical` value rejects as an ambiguous pair.
 * Error messages never embed project data (only positions, counts, types).
 */
export function mapProjectListResponse(response: unknown): readonly ProjectDestinationCandidate[] {
	if (!Array.isArray(response)) {
		throw new ProjectDestinationError(
			`project.list response must be an array of project records; received ${describeValue(response)}`,
		);
	}
	const total = response.length;
	const candidates: ProjectDestinationCandidate[] = [];
	const byProjectID = new Map<string, ProjectDestinationCandidate>();
	const byTargetDirectory = new Map<string, ProjectDestinationCandidate>();

	for (let index = 0; index < total; index += 1) {
		const candidate = parseProjectRecord(response[index], index, total);
		const knownByProjectID = byProjectID.get(candidate.projectID);
		const knownByTargetDirectory = byTargetDirectory.get(candidate.targetDirectory);
		if (knownByProjectID !== undefined || knownByTargetDirectory !== undefined) {
			// Deduplicate only an unambiguously identical entry: both lookups
			// must resolve to the same previously accepted candidate and every
			// candidate field must match. Anything else is a conflicting pair.
			const isExactDuplicate =
				knownByProjectID !== undefined &&
				knownByProjectID === knownByTargetDirectory &&
				candidate.projectID === knownByProjectID.projectID &&
				candidate.targetDirectory === knownByProjectID.targetDirectory &&
				candidate.label === knownByProjectID.label;
			if (isExactDuplicate) continue;
			throw new ProjectDestinationError(
				`project.list record ${index + 1} of ${total} conflicts with an earlier project ID/canonical directory pair; refusing to guess a destination`,
			);
		}
		byProjectID.set(candidate.projectID, candidate);
		byTargetDirectory.set(candidate.targetDirectory, candidate);
		candidates.push(candidate);
	}
	return candidates;
}

/**
 * Validates one `Project` record against the fields this adapter reads and
 * builds a candidate. `id` and `canonical` must be non-blank strings and are
 * carried verbatim (blankness is checked with `trim`, the value is never
 * trimmed or normalized). `name` must be absent or a string; a non-blank
 * string is the label, otherwise the label falls back to `canonical`.
 */
function parseProjectRecord(raw: unknown, index: number, total: number): ProjectDestinationCandidate {
	const position = `project.list record ${index + 1} of ${total}`;
	if (!isObjectRecord(raw)) {
		throw new ProjectDestinationError(`${position} must be an object; received ${describeValue(raw)}`);
	}
	const projectID = requireResponseString(raw["id"], "id", position);
	const targetDirectory = requireResponseString(raw["canonical"], "canonical", position);
	const rawName = raw["name"];
	if (rawName === undefined) {
		return { projectID, targetDirectory, label: targetDirectory };
	}
	if (typeof rawName !== "string") {
		throw new ProjectDestinationError(`${position} has a non-string name; received ${describeValue(rawName)}`);
	}
	const label = rawName.trim().length > 0 ? rawName : targetDirectory;
	return { projectID, targetDirectory, label };
}

/** Requires a non-blank string field or fails closed; the value is returned verbatim. */
function requireResponseString(value: unknown, field: string, position: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new ProjectDestinationError(
			`${position} must carry a non-blank string ${field}; received ${describeValue(value)}`,
		);
	}
	return value;
}

/** Type-only description for error messages; never includes the value itself. */
function describeValue(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	return typeof value;
}
