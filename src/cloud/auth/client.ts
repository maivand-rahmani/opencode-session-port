/**
 * Native device-authorization client.
 *
 * The client talks only to an explicitly configured canonical origin and the
 * frozen `/api/native/v1` paths. It never imports an HTTP library: the injected
 * fetch defaults to the runtime's global fetch and is resolved at request time.
 * Every request has an explicit caller-supplied deadline linked to the caller's
 * AbortSignal.
 *
 * Raw device codes, human codes, access tokens, and refresh tokens are returned
 * only in memory. They are never logged, placed in a URL/query/fragment, written
 * to browser storage, or persisted outside the injected SecureVault. There is no
 * automatic polling loop, sleep, or credential retry. Polling is one HTTP
 * attempt per call; the caller schedules the next attempt.
 *
 * Response bodies are limited by a required caller-supplied byte budget, read
 * from the stream with fatal UTF-8 decoding, and covered by the same overall
 * deadline as the fetch. A stalled fetch or body is rejected by the deadline
 * even if the injected fetch ignores abort.
 *
 * Refresh is single-flight per client. A vault marker is committed before the
 * refresh request is sent. If the process dies, the marker remains and the next
 * load must reauthorize; a lost/uncertain reply never resends the old refresh
 * token. Credential write serialization is per process through the store
 * adapter. Cross-process locking is not implemented.
 */
import {
	isCanonicalCredentialToken,
	isCanonicalHumanCode,
	isCanonicalScope,
	isPlainRecord,
	isPositiveSafeInteger,
	NATIVE_DEVICE_AUTHORIZATIONS_PATH,
	NATIVE_TOKEN_PATH,
	NATIVE_VERIFICATION_PATH,
	NativeAuthError,
	readTokenCredential,
} from "./types.ts";
import type {
	DeviceAuthorization,
	NativeCredentialStorePort,
	PollAuthorizationResult,
	TokenCredential,
	WireErrorCode,
} from "./types.ts";

/** Injected fetch shape; no HTTP implementation is bundled or imported. */
export type NativeFetch = (
	url: string,
	init: RequestInit,
) => Promise<Response>;

export interface NativeAuthClientConfig {
	/** Exact canonical HTTPS origin, or explicit HTTP loopback via the flag. */
	readonly origin: string;
	/** Required request deadline; no default is supplied. */
	readonly requestTimeoutMillis: number;
	/** Required response-body ceiling in bytes; no default is supplied. */
	readonly maxResponseBytes: number;
	/** Vault-backed credential port; this module never opens a vault itself. */
	readonly credentials: NativeCredentialStorePort;
	/** Explicit opt-in for HTTP only on loopback hosts. Defaults to false. */
	readonly allowLoopbackHttp?: boolean;
	/** Test/integration seam; resolves to globalThis.fetch when omitted. */
	readonly fetch?: NativeFetch;
	/** Injected clock in epoch milliseconds; defaults to Date.now. */
	readonly now?: () => number;
}

export interface NativeAuthRequestOptions {
	readonly signal?: AbortSignal;
}

interface WireResponse {
	readonly status: number;
	readonly text: string;
}

const MAX_ORIGIN_LENGTH = 2048;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const CONTENT_LENGTH_PATTERN = /^(0|[1-9][0-9]*)$/;
const WIRE_ERROR_CODES: ReadonlySet<string> = new Set([
	"authorization-pending",
	"slow-down",
	"authorization-denied",
	"authorization-expired",
	"authorization-consumed",
	"invalid-credential",
	"refresh-replay",
	"state-conflict",
]);

const POLL_STATUS: Readonly<
	Partial<
		Record<
			WireErrorCode,
			"pending" | "slow-down" | "denied" | "expired" | "consumed"
		>
	>
> = Object.freeze({
	"authorization-pending": "pending",
	"slow-down": "slow-down",
	"authorization-denied": "denied",
	"authorization-expired": "expired",
	"authorization-consumed": "consumed",
});

