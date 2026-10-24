import { describe, expect, test } from "bun:test"
import type { CheckpointPayload } from "../../../../src/core/contracts/session.ts"
import {
  PortNotFoundError,
  PortTimeoutError,
  type InventorySession,
  type ProbeImportPayload,
  type ProbeMessage,
  type ProbeSession,
  type RecoveryPort,
  type VerifiedDeletePort,
} from "./contract.ts"
import {
  OLD_MESSAGE_TEXT,
  SYNTHETIC_TAIL_TEXT,
  createVerifiedDeleteFixture,
  toCheckpointPayload,
  toNativeMessage,
  toNativeSession,
  type VerifiedDeleteFixture,
} from "./fixtures.ts"
import { runVerifiedDelete, type VerifiedDeleteResult } from "./state-machine.ts"

const sessionID = (character: string) => `ses_${character.repeat(64)}`
const messageID = (character: string) => `msg_${character.repeat(64)}`

function fixture(): VerifiedDeleteFixture {
  return createVerifiedDeleteFixture({
    directory: "C:\\probe\\verified-delete",
    projectID: "verified-delete-probe",
    now: 1_700_000_000_000,
    ids: {
      oldSessionID: sessionID("a"),
      candidateSessionID: sessionID("b"),
      oldMessageIDs: [messageID("1"), messageID("2")],
      candidateMessageIDs: [messageID("3"), messageID("4"), messageID("5")],
    },
  })
}

type RemoveMode = "ok" | "noop" | "timeout-noop" | "apply-timeout" | "error-noop"

class FakePort implements VerifiedDeletePort {
  readonly sessions = new Map<string, ProbeSession>()
  readonly messages = new Map<string, ProbeMessage[]>()
  readonly calls: string[] = []
  readonly removed: string[] = []
  candidateLookup: "normal" | "ambiguous" = "normal"
  importFails = false
  importID: string | null = null
  candidateMessageIDs: readonly string[] | null = null
  afterImport: ((port: FakePort) => void) | null = null
  removeMode: RemoveMode = "ok"
  afterRemove: ((port: FakePort) => void) | null = null
  unknownAfterRemove = false
  inventoryTransform: ((entries: InventorySession[]) => readonly InventorySession[]) | null = null
  inventoryThrows = false
  private removeAttempted = false

  constructor(readonly fixture: VerifiedDeleteFixture) {
    this.sessions.set(fixture.oldRoot.session.id, toNativeSession(fixture.oldRoot))
    this.messages.set(fixture.oldRoot.session.id, fixture.oldRoot.messages.map(toNativeMessage))
  }

  seedCandidate(): void {
    this.sessions.set(this.fixture.candidateRoot.session.id, toNativeSession(this.fixture.candidateRoot))
    this.messages.set(this.fixture.candidateRoot.session.id, this.fixture.candidateRoot.messages.map(toNativeMessage))
  }

  async getSession(id: string): Promise<ProbeSession> {
    this.calls.push(`get:${id}`)
    if (this.removeAttempted && this.unknownAfterRemove) throw new Error("unknown-readback")
    const session = this.sessions.get(id)
    if (session) return structuredClone(session)
    if (id === this.fixture.candidateRoot.session.id && this.candidateLookup === "ambiguous") {
      throw new Error("ambiguous-lookup")
    }
    throw new PortNotFoundError("session-get")
  }

  async listMessages(id: string): Promise<readonly ProbeMessage[]> {
    this.calls.push(`messages:${id}`)
    return structuredClone(this.messages.get(id) ?? [])
  }

  async importSession(payload: ProbeImportPayload): Promise<{ id: string }> {
    this.calls.push("import")
    if (this.importFails) throw new Error("import-failed")
    const ids = this.candidateMessageIDs ?? payload.messages.map((message) => message.id)
    this.sessions.set(payload.info.id, {
      id: payload.info.id,
      title: payload.info.title,
      projectID: payload.info.projectID,
      directory: payload.info.directory,
      time: { created: payload.info.time.created + 7, updated: payload.info.time.updated + 9 },
    })
    this.messages.set(
      payload.info.id,
      payload.messages.map((message, index) => ({ ...message, id: ids[index]!, time: { ...message.time } })),
    )
    this.afterImport?.(this)
    return { id: this.importID ?? payload.info.id }
  }

