/**
 * Pure "verified replacement" policy for the local-only 0.1.7 restore path.
 *
 * This module owns ONLY pure policy/verification helpers:
 * - `prepareStandaloneRecord` strips the three schema-defined session-reference
 *   fields from a checkpoint record so it can be imported as a root session.
 * - `fingerprintSessionRecord` returns a stable SHA-256 fingerprint over the
 *   complete canonical `{info, messages}` record.
 * - `classifyReplacement` decides whether a confirmed local target session may
 *   be deleted/replaced based on explicit authorization and a COMPLETE global
 *   session-info inventory.
 * - `verifyImportedRecord` compares the imported host readback against the
 *   expected planned record.
 *
 * It makes no host call, file/network access, Git operation, LLM call, tool
 * call, or crypto-container operation. Unknown opaque metadata is preserved and
 * is not treated as a reference; only schema-defined reference fields are
 * inspected.
 *
 * COMPARE-AND-SWAP LIMITATION: `classifyReplacement` is a point-in-time policy
 * decision, not a CAS primitive. It cannot prevent a host session from changing
 * (new messages, children, incoming forks, metadata) after classification and
 * before deletion. The caller MUST manually quiesce the host (no active turns,
 * no concurrent imports/forks) and take a fresh `fingerprintSessionRecord`
 * immediately before the delete/import step. If that fresh fingerprint differs
 * from the fingerprint used for the preview/classification, the caller must
 * stop and re-classify. No core guarantee closes this race.
 *
 * EVIDENCE BOUNDARY: the only allowed readback normalizations are the ones
 * observed by `scripts/host-probes/native-replacement`: host-assigned
 * `info.projectID`, retargeted `info.location = { directory }`, host-updated
 * `info.time.updated` inside the import window, and absent/null root
 * `parentID`/`fork`/`revert`. No other field, extra key, type change, message
 * field, tool part, role, order, or timestamp is ignored.
 */

import {
	snapshotJsonValue,
	type JsonObject,
	type JsonValue,
	type SessionRecord,
} from "../contracts/index.ts";
import { findSchemaReferenceViolation } from "../sessions/references.ts";
import { findUnsettledMessageReason } from "../sessions/unsettled.ts";

/* ------------------------------------------------------------------------- */
/* Errors and public result types                                            */
/* ------------------------------------------------------------------------- */

/** Fixed, content-free failure codes for replacement input rejection. */
export type ReplacementPolicyErrorCode = "invalid-input" | "invalid-record" | "unsupported-reference";

/**
 * Redacted fail-closed error. The message is a fixed literal: it never includes
 * session content, IDs, paths, host text, or a `cause`.
 */
export class ReplacementPolicyError extends Error {
	readonly code: ReplacementPolicyErrorCode;

	constructor(code: ReplacementPolicyErrorCode) {
		super("SessionPort replacement policy rejected the input");
		this.name = "ReplacementPolicyError";
		this.code = code;
	}
}

/** Replacement is either a confirmed delete+import or a non-destructive copy. */
export type ReplacementMode = "replace" | "copy";

/** Stable reasons a classification falls back to copy (no delete). */
export type ReplacementCopyReason =
	| "target-missing"
	| "target-not-authorized"
	| "source-unsettled"
	| "target-unsettled"
	| "source-unsupported-tool"
	| "target-unsupported-tool"
	| "source-has-references"
	| "target-has-references"
	| "source-has-children"
	| "source-has-incoming-references"
	| "target-has-incoming-references"
	| "inventory-missing"
	| "inventory-incomplete"
	| "inventory-malformed"
	| "inventory-unknown-reference";

export interface ReplacementClassification {
	readonly mode: ReplacementMode;
	readonly reason?: ReplacementCopyReason;
}

