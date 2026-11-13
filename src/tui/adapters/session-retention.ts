/**
 * Owner-directed checkpoint session-retention read port (2026-11-13;
 * configurable retention modes added 2026-11-13).
 *
 * Purpose: checkpoints are large because a real workspace project's session
 * list is dominated by subagent (child) sessions. In one measured project,
 * 245 of 248 sessions were child sessions and held 87% of the bytes; keeping
 * every root session plus only the 20 most recently updated child sessions
 * reduced the payload from 245.5 MiB to 41.1 MiB and the gzip size from
 * 89.7 MiB to 17.6 MiB.
 *
 * This module deliberately trades completeness for weight, at the owner's
 * explicit direction, and is scoped to checkpoint artifacts only. Restore
 * destination snapshots must keep using the unchanged core collector
 * (`collectCheckpointPayload`); they must never use this retention port.
 *
 * Retention modes (roots are always kept in every mode). The owner-directed
 * product default is "since-compaction" ("subagents after compaction"), but
 * this adapter requires the mode explicitly and applies no hidden default:
 * - "since-compaction": scans every project root session's messages, takes the
 *   latest compaction timestamp across those roots, and keeps only children
 *   whose finite `time.created` is strictly greater. A positive
 *   `maxSubagentSessions` still caps the survivors by `time.updated`
 *   descending with ascending `id` as the tie-break; zero keeps no children.
 *   When no root has a compaction, it falls back to "latest".
 * - "latest": keeps the `maxSubagentSessions` children with the greatest
 *   finite `time.updated`, breaking equal timestamps by ascending `id`; zero
 *   keeps roots only.
 * - "all": keeps every child; the cap is ignored for retention but still
 *   validated.
 * - "roots": keeps the `maxRootSessions` most recently active root sessions
 *   and every subagent session that descends from one of them (direct or
 *   nested). Children of older roots, orphan children whose parent is absent
 *   from the project list, and children of an unknown parent are excluded.
 *   Root activity is the finite `time.updated` (falling back to
 *   `time.created`); a root without either timestamp fails closed rather than
 *   being ranked by guesswork. Parent chains are cycle-checked and fail closed.
 *
 * `readCheckpointRetentionInsights` is a metadata-only companion used before
 * the chooser renders: it enumerates the same project list, reads no messages,
 * and reports root ages plus a recommendation. It recommends `"roots"` with
 * the number of roots active inside an explicit recent-days window when older
 * roots exist; otherwise it recommends `"since-compaction"`.
 *
 * Behavior:
 * - Enumerates the complete project session list through the injected
 *   dependency-capable read port, with the same strict `{ data, cursor }`
 *   page-envelope semantics and fail-closed codes as the core collector and
 *   the metadata inventory adapters.
 * - Classifies each session by `parentID`: absent or `null` is a root; a
 *   string is a child; any other value fails closed.
 * - Compaction discovery pages each root's messages exactly like the core
 *   collector: `order: "asc"` first, then the opaque cursor, with strict
 *   message-envelope, duplicate-id, repeated-cursor, and
 *   `maxMessagesPerSession` enforcement. Only the latest compaction timestamp
 *   is retained; message content is never kept. Any scan failure propagates.
 * - Exposes the kept records, in their original project-list order and
 *   untouched, through a one-shot `listSessions` call; the returned port never
 *   exposes a cursor and rejects every later `listSessions` call because the
 *   kept list is already complete and materialized. `listMessages` and
 *   `getSession` delegate verbatim to the injected read port.
 * - The summary (mode, project/kept/excluded counts, and the configured child
 *   cap) must be reported to the user; the reduction is intentional and
 *   visible.
 *
 * Dependency closure still runs after this port and may add referenced
 * parent/fork sessions back to the checkpoint; that is expected and is why
 * this port only ranks and excludes child sessions rather than authorizing a
 * final payload.
 *
 * Evidence boundary: no host, database, filesystem, crypto, or import work is
 * performed here. Behavior and failure semantics are pinned by synthetic
 * fake-port tests only; this adds no runtime, completeness, or compatibility
 * claim beyond the existing adapter/host research, and it defines no new
 * numeric default or cap.
 */

import {
	SessionCollectionError,
	validateSessionCollectionPolicy,
	type MessageListPageRequest,
	type SessionCollectionErrorCode,
	type SessionCollectionPolicy,
	type SessionDependencyReadPort,
	type SessionListPageRequest,
} from "../../core/sessions/index.ts";
import { isObjectRecord } from "./host-client.ts";

