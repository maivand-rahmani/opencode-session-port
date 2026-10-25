import { describe, expect, test } from "bun:test"
import { createRequestPort, LifecycleError } from "../lifecycle/runner.mjs"
import {
  buildFrozenFixture,
  generateFixtureIDs,
  nativeImportBody,
  verifyGraph,
  verifyReferenceClosure,
  type FrozenFixture,
  type Observation,
  type ObservedSession,
} from "./graph.ts"
import { detectGraphFeatures } from "./schema.ts"
import {
  createGraphGuard,
  exitCodeForResult,
  finalizeGraphRun,
  parseMessage,
  parseSession,
} from "./entry.ts"

const DIRECTORY = "/run/sessionport/run-graph-test"
const PROJECT = "host-graph-project"

function ids() {
  const make = (prefix: string, char: string) => `${prefix}_${char.repeat(64)}`
  return {
    root: make("ses", "a"),
    child: make("ses", "b"),
    grandchild: make("ses", "c"),
    fork: make("ses", "d"),
    rootMessages: [make("msg", "1"), make("msg", "2")],
    childMessages: [make("msg", "3"), make("msg", "4")],
    grandchildMessages: [make("msg", "5"), make("msg", "6")],
    forkMessages: [make("msg", "7"), make("msg", "8")],
    toolParts: ["prt_completed", "prt_error"],
  } as ReturnType<typeof generateFixtureIDs>
}

