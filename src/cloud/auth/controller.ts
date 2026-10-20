/**
 * Optional cloud-auth controller.
 *
 * This is the only module that composes the process-owner lock, the native
 * keyring binding, the credential store, and the native device-authorization
 * client. None of those resources are touched when the runtime configuration
 * is absent, and the optional native binding is loaded dynamically only after
 * configuration validation and owner acquisition. The owner lease is acquired
 * before the vault or native client is created.
 *
 * One controller owns at most one lock/client/store lifetime. Vault reads and
 * mutations, native HTTP operations, and the single login flow are tracked so
 * disposal cannot release the process-owner lock while a vault mutation could
 * still settle. There is no plaintext, memory-token, or file fallback.
 *
 * Login progress and outcomes contain only fixed status values plus the
 * server-provided verification URI, user code, and lifetime needed for
 * display. Device codes, tokens, raw errors, and account PII never leave the
 * controller. Local logout removes the exact configured vault entry and does
 * not revoke any server grant.
 */
import {
	NativeAuthClient,
	type NativeFetch,
} from "./client.ts";
import { CredentialStore } from "./credential-store.ts";
import {
	readCloudAuthConfig,
	type CloudAuthConfig,
} from "./configuration.ts";
import {
	isPlainRecord,
	NativeAuthError,
} from "./types.ts";
import type {
	DeviceAuthorization,
	NativeCredentialStorePort,
	PollAuthorizationResult,
	StoredCredentialState,
	TokenCredential,
} from "./types.ts";
import { acquireSessionOwner } from "./session-owner.ts";
import type { SessionOwner } from "./session-owner.ts";
import {
	createKeyringVault,
	type KeyringAsyncEntryConstructor,
} from "../vault/keyring.ts";
import type { SecureVault } from "../vault/types.ts";

/** UI-safe login progress. Codes are only the human display code. */
export type CloudAuthProgress = {
	readonly phase:
		| "starting"
		| "waiting"
		| "approved"
		| "denied"
		| "expired"
		| "cancelled"
		| "unavailable";
	readonly verificationUri?: string;
	readonly userCode?: string;
	readonly expiresIn?: number;
};

/** Local-only cloud-auth status. No account identity is invented. */
export type CloudAuthStatus = {
	readonly status:
		| "unconfigured"
		| "signed-out"
		| "signed-in"
		| "reauth-required"
		| "unavailable"
		| "busy";
};

/** Fixed login/logout outcome. No raw error or token is included. */
export type CloudAuthOutcome = {
	readonly status:
		| "signed-in"
		| "signed-out"
		| "denied"
		| "expired"
		| "cancelled"
		| "unavailable"
		| "reauth-required"
		| "busy";
};

/** UI-facing controller contract. */
export interface CloudAuthController {
	login(options?: {
		readonly signal?: AbortSignal;
		readonly onProgress?: (progress: CloudAuthProgress) => void;
	}): Promise<CloudAuthOutcome>;
	status(): Promise<CloudAuthStatus>;
	logout(): Promise<CloudAuthOutcome>;
	dispose(): Promise<void>;
}

/** Structural process-owner handle; compatible with `session-owner.ts`. */
export interface CloudAuthOwner {
	release(): Promise<void>;
}

/** Test-only seams. Production omits every member. */
export interface CloudAuthControllerDependencies {
	/** Injected fetch; production resolves the runtime global at request time. */
	readonly fetch?: NativeFetch;
	/** Wall clock in epoch milliseconds; used for stored-credential expiry. */
	readonly wallNow?: () => number;
	/** Monotonic clock in milliseconds; used only for login deadlines. */
	readonly monotonicNow?: () => number;
	/** Abort-aware sleep; resolves early when the signal aborts. */
	readonly sleep?: (
		milliseconds: number,
		signal: AbortSignal,
	) => Promise<void>;
	/** Async vault factory; production dynamically loads `@napi-rs/keyring`. */
	readonly createVault?: (config: CloudAuthConfig) => Promise<SecureVault>;
	/** Async owner acquisition; production uses session-owner.ts. */
	readonly acquireOwner?: (options: {
		readonly stateDirectory: string;
	}) => Promise<CloudAuthOwner>;
}