/**
 * Input for classification. `source` is the artifact/planned standalone record;
 * `target` is the confirmed local session to delete; `authorizedTargetID` is the
 * user's explicit target confirmation and must exactly equal `target.info.id`.
 *
 * `referenceInventory` is a COMPLETE combined inventory of destination and
 * artifact-payload-closure session infos (`info` objects only). The caller maps
 * adapter records to JSON infos before calling; this module deliberately does
 * not import adapter types.
 */
export interface ClassifyReplacementInput {
	readonly source: SessionRecord;
	/**
	 * The confirmed local target. `undefined` means the caller observed target
	 * absence; that case belongs to the import path, and this helper returns a
	 * non-destructive copy as a defensive fallback.
	 */
	readonly target: SessionRecord | undefined;
	readonly authorizedTargetID: string;
	readonly referenceInventory: readonly JsonObject[];
	readonly inventoryComplete: boolean;
}

/** Fixed failure reasons for strict imported-record verification. */
export type ImportVerificationReason =
	| "invalid-input"
	| "expected-malformed"
	| "actual-malformed"
	| "expected-references"
	| "session-id"
	| "session-reference"
	| "session-project"
	| "session-location"
	| "session-title"
	| "session-created"
	| "session-updated-window"
	| "session-idle"
	| "session-time"
	| "session-fields"
	| "message-count"
	| "message-id"
	| "message-mismatch";

export interface ImportedRecordVerification {
	readonly verified: boolean;
	readonly reason?: ImportVerificationReason;
}

/**
 * `expected` is the standalone, planner-rewritten record. `actual` is the host
 * readback (`{info, messages}`). `canonicalProjectID` is the host-confirmed
 * destination project ID from the import response/GET. `locationDirectory` is
 * the explicit canonical import target. `importStartedAt`/`importFinishedAt`
 * are the caller's inclusive import window for `info.time.updated`.
 */
export interface VerifyImportedRecordInput {
	readonly expected: SessionRecord;
	readonly actual: SessionRecord;
	readonly canonicalProjectID: string;
	readonly locationDirectory: string;
	readonly importStartedAt: number;
	readonly importFinishedAt: number;
}

/* ------------------------------------------------------------------------- */
/* JSON helpers                                                              */
/* ------------------------------------------------------------------------- */

function isJsonObject(value: unknown): value is { readonly [key: string]: JsonValue } {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: JsonObject, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(value, key);
}

/**
 * Detached JSON-only record snapshot with the minimal `SessionRecord` shape
 * required by the core planner: exactly `info` and `messages`, a string session
 * id, and object messages with string ids. Non-JSON values, getters, cycles,
 * class instances, non-finite numbers, `-0`, sparse arrays, and extra top-level
 * keys fail closed.
 */
function snapshotSessionRecord(value: unknown, code: ReplacementPolicyErrorCode): SessionRecord {
	let snapshot: JsonValue;
	try {
		snapshot = snapshotJsonValue(value, "$record");
	} catch {
		throw new ReplacementPolicyError(code);
	}
	if (!isJsonObject(snapshot)) throw new ReplacementPolicyError(code);

	const keys = Object.keys(snapshot);
	if (keys.length !== 2 || !hasOwn(snapshot, "info") || !hasOwn(snapshot, "messages")) {
		throw new ReplacementPolicyError(code);
	}

	const info = snapshot["info"];
	if (!isJsonObject(info)) throw new ReplacementPolicyError(code);
	const sessionID = info["id"];
	if (typeof sessionID !== "string" || !sessionID.startsWith("ses")) throw new ReplacementPolicyError(code);

	const rawMessages = snapshot["messages"];
	if (!Array.isArray(rawMessages)) throw new ReplacementPolicyError(code);
	const messages: JsonObject[] = [];
	// `snapshotJsonValue` deliberately creates null-prototype arrays, which are
	// not iterable (Array.prototype supplies Symbol.iterator). Index access is
	// required here.
	for (let index = 0; index < rawMessages.length; index++) {
		const rawMessage = rawMessages[index]!;
		if (!isJsonObject(rawMessage)) throw new ReplacementPolicyError(code);
		const messageID = rawMessage["id"];
		if (typeof messageID !== "string" || !messageID.startsWith("msg_")) {
			throw new ReplacementPolicyError(code);
		}
		messages.push(rawMessage);
	}

	return { info, messages };
}

