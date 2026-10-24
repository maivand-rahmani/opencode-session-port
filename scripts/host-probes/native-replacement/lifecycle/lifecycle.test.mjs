import test from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import {
  AUTH_ENV, LIMITS, PINNED, REQUIRED_OPENAPI, LifecycleError, buildChildEnv,
  createRequestPort, lifecycleEnvKeys, verifyOpenApi, withIsolatedHost,
} from "./runner.mjs"
import { PlanError, buildDockerRunPlan, verifyDockerRunPlan } from "./launch-plan.mjs"

const A = `ses_${"a".repeat(64)}`
const B = `ses_${"b".repeat(64)}`
const C = `ses_${"c".repeat(64)}`
const PASSWORD = "p".repeat(43)

function requiredDoc() {
  const paths = {}
  for (const [path, methods] of Object.entries(REQUIRED_OPENAPI)) {
    paths[path] = Object.fromEntries(methods.map((method) => [method, {}]))
  }
  return { openapi: "3.1.0", paths }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function makeFetch({ info = { version: PINNED.version }, openapi = requiredDoc(), statuses = {}, overrides = {} } = {}) {
  const calls = []
  const fetch = async (url, init = {}) => {
    const parsed = new URL(url)
    calls.push({ path: parsed.pathname, search: parsed.search, method: init.method ?? "GET", init })
    if (overrides[parsed.pathname]) return overrides[parsed.pathname]
    if (statuses[parsed.pathname]) return json({ error: "synthetic" }, statuses[parsed.pathname])
    if (parsed.pathname === "/api/info") return json(info)
    if (parsed.pathname === "/openapi.json") return json(openapi)
    return json({ data: [] })
  }
  fetch.calls = calls
  return fetch
}

class FakeChild extends EventEmitter {
  constructor({ stop = "ok" } = {}) {
    super()
    this.exitCode = null
    this.signalCode = null
    this.stop = stop
    this.stdout = new EventEmitter()
    this.stderr = new EventEmitter()
    this.killed = []
  }
  kill(signal) {
    this.killed.push(signal)
    if (this.stop === "ok") {
      this.exitCode = 0
      this.emit("exit", 0, null)
    }
    if (this.stop === "signal") {
      this.signalCode = signal
      this.emit("exit", null, signal)
    }
  }
}

function makeSpawn(behaviors = ["ok", "ok"]) {
  const calls = []
  const children = []
  const spawn = (command, args, options) => {
    calls.push({ command, args, options })
    const child = new FakeChild({ stop: behaviors[calls.length - 1] ?? "ok" })
    children.push(child)
    return child
  }
  spawn.calls = calls
  spawn.children = children
  return spawn
}

function makeFs() {
  const calls = { mkdir: [], rm: [] }
  return {
    calls,
    fs: {
      async mkdir(path, options) { calls.mkdir.push({ path, options }) },
      async rm(path, options) { calls.rm.push({ path, options }) },
    },
  }
}

function makeClock() {
  let time = 0
  return { now: () => time, sleep: async (ms) => { time += ms } }
}

function makeRandom() {
  let counter = 0
  return (size) => {
    counter += 1
    return Buffer.alloc(size, counter)
  }
}

function config(overrides = {}) {
  return {
    sessionIDs: [A, B],
    binaryPath: "/usr/local/bin/opencode",
    profileBase: "/run/sessionport",
    limits: { readyTimeoutMs: 1_000, stopTimeoutMs: 100, stopPollMs: 10, requestTimeoutMs: 1_000 },
    ...overrides,
  }
}

const probe = async ({ request }) => {
  await request({ method: "GET", path: "/api/info" })
  await request({
    method: "POST",
    path: "/api/experimental/session/import",
    body: { info: { id: A }, messages: [] },
  })
  await request({ method: "PATCH", path: `/api/session/${A}`, body: { archived: true } })
  return { outcome: "api-verified", restartManifestReady: true, imported: true }
}

const snapshot = async ({ request }) => {
  await request({ method: "GET", path: `/api/session/${B}/message?order=asc&limit=10` })
  return { status: "verified", steps: [{ step: "new-messages", status: "ok", count: 0 }] }
}

function deps({ spawn = makeSpawn(), fetch = makeFetch(), fs = makeFs(), clock = makeClock(), random = makeRandom(), generatePassword } = {}) {
  return {
    spawn, fetch, fs: fs.fs, now: clock.now, sleep: clock.sleep, randomBytes: random,
    ...(generatePassword ? { generatePassword } : {}),
    fsCalls: fs.calls,
  }
}

test("successful first run, verified stop, same-profile restart, readonly snapshot, cleanup", async () => {
  const spawn = makeSpawn(["ok", "ok"])
  const fetch = makeFetch()
  const fs = makeFs()
  const d = deps({ spawn, fetch, fs })
  const result = await withIsolatedHost(config({ snapshot }), probe, d)

  assert.equal(result.status, "ok")
  assert.equal(result.probe.outcome, "api-verified")
  assert.deepEqual(result.snapshot, { status: "verified", steps: [{ step: "new-messages", status: "ok", count: 0 }] })
  assert.equal(result.cleanup, "profile-removed")
  assert.equal(spawn.calls.length, 2)
  assert.equal(fs.calls.rm.length, 1)
  assert.equal(fs.calls.rm[0].path, spawn.calls[0].options.cwd)
  assert.equal(spawn.calls[1].options.cwd, spawn.calls[0].options.cwd)
  assert.deepEqual(spawn.calls[0].args, ["serve", "--hostname", "127.0.0.1", "--port", "4096"])
  assert.equal(spawn.calls[0].options.shell, false)

  const env = spawn.calls[0].options.env
  assert.deepEqual(Object.keys(env).sort(), [...lifecycleEnvKeys, AUTH_ENV.primary].sort())
  assert.equal(env.PATH, "/usr/local/bin:/usr/bin:/bin")
  assert.equal(env.OPENCODE_CONFIG_PROJECT_DISABLE, "1")
  assert.equal(env.OPENCODE_DISABLE_CLAUDE_CODE, "1")
  assert.equal(env.OPENCODE_DISABLE_MODELS_FETCH, "1")
  assert.ok(env.HOME.startsWith("/run/sessionport/run-"))
  assert.ok(env.OPENCODE_PASSWORD.length >= 32)
  assert.equal(env.OPENCODE_SERVER_PASSWORD, undefined)
  assert.equal(env.OPENAI_API_KEY, undefined)
  assert.ok(!JSON.stringify(result).includes(env.OPENCODE_PASSWORD))
  assert.equal(Object.values(result.childOutput).some((value) => typeof value === "string"), false)
  assert.equal(result.childOutput.stdoutPresent, false)
  assert.equal(result.childOutput.stderrPresent, false)
  assert.equal(result.childOutput.stdoutBytes, 0)
  assert.equal(result.childOutput.stderrBytes, 0)
})

test("child output is metadata-only and never retains split secrets or raw fragments", async () => {
  const spawn = makeSpawn()
  const encoded = Buffer.from(`opencode:${PASSWORD}`).toString("base64")
  const wrapped = (command, args, options) => {
    const child = spawn(command, args, options)
    queueMicrotask(() => {
      child.stdout.emit("data", `password=${PASSWORD.slice(0, 7)}`)
      child.stdout.emit("data", `${PASSWORD.slice(7)} Authorization: Basic ${encoded.slice(0, 11)}`)
      child.stdout.emit("data", encoded.slice(11))
      child.stderr.emit("data", "x".repeat(LIMITS.maxLogBytes + 10))
    })
    return child
  }
  wrapped.calls = spawn.calls
  wrapped.children = spawn.children
  const d = deps({ spawn: wrapped, generatePassword: () => PASSWORD })
  const result = await withIsolatedHost(config({ snapshot }), probe, d)
  const serialized = JSON.stringify(result)

  for (const fragment of [PASSWORD, PASSWORD.slice(0, 7), encoded, encoded.slice(0, 11), "Authorization"]) {
    assert.ok(!serialized.includes(fragment))
  }
  assert.equal("logs" in result, false)
  assert.equal(Object.values(result.childOutput).some((value) => typeof value === "string"), false)
  assert.equal(result.childOutput.stdoutPresent, true)
  assert.ok(result.childOutput.stdoutBytes > 0)
  assert.equal(result.childOutput.stdoutOverflow, false)
  assert.equal(result.childOutput.stderrPresent, true)
  assert.equal(result.childOutput.stderrOverflow, true)
  assert.equal(result.childOutput.stderrBytes, LIMITS.maxLogBytes)
})

test("signal-terminated owned stop is verified and allows cleanup", async () => {
  const spawn = makeSpawn(["signal", "signal"])
  const d = deps({ spawn })
  const result = await withIsolatedHost(config({ snapshot }), probe, d)
  assert.equal(result.status, "ok")
  assert.equal(spawn.calls.length, 2)
  assert.equal(d.fsCalls.rm.length, 1)
})

test("wrong pinned version blocks the probe", async () => {
  const spawn = makeSpawn()
  const d = deps({ spawn, fetch: makeFetch({ info: { version: "2.1.4" } }) })
  let probed = false
  await assert.rejects(
    withIsolatedHost(config(), async () => { probed = true }, d),
    (error) => error instanceof LifecycleError && error.code === "E_VERSION",
  )
  assert.equal(probed, false)
  assert.equal(spawn.calls.length, 1)
  assert.equal(d.fsCalls.rm.length, 1)
})

test("missing OpenAPI contract paths block the probe", async () => {
  const spawn = makeSpawn()
  const d = deps({ spawn, fetch: makeFetch({ openapi: { paths: { "/api/info": { get: {} } } } }) })
  let probed = false
  await assert.rejects(
    withIsolatedHost(config(), async () => { probed = true }, d),
    (error) => error.code === "E_CONTRACT",
  )
  assert.equal(probed, false)
  assert.equal(d.fsCalls.rm.length, 1)
})

test("authentication failure makes no import request and never reaches the probe", async () => {
  const spawn = makeSpawn()
  const fetch = makeFetch({ statuses: { "/api/info": 401 } })
  const d = deps({ spawn, fetch })
  let probed = false
  await assert.rejects(
    withIsolatedHost(config(), async () => { probed = true }, d),
    (error) => error.code === "E_AUTH",
  )
  assert.equal(probed, false)
  assert.equal(fetch.calls.some((call) => call.path.includes("import")), false)
})

test("response body cap aborts readiness without invoking the probe", async () => {
  const spawn = makeSpawn()
  const fetch = makeFetch({
    overrides: { "/api/info": new Response("x".repeat(2_000), { status: 200 }) },
  })
  const d = deps({ spawn, fetch })
  await assert.rejects(
    withIsolatedHost(config({ limits: { responseBodyBytes: 100 } }), probe, d),
    (error) => error.code === "E_BODY_CAP",
  )
})

test("request port enforces method/path allowlist and fresh synthetic ID scope", async () => {
  const fetch = makeFetch()
  const port = createRequestPort({ fetch, password: PASSWORD, sessionIDs: [A, B], baseUrl: "http://127.0.0.1:4096" })
  assert.deepEqual(await port({ method: "GET", path: "/api/info" }), { version: PINNED.version })
  await assert.rejects(port({ method: "POST", path: `/api/session/${A}/prompt` }), (e) => e.code === "E_ALLOWLIST")
  await assert.rejects(port({ method: "DELETE", path: `/api/session/${A}` }), (e) => e.code === "E_ALLOWLIST")
  await assert.rejects(port({ method: "PATCH", path: `/api/session/${C}`, body: { archived: true } }), (e) => e.code === "E_SCOPE")
  await assert.rejects(port({ method: "GET", path: "/api/session?unknown=1" }), (e) => e.code === "E_ALLOWLIST")
  await assert.rejects(port({ method: "GET", path: "http://example.invalid/api/info" }), (e) => e.code === "E_ALLOWLIST")
  await assert.rejects(port({ method: "GET", path: "/api/session/../api/info" }), (e) => e.code === "E_ALLOWLIST")
  await assert.rejects(port({ method: "GET", path: "/api/info#fragment" }), (e) => e.code === "E_ALLOWLIST")
  await assert.rejects(port({
    method: "POST", path: "/api/experimental/session/import",
    body: { info: { id: C }, messages: [] },
  }), (e) => e.code === "E_SCOPE")
  await assert.rejects(port({
    method: "POST", path: "/api/experimental/session/import",
    body: { info: { id: A }, messages: [{ id: "msg_not-synthetic" }] },
  }), (e) => e.code === "E_ALLOWLIST")
})

test("request port caps import bodies and readonly ports reject mutation", async () => {
  const fetch = makeFetch()
  const port = createRequestPort({ fetch, password: PASSWORD, sessionIDs: [A, B], baseUrl: "http://127.0.0.1:4096" })
  await assert.rejects(port({
    method: "POST", path: "/api/experimental/session/import",
    body: { info: { id: A }, messages: [], padding: "x".repeat(300_000) },
  }), (e) => e.code === "E_BODY_CAP")

  const readonly = createRequestPort({
    fetch, password: PASSWORD, sessionIDs: [A, B], baseUrl: "http://127.0.0.1:4096", readonly: true,
  })
  await assert.rejects(readonly({ method: "PATCH", path: `/api/session/${A}`, body: { archived: false } }), (e) => e.code === "E_READONLY")
  await assert.rejects(readonly({
    method: "POST", path: "/api/experimental/session/import", body: { info: { id: A }, messages: [] },
  }), (e) => e.code === "E_READONLY")
  assert.deepEqual(await readonly({ method: "GET", path: "/api/info" }), { version: PINNED.version })
})

test("request port denies DELETE by default and allows only the configured frozen old ID", async () => {
  const fetch = makeFetch()
  const base = { fetch, password: PASSWORD, sessionIDs: [A, B], baseUrl: "http://127.0.0.1:4096" }
  const port = createRequestPort(base)
  await assert.rejects(port({ method: "DELETE", path: `/api/session/${A}` }), (e) => e.code === "E_ALLOWLIST")

  const deletePort = createRequestPort({ ...base, syntheticDeleteTarget: A })
  assert.deepEqual(await deletePort({ method: "DELETE", path: `/api/session/${A}` }), { data: [] })
  await assert.rejects(deletePort({ method: "DELETE", path: `/api/session/${B}` }), (e) => e.code === "E_SCOPE")
  await assert.rejects(deletePort({ method: "DELETE", path: `/api/session/${C}` }), (e) => e.code === "E_SCOPE")
  await assert.rejects(deletePort({ method: "DELETE", path: `/api/session/${A}?x=1` }), (e) => e.code === "E_ALLOWLIST")
  await assert.rejects(deletePort({ method: "DELETE", path: `/api/session/${A}`, body: {} }), (e) => e.code === "E_ALLOWLIST")
  await assert.rejects(deletePort({ method: "DELETE", path: `/api/session/${A}/message` }), (e) => e.code === "E_ALLOWLIST")
  const calls = fetch.calls.filter((call) => call.method === "DELETE")
  assert.equal(calls.length, 1)
  assert.equal(calls[0].path, `/api/session/${A}`)
  assert.equal(calls[0].search, "")
})

test("restart readonly port denies DELETE even when a target is configured", async () => {
  const readonly = createRequestPort({
    fetch: makeFetch(), password: PASSWORD, sessionIDs: [A, B],
    baseUrl: "http://127.0.0.1:4096", readonly: true, syntheticDeleteTarget: A,
  })
  await assert.rejects(readonly({ method: "DELETE", path: `/api/session/${A}` }), (e) => e.code === "E_READONLY")

  const fetch = makeFetch()
  const deletingProbe = async ({ request }) => {
    await request({ method: "DELETE", path: `/api/session/${A}` })
    return { outcome: "api-verified", restartManifestReady: true }
  }
  const deletingSnapshot = async ({ request }) =>
    request({ method: "DELETE", path: `/api/session/${A}` })
  const result = await withIsolatedHost(
    config({ syntheticDeleteTarget: A, snapshot: deletingSnapshot }),
    deletingProbe,
    deps({ fetch }),
  )
  assert.equal(result.snapshot.status, "failed")
  assert.equal(result.snapshot.errorCategory, "E_READONLY")
  assert.equal(fetch.calls.filter((call) => call.method === "DELETE").length, 1)
  assert.deepEqual(await readonly({ method: "GET", path: "/api/info" }), { version: PINNED.version })
})

test("delete capability target must equal the first frozen session ID", async () => {
  const spawn = makeSpawn()
  await assert.rejects(
    withIsolatedHost(config({ syntheticDeleteTarget: B }), probe, deps({ spawn })),
    (e) => e.code === "E_CONFIG",
  )
  assert.equal(spawn.calls.length, 0)
})

test("missing password is a fixed error and never leaks environment or starts a child", async () => {
  const spawn = makeSpawn()
  const d = deps({ spawn, generatePassword: () => "" })
  let error
  await assert.rejects(withIsolatedHost(config(), probe, d), (e) => {
    error = e
    return e.code === "E_AUTH_CONFIG"
  })
  assert.equal(spawn.calls.length, 0)
  assert.equal(error.message, "E_AUTH_CONFIG")
  assert.equal(JSON.stringify(error), JSON.stringify({ name: "LifecycleError", code: "E_AUTH_CONFIG" }))
  assert.equal(error.message.includes("OPENCODE_PASSWORD"), false)
})

test("first stop uncertainty retains the profile, facts, and blocks restart and cleanup", async () => {
  const spawn = makeSpawn(["fail", "ok"])
  const d = deps({ spawn })
  await assert.rejects(withIsolatedHost(config({ snapshot }), probe, d), (e) => {
    assert.equal(e.code, "E_STOP_UNCERTAIN")
    assert.equal(e.facts.probe.outcome, "api-verified")
    assert.equal(e.facts.snapshot, null)
    assert.equal(e.facts.stop.verified, false)
    assert.equal(e.facts.stop.phase, "first-stop")
    assert.equal(e.facts.cleanup, "retained")
    return true
  })
  assert.equal(spawn.calls.length, 1)
  assert.equal(d.fsCalls.rm.length, 0)
  assert.deepEqual(spawn.children[0].killed, ["SIGTERM"])
})

test("second stop uncertainty blocks cleanup and retains probe and snapshot facts", async () => {
  const spawn = makeSpawn(["ok", "fail"])
  const d = deps({ spawn })
  await assert.rejects(withIsolatedHost(config({ snapshot }), probe, d), (e) => {
    assert.equal(e.code, "E_STOP_UNCERTAIN")
    assert.equal(e.facts.probe.outcome, "api-verified")
    assert.equal(e.facts.snapshot.status, "verified")
    assert.equal(e.facts.stop.phase, "second-stop")
    assert.equal(e.facts.cleanup, "retained")
    return true
  })
  assert.equal(spawn.calls.length, 2)
  assert.equal(d.fsCalls.rm.length, 0)
})

test("readonly restart snapshot mutation fails closed with a fixed category and still stops", async () => {
  const spawn = makeSpawn(["ok", "ok"])
  const d = deps({ spawn })
  const mutate = async ({ request }) => request({
    method: "PATCH", path: `/api/session/${A}`, body: { archived: true },
  })
  const result = await withIsolatedHost(config({ snapshot: mutate }), probe, d)
  assert.equal(result.status, "ok")
  assert.equal(result.probe.outcome, "api-verified")
  assert.equal(result.snapshot.status, "failed")
  assert.equal(result.snapshot.step, "snapshot-callback")
  assert.equal(result.snapshot.errorCategory, "E_READONLY")
  assert.equal(spawn.calls.length, 2)
  assert.equal(d.fsCalls.rm.length, 1)
})

test("failed probe skips restart and snapshot and retains the reason", async () => {
  const spawn = makeSpawn(["ok"])
  const d = deps({ spawn })
  const failure = async () => { throw new LifecycleError("E_OLD_TIME") }
  const never = async () => { throw new Error("snapshot-must-not-run") }
  const result = await withIsolatedHost(config({ snapshot: never }), failure, d)
  assert.equal(result.status, "ok")
  assert.equal(result.probe, null)
  assert.equal(result.probeFailure.code, "E_OLD_TIME")
  assert.deepEqual(result.snapshot, { status: "not-run", reason: "probe-failed" })
  assert.equal(result.snapshotReason, "probe-failed")
  assert.equal(spawn.calls.length, 1)
  assert.equal(d.fsCalls.rm.length, 1)
})

test("snapshot step failure retains the first probe result and category", async () => {
  const spawn = makeSpawn(["ok", "ok"])
  const d = deps({ spawn })
  const failedSnapshot = async () => ({
    status: "failed", step: "new-info", errorCategory: "E_NOT_FOUND",
  })
  const result = await withIsolatedHost(config({ snapshot: failedSnapshot }), probe, d)
  assert.equal(result.status, "ok")
  assert.equal(result.probe.outcome, "api-verified")
  assert.equal(result.snapshot.status, "failed")
  assert.equal(result.snapshot.step, "new-info")
  assert.equal(result.snapshot.errorCategory, "E_NOT_FOUND")
  assert.equal(spawn.calls.length, 2)
})

test("message query without explicit ascending order is rejected", async () => {
  const port = createRequestPort({
    fetch: makeFetch(), password: PASSWORD, sessionIDs: [A, B],
    baseUrl: "http://127.0.0.1:4096", limits: LIMITS, readonly: true,
  })
  await assert.rejects(port({ method: "GET", path: `/api/session/${B}/message?limit=10` }), (e) => e.code === "E_ALLOWLIST")
  await assert.rejects(port({ method: "GET", path: `/api/session/${B}/message?order=desc` }), (e) => e.code === "E_ALLOWLIST")
  const response = await port({ method: "GET", path: `/api/session/${B}/message?order=asc` })
  assert.deepEqual(response, { data: [] })
})

test("message query accepts one initial asc or one bounded cursor continuation", async () => {
  const port = createRequestPort({
    fetch: makeFetch(), password: PASSWORD, sessionIDs: [A, B], baseUrl: "http://127.0.0.1:4096",
  })
  assert.deepEqual(await port({ method: "GET", path: `/api/session/${B}/message?order=asc&limit=50` }), { data: [] })
  assert.deepEqual(
    await port({ method: "GET", path: `/api/session/${B}/message?limit=50&cursor=abcDEF_123` }),
    { data: [] },
  )
  assert.deepEqual(
    await port({ method: "GET", path: `/api/session/${B}/message?type=user&cursor=abcDEF_123` }),
    { data: [] },
  )
  for (const path of [
    `/api/session/${B}/message`,
    `/api/session/${B}/message?limit=50`,
    `/api/session/${B}/message?order=asc&cursor=abcDEF_123`,
    `/api/session/${B}/message?order=desc`,
    `/api/session/${B}/message?cursor=`,
    `/api/session/${B}/message?cursor=abc&cursor=def`,
    `/api/session/${B}/message?cursor=abc%20def`,
  ]) {
    await assert.rejects(port({ method: "GET", path }), (e) => e.code === "E_ALLOWLIST")
  }
})

test("oversized request target is rejected before any host call", async () => {
  const fetch = makeFetch()
  const port = createRequestPort({
    fetch, password: PASSWORD, sessionIDs: [A, B], baseUrl: "http://127.0.0.1:4096",
  })
  await assert.rejects(
    port({ method: "GET", path: `/api/info?x=${"a".repeat(5000)}` }),
    (e) => e.code === "E_ALLOWLIST",
  )
  assert.equal(fetch.calls.length, 0)
})

test("fresh profile paths differ across runs and remain inside the profile base", async () => {
  const spawn = makeSpawn(["ok", "ok", "ok", "ok"])
  const d = deps({ spawn })
  await withIsolatedHost(config({ snapshot }), probe, d)
  await withIsolatedHost(config({ snapshot }), probe, d)
  const first = spawn.calls[0].options.env.HOME
  const second = spawn.calls[2].options.env.HOME
  assert.notEqual(first, second)
  assert.ok(first.startsWith("/run/sessionport/run-"))
  assert.ok(second.startsWith("/run/sessionport/run-"))
})

test("child environment contains no inherited provider keys", async () => {
  const previous = process.env.OPENAI_API_KEY
  process.env.OPENAI_API_KEY = "synthetic-not-a-secret"
  try {
    const spawn = makeSpawn()
    const d = deps({ spawn })
    await withIsolatedHost(config({ snapshot }), probe, d)
    const env = spawn.calls[0].options.env
    assert.equal(env.OPENAI_API_KEY, undefined)
    assert.equal(env.ANTHROPIC_API_KEY, undefined)
    assert.deepEqual(Object.keys(env).sort(), [...lifecycleEnvKeys, AUTH_ENV.primary].sort())
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previous
  }
})

test("legacy auth env is selected explicitly and still never appears in results", async () => {
  const spawn = makeSpawn()
  const d = deps({ spawn })
  const result = await withIsolatedHost(config({ authEnv: AUTH_ENV.legacy, snapshot }), probe, d)
  const env = spawn.calls[0].options.env
  assert.ok(env.OPENCODE_SERVER_PASSWORD.length >= 32)
  assert.equal(env.OPENCODE_PASSWORD, undefined)
  assert.ok(!JSON.stringify(result).includes(env.OPENCODE_SERVER_PASSWORD))
})

test("request timeout is bounded and returns a fixed error", async () => {
  const hangingFetch = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener("abort", () => {
      const error = new Error("aborted")
      error.name = "AbortError"
      reject(error)
    })
  })
  const port = createRequestPort({
    fetch: hangingFetch, password: PASSWORD, sessionIDs: [A, B],
    baseUrl: "http://127.0.0.1:4096", limits: { requestTimeoutMs: 10 },
  })
  await assert.rejects(port({ method: "GET", path: "/api/info" }), (e) => e.code === "E_TIMEOUT")
})