/** The optional native package is loaded through a variable module ID. */
const KEYRING_MODULE_ID = "@napi-rs/keyring";

const OUTCOME_SIGNED_IN: CloudAuthOutcome = Object.freeze({
	status: "signed-in",
});
const OUTCOME_SIGNED_OUT: CloudAuthOutcome = Object.freeze({
	status: "signed-out",
});
const OUTCOME_DENIED: CloudAuthOutcome = Object.freeze({ status: "denied" });
const OUTCOME_EXPIRED: CloudAuthOutcome = Object.freeze({ status: "expired" });
const OUTCOME_CANCELLED: CloudAuthOutcome = Object.freeze({
	status: "cancelled",
});
const OUTCOME_UNAVAILABLE: CloudAuthOutcome = Object.freeze({
	status: "unavailable",
});
const OUTCOME_REAUTH_REQUIRED: CloudAuthOutcome = Object.freeze({
	status: "reauth-required",
});
const OUTCOME_BUSY: CloudAuthOutcome = Object.freeze({ status: "busy" });

const STATUS_UNCONFIGURED: CloudAuthStatus = Object.freeze({
	status: "unconfigured",
});
const STATUS_SIGNED_OUT: CloudAuthStatus = Object.freeze({
	status: "signed-out",
});
const STATUS_SIGNED_IN: CloudAuthStatus = Object.freeze({
	status: "signed-in",
});
const STATUS_REAUTH_REQUIRED: CloudAuthStatus = Object.freeze({
	status: "reauth-required",
});
const STATUS_UNAVAILABLE: CloudAuthStatus = Object.freeze({
	status: "unavailable",
});
const STATUS_BUSY: CloudAuthStatus = Object.freeze({ status: "busy" });

type ProgressCallback = (progress: CloudAuthProgress) => void;

interface Resources {
	readonly owner: CloudAuthOwner;
	readonly client: NativeAuthClient;
	readonly store: TrackingCredentialStore;
}

interface ResolvedDependencies {
	readonly fetch: NativeFetch | undefined;
	readonly wallNow: () => number;
	readonly monotonicNow: () => number;
	readonly sleep: (
		milliseconds: number,
		signal: AbortSignal,
	) => Promise<void>;
	readonly createVault: (config: CloudAuthConfig) => Promise<SecureVault>;
	readonly acquireOwner: (options: {
		readonly stateDirectory: string;
	}) => Promise<CloudAuthOwner>;
}

/**
 * Creates the optional controller. An absent configuration returns a fixed
 * disabled controller without reading any dependency. A malformed
 * configuration returns a fixed unavailable controller.
 */
export function createCloudAuthController(
	rawConfig: unknown,
	deps?: CloudAuthControllerDependencies,
): CloudAuthController {
	let config: CloudAuthConfig | null;
	try {
		config = readCloudAuthConfig(rawConfig);
	} catch {
		return new StaticController(false);
	}
	if (config === null) return new StaticController(true);
	if (deps !== undefined && !isPlainRecord(deps)) {
		return new StaticController(false);
	}
	return new Controller(config, deps ?? {});
}

class StaticController implements CloudAuthController {
	constructor(private readonly unconfigured: boolean) {}

	login(): Promise<CloudAuthOutcome> {
		return Promise.resolve(OUTCOME_UNAVAILABLE);
	}

	status(): Promise<CloudAuthStatus> {
		return Promise.resolve(
			this.unconfigured ? STATUS_UNCONFIGURED : STATUS_UNAVAILABLE,
		);
	}

	logout(): Promise<CloudAuthOutcome> {
		return Promise.resolve(
			this.unconfigured ? OUTCOME_SIGNED_OUT : OUTCOME_UNAVAILABLE,
		);
	}

	dispose(): Promise<void> {
		return Promise.resolve();
	}
}

class Controller implements CloudAuthController {
	private readonly config: CloudAuthConfig;
	private readonly deps: CloudAuthControllerDependencies;
	private readonly pending = new Set<Promise<unknown>>();

