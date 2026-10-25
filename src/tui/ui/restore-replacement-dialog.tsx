import type { Plugin } from "@opencode/plugin/tui";
import { useKeyboard, type JSX } from "@opentui/solid";
import { createSignal } from "solid-js";

/** A display-safe restore plan. Reasons are fixed local strings, never host errors. */
export interface RestoreReplacementPreview {
	readonly entries: readonly {
		readonly sessionID: string;
		readonly title: string;
		readonly action: "replace" | "copy" | "import" | "skip";
		readonly reason?: string;
	}[];
	readonly recoveryRequired: boolean;
}

/** Display-safe outcomes; recoveryPath, when present, names a local encrypted artifact. */
export interface RestoreReplacementReport {
	readonly entries: readonly {
		readonly sessionID: string;
		readonly title: string;
		readonly outcome:
			| "replaced"
			| "copied"
			| "imported"
			| "skipped"
			| "kept"
			| "failed"
			| "uncertain";
		readonly reason?: string;
	}[];
	readonly recoveryPath?: string;
}

const palette = {
	background: "#111922",
	field: "#202d3b",
	edge: "#344557",
	accent: "#53d6c3",
	text: "#edf3f7",
	muted: "#94a4b2",
	gold: "#e5be76",
	coral: "#ee907f",
} as const;

type DialogContext = Pick<Plugin.Context, "ui">;

interface ConsumableKeyEvent {
	readonly name: string;
	readonly sequence: string;
	readonly ctrl?: boolean;
	readonly meta?: boolean;
	preventDefault(): void;
	stopPropagation(): void;
}

interface EntryView {
	readonly sessionID: string;
	readonly title: string;
	readonly statusLabel: string;
	readonly statusColor: string;
	readonly reason?: string;
}

function consumeKey(event: ConsumableKeyEvent): void {
	event.preventDefault();
	event.stopPropagation();
}

function countLabel(count: number, singular: string, plural = `${singular}s`): string {
	return `${count.toLocaleString()} ${count === 1 ? singular : plural}`;
}

function Notice(props: { readonly color: string; readonly children: string }) {
	return (
		<box
			flexDirection="column"
			border
			borderStyle="rounded"
			borderColor={props.color}
			paddingX={1}
		>
			<text wrapMode="char" fg={props.color}>{props.children}</text>
		</box>
	);
}

function EntryBrowser(props: {
	readonly kind: "TARGET" | "OUTCOME";
	readonly entries: readonly EntryView[];
	readonly index: number;
}) {
	const entry = () => props.entries[props.index];
	if (!entry()) {
		return (
			<box
				flexDirection="column"
				border
				borderStyle="rounded"
				borderColor={palette.edge}
				backgroundColor={palette.field}
				paddingX={1}
			>
				<text fg={palette.muted}>No sessions are included in this restore plan.</text>
			</box>
		);
	}

	return (
		<box
			flexDirection="column"
			gap={0}
			border
			borderStyle="rounded"
			borderColor={palette.edge}
			backgroundColor={palette.field}
			paddingX={1}
		>
			<box flexDirection="row" justifyContent="space-between">
				<text fg={palette.accent}>{props.kind}</text>
				<text fg={palette.muted}>
					{(props.index + 1).toLocaleString()} OF {props.entries.length.toLocaleString()}
				</text>
			</box>
			<text fg={palette.muted}>Title</text>
			<text wrapMode="char" fg={palette.text}>{entry()!.title || "Untitled session"}</text>
			<text fg={palette.muted}>Session ID</text>
			{/* Keep the full ID visible; the character wrap is intentional, not ellipsis. */}
			<text wrapMode="char" fg={palette.text}>{entry()!.sessionID}</text>
			<box flexDirection="row" gap={1}>
				<text fg={palette.muted}>{props.kind === "TARGET" ? "Planned action" : "Outcome"}</text>
				<text wrapMode="char" fg={entry()!.statusColor}>{entry()!.statusLabel}</text>
			</box>
			{entry()!.reason !== undefined && (
				<box flexDirection="column" gap={0}>
					<text fg={palette.muted}>{props.kind === "TARGET" ? "Plan note" : "Details"}</text>
					<text wrapMode="char" fg={palette.text}>{entry()!.reason}</text>
				</box>
			)}
		</box>
	);
}

