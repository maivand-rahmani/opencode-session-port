import { describe, expect, test } from "bun:test";
import type { CheckpointRetentionInsights } from "../../../src/tui/adapters/session-retention.ts";
import { createCheckpointRetentionUi } from "../../../src/tui/ui/checkpoint-retention-flow.ts";

interface SelectOption<Value> {
	readonly title: string;
	readonly value: Value;
	readonly description?: string;
}

class FakeDialog {
	selectResult: unknown;
	promptResult: string | undefined;
	selectCalls = 0;
	promptCalls = 0;
	readonly alerts: Array<{ readonly title: string; readonly message: string }> = [];
	promptOptions: {
		readonly title: string;
		readonly description: string;
		readonly placeholder: string;
	} | undefined;
	selectOptions: {
		readonly title: string;
		readonly options: readonly SelectOption<unknown>[];
	} | undefined;

	select<Value>(options: {
		readonly title: string;
		readonly options: readonly SelectOption<Value>[];
	}): Promise<Value | undefined> {
		this.selectCalls += 1;
		this.selectOptions = options as {
			readonly title: string;
			readonly options: readonly SelectOption<unknown>[];
		};
		return Promise.resolve(this.selectResult as Value | undefined);
	}

	prompt(options: {
		readonly title: string;
		readonly description: string;
		readonly placeholder: string;
	}): Promise<string | undefined> {
		this.promptCalls += 1;
		this.promptOptions = options;
		return Promise.resolve(this.promptResult);
	}

	alert(options: { readonly title: string; readonly message: string }): Promise<void> {
		this.alerts.push(options);
		return Promise.resolve();
	}
}

const WINDOW_START_AT = Date.UTC(2026, 9, 14);
const INSIGHTS: CheckpointRetentionInsights = {
	totalRootSessions: 5,
	totalChildSessions: 8,
	roots: [
		{ id: "root-1", lastActiveAt: Date.UTC(2026, 10, 12) },
		{ id: "root-2", lastActiveAt: Date.UTC(2026, 10, 10) },
		{ id: "root-3", lastActiveAt: Date.UTC(2026, 8, 1) },
		{ id: "root-4", lastActiveAt: Date.UTC(2026, 6, 1) },
		{ id: "root-5", lastActiveAt: Date.UTC(2026, 2, 1) },
	],
	activeRootCounts: { days7: 1, days30: 2, days90: 3 },
	newestRootAt: Date.UTC(2026, 10, 12),
	oldestRootAt: Date.UTC(2026, 2, 1),
	recommendation: {
		mode: "roots",
		maxRootSessions: 2,
		recentRootCount: 2,
		totalRootCount: 5,
		windowDays: 30,
		windowStartAt: WINDOW_START_AT,
	},
};

const COMPACTION_RECOMMENDATION_INSIGHTS: CheckpointRetentionInsights = {
	...INSIGHTS,
	recommendation: {
		...INSIGHTS.recommendation,
		mode: "since-compaction",
		maxRootSessions: null,
	},
};

function createHarness(selectResult: unknown, promptResult?: string) {
	const dialog = new FakeDialog();
	dialog.selectResult = selectResult;
	dialog.promptResult = promptResult;
	const context = { ui: { dialog }, theme: {} } as unknown as Parameters<
	typeof createCheckpointRetentionUi
	>[0];
	return { dialog, ui: createCheckpointRetentionUi(context) };
}

