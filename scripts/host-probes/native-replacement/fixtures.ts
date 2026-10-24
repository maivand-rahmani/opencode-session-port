export const NATIVE_REPLACEMENT_VERSION = 1 as const
export const OLD_ROOT_TITLE = "synthetic native-replacement old root"
export const CANDIDATE_TITLE = "synthetic native-replacement parentless candidate"
export const SYNTHETIC_TAIL_TEXT = "synthetic native-replacement distinct tail"
export const OLD_MESSAGE_TEXT = [
  "synthetic native-replacement old user",
  "synthetic native-replacement old assistant",
] as const
export const CANDIDATE_MESSAGE_TEXT = [
  "synthetic native-replacement candidate user",
  "synthetic native-replacement candidate assistant",
] as const

const SESSION_ID = /^ses_[0-9a-f]{64}$/
const MESSAGE_ID = /^msg_[0-9a-f]{64}$/

export type SyntheticMessage = {
  id: string
  type: "user" | "assistant"
  text?: string
  agent?: string
  model?: { id: string; providerID: string }
  time: { created: number; completed?: number }
  content?: readonly { type: "text"; text: string }[]
}

export type NativeFixture = {
  version: typeof NATIVE_REPLACEMENT_VERSION
  directory: string
  projectID: string
  oldRootID: string
  candidateID: string
  oldMessages: readonly SyntheticMessage[]
  candidateMessages: readonly SyntheticMessage[]
}

export type FixtureIDs = {
  oldRootID: string
  candidateID: string
  oldMessageIDs: readonly [string, string]
  candidateMessageIDs: readonly [string, string, string]
}

export type NativeImportPayload = {
  info: {
    id: string
    projectID: string
    cost: 0
    tokens: {
      input: 0
      output: 0
      reasoning: 0
      cache: { read: 0; write: 0 }
    }
    time: { created: number; updated: number; idle: number }
    title: string
    location: { directory: string }
  }
  messages: SyntheticMessage[]
  location: { directory: string }
}

export function createSyntheticFixture(input: {
  directory: string
  projectID: string
  ids: FixtureIDs
  now?: number
}): NativeFixture {
  const now = input.now ?? 1_700_000_000_000
  const { ids } = input

  return {
    version: NATIVE_REPLACEMENT_VERSION,
    directory: input.directory,
    projectID: input.projectID,
    oldRootID: ids.oldRootID,
    candidateID: ids.candidateID,
    oldMessages: [
      {
        id: ids.oldMessageIDs[0],
        time: { created: now - 4000 },
        type: "user",
        text: OLD_MESSAGE_TEXT[0],
      },
      {
        id: ids.oldMessageIDs[1],
        time: { created: now - 3500, completed: now - 3000 },
        type: "assistant",
        agent: "probe",
        model: { id: "probe-model", providerID: "probe-provider" },
        content: [{ type: "text", text: OLD_MESSAGE_TEXT[1] }],
      },
    ],
    candidateMessages: [
      {
        id: ids.candidateMessageIDs[0],
        time: { created: now - 2000 },
        type: "user",
        text: CANDIDATE_MESSAGE_TEXT[0],
      },
      {
        id: ids.candidateMessageIDs[1],
        time: { created: now - 1500, completed: now - 1000 },
        type: "assistant",
        agent: "probe",
        model: { id: "probe-model", providerID: "probe-provider" },
        content: [{ type: "text", text: CANDIDATE_MESSAGE_TEXT[1] }],
      },
      {
        id: ids.candidateMessageIDs[2],
        time: { created: now - 500 },
        type: "user",
        text: SYNTHETIC_TAIL_TEXT,
      },
    ],
  }
}

