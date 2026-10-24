import type { CheckpointPayload } from "../../../../src/core/contracts/session.ts"

/**
 * Structural recovery surface. The implementation owns the stored old payload,
 * so no caller-supplied field values are trusted during verify or recover.
 */
export interface RecoveryPort {
  verify(expected: CheckpointPayload): Promise<boolean>
  recover(): Promise<CheckpointPayload>
  destroy(): void
}

/** Flat, settled, text-only session shape accepted by this lane. */
export type ProbeSession = {
  id: string
  parentID?: string | null
  title: string
  projectID: string
  directory: string
  time: { created: number; updated: number; archived?: number | null }
}

export type ProbeMessage = {
  id: string
  type: "user" | "assistant"
  text: string
  time: { created: number; completed?: number }
}

export type InventorySession = {
  id: string
  parentID?: string | null
  projectID: string
  messageIDs: readonly string[]
}

export type ProbeImportPayload = {
  info: {
    id: string
    title: string
    projectID: string
    directory: string
    time: { created: number; updated: number }
  }
  messages: readonly ProbeMessage[]
}

/**
 * Injected public host surface. `removeSession` is the only mutation; the state
 * machine may pass it the frozen fixture old ID and nothing else.
 */
export type VerifiedDeletePort = {
  getSession(sessionID: string): Promise<ProbeSession>
  listMessages(sessionID: string): Promise<readonly ProbeMessage[]>
  importSession(payload: ProbeImportPayload): Promise<{ id: string }>
  /** Public inventory of the isolated host, including each session's message IDs. */
  readInventory(): Promise<readonly InventorySession[]>
  removeSession(sessionID: string): Promise<void>
}

export class PortNotFoundError extends Error {
  readonly code = "port-not-found"

  constructor(readonly operation: string) {
    super(`not found: ${operation}`)
    this.name = "PortNotFoundError"
  }
}

export class PortTimeoutError extends Error {
  readonly code = "port-timeout"

  constructor(readonly operation: string) {
    super(`timeout: ${operation}`)
    this.name = "PortTimeoutError"
  }
}

export function isPortNotFoundError(error: unknown): boolean {
  return (
    error instanceof PortNotFoundError ||
    (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "port-not-found")
  )
}

export function isPortTimeoutError(error: unknown): boolean {
  return (
    error instanceof PortTimeoutError ||
    (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "port-timeout")
  )
}