/* ------------------------------------------------------------------------- */
/* Public types                                                              */
/* ------------------------------------------------------------------------- */

/**
 * Checkpoint child-retention policy. Roots are always kept.
 * - `"since-compaction"` — owner-directed default policy; keep children
 *   created after the latest compaction across project roots, falling back to
 *   `"latest"` when no compaction exists.
 * - `"latest"` — keep the most recently updated children.
 * - `"all"` — keep every child.
 * - `"roots"` — keep the most recently active root sessions and all of their
 *   subagent descendants; older roots and their children are excluded.
 */
export type SubagentRetentionMode = "latest" | "since-compaction" | "all" | "roots";

/** Fully injected retention inputs. Every field is required; no defaults exist. */
export interface SubagentRetentionInput {
	/** Enumerated exactly once; later checkpoint reads delegate to it. */
	readonly readPort: SessionDependencyReadPort;
	/** Explicit project scope for the single enumeration pass. */
	readonly projectID: string;
	/** Existing collection bounds; `sessionPageSize` and `maxSessions` are enforced. */
	readonly policy: SessionCollectionPolicy;
	/** Explicit retention mode; no hidden default is substituted. */
	readonly mode: SubagentRetentionMode;
	/**
	 * Number of child sessions retained by `"latest"`, and the cap applied to
	 * post-compaction survivors in `"since-compaction"`. Ignored for retention
	 * (but still validated) in `"all"` and `"roots"`. A non-negative safe
	 * integer; `0` keeps roots only. `null` means "no cap" for
	 * `"since-compaction"` (and the no-compaction fallback); it is rejected for
	 * `"latest"`, which requires an explicit count. Applied verbatim, never
	 * clamped or defaulted.
	 */
	readonly maxSubagentSessions: number | null;
	/**
	 * Number of most recently active root sessions retained by `"roots"`,
	 * together with all of their subagent descendants. A positive safe integer;
	 * required for `"roots"` and ignored (but validated when present) for every
	 * other mode.
	 */
	readonly maxRootSessions?: number | null;
}

/** User-facing accounting for the deliberate checkpoint reduction. */
export interface SubagentRetentionSummary {
	/** The retention mode that produced the kept list. */
	readonly mode: SubagentRetentionMode;
	/** Every session returned by the project-scoped list, across all pages. */
	readonly projectSessionCount: number;
	/** Root sessions plus the retained child sessions. */
	readonly keptSessionCount: number;
	/** `projectSessionCount - keptSessionCount`. */
	readonly excludedSessionCount: number;
	/** Root sessions retained (`roots.length` for every mode except `"roots"`). */
	readonly keptRootCount: number;
	/** The configured child cap, echoed verbatim (`null` = no cap). */
	readonly maxSubagentSessions: number | null;
	/** The configured root cap, echoed verbatim (`null` outside `"roots"`). */
	readonly maxRootSessions: number | null;
}

/** One-shot retained read surface plus the reduction summary. */
export interface SubagentRetention {
	/**
	 * Wraps the injected port. Its first `listSessions` call returns every kept
	 * record in original list order with `cursor: null`; later calls reject with
	 * `invalid-request`. Message and single-session reads delegate verbatim.
	 */
	readonly port: SessionDependencyReadPort;
	/** Must be reported to the user: checkpoint content was intentionally reduced. */
	readonly summary: SubagentRetentionSummary;
}

/* ------------------------------------------------------------------------- */
/* Retention insights (metadata-only, shown before the chooser)              */
/* ------------------------------------------------------------------------- */

/** One root session's last activity, used only for the chooser recommendation. */
export interface RootSessionActivity {
	readonly id: string;
	/** Finite `time.updated` (fallback `time.created`) in epoch milliseconds; null when the root has neither. */
	readonly lastActiveAt: number | null;
}

/**
 * Advisory recommendation for the checkpoint-size chooser. `"roots"` is
 * recommended when at least one root falls outside the recent-activity window
 * and at least one root falls inside it; `"since-compaction"` is recommended
 * when every root is recent (or the project has no roots).
 */