	private resolvedDependencies: ResolvedDependencies | null = null;
	private resources: Resources | null = null;
	private initPromise: Promise<Resources> | null = null;
	private owner: CloudAuthOwner | null = null;

	private disposed = false;
	private disposePromise: Promise<void> | null = null;
	private activeLogin: {
		readonly promise: Promise<CloudAuthOutcome>;
		readonly abort: AbortController;
	} | null = null;
	private logoutPromise: Promise<CloudAuthOutcome> | null = null;

	constructor(config: CloudAuthConfig, deps: CloudAuthControllerDependencies) {
		this.config = config;
		this.deps = deps;
	}

	login(options?: {
		readonly signal?: AbortSignal;
		readonly onProgress?: (progress: CloudAuthProgress) => void;
	}): Promise<CloudAuthOutcome> {
		if (this.disposed) return Promise.resolve(OUTCOME_UNAVAILABLE);
		if (this.activeLogin !== null || this.logoutPromise !== null) {
			return Promise.resolve(OUTCOME_BUSY);
		}

		let parsed: {
			readonly signal: AbortSignal | undefined;
			readonly onProgress: ProgressCallback | undefined;
		};
		try {
			parsed = readLoginOptions(options);
		} catch {
			return Promise.resolve(OUTCOME_UNAVAILABLE);
		}

		const abort = new AbortController();
		const callerSignal = parsed.signal;
		const forwardAbort = (): void => abort.abort();
		if (callerSignal !== undefined) {
			if (callerSignal.aborted) abort.abort();
			else {
				callerSignal.addEventListener("abort", forwardAbort, {
					once: true,
				});
			}
		}

		const promise = this.runLogin(abort.signal, parsed.onProgress).catch(
			() => OUTCOME_UNAVAILABLE,
		);
		const active = { promise, abort };
		this.activeLogin = active;
		this.track(promise);
		void promise.then(
			() => this.finishLogin(active, callerSignal, forwardAbort),
			() => this.finishLogin(active, callerSignal, forwardAbort),
		);
		return promise;
	}

	status(): Promise<CloudAuthStatus> {
		const promise = this.performStatus();
		this.track(promise);
		return promise;
	}

	private async performStatus(): Promise<CloudAuthStatus> {
		if (this.disposed) return STATUS_UNAVAILABLE;
		if (this.activeLogin !== null || this.logoutPromise !== null) {
			return STATUS_BUSY;
		}

		let resources: Resources;
		try {
			resources = await this.ensureResources();
		} catch (error) {
			return isFailure(error, "busy")
				? STATUS_BUSY
				: STATUS_UNAVAILABLE;
		}
		if (this.disposed) return STATUS_UNAVAILABLE;
		if (this.activeLogin !== null || this.logoutPromise !== null) {
			return STATUS_BUSY;
		}

		let state: StoredCredentialState | null;
		try {
			state = await this.track(resources.store.read());
		} catch (error) {
			return error instanceof NativeAuthError &&
				error.code === "credential-corrupt"
				? STATUS_REAUTH_REQUIRED
				: STATUS_UNAVAILABLE;
		}

		if (state === null) return STATUS_SIGNED_OUT;
		if (state.state === "ready") {
			// Local status never refreshes and never hits the network. An expired
			// ready credential is still a refreshable signed-in state; the
			// lifecycle API can refresh later.
			return STATUS_SIGNED_IN;
		}
		// refresh-uncertain and unauthorized both fail closed to reauth.
		return STATUS_REAUTH_REQUIRED;
	}

	logout(): Promise<CloudAuthOutcome> {
		if (this.disposed) return Promise.resolve(OUTCOME_UNAVAILABLE);
		if (this.logoutPromise !== null) return this.logoutPromise;

		const promise = this.performLogout();
		this.logoutPromise = promise;
		this.track(promise);
		void promise.then(
			() => {
				if (this.logoutPromise === promise) this.logoutPromise = null;
			},
			() => {
				if (this.logoutPromise === promise) this.logoutPromise = null;
			},
		);
		return promise;
	}

