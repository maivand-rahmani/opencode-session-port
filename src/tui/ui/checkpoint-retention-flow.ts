import type { Plugin } from "@opencode/plugin/tui";
import type { CheckpointRetentionInsights } from "../adapters/session-retention.ts";

export interface CheckpointRetentionChoice {
	readonly mode: "since-compaction" | "latest" | "all" | "roots";
	readonly maxSubagentSessions: number | null;
	readonly maxRootSessions: number | null;
}

export interface CheckpointRetentionUiPort {
	choose(insights: CheckpointRetentionInsights): Promise<CheckpointRetentionChoice | undefined>;
}

type RetentionSelection = "since-compaction" | "all" | "roots" | "latest" | "roots-only";
type CheckpointRetentionContext = Pick<Plugin.Context, "ui" | "theme">;

const COUNT_TITLE = "Subagent session count";
const COUNT_DESCRIPTION =
	"Choose 1–1000. Fewer sessions make a smaller artifact; more keep more history.";
const INVALID_COUNT_TITLE = "Invalid session count";
const INVALID_COUNT_MESSAGE = "Enter a whole number from 1 to 1000.";
const ROOT_COUNT_TITLE = "Root sessions to keep";
const ROOT_COUNT_DESCRIPTION =
	"Choose 1–1000. Keeps that many most recently active root sessions and all of their subagent sessions.";
const INVALID_ROOT_COUNT_TITLE = "Invalid root session count";

function parseSessionCount(value: string): number | undefined {
	const trimmed = value.trim();
	if (!/^\d+$/u.test(trimmed)) return undefined;

	const count = Number(trimmed);
	return Number.isSafeInteger(count) && count >= 1 && count <= 1000
		? count
		: undefined;
}

/** Use OpenCode's built-in selector and prompt for native TUI styling. */
export function createCheckpointRetentionUi(
	context: CheckpointRetentionContext,
): CheckpointRetentionUiPort {
	return {
		async choose(insights) {
			const recommendedRootCount =
				insights.recommendation.mode === "roots"
					? insights.recommendation.maxRootSessions
					: null;
			const recommendationDate = new Date(
				insights.recommendation.windowStartAt,
				).toISOString().slice(0, 10);
			const selection = await context.ui.dialog.select<RetentionSelection>({
				title: "Checkpoint size",
				options: [
					{
						title: `After last compaction${insights.recommendation.mode === "since-compaction" ? " (recommended)" : ""}`,
						value: "since-compaction",
						description: `Keep all ${insights.totalRootSessions} root sessions plus subagents created after the most recent compaction; smaller than all sessions.`,
					},
					{
						title: "All sessions",
						value: "all",
						description: `Keep all ${insights.totalRootSessions} root and ${insights.totalChildSessions} subagent sessions; largest artifact.`,
					},
					{
						title: `Last N root sessions…${insights.recommendation.mode === "roots" ? " (recommended)" : ""}`,
						value: "roots",
						description:
							recommendedRootCount === null
								? "Choose how many of the most recently active root sessions to keep, along with all of their subagents; older roots and their subagents are omitted."
								: `Keep the last ${recommendedRootCount} root sessions active since ${recommendationDate} plus all of their subagents; older roots and their subagents are omitted.`,
					},
					{
						title: "Latest subagent sessions…",
						value: "latest",
						description: `Choose how many of the ${insights.totalChildSessions} subagent sessions to keep, most recently updated across all roots.`,
					},
					{
						title: "Root sessions only",
						value: "roots-only",
						description: `Keep all ${insights.totalRootSessions} root sessions without subagent history; smallest artifact.`,
					},
				],
			});

			switch (selection) {
				case "since-compaction":
					return { mode: "since-compaction", maxSubagentSessions: null, maxRootSessions: null };
				case "all":
					return { mode: "all", maxSubagentSessions: null, maxRootSessions: null };
				case "roots": {
					const recommendedCount = recommendedRootCount ?? 3;
					const rootCountDescription =
						recommendedRootCount === null
							? ROOT_COUNT_DESCRIPTION
							: `${ROOT_COUNT_DESCRIPTION} Recommended: ${recommendedRootCount} roots active since ${recommendationDate}.`;
					const response = await context.ui.dialog.prompt({
						title: ROOT_COUNT_TITLE,
						description: rootCountDescription,
						placeholder: String(recommendedCount),
					});
					if (response === undefined) return undefined;

					const count = parseSessionCount(response);
					if (count === undefined) {
						await context.ui.dialog.alert({
							title: INVALID_ROOT_COUNT_TITLE,
							message: INVALID_COUNT_MESSAGE,
						});
						return undefined;
					}

					return { mode: "roots", maxSubagentSessions: null, maxRootSessions: count };
				}
				case "roots-only":
					return { mode: "latest", maxSubagentSessions: 0, maxRootSessions: null };
				case "latest": {
					const response = await context.ui.dialog.prompt({
						title: COUNT_TITLE,
						description: COUNT_DESCRIPTION,
						placeholder: "10",
					});
					if (response === undefined) return undefined;

					const count = parseSessionCount(response);
					if (count === undefined) {
						await context.ui.dialog.alert({
							title: INVALID_COUNT_TITLE,
							message: INVALID_COUNT_MESSAGE,
						});
						return undefined;
					}

					return { mode: "latest", maxSubagentSessions: count, maxRootSessions: null };
				}
				case undefined:
					return undefined;
			}
		},
	};
}
