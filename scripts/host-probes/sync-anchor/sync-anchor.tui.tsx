import { randomBytes } from "node:crypto"
import { readFileSync, renameSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { createEffect, createSignal } from "solid-js"
import { initialRedirectGuard, recordRedirect, sameOrderedIDs } from "./route-guard"
import {
  ANCHOR_TITLE,
  CHILD_TITLES,
  INSPECTION_MANIFEST_VERSION,
  parseInspectionManifest,
  validateInspectionGraph,
  type InspectionManifest,
} from "./phase2"

const PLUGIN_ID = "sync-anchor-probe"
const PROBE_NAME = "sessionport-sync-anchor-public-route-cache"
const USER_TEXT = "synthetic sync-anchor user message"
const ASSISTANT_TEXT = "synthetic sync-anchor assistant reply"
const SUPPLIED_PROJECT_ID = "sync-anchor-probe-supplied-project"
const RESULT_LIMIT_BYTES = 16 * 1024
const MANIFEST_LIMIT_BYTES = 4 * 1024
const ROUTE_WAIT_MS = 500
const POLL_MS = 25
const syntheticIDs: string[] = []

type ProbeResult = {
  probe: string
  phase: "probe" | "inspect"
  ok: boolean
  stage: string
  failure: string | null
  imports: { attempted: number; returned: number }
  anchor: {
    originalPreserved: boolean
    messageCount: number | null
    rootCount: number | null
    initialRouteObserved: boolean
    initialCacheReady: boolean
    initialCacheMessageCount: number | null
  }
  children: { count: number; retained: boolean; messagesSettled: boolean }
  cache: { refreshed: boolean; messageCount: number | null }
  route: { redirects: number; rootSelectionReachedHead: boolean; tabFocusReachedHead: boolean | null }
  tabs: { enabled: boolean; result: "passed" | "skipped-disabled" | "failed" | "not-tested" }
  renderReadiness: {
    nativeSessionRouteObserved: boolean
    messageCacheReady: boolean
    composerObserved: false
    ordinaryContinuation: "not-tested"
  }
}

function under(child: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
}

function fixedError(_error: unknown): string {
  return "probe-runtime-error"
}

function createResult(phase: "probe" | "inspect"): ProbeResult {
  return {
    probe: PROBE_NAME,
    phase,
    ok: false,
    stage: phase === "inspect" ? "inspection-manifest" : "isolation-gate",
    failure: null,
    imports: { attempted: 0, returned: 0 },
    anchor: {
      originalPreserved: false,
      messageCount: null,
      rootCount: null,
      initialRouteObserved: false,
      initialCacheReady: false,
      initialCacheMessageCount: null,
    },
    children: { count: 0, retained: false, messagesSettled: false },
    cache: { refreshed: false, messageCount: null },
    route: { redirects: 0, rootSelectionReachedHead: false, tabFocusReachedHead: null },
    tabs: { enabled: false, result: "failed" },
    renderReadiness: {
      nativeSessionRouteObserved: false,
      messageCacheReady: false,
      composerObserved: false,
      ordinaryContinuation: "not-tested",
    },
  }
}

function writeResult(file: string, result: ProbeResult, ids: readonly string[], paths: readonly string[]) {
  const serialized = JSON.stringify(result)
  if (Buffer.byteLength(serialized, "utf8") > RESULT_LIMIT_BYTES) throw new Error("result-limit")
  if (ids.some((id) => serialized.includes(id)) || paths.some((item) => serialized.includes(item))) {
    throw new Error("result-leak-guard")
  }

  const temporary = `${file}.tmp`
  writeFileSync(temporary, JSON.stringify(result, null, 2), { encoding: "utf8", flag: "wx" })
  renameSync(temporary, file)
}

function writeManifest(file: string, manifest: InspectionManifest, paths: readonly string[]) {
  const serialized = JSON.stringify(manifest)
  if (Buffer.byteLength(serialized, "utf8") > MANIFEST_LIMIT_BYTES) throw new Error("manifest-limit")
  if ([USER_TEXT, ASSISTANT_TEXT].some((text) => serialized.includes(text))) throw new Error("manifest-leak-guard")
  if (paths.some((item) => item.length > 0 && serialized.includes(item))) throw new Error("manifest-leak-guard")
  const temporary = `${file}.tmp`
  writeFileSync(temporary, serialized, { encoding: "utf8", flag: "wx" })
  renameSync(temporary, file)
}

function fixtureMessages() {
  const now = Date.now()
  return [
    { id: messageID(), time: { created: now - 2000 }, type: "user" as const, text: USER_TEXT },
    {
      id: messageID(),
      time: { created: now - 1500, completed: now - 1000 },
      type: "assistant" as const,
      agent: "probe",
      model: { id: "probe-model", providerID: "probe-provider" },
      content: [{ type: "text" as const, text: ASSISTANT_TEXT }],
    },
  ]
}

function sessionID(): string {
  const id = `ses_${randomBytes(32).toString("hex")}`
  syntheticIDs.push(id)
  return id
}

function messageID(): string {
  const id = `msg_${randomBytes(32).toString("hex")}`
  syntheticIDs.push(id)
  return id
}

function settled(messages: readonly unknown[]): boolean {
  const first = messages[0] as { type?: unknown; text?: unknown } | undefined
  const second = messages[1] as {
    type?: unknown
    time?: { completed?: unknown }
    content?: readonly { type?: unknown; text?: unknown }[]
  } | undefined
  return (
    messages.length === 2 &&
    first?.type === "user" &&
    first.text === USER_TEXT &&
    second?.type === "assistant" &&
    typeof second.time?.completed === "number" &&
    Array.isArray(second.content) &&
    second.content.some((part) => part.type === "text" && part.text === ASSISTANT_TEXT)
  )
}

function messageSnapshot(messages: readonly unknown[]) {
  return messages.map((entry) => {
    const message = entry as {
      id?: unknown
      type?: unknown
      text?: unknown
      time?: { created?: unknown; completed?: unknown }
      content?: readonly { type?: unknown; text?: unknown }[]
    }
    return {
      id: message.id,
      type: message.type,
      text: message.text,
      created: message.time?.created,
      completed: message.time?.completed,
      assistantMarkerPresent: Array.isArray(message.content) &&
        message.content.some((part) => part.type === "text" && part.text === ASSISTANT_TEXT),
    }
  })
}

function messageBodySnapshot(messages: readonly unknown[]) {
  return messageSnapshot(messages).map((message) => ({
    type: message.type,
    text: message.text,
    created: message.created,
    completed: message.completed,
    assistantMarkerPresent: message.assistantMarkerPresent,
  }))
}

function copySnapshotMessages(messages: ReturnType<typeof fixtureMessages>) {
  return messages.map((message) => ({
    ...message,
    id: messageID(),
    time: { ...message.time },
    ...(message.type === "assistant" ? { content: message.content.map((part) => ({ ...part })) } : {}),
  }))
}

function importPayload(
  id: string,
  parentID: string | undefined,
  title: string,
  directory: string,
  messages: ReturnType<typeof fixtureMessages> = fixtureMessages(),
) {
  const now = Date.now()
  return {
    info: {
      id,
      ...(parentID ? { parentID } : {}),
      projectID: SUPPLIED_PROJECT_ID,
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: now - 2000, updated: now - 1000, idle: now - 1000 },
      title,
      location: { directory },
    },
    messages,
    location: { directory },
  }
}

