/**
 * Install-root tests for the Phase 2 wiring lane.
 *
 * The install root is exercised with injected factory/deriver/password seams
 * and fake host contexts: no real sodium initialization, host call, file, or
 * import is performed. The explicit platform allowlist, fail-closed ordering,
 * and the component-scoped registration contract (E39) are the only claims
 * tested. The darwin/linux activation cases use the `platform` seam to simulate
 * the platform string only — they are not real macOS/Linux execution and
 * establish no platform-support claim.
 */

import { describe, expect, test } from "bun:test";
import type { Plugin } from "@opencode/plugin/tui";
import { createCloudAuthController } from "../../../src/cloud/auth/controller.ts";
import {
	createCloudAuthHandlers,
	type CloudAuthUiPort,
} from "../../../src/tui/ui/cloud-auth-flow.ts";
import { installSessionPortWiring } from "../../../src/tui/wiring/index.ts";
import type { SessionPortCloudAuthHandlers } from "../../../src/tui/wiring/cloud-auth.ts";
import { createFakeCryptoFactory } from "./test-support.ts";

type Context = Plugin.Context;

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function fakeCloudAuth(overrides: {
	readonly cancel?: () => void;
	readonly dispose?: () => Promise<void>;
} = {}): SessionPortCloudAuthHandlers {
	return {
		login: async () => ({ status: "unavailable" }),
		status: async () => ({ status: "unconfigured" }),
		logout: async () => ({ status: "signed-out" }),
		cancel: overrides.cancel ?? (() => {}),
		dispose: overrides.dispose ?? (async () => {}),
		usage: async () => {},
		sync: async () => {},
	};
}

interface FakeInstallContextHandle {
	readonly context: Context;
	readonly slotCalls: number;
	readonly layerCalls: number;
	readonly disposals: number;
	readonly toasts: Array<{ readonly title?: string; readonly message: string; readonly variant?: string }>;
	renderSlot(): void;
	/** Commands published by the deferred keymap layer (empty until `renderSlot`). */
	commands(): Array<{ readonly id?: string; readonly run: (input?: string) => unknown }>;
}

function createFakeInstallContext(): FakeInstallContextHandle {
	const toasts: FakeInstallContextHandle["toasts"] = [];
	let slotCalls = 0;
	let layerCalls = 0;
	let disposals = 0;
	let slotClaim: { readonly append?: string; readonly render?: (input: unknown) => unknown } | undefined;
	let layerFactory: (() => { readonly commands?: Array<{ readonly id?: string; readonly run: (input?: string) => unknown }> }) | undefined;

	const context = {
		client: {},
		location: { directory: "C:/work/active" },
		ui: {
			dialog: { select: async () => undefined },
			toast: {
				show(options: { title?: string; message: string; variant?: string }) {
					toasts.push(options);
				},
			},
			slot(claim: { readonly append?: string; readonly render?: (input: unknown) => unknown }) {
				slotCalls += 1;
				slotClaim = claim;
				return () => {
					disposals += 1;
				};
			},
		},
		keymap: {
			layer(factory: () => { readonly commands?: Array<{ readonly id?: string; readonly run: (input?: string) => unknown }> }) {
				layerCalls += 1;
				layerFactory = factory;
			},
		},
	} as unknown as Context;

	return {
		context,
		get slotCalls(): number {
			return slotCalls;
		},
		get layerCalls(): number {
			return layerCalls;
		},
		get disposals(): number {
			return disposals;
		},
		toasts,
		renderSlot() {
			slotClaim?.render?.({});
		},
		commands() {
			return layerFactory?.().commands ?? [];
		},
	};
}

const fakeFactory = () => createFakeCryptoFactory().factory;
const fakeDeriver = () => ({
	derive: () => "ses_0000000000000000000000000000000000000000000000000000000000000000",
});

