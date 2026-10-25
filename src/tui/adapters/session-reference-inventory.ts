/**
 * Bounded, read-only incoming-reference inventory for old-session deletion
 * decisions.
 *
 * The port pages the public TUI client's unfiltered `session.list` surface
 * (no `project` filter: the global request, all projects) or, at the caller's
 * explicit option, every project listed in `scope.projectIDs`. It projects
 * only the metadata needed to reason about incoming references:
 * `id`, `parentID`, `fork.sessionID`, `revert` presence, and flags for
 * unrecognized reference shapes. It never reads messages, never calls
 * `session.get`, and never touches a native picker, host-internal database,
 * filesystem, secrets, browser, import, or delete surface.
 *
 * Completeness rules (fail closed, no partial answer):
 * - pagination follows `cursor.next` to exhaustion; a repeated cursor, an
 *   empty page carrying a next cursor, a malformed page, a non-JSON/malformed
 *   info record, a missing/blank `id` or `projectID`, a duplicate ID anywhere
 *   in the scan, a project-scope mismatch, an unrecognized reference shape, or
 *   exceeding the explicit caller policy bounds all resolve with
 *   `status: "incomplete"` and `deleteEligible: false`;
 * - an incomplete result carries no entries at all, so a caller cannot
 *   accidentally treat partial metadata as a complete reference set;
 * - a complete result is `deleteEligible: true` only for a completed global
 *   scan or a completed scan of every explicitly supplied project. A
 *   project-scoped scan is deliberately not representable: a single-project
 *   inventory cannot conclude that no incoming cross-project reference
 *   exists.
 *
 * Data rules: the full info record is preserved as a detached module-owned
 * JSON snapshot (`entry.info`), including unknown/unmodeled JSON fields, so
 * the projection never silently drops host data. Every entry field is read
 * from that snapshot, never from the untrusted host object, and any throwing
 * getter or non-JSON value fails the whole scan with a fixed redacted reason.
 *
 * Bounds: the existing explicit `SessionCollectionPolicy` is reused with no
 * new defaults or guessed production caps. Only `sessionPageSize` (per
 * request) and `maxSessions` (aggregate ceiling) are applied; the message
 * fields are unused because no message is ever read.
 *
 * Consistency caveat (O-21/OQ-23 stay OPEN): the upstream list API documents
 * no snapshot isolation. This is a best-effort sequence of live page reads,
 * not an atomic cross-project snapshot; sessions created, deleted, or
 * reparented while it runs may be missed or stale.
 *
 * Evidence boundary: synthetic fake-client tests only. The global-scope
 * behavior of an unfiltered `session.list` request is declaration-derived and
 * unverified against a live host in this lane; no runtime, completeness, or
 * compatibility claim follows.
 */

import { snapshotJsonValue, type JsonObject } from "../../core/contracts/index.ts";
import {
	SessionCollectionError,
	validateSessionCollectionPolicy,
	type SessionCollectionPolicy,
} from "../../core/sessions/index.ts";
import {
	isObjectRecord,
	resolveUnaryMethod,
	type GlobalSessionListCallInput,
} from "./host-client.ts";

/* ------------------------------------------------------------------------- */
/* Public types                                                              */
/* ------------------------------------------------------------------------- */

/** Explicit scan scope. A single-project scope is deliberately not offered. */
export type SessionReferenceInventoryScope =
	| {
			/** Unfiltered `session.list`: every project the API returns. */
			readonly kind: "global";
	  }
	| {
			/** Every project in the caller-supplied complete all-project list. */
			readonly kind: "all-projects";
			readonly projectIDs: readonly string[];
	  };

/** Scope basis recorded on a result. */
export type SessionReferenceInventoryScopeKind = SessionReferenceInventoryScope["kind"];

/** Why a scan produced no usable inventory. Every detail string is fixed and redacted. */
export type SessionReferenceInventoryIncompleteReason =
	| "capability-unavailable"
	| "session-list-failed"
	| "malformed-session-page"
	| "malformed-session-record"
	| "session-project-mismatch"
	| "duplicate-session-id"
	| "repeated-session-cursor"
	| "session-limit-exceeded"
	| "unknown-reference-shape";

