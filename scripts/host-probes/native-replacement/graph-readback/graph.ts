// Pure synthetic graph fixture, projection, and reference-closure checks.
// No host, network, filesystem, model, or tool execution happens in this module.

import { createHash, randomBytes } from "node:crypto"
import { LifecycleError } from "../lifecycle/runner.mjs"
import type { GraphFeatures } from "./schema.ts"
import { isRecord } from "./schema.ts"

export const GRAPH_PROJECT_HINT = "m1-graph-readback-probe"
const CANONICAL_PROJECT_ID = /^[A-Za-z0-9._:-]{1,128}$/
const SESSION_ID = /^ses_[0-9a-f]{64}$/
const MESSAGE_ID = /^msg_[0-9a-f]{64}$/

export type JsonRecord = Record<string, unknown>
export type ForkRef = { sessionID: string; boundary: { type: "before" | "through"; messageID: string } }
export type RevertRef = { messageID: string }
export type ToolPart = {
  type: "tool"
  id: string
  name: string
  state:
    | { status: "completed"; input: JsonRecord; content: Array<{ type: "text"; text: string }> }
    | {
        status: "error"
        input: JsonRecord
        error: { type: string; message: string }
      }
  time: { created: number; ran: number; completed: number }
}
export type Part = { type: "text"; text: string } | ToolPart
export type Message =
  | { id: string; type: "user"; text: string; time: { created: number } }
  | {
      id: string
      type: "assistant"
      agent: string
      model: { id: string; providerID: string }
      content: Part[]
      time: { created: number; completed: number }
    }

export type SessionKey = "root" | "child" | "grandchild" | "fork"
export type SessionSpec = {
  key: SessionKey
  id: string
  title: string
  parentID: string | null
  fork: ForkRef | null
  revert: RevertRef | null
  created: number
  messages: Message[]
}

export type FrozenFixture = {
  projectHint: string
  directory: string
  sentinelPath: string
  features: GraphFeatures
  sessions: SessionSpec[]
}

export type ObservedSession = {
  id: string
  parentID: string | null
  fork: ForkRef | null
  revert: RevertRef | null
  projectID: string
  importedProject: string
  title: string
  created: number
  updated: number
  directory: string
  window: { started: number; finished: number }
}

export type Observation = {
  sessions: ObservedSession[]
  messages: Record<string, Message[]>
}

export type VerifyResult = {
  verified: boolean
  failure: string | null
  unsupported: string[]
  components: {
    parentChain: boolean
    fork: boolean
    revert: boolean
    toolCompleted: boolean
    toolError: boolean
    payloadHashes: boolean
    project: boolean
    time: boolean
    location: boolean
  }
  refs: {
    parentRefs: number
    forkRefs: number
    revertRefs: number
    known: boolean
    dangling: number
    unknown: number
    duplicateSessions: number
    duplicateMessages: number
  }
}

export type FixtureIDs = {
  root: string
  child: string
  grandchild: string
  fork: string
  rootMessages: [string, string]
  childMessages: [string, string]
  grandchildMessages: [string, string]
  forkMessages: [string, string]
  toolParts: [string, string]
}

function fail(code: string): never {
  throw new LifecycleError(code)
}

export function generateFixtureIDs(random: (size: number) => Buffer = randomBytes): FixtureIDs {
  const hex = () => random(32).toString("hex")
  const part = () => `prt_${random(16).toString("hex")}`
  const ids: FixtureIDs = {
    root: `ses_${hex()}`,
    child: `ses_${hex()}`,
    grandchild: `ses_${hex()}`,
    fork: `ses_${hex()}`,
    rootMessages: [`msg_${hex()}`, `msg_${hex()}`],
    childMessages: [`msg_${hex()}`, `msg_${hex()}`],
    grandchildMessages: [`msg_${hex()}`, `msg_${hex()}`],
    forkMessages: [`msg_${hex()}`, `msg_${hex()}`],
    toolParts: [part(), part()],
  }
  const sessions = [ids.root, ids.child, ids.grandchild, ids.fork]
  const messages = [
    ...ids.rootMessages,
    ...ids.childMessages,
    ...ids.grandchildMessages,
    ...ids.forkMessages,
  ]
  if (
    !sessions.every((id) => SESSION_ID.test(id)) ||
    !messages.every((id) => MESSAGE_ID.test(id)) ||
    new Set([...sessions, ...messages, ...ids.toolParts]).size !== sessions.length + messages.length + 2
  ) {
    fail("E_CONFIG")
  }
  return ids
}

