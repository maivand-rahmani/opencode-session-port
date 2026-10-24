import { describe, expect, test } from "bun:test"
import {
  CANDIDATE_MESSAGE_TEXT,
  CANDIDATE_TITLE,
  OLD_MESSAGE_TEXT,
  OLD_ROOT_TITLE,
  SYNTHETIC_TAIL_TEXT,
  buildImportPayload,
  createSyntheticFixture,
  validateFixture,
  type NativeFixture,
} from "./fixtures"
import {
  AdapterTimeoutError,
  NotFoundError,
  UnsupportedFeatureError,
  archiveState,
  createRestartManifest,
  diagnoseOldRootBaseline,
  parseRestartManifest,
  runNativeReplacement,
  validateRestartReadback,
  type AdapterMessage,
  type AdapterSession,
  type NativeReplacementAdapter,
  type PostRestartSnapshot,
} from "./state-machine"
import {
  HTTP_PROBE_MAX_LIST_ITEMS,
  HTTP_PROBE_MAX_RESPONSE_BYTES,
  createHttpProbeAdapter,
  type HttpProbeRequest,
} from "./http-adapter"

const sessionID = (character: string) => `ses_${character.repeat(64)}`
const messageID = (character: string) => `msg_${character.repeat(64)}`

function syntheticFixture(): NativeFixture {
  return createSyntheticFixture({
    directory: "C:\\probe\\native-replacement",
    projectID: "native-replacement-probe",
    now: 1_700_000_000_000,
    ids: {
      oldRootID: sessionID("a"),
      candidateID: sessionID("b"),
      oldMessageIDs: [messageID("1"), messageID("2")],
      candidateMessageIDs: [messageID("3"), messageID("4"), messageID("5")],
    },
  })
}

type FakeOptions = {
  importFails?: boolean
  importID?: string
  candidateMessages?: readonly AdapterMessage[]
  candidateLookupError?: "generic"
  candidateTime?: "active" | "absent" | "archived"
  oldTime?: "active" | "absent" | "archived"
  stripArchive?: boolean
  archiveTransport?: "unsupported" | "error" | "timeout-applied" | "timeout-readback-fail"
  listMode?: "filter" | "ignore" | "omit" | "unsupported" | "error"
  unarchiveMode?: "false" | "missing-time" | "true"
  mutateOldOnUnarchive?: boolean
}

class FakeAdapter implements NativeReplacementAdapter {
  readonly calls: string[] = []
  readonly setArchivedCalls: { sessionID: string; archived: boolean }[] = []
  readonly oldSession: AdapterSession
  readonly oldMessages: AdapterMessage[]
  candidateSession: AdapterSession | null = null
  candidateMessages: AdapterMessage[] = []
  private mutateOldOnNextRead = false
  private failOldGetAfterArchive = false

  constructor(
    readonly fixture: NativeFixture,
    readonly options: FakeOptions = {},
  ) {
    this.oldSession = {
      id: fixture.oldRootID,
      parentID: null,
      title: OLD_ROOT_TITLE,
      projectID: fixture.projectID,
      location: { directory: fixture.directory },
      ...sessionTime(options.oldTime ?? "active"),
    }
    this.oldMessages = cloneMessages(fixture.oldMessages)
  }

  async importSession(payload: ReturnType<typeof buildImportPayload>) {
    this.calls.push("import")
    if (this.options.importFails) throw new Error("synthetic import failure")
    const id = this.options.importID ?? payload.info.id
    this.candidateSession = {
      id,
      title: payload.info.title,
      projectID: payload.info.projectID,
      location: { directory: payload.info.location.directory },
      ...sessionTime(this.options.candidateTime ?? "active"),
    }
    this.candidateMessages = cloneMessages(this.options.candidateMessages ?? payload.messages)
    return { id }
  }

  async getSession(id: string): Promise<AdapterSession> {
    if (id === this.fixture.candidateID && this.options.candidateLookupError === "generic") {
      throw new Error("synthetic candidate lookup failure")
    }
    if (id === this.fixture.oldRootID && this.failOldGetAfterArchive) {
      throw new Error("synthetic archive readback failure")
    }
    return copySession(this.sessionByID(id))
  }

  async listMessages(id: string): Promise<readonly AdapterMessage[]> {
    if (id === this.fixture.oldRootID) {
      if (this.mutateOldOnNextRead) {
        this.mutateOldOnNextRead = false
        this.oldMessages[0] = { ...this.oldMessages[0], text: "synthetic late edit" }
      }
      return cloneMessages(this.oldMessages)
    }
    if (this.candidateSession?.id === id) return cloneMessages(this.candidateMessages)
    throw new NotFoundError("message-list")
  }

  async listSessions(input: { directory: string; archived?: boolean }): Promise<readonly AdapterSession[]> {
    this.calls.push(`list:${input.archived === true ? "archived" : "active"}`)
    const mode = this.options.listMode ?? "filter"
    if (mode === "unsupported") throw new UnsupportedFeatureError("archived-list-filter")
    if (mode === "error") throw new Error("synthetic list failure")
    const all = [this.oldSession, ...(this.candidateSession ? [this.candidateSession] : [])]
    if (mode === "ignore") return all.map(copySession)
    if (mode === "omit") return []
    return all
      .filter((session) =>
        input.archived === true ? archiveState(session) === "archived" : archiveState(session) !== "archived",
      )
      .map(copySession)
  }