/**
 * One projected session info. `info` is a detached, module-owned JSON copy of
 * the full host record (unknown fields preserved); all other fields are
 * derived from that copy.
 */
export interface SessionReferenceInventoryEntry {
	/** Non-empty session ID from the info snapshot. */
	readonly id: string;
	/** Non-empty project ID from the info snapshot. */
	readonly projectID: string;
	/** Present only when `parentID` is a non-empty string. */
	readonly parentID?: string;
	/** Present only when `fork.sessionID` is a non-empty string. */
	readonly forkSessionID?: string;
	/** True whenever a `revert` field is present, regardless of its value shape. */
	readonly revertPresent: boolean;
	/** True when any known reference field had an unrecognized shape. */
	readonly unknownReferenceShape: boolean;
	/** True when `parentID` was present in a shape other than a non-empty string. */
	readonly parentIDUnknownShape: boolean;
	/** True when `fork`/`fork.sessionID` was present in an unrecognized shape. */
	readonly forkUnknownShape: boolean;
	/** True when `revert` was present but was not an object. */
	readonly revertUnknownShape: boolean;
	/** Detached module-owned copy preserving every JSON field of the host record. */
	readonly info: JsonObject;
}

/**
 * Fixed, module-owned scan result. Incomplete results never carry entries, so
 * no consumer can delete based on a partial inventory.
 */
export type SessionReferenceInventoryResult =
	| {
			readonly status: "complete";
			readonly scope: SessionReferenceInventoryScopeKind;
			/** True only after a complete global or complete all-projects scan. */
			readonly deleteEligible: true;
			readonly entries: readonly SessionReferenceInventoryEntry[];
	  }
	| {
			readonly status: "incomplete";
			readonly scope: SessionReferenceInventoryScopeKind;
			readonly deleteEligible: false;
			readonly reason: SessionReferenceInventoryIncompleteReason;
			/** Fixed technical detail; never contains host response values. */
			readonly detail: string;
	  };

/** Explicit, fully injected inventory configuration. No defaults exist. */
export interface SessionReferenceInventoryOptions {
	/** Required scan scope; a single project is not an accepted completeness basis. */
	readonly scope: SessionReferenceInventoryScope;
	/** Existing explicit collection policy; only `sessionPageSize` and `maxSessions` are used. */
	readonly policy: SessionCollectionPolicy;
}

/** One bounded incoming-reference inventory port. */
export interface SessionReferenceInventoryPort {
	/**
	 * Performs one read-only scan and resolves with a structured complete or
	 * incomplete result. Never throws for host failures; malformed options throw
	 * `SessionCollectionError` at construction.
	 */
	readIncomingReferences(): Promise<SessionReferenceInventoryResult>;
}

/* ------------------------------------------------------------------------- */
/* Fixed redacted details                                                    */
/* ------------------------------------------------------------------------- */

const DETAIL_CAPABILITY_UNAVAILABLE =
	"The installed TUI client does not expose a callable session.list; the incoming-reference inventory is unavailable";
const DETAIL_LIST_FAILED = "The session list request failed; no incoming-reference conclusion is possible";
const DETAIL_MALFORMED_PAGE = "A session list page did not match the declared data/cursor response contract";
const DETAIL_MALFORMED_RECORD = "A session list record did not match the declared JSON session-info contract";
const DETAIL_PROJECT_MISMATCH = "A session list record was returned outside the explicitly requested project scope";
const DETAIL_DUPLICATE_ID = "The session list repeated a session id across the scan";
const DETAIL_REPEATED_CURSOR = "The session list repeated a pagination cursor; refusing to loop";
const DETAIL_LIMIT_EXCEEDED =
	"The incoming-reference inventory exceeded the explicit SessionCollectionPolicy.maxSessions bound";
const DETAIL_UNKNOWN_REFERENCE = "A session record carried an unrecognized parentID, fork, or revert reference shape";
const DETAIL_UNEXPECTED = "The incoming-reference inventory stopped on an unexpected failure";

