import { describe, expect, test } from "bun:test";
import { createCloudAuthController } from "../../../src/cloud/auth/controller.ts";
import type {
	CloudAuthController,
	CloudAuthOutcome,
	CloudAuthProgress,
	CloudAuthStatus,
} from "../../../src/cloud/auth/controller.ts";
import {
	createCloudAuthHandlers,
	type CloudAuthLoginDialog,
	type CloudAuthMenuAction,
	type CloudAuthToast,
	type CloudAuthUiPort,
} from "../../../src/tui/ui/cloud-auth-flow.ts";

type LoginOptions = NonNullable<Parameters<CloudAuthController["login"]>[0]>;

class FakeLoginDialog implements CloudAuthLoginDialog {
	readonly updates: CloudAuthProgress[] = [];
	closeCount = 0;
	closed = false;
	failClose = false;

	update(progress: CloudAuthProgress): void {
		if (!this.closed) this.updates.push(progress);
	}

	close(): void {
		if (this.closed) return;
		if (this.failClose) throw new Error("raw dialog clear failure");
		this.closed = true;
		this.closeCount += 1;
	}

	closeFromHost(onClose: () => void): void {
		if (this.closed) return;
		this.closed = true;
		onClose();
	}
}

class FakeUi implements CloudAuthUiPort {
	readonly dialogs: FakeLoginDialog[] = [];
	readonly alerts: Array<{ title: string; message: string }> = [];
	readonly confirmations: Array<{
		title: string;
		message: string;
		confirmLabel: string;
		cancelLabel: string;
	}> = [];
	readonly toasts: CloudAuthToast[] = [];
	selectResult: CloudAuthMenuAction | undefined;
	confirmResult: boolean | undefined = true;
	closeCallbacks: Array<() => void> = [];

	showLoginDialog(onClose: () => void): CloudAuthLoginDialog {
		const dialog = new FakeLoginDialog();
		this.dialogs.push(dialog);
		this.closeCallbacks.push(onClose);
		return dialog;
	}

	async alert(options: { readonly title: string; readonly message: string }): Promise<void> {
		this.alerts.push(options);
	}

	async confirm(options: {
		readonly title: string;
		readonly message: string;
		readonly confirmLabel: string;
		readonly cancelLabel: string;
	}): Promise<boolean | undefined> {
		this.confirmations.push(options);
		return this.confirmResult;
	}

	async selectAction(): Promise<CloudAuthMenuAction | undefined> {
		return this.selectResult;
	}

	toast(options: CloudAuthToast): void {
		this.toasts.push(options);
	}

