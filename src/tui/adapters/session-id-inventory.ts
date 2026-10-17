/**
 * Bounded, metadata-only cross-project session-ID inventory (2026-10-14
 * owner-approved collision amendment).
 *
 * `createSessionIdInventory` builds one bounded read-only scan over the
 * already-validated project list and an injected core `SessionReadPort`
 * (`session.list` through the public client surface). It returns the session
 * IDs the API reports as visible, without reading any message, without
 * retaining any record content, and without any host call beyond
 * `session.list`.
 *
 * Inputs are explicit and injected; no client surface is resolved here:
 * - `projects` — the validated `project.list` candidates from the restore
 *   selection flow (`ProjectDestinationCandidate` satisfies the structural
 *   `SessionIdInventoryProject` view). Their `projectID`s scope the scan in
 *   candidate order.
 * - `selectedProjectID` — the resolved destination project. It is always
 *   included in the scan; when the candidates omit it, it is appended rather
 *   than silently ignored. Duplicate project IDs in the inventory fail closed.
 * - `policy` — the existing `SessionCollectionPolicy`. Only `sessionPageSize`
 *   (per-request page size) and `maxSessions` (aggregate ceiling across every
 *   project and page) are applied; no new numeric default or cap is invented,
 *   and the message limits are unused because no message is ever read.
 *
 * Scan semantics mirror the core collector's known page handling without
 * modifying it (the collector stays untouched):
 * - per project, `listSessions({ project, limit })` then
 *   `listSessions({ project, limit, cursor })`, following `cursor.next` until
 *   it is absent/null;
 * - each item must snapshot to a JSON-stable object carrying a non-empty
 *   string `id` and a `projectID` exactly equal to the requested project;
 * - any malformed page/item/id/scope, duplicate session ID anywhere in the
 *   scan, repeated cursor, empty page carrying a next cursor, aggregate
 *   overflow, or API failure rejects the whole inventory with the collector's
 *   existing `SessionCollectionError` codes (`invalid-request`,
 *   `invalid-policy`, `session-list-failed`, `malformed-session-page`,
 *   `malformed-session-record`, `session-project-mismatch`,
 *   `duplicate-session-id`, `repeated-session-cursor`,
 *   `session-limit-exceeded`). No partial ID list is ever returned.
 *
 * Data rules: only `info.id` and `info.projectID` are read from each record;
 * the record is snapshotted solely to fail closed on non-JSON values and is
 * never retained. Messages are never requested (`listMessages` is never
 * called), no `message.list`/`location.get`/`project.list`/import call is made
 * — the inventory takes an injected read port, not a client — and no project
 * location side effect is possible.
 *
 * Snapshot/concurrency limitations (O-21/OQ-23 stay OPEN): the upstream list
 * APIs document no snapshot consistency. This scan is a best-effort sequence
 * of live page reads, not an atomic cross-project snapshot; sessions created,
 * deleted, or renamed while it runs may be missed or stale, and the result is
 * only the inventory the API returned during this scan. There is no
 * completeness guarantee beyond that, no retry/re-read policy, and no claim
 * that the ID set is point-in-time consistent across projects.
 *
 * Evidence boundary: synthetic fake-port tests only; no live host call,
 * filesystem, crypto, or import is performed, and no runtime or compatibility
 * claim follows.
 */

import { snapshotJsonValue, type JsonObject, type JsonValue } from "../../core/contracts/index.ts";
import {
	SessionCollectionError,
	validateSessionCollectionPolicy,
	type SessionCollectionPolicy,
	type SessionListPageRequest,
	type SessionReadPort,
} from "../../core/sessions/index.ts";
import { isObjectRecord } from "./host-client.ts";

/* ------------------------------------------------------------------------- */
/* Public types                                                              */
/* ------------------------------------------------------------------------- */

/**
 * Structural view of one already-validated project-list candidate. Only the
 * project ID is used; `ProjectDestinationCandidate` (which also carries the
 * proposed `targetDirectory` and `label`) satisfies this view without being
 * re-derived or re-validated here.
 */
export interface SessionIdInventoryProject {
	/** Non-blank project ID from the validated `project.list` candidate set. */
	readonly projectID: string;
}

/** Explicit, fully injected inventory dependencies. Every field is required; no defaults exist. */
export interface SessionIdInventoryInput {
	/** Injected core read port; only `listSessions` is ever called. */
	readonly readPort: SessionReadPort;
	/**
	 * Validated project-list candidates whose project IDs scope the scan, in
	 * candidate order. Malformed or duplicate entries fail closed.
	 */
	readonly projects: readonly SessionIdInventoryProject[];
	/**
	 * Resolved selected destination project; always included in the scan even
	 * when the candidates omit it (it is appended, never silently ignored).
	 */
	readonly selectedProjectID: string;
	/** Explicit collection policy; only `sessionPageSize` and `maxSessions` are applied. */
	readonly policy: SessionCollectionPolicy;
}