  async setArchived(id: string, archived: boolean): Promise<void> {
    this.calls.push(`setArchived:${archived}`)
    this.setArchivedCalls.push({ sessionID: id, archived })
    if (this.options.archiveTransport === "unsupported") throw new UnsupportedFeatureError("archived-patch")
    if (this.options.archiveTransport === "error") throw new Error("synthetic archive failure")
    if (this.options.archiveTransport === "timeout-applied" && archived) {
      this.oldSession.time = { ...this.oldSession.time, archived: 1 }
      throw new AdapterTimeoutError("archived-patch")
    }
    if (this.options.archiveTransport === "timeout-readback-fail" && archived) {
      this.oldSession.time = { ...this.oldSession.time, archived: 1 }
      this.failOldGetAfterArchive = true
      throw new AdapterTimeoutError("archived-patch")
    }
    if (this.options.stripArchive) return
    if (id !== this.fixture.oldRootID) throw new Error("synthetic unexpected mutation")
    if (archived) {
      this.oldSession.time = { ...this.oldSession.time, archived: 1 }
      return
    }
    if (this.options.unarchiveMode === "true") {
      this.oldSession.time = { ...this.oldSession.time, archived: 1 }
    } else if (this.options.unarchiveMode === "missing-time") {
      this.oldSession.time = undefined
    } else {
      this.oldSession.time = { created: this.oldSession.time?.created, updated: this.oldSession.time?.updated }
    }
    if (this.options.mutateOldOnUnarchive) this.mutateOldOnNextRead = true
  }

  snapshot(): PostRestartSnapshot {
    if (!this.candidateSession) throw new Error("synthetic candidate missing")
    return {
      oldRoot: copySession(this.oldSession),
      candidate: copySession(this.candidateSession),
      oldMessages: cloneMessages(this.oldMessages),
      candidateMessages: cloneMessages(this.candidateMessages),
    }
  }

  private sessionByID(id: string): AdapterSession {
    if (id === this.oldSession.id) return this.oldSession
    if (this.candidateSession?.id === id) return this.candidateSession
    throw new NotFoundError("session-get")
  }
}

function sessionTime(mode: "active" | "absent" | "archived"): Partial<AdapterSession> {
  if (mode === "absent") return {}
  if (mode === "archived") return { time: { created: 1, updated: 2, archived: 3 } }
  return { time: { created: 1, updated: 2 } }
}

function cloneMessages(messages: readonly AdapterMessage[]): AdapterMessage[] {
  return messages.map((message) => ({
    ...message,
    ...(message.time ? { time: { ...message.time } } : {}),
    ...(message.content ? { content: message.content.map((part) => ({ ...part })) } : {}),
  }))
}

function copySession(session: AdapterSession): AdapterSession {
  return {
    ...session,
    ...(session.location ? { location: { ...session.location } } : {}),
    ...(session.time ? { time: { ...session.time } } : {}),
  }
}

