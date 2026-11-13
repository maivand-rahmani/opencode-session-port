import type { Plugin } from "@opencode/plugin/tui";
import { useKeyboard, type JSX } from "@opentui/solid";
import { createSignal } from "solid-js";

export interface SessionPortSettingsHost {
	readonly ui: Pick<Plugin.Context["ui"], "dialog">;
	readonly theme: Plugin.Context["theme"];
}

export interface SessionPortSettingsOptions {
	readonly sidebarActions: () => boolean;
	readonly setSidebarActions: (value: boolean) => Promise<void>;
	/** Close the modal, ask the host for confirmation, prune, and toast the result. */
	readonly cleanupCheckpoints: () => Promise<void>;
}

export interface SessionPortSettingsUi {
	open(): void;
}

interface ConsumableKeyEvent {
	readonly name: string;
	preventDefault(): void;
	stopPropagation(): void;
}

function consumeKey(event: ConsumableKeyEvent): void {
	event.preventDefault();
	event.stopPropagation();
}

function SettingsDialog(props: {
	readonly theme: Plugin.Context["theme"];
	readonly options: SessionPortSettingsOptions;
	readonly isOpen: () => boolean;
	readonly close: () => void;
}): JSX.Element {
	const [selectedRow, setSelectedRow] = createSignal(0);
	const [saving, setSaving] = createSignal(false);
	const [error, setError] = createSignal(false);
	const [optimisticValue, setOptimisticValue] = createSignal<boolean | undefined>();
	const enabled = () => optimisticValue() ?? props.options.sidebarActions();

	const toggle = async () => {
		if (saving()) return;
		const previous = enabled();
		const next = !previous;
		setError(false);
		setOptimisticValue(next);
		setSaving(true);
		try {
			await props.options.setSidebarActions(next);
			setOptimisticValue(undefined);
		} catch {
			setOptimisticValue(previous);
			setError(true);
		} finally {
			setSaving(false);
		}
	};

	const activate = () => {
		if (selectedRow() === 0) {
			void toggle();
			return;
		}
		props.close();
		void props.options.cleanupCheckpoints();
	};

	useKeyboard((event: ConsumableKeyEvent) => {
		if (!props.isOpen()) return;
		const key = event.name.toLowerCase();
		if (key === "escape" || key === "esc") {
			consumeKey(event);
			props.close();
			return;
		}
		if (["up", "arrowup", "down", "arrowdown"].includes(key)) {
			consumeKey(event);
			const direction = key === "up" || key === "arrowup" ? -1 : 1;
			setSelectedRow((current) => Math.max(0, Math.min(1, current + direction)));
			return;
		}
		if (["left", "arrowleft", "right", "arrowright"].includes(key)) {
			consumeKey(event);
			if (selectedRow() === 0) void toggle();
			return;
		}
		if (["enter", "return"].includes(key)) {
			consumeKey(event);
			activate();
		}
	});

	return (
		<box
			flexDirection="column"
			width={58}
			gap={1}
			border
			borderStyle="rounded"
			borderColor={props.theme.border.base}
			backgroundColor={props.theme.background.base}
			paddingX={2}
			paddingY={1}
		>
			<text fg={props.theme.text.base}>SessionPort settings</text>

			<box
				flexDirection="row"
				justifyContent="space-between"
				border
				borderStyle="rounded"
				borderColor={props.theme.border.base}
				backgroundColor={selectedRow() === 0 ? props.theme.background.raised.base : props.theme.background.base}
				paddingX={1}
			>
				<text fg={props.theme.text.action.primary.base}>
					{selectedRow() === 0 ? ">" : " "}
				</text>
				<text fg={props.theme.text.base}>Sidebar quick actions</text>
				<text fg={saving() ? props.theme.text.muted : props.theme.text.action.primary.base}>
					{saving() ? "saving…" : enabled() ? "on" : "off"}
				</text>
			</box>

			<box
				flexDirection="row"
				border
				borderStyle="rounded"
				borderColor={props.theme.border.base}
				backgroundColor={selectedRow() === 1 ? props.theme.background.raised.base : props.theme.background.base}
				paddingX={1}
			>
				<text fg={props.theme.text.action.primary.base}>
					{selectedRow() === 1 ? ">" : " "}
				</text>
				<text fg={props.theme.text.base}>Delete older checkpoints</text>
			</box>

			<box flexDirection="row" minHeight={1}>
				<text fg={error() ? props.theme.text.feedback.error.base : props.theme.text.muted}>
					{error() ? "Could not save this setting." : " "}
				</text>
			</box>

			<text wrapMode="char" fg={props.theme.text.muted}>
				↑/↓ select · ←/→ change · Enter activate · Esc close
			</text>
		</box>
	);
}

/** Create the native TUI settings dialog for SessionPort. */
export function createSessionPortSettingsUi(
	context: SessionPortSettingsHost,
	options: SessionPortSettingsOptions,
): SessionPortSettingsUi {
	return {
		open() {
			let isOpen = true;
			const close = () => {
				if (!isOpen) return;
				isOpen = false;
				try {
					context.ui.dialog.clear();
				} catch {
					// A failed host close must not keep the keyboard handler active.
				}
			};
			const onClose = () => {
				isOpen = false;
			};

			context.ui.dialog.set({ size: "medium", centered: true });
			context.ui.dialog.show(
				() => (
					<SettingsDialog
						theme={context.theme}
						options={options}
						isOpen={() => isOpen}
						close={close}
					/>
				),
				onClose,
			);
		},
	};
}
