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
import { installSessionPortWiring } from "../../../src/tui/wiring/index.ts";
import { createFakeCryptoFactory } from "./test-support.ts";

type Context = Plugin.Context;

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
			]);

			(cleanup as () => void)();
			expect(handle.disposals).toBe(1);
		});
	}

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