/* ------------------------------------------------------------------------- */
/* Factory                                                                   */
/* ------------------------------------------------------------------------- */

/**
 * Creates the bounded reference inventory. Scope and policy are validated
 * fail-closed at construction; a missing/non-callable `session.list` is not a
 * construction error and instead produces a typed `capability-unavailable`
 * result on every read.
 */
export function createSessionReferenceInventoryPort(
	client: unknown,
	options: SessionReferenceInventoryOptions,
): SessionReferenceInventoryPort {
	const rawOptions: unknown = options;
	if (!isObjectRecord(rawOptions)) {
		throw new SessionCollectionError(
			"invalid-request",
			"createSessionReferenceInventoryPort requires an options object with an explicit scope and policy",
		);
	}
	const scope = validateScope(rawOptions["scope"]);
	validateSessionCollectionPolicy(rawOptions["policy"] as SessionCollectionPolicy);
	const policy = rawOptions["policy"] as SessionCollectionPolicy;

	return {
		async readIncomingReferences(): Promise<SessionReferenceInventoryResult> {
			let listMethod: ((input: GlobalSessionListCallInput) => Promise<unknown>) | undefined;
			try {
				listMethod = resolveUnaryMethod<GlobalSessionListCallInput>(client, "session", "list");
			} catch {
				listMethod = undefined;
			}
			if (listMethod === undefined) {
				return incomplete(scope.kind, "capability-unavailable", DETAIL_CAPABILITY_UNAVAILABLE);
			}

			try {
				const entries: SessionReferenceInventoryEntry[] = [];
				const seenSessionIDs = new Set<string>();
				if (scope.kind === "global") {
					await collectScope(listMethod, undefined, policy, entries, seenSessionIDs);
				} else {
					for (const projectID of scope.projectIDs) {
						await collectScope(listMethod, projectID, policy, entries, seenSessionIDs);
					}
				}
				return { status: "complete", scope: scope.kind, deleteEligible: true, entries };
			} catch (error) {
				if (error instanceof ScanFailure) {
					return incomplete(scope.kind, error.reason, error.detail);
				}
				// Any unexpected failure is redacted; no host value is surfaced.
				return incomplete(scope.kind, "session-list-failed", DETAIL_UNEXPECTED);
			}
		},
	};
}

/* ------------------------------------------------------------------------- */
/* Scope validation (fail closed, no implicit project scope)                 */
/* ------------------------------------------------------------------------- */

function validateScope(value: unknown): SessionReferenceInventoryScope {
	if (!isObjectRecord(value)) {
		throw new SessionCollectionError(
			"invalid-request",
			"SessionReferenceInventoryOptions.scope must be an explicit { kind } object",
		);
	}
	const kind = value["kind"];
	if (kind === "global") {
		if ("projectID" in value) {
			throw new SessionCollectionError(
				"invalid-request",
				'SessionReferenceInventoryOptions.scope.kind "global" must not carry a projectID; a project-scoped scan cannot prove the absence of incoming cross-project references',
			);
		}
		return { kind: "global" };
	}
	if (kind === "all-projects") {
		const rawProjectIDs = value["projectIDs"];
		if (!Array.isArray(rawProjectIDs) || rawProjectIDs.length === 0) {
			throw new SessionCollectionError(
				"invalid-request",
				"SessionReferenceInventoryOptions.scope.projectIDs must be a non-empty explicit array of every project to scan",
			);
		}
		const projectIDs: string[] = [];
		const seenProjectIDs = new Set<string>();
		for (let index = 0; index < rawProjectIDs.length; index += 1) {
			const entry: unknown = rawProjectIDs[index];
			if (typeof entry !== "string" || entry.trim().length === 0) {
				throw new SessionCollectionError(
					"invalid-request",
					`SessionReferenceInventoryOptions.scope.projectIDs[${index}] must be a non-blank string`,
				);
			}
			if (seenProjectIDs.has(entry)) {
				throw new SessionCollectionError(
					"invalid-request",
					"SessionReferenceInventoryOptions.scope.projectIDs repeats a project id; refusing an ambiguous all-project scan",
				);
			}
			seenProjectIDs.add(entry);
			projectIDs.push(entry);
		}
		return { kind: "all-projects", projectIDs };
	}
	throw new SessionCollectionError(
		"invalid-request",
		'SessionReferenceInventoryOptions.scope.kind must be "global" or "all-projects"; a single-project scope cannot prove the absence of incoming cross-project references',
	);
}

