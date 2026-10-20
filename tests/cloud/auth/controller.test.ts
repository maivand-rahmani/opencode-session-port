import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import {
	createCloudAuthController,
	type CloudAuthControllerDependencies,
	type CloudAuthOwner,
} from "../../../src/cloud/auth/controller.ts";
import type { NativeFetch } from "../../../src/cloud/auth/client.ts";
import type { CloudAuthConfig } from "../../../src/cloud/auth/configuration.ts";
import type {
	SecureVault,
	VaultEntry,
	VaultOperationOptions,
} from "../../../src/cloud/vault/types.ts";

const ORIGIN = "https://api.example.test";
const VERIFY_URI = `${ORIGIN}/api/native/v1/device-authorizations/verify`;
const SERVICE = "sessionport-controller-test";
const ACCOUNT = "native-credential";
const ENTRY: VaultEntry = { service: SERVICE, account: ACCOUNT };
const OTHER_ENTRY: VaultEntry = {
	service: SERVICE,
	account: "other-entry",
};
const NOW = 1_700_000_000_000;
const USER_CODE = "0123456789AB";
const DEVICE_CODE = token(1);
const ACCESS_TOKEN = token(10);
const REFRESH_TOKEN = token(11);
const NEW_ACCESS_TOKEN = token(20);
const NEW_REFRESH_TOKEN = token(21);

function token(seed: number): string {
	return Buffer.alloc(32, seed).toString("base64url");
}

function validConfig(
	overrides: Partial<CloudAuthConfig> = {},
): CloudAuthConfig {
	return {
		origin: ORIGIN,
		requestTimeoutMillis: 1_000,
		maxResponseBytes: 65_536,
		maxCredentialBytes: 4_096,
		maxSecretBytes: 8_192,
		vaultService: SERVICE,
		vaultAccount: ACCOUNT,
		stateDirectory: path.resolve("sessionport-controller-state"),
		...overrides,
	};
}

function json(
	body: unknown,
	status = 200,
	headers: Record<string, string> = {},
): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});
}

function errorEnvelope(
	code: string,
	status = 400,
	retryAfter?: string,
): Response {
	return json(
		{
			error: {
				code,
				message: "secret server detail",
				retryable: false,
				requestID: "request-id",
			},
		},
		status,
		retryAfter === undefined ? {} : { "retry-after": retryAfter },
	);
}

function beginBody(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		deviceCode: DEVICE_CODE,
		userCode: USER_CODE,
		verificationUri: VERIFY_URI,
		expiresIn: 600,
		pollInterval: 5,
		...overrides,
	};
}

function tokenBody(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		accessToken: NEW_ACCESS_TOKEN,
		tokenType: "Bearer",
		expiresIn: 60,
		refreshToken: NEW_REFRESH_TOKEN,
		scope: "projects:read projects:write",
		...overrides,
	};
}

function storedCredential(
	expiresAtMillis = NOW + 60_000,
): Record<string, unknown> {
	return {
		version: 1,
		state: "ready",
		accessToken: ACCESS_TOKEN,
		refreshToken: REFRESH_TOKEN,
		accessExpiresAtMillis: expiresAtMillis,
		scope: "projects:read",
	};
}

class FakeClock {
	wall = NOW;
	monotonic = 1_000;
	readonly sleepCalls: number[] = [];

	readonly wallNow = (): number => this.wall;
	readonly monotonicNow = (): number => this.monotonic;

	readonly sleep = async (
		milliseconds: number,
		signal: AbortSignal,
	): Promise<void> => {
		this.sleepCalls.push(milliseconds);
		if (signal.aborted) return;
		this.monotonic += milliseconds;
		await Promise.resolve();
	};
}

class MemoryVault implements SecureVault {
	readonly entries = new Map<string, Uint8Array>();
	readonly events: string[];
	readCalls = 0;
	writeCalls = 0;
	removeCalls = 0;
	failWrite: unknown;
	failRead: unknown;
	beforeWrite: ((call: number) => Promise<void>) | undefined;

	constructor(events: string[]) {
		this.events = events;
	}

	key(entry: VaultEntry): string {
		return `${entry.service}\u0000${entry.account}`;
	}

	seed(entry: VaultEntry, value: unknown): void {
		this.entries.set(
			this.key(entry),
			new TextEncoder().encode(JSON.stringify(value)),
		);
	}

