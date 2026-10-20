import { describe, expect, test } from "bun:test";
import { CredentialStore } from "../../../src/cloud/auth/credential-store.ts";
import {
	NativeAuthClient,
	type NativeAuthClientConfig,
	type NativeFetch,
} from "../../../src/cloud/auth/client.ts";
import {
	HUMAN_CODE_ALPHABET,
	HUMAN_CODE_LENGTH,
	isCanonicalHumanCode,
	type NativeAuthErrorCode,
	NativeAuthError,
	type TokenCredential,
} from "../../../src/cloud/auth/types.ts";
import type {
	SecureVault,
	VaultEntry,
	VaultOperationOptions,
} from "../../../src/cloud/vault/types.ts";

const ORIGIN = "https://api.example.test";
const VERIFY_URI = `${ORIGIN}/api/native/v1/device-authorizations/verify`;
const ENTRY: VaultEntry = {
	service: "sessionport-auth-test",
	account: "native-client",
};
const OTHER_ENTRY: VaultEntry = {
	service: "sessionport-auth-test",
	account: "other-entry",
};
const NOW = 1_700_000_000_000;
const USER_CODE = "0123456789AB";

function token(seed: number): string {
	return Buffer.alloc(32, seed).toString("base64url");
}

const DEVICE_CODE = token(1);
const ACCESS_TOKEN = token(10);
const REFRESH_TOKEN = token(11);
const NEW_ACCESS_TOKEN = token(20);
const NEW_REFRESH_TOKEN = token(21);

class MemoryVault implements SecureVault {
	readonly entries = new Map<string, Uint8Array>();
	readonly events: string[] = [];
	readCalls = 0;
	writeCalls = 0;
	removeCalls = 0;
	failRead: unknown;
	failWrite: unknown;
	failRemove: unknown;
	failWriteAtCall: number | undefined;
	beforeWrite: ((call: number) => Promise<void>) | undefined;
	beforeRead: ((call: number) => Promise<void>) | undefined;

	key(entry: VaultEntry): string {
		return `${entry.service}\u0000${entry.account}`;
	}

	seed(entry: VaultEntry, bytes: Uint8Array): void {
		this.entries.set(this.key(entry), new Uint8Array(bytes));
	}

