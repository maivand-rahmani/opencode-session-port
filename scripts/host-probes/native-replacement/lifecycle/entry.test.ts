import { describe, expect, test } from "bun:test"
import {
  LifecycleError,
  createRequestPort,
  verifyOpenApiArchiveContract,
} from "./runner.mjs"
import {
  buildOldImportPayload,
  createEntryCallbacks,
  exitCodeForResult,
  finalizeRunResult,
  generateFixtureIDs,
  sanitizeBlocker,
  sanitizeProbeResult,
  type GuardedRequest,
} from "./entry"
import { SYNTHETIC_TAIL_TEXT, createSyntheticFixture } from "../fixtures"

const A = `ses_${"a".repeat(64)}`
const B = `ses_${"b".repeat(64)}`
const PASSWORD = "p".repeat(43)
const SESSION_INFO_REF = "#/components/schemas/Session.Info"

function openapiDoc() {
  return {
    openapi: "3.1.0",
    paths: {
      "/api/info": { get: {} },
      "/api/session": {
        get: {
          parameters: [
            {
              name: "archived",
              in: "query",
              schema: {
                anyOf: [{ type: "string", enum: ["true", "false"] }, { type: "null" }],
              },
            },
          ],
        },
      },
      "/api/session/{sessionID}": {
        patch: {
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    archived: { anyOf: [{ type: "boolean" }, { type: "null" }] },
                  },
                  additionalProperties: false,
                },
              },
            },
          },
        },
        get: {
          responses: {
            "200": {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { data: { $ref: SESSION_INFO_REF } },
                    required: ["data"],
                  },
                },
              },
            },
          },
        },
      },
      "/api/experimental/session/import": { post: {} },
    },
    components: {
      schemas: {
        "Session.Info": {
          type: "object",
          properties: {
            time: {
              type: "object",
              properties: {
                created: { type: "number" },
                updated: { type: "number" },
                archived: { type: "number" },
              },
              required: ["created", "updated"],
              additionalProperties: false,
            },
          },
          required: ["time"],
        },
      },
    },
  }
}

function codeOf(fn: () => unknown): string {
  try {
    fn()
    return "ok"
  } catch (error) {
    return error instanceof LifecycleError ? error.code : "unexpected"
  }
}