const DETERMINISTIC_REFRESH_FAILURES: ReadonlySet<WireErrorCode> = new Set([
	"invalid-credential",
	"refresh-replay",
	"state-conflict",
]);

export class NativeAuthClient {
	private readonly origin: string;
	private readonly requestTimeoutMillis: number;
	private readonly maxResponseBytes: number;
	private readonly credentials: NativeCredentialStorePort;
	private readonly fetcher: NativeFetch | undefined;
	private readonly clock: () => number;
	private readonly pollsInFlight = new Set<string>();

	private refreshPromise: Promise<string> | null = null;
	private refreshID = 0;
	private generation = 0;

	constructor(config: NativeAuthClientConfig) {
		if (!isPlainRecord(config)) {
			throw new NativeAuthError("invalid-input");
		}

		const allowLoopbackHttp = readAllowLoopback(config.allowLoopbackHttp);
		const origin = readCanonicalOrigin(
			config.origin,
			allowLoopbackHttp,
		);

		if (!isPositiveSafeInteger(config.requestTimeoutMillis)) {
			throw new NativeAuthError("invalid-input");
		}
		if (!isPositiveSafeInteger(config.maxResponseBytes)) {
			throw new NativeAuthError("invalid-input");
		}
		if (!isCredentialStore(config.credentials)) {
			throw new NativeAuthError("invalid-input");
		}
		if (
			config.fetch !== undefined &&
			typeof config.fetch !== "function"
		) {
			throw new NativeAuthError("invalid-input");
		}
		if (config.now !== undefined && typeof config.now !== "function") {
			throw new NativeAuthError("invalid-input");
		}

		this.origin = origin;
		this.requestTimeoutMillis = config.requestTimeoutMillis;
		this.maxResponseBytes = config.maxResponseBytes;
		this.credentials = config.credentials;
		this.fetcher = config.fetch;
		this.clock = config.now ?? (() => Date.now());
	}

	/**
	 * Creates one pending authorization. The returned device code is memory-only
	 * and is never persisted as a pending login; the user code is solely for
	 * display by the caller and is not logged.
	 */
	async beginDeviceAuthorization(
		options?: NativeAuthRequestOptions,
	): Promise<DeviceAuthorization> {
		const response = await this.postJson(
			NATIVE_DEVICE_AUTHORIZATIONS_PATH,
			{},
			options,
		);
		if (!isSuccess(response.status)) {
			throw new NativeAuthError("invalid-response");
		}
		return this.parseDeviceAuthorization(response.text);
	}

	/**
	 * Performs exactly one token endpoint attempt. No loop or sleep is performed;
	 * the caller schedules subsequent polls. Concurrent polls for the same device
	 * code fail closed with `state-conflict` rather than racing a one-time code.
	 */
	async pollAuthorization(
		deviceCode: string,
		options?: NativeAuthRequestOptions,
	): Promise<PollAuthorizationResult> {
		if (!isCanonicalCredentialToken(deviceCode)) {
			throw new NativeAuthError("invalid-input");
		}
		if (this.pollsInFlight.has(deviceCode)) {
			throw new NativeAuthError("state-conflict");
		}

		this.pollsInFlight.add(deviceCode);
		try {
			const response = await this.postJson(
				NATIVE_TOKEN_PATH,
				{ grantType: "device_code", deviceCode },
				options,
			);

			if (isSuccess(response.status)) {
				return Object.freeze({
					status: "approved",
					credential: this.parseTokenResponse(response.text),
				});
			}

			if (response.status >= 400 && response.status < 500) {
				const code = readWireErrorCode(response.text);
				if (code !== null) {
					const status = POLL_STATUS[code];
					if (status !== undefined) {
						return Object.freeze({ status });
					}
					throw new NativeAuthError(code);
				}
			}

			throw new NativeAuthError("invalid-response");
		} finally {
			this.pollsInFlight.delete(deviceCode);
		}
	}

