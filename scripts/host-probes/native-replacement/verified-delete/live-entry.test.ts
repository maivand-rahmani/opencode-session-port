import { describe, expect, test } from "bun:test"
import { LifecycleError, createRequestPort } from "../lifecycle/runner.mjs"
import {
  createLiveEntryCallbacks,
  exitCodeForResult,
  finalizeRunResult,
  generateFixtureIDs,
  validateManifest,
  type GuardedRequest,
} from "./live-entry.ts"
import { OLD_MESSAGE_TEXT } from "./fixtures.ts"

const DIRECTORY = "/run/sessionport/run-test"
const CANONICAL_PROJECT = "host-canonical-project-1"

function openapi() {
  return {
    openapi: "3.1.0",
    paths: {
      "/api/info": { get: {} },
      "/api/session": { get: {} },
      "/api/session/{sessionID}": { get: {}, patch: {}, delete: {} },
      "/api/session/{sessionID}/message": { get: {} },
      "/api/experimental/session/import": { post: {} },
    },
  }
}

type Stored = {
  info: Record<string, unknown>
  messages: Record<string, unknown>[]
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

class FakeHost {
  readonly calls: Array<{ method: string; path: string; body?: unknown }> = []
  readonly sessions = new Map<string, Stored>()
  readonly imports: Array<Record<string, any>> = []
  readonly deletes: string[] = []
  readonly deleted = new Map<string, Stored>()
  deleteMode: "ok" | "ambiguous" = "ok"
  extraSession = false
  pageSize = 50
  terminalNull = false
  emptyPages = 0
  anomaly: "repeat" | "malformed" | "unknown" | "duplicate" | null = null

  private paginate(items: unknown[], url: URL): { data: unknown[]; cursor: unknown } {
    const raw = url.searchParams.get("cursor")
    const start = raw === null ? 0 : Number(Buffer.from(raw, "base64url").toString("utf8"))
    if (items.length === 0 || start >= items.length) {
      this.emptyPages += 1
      return { data: [], cursor: this.terminalNull ? null : {} }
    }
    const data = raw !== null && this.anomaly === "duplicate"
      ? items.slice(0, this.pageSize)
      : items.slice(start, start + this.pageSize)
    // The public handler anchors `next` at the last item of every non-empty page.
    const next = Buffer.from(String(start + data.length)).toString("base64url")
    const previous = start > 0 ? Buffer.from(String(Math.max(0, start - this.pageSize))).toString("base64url") : undefined
    const cursor: Record<string, unknown> = {
      ...(previous === undefined ? {} : { previous }),
      ...(next === undefined ? {} : { next }),
    }
    if (this.anomaly === "repeat" && raw !== null) cursor.next = raw
    if (this.anomaly === "duplicate") cursor.next = raw ?? next
    if (this.anomaly === "malformed") cursor.next = 5
    if (this.anomaly === "unknown") cursor["after"] = "opaque"
    return { data, cursor }
  }

  request: GuardedRequest = async (spec) => {
    this.calls.push(clone(spec))
    const url = new URL(spec.path, "http://127.0.0.1:4096")
    const path = url.pathname
    if (spec.method === "GET" && path === "/openapi.json") return openapi()
    if (spec.method === "GET" && path === "/api/session") {
      const list = [...this.sessions.values()].map((entry) => clone(entry.info))
      if (this.extraSession) {
        list.push({
          id: `ses_${"9".repeat(64)}`, projectID: CANONICAL_PROJECT, title: "foreign",
          time: { created: 1, updated: 2 }, location: { directory: DIRECTORY },
        })
      }
      return this.paginate(list, url)
    }
    if (spec.method === "POST" && path === "/api/experimental/session/import") {
      const body = spec.body as Record<string, any>
      this.imports.push(clone(body))
      const id = String(body.info.id)
      const info = {
        id, projectID: CANONICAL_PROJECT, title: body.info.title,
        cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: body.info.time.created, updated: Date.now(), idle: Date.now() },
        location: { directory: body.info.location.directory },
      }
      this.sessions.set(id, { info, messages: clone(body.messages) })
      return { data: { id, projectID: CANONICAL_PROJECT } }
    }
    const session = path.match(/^\/api\/session\/(ses_[0-9a-f]{64})(\/message)?$/)
    if (session) {
      const stored = this.sessions.get(session[1]!)
      if (!stored) throw new LifecycleError("E_NOT_FOUND")
      if (spec.method === "GET" && session[2]) return this.paginate(clone(stored.messages), url)
      if (spec.method === "GET" && !session[2]) return { data: clone(stored.info) }
      if (spec.method === "DELETE" && !session[2]) {
        if (this.deleteMode === "ambiguous") throw new LifecycleError("E_HTTP")
        this.deletes.push(session[1]!)
        this.deleted.set(session[1]!, clone(stored))
        this.sessions.delete(session[1]!)
        return null
      }
    }
    throw new Error("fake-host-unexpected-route")
  }

  readonlyReadonly: GuardedRequest = async (spec) => {
    if (spec.method !== "GET") throw new LifecycleError("E_READONLY")
    return this.request(spec)
  }
}