	async read(
		entry: VaultEntry,
		options?: VaultOperationOptions,
	): Promise<Uint8Array | null> {
		void options;
		this.readCalls += 1;
		this.events.push("read");
		if (this.failRead !== undefined) throw this.failRead;
		await this.beforeRead?.(this.readCalls);
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
		if (
			this.failWrite !== undefined ||
			this.failWriteAtCall === call
		) {
			this.events.push(`write-fail-${call}`);
			throw this.failWrite ?? new Error("write failed");
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
		if (this.failRemove !== undefined) throw this.failRemove;
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

	constructor(handler: Handler) {
		this.handler = handler;
	}

	readonly fetch: NativeFetch = async (url, init) => {
		this.calls.push({ url, init });
		return this.handler(this.calls.length, url, init);
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
	headers: Record<string, string> = {},
): Response {
	return json(
		{
			error: {
				code,
				message: "secret server message",
				retryable: false,
				requestID: "request-id",
			},
		},
		status,
		headers,
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

function credential(
	overrides: Partial<TokenCredential> = {},
): TokenCredential {
	return {
		accessToken: ACCESS_TOKEN,
		refreshToken: REFRESH_TOKEN,
		accessExpiresAtMillis: NOW + 60_000,
		scope: "projects:read",
		...overrides,
	};
}

function setup(
	handler: Handler,
	options: {
		clock?: () => number;
		timeout?: number;
		maxResponseBytes?: number;
		vault?: MemoryVault;
		store?: CredentialStore;
	} = {},
) {
	const vault = options.vault ?? new MemoryVault();
	const store =
		options.store ??
		new CredentialStore({
			vault,
			entry: ENTRY,
			maxCredentialBytes: 4096,
		});
	const fake = new FakeFetch(handler);
	const client = new NativeAuthClient({
		origin: ORIGIN,
		requestTimeoutMillis: options.timeout ?? 1000,
		maxResponseBytes: options.maxResponseBytes ?? 4096,
		credentials: store,
		fetch: fake.fetch,
		now: options.clock ?? (() => NOW),
	});
	return { vault, store, fake, client };
}

async function expectError(
	promise: Promise<unknown>,
	code: NativeAuthErrorCode,
): Promise<NativeAuthError> {
	try {
		await promise;
	} catch (error) {
		expect(error).toBeInstanceOf(NativeAuthError);
		const native = error as NativeAuthError;
		expect(native.code).toBe(code);
		return native;
	}
	throw new Error(`expected NativeAuthError ${code}`);
}

function expectSyncError(
	action: () => unknown,
	code: NativeAuthErrorCode,
): NativeAuthError {
	try {
		action();
	} catch (error) {
		expect(error).toBeInstanceOf(NativeAuthError);
		const native = error as NativeAuthError;
		expect(native.code).toBe(code);
		return native;
	}
	throw new Error(`expected NativeAuthError ${code}`);
}

function requestBody(call: { init: RequestInit }): unknown {
	return JSON.parse(String(call.init.body));
}

async function waitFor(condition: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	throw new Error("condition was not reached");
}

function abortableResponse(init: RequestInit): Promise<Response> {
	return new Promise<Response>((_resolve, reject) => {
		const signal = init.signal;
		if (signal === undefined || signal === null) {
			reject(new Error("missing abort signal"));
			return;
		}
		if (signal.aborted) {
			reject(new Error("aborted"));
			return;
		}
		signal.addEventListener(
			"abort",
			() => reject(new Error("aborted")),
			{ once: true },
		);
	});
}

function validConfig(
	store: CredentialStore,
	overrides: Partial<NativeAuthClientConfig> = {},
): NativeAuthClientConfig {
	return {
		origin: ORIGIN,
		requestTimeoutMillis: 1000,
		maxResponseBytes: 4096,
		credentials: store,
		fetch: async () => json({}),
		now: () => NOW,
		...overrides,
	};
}

describe("native client origin and configuration", () => {
	test("accepts a canonical origin and rejects non-canonical forms", () => {
		const store = new CredentialStore({
			vault: new MemoryVault(),
			entry: ENTRY,
			maxCredentialBytes: 4096,
		});

		for (const origin of [
			"http://api.example.test",
			"https://api.example.test/",
			"https://api.example.test:443",
			"https://api.example.test/path",
			"https://api.example.test?x=1",
			"https://api.example.test#fragment",
			"https://user:pass@api.example.test",
			"ftp://api.example.test",
			"not a url",
			"",
			"https://api.example.test ",
		]) {
			expectSyncError(
				() =>
					new NativeAuthClient(
						validConfig(store, { origin }),
					),
				"invalid-input",
			);
		}

		expect(
			() => new NativeAuthClient(validConfig(store)),
		).not.toThrow();
		expect(
			() =>
				new NativeAuthClient(
					validConfig(store, {
						origin: "https://api.example.test:8443",
					}),
				),
		).not.toThrow();
		expect(
			() =>
				new NativeAuthClient(
					validConfig(store, {
						origin: "https://127.0.0.1",
					}),
				),
		).not.toThrow();
	});

	test("requires the explicit loopback HTTP opt-in", () => {
		const store = new CredentialStore({
			vault: new MemoryVault(),
			entry: ENTRY,
			maxCredentialBytes: 4096,
		});

		for (const origin of [
			"http://127.0.0.1:8787",
			"http://localhost:3000",
			"http://[::1]:3000",
		]) {
			expect(
				() =>
					new NativeAuthClient(
						validConfig(store, {
							origin,
							allowLoopbackHttp: true,
						}),
					),
			).not.toThrow();
			expectSyncError(
				() =>
					new NativeAuthClient(
						validConfig(store, { origin }),
					),
				"invalid-input",
			);
		}

		expectSyncError(
			() =>
				new NativeAuthClient(
					validConfig(store, {
						origin: "http://192.168.0.10",
						allowLoopbackHttp: true,
					}),
				),
			"invalid-input",
		);
		expect(
			() =>
				new NativeAuthClient(
					validConfig(store, {
						origin: "https://127.0.0.1",
					}),
				),
		).not.toThrow();
	});

	test("requires a deadline, a credential port, and valid seams", () => {
		const store = new CredentialStore({
			vault: new MemoryVault(),
			entry: ENTRY,
			maxCredentialBytes: 4096,
		});

		for (const requestTimeoutMillis of [
			undefined,
			0,
			-1,
			1.5,
			"1000",
		]) {
			expectSyncError(
				() =>
					new NativeAuthClient(
						validConfig(store, {
							requestTimeoutMillis:
								requestTimeoutMillis as number,
						}),
					),
				"invalid-input",
			);
		}

		for (const maxResponseBytes of [
			undefined,
			0,
			-1,
			1.5,
			"4096",
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.MAX_SAFE_INTEGER + 1,
		]) {
			expectSyncError(
				() =>
					new NativeAuthClient(
						validConfig(store, {
							maxResponseBytes:
								maxResponseBytes as number,
						}),
					),
				"invalid-input",
			);
		}

		expectSyncError(
			() =>
				new NativeAuthClient(
					validConfig(store, {
						credentials: {} as CredentialStore,
					}),
				),
			"invalid-input",
		);
		expectSyncError(
			() =>
				new NativeAuthClient(
					validConfig(store, {
						fetch: 1 as unknown as NativeFetch,
					}),
				),
			"invalid-input",
		);
		expectSyncError(
			() =>
				new NativeAuthClient(
					validConfig(store, {
						now: 1 as unknown as () => number,
					}),
				),
			"invalid-input",
		);
		expectSyncError(
			() =>
				new NativeAuthClient(
					validConfig(store, {
						allowLoopbackHttp:
							"true" as unknown as boolean,
					}),
				),
			"invalid-input",
		);
	});
});

describe("native device authorization begin", () => {
	test("uses the frozen 12-character Crockford human-code copy", () => {
		expect(HUMAN_CODE_ALPHABET).toBe(
			"0123456789ABCDEFGHJKMNPQRSTVWXYZ",
		);
		expect(HUMAN_CODE_LENGTH).toBe(12);
		expect(isCanonicalHumanCode(USER_CODE)).toBe(true);
		for (const forbidden of ["I", "L", "O", "U"]) {
			expect(HUMAN_CODE_ALPHABET.includes(forbidden)).toBe(false);
		}
	});

	test("uses the fixed path and a safe JSON request", async () => {
		const { client, fake, vault } = setup(() => json(beginBody()));
		const result = await client.beginDeviceAuthorization();

		expect(fake.calls).toHaveLength(1);
		const call = fake.calls[0]!;
		expect(call.url).toBe(
			`${ORIGIN}/api/native/v1/device-authorizations`,
		);
		expect(call.init.method).toBe("POST");
		expect(call.init.body).toBe("{}");
		expect(call.init.credentials).toBe("omit");
		expect(call.init.cache).toBe("no-store");
		expect(call.init.redirect).toBe("error");
		expect(call.init.referrerPolicy).toBe("no-referrer");
		const headers = call.init.headers as Record<string, string>;
		expect(headers["content-type"]).toBe("application/json");
		expect(headers.accept).toBe("application/json");
		expect(headers.cookie).toBeUndefined();
		expect(headers.authorization).toBeUndefined();

		expect(result).toEqual({
			deviceCode: DEVICE_CODE,
			userCode: USER_CODE,
			verificationUri: VERIFY_URI,
			expiresIn: 600,
			pollInterval: 5,
		});
		expect(Object.isFrozen(result)).toBe(true);
		expect(vault.writeCalls).toBe(0);
	});

	test("rejects tampered or malformed authorization responses", async () => {
		const cases: Array<Record<string, unknown> | null> = [
			{ deviceCode: DEVICE_CODE.slice(1) },
			{ deviceCode: `${DEVICE_CODE}A` },
			{ deviceCode: `${"A".repeat(42)}!` },
			{ userCode: USER_CODE.toLowerCase() },
			{ userCode: "0123456789AI" },
			{ verificationUri: "https://evil.example.test/api/native/v1/device-authorizations/verify" },
			{ verificationUri: `${ORIGIN}/api/native/v1/device-authorizations/other` },
			{ verificationUri: `${VERIFY_URI}?code=leak` },
			{ verificationUri: `${VERIFY_URI}#fragment` },
			{ verificationUri: `https://user:pass@api.example.test/api/native/v1/device-authorizations/verify` },
			{ expiresIn: 0 },
			{ expiresIn: 1.5 },
			{ expiresIn: "600" },
			{ pollInterval: 0 },
			{ pollInterval: -1 },
			{ extra: "field" },
			null,
		];

		for (const overrides of cases) {
			const body =
				overrides === null
					? beginBody()
					: { ...beginBody(), ...overrides };
			if (overrides === null) {
				delete (body as Record<string, unknown>).pollInterval;
			}
			const { client } = setup(() => json(body));
			await expectError(
				client.beginDeviceAuthorization(),
				"invalid-response",
			);
		}
	});

	test("maps pre-abort and timeout without issuing a request when proven", async () => {
		const preAborted = new AbortController();
		preAborted.abort();
		const first = setup(() => json(beginBody()));
		await expectError(
			first.client.beginDeviceAuthorization({
				signal: preAborted.signal,
			}),
			"aborted",
		);
		expect(first.fake.calls).toHaveLength(0);

		const timed = setup(
			(_call, _url, init) => abortableResponse(init),
			{ timeout: 10 },
		);
		await expectError(
			timed.client.beginDeviceAuthorization(),
			"request-timeout",
		);
		expect(timed.fake.calls).toHaveLength(1);
	});

	test("treats an abort after request start as uncertain", async () => {
		const { client, fake } = setup((_call, _url, init) =>
			abortableResponse(init),
		);
		const controller = new AbortController();
		const pending = client.beginDeviceAuthorization({
			signal: controller.signal,
		});
		await waitFor(() => fake.calls.length === 1);
		controller.abort();
		await expectError(pending, "network-outcome-uncertain");
	});
});

describe("native response read bounds", () => {
	test("requires explicit maxResponseBytes before fetch or vault mutation", () => {
		const vault = new MemoryVault();
		const store = new CredentialStore({
			vault,
			entry: ENTRY,
			maxCredentialBytes: 4096,
		});
		const fake = new FakeFetch(() => json(beginBody()));

		for (const maxResponseBytes of [
			undefined,
			0,
			-1,
			1.5,
			"4096",
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.MAX_SAFE_INTEGER + 1,
		]) {
			expectSyncError(
				() =>
					new NativeAuthClient({
						origin: ORIGIN,
						requestTimeoutMillis: 1000,
						maxResponseBytes:
							maxResponseBytes as number,
						credentials: store,
						fetch: fake.fetch,
						now: () => NOW,
					}),
				"invalid-input",
			);
		}

		expect(fake.calls).toHaveLength(0);
		expect(vault.readCalls).toBe(0);
		expect(vault.writeCalls).toBe(0);
		expect(vault.removeCalls).toBe(0);
	});

	test("accepts a response exactly at the budget and rejects one byte over", async () => {
		const body = JSON.stringify(beginBody());
		const exact = Buffer.byteLength(body);

		const accepted = setup(() => new Response(body), {
			maxResponseBytes: exact,
		});
		const result = await accepted.client.beginDeviceAuthorization();
		expect(result.deviceCode).toBe(DEVICE_CODE);

		const rejected = setup(() => new Response(`${body} `), {
			maxResponseBytes: exact,
		});
		await expectError(
			rejected.client.beginDeviceAuthorization(),
			"response-too-large",
		);
	});

	test("rejects oversized or malformed Content-Length before reading", async () => {
		const cases: Array<[string, NativeAuthErrorCode]> = [
			["4097", "response-too-large"],
			["+4096", "invalid-response"],
			["04096", "invalid-response"],
			["4096.0", "invalid-response"],
		];

		for (const [header, code] of cases) {
			let readerCalls = 0;
			let cancelCalls = 0;
			const response = {
				status: 200,
				headers: new Headers({ "content-length": header }),
				body: {
					getReader() {
						readerCalls += 1;
						throw new Error("body must not be read");
					},
					cancel() {
						cancelCalls += 1;
						return Promise.resolve();
					},
				},
			};
			const { client } = setup(
				() => response as unknown as Response,
				{ maxResponseBytes: 4096 },
			);

			await expectError(
				client.beginDeviceAuthorization(),
				code,
			);
			expect(readerCalls).toBe(0);
			expect(cancelCalls).toBe(1);
		}
	});

	test("counts streamed bytes and cancels when the budget is crossed", async () => {
		let cancelCalled!: () => void;
		const cancelled = new Promise<void>((resolve) => {
			cancelCalled = resolve;
		});
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array(9));
			},
			cancel() {
				cancelCalled();
			},
		});
		const { client } = setup(() => new Response(stream, { status: 200 }), {
			maxResponseBytes: 8,
		});

		await expectError(
			client.beginDeviceAuthorization(),
			"response-too-large",
		);
		await Promise.race([
			cancelled,
			new Promise<never>((_, reject) => {
				setTimeout(
					() => reject(new Error("reader was not cancelled")),
					100,
				);
			}),
		]);
	});

	test("ignores a lying low Content-Length and counts actual bytes", async () => {
		let cancelled = false;
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array(9));
			},
			cancel() {
				cancelled = true;
			},
		});
		const response = {
			status: 200,
			headers: new Headers({ "content-length": "1" }),
			body: stream,
		};
		const { client } = setup(
			() => response as unknown as Response,
			{ maxResponseBytes: 8 },
		);