export interface CheckpointRetentionRecommendation {
	readonly mode: "roots" | "since-compaction";
	/** Root count for `"roots"`; `null` for `"since-compaction"`. */
	readonly maxRootSessions: number | null;
	/** Roots whose last activity is inside the window. */
	readonly recentRootCount: number;
	readonly totalRootCount: number;
	readonly windowDays: number;
	/** `now - windowDays * 24h` in epoch milliseconds. */
	readonly windowStartAt: number;
}

/** Root-age facts computed from the project session list; no message is read. */
export interface CheckpointRetentionInsights {
	readonly totalRootSessions: number;
	readonly totalChildSessions: number;
	/** Every root, newest activity first. */
	readonly roots: readonly RootSessionActivity[];
	/** Roots active within each fixed window, independent of the recommendation window. */
	readonly activeRootCounts: {
		readonly days7: number;
		readonly days30: number;
		readonly days90: number;
	};
	readonly newestRootAt: number | null;
	readonly oldestRootAt: number | null;
	readonly recommendation: CheckpointRetentionRecommendation;
}

/** Fully injected insights inputs. `now` and `recentDays` are explicit; no hidden clock or window. */
export interface CheckpointRetentionInsightsInput {
	/** Only `listSessions` is called; messages and single-session reads are never touched. */
	readonly readPort: Pick<SessionDependencyReadPort, "listSessions">;
	readonly projectID: string;
	readonly policy: SessionCollectionPolicy;
	/** Explicit current time in epoch milliseconds. */
	readonly now: number;
	/** Positive activity window in days used for the recommendation. */
	readonly recentDays: number;
}

const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;

/* ------------------------------------------------------------------------- */
/* Factory                                                                   */
/* ------------------------------------------------------------------------- */

/**
 * Enumerates the project's sessions once and returns the retained read port and
 * summary. All inputs are validated before any read: malformed inputs or a
 * port without all three callable methods reject with `invalid-request`, an
 * invalid policy rejects with `invalid-policy` through the shared core
 * validator, and malformed pages/records or collection bounds preserve the
 * core collector's failure codes.
 */