function openapi(options: { fork?: boolean; revert?: boolean; toolError?: boolean; list?: boolean } = {}) {
  const withFork = options.fork ?? true
  const withRevert = options.revert ?? true
  const withToolError = options.toolError ?? true
  const schemas: Record<string, unknown> = {
    "Session.ID": { type: "string" },
    "Project.ID": { type: "string" },
    "Session.Message.ID": { type: "string" },
    "Session.ForkBoundary": {
      anyOf: [
        {
          type: "object",
          properties: { type: { type: "string", enum: ["before"] }, messageID: { $ref: "#/components/schemas/Session.Message.ID" } },
          required: ["type", "messageID"],
        },
        {
          type: "object",
          properties: { type: { type: "string", enum: ["through"] }, messageID: { $ref: "#/components/schemas/Session.Message.ID" } },
          required: ["type", "messageID"],
        },
      ],
    },
    "Session.Revert": {
      type: "object",
      properties: { messageID: { $ref: "#/components/schemas/Session.Message.ID" } },
      required: ["messageID"],
    },
    "Session.Message.User": {
      type: "object",
      properties: {
        id: { $ref: "#/components/schemas/Session.Message.ID" },
        type: { type: "string", enum: ["user"] },
        text: { type: "string" },
        time: { type: "object", properties: { created: { type: "number" } }, required: ["created"] },
      },
      required: ["id", "type", "text", "time"],
    },
    "Tool.Content": {
      anyOf: [
        { type: "object", properties: { type: { type: "string", enum: ["text"] }, text: { type: "string" } }, required: ["type", "text"] },
        { type: "object", properties: { type: { type: "string", enum: ["file"] }, uri: { type: "string" } }, required: ["type", "uri"] },
      ],
    },
    "ToolState.Completed": {
      type: "object",
      properties: {
        status: { type: "string", enum: ["completed"] },
        input: { type: "object" },
        content: { type: "array", items: { $ref: "#/components/schemas/Tool.Content" } },
      },
      required: ["status", "input", "content"],
    },
    "ToolState.Error": {
      type: "object",
      properties: {
        status: { type: "string", enum: ["error"] },
        input: { type: "object" },
        error: { type: "object" },
      },
      required: ["status", "input", "error"],
    },
    "Session.Message.Assistant.Text": {
      type: "object",
      properties: { type: { type: "string", enum: ["text"] }, text: { type: "string" } },
      required: ["type", "text"],
    },
    "Session.Message.Assistant.Tool": {
      type: "object",
      properties: {
        type: { type: "string", enum: ["tool"] },
        id: { type: "string" },
        name: { type: "string" },
        state: {
          anyOf: [
            { $ref: "#/components/schemas/ToolState.Completed" },
            ...(withToolError ? [{ $ref: "#/components/schemas/ToolState.Error" }] : []),
          ],
        },
        time: { type: "object" },
      },
      required: ["type", "id", "name", "state", "time"],
    },
    "Session.Message.Assistant": {
      type: "object",
      properties: {
        id: { $ref: "#/components/schemas/Session.Message.ID" },
        type: { type: "string", enum: ["assistant"] },
        agent: { type: "string" },
        model: { type: "object" },
        content: {
          type: "array",
          items: {
            anyOf: [
              { $ref: "#/components/schemas/Session.Message.Assistant.Text" },
              { $ref: "#/components/schemas/Session.Message.Assistant.Tool" },
            ],
          },
        },
        time: {
          type: "object",
          properties: { created: { type: "number" }, completed: { type: "number" } },
          required: ["created"],
        },
      },
      required: ["id", "type", "agent", "model", "content", "time"],
    },
    "Session.Message.Info": {
      anyOf: [
        { $ref: "#/components/schemas/Session.Message.User" },
        { $ref: "#/components/schemas/Session.Message.Assistant" },
      ],
    },
    "Session.Info": {
      type: "object",
      properties: {
        id: { $ref: "#/components/schemas/Session.ID" },
        parentID: { $ref: "#/components/schemas/Session.ID" },
        ...(withFork
          ? {
              fork: {
                type: "object",
                properties: {
                  sessionID: { $ref: "#/components/schemas/Session.ID" },
                  boundary: { $ref: "#/components/schemas/Session.ForkBoundary" },
                },
                required: ["sessionID", "boundary"],
              },
            }
          : {}),
        ...(withRevert ? { revert: { $ref: "#/components/schemas/Session.Revert" } } : {}),
        projectID: { $ref: "#/components/schemas/Project.ID" },
        cost: { type: "number" },
        tokens: { type: "object" },
        time: { type: "object" },
        title: { type: "string" },
        location: { type: "object" },
      },
      required: ["id", "projectID", "cost", "tokens", "time", "location"],
    },
    SessionMessagesResponse: {
      type: "object",
      properties: {
        data: { type: "array", items: { $ref: "#/components/schemas/Session.Message.Info" } },
        cursor: { type: "object" },
      },
    },
  }
  return {
    openapi: "3.1.0",
    paths: {
      "/api/experimental/session/import": {
        post: {
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    info: { $ref: "#/components/schemas/Session.Info" },
                    messages: { type: "array" },
                    location: { type: "object" },
                  },
                  required: ["info", "messages"],
                },
              },
            },
          },
        },
      },
      ...(options.list === false
        ? {}
        : {
            "/api/session/{sessionID}/message": {
              get: {
                responses: {
                  200: {
                    content: {
                      "application/json": {
                        schema: { $ref: "#/components/schemas/SessionMessagesResponse" },
                      },
                    },
                  },
                },
              },
            },
          }),
    },
    components: { schemas },
  }
}

function fixture(): FrozenFixture {
  const features = detectGraphFeatures(openapi())
  expect(features.importsAllowed).toBe(true)
  expect(features.fork).toBe(true)
  expect(features.revert).toBe(true)
  expect(features.toolCompleted).toBe(true)
  expect(features.toolError).toBe(true)
  expect(features.messageSource).toBe("session-message-list")
  return buildFrozenFixture({
    ids: ids(),
    directory: DIRECTORY,
    features,
    now: 1_000_000,
    sentinelPath: `${DIRECTORY}/.graph-sentinel`,
  })
}

function observation(frozen: FrozenFixture): Observation {
  return {
    sessions: frozen.sessions.map((session, index): ObservedSession => ({
      id: session.id,
      parentID: session.parentID,
      fork: session.fork,
      revert: session.revert,
      projectID: PROJECT,
      importedProject: PROJECT,
      title: session.title,
      created: session.created,
      updated: session.created + 10,
      directory: DIRECTORY,
      window: { started: session.created + 9, finished: session.created + 11 + index },
    })),
    messages: Object.fromEntries(
      frozen.sessions.map((session) => [session.id, structuredClone(session.messages)]),
    ),
  }
}

