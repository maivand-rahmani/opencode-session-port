// Nondestructive graph import/readback probe for the pinned OpenCode host.
// Import-time side effects: none. A host is launched only by runEntry().
//
// The probe intentionally does not use outcome "api-verified": that meaning is
// reserved for the existing verified-delete run with its restart snapshot. This
// probe does not require or request a host restart.

import { randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
import { pathToFileURL } from "node:url"
import {
  LifecycleError,
  PINNED,
  createRequestPort,
  withIsolatedHost,
} from "../lifecycle/runner.mjs"
import {
  buildFrozenFixture,
  generateFixtureIDs,
  nativeImportBody,
  verifyGraph,
  type FrozenFixture,
  type Message,
  type Observation,
  type ObservedSession,
  type Part,
  type SessionSpec,
  type ToolPart,
  type VerifyResult,
} from "./graph.ts"
import { detectGraphFeatures, isRecord, type GraphFeatures } from "./schema.ts"

export type GuardedRequest = (spec: { method: string; path: string; body?: unknown }) => Promise<unknown>
export type GuardedContext = { request: GuardedRequest; sessionIDs: string[]; profileDir: string; phase: string }

const SESSION_PATH = /^\/api\/session\/(ses_[0-9a-f]{64})$/
const MESSAGE_PATH = /^\/api\/session\/(ses_[0-9a-f]{64})\/message$/
const CANONICAL_PROJECT_ID = /^[A-Za-z0-9._:-]{1,128}$/
const SESSION_KEYS = new Set([
  "id", "parentID", "fork", "projectID", "agent", "model", "cost", "tokens", "outcome",
  "time", "title", "location", "subpath", "metadata", "permissions", "revert",
])
const SESSION_TIME_KEYS = new Set(["created", "updated", "idle", "viewed", "archived"])
const USER_KEYS = new Set(["id", "metadata", "time", "type", "text", "files", "agents", "skills"])
const ASSISTANT_KEYS = new Set([
  "id", "metadata", "time", "type", "agent", "model", "content", "snapshot", "finish",
  "rawFinish", "native", "cost", "tokens", "error", "retry",
])
const ASSISTANT_TIME_KEYS = new Set(["created", "streamed", "completed"])
const TOOL_PART_KEYS = new Set(["type", "id", "name", "executed", "native", "state", "time"])
const TOOL_TIME_KEYS = new Set(["created", "ran", "completed"])
const COMPLETED_KEYS = new Set(["status", "input", "content", "metadata"])
const ERROR_KEYS = new Set(["status", "input", "error", "content", "metadata"])
const TEXT_PART_KEYS = new Set(["type", "text"])
const LIST_KEYS = new Set(["data", "cursor"])
const CURSOR_KEYS = new Set(["previous", "next"])
const PAGE_LIMIT = 50
const MAX_PAGES = 8
const MAX_SESSIONS = 4
const MAX_MESSAGES = 8

function fail(code: string): never {
  throw new LifecycleError(code)
}

function data(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || !isRecord(value.data)) fail("E_HOST_CONTRACT")
  return value.data
}

function exactKeys(value: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key))
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function sameDirectory(left: unknown, right: string): boolean {
  if (typeof left !== "string") return false
  const normalize = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "")
  const a = normalize(left)
  const b = normalize(right)
  return /^[A-Za-z]:\//.test(a) || /^[A-Za-z]:\//.test(b)
    ? a.toLowerCase() === b.toLowerCase()
    : a === b
}

function forkRef(value: unknown): { sessionID: string; boundary: { type: "before" | "through"; messageID: string } } | null {
  if (value === undefined || value === null) return null
  if (!isRecord(value) || Object.keys(value).length !== 2 || !isRecord(value.boundary)) fail("E_HOST_CONTRACT")
  const boundary = value.boundary
  if (
    Object.keys(boundary).length !== 2 ||
    (boundary.type !== "before" && boundary.type !== "through") ||
    typeof boundary.messageID !== "string" ||
    typeof value.sessionID !== "string"
  ) {
    fail("E_HOST_CONTRACT")
  }
  return { sessionID: value.sessionID, boundary: { type: boundary.type, messageID: boundary.messageID } }
}