	/**
	 * Commits a credential returned by the approved poll result. The input is
	 * validated and copied; storing is the only step that writes token material
	 * to the OS vault. It returns no token and performs no HTTP request.
	 */
	async storeCredential(
		credential: TokenCredential,
		options?: NativeAuthRequestOptions,
	): Promise<void> {
		const signal = readRequestSignal(options);
		throwIfAborted(signal);
		const copy = readTokenCredential(credential, "invalid-input");
		// A new login supersedes any in-flight refresh so it cannot overwrite
		// this newer credential with an older grant's rotation result.
		this.generation += 1;
		const writeGeneration = this.generation;
		this.refreshID += 1;
		this.refreshPromise = null;
		await this.credentials.writeReady(copy);
		if (this.generation !== writeGeneration) {
			// Logout or a newer login superseded this write.
			throw new NativeAuthError("reauth-required");
		}
	}

	/**
	 * Returns a stored unexpired access token from ready state. Expired or absent
	 * ready state uses the single-flight refresh path. Uncertain/unauthorized
	 * state fails closed with `reauth-required`; no access token is exposed and
	 * no old refresh token is sent.
	 */
	async getAccessToken(
		options?: NativeAuthRequestOptions,
	): Promise<string> {
		const signal = readRequestSignal(options);
		throwIfAborted(signal);

		const generation = this.generation;
		if (this.refreshPromise !== null) return this.refreshPromise;

		const state = await this.credentials.read();

		// A logout invalidates this read; a refresh may also have started while
		// the vault read was pending. Never return stale ready access.
		if (this.generation !== generation) {
			throw new NativeAuthError("aborted");
		}
		if (this.refreshPromise !== null) return this.refreshPromise;
		throwIfAborted(signal);

		if (state === null || state.state !== "ready") {
			throw new NativeAuthError("reauth-required");
		}
		if (state.accessExpiresAtMillis > this.readClock()) {
			return state.accessToken;
		}
		return this.refreshAccessToken({ signal });
	}

	/**
	 * Explicit refresh shared by all callers. The vault attempt marker is written
	 * before the request. A successful response is committed as a replacement
	 * ready state before any access token is returned.
	 */
	refreshAccessToken(
		options?: NativeAuthRequestOptions,
	): Promise<string> {
		let signal: AbortSignal | undefined;
		try {
			signal = readRequestSignal(options);
		} catch (error) {
			return Promise.reject(error);
		}
		if (signal?.aborted) {
			return Promise.reject(new NativeAuthError("aborted"));
		}
		if (this.refreshPromise !== null) return this.refreshPromise;

		const generation = this.generation;
		const id = this.refreshID + 1;
		this.refreshID = id;

		const run = this.performRefresh(signal, generation);
		const tracked = run.then(
			(value) => {
				if (this.refreshID === id) this.refreshPromise = null;
				return value;
			},
			(error: unknown) => {
				if (this.refreshID === id) this.refreshPromise = null;
				throw error;
			},
		);
		this.refreshPromise = tracked;
		return tracked;
	}

	/**
	 * Local logout only: removes the exact configured vault entry and forgets the
	 * in-memory refresh promise. It neither claims nor attempts server revocation.
	 */
	async logout(): Promise<boolean> {
		this.generation += 1;
		this.refreshID += 1;
		this.refreshPromise = null;
		return this.credentials.remove();
	}