describe("checkpoint retention picker", () => {
	test("maps every selection to the retention policy", async () => {
		const cases = [
			{
				selection: "since-compaction",
				expected: {
					mode: "since-compaction",
					maxSubagentSessions: null,
					maxRootSessions: null,
				},
			},
			{
				selection: "all",
				expected: { mode: "all", maxSubagentSessions: null, maxRootSessions: null },
			},
			{
				selection: "roots-only",
				expected: { mode: "latest", maxSubagentSessions: 0, maxRootSessions: null },
			},
		] as const;

		for (const entry of cases) {
			const { dialog, ui } = createHarness(entry.selection);
			expect(await ui.choose(INSIGHTS)).toEqual(entry.expected);
			expect(dialog.selectCalls).toBe(1);
			expect(dialog.promptCalls).toBe(0);
		}

		const latest = createHarness("latest", "12");
		expect(await latest.ui.choose(INSIGHTS)).toEqual({
			mode: "latest",
			maxSubagentSessions: 12,
			maxRootSessions: null,
		});
		expect(latest.dialog.promptCalls).toBe(1);

		const roots = createHarness("roots", "4");
		expect(await roots.ui.choose(INSIGHTS)).toEqual({
			mode: "roots",
			maxSubagentSessions: null,
			maxRootSessions: 4,
		});
		expect(roots.dialog.promptCalls).toBe(1);
	});

	test("uses dynamic recommendations and explains the size and history trade-offs", async () => {
		const { dialog, ui } = createHarness("all");
		await ui.choose(INSIGHTS);

		expect(dialog.selectOptions?.title).toBe("Checkpoint size");
		expect(dialog.selectOptions?.options.map((option) => option.title)).toEqual([
			"After last compaction",
			"All sessions",
			"Last N root sessions… (recommended)",
			"Latest subagent sessions…",
			"Root sessions only",
		]);
		const [sinceCompaction, all, roots, latest, rootsOnly] =
			dialog.selectOptions!.options;
		expect(sinceCompaction.description).toContain("all 5 root sessions");
		expect(sinceCompaction.description).toContain("smaller than all sessions");
		expect(all.description).toContain("all 5 root and 8 subagent sessions");
		expect(all.description).toContain("largest artifact");
		expect(roots.description).toContain(
			"Keep the last 2 root sessions active since 2026-10-14 plus all of their subagents",
		);
		expect(latest.description).toContain("8 subagent sessions");
		expect(latest.description).toContain("most recently updated across all roots");
		expect(rootsOnly.description).toContain("all 5 root sessions without subagent history");
		expect(rootsOnly.description).toContain("smallest artifact");

		const compaction = createHarness("all");
		await compaction.ui.choose(COMPACTION_RECOMMENDATION_INSIGHTS);
		expect(compaction.dialog.selectOptions?.options.map((option) => option.title)).toEqual([
			"After last compaction (recommended)",
			"All sessions",
			"Last N root sessions…",
			"Latest subagent sessions…",
			"Root sessions only",
		]);
	});

	test("accepts whole-number latest and root counts in the 1–1000 range", async () => {
		for (const [response, expected] of [[" 1 ", 1], ["1000", 1000]] as const) {
			const { dialog, ui } = createHarness("latest", response);
			expect(await ui.choose(INSIGHTS)).toEqual({
				mode: "latest",
				maxSubagentSessions: expected,
				maxRootSessions: null,
			});
			expect(dialog.alerts).toEqual([]);
		}

		for (const [response, expected] of [[" 1 ", 1], ["1000", 1000]] as const) {
			const { dialog, ui } = createHarness("roots", response);
			expect(await ui.choose(INSIGHTS)).toEqual({
				mode: "roots",
				maxSubagentSessions: null,
				maxRootSessions: expected,
			});
			expect(dialog.alerts).toEqual([]);
		}
	});

	test("uses the recommended root count and date in the root prompt", async () => {
		const { dialog, ui } = createHarness("roots", "2");
		await ui.choose(INSIGHTS);

		expect(dialog.promptOptions).toEqual({
			title: "Root sessions to keep",
			description:
				"Choose 1–1000. Keeps that many most recently active root sessions and all of their subagent sessions. Recommended: 2 roots active since 2026-10-14.",
			placeholder: "2",
		});
	});

	test("keeps the existing subagent count prompt and validation behavior", async () => {
		const { dialog, ui } = createHarness("latest", "1.5");
		expect(await ui.choose(INSIGHTS)).toBeUndefined();
		expect(dialog.promptOptions).toEqual({
			title: "Subagent session count",
			description:
				"Choose 1–1000. Fewer sessions make a smaller artifact; more keep more history.",
			placeholder: "10",
		});
		expect(dialog.alerts).toEqual([
			{
				title: "Invalid session count",
				message: "Enter a whole number from 1 to 1000.",
			},
		]);
	});

	test("alerts once and cancels for invalid root counts", async () => {
		for (const response of ["0", "1.5", "abc"]) {
			const { dialog, ui } = createHarness("roots", response);
			expect(await ui.choose(INSIGHTS)).toBeUndefined();
			expect(dialog.promptCalls).toBe(1);
			expect(dialog.alerts).toEqual([
				{
					title: "Invalid root session count",
					message: "Enter a whole number from 1 to 1000.",
				},
			]);
		}
	});

	test("returns undefined when a prompt or first selector is canceled without alert", async () => {
		const canceledPrompt = createHarness("latest", undefined);
		expect(await canceledPrompt.ui.choose(INSIGHTS)).toBeUndefined();
		expect(canceledPrompt.dialog.alerts).toEqual([]);

		const canceledRootPrompt = createHarness("roots", undefined);
		expect(await canceledRootPrompt.ui.choose(INSIGHTS)).toBeUndefined();
		expect(canceledRootPrompt.dialog.alerts).toEqual([]);

		const canceledSelect = createHarness(undefined);
		expect(await canceledSelect.ui.choose(INSIGHTS)).toBeUndefined();
		expect(canceledSelect.dialog.promptCalls).toBe(0);
		expect(canceledSelect.dialog.alerts).toEqual([]);
	});
});
