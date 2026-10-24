import { describe, expect, test } from "bun:test"
import type { ByteSource, CheckpointCrypto } from "../../../../src/core/contracts/crypto.ts"
import type { CheckpointPayload } from "../../../../src/core/contracts/session.ts"
import { createCheckpointCryptoFactory } from "../../../../src/core/crypto/index.ts"
import {
  EXPERIMENTAL_CRYPTO_POLICY,
  EXPERIMENTAL_CRYPTO_POLICY_DEFINITION,
} from "../../../../src/tui/wiring/experimental-profile.ts"
import { createVerifiedDeleteFixture, toCheckpointPayload, type FixtureIDs } from "./fixtures.ts"
import {
  createEncryptedRecoveryPort,
  RecoveryIntegrityError,
  RecoveryStateError,
} from "./recovery.ts"
import { collect, createTestCrypto, flipByte, sourceFrom } from "../../../../tests/core/crypto/test-only-support.ts"

const IDS: FixtureIDs = {
  oldSessionID: `ses_${"a".repeat(64)}`,
  candidateSessionID: `ses_${"b".repeat(64)}`,
  oldMessageIDs: [`msg_${"c".repeat(64)}`, `msg_${"d".repeat(64)}`],
  candidateMessageIDs: [`msg_${"e".repeat(64)}`, `msg_${"f".repeat(64)}`, `msg_${"0".repeat(64)}`],
}

function oldPayload(): CheckpointPayload {
  const fixture = createVerifiedDeleteFixture({
    directory: "/synthetic/verified-delete",
    projectID: "proj_synthetic_verified_delete",
    ids: IDS,
  })
  return toCheckpointPayload(fixture.oldRoot)
}

function mutatePayload(
  payload: CheckpointPayload,
  mutate: (info: Record<string, unknown>) => void,
): CheckpointPayload {
  const copy = structuredClone(payload) as unknown as { sessions: Array<{ info: Record<string, unknown> }> }
  mutate(copy.sessions[0]!.info)
  return copy as unknown as CheckpointPayload
}

function corruptingCrypto(inner: CheckpointCrypto): CheckpointCrypto {
  return {
    async seal(plaintext: ByteSource, password: Uint8Array): Promise<ByteSource> {
      const bytes = await collect(await inner.seal(plaintext, password))
      if (bytes.length === 0) throw new Error("empty sealed artifact (test seam)")
      return sourceFrom([flipByte(bytes, bytes.length - 1)])
    },
    openAndStage: (artifact, password) => inner.openAndStage(artifact, password),
  }
}

function wrongKeyCrypto(inner: CheckpointCrypto): CheckpointCrypto {
  return {
    seal: (plaintext, password) => inner.seal(plaintext, password),
    openAndStage: (artifact) => inner.openAndStage(artifact, new Uint8Array(32).fill(0x5a)),
  }
}

async function rejectionCode(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run()
    return undefined
  } catch (error) {
    return (error as { code?: string }).code
  }
}

describe("encrypted recovery port", () => {
  test("roundtrips the exact old fixture payload through real seal/open", async () => {
    const payload = oldPayload()
    const { crypto } = await createTestCrypto()
    const port = await createEncryptedRecoveryPort(payload, crypto, new Uint8Array(32).fill(0x11))

    expect(await port.verify(payload)).toBe(true)
    const recovered = await port.recover()
    expect(recovered).toEqual(payload)
    // Two verify calls independently authenticate and decompress the artifact.
    expect(await port.verify(payload)).toBe(true)

    port.destroy()
    port.destroy()
    expect(await rejectionCode(() => port.verify(payload))).toBe("recovery-destroyed")
    expect(await rejectionCode(() => port.recover())).toBe("recovery-destroyed")
  })

  test("recover returns a detached payload that cannot alter future reads", async () => {
    const payload = oldPayload()
    const { crypto } = await createTestCrypto()
    const port = await createEncryptedRecoveryPort(payload, crypto)

    const first = await port.recover()
    const info = first.sessions[0]!.info as Record<string, unknown>
    info["title"] = "mutated by caller"
    info["id"] = `ses_${"9".repeat(64)}`

    const second = await port.recover()
    expect(second).toEqual(payload)
    expect(await port.verify(payload)).toBe(true)
    port.destroy()
  })

  test("verify rejects changed content, IDs, and reference fields with false", async () => {
    const payload = oldPayload()
    const { crypto } = await createTestCrypto()
    const port = await createEncryptedRecoveryPort(payload, crypto)

    const changedText = mutatePayload(payload, (info) => {
      info["title"] = "different title"
    })
    const changedID = mutatePayload(payload, (info) => {
      info["id"] = `ses_${"8".repeat(64)}`
    })
    const changedReference = mutatePayload(payload, (info) => {
      info["parentID"] = `ses_${"7".repeat(64)}`
    })

    expect(await port.verify(changedText)).toBe(false)
    expect(await port.verify(changedID)).toBe(false)
    expect(await port.verify(changedReference)).toBe(false)
    expect(await port.verify(payload)).toBe(true)
    port.destroy()
  })

  test("tampered ciphertext rejects verify and recover", async () => {
    const payload = oldPayload()
    const { crypto } = await createTestCrypto()
    const port = await createEncryptedRecoveryPort(payload, corruptingCrypto(crypto))

    expect(await rejectionCode(() => port.verify(payload))).toBe("recovery-integrity-failed")
    expect(await rejectionCode(() => port.recover())).toBe("recovery-integrity-failed")
    port.destroy()
  })

  test("wrong key rejects verify and recover", async () => {
    const payload = oldPayload()
    const { crypto } = await createTestCrypto()
    const port = await createEncryptedRecoveryPort(payload, wrongKeyCrypto(crypto))

    expect(await rejectionCode(() => port.verify(payload))).toBe("recovery-integrity-failed")
    expect(await rejectionCode(() => port.recover())).toBe("recovery-integrity-failed")
    port.destroy()
  })

  test("factory exposes fixed error names without payload material", () => {
    const state = new RecoveryStateError()
    const integrity = new RecoveryIntegrityError()
    expect(state.name).toBe("RecoveryStateError")
    expect(integrity.name).toBe("RecoveryIntegrityError")
    expect(state.message).not.toContain("ses_")
    expect(integrity.message).not.toContain("ses_")
  })

  test("experimental owner profile seals and reopens the fixture payload", async () => {
    const payload = oldPayload()
    const factory = await createCheckpointCryptoFactory([EXPERIMENTAL_CRYPTO_POLICY_DEFINITION])
    const crypto = await factory.create(EXPERIMENTAL_CRYPTO_POLICY)
    const port = await createEncryptedRecoveryPort(payload, crypto, new Uint8Array(32).fill(0x22))

    expect(await port.verify(payload)).toBe(true)
    expect(await port.recover()).toEqual(payload)
    port.destroy()
  })
})