async function rejectionCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
    return "ok"
  } catch (error) {
    return error instanceof LifecycleError ? error.code : "unexpected"
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

describe("entry final status", () => {
  test("only api-verified probe plus verified snapshot is ok/exit 0", () => {
    const probe = { outcome: "api-verified" }
    const snapshot = { status: "verified" }
    const result = finalizeRunResult(probe, snapshot, "profile-removed")
    expect(result.status).toBe("ok")
    expect(result.failure).toBeNull()
    expect(result.probe).toBe(probe)
    expect(result.snapshot).toBe(snapshot)
    expect(exitCodeForResult(result)).toBe(0)
  })

  test("partial, failed, unsupported, or unknown probe outcomes are nonzero", () => {
    for (const outcome of ["api-verified-partial", "failed", "invalid-fixture", "blocked", "unsupported", undefined]) {
      const result = finalizeRunResult({ outcome }, { status: "verified" }, "profile-removed")
      expect(result.status).toBe("failed")
      expect(result.failure).toBe("E_VERIFY")
      expect(exitCodeForResult(result)).toBe(1)
    }
    expect(exitCodeForResult({ status: "unsupported" })).toBe(1)
    expect(exitCodeForResult({ status: "error" })).toBe(1)
    expect(exitCodeForResult({})).toBe(1)
  })

  test("failed or missing snapshot is nonzero even when the probe verified", () => {
    for (const snapshot of [{ status: "failed" }, { status: "unknown" }, null, undefined, {}]) {
      const result = finalizeRunResult({ outcome: "api-verified" }, snapshot, "profile-removed")
      expect(result.status).toBe("failed")
      expect(result.failure).toBe("E_VERIFY")
      expect(exitCodeForResult(result)).toBe(1)
    }
  })

  test("probe failure and snapshot not-run are nonzero and preserve the fixed reason", () => {
    const probeFailure = { status: "failed", code: "E_OLD_TIME" }
    const result = finalizeRunResult(null, { status: "not-run", reason: "probe-failed" }, "profile-removed", probeFailure, "probe-failed")
    expect(result.status).toBe("failed")
    expect(result.failure).toBe("E_OLD_TIME")
    expect(result.probeFailure).toEqual(probeFailure)
    expect(result.probe).toEqual(probeFailure)
    expect(result.snapshotReason).toBe("probe-failed")
    expect(exitCodeForResult(result)).toBe(1)
  })

  test("snapshot step failure retains its category and makes verification nonzero", () => {
    const probe = { outcome: "api-verified", restartManifestReady: true }
    const snapshot = { status: "failed", step: "new-info", errorCategory: "E_NOT_FOUND" }
    const result = finalizeRunResult(probe, snapshot, "profile-removed", null, null)
    expect(result.status).toBe("failed")
    expect(result.failure).toBe("E_NOT_FOUND")
    expect(result.probe).toBe(probe)
    expect(exitCodeForResult(result)).toBe(1)
  })
})

describe("canonical host project binding", () => {
  const directory = "/run/sessionport/run-test"

  test("consistent host rewrite is accepted and candidate payload uses the canonical ID", async () => {
    const ids = generateFixtureIDs()
    const fake = createFakePort(openapiDoc(), { hostProjectID: "host-canonical-project-1" })
    const callbacks = createEntryCallbacks({ ids })
    const probe = await callbacks.probe({
      request: fake.port,
      sessionIDs: [ids.oldRootID, ids.candidateID],
      profileDir: directory,
      phase: "first",
    })
    expect((probe as { outcome: string }).outcome).toBe("api-verified")
    const candidateImport = fake.calls.find(
      (call) => call.method === "POST" && call.body?.info?.id === ids.candidateID,
    )
    expect(candidateImport?.body?.info?.projectID).toBe("host-canonical-project-1")
    expect(fake.sessions.get(ids.oldRootID).projectID).toBe("host-canonical-project-1")
  })

  test("import-response and first-GET project mismatch blocks before candidate", async () => {
    const ids = generateFixtureIDs()
    const fake = createFakePort(openapiDoc(), { hostProjectID: "host-get-project", importProjectID: "host-response-project" })
    const callbacks = createEntryCallbacks({ ids })
    expect(await rejectionCode(callbacks.probe({
      request: fake.port, sessionIDs: [ids.oldRootID, ids.candidateID], profileDir: directory, phase: "first",
    }))).toBe("E_PROJECT_ID")
    expect(fake.calls.some((call) => call.method === "POST" && call.body?.info?.id === ids.candidateID)).toBe(false)
    expect(fake.calls.some((call) => call.method === "PATCH")).toBe(false)
  })

  test("missing, oversized, or invalid project IDs block before candidate", async () => {
    for (const value of ["", "x".repeat(129), "not a project!"]) {
      const ids = generateFixtureIDs()
      const fake = createFakePort(openapiDoc(), { hostProjectID: value, importProjectID: value })
      const callbacks = createEntryCallbacks({ ids })
      expect(await rejectionCode(callbacks.probe({
        request: fake.port, sessionIDs: [ids.oldRootID, ids.candidateID], profileDir: directory, phase: "first",
      }))).toBe("E_PROJECT_ID")
      expect(fake.calls.some((call) => call.method === "POST" && call.body?.info?.id === ids.candidateID)).toBe(false)
    }
  })

  test("candidate under another project is blocked before archive", async () => {
    const ids = generateFixtureIDs()
    const fake = createFakePort(openapiDoc(), { hostProjectID: "host-canonical-project-1", candidateProjectID: "other-project" })
    const callbacks = createEntryCallbacks({ ids })
    const probe = await callbacks.probe({
      request: fake.port, sessionIDs: [ids.oldRootID, ids.candidateID], profileDir: directory, phase: "first",
    }) as { outcome: string; blocker?: string }
    expect(probe.outcome).toBe("failed")
    expect(fake.calls.some((call) => call.method === "PATCH")).toBe(false)
  })

  test("restart project drift is rejected after a verified probe", async () => {
    const ids = generateFixtureIDs()
    const fake = createFakePort(openapiDoc(), { hostProjectID: "host-canonical-project-1" })
    const callbacks = createEntryCallbacks({ ids })
    await callbacks.probe({ request: fake.port, sessionIDs: [ids.oldRootID, ids.candidateID], profileDir: directory, phase: "first" })
    const drift = async (spec: Parameters<GuardedRequest>[0]) => {
      const response = await fake.port(spec) as { data?: Record<string, unknown> }
      if (spec.method === "GET" && spec.path === `/api/session/${ids.candidateID}` && response.data) {
        return { ...response, data: { ...response.data, projectID: "drifted-project" } }
      }
      return response
    }
    const snapshot = await callbacks.snapshot({
      request: drift, sessionIDs: [ids.oldRootID, ids.candidateID], profileDir: directory, phase: "restart-readonly",
    }) as { status: string; reason?: string }
    expect(snapshot.status).toBe("failed")
    expect(snapshot.reason).toBe("restart-candidate-project-mismatch")
  })
})

describe("blocker sanitation", () => {
  test("every known blocked reason and dynamic enum retains a fixed safe value", () => {
    for (const blocker of [
      "old-root-unreadable",
      "old-root-already-archived",
      "old-root-archive-state-unknown",
      "old-root-baseline-mismatch",
      "candidate-id-present",
      "candidate-id-lookup-ambiguous",
      "candidate-archive-state-unknown",
      "archive-transport-unsupported",
      "archive-request-error-observed-active",
      "archive-readback-unknown",
      "archive-readback-not-verified",
      "unarchive-transport-unsupported",
      "unarchive-readback-not-verified",
      "rearchive-transport-unsupported",
    ]) {
      expect(sanitizeBlocker(blocker)).toBe(blocker)
    }
    for (const value of ["observed", "not-filtering", "unverified", "unsupported", "error", "not-tested"]) {
      expect(sanitizeBlocker(`list-archived-filter:${value}`)).toBe(`list-archived-filter:${value}`)
    }
  })

  test("adversarial unknown blocker is reduced to unknown with no canary leakage", () => {
    const canary = "CANARY_SECRET_BLOCKER_VALUE_7f3a"
    expect(sanitizeBlocker(canary)).toBe("unknown")
    expect(sanitizeBlocker(`list-archived-filter:${canary}`)).toBe("unknown")
    expect(sanitizeBlocker(42)).toBe("unknown")
    const sanitized = sanitizeProbeResult({
      outcome: "blocked",
      blocker: canary,
      completedPhases: ["preflight"],
      api: {
        candidateLookup: "not-run", oldArchiveBefore: "active", candidateArchive: "unknown",
        archiveRequest: "not-run", archiveObserved: "unknown", archiveReadback: "not-tested",
        listFiltering: "not-tested", unarchiveReadback: "not-tested",
        oldContentRetained: "not-tested", candidateRetained: "not-tested", restartReadback: "not-tested",
      },
      fixture: { expected: { oldMessages: 2, candidateMessages: 3 } },
      native: { picker: "not-observed", route: "not-observed", composer: "not-tested" },
      safety: { ordinaryContinuation: "not-tested", permissionsForms: "not-tested", concurrency: "not-tested" },
    } as any)
    expect(sanitized.blocker).toBe("unknown")
    expect(JSON.stringify(sanitized)).not.toContain(canary)
  })
})

describe("OpenAPI archive feature gate", () => {
  test("accepts bounded local refs with archived input, list enum, and canonical time", () => {
    expect(verifyOpenApiArchiveContract(openapiDoc())).toBe(true)
  })

  test("returns E_UNSUPPORTED when PATCH archived, list enum, or time.archived is missing", () => {
    const noPatch = openapiDoc()
    delete (noPatch.paths["/api/session/{sessionID}"].patch.requestBody.content["application/json"].schema.properties.archived)
    expect(codeOf(() => verifyOpenApiArchiveContract(noPatch))).toBe("E_UNSUPPORTED")

    const badList = openapiDoc()
    badList.paths["/api/session"].get.parameters[0]!.schema.anyOf[0]!.enum = ["true"]
    expect(codeOf(() => verifyOpenApiArchiveContract(badList))).toBe("E_UNSUPPORTED")

    const noTimeArchive = openapiDoc()
    delete noTimeArchive.components.schemas["Session.Info"].properties.time.properties.archived
    expect(codeOf(() => verifyOpenApiArchiveContract(noTimeArchive))).toBe("E_UNSUPPORTED")
  })

  test("rejects a remote ref instead of resolving it", () => {
    const remote = openapiDoc()
    remote.paths["/api/session/{sessionID}"].patch.requestBody.content["application/json"].schema.properties.archived = {
      $ref: "https://example.invalid/schema.json#/archived",
    }
    expect(codeOf(() => verifyOpenApiArchiveContract(remote))).toBe("E_CONTRACT")
  })
})

describe("guarded request port integration", () => {
  test("maps 404 to E_NOT_FOUND and accepts archived true/false list query", async () => {
    const calls: string[] = []
    const port = createRequestPort({
      password: PASSWORD,
      sessionIDs: [A, B],
      baseUrl: "http://127.0.0.1:4096",
      fetch: async (url: string | URL) => {
        calls.push(String(url))
        if (String(url).includes("/api/session?")) return json({ data: [] })
        return json({ error: "synthetic" }, 404)
      },
    })

    expect(await rejectionCode(port({ method: "GET", path: `/api/session/${A}` }))).toBe("E_NOT_FOUND")
    await port({ method: "GET", path: "/api/session?archived=true" })
    await port({ method: "GET", path: "/api/session?archived=false" })
    expect(await rejectionCode(port({ method: "GET", path: "/api/session?archived=maybe" }))).toBe(
      "E_ALLOWLIST",
    )
    expect(calls.some((url) => url.includes("archived=true"))).toBe(true)
    expect(calls.some((url) => url.includes("archived=false"))).toBe(true)
  })
})

describe("entry wiring with fake guarded port", () => {
  test("seeds old root, runs archive flow, then verifies readonly restart snapshot", async () => {
    const ids = generateFixtureIDs()
    const fake = createFakePort()
    const callbacks = createEntryCallbacks({ ids })
    const directory = "/run/sessionport/run-test"

    const probe = await callbacks.probe({
      request: fake.port,
      sessionIDs: [ids.oldRootID, ids.candidateID],
      profileDir: directory,
      phase: "first",
    })

    expect((probe as { outcome: string }).outcome).toBe("api-verified")
    expect((probe as { native: { picker: string } }).native.picker).toBe("not-observed")
    expect((probe as { ordinaryContinuation: string }).ordinaryContinuation).toBe("not-tested")
    expect(JSON.stringify(probe)).not.toContain(SYNTHETIC_TAIL_TEXT)

    const oldImportIndex = fake.calls.findIndex(
      (call) => call.method === "POST" && call.body?.info?.id === ids.oldRootID,
    )
    const candidateLookupIndex = fake.calls.findIndex(
      (call) => call.method === "GET" && call.path === `/api/session/${ids.candidateID}`,
    )
    const candidateImportIndex = fake.calls.findIndex(
      (call) => call.method === "POST" && call.body?.info?.id === ids.candidateID,
    )
    expect(oldImportIndex).toBeGreaterThan(-1)
    expect(candidateLookupIndex).toBeGreaterThan(oldImportIndex)
    expect(candidateImportIndex).toBeGreaterThan(candidateLookupIndex)

    const snapshotStart = fake.calls.length
    const readonlyCalls: string[] = []
    const readonly: GuardedRequest = async (spec) => {
      readonlyCalls.push(spec.method)
      if (spec.method !== "GET") throw new LifecycleError("E_READONLY")
      return fake.port(spec)
    }
    const snapshot = await callbacks.snapshot({
      request: readonly,
      sessionIDs: [ids.oldRootID, ids.candidateID],
      profileDir: directory,
      phase: "restart-readonly",
    })

    expect((snapshot as { status: string }).status).toBe("verified")
    expect((snapshot as { nativeUi: string }).nativeUi).toBe("not-observed")
    expect((snapshot as { ordinaryContinuation: string }).ordinaryContinuation).toBe("not-tested")
    expect((snapshot as { permissionsForms: string }).permissionsForms).toBe("not-tested")
    expect((snapshot as { oldMessageCount: number }).oldMessageCount).toBe(2)
    expect((snapshot as { candidateMessageCount: number }).candidateMessageCount).toBe(3)
    expect((snapshot as { distinctTail: boolean }).distinctTail).toBe(true)
    expect(JSON.stringify(snapshot)).not.toContain(SYNTHETIC_TAIL_TEXT)
    expect(readonlyCalls.every((method) => method === "GET")).toBe(true)
    expect(fake.calls.slice(snapshotStart).some((call) => call.method !== "GET")).toBe(false)
    const messageCalls = fake.calls.filter((call) => /\/message(\?|$)/.test(call.path))
    expect(messageCalls.length).toBeGreaterThan(0)
    expect(messageCalls.every((call) => call.path.includes("order=asc"))).toBe(true)
  })

  test("snapshot 404 at new-info retains the fixed step and error category", async () => {
    const ids = generateFixtureIDs()
    const fake = createFakePort()
    const callbacks = createEntryCallbacks({ ids })
    const directory = "/run/sessionport/run-test"
    await callbacks.probe({
      request: fake.port,
      sessionIDs: [ids.oldRootID, ids.candidateID],
      profileDir: directory,
      phase: "first",
    })
    const request: GuardedRequest = async (spec) => {
      if (spec.method === "GET" && spec.path === `/api/session/${ids.candidateID}`) {
        throw Object.assign(new Error("synthetic 404"), { code: "not-found" })
      }
      return fake.port(spec)
    }
    const snapshot = await callbacks.snapshot({
      request,
      sessionIDs: [ids.oldRootID, ids.candidateID],
      profileDir: directory,
      phase: "restart-readonly",
    })
    expect((snapshot as { status: string }).status).toBe("failed")
    expect((snapshot as { step: string }).step).toBe("new-info")
    expect((snapshot as { errorCategory: string }).errorCategory).toBe("E_NOT_FOUND")
    const steps = (snapshot as { steps: Array<{ step: string; status: string }> }).steps
    expect(steps.map((entry) => entry.step)).toEqual(["old-info", "new-info"])
    expect(steps[0]!.status).toBe("ok")
    expect(steps[1]!.status).toBe("failed")
  })

  test("wrong contract prevents any import", async () => {
    const ids = generateFixtureIDs()
    const bad = openapiDoc()
    delete bad.paths["/api/session/{sessionID}"].patch.requestBody.content["application/json"].schema.properties.archived
    const fake = createFakePort(bad)
    const callbacks = createEntryCallbacks({ ids })

    expect(
      await rejectionCode(
        callbacks.probe({
          request: fake.port,
          sessionIDs: [ids.oldRootID, ids.candidateID],
          profileDir: "/run/sessionport/run-test",
          phase: "first",
        }),
      ),
    ).toBe("E_UNSUPPORTED")
    expect(fake.calls.some((call) => call.method === "POST")).toBe(false)
    expect(fake.calls.some((call) => call.method === "PATCH")).toBe(false)
  })

  test("wrong old-root initial canonical time blocks before candidate lookup", async () => {
    const ids = generateFixtureIDs()
    const fake = createFakePort(openapiDoc(), true)
    const callbacks = createEntryCallbacks({ ids })

    expect(
      await rejectionCode(
        callbacks.probe({
          request: fake.port,
          sessionIDs: [ids.oldRootID, ids.candidateID],
          profileDir: "/run/sessionport/run-test",
          phase: "first",
        }),
      ),
    ).toBe("E_OLD_TIME")
    expect(fake.calls.some((call) => call.method === "POST")).toBe(true)
    expect(fake.calls.some((call) => call.method === "GET" && call.path === `/api/session/${ids.candidateID}`)).toBe(
      false,
    )
  })

  test("server-stamped updated inside the import window is accepted before candidate flow", async () => {
    const ids = generateFixtureIDs()
    const fake = createFakePort(openapiDoc(), { clock: () => Date.now() })
    const callbacks = createEntryCallbacks({ ids })

    const probe = await callbacks.probe({
      request: fake.port,
      sessionIDs: [ids.oldRootID, ids.candidateID],
      profileDir: "/run/sessionport/run-test",
      phase: "first",
    })

    expect((probe as { outcome: string }).outcome).toBe("api-verified")
    const importCall = fake.calls.find(
      (call) => call.method === "POST" && call.body?.info?.id === ids.oldRootID,
    )
    const stored = fake.sessions.get(ids.oldRootID)
    expect(typeof stored.time.updated).toBe("number")
    expect(Number.isFinite(stored.time.updated)).toBe(true)
    expect(stored.time.updated).not.toBe(importCall!.body.info.time.updated)
    expect(stored.time.created).toBe(importCall!.body.info.time.created)
    expect(fake.calls.some((call) => call.method === "GET" && call.path === `/api/session/${ids.candidateID}`)).toBe(
      true,
    )
  })

  test("wrong created, replayed, future, nonfinite, or missing updated blocks before candidate", async () => {
    for (const timeMode of ["wrong-created", "replayed", "future", "nonfinite", "missing"] as const) {
      const ids = generateFixtureIDs()
      const fake = createFakePort(openapiDoc(), { timeMode })
      const callbacks = createEntryCallbacks({ ids })

      expect(
        await rejectionCode(
          callbacks.probe({
            request: fake.port,
            sessionIDs: [ids.oldRootID, ids.candidateID],
            profileDir: "/run/sessionport/run-test",
            phase: "first",
          }),
        ),
      ).toBe("E_OLD_TIME")
      expect(fake.calls.some((call) => call.method === "POST")).toBe(true)
      expect(
        fake.calls.some((call) => call.method === "GET" && call.path === `/api/session/${ids.candidateID}`),
      ).toBe(false)
      expect(fake.calls.some((call) => call.method === "PATCH")).toBe(false)
    }
  })

  test("old import payload is parentless and uses canonical Session.Info time", () => {
    const ids = generateFixtureIDs()
    const fixture = createSyntheticFixture({
      directory: "/run/sessionport/run-test",
      projectID: "m1-native-replacement-probe",
      ids,
      now: 1_700_000_000_000,
    })
    const payload = buildOldImportPayload(fixture)
    expect("parentID" in payload.info).toBe(false)
    expect(payload.info.time.created).toBe(1_700_000_000_000 - 5_000)
    expect(payload.info.time.updated).toBe(1_700_000_000_000 - 3_500)
    expect(payload.messages).toHaveLength(2)
    expect(payload.messages[0]!.id).toBe(ids.oldMessageIDs[0])
  })
})

type FakePortTimeMode = "server" | "replayed" | "future" | "nonfinite" | "missing" | "wrong-created"
type FakePortOptions = {
  corruptOldTime?: boolean
  clock?: () => number
  timeMode?: FakePortTimeMode
  hostProjectID?: string
  importProjectID?: string
  candidateProjectID?: string
}

function createFakePort(openapi: unknown = openapiDoc(), options: boolean | FakePortOptions = {}) {
  const opts: FakePortOptions = typeof options === "boolean" ? { corruptOldTime: options } : options
  const clock = opts.clock ?? (() => Date.now())
  const timeMode: FakePortTimeMode = opts.timeMode ?? (opts.corruptOldTime ? "replayed" : "server")
  let importCount = 0
  const calls: Array<{ method: string; path: string; body?: any }> = []
  const sessions = new Map<string, any>()
  const messages = new Map<string, any[]>()
  const port = async (spec: { method: string; path: string; body?: any }) => {
    calls.push({ method: spec.method, path: spec.path, body: spec.body })
    const url = new URL(spec.path, "http://127.0.0.1:4096")
    if (url.pathname === "/openapi.json") return openapi
    if (url.pathname === "/api/info") return { version: "2.1.3" }
    if (spec.method === "POST" && url.pathname === "/api/experimental/session/import") {
      const info = spec.body?.info
      if (!info || typeof info.id !== "string") throw new LifecycleError("E_ALLOWLIST")
      const now = clock()
      importCount += 1
      const isCandidate = importCount >= 2
      const canonicalProjectID = isCandidate && opts.candidateProjectID !== undefined
        ? opts.candidateProjectID
        : (opts.hostProjectID ?? info.projectID)
      const responseProjectID = isCandidate ? canonicalProjectID : (opts.importProjectID ?? canonicalProjectID)
      let created = info.time.created
      let updated: number | undefined = now
      if (timeMode === "replayed") updated = info.time.updated
      else if (timeMode === "future") updated = now + 60_000
      else if (timeMode === "nonfinite") updated = Number.NaN
      else if (timeMode === "missing") updated = undefined
      else if (timeMode === "wrong-created") created = info.time.created + 1
      const time: { created: number; updated?: number; idle: number } = {
        created,
        updated,
        idle: info.time.idle,
      }
      if (timeMode === "missing") delete time.updated
      sessions.set(info.id, {
        id: info.id,
        projectID: canonicalProjectID,
        title: info.title,
        location: info.location,
        time,
      })
      messages.set(
        info.id,
        (spec.body.messages ?? []).map((message: any) => ({
          ...message,
          time: { ...message.time },
          ...(message.content ? { content: message.content.map((part: any) => ({ ...part })) } : {}),
        })),
      )
      return { data: { id: info.id, projectID: responseProjectID } }
    }
    if (spec.method === "PATCH" && /^\/api\/session\/ses_[0-9a-f]{64}$/.test(url.pathname)) {
      const id = url.pathname.split("/").pop()!
      const session = sessions.get(id)
      if (!session) throw new LifecycleError("E_NOT_FOUND")
      if (spec.body?.archived === true) session.time.archived = 1
      else delete session.time.archived
      return { data: session }
    }
    if (spec.method === "GET" && url.pathname === "/api/session") {
      const archived = url.searchParams.get("archived")
      const list = [...sessions.values()].filter((session) =>
        archived === "true" ? session.time?.archived !== undefined : session.time?.archived === undefined,
      )
      return { data: list, cursor: { next: null } }
    }
    if (spec.method === "GET" && /^\/api\/session\/ses_[0-9a-f]{64}$/.test(url.pathname)) {
      const id = url.pathname.split("/").pop()!
      const session = sessions.get(id)
      if (!session) throw new LifecycleError("E_NOT_FOUND")
      return { data: session }
    }
    if (
      spec.method === "GET" &&
      /^\/api\/session\/ses_[0-9a-f]{64}\/message$/.test(url.pathname)
    ) {
      const id = url.pathname.split("/")[3]!
      const list = messages.get(id) ?? []
      return { data: url.searchParams.get("order") === "asc" ? list : [...list].reverse() }
    }
    throw new LifecycleError("E_ALLOWLIST")
  }
  return { port, calls, sessions, messages }
}