export async function createSubagentRetentionPort(input: SubagentRetentionInput): Promise<SubagentRetention> {
	if (!isObjectRecord(input)) {
		throw new SessionCollectionError(
			"invalid-request",
			"createSubagentRetentionPort requires an input object with readPort, projectID, policy, mode, and maxSubagentSessions (plus maxRootSessions for roots mode)",
		);
	}
	const readPort = input.readPort;
	if (
		!isObjectRecord(readPort) ||
		typeof readPort.listSessions !== "function" ||
		typeof readPort.listMessages !== "function" ||
		typeof readPort.getSession !== "function"
	) {
		throw new SessionCollectionError(
			"invalid-request",
			"SubagentRetention requires an injected SessionDependencyReadPort with callable listSessions, listMessages, and getSession",
		);
	}
	const projectID = input.projectID;
	if (typeof projectID !== "string" || projectID.trim().length === 0) {
		throw new SessionCollectionError(
			"invalid-request",
			"SubagentRetention requires an explicit non-blank projectID",
		);
	}
	validateSessionCollectionPolicy(input.policy);
	const mode = input.mode;
	if (mode !== "latest" && mode !== "since-compaction" && mode !== "all" && mode !== "roots") {
		throw new SessionCollectionError(
			"invalid-request",
			`SubagentRetention.mode must be one of "latest", "since-compaction", "all", or "roots" (got ${String(mode)})`,
		);
	}
	const maxSubagentSessions = input.maxSubagentSessions;
	if (
		maxSubagentSessions !== null &&
		(typeof maxSubagentSessions !== "number" ||
			!Number.isSafeInteger(maxSubagentSessions) ||
			maxSubagentSessions < 0)
	) {
		throw new SessionCollectionError(
			"invalid-request",
			`SubagentRetention.maxSubagentSessions must be null or an explicit non-negative safe integer (got ${String(maxSubagentSessions)})`,
		);
	}
	if (mode === "latest" && maxSubagentSessions === null) {
		throw new SessionCollectionError(
			"invalid-request",
			'SubagentRetention mode "latest" requires a numeric maxSubagentSessions; null (no cap) is only valid for "since-compaction"',
		);
	}
	const maxRootSessions = input.maxRootSessions;
	if (
		maxRootSessions !== undefined &&
		maxRootSessions !== null &&
		(typeof maxRootSessions !== "number" || !Number.isSafeInteger(maxRootSessions) || maxRootSessions < 1)
	) {
		throw new SessionCollectionError(
			"invalid-request",
			`SubagentRetention.maxRootSessions must be a positive safe integer when present (got ${String(maxRootSessions)})`,
		);
	}
	if (mode === "roots" && (maxRootSessions === undefined || maxRootSessions === null)) {
		throw new SessionCollectionError(
			"invalid-request",
			'SubagentRetention mode "roots" requires a numeric maxRootSessions',
		);
	}
	const policy = input.policy;

	const sessions = await collectProjectSessions(readPort, projectID, policy);
	const roots = sessions.filter((session) => session.isRoot);
	const children = sessions.filter(
		(session): session is ChildSession => !session.isRoot,
	);
	let keptRoots: readonly EnumeratedSession[] = roots;
	let keptChildren: readonly ChildSession[];
	switch (mode) {
		case "all":
			keptChildren = children;
			break;
		case "latest":
			keptChildren = selectLatestChildren(children, maxSubagentSessions);
			break;
		case "since-compaction":
			keptChildren = await selectPostCompactionChildren(
				readPort,
				roots,
				children,
				maxSubagentSessions,
				policy,
			);
			break;
		case "roots": {
			const rootTimestamps = new Map<string, number>();
			for (const root of roots) rootTimestamps.set(root.id, requireRootTimestamp(root));
			keptRoots = [...roots]
				.sort((left, right) => compareRootsByRecency(left, right, rootTimestamps))
				.slice(0, maxRootSessions as number);
			keptChildren = selectDescendantChildren(
				sessions,
				new Set(keptRoots.map((root) => root.id)),
			);
			break;
		}
	}
	const keptIDs = new Set<string>(keptRoots.map((session) => session.id));
	for (const session of keptChildren) keptIDs.add(session.id);
	const keptSessions = sessions.filter((session) => keptIDs.has(session.id)).map((session) => session.info);
	const keptSessionCount = keptRoots.length + keptChildren.length;

	let consumed = false;
	const port: SessionDependencyReadPort = {
		async listSessions(_request: SessionListPageRequest): Promise<unknown> {
			if (consumed) {
				throw new SessionCollectionError(
					"invalid-request",
					"SubagentRetention.listSessions has already materialized and returned the complete kept session list; it exposes no cursor and accepts no further calls",
				);
			}
			consumed = true;
			return { data: keptSessions, cursor: null };
		},
		listMessages(request: MessageListPageRequest): Promise<unknown> {
			return readPort.listMessages(request);
		},
		getSession(sessionID: string): Promise<unknown> {
			return readPort.getSession(sessionID);
		},
	};

	return {
		port,
		summary: {
			mode,
			projectSessionCount: sessions.length,
			keptSessionCount,
			excludedSessionCount: sessions.length - keptSessionCount,
			keptRootCount: keptRoots.length,
			maxSubagentSessions,
			maxRootSessions: maxRootSessions ?? null,
		},
	};
}

/**
 * Reads root-session ages from the project list and recommends one retention
 * mode for the chooser. This is metadata-only: it never calls `listMessages` or
 * `getSession`, writes nothing, and has no effect on the checkpoint itself.
 * Every input is validated fail-closed; malformed sessions and roots without a
 * finite activity timestamp reject with `malformed-session-record`.
 */
