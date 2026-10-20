/**
 * Host-independent UI flow for optional cloud sign-in. The adapter owns only
 * the current login dialog; controller ownership and its process lock outlive
 * individual dialogs and are released only when this flow is disposed.
 */
import type {
	CloudAuthController,
	CloudAuthOutcome,
	CloudAuthProgress,
	CloudAuthStatus,
} from "../../cloud/auth/controller.ts";

export type CloudAuthMenuAction = "login" | "status" | "logout";

export interface CloudAuthLoginDialog {
	/** Only waiting progress carries the display-only verification code. */
	update(progress: CloudAuthProgress): void;
	/** Close this dialog only if the adapter still owns the host dialog. */
	close(): void;
}

export interface CloudAuthToast {
	readonly message: string;
	readonly variant?: "info" | "success" | "warning" | "error";
}

export interface CloudAuthUiPort {
	showLoginDialog(onClose: () => void): CloudAuthLoginDialog;
	alert(options: { readonly title: string; readonly message: string }): Promise<void>;
	confirm(options: {
		readonly title: string;
		readonly message: string;
		readonly confirmLabel: string;
		readonly cancelLabel: string;
	}): Promise<boolean | undefined>;
	selectAction(): Promise<CloudAuthMenuAction | undefined>;
	toast(options: CloudAuthToast): void;
}

export interface CreateCloudAuthHandlersOptions {
	/** Called only when a user action first needs the controller. */
	readonly getController: () => CloudAuthController;
	readonly ui: CloudAuthUiPort;
}

export interface CloudAuthHandlers {
	readonly login: () => Promise<CloudAuthOutcome>;
	readonly status: () => Promise<CloudAuthStatus>;
	readonly logout: () => Promise<CloudAuthOutcome>;
	/** Cancel the current login without disposing the shared controller. */
	readonly cancel: () => void;
	/** Plugin teardown: cancel login, then release controller-owned resources. */
	readonly dispose: () => Promise<void>;
	/** Native /sync bare-command menu; exposes only supported actions. */
	readonly usage: () => Promise<void>;
}

const TITLE = "SessionPort cloud sign-in";

const UNAVAILABLE_STATUS: CloudAuthStatus = Object.freeze({
	status: "unavailable",
});
const UNCONFIGURED_STATUS: CloudAuthStatus = Object.freeze({
	status: "unconfigured",
});
const CANCELLED_OUTCOME: CloudAuthOutcome = Object.freeze({
	status: "cancelled",
});
const BUSY_OUTCOME: CloudAuthOutcome = Object.freeze({ status: "busy" });
const UNAVAILABLE_OUTCOME: CloudAuthOutcome = Object.freeze({
	status: "unavailable",
});

interface ActiveLogin {
	readonly abort: AbortController;
	cancelled: boolean;
	dialog?: CloudAuthLoginDialog;
}

/**
 * Build the three /sync handlers and their native usage menu. Controller
 * lookup stays lazy; closing a login modal only aborts that login. Explicit
 * dispose() is reserved for plugin teardown and disposes an acquired controller.
 */