function revertRef(value: unknown): { messageID: string } | null {
  if (value === undefined || value === null) return null
  if (!isRecord(value) || Object.keys(value).length !== 1 || typeof value.messageID !== "string") {
    fail("E_HOST_CONTRACT")
  }
  return { messageID: value.messageID }
}

export function parseSession(value: unknown, directory: string): {
  id: string
  parentID: string | null
  fork: ReturnType<typeof forkRef>
  revert: ReturnType<typeof revertRef>
  projectID: string
  title: string
  created: number
  updated: number
  directory: string
} {
  if (!isRecord(value) || !exactKeys(value, SESSION_KEYS)) fail("E_HOST_CONTRACT")
  if (
    typeof value.id !== "string" ||
    !SESSION_PATH.test(`/api/session/${value.id}`) ||
    (value.parentID !== undefined && value.parentID !== null && typeof value.parentID !== "string") ||
    !isRecord(value.time) ||
    !exactKeys(value.time, SESSION_TIME_KEYS) ||
    !finite(value.time.created) ||
    !finite(value.time.updated) ||
    (value.time.archived !== undefined && !finite(value.time.archived)) ||
    typeof value.projectID !== "string" ||
    !CANONICAL_PROJECT_ID.test(value.projectID) ||
    typeof value.title !== "string" ||
    value.title.length === 0 ||
    !isRecord(value.location) ||
    !sameDirectory(value.location.directory, directory)
  ) {
    fail("E_HOST_CONTRACT")
  }
  return {
    id: value.id,
    parentID: value.parentID ?? null,
    fork: forkRef(value.fork),
    revert: revertRef(value.revert),
    projectID: value.projectID,
    title: value.title,
    created: value.time.created,
    updated: value.time.updated,
    directory: value.location.directory,
  }
}

function textPart(value: unknown): { type: "text"; text: string } {
  if (!isRecord(value) || !exactKeys(value, TEXT_PART_KEYS) || value.type !== "text" || typeof value.text !== "string") {
    fail("E_HOST_CONTRACT")
  }
  return { type: "text", text: value.text }
}

function toolPart(value: Record<string, unknown>): ToolPart {
  if (
    !exactKeys(value, TOOL_PART_KEYS) ||
    value.type !== "tool" ||
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    !isRecord(value.state) ||
    !isRecord(value.time) ||
    !exactKeys(value.time, TOOL_TIME_KEYS) ||
    !finite(value.time.created) ||
    !finite(value.time.ran) ||
    !finite(value.time.completed)
  ) {
    fail("E_HOST_CONTRACT")
  }
  const state = value.state
  if (!isRecord(state.input)) fail("E_HOST_CONTRACT")
  if (state.status === "completed") {
    if (!exactKeys(state, COMPLETED_KEYS) || !Array.isArray(state.content)) fail("E_HOST_CONTRACT")
    return {
      type: "tool",
      id: value.id,
      name: value.name,
      state: {
        status: "completed",
        input: state.input,
        content: state.content.map(textPart),
      },
      time: { created: value.time.created, ran: value.time.ran, completed: value.time.completed },
    }
  }
  if (state.status === "error") {
    if (
      !exactKeys(state, ERROR_KEYS) ||
      !isRecord(state.error) ||
      typeof state.error.type !== "string" ||
      typeof state.error.message !== "string" ||
      Object.keys(state.error).length !== 2
    ) {
      fail("E_HOST_CONTRACT")
    }
    return {
      type: "tool",
      id: value.id,
      name: value.name,
      state: {
        status: "error",
        input: state.input,
        error: { type: state.error.type, message: state.error.message },
      },
      time: { created: value.time.created, ran: value.time.ran, completed: value.time.completed },
    }
  }
  fail("E_HOST_CONTRACT")
}