	dispose(): Promise<void> {
		if (this.disposePromise !== null) return this.disposePromise;
		this.disposed = true;

		// Cache the promise before draining/abort callbacks can reenter dispose.
		// The rejection is preserved: a failed owner release must never be
		// reported as a successful cleanup.
		let resolveCleanup!: () => void;
		let rejectCleanup!: (error: unknown) => void;
		const promise = new Promise<void>((resolve, reject) => {
			resolveCleanup = resolve;
			rejectCleanup = reject;
		});
		this.disposePromise = promise;

		void this.performDispose().then(resolveCleanup, rejectCleanup);
		return promise;
	}

	private finishLogin(
		active: {
			readonly promise: Promise<CloudAuthOutcome>;
			readonly abort: AbortController;
		},
		callerSignal: AbortSignal | undefined,
		forwardAbort: () => void,
	): void {
		if (this.activeLogin === active) this.activeLogin = null;
		callerSignal?.removeEventListener("abort", forwardAbort);
	}

	private async runLogin(
		signal: AbortSignal,
		onProgress: ProgressCallback | undefined,
	): Promise<CloudAuthOutcome> {
		if (signal.aborted) {
			return this.terminal(onProgress, "cancelled", OUTCOME_CANCELLED);
		}

		let resources: Resources;
		try {
			resources = await this.ensureResources();
		} catch (error) {
			if (isFailure(error, "busy")) return OUTCOME_BUSY;
			return this.terminal(onProgress, "unavailable", OUTCOME_UNAVAILABLE);
		}

		if (signal.aborted) {
			return this.terminal(onProgress, "cancelled", OUTCOME_CANCELLED);
		}

		let requestStartedAt: number;
		try {
			requestStartedAt = this.readMonotonicNow();
		} catch {
			return this.terminal(onProgress, "unavailable", OUTCOME_UNAVAILABLE);
		}

		this.emit(onProgress, { phase: "starting" });

		let authorization: DeviceAuthorization;
		try {
			authorization = await this.track(
				resources.client.beginDeviceAuthorization({ signal }),
			);
		} catch (error) {
			return this.mapNativeFailure(error, signal, onProgress);
		}

		if (signal.aborted) {
			return this.terminal(onProgress, "cancelled", OUTCOME_CANCELLED);
		}

		let lifetimeMillis: number | null;
		let pollDelayMillis: number | null;
		try {
			lifetimeMillis = secondsToMillis(authorization.expiresIn);
			pollDelayMillis = secondsToMillis(authorization.pollInterval);
		} catch {
			return this.terminal(onProgress, "unavailable", OUTCOME_UNAVAILABLE);
		}
		if (lifetimeMillis === null || pollDelayMillis === null) {
			return this.terminal(onProgress, "unavailable", OUTCOME_UNAVAILABLE);
		}
		const deadline = requestStartedAt + lifetimeMillis;
		if (!Number.isFinite(deadline)) {
			return this.terminal(onProgress, "unavailable", OUTCOME_UNAVAILABLE);
		}

		// The human code is display-only and stays in this scope until the flow
		// settles. The device code is never emitted here.
		this.emit(onProgress, {
			phase: "waiting",
			verificationUri: authorization.verificationUri,
			userCode: authorization.userCode,
			expiresIn: authorization.expiresIn,
		});

		const deviceCode = authorization.deviceCode;
		let delayMillis = pollDelayMillis;

		for (;;) {
			if (signal.aborted) {
				return this.terminal(
					onProgress,
					"cancelled",
					OUTCOME_CANCELLED,
				);
			}

			let now: number;
			try {
				now = this.readMonotonicNow();
			} catch {
				return this.terminal(
					onProgress,
					"unavailable",
					OUTCOME_UNAVAILABLE,
				);
			}
			if (now >= deadline) {
				return this.terminal(onProgress, "expired", OUTCOME_EXPIRED);
			}
			// Never poll after the local device-code lifetime. Sleeping for the
			// full server interval would cross the deadline, so expire now.
			if (delayMillis >= deadline - now) {
				return this.terminal(onProgress, "expired", OUTCOME_EXPIRED);
			}

			try {
				await this.sleep(delayMillis, signal);
			} catch (error) {
				if (signal.aborted) {
					return this.terminal(
						onProgress,
						"cancelled",
						OUTCOME_CANCELLED,
					);
				}
				return this.terminal(
					onProgress,
					"unavailable",
					OUTCOME_UNAVAILABLE,
				);
			}
			if (signal.aborted) {
				return this.terminal(
					onProgress,
					"cancelled",
					OUTCOME_CANCELLED,
				);
			}

			try {
				now = this.readMonotonicNow();
			} catch {
				return this.terminal(
					onProgress,
					"unavailable",
					OUTCOME_UNAVAILABLE,
				);
			}
			if (now >= deadline) {
				return this.terminal(onProgress, "expired", OUTCOME_EXPIRED);
			}

			let result: PollAuthorizationResult;
			try {
				result = await this.track(
					resources.client.pollAuthorization(deviceCode, {
						signal,
					}),
				);
			} catch (error) {
				return this.mapNativeFailure(error, signal, onProgress);
			}

			if (result.status === "pending") {
				let nextDelay: number | null;
				try {
					nextDelay =
						result.retryAfterSeconds === undefined
							? secondsToMillis(authorization.pollInterval)
							: secondsToMillis(result.retryAfterSeconds);
				} catch {
					nextDelay = null;
				}
				if (nextDelay === null) {
					return this.terminal(
						onProgress,
						"unavailable",
						OUTCOME_UNAVAILABLE,
					);
				}
				delayMillis = nextDelay;
				continue;
			}

			if (result.status === "slow-down") {
				let nextDelay: number | null;
				try {
					nextDelay = secondsToMillis(result.retryAfterSeconds);
				} catch {
					nextDelay = null;
				}
				if (nextDelay === null) {
					return this.terminal(
						onProgress,
						"unavailable",
						OUTCOME_UNAVAILABLE,
					);
				}
				delayMillis = nextDelay;
				continue;
			}

			if (result.status === "denied") {
				return this.terminal(onProgress, "denied", OUTCOME_DENIED);
			}

			if (result.status === "expired" || result.status === "consumed") {
				return this.terminal(onProgress, "expired", OUTCOME_EXPIRED);
			}

			// Approved: the credential must be committed before any success is
			// reported. A store failure is not proof of absence or success.
			try {
				await this.track(
					resources.client.storeCredential(result.credential, {
						signal,
					}),
				);
			} catch (error) {
				return this.mapStoreFailure(error, signal, onProgress);
			}

			this.emit(onProgress, { phase: "approved" });
			return OUTCOME_SIGNED_IN;
		}
	}