function ActionChoice(props: {
	readonly label: string;
	readonly focused: boolean;
	readonly color: string;
}) {
	return (
		<box
			flexDirection="row"
			border
			borderStyle="rounded"
			borderColor={props.focused ? props.color : palette.edge}
			backgroundColor={props.focused ? palette.field : palette.background}
			paddingX={1}
		>
			<text fg={props.focused ? props.color : palette.muted}>
				{props.focused ? "> " : "  "}{props.label}
			</text>
		</box>
	);
}

function RestoreReplacementDialog(props: {
	readonly preview: RestoreReplacementPreview;
	readonly replaceCount: number;
	readonly isOpen: () => boolean;
	readonly cancel: () => void;
	readonly continueRestore: () => void;
}): JSX.Element {
	const [index, setIndex] = createSignal(0);
	const [focusedAction, setFocusedAction] = createSignal<"cancel" | "continue">("cancel");
	const entries: readonly EntryView[] = props.preview.entries.map((entry) => ({
		sessionID: entry.sessionID,
		title: entry.title,
		statusLabel: entry.action,
		statusColor: entry.action === "replace" ? palette.coral : palette.text,
		reason: entry.reason,
	}));
	const move = (amount: number) => {
		if (entries.length === 0) return;
		setIndex((current) => Math.max(0, Math.min(entries.length - 1, current + amount)));
	};

	useKeyboard((event: ConsumableKeyEvent) => {
		if (!props.isOpen()) return;
		const key = event.name.toLowerCase();
		const sequence = event.sequence.toLowerCase();
		if (key === "escape" || key === "esc") {
			consumeKey(event);
			props.cancel();
			return;
		}
		if (event.ctrl || event.meta) return;
		if (["tab", "left", "arrowleft", "right", "arrowright"].includes(key)) {
			consumeKey(event);
			setFocusedAction((current) => current === "cancel" ? "continue" : "cancel");
			return;
		}
		if (["up", "arrowup"].includes(key) || sequence === "k") {
			consumeKey(event);
			move(-1);
			return;
		}
		if (["down", "arrowdown"].includes(key) || sequence === "j") {
			consumeKey(event);
			move(1);
			return;
		}
		if (key === "pageup") {
			consumeKey(event);
			move(-5);
			return;
		}
		if (key === "pagedown") {
			consumeKey(event);
			move(5);
			return;
		}
		if (key === "home") {
			consumeKey(event);
			setIndex(0);
			return;
		}
		if (key === "end") {
			consumeKey(event);
			setIndex(Math.max(0, entries.length - 1));
			return;
		}
		if (key === "enter" || key === "return") {
			consumeKey(event);
			if (focusedAction() === "continue") props.continueRestore();
			else props.cancel();
		}
	});

	const counts = {
		replace: props.preview.entries.filter((entry) => entry.action === "replace").length,
		copy: props.preview.entries.filter((entry) => entry.action === "copy").length,
		import: props.preview.entries.filter((entry) => entry.action === "import").length,
		skip: props.preview.entries.filter((entry) => entry.action === "skip").length,
	};
	const cancelLabel = props.replaceCount > 0 ? "Keep existing sessions" : "Cancel restore";
	const continueLabel = props.replaceCount > 0
		? `Restore and replace ${props.replaceCount.toLocaleString()} ${props.replaceCount === 1 ? "session" : "sessions"}`
		: "Continue restore";

	return (
		<box
			flexDirection="column"
			width={78}
			gap={1}
			border
			borderStyle="rounded"
			borderColor={palette.edge}
			backgroundColor={palette.background}
			paddingX={2}
			paddingY={1}
		>
			<box flexDirection="row" justifyContent="space-between">
				<text fg={palette.accent}>SESSIONPORT</text>
				<text fg={palette.muted}>RESTORE PREVIEW</text>
			</box>
			<box flexDirection="column" gap={0}>
				<text fg={palette.text}>Review local restore targets</text>
				<text fg={palette.muted}>
					{countLabel(props.preview.entries.length, "session")} in this plan.
				</text>
				<text wrapMode="char" fg={palette.text}>
					{countLabel(counts.replace, "replacement")} · {countLabel(counts.copy, "copy", "copies")} · {countLabel(counts.import, "import")} · {countLabel(counts.skip, "skip", "skips")}
				</text>
			</box>

			{props.preview.recoveryRequired && (
				<Notice color={palette.gold}>
					A verified encrypted recovery backup is required before this restore can continue.
				</Notice>
			)}
			{props.replaceCount > 0 && (
				<Notice color={palette.coral}>
					An existing session is deleted only after the restored copy is verified, an encrypted recovery backup is verified, and an unchanged readback of the existing session succeeds.
				</Notice>
			)}
			{counts.copy > 0 && (
				<Notice color={palette.gold}>
					Forks and reverts keep the original. Known session relationships are not preserved in the new copy.
				</Notice>
			)}
			<Notice color={palette.gold}>
				Do not edit sessions or run an agent during restore. Restore is not atomic.
			</Notice>

			<EntryBrowser kind="TARGET" entries={entries} index={index()} />

			<box flexDirection="row" gap={1}>
				<ActionChoice
					label={cancelLabel}
					focused={focusedAction() === "cancel"}
					color={palette.accent}
				/>
				<ActionChoice
					label={continueLabel}
					focused={focusedAction() === "continue"}
					color={props.replaceCount > 0 ? palette.coral : palette.accent}
				/>
			</box>
			<text wrapMode="char" fg={palette.muted}>
				↑/↓ target · PgUp/PgDn jump · Tab or ←/→ choose · Enter activate · Esc cancel
			</text>
		</box>
	);
}

