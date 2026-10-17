import type { Plugin } from "@opencode/plugin/tui";

export interface RestoreProjectChoice {
	readonly projectID: string;
	/** Canonical host-project directory; this is also the explicit import target. */
	readonly targetDirectory: string;
	readonly label: string;
}

export type RestoreProjectDialog = Pick<Plugin.Context["ui"]["dialog"], "select">;

function assertResolvedChoices(choices: readonly RestoreProjectChoice[]): void {
	const directoryByProjectID = new Map<string, string>();
	const projectIDByDirectory = new Map<string, string>();

	for (const choice of choices) {
		if (!choice.projectID.trim() || !choice.targetDirectory.trim()) {
			throw new TypeError(
				"Restore choices require both a project ID and canonical target directory.",
			);
		}

		const knownDirectory = directoryByProjectID.get(choice.projectID);
		if (knownDirectory !== undefined && knownDirectory !== choice.targetDirectory) {
			throw new Error("Restore choices contain an ambiguous project ID and target directory pair.");
		}

		const knownProjectID = projectIDByDirectory.get(choice.targetDirectory);
		if (knownProjectID !== undefined && knownProjectID !== choice.projectID) {
			throw new Error("Restore choices contain an ambiguous project ID and target directory pair.");
		}

		directoryByProjectID.set(choice.projectID, choice.targetDirectory);
		projectIDByDirectory.set(choice.targetDirectory, choice.projectID);
	}
}

/**
 * Present already-resolved host projects for selection. This helper does not
 * enumerate projects or derive a directory; callers must provide each
 * project's canonical target directory alongside its project ID. Empty input
 * stays in the host selector so the user sees an actionable empty state; the
 * host's undefined result continues to mean that selection was cancelled.
 */
export function selectRestoreProject(
	dialog: RestoreProjectDialog,
	choices: readonly RestoreProjectChoice[],
): Promise<RestoreProjectChoice | undefined> {
	assertResolvedChoices(choices);
	const empty = choices.length === 0;
	return dialog.select<RestoreProjectChoice>({
		title: empty
			? "No projects available to restore into"
			: "Choose an existing project to restore into",
		placeholder: empty ? "Open or add a project, then retry /restore" : "Select a project",
		options: choices.map((choice) => ({
			title: choice.label.trim() || choice.targetDirectory,
			description: choice.targetDirectory,
			value: choice,
		})),
	});
}