		await expectError(
			client.beginDeviceAuthorization(),
			"response-too-large",
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(cancelled).toBe(true);
	});

	test("rejects malformed UTF-8 after a completed read", async () => {
		const { client } = setup(
			() =>
				new Response(new Uint8Array([0xff, 0xfe]), {
					status: 200,
				}),
		);
		await expectError(
			client.beginDeviceAuthorization(),
			"invalid-response",
		);
	});

	test("bounds a fetch that never settles with the overall deadline", async () => {
		const { client, fake } = setup(
			() => new Promise<Response>(() => {}),
			{ timeout: 10 },
		);
		const started = Date.now();
		await expectError(
			client.beginDeviceAuthorization(),
			"request-timeout",
		);
		expect(Date.now() - started).toBeLessThan(500);
		expect(fake.calls).toHaveLength(1);
	});

	test("bounds a body that never settles with the same deadline", async () => {
		let cancelCalled = false;
		const stream = new ReadableStream<Uint8Array>({
			start() {},
			cancel() {
				cancelCalled = true;
			},
		});
		const { client, fake } = setup(
			() => new Response(stream, { status: 200 }),
			{ timeout: 10 },
		);

		const started = Date.now();
		await expectError(
			client.beginDeviceAuthorization(),
			"request-timeout",
		);
		expect(Date.now() - started).toBeLessThan(500);
		expect(fake.calls).toHaveLength(1);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(cancelCalled).toBe(true);
	});

	test("caller abort bounds a fetch or body that ignores abort", async () => {
		const stalledFetch = setup(
			() => new Promise<Response>(() => {}),
		);
		const fetchController = new AbortController();
		const fetchPending = stalledFetch.client.beginDeviceAuthorization(
			{ signal: fetchController.signal },
		);
		await waitFor(
			() => stalledFetch.fake.calls.length === 1,
		);
		fetchController.abort();
		await expectError(
			fetchPending,
			"network-outcome-uncertain",
		);

		let bodyStarted = false;
		const stream = new ReadableStream<Uint8Array>({
			pull() {
				bodyStarted = true;
			},
			cancel() {},
		});
		const stalledBody = setup(
			() => new Response(stream, { status: 200 }),
		);
		const bodyController = new AbortController();
		const bodyPending = stalledBody.client.beginDeviceAuthorization(
			{ signal: bodyController.signal },
		);
		await waitFor(() => bodyStarted);
		bodyController.abort();
		await expectError(
			bodyPending,
			"network-outcome-uncertain",
		);
	});

	test("observes a late fetch rejection after the deadline", async () => {
		let rejectLate!: (error: Error) => void;
		const late = new Promise<Response>((_resolve, reject) => {
			rejectLate = reject;
		});
		const { client } = setup(() => late, { timeout: 10 });

		await expectError(
			client.beginDeviceAuthorization(),
			"request-timeout",
		);

		let unhandled = false;
		const listener = (reason: unknown): void => {
			if (
				reason instanceof Error &&
				reason.message === "late fetch rejection"
			) {
				unhandled = true;
			}
		};
		process.on("unhandledRejection", listener);
		try {
			rejectLate(new Error("late fetch rejection"));
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(unhandled).toBe(false);
		} finally {
			process.off("unhandledRejection", listener);
		}
	});

	test("refresh response overflow and body timeout remain fail-closed", async () => {
		const handlers: Array<() => Response> = [
			() =>
				new Response("x".repeat(100), {
					status: 200,
				}),
			() =>
				new Response(
					new ReadableStream<Uint8Array>({
						start() {},
						cancel() {},
					}),
					{ status: 200 },
				),
		];

		for (const handler of handlers) {
			const { client, store, fake } = setup(handler, {
				timeout: 10,
				maxResponseBytes: 8,
			});
			await store.writeReady(
				credential({ accessExpiresAtMillis: NOW - 1 }),
			);

			await expectError(
				client.refreshAccessToken(),
				"refresh-outcome-uncertain",
			);
			expect(await store.read()).toEqual({
				version: 1,
				state: "refresh-uncertain",
			});
			await expectError(
				client.getAccessToken(),
				"reauth-required",
			);
			expect(fake.calls).toHaveLength(1);
		}
	});
});