function outcomeColor(outcome: RestoreReplacementReport["entries"][number]["outcome"]): string {
	switch (outcome) {
		case "replaced":
		case "copied":
		case "imported":
			return palette.accent;
		case "failed":
			return palette.coral;
		case "uncertain":
			return palette.gold;
		case "skipped":
		case "kept":
			return palette.muted;
	}
}

function RestoreReplacementReportDialog(props: {
	readonly result: RestoreReplacementReport;
	readonly close: () => void;
	readonly isOpen: () => boolean;
}): JSX.Element {
	const [index, setIndex] = createSignal(0);
	const entries: readonly EntryView[] = props.result.entries.map((entry) => ({
		sessionID: entry.sessionID,
		title: entry.title,
		statusLabel: entry.outcome,
		statusColor: outcomeColor(entry.outcome),
		reason: entry.reason,
	}));
	const countOutcome = (outcome: RestoreReplacementReport["entries"][number]["outcome"]) =>
		props.result.entries.filter((entry) => entry.outcome === outcome).length;
	const partial = countOutcome("failed") > 0 || countOutcome("uncertain") > 0;
	const copied = countOutcome("copied") > 0;
	const move = (amount: number) => {
		if (entries.length === 0) return;
		setIndex((current) => Math.max(0, Math.min(entries.length - 1, current + amount)));
	};

	useKeyboard((event: ConsumableKeyEvent) => {
		if (!props.isOpen()) return;
		const key = event.name.toLowerCase();
		const sequence = event.sequence.toLowerCase();
		if (key === "escape" || key === "esc") {
			consumeKey(event);
			props.close();
			return;
		}
		if (["left", "arrowleft", "up", "arrowup", "pageup"].includes(key) || sequence === "k") {
			consumeKey(event);
			move(key === "pageup" ? -5 : -1);
			return;
		}
		if (["right", "arrowright", "down", "arrowdown", "pagedown"].includes(key) || sequence === "j") {
			consumeKey(event);
			move(key === "pagedown" ? 5 : 1);
			return;
		}
		if (key === "home") {
			consumeKey(event);
			setIndex(0);
			return;
		}
		if (key === "end") {
			consumeKey(event);
			setIndex(Math.max(0, entries.length - 1));
		}
	});

	return (
		<box
			flexDirection="column"
			width={74}
			gap={1}
			border
			borderStyle="rounded"
			borderColor={palette.edge}
			backgroundColor={palette.background}
			paddingX={2}
			paddingY={1}
		>
			<box flexDirection="row" justifyContent="space-between">
				<text fg={palette.accent}>SESSIONPORT</text>
				<text fg={palette.muted}>RESTORE REPORT</text>
			</box>
			<box flexDirection="column" gap={0}>
				<text fg={palette.text}>{partial ? "Restore needs attention" : "Restore finished"}</text>
				<text wrapMode="char" fg={palette.text}>
					{countLabel(props.result.entries.length, "session")} · {countLabel(countOutcome("replaced"), "replacement")} · {countLabel(countOutcome("copied"), "copy", "copies")}
				</text>
				<text wrapMode="char" fg={palette.text}>
					{countLabel(countOutcome("imported"), "import")} · {countLabel(countOutcome("skipped"), "skip", "skips")} · {countLabel(countOutcome("kept"), "session kept", "sessions kept")} · {countLabel(countOutcome("failed"), "failure")} · {countLabel(countOutcome("uncertain"), "uncertain outcome")}
				</text>
			</box>

			{partial && (
				<Notice color={palette.gold}>
					Some outcomes need checking. Keep any remaining originals and the recovery file until you have checked the receiving sessions.
				</Notice>
			)}
			{copied && (
				<Notice color={palette.gold}>
					Copied sessions keep their originals. Known session relationships are not preserved in a new copy.
				</Notice>
			)}
			{props.result.recoveryPath !== undefined && (
				<box flexDirection="column" gap={0}>
					<text fg={palette.muted}>Encrypted recovery file</text>
					<text wrapMode="char" fg={palette.text}>{props.result.recoveryPath}</text>
				</box>
			)}

			<EntryBrowser kind="OUTCOME" entries={entries} index={index()} />
			<box flexDirection="row" justifyContent="space-between">
				<text wrapMode="char" fg={palette.muted}>↑/↓ previous/next · PgUp/PgDn jump · Home/End</text>
				<text fg={palette.accent}>Esc CLOSE</text>
			</box>
		</box>
	);
}