describe("synthetic fixture", () => {
  test("has two old messages, a distinct three-message candidate tail, and no parent", () => {
    const fixture = syntheticFixture()
    expect(validateFixture(fixture)).toEqual([])
    expect(fixture.oldMessages).toHaveLength(2)
    expect(fixture.candidateMessages).toHaveLength(3)
    expect(fixture.candidateMessages[2]?.text).toBe(SYNTHETIC_TAIL_TEXT)
    expect(fixture.candidateMessages[2]?.text).not.toBe(fixture.candidateMessages[0]?.text)

    const payload = buildImportPayload(fixture)
    expect("parentID" in payload.info).toBe(false)
    const ids = [
      fixture.oldRootID,
      fixture.candidateID,
      ...fixture.oldMessages.map((message) => message.id),
      ...fixture.candidateMessages.map((message) => message.id),
    ]
    expect(new Set(ids).size).toBe(ids.length)
  })

  test("rejects duplicate roots, duplicate message IDs, and a non-distinct tail", () => {
    const fixture = syntheticFixture()
    expect(validateFixture({ ...fixture, candidateID: fixture.oldRootID })).toContain("root-id-duplicate")

    const duplicate = {
      ...fixture,
      candidateMessages: fixture.candidateMessages.map((message, index) =>
        index === 2 ? { ...message, id: fixture.oldMessages[0]!.id } : message,
      ),
    }
    expect(validateFixture(duplicate)).toContain("fixture-id-duplicate")

    const tail = {
      ...fixture,
      candidateMessages: fixture.candidateMessages.map((message, index) =>
        index === 2 ? { ...message, text: CANDIDATE_MESSAGE_TEXT[0] } : message,
      ),
    }
    expect(validateFixture(tail)).toContain("tail-invalid")
  })

  test("rejects extra properties, tool parts, and non-allowlisted text", () => {
    const fixture = syntheticFixture()
    expect(validateFixture({ ...fixture, notes: "raw" })).toContain("fixture-shape-invalid")

    const extraMessageProp = {
      ...fixture,
      candidateMessages: fixture.candidateMessages.map((message, index) =>
        index === 0 ? { ...message, extra: "raw" } : message,
      ),
    }
    expect(validateFixture(extraMessageProp)).toContain("message-shape-invalid")

    const toolPart = {
      ...fixture,
      candidateMessages: fixture.candidateMessages.map((message, index) =>
        index === 1
          ? {
              ...message,
              content: [
                { type: "text", text: CANDIDATE_MESSAGE_TEXT[1] },
                { type: "tool", text: "synthetic tool part" },
              ],
            }
          : message,
      ),
    }
    expect(validateFixture(toolPart)).toContain("message-content-invalid")

    const arbitraryText = {
      ...fixture,
      candidateMessages: fixture.candidateMessages.map((message, index) =>
        index === 2 ? { ...message, text: "arbitrary text" } : message,
      ),
    }
    expect(validateFixture(arbitraryText)).toContain("tail-invalid")
    expect(() => buildImportPayload(extraMessageProp)).toThrow("fixture-invalid")
  })

  test("builds only whitelisted import fields", () => {
    const fixture = syntheticFixture()
    const payload = buildImportPayload(fixture)

    expect(Object.keys(payload.info)).toEqual([
      "id",
      "projectID",
      "cost",
      "tokens",
      "time",
      "title",
      "location",
    ])
    expect(Object.keys(payload.messages[0]!)).toEqual(["id", "type", "text", "time"])
    expect(Object.keys(payload.messages[1]!)).toEqual([
      "id",
      "type",
      "agent",
      "model",
      "time",
      "content",
    ])
    expect(Object.keys(payload.messages[1]!.content![0]!)).toEqual(["type", "text"])
    expect("parentID" in payload.info).toBe(false)
  })
})

describe("canonical archive normalization", () => {
  test("derives active only from valid required time with archived absent", () => {
    expect(archiveState({ id: sessionID("a"), time: { created: 1, updated: 2 } })).toBe("active")
    expect(archiveState({ id: sessionID("a"), time: { created: 1, updated: 2, archived: 3 } })).toBe(
      "archived",
    )
    expect(archiveState({ id: sessionID("a"), time: { created: 1 } })).toBe("unknown")
    expect(archiveState({ id: sessionID("a"), time: { updated: 2 } })).toBe("unknown")
    expect(archiveState({ id: sessionID("a") })).toBe("unknown")
    expect(
      archiveState({ id: sessionID("a"), time: { created: 1, updated: 2, archived: null } }),
    ).toBe("unknown")
    expect(
      archiveState({ id: sessionID("a"), archived: false } as unknown as AdapterSession),
    ).toBe("unknown")
  })
})