describe("native device authorization polling", () => {
	test("performs one attempt for each structured status", async () => {
		const cases: Array<[string, string]> = [
			["authorization-pending", "pending"],
			["slow-down", "slow-down"],
			["authorization-denied", "denied"],
			["authorization-expired", "expired"],
			["authorization-consumed", "consumed"],
		];

		for (const [code, status] of cases) {
			const { client, fake } = setup(() =>
				code === "slow-down"
					? errorEnvelope(code, 400, { "retry-after": "7" })
					: errorEnvelope(code),
			);
			const result = await client.pollAuthorization(DEVICE_CODE);
			expect(result).toEqual(
				code === "slow-down"
					? { status, retryAfterSeconds: 7 }
					: { status },
			);
			expect(fake.calls).toHaveLength(1);
			expect(fake.calls[0]!.url).toBe(
				`${ORIGIN}/api/native/v1/token`,
			);
			expect(requestBody(fake.calls[0]!)).toEqual({
				grantType: "device_code",
				deviceCode: DEVICE_CODE,
			});
			expect(fake.calls).toHaveLength(1);
		}
	});

	test("preserves sanitized Retry-After for pending and slow-down", async () => {
		const { client, fake } = setup((call) =>
			call === 1
				? errorEnvelope("authorization-pending", 400, {
						"retry-after": "2",
					})
				: errorEnvelope("slow-down", 400, {
						"retry-after": "7",
					}),
		);

		expect(await client.pollAuthorization(DEVICE_CODE)).toEqual({
			status: "pending",
			retryAfterSeconds: 2,
		});
		expect(await client.pollAuthorization(DEVICE_CODE)).toEqual({
			status: "slow-down",
			retryAfterSeconds: 7,
		});
		expect(fake.calls).toHaveLength(2);
	});

	test("rejects a slow-down without a canonical Retry-After", async () => {
		const invalidHeaders: Array<string | undefined> = [
			undefined,
			"0",
			"-1",
			"1.5",
			"01",
			"+2",
			"abc",
			"Wed, 21 Oct 2015 07:28:00 GMT",
			"9".repeat(40),
		];

		for (const retryAfter of invalidHeaders) {
			const { client, fake } = setup(() =>
				errorEnvelope(
					"slow-down",
					400,
					retryAfter === undefined
						? {}
						: { "retry-after": retryAfter },
				),
			);
			await expectError(
				client.pollAuthorization(DEVICE_CODE),
				"invalid-response",
			);
			expect(fake.calls).toHaveLength(1);
		}
	});

	test("ignores a non-canonical Retry-After on a pending response", async () => {
		const { client } = setup(() =>
			errorEnvelope("authorization-pending", 400, {
				"retry-after": "1.5",
			}),
		);
		expect(await client.pollAuthorization(DEVICE_CODE)).toEqual({
			status: "pending",
		});
	});

	test("returns an approved credential without persisting it", async () => {
		const { client, fake, vault } = setup(() => json(tokenBody()));
		const result = await client.pollAuthorization(DEVICE_CODE);

		expect(result.status).toBe("approved");
		if (result.status !== "approved") throw new Error("unreachable");
		expect(result.credential).toEqual({
			accessToken: NEW_ACCESS_TOKEN,
			refreshToken: NEW_REFRESH_TOKEN,
			accessExpiresAtMillis: NOW + 60_000,
			scope: "projects:read projects:write",
		});
		expect(Object.isFrozen(result.credential)).toBe(true);
		expect(vault.writeCalls).toBe(0);
		expect(fake.calls).toHaveLength(1);
		const headers = fake.calls[0]!.init.headers as Record<
			string,
			string
		>;
		expect(headers.cookie).toBeUndefined();
		expect(headers.authorization).toBeUndefined();
	});

	test("rejects malformed device codes before the network", async () => {
		const { client, fake } = setup(() => json(tokenBody()));
		for (const code of [
			DEVICE_CODE.slice(1),
			`${DEVICE_CODE}A`,
			`${"A".repeat(42)}!`,
		]) {
			await expectError(
				client.pollAuthorization(code),
				"invalid-input",
			);
		}
		expect(fake.calls).toHaveLength(0);
	});

	test("token exchange network failure is uncertain and never retried", async () => {
		const { client, fake } = setup(() =>
			Promise.reject(new Error("SECRET EXCHANGE DETAIL")),
		);
		const error = await expectError(
			client.pollAuthorization(DEVICE_CODE),
			"network-outcome-uncertain",
		);
		expect(error.message).not.toContain("SECRET");
		expect(fake.calls).toHaveLength(1);
		await expectError(
			client.pollAuthorization(DEVICE_CODE),
			"network-outcome-uncertain",
		);
		expect(fake.calls).toHaveLength(2);
	});

	test("maps known wire failures and sanitizes unknown bodies", async () => {
		const known = setup(() =>
			errorEnvelope("invalid-credential", 400),
		);
		const knownError = await expectError(
			known.client.pollAuthorization(DEVICE_CODE),
			"invalid-credential",
		);
		expect(knownError.message).not.toContain("secret");
		expect(knownError.cause).toBeUndefined();

		for (const response of [
			errorEnvelope("not-a-real-code", 400),
			json({ code: "authorization-pending" }, 400),
			errorEnvelope("authorization-pending", 500),
			json({ secret: "SECRET BODY" }, 500),
			json({ not: "a token response" }),
			new Response("not json"),
		]) {
			const { client } = setup(() => response);
			const error = await expectError(
				client.pollAuthorization(DEVICE_CODE),
				"invalid-response",
			);
			expect(error.message).not.toContain("SECRET");
			expect(error.message).not.toContain("not json");
		}
	});

	test("strictly validates every token response field", async () => {
		const cases: Array<Record<string, unknown>> = [
			{ accessToken: `${"A".repeat(42)}B` },
			{ refreshToken: `${"A".repeat(42)}B` },
			{ tokenType: "bearer" },
			{ tokenType: "Bearer " },
			{ expiresIn: 0 },
			{ expiresIn: 1.5 },
			{ expiresIn: Number.MAX_SAFE_INTEGER },
			{ scope: "" },
			{ scope: " projects:read" },
			{ scope: "projects:read " },
			{ scope: "projects:read  projects:write" },
			{ scope: "projects:read projects:read" },
			{ scope: "projects:read\tprojects:write" },
			{ extra: "field" },
		];

		for (const overrides of cases) {
			const { client } = setup(() => json(tokenBody(overrides)));
			await expectError(
				client.pollAuthorization(DEVICE_CODE),
				"invalid-response",
			);
		}
	});
});

