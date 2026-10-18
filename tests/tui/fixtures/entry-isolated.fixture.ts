import { describe, expect, mock, test } from "bun:test";

/**
 * Entry regression tests for the Phase 2 wiring: the entrypoint delegates to
 * the wiring install root, which is gated to the explicit `win32`/`darwin`/
 * `linux` allowlist. These tests pin the fail-closed behavior (no registration,
 * no host-context access) on unsupported platforms and the activation path on
 * the allowlisted platforms.
 *
 * Import-gate coverage: the designer-owned UI modules statically import the
 * optional UI peers (`@opentui/solid`, `solid-js`). They are mocked here so
 * their evaluation is observable and this file's own graph stays free of those
 * peers. The entry must not evaluate them before the `process.platform` check;
 * on a supported platform the dynamic wiring import must evaluate them.
 *
 * The darwin/linux activation tests simulate `process.platform` only: they
 * establish no real macOS/Linux execution, host run, or platform-support claim.
 * The pinned core crypto/deriver modules are mocked with fakes so simulated
 * activation never initializes real sodium, and `process.platform` is always
 * restored in `finally`.
 *
 * CI-02 isolation: this file intentionally does NOT match Bun's auto-discovered
 * test file patterns. `tests/tui/entry.test.ts` launches it as an explicitly
 * named child (`bun test tests/tui/fixtures/entry-isolated.fixture.ts`) so the
 * process-wide `mock.module` registrations above can never leak into the rest
 * of the suite. Do not rename this file to a `*.test.ts` / `*.spec.ts` pattern.
 * Initial assertions and seams are unchanged from the original entry tests;
 * only the relative source paths gained one `../` level for this folder.
 */

const uiModuleEvaluations: string[] = [];
let cryptoFactoryCalls = 0;

mock.module("../../../src/tui/ui/password-dialog.tsx", () => {
	uiModuleEvaluations.push("password-dialog");
	return { requestPassword: async () => undefined };
});

mock.module("../../../src/tui/ui/restore-report-dialog.tsx", () => {
	uiModuleEvaluations.push("restore-report-dialog");
	return { showRestoreReportDialog: () => {} };
});

// Fake crypto/deriver seams: the wiring graph resolves these instead of the
// real sodium-backed factories, so no real crypto runs in this file.
mock.module("../../../src/core/crypto/index.ts", () => ({
	createCheckpointCryptoFactory: () => {
		cryptoFactoryCalls += 1;
		return { create: async () => ({}) };
	},
}));

mock.module("../../../src/core/restore/index.ts", () => ({
	createRemappedIdDeriver: async () => ({
		derive: () => "ses_0000000000000000000000000000000000000000000000000000000000000000",
	}),
	// Never invoked by these entry tests; present so the wiring graph's
	// `planRestore` import resolves against the mock.
	planRestore: () => {
		throw new Error("planRestore is not used by entry tests");
	},
}));

const sessionPort = (await import("../../../src/tui.ts")).default;
/** UI module evaluations caused by loading the entry itself (must be none). */
const evaluationsAtEntryImport = [...uiModuleEvaluations];