/** One bounded metadata-only cross-project session-ID inventory surface. */
export interface SessionIdInventory {
	/**
	 * Performs one scan and resolves with every session ID the API returned,
	 * each exactly once, in deterministic project/page order. Rejects with a
	 * `SessionCollectionError` (collector codes) without returning any partial
	 * list; see the module header for the exact fail-closed rules and the
	 * documented snapshot/concurrency limitations.
	 */
	readGloballyVisibleSessionIDs(): Promise<readonly string[]>;
}

/* ------------------------------------------------------------------------- */
/* Factory                                                                   */
/* ------------------------------------------------------------------------- */

/**
 * Creates the metadata-only inventory. All inputs are validated fail-closed
 * here, before any host call: a malformed/duplicate project inventory throws
 * `SessionCollectionError("invalid-request")`, an invalid policy throws
 * `SessionCollectionError("invalid-policy")` through the shared core
 * validator, and a port without a callable `listSessions` throws
 * `invalid-request`.
 */
export function createSessionIdInventory(input: SessionIdInventoryInput): SessionIdInventory {
	if (!isObjectRecord(input)) {
		throw new SessionCollectionError(
			"invalid-request",
			"createSessionIdInventory requires an input object with readPort, projects, selectedProjectID, and policy",
		);
	}
	const readPort = input.readPort;
	if (!isObjectRecord(readPort) || typeof readPort.listSessions !== "function") {
		throw new SessionCollectionError(
			"invalid-request",
			"SessionIdInventory requires an injected SessionReadPort with a callable listSessions",
		);
	}
	validateSessionCollectionPolicy(input.policy);
	const projectIDs = resolveInventoryProjects(input.projects, input.selectedProjectID);
	const policy = input.policy;

	return {
		async readGloballyVisibleSessionIDs(): Promise<readonly string[]> {
			const sessionIDs: string[] = [];
			const seenSessionIDs = new Set<string>();
			for (const projectID of projectIDs) {
				await collectProjectSessionIDs(readPort, projectID, policy, sessionIDs, seenSessionIDs);
			}
			return sessionIDs;
		},
	};
}

/* ------------------------------------------------------------------------- */
/* Project-inventory validation (fail closed, no silent skips)               */
/* ------------------------------------------------------------------------- */

/**
 * Validates the project inventory and returns the deterministic scan order:
 * candidate project IDs verbatim in candidate order, then the selected
 * project ID appended when it is not already present. Malformed entries,
 * blank IDs, and any duplicate project ID reject the whole inventory before
 * any host call.
 */
function resolveInventoryProjects(projects: unknown, selectedProjectID: unknown): readonly string[] {
	if (!Array.isArray(projects)) {
		throw new SessionCollectionError(
			"invalid-request",
			"SessionIdInventory projects must be an array of validated project candidates",
		);
	}
	const projectIDs: string[] = [];
	const seenProjectIDs = new Set<string>();
	for (let index = 0; index < projects.length; index += 1) {
		const entry: unknown = projects[index];
		if (!isObjectRecord(entry)) {
			throw new SessionCollectionError(
				"invalid-request",
				`SessionIdInventory projects[${index}] must be an object with a projectID`,
			);
		}
		const projectID = entry["projectID"];
		if (typeof projectID !== "string" || projectID.trim().length === 0) {
			throw new SessionCollectionError(
				"invalid-request",
				`SessionIdInventory projects[${index}].projectID must be a non-blank string`,
			);
		}
		if (seenProjectIDs.has(projectID)) {
			throw new SessionCollectionError(
				"invalid-request",
				`SessionIdInventory project inventory repeats project id ${JSON.stringify(projectID)}; refusing an ambiguous scope`,
			);
		}
		seenProjectIDs.add(projectID);
		projectIDs.push(projectID);
	}
	if (typeof selectedProjectID !== "string" || selectedProjectID.trim().length === 0) {
		throw new SessionCollectionError(
			"invalid-request",
			"SessionIdInventory requires an explicit non-blank selectedProjectID",
		);
	}
	if (!seenProjectIDs.has(selectedProjectID)) {
		projectIDs.push(selectedProjectID);
	}
	return projectIDs;
}

/* ------------------------------------------------------------------------- */
/* Per-project pagination (collector page semantics, metadata only)          */
/* ------------------------------------------------------------------------- */