describe("installSessionPortWiring", () => {
	test("unsupported platform (freebsd): registers nothing and never touches the host context", async () => {
		let factoryCalls = 0;
		let deriverCalls = 0;
		const accessed: string[] = [];
		const context = new Proxy({} as Context, {
			get(_target, property) {
				accessed.push(String(property));
				throw new Error(`Unexpected host context access: ${String(property)}`);
			},
		});

		const cleanup = await installSessionPortWiring(context, {
			platform: "freebsd",
			createCryptoFactory: async () => {
				factoryCalls += 1;
				return fakeFactory();
			},
			createIdDeriver: async () => {
				deriverCalls += 1;
				return fakeDeriver();
			},
		});

		expect(cleanup).toBeUndefined();
		expect(accessed).toEqual([]);
		expect(factoryCalls).toBe(0);
		expect(deriverCalls).toBe(0);
	});

	test("Windows: initializes, registers the app-slot/keymap commands, and returns the slot disposer", async () => {
		const handle = createFakeInstallContext();

		const cleanup = await installSessionPortWiring(handle.context, {
			platform: "win32",
			createCryptoFactory: async () => fakeFactory(),
			createIdDeriver: async () => fakeDeriver(),
			requestPassword: async () => undefined,
		});

		expect(handle.slotCalls).toBe(1);
		expect(typeof cleanup).toBe("function");
		expect(handle.layerCalls).toBe(0); // E39: the layer is effect-deferred until render

		handle.renderSlot();
		expect(handle.layerCalls).toBe(1);

		(cleanup as () => void)();
		expect(handle.disposals).toBe(1);
	});

	// Simulated platform only: the `platform` seam overrides the platform string
	// to exercise the allowlist on the current test host. These cases are not
	// real macOS/Linux execution and establish no platform-support claim.
	for (const platform of ["darwin", "linux"] as const) {
		test(`simulated ${platform}: initializes the fake seams, registers the app-slot/keymap commands, and returns the slot disposer`, async () => {
			const handle = createFakeInstallContext();
			let factoryCalls = 0;
			let deriverCalls = 0;

			const cleanup = await installSessionPortWiring(handle.context, {
				platform,
				createCryptoFactory: async () => {
					factoryCalls += 1;
					return fakeFactory();
				},
				createIdDeriver: async () => {
					deriverCalls += 1;
					return fakeDeriver();
				},
				requestPassword: async () => undefined,
			});

			expect(factoryCalls).toBe(1);
			expect(deriverCalls).toBe(1);
			expect(handle.slotCalls).toBe(1);
			expect(typeof cleanup).toBe("function");
			expect(handle.layerCalls).toBe(0); // E39: the layer is effect-deferred until render

			handle.renderSlot();
			expect(handle.layerCalls).toBe(1);
			expect(handle.commands().map((command) => command.id)).toEqual([
				"sessionport.checkpoint",
				"sessionport.restore",
				"sessionport.sync",
			]);

			(cleanup as () => void)();
			expect(handle.disposals).toBe(1);
		});
	}

	test("Windows: host cleanup awaits deferred controller release, disposes the slot immediately, and shares one promise", async () => {
		const handle = createFakeInstallContext();
		const release = deferred<void>();
		let disposeCalls = 0;
		let cleanupFn: (() => Promise<void>) | undefined;
		let reentrantCleanup: Promise<void> | undefined;
		const cloudAuth = fakeCloudAuth({
			cancel() {
				// Simulates a host dialog close callback reentering cleanup.
				reentrantCleanup = cleanupFn?.();
			},
			dispose: async () => {
				disposeCalls += 1;
				await release.promise;
			},
		});

		const cleanup = await installSessionPortWiring(handle.context, {
			platform: "win32",
			createCryptoFactory: async () => fakeFactory(),
			createIdDeriver: async () => fakeDeriver(),
			requestPassword: async () => undefined,
			createCloudAuth: () => cloudAuth,
		});
		cleanupFn = cleanup as () => Promise<void>;

		const first = cleanupFn();
		expect(handle.disposals).toBe(1); // slot disposer ran before awaiting release
		expect(disposeCalls).toBe(1);
		expect(reentrantCleanup).toBe(first);
		let settled = false;
		void first.then(() => {
			settled = true;
		});
		await Promise.resolve();
		await Promise.resolve();
		expect(settled).toBe(false);
		expect(cleanupFn()).toBe(first);

		release.resolve();
		await first;
		expect(settled).toBe(true);
		expect(disposeCalls).toBe(1);
		expect(cleanupFn()).toBe(first);
	});

	test("Windows: slot and cancel failures still await controller release and stay sanitized", async () => {
		const handle = createFakeInstallContext();
		let disposeCalls = 0;
		Object.defineProperty(handle.context.ui, "slot", {
			configurable: true,
			value: () => () => {
				throw new Error("raw slot SECRET");
			},
		});
		const cloudAuth = fakeCloudAuth({
			cancel() {
				throw new Error("raw dialog SECRET");
			},
			dispose: async () => {
				disposeCalls += 1;
			},
		});

		const cleanup = await installSessionPortWiring(handle.context, {
			platform: "win32",
			createCryptoFactory: async () => fakeFactory(),
			createIdDeriver: async () => fakeDeriver(),
			requestPassword: async () => undefined,
			createCloudAuth: () => cloudAuth,
		});

		const error = await (cleanup as () => Promise<void>)().catch((value) => value);
		expect(disposeCalls).toBe(1);
		expect(error).toBeInstanceOf(Error);
		expect(error.message).toBe("SessionPort cleanup failed.");
		expect(error.message).not.toContain("SECRET");
	});

	test("Windows: real controller owner-release failure rejects host cleanup fixed and disposes slot", async () => {
		const handle = createFakeInstallContext();
		let releaseCalls = 0;
		const realController = createCloudAuthController(
			{
				origin: "https://api.example.test",
				requestTimeoutMillis: 1_000,
				maxResponseBytes: 4_096,
				maxCredentialBytes: 4_096,
				maxSecretBytes: 8_192,
				vaultService: "sessionport-install-real",
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
		expect(await realController.status()).toEqual({
			status: "signed-out",
		});
		const flowUi: CloudAuthUiPort = {
			showLoginDialog: () => ({
				update: () => {},
				close: () => {},
			}),
			alert: async () => {},
			confirm: async () => true,
			selectAction: async () => undefined,
			toast: () => {},
		};
		const flow = createCloudAuthHandlers({
			getController: () => realController,
			ui: flowUi,
		});
		// Cache the real controller through the actual designer flow.
		expect(await flow.status()).toEqual({ status: "signed-out" });
		const cloudAuth: SessionPortCloudAuthHandlers = {
			...flow,
			sync: async () => {},
		};

		const cleanup = await installSessionPortWiring(handle.context, {
			platform: "win32",
			createCryptoFactory: async () => fakeFactory(),
			createIdDeriver: async () => fakeDeriver(),
			requestPassword: async () => undefined,
			createCloudAuth: () => cloudAuth,
		});
		const cleanupFn = cleanup as () => Promise<void>;
		const first = cleanupFn();
		const repeated = cleanupFn();
		expect(repeated).toBe(first);
		const error = await first.catch((value) => value);
		expect(handle.disposals).toBe(1);
		expect(releaseCalls).toBe(1);
		expect(error).toBeInstanceOf(Error);
		expect(error.message).toBe("Cloud sign-in cleanup failed.");
		expect(error.message).not.toContain("CANARY");
		expect(error.cause).toBeUndefined();
		await expect(repeated).rejects.toThrow(
			"Cloud sign-in cleanup failed.",
		);
		expect(releaseCalls).toBe(1);
	});

	test("Windows: unverifiable owner release fails sanitized instead of claiming cleanup", async () => {
		const handle = createFakeInstallContext();
		let disposeCalls = 0;
		const cloudAuth = fakeCloudAuth({
			dispose: async () => {
				disposeCalls += 1;
				throw new Error("raw owner release SECRET");
			},
		});

		const cleanup = await installSessionPortWiring(handle.context, {
			platform: "win32",
			createCryptoFactory: async () => fakeFactory(),
			createIdDeriver: async () => fakeDeriver(),
			requestPassword: async () => undefined,
			createCloudAuth: () => cloudAuth,
		});

		const cleanupFn = cleanup as () => Promise<void>;
		const first = cleanupFn();
		const repeated = cleanupFn();
		expect(repeated).toBe(first);
		const error = await first.catch((value) => value);
		expect(disposeCalls).toBe(1);
		expect(handle.disposals).toBe(1);
		expect(error).toBeInstanceOf(Error);
		expect(error.message).toBe("Cloud sign-in cleanup failed.");
		expect(error.message).not.toContain("SECRET");
		await expect(repeated).rejects.toThrow("Cloud sign-in cleanup failed.");
	});

	test("Windows: throwing cloud options do not block checkpoint/restore registration or cleanup", async () => {
		const handle = createFakeInstallContext();
		let optionReads = 0;
		Object.defineProperty(handle.context, "options", {
			configurable: true,
			get() {
				optionReads += 1;
				throw new Error("SECRET CLOUD OPTIONS");
			},
		});

		const cleanup = await installSessionPortWiring(handle.context, {
			platform: "win32",
			createCryptoFactory: async () => fakeFactory(),
			createIdDeriver: async () => fakeDeriver(),
			requestPassword: async () => undefined,
		});
		expect(optionReads).toBe(0);
		handle.renderSlot();
		expect(handle.commands().map((command) => command.id)).toEqual([
			"sessionport.checkpoint",
			"sessionport.restore",
			"sessionport.sync",
		]);

		(cleanup as () => void)();
		(cleanup as () => void)();
		expect(handle.disposals).toBe(1);
		expect(optionReads).toBe(0);
	});

	test("Windows: a handler failure is reported through the host toast with sanitized copy", async () => {
		const handle = createFakeInstallContext();
		await installSessionPortWiring(handle.context, {
			platform: "win32",
			createCryptoFactory: async () => fakeFactory(),
			createIdDeriver: async () => fakeDeriver(),
			requestPassword: async () => undefined,
		});
		handle.renderSlot();

		// `client: {}` has no location.get, so the checkpoint handler must report a
		// sanitized failure through the real toast mapping (no raw error text).
		const checkpoint = handle.commands().find((command) => command.id === "sessionport.checkpoint");
		expect(checkpoint).toBeDefined();
		await checkpoint?.run(undefined);

		expect(handle.toasts).toHaveLength(1);
		const toast = handle.toasts[0]!;
		expect(toast.variant).toBe("error");
		expect(toast.title).toBe("Checkpoint failed");
		expect(toast.message).not.toContain("location.get");
	});

	test("Windows: fails closed before registration when the pinned runtime/factory is unavailable", async () => {
		const handle = createFakeInstallContext();
		const failure = new Error("sodium unavailable");

		await expect(
			installSessionPortWiring(handle.context, {
				platform: "win32",
				createCryptoFactory: async () => {
					throw failure;
				},
			}),
		).rejects.toBe(failure);
		expect(handle.slotCalls).toBe(0);
		expect(handle.layerCalls).toBe(0);
	});

	test("Windows: fails closed before registration when the deriver/runtime is unavailable", async () => {
		const handle = createFakeInstallContext();
		const failure = new Error("sodium unavailable");

		await expect(
			installSessionPortWiring(handle.context, {
				platform: "win32",
				createCryptoFactory: async () => fakeFactory(),
				createIdDeriver: async () => {
					throw failure;
				},
			}),
		).rejects.toBe(failure);
		expect(handle.slotCalls).toBe(0);
	});

	test("Windows: fails closed when the host command surface is unavailable", async () => {
		let layerCalls = 0;
		const context = {
			client: {},
			location: undefined,
			ui: {
				dialog: { select: async () => undefined },
				toast: { show() {} },
				// `slot` intentionally absent.
			},
			keymap: {
				layer() {
					layerCalls += 1;
				},
			},
		} as unknown as Context;

		await expect(
			installSessionPortWiring(context, {
				platform: "win32",
				createCryptoFactory: async () => fakeFactory(),
				createIdDeriver: async () => fakeDeriver(),
				requestPassword: async () => undefined,
			}),
		).rejects.toBeInstanceOf(TypeError);
		expect(layerCalls).toBe(0);
	});
});