describe("native replacement state machine", () => {
  test("verifies parentless import, archive readback, unarchive, and both retained histories", async () => {
    const fixture = syntheticFixture()
    const fake = new FakeAdapter(fixture)
    const result = await runNativeReplacement(fake, fixture)

    expect(result.outcome).toBe("api-verified")
    expect(result.api.import).toBe("created")
    expect(result.api.candidateLookup).toBe("absent")
    expect(result.api.oldArchiveBefore).toBe("active")
    expect(result.api.candidateArchive).toBe("active")
    expect(result.api.parentless).toBe("verified")
    expect(result.api.history).toBe("verified")
    expect(result.api.archiveRequest).toBe("accepted")
    expect(result.api.archiveObserved).toBe("archived")
    expect(result.api.archiveReadback).toBe("verified")
    expect(result.api.listFiltering).toBe("observed")
    expect(result.api.unarchiveReadback).toBe("verified")
    expect(result.api.oldContentRetained).toBe("verified")
    expect(result.api.candidateRetained).toBe("verified")
    expect(result.api.restartReadback).toBe("not-tested")
    expect(result.mutations).toEqual([
      { sessionID: fixture.oldRootID, archived: true },
      { sessionID: fixture.oldRootID, archived: false },
    ])
    expect(result.retained).toEqual({ oldRoot: true, candidate: true })
    expect(result.native).toEqual({
      picker: "not-observed",
      route: "not-observed",
      composer: "not-tested",
    })
    expect(result.safety.deleteCalls).toBe(0)
    expect(result.safety.publicDeleteUsed).toBe(false)
    expect(result.safety.nativeUiInferredFromList).toBe(false)
    expect(result.safety.candidateMutationCalls).toBe(0)
    expect(result.safety.ordinaryContinuation).toBe("not-tested")
    expect(result.safety.permissionsForms).toBe("not-tested")
    expect(result.safety.concurrency).toBe("not-tested")
    expect(JSON.stringify(result)).not.toContain(SYNTHETIC_TAIL_TEXT)
    expect(JSON.stringify(result)).not.toContain(OLD_MESSAGE_TEXT[0])
    expect(JSON.stringify(result)).not.toContain(fixture.directory)
  })

  test("leaves the old root intact and makes no archive call when import fails", async () => {
    const fixture = syntheticFixture()
    const fake = new FakeAdapter(fixture, { importFails: true })
    const result = await runNativeReplacement(fake, fixture)

    expect(result.outcome).toBe("failed")
    expect(result.failure).toBe("import-failed")
    expect(result.api.import).toBe("failed")
    expect(result.api.oldRootIntact).toBe("verified")
    expect(result.api.archiveReadback).toBe("not-tested")
    expect(result.mutations).toEqual([])
    expect(result.retained).toEqual({ oldRoot: true, candidate: false })
    expect(fake.setArchivedCalls).toEqual([])
  })

  test("refuses import when the old root is already archived or its archive state is unknown", async () => {
    const fixture = syntheticFixture()

    const archived = await runNativeReplacement(new FakeAdapter(fixture, { oldTime: "archived" }), fixture)
    expect(archived.outcome).toBe("blocked")
    expect(archived.blocker).toBe("old-root-already-archived")
    expect(archived.api.oldArchiveBefore).toBe("archived")
    expect(archived.api.import).toBe("not-run")
    expect(archived.mutations).toEqual([])

    const unknown = await runNativeReplacement(new FakeAdapter(fixture, { oldTime: "absent" }), fixture)
    expect(unknown.outcome).toBe("blocked")
    expect(unknown.blocker).toBe("old-root-archive-state-unknown")
    expect(unknown.api.oldArchiveBefore).toBe("unknown")
    expect(unknown.api.import).toBe("not-run")
    expect(unknown.mutations).toEqual([])
  })

  test("blocks import when the candidate ID is present or lookup is ambiguous", async () => {
    const fixture = syntheticFixture()

    const presentFake = new FakeAdapter(fixture)
    presentFake.candidateSession = {
      id: fixture.candidateID,
      parentID: null,
      title: CANDIDATE_TITLE,
      projectID: fixture.projectID,
      location: { directory: fixture.directory },
      time: { created: 1, updated: 2 },
    }
    const present = await runNativeReplacement(presentFake, fixture)
    expect(present.outcome).toBe("blocked")
    expect(present.blocker).toBe("candidate-id-present")
    expect(present.api.candidateLookup).toBe("present")
    expect(present.api.import).toBe("not-run")
    expect(presentFake.calls).not.toContain("import")

    const ambiguousFake = new FakeAdapter(fixture, { candidateLookupError: "generic" })
    const ambiguous = await runNativeReplacement(ambiguousFake, fixture)
    expect(ambiguous.outcome).toBe("blocked")
    expect(ambiguous.blocker).toBe("candidate-id-lookup-ambiguous")
    expect(ambiguous.api.candidateLookup).toBe("ambiguous")
    expect(ambiguous.api.import).toBe("not-run")
    expect(ambiguousFake.calls).not.toContain("import")
  })

  test("refuses archive when the candidate archive state is unknown or archived", async () => {
    const fixture = syntheticFixture()

    const unknown = await runNativeReplacement(new FakeAdapter(fixture, { candidateTime: "absent" }), fixture)
    expect(unknown.outcome).toBe("api-verified-partial")
    expect(unknown.blocker).toBe("candidate-archive-state-unknown")
    expect(unknown.api.candidateArchive).toBe("unknown")
    expect(unknown.api.archiveReadback).toBe("not-tested")
    expect(unknown.mutations).toEqual([])

    const archived = await runNativeReplacement(new FakeAdapter(fixture, { candidateTime: "archived" }), fixture)
    expect(archived.outcome).toBe("failed")
    expect(archived.failure).toBe("candidate-already-archived")
    expect(archived.api.candidateArchive).toBe("archived")
    expect(archived.api.archiveReadback).toBe("not-tested")
    expect(archived.mutations).toEqual([])
  })

  test("classifies a timed-out archive request by a read-only follow-up readback", async () => {
    const fixture = syntheticFixture()
    const fake = new FakeAdapter(fixture, { archiveTransport: "timeout-applied" })
    const result = await runNativeReplacement(fake, fixture)

    expect(result.outcome).toBe("api-verified")
    expect(result.api.archiveRequest).toBe("timeout")
    expect(result.api.archiveObserved).toBe("archived")
    expect(result.api.archiveReadback).toBe("verified")
    expect(result.mutations).toEqual([
      { sessionID: fixture.oldRootID, archived: true },
      { sessionID: fixture.oldRootID, archived: false },
    ])
    expect(archiveState(fake.oldSession)).toBe("active")
  })

  test("classifies a generic archive request error as active and stops without retry", async () => {
    const fixture = syntheticFixture()
    const fake = new FakeAdapter(fixture, { archiveTransport: "error" })
    const result = await runNativeReplacement(fake, fixture)

    expect(result.outcome).toBe("blocked")
    expect(result.blocker).toBe("archive-request-error-observed-active")
    expect(result.api.archiveRequest).toBe("error")
    expect(result.api.archiveObserved).toBe("active")
    expect(result.api.archiveReadback).toBe("mismatch")
    expect(result.mutations).toEqual([{ sessionID: fixture.oldRootID, archived: true }])
    expect(fake.setArchivedCalls).toHaveLength(1)
    expect(result.retained).toEqual({ oldRoot: true, candidate: true })
  })

  test("keeps both roots when a timed-out archive readback is unknown", async () => {
    const fixture = syntheticFixture()
    const fake = new FakeAdapter(fixture, { archiveTransport: "timeout-readback-fail" })
    const result = await runNativeReplacement(fake, fixture)

    expect(result.outcome).toBe("blocked")
    expect(result.blocker).toBe("archive-readback-unknown")
    expect(result.api.archiveRequest).toBe("timeout")
    expect(result.api.archiveObserved).toBe("unknown")
    expect(result.api.archiveReadback).toBe("unknown")
    expect(result.mutations).toEqual([{ sessionID: fixture.oldRootID, archived: true }])
    expect(result.retained).toEqual({ oldRoot: true, candidate: true })
    expect(fake.setArchivedCalls).toHaveLength(1)
  })

  test("rejects a same-ID fixture before any adapter call", async () => {
    const fixture = syntheticFixture()
    const invalid = { ...fixture, candidateID: fixture.oldRootID }
    const fake = new FakeAdapter(invalid)
    const result = await runNativeReplacement(fake, invalid)

    expect(result.outcome).toBe("invalid-fixture")
    expect(result.failure).toBe("root-id-duplicate")
    expect(result.candidateCreated).toBe(false)
    expect(fake.calls).toEqual([])
  })

  test("refuses to archive when the imported root returns an unexpected ID", async () => {
    const fixture = syntheticFixture()
    const fake = new FakeAdapter(fixture, { importID: sessionID("c") })
    const result = await runNativeReplacement(fake, fixture)

    expect(result.outcome).toBe("failed")
    expect(result.failure).toBe("import-returned-unexpected-root")
    expect(result.api.import).toBe("unexpected-root")
    expect(result.api.archiveReadback).toBe("not-tested")
    expect(fake.setArchivedCalls).toEqual([])
  })

  test("refuses to archive when the new history is stale or malformed", async () => {
    const fixture = syntheticFixture()
    const fake = new FakeAdapter(fixture, {
      candidateMessages: fixture.candidateMessages.slice(0, 2),
    })
    const result = await runNativeReplacement(fake, fixture)

    expect(result.outcome).toBe("failed")
    expect(result.failure).toBe("candidate-history-mismatch")
    expect(result.api.parentless).toBe("verified")
    expect(result.api.history).toBe("failed")
    expect(result.api.archiveReadback).toBe("not-tested")
    expect(result.mutations).toEqual([])
    expect(result.retained).toEqual({ oldRoot: true, candidate: true })
  })

  test("treats a stripped archived field as a readback mismatch and retains both roots", async () => {
    const fixture = syntheticFixture()
    const fake = new FakeAdapter(fixture, { stripArchive: true })
    const result = await runNativeReplacement(fake, fixture)

    expect(result.outcome).toBe("blocked")
    expect(result.blocker).toBe("archive-readback-not-verified")
    expect(result.api.archiveReadback).toBe("mismatch")
    expect(result.api.unarchiveReadback).toBe("not-tested")
    expect(result.mutations).toEqual([{ sessionID: fixture.oldRootID, archived: true }])
    expect(fake.setArchivedCalls).toHaveLength(1)
    expect(archiveState(fake.oldSession)).toBe("active")
    expect(fake.candidateSession).not.toBeNull()
    expect(result.retained).toEqual({ oldRoot: true, candidate: true })
  })

  test("reports an unsupported archive transport as blocked with both roots retained", async () => {
    const fixture = syntheticFixture()
    const fake = new FakeAdapter(fixture, { archiveTransport: "unsupported" })
    const result = await runNativeReplacement(fake, fixture)

    expect(result.outcome).toBe("blocked")
    expect(result.blocker).toBe("archive-transport-unsupported")
    expect(result.api.archiveReadback).toBe("unsupported")
    expect(result.api.unarchiveReadback).toBe("not-tested")
    expect(result.mutations).toEqual([{ sessionID: fixture.oldRootID, archived: true }])
    expect(result.retained).toEqual({ oldRoot: true, candidate: true })
  })

  test("does not treat a non-filtering archived list as a pass", async () => {
    const fixture = syntheticFixture()
    const fake = new FakeAdapter(fixture, { listMode: "ignore" })
    const result = await runNativeReplacement(fake, fixture)

    expect(result.outcome).toBe("api-verified-partial")
    expect(result.api.listFiltering).toBe("not-filtering")
    expect(result.api.unarchiveReadback).toBe("verified")
    expect(result.blocker).toContain("list-archived-filter")
  })

  test("does not treat unsupported or unverified archived list filtering as a pass", async () => {
    const fixture = syntheticFixture()

    const unsupported = await runNativeReplacement(
      new FakeAdapter(fixture, { listMode: "unsupported" }),
      fixture,
    )
    expect(unsupported.outcome).toBe("api-verified-partial")
    expect(unsupported.api.listFiltering).toBe("unsupported")

    const unverified = await runNativeReplacement(
      new FakeAdapter(fixture, { listMode: "omit" }),
      fixture,
    )
    expect(unverified.outcome).toBe("api-verified-partial")
    expect(unverified.api.listFiltering).toBe("unverified")
  })

  test("keeps the native picker, route, and composer unobserved", async () => {
    const fixture = syntheticFixture()
    const result = await runNativeReplacement(new FakeAdapter(fixture), fixture)

    expect(result.native.picker).toBe("not-observed")
    expect(result.native.route).toBe("not-observed")
    expect(result.native.composer).toBe("not-tested")
    expect(result.safety.terminalRestore).toBe("not-proven")
    expect(result.safety.nativeUiInferredFromList).toBe(false)
    expect(result.featureFlags.nativePickerArchiveFilter).toBe("unknown")
  })

  test("detects a late old-root edit without claiming CAS", async () => {
    const fixture = syntheticFixture()
    const fake = new FakeAdapter(fixture, { mutateOldOnUnarchive: true })
    const result = await runNativeReplacement(fake, fixture)

    expect(result.outcome).toBe("failed")
    expect(result.failure).toBe("late-edit-detected-old-root")
    expect(result.api.unarchiveReadback).toBe("verified")
    expect(result.api.oldContentRetained).toBe("failed")
    expect(result.safety.lateEditDetected).toBe(true)
    expect(result.safety.casClaim).toBe(false)
    expect(result.safety.residual).toBe("manual-quiescence-required")
  })

  test("reports an unproven unarchive as partial rather than a pass", async () => {
    const fixture = syntheticFixture()
    const fake = new FakeAdapter(fixture, { unarchiveMode: "missing-time" })
    const result = await runNativeReplacement(fake, fixture)

    expect(result.outcome).toBe("api-verified-partial")
    expect(result.api.unarchiveReadback).toBe("unknown")
    expect(result.api.oldContentRetained).toBe("verified")
    expect(result.api.candidateRetained).toBe("verified")
    expect(result.blocker).toBe("unarchive-readback-not-verified")
  })

  test("optional rearchive is verified and still mutates only the old root", async () => {
    const fixture = syntheticFixture()
    const fake = new FakeAdapter(fixture)
    const result = await runNativeReplacement(fake, fixture, { rearchive: true })

    expect(result.outcome).toBe("api-verified")
    expect(result.api.rearchiveReadback).toBe("verified")
    expect(result.mutations).toEqual([
      { sessionID: fixture.oldRootID, archived: true },
      { sessionID: fixture.oldRootID, archived: false },
      { sessionID: fixture.oldRootID, archived: true },
    ])
    expect(fake.setArchivedCalls.every((call) => call.sessionID === fixture.oldRootID)).toBe(true)
    expect(result.safety.candidateMutationCalls).toBe(0)
    expect(validateRestartReadback(fake.snapshot(), fixture, true)).toEqual({ ok: true })
  })

  test("validates an externally captured restart readback without launching a host", async () => {
    const fixture = syntheticFixture()
    const fake = new FakeAdapter(fixture)
    const result = await runNativeReplacement(fake, fixture)
    const snapshot = fake.snapshot()

    expect(result.api.restartReadback).toBe("not-tested")
    expect(validateRestartReadback(snapshot, fixture, false)).toEqual({ ok: true })

    const parented = { ...snapshot, candidate: { ...snapshot.candidate, parentID: fixture.oldRootID } }
    expect(validateRestartReadback(parented, fixture, false)).toEqual({
      ok: false,
      code: "restart-candidate-parent-present",
    })

    const stillArchived = {
      ...snapshot,
      oldRoot: { ...snapshot.oldRoot, time: { ...snapshot.oldRoot.time, archived: 3 } },
    }
    expect(validateRestartReadback(stillArchived, fixture, false)).toEqual({
      ok: false,
      code: "restart-archive-state-mismatch",
    })
  })
})

