import type { Plugin } from "@opencode/plugin/tui";

export const SESSIONPORT_COMMAND_IDS = {
	checkpoint: "sessionport.checkpoint",
	restore: "sessionport.restore",
	sync: "sessionport.sync",
} as const;

export interface SessionPortCommandHandlers {
	readonly checkpoint: (rawInput: string | undefined) => Promise<void>;
	readonly restore: (rawInput: string | undefined) => Promise<void>;
	/** Optional in the base seam so existing checkpoint/restore composition stays compatible. */
	readonly sync?: (rawInput: string | undefined) => Promise<void>;
}

/** The host APIs this registration seam uses. */
export interface SessionPortCommandHost {
	readonly ui: Pick<Plugin.Context["ui"], "slot">;
	readonly keymap: Pick<Plugin.Context["keymap"], "layer">;
}

/**
 * Register native slash commands from an app-slot component scope. The layer
 * opts out of the default `base` input mode with `mode: "global"` so the
 * commands are reachable from every OpenCode input mode (palette and slash
 * discovery included); without it the host hides them outside `base`. The slot
 * disposer is returned unchanged so the plugin can clean up its contribution.
 * Command input is forwarded as received; parsing belongs to the injected
 * handlers.
 */
export function installSessionPortCommands(
	context: SessionPortCommandHost,
	handlers: SessionPortCommandHandlers,
): () => void {
	return context.ui.slot({
		append: "app",
		render() {
			context.keymap.layer(() => ({
				mode: "global",
				commands: [
					{
						id: SESSIONPORT_COMMAND_IDS.checkpoint,
						title: "Checkpoint project sessions",
						description:
							"Create a password-encrypted checkpoint of the current project's sessions.",
						group: "SessionPort",
						bind: false,
						palette: true,
						slash: { name: "checkpoint", arguments: true },
						run: async (rawInput) => {
							await handlers.checkpoint(rawInput);
						},
					},
					{
						id: SESSIONPORT_COMMAND_IDS.restore,
						title: "Restore project sessions",
						description:
							"Choose an existing project and restore a checkpoint without overwriting its local sessions.",
						group: "SessionPort",
						bind: false,
						palette: true,
						slash: { name: "restore", arguments: true },
						run: async (rawInput) => {
							await handlers.restore(rawInput);
						},
					},
					{
						id: SESSIONPORT_COMMAND_IDS.sync,
						title: "Cloud sign-in",
						description:
							"Sign in to SessionPort cloud on this device.",
						group: "SessionPort",
						bind: false,
						palette: true,
						slash: { name: "sync", arguments: true },
						run: async (rawInput) => {
							await handlers.sync?.(rawInput);
						},
					},
				],
			}));
			return null;
		},
	});
}