describe("schema feature detection", () => {
  test("accepts the candidate fork, revert, and tool shapes", () => {
    const features = detectGraphFeatures(openapi())
    expect(features.unsupported).toEqual([])
    expect(features.importsAllowed).toBe(true)
  })

  test("classifies absent fork and tool-error shapes as unsupported instead of success", () => {
    const features = detectGraphFeatures(openapi({ fork: false, revert: false, toolError: false }))
    expect(features.importsAllowed).toBe(true)
    expect(features.fork).toBe(false)
    expect(features.revert).toBe(false)
    expect(features.toolError).toBe(false)
    expect(features.unsupported).toContain("session.import.info.fork")
    expect(features.unsupported).toContain("session.import.info.revert")
    expect(features.unsupported).toContain("session.message.tool.error")
  })

  test("cannot infer messages without import items or the message-list schema", () => {
    const features = detectGraphFeatures(openapi({ list: false }))
    expect(features.messageSource).toBe("missing")
    expect(features.importsAllowed).toBe(false)
  })
})

describe("frozen graph fixture and readback projection", () => {
  test("native import bodies use parent/fork/revert schema fields and no forkID", () => {
    const frozen = fixture()
    const body = nativeImportBody(frozen.sessions[3]!, frozen)
    const info = body.info as Record<string, unknown>
    expect(info.parentID).toBeUndefined()
    expect(info.fork).toEqual({
      sessionID: frozen.sessions[0]!.id,
      boundary: { type: "through", messageID: frozen.sessions[0]!.messages[1]!.id },
    })
    expect(info.forkID).toBeUndefined()
    expect(frozen.sessions[2]!.revert).toEqual({ messageID: frozen.sessions[2]!.messages[0]!.id })
  })

  test("verifies the exact root-child-grandchild, fork, revert, and tool-part projection", () => {
    const frozen = fixture()
    const result = verifyGraph(frozen, observation(frozen))
    expect(result.failure).toBeNull()
    expect(result.verified).toBe(true)
    expect(result.components).toMatchObject({
      parentChain: true,
      fork: true,
      revert: true,
      toolCompleted: true,
      toolError: true,
      payloadHashes: true,
      project: true,
      time: true,
      location: true,
    })
    expect(result.refs).toMatchObject({ known: true, dangling: 0, unknown: 0, parentRefs: 2, forkRefs: 1, revertRefs: 1 })
  })

  test("rejects a tool-part payload mismatch by hash/projection", () => {
    const frozen = fixture()
    const observed = observation(frozen)
    const assistant = observed.messages[frozen.sessions[0]!.id]![1]!
    if (assistant.type !== "assistant") throw new Error("fixture")
    const tool = assistant.content.find((part) => part.type === "tool")!
    if (tool.type !== "tool" || tool.state.status !== "completed") throw new Error("fixture")
    tool.state.input = { command: "echo changed" }
    const result = verifyGraph(frozen, observed)
    expect(result.verified).toBe(false)
    expect(result.failure).toBe("E_GRAPH_PARTS")
  })

  test("rejects a message content/order mismatch", () => {
    const frozen = fixture()
    const observed = observation(frozen)
    const messages = observed.messages[frozen.sessions[1]!.id]!
    messages[0] = { ...messages[0]!, text: "changed" }
    expect(verifyGraph(frozen, observed).failure).toBe("E_GRAPH_MESSAGES")
  })

  test("classifies a dropped fork reference as unsupported, never verified", () => {
    const frozen = fixture()
    const observed = observation(frozen)
    observed.sessions.find((session) => session.id === frozen.sessions[3]!.id)!.fork = null
    const result = verifyGraph(frozen, observed)
    expect(result.failure).toBeNull()
    expect(result.verified).toBe(false)
    expect(result.components.fork).toBe(false)
    expect(result.unsupported).toContain("session.import.info.fork.persistence")
  })

  test("rejects a host project mismatch", () => {
    const frozen = fixture()
    const observed = observation(frozen)
    observed.sessions[0]!.importedProject = "different-project"
    expect(verifyGraph(frozen, observed).failure).toBe("E_GRAPH_PROJECT")
  })
})

