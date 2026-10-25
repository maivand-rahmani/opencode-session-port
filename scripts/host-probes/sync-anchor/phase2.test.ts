import { describe, expect, test } from "bun:test"
import {
  ANCHOR_TITLE,
  INSPECTION_MANIFEST_VERSION,
  parseInspectionManifest,
  validateInspectionGraph,
  type InspectionManifest,
} from "./phase2"

const sessionID = (character: string) => `ses_${character.repeat(64)}`
const messageID = (character: string) => `msg_${character.repeat(64)}`

function manifest(): InspectionManifest {
  return {
    version: INSPECTION_MANIFEST_VERSION,
    anchorID: sessionID("a"),
    childIDs: [sessionID("b"), sessionID("c")],
    anchorMessageIDs: [messageID("1"), messageID("2")],
    childMessageIDs: [
      [messageID("3"), messageID("4")],
      [messageID("5"), messageID("6")],
    ],
    expected: { rootCount: 1, childCount: 2, anchorMessages: 2, childMessages: 2 },
  }
}

function graph(value = manifest()) {
  return {
    anchor: {
      id: value.anchorID,
      parentID: undefined,
      title: ANCHOR_TITLE,
      projectID: "sync-anchor-probe-supplied-project",
    },
    anchorMessageIDs: value.anchorMessageIDs,
    anchorSettled: true,
    directoryMatches: true,
    sessions: [
      { id: value.anchorID, parentID: undefined },
      { id: value.childIDs[0], parentID: value.anchorID },
      { id: value.childIDs[1], parentID: value.anchorID },
    ],
    childMessageIDs: value.childMessageIDs,
    childSettled: [true, true],
  }
}

describe("inspection manifest", () => {
  test("accepts the exact synthetic-ID manifest", () => {
    const parsed = parseInspectionManifest(JSON.stringify(manifest()))
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.manifest.anchorID).toBe(sessionID("a"))
  })

  test("rejects extra free-text or unexpected keys", () => {
    const value = { ...manifest(), notes: "raw text" }
    expect(parseInspectionManifest(JSON.stringify(value))).toEqual({ ok: false, code: "manifest-shape-invalid" })
  })

  test("rejects malformed JSON, wrong versions, missing IDs, and duplicate IDs", () => {
    expect(parseInspectionManifest("{")).toEqual({ ok: false, code: "manifest-json-invalid" })
    expect(parseInspectionManifest(JSON.stringify({ ...manifest(), version: 2 }))).toEqual({
      ok: false,
      code: "manifest-version-invalid",
    })
    const missing = { ...manifest(), childIDs: [sessionID("b")] }
    expect(parseInspectionManifest(JSON.stringify(missing))).toEqual({ ok: false, code: "manifest-child-invalid" })
    const duplicate = manifest()
    duplicate.childMessageIDs[1][0] = duplicate.childMessageIDs[0][0]
    expect(parseInspectionManifest(JSON.stringify(duplicate))).toEqual({ ok: false, code: "manifest-id-duplicate" })
  })

  test("rejects malformed counts and oversized manifests", () => {
    const badCounts = { ...manifest(), expected: { ...manifest().expected, childCount: 3 } }
    expect(parseInspectionManifest(JSON.stringify(badCounts))).toEqual({ ok: false, code: "manifest-counts-invalid" })
    expect(parseInspectionManifest(`{${" ".repeat(5000)}}`)).toEqual({ ok: false, code: "manifest-too-large" })
  })
})

describe("inspection graph", () => {
  test("accepts the exact root and two-child graph", () => {
    expect(validateInspectionGraph(manifest(), graph())).toEqual({ ok: true })
  })

  test("rejects anchor identity, title, project, or directory mismatches", () => {
    const anchorID = { ...graph(), anchor: { ...graph().anchor, id: sessionID("f") } }
    const parent = { ...graph(), anchor: { ...graph().anchor, parentID: sessionID("b") } }
    const title = { ...graph(), anchor: { ...graph().anchor, title: "different" } }
    const project = { ...graph(), anchor: { ...graph().anchor, projectID: "" } }
    const directory = { ...graph(), directoryMatches: false }
    expect(validateInspectionGraph(manifest(), anchorID).ok).toBe(false)
    expect(validateInspectionGraph(manifest(), parent).ok).toBe(false)
    expect(validateInspectionGraph(manifest(), title).ok).toBe(false)
    expect(validateInspectionGraph(manifest(), project).ok).toBe(false)
    expect(validateInspectionGraph(manifest(), directory).ok).toBe(false)
  })

  test("rejects wrong root/child counts, unknown child IDs, and wrong depth", () => {
    const rootCount = { ...graph(), sessions: [{ id: manifest().anchorID }] }
    const extraRoot = { ...graph(), sessions: [...graph().sessions, { id: sessionID("f") }] }
    const wrongChild = { ...graph(), sessions: [{ id: manifest().anchorID }, { id: sessionID("f"), parentID: manifest().anchorID }] }
    const wrongDepth = { ...graph(), sessions: graph().sessions.map((session, index) => index === 1 ? { ...session, parentID: undefined } : session) }
    expect(validateInspectionGraph(manifest(), rootCount).ok).toBe(false)
    expect(validateInspectionGraph(manifest(), extraRoot).ok).toBe(false)
    expect(validateInspectionGraph(manifest(), wrongChild).ok).toBe(false)
    expect(validateInspectionGraph(manifest(), wrongDepth).ok).toBe(false)
  })

  test("rejects wrong message order and unsettled messages", () => {
    const reordered = graph()
    reordered.anchorMessageIDs = [...reordered.anchorMessageIDs].reverse()
    const unsettled = { ...graph(), childSettled: [true, false] }
    const wrongChildMessages = graph()
    wrongChildMessages.childMessageIDs = [wrongChildMessages.childMessageIDs[0], [...wrongChildMessages.childMessageIDs[1]].reverse()]
    expect(validateInspectionGraph(manifest(), reordered).ok).toBe(false)
    expect(validateInspectionGraph(manifest(), unsettled).ok).toBe(false)
    expect(validateInspectionGraph(manifest(), wrongChildMessages).ok).toBe(false)
  })
})

describe("inspection phase boundary", () => {
  test("inspection branch contains no import or mutation calls", async () => {
    const plugin = await Bun.file(new URL("./sync-anchor.tui.tsx", import.meta.url)).text()
    const start = plugin.indexOf("async function runInspection")
    const end = plugin.indexOf("async function runProbe", start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const body = plugin.slice(start, end)
    expect(body).not.toContain("session.import")
    expect(body).not.toContain("session.update")
    expect(body).not.toContain("session.delete")
    expect(plugin).toContain('process.env.SP_PROBE_PHASE === "inspect"')
  })
})
