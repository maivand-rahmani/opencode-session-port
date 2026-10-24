import sodium from "libsodium-wrappers-sumo"
import {
  ARTIFACT_IDENTITY_BYTES,
  type ByteSource,
  type CheckpointCrypto,
} from "../../../../src/core/contracts/crypto.ts"
import type { CheckpointPayload } from "../../../../src/core/contracts/session.ts"
import { bestEffortZero, concatChunks } from "../../../../src/core/crypto/zero.ts"
import { createRemappedIdDeriver } from "../../../../src/core/restore/identity.ts"
import { planRestore } from "../../../../src/core/restore/planner.ts"
import { serializeCheckpointPayload } from "../../../../src/core/sessions/serialize.ts"
import type { RecoveryPort } from "./contract.ts"

/**
 * Probe-lane encrypted recovery port.
 *
 * The old checkpoint payload is serialized with the existing serializer and
 * sealed once through an injected real `CheckpointCrypto` instance. After
 * creation only the ciphertext and the owned password copy remain in memory;
 * the plaintext byte buffer is best-effort zeroed. The password is either a
 * fresh 32-byte CSPRNG value or a caller-supplied copy (the caller's buffer is
 * never modified). It is never printed, logged, hashed, or written to disk.
 *
 * LIMITS: this is an in-process probe, not production durability. If the parent
 * process dies, the in-memory key is lost and the ciphertext is unrecoverable;
 * the port proves host-child memory survival, not OS-restart survival. The key
 * is external artifact data and is deliberately not serialized with the
 * ciphertext. No secure-erasure claim is made (A-07): JS payload objects and
 * engine copies cannot be erased.
 */

/** Fresh CSPRNG password length owned by the probe (parent memory only). */
export const RECOVERY_PASSWORD_BYTES = 32

/** Fixed error for calls after `destroy()`; never includes payload material. */
export class RecoveryStateError extends Error {
  readonly code = "recovery-destroyed"

  constructor() {
    super("recovery port has been destroyed")
    this.name = "RecoveryStateError"
  }
}

/** Fixed error for any authentication, decode, parse, or validation failure. */
export class RecoveryIntegrityError extends Error {
  readonly code = "recovery-integrity-failed"

  constructor() {
    super("stored recovery artifact failed authentication or validation")
    this.name = "RecoveryIntegrityError"
  }
}

function oneShot(bytes: Uint8Array): ByteSource {
  return (async function* () {
    yield bytes
  })()
}

async function collectCiphertext(source: ByteSource): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  try {
    for await (const chunk of source) chunks.push(Uint8Array.from(chunk))
    return concatChunks(chunks)
  } finally {
    for (const chunk of chunks) bestEffortZero(chunk)
  }
}

function copyPassword(password: Uint8Array): Uint8Array {
  if (!(password instanceof Uint8Array) || password.length === 0) {
    throw new TypeError("recovery password material must be a non-empty byte array")
  }
  return Uint8Array.from(password)
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false
  let difference = 0
  for (let index = 0; index < left.length; index++) difference |= left[index]! ^ right[index]!
  return difference === 0
}

function decodeStrictUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    throw new RecoveryIntegrityError()
  }
}

/**
 * Strict UTF-8/JSON decode plus the existing restore planner's payload schema
 * validation. The planner runs against an empty destination and no host reads,
 * so no destination host is contacted. Failures are reported with the fixed
 * integrity error and never echo payload content.
 */
async function parseAndValidate(
  bytes: Uint8Array,
  artifactIdentity: Uint8Array,
  idDeriver: Awaited<ReturnType<typeof createRemappedIdDeriver>>,
): Promise<CheckpointPayload> {
  const text = decodeStrictUtf8(bytes)
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    throw new RecoveryIntegrityError()
  }
  try {
    planRestore({
      payload: parsed as CheckpointPayload,
      artifactIdentity,
      destination: [],
      globallyVisibleSessionIDs: [],
      idDeriver,
    })
  } catch {
    throw new RecoveryIntegrityError()
  }
  return parsed as CheckpointPayload
}

