/**
 * Narrow structural boundary over the public TUI `context.client` surface.
 *
 * These adapters never import the host runtime; they accept the host-provided
 * client as an untrusted value, resolve the specific methods they use with
 * runtime checks, and call only through public client methods. The narrow
 * interfaces below document the exact surface the adapters call and are used
 * for compile-time assertions against the installed OpenCode v2.0.22 TUI
 * declaration (`Plugin.Context["client"]`, the generated `OpenCodeClient`).
 *
 * Declaration boundary (O-12/OQ-12): the installed plugin hook `SessionDomain`
 * declaration omits `session.import` while the generated TUI client
 * declaration includes it; the generated client is also what the TUI plugin
 * context actually carries. This module therefore does not depend on any host
 * type at runtime: capability is detected at runtime (see
 * `probeSessionImportCapability`), and the compile-time assertions below only
 * pin the installed declaration relation so `tsc` flags a drift. No blanket
 * `any` is used anywhere; the single unknown-to-callable conversion point is
 * `resolveUnaryMethod`, which narrows a value proven callable by `typeof` to a typed call signature
 * and always invokes it with its owning object (`client[container]`) preserved
 * as the receiver, so a `this`-dependent host method behaves exactly as a
 * direct `client[container][method](input)` call would.
 *
 * Bounded evidence only: the v2.0.22 declaration/source research (E13/E14/E18)
 * and the one-run actual-TUI probe (E33) are not a cross-version or support
 * claim. Do not extend them.
 */

import type { Plugin } from "@opencode/plugin/tui";
import type { JsonObject } from "../../core/contracts/index.ts";

/* ------------------------------------------------------------------------- */
/* Errors                                                                    */
/* ------------------------------------------------------------------------- */

/** Stable machine-readable failure codes for host adapter setup/invocation. */
export type HostAdapterErrorCode =
	/** The installed client does not expose the required callable method. */
	| "capability-unavailable"
	/** The adapter was called with a request that violates the core port contract. */
	| "invalid-request"
	/** The host call resolved with a value that violates the declared response contract. */
	| "invalid-response";

/**
 * Fail-closed adapter error. Never wraps or replaces host API errors: errors
 * thrown by the public client itself propagate unchanged so restore/checkpoint
 * reporting stays truthful.
 */
export class HostAdapterError extends Error {
	readonly code: HostAdapterErrorCode;

	constructor(code: HostAdapterErrorCode, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "HostAdapterError";
		this.code = code;
	}
}

/* ------------------------------------------------------------------------- */
/* Narrow client surface (documentation + compile-time assertions)           */
/* ------------------------------------------------------------------------- */

/** One `session.list` request as mapped from `SessionListPageRequest`. */
export interface SessionListCallInput {
	/** Explicit project scope; mapped to the list route's `project` filter. */
	readonly project: string;
	/** Explicit page size; the API default is never relied on. */
	readonly limit: number;
	/** Opaque `cursor.next`; absent on the first request. */
	readonly cursor?: string;
}

/** One `message.list` request as mapped from `MessageListPageRequest`. */
export interface MessageListCallInput {
	/** Route-scoped session ID (the ownership boundary). */
	readonly sessionID: string;
	/** Explicit page size; the API default is never relied on. */
	readonly limit: number;
	/** First page only: ascending order. */
	readonly order?: "asc";
	/** Subsequent pages only: opaque cursor; no `order`, no `type` filter. */
	readonly cursor?: string;
}

/**
 * One `session.get` request as mapped from the checkpoint dependency port.
 *
 * The pinned v2.0.22 generated client declares
 * `get(input: SessionGetInput) => Promise<SessionInfo>` where `SessionGetInput`
 * is exactly `{ readonly sessionID: string }` and the resolved value is the
 * already-unwrapped `SessionInfo` (the protocol `{ data }` envelope is
 * unwrapped by the generated promise client, not by this adapter). Only this
 * one field is ever sent.
 */
export interface SessionGetCallInput {
	/** The single session ID to resolve; the only field ever sent. */
	readonly sessionID: string;
}