describe("graph reference closure", () => {
  test("rejects unknown parent references", () => {
    const frozen = fixture()
    const observed = observation(frozen)
    observed.sessions[1]!.parentID = `ses_${"f".repeat(64)}`
    const closure = verifyReferenceClosure(observed.sessions, observed.messages)
    expect(closure.known).toBe(false)
    expect(closure.unknown).toBeGreaterThan(0)
    expect(verifyGraph(frozen, observed).failure).toBe("E_GRAPH_UNKNOWN_REF")
  })

  test("rejects a dangling fork boundary message", () => {
    const frozen = fixture()
    const observed = observation(frozen)
    observed.sessions[3]!.fork = { sessionID: frozen.sessions[0]!.id, boundary: { type: "through", messageID: `msg_${"f".repeat(64)}` } }
    const closure = verifyReferenceClosure(observed.sessions, observed.messages)
    expect(closure.known).toBe(false)
    expect(closure.dangling).toBe(1)
    expect(verifyGraph(frozen, observed).failure).toBe("E_GRAPH_DANGLING_REF")
  })

  test("rejects a dangling revert reference", () => {
    const frozen = fixture()
    const observed = observation(frozen)
    observed.sessions[2]!.revert = { messageID: `msg_${"f".repeat(64)}` }
    expect(verifyReferenceClosure(observed.sessions, observed.messages).dangling).toBe(1)
  })

  test("rejects duplicate session IDs", () => {
    const frozen = fixture()
    const observed = observation(frozen)
    observed.sessions.push(structuredClone(observed.sessions[0]!))
    expect(verifyGraph(frozen, observed).failure).toBe("E_GRAPH_DUPLICATE")
  })
})

describe("request guard", () => {
  test("the real lifecycle request port denies DELETE/PATCH/import in readonly mode", async () => {
    const A = `ses_${"a".repeat(64)}`
    const B = `ses_${"b".repeat(64)}`
    let calls = 0
    const port = createRequestPort({
      fetch: async () => {
        calls += 1
        return new Response("{}", { status: 200 })
      },
      password: "p".repeat(32),
      sessionIDs: [A, B],
      baseUrl: "http://127.0.0.1:4096",
      readonly: true,
    })
    for (const spec of [
      { method: "DELETE", path: `/api/session/${A}` },
      { method: "PATCH", path: `/api/session/${A}`, body: { archived: true } },
      {
        method: "POST",
        path: "/api/experimental/session/import",
        body: { info: { id: A }, messages: [] },
      },
    ]) {
      await expect(port(spec)).rejects.toMatchObject({ code: "E_READONLY" })
    }
    expect(calls).toBe(0)
  })

  test("the graph guard allows only bounded imports and owned GETs, never deletes", async () => {
    const frozen = fixture()
    const calls: Array<{ port: string; method: string; path: string }> = []
    const makePort = (name: string, sessionIDs: string[]) => ({
      sessionIDs,
      request: async (spec: { method: string; path: string }) => {
        calls.push({ port: name, method: spec.method, path: spec.path })
        return { data: {} }
      },
    })
    const all = frozen.sessions.map((session) => session.id)
    const guard = createGraphGuard(
      [
        makePort("first", [all[0]!, all[1]!]),
        makePort("second", [all[2]!, all[3]!]),
      ],
      all,
    )
    for (const spec of [
      { method: "DELETE", path: `/api/session/${all[0]}` },
      { method: "PATCH", path: `/api/session/${all[0]}`, body: { archived: true } },
      { method: "POST", path: `/api/session/${all[0]}/fork`, body: {} },
      {
        method: "POST",
        path: "/api/experimental/session/import",
        body: { info: { id: `ses_${"f".repeat(64)}` }, messages: [] },
      },
    ]) {
      await expect(guard.request(spec)).rejects.toBeInstanceOf(LifecycleError)
    }
    expect(calls).toHaveLength(0)
    expect(guard.counts.rejectedMutations).toBe(4)

    await guard.request({ method: "POST", path: "/api/experimental/session/import", body: { info: { id: all[2] }, messages: [] } })
    expect(calls.at(-1)).toMatchObject({ port: "second", method: "POST" })
    await expect(
      guard.request({ method: "POST", path: "/api/experimental/session/import", body: { info: { id: all[2] }, messages: [] } }),
    ).rejects.toMatchObject({ code: "E_READONLY" })
    await guard.request({ method: "GET", path: `/api/session/${all[3]}` })
    expect(calls.at(-1)).toMatchObject({ port: "second", method: "GET" })
    await expect(guard.request({ method: "GET", path: "/api/session/unknown" })).rejects.toMatchObject({ code: "E_ALLOWLIST" })
    expect(guard.counts.imports).toBe(1)
  })
})