describe("restart manifest", () => {
  test("carries bounded IDs and counts only", async () => {
    const fixture = syntheticFixture()
    const result = await runNativeReplacement(new FakeAdapter(fixture), fixture)
    const manifest = createRestartManifest(result)
    const serialized = JSON.stringify(manifest)

    expect(serialized).not.toContain(SYNTHETIC_TAIL_TEXT)
    expect(serialized).not.toContain(OLD_MESSAGE_TEXT[0])
    expect(serialized).not.toContain(fixture.directory)
    expect(parseRestartManifest(serialized)).toEqual({ ok: true, manifest })
  })

  test("rejects unknown fields, wrong versions, malformed counts, and oversized input", async () => {
    const fixture = syntheticFixture()
    const result = await runNativeReplacement(new FakeAdapter(fixture), fixture)
    const manifest = createRestartManifest(result)

    expect(parseRestartManifest(JSON.stringify({ ...manifest, notes: "raw" }))).toEqual({
      ok: false,
      code: "manifest-shape-invalid",
    })
    expect(parseRestartManifest(JSON.stringify({ ...manifest, version: 2 }))).toEqual({
      ok: false,
      code: "manifest-version-invalid",
    })
    expect(
      parseRestartManifest(JSON.stringify({ ...manifest, phase: "archive-requested", completedPhases: ["preflight"] })),
    ).toEqual({ ok: false, code: "manifest-phases-invalid" })
    expect(
      parseRestartManifest(JSON.stringify({ ...manifest, candidateMessageIDs: manifest.candidateMessageIDs.slice(0, 2) })),
    ).toEqual({ ok: false, code: "manifest-message-ids-invalid" })
    expect(parseRestartManifest(JSON.stringify({ ...manifest, padding: "x".repeat(9000) }))).toEqual({
      ok: false,
      code: "manifest-too-large",
    })
  })
})