function parts(value: unknown): Part[] {
  if (!Array.isArray(value)) fail("E_HOST_CONTRACT")
  return value.map((part) => {
    if (!isRecord(part)) fail("E_HOST_CONTRACT")
    if (part.type === "text") return textPart(part)
    if (part.type === "tool") return toolPart(part)
    fail("E_HOST_CONTRACT")
  })
}

export function parseMessage(value: unknown): Message {
  if (!isRecord(value)) fail("E_HOST_CONTRACT")
  if (value.type === "user") {
    if (
      !exactKeys(value, USER_KEYS) ||
      typeof value.id !== "string" ||
      typeof value.text !== "string" ||
      value.files !== undefined ||
      value.agents !== undefined ||
      value.skills !== undefined ||
      !isRecord(value.time) ||
      Object.keys(value.time).length !== 1 ||
      !finite(value.time.created)
    ) {
      fail("E_HOST_CONTRACT")
    }
    return { id: value.id, type: "user", text: value.text, time: { created: value.time.created } }
  }
  if (value.type === "assistant") {
    if (
      !exactKeys(value, ASSISTANT_KEYS) ||
      typeof value.id !== "string" ||
      typeof value.agent !== "string" ||
      !isRecord(value.model) ||
      typeof value.model.id !== "string" ||
      typeof value.model.providerID !== "string" ||
      Object.keys(value.model).length !== 2 ||
      !isRecord(value.time) ||
      !exactKeys(value.time, ASSISTANT_TIME_KEYS) ||
      value.time.streamed !== undefined ||
      !finite(value.time.created) ||
      !finite(value.time.completed) ||
      value.metadata !== undefined ||
      value.finish !== undefined ||
      value.rawFinish !== undefined ||
      value.native !== undefined ||
      value.cost !== undefined ||
      value.tokens !== undefined ||
      value.error !== undefined ||
      value.retry !== undefined ||
      value.snapshot !== undefined
    ) {
      fail("E_HOST_CONTRACT")
    }
    return {
      id: value.id,
      type: "assistant",
      agent: value.agent,
      model: { id: value.model.id, providerID: value.model.providerID },
      content: parts(value.content),
      time: { created: value.time.created, completed: value.time.completed },
    }
  }
  fail("E_HOST_CONTRACT")
}

function cursorEnvelope(value: unknown, parse: (item: unknown) => unknown): {
  items: unknown[]
  next: string | undefined
} {
  if (!isRecord(value) || !exactKeys(value, LIST_KEYS) || !Array.isArray(value.data)) fail("E_HOST_CONTRACT")
  const raw = value.cursor
  const cursor = raw === undefined || raw === null ? {} : raw
  if (!isRecord(cursor) || !exactKeys(cursor, CURSOR_KEYS)) fail("E_INVENTORY_PAGING")
  const position = (entry: unknown): string | undefined => {
    if (entry === undefined || entry === null) return undefined
    if (typeof entry !== "string" || !/^[A-Za-z0-9_-]{1,8192}$/.test(entry)) fail("E_INVENTORY_PAGING")
    return entry
  }
  const next = position(cursor.next)
  const previous = position(cursor.previous)
  const items = value.data.map(parse)
  if (items.length === 0) {
    if (next !== undefined || previous !== undefined) fail("E_INVENTORY_PAGING")
  } else if (next === undefined) {
    fail("E_INVENTORY_PAGING")
  }
  return { items, next }
}

/**
 * Strict outer guard around the lifecycle request ports. GET is limited to the
 * owned graph readback routes; POST is limited to one import per frozen session
 * ID. DELETE/PATCH and every other mutation are rejected before any port call.
 */
