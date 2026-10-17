/**
 * Injected sequential restore execution (Phase 4, bounded orchestration).
 *
 * `runRestoreExecution` consumes one completed `RestorePlan` (from
 * `planRestore`) plus an injected `SessionImportAdapter` and executes exactly
 * `plan.importOrder` — the planner's deterministic parent-before-child order —
 * one import at a time. This module performs no host call itself: the injected
 * adapter owns the single public `session.import` invocation per planned entry
 * and its explicit target (O-16).
 *
 * Owner handling policy (O-06, 2026-10-10; the final error taxonomy/report
 * format stays OPEN as O-15):
 * - No automatic retries: at most one `importSession` call per planned entry,
 *   ever.
 * - An individual import failure is caught and recorded as `failed`; unrelated
 *   branches continue with the remaining `importOrder` entries.
 * - Descendants by `info.parentID` of a parent that failed, was blocked, or was
 *   not attempted are marked `blocked` and are never imported; blocking
 *   propagates down the parent chain.
 * - Exact skips from `plan.entries` initialize as `skipped` outcomes with their
 *   planner `skipReason` preserved; they are treated as already present, are
 *   never imported, and never block their descendants.
 * - A `parentID` that resolves outside the plan is assumed to be an already
 *   validated destination/local session (the planner only preserves such
 *   references when the destination snapshot contains them) and never blocks.
 * - `shouldContinue` is a minimal injected stop check (default: always
 *   continue; no host cancellation is wired). Once it reports `false` — or
 *   misbehaves by returning a nonboolean value or throwing — no further import
 *   is attempted: remaining independent planned entries are `not-attempted`,
 *   while descendants of an unattempted parent are `blocked` because that
 *   parent is absent. Stop-check misbehavior only latches the injected stop
 *   seam; the raw return value/error is never exposed, stringified, or logged,
 *   and importer failure handling is unchanged (a failed import is still
 *   recorded as `failed` and independent branches continue).
 * - Every `plan.entries` entry receives exactly one outcome; a manual rerun
 *   stays user-controlled (deterministic O-05 IDs let it reuse the same
 *   targets), and no atomic rollback is attempted or promised (A-06).
 *
 * Secrecy and leak boundary: outcomes carry IDs, classifications, and statuses
 * only. Host exceptions are caught and never rethrown, wrapped, stringified, or
 * logged, so no session record content, message text, password material, or raw
 * host error crosses this boundary; this module performs no console output.
 * Error taxonomy and report formatting remain OPEN (O-15): these are raw
 * per-session facts, not a user-facing report.
 *
 * Fail-closed input validation: the plan shape, the adapter surface, the
 * explicit target directory, and the callable `shouldContinue` shape are
 * validated before any import is attempted; a malformed plan (for example an
 * `importOrder` that omits or repeats a planned entry, contains a skipped
 * entry, is not parent-first, or an `exact-local-duplicate` skip whose
 * `targetSessionID` differs from its `sourceSessionID`) throws a `TypeError`
 * without calling the adapter. Only exact-local-duplicate skips must keep
 * target equal to source (the planner never remaps a local duplicate);
 * `exact-planned-retry` skips may legitimately be remapped, so no equality is
 * imposed on them.
 *
 * Evidence boundary: exercised only with synthetic plans and fake importers in
 * tests. No real host call, import, filesystem, crypto, or UI effect is
 * performed by this lane, and no runtime, compatibility, or security claim
 * follows; the adapter's Experimental-route and O-12/O-16 boundaries are
 * unchanged.
 */

import type { SessionRecord } from "../../core/contracts/index.ts";
import type {
	RestoreClassification,
	RestorePlan,
	RestorePlanEntry,
	RestoreSkipReason,
} from "../../core/restore/index.ts";
import type { SessionImportAdapter } from "../adapters/index.ts";
import { isRecordValue, requireCallable, requireNonEmptyString } from "./shared.ts";

/* ------------------------------------------------------------------------- */
/* Public result shape                                                       */
/* ------------------------------------------------------------------------- */

/** Truthful per-session execution status for one restore run (O-06). */
export type RestoreSessionExecutionStatus = "imported" | "skipped" | "failed" | "blocked" | "not-attempted";

