import type { Plugin } from "@opencode/plugin/tui";
import { createSignal } from "solid-js";
import { SESSIONPORT_COMMAND_IDS } from "./sessionport-commands.tsx";

/** Host surface used by the optional sidebar quick actions. */
export interface SessionPortSidebarHost {
	readonly ui: Pick<Plugin.Context["ui"], "slot">;
	readonly keymap: Pick<Plugin.Context["keymap"], "dispatch">;
	readonly theme: Plugin.Context["theme"];
}

type Action = "checkpoint" | "restore";

/**
 * Optional additive sidebar footer actions. They dispatch the same native
 * commands as `/checkpoint` and `/restore`, so the command layer stays the
 * single owner of parsing, dialogs, and error reporting.
 *
 * This is a UI convenience only. It never writes a session, artifact, or host
 * database directly. Its visibility is controlled by the native SessionPort
 * settings toggle, persisted in plugin storage; no config file is used.
 */
export function installSessionPortSidebarActions(
	context: SessionPortSidebarHost,
	options: { readonly enabled: () => boolean },
): () => void {
	const [hovered, setHovered] = createSignal<Action | undefined>(undefined);

	const dispatch = (action: Action): void => {
		try {
			context.keymap.dispatch(
				action === "checkpoint" ? SESSIONPORT_COMMAND_IDS.checkpoint : SESSIONPORT_COMMAND_IDS.restore,
			);
		} catch {
			// The command layer is registered from the app slot; a host that has
			// not rendered it yet simply has nothing to dispatch to.
		}
	};

	const color = (action: Action) =>
		hovered() === action
			? context.theme.text.action.primary.state({ hovered: true })
			: context.theme.text.muted;

	return context.ui.slot({
		append: "sidebar.footer",
		render() {
			if (!options.enabled()) return <box />;
			return (
				<box flexDirection="row" gap={2} paddingTop={1}>
					<box
						id="sessionport.sidebar.checkpoint"
						onMouseOver={() => setHovered("checkpoint")}
						onMouseOut={() => setHovered(undefined)}
						onMouseUp={() => dispatch("checkpoint")}
					>
						<text fg={color("checkpoint")}>Checkpoint</text>
					</box>
					<box
						id="sessionport.sidebar.restore"
						onMouseOver={() => setHovered("restore")}
						onMouseOut={() => setHovered(undefined)}
						onMouseUp={() => dispatch("restore")}
					>
						<text fg={color("restore")}>Restore</text>
					</box>
				</box>
			);
		},
	});
}