export function createGraphGuard(
  ports: Array<{ request: GuardedRequest; sessionIDs: readonly string[] }>,
  sessionIDs: readonly string[],
): { request: GuardedRequest; counts: { imports: number; gets: number; rejectedMutations: number } } {
  if (ports.length !== 2 || sessionIDs.length !== 4) fail("E_CONFIG")
  const ids = new Set(sessionIDs)
  if (ids.size !== 4) fail("E_CONFIG")
  const imported = new Set<string>()
  const counts = { imports: 0, gets: 0, rejectedMutations: 0 }

  const portFor = (sessionID: string): GuardedRequest => {
    for (const port of ports) {
      if (port.sessionIDs.includes(sessionID)) return port.request
    }
    fail("E_SCOPE")
  }

  return {
    counts,
    request: async (spec) => {
      if (!isRecord(spec) || typeof spec.path !== "string") fail("E_ALLOWLIST")
      const method = String(spec.method ?? "GET").toUpperCase()
      let url: URL
      try {
        url = new URL(spec.path, "http://graph.local")
      } catch {
        fail("E_ALLOWLIST")
      }
      if (url.origin !== "http://graph.local" || url.username || url.password || url.hash) fail("E_ALLOWLIST")
      if (spec.path.includes("\\") || spec.path.includes("..") || /%2e|%2f|%5c/i.test(spec.path)) fail("E_ALLOWLIST")
      const path = url.pathname

      if (method === "DELETE" || method === "PATCH" || method === "PUT" || method === "OPTIONS" || method === "HEAD") {
        counts.rejectedMutations += 1
        fail("E_READONLY")
      }
      if (method === "POST") {
        if (
          path !== "/api/experimental/session/import" ||
          url.search.length > 0 ||
          !isRecord(spec.body) ||
          !isRecord(spec.body.info) ||
          typeof spec.body.info.id !== "string" ||
          !ids.has(spec.body.info.id)
        ) {
          counts.rejectedMutations += 1
          fail("E_READONLY")
        }
        if (imported.has(spec.body.info.id)) fail("E_READONLY")
        imported.add(spec.body.info.id)
        counts.imports += 1
        return portFor(spec.body.info.id)(spec)
      }
      if (method !== "GET") {
        counts.rejectedMutations += 1
        fail("E_READONLY")
      }
      counts.gets += 1
      if (path === "/openapi.json" || path === "/api/session") return ports[0]!.request(spec)
      const session = path.match(SESSION_PATH)
      if (session) {
        if (!ids.has(session[1]!) || url.search.length > 0) fail("E_ALLOWLIST")
        return portFor(session[1]!)(spec)
      }
      const messages = path.match(MESSAGE_PATH)
      if (messages) {
        if (!ids.has(messages[1]!)) fail("E_ALLOWLIST")
        return portFor(messages[1]!)(spec)
      }
      fail("E_ALLOWLIST")
    },
  }
}

async function importSpec(request: GuardedRequest, spec: SessionSpec, fixture: FrozenFixture): Promise<{
  projectID: string
  window: { started: number; finished: number }
}> {
  const started = Date.now()
  const value = await request({
    method: "POST",
    path: "/api/experimental/session/import",
    body: nativeImportBody(spec, fixture),
  })
  const finished = Date.now()
  const info = data(value)
  if (info.id !== spec.id) fail(`E_IMPORT_${spec.key.toUpperCase()}`)
  if (typeof info.projectID !== "string" || !CANONICAL_PROJECT_ID.test(info.projectID)) fail("E_GRAPH_PROJECT")
  return { projectID: info.projectID, window: { started, finished } }
}