	private async performRefresh(
		signal: AbortSignal | undefined,
		generation: number,
	): Promise<string> {
		// A pre-marker abort leaves the original ready state untouched.
		throwIfAborted(signal);

		const state = await this.credentials.read();
		throwIfAborted(signal);
		if (this.generation !== generation) {
			throw new NativeAuthError("aborted");
		}
		if (state === null || state.state !== "ready") {
			throw new NativeAuthError("reauth-required");
		}

		// Commit the attempt marker before any HTTP request. If this write cannot
		// be proven, no refresh request is sent.
		try {
			await this.credentials.markRefreshUncertain();
		} catch {
			throw new NativeAuthError("reauth-required");
		}

		if (this.generation !== generation) {
			// Do not remove the entry here: a newer login may already own it.
			// Logout's queued removal is ordered after any marker written before
			// it, so the stale refresh must only fail closed.
			throw new NativeAuthError("reauth-required");
		}
		if (signal?.aborted) {
			throw new NativeAuthError("refresh-outcome-uncertain");
		}

		let response: WireResponse;
		try {
			response = await this.postJson(
				NATIVE_TOKEN_PATH,
				{
					grantType: "refresh_token",
					refreshToken: state.refreshToken,
				},
				signal === undefined ? undefined : { signal },
			);
		} catch {
			// Once the marker is committed, no transport result (including a
			// pre-send abort observed here) may resend the old refresh token.
			throw new NativeAuthError("refresh-outcome-uncertain");
		}

		if (isSuccess(response.status)) {
			let credential: TokenCredential;
			try {
				credential = this.parseTokenResponse(response.text);
			} catch {
				throw new NativeAuthError("refresh-outcome-uncertain");
			}

			if (this.generation !== generation) {
				// Never overwrite or remove a newer login's entry.
				throw new NativeAuthError("reauth-required");
			}

			try {
				await this.credentials.writeReady(credential);
			} catch {
				// A successful token response is never returned unless the
				// replacement credential was committed.
				throw new NativeAuthError("reauth-required");
			}

			if (this.generation !== generation) {
				// The write already happened before logout; logout's queued
				// removal owns cleanup. Do not delete a newer entry.
				throw new NativeAuthError("reauth-required");
			}
			return credential.accessToken;
		}

		const code =
			response.status >= 400 && response.status < 500
				? readWireErrorCode(response.text)
				: null;
		if (
			code !== null &&
			DETERMINISTIC_REFRESH_FAILURES.has(code)
		) {
			// Deterministic credential failure: replace uncertain state with an
			// unauthorized marker when possible. Never fall back to old tokens.
			// A 5xx or ambiguous reply is not deterministic and stays uncertain.
			await this.credentials.markUnauthorized().catch(() => undefined);
			throw new NativeAuthError(code);
		}

		// Any other status/body is not proof that rotation did not happen.
		throw new NativeAuthError("refresh-outcome-uncertain");
	}

	private parseDeviceAuthorization(text: string): DeviceAuthorization {
		const parsed = parseJsonObject(text);
		if (
			!hasExactKeys(parsed, [
				"deviceCode",
				"userCode",
				"verificationUri",
				"expiresIn",
				"pollInterval",
			])
		) {
			throw new NativeAuthError("invalid-response");
		}

		const deviceCode = parsed.deviceCode;
		const userCode = parsed.userCode;
		const verificationUri = parsed.verificationUri;
		const expiresIn = parsed.expiresIn;
		const pollInterval = parsed.pollInterval;

		if (
			!isCanonicalCredentialToken(deviceCode) ||
			!isCanonicalHumanCode(userCode) ||
			typeof verificationUri !== "string" ||
			verificationUri !== `${this.origin}${NATIVE_VERIFICATION_PATH}` ||
			!isPositiveSafeInteger(expiresIn) ||
			!isPositiveSafeInteger(pollInterval)
		) {
			throw new NativeAuthError("invalid-response");
		}

		return Object.freeze({
			deviceCode,
			userCode,
			verificationUri,
			expiresIn,
			pollInterval,
		});
	}

