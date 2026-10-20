import type { Plugin } from "@opencode/plugin/tui";
import { useKeyboard, type JSX } from "@opentui/solid";
import { createSignal } from "solid-js";
import type { CloudAuthProgress } from "../../cloud/auth/controller.ts";
import type {
	CloudAuthMenuAction,
	CloudAuthUiPort,
} from "./cloud-auth-flow.ts";

type CloudAuthDialogContext = Pick<Plugin.Context, "ui" | "theme">;

interface LoginDialogProps {
	readonly progress: () => CloudAuthProgress;
	readonly theme: Plugin.Context["theme"];
	readonly onEscape: () => void;
}

function LoginDialog(props: LoginDialogProps): JSX.Element {
	useKeyboard((event) => {
		const key = event.name.toLowerCase();
		if (key !== "escape" && key !== "esc") return;
		event.preventDefault();
		event.stopPropagation();
		props.onEscape();
	});

	const phase = () => props.progress().phase;
	const waiting = () => phase() === "waiting";
	const message = () => {
		switch (phase()) {
			case "starting":
				return "Starting sign-in…";
			case "waiting":
				return "Waiting for approval…";
			case "approved":
				return "Approval received.";
			case "denied":
				return "This request was declined.";
			case "expired":
				return "This request expired.";
			case "cancelled":
				return "Sign-in cancelled.";
			case "unavailable":
				return "Cloud sign-in is unavailable right now.";
		}
	};

	return (
		<box flexDirection="column" gap={1}>
			<text fg={props.theme.text.base}>Sign in to SessionPort</text>
			{waiting() ? (
				<>
					<text fg={props.theme.text.muted}>Open this page to continue:</text>
					<text fg={props.theme.text.base} wrapMode="char">
						{props.progress().verificationUri}
					</text>
					<box flexDirection="row" gap={1}>
						<text fg={props.theme.text.muted}>Code</text>
						<text fg={props.theme.text.base}>{props.progress().userCode}</text>
					</box>
					<text fg={props.theme.text.muted} wrapMode="char">
						Approve only a request you started in OpenCode.
					</text>
					<text fg={props.theme.text.muted}>{message()}</text>
				</>
			) : (
				<text fg={props.theme.text.muted}>{message()}</text>
			)}
			<text fg={props.theme.text.muted}>Esc to cancel</text>
		</box>
	);
}

/**
 * Adapt OpenCode's public native dialogs, toasts, and semantic theme to the
 * small flow port. The login view is the only custom JSX; host-owned built-ins
 * handle status, confirmation, and the supported-action menu.
 */
export function createCloudAuthUi(context: CloudAuthDialogContext): CloudAuthUiPort {
	return {
		showLoginDialog(onClose) {
			const [progress, setProgress] = createSignal<CloudAuthProgress>({
				phase: "starting",
			});
			let ownsDialog = true;

			const notifyClosed = (): void => {
				if (!ownsDialog) return;
				ownsDialog = false;
				setProgress({ phase: "cancelled" });
				onClose();
			};

			const clearOwnedDialog = (): void => {
				if (!ownsDialog) return;
				ownsDialog = false;
				setProgress({ phase: "cancelled" });
				context.ui.dialog.clear();
			};

			context.ui.dialog.set({ size: "medium", centered: true });
			context.ui.dialog.show(
				() => (
					<LoginDialog
						progress={progress}
						theme={context.theme}
						onEscape={() => {
							if (!ownsDialog) return;
							clearOwnedDialog();
							onClose();
						}}
					/>
				),
				notifyClosed,
			);

			return {
				update(next) {
					if (!ownsDialog) return;
					setProgress(sanitizeDialogProgress(next));
				},
				close() {
					clearOwnedDialog();
				},
			};
		},

		alert(options) {
			return context.ui.dialog.alert(options);
		},

		confirm(options) {
			return context.ui.dialog.confirm({
				title: options.title,
				message: options.message,
				label: {
					confirm: options.confirmLabel,
					cancel: options.cancelLabel,
				},
			});
		},

		selectAction(): Promise<CloudAuthMenuAction | undefined> {
			return context.ui.dialog.select<CloudAuthMenuAction>({
				title: "SessionPort cloud sign-in",
				options: [
					{
						title: "Sign in",
						value: "login",
						description: "Approve a sign-in request on this device.",
					},
					{
						title: "Check sign-in status",
						value: "status",
						description: "Show local sign-in status on this device.",
					},
					{
						title: "Remove sign-in",
						value: "logout",
						description: "Remove locally stored sign-in on this device.",
					},
				],
			});
		},

		toast(options) {
			context.ui.toast.show(options);
		},
	};
}

function sanitizeDialogProgress(progress: CloudAuthProgress): CloudAuthProgress {
	if (progress.phase !== "waiting") return { phase: progress.phase };
	const verificationUri = cleanVerificationUri(progress.verificationUri);
	const userCode = progress.userCode;
	if (
		verificationUri === undefined ||
		typeof userCode !== "string" ||
		userCode.length !== 12 ||
		!/^[0-9A-Z]{12}$/u.test(userCode)
	) {
		return { phase: "unavailable" };
	}
	return { phase: "waiting", verificationUri, userCode };
}

function cleanVerificationUri(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	try {
		const uri = new URL(value);
		if (
			(uri.protocol !== "https:" && uri.protocol !== "http:") ||
			uri.username !== "" ||
			uri.password !== "" ||
			uri.search !== "" ||
			uri.hash !== ""
		) {
			return undefined;
		}
		return uri.href;
	} catch {
		return undefined;
	}
}