function toolPart(
  id: string,
  status: "completed" | "error",
  created: number,
  sentinelPath: string,
): ToolPart {
  const input = {
    command: status === "completed" ? `touch ${sentinelPath}` : `touch ${sentinelPath} && exit 1`,
    sentinelPath,
  }
  if (status === "completed") {
    return {
      type: "tool",
      id,
      name: "probe_no_replay",
      state: {
        status,
        input,
        content: [{ type: "text", text: "synthetic completed tool output" }],
      },
      time: { created, ran: created + 10, completed: created + 20 },
    }
  }
  return {
    type: "tool",
    id,
    name: "probe_no_replay",
    state: {
      status,
      input,
      error: { type: "probe_error", message: "synthetic tool error" },
    },
    time: { created, ran: created + 10, completed: created + 20 },
  }
}

export function buildFrozenFixture(input: {
  ids: FixtureIDs
  directory: string
  features: GraphFeatures
  now?: number
  sentinelPath?: string
}): FrozenFixture {
  const now = input.now ?? Date.now()
  const sentinelPath = input.sentinelPath ?? `${input.directory}/.graph-readback-sentinel`
  if (typeof input.directory !== "string" || input.directory.length === 0) fail("E_CONFIG")
  if (!sentinelPath.startsWith(`${input.directory}/`)) fail("E_CONFIG")

  const text = (value: string) => ({ type: "text" as const, text: value })
  const assistant = (
    id: string,
    created: number,
    content: Part[],
  ): Message => ({
    id,
    type: "assistant",
    agent: "probe",
    model: { id: "probe-model", providerID: "probe-provider" },
    content,
    time: { created, completed: created + 400 },
  })

  const rootUser = `msg_${input.ids.rootMessages[0].slice(4)}`
  let rootContent: Part[] = [text("synthetic graph root assistant")]
  if (input.features.toolCompleted && input.features.toolTextContent) {
    rootContent = [
      ...rootContent,
      toolPart(input.ids.toolParts[0], "completed", now - 7200, sentinelPath),
    ]
  }
  let childContent: Part[] = [text("synthetic graph child assistant")]
  if (input.features.toolError) {
    childContent = [
      ...childContent,
      toolPart(input.ids.toolParts[1], "error", now - 5200, sentinelPath),
    ]
  }
  const rootAssistant = input.ids.rootMessages[1]

  const sessions: SessionSpec[] = [
    {
      key: "root",
      id: input.ids.root,
      title: "synthetic graph root",
      parentID: null,
      fork: null,
      revert: null,
      created: now - 9000,
      messages: [
        { id: rootUser, type: "user", text: "synthetic graph root user", time: { created: now - 8000 } },
        assistant(rootAssistant, now - 7000, rootContent),
      ],
    },
    {
      key: "child",
      id: input.ids.child,
      title: "synthetic graph child",
      parentID: input.ids.root,
      fork: null,
      revert: null,
      created: now - 6500,
      messages: [
        { id: input.ids.childMessages[0], type: "user", text: "synthetic graph child user", time: { created: now - 6000 } },
        assistant(input.ids.childMessages[1], now - 5000, childContent),
      ],
    },
    {
      key: "grandchild",
      id: input.ids.grandchild,
      title: "synthetic graph grandchild",
      parentID: input.ids.child,
      fork: null,
      revert: input.features.revert ? { messageID: input.ids.grandchildMessages[0] } : null,
      created: now - 4500,
      messages: [
        { id: input.ids.grandchildMessages[0], type: "user", text: "synthetic graph grandchild user", time: { created: now - 4000 } },
        assistant(input.ids.grandchildMessages[1], now - 3000, [text("synthetic graph grandchild assistant")]),
      ],
    },
  ]

  if (input.features.fork) {
    sessions.push({
      key: "fork",
      id: input.ids.fork,
      title: "synthetic graph fork",
      parentID: null,
      fork: {
        sessionID: input.ids.root,
        boundary: { type: "through", messageID: rootAssistant },
      },
      revert: null,
      created: now - 2500,
      messages: [
        { id: input.ids.forkMessages[0], type: "user", text: "synthetic graph fork user", time: { created: now - 2000 } },
        assistant(input.ids.forkMessages[1], now - 1000, [text("synthetic graph fork assistant")]),
      ],
    })
  }

  const allSessions = new Set(sessions.map((session) => session.id))
  const allMessages = new Set(sessions.flatMap((session) => session.messages.map((message) => message.id)))
  if (allSessions.size !== sessions.length || allMessages.size !== sessions.reduce((sum, session) => sum + session.messages.length, 0)) {
    fail("E_FIXTURE")
  }
  return { projectHint: GRAPH_PROJECT_HINT, directory: input.directory, sentinelPath, features: input.features, sessions }
}