describe("combined status gate", () => {
  const base = () => ({
    status: "ok",
    cleanup: "profile-removed",
    probeFailure: null,
    snapshot: { status: "not-run" },
    snapshotReason: "probe-not-verified",
    probe: {
      outcome: "graph-verified",
      verified: true,
      sideEffect: { sentinelAbsent: true },
    },
  })

  test("accepts only graph-verified plus profile cleanup and no restart uncertainty", () => {
    const result = finalizeGraphRun(base())
    expect(result.status).toBe("ok")
    expect(result.outcome).toBe("graph-readback-verified")
    expect(exitCodeForResult(result)).toBe(0)
  })

  test("does not interpret runner status ok alone as graph success", () => {
    const run = base()
    run.probe.outcome = "graph-partial"
    run.probe.verified = false
    const result = finalizeGraphRun(run)
    expect(result.status).toBe("failed")
    expect(exitCodeForResult(result)).toBe(1)
  })

  test("requires verified cleanup and an absent side-effect sentinel", () => {
    const retained = base()
    retained.cleanup = "retained"
    expect(finalizeGraphRun(retained).status).toBe("failed")
    const sentinel = base()
    sentinel.probe.sideEffect.sentinelAbsent = false
    expect(finalizeGraphRun(sentinel).status).toBe("failed")
  })
})

describe("wire projection parsing", () => {
  test("parses the frozen session and exact tool parts without retaining extra fields", () => {
    const frozen = fixture()
    const root = frozen.sessions[0]!
    const parsedSession = parseSession(
      {
        id: root.id,
        projectID: PROJECT,
        title: root.title,
        time: { created: root.created, updated: root.created + 10 },
        location: { directory: DIRECTORY },
      },
      DIRECTORY,
    )
    expect(parsedSession.parentID).toBeNull()
    const assistant = root.messages[1]!
    if (assistant.type !== "assistant") throw new Error("fixture")
    const parsed = parseMessage({
      id: assistant.id,
      type: "assistant",
      agent: assistant.agent,
      model: assistant.model,
      time: assistant.time,
      content: assistant.content,
    })
    expect(parsed).toEqual(assistant)
    expect(() => parseMessage({ ...assistant, extra: true })).toThrow()
  })

  test("parseMessage rejects abandoned tool states", () => {
    const frozen = fixture()
    const assistant = frozen.sessions[0]!.messages[1]!
    if (assistant.type !== "assistant") throw new Error("fixture")
    const content = structuredClone(assistant.content) as unknown[]
    const tool = content.find((part): part is Record<string, unknown> => {
      return typeof part === "object" && part !== null && (part as { type?: string }).type === "tool"
    })!
    tool.state = { status: "running", input: {}, metadata: {} }
    expect(() => parseMessage({ ...assistant, content })).toThrow()
  })
})