function cloneObject(source: JsonObject): { [key: string]: JsonValue } {
	const copy = Object.create(null) as { [key: string]: JsonValue };
	for (const key of Object.keys(source)) copy[key] = source[key]!;
	return copy;
}

function withoutKeys(source: JsonObject, keys: readonly string[]): { [key: string]: JsonValue } {
	const copy = cloneObject(source);
	for (const key of keys) delete copy[key];
	return copy;
}

/**
 * Canonical JSON string: object keys sorted recursively at every level; array
 * order, primitive values, IDs, and absent-vs-null are preserved exactly.
 * Iterative so deeply nested payloads cannot overflow the call stack.
 */
function canonicalJson(root: JsonValue): string {
	type WorkItem =
		| { readonly kind: "value"; readonly value: JsonValue }
		| { readonly kind: "text"; readonly text: string };
	const parts: string[] = [];
	const stack: WorkItem[] = [{ kind: "value", value: root }];

	while (stack.length > 0) {
		const item = stack.pop()!;
		if (item.kind === "text") {
			parts.push(item.text);
			continue;
		}

		const value = item.value;
		if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
			const encoded = JSON.stringify(value);
			if (encoded === undefined) throw new ReplacementPolicyError("invalid-record");
			parts.push(encoded);
			continue;
		}

		if (Array.isArray(value)) {
			stack.push({ kind: "text", text: "]" });
			for (let index = value.length - 1; index >= 0; index--) {
				stack.push({ kind: "value", value: value[index]! });
				if (index > 0) stack.push({ kind: "text", text: "," });
			}
			stack.push({ kind: "text", text: "[" });
			continue;
		}

		const objectValue = value as { readonly [key: string]: JsonValue };
		const sortedKeys = Object.keys(objectValue).sort();
		stack.push({ kind: "text", text: "}" });
		for (let index = sortedKeys.length - 1; index >= 0; index--) {
			const key = sortedKeys[index]!;
			stack.push({ kind: "value", value: objectValue[key]! });
			stack.push({ kind: "text", text: `${JSON.stringify(key)}:` });
			if (index > 0) stack.push({ kind: "text", text: "," });
		}
		stack.push({ kind: "text", text: "{" });
	}

	return parts.join("");
}

/* ------------------------------------------------------------------------- */
/* SHA-256 (portable, dependency-free)                                       */
/* ------------------------------------------------------------------------- */