/* ------------------------------------------------------------------------- */
/* Pagination                                                                */
/* ------------------------------------------------------------------------- */

/** Internal fail-closed signal; never escapes the port. */
class ScanFailure extends Error {
	readonly reason: SessionReferenceInventoryIncompleteReason;
	readonly detail: string;

	constructor(reason: SessionReferenceInventoryIncompleteReason, detail: string) {
		super(detail);
		this.name = "ScanFailure";
		this.reason = reason;
		this.detail = detail;
	}
}

interface ParsedPage {
	readonly items: readonly unknown[];
	/** `cursor.next` when present and non-null; `undefined` means the sequence is complete. */
	readonly next: string | undefined;
}

/**
 * Pages one scope (global when `projectID` is undefined, otherwise exactly
 * one project) to exhaustion and appends projected entries to the shared
 * aggregate. The aggregate duplicate and `maxSessions` checks span every
 * scope, so a repeated ID across projects fails closed.
 */
async function collectScope(
	listMethod: (input: GlobalSessionListCallInput) => Promise<unknown>,
	projectID: string | undefined,
	policy: SessionCollectionPolicy,
	entries: SessionReferenceInventoryEntry[],
	seenSessionIDs: Set<string>,
): Promise<void> {
	const usedCursors = new Set<string>();
	let cursor: string | undefined;

	for (;;) {
		const request =
			projectID === undefined
				? cursor === undefined
					? { limit: policy.sessionPageSize }
					: { limit: policy.sessionPageSize, cursor }
				: cursor === undefined
					? { project: projectID, limit: policy.sessionPageSize }
					: { project: projectID, limit: policy.sessionPageSize, cursor };

		let rawPage: unknown;
		try {
			rawPage = await listMethod(request);
		} catch {
			throw new ScanFailure("session-list-failed", DETAIL_LIST_FAILED);
		}
		const page = parsePage(rawPage);

		for (const rawInfo of page.items) {
			const info = snapshotInfo(rawInfo);
			const id = info["id"];
			if (typeof id !== "string" || id.length === 0) {
				throw new ScanFailure("malformed-session-record", DETAIL_MALFORMED_RECORD);
			}
			const boundProjectID = info["projectID"];
			if (typeof boundProjectID !== "string" || boundProjectID.length === 0) {
				throw new ScanFailure("malformed-session-record", DETAIL_MALFORMED_RECORD);
			}
			if (projectID !== undefined && boundProjectID !== projectID) {
				throw new ScanFailure("session-project-mismatch", DETAIL_PROJECT_MISMATCH);
			}
			if (seenSessionIDs.has(id)) {
				throw new ScanFailure("duplicate-session-id", DETAIL_DUPLICATE_ID);
			}
			if (entries.length >= policy.maxSessions) {
				throw new ScanFailure("session-limit-exceeded", DETAIL_LIMIT_EXCEEDED);
			}
			const entry = projectInfo(info, id, boundProjectID);
			seenSessionIDs.add(id);
			entries.push(entry);
		}

		if (page.next === undefined) break;
		if (usedCursors.has(page.next)) {
			throw new ScanFailure("repeated-session-cursor", DETAIL_REPEATED_CURSOR);
		}
		usedCursors.add(page.next);
		cursor = page.next;
	}
}

/**
 * Validates the untrusted `{ data, cursor }` envelope with the same semantics
 * used by the read adapters: a non-object response, missing `data` array,
 * non-object cursor, non-string/blank `cursor.next`, or an empty page with a
 * next cursor fails closed.
 */