/**
 * Builds a `RecoveryPort` over one immutable old payload. `crypto` must be an
 * already-created real instance from the existing factory; this helper does not
 * choose or invent any policy, KDF cost, header, or cap. `passwordMaterial` is
 * copied and only the copy is owned/zeroed.
 */
export async function createEncryptedRecoveryPort(
  payload: CheckpointPayload,
  crypto: CheckpointCrypto,
  passwordMaterial?: Uint8Array,
): Promise<RecoveryPort> {
  if (
    crypto === null ||
    typeof crypto !== "object" ||
    typeof crypto.seal !== "function" ||
    typeof crypto.openAndStage !== "function"
  ) {
    throw new TypeError("recovery requires an existing CheckpointCrypto instance with seal and openAndStage")
  }

  const idDeriver = await createRemappedIdDeriver()

  // Capture the canonical serialized old payload once and validate it before
  // any sealing. A zero identity is used only for schema validation; it is not
  // the artifact's real identity and is never stored.
  let expectedBytes: Uint8Array
  try {
    expectedBytes = serializeCheckpointPayload(payload)
  } catch {
    throw new TypeError("recovery payload is not a JSON-stable checkpoint payload")
  }

  let ownedPassword: Uint8Array
  try {
    await parseAndValidate(expectedBytes, new Uint8Array(ARTIFACT_IDENTITY_BYTES), idDeriver)
    ownedPassword = passwordMaterial === undefined ? sodium.randombytes_buf(RECOVERY_PASSWORD_BYTES) : copyPassword(passwordMaterial)
  } catch (error) {
    bestEffortZero(expectedBytes)
    if (error instanceof RecoveryIntegrityError) {
      throw new TypeError("recovery payload is not a valid checkpoint payload")
    }
    throw error
  }

  let ciphertext: Uint8Array
  try {
    const sealed = await crypto.seal(oneShot(expectedBytes), ownedPassword)
    ciphertext = await collectCiphertext(sealed)
  } catch {
    bestEffortZero(ownedPassword)
    throw new RecoveryIntegrityError()
  } finally {
    // Best-effort only: JS payload objects cannot be securely erased.
    bestEffortZero(expectedBytes)
  }

  let destroyed = false
  let key: Uint8Array | undefined = ownedPassword
  let stored: Uint8Array | undefined = ciphertext

  const assertLive = (): void => {
    if (destroyed) throw new RecoveryStateError()
  }

  const openAuthenticated = async (): Promise<{ bytes: Uint8Array; artifactIdentity: Uint8Array }> => {
    assertLive()
    try {
      const authenticated = await crypto.openAndStage(oneShot(stored!), key!)
      return { bytes: authenticated.bytes, artifactIdentity: Uint8Array.from(authenticated.artifactIdentity) }
    } catch (error) {
      if (error instanceof RecoveryStateError) throw error
      throw new RecoveryIntegrityError()
    }
  }

  return {
    async verify(expected: CheckpointPayload): Promise<boolean> {
      assertLive()
      let expectedBytes: Uint8Array
      try {
        expectedBytes = serializeCheckpointPayload(expected)
      } catch {
        return false
      }
      try {
        const authenticated = await openAuthenticated()
        try {
          await parseAndValidate(authenticated.bytes, authenticated.artifactIdentity, idDeriver)
          return bytesEqual(authenticated.bytes, expectedBytes)
        } finally {
          bestEffortZero(authenticated.bytes)
        }
      } catch (error) {
        if (error instanceof RecoveryStateError) throw error
        throw new RecoveryIntegrityError()
      } finally {
        bestEffortZero(expectedBytes)
      }
    },

    async recover(): Promise<CheckpointPayload> {
      assertLive()
      try {
        const authenticated = await openAuthenticated()
        try {
          return await parseAndValidate(authenticated.bytes, authenticated.artifactIdentity, idDeriver)
        } finally {
          bestEffortZero(authenticated.bytes)
        }
      } catch (error) {
        if (error instanceof RecoveryStateError) throw error
        throw new RecoveryIntegrityError()
      }
    },

    destroy(): void {
      if (destroyed) return
      destroyed = true
      if (key !== undefined) {
        bestEffortZero(key)
        key = undefined
      }
      if (stored !== undefined) {
        bestEffortZero(stored)
        stored = undefined
      }
    },
  }
}