	private async performLogout(): Promise<CloudAuthOutcome> {
		// Cancel and await the one login flow before touching the exact vault
		// entry; local deletion must never be overwritten by a late new token.
		const active = this.activeLogin;
		if (active !== null) {
			active.abort.abort();
			try {
				await active.promise;
			} catch {
				// The outcome is irrelevant to local deletion.
			}
		}
		if (this.disposed) return OUTCOME_UNAVAILABLE;

		let resources: Resources;
		try {
			resources = await this.ensureResources();
		} catch (error) {
			return isFailure(error, "busy")
				? OUTCOME_BUSY
				: OUTCOME_UNAVAILABLE;
		}

		try {
			await this.track(resources.client.logout());
			return OUTCOME_SIGNED_OUT;
		} catch {
			return OUTCOME_UNAVAILABLE;
		}
	}

	private async performDispose(): Promise<void> {
		const active = this.activeLogin;
		if (active !== null) {
			active.abort.abort();
			try {
				await active.promise;
			} catch {
				// Disposal continues regardless of the login outcome.
			}
		}

		if (this.logoutPromise !== null) {
			try {
				await this.logoutPromise;
			} catch {
				// Disposal continues regardless of the logout outcome.
			}
		}

		// All vault/HTTP operations started by this controller are awaited before
		// ownership is released. A pending write must settle first.
		await this.drainPending();

		const owner = this.owner;
		if (owner !== null) {
			try {
				await owner.release();
			} catch {
				// Fail closed: retain the controller state and existing lock
				// reference, reject with fixed sanitized copy, and never retry
				// automatically. The cached dispose promise keeps this result.
				throw new Error("Cloud sign-in cleanup failed.");
			}
			if (this.owner === owner) this.owner = null;
		}

		this.resources = null;
	}