describe("native credential persistence and access", () => {
	test("completes begin, poll, approve, persist, and access", async () => {
		const { client, fake, vault } = setup((_call, url) => {
			if (url.endsWith("/device-authorizations")) {
				return json(beginBody());
			}
			return json(tokenBody());
		});

		const authorization = await client.beginDeviceAuthorization();
		expect(authorization.userCode).toBe(USER_CODE);
		const poll = await client.pollAuthorization(
			authorization.deviceCode,
		);
		expect(poll.status).toBe("approved");
		if (poll.status !== "approved") throw new Error("unreachable");

		await client.storeCredential(poll.credential);
		expect(await client.getAccessToken()).toBe(NEW_ACCESS_TOKEN);
		expect(fake.calls).toHaveLength(2);
		for (const call of fake.calls) {
			expect(call.url).not.toContain(USER_CODE);
			expect(String(call.init.body)).not.toContain(USER_CODE);
		}

		const raw = new TextDecoder().decode(
			vault.entries.get(vault.key(ENTRY))!,
		);
		expect(raw).toContain(NEW_ACCESS_TOKEN);
		expect(raw).toContain(NEW_REFRESH_TOKEN);
		expect(raw).not.toContain(DEVICE_CODE);
		expect(raw).not.toContain(USER_CODE);
		expect(vault.entries.size).toBe(1);
	});

	test("returns valid stored access without a network request and refreshes at expiry", async () => {
		let now = NOW;
		const { client, fake, vault, store } = setup(
			() => json(tokenBody()),
			{ clock: () => now },
		);
		await store.writeReady(
			credential({ accessExpiresAtMillis: NOW + 1000 }),
		);
		const writes = vault.writeCalls;

		expect(await client.getAccessToken()).toBe(ACCESS_TOKEN);
		expect(fake.calls).toHaveLength(0);
		expect(vault.writeCalls).toBe(writes);

		now = NOW + 1000;
		expect(await client.getAccessToken()).toBe(NEW_ACCESS_TOKEN);
		expect(fake.calls).toHaveLength(1);
	});

	test("never exposes access from uncertain or unauthorized state", async () => {
		const first = setup(() => json(tokenBody()));
		await first.store.markRefreshUncertain();
		await expectError(
			first.client.getAccessToken(),
			"reauth-required",
		);
		await expectError(
			first.client.refreshAccessToken(),
			"reauth-required",
		);
		expect(first.fake.calls).toHaveLength(0);

		const second = setup(() => json(tokenBody()));
		await second.store.markUnauthorized();
		await expectError(
			second.client.getAccessToken(),
			"reauth-required",
		);
		expect(second.fake.calls).toHaveLength(0);
	});

	test("pre-aborts access reads before touching the vault", async () => {
		const { client, store, vault } = setup(() => json(tokenBody()));
		await store.writeReady(credential());
		const reads = vault.readCalls;
		const controller = new AbortController();
		controller.abort();
		await expectError(
			client.getAccessToken({ signal: controller.signal }),
			"aborted",
		);
		expect(vault.readCalls).toBe(reads);
	});

	test("validates and pre-aborts the storeCredential boundary", async () => {
		const { client, vault } = setup(() => json(tokenBody()));
		await expectError(
			client.storeCredential({
				...credential(),
				accessToken: "bad",
			}),
			"invalid-input",
		);
		expect(vault.writeCalls).toBe(0);

		const controller = new AbortController();
		controller.abort();
		await expectError(
			client.storeCredential(credential(), {
				signal: controller.signal,
			}),
			"aborted",
		);
		expect(vault.writeCalls).toBe(0);
	});
});