	async read(
		entry: VaultEntry,
		options?: VaultOperationOptions,
	): Promise<Uint8Array | null> {
		void options;
		this.readCalls += 1;
		this.events.push("read");
		if (this.failRead !== undefined) throw this.failRead;
		const value = this.entries.get(this.key(entry));
		return value === undefined ? null : new Uint8Array(value);
	}

	async write(
		entry: VaultEntry,
		secret: Uint8Array,
		options?: VaultOperationOptions,
	): Promise<void> {
		void options;
		const call = (this.writeCalls += 1);
		this.events.push(`write-start-${call}`);
		await this.beforeWrite?.(call);
		if (this.failWrite !== undefined) {
			this.events.push(`write-fail-${call}`);
			throw this.failWrite;
		}
		this.entries.set(this.key(entry), new Uint8Array(secret));
		this.events.push(`write-end-${call}`);
	}

	async remove(
		entry: VaultEntry,
		options?: VaultOperationOptions,
	): Promise<boolean> {
		void options;
		this.removeCalls += 1;
		this.events.push("remove");
		return this.entries.delete(this.key(entry));
	}
}

type Handler = (
	call: number,
	url: string,
	init: RequestInit,
) => Promise<Response> | Response;

class FakeFetch {
	readonly calls: Array<{ url: string; init: RequestInit }> = [];
	private readonly handler: Handler;
	private readonly events: string[];

	constructor(handler: Handler, events: string[] = []) {
		this.handler = handler;
		this.events = events;
	}

	readonly fetch: NativeFetch = async (url, init) => {
		this.calls.push({ url, init });
		this.events.push("fetch");
		return this.handler(this.calls.length, url, init);
	};
}

class FakeOwner implements CloudAuthOwner {
	releaseCalls = 0;
	readonly events: string[];
	releaseGate: Promise<void> | null = null;
	failRelease: unknown;

	constructor(events: string[]) {
		this.events = events;
	}

	async release(): Promise<void> {
		this.releaseCalls += 1;
		this.events.push("release");
		if (this.failRelease !== undefined) throw this.failRelease;
		await this.releaseGate;
	}
}

interface SetupOptions {
	config?: unknown;
	handler?: Handler;
	clock?: FakeClock;
	vault?: MemoryVault;
	acquireOwner?: () => Promise<CloudAuthOwner>;
	createVault?: (config: CloudAuthConfig) => Promise<SecureVault>;
	sleep?: (
		milliseconds: number,
		signal: AbortSignal,
	) => Promise<void>;
}

function setup(options: SetupOptions = {}) {
	const events: string[] = [];
	const clock = options.clock ?? new FakeClock();
	const vault = options.vault ?? new MemoryVault(events);
	const owner = new FakeOwner(events);
	const fake = new FakeFetch(
		options.handler ?? (() => json(tokenBody())),
		events,
	);
	let acquireCalls = 0;
	let createVaultCalls = 0;

	const deps: CloudAuthControllerDependencies = {
		fetch: fake.fetch,
		wallNow: clock.wallNow,
		monotonicNow: clock.monotonicNow,
		sleep: options.sleep ?? clock.sleep,
		acquireOwner: async () => {
			acquireCalls += 1;
			events.push("acquire");
			if (options.acquireOwner !== undefined) {
				return options.acquireOwner();
			}
			return owner;
		},
		createVault: async (config) => {
			createVaultCalls += 1;
			events.push("vault");
			if (options.createVault !== undefined) {
				return options.createVault(config);
			}
			return vault;
		},
	};

	const controller = createCloudAuthController(
		options.config === undefined ? validConfig() : options.config,
		deps,
	);

	return {
		controller,
		clock,
		vault,
		owner,
		fake,
		events,
		get acquireCalls() {
			return acquireCalls;
		},
		get createVaultCalls() {
			return createVaultCalls;
		},
	};
}

function approvedHandler(
	overrides: Record<string, unknown> = {},
): Handler {
	return (_call, url) =>
		url.endsWith("/device-authorizations")
			? json(beginBody())
			: json(tokenBody(overrides));
}

function blockingSleep(): {
	sleep: (
		milliseconds: number,
		signal: AbortSignal,
	) => Promise<void>;
	calls: number[];
} {
	const calls: number[] = [];
	return {
		calls,
		sleep: (milliseconds, signal) =>
			new Promise<void>((resolve) => {
				calls.push(milliseconds);
				if (signal.aborted) {
					resolve();
					return;
				}
				signal.addEventListener("abort", () => resolve(), {
					once: true,
				});
			}),
	};
}