export function nativeSessionInfo(spec: SessionSpec, fixture: FrozenFixture): JsonRecord {
  return {
    id: spec.id,
    ...(spec.parentID === null ? {} : { parentID: spec.parentID }),
    ...(spec.fork === null ? {} : { fork: spec.fork }),
    projectID: fixture.projectHint,
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: spec.created, updated: Math.max(...spec.messages.map((message) => message.time.created)) },
    title: spec.title,
    ...(spec.revert === null ? {} : { revert: spec.revert }),
    location: { directory: fixture.directory },
  }
}

export function nativeImportBody(spec: SessionSpec, fixture: FrozenFixture): JsonRecord {
  return {
    info: nativeSessionInfo(spec, fixture),
    messages: spec.messages.map((message) => {
      if (message.type === "user") {
        return { id: message.id, type: "user", text: message.text, time: { created: message.time.created } }
      }
      return {
        id: message.id,
        type: "assistant",
        agent: message.agent,
        model: message.model,
        time: { created: message.time.created, completed: message.time.completed },
        content: message.content,
      }
    }),
    location: { directory: fixture.directory },
  }
}

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
  }
  return JSON.stringify(value) ?? "null"
}

export function sameJson(left: unknown, right: unknown): boolean {
  return canonical(left) === canonical(right)
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex")
}

function normalizeDirectory(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "")
  return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized
}

function messagePayload(message: Message): unknown {
  return message
}

function verifyMessages(expected: Message[], actual: Message[]): string | null {
  if (actual.length !== expected.length) return "E_GRAPH_MESSAGES"
  for (const [index, expectedMessage] of expected.entries()) {
    const actualMessage = actual[index]
    if (actualMessage === undefined) return "E_GRAPH_MESSAGES"
    if (
      actualMessage.id !== expectedMessage.id ||
      actualMessage.type !== expectedMessage.type ||
      actualMessage.time.created !== expectedMessage.time.created
    ) {
      return "E_GRAPH_MESSAGES"
    }
    if (expectedMessage.type === "user") {
      if (actualMessage.type !== "user" || actualMessage.text !== expectedMessage.text) {
        return "E_GRAPH_MESSAGES"
      }
      continue
    }
    if (actualMessage.type !== "assistant") return "E_GRAPH_MESSAGES"
    if (
      actualMessage.agent !== expectedMessage.agent ||
      !sameJson(actualMessage.model, expectedMessage.model) ||
      actualMessage.time.completed !== expectedMessage.time.completed ||
      !sameJson(actualMessage.content, expectedMessage.content)
    ) {
      return "E_GRAPH_PARTS"
    }
  }
  return null
}

