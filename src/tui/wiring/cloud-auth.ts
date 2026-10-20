/**
 * Optional cloud-auth wiring for the native `/sync` command.
 *
 * This module only composes the designer-owned UI flow with the native cloud
 * controller. Configuration, the process-owner lock, the keyring binding, and
 * the vault are not touched at install time: the runtime options getter and
 * `createCloudAuthController` are reached only from a user action. A malformed
 * or throwing options value stays inside the fixed UI/controller taxonomy and
 * cannot break checkpoint/restore registration.
 */
import type { Plugin } from "@opencode/plugin/tui";
import {
	createCloudAuthController,
	type CloudAuthController,
} from "../../cloud/auth/controller.ts";
import {
	createCloudAuthHandlers,
	type CloudAuthHandlers,
	type CloudAuthMenuAction,
	type CloudAuthUiPort,
} from "../ui/cloud-auth-flow.ts";
import { createCloudAuthUi } from "../ui/cloud-auth-dialog.tsx";

/** Accepted `/sync` actions plus the two non-action outcomes. */
export type CloudAuthSyncAction =
	| CloudAuthMenuAction
	| "usage"
	| "unsupported";

/** Native `/sync` integrates the designer flow's fixed actions. */
export interface SessionPortCloudAuthHandlers extends CloudAuthHandlers {
	sync(rawInput: string | undefined): Promise<void>;
}

/**
 * Strict ASCII action parser. Empty input opens the supported-action menu;
 * only `login`, `status`, and `logout` are accepted, with no nested command
 * syntax or checkpoint/restore aliases. Unknown, future, or non-ASCII input is
 * reported through fixed UI copy, never echoed.
 */
export function parseCloudAuthSyncAction(
	rawInput: string | undefined,
): CloudAuthSyncAction {
	if (rawInput === undefined) return "usage";
	if (
		typeof rawInput !== "string" ||
		!/^[\u0009\u000a\u000d\u0020-\u007e]*$/u.test(rawInput)
	) {
		return "unsupported";
	}
	const action = rawInput.trim();
	if (action === "") return "usage";
	if (
		action === "login" ||
		action === "status" ||
		action === "logout"
	) {
		return action;
	}
	return "unsupported";
}

/**
 * Creates the `/sync` handlers with one lazily created controller per wiring
 * lifetime. No option or UI access occurs until an action needs it.
 */
export function createSessionPortCloudAuth(
	context: Plugin.Context,
): SessionPortCloudAuthHandlers {
	const ui = createCloudAuthUi(context);
	let controller: CloudAuthController | undefined;

	const handlers = createCloudAuthHandlers({
		getController: () => {
			if (controller === undefined) {
				controller = createCloudAuthController(
					context.options.sessionportCloud,
				);
			}
			return controller;
		},
		ui,
	});

	const reportUnsupported = async (): Promise<void> => {
		const message =
			"Unsupported /sync action. Use login, status, or logout.";
		try {
			await ui.alert({
				title: "SessionPort cloud sign-in",
				message,
			});
		} catch {
			reportToast(ui, message);
		}
	};

	const sync = async (rawInput: string | undefined): Promise<void> => {
		const action = parseCloudAuthSyncAction(rawInput);
		if (action === "usage") {
			await handlers.usage();
			return;
		}
		if (action === "unsupported") {
			await reportUnsupported();
			return;
		}
		if (action === "login") {
			await handlers.login();
			return;
		}
		if (action === "status") {
			await handlers.status();
			return;
		}
		await handlers.logout();
	};

	return Object.freeze({ ...handlers, sync });
}

function reportToast(ui: CloudAuthUiPort, message: string): void {
	try {
		ui.toast({ message, variant: "warning" });
	} catch {
		// Teardown/UI failures never expose raw input or throw at the host.
	}
}