async function readInventory(request: GuardedRequest): Promise<ReturnType<typeof parseSession>[]> {
  const sessions: ReturnType<typeof parseSession>[] = []
  const ids = new Set<string>()
  const cursors = new Set<string>()
  let cursor: string | undefined
  for (let page = 0; ; page += 1) {
    if (page >= MAX_PAGES) fail("E_INVENTORY_PAGING_LIMIT")
    const path = cursor === undefined
      ? `/api/session?limit=${PAGE_LIMIT}&order=asc`
      : `/api/session?limit=${PAGE_LIMIT}&cursor=${encodeURIComponent(cursor)}`
    const parsed = cursorEnvelope(await request({ method: "GET", path }), (item) => item)
    for (const item of parsed.items) {
      if (!isRecord(item) || typeof item.location !== "object") fail("E_HOST_CONTRACT")
      const session = parseSession(item, (item.location as { directory?: unknown }).directory as string)
      if (ids.has(session.id)) fail("E_INVENTORY_DUPLICATE")
      if (ids.size >= MAX_SESSIONS) fail("E_INVENTORY_SHAPE")
      ids.add(session.id)
      sessions.push(session)
    }
    if (parsed.items.length === 0) return sessions
    if (cursors.has(parsed.next!)) fail("E_INVENTORY_PAGING_CYCLE")
    cursors.add(parsed.next!)
    cursor = parsed.next!
  }
}

async function readMessages(request: GuardedRequest, sessionID: string, directory: string): Promise<Message[]> {
  const messages: Message[] = []
  const ids = new Set<string>()
  const cursors = new Set<string>()
  let cursor: string | undefined
  for (let page = 0; ; page += 1) {
    if (page >= MAX_PAGES) fail("E_INVENTORY_PAGING_LIMIT")
    const path = cursor === undefined
      ? `/api/session/${sessionID}/message?order=asc&limit=${PAGE_LIMIT}`
      : `/api/session/${sessionID}/message?limit=${PAGE_LIMIT}&cursor=${encodeURIComponent(cursor)}`
    const parsed = cursorEnvelope(await request({ method: "GET", path }), (item) => item)
    for (const item of parsed.items) {
      const message = parseMessage(item)
      if (ids.has(message.id)) fail("E_INVENTORY_DUPLICATE")
      if (ids.size >= MAX_MESSAGES) fail("E_INVENTORY_SHAPE")
      ids.add(message.id)
      messages.push(message)
    }
    if (parsed.items.length === 0) return messages
    if (cursors.has(parsed.next!)) fail("E_INVENTORY_PAGING_CYCLE")
    cursors.add(parsed.next!)
    cursor = parsed.next!
  }
}

export function sanitizeGraphResult(input: {
  features: GraphFeatures
  fixture: FrozenFixture
  verification: VerifyResult
  importPosts: number
  sentinelAbsent: boolean
  directory: string
}): Record<string, unknown> {
  const { features, fixture, verification } = input
  const failure = verification.failure
  const outcome = failure !== null
    ? "graph-failed"
    : verification.verified
      ? "graph-verified"
      : "graph-partial"
  const unsupported = [...new Set([...features.unsupported, ...verification.unsupported])].sort()
  return {
    outcome,
    verified: outcome === "graph-verified",
    reason: failure,
    schema: {
      import: features.importEndpoint,
      parentID: features.parentID,
      fork: features.fork,
      revert: features.revert,
      user: features.user,
      assistant: features.assistant,
      assistantText: features.assistantText,
      toolCompleted: features.toolCompleted,
      toolError: features.toolError,
      toolTextContent: features.toolTextContent,
      messageSource: features.messageSource,
      unsupported,
      importsAllowed: features.importsAllowed,
    },
    graph: {
      sessions: fixture.sessions.length,
      messages: fixture.sessions.reduce((sum, session) => sum + session.messages.length, 0),
      parentChain: verification.components.parentChain,
      forkRef: features.fork
        ? verification.components.fork ? "verified" : "unsupported"
        : "not-supported",
      revertRef: features.revert
        ? verification.components.revert ? "verified" : "unsupported"
        : "not-supported",
      toolCompleted: features.toolCompleted && verification.components.toolCompleted,
      toolError: features.toolError && verification.components.toolError,
    },
    projection: {
      projectNormalized: verification.components.project,
      timeUpdatedNormalized: verification.components.time,
      locationRetargeted: verification.components.location,
      partsPayloadHashes: verification.components.payloadHashes,
      rolesOrder: failure === null,
    },
    refs: verification.refs,
    sideEffect: {
      sentinelAbsent: input.sentinelAbsent,
      commandsExecuted: false,
      network: "planned-none",
    },
    mutations: {
      importPosts: input.importPosts,
      getRequests: 0,
      deleteCalls: 0,
      patchCalls: 0,
      otherMutations: 0,
    },
    profile: "fresh-isolated",
    directoryRetargeted: input.directory.length > 0,
  }
}

