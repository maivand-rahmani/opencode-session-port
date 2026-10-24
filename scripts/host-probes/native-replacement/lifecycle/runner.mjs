// Offline-testable inner lifecycle runner for the pinned OpenCode 2.1.3 probe host.
// No host, container, network, or credential access happens at import time.

import { randomBytes as nodeRandomBytes } from "node:crypto"
import { spawn as nodeSpawn } from "node:child_process"
import { mkdir as nodeMkdir, rm as nodeRm } from "node:fs/promises"
import { posix } from "node:path"

export const PINNED = Object.freeze({
  version: "2.1.3",
  hostname: "127.0.0.1",
  port: 4096,
})

export const AUTH_ENV = Object.freeze({
  primary: "OPENCODE_PASSWORD",
  legacy: "OPENCODE_SERVER_PASSWORD",
})

export const REQUIRED_OPENAPI = Object.freeze({
  "/api/info": ["get"], "/api/session": ["get"],
  "/api/session/{sessionID}": ["get", "patch"],
  "/api/session/{sessionID}/message": ["get"],
  "/api/experimental/session/import": ["post"],
})

export const LIMITS = Object.freeze({
  readyTimeoutMs: 15_000, readyIntervalMs: 100, stopTimeoutMs: 10_000, stopPollMs: 50,
  requestTimeoutMs: 5_000, responseBodyBytes: 1_048_576, importBodyBytes: 262_144, maxLogBytes: 8_192,
})

const SESSION_ID = /^ses_[0-9a-f]{64}$/
const LIST_QUERY = new Set(["limit", "order", "cursor", "parentID", "archived"])
const MESSAGE_QUERY = new Set(["limit", "order", "cursor", "type"])
const MESSAGE_TYPES = new Set([
  "agent-switched", "model-switched", "location-switched", "user", "synthetic",
  "system", "skill", "shell", "assistant", "compaction",
])
const ENV_KEYS = Object.freeze([
  "PATH", "HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME",
  "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG_PROJECT_DISABLE", "OPENCODE_DISABLE_CLAUDE_CODE",
  "OPENCODE_DISABLE_MODELS_FETCH",
])

export class LifecycleError extends Error {
  constructor(code) {
    super(code)
    this.name = "LifecycleError"
    this.code = code
  }
}

const fail = (code) => { throw new LifecycleError(code) }

function defaults() {
  return {
    spawn: nodeSpawn,
    fetch: globalThis.fetch,
    fs: { mkdir: nodeMkdir, rm: nodeRm },
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    randomBytes: nodeRandomBytes,
    generatePassword: null,
  }
}

function normalizeLimits(overrides = {}) {
  const limits = { ...LIMITS }
  for (const key of Object.keys(LIMITS)) {
    if (overrides[key] === undefined) continue
    const value = overrides[key]
    if (!Number.isInteger(value) || value < 1 || value > 120_000) fail("E_CONFIG")
    limits[key] = value
  }
  return limits
}

function validateConfig(config, probe, deps) {
  if (!config || typeof config !== "object" || typeof probe !== "function") fail("E_CONFIG")
  const ids = config.sessionIDs
  if (!Array.isArray(ids) || ids.length !== 2) fail("E_CONFIG")
  if (!ids.every((id) => typeof id === "string" && SESSION_ID.test(id))) fail("E_CONFIG")
  if (ids[0] === ids[1]) fail("E_CONFIG")
  const binaryPath = config.binaryPath
  if (typeof binaryPath !== "string" || !posix.isAbsolute(binaryPath)) fail("E_CONFIG")
  if (binaryPath.includes("..") || /[\0\r\n]/.test(binaryPath)) fail("E_CONFIG")
  const base = config.profileBase ?? "/run/sessionport"
  if (typeof base !== "string" || !posix.isAbsolute(base) || base === "/") fail("E_CONFIG")
  if (posix.normalize(base) !== base || base.includes("..") || /[\0\r\n]/.test(base)) fail("E_CONFIG")
  if (config.authEnv !== undefined && !Object.values(AUTH_ENV).includes(config.authEnv)) fail("E_CONFIG")
  if (config.syntheticDeleteTarget !== undefined) {
    if (typeof config.syntheticDeleteTarget !== "string" || !SESSION_ID.test(config.syntheticDeleteTarget)) {
      fail("E_CONFIG")
    }
    if (config.syntheticDeleteTarget !== ids[0]) fail("E_CONFIG")
  }
  if (config.snapshot !== undefined && typeof config.snapshot !== "function") fail("E_CONFIG")
  if (typeof deps.fetch !== "function" || typeof deps.spawn !== "function") fail("E_CONFIG")
}

