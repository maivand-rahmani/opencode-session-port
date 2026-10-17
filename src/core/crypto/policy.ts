/**
 * Allow-listed crypto policy definitions.
 *
 * Numeric profiles/caps live here as caller-supplied definitions — never in
 * the shared contract and never in the artifact. The artifact only references
 * a profile code that must resolve through the factory's allow-list.
 *
 * NO production profile is defined in this repository yet: Argon2id costs,
 * chunk size, and artifact/compressed/decompressed/expansion/password caps are
 * OPEN (O-01/O-03) and must be benchmarked and owner-approved before any
 * production definition ships. `maxCompressedBytes` is a required distinct
 * caller-supplied limit (never derived from `maxArtifactBytes`); tests
 * construct clearly-marked test-only definitions.
 */
import type { CryptoPolicy } from "../contracts/crypto.ts";
import { CryptoContainerError } from "./errors.ts";
import {
	ENVELOPE_PROFILE_CODE_MAX,
	ENVELOPE_PROFILE_CODE_MIN,
	FRAME_MAX_CIPHERTEXT_BYTES,
} from "./envelope.ts";

/** One allow-listed policy: numeric KDF costs, framing, and resource caps. */
export interface CryptoPolicyDefinition {
	/** Stable code-selected profile identifier used by `CheckpointCryptoFactory.create`. */
	readonly id: string;
	/** One-byte code stored in the artifact header and resolved against the allow-list. */
	readonly profileCode: number;
	readonly kdf: {
		/** Argon2id ops limit; must be within the pinned libsodium bounds. */
		readonly opsLimit: number;
		/** Argon2id memory limit in bytes; must be within the pinned libsodium bounds. */
		readonly memLimit: number;
	};
	readonly compression: {
		/** zlib level (-1 default, 0..9) or undefined for the library default. */
		readonly level?: number | undefined;
	};
	readonly framing: {
		/** Plaintext bytes per secretstream frame produced while sealing. */
		readonly chunkBytes: number;
	};
	readonly limits: {
		readonly maxPasswordBytes: number;
		readonly maxArtifactBytes: number;
		/**
		 * Required cap on the decrypted gzip (compressed) byte count, enforced
		 * while streaming before each chunk is accepted. This is a distinct
		 * caller-supplied limit, NOT derived from `maxArtifactBytes`; numeric
		 * values remain OPEN (O-03).
		 */
		readonly maxCompressedBytes: number;
		readonly maxDecompressedBytes: number;
		readonly maxExpansionRatio: number;
	};
}

/** Runtime bounds taken from the pinned libsodium build (not chosen here). */
export interface SodiumPolicyBounds {
	readonly opsLimitMin: number;
	readonly memLimitMin: number;
	readonly ciphertextOverheadBytes: number;
}

export interface CryptoPolicyRegistry {
	readonly byId: ReadonlyMap<string, CryptoPolicyDefinition>;
	readonly byProfileCode: ReadonlyMap<number, CryptoPolicyDefinition>;
}

function invalid(message: string): never {
	throw new CryptoContainerError("invalid-policy-definition", message);
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		invalid(`${field} must be an object`);
	}
	return value as Record<string, unknown>;
}

function requireSafeInteger(value: unknown, field: string, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
		invalid(`${field} must be a safe integer between ${min} and ${max}`);
	}
	return value;
}