/**
 * Pages one project's session list to exhaustion and appends each newly seen
 * session ID to the shared aggregate list. The aggregate `seenSessionIDs`
 * set spans every project, so a duplicate ID anywhere in the scan fails
 * closed; `sessionIDs.length` is the aggregate ceiling counter checked
 * against `policy.maxSessions`.
 */
async function collectProjectSessionIDs(
	readPort: SessionReadPort,
	projectID: string,
	policy: SessionCollectionPolicy,
	sessionIDs: string[],
	seenSessionIDs: Set<string>,
): Promise<void> {
	const usedCursors = new Set<string>();
	let cursor: string | undefined;

	for (;;) {
		const pageRequest: SessionListPageRequest =
			cursor === undefined
				? { project: projectID, limit: policy.sessionPageSize }
				: { project: projectID, limit: policy.sessionPageSize, cursor };
		const label = `Session metadata inventory for project ${JSON.stringify(projectID)}`;
		const rawPage = await callPort(
			() => readPort.listSessions(pageRequest),
			"session-list-failed",
			`${label} request failed`,
		);
		const page = parsePageEnvelope(rawPage, "malformed-session-page", `${label} response`);

		for (const rawSession of page.items) {
			const info = snapshotJsonRecord(rawSession, "malformed-session-record", `${label} item ${sessionIDs.length}`);
			const id = info["id"];
			if (typeof id !== "string" || id.length === 0) {
				throw new SessionCollectionError(
					"malformed-session-record",
					`${label} returned an item without a non-empty string id`,
				);
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
			if (seenSessionIDs.has(id)) {
				throw new SessionCollectionError(
					"duplicate-session-id",
					`${label} returned session id ${JSON.stringify(id)} more than once across the inventory; refusing to continue`,
				);
			}
			if (sessionIDs.length >= policy.maxSessions) {
				throw new SessionCollectionError(
					"session-limit-exceeded",
					`Session metadata inventory exceeded SessionCollectionPolicy.maxSessions=${policy.maxSessions}; refusing to return a partial inventory`,
				);
			}
			seenSessionIDs.add(id);
			sessionIDs.push(id);
		}

		if (page.next === undefined) break;
		if (usedCursors.has(page.next)) {
			throw new SessionCollectionError(
				"repeated-session-cursor",
				`${label} returned a cursor that was already used: ${JSON.stringify(page.next)}; refusing to loop`,
			);
		}
		usedCursors.add(page.next);
		cursor = page.next;
	}
}

/* ------------------------------------------------------------------------- */
/* Shared page/record semantics (mirrors the core collector)                 */
/* ------------------------------------------------------------------------- */

interface ParsedPage {
	readonly items: readonly unknown[];
	/** `cursor.next` when present and non-null; `undefined` means the page sequence is complete. */
	readonly next: string | undefined;
}

/**
 * Validates the untrusted `{ data, cursor }` envelope with the same semantics
 * the core collector uses: a non-object response, a missing `data` array, a
 * non-object `cursor`, a non-string/blank `cursor.next`, or an empty page
 * carrying a next cursor all fail closed.
 */
function parsePageEnvelope(value: unknown, code: "malformed-session-page", label: string): ParsedPage {
	if (!isObjectRecord(value)) {
		throw new SessionCollectionError(code, `${label} was not an object`);
	}
	const data = value["data"];
	if (!Array.isArray(data)) {
		throw new SessionCollectionError(code, `${label} did not contain a data array`);
	}

	let next: string | undefined;
	const cursor = value["cursor"];
	if (cursor !== undefined && cursor !== null) {
		if (!isObjectRecord(cursor)) {
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
function snapshotJsonRecord(value: unknown, code: "malformed-session-record", label: string): JsonObject {
	if (!isObjectRecord(value)) {
		throw new SessionCollectionError(code, `${label} was not an object`);
	}
	let snapshot: JsonValue;
	try {
		snapshot = snapshotJsonValue(value, label);
	} catch (cause) {
		throw new SessionCollectionError(code, `${label} is not JSON-stable: ${errorText(cause)}`, { cause });
	}
	if (!isObjectRecord(snapshot)) {
		throw new SessionCollectionError(code, `${label} did not snapshot to an object`);
	}
	return snapshot as JsonObject;
}

/** Awaits one port call and converts non-collection failures into a coded error while preserving the cause. */
async function callPort(
	call: () => Promise<unknown>,
	code: "session-list-failed",
	label: string,
): Promise<unknown> {
	try {
		return await call();
	} catch (cause) {
		if (cause instanceof SessionCollectionError) throw cause;
		throw new SessionCollectionError(code, `${label}: ${errorText(cause)}`, { cause });
	}
}

/** Best-effort message text for wrapping a caught `unknown` value. */
function errorText(value: unknown): string {
	return value instanceof Error ? value.message : String(value);
}