export function createCloudAuthHandlers(
	options: CreateCloudAuthHandlersOptions,
): CloudAuthHandlers {
	let controller: CloudAuthController | undefined;
	let activeLogin: ActiveLogin | undefined;
	let disposed = false;
	let disposePromise: Promise<void> | undefined;

	const getController = (): CloudAuthController | undefined => {
		if (disposed) return undefined;
		if (controller !== undefined) return controller;
		try {
			controller = options.getController();
			return controller;
		} catch {
			return undefined;
		}
	};

	const showToast = (message: string, variant: CloudAuthToast["variant"] = "info") => {
		try {
			options.ui.toast({ message, variant });
		} catch {
			// A notification failure must not expose or change auth state.
		}
	};

	const showAlert = async (message: string): Promise<void> => {
		try {
			await options.ui.alert({ title: TITLE, message });
		} catch {
			showToast(message, "warning");
		}
	};

	const busy = (): void => {
		showToast("A cloud sign-in action is already in progress.");
	};

	const cancelActiveLogin = (flow: ActiveLogin, closeDialog: boolean): void => {
		if (activeLogin !== flow) return;
		// Clear ownership and the displayed-code path before any host UI call.
		// A throwing close/clear must not leave a live cancelled login or code.
		activeLogin = undefined;
		flow.cancelled = true;
		flow.abort.abort();
		if (closeDialog) {
			const dialog = flow.dialog;
			flow.dialog = undefined;
			safeDialogClose(dialog);
		}
	};

	const isCurrent = (flow: ActiveLogin): boolean =>
		!disposed && !flow.cancelled && activeLogin === flow;

	const completeLogin = (
		flow: ActiveLogin,
		outcome: CloudAuthOutcome,
	): void => {
		if (activeLogin === flow) activeLogin = undefined;
		// A final phase replaces any displayed code before the dialog disappears.
		flow.dialog?.update(progressForOutcome(outcome));
		safeDialogClose(flow.dialog);
		showOutcome(outcome, showToast);
	};

	const login = async (): Promise<CloudAuthOutcome> => {
		if (disposed) return UNAVAILABLE_OUTCOME;
		if (activeLogin !== undefined) {
			busy();
			return BUSY_OUTCOME;
		}

		const flow: ActiveLogin = { abort: new AbortController(), cancelled: false };
		activeLogin = flow;
		const currentController = getController();
		if (currentController === undefined) {
			completeLogin(flow, UNAVAILABLE_OUTCOME);
			return UNAVAILABLE_OUTCOME;
		}

		let currentStatus: CloudAuthStatus;
		try {
			currentStatus = normalizeStatus(await currentController.status());
		} catch {
			currentStatus = UNAVAILABLE_STATUS;
		}
		if (!isCurrent(flow)) return CANCELLED_OUTCOME;
		if (currentStatus.status === "unconfigured") {
			activeLogin = undefined;
			await showAlert("Cloud sign-in is not configured.");
			return UNAVAILABLE_OUTCOME;
		}
		if (currentStatus.status === "busy") {
			activeLogin = undefined;
			busy();
			return BUSY_OUTCOME;
		}
		if (currentStatus.status === "unavailable") {
			activeLogin = undefined;
			showToast("Cloud sign-in is unavailable right now.", "error");
			return UNAVAILABLE_OUTCOME;
		}

		try {
			flow.dialog = options.ui.showLoginDialog(() => {
				// Host Escape/close or another dialog replacing ours only cancels this
				// login. It never disposes the shared controller or its owner lock.
				cancelActiveLogin(flow, false);
			});
		} catch {
			completeLogin(flow, UNAVAILABLE_OUTCOME);
			return UNAVAILABLE_OUTCOME;
		}
		if (!isCurrent(flow)) return CANCELLED_OUTCOME;

		let outcome: CloudAuthOutcome;
		try {
			outcome = normalizeOutcome(
				await currentController.login({
					signal: flow.abort.signal,
					onProgress: (progress) => {
						if (!isCurrent(flow)) return;
						flow.dialog?.update(sanitizeProgress(progress));
					},
				}),
			);
		} catch {
			outcome = UNAVAILABLE_OUTCOME;
		}

		if (!isCurrent(flow)) return CANCELLED_OUTCOME;
		completeLogin(flow, outcome);
		return outcome;
	};

	const status = async (): Promise<CloudAuthStatus> => {
		if (disposed) return UNAVAILABLE_STATUS;
		if (activeLogin !== undefined) {
			busy();
			return Object.freeze({ status: "busy" });
		}
		const currentController = getController();
		if (currentController === undefined) {
			await showAlert("Cloud sign-in is unavailable right now.");
			return UNAVAILABLE_STATUS;
		}

		let result: CloudAuthStatus;
		try {
			result = normalizeStatus(await currentController.status());
		} catch {
			result = UNAVAILABLE_STATUS;
		}
		await showAlert(statusMessage(result));
		return result;
	};

	const logout = async (): Promise<CloudAuthOutcome> => {
		if (disposed) return UNAVAILABLE_OUTCOME;
		if (activeLogin !== undefined) {
			busy();
			return BUSY_OUTCOME;
		}
		const currentController = getController();
		if (currentController === undefined) {
			showToast("Cloud sign-in is unavailable right now.", "error");
			return UNAVAILABLE_OUTCOME;
		}

		let currentStatus: CloudAuthStatus;
		try {
			currentStatus = normalizeStatus(await currentController.status());
		} catch {
			currentStatus = UNAVAILABLE_STATUS;
		}
		if (disposed) return UNAVAILABLE_OUTCOME;
		if (currentStatus.status === "unconfigured") {
			await showAlert("Cloud sign-in is not configured.");
			return UNAVAILABLE_OUTCOME;
		}
		if (currentStatus.status === "busy") {
			busy();
			return BUSY_OUTCOME;
		}
		if (currentStatus.status === "unavailable") {
			showToast("Cloud sign-in is unavailable right now.", "error");
			return UNAVAILABLE_OUTCOME;
		}

		let confirmed: boolean | undefined;
		try {
			confirmed = await options.ui.confirm({
				title: "Remove sign-in from this device",
				message: "This does not revoke access on the server.",
				confirmLabel: "Remove sign-in",
				cancelLabel: "Keep sign-in",
			});
		} catch {
			showToast("Cloud sign-in is unavailable right now.", "error");
			return UNAVAILABLE_OUTCOME;
		}
		if (disposed) return UNAVAILABLE_OUTCOME;
		if (confirmed !== true) return CANCELLED_OUTCOME;

		let outcome: CloudAuthOutcome;
		try {
			outcome = normalizeOutcome(await currentController.logout());
		} catch {
			outcome = UNAVAILABLE_OUTCOME;
		}
		showOutcome(outcome, showToast);
		return outcome;
	};

	const usage = async (): Promise<void> => {
		if (disposed) return;
		if (activeLogin !== undefined) {
			busy();
			return;
		}
		let action: CloudAuthMenuAction | undefined;
		try {
			action = await options.ui.selectAction();
		} catch {
			showToast("Cloud sign-in is unavailable right now.", "error");
			return;
		}
		if (action === "login") await login();
		else if (action === "status") await status();
		else if (action === "logout") await logout();
	};

	const cancel = (): void => {
		if (activeLogin !== undefined) cancelActiveLogin(activeLogin, true);
	};

	const dispose = (): Promise<void> => {
		if (disposePromise !== undefined) return disposePromise;
		disposed = true;

		let resolveCleanup!: () => void;
		let rejectCleanup!: (error: unknown) => void;
		const promise = new Promise<void>((resolve, reject) => {
			resolveCleanup = resolve;
			rejectCleanup = reject;
		});
		// Cache before any host/controller call so reentrant dispose() calls
		// share one release attempt and every caller awaits the same settlement.
		disposePromise = promise;

		void performDispose().then(resolveCleanup, rejectCleanup);
		return promise;
	};

	const performDispose = async (): Promise<void> => {
		try {
			if (activeLogin !== undefined) {
				cancelActiveLogin(activeLogin, true);
			}
		} catch {
			// Cancellation/UI failure must not skip controller release.
		}
		const ownedController = controller;
		controller = undefined;
		if (ownedController === undefined) return;
		try {
			await ownedController.dispose();
		} catch {
			// Fail closed: never claim the owner lock was released when the
			// controller could not verify it. Fixed sanitized copy only.
			throw new Error("Cloud sign-in cleanup failed.");
		}
	};

	return Object.freeze({ login, status, logout, cancel, dispose, usage });
}