export async function readCheckpointRetentionInsights(
	input: CheckpointRetentionInsightsInput,
): Promise<CheckpointRetentionInsights> {
	if (!isObjectRecord(input)) {
		throw new SessionCollectionError(
			"invalid-request",
			"readCheckpointRetentionInsights requires an input object with readPort, projectID, policy, now, and recentDays",
		);
	}
	const readPort = input.readPort;
	if (!isObjectRecord(readPort) || typeof readPort.listSessions !== "function") {
		throw new SessionCollectionError(
			"invalid-request",
			"Retention insights require an injected read port with a callable listSessions",
		);
	}
	const projectID = input.projectID;
	if (typeof projectID !== "string" || projectID.trim().length === 0) {
		throw new SessionCollectionError(
			"invalid-request",
			"Retention insights require an explicit non-blank projectID",
		);
	}
	validateSessionCollectionPolicy(input.policy);
	const now = input.now;
	if (typeof now !== "number" || !Number.isFinite(now)) {
		throw new SessionCollectionError(
			"invalid-request",
			`Retention insights require a finite numeric now in epoch milliseconds (got ${String(now)})`,
		);
	}
	const recentDays = input.recentDays;
	if (typeof recentDays !== "number" || !Number.isFinite(recentDays) || recentDays <= 0) {
		throw new SessionCollectionError(
			"invalid-request",
			`Retention insights require a positive finite recentDays (got ${String(recentDays)})`,
		);
	}

	const sessions = await collectProjectSessions(readPort, projectID, input.policy);
	const roots = sessions.filter((session) => session.isRoot);
	const activities: RootSessionActivity[] = roots.map((root) => ({
		id: root.id,
		lastActiveAt: optionalRootTimestamp(root),
	}));
	activities.sort((left, right) => {
		if (left.lastActiveAt === null && right.lastActiveAt === null) {
			if (left.id === right.id) return 0;
			return left.id < right.id ? -1 : 1;
		}
		if (left.lastActiveAt === null) return 1;
		if (right.lastActiveAt === null) return -1;
		if (left.lastActiveAt !== right.lastActiveAt) return right.lastActiveAt - left.lastActiveAt;
		if (left.id === right.id) return 0;
		return left.id < right.id ? -1 : 1;
	});
	const dated = activities.filter(
		(root): root is RootSessionActivity & { readonly lastActiveAt: number } => root.lastActiveAt !== null,
	);
	const countActive = (days: number): number => {
		const start = now - days * DAY_MILLISECONDS;
		return dated.filter((root) => root.lastActiveAt >= start).length;
	};
	const recentRootCount = countActive(recentDays);
	// Never recommend a mode that cannot rank an undated root; since-compaction
	// keeps every root and does not need root timestamps.
	const recommendRoots = roots.length > 0 && dated.length === roots.length && recentRootCount < roots.length;
	return {
		totalRootSessions: roots.length,
		totalChildSessions: sessions.length - roots.length,
		roots: activities,
		activeRootCounts: {
			days7: countActive(7),
			days30: countActive(30),
			days90: countActive(90),
		},
		newestRootAt: dated[0]?.lastActiveAt ?? null,
		oldestRootAt: dated[dated.length - 1]?.lastActiveAt ?? null,
		recommendation: {
			mode: recommendRoots ? "roots" : "since-compaction",
			maxRootSessions: recommendRoots ? Math.max(1, recentRootCount) : null,
			recentRootCount,
			totalRootCount: roots.length,
			windowDays: recentDays,
			windowStartAt: now - recentDays * DAY_MILLISECONDS,
		},
	};
}

/* ------------------------------------------------------------------------- */
/* Enumeration and classification (collector page semantics)                 */
/* ------------------------------------------------------------------------- */

interface EnumeratedSession {
	/** The original API record; retained untouched and never normalized. */
	readonly info: { readonly [key: string]: unknown };
	readonly id: string;
	readonly isRoot: boolean;
	/** Present only for children; the already-validated parent session id. */
	readonly parentID?: string;
	/** Present only for children; finite `time.updated` used for ranking. */
	readonly updated?: number;
}

interface ChildSession extends EnumeratedSession {
	readonly isRoot: false;
	readonly parentID: string;
	readonly updated: number;
}

/**
 * Pages the project session list to exhaustion and validates every item. Any
 * malformed page/item, project mismatch, duplicate id, repeated cursor, or
 * `maxSessions` overflow rejects the whole retention pass; nothing is ever
 * truncated.
 */