export function buildChildEnv(profileDir, password, authEnv = AUTH_ENV.primary) {
  if (typeof password !== "string" || password.length < 32) fail("E_AUTH_CONFIG")
  if (!Object.values(AUTH_ENV).includes(authEnv)) fail("E_CONFIG")
  return {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: `${profileDir}/home`,
    XDG_CONFIG_HOME: `${profileDir}/config`,
    XDG_DATA_HOME: `${profileDir}/data`,
    XDG_CACHE_HOME: `${profileDir}/cache`,
    XDG_STATE_HOME: `${profileDir}/state`,
    OPENCODE_CONFIG_DIR: `${profileDir}/opencode-config`,
    OPENCODE_CONFIG_PROJECT_DISABLE: "1",
    OPENCODE_DISABLE_CLAUDE_CODE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    [authEnv]: password,
  }
}

function attachLogMetadata(child, stats) {
  for (const stream of ["stdout", "stderr"]) {
    let total = 0
    child[stream]?.on?.("data", (chunk) => {
      const bytes = Buffer.byteLength(chunk)
      if (bytes > 0) stats[`${stream}Present`] = true
      total += bytes
      stats[`${stream}Bytes`] = Math.min(total, LIMITS.maxLogBytes)
      if (total > LIMITS.maxLogBytes) stats[`${stream}Overflow`] = true
      // The chunk is intentionally not retained, copied, or decoded.
    })
  }
}

async function readCapped(response, max) {
  const declared = Number(response.headers?.get?.("content-length"))
  if (Number.isFinite(declared) && declared > max) fail("E_BODY_CAP")
  if (!response.body?.getReader) {
    const bytes = Buffer.from(await response.text())
    if (bytes.length > max) fail("E_BODY_CAP")
    return bytes
  }
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel().catch(() => {})
      fail("E_BODY_CAP")
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks)
}

async function rawRequest({ path, method = "GET", body, password, baseUrl, limits, deps, notFound = false }) {
  const headers = {
    authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
  }
  if (body !== undefined) headers["content-type"] = "application/json"
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), limits.requestTimeoutMs)
  try {
    const response = await deps.fetch(new URL(path, baseUrl), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
      redirect: "error",
    })
    if (response.status === 401 || response.status === 403) fail("E_AUTH")
    if (response.status === 404 && notFound) fail("E_NOT_FOUND")
    if (!response.ok) fail("E_HTTP")
    const bytes = await readCapped(response, limits.responseBodyBytes)
    if (bytes.length === 0) return null
    try {
      return JSON.parse(bytes.toString("utf8"))
    } catch {
      fail("E_CONTRACT")
    }
  } catch (error) {
    if (error instanceof LifecycleError) throw error
    if (error?.name === "AbortError") fail("E_TIMEOUT")
    fail("E_TRANSPORT")
  } finally {
    clearTimeout(timer)
  }
}

export function verifyOpenApi(document) {
  if (!document || typeof document !== "object" || !document.paths || typeof document.paths !== "object") {
    fail("E_CONTRACT")
  }
  for (const [path, methods] of Object.entries(REQUIRED_OPENAPI)) {
    const entry = document.paths[path]
    if (!entry || typeof entry !== "object") fail("E_CONTRACT")
    for (const method of methods) if (!entry[method]) fail("E_CONTRACT")
  }
  return true
}

