import { sameOrderedIDs } from "./route-guard"

export const INSPECTION_MANIFEST_VERSION = 1
export const ANCHOR_TITLE = "synthetic sync-anchor root"
export const CHILD_TITLES = ["synthetic sync-anchor child 1", "synthetic sync-anchor child 2"] as const
export const INSPECTION_MANIFEST_LIMIT_BYTES = 4096

const SESSION_ID = /^ses_[0-9a-f]{64}$/
const MESSAGE_ID = /^msg_[0-9a-f]{64}$/
const MANIFEST_KEYS = ["version", "anchorID", "childIDs", "anchorMessageIDs", "childMessageIDs", "expected"]
const EXPECTED_KEYS = ["rootCount", "childCount", "anchorMessages", "childMessages"]

export type InspectionManifest = {
  version: typeof INSPECTION_MANIFEST_VERSION
  anchorID: string
  childIDs: [string, string]
  anchorMessageIDs: [string, string]
  childMessageIDs: [[string, string], [string, string]]
  expected: { rootCount: 1; childCount: 2; anchorMessages: 2; childMessages: 2 }
}

export type InspectionGraphInput = {
  anchor: {
    id?: unknown
    parentID?: unknown
    title?: unknown
    projectID?: unknown
  }
  anchorMessageIDs: readonly string[]
  anchorSettled: boolean
  directoryMatches: boolean
  sessions: readonly { id?: unknown; parentID?: unknown }[]
  childMessageIDs: readonly (readonly string[])[]
  childSettled: readonly boolean[]
}

export type ManifestParseResult =
  | { ok: true; manifest: InspectionManifest }
  | { ok: false; code: string }

export type GraphCheckResult = { ok: true } | { ok: false; code: string }

export function parseInspectionManifest(text: string): ManifestParseResult {
  if (new TextEncoder().encode(text).byteLength > INSPECTION_MANIFEST_LIMIT_BYTES) {
    return { ok: false, code: "manifest-too-large" }
  }

  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return { ok: false, code: "manifest-json-invalid" }
  }
  if (!isRecord(value)) return { ok: false, code: "manifest-shape-invalid" }
  if (!hasExactKeys(value, MANIFEST_KEYS)) return { ok: false, code: "manifest-shape-invalid" }
  if (value.version !== INSPECTION_MANIFEST_VERSION) return { ok: false, code: "manifest-version-invalid" }

  const anchorID = value.anchorID
  const childIDs = value.childIDs
  const anchorMessageIDs = value.anchorMessageIDs
  const childMessageIDs = value.childMessageIDs
  const expected = value.expected

  if (!isSessionID(anchorID)) return { ok: false, code: "manifest-anchor-invalid" }
  if (!isSessionIDArray(childIDs, 2) || new Set(childIDs).size !== 2) {
    return { ok: false, code: "manifest-child-invalid" }
  }
  if (!isMessageIDArray(anchorMessageIDs, 2) || new Set(anchorMessageIDs).size !== 2) {
    return { ok: false, code: "manifest-message-invalid" }
  }
  if (
    !Array.isArray(childMessageIDs) ||
    childMessageIDs.length !== 2 ||
    childMessageIDs.some((item) => !isMessageIDArray(item, 2) || new Set(item).size !== 2)
  ) {
    return { ok: false, code: "manifest-message-invalid" }
  }
  if (!isExpectedCounts(expected)) return { ok: false, code: "manifest-counts-invalid" }

  const allIDs = [anchorID, ...childIDs, ...anchorMessageIDs, ...childMessageIDs.flat()]
  if (new Set(allIDs).size !== allIDs.length) return { ok: false, code: "manifest-id-duplicate" }

  return {
    ok: true,
    manifest: {
      version: INSPECTION_MANIFEST_VERSION,
      anchorID,
      childIDs: [childIDs[0], childIDs[1]],
      anchorMessageIDs: [anchorMessageIDs[0], anchorMessageIDs[1]],
      childMessageIDs: [
        [childMessageIDs[0][0], childMessageIDs[0][1]],
        [childMessageIDs[1][0], childMessageIDs[1][1]],
      ],
      expected: { rootCount: 1, childCount: 2, anchorMessages: 2, childMessages: 2 },
    },
  }
}

export function validateInspectionGraph(
  manifest: InspectionManifest,
  input: InspectionGraphInput,
): GraphCheckResult {
  if (
    input.anchor.id !== manifest.anchorID ||
    (input.anchor.parentID !== undefined && input.anchor.parentID !== null) ||
    input.anchor.title !== ANCHOR_TITLE ||
    typeof input.anchor.projectID !== "string" ||
    input.anchor.projectID.length === 0 ||
    !input.directoryMatches
  ) {
    return { ok: false, code: "readback-anchor-mismatch" }
  }

  if (
    !sameOrderedIDs(input.anchorMessageIDs, manifest.anchorMessageIDs) ||
    !input.anchorSettled
  ) {
    return { ok: false, code: "readback-anchor-messages-mismatch" }
  }

  const roots = input.sessions.filter((session) => !session.parentID)
  const children = input.sessions.filter((session) => session.parentID === manifest.anchorID)
  if (roots.length !== manifest.expected.rootCount || children.length !== manifest.expected.childCount) {
    return { ok: false, code: "readback-count-mismatch" }
  }
  if (!manifest.childIDs.every((id) => children.some((child) => child.id === id))) {
    return { ok: false, code: "readback-child-mismatch" }
  }
  if (input.childMessageIDs.length !== 2 || input.childSettled.length !== 2) {
    return { ok: false, code: "readback-child-messages-mismatch" }
  }
  for (let index = 0; index < 2; index++) {
    if (
      !sameOrderedIDs(input.childMessageIDs[index], manifest.childMessageIDs[index]) ||
      !input.childSettled[index]
    ) {
      return { ok: false, code: "readback-child-messages-mismatch" }
    }
  }

  return { ok: true }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
}

function isSessionID(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID.test(value)
}

function isMessageID(value: unknown): value is string {
  return typeof value === "string" && MESSAGE_ID.test(value)
}

function isSessionIDArray(value: unknown, length: number): value is string[] {
  return Array.isArray(value) && value.length === length && value.every(isSessionID)
}

function isMessageIDArray(value: unknown, length: number): value is string[] {
  return Array.isArray(value) && value.length === length && value.every(isMessageID)
}

function isExpectedCounts(value: unknown): value is InspectionManifest["expected"] {
  if (!isRecord(value) || !hasExactKeys(value, EXPECTED_KEYS)) return false
  return (
    value.rootCount === 1 &&
    value.childCount === 2 &&
    value.anchorMessages === 2 &&
    value.childMessages === 2
  )
}