function RouteController(props: { context: Context }) {
  const [heads, setHeads] = createSignal<Record<string, string>>({})
  let guard = initialRedirectGuard
  let redirects = 0
  let loopDetected = false
  let started = false

  createEffect(() => {
    const route = props.context.ui.router.current()
    const head = route.type === "session" ? heads()[route.sessionID] : undefined
    if (!head || head === route.sessionID || loopDetected) return

    const decision = recordRedirect(guard, Date.now())
    guard = decision.state
    if (!decision.allowed) {
      loopDetected = true
      return
    }

    redirects += 1
    props.context.ui.router.navigate({ type: "session", sessionID: head })
  })

  createEffect(() => {
    if (started) return
    started = true
    const routeState = {
      publishHeads: setHeads,
      redirects: () => redirects,
      loopDetected: () => loopDetected,
    }
    void (process.env.SP_PROBE_PHASE === "inspect"
      ? runInspection(props.context, routeState)
      : runProbe(props.context, routeState))
  })

  return null
}

async function waitForHead(context: Context, headID: string, loopDetected: () => boolean): Promise<boolean> {
  const deadline = Date.now() + ROUTE_WAIT_MS
  while (Date.now() < deadline) {
    const route = context.ui.router.current()
    if (route.type === "session" && route.sessionID === headID) return true
    if (loopDetected()) return false
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
  const route = context.ui.router.current()
  return route.type === "session" && route.sessionID === headID
}

async function waitForRedirectAfter(previousCount: number, redirects: () => number, loopDetected: () => boolean): Promise<boolean> {
  const deadline = Date.now() + ROUTE_WAIT_MS
  while (Date.now() < deadline) {
    if (loopDetected()) return false
    if (redirects() > previousCount) return true
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
  return redirects() > previousCount && !loopDetected()
}

async function waitForHome(context: Context, loopDetected: () => boolean): Promise<boolean> {
  const deadline = Date.now() + ROUTE_WAIT_MS
  while (Date.now() < deadline) {
    if (context.ui.router.current().type === "home") return true
    if (loopDetected()) return false
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
  return context.ui.router.current().type === "home"
}

async function runInspection(
  context: Context,
  routeState: {
    publishHeads: (value: Record<string, string>) => Record<string, string>
    redirects: () => number
    loopDetected: () => boolean
  },
) {
  const env = process.env
  const root = env.SP_PROBE_ROOT ?? ""
  const resultPath = env.SP_PROBE_RESULT ?? ""
  const project = env.SP_PROBE_PROJECT ?? ""
  const manifestPath = env.SP_PROBE_MANIFEST ?? ""
  const contextDirectory = context.location?.directory ?? ""
  const paths = [
    root,
    resultPath,
    manifestPath,
    project,
    contextDirectory,
    os.homedir(),
    os.tmpdir(),
    process.cwd(),
    env.HOME ?? "",
    env.USERPROFILE ?? "",
    env.APPDATA ?? "",
    env.LOCALAPPDATA ?? "",
    env.TEMP ?? "",
    env.TMP ?? "",
    env.TMPDIR ?? "",
    env.XDG_DATA_HOME ?? "",
    env.XDG_CACHE_HOME ?? "",
    env.XDG_CONFIG_HOME ?? "",
    env.XDG_STATE_HOME ?? "",
    env.OPENCODE_CONFIG_DIR ?? "",
  ].filter(Boolean)
  const result = createResult("inspect")
  try {
    if (
      !root || !resultPath || !project || !manifestPath ||
      paths.some((candidate) => !under(candidate, root)) ||
      !samePath(contextDirectory, project)
    ) {
      result.failure = "isolation-gate-failed"
      if (root && resultPath && under(resultPath, root)) writeResult(resultPath, result, syntheticIDs, paths)
      return
    }

    result.stage = "inspection-capability"
    if (
      typeof context.client.session.get !== "function" ||
      typeof context.client.session.list !== "function" ||
      typeof context.client.message.list !== "function"
    ) {
      result.failure = "public-client-capability-missing"
      writeResult(resultPath, result, syntheticIDs, paths)
      return
    }

    result.stage = "inspection-manifest"
    const parsed = parseInspectionManifest(readFileSync(manifestPath, "utf8"))
    if (!parsed.ok) {
      result.failure = "inspection-manifest-invalid"
      writeResult(resultPath, result, syntheticIDs, paths)
      return
    }
    const manifest = parsed.manifest

    result.stage = "inspection-readback"
    const anchor = await context.client.session.get({ sessionID: manifest.anchorID })
    const anchorMessagesResponse = await context.client.message.list({ sessionID: manifest.anchorID, limit: 50, order: "asc" })
    const anchorMessages = Array.isArray(anchorMessagesResponse?.data) ? anchorMessagesResponse.data : []
    const projectID = typeof anchor?.projectID === "string" ? anchor.projectID : ""
    if (!projectID) {
      result.failure = "inspection-readback-mismatch"
      writeResult(resultPath, result, syntheticIDs, paths)
      return
    }
    const listResponse = await context.client.session.list({ project: projectID, limit: 50 })
    const sessions = Array.isArray(listResponse?.data) ? listResponse.data : []
    const childMessages: string[][] = []
    const childSettled: boolean[] = []
    for (const childID of manifest.childIDs) {
      const response = await context.client.message.list({ sessionID: childID, limit: 50, order: "asc" })
      const messages = Array.isArray(response?.data) ? response.data : []
      childMessages.push(messages.map((message) => message.id))
      childSettled.push(settled(messages))
    }
    const graph = validateInspectionGraph(manifest, {
      anchor: {
        id: anchor?.id,
        parentID: anchor?.parentID,
        title: anchor?.title,
        projectID: anchor?.projectID,
      },
      anchorMessageIDs: anchorMessages.map((message) => message.id),
      anchorSettled: settled(anchorMessages),
      directoryMatches: samePath(anchor?.location?.directory ?? "", project),
      sessions,
      childMessageIDs: childMessages,
      childSettled,
    })
    result.anchor.originalPreserved = graph.ok
    result.anchor.messageCount = anchorMessages.length
    result.anchor.rootCount = sessions.filter((session) => !session.parentID).length
    result.children.count = sessions.filter((session) => session.parentID === manifest.anchorID).length
    result.children.retained = graph.ok
    result.children.messagesSettled = graph.ok
    if (!graph.ok) {
      result.failure = "inspection-readback-mismatch"
      writeResult(resultPath, result, syntheticIDs, paths)
      return
    }

    result.stage = "inspection-cache"
    const headID = manifest.childIDs[1]
    await context.data.session.sync(headID)
    await context.data.session.message.sync(headID)
    const cachedMessages = context.data.session.message.list(headID)
    result.cache.refreshed = true
    result.cache.messageCount = cachedMessages.length
    const cacheReady =
      cachedMessages.length === manifest.expected.childMessages &&
      sameOrderedIDs(cachedMessages.map((message) => message.id), manifest.childMessageIDs[1]) &&
      settled(cachedMessages)
    result.anchor.initialCacheReady = cacheReady
    if (!cacheReady) {
      result.failure = "inspection-cache-not-ready"
      writeResult(resultPath, result, syntheticIDs, paths)
      return
    }

    result.stage = "inspection-route"
    routeState.publishHeads({ [manifest.anchorID]: headID })
    const redirectsBefore = routeState.redirects()
    context.ui.router.navigate({ type: "session", sessionID: manifest.anchorID })
    const redirected = await waitForRedirectAfter(redirectsBefore, routeState.redirects, routeState.loopDetected)
    result.route.rootSelectionReachedHead = redirected && await waitForHead(context, headID, routeState.loopDetected)
    result.route.redirects = routeState.redirects()
    if (!result.route.rootSelectionReachedHead || routeState.loopDetected()) {
      result.failure = "inspection-route-not-observed"
      writeResult(resultPath, result, syntheticIDs, paths)
      return
    }

    result.tabs.enabled = context.ui.tabs.enabled()
    result.tabs.result = "not-tested"
    result.anchor.initialRouteObserved = true
    const finalRoute = context.ui.router.current()
    const finalCachedMessages = context.data.session.message.list(headID)
    result.renderReadiness.nativeSessionRouteObserved = finalRoute.type === "session" && finalRoute.sessionID === headID
    result.renderReadiness.messageCacheReady =
      finalCachedMessages.length === manifest.expected.childMessages &&
      sameOrderedIDs(finalCachedMessages.map((message) => message.id), manifest.childMessageIDs[1]) &&
      settled(finalCachedMessages)
    result.ok = result.renderReadiness.nativeSessionRouteObserved && result.renderReadiness.messageCacheReady
    result.stage = "complete"
    if (!result.ok) result.failure = "native-session-route-not-ready"
    writeResult(resultPath, result, syntheticIDs, paths)
  } catch {
    result.ok = false
    result.failure = "inspection-runtime-error"
    result.route.redirects = routeState.redirects()
    try {
      writeResult(resultPath, result, syntheticIDs, paths)
    } catch {
      // The runner reports a bounded missing-result failure; no exception text is retained.
    }
  }
}

async function runProbe(
  context: Context,
  routeState: {
    publishHeads: (value: Record<string, string>) => Record<string, string>
    redirects: () => number
    loopDetected: () => boolean
  },
) {
  const env = process.env
  const root = env.SP_PROBE_ROOT ?? ""
  const resultPath = env.SP_PROBE_RESULT ?? ""
  const project = env.SP_PROBE_PROJECT ?? ""
  const manifestPath = env.SP_PROBE_MANIFEST ?? ""
  const home = os.homedir()
  const temp = os.tmpdir()
  const contextDirectory = context.location?.directory ?? ""
  const paths = [
    root,
    resultPath,
    manifestPath,
    project,
    contextDirectory,
    home,
    temp,
    process.cwd(),
    env.HOME ?? "",
    env.USERPROFILE ?? "",
    env.APPDATA ?? "",
    env.LOCALAPPDATA ?? "",
    env.TEMP ?? "",
    env.TMP ?? "",
    env.TMPDIR ?? "",
    env.XDG_DATA_HOME ?? "",
    env.XDG_CACHE_HOME ?? "",
    env.XDG_CONFIG_HOME ?? "",
    env.XDG_STATE_HOME ?? "",
    env.OPENCODE_CONFIG_DIR ?? "",
  ].filter(Boolean)

  const result = createResult("probe")

  try {
    if (
      !root || !resultPath || !project ||
      paths.some((candidate) => !under(candidate, root)) ||
      !samePath(contextDirectory, project)
    ) {
      result.failure = "isolation-gate-failed"
      if (root && resultPath && under(resultPath, root)) writeResult(resultPath, result, syntheticIDs, paths)
      return
    }

    result.stage = "capability-gate"
    if (
      typeof context.client.session.import !== "function" ||
      typeof context.client.session.get !== "function" ||
      typeof context.client.session.list !== "function" ||
      typeof context.client.message.list !== "function"
    ) {
      result.failure = "public-client-capability-missing"
      writeResult(resultPath, result, syntheticIDs, paths)
      return
    }

    result.stage = "anchor-import"
    const anchorID = sessionID()
    const anchorPayload = importPayload(anchorID, undefined, "synthetic sync-anchor root", project)
    result.imports.attempted += 1
    const anchorImport = await context.client.session.import(anchorPayload)
    result.imports.returned += 1
    const anchorMessagesResponse = await context.client.message.list({ sessionID: anchorID, limit: 50, order: "asc" })
    const anchorMessages = Array.isArray(anchorMessagesResponse?.data) ? anchorMessagesResponse.data : []
    const anchorListResponse = await context.client.session.list({ project: anchorImport.projectID, limit: 50 })
    const anchorList = Array.isArray(anchorListResponse?.data) ? anchorListResponse.data : []
    const anchorReadback = await context.client.session.get({ sessionID: anchorID })
    result.anchor.messageCount = anchorMessages.length
    result.anchor.rootCount = anchorList.filter((item) => !item.parentID).length
    result.anchor.originalPreserved = Boolean(
      anchorImport.id === anchorID &&
      anchorReadback?.id === anchorID &&
      !anchorReadback?.parentID &&
      anchorReadback?.title === "synthetic sync-anchor root" &&
      samePath(anchorReadback?.location?.directory ?? "", project) &&
      settled(anchorMessages),
    )
    if (!result.anchor.originalPreserved || result.anchor.rootCount !== 1) {
      result.failure = "anchor-seed-readback-mismatch"
      writeResult(resultPath, result, syntheticIDs, paths)
      return
    }

    result.stage = "initial-anchor-route"
    await context.data.session.sync(anchorID)
    await context.data.session.message.sync(anchorID)
    const cachedAnchorMessages = context.data.session.message.list(anchorID)
    result.anchor.initialCacheMessageCount = cachedAnchorMessages.length
    result.anchor.initialCacheReady = cachedAnchorMessages.length === 2 &&
      sameOrderedIDs(cachedAnchorMessages.map((message) => message.id), anchorPayload.messages.map((message) => message.id)) &&
      settled(cachedAnchorMessages)
    if (!result.anchor.initialCacheReady) {
      result.failure = "anchor-cache-not-ready"
      writeResult(resultPath, result, syntheticIDs, paths)
      return
    }
    routeState.publishHeads({ [anchorID]: anchorID })
    context.ui.router.navigate({ type: "session", sessionID: anchorID })
    result.anchor.initialRouteObserved = await waitForHead(context, anchorID, routeState.loopDetected)
    if (!result.anchor.initialRouteObserved || routeState.loopDetected()) {
      result.failure = routeState.loopDetected() ? "route-redirect-loop-guard" : "initial-anchor-route-not-observed"
      writeResult(resultPath, result, syntheticIDs, paths)
      return
    }

    result.stage = "child-imports"
    const childIDs = [sessionID(), sessionID()]
    const childSnapshots = childIDs.map((id) => ({ id, messages: copySnapshotMessages(anchorPayload.messages) }))
    const originalAnchor = {
      id: anchorReadback.id,
      parentID: anchorReadback.parentID,
      title: anchorReadback.title,
      directory: anchorReadback.location?.directory,
      messages: messageSnapshot(anchorMessages),
    }
    let childrenValid = true
    let finalListed: typeof anchorList = anchorList
    const allImportedMessageIDs = new Set(anchorPayload.messages.map((message) => message.id))
    for (const [index, child] of childSnapshots.entries()) {
      const childID = child.id
      result.imports.attempted += 1
      const imported = await context.client.session.import(
        importPayload(childID, anchorID, `synthetic sync-anchor child ${index + 1}`, project, child.messages),
      )
      result.imports.returned += 1
      const readback = await context.client.session.get({ sessionID: childID })
      const messagesResponse = await context.client.message.list({ sessionID: childID, limit: 50, order: "asc" })
      const messages = Array.isArray(messagesResponse?.data) ? messagesResponse.data : []
      const expectedMessageIDs = new Set(child.messages.map((message) => message.id))
      childrenValid = childrenValid && Boolean(
        imported.id === childID &&
        readback?.id === childID &&
        readback?.parentID === anchorID &&
        settled(messages) &&
        messages.every((message, messageIndex) =>
          message.id === child.messages[messageIndex]?.id &&
          expectedMessageIDs.has(message.id) &&
          !allImportedMessageIDs.has(message.id)
        ) &&
        JSON.stringify(messageBodySnapshot(messages)) === JSON.stringify(messageBodySnapshot(anchorPayload.messages)),
      )
      for (const message of messages) allImportedMessageIDs.add(message.id)

      const currentAnchor = await context.client.session.get({ sessionID: anchorID })
      const currentAnchorMessagesResponse = await context.client.message.list({ sessionID: anchorID, limit: 50, order: "asc" })
      const currentAnchorMessages = Array.isArray(currentAnchorMessagesResponse?.data) ? currentAnchorMessagesResponse.data : []
      const currentAnchorSnapshot = {
        id: currentAnchor?.id,
        parentID: currentAnchor?.parentID,
        title: currentAnchor?.title,
        directory: currentAnchor?.location?.directory,
        messages: messageSnapshot(currentAnchorMessages),
      }
      const currentListResponse = await context.client.session.list({ project: anchorImport.projectID, limit: 50 })
      finalListed = Array.isArray(currentListResponse?.data) ? currentListResponse.data : []
      const rootCount = finalListed.filter((item) => !item.parentID).length
      const retainedChildren = finalListed.filter((item) => item.parentID === anchorID)
      result.anchor.originalPreserved = JSON.stringify(originalAnchor) === JSON.stringify(currentAnchorSnapshot)
      result.anchor.messageCount = currentAnchorMessages.length
      result.anchor.rootCount = rootCount
      result.children.count = retainedChildren.length
      result.children.retained = retainedChildren.length === index + 1 && childIDs.slice(0, index + 1).every((id) => retainedChildren.some((item) => item.id === id))
      result.children.messagesSettled = childrenValid
      if (!result.anchor.originalPreserved || rootCount !== 1 || !result.children.retained || !childrenValid) {
        result.failure = "public-readback-verification-failed"
        writeResult(resultPath, result, syntheticIDs, paths)
        return
      }
    }
    const children = finalListed.filter((item) => item.parentID === anchorID)
    result.children.retained = children.length === 2 && childIDs.every((id) => children.some((item) => item.id === id))
    if (!result.anchor.originalPreserved || result.anchor.rootCount !== 1 || !result.children.retained || !childrenValid) {
      result.failure = "public-readback-verification-failed"
      writeResult(resultPath, result, syntheticIDs, paths)
      return
    }

    result.stage = "cache-refresh"
    const headID = childIDs[1]
    await context.data.session.sync(headID)
    await context.data.session.message.sync(headID)
    const cachedMessages = context.data.session.message.list(headID)
    result.cache.refreshed = true
    result.cache.messageCount = cachedMessages.length
    const expectedHeadMessageIDs = childSnapshots[1].messages.map((message) => message.id)
    if (cachedMessages.length !== 2 || !sameOrderedIDs(cachedMessages.map((message) => message.id), expectedHeadMessageIDs) || !settled(cachedMessages)) {
      result.failure = "head-cache-not-ready"
      writeResult(resultPath, result, syntheticIDs, paths)
      return
    }

    result.stage = "root-route-selection"
    const redirectsBeforeRootSelection = routeState.redirects()
    routeState.publishHeads({ [anchorID]: headID })
    context.ui.router.navigate({ type: "session", sessionID: anchorID })
    const rootRedirected = await waitForRedirectAfter(redirectsBeforeRootSelection, routeState.redirects, routeState.loopDetected)
    result.route.rootSelectionReachedHead = rootRedirected && await waitForHead(context, headID, routeState.loopDetected)
    result.route.redirects = routeState.redirects()
    if (!result.route.rootSelectionReachedHead || routeState.loopDetected()) {
      result.failure = routeState.loopDetected() ? "route-redirect-loop-guard" : "root-route-did-not-reach-head"
      writeResult(resultPath, result, syntheticIDs, paths)
      return
    }

    result.stage = "tabs-route-selection"
    result.tabs.enabled = context.ui.tabs.enabled()
    if (result.tabs.enabled) {
      context.ui.router.navigate({ type: "home" })
      const homeReached = await waitForHome(context, routeState.loopDetected)
      if (!homeReached) {
        result.failure = routeState.loopDetected() ? "route-redirect-loop-guard" : "tab-home-route-not-observed"
        result.tabs.result = "failed"
        result.route.redirects = routeState.redirects()
        writeResult(resultPath, result, syntheticIDs, paths)
        return
      }
      const redirectsBeforeTabFocus = routeState.redirects()
      const alreadyOpen = context.ui.tabs.list().some((tab) => tab.sessionID === anchorID)
      const opened = alreadyOpen || context.ui.tabs.open(anchorID)
      const focused = context.ui.tabs.focus(anchorID)
      const rootTabListed = context.ui.tabs.list().some((tab) => tab.sessionID === anchorID)
      const tabRedirected = opened && focused && rootTabListed
        ? await waitForRedirectAfter(redirectsBeforeTabFocus, routeState.redirects, routeState.loopDetected)
        : false
      result.route.tabFocusReachedHead = tabRedirected
        ? await waitForHead(context, headID, routeState.loopDetected)
        : false
      result.route.redirects = routeState.redirects()
      result.tabs.result = result.route.tabFocusReachedHead && !routeState.loopDetected() ? "passed" : "failed"
      if (result.tabs.result === "failed") {
        result.failure = routeState.loopDetected() ? "route-redirect-loop-guard" : "tab-focus-did-not-reach-head"
        writeResult(resultPath, result, syntheticIDs, paths)
        return
      }
    } else {
      result.route.tabFocusReachedHead = null
      result.tabs.result = "skipped-disabled"
    }

    const finalRoute = context.ui.router.current()
    result.renderReadiness.nativeSessionRouteObserved = finalRoute.type === "session" && finalRoute.sessionID === headID
    const finalCachedMessages = context.data.session.message.list(headID)
    result.renderReadiness.messageCacheReady = finalCachedMessages.length === 2 &&
      sameOrderedIDs(finalCachedMessages.map((message) => message.id), expectedHeadMessageIDs) &&
      settled(finalCachedMessages)
    result.ok = result.renderReadiness.nativeSessionRouteObserved && result.renderReadiness.messageCacheReady
    if (manifestPath) {
      writeManifest(manifestPath, {
        version: INSPECTION_MANIFEST_VERSION,
        anchorID,
        childIDs: [childIDs[0], childIDs[1]],
        anchorMessageIDs: [anchorPayload.messages[0].id, anchorPayload.messages[1].id],
        childMessageIDs: [
          [childSnapshots[0].messages[0].id, childSnapshots[0].messages[1].id],
          [childSnapshots[1].messages[0].id, childSnapshots[1].messages[1].id],
        ],
        expected: { rootCount: 1, childCount: 2, anchorMessages: 2, childMessages: 2 },
      }, paths)
    }
    result.stage = "complete"
    if (!result.ok) result.failure = "native-session-route-not-ready"
    writeResult(resultPath, result, syntheticIDs, paths)
  } catch (error) {
    result.ok = false
    result.failure = fixedError(error)
    result.route.redirects = routeState.redirects()
    try {
      writeResult(resultPath, result, syntheticIDs, paths)
    } catch {
      // The runner reports a bounded missing-result failure; no exception text is retained.
    }
  }
}

export default Plugin.define({
  id: PLUGIN_ID,
  setup(context) {
    return context.ui.slot({
      append: "app",
      render: () => <RouteController context={context} />,
    })
  },
})