describe("SessionPort plugin entrypoint", () => {
	test("loading the entry does not evaluate the optional-peer UI modules", () => {
		expect(sessionPort.id).toBe("sessionport");
		expect(evaluationsAtEntryImport).toEqual([]);
	});

	test("unsupported platform (freebsd): registers nothing, never touches the host context, and evaluates no UI module", async () => {
		const originalPlatform = process.platform;
		const accessed: string[] = [];
		const context = new Proxy({} as Parameters<typeof sessionPort.setup>[0], {
			get(_target, property) {
				accessed.push(String(property));
				throw new Error(`Unexpected host context access: ${String(property)}`);
			},
		});
		const evaluationsBefore = uiModuleEvaluations.length;

		try {
			Object.defineProperty(process, "platform", { value: "freebsd", configurable: true });
			expect(await sessionPort.setup(context)).toBeUndefined();
			expect(accessed).toEqual([]);
			// The wiring module (and with it every UI module) must stay unloaded.
			expect(uiModuleEvaluations.length).toBe(evaluationsBefore);
		} finally {
			Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
		}
	});

	// Simulated platform only: `process.platform` is overridden to exercise the
	// allowlist on the current test host. These tests do NOT run on macOS/Linux
	// and prove nothing about real cross-platform behavior.
	for (const platform of ["darwin", "linux"] as const) {
		test(`simulated ${platform}: loads the wiring, registers inside the app slot, and returns the slot disposer`, async () => {
			const originalPlatform = process.platform;
			let disposed = 0;
			let layerCalls = 0;
			let layerMode: string | undefined;
			let commandIDs: Array<string | undefined> = [];
			let slotClaim: { readonly append?: string; readonly render?: (input: unknown) => unknown } | undefined;
			const factoryCallsBefore = cryptoFactoryCalls;
			const context = {
				client: {},
				location: { directory: "/work/active" },
				ui: {
					dialog: { select: async () => undefined },
					toast: { show() {} },
					slot(claim: { readonly append?: string; readonly render?: (input: unknown) => unknown }) {
						slotClaim = claim;
						return () => {
							disposed += 1;
						};
					},
				},
				keymap: {
					layer(
						factory: () =>
							| { readonly mode?: string; readonly commands?: ReadonlyArray<{ readonly id?: string }> }
							| undefined,
					) {
						layerCalls += 1;
						const layer = factory();
						layerMode = layer?.mode;
						commandIDs = (layer?.commands ?? []).map((command) => command.id);
					},
				},
			} as unknown as Parameters<typeof sessionPort.setup>[0];

			try {
				Object.defineProperty(process, "platform", { value: platform, configurable: true });
				const cleanup = await sessionPort.setup(context);

				expect(typeof cleanup).toBe("function");
				expect(slotClaim?.append).toBe("app");

				// Loading the wiring on an allowlisted platform evaluates the UI modules it imports.
				expect(uiModuleEvaluations).toContain("password-dialog");
				expect(uiModuleEvaluations).toContain("restore-report-dialog");

				// Activation reached the mocked crypto seam, not real sodium.
				expect(cryptoFactoryCalls).toBeGreaterThan(factoryCallsBefore);

				slotClaim?.render?.({});
				expect(layerCalls).toBe(1);
				expect(layerMode).toBe("global");
				expect(commandIDs).toEqual(["sessionport.checkpoint", "sessionport.restore"]);

				(cleanup as () => void)();
				expect(disposed).toBe(1);
			} finally {
				Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
			}
		});
	}

	test.skipIf(process.platform !== "win32")(
		"Windows: fails closed without registering when the host command surface is unavailable",
		async () => {
			let layerCalls = 0;
			const context = {
				client: {},
				location: undefined,
				ui: {},
				keymap: {
					layer() {
						layerCalls += 1;
					},
				},
			} as unknown as Parameters<typeof sessionPort.setup>[0];

			await expect(sessionPort.setup(context)).rejects.toBeInstanceOf(TypeError);
			expect(layerCalls).toBe(0);
		},
	);

	test.skipIf(process.platform !== "win32")(
		"Windows: dynamically loads the wiring, registers inside the app slot, and returns the slot disposer",
		async () => {
			let disposed = 0;
			let slotClaim: { readonly append?: string } | undefined;
			const context = {
				client: {},
				location: { directory: "C:/work/active" },
				ui: {
					dialog: { select: async () => undefined },
					toast: { show() {} },
					slot(claim: { readonly append?: string }) {
						slotClaim = claim;
						return () => {
							disposed += 1;
						};
					},
				},
				keymap: { layer() {} },
			} as unknown as Parameters<typeof sessionPort.setup>[0];

			const cleanup = await sessionPort.setup(context);

			// Loading the wiring on Windows evaluates the UI modules it imports.
			expect(uiModuleEvaluations).toContain("password-dialog");
			expect(uiModuleEvaluations).toContain("restore-report-dialog");

			expect(slotClaim?.append).toBe("app");
			expect(typeof cleanup).toBe("function");
			(cleanup as () => void)();
			expect(disposed).toBe(1);
		},
	);
});