describe("injected HTTP adapter", () => {
  test("sends archived on PATCH but never infers archive success from the response", async () => {
    const fixture = syntheticFixture()
    const oldSession: AdapterSession = {
      id: fixture.oldRootID,
      parentID: null,
      title: OLD_ROOT_TITLE,
      projectID: fixture.projectID,
      location: { directory: fixture.directory },
      time: { created: 1, updated: 2 },
    }
    let candidate: AdapterSession | null = null
    let candidateMessages: AdapterMessage[] = []
    const calls: { url: string; method: string; body?: string }[] = []

    const request: HttpProbeRequest = async (input) => {
      calls.push({ url: input.url, method: input.method, ...(input.body ? { body: input.body } : {}) })
      const path = new URL(input.url).pathname
      if (input.method === "POST" && path === "/api/session/import") {
        candidate = {
          id: fixture.candidateID,
          title: CANDIDATE_TITLE,
          projectID: fixture.projectID,
          location: { directory: fixture.directory },
          time: { created: 3, updated: 4 },
        }
        candidateMessages = cloneMessages(fixture.candidateMessages)
        return { status: 200, body: JSON.stringify({ data: { id: candidate.id } }) }
      }
      if (
        input.method === "GET" &&
        path === `/api/session/${fixture.candidateID}` &&
        candidate === null
      ) {
        return { status: 404, body: "{}" }
      }
      if (input.method === "GET" && path === `/api/session/${fixture.candidateID}/message`) {
        return { status: 200, body: JSON.stringify({ data: candidateMessages }) }
      }
      if (input.method === "GET" && path === `/api/session/${fixture.oldRootID}/message`) {
        return { status: 200, body: JSON.stringify({ data: cloneMessages(fixture.oldMessages) }) }
      }
      if (input.method === "GET" && path === `/api/session/${fixture.candidateID}`) {
        return { status: 200, body: JSON.stringify({ data: candidate }) }
      }
      if (input.method === "GET" && path === `/api/session/${fixture.oldRootID}`) {
        return { status: 200, body: JSON.stringify({ data: oldSession }) }
      }
      if (input.method === "PATCH") {
        // Simulate a transport that drops the archived field while returning 2xx.
        return { status: 200, body: "{}" }
      }
      return { status: 404, body: "{}" }
    }

    const adapter = createHttpProbeAdapter({
      baseUrl: "http://127.0.0.1:1",
      request,
      headers: () => ({ authorization: "test-only-synthetic" }),
      paths: {
        importSession: "/api/session/import",
        session: (id) => `/api/session/${id}`,
        messages: (id) => `/api/session/${id}/message`,
        sessions: () => "/api/session",
        updateSession: (id) => `/api/session/${id}`,
      },
    })
    const result = await runNativeReplacement(adapter, fixture)

    expect(result.outcome).toBe("blocked")
    expect(result.api.archiveReadback).toBe("mismatch")
    expect(calls.find((call) => call.method === "PATCH")?.body).toBe(JSON.stringify({ archived: true }))
    expect(result.retained).toEqual({ oldRoot: true, candidate: true })
  })

  test("encodes archived list query values as true and false", async () => {
    const seen: Array<"true" | "false" | undefined> = []
    const adapter = createHttpProbeAdapter({
      baseUrl: "http://127.0.0.1:1",
      request: async () => ({ status: 200, body: JSON.stringify({ data: [] }) }),
      paths: {
        ...httpTestPaths(),
        sessions: (input) => {
          seen.push(input.archived)
          return "/api/session"
        },
      },
    })

    await adapter.listSessions({ directory: "C:\\probe", archived: true })
    await adapter.listSessions({ directory: "C:\\probe", archived: false })
    expect(seen).toEqual(["true", "false"])
  })

  test("rejects oversized bodies before JSON parsing", async () => {
    const adapter = createHttpProbeAdapter({
      baseUrl: "http://127.0.0.1:1",
      request: async () => ({ status: 200, body: "x".repeat(HTTP_PROBE_MAX_RESPONSE_BYTES + 1) }),
      paths: httpTestPaths(),
    })

    await expect(adapter.getSession(sessionID("a"))).rejects.toThrow("http-probe-response-too-large")
  })

  test("bounds message and session list counts", async () => {
    const sessionsAdapter = createHttpProbeAdapter({
      baseUrl: "http://127.0.0.1:1",
      request: async () => ({
        status: 200,
        body: JSON.stringify({
          data: Array.from({ length: HTTP_PROBE_MAX_LIST_ITEMS + 1 }, () => ({ id: sessionID("a") })),
        }),
      }),
      paths: httpTestPaths(),
    })
    await expect(sessionsAdapter.listSessions({ directory: "C:\\probe" })).rejects.toThrow(
      "http-probe-list-too-large",
    )

    const messagesAdapter = createHttpProbeAdapter({
      baseUrl: "http://127.0.0.1:1",
      request: async () => ({
        status: 200,
        body: JSON.stringify({
          data: Array.from({ length: HTTP_PROBE_MAX_LIST_ITEMS + 1 }, () => ({ id: messageID("1") })),
        }),
      }),
      paths: httpTestPaths(),
    })
    await expect(messagesAdapter.listMessages(sessionID("a"))).rejects.toThrow("http-probe-list-too-large")
  })

  test("maps malformed JSON to a fixed error without echoing the body", async () => {
    const adapter = createHttpProbeAdapter({
      baseUrl: "http://127.0.0.1:1",
      request: async () => ({ status: 200, body: "{not-json" }),
      paths: httpTestPaths(),
    })

    await expect(adapter.getSession(sessionID("a"))).rejects.toThrow("http-probe-json-invalid")
  })
})

