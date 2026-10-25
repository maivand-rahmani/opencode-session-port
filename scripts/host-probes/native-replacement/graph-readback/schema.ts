// Runtime OpenAPI feature detection for the nondestructive graph-readback probe.
// Candidate shapes were inspected in the read-only 2.0.22 source clone; only the
// actual pinned-host OpenAPI fetched at runtime is treated as evidence.

import { LifecycleError } from "../lifecycle/runner.mjs"

const MAX_REF_DEPTH = 12
const MAX_VARIANTS = 64
const SCHEMA_SECTIONS = new Set(["schemas", "parameters", "requestBodies", "responses"])

export type GraphFeatures = {
  importEndpoint: boolean
  parentID: boolean
  fork: boolean
  revert: boolean
  user: boolean
  assistant: boolean
  assistantText: boolean
  toolCompleted: boolean
  toolError: boolean
  toolTextContent: boolean
  messageSource: "import" | "session-message-list" | "missing"
  unsupported: string[]
  importsAllowed: boolean
}

function fail(code: string): never {
  throw new LifecycleError(code)
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function resolve(document: Record<string, unknown>, value: unknown, section?: string): Record<string, unknown> {
  let current = value
  for (let depth = 0; depth <= MAX_REF_DEPTH; depth += 1) {
    if (!isRecord(current)) fail("E_CONTRACT")
    if (typeof current.$ref !== "string") return current
    const ref = current.$ref
    if (!ref.startsWith("#/components/")) fail("E_CONTRACT")
    const parts = ref.slice(2).split("/")
    if (
      parts.length !== 3 ||
      parts[0] !== "components" ||
      !SCHEMA_SECTIONS.has(parts[1]) ||
      parts[2].length === 0 ||
      (section !== undefined && parts[1] !== section)
    ) {
      fail("E_CONTRACT")
    }
    const name = parts[2].replace(/~1/g, "/").replace(/~0/g, "~")
    const target = (document.components as Record<string, unknown> | undefined)?.[parts[1]]
    if (!isRecord(target)) fail("E_CONTRACT")
    current = (target as Record<string, unknown>)[name]
  }
  fail("E_CONTRACT")
}

function variants(document: Record<string, unknown>, value: unknown, depth = 0): Record<string, unknown>[] {
  if (depth > MAX_REF_DEPTH) fail("E_CONTRACT")
  const resolved = resolve(document, value, "schemas")
  const branches = Array.isArray(resolved.anyOf)
    ? resolved.anyOf
    : Array.isArray(resolved.oneOf)
      ? resolved.oneOf
      : null
  if (!branches) return [resolved]
  if (branches.length === 0 || branches.length > MAX_VARIANTS) fail("E_CONTRACT")
  return branches.flatMap((branch) => variants(document, branch, depth + 1))
}

function enumValues(schema: Record<string, unknown>): unknown[] {
  return Array.isArray(schema.enum) ? schema.enum : []
}

function hasEnum(schema: Record<string, unknown>, value: string): boolean {
  return enumValues(schema).includes(value)
}

function isStringSchema(schema: Record<string, unknown>): boolean {
  const type = schema.type
  return type === "string" || (Array.isArray(type) && type.includes("string"))
}

function props(schema: Record<string, unknown>): Record<string, unknown> {
  return isRecord(schema.properties) ? schema.properties : {}
}

function required(schema: Record<string, unknown>, name: string): boolean {
  return Array.isArray(schema.required) && (schema.required as unknown[]).includes(name)
}

function jsonBodySchema(
  document: Record<string, unknown>,
  path: string,
  method: string,
): Record<string, unknown> | null {
  const paths = document.paths
  if (!isRecord(paths)) return null
  const item = paths[path]
  if (!isRecord(item)) return null
  const operation = item[method]
  if (!isRecord(operation) || !isRecord(operation.requestBody)) return null
  const requestBody = resolve(document, operation.requestBody, "requestBodies")
  const content = requestBody.content
  if (!isRecord(content)) return null
  const json = content["application/json"]
  if (!isRecord(json) || !isRecord(json.schema)) return null
  return resolve(document, json.schema, "schemas")
}

function responseDataSchema(
  document: Record<string, unknown>,
  path: string,
  method: string,
): Record<string, unknown> | null {
  const paths = document.paths
  if (!isRecord(paths)) return null
  const item = paths[path]
  if (!isRecord(item)) return null
  const operation = item[method]
  if (!isRecord(operation) || !isRecord(operation.responses)) return null
  const response = operation.responses["200"]
  if (!isRecord(response)) return null
  const resolved = resolve(document, response, "responses")
  const content = resolved.content
  if (!isRecord(content)) return null
  const json = content["application/json"]
  if (!isRecord(json) || !isRecord(json.schema)) return null
  return resolve(document, json.schema, "schemas")
}

function messageUnion(document: Record<string, unknown>, importSchema: Record<string, unknown>): {
  union: Record<string, unknown> | null
  source: GraphFeatures["messageSource"]
} {
  const importedMessages = props(importSchema).messages
  if (isRecord(importedMessages) && isRecord(importedMessages.items)) {
    return { union: resolve(document, importedMessages.items, "schemas"), source: "import" }
  }
  const list = responseDataSchema(document, "/api/session/{sessionID}/message", "get")
  const data = list === null ? null : props(list).data
  if (isRecord(data) && isRecord(data.items)) {
    return { union: resolve(document, data.items, "schemas"), source: "session-message-list" }
  }
  return { union: null, source: "missing" }
}

function messageVariant(document: Record<string, unknown>, union: Record<string, unknown>, type: string) {
  return variants(document, union).find((variant) => {
    const typeSchema = props(variant).type
    return isRecord(typeSchema) && hasEnum(typeSchema, type)
  })
}

function contentPart(
  document: Record<string, unknown>,
  assistant: Record<string, unknown>,
  type: string,
): Record<string, unknown> | undefined {
  const content = props(assistant).content
  if (!isRecord(content) || !isRecord(content.items)) return undefined
  return variants(document, content.items).find((variant) => {
    const typeSchema = props(variant).type
    return isRecord(typeSchema) && hasEnum(typeSchema, type)
  })
}

function toolState(
  document: Record<string, unknown>,
  tool: Record<string, unknown>,
  status: string,
): Record<string, unknown> | undefined {
  const state = props(tool).state
  if (!isRecord(state)) return undefined
  return variants(document, state).find((variant) => {
    const statusSchema = props(variant).status
    return isRecord(statusSchema) && hasEnum(statusSchema, status)
  })
}

function boundaryAllows(document: Record<string, unknown>, fork: Record<string, unknown>): boolean {
  const boundary = props(fork).boundary
  if (!isRecord(boundary)) return false
  const allowed = new Set<string>()
  for (const variant of variants(document, boundary)) {
    const type = props(variant).type
    if (!isRecord(type) || !isRecord(props(variant).messageID)) continue
    for (const value of enumValues(type)) if (typeof value === "string") allowed.add(value)
  }
  return allowed.has("before") && allowed.has("through")
}

export function detectGraphFeatures(document: unknown): GraphFeatures {
  if (!isRecord(document)) fail("E_CONTRACT")
  const unsupported = new Set<string>()
  const importSchema = jsonBodySchema(document, "/api/experimental/session/import", "post")
  const importEndpoint = importSchema !== null
  if (!importEndpoint) unsupported.add("session.import")

  let parentID = false
  let fork = false
  let revert = false
  if (importSchema !== null) {
    const infoRef = props(importSchema).info
    const info = isRecord(infoRef) ? resolve(document, infoRef, "schemas") : null
    if (info === null) {
      unsupported.add("session.import.info")
    } else {
      const parent = props(info).parentID
      parentID = isRecord(parent) && variants(document, parent).some((variant) => isStringSchema(variant))
      if (!parentID) unsupported.add("session.import.info.parentID")

      const forkSchema = props(info).fork
      if (isRecord(forkSchema)) {
        const resolvedFork = resolve(document, forkSchema, "schemas")
        const sessionID = props(resolvedFork).sessionID
        fork = isRecord(sessionID) &&
          variants(document, sessionID).some((variant) => isStringSchema(variant)) &&
          boundaryAllows(document, resolvedFork)
      }
      if (!fork) unsupported.add("session.import.info.fork")

      const revertSchema = props(info).revert
      if (isRecord(revertSchema)) {
        const resolvedRevert = resolve(document, revertSchema, "schemas")
        const messageID = props(resolvedRevert).messageID
        revert = isRecord(messageID) &&
          variants(document, messageID).some((variant) => isStringSchema(variant))
      }
      if (!revert) unsupported.add("session.import.info.revert")
    }
  }

  const { union, source } = importSchema === null
    ? { union: null, source: "missing" as const }
    : messageUnion(document, importSchema)
  let user = false
  let assistant = false
  let assistantText = false
  let toolCompleted = false
  let toolError = false
  let toolTextContent = false

  if (union !== null) {
    const userVariant = messageVariant(document, union, "user")
    const userText = userVariant === undefined ? undefined : props(userVariant).text
    const userTime = userVariant === undefined ? undefined : props(userVariant).time
    user = userVariant !== undefined &&
      isRecord(userText) &&
      isRecord(userTime) &&
      isRecord(props(userTime).created)
    if (!user) unsupported.add("session.message.user")

    const assistantVariant = messageVariant(document, union, "assistant")
    const assistantTime = assistantVariant === undefined ? undefined : props(assistantVariant).time
    assistant = assistantVariant !== undefined &&
      isRecord(props(assistantVariant).agent) &&
      isRecord(props(assistantVariant).model) &&
      isRecord(props(assistantVariant).content) &&
      isRecord(assistantTime) &&
      isRecord(props(assistantTime).created) &&
      isRecord(props(assistantTime).completed)
    if (!assistant) unsupported.add("session.message.assistant")

    if (assistantVariant !== undefined) {
      const text = contentPart(document, assistantVariant, "text")
      assistantText = text !== undefined && isRecord(props(text).text)
      if (!assistantText) unsupported.add("session.message.assistant.text")

      const tool = contentPart(document, assistantVariant, "tool")
      const completed = tool === undefined ? undefined : toolState(document, tool, "completed")
      const errored = tool === undefined ? undefined : toolState(document, tool, "error")

      toolCompleted = tool !== undefined &&
        isRecord(tool) &&
        isRecord(props(tool).id) &&
        isRecord(props(tool).name) &&
        isRecord(props(tool).time) &&
        completed !== undefined &&
        isRecord(props(completed).input) &&
        isRecord(props(completed).content)
      if (!toolCompleted) unsupported.add("session.message.tool.completed")

      toolError = tool !== undefined &&
        isRecord(tool) &&
        isRecord(props(tool).id) &&
        isRecord(props(tool).name) &&
        isRecord(props(tool).time) &&
        errored !== undefined &&
        isRecord(props(errored).input) &&
        isRecord(props(errored).error)
      if (!toolError) unsupported.add("session.message.tool.error")

      if (toolCompleted && completed !== undefined) {
        const completedContent = props(completed).content
        toolTextContent = isRecord(completedContent) &&
          isRecord(completedContent.items) &&
          variants(document, completedContent.items).some((variant) => {
            const type = props(variant).type
            return isRecord(type) && hasEnum(type, "text") && isRecord(props(variant).text)
          })
      }
      if (!toolTextContent) unsupported.add("session.message.tool.content.text")
    } else {
      unsupported.add("session.message.assistant.text")
      unsupported.add("session.message.tool.completed")
      unsupported.add("session.message.tool.error")
      unsupported.add("session.message.tool.content.text")
    }
  } else {
    for (const name of [
      "session.message.user",
      "session.message.assistant",
      "session.message.assistant.text",
      "session.message.tool.completed",
      "session.message.tool.error",
      "session.message.tool.content.text",
    ]) {
      unsupported.add(name)
    }
  }

  // Required for any import: endpoint, parent chain, user and assistant text.
  // Fork/revert/tool support is optional and reported as unsupported when absent.
  const importsAllowed = importEndpoint && parentID && user && assistant && assistantText
  return {
    importEndpoint,
    parentID,
    fork,
    revert,
    user,
    assistant,
    assistantText,
    toolCompleted,
    toolError,
    toolTextContent,
    messageSource: source,
    unsupported: [...unsupported].sort(),
    importsAllowed,
  }
}
