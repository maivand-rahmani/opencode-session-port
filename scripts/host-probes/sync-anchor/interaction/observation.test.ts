import { describe, expect, test } from "bun:test"
import {
  createInteractionObservation,
  summarizeInteractionObservation,
  validateInteractionObservation,
  type InteractionObservation,
} from "./observation"

function observed(): InteractionObservation {
  const record = createInteractionObservation()
  record.phase1.composerVisible = "observed"
  record.phase1.composerFocused = "observed"
  record.phase1.draftTypedNotSubmitted = "observed"
  record.phase1.headNavigation = "observed"
  record.phase1.rootNavigation = "observed"
  record.phase1.tabFocus = "observed"
  record.phase1.ownedStopVerified = "observed"
  record.phase2.manifestValid = "observed"
  record.phase2.readbackComplete = "observed"
  record.phase2.cacheReady = "observed"
  record.phase2.routeReady = "observed"
  record.phase2.ownedStopVerified = "observed"
  record.terminalRestored = "verified"
  return record
}

describe("interaction observation record", () => {
  test("defaults keep both phases, continuation, permissions, and concurrency unclaimed", () => {
    const record = createInteractionObservation()
    expect(validateInteractionObservation(record)).toEqual({ ok: true, errors: [] })
    expect(record.phase1.ownedStopVerified).toBe("not-tested")
    expect(record.phase2.ownedStopVerified).toBe("not-tested")
    expect(record.ordinaryContinuation).toBe("not-tested")
    expect(record.permissionsForms).toBe("not-tested")
    expect(record.concurrency).toBe("not-tested")
    expect(record.terminalRestored).toBe("unverified")
  })

  test("accepts separately observed phase 1 and phase 2 fields", () => {
    expect(validateInteractionObservation(observed())).toEqual({ ok: true, errors: [] })
  })

  test("rejects free-text or unexpected top-level fields", () => {
    const record = { ...createInteractionObservation(), notes: "raw terminal text" }
    expect(validateInteractionObservation(record)).toEqual({ ok: false, errors: ["unknown-field"] })
  })

  test("rejects unknown or missing phase fields", () => {
    const record = createInteractionObservation()
    const withExtra = { ...record, phase1: { ...record.phase1, notes: "raw" } }
    const missingPhase = { ...record, phase2: undefined }
    expect(validateInteractionObservation(withExtra).errors).toEqual(["unknown-field"])
    expect(validateInteractionObservation(missingPhase).errors).toEqual(["invalid-phase"])
  })

  test("rejects continuation, permissions, or concurrency overclaim", () => {
    const continuation = { ...createInteractionObservation(), ordinaryContinuation: "observed" }
    const permissions = { ...createInteractionObservation(), permissionsForms: "observed" }
    const concurrency = { ...createInteractionObservation(), concurrency: "observed" }
    expect(validateInteractionObservation(continuation).errors).toEqual(["overclaim"])
    expect(validateInteractionObservation(permissions).errors).toEqual(["overclaim"])
    expect(validateInteractionObservation(concurrency).errors).toEqual(["overclaim"])
  })

  test("rejects stored raw content and malformed status values", () => {
    const raw = { ...createInteractionObservation(), rawContentStored: true }
    const record = createInteractionObservation()
    const status = { ...record, phase1: { ...record.phase1, composerVisible: "maybe" } }
    const terminal = { ...record, terminalRestored: "probably" }
    expect(validateInteractionObservation(raw).errors).toEqual(["raw-content-not-allowed"])
    expect(validateInteractionObservation(status).errors).toEqual(["invalid-status"])
    expect(validateInteractionObservation(terminal).errors).toEqual(["invalid-terminal-status"])
  })

  test("rejects non-object, array, and wrong-version records", () => {
    expect(validateInteractionObservation(null)).toEqual({ ok: false, errors: ["not-object"] })
    expect(validateInteractionObservation([])).toEqual({ ok: false, errors: ["not-object"] })
    expect(validateInteractionObservation({ ...createInteractionObservation(), version: 2 }).errors).toEqual([
      "invalid-version",
    ])
  })

  test("summary separates phases and uses fixed labels only", () => {
    const summary = summarizeInteractionObservation(createInteractionObservation())
    expect(summary).toHaveLength(16)
    expect(summary).toContain("phase1.composerVisible=not-tested")
    expect(summary).toContain("phase2.manifestValid=not-tested")
    expect(summary).toContain("ordinaryContinuation=not-tested")
    expect(summary).toContain("terminalRestored=unverified")
    expect(summary.join("\n")).not.toMatch(/ses_|msg_|C:\\|notes=/)
  })
})
