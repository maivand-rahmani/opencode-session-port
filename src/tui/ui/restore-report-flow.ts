/**
 * A small, host-independent cursor for browsing restore outcomes. The report
 * surface shows one session at a time so IDs and reason text are never
 * shortened to fit a notification or a crowded list.
 */

export type RestoreReportClassification = "skipped" | "imported" | "renamed";

export type RestoreReportStatus =
	| "imported"
	| "skipped"
	| "failed"
	| "blocked"
	| "not-attempted";

/** Presentation-safe per-session facts. Never put a host exception here. */
export interface RestoreReportSession {
	readonly sessionID: string;
	readonly classification: RestoreReportClassification;
	readonly status: RestoreReportStatus;
	/** A sanitized planner skip reason, shown verbatim when present. */
	readonly skipReason?: string;
}

export interface RestoreReportSummary {
	readonly total: number;
	readonly imported: number;
	readonly skipped: number;
	readonly failed: number;
	readonly blocked: number;
	readonly notAttempted: number;
}

/**
 * Stable, already-sanitized input for the restore report dialog. It contains
 * only aggregate counts and display-safe per-session fields; no exception
 * object or host error text is accepted or rendered.
 */
export interface RestoreReportPresentationModel {
	readonly summary: RestoreReportSummary;
	readonly sessions: readonly RestoreReportSession[];
}

export interface RestoreReportNavigationSnapshot {
	/** Zero-based position; remains 0 for an empty report. */
	readonly index: number;
	readonly count: number;
	readonly pageCount: number;
	readonly session: RestoreReportSession | undefined;
	readonly canPrevious: boolean;
	readonly canNext: boolean;
}

/** Pure cursor state used by the TUI and by state-only tests. */
export class RestoreReportNavigator {
	readonly #sessions: readonly RestoreReportSession[];
	#index = 0;

	constructor(sessions: readonly RestoreReportSession[]) {
		this.#sessions = sessions;
	}

	snapshot(): RestoreReportNavigationSnapshot {
		const count = this.#sessions.length;
		return Object.freeze({
			index: this.#index,
			count,
			pageCount: count,
			session: this.#sessions[this.#index],
			canPrevious: this.#index > 0,
			canNext: this.#index + 1 < count,
		});
	}

	previous(): RestoreReportNavigationSnapshot {
		if (this.#index > 0) this.#index -= 1;
		return this.snapshot();
	}

	next(): RestoreReportNavigationSnapshot {
		if (this.#index + 1 < this.#sessions.length) this.#index += 1;
		return this.snapshot();
	}

	first(): RestoreReportNavigationSnapshot {
		this.#index = 0;
		return this.snapshot();
	}

	last(): RestoreReportNavigationSnapshot {
		this.#index = Math.max(0, this.#sessions.length - 1);
		return this.snapshot();
	}
}
