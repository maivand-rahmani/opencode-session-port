import { describe, expect, test } from "bun:test";
import { createRestoreImportModeUi } from "../../../src/tui/ui/restore-import-mode-flow.ts";

interface SelectOption<Value> {
	readonly title: string;
	readonly value: Value;
	readonly description?: string;
}

class FakeDialog {
	selectResult: unknown;
	selectOptions: {
		readonly title: string;
		readonly options: readonly SelectOption<unknown>[];
	} | undefined;

	select<Value>(options: {
		readonly title: string;
		readonly options: readonly SelectOption<Value>[];
	}): Promise<Value | undefined> {
		this.selectOptions = options as {
			readonly title: string;
			readonly options: readonly SelectOption<unknown>[];
		};
		return Promise.resolve(this.selectResult as Value | undefined);
	}
}

function createHarness(selectResult: unknown) {
	const dialog = new FakeDialog();
	dialog.selectResult = selectResult;
	const context = { ui: { dialog }, theme: {} } as unknown as Parameters<
	typeof createRestoreImportModeUi
	>[0];
	return { dialog, ui: createRestoreImportModeUi(context) };
}

describe("restore import mode picker", () => {
	test("returns keep and replace selections from the native picker", async () => {
		for (const mode of ["keep", "replace"] as const) {
			const { ui } = createHarness(mode);
			expect(await ui.choose()).toBe(mode);
		}
	});

	test("explains the safe keep and verified replace options", async () => {
		const { dialog, ui } = createHarness("keep");
		await ui.choose();

		expect(dialog.selectOptions?.title).toBe("Restore existing sessions?");
		expect(dialog.selectOptions?.options).toEqual([
			{
				title: "Keep existing sessions (recommended)",
				value: "keep",
				description:
					"Import alongside existing sessions. Nothing is deleted; collisions are copied with new IDs.",
			},
			{
				title: "Replace verified sessions",
				value: "replace",
				description:
					"Delete only sessions the safety checks prove unchanged, then import. A recovery artifact is created first.",
			},
		]);
	});

	test("returns undefined when the selector is canceled", async () => {
		const { ui } = createHarness(undefined);
		expect(await ui.choose()).toBeUndefined();
	});
});
