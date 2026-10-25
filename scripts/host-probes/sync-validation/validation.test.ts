/**
 * Host-free validation for the native `/sync` validation lane.
 *
 * Nothing here starts OpenCode, reads the real keyring, calls the network, or
 * performs a user action. The only child process is the runner's validation-only
 * mode (no root, no TUI, no keyring read, no environment mutation).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupExactEntry } from "./cleanup-entry.mjs";
import {
	createCloudAuthController,
} from "../../../src/cloud/auth/controller.ts";
import { CredentialStore } from "../../../src/cloud/auth/credential-store.ts";
import { createCloudAuthUi } from "../../../src/tui/ui/cloud-auth-dialog.tsx";
import { createCloudAuthHandlers } from "../../../src/tui/ui/cloud-auth-flow.ts";
import { SESSIONPORT_COMMAND_IDS } from "../../../src/tui/ui/sessionport-commands.tsx";
import { parseCloudAuthSyncAction } from "../../../src/tui/wiring/cloud-auth.ts";
import { installSessionPortWiring } from "../../../src/tui/wiring/install.ts";
import {
	createNativeObservations,
	createObservedCloudAuthFactory,
	MAX_OBSERVED_EVENTS,
	recordAlertObservation,
	sanitizeNativeResponseText,
	wrapObservedController,
} from "./tui-sync-probe.ts";
import { createCloudAuthHandlers } from "../../../src/tui/ui/cloud-auth-flow.ts";

const HERE = import.meta.dir;
const RUNNER = join(HERE, "..", "command-integration", "run-command-integration-probe.ps1");
const PLUGIN = join(HERE, "tui-sync-probe.ts");
const CLEANUP = join(HERE, "cleanup-entry.mjs");

type EntryConstructor = new (service: string, account: string) => {
	getSecret(): Promise<number[] | null>;
	deleteCredential(): Promise<boolean>;
};

function createFakeEntryClass(
	store: Map<string, number[]>,
	options: { throwOnDelete?: boolean } = {},
) {
	const calls = { deleted: [] as string[], read: [] as string[] };
	class FakeEntry {
		readonly key: string;
		constructor(
			readonly service: string,
			readonly account: string,
		) {
			this.key = `${service}\u0000${account}`;
		}
		async getSecret(): Promise<number[] | null> {
			calls.read.push(this.key);
			const value = store.get(this.key);
			return value === undefined ? null : value.slice();
		}
		async deleteCredential(): Promise<boolean> {
			calls.deleted.push(this.key);
			if (options.throwOnDelete) throw new Error("native delete failed");
			if (!store.has(this.key)) return false;
			store.delete(this.key);
			return true;
		}
	}
	return { FakeEntry: FakeEntry as EntryConstructor, calls };
}

describe("exact-entry vault cleanup guard", () => {
	test("removes only the run-unique pair and never touches other entries", async () => {
		const store = new Map<string, number[]>([
			["sessionport-m3-run\u0000credential", [1, 2, 3]],
			["other-service\u0000credential", [9, 9]],
			["sessionport-m3-run\u0000other-account", [7]],
		]);
		const { FakeEntry, calls } = createFakeEntryClass(store);

		const receipt = await cleanupExactEntry(FakeEntry, "sessionport-m3-run", "credential");

		expect(receipt).toEqual({ exactTargetOnly: true, presence: true, removed: true });
		expect(store.has("sessionport-m3-run\u0000credential")).toBe(false);
		expect(store.get("other-service\u0000credential")).toEqual([9, 9]);
		expect(store.get("sessionport-m3-run\u0000other-account")).toEqual([7]);
		expect(calls.deleted).toEqual(["sessionport-m3-run\u0000credential"]);
	});

	test("absent target is a verified no-op (no delete call, no overwrite)", async () => {
		const store = new Map<string, number[]>([["other\u0000credential", [4]]]);
		const { FakeEntry, calls } = createFakeEntryClass(store);

		const receipt = await cleanupExactEntry(FakeEntry, "sessionport-m3-absent", "credential");

		expect(receipt).toEqual({ exactTargetOnly: true, presence: false, removed: false });
		expect(calls.deleted).toEqual([]);
		expect(store.get("other\u0000credential")).toEqual([4]);
	});

	test("uncertain delete keeps null state so the runner retains the private root", async () => {
		const store = new Map<string, number[]>([["target\u0000credential", [5]]]);
		const { FakeEntry } = createFakeEntryClass(store, { throwOnDelete: true });

		const receipt = await cleanupExactEntry(FakeEntry, "target", "credential");

		expect(receipt.exactTargetOnly).toBe(true);
		expect(receipt.presence).toBe(true);
		expect(receipt.removed).toBeNull();
	});

	test("unavailable read keeps null state and never attempts a mutation", async () => {
		const store = new Map<string, number[]>([["target\u0000credential", [5]]]);
		const { FakeEntry, calls } = createFakeEntryClass(store);
		class BrokenEntry extends FakeEntry {}
		Object.defineProperty(BrokenEntry.prototype, "getSecret", {
			value: async () => {
				throw new Error("vault unavailable");
			},
		});

		const receipt = await cleanupExactEntry(BrokenEntry as EntryConstructor, "target", "credential");

		expect(receipt).toEqual({ exactTargetOnly: true, presence: null, removed: null });
		expect(calls.deleted).toEqual([]);
	});
});

describe("fixed native sync plugin", () => {
	const source = readFileSync(PLUGIN, "utf8");

	test("uses the real wiring and a test-wrapper-only cloud configuration", () => {
		expect(source).toContain("installSessionPortWiring(contextWrapper, { createCloudAuth: observedCloudAuthFactory })");
		expect(source).toContain("sessionportCloud: config");
		expect(source).toContain("origin: origin");
		expect(source).toContain("allowLoopbackHttp: true");
		expect(source).toContain("requestTimeoutMillis: 1000");
		expect(source).toContain("maxResponseBytes: 4096");
		expect(source).toContain("maxCredentialBytes: 4096");
		expect(source).toContain("vaultAccount: vaultAccount");
		expect(source).not.toContain("requestTimeoutMillis ??");
		expect(source).not.toContain("maxResponseBytes ??");
	});

	test("preflights the run-unique scope read-only and stops on any presence", () => {
		expect(source).toContain("sessionport-m3-");
		expect(source).toContain("vault.read({ service: config.vaultService, account: config.vaultAccount })");
		expect(source).toContain("vault-entry-present");
		expect(source).toContain("vault-preflight-failed");
		expect(source).not.toContain("setSecret");
		expect(source).not.toContain("deleteCredential");
		expect(source).not.toContain("findCredentials");
	});

	test("never performs a programmatic login or captures UI secrets", () => {
		expect(source).toContain("loginDispatchedByProbe: false");
		expect(source).toContain("dialogContentRead: false");
		expect(source).toContain("verificationCodeCaptured: false");
		expect(source).toContain("identityCaptured: false");
		expect(source).not.toContain("keymap.dispatch");
		expect(source).toContain("parseCloudAuthSyncAction");
		expect((source.match(/handlers\.login\(\)/g) ?? []).length).toBe(1);
		expect(source).not.toContain("dialog.show(");
	});

	test("does not dispose the product wiring from the probe (host teardown owns it)", () => {
		expect(source).not.toContain("disposer(");
		expect((source.match(/dispose: function \(\)/g) ?? []).length).toBe(1);
	});

	test("alert wrapper persists an observation without reading alert fields", () => {
		const start = source.indexOf("alert: function (options)");
		const end = source.indexOf("return Promise.resolve()", start);
		const block = source.slice(start, end);
		expect(start).toBeGreaterThan(0);
		expect(block).toContain("recordAlertObservation(observations)");
		expect(block).toContain("persist()");
		expect(block).not.toContain("options.");
		for (const marker of [
			"message",
			"title",
			"userCode",
			"verificationUri",
			"accessToken",
			"refreshToken",
			"content",
		]) {
			expect(block).not.toContain(marker);
		}
		expect(source).toContain("MAX_OBSERVED_EVENTS = 16");
		expect(source).not.toContain("showLoginDialog");
	});
});

describe("runner fixed mode", () => {
	const runner = readFileSync(RUNNER, "utf8");
	const cleanup = readFileSync(CLEANUP, "utf8");

	test("default mode remains the original checkpoint/restore probe", () => {
		expect(runner).toContain('$RootNamePrefix = if ($script:NativeSyncValidation) { "sp-native-sync-" } else { "sp-command-" }');
		expect(runner).toContain('$ProbeName = "sessionport-command-integration"');
		expect(runner).toContain("single synthetic /checkpoint -> /restore round trip");
	});

	test("native mode has fixed plugin/cleanup sources and no caller path override", () => {
		expect(runner).toContain('$NativeSyncPluginRelativePath = "scripts\\host-probes\\sync-validation\\tui-sync-probe.ts"');
		expect(runner).toContain('$NativeSyncCleanupRelativePath = "scripts\\host-probes\\sync-validation\\cleanup-entry.mjs"');
		expect(runner).not.toContain("PluginPath");
		expect(runner).not.toContain("[string]$VaultService");
	});

	test("pins exactly four regular keyring files with source+destination hashes", () => {
		const pinned = [
			"4BA8C90AC72BE27FCB3337ED7BC0159C68747E0824294DF5F2AAAEB03130CD4F",
			"8A89DB37F981D05B484EB063ADAE3399660AE7734AD38797463E5691382F5036",
			"1552C08589EEAEBC3680642883A8CAFEA8C72F80ED62908DE814177498562121",
			"52B16658275B7848F8081A6542FEE3448F1B1C5D3A36487107AE0E7CEC95AC6F",
		];
		for (const hash of pinned) expect(runner).toContain(hash);
		expect(runner).toContain("regular file");
		expect(runner).toContain("Get-FileHash -LiteralPath $destination");
		expect(runner).toContain("keyring.win32-x64-msvc.node");
		expect(cleanup).not.toContain("setSecret");
		expect(cleanup).not.toContain("findCredentials");
	});

	test("vault cleanup runs only after the verified stop and fails closed", () => {
		const stopIndex = runner.indexOf("$script:TuiStopVerified = $true");
		const guardIndex = runner.indexOf("Invoke-NativeSyncVaultCleanupGuard -Root $script:Root");
		expect(stopIndex).toBeGreaterThan(0);
		expect(guardIndex).toBeGreaterThan(stopIndex);
		expect(runner).toContain("$script:KeepRootForced = $true");
		expect(runner).toContain("private root retained and no unmanaged delete attempted");
		expect(runner).toContain("if ($preflightAbsent -eq $true)");
	});
});

const HAS_POWERSHELL = process.platform === "win32" && Bun.which("powershell.exe") !== null;

describe("fixed terminal outcome observation via real flow", () => {
	function fakeUi() {
		const closed = { count: 0 };
		return {
			closed,
			ui: {
				showLoginDialog() {
					return {
						update() {},
						close() {
							closed.count += 1;
						},
					};
				},
				alert: async () => {},
				confirm: async () => true,
				selectAction: async () => undefined,
				toast: () => {},
			},
		};
	}

	for (const status of ["signed-in", "unavailable", "reauth-required"] as const) {
		test(`auto-close on ${status} still records the real terminal outcome`, async () => {
			const observations = createNativeObservations();
			const canary = "SECRETCODE12";
			const controller = {
				login: async (options?: { onProgress?: (progress: unknown) => void }) => {
					options?.onProgress?.({
						phase: "waiting",
						verificationUri: "https://cloud.example/device",
						userCode: canary,
					});
					return { status };
				},
				status: async () => ({ status: "signed-in" }),
				logout: async () => ({ status: "signed-out" }),
				dispose: async () => {},
			};
			const { ui, closed } = fakeUi();
			const flow = createCloudAuthHandlers({
				getController: () => wrapObservedController(controller, observations),
				ui,
			});

			expect(await flow.login()).toEqual({ status });
			expect(observations.terminalOutcome).toBe(status);
			expect(closed.count).toBe(1);
			expect(JSON.stringify(observations)).not.toContain(canary);
		});
	}

	test("response sanitizer records only allowlisted names and a fixed error category", () => {
		const body = JSON.stringify({
			accessToken: "SECRET-TOKEN",
			refreshToken: "SECRET-REFRESH",
			expiresAt: 123,
			DYNAMIC_SECRET_KEY: "SECRET-VALUE",
			error: { code: "rate-limited", message: "SECRET-MESSAGE" },
		});
		const sanitized = sanitizeNativeResponseText(body);
		expect(sanitized.fields.sort()).toEqual(["accessToken", "error", "expiresAt", "refreshToken"]);
		expect(sanitized.unknownKeyCount).toBe(1);
		expect(sanitized.errorCategory).toBe("omitted-by-wire-allowlist");
		const serialized = JSON.stringify(sanitized);
		for (const secret of ["SECRET-TOKEN", "SECRET-REFRESH", "SECRET-VALUE", "SECRET-MESSAGE", "DYNAMIC_SECRET_KEY", "rate-limited"]) {
			expect(serialized).not.toContain(secret);
		}
	});

	test("observations initialize with explicit unknowns, never inferred commit", () => {
		const observations = createNativeObservations();
		expect(observations.terminalOutcome).toBe("unknown");
		expect(observations.statusResult).toBe("unknown");
		expect(observations.preLogoutStatusResult).toBe("unknown");
		expect(observations.postLogoutStatusResult).toBe("unknown");
		expect(observations.lastStatusResult).toBe("unknown");
		expect(observations.alertStatusResult).toBe("unknown");
		expect(observations.events).toEqual([]);
		expect(observations.vaultCommitOutcome).toBe("not-observed");
		expect(observations.beginStatus).toBeNull();
		expect(observations.pollLastStatus).toBeNull();
		expect(observations.tokenStatus).toBeNull();
	});
});

describe("bounded owner status evidence", () => {
	function evidenceUi(observations: ReturnType<typeof createNativeObservations>) {
		const state = { alerts: 0 };
		const ui = {
			showLoginDialog() {
				return { update() {}, close() {} };
			},
			alert: async () => {
				state.alerts += 1;
				recordAlertObservation(observations);
			},
			confirm: async () => true,
			selectAction: async () => undefined,
			toast: () => {},
		};
		return { state, ui };
	}

	function signedInController() {
		return {
			login: async () => ({ status: "signed-in" }),
			status: async () => ({ status: "signed-in" }),
			logout: async () => ({ status: "signed-out" }),
			dispose: async () => {},
		};
	}

	test("explicit owner status is command-proven and survives a later logout", async () => {
		const observations = createNativeObservations();
		const context = { action: "none" };
		const { state, ui } = evidenceUi(observations);
		const flow = createCloudAuthHandlers({
			getController: () => wrapObservedController(signedInController(), observations, context),
			ui,
		});

		context.action = "status";
		expect(await flow.status()).toEqual({ status: "signed-in" });
		expect(state.alerts).toBe(1);
		expect(observations.statusResult).toBe("signed-in");
		expect(observations.alertStatusResult).toBe("signed-in");

		const ownerIndex = observations.events.indexOf("status:owner");
		const alertIndex = observations.events.indexOf("alert:observed");
		expect(ownerIndex).toBeGreaterThanOrEqual(0);
		expect(alertIndex).toBeGreaterThan(ownerIndex);

		context.action = "logout";
		observations.preLogoutStatusResult = observations.statusResult;
		expect(await flow.logout()).toEqual({ status: "signed-out" });
		expect(observations.terminalOutcome).toBe("signed-out");
		expect(observations.statusResult).toBe("signed-in");
		expect(observations.preLogoutStatusResult).toBe("signed-in");
		expect(observations.alertStatusResult).toBe("signed-in");
	});

	test("a post-logout explicit status never erases pre-logout evidence", async () => {
		const observations = createNativeObservations();
		const context = { action: "none" };
		const { ui } = evidenceUi(observations);
		let signedIn = true;
		const controller = {
			login: async () => ({ status: "signed-in" }),
			status: async () => ({ status: signedIn ? "signed-in" : "signed-out" }),
			logout: async () => {
				signedIn = false;
				return { status: "signed-out" };
			},
			dispose: async () => {},
		};
		const flow = createCloudAuthHandlers({
			getController: () => wrapObservedController(controller, observations, context),
			ui,
		});

		context.action = "status";
		await flow.status();
		context.action = "logout";
		observations.preLogoutStatusResult = observations.statusResult;
		await flow.logout();
		context.action = "status";
		expect(await flow.status()).toEqual({ status: "signed-out" });

		expect(observations.statusResult).toBe("signed-in");
		expect(observations.preLogoutStatusResult).toBe("signed-in");
		expect(observations.postLogoutStatusResult).toBe("signed-out");
		expect(observations.events).toContain("status:post-logout");
		expect(observations.terminalOutcome).toBe("signed-out");
	});

	test("real wiring command path preserves pre-logout status across a later status", async () => {
		const observations = createNativeObservations();
		const commandContext = { action: "none" };
		let bytes: Uint8Array | null = null;
		const vault = {
			async read() {
				return bytes === null ? null : new Uint8Array(bytes);
			},
			async write(_entry: unknown, secret: Uint8Array) {
				bytes = new Uint8Array(secret);
			},
			async remove() {
				const had = bytes !== null;
				bytes = null;
				return had;
			},
		};
		const store = new CredentialStore({
			vault,
			entry: { service: "sessionport-m3-test", account: "credential" },
			maxCredentialBytes: 4096,
		});
		await store.writeReady({
			accessToken: Buffer.alloc(32, 1).toString("base64url"),
			refreshToken: Buffer.alloc(32, 2).toString("base64url"),
			accessExpiresAtMillis: Date.now() + 60_000,
			scope: "test",
		});

		let commands: Array<{ id: string; run: (input?: string) => Promise<void> }> = [];
		const context = {
			client: {},
			location: { directory: HERE },
			theme: {},
			options: {
				sessionportCloud: {
					origin: "http://127.0.0.1:43117",
					allowLoopbackHttp: true,
					requestTimeoutMillis: 1000,
					maxResponseBytes: 4096,
					maxCredentialBytes: 4096,
					maxSecretBytes: 4096,
					vaultService: "sessionport-m3-test",
					vaultAccount: "credential",
					stateDirectory: HERE,
				},
			},
			ui: {
				dialog: {
					alert: async () => {
						recordAlertObservation(observations);
					},
					confirm: async () => true,
					clear: () => {},
					select: async () => undefined,
					set: () => {},
					show: () => {},
				},
				toast: { show: () => {} },
				slot: (options: { render: () => unknown }) => {
					options.render();
					return () => {};
				},
			},
			keymap: {
				layer: (factory: () => { commands: typeof commands }) => {
					commands = factory().commands;
					return () => {};
				},
			},
		};

		const factory = createObservedCloudAuthFactory(
			{
				cloudAuthModule: { parseCloudAuthSyncAction },
				flowModule: { createCloudAuthHandlers },
				dialogModule: { createCloudAuthUi },
				controllerModule: { createCloudAuthController },
			},
			observations,
			commandContext,
			{
				createVault: async () => vault,
				acquireOwner: async () => ({ release: async () => {} }),
			},
		);
		const dispose = await installSessionPortWiring(context as never, {
			createCryptoFactory: async () => ({ create: async () => ({}) }) as never,
			createIdDeriver: async () => ({ derive: async () => "" }) as never,
			createCloudAuth: factory,
		});
		expect(typeof dispose).toBe("function");

		const sync = commands.find((command) => command.id === SESSIONPORT_COMMAND_IDS.sync);
		expect(sync).toBeDefined();
		await sync!.run("status");
		expect(observations.statusResult).toBe("signed-in");
		await sync!.run("logout");
		expect(observations.preLogoutStatusResult).toBe("signed-in");
		await sync!.run("status");
		expect(observations.postLogoutStatusResult).toBe("signed-out");
		expect(observations.statusResult).toBe("signed-in");
		expect(observations.terminalOutcome).toBe("signed-out");
		await dispose?.();
	});

	test("login preflight signed-out is not recorded as owner status", async () => {
		const observations = createNativeObservations();
		const context = { action: "login" };
		const { state, ui } = evidenceUi(observations);
		const controller = {
			login: async () => ({ status: "signed-in" }),
			status: async () => ({ status: "signed-out" }),
			logout: async () => ({ status: "signed-out" }),
			dispose: async () => {},
		};
		const flow = createCloudAuthHandlers({
			getController: () => wrapObservedController(controller, observations, context),
			ui,
		});

		expect(await flow.login()).toEqual({ status: "signed-in" });
		expect(state.alerts).toBe(0);
		expect(observations.statusResult).toBe("unknown");
		expect(observations.lastStatusResult).toBe("signed-out");
		expect(observations.loginOutcome).toBe("signed-in");
		expect(observations.terminalOutcome).toBe("signed-in");
		expect(observations.events).toContain("status:internal:login");
		expect(observations.events).not.toContain("status:owner");
	});

	test("menu-dispatched status is labelled observation-only, not owner-proven", async () => {
		const observations = createNativeObservations();
		const context = { action: "usage" };
		const { ui } = evidenceUi(observations);
		const flow = createCloudAuthHandlers({
			getController: () => wrapObservedController(signedInController(), observations, context),
			ui,
		});

		expect(await flow.status()).toEqual({ status: "signed-in" });
		expect(observations.statusResult).toBe("unknown");
		expect(observations.alertStatusResult).toBe("signed-in");
		expect(observations.events).toContain("status:internal:usage");
		expect(observations.events).not.toContain("status:owner");
	});

	test("status ownership is snapshotted before an await, not read after it", async () => {
		const observations = createNativeObservations();
		const context = { action: "status" };
		let resolveStatus!: (value: { status: string }) => void;
		const wrapped = wrapObservedController(
			{
				status: () =>
					new Promise((resolve) => {
						resolveStatus = resolve;
					}),
			},
			observations,
			context,
		);

		const pending = wrapped.status();
		context.action = "logout";
		resolveStatus({ status: "signed-in" });
		await pending;

		expect(observations.statusResult).toBe("signed-in");
		expect(observations.events).toContain("status:owner");
		expect(observations.events).not.toContain("status:internal:logout");
	});

	test("events stay bounded and reject raw controller text", async () => {
		const observations = createNativeObservations();
		const wrapped = wrapObservedController(
			{ status: async () => ({ status: "RAW-STATUS-CANARY" }) },
			observations,
		);
		for (let index = 0; index < 40; index += 1) await wrapped.status();
		recordAlertObservation(observations);

		expect(observations.lastStatusResult).toBe("unknown");
		expect(observations.events.length).toBe(MAX_OBSERVED_EVENTS);
		expect(JSON.stringify(observations)).not.toContain("RAW-STATUS-CANARY");
	});
});

describe("interactive console TUI launch", () => {
	const runner = readFileSync(RUNNER, "utf8");
	const helperStart = runner.indexOf("function Start-ProbeChildProcess {");
	const helperEnd = runner.indexOf("function Parse-DebugPaths {");
	const helper = runner.slice(helperStart, helperEnd);
	const interactiveStart = helper.indexOf("if ($InteractiveConsole) {");
	const interactiveEnd = helper.indexOf("} else {", interactiveStart);
	const interactiveBlock = helper.slice(interactiveStart, interactiveEnd);

	test("native TUI inherits parent stdin/stdout/stderr with no capture/drain", () => {
		expect(helper).toContain("[switch]$InteractiveConsole");
		expect(interactiveBlock).toContain("$psi.RedirectStandardInput = $false");
		expect(interactiveBlock).toContain("$psi.RedirectStandardOutput = $false");
		expect(interactiveBlock).toContain("$psi.RedirectStandardError = $false");
		expect(interactiveBlock).not.toContain(".StandardOutput");
		expect(interactiveBlock).not.toContain(".StandardError");
		expect(interactiveBlock).not.toContain("BoundedStreamDrain");
		expect(interactiveBlock).not.toContain("Stream]::Null");
	});

	test("interactive mode is used only at the native TUI launch", () => {
		const sites = runner.match(/-InteractiveConsole:\(\$script:NativeSyncValidation\)/g) ?? [];
		expect(sites.length).toBe(1);
		expect(runner).toContain("$tuiLaunch = Start-ProbeChildProcess -EnvMap $envMap -FilePath $resolved -Arguments $tuiArgs -WorkingDirectory $projectDir -InteractiveConsole:($script:NativeSyncValidation)");
		expect(runner).toContain('Start-ProbeChildProcess -EnvMap $envMap -FilePath $resolved -Arguments @("debug", "paths") -WorkingDirectory $projectDir -CaptureStdOut');
		expect(runner).not.toContain("CreateNoWindow");
		expect(runner).not.toContain("NoNewWindow");
	});

	test("default debug/default capture path keeps bounded redirection", () => {
		expect(helper).toContain("$psi.RedirectStandardOutput = $true");
		expect(helper).toContain("$psi.RedirectStandardError = $true");
		expect(helper).toContain("[SessionPortProbe.BoundedStreamDrain]::new");
		expect(runner).not.toContain("$psi.RedirectStandardInput = $true");
	});

	test("native mode resolves the explicit .exe and gates version 2.1.1 before launch", () => {
		expect(runner).toContain('$NativeSyncExpectedVersion = "2.1.1"');
		expect(runner).toContain("opencode\\cli\\bin\\opencode.exe");
		expect(runner).toContain("Resolve-NativeSyncOpenCodeExe");
		expect(runner).toContain("Get-NativeSyncOpenCodeVersion");
		expect(runner).toContain("versionGate.Ok -ne $true");
		expect(runner).not.toContain("terminal-process-bridge");
	});
});

describe.skipIf(!HAS_POWERSHELL)("validation-only default is NOT-STARTED", () => {
	/**
	 * Additive Windows PowerShell 5.1 environment normalization for the child
	 * runner. CI executes `bun test` under pwsh 7; `powershell.exe` must be able
	 * to resolve its own module and executable paths. Only canonical existing
	 * entries are prepended; nothing is removed and the runner's exit code is
	 * still the sole pass/fail signal.
	 */
	function normalizedChildEnvironment(): Record<string, string> {
		const env: Record<string, string> = {};
		for (const [key, value] of Object.entries(process.env)) {
			if (typeof value === "string") env[key] = value;
		}
		const systemRoot = process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows";
		const system32 = join(systemRoot, "System32");
		const shellDirectory = join(system32, "WindowsPowerShell", "v1.0");
		const prepend = (name: string, entry: string): void => {
			let key = name;
			for (const existing of Object.keys(env)) {
				if (existing.toLowerCase() === name.toLowerCase()) {
					key = existing;
					break;
				}
			}
			const current = env[key];
			const entries = (current ?? "").split(";").filter((part) => part.length > 0);
			if (entries.some((part) => part.toLowerCase() === entry.toLowerCase())) return;
			env[key] = current === undefined || current.length === 0 ? entry : `${entry};${current}`;
		};
		prepend("PATH", shellDirectory);
		prepend("PATH", system32);
		prepend("PSModulePath", join(shellDirectory, "Modules"));
		return env;
	}

	/** Bounded, fixed-shape diagnostic; no credentials, prompts, or env dumps. */
	function reportIfFailed(result: { code: number; out: string }, label: string): void {
		if (result.code === 0) return;
		const bounded = result.out.replace(/\u001b\[[0-9;]*m/g, "").slice(0, 4000);
		console.error(
			`[validation-runner-diagnostic] ${label} exit=${result.code}\n${bounded}\n[/validation-runner-diagnostic]`,
		);
	}

	function runValidation(extra: string[], label: string): { code: number; out: string } {
		const result = Bun.spawnSync(
			[
				"powershell.exe",
				"-NoProfile",
				"-ExecutionPolicy",
				"Bypass",
				"-File",
				RUNNER,
				...extra,
			],
			{
				cwd: join(HERE, "..", "..", ".."),
				env: normalizedChildEnvironment(),
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const output = {
			code: result.exitCode ?? 1,
			out: `${result.stdout.toString()}\n${result.stderr.toString()}`,
		};
		reportIfFailed(output, label);
		return output;
	}

	test("default mode validates without launching", () => {
		const result = runValidation([], "default");
		expect(result.code).toBe(0);
		expect(result.out).toContain("run: NOT-STARTED");
		expect(result.out).toContain("root prefix: sp-command-");
		expect(result.out).toContain("VALIDATION-OK");
	}, 120000);

	test("native mode validates fixed staging and pinned keyring without launching", () => {
		const result = runValidation(["-NativeSyncValidation"], "native-sync-validation");
		expect(result.code).toBe(0);
		expect(result.out).toContain("run: NOT-STARTED");
		expect(result.out).toContain("native-sync-validation");
		expect(result.out).toContain("pinned @napi-rs/keyring@2.1.2");
		expect(result.out).toContain("owner window: 180s");
		expect(result.out).toContain("root prefix: sp-native-sync-");
		expect(result.out).toContain("VALIDATION-OK");
	}, 120000);
});
