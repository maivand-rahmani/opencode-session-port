import type { Plugin } from "@opencode/plugin/tui";
import { useKeyboard, usePaste, type JSX } from "@opentui/solid";
import { createMemo, createSignal, onCleanup } from "solid-js";
import {
	showPasswordPrompt,
	type PasswordMode,
	type PasswordPromptState,
} from "./password-flow.ts";

type Context = Pick<Plugin.Context, "ui" | "theme">;

interface PasswordDialogProps {
	readonly mode: PasswordMode;
	readonly maxPasswordBytes: number;
	readonly prompt: PasswordPromptState;
	readonly theme: Plugin.Context["theme"];
	readonly accept: (password: Uint8Array) => void;
	readonly cancel: () => void;
}

interface PasswordFieldProps {
	readonly label: string;
	readonly active: boolean;
	/** A mask from PasswordPromptState; never pass the entered password here. */
	readonly displayMask: string;
	readonly emptyHint: string;
	readonly theme: Plugin.Context["theme"];
}

interface ConsumableKeyEvent {
	preventDefault(): void;
	stopPropagation(): void;
}

function consumeKey(event: ConsumableKeyEvent): void {
	event.preventDefault();
	event.stopPropagation();
}

function formatByteLimit(maxPasswordBytes: number): string {
	return maxPasswordBytes % 1024 === 0
		? `${maxPasswordBytes / 1024} KiB`
		: `${maxPasswordBytes} bytes`;
}

function PasswordField(props: PasswordFieldProps) {
	return (
		<box
			flexDirection="column"
			border
			borderStyle="rounded"
			borderColor={
				props.active ? props.theme.text.formfield.focused : props.theme.border.base
			}
			backgroundColor={
				props.active
					? props.theme.background.formfield.focused
					: props.theme.background.formfield.base
			}
			paddingX={1}
			paddingY={0}
		>
			<box flexDirection="row" gap={1}>
				<text fg={props.active ? props.theme.text.formfield.selected : props.theme.text.muted}>
					{props.active ? ">" : " "}
				</text>
				<text fg={props.active ? props.theme.text.formfield.focused : props.theme.text.muted}>
					{props.label}
				</text>
			</box>
			<box flexDirection="row">
				<text fg={props.displayMask ? props.theme.text.formfield.base : props.theme.text.muted}>
					{props.displayMask || props.emptyHint}
				</text>
				{props.active && <text fg={props.theme.text.formfield.focused}>▏</text>}
			</box>
		</box>
	);
}

function PasswordDialog(props: PasswordDialogProps) {
	const [revision, setRevision] = createSignal(0);
	const view = createMemo(() => {
		revision();
		return props.prompt.snapshot();
	});
	const refresh = () => setRevision((current) => current + 1);

	const submit = () => {
		const result = props.prompt.submit();
		refresh();
		if (result.status === "accepted") props.accept(result.password);
	};

	onCleanup(() => props.prompt.dispose());

	useKeyboard((event) => {
		const key = event.name.toLowerCase();

		if (key === "escape" || key === "esc") {
			consumeKey(event);
			props.cancel();
			return;
		}
		if (key === "enter" || key === "return") {
			consumeKey(event);
			submit();
			return;
		}
		if (key === "tab") {
			consumeKey(event);
			props.prompt.switchField();
			refresh();
			return;
		}
		if (key === "backspace") {
			consumeKey(event);
			props.prompt.backspace();
			refresh();
			return;
		}
		if (event.ctrl && key === "u") {
			consumeKey(event);
			props.prompt.clearActive();
			refresh();
			return;
		}
		if (event.ctrl || event.meta) return;

		const text = event.sequence;
		if (text && !/[\u0000-\u001f\u007f-\u009f]/u.test(text)) {
			consumeKey(event);
			props.prompt.insert(text);
			refresh();
		}
	});

	usePaste((event) => {
		// Prevent the paste from reaching other handlers. Decode strictly and
		// keep only the mask in state exposed to the rendered tree.
		event.preventDefault();
		event.stopPropagation();
		props.prompt.insertPasteBytes(event.bytes);
		refresh();
	});

	return (
		<box
			flexDirection="column"
			width={62}
			gap={1}
			border
			borderStyle="rounded"
			borderColor={props.theme.border.base}
			backgroundColor={props.theme.background.base}
			paddingX={2}
			paddingY={1}
		>
			<box flexDirection="row" justifyContent="space-between">
				<text fg={props.theme.text.feedback.info.base}>SESSIONPORT</text>
				<text fg={props.theme.text.muted}>
					{props.mode === "checkpoint" ? "CHECKPOINT" : "RESTORE"}
				</text>
			</box>

			<box flexDirection="column" gap={0}>
				<text fg={props.theme.text.base}>Password</text>
				<text fg={props.theme.text.muted}>
					{props.mode === "checkpoint"
						? "Choose a password to protect this checkpoint."
						: "Enter the password used to create this checkpoint."}
				</text>
				{props.mode === "checkpoint" && (
					<>
						<text fg={props.theme.text.muted}>
							Use a longer password you do not reuse elsewhere.
						</text>
						<text fg={props.theme.text.muted}>
							Password strength is not checked.
						</text>
					</>
				)}
				<text fg={props.theme.text.muted}>SessionPort cannot recover a lost password.</text>
				<text fg={props.theme.text.muted}>You can type or paste; your entry stays masked.</text>
				<text fg={props.theme.text.muted}>
					Password entries are limited to {formatByteLimit(props.maxPasswordBytes)} of UTF-8.
				</text>
			</box>

			<PasswordField
				label="Password"
				active={view().activeField === "password"}
				displayMask={view().passwordMask}
				emptyHint="Type a password"
				theme={props.theme}
			/>

			{props.mode === "checkpoint" && (
				<PasswordField
					label="Confirm password"
					active={view().activeField === "confirmation"}
					displayMask={view().confirmationMask ?? ""}
					emptyHint="Type it again"
					theme={props.theme}
				/>
			)}

			<box flexDirection="row" minHeight={1}>
				<text fg={view().message ? props.theme.text.feedback.warning.base : props.theme.text.muted}>
					{view().message ?? " "}
				</text>
			</box>

			<box flexDirection="row" justifyContent="space-between">
				<text fg={props.theme.text.muted}>
					{props.mode === "checkpoint" ? "Tab: switch fields · Esc: cancel" : "Esc: cancel"}
				</text>
				<text fg={props.theme.text.action.primary.base}>
					{props.mode === "restore"
						? "ENTER  CONTINUE"
						: view().activeField === "password"
							? "ENTER  NEXT"
							: "ENTER  CREATE"}
				</text>
			</box>
			<text fg={props.theme.text.muted}>
				Backspace: delete · Ctrl+U: clear · Paste: allowed
			</text>
		</box>
	);
}

/** Request one password entry (or a matching checkpoint confirmation). */
export function requestPassword(
	context: Context,
	mode: "checkpoint" | "restore",
	maxPasswordBytes = 4096,
): Promise<Uint8Array | undefined> {
	context.ui.dialog.set({ size: "medium", centered: true });

	return showPasswordPrompt<JSX.Element>(
		context.ui.dialog,
		mode,
		(prompt, accept, cancel) => (
			<PasswordDialog
				mode={mode}
				maxPasswordBytes={maxPasswordBytes}
				prompt={prompt}
				theme={context.theme}
				accept={accept}
				cancel={cancel}
			/>
		),
		maxPasswordBytes,
	);
}