test("Docker plan requires an immutable digest and rejects host exposure", () => {
  assert.throws(
    () => buildDockerRunPlan({ imageDigest: "node:22", containerName: "sessionport-probe-1" }),
    (e) => e instanceof PlanError && e.code === "E_IMAGE_IMMUTABLE_REQUIRED",
  )
  const plan = buildDockerRunPlan({
    imageDigest: `sha256:${"d".repeat(64)}`,
    containerName: "sessionport-probe-1",
  })
  assert.deepEqual(verifyDockerRunPlan(plan), [])
  assert.ok(plan.argv.includes("--network") && plan.argv.includes("none"))
  assert.ok(plan.argv.includes("--read-only"))
  assert.ok(plan.argv.includes("--cap-drop") && plan.argv.includes("ALL"))
  assert.ok(plan.argv.includes("--security-opt") && plan.argv.includes("no-new-privileges"))
  assert.equal(plan.argv.includes("-p"), false)
  assert.equal(plan.argv.includes("--publish"), false)
  assert.equal(plan.argv.includes("-v"), false)
  assert.equal(plan.argv.includes("--mount"), false)
  assert.equal(plan.argv.includes("--rm"), false)
  assert.equal(plan.argv.includes("--privileged"), false)
  assert.ok(plan.argv.some((arg) => arg.startsWith("/run/sessionport:rw,noexec")))
})

test("OpenAPI verifier accepts the pinned required surface and rejects omissions", () => {
  assert.equal(verifyOpenApi(requiredDoc()), true)
  assert.throws(
    () => verifyOpenApi({ paths: { "/api/info": { get: {} } } }),
    (e) => e.code === "E_CONTRACT",
  )
})

test("child env builder rejects short passwords without exposing the value", () => {
  assert.throws(() => buildChildEnv("/run/sessionport/run-1", "short"), (e) => e.code === "E_AUTH_CONFIG")
})