export function createGraphCallbacks(input: {
  ids: ReturnType<typeof generateFixtureIDs>
  password: string
  baseUrl?: string
}): {
  probe(context: GuardedContext): Promise<Record<string, unknown>>
} {
  const baseUrl = input.baseUrl ?? `http://${PINNED.hostname}:${PINNED.port}`
  return {
    probe: async (context) => {
      if (
        !Array.isArray(context.sessionIDs) ||
        context.sessionIDs.length !== 2 ||
        context.sessionIDs[0] !== input.ids.root ||
        context.sessionIDs[1] !== input.ids.child ||
        typeof context.profileDir !== "string" ||
        context.phase !== "first"
      ) {
        throw new LifecycleError("E_CONFIG")
      }

      const secondPort = createRequestPort({
        fetch: globalThis.fetch,
        password: input.password,
        sessionIDs: [input.ids.grandchild, input.ids.fork],
        baseUrl,
      })
      const guard = createGraphGuard(
        [
          { request: context.request, sessionIDs: [input.ids.root, input.ids.child] },
          { request: secondPort, sessionIDs: [input.ids.grandchild, input.ids.fork] },
        ],
        [input.ids.root, input.ids.child, input.ids.grandchild, input.ids.fork],
      )
      const request = guard.request

      const openapi = await request({ method: "GET", path: "/openapi.json" })
      const features = detectGraphFeatures(openapi)
      if (!features.importsAllowed) {
        const fixture = buildFrozenFixture({
          ids: input.ids,
          directory: context.profileDir,
          features,
        })
        return {
          outcome: "graph-unsupported",
          verified: false,
          reason: "E_SCHEMA_UNSUPPORTED",
          schema: {
            import: features.importEndpoint,
            parentID: features.parentID,
            fork: features.fork,
            revert: features.revert,
            user: features.user,
            assistant: features.assistant,
            assistantText: features.assistantText,
            toolCompleted: features.toolCompleted,
            toolError: features.toolError,
            toolTextContent: features.toolTextContent,
            messageSource: features.messageSource,
            unsupported: features.unsupported,
            importsAllowed: false,
          },
          graph: { sessions: fixture.sessions.length, messages: 0 },
          mutations: { importPosts: 0, getRequests: guard.counts.gets, deleteCalls: 0, patchCalls: 0, otherMutations: 0 },
          sideEffect: { sentinelAbsent: true, commandsExecuted: false, network: "planned-none" },
          profile: "fresh-isolated",
        }
      }

      const fixture = buildFrozenFixture({
        ids: input.ids,
        directory: context.profileDir,
        features,
      })
      if (existsSync(fixture.sentinelPath)) fail("E_SIDE_EFFECT_SENTINEL_PRESENT")

      const imports = new Map<string, { projectID: string; window: { started: number; finished: number } }>()
      for (const spec of fixture.sessions) {
        const result = await importSpec(request, spec, fixture)
        imports.set(spec.id, result)
      }

      const inventory = await readInventory(request)
      const observedSessions: ObservedSession[] = []
      const observedMessages: Record<string, Message[]> = {}
      for (const session of inventory) {
        const imported = imports.get(session.id)
        if (imported === undefined) fail("E_GRAPH_UNEXPECTED_SESSION")
        observedSessions.push({
          ...session,
          importedProject: imported.projectID,
          window: imported.window,
        })
        observedMessages[session.id] = await readMessages(request, session.id, fixture.directory)
      }
      const observation: Observation = { sessions: observedSessions, messages: observedMessages }
      const verification = verifyGraph(fixture, observation)
      const sentinelAbsent = !existsSync(fixture.sentinelPath)
      if (!sentinelAbsent) fail("E_SIDE_EFFECT_SENTINEL_PRESENT")

      const result = sanitizeGraphResult({
        features,
        fixture,
        verification,
        importPosts: guard.counts.imports,
        sentinelAbsent,
        directory: context.profileDir,
      })
      if (isRecord(result.mutations)) {
        result.mutations.getRequests = guard.counts.gets
        result.mutations.otherMutations = guard.counts.rejectedMutations
      }
      return result
    },
  }
}

