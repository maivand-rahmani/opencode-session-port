import {
  NotFoundError,
  UnsupportedFeatureError,
  runNativeReplacement,
  type AdapterMessage,
  type AdapterSession,
  type NativeReplacementAdapter,
  type NativeReplacementResult,
  type RunOptions,
} from "./state-machine"
import { isRecord, type NativeFixture, type NativeImportPayload } from "./fixtures"

export const HTTP_PROBE_MAX_RESPONSE_BYTES = 64 * 1024
export const HTTP_PROBE_MAX_LIST_ITEMS = 50

export type HttpProbeRequest = (input: {
  url: string
  method: "GET" | "POST" | "PATCH"
  headers: Record<string, string>
  body?: string
}) => Promise<{ status: number; body: string }>

export type HttpProbePaths = {
  importSession: string
  session: (sessionID: string) => string
  messages: (sessionID: string) => string
  sessions: (input: { directory: string; archived?: "true" | "false" }) => string
  updateSession: (sessionID: string) => string
}

export type HttpProbeOptions = {
  baseUrl: string
  request: HttpProbeRequest
  paths: HttpProbePaths
  headers?: () => Record<string, string> | Promise<Record<string, string>>
}

export function createHttpProbeAdapter(options: HttpProbeOptions): NativeReplacementAdapter {
  return {
    async importSession(payload: NativeImportPayload) {
      const response = await send(options, "POST", options.paths.importSession, payload)
      requireOk(response, [], "session-import")
      const value = unwrap(parseJson(response))
      const id = readImportedID(value)
      if (!id) throw new Error("http-probe-import-response-invalid")
      return { id }
    },

    async getSession(sessionID: string) {
      const response = await send(options, "GET", options.paths.session(sessionID))
      if (response.status === 404) throw new NotFoundError("session-get")
      requireOk(response, [], "session-get")
      return asSession(unwrap(parseJson(response)))
    },

    async listMessages(sessionID: string) {
      const response = await send(options, "GET", options.paths.messages(sessionID))
      requireOk(response, [], "message-list")
      const value = unwrap(parseJson(response))
      if (!Array.isArray(value)) throw new Error("http-probe-message-list-invalid")
      if (value.length > HTTP_PROBE_MAX_LIST_ITEMS) throw new Error("http-probe-list-too-large")
      return value.map(asMessage)
    },

    async listSessions(input: { directory: string; archived?: boolean }) {
      const archived = input.archived === undefined ? undefined : input.archived ? "true" : "false"
      const response = await send(
        options,
        "GET",
        options.paths.sessions({
          directory: input.directory,
          ...(archived === undefined ? {} : { archived }),
        }),
      )
      requireOk(response, [400, 404, 405, 501], "archived-list-filter")
      const value = unwrap(parseJson(response))
      if (!Array.isArray(value)) throw new Error("http-probe-session-list-invalid")
      if (value.length > HTTP_PROBE_MAX_LIST_ITEMS) throw new Error("http-probe-list-too-large")
      return value.map(asSession)
    },

    async setArchived(sessionID: string, archived: boolean) {
      const response = await send(options, "PATCH", options.paths.updateSession(sessionID), { archived })
      requireOk(response, [400, 405, 501], "archived-patch")
      // Deliberately no success inference from the response body. The state machine
      // must verify canonical Session.Info.time.archived through a separate readback.
    },
  }
}

export async function probeNativeReplacementOverHttp(
  input: HttpProbeOptions & { fixture: NativeFixture; runOptions?: RunOptions },
): Promise<NativeReplacementResult> {
  const adapter = createHttpProbeAdapter(input)
  return runNativeReplacement(adapter, input.fixture, input.runOptions)
}

async function send(
  options: HttpProbeOptions,
  method: "GET" | "POST" | "PATCH",
  path: string,
  body?: unknown,
): Promise<{ status: number; body: string }> {
  const authHeaders = (await options.headers?.()) ?? {}
  const headers: Record<string, string> = { ...authHeaders }
  if (body !== undefined) headers["content-type"] = "application/json"

  const response = await options.request({
    url: joinURL(options.baseUrl, path),
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (!response || typeof response.body !== "string") throw new Error("http-probe-response-invalid")
  if (new TextEncoder().encode(response.body).byteLength > HTTP_PROBE_MAX_RESPONSE_BYTES) {
    throw new Error("http-probe-response-too-large")
  }
  return response
}

function requireOk(
  response: { status: number; body: string },
  unsupportedStatuses: readonly number[],
  feature: string,
): void {
  if (response.status >= 200 && response.status < 300) return
  if (unsupportedStatuses.includes(response.status)) {
    throw new UnsupportedFeatureError(feature)
  }
  throw new Error(`http-probe-status-${response.status}`)
}

function parseJson(response: { status: number; body: string }): unknown {
  try {
    return JSON.parse(response.body)
  } catch {
    throw new Error("http-probe-json-invalid")
  }
}

function unwrap(value: unknown): unknown {
  return isRecord(value) && Object.prototype.hasOwnProperty.call(value, "data") ? value.data : value
}

function joinURL(baseURL: string, path: string): string {
  return `${baseURL.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`
}

function readImportedID(value: unknown): string | null {
  if (!isRecord(value)) return null
  if (typeof value.id === "string") return value.id
  if (isRecord(value.info) && typeof value.info.id === "string") return value.info.id
  return null
}

function asSession(value: unknown): AdapterSession {
  if (!isRecord(value) || typeof value.id !== "string") throw new Error("http-probe-session-invalid")
  return value as AdapterSession
}

function asMessage(value: unknown): AdapterMessage {
  if (!isRecord(value) || typeof value.id !== "string") throw new Error("http-probe-message-invalid")
  return value as AdapterMessage
}
