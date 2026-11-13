import type { Plugin } from "@opencode/plugin/tui";
import { useKeyboard, type JSX } from "@opentui/solid";
import { createSignal } from "solid-js";

/** A display-safe restore plan. Reasons are fixed local strings, never host errors. */
export interface RestoreReplacementPreview {
	readonly entries: readonly {
		readonly sessionID: string;
		readonly title: string;
		readonly action: "replace" | "update" | "copy" | "import" | "skip";
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
			| "updated"
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

type NativeTheme = Plugin.Context["theme"];
type Theme = NativeTheme | undefined;
type ThemeColor = NativeTheme["text"]["base"];
type DialogContext = Pick<Plugin.Context, "ui" | "theme">;

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
	readonly statusColor: ThemeColor | undefined;
	readonly reason?: string;
}

const FORCED_COPY_REASONS = new Set([
	"lineage-conflict",
	"lineage-ambiguous",
	"lineage-linked",
]);

const REASON_LABELS: Readonly<Record<string, string>> = {
	"exact-duplicate": "An exact duplicate already exists.",
	"lineage-current": "The local copy already has the same or newer message history. Nothing was changed.",
	"lineage-continuation": "Incoming messages continue the existing session under the same ID.",
	"lineage-conflict": "Message histories conflict. A copy is created; both versions are kept and nothing is deleted.",
	"lineage-ambiguous": "The history match is ambiguous. A copy is created; both versions are kept and nothing is deleted.",
	"lineage-linked": "This session has linked records. Restore creates a copy; both versions are kept and nothing is deleted.",
	"lineage-update-blocked": "A same-ID update is not available. This session was not changed.",
	"confirmation-cancelled": "Restore was cancelled.",
	"candidate-collision": "The planned session ID is already in use.",
	"target-absent": "No existing session was found at this ID.",
	"safe-replace": "The existing session passed the replacement checks.",
	"keep-existing": "The existing session will be kept; restore creates a copy.",
	"original-fork-or-revert": "The existing session is a fork or revert; restore creates a copy.",
	"original-parent": "The existing session is a parent of another session and cannot be replaced.",
	"target-unsettled": "The existing session is not settled and cannot be replaced.",
	"destination-child-reference": "Another local session refers to the existing session, so it cannot be replaced.",
	"incoming-reference": "Another session refers to this session, so it cannot be replaced.",
	"inventory-incomplete": "Session references could not be fully checked, so the existing session was kept.",
	"delete-capability-unavailable": "Session deletion is unavailable, so the existing session was kept.",
	"classifier-copy": "The restore checks require a copy, so the existing session was kept.",
	"classifier-skip": "The restore checks could not confirm an action, so this session was not changed.",
	"classifier-unavailable": "The restore checks could not classify this session, so it was not changed.",
	"fingerprint-unavailable": "The existing session could not be verified, so it was not changed.",
	"prepared-record-invalid": "The incoming session record could not be prepared.",
	"clock-invalid": "The import time could not be verified.",
	"import-failed": "The session could not be imported.",
	"import-response-invalid": "The host returned an invalid import response.",
	"import-project-mismatch": "The imported session did not match the selected project.",
	"import-time-window-invalid": "The imported session timestamps could not be verified.",
	"candidate-readback-failed": "The imported session could not be read back.",
	"candidate-verification-failed": "The imported session did not pass verification.",
	"target-readback-failed": "The existing session could not be read back, so it was kept.",
	"target-changed": "The existing session changed after preview, so it was kept.",
	"target-unsettled-at-delete": "The existing session was not settled at the deletion check, so it was kept.",
	"recovery-unverified": "The encrypted recovery backup could not be verified, so the existing session was kept.",
	"delete-capability-missing": "Session deletion is unavailable, so the existing session was kept.",
	"delete-not-performed": "The existing session was not deleted.",
	"delete-unverified-present": "The existing session is still present after the delete attempt.",
	"delete-unverified-unreadable": "The delete could not be confirmed because the existing session could not be read.",
	"delete-uncertain-present": "The delete result is uncertain; the existing session is still present.",
	"delete-uncertain-unreadable": "The delete result is uncertain and the existing session cannot be read.",
	"delete-uncertain-absence-verified": "The delete result was uncertain, but the session is confirmed absent.",
	"old-already-absent": "The original session was already absent; no deletion was needed.",
	"already-absent": "The session was already absent.",
};

function reasonLabel(reason: string | undefined): string | undefined {
	return reason === undefined ? undefined : REASON_LABELS[reason] ?? reason;
}

function previewActionLabel(action: RestoreReplacementPreview["entries"][number]["action"]): string {
	switch (action) {
		case "replace":
			return "Replace existing";
		case "update":
			return "Update under same ID";
		case "copy":
			return "Create copy";
		case "import":
			return "Import";
		case "skip":
			return "No change";
	}
}

function outcomeLabel(outcome: RestoreReplacementReport["entries"][number]["outcome"]): string {
	switch (outcome) {
		case "replaced":
			return "Replaced";
		case "updated":
			return "Updated under same ID";
		case "copied":
			return "Copied; original kept";
		case "imported":
			return "Imported";
		case "skipped":
			return "Skipped";
		case "kept":
			return "Kept";
		case "failed":
			return "Failed";
		case "uncertain":
			return "Uncertain";
	}
}

function consumeKey(event: ConsumableKeyEvent): void {
	event.preventDefault();
	event.stopPropagation();
}

function countLabel(count: number, singular: string, plural = `${singular}s`): string {
	return `${count.toLocaleString()} ${count === 1 ? singular : plural}`;
}

function Notice(props: {
	readonly color: ThemeColor | undefined;
	readonly theme: Theme;
	readonly children: string;
}) {
	return (
		<box
			flexDirection="column"
			border
			borderStyle="rounded"
			borderColor={props.theme?.border.base}
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
	readonly theme: Theme;
}) {
	const entry = () => props.entries[props.index];
	if (!entry()) {
		return (
			<box
				flexDirection="column"
				border
				borderStyle="rounded"
				borderColor={props.theme?.border.base}
				backgroundColor={props.theme?.background.raised.base}
				paddingX={1}
			>
				<text fg={props.theme?.text.muted}>No sessions are included in this restore plan.</text>
			</box>
		);
	}

	return (
		<box
			flexDirection="column"
			gap={0}
			border
			borderStyle="rounded"
			borderColor={props.theme?.border.base}
			backgroundColor={
				props.kind === "OUTCOME"
					? props.theme?.background.raised.high
					: props.theme?.background.raised.base
			}
			paddingX={1}
		>
			<box flexDirection="row" justifyContent="space-between">
				<text fg={props.theme?.text.feedback.info.base}>{props.kind}</text>
				<text fg={props.theme?.text.muted}>
					{(props.index + 1).toLocaleString()} OF {props.entries.length.toLocaleString()}
				</text>
			</box>
			<text fg={props.theme?.text.muted}>Title</text>
			<text wrapMode="char" fg={props.theme?.text.base}>{entry()!.title || "Untitled session"}</text>
			<text fg={props.theme?.text.muted}>Session ID</text>
			{/* Keep the full ID visible; the character wrap is intentional, not ellipsis. */}
			<text wrapMode="char" fg={props.theme?.text.base}>{entry()!.sessionID}</text>
			<box flexDirection="row" gap={1}>
				<text fg={props.theme?.text.muted}>{props.kind === "TARGET" ? "Planned action" : "Outcome"}</text>
				<text wrapMode="char" fg={entry()!.statusColor}>{entry()!.statusLabel}</text>
			</box>
			{entry()!.reason !== undefined && (
				<box flexDirection="column" gap={0}>
					<text fg={props.theme?.text.muted}>{props.kind === "TARGET" ? "Plan note" : "Details"}</text>
					<text wrapMode="char" fg={props.theme?.text.base}>{entry()!.reason}</text>
				</box>
			)}
		</box>
	);
}

function ActionChoice(props: {
	readonly label: string;
	readonly focused: boolean;
	readonly theme: Theme;
}) {
	return (
		<box
			flexDirection="row"
			border
			borderStyle="rounded"
			borderColor={props.theme?.border.base}
			backgroundColor={
				props.focused
					? props.theme?.background.action.primary.base
					: props.theme?.background.raised.base
			}
			paddingX={1}
		>
			<text fg={props.focused ? props.theme?.text.action.primary.base : props.theme?.text.muted}>
				{props.focused ? "> " : "  "}{props.label}
			</text>
		</box>
	);
}

function RestoreReplacementDialog(props: {
	readonly preview: RestoreReplacementPreview;
	readonly replaceCount: number;
	readonly theme: Theme;
	readonly isOpen: () => boolean;
	readonly cancel: () => void;
	readonly continueRestore: () => void;
}): JSX.Element {
	const [index, setIndex] = createSignal(0);
	const [focusedAction, setFocusedAction] = createSignal<"cancel" | "continue">("cancel");
	const entries: readonly EntryView[] = props.preview.entries.map((entry) => ({
		sessionID: entry.sessionID,
		title: entry.title,
		statusLabel: previewActionLabel(entry.action),
		statusColor: entry.action === "replace" || entry.action === "update"
			? props.theme?.text.feedback.warning.base
			: entry.action === "skip"
				? props.theme?.text.muted
				: props.theme?.text.feedback.info.base,
		reason: reasonLabel(entry.reason),
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
		update: props.preview.entries.filter((entry) => entry.action === "update").length,
		copy: props.preview.entries.filter((entry) => entry.action === "copy").length,
		import: props.preview.entries.filter((entry) => entry.action === "import").length,
		skip: props.preview.entries.filter((entry) => entry.action === "skip").length,
	};
	const destructiveCount = props.replaceCount;
	const cancelLabel = destructiveCount > 0 ? "Keep existing sessions" : "Cancel restore";
	const continueLabel = counts.update > 0 && counts.replace === 0
		? `Restore and update ${countLabel(counts.update, "session")}`
		: counts.replace > 0 && counts.update === 0
			? `Restore and replace ${countLabel(counts.replace, "session")}`
			: counts.replace > 0 && counts.update > 0
				? `Restore ${countLabel(destructiveCount, "session")} (${countLabel(counts.update, "update")}, ${countLabel(counts.replace, "replacement")})`
				: "Continue restore";

	return (
		<box
			flexDirection="column"
			width={78}
			gap={1}
			border
			borderStyle="rounded"
			borderColor={props.theme?.border.base}
			backgroundColor={props.theme?.background.base}
			paddingX={2}
			paddingY={1}
		>
			<box flexDirection="row" justifyContent="space-between">
				<text fg={props.theme?.text.feedback.info.base}>SESSIONPORT</text>
				<text fg={props.theme?.text.muted}>RESTORE PREVIEW</text>
			</box>
			<box flexDirection="column" gap={0}>
				<text fg={props.theme?.text.base}>Review local restore targets</text>
				<text fg={props.theme?.text.muted}>
					{countLabel(props.preview.entries.length, "session")} in this plan.
				</text>
				<text wrapMode="char" fg={props.theme?.text.base}>
					{countLabel(counts.replace, "replacement")} · {countLabel(counts.update, "same-ID update")} · {countLabel(counts.copy, "copy", "copies")} · {countLabel(counts.import, "import")} · {countLabel(counts.skip, "skip", "skips")}
				</text>
			</box>

			{props.preview.recoveryRequired && (
				<Notice color={props.theme?.text.feedback.warning.base} theme={props.theme}>
					A verified encrypted recovery backup is required before an existing session can be deleted.
				</Notice>
			)}
			{props.replaceCount > 0 && (
				<Notice color={props.theme?.text.feedback.warning.base} theme={props.theme}>
					{`An existing session is deleted only after its encrypted recovery backup is verified and a fresh read confirms it is unchanged.${counts.update > 0 ? " For a same-ID update, the continuation is then imported under the same session ID. If that import fails, the recovery file is the only restore path." : ""}`}
				</Notice>
			)}
			{props.preview.entries.some((entry) => entry.reason !== undefined && FORCED_COPY_REASONS.has(entry.reason)) && (
				<Notice color={props.theme?.text.feedback.info.base} theme={props.theme}>
					Where message histories conflict, the match is ambiguous, or a session is linked, restore creates a copy. Both versions are kept and nothing is deleted.
				</Notice>
			)}
			{counts.copy > 0 && (
				<Notice color={props.theme?.text.feedback.info.base} theme={props.theme}>
					Forks and reverts keep the original. Known session relationships are not preserved in the new copy.
				</Notice>
			)}
			<Notice color={props.theme?.text.feedback.warning.base} theme={props.theme}>
				Do not edit sessions or run an agent during restore. Restore is not atomic.
			</Notice>

			<EntryBrowser kind="TARGET" entries={entries} index={index()} theme={props.theme} />

			<box flexDirection="row" gap={1}>
				<ActionChoice
					label={cancelLabel}
					focused={focusedAction() === "cancel"}
					theme={props.theme}
				/>
				<ActionChoice
					label={continueLabel}
					focused={focusedAction() === "continue"}
					theme={props.theme}
				/>
			</box>
			<text wrapMode="char" fg={props.theme?.text.muted}>
				↑/↓ target · PgUp/PgDn jump · Tab or ←/→ choose · Enter activate · Esc cancel
			</text>
		</box>
	);
}

function outcomeColor(
	outcome: RestoreReplacementReport["entries"][number]["outcome"],
	theme: Theme,
): ThemeColor | undefined {
	switch (outcome) {
		case "replaced":
		case "updated":
		case "copied":
		case "imported":
			return theme?.text.feedback.success.base;
		case "failed":
			return theme?.text.feedback.error.base;
		case "uncertain":
			return theme?.text.feedback.warning.base;
		case "skipped":
		case "kept":
			return theme?.text.muted;
	}
}

function RestoreReplacementReportDialog(props: {
	readonly result: RestoreReplacementReport;
	readonly theme: Theme;
	readonly close: () => void;
	readonly isOpen: () => boolean;
}): JSX.Element {
	const [index, setIndex] = createSignal(0);
	const entries: readonly EntryView[] = props.result.entries.map((entry) => ({
		sessionID: entry.sessionID,
		title: entry.title,
		statusLabel: outcomeLabel(entry.outcome),
		statusColor: outcomeColor(entry.outcome, props.theme),
		reason: reasonLabel(entry.reason),
	}));
	const countOutcome = (outcome: RestoreReplacementReport["entries"][number]["outcome"]) =>
		props.result.entries.filter((entry) => entry.outcome === outcome).length;
	const partial = countOutcome("failed") > 0 || countOutcome("uncertain") > 0;
	const copied = countOutcome("copied") > 0;
	const forcedCopy = props.result.entries.some(
		(entry) => entry.reason !== undefined && FORCED_COPY_REASONS.has(entry.reason),
	);
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
			borderColor={props.theme?.border.base}
			backgroundColor={props.theme?.background.base}
			paddingX={2}
			paddingY={1}
		>
			<box flexDirection="row" justifyContent="space-between">
				<text fg={props.theme?.text.feedback.info.base}>SESSIONPORT</text>
				<text fg={props.theme?.text.muted}>RESTORE REPORT</text>
			</box>
			<box flexDirection="column" gap={0}>
				<text fg={partial ? props.theme?.text.feedback.warning.base : props.theme?.text.base}>{partial ? "Restore needs attention" : "Restore finished"}</text>
				<text wrapMode="char" fg={props.theme?.text.base}>
					{countLabel(props.result.entries.length, "session")} · {countLabel(countOutcome("replaced"), "replacement")} · {countLabel(countOutcome("updated"), "same-ID update")} · {countLabel(countOutcome("copied"), "copy", "copies")}
				</text>
				<text wrapMode="char" fg={props.theme?.text.base}>
					{countLabel(countOutcome("imported"), "import")} · {countLabel(countOutcome("skipped"), "skip", "skips")} · {countLabel(countOutcome("kept"), "session kept", "sessions kept")} · {countLabel(countOutcome("failed"), "failure")} · {countLabel(countOutcome("uncertain"), "uncertain outcome")}
				</text>
			</box>

			{partial && (
				<Notice color={props.theme?.text.feedback.warning.base} theme={props.theme}>
					Some outcomes need checking. Keep any remaining originals and the recovery file until you have checked the receiving sessions.
				</Notice>
			)}
			{copied && (
				<Notice color={props.theme?.text.feedback.info.base} theme={props.theme}>
					Copied sessions keep their originals. Known session relationships are not preserved in a new copy.
				</Notice>
			)}
			{forcedCopy && (
				<Notice color={props.theme?.text.feedback.info.base} theme={props.theme}>
					Where message histories conflict, the match is ambiguous, or a session is linked, restore creates a copy. Both versions are kept and nothing is deleted.
				</Notice>
			)}
			{props.result.recoveryPath !== undefined && (
				<box flexDirection="column" gap={0}>
					<text fg={props.theme?.text.muted}>Encrypted recovery file</text>
					<text wrapMode="char" fg={props.theme?.text.base}>{props.result.recoveryPath}</text>
				</box>
			)}

			<EntryBrowser kind="OUTCOME" entries={entries} index={index()} theme={props.theme} />
			<box flexDirection="row" justifyContent="space-between">
				<text wrapMode="char" fg={props.theme?.text.muted}>↑/↓ previous/next · PgUp/PgDn jump · Home/End</text>
				<text fg={props.theme?.text.action.primary.base}>Esc CLOSE</text>
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
			const replaceCount = preview.entries.filter((entry) => entry.action === "replace" || entry.action === "update").length;
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
								theme={context.theme}
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
								theme={context.theme}
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