function baselineFixture() {
  return createSyntheticFixture({
    directory: "/run/sessionport/baseline-diagnostic",
    projectID: "m1-baseline-diagnostic",
    ids: {
      oldRootID: `ses_${"a".repeat(64)}`,
      candidateID: `ses_${"b".repeat(64)}`,
      oldMessageIDs: [`msg_${"1".repeat(64)}`, `msg_${"2".repeat(64)}`],
      candidateMessageIDs: [`msg_${"3".repeat(64)}`, `msg_${"4".repeat(64)}`, `msg_${"5".repeat(64)}`],
    },
  })
}

function baselineSnapshot(fixture: NativeFixture) {
  return {
    session: {
      id: fixture.oldRootID,
      title: OLD_ROOT_TITLE,
      projectID: fixture.projectID,
      location: { directory: fixture.directory },
      time: { created: 1_700_000_000_000, updated: 1_700_000_001_000 },
    },
    messages: fixture.oldMessages.map((message) => ({
      id: message.id,
      type: message.type,
      ...(message.text ? { text: message.text } : {}),
      time: { ...message.time },
      ...(message.content ? { content: message.content.map((part) => ({ ...part })) } : {}),
    })),
  }
}

describe("baseline diagnostic completeness", () => {
  test("reports the exact failing predicate subcheck without content", () => {
    const fixture = baselineFixture()
    const base = baselineSnapshot(fixture)
    const clean = diagnoseOldRootBaseline(base as any, fixture)
    expect(Object.values(clean.checks).every((value) => value === true)).toBe(true)

    const cases: Array<[string, (snapshot: any) => void]> = [
      ["returnedSessionID", (s) => { s.session.id = `ses_${"c".repeat(64)}` }],
      ["parentAbsent", (s) => { s.session.parentID = `ses_${"d".repeat(64)}` }],
      ["titleMatch", (s) => { s.session.title = "wrong-title" }],
      ["archiveActive", (s) => { s.session.time.archived = 1 }],
      ["projectIDMatch", (s) => { s.session.projectID = "wrong-project" }],
      ["directoryMatch", (s) => { s.session.location.directory = "/wrong" }],
      ["messageCountMatch", (s) => { s.messages.push({ id: `msg_${"6".repeat(64)}`, type: "user", text: "extra", time: { created: 1 } }) }],
      ["orderedIDsMatch", (s) => { s.messages.reverse() }],
      ["messageRoleMatch", (s) => { s.messages[0].type = "assistant" }],
      ["userTextMatch", (s) => { s.messages[0].text = "wrong-user-text" }],
      ["assistantContentMatch", (s) => { s.messages[1].content[0].text = "wrong-assistant-text" }],
    ]
    for (const [name, mutate] of cases) {
      const snapshot = baselineSnapshot(fixture)
      mutate(snapshot)
      const diagnostic = diagnoseOldRootBaseline(snapshot as any, fixture)
      expect((diagnostic.checks as any)[name]).toBe(false)
      expect(diagnostic.messages.fieldPresence.length).toBeLessThanOrEqual(5)
      expect(JSON.stringify(diagnostic)).not.toContain(OLD_MESSAGE_TEXT[0])
      expect(JSON.stringify(diagnostic)).not.toContain(OLD_MESSAGE_TEXT[1])
    }
  })
})

function httpTestPaths() {
  return {
    importSession: "/api/session/import",
    session: (id: string) => `/api/session/${id}`,
    messages: (id: string) => `/api/session/${id}/message`,
    sessions: () => "/api/session",
    updateSession: (id: string) => `/api/session/${id}`,
  }
}