	private ensureResources(): Promise<Resources> {
		if (this.resources !== null) {
			return Promise.resolve(this.resources);
		}
		if (this.initPromise !== null) return this.initPromise;

		const promise = this.initialize();
		this.initPromise = promise;
		this.track(promise);
		void promise.then(
			() => {
				if (this.initPromise === promise) this.initPromise = null;
			},
			() => {
				if (this.initPromise === promise) this.initPromise = null;
			},
		);
		return promise;
	}

	private async initialize(): Promise<Resources> {
		if (this.disposed) throw new ControllerFailure("unavailable");

		const deps = this.resolveDependencies();
		let owner: CloudAuthOwner;
		try {
			owner = await deps.acquireOwner({
				stateDirectory: this.config.stateDirectory,
			});
		} catch (error) {
			throw mapOwnerFailure(error);
		}
		if (
			!isPlainRecord(owner) ||
			typeof owner.release !== "function"
		) {
			throw new ControllerFailure("unavailable");
		}

		this.owner = owner;
		if (this.disposed) {
			await this.releaseOwner(owner);
			throw new ControllerFailure("unavailable");
		}

		let vault: SecureVault;
		try {
			vault = await deps.createVault(this.config);
		} catch {
			await this.releaseOwner(owner);
			throw new ControllerFailure("unavailable");
		}
		if (this.disposed) {
			await this.releaseOwner(owner);
			throw new ControllerFailure("unavailable");
		}

		let resources: Resources;
		try {
			const store = new CredentialStore({
				vault,
				entry: Object.freeze({
					service: this.config.vaultService,
					account: this.config.vaultAccount,
				}),
				maxCredentialBytes: this.config.maxCredentialBytes,
			});
			const tracking = new TrackingCredentialStore(store, this);
			const client = new NativeAuthClient({
				origin: this.config.origin,
				requestTimeoutMillis: this.config.requestTimeoutMillis,
				maxResponseBytes: this.config.maxResponseBytes,
				credentials: tracking,
				...(this.config.allowLoopbackHttp === undefined
					? {}
					: {
							allowLoopbackHttp:
								this.config.allowLoopbackHttp,
						}),
				...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
				now: deps.wallNow,
			});
			resources = {
				owner,
				client,
				store: tracking,
			};
		} catch {
			await this.releaseOwner(owner);
			throw new ControllerFailure("unavailable");
		}
		if (this.disposed) {
			await this.releaseOwner(owner);
			throw new ControllerFailure("unavailable");
		}
		this.resources = resources;
		return resources;
	}

	private resolveDependencies(): ResolvedDependencies {
		if (this.resolvedDependencies !== null) {
			return this.resolvedDependencies;
		}

		let fetch: NativeFetch | undefined;
		let wallNow: (() => number) | undefined;
		let monotonicNow: (() => number) | undefined;
		let sleep:
			| ((milliseconds: number, signal: AbortSignal) => Promise<void>)
			| undefined;
		let createVault:
			| ((config: CloudAuthConfig) => Promise<SecureVault>)
			| undefined;
		let acquireOwner:
			| ((options: {
					readonly stateDirectory: string;
			  }) => Promise<CloudAuthOwner>)
			| undefined;
		try {
			fetch = readOptionalFunction<NativeFetch>(this.deps.fetch);
			wallNow = readOptionalFunction<() => number>(this.deps.wallNow);
			monotonicNow =
				readOptionalFunction<() => number>(this.deps.monotonicNow);
			sleep = readOptionalFunction<
				(milliseconds: number, signal: AbortSignal) => Promise<void>
			>(this.deps.sleep);
			createVault = readOptionalFunction<
				(config: CloudAuthConfig) => Promise<SecureVault>
			>(this.deps.createVault);
			acquireOwner = readOptionalFunction<
				(options: {
					readonly stateDirectory: string;
				}) => Promise<CloudAuthOwner>
			>(this.deps.acquireOwner);
		} catch {
			throw new ControllerFailure("unavailable");
		}

		const resolved: ResolvedDependencies = {
			fetch,
			wallNow: wallNow ?? (() => Date.now()),
			monotonicNow: monotonicNow ?? (() => performance.now()),
			sleep: sleep ?? defaultSleep,
			createVault: createVault ?? defaultCreateVault,
			acquireOwner: acquireOwner ?? defaultAcquireOwner,
		};
		this.resolvedDependencies = resolved;
		return resolved;
	}