async function collectProjectSessions(
	readPort: Pick<SessionDependencyReadPort, "listSessions">,
	projectID: string,
	policy: SessionCollectionPolicy,
): Promise<readonly EnumeratedSession[]> {
	const sessions: EnumeratedSession[] = [];
	const seenSessionIDs = new Set<string>();
	const usedCursors = new Set<string>();
	let cursor: string | undefined;

	for (;;) {
		const pageRequest: SessionListPageRequest =
			cursor === undefined
				? { project: projectID, limit: policy.sessionPageSize }
				: { project: projectID, limit: policy.sessionPageSize, cursor };
		const label = `Session retention snapshot for project ${JSON.stringify(projectID)}`;
		const rawPage = await callPort(
			() => readPort.listSessions(pageRequest),
			"session-list-failed",
			`${label} request failed`,
		);
		const page = parsePageEnvelope(rawPage, "malformed-session-page", `${label} response`);

		for (const rawSession of page.items) {
			const index = sessions.length;
			if (!isObjectRecord(rawSession)) {
				throw new SessionCollectionError(
					"malformed-session-record",
					`${label} item ${index} was not an object`,
				);
			}
			const id = rawSession["id"];
			if (typeof id !== "string" || id.length === 0) {
				throw new SessionCollectionError(
					"malformed-session-record",
					`${label} item ${index} did not contain a non-empty string id`,
				);
			}
			const boundProjectID = rawSession["projectID"];
			if (typeof boundProjectID !== "string" || boundProjectID !== projectID) {
				throw new SessionCollectionError(
					"session-project-mismatch",
					`${label} returned session ${JSON.stringify(id)} with ${
						typeof boundProjectID === "string" ? "a different projectID" : "no string projectID"
					}; refusing to include a session outside the requested project scope`,
				);
			}
			if (seenSessionIDs.has(id)) {
				throw new SessionCollectionError(
					"duplicate-session-id",
					`${label} returned session id ${JSON.stringify(id)} more than once; refusing to continue`,
				);
			}
			if (sessions.length >= policy.maxSessions) {
				throw new SessionCollectionError(
					"session-limit-exceeded",
					`${label} exceeded SessionCollectionPolicy.maxSessions=${policy.maxSessions}; refusing to retain a truncated session list`,
				);
			}
			seenSessionIDs.add(id);
			sessions.push(classifySession(rawSession, id, index, label));
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

	return sessions;
}

/**
 * Classifies one already-identified session. Root sessions need no timestamp;
 * child sessions require a finite numeric `time.updated` so ranking is total
 * and deterministic.
 */
function classifySession(
	info: { readonly [key: string]: unknown },
	id: string,
	index: number,
	label: string,
): EnumeratedSession {
	const parentID = info["parentID"];
	if (parentID === undefined || parentID === null) {
		return { info, id, isRoot: true };
	}
	if (typeof parentID !== "string") {
		throw new SessionCollectionError(
			"malformed-session-record",
			`${label} item ${index} has a parentID that is neither absent, null, nor a string`,
		);
	}
	const time = info["time"];
	if (!isObjectRecord(time)) {
		throw new SessionCollectionError(
			"malformed-session-record",
			`${label} item ${index} is a child session without a time object carrying a finite updated timestamp`,
		);
	}
	const updated = time["updated"];
	if (typeof updated !== "number" || !Number.isFinite(updated)) {
		throw new SessionCollectionError(
			"malformed-session-record",
			`${label} item ${index} is a child session whose time.updated is not a finite number`,
		);
	}
	return { info, id, isRoot: false, parentID, updated };
}

/** Most recently updated first; equal timestamps break by ascending id. */
function compareChildren(left: ChildSession, right: ChildSession): number {
	if (left.updated !== right.updated) return right.updated - left.updated;
	if (left.id === right.id) return 0;
	return left.id < right.id ? -1 : 1;
}

/** Selects the `limit` most recently updated children without mutating the input list. */
function selectLatestChildren(children: readonly ChildSession[], limit: number | null): readonly ChildSession[] {
	if (limit === null) return [...children].sort(compareChildren);
	if (limit === 0) return [];
	return [...children].sort(compareChildren).slice(0, limit);
}

/**
 * Finite root activity timestamp for the insights read: `time.updated` first,
 * then `time.created`, or null. The advisory insights never fail because one
 * root is undated; `"roots"` mode itself still fails closed via
 * `requireRootTimestamp`.
 */
function optionalRootTimestamp(session: EnumeratedSession): number | null {
	const time = session.info["time"];
	if (isObjectRecord(time)) {
		const updated = time["updated"];
		if (typeof updated === "number" && Number.isFinite(updated)) return updated;
		const created = time["created"];
		if (typeof created === "number" && Number.isFinite(created)) return created;
	}
	return null;
}

/**
 * Finite root activity timestamp: `time.updated` first, then `time.created`.
 * Roots without either fail closed in `"roots"` rather than being ordered by an
 * invented value.
 */
function requireRootTimestamp(session: EnumeratedSession): number {
	const time = session.info["time"];
	if (isObjectRecord(time)) {
		const updated = time["updated"];
		if (typeof updated === "number" && Number.isFinite(updated)) return updated;
		const created = time["created"];
		if (typeof created === "number" && Number.isFinite(created)) return created;
	}
	throw new SessionCollectionError(
		"malformed-session-record",
		`Retention root session ${JSON.stringify(session.id)} has no finite time.updated or time.created; refusing to rank root sessions without a timestamp`,
	);
}

/** Most recently active root first; equal timestamps break by ascending id. */
function compareRootsByRecency(
	left: EnumeratedSession,
	right: EnumeratedSession,
	timestamps: ReadonlyMap<string, number>,
): number {
	const leftAt = timestamps.get(left.id)!;
	const rightAt = timestamps.get(right.id)!;
	if (leftAt !== rightAt) return rightAt - leftAt;
	if (left.id === right.id) return 0;
	return left.id < right.id ? -1 : 1;
}

/**
 * Keeps every child whose parent chain reaches one of the kept roots. A chain
 * that leaves the project-scoped list (missing parent) is excluded; a parent
 * cycle is malformed and fails the whole retention pass. Original list order is
 * preserved by filtering the enumerated list.
 */
function selectDescendantChildren(
	sessions: readonly EnumeratedSession[],
	keptRootIDs: ReadonlySet<string>,
): readonly ChildSession[] {
	const byID = new Map<string, EnumeratedSession>();
	for (const session of sessions) byID.set(session.id, session);
	const kept: ChildSession[] = [];
	for (const session of sessions) {
		if (session.isRoot) continue;
		// `classifySession` guarantees a string parentID and finite updated on
		// every non-root record; the interface is not a discriminated union.
		const child = session as ChildSession;
		const chain = new Set<string>();
		let current: EnumeratedSession = child;
		for (;;) {
			if (chain.has(current.id)) {
				throw new SessionCollectionError(
					"malformed-session-record",
					`Retention child session ${JSON.stringify(child.id)} has a parentID cycle through ${JSON.stringify(current.id)}; refusing to resolve descendants`,
				);
			}
			chain.add(current.id);
			if (current.isRoot) {
				if (keptRootIDs.has(current.id)) kept.push(child);
				break;
			}
			const parentID = current.parentID;
			if (parentID === undefined) {
				throw new SessionCollectionError(
					"malformed-session-record",
					`Retention child session ${JSON.stringify(current.id)} lost its validated parentID; refusing to resolve descendants`,
				);
			}
			const parent = byID.get(parentID);
			if (parent === undefined) break;
			current = parent;
		}
	}
	return kept;
}

/**
 * "since-compaction" selection. Scans every root's messages for the latest
 * compaction timestamp and keeps children created strictly after it. With no
 * compaction it falls back to "latest". A positive cap ranks survivors by
 * `time.updated` descending with ascending `id` as the tie-break; zero keeps no
 * children. Every child's `time.created` is validated whenever a compaction
 * exists, even when the cap is zero.
 */
async function selectPostCompactionChildren(
	readPort: SessionDependencyReadPort,
	roots: readonly EnumeratedSession[],
	children: readonly ChildSession[],
	maxSubagentSessions: number | null,
	policy: SessionCollectionPolicy,
): Promise<readonly ChildSession[]> {
	const latestCompaction = await findLatestCompaction(readPort, roots, policy);
	if (latestCompaction === undefined) {
		return selectLatestChildren(children, maxSubagentSessions);
	}
	const createdByID = new Map<string, number>();
	for (const child of children) {
		createdByID.set(child.id, requireChildCreated(child));
	}
	if (maxSubagentSessions === 0) return [];
	const eligible = children.filter((child) => createdByID.get(child.id)! > latestCompaction);
	return selectLatestChildren(eligible, maxSubagentSessions);
}

/** Maximum finite compaction timestamp across every project root, scanned in list order. */
async function findLatestCompaction(
	readPort: SessionDependencyReadPort,
	roots: readonly EnumeratedSession[],
	policy: SessionCollectionPolicy,
): Promise<number | undefined> {
	let latest: number | undefined;
	for (const root of roots) {
		const candidate = await scanRootCompaction(readPort, root.id, policy);
		if (candidate !== undefined && (latest === undefined || candidate > latest)) {
			latest = candidate;
		}
	}
	return latest;
}

/**
 * Pages one root's messages to exhaustion with the collector's request shape
 * and failure rules, returning only its latest compaction timestamp. Message
 * content is never retained.
 */
async function scanRootCompaction(
	readPort: SessionDependencyReadPort,
	sessionID: string,
	policy: SessionCollectionPolicy,
): Promise<number | undefined> {
	const seenMessageIDs = new Set<string>();
	const usedCursors = new Set<string>();
	let messageCount = 0;
	let latest: number | undefined;
	let cursor: string | undefined;

	for (;;) {
		const pageRequest: MessageListPageRequest =
			cursor === undefined
				? { sessionID, limit: policy.messagePageSize, order: "asc" }
				: { sessionID, limit: policy.messagePageSize, cursor };
		const label = `Compaction scan for root session ${JSON.stringify(sessionID)}`;
		const rawPage = await callPort(
			() => readPort.listMessages(pageRequest),
			"message-list-failed",
			`${label} request failed`,
		);
		const page = parsePageEnvelope(rawPage, "malformed-message-page", `${label} response`);

		for (const rawMessage of page.items) {
			if (!isObjectRecord(rawMessage)) {
				throw new SessionCollectionError(
					"malformed-message-record",
					`${label} item ${messageCount} was not an object`,
				);
			}
			const id = rawMessage["id"];
			if (typeof id !== "string" || id.length === 0) {
				throw new SessionCollectionError(
					"malformed-message-record",
					`${label} item ${messageCount} did not contain a non-empty string id`,
				);
			}
			if (seenMessageIDs.has(id)) {
				throw new SessionCollectionError(
					"duplicate-message-id",
					`${label} returned message id ${JSON.stringify(id)} more than once; refusing to continue`,
				);
			}
			if (messageCount >= policy.maxMessagesPerSession) {
				throw new SessionCollectionError(
					"message-limit-exceeded",
					`${label} exceeded SessionCollectionPolicy.maxMessagesPerSession=${policy.maxMessagesPerSession}; refusing to scan a truncated message history`,
				);
			}
			seenMessageIDs.add(id);
			messageCount += 1;
			if (rawMessage["type"] === "compaction") {
				const timestamp = compactionTimestamp(rawMessage);
				if (timestamp !== undefined && (latest === undefined || timestamp > latest)) {
					latest = timestamp;
				}
			}
		}

		if (page.next === undefined) break;
		if (usedCursors.has(page.next)) {
			throw new SessionCollectionError(
				"repeated-message-cursor",
				`${label} returned a cursor that was already used: ${JSON.stringify(page.next)}; refusing to loop`,
			);
		}
		usedCursors.add(page.next);
		cursor = page.next;
	}

	return latest;
}

/** Finite `time.created` for a child; missing or malformed fails closed in "since-compaction". */
function requireChildCreated(session: EnumeratedSession): number {
	const time = session.info["time"];
	const created = isObjectRecord(time) ? time["created"] : undefined;
	if (typeof created !== "number" || !Number.isFinite(created)) {
		throw new SessionCollectionError(
			"malformed-session-record",
			`Retention child session ${JSON.stringify(session.id)} has no finite time.created; refusing to compare it with the latest compaction`,
		);
	}
	return created;
}

/** Latest finite compaction timestamp: completion time first, then creation time. */
function compactionTimestamp(message: { readonly [key: string]: unknown }): number | undefined {
	const time = message["time"];
	if (!isObjectRecord(time)) return undefined;
	const completed = time["completed"];
	if (typeof completed === "number" && Number.isFinite(completed)) return completed;
	const created = time["created"];
	if (typeof created === "number" && Number.isFinite(created)) return created;
	return undefined;
}

/* ------------------------------------------------------------------------- */
/* Shared page-envelope semantics (mirrors the core collector)               */
/* ------------------------------------------------------------------------- */

interface ParsedPage {
	readonly items: readonly unknown[];
	/** `cursor.next` when present and non-null; `undefined` means the page sequence is complete. */
	readonly next: string | undefined;
}

/**
 * Validates the untrusted `{ data, cursor }` envelope with the same semantics
 * the core collector and session-ID inventory use: a non-object response, a
 * missing `data` array, a non-object `cursor`, a non-string/blank `cursor.next`,
 * or an empty page carrying a next cursor all fail closed.
 */
function parsePageEnvelope(
	value: unknown,
	code: "malformed-session-page" | "malformed-message-page",
	label: string,
): ParsedPage {
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

/** Awaits one port call and converts non-collection failures into a coded error while preserving the cause. */
async function callPort(
	call: () => Promise<unknown>,
	code: SessionCollectionErrorCode,
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