function safeDialogClose(dialog: CloudAuthLoginDialog | undefined): void {
	try {
		dialog?.close();
	} catch {
		// A host dialog close/clear failure is masked after login state is gone.
	}
}

function sanitizeProgress(progress: CloudAuthProgress): CloudAuthProgress {
	if (progress.phase !== "waiting") {
		switch (progress.phase) {
			case "starting":
			case "approved":
			case "denied":
			case "expired":
			case "cancelled":
			case "unavailable":
				return Object.freeze({ phase: progress.phase });
			default:
				return Object.freeze({ phase: "unavailable" });
		}
	}

	const verificationUri = cleanVerificationUri(progress.verificationUri);
	const userCode = progress.userCode;
	if (
		verificationUri === undefined ||
		typeof userCode !== "string" ||
		userCode.length !== 12 ||
		!/^[0-9A-Z]{12}$/u.test(userCode)
	) {
		return Object.freeze({ phase: "unavailable" });
	}
	return Object.freeze({
		phase: "waiting",
		verificationUri,
		userCode,
	});
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

function progressForOutcome(outcome: CloudAuthOutcome): CloudAuthProgress {
	switch (outcome.status) {
		case "signed-in":
			return { phase: "approved" };
		case "denied":
			return { phase: "denied" };
		case "expired":
			return { phase: "expired" };
		case "cancelled":
			return { phase: "cancelled" };
		case "signed-out":
		case "unavailable":
		case "reauth-required":
		case "busy":
			return { phase: "unavailable" };
	}
}

function normalizeStatus(status: CloudAuthStatus): CloudAuthStatus {
	switch (status?.status) {
		case "unconfigured":
			return UNCONFIGURED_STATUS;
		case "signed-out":
		case "signed-in":
		case "reauth-required":
		case "unavailable":
		case "busy":
			return Object.freeze({ status: status.status });
		default:
			return UNAVAILABLE_STATUS;
	}
}

function normalizeOutcome(outcome: CloudAuthOutcome): CloudAuthOutcome {
	switch (outcome?.status) {
		case "signed-in":
		case "signed-out":
		case "denied":
		case "expired":
		case "cancelled":
		case "unavailable":
		case "reauth-required":
		case "busy":
			return Object.freeze({ status: outcome.status });
		default:
			return UNAVAILABLE_OUTCOME;
	}
}

function statusMessage(status: CloudAuthStatus): string {
	switch (status.status) {
		case "unconfigured":
			return "Cloud sign-in is not configured.";
		case "signed-out":
			return "Not signed in on this device.";
		case "signed-in":
			return "Signed in on this device.";
		case "reauth-required":
			return "Sign-in needs to be set up again on this device.";
		case "unavailable":
			return "Cloud sign-in is unavailable right now.";
		case "busy":
			return "A cloud sign-in action is already in progress.";
	}
}

function showOutcome(
	outcome: CloudAuthOutcome,
	toast: (message: string, variant?: CloudAuthToast["variant"]) => void,
): void {
	switch (outcome.status) {
		case "signed-in":
			toast("Signed in on this device.", "success");
			return;
		case "signed-out":
			toast(
				"Sign-in was removed from this device. This does not revoke access on the server.",
				"success",
			);
			return;
		case "denied":
			toast("Sign-in request was declined.", "warning");
			return;
		case "expired":
			toast("Sign-in request expired. Try again.", "warning");
			return;
		case "cancelled":
			toast("Sign-in cancelled.", "info");
			return;
		case "unavailable":
			toast("Cloud sign-in is unavailable right now.", "error");
			return;
		case "reauth-required":
			toast("Sign-in needs to be set up again on this device.", "warning");
			return;
		case "busy":
			toast("A cloud sign-in action is already in progress.", "info");
			return;
	}
}
