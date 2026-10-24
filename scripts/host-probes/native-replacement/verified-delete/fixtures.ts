import type { CheckpointPayload } from "../../../../src/core/contracts/session.ts"
import type { ProbeImportPayload, ProbeMessage, ProbeSession } from "./contract.ts"

export const VERIFIED_DELETE_VERSION = 1 as const
export const OLD_ROOT_TITLE = "synthetic verified-delete old root"
export const CANDIDATE_TITLE = "synthetic verified-delete candidate root"
export const OLD_MESSAGE_TEXT = [
  "synthetic verified-delete old user",
  "synthetic verified-delete old assistant",
] as const
export const SYNTHETIC_TAIL_TEXT = "synthetic verified-delete distinct tail"
export const EXPECTED_COUNTS = { oldMessages: 2, candidateMessages: 3 } as const

const SESSION_ID = /^ses_[0-9a-f]{64}$/
const MESSAGE_ID = /^msg_[0-9a-f]{64}$/
const SESSION_KEYS = ["id", "title", "projectID", "directory", "time"] as const
const MESSAGE_KEYS = ["id", "type", "text", "time"] as const

export type FlatSession = {
  id: string
  title: string
  projectID: string
  directory: string
  time: { created: number; updated: number }
}

export type FlatMessage = {
  id: string
  type: "user" | "assistant"
  text: string
  time: { created: number; completed?: number }
}

export type FlatRoot = { session: FlatSession; messages: readonly FlatMessage[] }

export type VerifiedDeleteFixture = {
  version: typeof VERIFIED_DELETE_VERSION
  projectID: string
  directory: string
  oldRoot: FlatRoot
  candidateRoot: FlatRoot
  expected: typeof EXPECTED_COUNTS
}

export type FixtureIDs = {
  oldSessionID: string
  candidateSessionID: string
  oldMessageIDs: readonly [string, string]
  candidateMessageIDs: readonly [string, string, string]
}

/**
 * The candidate is the complete old ordered history prefix with fresh global
 * message IDs plus one distinct tail. Prefix text, role, and timestamps are
 * copied exactly from the old root.
 */
export function createVerifiedDeleteFixture(input: {
  directory: string
  projectID: string
  ids: FixtureIDs
  now?: number
}): VerifiedDeleteFixture {
  const now = input.now ?? 1_700_000_000_000
  const ids = input.ids
  const oldMessages: FlatMessage[] = [
    { id: ids.oldMessageIDs[0], type: "user", text: OLD_MESSAGE_TEXT[0], time: { created: now - 4000 } },
    {
      id: ids.oldMessageIDs[1],
      type: "assistant",
      text: OLD_MESSAGE_TEXT[1],
      time: { created: now - 3500, completed: now - 3000 },
    },
  ]

  return {
    version: VERIFIED_DELETE_VERSION,
    projectID: input.projectID,
    directory: input.directory,
    oldRoot: {
      session: {
        id: ids.oldSessionID,
        title: OLD_ROOT_TITLE,
        projectID: input.projectID,
        directory: input.directory,
        time: { created: now - 10_000, updated: now - 3000 },
      },
      messages: oldMessages,
    },
    candidateRoot: {
      session: {
        id: ids.candidateSessionID,
        title: CANDIDATE_TITLE,
        projectID: input.projectID,
        directory: input.directory,
        time: { created: now - 2000, updated: now - 1000 },
      },
      messages: [
        { ...oldMessages[0]!, id: ids.candidateMessageIDs[0], time: { ...oldMessages[0]!.time } },
        { ...oldMessages[1]!, id: ids.candidateMessageIDs[1], time: { ...oldMessages[1]!.time } },
        {
          id: ids.candidateMessageIDs[2],
          type: "user",
          text: SYNTHETIC_TAIL_TEXT,
          time: { created: now - 500 },
        },
      ],
    },
    expected: EXPECTED_COUNTS,
  }
}

export function validateFixture(value: unknown): string[] {
  if (!isRecord(value)) return ["fixture-not-object"]
  const errors: string[] = []
  if (
    !hasExactKeys(value, ["version", "projectID", "directory", "oldRoot", "candidateRoot", "expected"]) ||
    value.version !== VERIFIED_DELETE_VERSION
  ) {
    errors.push("fixture-shape-invalid")
  }
  if (typeof value.projectID !== "string" || value.projectID.length === 0) errors.push("project-id-invalid")
  if (typeof value.directory !== "string" || value.directory.length === 0) errors.push("directory-invalid")

  const oldRoot = value.oldRoot
  const candidateRoot = value.candidateRoot
  if (!isRecord(oldRoot) || !isRecord(candidateRoot)) return [...errors, "fixture-root-invalid"]
  if (!validateRoot(oldRoot, OLD_ROOT_TITLE, value, errors)) return [...new Set(errors)]
  if (!validateRoot(candidateRoot, CANDIDATE_TITLE, value, errors)) return [...new Set(errors)]

  const oldMessages = oldRoot.messages as FlatMessage[]
  const candidateMessages = candidateRoot.messages as FlatMessage[]
  if (candidateMessages.length !== EXPECTED_COUNTS.candidateMessages) errors.push("candidate-count-invalid")
  if (candidateMessages.length === EXPECTED_COUNTS.candidateMessages) {
    for (const index of [0, 1] as const) {
      const old = oldMessages[index]!
      const candidate = candidateMessages[index]!
      if (
        candidate.type !== old.type ||
        candidate.text !== old.text ||
        candidate.time.created !== old.time.created ||
        candidate.time.completed !== old.time.completed
      ) {
        errors.push("candidate-prefix-mismatch")
      }
    }
    const tail = candidateMessages[2]!
    if (tail.type !== "user" || tail.text !== SYNTHETIC_TAIL_TEXT) errors.push("tail-invalid")
    if (OLD_MESSAGE_TEXT.includes(tail.text as (typeof OLD_MESSAGE_TEXT)[number])) errors.push("tail-not-distinct")
  }

  const expected = value.expected
  if (
    !isRecord(expected) ||
    !hasExactKeys(expected, ["oldMessages", "candidateMessages"]) ||
    expected.oldMessages !== EXPECTED_COUNTS.oldMessages ||
    expected.candidateMessages !== EXPECTED_COUNTS.candidateMessages
  ) {
    errors.push("expected-counts-invalid")
  }

  const allIDs = [
    (oldRoot.session as FlatSession).id,
    (candidateRoot.session as FlatSession).id,
    ...oldMessages.map((message) => message.id),
    ...candidateMessages.map((message) => message.id),
  ]
  if (new Set(allIDs).size !== allIDs.length) errors.push("fixture-id-duplicate")
  return [...new Set(errors)]
}