export function finalizeGraphRun(run: Record<string, unknown>): Record<string, unknown> {
  const probe = isRecord(run.probe) ? run.probe : null
  const snapshot = isRecord(run.snapshot) ? run.snapshot : null
  const probeFailure = isRecord(run.probeFailure) ? run.probeFailure : null
  const verified = run.status === "ok" &&
    run.cleanup === "profile-removed" &&
    probe !== null &&
    probe.outcome === "graph-verified" &&
    probe.verified === true &&
    isRecord(probe.sideEffect) &&
    probe.sideEffect.sentinelAbsent === true &&
    probeFailure === null &&
    snapshot !== null &&
    snapshot.status === "not-run" &&
    (run.snapshotReason === "probe-not-verified" || run.snapshotReason === "snapshot-unconfigured")
  const failure = verified
    ? null
    : typeof probeFailure?.code === "string"
      ? probeFailure.code
      : typeof probe?.reason === "string"
        ? probe.reason
        : typeof run.snapshotReason === "string"
          ? run.snapshotReason
          : "E_GRAPH_VERIFY"
  return {
    status: verified ? "ok" : "failed",
    outcome: verified ? "graph-readback-verified" : "not-verified",
    failure,
    graph: probe,
    probeFailure,
    cleanup: run.cleanup,
    restart: "not-required",
    snapshot: snapshot === null ? null : { status: snapshot.status, reason: run.snapshotReason ?? null },
    nativeRestore: "not-in-scope",
  }
}

export function exitCodeForResult(result: unknown): number {
  return isRecord(result) && result.status === "ok" ? 0 : 1
}

export async function runEntry(): Promise<Record<string, unknown>> {
  const ids = generateFixtureIDs()
  const password = randomBytes(32).toString("base64url")
  const callbacks = createGraphCallbacks({ ids, password })
  let run: unknown = null
  try {
    run = await withIsolatedHost(
      {
        sessionIDs: [ids.root, ids.child],
        binaryPath: "/usr/local/bin/opencode",
        profileBase: "/run/sessionport",
        // No snapshot: this probe must not request a restart. No delete target.
      },
      callbacks.probe,
      { generatePassword: () => password },
    )
    return finalizeGraphRun(run as Record<string, unknown>)
  } catch (error) {
    if (error instanceof LifecycleError) {
      const facts = "facts" in error && isRecord((error as { facts?: unknown }).facts)
        ? (error as { facts: Record<string, unknown> }).facts
        : {}
      return { ...facts, status: "error", outcome: "not-verified", failure: error.code }
    }
    return { status: "error", outcome: "not-verified", failure: "E_INTERNAL" }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runEntry()
  process.stdout.write(`${JSON.stringify(result)}\n`)
  process.exitCode = exitCodeForResult(result)
}