async function waitFor(
	condition: () => boolean,
	timeoutMillis = 2_000,
): Promise<void> {
	const started = Date.now();
	while (!condition()) {
		if (Date.now() - started > timeoutMillis) {
			throw new Error("timed out waiting for condition");
		}
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
}

function vaultBytes(vault: MemoryVault): string | null {
	const value = vault.entries.get(vault.key(ENTRY));
	return value === undefined ? null : new TextDecoder().decode(value);
}

describe("cloud auth controller configuration and ownership", () => {
	test("absent configuration disables every operation without deps access", async () => {
		let touches = 0;
		const deps = {};
		for (const key of [
			"fetch",
			"wallNow",
			"monotonicNow",
			"sleep",
			"createVault",
			"acquireOwner",
		]) {
			Object.defineProperty(deps, key, {
				enumerable: true,
				get() {
					touches += 1;
					throw new Error("dependency touched");
				},
			});
		}

		const controller = createCloudAuthController(
			undefined,
			deps as CloudAuthControllerDependencies,
		);
		expect(await controller.status()).toEqual({
			status: "unconfigured",
		});
		expect(await controller.login()).toEqual({
			status: "unavailable",
		});
		expect(await controller.logout()).toEqual({
			status: "signed-out",
		});
		await controller.dispose();
		expect(touches).toBe(0);
	});

	test("invalid configuration fails before reading any dependency", async () => {
		let touches = 0;
		const deps = {};
		Object.defineProperty(deps, "acquireOwner", {
			enumerable: true,
			get() {
				touches += 1;
				throw new Error("dependency touched");
			},
		});

		const controller = createCloudAuthController(
			{
				...validConfig(),
				origin: "http://api.example.test",
			},
			deps as CloudAuthControllerDependencies,
		);
		expect(await controller.status()).toEqual({
			status: "unavailable",
		});
		expect(await controller.login()).toEqual({
			status: "unavailable",
		});
		expect(await controller.logout()).toEqual({
			status: "unavailable",
		});
		expect(touches).toBe(0);
	});

	test("owner-busy maps to busy and never creates a vault or request", async () => {
		const { controller, fake, events } = setup({
			acquireOwner: async () => {
				throw Object.assign(new Error("busy"), {
					code: "owner-busy",
				});
			},
		});

		expect(await controller.status()).toEqual({ status: "busy" });
		expect(await controller.login()).toEqual({ status: "busy" });
		expect(fake.calls).toHaveLength(0);
		expect(events).not.toContain("vault");
	});

	test("owner failures map to unavailable without a token fallback", async () => {
		const { controller, fake } = setup({
			acquireOwner: async () => {
				throw Object.assign(new Error("unavailable"), {
					code: "owner-unavailable",
				});
			},
		});

		expect(await controller.status()).toEqual({
			status: "unavailable",
		});
		expect(await controller.login()).toEqual({
			status: "unavailable",
		});
		expect(fake.calls).toHaveLength(0);
	});

	test("acquires ownership before creating the vault and before any request", async () => {
		const { controller, events, fake } = setup({
			handler: approvedHandler(),
		});

		expect(await controller.status()).toEqual({
			status: "signed-out",
		});
		expect(await controller.login()).toEqual({ status: "signed-in" });

		const acquire = events.indexOf("acquire");
		const vault = events.indexOf("vault");
		const write = events.findIndex((event) =>
			event.startsWith("write-start"),
		);
		const fetch = events.indexOf("fetch");
		expect(acquire).toBeGreaterThanOrEqual(0);
		expect(acquire).toBeLessThan(vault);
		expect(vault).toBeLessThan(fetch);
		expect(vault).toBeLessThan(write);
		expect(fake.calls.length).toBe(2);
	});

	test("a binding failure is unavailable and releases the owner", async () => {
		const { controller, owner, fake } = setup({
			createVault: async () => {
				throw new Error("binding missing");
			},
		});

		expect(await controller.status()).toEqual({
			status: "unavailable",
		});
		expect(owner.releaseCalls).toBe(1);
		expect(await controller.login()).toEqual({
			status: "unavailable",
		});
		expect(fake.calls).toHaveLength(0);
	});
});

describe("cloud auth controller local status and logout", () => {
	test("local status never fetches and maps stored states", async () => {
		const { controller, vault, fake } = setup();

		expect(await controller.status()).toEqual({
			status: "signed-out",
		});
		vault.seed(ENTRY, storedCredential());
		expect(await controller.status()).toEqual({ status: "signed-in" });
		expect(fake.calls).toHaveLength(0);

		vault.seed(ENTRY, storedCredential(NOW - 1));
		expect(await controller.status()).toEqual({ status: "signed-in" });
		expect(fake.calls).toHaveLength(0);

		vault.seed(ENTRY, { version: 1, state: "refresh-uncertain" });
		expect(await controller.status()).toEqual({
			status: "reauth-required",
		});
		vault.seed(ENTRY, { version: 1, state: "unauthorized" });
		expect(await controller.status()).toEqual({
			status: "reauth-required",
		});
		expect(fake.calls).toHaveLength(0);
	});

	test("corrupt store state is reauth-required, not a network refresh", async () => {
		const { controller, vault, fake } = setup();
		vault.entries.set(
			vault.key(ENTRY),
			new TextEncoder().encode("not-json"),
		);
		expect(await controller.status()).toEqual({
			status: "reauth-required",
		});
		expect(fake.calls).toHaveLength(0);
	});

	test("logout removes only the exact entry and never calls the server", async () => {
		const { controller, vault, fake } = setup({
			handler: approvedHandler(),
		});
		vault.seed(ENTRY, storedCredential());
		vault.seed(OTHER_ENTRY, storedCredential());
		const fetchesBefore = fake.calls.length;

		expect(await controller.logout()).toEqual({
			status: "signed-out",
		});
		expect(fake.calls).toHaveLength(fetchesBefore);
		expect(vault.entries.has(vault.key(ENTRY))).toBe(false);
		expect(vault.entries.has(vault.key(OTHER_ENTRY))).toBe(true);
		expect(await controller.status()).toEqual({
			status: "signed-out",
		});
	});

	test("logout cancels and awaits the login poll before deleting", async () => {
		const gate = blockingSleep();
		const { controller, vault, events, fake } = setup({
			sleep: gate.sleep,
			handler: (_call, url) =>
				url.endsWith("/device-authorizations")
					? json(beginBody())
					: errorEnvelope("authorization-pending"),
		});
		vault.seed(ENTRY, storedCredential());
		const progress: string[] = [];

		const login = controller.login({
			onProgress: (value) => progress.push(value.phase),
		});
		await waitFor(() => gate.calls.length > 0);
		const fetchesBeforeLogout = fake.calls.length;
		const logout = controller.logout();

		expect(await login).toEqual({ status: "cancelled" });
		expect(await logout).toEqual({ status: "signed-out" });
		expect(progress).toContain("cancelled");
		expect(fake.calls).toHaveLength(fetchesBeforeLogout);
		expect(vault.entries.has(vault.key(ENTRY))).toBe(false);
		expect(events.filter((event) => event === "remove")).toHaveLength(1);
	});
});

describe("cloud auth controller login flow", () => {
	test("approved login persists before reporting signed-in and leaks no codes", async () => {
		const { controller, vault, fake, events } = setup({
			handler: approvedHandler(),
		});
		const progress: Array<Record<string, unknown>> = [];

		const outcome = await controller.login({
			onProgress: (value) => {
				progress.push(value as Record<string, unknown>);
			},
		});

		expect(outcome).toEqual({ status: "signed-in" });
		expect(progress.map((value) => value.phase)).toEqual([
			"starting",
			"waiting",
			"approved",
		]);
		expect(progress[1]).toEqual({
			phase: "waiting",
			verificationUri: VERIFY_URI,
			userCode: USER_CODE,
			expiresIn: 600,
		});
		expect(Object.keys(progress[1]!)).not.toContain("deviceCode");
		expect(JSON.stringify(progress)).not.toContain(DEVICE_CODE);
		expect(JSON.stringify(progress)).not.toContain(NEW_ACCESS_TOKEN);
		expect(JSON.stringify(progress)).not.toContain(NEW_REFRESH_TOKEN);

		const persisted = vaultBytes(vault);
		expect(persisted).not.toBeNull();
		expect(persisted).toContain(NEW_ACCESS_TOKEN);
		expect(persisted).toContain(NEW_REFRESH_TOKEN);
		expect(persisted).not.toContain(DEVICE_CODE);
		expect(persisted).not.toContain(USER_CODE);
		expect(fake.calls).toHaveLength(2);
		expect(events.filter((event) => event.startsWith("write-start"))).toHaveLength(
			1,
		);

		expect(await controller.status()).toEqual({ status: "signed-in" });
	});

	test("store failure leaves no fake success and reports reauth-required", async () => {
		const { controller, vault } = setup({
			handler: approvedHandler(),
		});
		vault.failWrite = new Error("vault write failed");
		const progress: string[] = [];

		const outcome = await controller.login({
			onProgress: (value) => progress.push(value.phase),
		});
		expect(outcome).toEqual({ status: "reauth-required" });
		expect(progress).not.toContain("approved");
		expect(progress).toContain("unavailable");
		expect(await controller.status()).toEqual({
			status: "signed-out",
		});
	});

	test("denied, expired, and consumed authorizations are terminal", async () => {
		const cases: Array<[string, string]> = [
			["authorization-denied", "denied"],
			["authorization-expired", "expired"],
			["authorization-consumed", "expired"],
		];

		for (const [code, expected] of cases) {
			const { controller, fake } = setup({
				handler: (_call, url) =>
					url.endsWith("/device-authorizations")
						? json(beginBody())
						: errorEnvelope(code),
			});
			const progress: string[] = [];
			const outcome = await controller.login({
				onProgress: (value) => progress.push(value.phase),
			});
			expect(outcome).toEqual({ status: expected });
			expect(progress.at(-1)).toBe(expected);
			expect(progress).not.toContain("waiting-code");
			expect(fake.calls).toHaveLength(2);
		}
	});

	test("only one login flow is active at a time", async () => {
		const gate = blockingSleep();
		const { controller, fake } = setup({
			sleep: gate.sleep,
			handler: (_call, url) =>
				url.endsWith("/device-authorizations")
					? json(beginBody())
					: errorEnvelope("authorization-pending"),
		});
		const abort = new AbortController();
		const first = controller.login({ signal: abort.signal });
		await waitFor(() => gate.calls.length > 0);

		expect(await controller.login()).toEqual({ status: "busy" });
		expect(fake.calls).toHaveLength(1);

		abort.abort();
		expect(await first).toEqual({ status: "cancelled" });
		expect(fake.calls).toHaveLength(1);
	});

	test("caller cancellation after pending drops the flow without retry", async () => {
		const gate = blockingSleep();
		const { controller, fake } = setup({
			sleep: gate.sleep,
			handler: (_call, url) =>
				url.endsWith("/device-authorizations")
					? json(beginBody())
					: errorEnvelope("authorization-pending"),
		});
		const abort = new AbortController();
		const progress: string[] = [];
		const login = controller.login({
			signal: abort.signal,
			onProgress: (value) => progress.push(value.phase),
		});
		await waitFor(() => gate.calls.length > 0);
		const callsBefore = fake.calls.length;

		abort.abort();
		expect(await login).toEqual({ status: "cancelled" });
		expect(progress.at(-1)).toBe("cancelled");
		expect(progress).not.toContain("approved");
		expect(fake.calls).toHaveLength(callsBefore);
	});

	test("onProgress exceptions are ignored and do not corrupt success", async () => {
		const { controller, vault } = setup({
			handler: approvedHandler(),
		});

		const outcome = await controller.login({
			onProgress: () => {
				throw new Error("UI callback failed");
			},
		});
		expect(outcome).toEqual({ status: "signed-in" });
		expect(vaultBytes(vault)).toContain(NEW_ACCESS_TOKEN);
	});

	test("slow-down follows the server Retry-After, not a default", async () => {
		const { controller, clock } = setup({
			handler: (call, url) => {
				if (url.endsWith("/device-authorizations")) {
					return json(beginBody());
				}
				if (call === 2) {
					return errorEnvelope(
						"authorization-pending",
						400,
						"2",
					);
				}
				if (call === 3) {
					return errorEnvelope("slow-down", 400, "7");
				}
				return json(tokenBody());
			},
		});

		expect(await controller.login()).toEqual({ status: "signed-in" });
		expect(clock.sleepCalls).toEqual([5_000, 2_000, 7_000]);
	});

	test("a slow-down without Retry-After stops instead of polling tightly", async () => {
		const { controller, clock, fake } = setup({
			handler: (_call, url) =>
				url.endsWith("/device-authorizations")
					? json(beginBody())
					: errorEnvelope("slow-down"),
		});

		expect(await controller.login()).toEqual({
			status: "unavailable",
		});
		expect(fake.calls).toHaveLength(2);
		expect(clock.sleepCalls).toEqual([5_000]);
	});

	test("login deadline uses monotonic time while the wall clock moves", async () => {
		const { controller, clock, fake } = setup({
			handler: (call, url) => {
				if (url.endsWith("/device-authorizations")) {
					return json(beginBody({ expiresIn: 10, pollInterval: 5 }));
				}
				clock.wall += 1_000_000_000;
				return errorEnvelope("authorization-pending");
			},
		});

		expect(await controller.login()).toEqual({ status: "expired" });
		expect(fake.calls).toHaveLength(2);
		expect(clock.sleepCalls).toEqual([5_000]);
		expect(clock.wall).toBe(NOW + 1_000_000_000);
	});
});

describe("cloud auth controller disposal and races", () => {
	test("dispose waits for a pending credential write before releasing ownership", async () => {
		const { controller, vault, owner, events } = setup({
			handler: approvedHandler(),
		});
		let signalWriteStarted: (() => void) | undefined;
		const writeStarted = new Promise<void>((resolve) => {
			signalWriteStarted = resolve;
		});
		let releaseWrite: (() => void) | undefined;
		const writeGate = new Promise<void>((resolve) => {
			releaseWrite = resolve;
		});
		vault.beforeWrite = async () => {
			signalWriteStarted?.();
			await writeGate;
		};

		const login = controller.login();
		await writeStarted;
		const dispose = controller.dispose();
		await Promise.resolve();
		expect(owner.releaseCalls).toBe(0);

		releaseWrite?.();
		expect(await login).toEqual({ status: "signed-in" });
		await dispose;
		expect(owner.releaseCalls).toBe(1);
		expect(events.indexOf("write-end-1")).toBeLessThan(
			events.indexOf("release"),
		);
		expect(await controller.status()).toEqual({
			status: "unavailable",
		});
	});

	test("dispose is idempotent and blocks new logins", async () => {
		const { controller, owner, fake } = setup({
			handler: approvedHandler(),
		});
		expect(await controller.login()).toEqual({ status: "signed-in" });
		const fetches = fake.calls.length;
		expect(owner.releaseCalls).toBe(0);

		const first = controller.dispose();
		const repeated = controller.dispose();
		expect(repeated).toBe(first);
		await first;
		await repeated;
		expect(owner.releaseCalls).toBe(1);
		expect(await controller.login()).toEqual({
			status: "unavailable",
		});
		expect(fake.calls).toHaveLength(fetches);
	});

	test("owner release rejection rejects the cached dispose promise with fixed sanitized copy", async () => {
		const { controller, owner } = setup();
		expect(await controller.status()).toEqual({ status: "signed-out" });
		owner.failRelease = new Error(
			"CANARY raw owner path/token detail",
		);

		const first = controller.dispose();
		const second = controller.dispose();
		expect(second).toBe(first);
		const error = await first.catch((value) => value);
		expect(error).toBeInstanceOf(Error);
		expect(error.message).toBe("Cloud sign-in cleanup failed.");
		expect(error.message).not.toContain("CANARY");
		expect(error.cause).toBeUndefined();
		expect(owner.releaseCalls).toBe(1);

		// Disposed state is retained: no keyring/client reload and no retry.
		expect(await controller.status()).toEqual({
			status: "unavailable",
		});
		const repeated = controller.dispose();
		expect(repeated).toBe(first);
		await expect(repeated).rejects.toThrow(
			"Cloud sign-in cleanup failed.",
		);
		expect(owner.releaseCalls).toBe(1);
	});

	test("dispose during the initial poll cancels without retaining ownership", async () => {
		const gate = blockingSleep();
		const { controller, owner, fake } = setup({
			sleep: gate.sleep,
			handler: (_call, url) =>
				url.endsWith("/device-authorizations")
					? json(beginBody())
					: errorEnvelope("authorization-pending"),
		});
		const login = controller.login();
		await waitFor(() => gate.calls.length > 0);

		const dispose = controller.dispose();
		expect(await login).toEqual({ status: "cancelled" });
		await dispose;
		expect(owner.releaseCalls).toBe(1);
		expect(fake.calls).toHaveLength(1);
	});
});