	private parseTokenResponse(text: string): TokenCredential {
		const parsed = parseJsonObject(text);
		if (
			!hasExactKeys(parsed, [
				"accessToken",
				"tokenType",
				"expiresIn",
				"refreshToken",
				"scope",
			])
		) {
			throw new NativeAuthError("invalid-response");
		}

		const accessToken = parsed.accessToken;
		const tokenType = parsed.tokenType;
		const expiresIn = parsed.expiresIn;
		const refreshToken = parsed.refreshToken;
		const scope = parsed.scope;

		if (
			!isCanonicalCredentialToken(accessToken) ||
			tokenType !== "Bearer" ||
			!isPositiveSafeInteger(expiresIn) ||
			!isCanonicalCredentialToken(refreshToken) ||
			!isCanonicalScope(scope)
		) {
			throw new NativeAuthError("invalid-response");
		}

		const lifetimeMillis = expiresIn * 1000;
		const expiresAt = this.readClock() + lifetimeMillis;
		if (
			!Number.isSafeInteger(lifetimeMillis) ||
			!Number.isSafeInteger(expiresAt) ||
			expiresAt <= 0
		) {
			throw new NativeAuthError("invalid-response");
		}

		return Object.freeze({
			accessToken,
			refreshToken,
			accessExpiresAtMillis: expiresAt,
			scope,
		});
	}

	private async postJson(
		path: string,
		body: Record<string, unknown>,
		options: NativeAuthRequestOptions | undefined,
	): Promise<WireResponse> {
		const callerSignal = readRequestSignal(options);
		throwIfAborted(callerSignal);

		const controller = new AbortController();
		let timedOut = false;
		let started = false;
		const timer = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, this.requestTimeoutMillis);
		const forwardAbort = (): void => controller.abort();
		callerSignal?.addEventListener("abort", forwardAbort, { once: true });

		try {
			if (callerSignal?.aborted) {
				throw new RequestAbortError();
			}

			const headers: Readonly<Record<string, string>> = {
				"content-type": "application/json",
				accept: "application/json",
				"cache-control": "no-store",
			};

			const init: RequestInit = {
				method: "POST",
				headers,
				body: JSON.stringify(body),
				signal: controller.signal,
				credentials: "omit",
				cache: "no-store",
				redirect: "error",
				referrerPolicy: "no-referrer",
			};

			const fetcher =
				this.fetcher ??
				((url: string, request: RequestInit) =>
					globalThis.fetch(url, request));

			started = true;
			const operation = (async (): Promise<WireResponse> => {
				const response = await fetcher(
					`${this.origin}${path}`,
					init,
				);
				const text = await readBoundedBody(
					response,
					this.maxResponseBytes,
					controller.signal,
				);
				return { status: response.status, text };
			})();

			return await raceWithAbort(operation, controller.signal);
		} catch (error) {
			if (error instanceof ResponseReadError) {
				throw new NativeAuthError(error.code);
			}
			if (error instanceof RequestAbortError) {
				if (!started) throw new NativeAuthError("aborted");
				if (timedOut) throw new NativeAuthError("request-timeout");
				throw new NativeAuthError("network-outcome-uncertain");
			}
			if (!started) throw new NativeAuthError("aborted");
			if (timedOut) throw new NativeAuthError("request-timeout");
			// An abort or network failure after the request started is never
			// retried automatically; callers see a fixed uncertain outcome.
			throw new NativeAuthError("network-outcome-uncertain");
		} finally {
			clearTimeout(timer);
			callerSignal?.removeEventListener("abort", forwardAbort);
		}
	}

	private readClock(): number {
		let value: unknown;
		try {
			value = this.clock();
		} catch {
			throw new NativeAuthError("invalid-input");
		}
		if (
			typeof value !== "number" ||
			!Number.isSafeInteger(value) ||
			value < 0
		) {
			throw new NativeAuthError("invalid-input");
		}
		return value;
	}
}

function isSuccess(status: number): boolean {
	return status >= 200 && status < 300;
}

function parseJsonObject(text: string): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new NativeAuthError("invalid-response");
	}
	if (!isPlainRecord(parsed)) {
		throw new NativeAuthError("invalid-response");
	}
	return parsed;
}

function hasExactKeys(
	record: Record<string, unknown>,
	required: readonly string[],
): boolean {
	const actual = Object.keys(record);
	return (
		actual.length === required.length &&
		required.every((key) => Object.hasOwn(record, key))
	);
}