function parsePage(value: unknown): ParsedPage {
	if (!isObjectRecord(value)) {
		throw new ScanFailure("malformed-session-page", DETAIL_MALFORMED_PAGE);
	}
	const data = value["data"];
	if (!Array.isArray(data)) {
		throw new ScanFailure("malformed-session-page", DETAIL_MALFORMED_PAGE);
	}

	let next: string | undefined;
	const cursor = value["cursor"];
	if (cursor !== undefined && cursor !== null) {
		if (!isObjectRecord(cursor)) {
			throw new ScanFailure("malformed-session-page", DETAIL_MALFORMED_PAGE);
		}
		const rawNext = cursor["next"];
		if (rawNext !== undefined && rawNext !== null) {
			if (typeof rawNext !== "string" || rawNext.length === 0) {
				throw new ScanFailure("malformed-session-page", DETAIL_MALFORMED_PAGE);
			}
			next = rawNext;
		}
	}

	if (next !== undefined && data.length === 0) {
		throw new ScanFailure("malformed-session-page", DETAIL_MALFORMED_PAGE);
	}
	return { items: data, next };
}

/** Copies one host record into a detached JSON-only object; any failure is redacted. */
function snapshotInfo(value: unknown): JsonObject {
	if (!isObjectRecord(value)) {
		throw new ScanFailure("malformed-session-record", DETAIL_MALFORMED_RECORD);
	}
	try {
		const snapshot = snapshotJsonValue(value, "session info record");
		if (!isObjectRecord(snapshot)) {
			throw new ScanFailure("malformed-session-record", DETAIL_MALFORMED_RECORD);
		}
		return snapshot as JsonObject;
	} catch {
		// Covers throwing getters, cycles, and non-JSON values in one redacted code.
		throw new ScanFailure("malformed-session-record", DETAIL_MALFORMED_RECORD);
	}
}

/**
 * Projects the known reference fields from a snapshot. Any recognized field
 * present in an unknown shape fails the whole scan: silently ignoring it
 * could hide an incoming reference and make a delete unsafe.
 */
function projectInfo(info: JsonObject, id: string, projectID: string): SessionReferenceInventoryEntry {
	const parentRaw = info["parentID"];
	let parentID: string | undefined;
	let parentIDUnknownShape = false;
	if (parentRaw !== undefined) {
		if (typeof parentRaw === "string" && parentRaw.length > 0) {
			parentID = parentRaw;
		} else {
			parentIDUnknownShape = true;
		}
	}

	const forkRaw = info["fork"];
	let forkSessionID: string | undefined;
	let forkUnknownShape = false;
	if (forkRaw !== undefined) {
		if (isObjectRecord(forkRaw)) {
			const reference = forkRaw["sessionID"];
			if (typeof reference === "string" && reference.length > 0) {
				forkSessionID = reference;
			} else {
				forkUnknownShape = true;
			}
		} else {
			forkUnknownShape = true;
		}
	}

	const revertRaw = info["revert"];
	const revertPresent = revertRaw !== undefined;
	const revertUnknownShape = revertPresent && !isObjectRecord(revertRaw);
	const unknownReferenceShape = parentIDUnknownShape || forkUnknownShape || revertUnknownShape;
	if (unknownReferenceShape) {
		throw new ScanFailure("unknown-reference-shape", DETAIL_UNKNOWN_REFERENCE);
	}

	return {
		id,
		projectID,
		...(parentID === undefined ? {} : { parentID }),
		...(forkSessionID === undefined ? {} : { forkSessionID }),
		revertPresent,
		unknownReferenceShape: false,
		parentIDUnknownShape: false,
		forkUnknownShape: false,
		revertUnknownShape: false,
		info,
	};
}

/** Builds the fixed incomplete result; never carries entries or host values. */
function incomplete(
	scope: SessionReferenceInventoryScopeKind,
	reason: SessionReferenceInventoryIncompleteReason,
	detail: string,
): SessionReferenceInventoryResult {
	return { status: "incomplete", scope, deleteEligible: false, reason, detail };
}