const SHA256_INITIAL: readonly number[] = [
	0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

const SHA256_ROUND_CONSTANTS: readonly number[] = [
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
	0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
	0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
	0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
	0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
	0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
	0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function rotateRight(value: number, distance: number): number {
	return (value >>> distance) | (value << (32 - distance));
}

function sha256Hex(input: string): string {
	const bytes = new TextEncoder().encode(input);
	const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
	const data = new Uint8Array(paddedLength);
	data.set(bytes);
	data[bytes.length] = 0x80;

	const bitLength = BigInt(bytes.length) * 8n;
	for (let index = 0; index < 8; index++) {
		data[paddedLength - 1 - index] = Number((bitLength >> BigInt(8 * index)) & 0xffn);
	}

	const hash = [...SHA256_INITIAL];
	const schedule = new Uint32Array(64);

	for (let offset = 0; offset < paddedLength; offset += 64) {
		for (let index = 0; index < 16; index++) {
			const position = offset + index * 4;
			schedule[index] =
				((data[position]! << 24) |
					(data[position + 1]! << 16) |
					(data[position + 2]! << 8) |
					data[position + 3]!) >>>
				0;
		}
		for (let index = 16; index < 64; index++) {
			const previous15 = schedule[index - 15]!;
			const previous2 = schedule[index - 2]!;
			const sigma0 = rotateRight(previous15, 7) ^ rotateRight(previous15, 18) ^ (previous15 >>> 3);
			const sigma1 = rotateRight(previous2, 17) ^ rotateRight(previous2, 19) ^ (previous2 >>> 10);
			schedule[index] = (schedule[index - 16]! + sigma0 + schedule[index - 7]! + sigma1) >>> 0;
		}

		let a = hash[0]!;
		let b = hash[1]!;
		let c = hash[2]!;
		let d = hash[3]!;
		let e = hash[4]!;
		let f = hash[5]!;
		let g = hash[6]!;
		let h = hash[7]!;

		for (let index = 0; index < 64; index++) {
			const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
			const choose = (e & f) ^ (~e & g);
			const temp1 = (h + sum1 + choose + SHA256_ROUND_CONSTANTS[index]! + schedule[index]!) >>> 0;
			const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
			const majority = (a & b) ^ (a & c) ^ (b & c);
			const temp2 = (sum0 + majority) >>> 0;

			h = g;
			g = f;
			f = e;
			e = (d + temp1) >>> 0;
			d = c;
			c = b;
			b = a;
			a = (temp1 + temp2) >>> 0;
		}

		hash[0] = (hash[0]! + a) >>> 0;
		hash[1] = (hash[1]! + b) >>> 0;
		hash[2] = (hash[2]! + c) >>> 0;
		hash[3] = (hash[3]! + d) >>> 0;
		hash[4] = (hash[4]! + e) >>> 0;
		hash[5] = (hash[5]! + f) >>> 0;
		hash[6] = (hash[6]! + g) >>> 0;
		hash[7] = (hash[7]! + h) >>> 0;
	}

	let output = "";
	for (const word of hash) output += word.toString(16).padStart(8, "0");
	return output;
}

/* ------------------------------------------------------------------------- */
/* Standalone/root preparation and fingerprint                               */
/* ------------------------------------------------------------------------- */

/**
 * Returns a detached standalone copy of one record: ONLY `info.parentID`,
 * `info.fork`, and `info.revert` are removed. Everything else is preserved
 * exactly, including every message, tool part, timestamp, opaque metadata, and
 * absent/null distinction.
 *
 * Present non-null schema-defined references are validated before removal. A
 * present reference with an invalid shape is rejected with the fixed
 * `ReplacementPolicyError` (`unsupported-reference`) instead of being silently
 * dropped. Null values are treated as absent for these three fields. Unknown
 * opaque metadata is never interpreted as a reference.
 */
export function prepareStandaloneRecord(record: SessionRecord): SessionRecord {
	const snapshot = snapshotSessionRecord(record, "invalid-record");

	const validationInfo = cloneObject(snapshot.info);
	for (const key of ["parentID", "fork", "revert"] as const) {
		if (validationInfo[key] === null) delete validationInfo[key];
	}
	if (findSchemaReferenceViolation(validationInfo, "record.info") !== undefined) {
		throw new ReplacementPolicyError("unsupported-reference");
	}

	const info = cloneObject(snapshot.info);
	delete info["parentID"];
	delete info["fork"];
	delete info["revert"];
	return { info, messages: snapshot.messages };
}

/**
 * Stable SHA-256 (lowercase hex) fingerprint over the COMPLETE canonical
 * `{info, messages}` record. Object keys are sorted recursively; array order,
 * values, and absent-vs-null are preserved. Strict JSON-only validation rejects
 * non-JSON/unstable values instead of coercing or omitting them.
 *
 * This is a change detector, not an authentication tag or a CAS primitive. The
 * caller must take a fresh fingerprint immediately before delete.
 */
export function fingerprintSessionRecord(record: SessionRecord): string {
	const snapshot = snapshotSessionRecord(record, "invalid-record");
	const canonical = canonicalJson({ info: snapshot.info, messages: snapshot.messages } as unknown as JsonValue);
	return sha256Hex(canonical);
}

/* ------------------------------------------------------------------------- */
/* Replacement classification                                                */
/* ------------------------------------------------------------------------- */

type MessageBlocker = "unsettled" | "unsupported-tool";

function firstUnsettled(record: SessionRecord): MessageBlocker | undefined {
	for (const message of record.messages) {
		if (findUnsettledMessageReason(message) !== undefined) return "unsettled";
	}
	for (const message of record.messages) {
		if (hasRunningToolPart(message)) return "unsupported-tool";
	}
	return undefined;
}

/** Detects a tool part in `running` state; other states/opaque metadata are untouched. */
function hasRunningToolPart(message: JsonObject): boolean {
	const content = message["content"];
	if (!Array.isArray(content)) return false;
	// Snapshot arrays are null-prototype and therefore not iterable; index access.
	for (let index = 0; index < content.length; index++) {
		const part = content[index]!;
		if (!isJsonObject(part) || part["type"] !== "tool") continue;
		const state = part["state"];
		if (isJsonObject(state) && state["status"] === "running") return true;
	}
	return false;
}

/** Any present, non-null schema reference makes the session non-standalone. */
function hasSessionReference(info: JsonObject): boolean {
	for (const key of ["parentID", "fork", "revert"] as const) {
		const value = info[key];
		if (value !== undefined && value !== null) return true;
	}
	return false;
}

interface InventoryEntry {
	readonly id: string;
	/** Full detached info snapshot, used only to compare duplicate combined entries. */
	readonly info: JsonObject;
	readonly parentID: string | undefined;
	readonly forkSessionID: string | undefined;
	readonly boundaryMessageID: string | undefined;
	readonly revertMessageID: string | undefined;
}

type InventoryScan =
	| { readonly ok: true; readonly entries: readonly InventoryEntry[] }
	| { readonly ok: false; readonly reason: ReplacementCopyReason };

/**
 * Strictly validates the inventory infos. Any missing/malformed entry, a
 * conflicting duplicate id, or an unknown session reference yields `ok:false`;
 * it never throws and never silently ignores an inventory problem.
 *
 * The caller may combine destination and artifact infos, so the same session
 * can legitimately appear twice. An exact duplicate (canonically identical full
 * info) is collapsed; a duplicate with different content is ambiguous and fails
 * closed. This is deduplication of identical evidence, not tolerance for a
 * conflicting record.
 */
function scanInventory(rawInventory: unknown): InventoryScan {
	if (rawInventory === undefined) return { ok: false, reason: "inventory-missing" };
	if (!Array.isArray(rawInventory)) return { ok: false, reason: "inventory-malformed" };

	const entriesByID = new Map<string, InventoryEntry>();
	for (let index = 0; index < rawInventory.length; index++) {
		let snapshot: JsonValue;
		try {
			snapshot = snapshotJsonValue(rawInventory[index], `$inventory[${index}]`);
		} catch {
			return { ok: false, reason: "inventory-malformed" };
		}
		if (!isJsonObject(snapshot)) return { ok: false, reason: "inventory-malformed" };

		const id = snapshot["id"];
		if (typeof id !== "string" || id.length === 0) {
			return { ok: false, reason: "inventory-malformed" };
		}
		const existing = entriesByID.get(id);
		if (existing !== undefined) {
			if (canonicalJson(existing.info) !== canonicalJson(snapshot)) {
				return { ok: false, reason: "inventory-malformed" };
			}
			continue;
		}

		const rawParentID = snapshot["parentID"];
		let parentID: string | undefined;
		if (rawParentID !== undefined && rawParentID !== null) {
			if (typeof rawParentID !== "string" || rawParentID.length === 0) {
				return { ok: false, reason: "inventory-malformed" };
			}
			parentID = rawParentID;
		}

		const rawFork = snapshot["fork"];
		let forkSessionID: string | undefined;
		let boundaryMessageID: string | undefined;
		if (rawFork !== undefined && rawFork !== null) {
			if (!isJsonObject(rawFork)) return { ok: false, reason: "inventory-malformed" };
			const sessionID = rawFork["sessionID"];
			if (typeof sessionID !== "string" || sessionID.length === 0) {
				return { ok: false, reason: "inventory-malformed" };
			}
			const boundary = rawFork["boundary"];
			if (!isJsonObject(boundary)) return { ok: false, reason: "inventory-malformed" };
			const boundaryType = boundary["type"];
			const messageID = boundary["messageID"];
			if ((boundaryType !== "before" && boundaryType !== "through") ||
				typeof messageID !== "string" || messageID.length === 0) {
				return { ok: false, reason: "inventory-malformed" };
			}
			forkSessionID = sessionID;
			boundaryMessageID = messageID;
		}

		const rawRevert = snapshot["revert"];
		let revertMessageID: string | undefined;
		if (rawRevert !== undefined && rawRevert !== null) {
			if (!isJsonObject(rawRevert)) return { ok: false, reason: "inventory-malformed" };
			const messageID = rawRevert["messageID"];
			if (typeof messageID !== "string" || messageID.length === 0) {
				return { ok: false, reason: "inventory-malformed" };
			}
			revertMessageID = messageID;
		}

		entriesByID.set(id, { id, info: snapshot, parentID, forkSessionID, boundaryMessageID, revertMessageID });
	}

	const entries = [...entriesByID.values()];
	const ids = new Set(entriesByID.keys());
	for (const entry of entries) {
		if (entry.parentID !== undefined && !ids.has(entry.parentID)) {
			return { ok: false, reason: "inventory-unknown-reference" };
		}
		if (entry.forkSessionID !== undefined && !ids.has(entry.forkSessionID)) {
			return { ok: false, reason: "inventory-unknown-reference" };
		}
	}

	return { ok: true, entries };
}

/**
 * Classifies whether one confirmed target session can be replaced. Returns
 * `{ mode: "copy" }` with a fixed reason for every policy uncertainty; it never
 * authorizes deletion from a session ID alone.
 *
 * Replace requires ALL of:
 * - explicit non-empty `authorizedTargetID` exactly equal to `target.info.id`;
 * - source and target are standalone (no non-null parentID/fork/revert);
 * - all source and target messages are settled and contain no running tool part;
 * - complete inventory (`inventoryComplete === true`), well-formed entries, both
 *   source and target present, all session references resolvable;
 * - no child session (`parentID`) and no incoming fork/revert reference to the
 *   source or target from any inventory entry.
 *
 * A target that does not exist is not handled here: the caller uses the import
 * path instead. Source and target IDs are not required to match; the explicit
 * `authorizedTargetID` is the confirmation.
 */
export function classifyReplacement(input: ClassifyReplacementInput): ReplacementClassification {
	const copy = (reason: ReplacementCopyReason): ReplacementClassification => ({ mode: "copy", reason });

	const rawInput: unknown = input;
	if (!isJsonObject(rawInput)) throw new ReplacementPolicyError("invalid-input");
	if (rawInput["source"] === undefined || rawInput["source"] === null) {
		throw new ReplacementPolicyError("invalid-input");
	}
	if (rawInput["target"] === undefined || rawInput["target"] === null) return copy("target-missing");

	const source = snapshotSessionRecord(rawInput["source"], "invalid-record");
	const target = snapshotSessionRecord(rawInput["target"], "invalid-record");
	const targetID = target.info["id"] as string;

	if (typeof rawInput["authorizedTargetID"] !== "string" ||
		rawInput["authorizedTargetID"].length === 0 ||
		rawInput["authorizedTargetID"] !== targetID) {
		return copy("target-not-authorized");
	}

	if (hasSessionReference(source.info)) return copy("source-has-references");
	if (hasSessionReference(target.info)) return copy("target-has-references");

	const sourceUnsupported = firstUnsettled(source);
	if (sourceUnsupported === "unsettled") return copy("source-unsettled");
	if (sourceUnsupported === "unsupported-tool") return copy("source-unsupported-tool");

	const targetUnsupported = firstUnsettled(target);
	if (targetUnsupported === "unsettled") return copy("target-unsettled");
	if (targetUnsupported === "unsupported-tool") return copy("target-unsupported-tool");

	if (rawInput["inventoryComplete"] !== true) return copy("inventory-incomplete");
	const inventory = scanInventory(rawInput["referenceInventory"]);
	if (!inventory.ok) return copy(inventory.reason);

	const inventoryIDs = new Set(inventory.entries.map((entry) => entry.id));
	if (!inventoryIDs.has(source.info["id"] as string) || !inventoryIDs.has(targetID)) {
		return copy("inventory-incomplete");
	}

	const sourceMessageIDs = new Set(source.messages.map((message) => message["id"] as string));
	const targetMessageIDs = new Set(target.messages.map((message) => message["id"] as string));

	for (const entry of inventory.entries) {
		if (entry.parentID === source.info["id"]) return copy("source-has-children");
		if (entry.parentID === targetID) return copy("target-has-incoming-references");
		if (
			entry.forkSessionID === source.info["id"] ||
			(entry.boundaryMessageID !== undefined && sourceMessageIDs.has(entry.boundaryMessageID))
		) {
			return copy("source-has-incoming-references");
		}
		if (
			entry.forkSessionID === targetID ||
			(entry.boundaryMessageID !== undefined && targetMessageIDs.has(entry.boundaryMessageID))
		) {
			return copy("target-has-incoming-references");
		}
		if (entry.revertMessageID !== undefined && sourceMessageIDs.has(entry.revertMessageID)) {
			return copy("source-has-incoming-references");
		}
		if (entry.revertMessageID !== undefined && targetMessageIDs.has(entry.revertMessageID)) {
			return copy("target-has-incoming-references");
		}
	}

	return { mode: "replace" };
}

/* ------------------------------------------------------------------------- */
/* Imported-record verification                                              */
/* ------------------------------------------------------------------------- */

function fail(reason: ImportVerificationReason): ImportedRecordVerification {
	return { verified: false, reason };
}

function normalizeDirectory(value: string): string {
	const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "");
	return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
}

function sameOptionalField(expected: JsonObject, actual: JsonObject, key: string): boolean {
	const expectedHas = hasOwn(expected, key);
	const actualHas = hasOwn(actual, key);
	if (expectedHas !== actualHas) return false;
	if (!expectedHas) return true;
	return canonicalJson(expected[key]!) === canonicalJson(actual[key]!);
}

/**
 * Strictly verifies one imported host readback against the expected standalone,
 * planner-rewritten record.
 *
 * The ONLY accepted normalizations are:
 * - `info.projectID` equals the caller's host-confirmed `canonicalProjectID`;
 * - `info.location` is exactly `{ directory }` matching the explicit canonical
 *   target after slash/trailing-slash/Windows-drive-case normalization;
 * - `info.time.updated` is a finite timestamp inside the inclusive import
 *   window and not before `info.time.created`;
 * - root `parentID`/`fork`/`revert` may be absent or exactly null.
 *
 * Every other session field, every message (IDs, types, roles, order, parts,
 * tools, timestamps, unknown/extra/missing fields), and the id/title/created/
 * idle values must match exactly. There is no permissive projection and no
 * fallback: a host type or field drift fails closed.
 */
export function verifyImportedRecord(input: VerifyImportedRecordInput): ImportedRecordVerification {
	const rawInput: unknown = input;
	if (!isJsonObject(rawInput)) return fail("invalid-input");
	if (typeof rawInput["canonicalProjectID"] !== "string" ||
		rawInput["canonicalProjectID"].length === 0 ||
		typeof rawInput["locationDirectory"] !== "string" ||
		rawInput["locationDirectory"].length === 0) {
		return fail("invalid-input");
	}
	const importStartedAt = rawInput["importStartedAt"];
	const importFinishedAt = rawInput["importFinishedAt"];
	if (typeof importStartedAt !== "number" || !Number.isFinite(importStartedAt) ||
		typeof importFinishedAt !== "number" || !Number.isFinite(importFinishedAt) ||
		importStartedAt > importFinishedAt) {
		return fail("invalid-input");
	}

	let expected: SessionRecord;
	let actual: SessionRecord;
	try {
		expected = snapshotSessionRecord(rawInput["expected"], "invalid-record");
	} catch {
		return fail("expected-malformed");
	}
	try {
		actual = snapshotSessionRecord(rawInput["actual"], "invalid-record");
	} catch {
		return fail("actual-malformed");
	}

	for (const key of ["parentID", "fork", "revert"] as const) {
		const value = expected.info[key];
		if (value !== undefined && value !== null) return fail("expected-references");
	}
	for (const key of ["parentID", "fork", "revert"] as const) {
		const value = actual.info[key];
		if (value !== undefined && value !== null) return fail("session-reference");
	}

	if (expected.info["id"] !== actual.info["id"]) return fail("session-id");

	if (actual.info["projectID"] !== rawInput["canonicalProjectID"]) return fail("session-project");

	const location = actual.info["location"];
	if (!isJsonObject(location)) return fail("session-location");
	const locationKeys = Object.keys(location);
	if (locationKeys.length !== 1 || locationKeys[0] !== "directory" ||
		typeof location["directory"] !== "string" ||
		normalizeDirectory(location["directory"]) !== normalizeDirectory(rawInput["locationDirectory"])) {
		return fail("session-location");
	}

	const expectedTime = expected.info["time"];
	const actualTime = actual.info["time"];
	if (!isJsonObject(expectedTime) || !isJsonObject(actualTime)) return fail("session-time");

	const expectedCreated = expectedTime["created"];
	const actualCreated = actualTime["created"];
	if (typeof expectedCreated !== "number" || !Number.isFinite(expectedCreated) ||
		typeof actualCreated !== "number" || !Number.isFinite(actualCreated) ||
		actualCreated !== expectedCreated) {
		return fail("session-created");
	}

	const actualUpdated = actualTime["updated"];
	if (typeof actualUpdated !== "number" || !Number.isFinite(actualUpdated) ||
		actualUpdated < actualCreated ||
		actualUpdated < importStartedAt ||
		actualUpdated > importFinishedAt) {
		return fail("session-updated-window");
	}

	if (!sameOptionalField(expectedTime, actualTime, "idle")) return fail("session-idle");

	if (canonicalJson(withoutKeys(expectedTime, ["updated"])) !==
		canonicalJson(withoutKeys(actualTime, ["updated"]))) {
		return fail("session-time");
	}

	if (!sameOptionalField(expected.info, actual.info, "title")) return fail("session-title");

	const ignoredInfoKeys = ["id", "projectID", "location", "time", "parentID", "fork", "revert"] as const;
	if (canonicalJson(withoutKeys(expected.info, ignoredInfoKeys)) !==
		canonicalJson(withoutKeys(actual.info, ignoredInfoKeys))) {
		return fail("session-fields");
	}

	if (expected.messages.length !== actual.messages.length) return fail("message-count");
	for (let index = 0; index < expected.messages.length; index++) {
		const expectedMessage = expected.messages[index]!;
		const actualMessage = actual.messages[index]!;
		if (expectedMessage["id"] !== actualMessage["id"]) return fail("message-id");
		if (canonicalJson(expectedMessage) !== canonicalJson(actualMessage)) return fail("message-mismatch");
	}

	return { verified: true };
}