class RequestAbortError extends Error {
	constructor() {
		super("The request was aborted.");
		this.name = "RequestAbortError";
	}
}

class ResponseReadError extends Error {
	readonly code: "invalid-response" | "response-too-large";

	constructor(code: "invalid-response" | "response-too-large") {
		super("The response could not be read.");
		this.name = "ResponseReadError";
		this.code = code;
	}
}

/**
 * Reject as soon as the request controller aborts, even if the underlying
 * fetch/body promise ignores its signal. The operation promise always gets a
 * rejection handler, so a late rejection is observed rather than unhandled.
 */
function raceWithAbort<T>(
	operation: Promise<T>,
	signal: AbortSignal,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const onAbort = (): void => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", onAbort);
			reject(new RequestAbortError());
		};
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });

		operation.then(
			(value) => {
				if (settled) return;
				settled = true;
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error: unknown) => {
				// Observe late rejection even when abort already won the race.
				if (settled) return;
				settled = true;
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

/**
 * Read a response body without trusting Content-Length for the byte count.
 * The declared length is only an early bound; actual stream bytes are counted
 * independently. The reader is cancelled on overflow/abort without awaiting
 * the cancellation promise. UTF-8 decoding is fatal after the read completes.
 */
async function readBoundedBody(
	response: Response,
	maxBytes: number,
	signal: AbortSignal,
): Promise<string> {
	const contentLength = response.headers.get("content-length");
	if (contentLength !== null) {
		if (!CONTENT_LENGTH_PATTERN.test(contentLength)) {
			cancelBody(response.body);
			throw new ResponseReadError("invalid-response");
		}
		const declared = Number(contentLength);
		if (!Number.isSafeInteger(declared) || declared < 0) {
			cancelBody(response.body);
			throw new ResponseReadError("invalid-response");
		}
		if (declared > maxBytes) {
			cancelBody(response.body);
			throw new ResponseReadError("response-too-large");
		}
	}

	if (signal.aborted) {
		cancelBody(response.body);
		throw new RequestAbortError();
	}
	const body = response.body;
	if (body === null) return "";

	let reader: ReadableStreamDefaultReader<Uint8Array>;
	try {
		reader = body.getReader();
	} catch {
		throw new ResponseReadError("invalid-response");
	}

	let cancelled = false;
	const cancel = (): void => {
		if (cancelled) return;
		cancelled = true;
		try {
			observeCancellation(reader.cancel());
		} catch {
			// Client-side cancellation is best effort only.
		}
	};
	const onAbort = (): void => {
		cancel();
		signal.removeEventListener("abort", onAbort);
	};
	if (signal.aborted) onAbort();
	else signal.addEventListener("abort", onAbort, { once: true });

	try {
		const chunks: Uint8Array[] = [];
		let total = 0;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!(value instanceof Uint8Array)) {
				throw new ResponseReadError("invalid-response");
			}
			if (value.byteLength > maxBytes - total) {
				cancel();
				throw new ResponseReadError("response-too-large");
			}
			total += value.byteLength;
			chunks.push(value);
		}
		if (signal.aborted) throw new RequestAbortError();
		return decodeBody(chunks, total);
	} finally {
		signal.removeEventListener("abort", onAbort);
		try {
			reader.releaseLock();
		} catch {
			// The reader may already be cancelled or released.
		}
	}
}

function cancelBody(body: ReadableStream<Uint8Array> | null): void {
	if (body === null) return;
	try {
		observeCancellation(body.cancel());
	} catch {
		// Best-effort client-side cancellation; no server rollback is claimed.
	}
}

function observeCancellation(value: Promise<unknown> | undefined): void {
	if (
		value !== undefined &&
		value !== null &&
		typeof value.catch === "function"
	) {
		value.catch(() => undefined);
	}
}