/** One artifact session's outcome: planner classification plus execution status. */
export interface RestoreSessionOutcome {
	/** Original artifact session ID; unique within the plan. */
	readonly sourceSessionID: string;
	/** Planned target session ID for this run (deterministic O-05 remap). */
	readonly targetSessionID: string;
	/** Planner classification preserved from `plan.entries` ("skipped" for exact skips). */
	readonly classification: RestoreClassification;
	/** Truthful execution status for this run. */
	readonly status: RestoreSessionExecutionStatus;
	/** Present exactly when `classification` is "skipped"; preserved from the plan. */
	readonly skipReason?: RestoreSkipReason;
}

/** Raw per-session counts; no O-15 report format is implied. */
export interface RestoreExecutionSummary {
	readonly total: number;
	readonly imported: number;
	readonly skipped: number;
	readonly failed: number;
	readonly blocked: number;
	readonly notAttempted: number;
}

/** Complete outcome accounting for one execution run. */
export interface RestoreExecutionResult {
	/** One outcome per `plan.entries` entry, in the same order. */
	readonly outcomes: readonly RestoreSessionOutcome[];
	readonly summary: RestoreExecutionSummary;
}

/** Explicit, fully injected execution dependencies. */
export interface RestoreExecutionInput {
	/** Completed `planRestore` output; consumed as-is (order, classifications, skip reasons). */
	readonly plan: RestorePlan;
	/** Single-session import surface; one call per planned entry, no retries. */
	readonly importer: SessionImportAdapter;
	/** Explicit import target directory supplied on every call (O-16); never inferred. */
	readonly targetDirectory: string;
	/**
	 * Minimal stop check; defaults to always-continue. No host cancellation is
	 * wired. A thrown error or nonboolean return is treated as a stop for the
	 * remaining entries (never rethrown, wrapped, stringified, or logged);
	 * importer failure handling is unaffected.
	 */
	readonly shouldContinue?: () => boolean;
}

/* ------------------------------------------------------------------------- */
/* Internal helpers                                                          */
/* ------------------------------------------------------------------------- */

interface MutableOutcome {
	readonly sourceSessionID: string;
	readonly targetSessionID: string;
	readonly classification: RestoreClassification;
	readonly skipReason?: RestoreSkipReason;
	status: RestoreSessionExecutionStatus;
}

const CLASSIFICATIONS: ReadonlySet<string> = new Set(["skipped", "imported", "renamed"]);
const SKIP_REASONS: ReadonlySet<string> = new Set(["exact-local-duplicate", "exact-planned-retry"]);

function summarize(outcomes: readonly RestoreSessionOutcome[]): RestoreExecutionSummary {
	const counts: Record<RestoreSessionExecutionStatus, number> = {
		imported: 0,
		skipped: 0,
		failed: 0,
		blocked: 0,
		"not-attempted": 0,
	};
	for (const outcome of outcomes) counts[outcome.status] += 1;
	return {
		total: outcomes.length,
		imported: counts.imported,
		skipped: counts.skipped,
		failed: counts.failed,
		blocked: counts.blocked,
		notAttempted: counts["not-attempted"],
	};
}

/* ------------------------------------------------------------------------- */
/* runRestoreExecution                                                       */
/* ------------------------------------------------------------------------- */

/**
 * Executes one completed restore plan sequentially in `plan.importOrder` order
 * and returns truthful per-session outcomes. See the module comment for the
 * exact handling policy, blocking rules, and validation boundary.
 */