const MAX_LOCAL_REF_DEPTH = 8
const LOCAL_REF_SECTIONS = new Set(["schemas", "parameters", "requestBodies", "responses"])

function resolveLocalRef(document, value, expectedSection) {
  let current = value
  for (let depth = 0; depth <= MAX_LOCAL_REF_DEPTH; depth += 1) {
    if (!isRecord(current)) fail("E_CONTRACT")
    if (typeof current.$ref !== "string") return current
    const ref = current.$ref
    if (!ref.startsWith("#/components/")) fail("E_CONTRACT")
    const parts = ref.slice(2).split("/")
    if (
      parts.length !== 3 ||
      parts[0] !== "components" ||
      !LOCAL_REF_SECTIONS.has(parts[1]) ||
      parts[2].length === 0 ||
      (expectedSection !== undefined && parts[1] !== expectedSection)
    ) {
      fail("E_CONTRACT")
    }
    const name = parts[2].replace(/~1/g, "/").replace(/~0/g, "~")
    const target = document.components?.[parts[1]]?.[name]
    if (!isRecord(target)) fail("E_CONTRACT")
    current = target
  }
  fail("E_CONTRACT")
}

function schemaVariants(document, schema, depth = 0) {
  if (depth > MAX_LOCAL_REF_DEPTH) fail("E_CONTRACT")
  const resolved = resolveLocalRef(document, schema, "schemas")
  const branches = Array.isArray(resolved.anyOf)
    ? resolved.anyOf
    : Array.isArray(resolved.oneOf)
      ? resolved.oneOf
      : null
  if (!branches) return [resolved]
  return branches.flatMap((branch) => schemaVariants(document, branch, depth + 1))
}

function schemaAllowsBoolean(document, schema) {
  return schemaVariants(document, schema).some(
    (variant) =>
      variant.type === "boolean" ||
      (Array.isArray(variant.type) && variant.type.includes("boolean")) ||
      (Array.isArray(variant.enum) && variant.enum.includes(true)),
  )
}

function schemaIsNumber(document, schema) {
  return schemaVariants(document, schema).some(
    (variant) =>
      variant.type === "number" ||
      (Array.isArray(variant.type) && variant.type.includes("number")),
  )
}

function schemaHasArchivedQueryEnum(document, schema) {
  const values = new Set()
  for (const variant of schemaVariants(document, schema)) {
    if (!Array.isArray(variant.enum)) continue
    for (const value of variant.enum) values.add(value)
  }
  return values.size === 2 && values.has("true") && values.has("false")
}

function jsonSchema(document, container) {
  const schema = container?.content?.["application/json"]?.schema
  if (!isRecord(schema)) fail("E_CONTRACT")
  return resolveLocalRef(document, schema, "schemas")
}

function findQueryParameter(document, pathItem, operation, name) {
  for (const source of [pathItem.parameters, operation.parameters]) {
    if (!Array.isArray(source)) continue
    for (const raw of source) {
      const parameter = resolveLocalRef(document, raw, "parameters")
      if (parameter.name === name && parameter.in === "query") return parameter
    }
  }
  return null
}

function sessionInfoSchema(document) {
  const operation = document.paths["/api/session/{sessionID}"]?.get
  if (!isRecord(operation)) fail("E_UNSUPPORTED")
  const response = operation.responses?.["200"]
  if (!isRecord(response)) fail("E_UNSUPPORTED")
  const resolvedResponse = resolveLocalRef(document, response, "responses")
  const schema = jsonSchema(document, resolvedResponse)
  const dataSchema = schema.properties?.data
  if (dataSchema === undefined) return schema
  return resolveLocalRef(document, dataSchema, "schemas")
}