	closeFromHost(index = this.dialogs.length - 1): void {
		this.dialogs[index]?.closeFromHost(this.closeCallbacks[index] ?? (() => {}));
	}
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function createController(overrides: {
	status?: () => Promise<CloudAuthStatus>;
	login?: (options?: LoginOptions) => Promise<CloudAuthOutcome>;
	logout?: () => Promise<CloudAuthOutcome>;
	dispose?: () => Promise<void>;
} = {}) {
	let statusCalls = 0;
	let loginCalls = 0;
	let logoutCalls = 0;
	let disposeCalls = 0;
	let lastLoginOptions: LoginOptions | undefined;
	const controller: CloudAuthController = {
		status: async () => {
			statusCalls += 1;
			return overrides.status
				? overrides.status()
				: { status: "signed-out" };
		},
		login: async (options) => {
			loginCalls += 1;
			lastLoginOptions = options;
			return overrides.login
				? overrides.login(options)
				: { status: "signed-in" };
		},
		logout: async () => {
			logoutCalls += 1;
			return overrides.logout
				? overrides.logout()
				: { status: "signed-out" };
		},
		dispose: async () => {
			disposeCalls += 1;
			await overrides.dispose?.();
		},
	};
	return {
		controller,
		get statusCalls() {
			return statusCalls;
		},
		get loginCalls() {
			return loginCalls;
		},
		get logoutCalls() {
			return logoutCalls;
		},
		get disposeCalls() {
			return disposeCalls;
		},
		get lastLoginOptions() {
			return lastLoginOptions;
		},
	};
}

function handlers(controller: CloudAuthController, ui: FakeUi, getCount = { value: 0 }) {
	return {
		getCount,
		...createCloudAuthHandlers({
			getController: () => {
				getCount.value += 1;
				return controller;
			},
			ui,
		}),
	};
}

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

describe("cloud auth UI flow", () => {
	test("keeps lookup lazy and shows the 12-character code only while approval is pending", async () => {
		const pending = deferred<CloudAuthOutcome>();
		const fakeController = createController({
			login: async (options) => {
				options?.onProgress?.({
					phase: "waiting",
					verificationUri: "https://cloud.example/device",
					userCode: "01ABCDEF2GHT",
				});
			return pending.promise;
		},
		});
		const ui = new FakeUi();
		const flow = handlers(fakeController.controller, ui);

		expect(flow.getCount.value).toBe(0);
		const result = flow.login();
		await flushMicrotasks();
		expect(flow.getCount.value).toBe(1);
		expect(fakeController.loginCalls).toBe(1);
		const dialog = ui.dialogs[0];
		expect(dialog).toBeDefined();
		expect(dialog.updates).toContainEqual({
			phase: "waiting",
			verificationUri: "https://cloud.example/device",
			userCode: "01ABCDEF2GHT",
		});
		expect(dialog.updates.at(-1)?.verificationUri).not.toContain("01ABCDEF2GHT");

		// Success is not reported until the controller's login promise (and its
		// credential-store commit) has completed.
		expect(ui.toasts).toEqual([]);
		pending.resolve({ status: "signed-in" });
		expect(await result).toEqual({ status: "signed-in" });
		expect(dialog.updates.at(-1)).toEqual({ phase: "approved" });
		expect(dialog.updates.at(-1)).not.toHaveProperty("userCode");
		expect(dialog.closed).toBe(true);
		expect(ui.toasts.at(-1)?.message).toBe("Signed in on this device.");
	});

	test("maps missing configuration to clear copy without opening a login dialog", async () => {
		const fakeController = createController({
			status: async () => ({ status: "unconfigured" }),
		});
		const ui = new FakeUi();
		const flow = handlers(fakeController.controller, ui);

		expect(await flow.login()).toEqual({ status: "unavailable" });
		expect(fakeController.loginCalls).toBe(0);
		expect(ui.dialogs).toHaveLength(0);
		expect(ui.alerts.at(-1)?.message).toBe("Cloud sign-in is not configured.");
	});

	test("uses fixed outcome copy for denied, expired, unavailable, and busy results", async () => {
		const cases: Array<{
			outcome: CloudAuthOutcome;
			message: string;
		}> = [
			{ outcome: { status: "denied" }, message: "Sign-in request was declined." },
			{ outcome: { status: "expired" }, message: "Sign-in request expired. Try again." },
			{
				outcome: { status: "unavailable" },
				message: "Cloud sign-in is unavailable right now.",
			},
			{
				outcome: { status: "busy" },
				message: "A cloud sign-in action is already in progress.",
			},
		];

		for (const item of cases) {
			const fakeController = createController({
				login: async () => item.outcome,
			});
			const ui = new FakeUi();
			const flow = handlers(fakeController.controller, ui);
			expect(await flow.login()).toEqual(item.outcome);
			expect(ui.toasts.at(-1)?.message).toBe(item.message);
			expect(JSON.stringify(ui.toasts)).not.toContain("raw error");
		}
	});

	test("status is local, uses a native alert, and never starts login or exposes raw errors", async () => {
		const fakeController = createController({
			status: async () => ({ status: "signed-out" }),
		});
		const ui = new FakeUi();
		const flow = handlers(fakeController.controller, ui);
		expect(await flow.status()).toEqual({ status: "signed-out" });
		expect(ui.alerts.at(-1)?.message).toBe("Not signed in on this device.");
		expect(fakeController.loginCalls).toBe(0);

		const throwingController = createController({
			status: async () => {
				throw new Error("raw error with secret credential");
			},
		});
		const secondUi = new FakeUi();
		const secondFlow = handlers(throwingController.controller, secondUi);
		expect(await secondFlow.status()).toEqual({ status: "unavailable" });
		expect(secondUi.alerts.at(-1)?.message).toBe(
			"Cloud sign-in is unavailable right now.",
		);
		expect(JSON.stringify(secondUi.alerts)).not.toContain("raw error");
		expect(JSON.stringify(secondUi.alerts)).not.toContain("secret credential");
	});

	test("logout confirms local removal and a cancelled confirmation makes no mutation", async () => {
		const fakeController = createController({
			status: async () => ({ status: "signed-in" }),
		});
		const ui = new FakeUi();
		const flow = handlers(fakeController.controller, ui);
		ui.confirmResult = false;
		expect(await flow.logout()).toEqual({ status: "cancelled" });
		expect(fakeController.logoutCalls).toBe(0);

		ui.confirmResult = true;
		expect(await flow.logout()).toEqual({ status: "signed-out" });
		expect(fakeController.logoutCalls).toBe(1);
		expect(ui.confirmations[0]).toEqual({
			title: "Remove sign-in from this device",
			message: "This does not revoke access on the server.",
			confirmLabel: "Remove sign-in",
			cancelLabel: "Keep sign-in",
		});
		expect(ui.toasts.at(-1)?.message).toContain(
			"This does not revoke access on the server.",
		);
	});

	test("cancel, dialog replacement, and late progress never resurrect a code or clear a newer dialog", async () => {
		const pending = deferred<CloudAuthOutcome>();
		const fakeController = createController({
			login: async () => pending.promise,
		});
		const ui = new FakeUi();
		const flow = handlers(fakeController.controller, ui);
		const result = flow.login();
		await flushMicrotasks();
		const dialog = ui.dialogs[0];
		const progress = fakeController.lastLoginOptions?.onProgress;
		progress?.({
			phase: "waiting",
			verificationUri: "https://cloud.example/device",
			userCode: "01ABCDEF2GHT",
		});
		const countBeforeReplacement = dialog.updates.length;

		// This is the host's onClose path, used when Escape closes or another
		// plugin replaces its dialog. The login signal is cancelled, not disposed.
		ui.closeFromHost();
		expect(fakeController.lastLoginOptions?.signal?.aborted).toBe(true);
		expect(fakeController.disposeCalls).toBe(0);
		progress?.({
			phase: "waiting",
			verificationUri: "https://cloud.example/device",
			userCode: "12GHIJKL3MNP",
		});
		expect(dialog.updates).toHaveLength(countBeforeReplacement);

		pending.resolve({ status: "cancelled" });
		expect(await result).toEqual({ status: "cancelled" });
		expect(dialog.closeCount).toBe(0);
		expect(ui.toasts).toEqual([]);
		await flow.dispose();
		expect(fakeController.disposeCalls).toBe(1);
	});

	test("rapid login is busy, and dispose cancels without disposing on ordinary modal close", async () => {
		const pending = deferred<CloudAuthOutcome>();
		const fakeController = createController({ login: async () => pending.promise });
		const ui = new FakeUi();
		const flow = handlers(fakeController.controller, ui);
		const first = flow.login();
		await flushMicrotasks();
		expect(await flow.login()).toEqual({ status: "busy" });
		expect(fakeController.loginCalls).toBe(1);
		expect(ui.toasts.at(-1)?.message).toBe(
			"A cloud sign-in action is already in progress.",
		);

		flow.cancel();
		expect(fakeController.lastLoginOptions?.signal?.aborted).toBe(true);
		expect(fakeController.disposeCalls).toBe(0);
		pending.resolve({ status: "cancelled" });
		expect(await first).toEqual({ status: "cancelled" });
	});

	test("dispose caches one promise, clears codes before close, and waits for deferred controller release", async () => {
		const login = deferred<CloudAuthOutcome>();
		const release = deferred<void>();
		let disposeCalls = 0;
		const fakeController = createController({
			login: async () => login.promise,
			dispose: async () => {
				disposeCalls += 1;
				await release.promise;
			},
		});
		const ui = new FakeUi();
		const flow = handlers(fakeController.controller, ui);
		const pendingLogin = flow.login();
		await flushMicrotasks();
		const dialog = ui.dialogs[0]!;
		dialog.failClose = true;
		const updatesBeforeDispose = dialog.updates.length;
		const progress = fakeController.lastLoginOptions?.onProgress;

		const first = flow.dispose();
		const second = flow.dispose();
		expect(second).toBe(first);
		await flushMicrotasks();
		expect(disposeCalls).toBe(1);
		expect(fakeController.lastLoginOptions?.signal?.aborted).toBe(true);
		expect(dialog.closed).toBe(false); // close threw and was masked

		let settled = false;
		void first.then(() => {
			settled = true;
		});
		await flushMicrotasks();
		expect(settled).toBe(false); // deferred owner/vault release still pending
		progress?.({
			phase: "waiting",
			verificationUri: "https://cloud.example/device",
			userCode: "01ABCDEF2GHT",
		});
		expect(dialog.updates).toHaveLength(updatesBeforeDispose);
		expect(progress).toBeDefined();

		release.resolve();
		await first;
		expect(settled).toBe(true);
		expect(disposeCalls).toBe(1);
		login.resolve({ status: "cancelled" });
		expect(await pendingLogin).toEqual({ status: "cancelled" });
	});

	test("controller release failure is still awaited and sanitized; dialog close failure is masked", async () => {
		const ui = new FakeUi();
		const login = deferred<CloudAuthOutcome>();
		const fakeController = createController({
			login: async () => login.promise,
			dispose: async () => {
				throw new Error("raw owner lock SECRET");
			},
		});
		const flow = handlers(fakeController.controller, ui);
		const pendingLogin = flow.login();
		await flushMicrotasks();
		ui.dialogs[0]!.failClose = true;

		const cleanup = flow.dispose();
		expect(flow.dispose()).toBe(cleanup);
		const error = await cleanup.catch((value) => value);
		expect(error).toBeInstanceOf(Error);
		expect(error.message).toBe("Cloud sign-in cleanup failed.");
		expect(error.message).not.toContain("raw owner lock SECRET");
		expect(fakeController.disposeCalls).toBe(1);

		// Dispose is idempotent even after failure; the same fixed error persists.
		const repeated = flow.dispose();
		expect(repeated).toBe(cleanup);
		await expect(repeated).rejects.toThrow("Cloud sign-in cleanup failed.");
		login.resolve({ status: "cancelled" });
		expect(await pendingLogin).toEqual({ status: "cancelled" });
	});

	test("real controller dispose propagates fixed owner-release failure through the cached flow promise", async () => {
		let releaseCalls = 0;
		const realController = createCloudAuthController(
			{
				origin: "https://api.example.test",
				requestTimeoutMillis: 1_000,
				maxResponseBytes: 4_096,
				maxCredentialBytes: 4_096,
				maxSecretBytes: 8_192,
				vaultService: "sessionport-flow-real",
				vaultAccount: "credential",
				stateDirectory: process.cwd(),
			},
			{
				acquireOwner: async () => ({
					release: async () => {
						releaseCalls += 1;
						throw new Error(
							"CANARY raw owner path/token detail",
						);
					},
				}),
				createVault: async () => ({
					read: async () => null,
					write: async () => {},
					remove: async () => false,
				}),
				fetch: async () => {
					throw new Error("unexpected network");
				},
				wallNow: () => 1_700_000_000_000,
				monotonicNow: () => 1_000,
				sleep: async () => {},
			},
		);
		const ui = new FakeUi();
		const flow = createCloudAuthHandlers({
			getController: () => realController,
			ui,
		});
		expect(await flow.status()).toEqual({ status: "signed-out" });
		expect(releaseCalls).toBe(0);

		const cleanup = flow.dispose();
		expect(flow.dispose()).toBe(cleanup);
		const error = await cleanup.catch((value) => value);
		expect(error).toBeInstanceOf(Error);
		expect(error.message).toBe("Cloud sign-in cleanup failed.");
		expect(error.message).not.toContain("CANARY");
		expect(error.cause).toBeUndefined();
		expect(releaseCalls).toBe(1);
		expect(await realController.status()).toEqual({
			status: "unavailable",
		});
		expect(releaseCalls).toBe(1);
	});

	test("public cancel is safe when the host dialog close/clear throws", async () => {
		const pending = deferred<CloudAuthOutcome>();
		const fakeController = createController({ login: async () => pending.promise });
		const ui = new FakeUi();
		const flow = handlers(fakeController.controller, ui);
		const login = flow.login();
		await flushMicrotasks();
		const dialog = ui.dialogs[0]!;
		dialog.failClose = true;
		const progress = fakeController.lastLoginOptions?.onProgress;

		expect(() => flow.cancel()).not.toThrow();
		expect(fakeController.lastLoginOptions?.signal?.aborted).toBe(true);
		const updates = dialog.updates.length;
		progress?.({
			phase: "waiting",
			verificationUri: "https://cloud.example/device",
			userCode: "01ABCDEF2GHT",
		});
		expect(dialog.updates).toHaveLength(updates);
		pending.resolve({ status: "cancelled" });
		expect(await login).toEqual({ status: "cancelled" });
	});

	test("the usage menu dispatches only its selected supported action", async () => {
		const fakeController = createController({ status: async () => ({ status: "signed-in" }) });
		const ui = new FakeUi();
		const flow = handlers(fakeController.controller, ui);
		ui.selectResult = "status";
		await flow.usage();
		expect(fakeController.statusCalls).toBe(1);
		expect(fakeController.loginCalls).toBe(0);
		expect(fakeController.logoutCalls).toBe(0);
		expect(ui.alerts.at(-1)?.message).toBe("Signed in on this device.");
	});

	test("malformed progress cannot put a code in a URL or render an invalid code", async () => {
		const fakeController = createController({
			login: async (options) => {
				options?.onProgress?.({
					phase: "waiting",
					verificationUri: "https://cloud.example/device?user_code=SHOULD_NOT_APPEAR",
					userCode: "SHOULD_NOT_APPEAR",
				});
				return { status: "expired" };
			},
		});
		const ui = new FakeUi();
		const flow = handlers(fakeController.controller, ui);
		await flow.login();
		expect(ui.dialogs[0]?.updates).toContainEqual({ phase: "unavailable" });
		expect(JSON.stringify(ui.dialogs[0]?.updates)).not.toContain("SHOULD_NOT_APPEAR");
	});
});