  async readInventory(): Promise<readonly InventorySession[]> {
    this.calls.push("inventory")
    if (this.inventoryThrows) throw new Error("inventory-failed")
    const entries = [...this.sessions.entries()].map(([id, session]) => ({
      id,
      ...(session.parentID === undefined ? {} : { parentID: session.parentID }),
      projectID: session.projectID,
      messageIDs: (this.messages.get(id) ?? []).map((message) => message.id),
    }))
    return this.inventoryTransform ? this.inventoryTransform(entries) : entries
  }

  async removeSession(id: string): Promise<void> {
    this.calls.push(`remove:${id}`)
    this.removed.push(id)
    this.removeAttempted = true
    if (this.removeMode === "ok" || this.removeMode === "apply-timeout" || this.removeMode === "error-noop") {
      if (this.removeMode !== "error-noop") this.sessions.delete(id)
    }
    this.afterRemove?.(this)
    if (this.removeMode === "apply-timeout") throw new PortTimeoutError("session-remove")
    if (this.removeMode === "timeout-noop") throw new PortTimeoutError("session-remove")
    if (this.removeMode === "error-noop") throw new Error("remove-error")
  }
}

class FakeRecovery implements RecoveryPort {
  readonly calls = { verify: 0, recover: 0, destroy: 0 }
  verifyResult = true
  recoverOverride: CheckpointPayload | null = null
  recoverThrows = false
  onVerify: ((call: number) => void) | null = null

  constructor(readonly expected: CheckpointPayload) {}

  async verify(): Promise<boolean> {
    this.calls.verify++
    this.onVerify?.(this.calls.verify)
    return this.verifyResult
  }

  async recover(): Promise<CheckpointPayload> {
    this.calls.recover++
    if (this.recoverThrows) throw new Error("recover-failed")
    return structuredClone(this.recoverOverride ?? this.expected)
  }

  destroy(): void {
    this.calls.destroy++
  }
}

function setup() {
  const value = fixture()
  const port = new FakePort(value)
  const recovery = new FakeRecovery(toCheckpointPayload(value.oldRoot))
  return { value, port, recovery }
}

async function run(): Promise<{
  result: VerifiedDeleteResult
  port: FakePort
  recovery: FakeRecovery
  value: VerifiedDeleteFixture
}> {
  const { value, port, recovery } = setup()
  const result = await runVerifiedDelete(port, recovery, value)
  return { result, port, recovery, value }
}

function expectedZeroDelete(result: VerifiedDeleteResult): void {
  expect(result.counts.removeCalls).toBe(0)
  expect(result.safety.deleteCalls).toBe(0)
  expect(result.delete.requested).toBe(false)
}