	private readMonotonicNow(): number {
		const value = this.resolveDependencies().monotonicNow();
		if (
			typeof value !== "number" ||
			!Number.isFinite(value) ||
			value < 0
		) {
			throw new ControllerFailure("unavailable");
		}
		return value;
	}

	private sleep(
		milliseconds: number,
		signal: AbortSignal,
	): Promise<void> {
		if (signal.aborted) return Promise.resolve();
		return this.resolveDependencies().sleep(milliseconds, signal);
	}

	private emit(
		onProgress: ProgressCallback | undefined,
		progress: CloudAuthProgress,
	): void {
		if (onProgress === undefined) return;
		try {
			onProgress(Object.freeze(progress));
		} catch {
			// UI callback failures are ignored; they must not corrupt the flow.
		}
	}

	private terminal(
		onProgress: ProgressCallback | undefined,
		phase: "denied" | "expired" | "cancelled" | "unavailable",
		outcome: CloudAuthOutcome,
	): CloudAuthOutcome {
		this.emit(onProgress, { phase });
		return outcome;
	}

	private mapNativeFailure(
		error: unknown,
		signal: AbortSignal,
		onProgress: ProgressCallback | undefined,
	): CloudAuthOutcome {
		if (signal.aborted) {
			return this.terminal(
				onProgress,
				"cancelled",
				OUTCOME_CANCELLED,
			);
		}
		if (error instanceof NativeAuthError) {
			switch (error.code) {
				case "aborted":
					return this.terminal(
						onProgress,
						"cancelled",
						OUTCOME_CANCELLED,
					);
				case "authorization-denied":
					return this.terminal(
						onProgress,
						"denied",
						OUTCOME_DENIED,
					);
				case "authorization-expired":
				case "authorization-consumed":
					return this.terminal(
						onProgress,
						"expired",
						OUTCOME_EXPIRED,
					);
				default:
					break;
			}
		}
		return this.terminal(onProgress, "unavailable", OUTCOME_UNAVAILABLE);
	}

	private mapStoreFailure(
		error: unknown,
		signal: AbortSignal,
		onProgress: ProgressCallback | undefined,
	): CloudAuthOutcome {
		if (
			signal.aborted &&
			error instanceof NativeAuthError &&
			error.code === "aborted"
		) {
			return this.terminal(
				onProgress,
				"cancelled",
				OUTCOME_CANCELLED,
			);
		}
		// The vault may contain a partial/uncertain state. Never report success;
		// the user must reauthorize.
		this.emit(onProgress, { phase: "unavailable" });
		return OUTCOME_REAUTH_REQUIRED;
	}

	track<T>(promise: Promise<T>): Promise<T> {
		this.pending.add(promise);
		const done = (): void => {
			this.pending.delete(promise);
		};
		void promise.then(done, done);
		return promise;
	}

	private async drainPending(): Promise<void> {
		while (this.pending.size > 0) {
			const batch = Array.from(this.pending);
			await Promise.allSettled(batch);
		}
	}

	private async releaseOwner(owner: CloudAuthOwner): Promise<void> {
		if (this.owner === owner) this.owner = null;
		try {
			await owner.release();
		} catch {
			// Fail closed; the lock is not unlocked by a fallback path.
		}
	}
}

class ControllerFailure extends Error {
	readonly code: "busy" | "unavailable";

	constructor(code: "busy" | "unavailable") {
		super("Cloud authentication is unavailable.");
		this.name = "ControllerFailure";
		this.code = code;
	}
}

class TrackingCredentialStore implements NativeCredentialStorePort {
	constructor(
		private readonly inner: CredentialStore,
		private readonly controller: Controller,
	) {}