function validateRoot(
  root: Record<string, unknown>,
  title: string,
  fixture: Record<string, unknown>,
  errors: string[],
): boolean {
  if (!hasExactKeys(root, ["session", "messages"]) || !isRecord(root.session) || !Array.isArray(root.messages)) {
    errors.push("fixture-root-invalid")
    return false
  }
  const session = root.session
  if (!hasExactKeys(session, [...SESSION_KEYS])) errors.push("session-shape-invalid")
  if (!isSessionID(session.id)) errors.push("session-id-invalid")
  if (session.title !== title) errors.push("session-title-invalid")
  if (session.projectID !== fixture.projectID) errors.push("session-project-invalid")
  if (session.directory !== fixture.directory) errors.push("session-directory-invalid")
  if (!isRecord(session.time) || !hasExactKeys(session.time, ["created", "updated"])) {
    errors.push("session-time-invalid")
  } else if (!isFiniteNumber(session.time.created) || !isFiniteNumber(session.time.updated)) {
    errors.push("session-time-invalid")
  }

  const count = root === fixture.oldRoot ? EXPECTED_COUNTS.oldMessages : EXPECTED_COUNTS.candidateMessages
  if (root.messages.length !== count) errors.push("message-count-invalid")
  for (const [index, message] of root.messages.entries()) {
    const expectedType = index === 1 ? "assistant" : "user"
    if (!isRecord(message) || !hasExactKeys(message, [...MESSAGE_KEYS])) {
      errors.push("message-shape-invalid")
      continue
    }
    if (!isMessageID(message.id)) errors.push("message-id-invalid")
    if (message.type !== expectedType) errors.push("message-type-invalid")
    if (typeof message.text !== "string" || message.text.length === 0) errors.push("message-text-invalid")
    const timeKeys = expectedType === "assistant" ? ["created", "completed"] : ["created"]
    if (!isRecord(message.time) || !hasExactKeys(message.time, timeKeys)) {
      errors.push("message-time-invalid")
      continue
    }
    if (!isFiniteNumber(message.time.created)) errors.push("message-time-invalid")
    if (expectedType === "assistant" && !isFiniteNumber(message.time.completed)) {
      errors.push("message-time-invalid")
    }
  }
  return errors.length === 0
}

export function buildImportPayload(fixture: VerifiedDeleteFixture): ProbeImportPayload {
  if (validateFixture(fixture).length > 0) throw new Error("fixture-invalid")
  return {
    info: {
      id: fixture.candidateRoot.session.id,
      title: fixture.candidateRoot.session.title,
      projectID: fixture.projectID,
      directory: fixture.directory,
      time: { ...fixture.candidateRoot.session.time },
    },
    messages: fixture.candidateRoot.messages.map(toNativeMessage),
  }
}

/** Probe-local normalized JSON, not a claim about the host's native message shape. */
export function toCheckpointPayload(root: FlatRoot): CheckpointPayload {
  return {
    sessions: [
      {
        info: {
          id: root.session.id,
          title: root.session.title,
          projectID: root.session.projectID,
          directory: root.session.directory,
          time: { created: root.session.time.created, updated: root.session.time.updated },
        },
        messages: root.messages.map((message) => {
          const time: Record<string, number> = { created: message.time.created }
          if (message.time.completed !== undefined) time.completed = message.time.completed
          return { id: message.id, type: message.type, text: message.text, time }
        }),
      },
    ],
  }
}

export function toNativeMessage(message: FlatMessage): ProbeMessage {
  return {
    id: message.id,
    type: message.type,
    text: message.text,
    time:
      message.time.completed === undefined
        ? { created: message.time.created }
        : { created: message.time.created, completed: message.time.completed },
  }
}

export function toNativeSession(root: FlatRoot): ProbeSession {
  return {
    id: root.session.id,
    title: root.session.title,
    projectID: root.session.projectID,
    directory: root.session.directory,
    time: { ...root.session.time },
  }
}

export function isSessionID(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID.test(value)
}

export function isMessageID(value: unknown): value is string {
  return typeof value === "string" && MESSAGE_ID.test(value)
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}