describe("verified delete state machine", () => {
  test("success deletes only the frozen old ID once and recovers the exact payload", async () => {
    const { result, port, recovery, value } = await run()
    expect(result.outcome).toBe("delete-verified")
    expect(result.reason).toBeNull()
    expect(result.phase).toBe("complete")
    expect(port.removed).toEqual([value.oldRoot.session.id])
    expect(result.counts.removeCalls).toBe(1)
    expect(result.delete).toEqual({ requested: true, state: "deleted", removeOutcome: "resolved" })
    expect(result.checks).toEqual({
      oldBaseline: "verified",
      recoveryBeforeImport: "verified",
      candidateAbsent: "verified",
      import: "created",
      candidateReadback: "verified",
      recoveryBeforeDelete: "verified",
      oldUnchanged: "verified",
      inventory: "verified",
      recoveryAfterDelete: "verified",
    })
    expect(result.counts.inventorySessions).toBe(2)
    expect(result.counts.inventoryMessages).toBe(5)
    expect(result.retained).toEqual({ oldRoot: false, candidate: true })
    expect(result.safety.deleteTargetFrozenOldOnly).toBe(true)
    expect(result.safety.candidateDeleteCalls).toBe(0)
    expect(result.safety.blindRetries).toBe(0)
    expect(result.safety.casClaim).toBe(false)
    expect(result.safety.residual).toBe("manual-quiescence-required")
    expect(result.safety.automaticRestore).toBe(false)
    expect(recovery.calls.verify).toBe(2)
    expect(recovery.calls.recover).toBe(1)
    expect(recovery.calls.destroy).toBe(0)
  })

  test("missing and tampered recovery verification block before import with zero deletes", async () => {
    const { value, port, recovery } = setup()
    recovery.verifyResult = false
    const result = await runVerifiedDelete(port, recovery, value)
    expect(result.outcome).toBe("blocked")
    expect(result.reason).toBe("recovery-verify-failed-before-import")
    expectedZeroDelete(result)
    expect(port.removed).toEqual([])
    expect(port.calls.includes("import")).toBe(false)
    expect(result.retained).toEqual({ oldRoot: true, candidate: false })
  })

  test("a recovery failure after import but before delete blocks with zero deletes", async () => {
    const { value, port, recovery } = setup()
    recovery.onVerify = (call) => {
      if (call === 2) recovery.verifyResult = false
    }
    const result = await runVerifiedDelete(port, recovery, value)
    expect(result.outcome).toBe("blocked")
    expect(result.reason).toBe("recovery-verify-failed-before-delete")
    expectedZeroDelete(result)
    expect(result.checks.recoveryBeforeDelete).toBe("not-tested")
    expect(port.removed).toEqual([])
    expect(result.retained).toEqual({ oldRoot: true, candidate: true })
  })

  test("recover failure after delete is honest and does not pretend to restore", async () => {
    const { value, port, recovery } = setup()
    recovery.recoverThrows = true
    const result = await runVerifiedDelete(port, recovery, value)
    expect(result.outcome).toBe("failed")
    expect(result.reason).toBe("recovery-failed")
    expect(result.delete.state).toBe("deleted")
    expect(result.retained).toEqual({ oldRoot: false, candidate: true })
    expect(result.safety.automaticRestore).toBe(false)
    expect(port.removed).toEqual([value.oldRoot.session.id])

    const second = setup()
    const tampered = structuredClone(second.recovery.expected) as unknown as {
      sessions: Array<{ messages: Array<{ text: string }> }>
    }
    tampered.sessions[0]!.messages[0]!.text = "tampered"
    second.recovery.recoverOverride = tampered as unknown as CheckpointPayload
    const mismatched = await runVerifiedDelete(second.port, second.recovery, second.value)
    expect(mismatched.outcome).toBe("failed")
    expect(mismatched.reason).toBe("recovery-mismatch")
    expect(mismatched.delete.state).toBe("deleted")
    expect(mismatched.safety.automaticRestore).toBe(false)
  })

  test("import failure blocks with zero deletes and creates no candidate", async () => {
    const { value, port, recovery } = setup()
    port.importFails = true
    const result = await runVerifiedDelete(port, recovery, value)
    expect(result.outcome).toBe("blocked")
    expect(result.reason).toBe("import-failed")
    expect(result.checks.import).toBe("failed")
    expectedZeroDelete(result)
    expect(result.retained).toEqual({ oldRoot: true, candidate: false })
  })

  test("candidate present or ambiguous lookup blocks with zero deletes", async () => {
    const present = setup()
    present.port.seedCandidate()
    const presentResult = await runVerifiedDelete(present.port, present.recovery, present.value)
    expect(presentResult.reason).toBe("candidate-present")
    expectedZeroDelete(presentResult)
    expect(presentResult.retained.candidate).toBe(true)

    const ambiguous = setup()
    ambiguous.port.candidateLookup = "ambiguous"
    const ambiguousResult = await runVerifiedDelete(ambiguous.port, ambiguous.recovery, ambiguous.value)
    expect(ambiguousResult.reason).toBe("candidate-lookup-ambiguous")
    expectedZeroDelete(ambiguousResult)
  })

  test("content, order, mapping, and unfresh native IDs block before delete", async () => {
    const content = setup()
    content.port.afterImport = (port) => {
      port.messages.get(content.value.candidateRoot.session.id)![0]!.text = "changed"
    }
    const contentResult = await runVerifiedDelete(content.port, content.recovery, content.value)
    expect(contentResult.reason).toBe("candidate-message-mismatch")
    expectedZeroDelete(contentResult)

    const order = setup()
    order.port.afterImport = (port) => {
      const messages = port.messages.get(order.value.candidateRoot.session.id)!
      const first = messages[0]!
      messages[0] = messages[1]!
      messages[1] = first
    }
    const orderResult = await runVerifiedDelete(order.port, order.recovery, order.value)
    expect(orderResult.reason).toBe("candidate-message-mismatch")
    expectedZeroDelete(orderResult)

    const mapping = setup()
    mapping.port.candidateMessageIDs = [messageID("3"), messageID("3"), messageID("5")]
    const mappingResult = await runVerifiedDelete(mapping.port, mapping.recovery, mapping.value)
    expect(mappingResult.reason).toBe("candidate-id-duplicate")
    expectedZeroDelete(mappingResult)

    const unfresh = setup()
    unfresh.port.candidateMessageIDs = [
      unfresh.value.oldRoot.messages[0]!.id,
      messageID("4"),
      messageID("5"),
    ]
    const unfreshResult = await runVerifiedDelete(unfresh.port, unfresh.recovery, unfresh.value)
    expect(unfreshResult.reason).toBe("candidate-id-unfresh")
    expectedZeroDelete(unfreshResult)
  })

  test("unknown old message references and old-root edits block before delete", async () => {
    const unknown = setup()
    unknown.port.messages.get(unknown.value.oldRoot.session.id)![0]!.id = messageID("9")
    const unknownResult = await runVerifiedDelete(unknown.port, unknown.recovery, unknown.value)
    expect(unknownResult.reason).toBe("old-message-mismatch")
    expectedZeroDelete(unknownResult)

    const late = setup()
    late.recovery.onVerify = (call) => {
      if (call === 2) late.port.messages.get(late.value.oldRoot.session.id)![1]!.text = "late-edit"
    }
    const lateResult = await runVerifiedDelete(late.port, late.recovery, late.value)
    expect(lateResult.reason).toBe("old-changed-before-delete")
    expect(lateResult.checks.oldUnchanged).toBe("not-tested")
    expectedZeroDelete(lateResult)
  })

  test("unsupported graphs and shapes fail closed before delete", async () => {
    const cases: Array<{ reason: string; mutate: (port: FakePort, value: VerifiedDeleteFixture) => void }> = [
      {
        reason: "old-not-parentless",
        mutate: (port, value) => {
          port.sessions.get(value.oldRoot.session.id)!.parentID = value.candidateRoot.session.id
        },
      },
      {
        reason: "old-not-active",
        mutate: (port, value) => {
          port.sessions.get(value.oldRoot.session.id)!.time.archived = 1_700_000_000_000
        },
      },
      {
        reason: "unsupported-session-shape",
        mutate: (port, value) => {
          const session = port.sessions.get(value.oldRoot.session.id) as ProbeSession & { revert: unknown }
          session.revert = { messageID: messageID("1") }
        },
      },
      {
        reason: "unsupported-message-shape",
        mutate: (port, value) => {
          const message = port.messages.get(value.oldRoot.session.id)![1] as ProbeMessage & {
            content: unknown[]
          }
          message.content = [{ type: "tool", text: "unsupported" }]
        },
      },
      {
        reason: "candidate-not-parentless",
        mutate: (port, value) => {
          port.afterImport = (target) => {
            target.sessions.get(value.candidateRoot.session.id)!.parentID = value.oldRoot.session.id
          }
        },
      },
    ]

    for (const item of cases) {
      const { value, port, recovery } = setup()
      item.mutate(port, value)
      const result = await runVerifiedDelete(port, recovery, value)
      expect(result.reason).toBe(item.reason)
      expectedZeroDelete(result)
    }
  })

  test("inventory must contain exactly the two owned roots and the fixture closure", async () => {
    const cases: Array<{ reason: string; apply: (port: FakePort, value: VerifiedDeleteFixture) => void }> = [
      {
        reason: "inventory-foreign-session",
        apply: (port, value) => {
          port.inventoryTransform = (entries) => [
            ...entries,
            { id: sessionID("c"), projectID: value.projectID, messageIDs: [] },
          ]
        },
      },
      {
        reason: "inventory-missing-session",
        apply: (port, value) => {
          port.inventoryTransform = (entries) => entries.filter((entry) => entry.id !== value.candidateRoot.session.id)
        },
      },
      {
        reason: "inventory-foreign-message",
        apply: (port) => {
          port.inventoryTransform = (entries) =>
            entries.map((entry) =>
              entry.id === port.fixture.candidateRoot.session.id
                ? { ...entry, messageIDs: [...entry.messageIDs, messageID("8")] }
                : entry,
            )
        },
      },
      {
        reason: "inventory-duplicate-message",
        apply: (port, value) => {
          const oldID = value.oldRoot.messages[0]!.id
          port.inventoryTransform = (entries) =>
            entries.map((entry) =>
              entry.id === value.candidateRoot.session.id
                ? { ...entry, messageIDs: [...entry.messageIDs, oldID] }
                : entry,
            )
        },
      },
      {
        reason: "inventory-session-parent",
        apply: (port, value) => {
          port.inventoryTransform = (entries) =>
            entries.map((entry) =>
              entry.id === value.candidateRoot.session.id ? { ...entry, parentID: value.oldRoot.session.id } : entry,
            )
        },
      },
      {
        reason: "unsupported-inventory-shape",
        apply: (port) => {
          port.inventoryTransform = (entries) =>
            entries.map((entry) => ({ ...entry, extra: true })) as unknown as InventorySession[]
        },
      },
      {
        reason: "inventory-unreadable",
        apply: (port) => {
          port.inventoryThrows = true
        },
      },
    ]

    for (const item of cases) {
      const { value, port, recovery } = setup()
      item.apply(port, value)
      const result = await runVerifiedDelete(port, recovery, value)
      expect(result.reason).toBe(item.reason)
      expectedZeroDelete(result)
    }
  })

  test("fresh global candidate IDs may replace fixture IDs without weakening content checks", async () => {
    const { value, port, recovery } = setup()
    port.candidateMessageIDs = [messageID("6"), messageID("7"), messageID("8")]
    const result = await runVerifiedDelete(port, recovery, value)
    expect(result.outcome).toBe("delete-verified")
    expect(port.removed).toEqual([value.oldRoot.session.id])
    expect(result.counts.inventoryMessages).toBe(5)
  })

  test("timeout after apply is observed through readback and not retried", async () => {
    const { value, port, recovery } = setup()
    port.removeMode = "apply-timeout"
    const result = await runVerifiedDelete(port, recovery, value)
    expect(result.outcome).toBe("delete-verified")
    expect(result.delete.removeOutcome).toBe("timeout")
    expect(result.delete.state).toBe("deleted")
    expect(result.counts.removeCalls).toBe(1)
    expect(port.removed).toEqual([value.oldRoot.session.id])
  })

  test("timeout without apply retains both roots and does not retry or recover", async () => {
    const { value, port, recovery } = setup()
    port.removeMode = "timeout-noop"
    const result = await runVerifiedDelete(port, recovery, value)
    expect(result.outcome).toBe("failed")
    expect(result.reason).toBe("delete-not-applied")
    expect(result.delete.state).toBe("not-deleted")
    expect(result.counts.removeCalls).toBe(1)
    expect(result.retained).toEqual({ oldRoot: true, candidate: true })
    expect(port.removed).toEqual([value.oldRoot.session.id])
    expect(recovery.calls.recover).toBe(0)
  })

  test("unknown delete state stops without recovery or retry", async () => {
    const { value, port, recovery } = setup()
    port.removeMode = "noop"
    port.unknownAfterRemove = true
    const result = await runVerifiedDelete(port, recovery, value)
    expect(result.outcome).toBe("failed")
    expect(result.reason).toBe("delete-state-unknown")
    expect(result.delete.state).toBe("unknown")
    expect(result.retained).toEqual({ oldRoot: true, candidate: true })
    expect(result.safety.blindRetries).toBe(0)
    expect(result.counts.removeCalls).toBe(1)
    expect(recovery.calls.recover).toBe(0)
  })

  test("candidate changes after delete are reported without recovery or retry", async () => {
    const { value, port, recovery } = setup()
    port.afterRemove = (target) => {
      target.messages.get(value.candidateRoot.session.id)![2]!.text = "changed-after-delete"
    }
    const result = await runVerifiedDelete(port, recovery, value)
    expect(result.outcome).toBe("failed")
    expect(result.reason).toBe("candidate-changed-after-delete")
    expect(result.delete.state).toBe("deleted")
    expect(result.retained).toEqual({ oldRoot: false, candidate: true })
    expect(result.counts.removeCalls).toBe(1)
    expect(recovery.calls.recover).toBe(0)
  })

  test("tail must stay distinct from the old history prefix", async () => {
    const { value, port, recovery } = setup()
    port.afterImport = (target) => {
      target.messages.get(value.candidateRoot.session.id)![2]!.text = OLD_MESSAGE_TEXT[0]
    }
    const result = await runVerifiedDelete(port, recovery, value)
    expect(result.reason).toBe("candidate-tail-mismatch")
    expectedZeroDelete(result)
  })

  test("invalid fixtures fail before any port call", async () => {
    const value = fixture()
    const invalid = {
      ...value,
      candidateRoot: {
        ...value.candidateRoot,
        messages: [value.candidateRoot.messages[0]!, value.candidateRoot.messages[0]!, value.candidateRoot.messages[2]!],
      },
    }
    const port = new FakePort(invalid)
    const recovery = new FakeRecovery(toCheckpointPayload(invalid.oldRoot))
    const result = await runVerifiedDelete(port, recovery, invalid)
    expect(result.outcome).toBe("invalid-fixture")
    expect(result.reason).toBe("invalid-fixture")
    expect(port.calls).toEqual([])
    expect(port.removed).toEqual([])
    expect(recovery.calls.verify).toBe(0)
  })
})