export function verifyOpenApiArchiveContract(document) {
  if (!document || typeof document !== "object" || !document.paths || typeof document.paths !== "object") {
    fail("E_CONTRACT")
  }

  const patch = document.paths["/api/session/{sessionID}"]?.patch
  if (!isRecord(patch) || !isRecord(patch.requestBody)) fail("E_UNSUPPORTED")
  const requestBody = resolveLocalRef(document, patch.requestBody, "requestBodies")
  const patchSchema = jsonSchema(document, requestBody)
  const archivedInput = patchSchema.properties?.archived
  if (!archivedInput || !schemaAllowsBoolean(document, archivedInput)) fail("E_UNSUPPORTED")

  const list = document.paths["/api/session"]?.get
  if (!isRecord(list)) fail("E_UNSUPPORTED")
  const archivedQuery = findQueryParameter(document, document.paths["/api/session"], list, "archived")
  if (!archivedQuery?.schema || !schemaHasArchivedQueryEnum(document, archivedQuery.schema)) {
    fail("E_UNSUPPORTED")
  }

  const info = sessionInfoSchema(document)
  const time = info.properties?.time
  if (!time) fail("E_UNSUPPORTED")
  const timeSchema = resolveLocalRef(document, time, "schemas")
  if (
    !Array.isArray(timeSchema.required) ||
    !timeSchema.required.includes("created") ||
    !timeSchema.required.includes("updated")
  ) {
    fail("E_UNSUPPORTED")
  }
  const created = timeSchema.properties?.created
  const updated = timeSchema.properties?.updated
  const archivedReadback = timeSchema.properties?.archived
  if (!created || !updated || !archivedReadback) fail("E_UNSUPPORTED")
  if (
    !schemaIsNumber(document, created) ||
    !schemaIsNumber(document, updated) ||
    !schemaIsNumber(document, archivedReadback)
  ) {
    fail("E_UNSUPPORTED")
  }

  return true
}

function hasExited(child) {
  return (child.exitCode !== null && child.exitCode !== undefined) ||
    (child.signalCode !== null && child.signalCode !== undefined)
}

async function waitReady({ child, baseUrl, password, limits, deps, childFailed }) {
  const deadline = deps.now() + limits.readyTimeoutMs
  for (;;) {
    if (childFailed() || hasExited(child)) fail("E_CHILD_EXIT")
    try {
      const info = await rawRequest({ path: "/api/info", password, baseUrl, limits, deps })
      if (!info || typeof info !== "object" || info.version !== PINNED.version) fail("E_VERSION")
      const spec = await rawRequest({ path: "/openapi.json", password, baseUrl, limits, deps })
      verifyOpenApi(spec)
      return
    } catch (error) {
      if (error instanceof LifecycleError && ["E_AUTH", "E_VERSION", "E_CONTRACT", "E_BODY_CAP"].includes(error.code)) {
        throw error
      }
      if (deps.now() >= deadline) fail("E_READY_TIMEOUT")
      await deps.sleep(limits.readyIntervalMs)
    }
  }
}