export function verifyReferenceClosure(
  sessions: ObservedSession[],
  messages: Record<string, Message[]>,
): {
  known: boolean
  dangling: number
  unknown: number
  parentRefs: number
  forkRefs: number
  revertRefs: number
} {
  const byID = new Map(sessions.map((session) => [session.id, session]))
  let parentRefs = 0
  let forkRefs = 0
  let revertRefs = 0
  let dangling = 0
  let unknown = 0
  for (const session of sessions) {
    if (session.parentID !== null) {
      parentRefs += 1
      if (!byID.has(session.parentID)) unknown += 1
    }
    if (session.fork !== null) {
      forkRefs += 1
      const source = byID.get(session.fork.sessionID)
      if (source === undefined) {
        unknown += 1
      } else if (!(messages[source.id] ?? []).some((message) => message.id === session.fork!.boundary.messageID)) {
        dangling += 1
      }
    }
    if (session.revert !== null) {
      revertRefs += 1
      if (!(messages[session.id] ?? []).some((message) => message.id === session.revert!.messageID)) {
        dangling += 1
      }
    }
  }
  return { known: unknown === 0 && dangling === 0, dangling, unknown, parentRefs, forkRefs, revertRefs }
}

export function verifyGraph(fixture: FrozenFixture, observation: Observation): VerifyResult {
  const unsupported = new Set<string>()
  const components: VerifyResult["components"] = {
    parentChain: false,
    fork: false,
    revert: false,
    toolCompleted: false,
    toolError: false,
    payloadHashes: false,
    project: false,
    time: false,
    location: false,
  }
  const refs: VerifyResult["refs"] = {
    parentRefs: 0,
    forkRefs: 0,
    revertRefs: 0,
    known: false,
    dangling: 0,
    unknown: 0,
    duplicateSessions: 0,
    duplicateMessages: 0,
  }
  const failed = (failure: string): VerifyResult => ({
    verified: false,
    failure,
    unsupported: [...unsupported].sort(),
    components,
    refs,
  })

  const expectedByID = new Map(fixture.sessions.map((session) => [session.id, session]))
  const observedByID = new Map<string, ObservedSession>()
  for (const session of observation.sessions) {
    if (observedByID.has(session.id)) {
      refs.duplicateSessions += 1
      refs.known = false
      return failed("E_GRAPH_DUPLICATE")
    }
    observedByID.set(session.id, session)
  }
  if (observedByID.size !== expectedByID.size) return failed("E_GRAPH_SESSIONS")
  for (const id of expectedByID.keys()) if (!observedByID.has(id)) return failed("E_GRAPH_SESSIONS")
  for (const id of observedByID.keys()) if (!expectedByID.has(id)) return failed("E_GRAPH_UNEXPECTED_SESSION")

  const closure = verifyReferenceClosure(observation.sessions, observation.messages)
  refs.parentRefs = closure.parentRefs
  refs.forkRefs = closure.forkRefs
  refs.revertRefs = closure.revertRefs
  refs.unknown = closure.unknown
  refs.dangling = closure.dangling
  if (closure.unknown > 0) return failed("E_GRAPH_UNKNOWN_REF")
  if (closure.dangling > 0) return failed("E_GRAPH_DANGLING_REF")

  const messageIDs = new Set<string>()
  for (const [sessionID, messages] of Object.entries(observation.messages)) {
    if (!expectedByID.has(sessionID)) return failed("E_GRAPH_UNEXPECTED_SESSION")
    for (const message of messages) {
      if (messageIDs.has(message.id)) {
        refs.duplicateMessages += 1
        refs.known = false
        return failed("E_GRAPH_DUPLICATE")
      }
      messageIDs.add(message.id)
    }
  }

  let projectID: string | null = null
  let parentChain = true
  let timeOK = true
  let locationOK = true
  let payloadsOK = true
  let toolCompletedOK = fixture.features.toolCompleted
  let toolErrorOK = fixture.features.toolError

  for (const expected of fixture.sessions) {
    const observed = observedByID.get(expected.id)!
    const actualMessages = observation.messages[expected.id] ?? []
    if (observed.parentID !== expected.parentID) return failed("E_GRAPH_PARENT")
    if (observed.parentID !== null && !expectedByID.has(observed.parentID)) {
      refs.unknown += 1
      return failed("E_GRAPH_UNKNOWN_REF")
    }

    if (expected.fork !== null) {
      if (observed.fork === null) {
        components.fork = false
        unsupported.add("session.import.info.fork.persistence")
      } else if (!sameJson(observed.fork, expected.fork)) {
        return failed("E_GRAPH_FORK")
      }
    } else if (observed.fork !== null) {
      return failed("E_GRAPH_UNEXPECTED_REF")
    }

    if (expected.revert !== null) {
      if (observed.revert === null) {
        unsupported.add("session.import.info.revert.persistence")
      } else if (!sameJson(observed.revert, expected.revert)) {
        return failed("E_GRAPH_REVERT")
      }
    } else if (observed.revert !== null) {
      return failed("E_GRAPH_UNEXPECTED_REF")
    }

    if (observed.title !== expected.title || observed.created !== expected.created) {
      return failed("E_GRAPH_SESSION")
    }
    if (typeof observed.projectID !== "string" || !CANONICAL_PROJECT_ID.test(observed.projectID)) {
      return failed("E_GRAPH_PROJECT")
    }
    if (projectID === null) projectID = observed.projectID
    if (observed.projectID !== projectID || observed.importedProject !== observed.projectID) {
      return failed("E_GRAPH_PROJECT")
    }
    if (
      !Number.isFinite(observed.updated) ||
      observed.updated < observed.created ||
      observed.updated < observed.window.started ||
      observed.updated > observed.window.finished
    ) {
      timeOK = false
    }
    if (normalizeDirectory(observed.directory) !== normalizeDirectory(fixture.directory)) {
      locationOK = false
    }

    const messageFailure = verifyMessages(expected.messages, actualMessages)
    if (messageFailure !== null) return failed(messageFailure)
    if (digest(actualMessages.map(messagePayload)) !== digest(expected.messages.map(messagePayload))) {
      payloadsOK = false
    }

    const expectedCompleted = expected.messages.some(
      (message) => message.type === "assistant" && message.content.some(
        (part) => part.type === "tool" && part.state.status === "completed",
      ),
    )
    const expectedError = expected.messages.some(
      (message) => message.type === "assistant" && message.content.some(
        (part) => part.type === "tool" && part.state.status === "error",
      ),
    )
    if (expectedCompleted) toolCompletedOK = true
    if (expectedError) toolErrorOK = true
  }

  for (const expected of fixture.sessions) {
    const observed = observedByID.get(expected.id)!
    if (observed.fork !== null) {
      const source = observedByID.get(observed.fork.sessionID)
      if (source === undefined) return failed("E_GRAPH_UNKNOWN_REF")
      const sourceMessages = observation.messages[source.id] ?? []
      if (!sourceMessages.some((message) => message.id === observed.fork!.boundary.messageID)) {
        return failed("E_GRAPH_DANGLING_REF")
      }
    }
    if (observed.revert !== null) {
      const ownMessages = observation.messages[observed.id] ?? []
      if (!ownMessages.some((message) => message.id === observed.revert!.messageID)) {
        return failed("E_GRAPH_DANGLING_REF")
      }
    }
  }

  refs.known = refs.unknown === 0 && refs.dangling === 0
  components.parentChain = parentChain
  components.fork = fixture.features.fork ? !unsupported.has("session.import.info.fork.persistence") : false
  components.revert = fixture.features.revert ? !unsupported.has("session.import.info.revert.persistence") : false
  components.toolCompleted = fixture.features.toolCompleted && toolCompletedOK
  components.toolError = fixture.features.toolError && toolErrorOK
  components.payloadHashes = payloadsOK
  components.project = projectID !== null
  components.time = timeOK
  components.location = locationOK

  const allSupported =
    fixture.features.parentID &&
    fixture.features.user &&
    fixture.features.assistant &&
    fixture.features.assistantText &&
    fixture.features.fork &&
    fixture.features.revert &&
    fixture.features.toolCompleted &&
    fixture.features.toolError &&
    fixture.features.toolTextContent
  const verified = allSupported &&
    parentChain &&
    timeOK &&
    locationOK &&
    payloadsOK &&
    components.fork &&
    components.revert &&
    components.toolCompleted &&
    components.toolError &&
    components.project &&
    refs.known

  return {
    verified,
    failure: null,
    unsupported: [...unsupported].sort(),
    components,
    refs,
  }
}