	read(): Promise<StoredCredentialState | null> {
		return this.controller.track(this.inner.read());
	}

	writeReady(credential: TokenCredential): Promise<void> {
		return this.controller.track(this.inner.writeReady(credential));
	}

	markRefreshUncertain(): Promise<void> {
		return this.controller.track(this.inner.markRefreshUncertain());
	}

	markUnauthorized(): Promise<void> {
		return this.controller.track(this.inner.markUnauthorized());
	}

	remove(): Promise<boolean> {
		return this.controller.track(this.inner.remove());
	}
}

function readLoginOptions(value: unknown): {
	readonly signal: AbortSignal | undefined;
	readonly onProgress: ProgressCallback | undefined;
} {
	if (value === undefined) {
		return { signal: undefined, onProgress: undefined };
	}
	if (!isPlainRecord(value)) {
		throw new ControllerFailure("unavailable");
	}

	const signal = value.signal;
	if (signal !== undefined) validateAbortSignal(signal);
	const onProgress = value.onProgress;
	if (onProgress !== undefined && typeof onProgress !== "function") {
		throw new ControllerFailure("unavailable");
	}

	return {
		signal: signal as AbortSignal | undefined,
		onProgress: onProgress as ProgressCallback | undefined,
	};
}

function validateAbortSignal(value: unknown): asserts value is AbortSignal {
	if (value === null || typeof value !== "object") {
		throw new ControllerFailure("unavailable");
	}
	const candidate = value as {
		readonly aborted?: unknown;
		readonly addEventListener?: unknown;
		readonly removeEventListener?: unknown;
	};
	if (
		typeof candidate.aborted !== "boolean" ||
		typeof candidate.addEventListener !== "function" ||
		typeof candidate.removeEventListener !== "function"
	) {
		throw new ControllerFailure("unavailable");
	}
}

function readOptionalFunction<T>(value: unknown): T | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "function") {
		throw new ControllerFailure("unavailable");
	}
	return value as T;
}

function secondsToMillis(seconds: unknown): number | null {
	if (
		typeof seconds !== "number" ||
		!Number.isSafeInteger(seconds) ||
		seconds <= 0
	) {
		return null;
	}
	const milliseconds = seconds * 1000;
	return Number.isSafeInteger(milliseconds) ? milliseconds : null;
}

function isFailure(
	error: unknown,
	code: "busy" | "unavailable",
): boolean {
	return error instanceof ControllerFailure && error.code === code;
}

function mapOwnerFailure(error: unknown): ControllerFailure {
	if (error instanceof ControllerFailure) return error;
	const code =
		isPlainRecord(error) && typeof error.code === "string"
			? error.code
			: null;
	if (code === "owner-busy") return new ControllerFailure("busy");
	return new ControllerFailure("unavailable");
}

function defaultSleep(
	milliseconds: number,
	signal: AbortSignal,
): Promise<void> {
	return new Promise<void>((resolve) => {
		if (signal.aborted) {
			resolve();
			return;
		}
		let timer: ReturnType<typeof setTimeout>;
		const onAbort = (): void => {
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
			resolve();
		};
		timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, milliseconds);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

async function defaultCreateVault(
	config: CloudAuthConfig,
): Promise<SecureVault> {
	let loaded: unknown;
	try {
		loaded = await import(KEYRING_MODULE_ID);
	} catch {
		throw new ControllerFailure("unavailable");
	}
	const AsyncEntry = isPlainRecord(loaded)
		? loaded.AsyncEntry
		: undefined;
	if (typeof AsyncEntry !== "function") {
		throw new ControllerFailure("unavailable");
	}
	try {
		return createKeyringVault(
			AsyncEntry as KeyringAsyncEntryConstructor,
			{ maxSecretBytes: config.maxSecretBytes },
		);
	} catch {
		throw new ControllerFailure("unavailable");
	}
}

async function defaultAcquireOwner(options: {
	readonly stateDirectory: string;
}): Promise<CloudAuthOwner> {
	let owner: SessionOwner;
	try {
		owner = await acquireSessionOwner(options);
	} catch (error) {
		throw mapOwnerFailure(error);
	}
	return owner;
}