describe("native refresh safety", () => {
	test("single-flight refresh writes the marker before the request and commits before returning", async () => {
		const { client, store, fake, vault } = setup(() =>
			json(tokenBody()),
		);
		await store.writeReady(
			credential({ accessExpiresAtMillis: NOW - 1 }),
		);
		const writesBefore = vault.writeCalls;

		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let started!: () => void;
		const startedPromise = new Promise<void>((resolve) => {
			started = resolve;
		});

		const observedMarkers: string[] = [];
		const refreshFetch = setup(
			async (_call, _url, _init) => {
				const state = await store.read();
				observedMarkers.push(
					state === null ? "null" : state.state,
				);
				started();
				await gate;
				return json(tokenBody());
			},
			{ vault, store },
		);

		const first = refreshFetch.client.refreshAccessToken();
		await startedPromise;
		const second = refreshFetch.client.getAccessToken();
		expect(refreshFetch.fake.calls).toHaveLength(1);
		expect(refreshFetch.fake.calls[0]!.url).toBe(
			`${ORIGIN}/api/native/v1/token`,
		);
		expect(requestBody(refreshFetch.fake.calls[0]!)).toEqual({
			grantType: "refresh_token",
			refreshToken: REFRESH_TOKEN,
		});
		release();

		expect(await first).toBe(NEW_ACCESS_TOKEN);
		expect(await second).toBe(NEW_ACCESS_TOKEN);
		expect(observedMarkers).toEqual(["refresh-uncertain"]);
		expect(refreshFetch.fake.calls).toHaveLength(1);
		expect(vault.writeCalls).toBe(writesBefore + 2);

		const stored = await store.read();
		expect(stored?.state).toBe("ready");
		expect(await client.getAccessToken()).toBe(NEW_ACCESS_TOKEN);
	});

	test("a newer login is not overwritten by an in-flight refresh", async () => {
		const { client, store, vault } = setup(() => json(tokenBody()));
		await store.writeReady(
			credential({ accessExpiresAtMillis: NOW - 1 }),
		);

		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let started!: () => void;
		const startedPromise = new Promise<void>((resolve) => {
			started = resolve;
		});
		const refreshClient = setup(
			async () => {
				started();
				await gate;
				return json(tokenBody());
			},
			{ vault, store },
		).client;

		const pending = refreshClient.refreshAccessToken();
		await startedPromise;

		const replacement = credential({
			accessToken: token(30),
			refreshToken: token(31),
			accessExpiresAtMillis: NOW + 120_000,
			scope: "new:scope",
		});
		await refreshClient.storeCredential(replacement);
		expect(await refreshClient.getAccessToken()).toBe(
			replacement.accessToken,
		);
		release();

		await expectError(pending, "reauth-required");
		expect(await store.read()).toEqual({
			version: 1,
			state: "ready",
			...replacement,
		});
		expect(await refreshClient.getAccessToken()).toBe(
			replacement.accessToken,
		);
	});

	test("a lost refresh response leaves an uncertain marker and blocks retry", async () => {
		const { client, store, fake, vault } = setup(() =>
			Promise.reject(new Error("SECRET NETWORK DETAIL")),
		);
		await store.writeReady(
			credential({ accessExpiresAtMillis: NOW - 1 }),
		);
		const writesBefore = vault.writeCalls;

		const error = await expectError(
			client.refreshAccessToken(),
			"refresh-outcome-uncertain",
		);
		expect(error.message).not.toContain("SECRET");
		expect(error.cause).toBeUndefined();
		expect(await store.read()).toEqual({
			version: 1,
			state: "refresh-uncertain",
		});
		expect(vault.writeCalls).toBe(writesBefore + 1);
		expect(vault.removeCalls).toBe(0);

		await expectError(
			client.getAccessToken(),
			"reauth-required",
		);
		expect(fake.calls).toHaveLength(1);
	});

	test("a restart over the same vault never resends the old refresh token", async () => {
		const vault = new MemoryVault();
		const store = new CredentialStore({
			vault,
			entry: ENTRY,
			maxCredentialBytes: 4096,
		});
		await store.writeReady(
			credential({ accessExpiresAtMillis: NOW - 1 }),
		);
		const first = setup(
			() => Promise.reject(new Error("lost")),
			{ vault, store },
		);
		await expectError(
			first.client.refreshAccessToken(),
			"refresh-outcome-uncertain",
		);

		const restartedStore = new CredentialStore({
			vault,
			entry: ENTRY,
			maxCredentialBytes: 4096,
		});
		const restarted = setup(() => json(tokenBody()), {
			vault,
			store: restartedStore,
		});
		await expectError(
			restarted.client.getAccessToken(),
			"reauth-required",
		);
		await expectError(
			restarted.client.refreshAccessToken(),
			"reauth-required",
		);
		expect(restarted.fake.calls).toHaveLength(0);
	});

	test("a timeout after the marker is uncertain and never retried", async () => {
		const { client, store, fake } = setup(
			(_call, _url, init) => abortableResponse(init),
			{ timeout: 10 },
		);
		await store.writeReady(
			credential({ accessExpiresAtMillis: NOW - 1 }),
		);
		await expectError(
			client.refreshAccessToken(),
			"refresh-outcome-uncertain",
		);
		expect((await store.read())?.state).toBe("refresh-uncertain");
		await expectError(
			client.getAccessToken(),
			"reauth-required",
		);
		expect(fake.calls).toHaveLength(1);
	});

	test("an abort after the marker is uncertain and keeps the marker", async () => {
		const { client, store, fake } = setup((_call, _url, init) =>
			abortableResponse(init),
		);
		await store.writeReady(
			credential({ accessExpiresAtMillis: NOW - 1 }),
		);
		const controller = new AbortController();
		const pending = client.refreshAccessToken({
			signal: controller.signal,
		});
		await waitFor(() => fake.calls.length === 1);
		controller.abort();
		await expectError(pending, "refresh-outcome-uncertain");
		expect((await store.read())?.state).toBe("refresh-uncertain");
	});

	test("a pre-marker abort preserves ready state and sends nothing", async () => {
		const { client, store, fake, vault } = setup(() =>
			json(tokenBody()),
		);
		await store.writeReady(
			credential({ accessExpiresAtMillis: NOW - 1 }),
		);
		const writes = vault.writeCalls;
		const controller = new AbortController();
		controller.abort();

		await expectError(
			client.refreshAccessToken({
				signal: controller.signal,
			}),
			"aborted",
		);
		expect(fake.calls).toHaveLength(0);
		expect(vault.writeCalls).toBe(writes);
		expect((await store.read())?.state).toBe("ready");
	});

	test("a marker write failure prevents the refresh request", async () => {
		const { client, store, fake, vault } = setup(() =>
			json(tokenBody()),
		);
		await store.writeReady(
			credential({ accessExpiresAtMillis: NOW - 1 }),
		);
		vault.failWriteAtCall = vault.writeCalls + 1;

		await expectError(
			client.refreshAccessToken(),
			"reauth-required",
		);
		expect(fake.calls).toHaveLength(0);
		expect((await store.read())?.state).toBe("ready");
	});

	test("a failed replacement write returns no token and fails closed", async () => {
		const { client, store, fake, vault } = setup(() =>
			json(tokenBody()),
		);
		await store.writeReady(
			credential({ accessExpiresAtMillis: NOW - 1 }),
		);
		vault.failWriteAtCall = vault.writeCalls + 2;

		await expectError(
			client.refreshAccessToken(),
			"reauth-required",
		);
		expect(fake.calls).toHaveLength(1);
		expect((await store.read())?.state).toBe("refresh-uncertain");
		await expectError(
			client.getAccessToken(),
			"reauth-required",
		);
	});

	test("deterministic refresh failures mark unauthorized", async () => {
		const { client, store, fake } = setup(() =>
			errorEnvelope("refresh-replay", 400),
		);
		await store.writeReady(
			credential({ accessExpiresAtMillis: NOW - 1 }),
		);

		const error = await expectError(
			client.refreshAccessToken(),
			"refresh-replay",
		);
		expect(error.message).not.toContain("secret");
		expect(await store.read()).toEqual({
			version: 1,
			state: "unauthorized",
		});
		await expectError(
			client.getAccessToken(),
			"reauth-required",
		);
		expect(fake.calls).toHaveLength(1);
	});

	test("arbitrary server failures keep uncertainty and never delete", async () => {
		const { client, store, fake, vault } = setup(() =>
			json({ secret: "SERVER DETAIL" }, 500),
		);
		await store.writeReady(
			credential({ accessExpiresAtMillis: NOW - 1 }),
		);

		const error = await expectError(
			client.refreshAccessToken(),
			"refresh-outcome-uncertain",
		);
		expect(error.message).not.toContain("SERVER");
		expect(await store.read()).toEqual({
			version: 1,
			state: "refresh-uncertain",
		});
		expect(vault.removeCalls).toBe(0);
		expect(fake.calls).toHaveLength(1);
	});

	test("a 5xx with a deterministic-looking envelope stays uncertain", async () => {
		const { client, store, fake } = setup(() =>
			errorEnvelope("invalid-credential", 500),
		);
		await store.writeReady(
			credential({ accessExpiresAtMillis: NOW - 1 }),
		);
		await expectError(
			client.refreshAccessToken(),
			"refresh-outcome-uncertain",
		);
		expect((await store.read())?.state).toBe("refresh-uncertain");
		expect(fake.calls).toHaveLength(1);
	});
});