function decodeBody(
	chunks: readonly Uint8Array[],
	total: number,
): string {
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try {
		return new TextDecoder("utf-8", {
			fatal: true,
			ignoreBOM: true,
		}).decode(bytes);
	} catch {
		throw new ResponseReadError("invalid-response");
	}
}

function readWireErrorCode(text: string): WireErrorCode | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	if (!isPlainRecord(parsed) || !isPlainRecord(parsed.error)) {
		return null;
	}
	const code = parsed.error.code;
	return typeof code === "string" && WIRE_ERROR_CODES.has(code)
		? (code as WireErrorCode)
		: null;
}

function readRequestSignal(
	options: NativeAuthRequestOptions | undefined,
): AbortSignal | undefined {
	if (options === undefined) return undefined;
	if (!isPlainRecord(options)) {
		throw new NativeAuthError("invalid-input");
	}
	const signal = options.signal;
	if (signal === undefined) return undefined;
	if (signal === null || typeof signal !== "object") {
		throw new NativeAuthError("invalid-input");
	}
	const candidate = signal as {
		readonly aborted?: unknown;
		readonly addEventListener?: unknown;
		readonly removeEventListener?: unknown;
	};
	if (
		typeof candidate.aborted !== "boolean" ||
		typeof candidate.addEventListener !== "function" ||
		typeof candidate.removeEventListener !== "function"
	) {
		throw new NativeAuthError("invalid-input");
	}
	return signal as AbortSignal;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new NativeAuthError("aborted");
}

function readAllowLoopback(value: unknown): boolean {
	if (value === undefined) return false;
	if (typeof value !== "boolean") {
		throw new NativeAuthError("invalid-input");
	}
	return value;
}

function readCanonicalOrigin(
	value: unknown,
	allowLoopbackHttp: boolean,
): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > MAX_ORIGIN_LENGTH ||
		value.trim() !== value ||
		CONTROL_CHARACTERS.test(value)
	) {
		throw new NativeAuthError("invalid-input");
	}

	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw new NativeAuthError("invalid-input");
	}

	if (
		(parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
		parsed.username !== "" ||
		parsed.password !== "" ||
		parsed.search !== "" ||
		parsed.hash !== "" ||
		parsed.pathname !== "/" ||
		parsed.origin !== value ||
		!isConcreteHostname(parsed.hostname)
	) {
		throw new NativeAuthError("invalid-input");
	}
	if (
		parsed.protocol === "http:" &&
		(!allowLoopbackHttp || !isLoopbackHostname(parsed.hostname))
	) {
		throw new NativeAuthError("invalid-input");
	}

	return parsed.origin;
}

function isConcreteHostname(hostname: string): boolean {
	if (hostname.startsWith("[")) {
		return /^\[[0-9a-f:.]+\]$/i.test(hostname);
	}

	const withoutTrailingDot = hostname.endsWith(".")
		? hostname.slice(0, -1)
		: hostname;
	if (withoutTrailingDot.length === 0 || withoutTrailingDot.length > 253) {
		return false;
	}

	return withoutTrailingDot.split(".").every(
		(label) =>
			label.length > 0 &&
			label.length <= 63 &&
			/^[a-z0-9-]+$/i.test(label) &&
			!label.startsWith("-") &&
			!label.endsWith("-"),
	);
}

function isLoopbackHostname(hostname: string): boolean {
	if (hostname === "localhost" || hostname === "[::1]") {
		return true;
	}

	const octets = hostname.split(".");
	return (
		octets.length === 4 &&
		octets[0] === "127" &&
		octets.every(
			(octet) =>
				/^[0-9]{1,3}$/.test(octet) && Number(octet) <= 255,
		)
	);
}

function isCredentialStore(
	value: unknown,
): value is NativeCredentialStorePort {
	return (
		isPlainRecord(value) &&
		typeof value.read === "function" &&
		typeof value.writeReady === "function" &&
		typeof value.markRefreshUncertain === "function" &&
		typeof value.markUnauthorized === "function" &&
		typeof value.remove === "function"
	);
}