export async function runRestoreExecution(input: RestoreExecutionInput): Promise<RestoreExecutionResult> {
	if (!isRecordValue(input)) {
		throw new TypeError("runRestoreExecution requires an input object with plan, importer, and targetDirectory");
	}
	if (!isRecordValue(input.importer) || typeof input.importer.importSession !== "function") {
		throw new TypeError("runRestoreExecution requires an importer with an importSession(request) function");
	}
	const targetDirectory = requireNonEmptyString(input.targetDirectory, "targetDirectory");
	if (input.shouldContinue !== undefined) {
		requireCallable(input.shouldContinue, "shouldContinue");
	}
	const shouldContinue: () => boolean = input.shouldContinue ?? (() => true);

	/* -- 1. Fail-closed plan-shape validation before any import. -- */
	const rawPlan: unknown = input.plan;
	if (!isRecordValue(rawPlan)) {
		throw new TypeError("runRestoreExecution requires a completed RestorePlan object");
	}
	const rawEntries = rawPlan["entries"];
	const rawImportOrder = rawPlan["importOrder"];
	if (!Array.isArray(rawEntries) || !Array.isArray(rawImportOrder)) {
		throw new TypeError("runRestoreExecution requires a completed RestorePlan with entries and importOrder arrays");
	}

	const entries: RestorePlanEntry[] = [];
	const entryBySourceID = new Map<string, RestorePlanEntry>();
	const outcomeBySourceID = new Map<string, MutableOutcome>();
	const outcomeByTargetID = new Map<string, MutableOutcome>();

	for (let index = 0; index < rawEntries.length; index++) {
		const raw: unknown = rawEntries[index];
		if (!isRecordValue(raw)) throw new TypeError(`plan.entries[${index}] must be a restore plan entry object`);
		const sourceSessionID = requireNonEmptyString(raw["sourceSessionID"], `plan.entries[${index}].sourceSessionID`);
		const targetSessionID = requireNonEmptyString(raw["targetSessionID"], `plan.entries[${index}].targetSessionID`);
		const classification = raw["classification"];
		if (typeof classification !== "string" || !CLASSIFICATIONS.has(classification)) {
			throw new TypeError(`plan.entries[${index}].classification must be "skipped", "imported", or "renamed"`);
		}
		const rawSkipReason = raw["skipReason"];
		let skipReason: RestoreSkipReason | undefined;
		if (classification === "skipped") {
			if (typeof rawSkipReason !== "string" || !SKIP_REASONS.has(rawSkipReason)) {
				throw new TypeError(`plan.entries[${index}] is skipped and must preserve an exact planner skipReason`);
			}
			skipReason = rawSkipReason as RestoreSkipReason;
		} else if (rawSkipReason !== undefined) {
			throw new TypeError(`plan.entries[${index}] carries a skipReason but is not skipped`);
		}
		if (classification === "skipped" && skipReason === "exact-local-duplicate" && sourceSessionID !== targetSessionID) {
			// A genuine exact-local-duplicate skip is an unchanged local session:
			// the planner never remaps its target. A remapped target would let
			// execution treat an absent session as already present, so fail closed
			// before any import. Exact-planned-retry skips are deliberately exempt
			// (a renamed retry may target a derived ID).
			throw new TypeError(
				`plan.entries[${index}] is an exact-local-duplicate skip whose targetSessionID differs from its sourceSessionID; a local duplicate must target the same session`,
			);
		}
		const rawRecord = raw["record"];
		if (!isRecordValue(rawRecord)) {
			throw new TypeError(`plan.entries[${index}].record must be an object with info and messages`);
		}
		const rawInfo = rawRecord["info"];
		const rawMessages = rawRecord["messages"];
		if (!isRecordValue(rawInfo) || !Array.isArray(rawMessages)) {
			throw new TypeError(`plan.entries[${index}].record must be an object with info and messages`);
		}
		const recordID = rawInfo["id"];
		if (typeof recordID !== "string" || recordID !== targetSessionID) {
			throw new TypeError(`plan.entries[${index}].record.info.id must equal the planned targetSessionID`);
		}
		const parentID = rawInfo["parentID"];
		if (parentID !== undefined && typeof parentID !== "string") {
			throw new TypeError(`plan.entries[${index}].record.info.parentID must be a string when present`);
		}
		if (entryBySourceID.has(sourceSessionID)) {
			throw new TypeError(`plan.entries repeats sourceSessionID ${JSON.stringify(sourceSessionID)}`);
		}
		if (outcomeByTargetID.has(targetSessionID)) {
			throw new TypeError(`plan.entries repeats targetSessionID ${JSON.stringify(targetSessionID)}`);
		}

		const entry: RestorePlanEntry = {
			sourceSessionID,
			targetSessionID,
			classification: classification as RestoreClassification,
			record: rawRecord as unknown as SessionRecord,
			...(skipReason !== undefined ? { skipReason } : {}),
		};
		const outcome: MutableOutcome = {
			sourceSessionID,
			targetSessionID,
			classification: entry.classification,
			...(skipReason !== undefined ? { skipReason } : {}),
			status: classification === "skipped" ? "skipped" : "not-attempted",
		};
		entries.push(entry);
		entryBySourceID.set(sourceSessionID, entry);
		outcomeBySourceID.set(sourceSessionID, outcome);
		outcomeByTargetID.set(targetSessionID, outcome);
	}

	const order: RestorePlanEntry[] = [];
	const orderIndexByTargetID = new Map<string, number>();
	const orderSeen = new Set<string>();
	for (let index = 0; index < rawImportOrder.length; index++) {
		const raw: unknown = rawImportOrder[index];
		if (!isRecordValue(raw)) throw new TypeError(`plan.importOrder[${index}] must be a restore plan entry object`);
		const sourceSessionID = requireNonEmptyString(raw["sourceSessionID"], `plan.importOrder[${index}].sourceSessionID`);
		const entry = entryBySourceID.get(sourceSessionID);
		if (entry === undefined) {
			throw new TypeError(
				`plan.importOrder[${index}] references sourceSessionID ${JSON.stringify(sourceSessionID)} that is not in plan.entries`,
			);
		}
		if (raw["targetSessionID"] !== entry.targetSessionID || raw["classification"] !== entry.classification) {
			throw new TypeError(`plan.importOrder[${index}] does not match the corresponding plan.entries entry`);
		}
		if (entry.classification === "skipped") {
			throw new TypeError(
				`plan.importOrder[${index}] contains skipped session ${JSON.stringify(sourceSessionID)}; exact skips are never imported`,
			);
		}
		if (orderSeen.has(sourceSessionID)) {
			throw new TypeError(`plan.importOrder repeats sourceSessionID ${JSON.stringify(sourceSessionID)}; a retry is never performed`);
		}
		orderSeen.add(sourceSessionID);
		orderIndexByTargetID.set(entry.targetSessionID, index);
		order.push(entry);
	}
	for (const entry of entries) {
		if (entry.classification === "skipped") continue;
		if (!orderSeen.has(entry.sourceSessionID)) {
			throw new TypeError(
				`plan.importOrder omits planned session ${JSON.stringify(entry.sourceSessionID)}; every planned entry must be accounted for`,
			);
		}
	}
	for (let index = 0; index < order.length; index++) {
		const entry = order[index]!;
		const parentID = entry.record.info["parentID"];
		if (typeof parentID !== "string") continue;
		const parentIndex = orderIndexByTargetID.get(parentID);
		if (parentIndex !== undefined && parentIndex >= index) {
			throw new TypeError(
				`plan.importOrder is not parent-first: ${JSON.stringify(entry.sourceSessionID)} appears before its planned parent ${JSON.stringify(parentID)}`,
			);
		}
	}

	/* -- 2. Sequential execution in planner order. -- */
	let stopLatched = false;
	for (const entry of order) {
		const outcome = outcomeBySourceID.get(entry.sourceSessionID)!;
		const parentID = entry.record.info["parentID"];
		if (typeof parentID === "string") {
			const parent = outcomeByTargetID.get(parentID);
			if (parent !== undefined && parent.status !== "imported" && parent.status !== "skipped") {
				// The planned parent is absent: it failed, was blocked, or was
				// never attempted, so this descendant is not imported.
				outcome.status = "blocked";
				continue;
			}
		}
		if (!stopLatched) {
			let decision: unknown;
			try {
				decision = shouldContinue();
			} catch {
				// Misbehaving injected stop seam: treat it as a stop. The raw
				// callback error never crosses this boundary (no rethrow, wrap,
				// stringify, or log), and importer failure handling is unchanged.
				decision = false;
			}
			// Only an explicit boolean `true` continues; `false` and any
			// nonboolean value latch the stop for the remaining entries.
			if (decision !== true) stopLatched = true;
		}
		if (stopLatched) {
			// Remaining independent planned entries are not attempted; their
			// descendants are blocked on the next iterations because this
			// parent stays absent.
			outcome.status = "not-attempted";
			continue;
		}
		try {
			await input.importer.importSession({ record: entry.record, target: { directory: targetDirectory } });
			outcome.status = "imported";
		} catch {
			// No retry, no wrapping, no logging: the failure is recorded as a
			// truthful `failed` status and its raw error never crosses this
			// boundary (O-15 taxonomy/report format stays OPEN).
			outcome.status = "failed";
		}
	}

	/* -- 3. Complete outcome accounting in plan.entries order. -- */
	const outcomes: RestoreSessionOutcome[] = entries.map((entry) => {
		const outcome = outcomeBySourceID.get(entry.sourceSessionID)!;
		return {
			sourceSessionID: outcome.sourceSessionID,
			targetSessionID: outcome.targetSessionID,
			classification: outcome.classification,
			status: outcome.status,
			...(outcome.skipReason !== undefined ? { skipReason: outcome.skipReason } : {}),
		};
	});

	return { outcomes, summary: summarize(outcomes) };
}