function context(ids: ReturnType<typeof generateFixtureIDs>, request: GuardedRequest, phase: string) {
  return {
    request,
    sessionIDs: [ids.oldSessionID, ids.candidateSessionID],
    profileDir: DIRECTORY,
    phase,
  }
}

function actualPort(host: FakeHost, ids: ReturnType<typeof generateFixtureIDs>, readonly = false) {
  const fetch = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input))
    const body = init.body === undefined || init.body === null ? undefined : JSON.parse(String(init.body))
    try {
      const data = await host.request({
        method: String(init.method ?? "GET"),
        path: `${url.pathname}${url.search}`,
        ...(body === undefined ? {} : { body }),
      })
      return new Response(data === null ? "" : JSON.stringify(data), { status: 200 })
    } catch (error) {
      if (error instanceof LifecycleError && error.code === "E_NOT_FOUND") {
        return new Response(JSON.stringify({ error: "not found" }), { status: 404 })
      }
      return new Response(JSON.stringify({ error: "synthetic" }), { status: 500 })
    }
  }
  return createRequestPort({
    fetch,
    password: "p".repeat(43),
    sessionIDs: [ids.oldSessionID, ids.candidateSessionID],
    baseUrl: "http://127.0.0.1:4096",
    readonly,
    syntheticDeleteTarget: ids.oldSessionID,
  })
}

async function successHost(options: Partial<Pick<FakeHost, "terminalNull" | "pageSize">> = {}) {
  const ids = generateFixtureIDs()
  const callbacks = createLiveEntryCallbacks({ ids })
  const host = new FakeHost()
  Object.assign(host, options)
  const probe = await callbacks.probe(context(ids, host.request, "first"))
  return { ids, callbacks, host, probe }
}

async function probeFailure(options: Partial<Pick<FakeHost, "anomaly" | "extraSession" | "pageSize">>) {
  const ids = generateFixtureIDs()
  const callbacks = createLiveEntryCallbacks({ ids })
  const host = new FakeHost()
  Object.assign(host, options)
  let code = "no-error"
  let probe: Record<string, unknown> | null = null
  try {
    probe = await callbacks.probe(context(ids, host.request, "first"))
  } catch (error) {
    code = error instanceof LifecycleError ? error.code : "unexpected"
  }
  return { code, probe, host, callbacks }
}

