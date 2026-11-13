import type { Plugin } from "@opencode/plugin/tui";

export type RestoreImportMode = "replace" | "keep";

export interface RestoreImportModeUiPort {
	choose(): Promise<RestoreImportMode | undefined>;
}

type RestoreImportModeContext = Pick<Plugin.Context, "ui" | "theme">;

/** Use OpenCode's built-in selector so restore choices match native dialogs. */
export function createRestoreImportModeUi(
	context: RestoreImportModeContext,
): RestoreImportModeUiPort {
	return {
		choose() {
			return context.ui.dialog.select<RestoreImportMode>({
				title: "Restore existing sessions?",
				options: [
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
				],
			});
		},
	};
}