async function stopOwned(child, deps, limits) {
  if (!child) return
  if (hasExited(child)) return
  try {
    child.kill("SIGTERM")
  } catch {
    fail("E_STOP_UNCERTAIN")
  }
  const deadline = deps.now() + limits.stopTimeoutMs
  while (!hasExited(child)) {
    if (deps.now() >= deadline) fail("E_STOP_UNCERTAIN")
    await deps.sleep(limits.stopPollMs)
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function errorCategory(error) {
  if (error instanceof LifecycleError) return error.code
  if (isRecord(error) && typeof error.code === "string") {
    return error.code === "not-found" ? "E_NOT_FOUND" : error.code
  }
  if (isRecord(error) && error.name === "NotFoundError") return "E_NOT_FOUND"
  return "E_SNAPSHOT_READ"
}

function validateQuery(url, allowed) {
  const seen = new Set()
  for (const [key, value] of url.searchParams) {
    if (!allowed.has(key) || seen.has(key)) fail("E_ALLOWLIST")
    seen.add(key)
    if (value.length > 512 || /[\0\r\n]/.test(value)) fail("E_ALLOWLIST")
    if (key === "limit" && !/^\d{1,4}$/.test(value)) fail("E_ALLOWLIST")
    if (key === "order" && !["asc", "desc"].includes(value)) fail("E_ALLOWLIST")
    if (key === "archived" && !["true", "false"].includes(value)) fail("E_ALLOWLIST")
    if (key === "type" && !MESSAGE_TYPES.has(value)) fail("E_ALLOWLIST")
  }
}

export function createRequestPort({
  fetch, password, sessionIDs, baseUrl, limits = {}, readonly = false, syntheticDeleteTarget,
}) {
  if (typeof password !== "string" || password.length < 32) fail("E_AUTH_CONFIG")
  if (!Array.isArray(sessionIDs) || sessionIDs.length !== 2) fail("E_CONFIG")
  if (!sessionIDs.every((id) => typeof id === "string" && SESSION_ID.test(id))) fail("E_CONFIG")
  if (sessionIDs[0] === sessionIDs[1]) fail("E_CONFIG")
  if (syntheticDeleteTarget !== undefined) {
    if (
      typeof syntheticDeleteTarget !== "string" ||
      !SESSION_ID.test(syntheticDeleteTarget) ||
      syntheticDeleteTarget !== sessionIDs[0]
    ) {
      fail("E_CONFIG")
    }
  }
  const ids = new Set(sessionIDs)
  const cfg = { ...LIMITS, ...limits }
  const deps = { fetch }
  const origin = new URL(baseUrl).origin

  return async function request(spec) {
    if (!spec || typeof spec !== "object") fail("E_ALLOWLIST")
    const method = String(spec.method ?? "GET").toUpperCase()
    const raw = spec.path
    if (typeof raw !== "string" || !raw.startsWith("/") || raw.length > 4096) fail("E_ALLOWLIST")
    if (raw.includes("\\") || raw.includes("..") || /%2e|%2f|%5c/i.test(raw) || /[\0\r\n]/.test(raw)) {
      fail("E_ALLOWLIST")
    }
    let url
    try {
      url = new URL(raw, baseUrl)
    } catch {
      fail("E_ALLOWLIST")
    }
    if (url.origin !== origin || url.username || url.password) fail("E_ALLOWLIST")
    if (url.hash) fail("E_ALLOWLIST")
    const body = spec.body
    if (method === "GET" && body !== undefined) fail("E_ALLOWLIST")
    const path = url.pathname

    if (method === "DELETE") {
      if (readonly) fail("E_READONLY")
      if (syntheticDeleteTarget === undefined) fail("E_ALLOWLIST")
      const match = path.match(/^\/api\/session\/(ses_[0-9a-f]{64})(\/message)?$/)
      if (!match || match[2] !== undefined) fail("E_ALLOWLIST")
      if (!ids.has(match[1]) || match[1] !== syntheticDeleteTarget) fail("E_SCOPE")
      if (url.search.length > 0 || body !== undefined) fail("E_ALLOWLIST")
      return rawRequest({
        path, method, password, baseUrl, limits: cfg, deps, notFound: true,
      })
    }
    if (!["GET", "POST", "PATCH"].includes(method)) fail("E_ALLOWLIST")

    if (path === "/api/info" || path === "/openapi.json") {
      if (method !== "GET" || url.search.length > 0) fail("E_ALLOWLIST")
      return rawRequest({ path, method, password, baseUrl, limits: cfg, deps })
    }
    if (path === "/api/session") {
      if (method !== "GET") fail("E_ALLOWLIST")
      validateQuery(url, LIST_QUERY)
      return rawRequest({ path: raw, method, password, baseUrl, limits: cfg, deps })
    }
    const match = path.match(/^\/api\/session\/(ses_[0-9a-f]{64})(\/message)?$/)
    if (match) {
      if (!ids.has(match[1])) fail("E_SCOPE")
      if (match[2]) {
        if (method !== "GET") fail("E_ALLOWLIST")
        validateQuery(url, MESSAGE_QUERY)
        const orders = url.searchParams.getAll("order")
        const cursors = url.searchParams.getAll("cursor")
        // Initial page: exactly asc. Continuation: exactly one non-empty opaque
        // cursor and no order; the documented cursor already carries asc.
        if (cursors.length > 0) {
          if (orders.length !== 0 || cursors.length !== 1 || !/^[A-Za-z0-9_-]+$/.test(cursors[0])) {
            fail("E_ALLOWLIST")
          }
        } else if (orders.length !== 1 || orders[0] !== "asc") {
          fail("E_ALLOWLIST")
        }
      } else if (method === "GET") {
        if (url.search.length > 0) fail("E_ALLOWLIST")
      } else if (method === "PATCH") {
        if (readonly) fail("E_READONLY")
        if (url.search.length > 0) fail("E_ALLOWLIST")
        if (!isRecord(body) || Object.keys(body).length !== 1 || typeof body.archived !== "boolean") {
          fail("E_ALLOWLIST")
        }
      } else {
        fail("E_ALLOWLIST")
      }
      return rawRequest({ path: raw, method, body, password, baseUrl, limits: cfg, deps, notFound: true })
    }
    if (path === "/api/experimental/session/import") {
      if (method !== "POST") fail("E_ALLOWLIST")
      if (readonly) fail("E_READONLY")
      if (url.search.length > 0 || !isRecord(body) || !isRecord(body.info)) fail("E_ALLOWLIST")
      if (typeof body.info.id !== "string" || !ids.has(body.info.id)) fail("E_SCOPE")
      if (!Array.isArray(body.messages) || body.messages.length > 50) fail("E_ALLOWLIST")
      const messageIDs = new Set()
      for (const message of body.messages) {
        if (!isRecord(message) || typeof message.id !== "string") fail("E_ALLOWLIST")
        if (!/^msg_[0-9a-f]{64}$/.test(message.id) || messageIDs.has(message.id)) fail("E_ALLOWLIST")
        messageIDs.add(message.id)
      }
      if (Buffer.byteLength(JSON.stringify(body)) > cfg.importBodyBytes) fail("E_BODY_CAP")
      return rawRequest({ path, method, body, password, baseUrl, limits: cfg, deps })
    }
    fail("E_ALLOWLIST")
  }
}

export async function withIsolatedHost(config, probe, injected = {}) {
  const deps = { ...defaults(), ...injected }
  validateConfig(config, probe, deps)
  const limits = normalizeLimits(config.limits)
  const password = deps.generatePassword ? deps.generatePassword() : deps.randomBytes(32).toString("base64url")
  if (typeof password !== "string" || password.length < 32) fail("E_AUTH_CONFIG")
  const profileBase = config.profileBase ?? "/run/sessionport"
  const profileDir = posix.join(profileBase, `run-${deps.randomBytes(8).toString("hex")}`)
  if (!profileDir.startsWith(`${profileBase}/`)) fail("E_CONFIG")
  const authEnv = config.authEnv ?? AUTH_ENV.primary
  const baseUrl = `http://${PINNED.hostname}:${PINNED.port}`
  const childOutput = {
    stdoutBytes: 0, stderrBytes: 0,
    stdoutOverflow: false, stderrOverflow: false,
    stdoutPresent: false, stderrPresent: false,
  }
  let activeChild = null
  let cleaned = false
  let stopUncertain = false

  try {
    for (const suffix of ["", "/home", "/config", "/data", "/cache", "/state", "/opencode-config"]) {
      await deps.fs.mkdir(`${profileDir}${suffix}`, { recursive: true, mode: 0o700 })
    }

    const start = async () => {
      const env = buildChildEnv(profileDir, password, authEnv)
      let child
      try {
        child = deps.spawn(config.binaryPath, ["serve", "--hostname", PINNED.hostname, "--port", String(PINNED.port)], {
          cwd: profileDir,
          env,
          stdio: ["ignore", "pipe", "pipe"],
          shell: false,
          detached: false,
        })
      } catch {
        fail("E_SPAWN")
      }
      activeChild = child
      let childFailed = false
      child.on?.("error", () => { childFailed = true })
      attachLogMetadata(child, childOutput)
      await waitReady({ child, baseUrl, password, limits, deps, childFailed: () => childFailed })
      return child
    }

    await start()
    const firstPort = createRequestPort({
      fetch: deps.fetch, password, sessionIDs: config.sessionIDs, baseUrl, limits,
      syntheticDeleteTarget: config.syntheticDeleteTarget,
    })
    let probeResult = null
    let probeFailure = null
    try {
      probeResult = await probe({
        request: firstPort, sessionIDs: [...config.sessionIDs], profileDir, phase: "first",
      })
    } catch (error) {
      probeFailure = {
        status: "failed",
        code: error instanceof LifecycleError ? error.code : "E_PROBE",
      }
    }
    const facts = (stopPhase) => ({
      probe: probeResult,
      probeFailure,
      snapshot: snapshotResult,
      stop: { verified: false, phase: stopPhase },
      cleanup: "retained",
      profileRetained: true,
    })
    let snapshotResult = null
    let snapshotReason = null

    try {
      await stopOwned(activeChild, deps, limits)
    } catch {
      stopUncertain = true
      const error = new LifecycleError("E_STOP_UNCERTAIN")
      error.facts = facts("first-stop")
      throw error
    }
    activeChild = null

    const probeVerified = isRecord(probeResult) &&
      probeResult.outcome === "api-verified" &&
      probeResult.restartManifestReady === true
    if (!probeVerified) {
      snapshotReason = probeFailure ? "probe-failed" : "probe-not-verified"
      snapshotResult = { status: "not-run", reason: snapshotReason }
    } else if (!config.snapshot) {
      snapshotReason = "snapshot-unconfigured"
      snapshotResult = { status: "not-run", reason: snapshotReason }
    } else {
      await start()
      const readonlyPort = createRequestPort({
        fetch: deps.fetch, password, sessionIDs: config.sessionIDs, baseUrl, limits, readonly: true,
        syntheticDeleteTarget: config.syntheticDeleteTarget,
      })
      try {
        snapshotResult = await config.snapshot({
          request: readonlyPort, sessionIDs: [...config.sessionIDs], profileDir, phase: "restart-readonly",
        })
      } catch (error) {
        snapshotResult = {
          status: "failed",
          step: "snapshot-callback",
          errorCategory: errorCategory(error),
        }
      }

      try {
        await stopOwned(activeChild, deps, limits)
      } catch {
        stopUncertain = true
        const error = new LifecycleError("E_STOP_UNCERTAIN")
        error.facts = facts("second-stop")
        throw error
      }
      activeChild = null
    }

    try {
      await deps.fs.rm(profileDir, { recursive: true, force: false })
      cleaned = true
    } catch {
      fail("E_CLEANUP")
    }

    return {
      status: "ok",
      probe: probeResult,
      probeFailure,
      snapshot: snapshotResult,
      snapshotReason,
      cleanup: "profile-removed",
      childOutput,
    }
  } catch (error) {
    if (activeChild && !stopUncertain) {
      try {
        await stopOwned(activeChild, deps, limits)
        activeChild = null
      } catch {
        throw new LifecycleError("E_STOP_UNCERTAIN")
      }
    }
    if (!activeChild && !cleaned) {
      try {
        await deps.fs.rm(profileDir, { recursive: true, force: false })
      } catch {
        // Retain-on-cleanup-failure is safer than reporting a clean run.
      }
    }
    throw error instanceof LifecycleError ? error : new LifecycleError("E_INTERNAL")
  }
}

export const lifecycleEnvKeys = ENV_KEYS
