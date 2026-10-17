import { describe, expect, test } from "bun:test";
import {
	selectRestoreProject,
	type RestoreProjectChoice,
	type RestoreProjectDialog,
} from "../../../src/tui/ui/restore-project-selector.ts";

describe("restore project selector", () => {
	test("returns the exact selected choice and preserves its ID-directory pair", async () => {
		const first: RestoreProjectChoice = {
			projectID: "proj-one",
			targetDirectory: "C:/work/one",
			label: "Work one",
		};
		const second: RestoreProjectChoice = {
			projectID: "proj-two",
			targetDirectory: "C:/work/two",
			label: "Work two",
		};
		let selectTitle: string | undefined;
		let selectPlaceholder: string | undefined;
		let optionValues: readonly RestoreProjectChoice[] = [];
		let optionTitles: readonly string[] = [];
		let optionDescriptions: readonly (string | undefined)[] = [];
		const dialog: RestoreProjectDialog = {
			async select(options) {
				selectTitle = options.title;
				selectPlaceholder = options.placeholder;
				optionValues = options.options.map((option) => option.value);
				optionTitles = options.options.map((option) => option.title);
				optionDescriptions = options.options.map((option) => option.description);
				return options.options[1]?.value;
			},
		};

		const selected = await selectRestoreProject(dialog, [first, second]);

		expect(selectTitle).toBe("Choose an existing project to restore into");
		expect(selectPlaceholder).toBe("Select a project");
		expect(optionValues).toHaveLength(2);
		expect(optionTitles).toEqual(["Work one", "Work two"]);
		expect(optionDescriptions).toEqual(["C:/work/one", "C:/work/two"]);
		expect(optionValues[0]).toBe(first);
		expect(optionValues[1]).toBe(second);
		expect(selected).toBe(second);
		expect(selected).toEqual({
			projectID: "proj-two",
			targetDirectory: "C:/work/two",
			label: "Work two",
		});
	});

	test("shows an actionable empty state when no resolved projects are available", async () => {
		let receivedOptions: Parameters<RestoreProjectDialog["select"]>[0] | undefined;
		const dialog: RestoreProjectDialog = {
			async select(options) {
				receivedOptions = options;
				return undefined;
			},
		};

		expect(await selectRestoreProject(dialog, [])).toBeUndefined();
		expect(receivedOptions).toMatchObject({
			title: "No projects available to restore into",
			placeholder: "Open or add a project, then retry /restore",
			options: [],
		});
	});

	test("falls back to the target directory when a choice has no display label", async () => {
		let optionTitle: string | undefined;
		const dialog: RestoreProjectDialog = {
			async select(options) {
				optionTitle = options.options[0]?.title;
				return undefined;
			},
		};

		await selectRestoreProject(dialog, [
			{ projectID: "proj-one", targetDirectory: "C:/work/one", label: "  " },
		]);

		expect(optionTitle).toBe("C:/work/one");
	});

	test("returns undefined when the host dialog is cancelled", async () => {
		const choice: RestoreProjectChoice = {
			projectID: "proj-one",
			targetDirectory: "C:/work/one",
			label: "Work one",
		};
		const dialog: RestoreProjectDialog = {
			async select() {
				return undefined;
			},
		};

		expect(await selectRestoreProject(dialog, [choice])).toBeUndefined();
	});

	test("fails closed before opening the dialog when a project ID has conflicting targets", () => {
		let selectCalls = 0;
		const dialog: RestoreProjectDialog = {
			async select() {
				selectCalls += 1;
				return undefined;
			},
		};
		const choices: RestoreProjectChoice[] = [
			{ projectID: "proj-one", targetDirectory: "C:/work/one", label: "Work one" },
			{ projectID: "proj-one", targetDirectory: "C:/work/other", label: "Work one, other path" },
		];

		expect(() => selectRestoreProject(dialog, choices)).toThrow("ambiguous");
		expect(selectCalls).toBe(0);
	});
});