describe("native logout", () => {
	test("removes only the exact entry and forgets local state", async () => {
		const { client, store, fake, vault } = setup(() =>
			json(tokenBody()),
		);
		await store.writeReady(credential());
		vault.seed(
			OTHER_ENTRY,
			new TextEncoder().encode("other-entry-value"),
		);

		expect(await client.logout()).toBe(true);
		expect(fake.calls).toHaveLength(0);
		expect(vault.removeCalls).toBe(1);
		expect(vault.entries.has(vault.key(ENTRY))).toBe(false);
		expect(
			new TextDecoder().decode(
				vault.entries.get(vault.key(OTHER_ENTRY)),
			),
		).toBe("other-entry-value");
		await expectError(
			client.getAccessToken(),
			"reauth-required",
		);
		expect(await client.logout()).toBe(false);
	});

	test("logout during refresh cannot resurrect credentials", async () => {
		const { client, store, fake, vault } = setup(() =>
			json(tokenBody()),
		);
		await store.writeReady(
			credential({ accessExpiresAtMillis: NOW - 1 }),
		);

		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let started!: () => void;
		const startedPromise = new Promise<void>((resolve) => {
			started = resolve;
		});

		const refreshClient = setup(
			async () => {
				started();
				await gate;
				return json(tokenBody());
			},
			{ vault, store },
		).client;

		const pending = refreshClient.refreshAccessToken();
		await startedPromise;
		expect(await refreshClient.logout()).toBe(true);
		release();

		await expectError(pending, "reauth-required");
		expect(vault.entries.has(vault.key(ENTRY))).toBe(false);
		await expectError(
			refreshClient.getAccessToken(),
			"reauth-required",
		);
		expect(fake.calls).toHaveLength(0);
	});

	test("an access read cannot return a token after logout", async () => {
		const { client, store, vault } = setup(() =>
			json(tokenBody()),
		);
		await store.writeReady(credential());

		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let readStarted!: () => void;
		const readStartedPromise = new Promise<void>((resolve) => {
			readStarted = resolve;
		});
		vault.beforeRead = async () => {
			readStarted();
			await gate;
		};

		const pending = client.getAccessToken();
		await readStartedPromise;
		const logout = client.logout();
		release();
		expect(await logout).toBe(true);
		await expectError(pending, "aborted");
		expect(vault.entries.has(vault.key(ENTRY))).toBe(false);
	});
});