/** Create the native TUI preview/confirmation and outcome-report port. */
export function createRestoreReplacementUi(context: DialogContext): {
	confirm(preview: RestoreReplacementPreview): Promise<boolean>;
	report(result: RestoreReplacementReport): Promise<void>;
} {
	return {
		confirm(preview) {
			const replaceCount = preview.entries.filter((entry) => entry.action === "replace").length;
			return new Promise<boolean>((resolve) => {
				let isOpen = true;
				const dismiss = () => {
					if (!isOpen) return;
					isOpen = false;
					resolve(false);
				};
				const finish = (accepted: boolean) => {
					if (!isOpen) return;
					isOpen = false;
					resolve(accepted);
					try {
						context.ui.dialog.clear();
					} catch {
						// A failed host close must not leave confirmation pending.
					}
				};
				try {
					context.ui.dialog.set({ size: "large", centered: true });
					context.ui.dialog.show(
						() => (
							<RestoreReplacementDialog
								preview={preview}
								replaceCount={replaceCount}
								isOpen={() => isOpen}
								cancel={() => finish(false)}
								continueRestore={() => finish(true)}
							/>
						),
						dismiss,
					);
				} catch {
					dismiss();
				}
			});
		},

		report(result) {
			return new Promise<void>((resolve) => {
				let isOpen = true;
				const finish = (clear: boolean) => {
					if (!isOpen) return;
					isOpen = false;
					resolve();
					if (!clear) return;
					try {
						context.ui.dialog.clear();
					} catch {
						// Report display is complete even if the host cannot clear the modal.
					}
				};
				try {
					context.ui.dialog.set({ size: "large", centered: true });
					context.ui.dialog.show(
						() => (
							<RestoreReplacementReportDialog
								result={result}
								isOpen={() => isOpen}
								close={() => finish(true)}
							/>
						),
						() => finish(false),
					);
				} catch {
					finish(false);
				}
			});
		},
	};
}