/**
 * Narrow structural view of the public read surface used for enumeration.
 *
 * All members are optional because capability absence is a real runtime state
 * (E1/OQ-12): the adapters fail closed with a clear `HostAdapterError` when a
 * method is missing or not callable. Method syntax is intentional: it keeps
 * the installed generated client assignable (bivariant parameter check) while
 * the runtime resolver below still validates callability before every use.
 */
export interface SessionReadClientLike {
	readonly session?: {
		list?(input: SessionListCallInput): Promise<unknown>;
		/**
		 * Optional `session.get`, required only by the checkpoint
		 * dependency-closure adapter (`createSessionDependencyReadAdapter`).
		 * The restore destination-snapshot adapter
		 * (`createSessionReadAdapter`) never resolves or calls it, so a
		 * list-only client remains sufficient for restore. The pinned
		 * declaration resolves the unwrapped `SessionInfo` directly (no
		 * `{ data }` envelope), which is the raw value the dependency adapter
		 * passes through unchanged.
		 */
		get?(input: SessionGetCallInput): Promise<unknown>;
	};
	readonly message?: {
		list?(input: MessageListCallInput): Promise<unknown>;
	};
}

/**
 * One `session.import` call payload: the final planned record (`info` and
 * `messages` are passed through verbatim, never re-derived here) plus the
 * explicit target location supplied by the caller.
 *
 * `location` is typed optional/nullable only so the installed v2.0.22
 * generated declaration (`SessionImportInput`, whose `location` is optional
 * and nullable) remains assignable to this narrow view; the import adapter
 * always supplies it (O-16: V1 always supplies an explicit target).
 */
export interface SessionImportCallInput {
	readonly info: JsonObject;
	readonly messages: readonly JsonObject[];
	readonly location?: { readonly directory: string } | null;
}

/**
 * Validated narrow view of one `session.import` response.
 *
 * The pinned v2.0.22 public TUI client (`context.client`, the generated promise
 * client) unwraps the raw protocol `{ data: SessionInfo }` envelope and
 * resolves the `SessionInfo` directly: its declaration is
 * `import(input) => Promise<SessionInfo>`, and `SessionInfo` carries
 * non-optional `id`, `projectID`, and `location.directory`. The generated
 * client casts the JSON body to that declared type without runtime validation,
 * so the import adapter re-proves these fields at this dynamic boundary before
 * treating a response as confirmed; it returns the original response value
 * unchanged after narrowing. Only the fields SessionPort relies on are
 * declared here.
 */
export interface SessionImportResult {
	readonly id: string;
	readonly projectID: string;
	readonly location: { readonly directory: string };
}

/**
 * Narrow structural view of the public import surface. `import` is optional
 * because it may be absent or non-callable at runtime (O-12 policy: probe at
 * restore start and stop with a clear message before reading or decrypting).
 * The resolved value is intentionally `unknown` at this raw boundary: the
 * generated client does not runtime-validate its JSON, so the import adapter
 * proves the declared `SessionInfo` fields (`SessionImportResult`) before a
 * response is treated as confirmed.
 */
export interface SessionImportClientLike {
	readonly session?: {
		import?(input: SessionImportCallInput): Promise<unknown>;
	};
}

/* ------------------------------------------------------------------------- */
/* Compile-time assertions against the installed TUI client declaration      */
/* ------------------------------------------------------------------------- */

type HostTuiClient = Plugin.Context["client"];
type AssertTrue<T extends true> = T;

/**
 * The installed v2.0.22 TUI client (`Plugin.Context["client"]`) must satisfy
 * the narrow read surface; if a future pinned declaration drifts, `tsc` fails
 * here instead of failing at runtime.
 */
type _AssertHostReadClientCompatible = AssertTrue<HostTuiClient extends SessionReadClientLike ? true : false>;

/**
 * The installed v2.0.22 declaration must keep `session.get` accepting exactly
 * the narrow `{ sessionID }` input the dependency adapter sends. Drift in the
 * input shape is a compile error, not a runtime surprise.
 */
type _AssertHostSessionGetInputCompatible = AssertTrue<
	Parameters<HostTuiClient["session"]["get"]>[0] extends SessionGetCallInput ? true : false
>;

