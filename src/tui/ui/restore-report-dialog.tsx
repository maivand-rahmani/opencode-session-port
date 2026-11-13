import type { Plugin } from "@opencode/plugin/tui";
import { useKeyboard } from "@opentui/solid";
import { createSignal } from "solid-js";
import {
	RestoreReportNavigator,
	type RestoreReportNavigationSnapshot,
	type RestoreReportPresentationModel,
	type RestoreReportSession,
	type RestoreReportStatus,
} from "./restore-report-flow.ts";

export type {
	RestoreReportClassification,
	RestoreReportPresentationModel,
	RestoreReportSession,
	RestoreReportStatus,
	RestoreReportSummary,
} from "./restore-report-flow.ts";

type Theme = Plugin.Context["theme"];
type ThemeColor = Theme["text"]["base"];
type RestoreReportDialogContext = Pick<Plugin.Context, "ui" | "theme">;

interface RestoreReportDialogProps {
	readonly model: RestoreReportPresentationModel;
	readonly navigator: RestoreReportNavigator;
	readonly theme: Theme;
	readonly close: () => void;
}

interface ConsumableKeyEvent {
	preventDefault(): void;
	stopPropagation(): void;
}

function consumeKey(event: ConsumableKeyEvent): void {
	event.preventDefault();
	event.stopPropagation();
}

function statusColor(status: RestoreReportStatus, theme: Theme): ThemeColor {
	switch (status) {
		case "imported":
			return theme.text.feedback.success.base;
		case "failed":
			return theme.text.feedback.error.base;
		case "blocked":
			return theme.text.feedback.warning.base;
		case "skipped":
		case "not-attempted":
			return theme.text.muted;
	}
}

function isPartial(summary: RestoreReportPresentationModel["summary"]): boolean {
	return summary.failed > 0 || summary.blocked > 0 || summary.notAttempted > 0;
}

function SummaryLine(props: {
	readonly total: number;
	readonly imported: number;
	readonly skipped: number;
	readonly failed: number;
	readonly blocked: number;
	readonly notAttempted: number;
	readonly theme: Theme;
}) {
	return (
		<box flexDirection="column" gap={0}>
			<text wrapMode="char" fg={props.theme.text.base}>
				{props.total.toLocaleString()} total · {props.imported.toLocaleString()} imported · {props.skipped.toLocaleString()} skipped
			</text>
			<text wrapMode="char" fg={props.theme.text.base}>
				{props.failed.toLocaleString()} failed · {props.blocked.toLocaleString()} blocked · {props.notAttempted.toLocaleString()} not attempted
			</text>
		</box>
	);
}

function SessionOutcome(props: { readonly session: RestoreReportSession; readonly theme: Theme }) {
	return (
		<box
			flexDirection="column"
			gap={0}
			border
			borderStyle="rounded"
			borderColor={props.theme.border.base}
			backgroundColor={props.theme.background.raised.base}
			paddingX={1}
			paddingY={0}
		>
			<text fg={props.theme.text.muted}>Session ID</text>
			<text wrapMode="char" fg={props.theme.text.base}>{props.session.sessionID}</text>

			<box flexDirection="row" gap={1}>
				<text fg={props.theme.text.muted}>Classification</text>
				<text wrapMode="char" fg={props.theme.text.base}>{props.session.classification}</text>
			</box>
			<box flexDirection="row" gap={1}>
				<text fg={props.theme.text.muted}>Outcome</text>
				<text wrapMode="char" fg={statusColor(props.session.status, props.theme)}>{props.session.status}</text>
			</box>

			{props.session.skipReason !== undefined && (
				<box flexDirection="column" gap={0}>
					<text fg={props.theme.text.muted}>Skip reason</text>
					{/* Keep the supplied sanitized reason verbatim; do not ellipsize it. */}
					<text wrapMode="char" fg={props.theme.text.base}>{props.session.skipReason}</text>
				</box>
			)}
		</box>
	);
}

function RestoreReportDialog(props: RestoreReportDialogProps) {
	const [navigation, setNavigation] = createSignal(props.navigator.snapshot());
	const move = (next: RestoreReportNavigationSnapshot) => setNavigation(next);

	useKeyboard((event) => {
		const key = event.name.toLowerCase();
		const sequence = event.sequence.toLowerCase();

		if (key === "escape" || key === "esc") {
			consumeKey(event);
			props.close();
			return;
		}

		if (["left", "arrowleft", "up", "arrowup", "pageup"].includes(key) || sequence === "k") {
			consumeKey(event);
			move(props.navigator.previous());
			return;
		}
		if (["right", "arrowright", "down", "arrowdown", "pagedown"].includes(key) || sequence === "j") {
			consumeKey(event);
			move(props.navigator.next());
			return;
		}
		if (key === "home") {
			consumeKey(event);
			move(props.navigator.first());
			return;
		}
		if (key === "end") {
			consumeKey(event);
			move(props.navigator.last());
		}
	});

	const summary = props.model.summary;
	const partial = isPartial(summary);

	return (
		<box
			flexDirection="column"
			width={74}
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
				<text fg={props.theme.text.muted}>RESTORE REPORT</text>
			</box>

			<box flexDirection="column" gap={0}>
				<text fg={props.theme.text.feedback.success.base}>Restore finished</text>
				<SummaryLine {...summary} theme={props.theme} />
			</box>

			{partial && (
				<box
					flexDirection="row"
					border
					borderStyle="rounded"
					borderColor={props.theme.border.base}
					paddingX={1}
				>
					<text wrapMode="char" fg={props.theme.text.feedback.warning.base}>
						Partial progress: there is no atomic rollback; imported sessions remain.
					</text>
				</box>
			)}

			<box flexDirection="column" gap={0}>
				<box flexDirection="row" justifyContent="space-between">
					<text fg={props.theme.text.feedback.info.base}>SESSION OUTCOME</text>
					<text fg={props.theme.text.muted}>
						{navigation().count === 0
							? "NO RESULTS"
							: `${(navigation().index + 1).toLocaleString()} OF ${navigation().count.toLocaleString()}`}
					</text>
				</box>
				{navigation().session ? (
					<SessionOutcome session={navigation().session!} theme={props.theme} />
				) : (
					<box
						flexDirection="column"
						border
						borderStyle="rounded"
						borderColor={props.theme.border.base}
						backgroundColor={props.theme.background.raised.high}
						paddingX={1}
					>
						<text wrapMode="char" fg={props.theme.text.muted}>No per-session outcomes were returned.</text>
					</box>
				)}
			</box>

			<box flexDirection="row" justifyContent="space-between">
				<text wrapMode="char" fg={props.theme.text.muted}>
					←/↑ previous · →/↓ next · Home/End jump
				</text>
				<text fg={props.theme.text.action.primary.base}>Esc  CLOSE</text>
			</box>
		</box>
	);
}

/**
 * Show a keyboard-navigable restore report using only a sanitized presentation
 * model. Each page contains one complete session outcome; long IDs and reason
 * text wrap rather than being clipped. Escape closes the report.
 */
export function showRestoreReportDialog(
	context: RestoreReportDialogContext,
	model: RestoreReportPresentationModel,
): void {
	const navigator = new RestoreReportNavigator(model.sessions);
	context.ui.dialog.set({ size: "large", centered: true });
	context.ui.dialog.show(
		() => (
			<RestoreReportDialog
				model={model}
				navigator={navigator}
				theme={context.theme}
				close={() => context.ui.dialog.clear()}
			/>
		),
	);
}