export function validateFixture(value: unknown): string[] {
  const errors: string[] = []
  if (!isRecord(value)) return ["fixture-not-object"]

  if (
    !hasExactKeys(value, [
      "version",
      "directory",
      "projectID",
      "oldRootID",
      "candidateID",
      "oldMessages",
      "candidateMessages",
    ])
  ) {
    errors.push("fixture-shape-invalid")
  }
  if (value.version !== NATIVE_REPLACEMENT_VERSION) errors.push("fixture-version-invalid")

  const oldRootID = value.oldRootID
  const candidateID = value.candidateID
  if (!isSessionID(oldRootID)) errors.push("old-root-id-invalid")
  if (!isSessionID(candidateID)) errors.push("candidate-id-invalid")
  if (typeof oldRootID === "string" && oldRootID === candidateID) errors.push("root-id-duplicate")
  if (typeof value.directory !== "string" || value.directory.length === 0) errors.push("directory-missing")
  if (typeof value.projectID !== "string" || value.projectID.length === 0) errors.push("project-id-missing")

  const oldMessages = value.oldMessages
  const candidateMessages = value.candidateMessages
  if (!Array.isArray(oldMessages) || oldMessages.length !== 2) errors.push("old-message-count-invalid")
  if (!Array.isArray(candidateMessages) || candidateMessages.length !== 3) {
    errors.push("candidate-message-count-invalid")
  }

  if (Array.isArray(oldMessages) && oldMessages.length === 2) {
    validateMessage(oldMessages[0], "user", OLD_MESSAGE_TEXT[0], errors)
    validateMessage(oldMessages[1], "assistant", OLD_MESSAGE_TEXT[1], errors)
  }
  if (Array.isArray(candidateMessages) && candidateMessages.length === 3) {
    validateMessage(candidateMessages[0], "user", CANDIDATE_MESSAGE_TEXT[0], errors)
    validateMessage(candidateMessages[1], "assistant", CANDIDATE_MESSAGE_TEXT[1], errors)
    validateMessage(candidateMessages[2], "user", SYNTHETIC_TAIL_TEXT, errors)
  }

  const allIDs: string[] = []
  if (typeof oldRootID === "string") allIDs.push(oldRootID)
  if (typeof candidateID === "string") allIDs.push(candidateID)
  for (const collection of [oldMessages, candidateMessages]) {
    if (!Array.isArray(collection)) continue
    for (const message of collection) {
      if (isRecord(message) && typeof message.id === "string") allIDs.push(message.id)
    }
  }
  if (new Set(allIDs).size !== allIDs.length) errors.push("fixture-id-duplicate")

  if (
    Array.isArray(candidateMessages) &&
    candidateMessages.length === 3 &&
    isRecord(candidateMessages[2]) &&
    candidateMessages[2].text !== SYNTHETIC_TAIL_TEXT
  ) {
    errors.push("tail-invalid")
  }
  if (
    Array.isArray(candidateMessages) &&
    candidateMessages.length === 3 &&
    isRecord(candidateMessages[2]) &&
    isRecord(candidateMessages[0]) &&
    candidateMessages[2].text === candidateMessages[0].text
  ) {
    errors.push("tail-not-distinct")
  }

  return [...new Set(errors)]
}

function validateMessage(
  value: unknown,
  expectedType: "user" | "assistant",
  expectedText: string,
  errors: string[],
): void {
  if (!isRecord(value)) {
    errors.push("message-shape-invalid")
    return
  }
  const keys =
    expectedType === "user"
      ? ["id", "type", "text", "time"]
      : ["id", "type", "time", "agent", "model", "content"]
  if (!hasExactKeys(value, keys)) errors.push("message-shape-invalid")
  if (!isMessageID(value.id)) errors.push("message-id-invalid")
  if (value.type !== expectedType) errors.push("message-type-invalid")

  const time = value.time
  const timeKeys = expectedType === "user" ? ["created"] : ["created", "completed"]
  if (!isRecord(time) || !hasExactKeys(time, timeKeys)) {
    errors.push("message-time-invalid")
  } else if (
    typeof time.created !== "number" ||
    !Number.isFinite(time.created) ||
    (expectedType === "assistant" &&
      (typeof time.completed !== "number" || !Number.isFinite(time.completed)))
  ) {
    errors.push("message-time-invalid")
  }

  if (expectedType === "user") {
    if (value.text !== expectedText) errors.push("message-content-invalid")
    return
  }

  if (value.agent !== "probe") errors.push("message-agent-invalid")
  const model = value.model
  if (
    !isRecord(model) ||
    !hasExactKeys(model, ["id", "providerID"]) ||
    model.id !== "probe-model" ||
    model.providerID !== "probe-provider"
  ) {
    errors.push("message-model-invalid")
  }
  const content = value.content
  if (!Array.isArray(content) || content.length !== 1) {
    errors.push("message-content-invalid")
    return
  }
  const part = content[0]
  if (
    !isRecord(part) ||
    !hasExactKeys(part, ["type", "text"]) ||
    part.type !== "text" ||
    part.text !== expectedText
  ) {
    errors.push("message-content-invalid")
  }
}

export function buildImportPayload(fixture: NativeFixture): NativeImportPayload {
  const errors = validateFixture(fixture)
  if (errors.length > 0) throw new Error("fixture-invalid")

  const times = fixture.candidateMessages.map((message) => message.time.created)
  const updated = Math.max(...times)
  const created = Math.min(...times) - 1000

  return {
    info: {
      id: fixture.candidateID,
      projectID: fixture.projectID,
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created, updated, idle: updated },
      title: CANDIDATE_TITLE,
      location: { directory: fixture.directory },
    },
    messages: fixture.candidateMessages.map(toImportMessage),
    location: { directory: fixture.directory },
  }
}

function toImportMessage(message: SyntheticMessage): SyntheticMessage {
  if (message.type === "user") {
    return {
      id: message.id,
      type: "user",
      text: message.text!,
      time: { created: message.time.created },
    }
  }
  return {
    id: message.id,
    type: "assistant",
    agent: "probe",
    model: { id: "probe-model", providerID: "probe-provider" },
    time: { created: message.time.created, completed: message.time.completed! },
    content: [{ type: "text", text: message.content![0]!.text }],
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