/**
 * The declared `session.get` output must stay the already-unwrapped
 * `SessionInfo` (declared `Promise<SessionInfo>`, not a `{ data: SessionInfo }`
 * envelope). The dependency adapter returns this raw value to the core
 * collector unchanged and performs no envelope fallback, so a declaration
 * change back to an enveloped shape must fail compilation here.
 */
type HostSessionGetOutput = Awaited<ReturnType<HostTuiClient["session"]["get"]>>;
type _AssertHostSessionGetOutputIsDirectSessionInfo = AssertTrue<
	HostSessionGetOutput extends { readonly id: string; readonly projectID: string } ? true : false
>;

/**
 * The installed declaration must expose the import surface with a payload
 * shape compatible with `SessionImportCallInput` and a top-level `location`
 * target field. This pins the declaration side of the known
 * `SessionDomain`-vs-generated-client mismatch to the narrowest typed
 * boundary; runtime callability is still checked by the probe.
 */
type _AssertHostImportClientCompatible = AssertTrue<HostTuiClient extends SessionImportClientLike ? true : false>;
type _AssertHostImportInputCompatible = AssertTrue<
	Parameters<HostTuiClient["session"]["import"]>[0] extends SessionImportCallInput ? true : false
>;
type _AssertHostImportInputHasLocationTarget = AssertTrue<
	Parameters<HostTuiClient["session"]["import"]>[0] extends { location?: { directory: string } | null | undefined }
		? true
		: false
>;

/**
 * The declared `session.import` output must keep exposing the fields the
 * adapter validates (`id`, `projectID`, `location.directory`); drift in those
 * fields is a compile error, not a silent runtime fallback. The declaration
 * type is the unwrapped `SessionInfo` (the raw `{ data }` envelope is already
 * unwrapped by the generated promise client), which is exactly what the
 * runtime guard in `session-import.ts` re-proves.
 */
type HostImportOutput = Awaited<ReturnType<HostTuiClient["session"]["import"]>>;
type _AssertHostImportOutputHasValidatedFields = AssertTrue<
	HostImportOutput extends {
		readonly id: string;
		readonly projectID: string;
		readonly location: { readonly directory: string };
	}
		? true
		: false
>;

/* ------------------------------------------------------------------------- */
/* Runtime resolution helpers                                                */
/* ------------------------------------------------------------------------- */

/** True for non-null, non-array object values; used on untrusted client values. */
export function isObjectRecord(value: unknown): value is { readonly [key: string]: unknown } {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

type UnaryMethod<Input> = (input: Input) => Promise<unknown>;

/**
 * Resolves `client[container][method]` to a typed call signature only when the
 * value is actually a function. This is the single unknown-to-typed conversion
 * boundary: the `typeof` check proves callability, and the returned wrapper
 * awaits whatever the host method returns so the result is always a Promise.
 *
 * The wrapper preserves the exact owning object (`client[container]`) as the
 * receiver via `Reflect.apply`, so a host method that depends on `this` (class
 * method, prototype method, non-arrow object property) is invoked with the
 * same receiver a direct `client[container][method](input)` call would supply.
 * The installed v2.0.22 generated promise client happens to build these
 * methods as arrow closures over its transport (which ignore the receiver),
 * but the adapter must not depend on that implementation detail.
 */
export function resolveUnaryMethod<Input>(client: unknown, container: string, method: string): UnaryMethod<Input> | undefined {
	if (!isObjectRecord(client)) return undefined;
	const owner = client[container];
	if (!isObjectRecord(owner)) return undefined;
	const candidate = owner[method];
	if (typeof candidate !== "function") return undefined;
	const callable = candidate as (...args: unknown[]) => unknown;
	return async (input: Input) => Reflect.apply(callable, owner, [input]);
}

/** Requires a non-empty string or fails closed with `invalid-request`. */
export function requireNonEmptyString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new HostAdapterError("invalid-request", `${label} must be a non-empty string`);
	}
	return value;
}

/** Requires a positive safe integer or fails closed with `invalid-request`. */
export function requirePositiveSafeInteger(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
		throw new HostAdapterError("invalid-request", `${label} must be a positive safe integer`);
	}
	return value;
}
