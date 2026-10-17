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

type RestoreReportDialogContext = Pick<Plugin.Context, "ui">;

interface RestoreReportDialogProps {
	readonly model: RestoreReportPresentationModel;
	readonly navigator: RestoreReportNavigator;
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

function statusColor(status: RestoreReportStatus): string {
	switch (status) {
		case "imported":
			return palette.accent;
		case "failed":
			return palette.coral;
		case "blocked":
			return palette.gold;
		case "skipped":
		case "not-attempted":
			return palette.muted;
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
}) {
	return (
		<box flexDirection="column" gap={0}>
			<text wrapMode="char" fg={palette.text}>
				{props.total.toLocaleString()} total · {props.imported.toLocaleString()} imported · {props.skipped.toLocaleString()} skipped
			</text>
			<text wrapMode="char" fg={palette.text}>
				{props.failed.toLocaleString()} failed · {props.blocked.toLocaleString()} blocked · {props.notAttempted.toLocaleString()} not attempted
			</text>
		</box>
	);
}

function SessionOutcome(props: { readonly session: RestoreReportSession }) {
	return (
		<box
			flexDirection="column"
			gap={0}
			border
			borderStyle="rounded"
			borderColor={palette.edge}
			backgroundColor={palette.field}
			paddingX={1}
			paddingY={0}
		>
			<text fg={palette.muted}>Session ID</text>
			<text wrapMode="char" fg={palette.text}>{props.session.sessionID}</text>

			<box flexDirection="row" gap={1}>
				<text fg={palette.muted}>Classification</text>
				<text wrapMode="char" fg={palette.text}>{props.session.classification}</text>
			</box>
			<box flexDirection="row" gap={1}>
				<text fg={palette.muted}>Outcome</text>
				<text wrapMode="char" fg={statusColor(props.session.status)}>{props.session.status}</text>
			</box>

			{props.session.skipReason !== undefined && (
				<box flexDirection="column" gap={0}>
					<text fg={palette.muted}>Skip reason</text>
					{/* Keep the supplied sanitized reason verbatim; do not ellipsize it. */}
					<text wrapMode="char" fg={palette.text}>{props.session.skipReason}</text>
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
				<text fg={palette.text}>Restore finished</text>
				<SummaryLine {...summary} />
			</box>

			{partial && (
				<box
					flexDirection="row"
					border
					borderStyle="rounded"
					borderColor={palette.gold}
					paddingX={1}
				>
					<text wrapMode="char" fg={palette.gold}>
						Partial progress: there is no atomic rollback; imported sessions remain.
					</text>
				</box>
			)}

			<box flexDirection="column" gap={0}>
				<box flexDirection="row" justifyContent="space-between">
					<text fg={palette.accent}>SESSION OUTCOME</text>
					<text fg={palette.muted}>
						{navigation().count === 0
							? "NO RESULTS"
							: `${(navigation().index + 1).toLocaleString()} OF ${navigation().count.toLocaleString()}`}
					</text>
				</box>
				{navigation().session ? (
					<SessionOutcome session={navigation().session!} />
				) : (
					<box
						flexDirection="column"
						border
						borderStyle="rounded"
						borderColor={palette.edge}
						backgroundColor={palette.field}
						paddingX={1}
					>
						<text wrapMode="char" fg={palette.muted}>No per-session outcomes were returned.</text>
					</box>
				)}
			</box>

			<box flexDirection="row" justifyContent="space-between">
				<text wrapMode="char" fg={palette.muted}>
					←/↑ previous · →/↓ next · Home/End jump
				</text>
				<text fg={palette.accent}>Esc  CLOSE</text>
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
				close={() => context.ui.dialog.clear()}
			/>
		),
	);
}
