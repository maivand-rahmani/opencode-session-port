/**
 * Diagnostic settings for the Windows-only KDF benchmark harness.
 *
 * The default diagnostic candidate (2 ops / 64 MiB) reproduces the earlier
 * recorded diagnostic run (E35 / `fix-52`) so new measurements stay comparable.
 * `--ops` / `--memory-mib` parameterize the candidate for diagnostic comparison
 * only; measured values are NOT a SessionPort crypto profile, candidate
 * shortlist, or recommendation. No profile, cap, or format value is selected
 * here; O-01/O-03 remain OPEN and the production crypto registry remains
 * intentionally empty. Do not import these constants into product code.
 */

/** Pinned package this harness is designed to exercise (identity string for reporting). */
export const LIBSODIUM_PACKAGE_ID = "libsodium-wrappers-sumo@0.8.4";

export const KDF_FUNCTION = "crypto_pwhash";
export const KDF_ALGORITHM = "argon2id13";
/** `crypto_pwhash_ALG_ARGON2ID13`; asserted against the library at child runtime. */
export const KDF_ALGORITHM_ID = 2;
/** Diagnostic output length only; not a selected key-derivation output size. */
export const KDF_OUTPUT_BYTES = 32;
/** Synthetic random password length (bytes); not a user passphrase and not representative of one. */
export const KDF_PASSWORD_BYTES = 32;

/** Default diagnostic candidate: 2 ops / 64 MiB (reproduces the earlier recorded diagnostic run). */
export const DEFAULT_KDF_OPS_LIMIT = 2;
export const DEFAULT_KDF_MEMORY_LIMIT_BYTES = 64 * 1024 * 1024; // 64 MiB

/**
 * Harness input guards for the diagnostic candidate comparison (CLI validation
 * only). These bound what this diagnostic tool will run so an accidental value
 * cannot request an unreasonable allocation or a degenerate Argon2 cost. They
 * are NOT a product resource cap, crypto profile, or support claim, and no
 * product cap is selected from them (O-01/O-03 remain OPEN).
 */
export const MIN_KDF_OPS_LIMIT = 1;
export const MAX_KDF_OPS_LIMIT = 10;
export const MIN_KDF_MEMORY_LIMIT_MIB = 8;
export const MAX_KDF_MEMORY_LIMIT_MIB = 1024;

export const KDF_SETTINGS_NOTE =
	"Diagnostic candidate inputs only (per-run ops/memory; the 2 ops / 64 MiB default reproduces the earlier " +
	"recorded diagnostic run); NOT a selected or approved crypto profile. No profile, cap, or format value is " +
	"chosen from these measurements (O-01/O-03 remain OPEN).";