describe("live verified-delete entry", () => {
  test("seeds a readback payload, pins host project/time, verifies recovery, and deletes old once", async () => {
    const { ids, callbacks, host, probe } = await successHost()
    const state = callbacks.state()

    expect(probe.outcome).toBe("api-verified")
    expect(probe.restartManifestReady).toBe(true)
    expect(state.result?.outcome).toBe("delete-verified")
    expect(state.fixture?.projectID).toBe(CANONICAL_PROJECT)
    expect(state.fixture?.oldRoot.session.time.created).toBe(host.imports[0]!.info.time.created)
    expect(state.fixture?.oldRoot.messages[0]!.text).toBe(OLD_MESSAGE_TEXT[0])
    expect(host.imports[1]!.info.projectID).toBe(CANONICAL_PROJECT)
    expect(host.deletes).toEqual([ids.oldSessionID])
    expect(state.manifest && validateManifest(state.manifest, state.fixture!)).toBe(true)
    expect(state.manifest).toMatchObject({
      oldID: ids.oldSessionID,
      newID: ids.candidateSessionID,
      canonicalProject: CANONICAL_PROJECT,
      expectedCounts: { oldMessages: 2, candidateMessages: 3 },
    })

    const deletes = host.calls.filter((call) => call.method === "DELETE")
    expect(deletes).toEqual([{ method: "DELETE", path: `/api/session/${ids.oldSessionID}` }])
    expect(host.calls.some((call) => /prompt|tool|command|shell/.test(call.path))).toBe(false)
    expect(JSON.stringify(probe)).not.toContain("synthetic verified-delete")

    const cursorPages = host.calls.filter((call) => call.path.includes("cursor="))
    expect(cursorPages.length).toBeGreaterThan(0)
    expect(cursorPages.every((call) => !call.path.includes("order="))).toBe(true)
    callbacks.dispose()
  })

  test("actual request port consumes every server-like session/message page through the live adapter", async () => {
    const ids = generateFixtureIDs()
    const callbacks = createLiveEntryCallbacks({ ids })
    const host = new FakeHost()
    const probe = await callbacks.probe(context(ids, actualPort(host, ids), "first"))
    expect(probe.outcome).toBe("api-verified")
    expect(host.deletes).toEqual([ids.oldSessionID])

    const messageInitial = host.calls.filter((call) => call.path.includes("/message?order=asc"))
    const messageCursor = host.calls.filter((call) => call.path.includes("/message?") && call.path.includes("cursor="))
    const sessionCursor = host.calls.filter((call) => call.path.startsWith("/api/session?") && call.path.includes("cursor="))
    expect(messageInitial.length).toBeGreaterThan(0)
    expect(messageCursor.length).toBeGreaterThan(0)
    expect(sessionCursor.length).toBeGreaterThan(0)
    expect([...messageCursor, ...sessionCursor].every((call) => !call.path.includes("order="))).toBe(true)
    expect(host.calls.some((call) => call.path.includes("cursor=") && call.method !== "GET")).toBe(false)
    expect(host.emptyPages).toBeGreaterThan(0)

    const snapshot = await callbacks.snapshot(context(ids, actualPort(host, ids, true), "restart-readonly"))
    expect(snapshot.status).toBe("verified")
    expect(snapshot.recoveryPayload).toBe("strict-equal")
    callbacks.dispose()
  })

  test("readonly restart snapshot verifies old 404, candidate history, inventory, and recovery", async () => {
    const { ids, callbacks, host, probe } = await successHost()
    const snapshot = await callbacks.snapshot(context(ids, host.readonlyReadonly, "restart-readonly"))

    expect(snapshot.status).toBe("verified")
    expect(snapshot.oldAbsent).toBe(true)
    expect(snapshot.candidateMessages).toBe(3)
    expect(snapshot.inventorySessions).toBe(1)
    expect(snapshot.recoveryVerify).toBe("verified")
    expect(snapshot.recoveryPayload).toBe("strict-equal")
    expect(snapshot.nativeRestore).toBe("not-proven")
    expect(JSON.stringify(snapshot)).not.toContain("synthetic verified-delete")

    const finalized = finalizeRunResult({ status: "ok", probe, snapshot, cleanup: "profile-removed" })
    expect(finalized.status).toBe("ok")
    expect(exitCodeForResult(finalized)).toBe(0)
    callbacks.dispose()
  })

  test("terminal cursor null is accepted only on an empty page, with the same DELETE proof", async () => {
    const { callbacks, host, probe } = await successHost({ terminalNull: true })
    expect(probe.outcome).toBe("api-verified")
    expect(probe.restartManifestReady).toBe(true)
    expect(host.deletes).toHaveLength(1)
    callbacks.dispose()
  })

  test("restart old present, candidate change, and recovery failure are non-zero and never false-pass", async () => {
    const { ids, callbacks, host, probe } = await successHost()
    const oldInfo = host.deleted.get(ids.oldSessionID)!.info
    host.sessions.set(ids.oldSessionID, { info: oldInfo, messages: [] })
    const present = await callbacks.snapshot(context(ids, host.readonlyReadonly, "restart-readonly"))
    expect(present.status).toBe("failed")
    expect(present.step).toBe("old-absent")
    expect(exitCodeForResult(finalizeRunResult({ probe, snapshot: present }))).toBe(1)
    host.sessions.delete(ids.oldSessionID)

    host.sessions.get(ids.candidateSessionID)!.messages[2]!.text = "changed"
    const changed = await callbacks.snapshot(context(ids, host.readonlyReadonly, "restart-readonly"))
    expect(changed.status).toBe("failed")
    expect(changed.step).toBe("candidate-verify")
    host.sessions.get(ids.candidateSessionID)!.messages[2]!.text = "synthetic verified-delete distinct tail"

    callbacks.dispose()
    const recovery = await callbacks.snapshot(context(ids, host.readonlyReadonly, "restart-readonly"))
    expect(recovery.status).toBe("failed")
    expect(recovery.step).toBe("recovery-verify")
    expect(recovery.errorCategory).toBe("E_RECOVERY_VERIFY")
    expect(exitCodeForResult(finalizeRunResult({ probe, snapshot: recovery }))).toBe(1)
  })

  test("unknown inventory and unsettled graph block with zero deletes", async () => {
    const ids = generateFixtureIDs()
    const callbacks = createLiveEntryCallbacks({ ids })
    const host = new FakeHost()
    host.extraSession = true
    const probe = await callbacks.probe(context(ids, host.request, "first"))
    expect(probe.outcome).toBe("blocked")
    expect(probe.reason).toBe("inventory-unreadable")
    expect(probe.restartManifestReady).toBe(false)
    expect(host.deletes).toEqual([])
    expect(host.calls.some((call) => call.method === "DELETE")).toBe(false)
    callbacks.dispose()
  })

  test("malformed, unknown, duplicate, and repeated cursors block with zero DELETE", async () => {
    for (const [options, expected] of [
      [{ anomaly: "malformed" }, "E_INVENTORY_PAGING"],
      [{ anomaly: "unknown" }, "E_INVENTORY_PAGING"],
      [{ anomaly: "duplicate", pageSize: 1 }, "E_INVENTORY_DUPLICATE"],
      [{ anomaly: "repeat", pageSize: 1 }, "E_INVENTORY_PAGING_CYCLE"],
    ] as const) {
      const { code, host, callbacks } = await probeFailure(options)
      expect(code).toBe(expected)
      expect(host.calls.some((call) => call.method === "DELETE")).toBe(false)
      callbacks.dispose()
    }
  })

  test("foreign session hidden on a second page blocks with zero DELETE", async () => {
    const { code, probe, host, callbacks } = await probeFailure({ extraSession: true, pageSize: 2 })
    expect(code).toBe("no-error")
    expect(probe?.outcome).toBe("blocked")
    expect(probe?.reason).toBe("inventory-unreadable")
    expect(probe?.restartManifestReady).toBe(false)
    expect(host.calls.some((call) => call.method === "DELETE")).toBe(false)
    callbacks.dispose()
  })

  test("actual request port blocks foreign session hidden on a second page with zero DELETE", async () => {
    const ids = generateFixtureIDs()
    const callbacks = createLiveEntryCallbacks({ ids })
    const host = new FakeHost()
    host.extraSession = true
    host.pageSize = 2
    const probe = await callbacks.probe(context(ids, actualPort(host, ids), "first"))
    expect(probe.outcome).toBe("blocked")
    expect(probe.reason).toBe("inventory-unreadable")
    expect(probe.restartManifestReady).toBe(false)
    expect(host.calls.some((call) => call.method === "DELETE")).toBe(false)
    callbacks.dispose()
  })

  test("ambiguous delete reconciles read-only once and never converts to success", async () => {
    const ids = generateFixtureIDs()
    const callbacks = createLiveEntryCallbacks({ ids })
    const host = new FakeHost()
    host.deleteMode = "ambiguous"
    const probe = await callbacks.probe(context(ids, host.request, "first"))
    const state = callbacks.state()

    expect(probe.outcome).toBe("failed")
    expect(probe.reason).toBe("delete-not-applied")
    expect(probe.restartManifestReady).toBe(false)
    expect(state.result?.delete.state).toBe("not-deleted")
    expect(state.result?.delete.removeOutcome).toBe("error")
    expect(state.result?.safety.deleteCalls).toBe(1)
    expect(state.result?.safety.blindRetries).toBe(0)
    expect(host.calls.filter((call) => call.method === "DELETE")).toHaveLength(1)
    expect(exitCodeForResult(finalizeRunResult({ probe, snapshot: { status: "not-run", reason: "probe-not-verified" } }))).toBe(1)
    callbacks.dispose()
  })
})