function normalizeDefinition(raw: unknown, bounds: SodiumPolicyBounds): CryptoPolicyDefinition {
	const source = asRecord(raw, "policy definition");
	const id = source["id"];
	if (typeof id !== "string" || id.length === 0) invalid("policy definition id must be a non-empty string");
	const profileCode = requireSafeInteger(
		source["profileCode"],
		"policy definition profileCode",
		ENVELOPE_PROFILE_CODE_MIN,
		ENVELOPE_PROFILE_CODE_MAX,
	);

	const kdf = asRecord(source["kdf"], "policy definition kdf");
	// Upper bounds: the pinned 0.8.4 wrappers report the library `_MAX`
	// constants as negative sentinels, so they are not usable here; definitions
	// are caller-supplied (trusted) and only need JS-safe integer validation.
	const opsLimit = requireSafeInteger(kdf["opsLimit"], "kdf.opsLimit", bounds.opsLimitMin, Number.MAX_SAFE_INTEGER);
	const memLimit = requireSafeInteger(kdf["memLimit"], "kdf.memLimit", bounds.memLimitMin, Number.MAX_SAFE_INTEGER);

	const compression = asRecord(source["compression"], "policy definition compression");
	const level = compression["level"];
	const normalizedLevel = level === undefined ? undefined : requireSafeInteger(level, "compression.level", -1, 9);

	const framing = asRecord(source["framing"], "policy definition framing");
	const maxChunkBytes = FRAME_MAX_CIPHERTEXT_BYTES - bounds.ciphertextOverheadBytes;
	const chunkBytes = requireSafeInteger(framing["chunkBytes"], "framing.chunkBytes", 1, maxChunkBytes);

	const limits = asRecord(source["limits"], "policy definition limits");
	const maxPasswordBytes = requireSafeInteger(limits["maxPasswordBytes"], "limits.maxPasswordBytes", 0, Number.MAX_SAFE_INTEGER);
	const maxArtifactBytes = requireSafeInteger(limits["maxArtifactBytes"], "limits.maxArtifactBytes", 1, Number.MAX_SAFE_INTEGER);
	// A gzip stream needs at least one nonempty member, so the compressed cap
	// minimum is 1; a distinct value is required, never derived from the
	// artifact cap (O-03 numeric values remain OPEN).
	const maxCompressedBytes = requireSafeInteger(
		limits["maxCompressedBytes"],
		"limits.maxCompressedBytes",
		1,
		Number.MAX_SAFE_INTEGER,
	);
	const maxDecompressedBytes = requireSafeInteger(
		limits["maxDecompressedBytes"],
		"limits.maxDecompressedBytes",
		0,
		Number.MAX_SAFE_INTEGER,
	);
	const maxExpansionRatio = limits["maxExpansionRatio"];
	if (typeof maxExpansionRatio !== "number" || !Number.isFinite(maxExpansionRatio) || maxExpansionRatio <= 0) {
		invalid("limits.maxExpansionRatio must be a positive finite number");
	}

	return Object.freeze({
		id,
		profileCode,
		kdf: Object.freeze({ opsLimit, memLimit }),
		compression: Object.freeze({ level: normalizedLevel }),
		framing: Object.freeze({ chunkBytes }),
		limits: Object.freeze({
			maxPasswordBytes,
			maxArtifactBytes,
			maxCompressedBytes,
			maxDecompressedBytes,
			maxExpansionRatio,
		}),
	});
}

/**
 * Validates and copies caller-supplied definitions into an immutable
 * allow-list. Duplicate ids/profile codes and out-of-range numeric values are
 * rejected (fail closed); an empty allow-list is valid and rejects every
 * `create` call.
 */
export function buildCryptoPolicyRegistry(
	definitions: readonly CryptoPolicyDefinition[],
	bounds: SodiumPolicyBounds,
): CryptoPolicyRegistry {
	if (!Array.isArray(definitions)) invalid("policy definitions must be an array");
	const byId = new Map<string, CryptoPolicyDefinition>();
	const byProfileCode = new Map<number, CryptoPolicyDefinition>();
	for (const raw of definitions) {
		const definition = normalizeDefinition(raw, bounds);
		if (byId.has(definition.id)) invalid("duplicate policy definition id");
		if (byProfileCode.has(definition.profileCode)) invalid("duplicate policy profile code");
		byId.set(definition.id, definition);
		byProfileCode.set(definition.profileCode, definition);
	}
	return { byId, byProfileCode };
}

/** Resolves an explicitly selected policy id; unknown ids fail closed. */
export function resolvePolicyById(registry: CryptoPolicyRegistry, policy: CryptoPolicy): CryptoPolicyDefinition {
	const id = (policy as { id?: unknown } | null | undefined)?.id;
	if (typeof id !== "string" || id.length === 0) {
		throw new CryptoContainerError("unknown-policy", "an explicit non-empty crypto policy id is required");
	}
	const definition = registry.byId.get(id);
	if (definition === undefined) {
		throw new CryptoContainerError("unknown-policy", "the requested crypto policy id is not allow-listed");
	}
	return definition;
}

/**
 * Resolves the artifact's one-byte profile code strictly through the
 * caller-supplied allow-list. Unknown codes fail closed before any KDF work.
 */
export function resolvePolicyByProfileCode(
	registry: CryptoPolicyRegistry,
	profileCode: number,
): CryptoPolicyDefinition {
	const definition = registry.byProfileCode.get(profileCode);
	if (definition === undefined) {
		throw new CryptoContainerError("unknown-kdf-profile", "artifact references a KDF profile that is not allow-listed");
	}
	return definition;
}
