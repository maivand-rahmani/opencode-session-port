import { afterEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { CANDIDATE_TITLE, OLD_ROOT_TITLE, SYNTHETIC_TAIL_TEXT } from "../fixtures"
import {
  archiveProbeEnabled,
  createArchiveProbeResult,
  createProbeResult,
  isArchiveProbeResult,
  isNativeProbeResult,
  runArchiveTuiProbe,
  runNativeTuiProbe,
  validateIsolation,
  writeArchiveProbeResult,
  writeNativeProbeResult,
  type NativeProbeContext,
  type NativeProbeResult,
  type ProbeEnv,
} from "./entry"

const TEST_BASE = path.join(
  process.cwd(),
  ".package-verify-work",
  "m1-native-tui-plugin-20261024",
)
const FIX_BASE = path.join(
  process.cwd(),
  ".package-verify-work",
  "m1-tui-isolation-fix-20261024",
)
const roots: string[] = []

const EXPECTED_KEYS = [
  "probe",
  "version",
  "ok",
  "stage",
  "reason",
  "importedCount",
  "oldMessageCount",
  "candidateMessageCount",
  "nativeRouteObserved",
  "parentlessVerified",
  "archiveNotTested",
  "composerNotTested",
  "pickerNotTested",
] as const

function makeRoot() {
  mkdirSync(TEST_BASE, { recursive: true })
  const root = mkdtempSync(path.join(TEST_BASE, "test-"))
  roots.push(root)
  const project = path.join(root, "project")
  const results = path.join(root, "results")
  mkdirSync(project)
  mkdirSync(results)
  mkdirSync(path.join(project, "subroot"))
  return {
    root,
    project,
    results,
    resultPath: path.join(results, "probe-result.json"),
    env: {
      SP_PROBE_ROOT: root,
      SP_PROBE_PROJECT: project,
      SP_PROBE_RESULT: path.join(results, "probe-result.json"),
    },
  }
}

const RUNNER_PATH = path.resolve(
  "scripts/host-probes/sync-anchor/run-sync-anchor-probe.ps1",
)

const RUNNER_ENV_SCRIPT = String.raw`param([string]$Root, [string]$Runner, [string]$Archive = '0')
$ErrorActionPreference = 'Stop'
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($Runner, [ref]$tokens, [ref]$errors)
if (@($errors).Count -gt 0) { throw 'runner-parse' }
$fn = $ast.Find({ param($candidate) $candidate -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $candidate.Name -eq 'New-ProbeEnvironmentBlock' }, $true)
if ($null -eq $fn) { throw 'runner-function-missing' }
. ([scriptblock]::Create($fn.Extent.Text))
$archiveSwitch = ($Archive -eq '1')
$block = [string](New-ProbeEnvironmentBlock -Root $Root -Executable (Join-Path $Root 'bin\opencode.exe') -Phase 'probe' -ResultPath (Join-Path $Root 'results\probe-result.json') -ArchiveProbe:$archiveSwitch)
$map = [ordered]@{}
foreach ($entry in ($block.Split([char]0))) {
  if ($entry -eq '') { continue }
  $index = $entry.IndexOf('=')
  if ($index -gt 0) { $map[$entry.Substring(0, $index)] = $entry.Substring($index + 1) }
}
$map | ConvertTo-Json -Compress
`

function makeContractRoot() {
  mkdirSync(FIX_BASE, { recursive: true })
  const root = mkdtempSync(path.join(FIX_BASE, "contract-"))
  roots.push(root)
  const project = path.join(root, "project")
  const results = path.join(root, "results")
  mkdirSync(project)
  mkdirSync(results)
  mkdirSync(path.join(root, "bin"))
  mkdirSync(path.join(project, "subroot"))
  return {
    root,
    project,
    results,
    resultPath: path.join(results, "probe-result.json"),
  }
}

function readRunnerEnvironment(root: string, archive = false): ProbeEnv {
  const scriptPath = path.join(root, "read-runner-env.ps1")
  writeFileSync(scriptPath, RUNNER_ENV_SCRIPT, "utf8")
  const child = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
      root,
      RUNNER_PATH,
      archive ? "1" : "0",
    ],
    { encoding: "utf8", windowsHide: true, timeout: 30000 },
  )
  if (child.error || child.status !== 0) throw new Error("runner-env-read-failed")
  return JSON.parse(String(child.stdout ?? "").trim()) as ProbeEnv
}

type FakeOptions = {
  canonicalProjectID?: string
  parentOnOld?: boolean
  oldMessages?: number
  candidateMessages?: number
  replayedUpdated?: boolean
  omitCurrent?: boolean
  omitLocation?: boolean
  route?: "candidate" | "home"
  omitImport?: boolean
  omitUpdate?: boolean
  stripArchive?: boolean
  throwArchive?: "applied" | "not-applied"
  archiveUnknown?: boolean
  recoveryStuck?: boolean
}

function createFakeContext(project: string, options: FakeOptions = {}) {
  const sessions = new Map<string, Record<string, unknown>>()
  const messages = new Map<string, unknown[]>()
  const calls = {
    imports: [] as Array<Record<string, any>>,
    gets: [] as string[],
    lists: [] as Array<Record<string, unknown>>,
    syncs: [] as string[],
    invalidates: [] as string[],
    updates: [] as Array<{ sessionID: string; archived: boolean }>,
    navigations: [] as Array<Record<string, unknown>>,
  }
  const canonicalProjectID = options.canonicalProjectID ?? "host-canonical-project"
  let route: Record<string, unknown> = { type: "home" }

  const client = {
    session: {
      async import(payload: Record<string, any>) {
        calls.imports.push(payload)
        const id = payload.info.id
        const now = Date.now()
        const old = payload.info.title === OLD_ROOT_TITLE
        const stored = {
          id,
          ...(options.parentOnOld && old ? { parentID: "ses_parent" } : {}),
          projectID: canonicalProjectID,
          title: payload.info.title,
          time: {
            created: payload.info.time.created,
            updated: options.replayedUpdated ? payload.info.time.updated : now,
          },
          location: payload.location,
        }
        sessions.set(id, stored)
        const limit = old ? options.oldMessages : options.candidateMessages
        messages.set(id, limit === undefined ? payload.messages : payload.messages.slice(0, limit))
        return stored
      },
      async get({ sessionID }: { sessionID: string }) {
        calls.gets.push(sessionID)
        const stored = sessions.get(sessionID)
        if (!stored) throw new Error("missing")
        return stored
      },
      async update(input: { sessionID: string; archived: boolean }) {
        calls.updates.push(input)
        if (options.throwArchive === "not-applied") throw new Error("archive-transport")
        const stored = sessions.get(input.sessionID)
        if (!stored) throw new Error("missing")
        if (!options.stripArchive) {
          const time = stored.time as Record<string, unknown>
          if (input.archived) {
            time.archived = options.archiveUnknown ? "invalid" : Date.now()
          } else if (!options.recoveryStuck) {
            delete time.archived
          }
        }
        if (options.throwArchive === "applied") throw new Error("archive-transport")
        return {}
      },
    },
    message: {
      async list(input: Record<string, unknown>) {
        calls.lists.push(input)
        const data = messages.get(String(input.sessionID))
        if (!data) throw new Error("missing")
        return { data }
      },
    },
  }
  if (options.omitImport) delete (client.session as { import?: unknown }).import
  if (options.omitUpdate) delete (client.session as { update?: unknown }).update

  const data = {
    session: {
      async sync(sessionID: string) {
        calls.syncs.push(sessionID)
      },
      invalidate(sessionID: string) {
        calls.invalidates.push(sessionID)
      },
      message: {
        async sync(sessionID: string) {
          calls.syncs.push(sessionID)
        },
        invalidate(sessionID: string) {
          calls.invalidates.push(sessionID)
        },
      },
    },
  }

  const ui = {
    router: {
      navigate(destination: Record<string, unknown>) {
        calls.navigations.push(destination)
        if (options.route !== "home") route = destination
      },
      ...(options.omitCurrent ? {} : { current: () => route }),
    },
  }

  return {
    context: (() => {
      const value: Record<string, unknown> = { client, data, ui }
      if (!options.omitLocation) {
        value.location = {
          directory: project,
          project: { directory: project, canonical: project },
        }
      }
      return value
    })() as unknown as NativeProbeContext,
    calls,
  }
}

function fakeTiming() {
  let scheduled: (() => void) | undefined
  let delay = -1
  let cancelled: unknown
  return {
    timing: {
      schedule: (callback: () => void, delayMs: number) => {
        scheduled = callback
        delay = delayMs
        return "timer-1"
      },
      cancel: (handle: unknown) => {
        cancelled = handle
      },
      recoveryDelayMs: 60_000,
    },
    get scheduled() {
      return scheduled
    },
    get delay() {
      return delay
    },
    get cancelled() {
      return cancelled
    },
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("native replacement TUI core", () => {
  test("imports two parentless roots, verifies history, and observes the candidate route", async () => {
    const dirs = makeRoot()
    const fake = createFakeContext(dirs.project)
    const outcome = await runNativeTuiProbe(fake.context, dirs.env)

    expect(outcome.result).toEqual({
      probe: "sessionport-native-replacement-tui",
      version: 1,
      ok: true,
      stage: "complete",
      reason: "none",
      importedCount: 2,
      oldMessageCount: 2,
      candidateMessageCount: 3,
      nativeRouteObserved: true,
      parentlessVerified: true,
      archiveNotTested: true,
      composerNotTested: true,
      pickerNotTested: true,
    })
    expect(fake.calls.imports).toHaveLength(2)
    expect(fake.calls.imports[0]!.messages).toHaveLength(2)
    expect(fake.calls.imports[1]!.messages).toHaveLength(3)
    for (const payload of fake.calls.imports) {
      expect(Object.prototype.hasOwnProperty.call(payload, "parentID")).toBe(false)
      expect(Object.prototype.hasOwnProperty.call(payload.info, "parentID")).toBe(false)
    }
    expect(fake.calls.imports[0]!.info.projectID).toBe("native-replacement-tui-probe")
    expect(fake.calls.imports[1]!.info.projectID).toBe("host-canonical-project")
    expect(fake.calls.imports[1]!.info.title).toBe(CANDIDATE_TITLE)
    expect(fake.calls.imports[1]!.messages[2]!.text).toBe(SYNTHETIC_TAIL_TEXT)
    expect(fake.calls.lists.every((call) => call.order === "asc" && call.limit === 50)).toBe(true)
    expect(fake.calls.navigations).toEqual([
      { type: "session", sessionID: fake.calls.imports[1]!.info.id },
    ])
    expect(fake.calls.syncs).toContain(fake.calls.imports[1]!.info.id)

    expect(writeNativeProbeResult(dirs.env, outcome.result, outcome.forbidden)).toBe(true)
    const raw = readFileSync(dirs.resultPath, "utf8")
    const parsed = JSON.parse(raw) as NativeProbeResult
    expect(isNativeProbeResult(parsed)).toBe(true)
    expect(Object.keys(parsed).sort()).toEqual([...EXPECTED_KEYS].sort())
    expect(Buffer.byteLength(raw, "utf8")).toBeLessThanOrEqual(4096)
    for (const forbidden of outcome.forbidden) {
      expect(raw).not.toContain(forbidden)
    }
  })

  test("fails closed before any API when the context project is not the isolated project", async () => {
    const dirs = makeRoot()
    const fake = createFakeContext(path.join(dirs.root, "other"))
    const outcome = await runNativeTuiProbe(fake.context, dirs.env)

    expect(outcome.result.stage).toBe("preflight")
    expect(outcome.result.reason).toBe("isolation")
    expect(outcome.result.ok).toBe(false)
    expect(fake.calls.imports).toHaveLength(0)
    expect(fake.calls.gets).toHaveLength(0)
    expect(fake.calls.lists).toHaveLength(0)
  })

  test("fails closed before any API when the public location is absent", async () => {
    const dirs = makeRoot()
    const fake = createFakeContext(dirs.project, { omitLocation: true })
    const outcome = await runNativeTuiProbe(fake.context, dirs.env)

    expect(outcome.result.stage).toBe("preflight")
    expect(outcome.result.reason).toBe("isolation")
    expect(outcome.result.ok).toBe(false)
    expect(fake.calls.imports).toHaveLength(0)
  })

  test("fails with a fixed capability reason when public import is missing", async () => {
    const dirs = makeRoot()
    const fake = createFakeContext(dirs.project, { omitImport: true })
    const outcome = await runNativeTuiProbe(fake.context, dirs.env)

    expect(outcome.result.stage).toBe("preflight")
    expect(outcome.result.reason).toBe("capability")
    expect(outcome.result.importedCount).toBe(0)
    expect(fake.calls.imports).toHaveLength(0)
  })

  test("rejects a parented old readback as history failure", async () => {
    const dirs = makeRoot()
    const fake = createFakeContext(dirs.project, { parentOnOld: true })
    const outcome = await runNativeTuiProbe(fake.context, dirs.env)

    expect(outcome.result.stage).toBe("import-old")
    expect(outcome.result.reason).toBe("history")
    expect(outcome.result.importedCount).toBe(1)
    expect(outcome.result.parentlessVerified).toBe(false)
  })

  test("rejects the replayed payload update timestamp", async () => {
    const dirs = makeRoot()
    const fake = createFakeContext(dirs.project, { replayedUpdated: true })
    const outcome = await runNativeTuiProbe(fake.context, dirs.env)

    expect(outcome.result.stage).toBe("import-old")
    expect(outcome.result.reason).toBe("history")
    expect(outcome.result.ok).toBe(false)
  })

  test("rejects a short old history without navigating", async () => {
    const dirs = makeRoot()
    const fake = createFakeContext(dirs.project, { oldMessages: 1 })
    const outcome = await runNativeTuiProbe(fake.context, dirs.env)

    expect(outcome.result.stage).toBe("import-old")
    expect(outcome.result.reason).toBe("history")
    expect(outcome.result.oldMessageCount).toBe(1)
    expect(fake.calls.navigations).toHaveLength(0)
  })

  test("rejects a short candidate history before navigating", async () => {
    const dirs = makeRoot()
    const fake = createFakeContext(dirs.project, { candidateMessages: 2 })
    const outcome = await runNativeTuiProbe(fake.context, dirs.env)

    expect(outcome.result.stage).toBe("import-candidate")
    expect(outcome.result.reason).toBe("history")
    expect(outcome.result.importedCount).toBe(2)
    expect(outcome.result.candidateMessageCount).toBe(2)
    expect(fake.calls.navigations).toHaveLength(0)
  })

  test("does not claim a route the public context does not report", async () => {
    const dirs = makeRoot()
    const fake = createFakeContext(dirs.project, { route: "home" })
    const outcome = await runNativeTuiProbe(fake.context, dirs.env)

    expect(outcome.result.stage).toBe("navigate")
    expect(outcome.result.reason).toBe("navigation")
    expect(outcome.result.nativeRouteObserved).toBe(false)
    expect(outcome.result.ok).toBe(false)
  })

  test("reports a partial navigate phase when the route reader is absent", async () => {
    const dirs = makeRoot()
    const fake = createFakeContext(dirs.project, { omitCurrent: true })
    const outcome = await runNativeTuiProbe(fake.context, dirs.env)

    expect(outcome.result.stage).toBe("navigate")
    expect(outcome.result.reason).toBe("capability")
    expect(outcome.result.nativeRouteObserved).toBe(false)
    expect(outcome.result.ok).toBe(false)
  })

  test("accepts the live host shape where location.directory is a subroot of the project", async () => {
    const dirs = makeRoot()
    const fake = createFakeContext(dirs.project)
    ;(fake.context as { location: unknown }).location = {
      directory: path.join(dirs.project, "subroot"),
      project: { directory: dirs.project, canonical: dirs.project },
    }

    const outcome = await runNativeTuiProbe(fake.context, dirs.env)

    expect(outcome.result.ok).toBe(true)
    expect(outcome.result.stage).toBe("complete")
  })

  test("fails closed when the host project readback is absent", async () => {
    const dirs = makeRoot()
    const fake = createFakeContext(dirs.project)
    ;(fake.context as { location: unknown }).location = { directory: dirs.project }

    const outcome = await runNativeTuiProbe(fake.context, dirs.env)

    expect(outcome.result.stage).toBe("preflight")
    expect(outcome.result.reason).toBe("isolation")
    expect(fake.calls.imports).toHaveLength(0)
  })

  test("ignores the raw location when the host project path is the isolated project", async () => {
    const dirs = makeRoot()
    const fake = createFakeContext(dirs.project)
    ;(fake.context as { location: unknown }).location = {
      directory: path.join(dirs.root, "outside"),
      project: { directory: dirs.project, canonical: dirs.project },
    }

    const outcome = await runNativeTuiProbe(fake.context, dirs.env)

    expect(outcome.result.ok).toBe(true)
    expect(outcome.result.stage).toBe("complete")
  })

  test("fails closed when the host project path is outside the isolated project", async () => {
    const dirs = makeRoot()
    mkdirSync(path.join(dirs.root, "outside"))
    const fake = createFakeContext(dirs.project)
    ;(fake.context as { location: unknown }).location = {
      directory: dirs.project,
      project: { directory: path.join(dirs.root, "outside") },
    }

    const outcome = await runNativeTuiProbe(fake.context, dirs.env)

    expect(outcome.result.stage).toBe("preflight")
    expect(outcome.result.reason).toBe("isolation")
    expect(fake.calls.imports).toHaveLength(0)
  })

  test("waits briefly for the host project readback before failing isolation", async () => {
    const dirs = makeRoot()
    const fake = createFakeContext(dirs.project)
    let reads = 0
    Object.defineProperty(fake.context, "location", {
      configurable: true,
      get() {
        reads += 1
        if (reads <= 2) return undefined
        return { directory: dirs.project, project: { directory: dirs.project, canonical: dirs.project } }
      },
    })

    const outcome = await runNativeTuiProbe(fake.context, dirs.env)

    expect(outcome.result.ok).toBe(true)
    expect(reads).toBeGreaterThan(2)
  })
})

describe("native replacement archive branch", () => {
  async function runArchiveCase(options: FakeOptions = {}) {
    const dirs = makeRoot()
    const fake = createFakeContext(dirs.project, options)
    const clock = fakeTiming()
    const outcome = await runArchiveTuiProbe(fake.context, dirs.env, clock.timing)
    const oldID = String(fake.calls.imports[0]?.info.id ?? "")
    const candidateID = String(fake.calls.imports[1]?.info.id ?? "")
    return { dirs, fake, clock, outcome, oldID, candidateID }
  }

  test("archives only the old fixture, verifies recovery, and writes the v2 schema", async () => {
    const { dirs, fake, clock, outcome, oldID, candidateID } = await runArchiveCase()

    expect(outcome.result).toMatchObject({
      probe: "sessionport-native-replacement-tui-archive",
      version: 2,
      ok: false,
      stage: "navigate",
      reason: "none",
      archiveCall: "accepted",
      archiveReadback: "archived",
      archiveNotTested: false,
      recoveryReadback: "not-read",
      recoveryVerified: false,
      mutationTargetOldOnly: true,
      importedCount: 2,
      oldMessageCount: 2,
      candidateMessageCount: 3,
      parentlessVerified: true,
      nativeRouteObserved: true,
    })
    expect(typeof clock.scheduled).toBe("function")
    expect(clock.delay).toBe(60_000)
    expect(writeArchiveProbeResult(dirs.env, outcome.result, outcome.forbidden)).toBe(true)
    expect(fake.calls.updates).toEqual([{ sessionID: oldID, archived: true }])
    expect(fake.calls.updates.every((item) => item.sessionID === oldID)).toBe(true)
    expect(fake.calls.updates.some((item) => item.sessionID === candidateID)).toBe(false)
    expect(fake.calls.invalidates).toEqual(expect.arrayContaining([oldID, candidateID]))

    await outcome.recoverNow()

    expect(outcome.result).toMatchObject({
      ok: true,
      stage: "complete",
      reason: "none",
      archiveCall: "accepted",
      archiveReadback: "archived",
      archiveNotTested: false,
      recoveryReadback: "active",
      recoveryVerified: true,
      mutationTargetOldOnly: true,
    })
    expect(fake.calls.updates).toEqual([
      { sessionID: oldID, archived: true },
      { sessionID: oldID, archived: false },
    ])
    expect(fake.calls.updates.every((item) => item.sessionID === oldID)).toBe(true)
    expect(fake.calls.updates.some((item) => item.sessionID === candidateID)).toBe(false)

    const raw = readFileSync(dirs.resultPath, "utf8")
    const parsed = JSON.parse(raw)
    expect(isArchiveProbeResult(parsed)).toBe(true)
    expect(Object.keys(parsed)).toHaveLength(18)
    expect(Buffer.byteLength(raw, "utf8")).toBeLessThanOrEqual(4096)
    for (const forbidden of outcome.forbidden) expect(raw).not.toContain(forbidden)

    outcome.cancelRecovery()
    expect(clock.cancelled).toBe("timer-1")
  })

  test("reports unsupported when the public update adapter is absent and never mutates", async () => {
    const { dirs, fake, clock, outcome } = await runArchiveCase({ omitUpdate: true })

    expect(outcome.result).toMatchObject({
      ok: false,
      stage: "archive",
      reason: "capability",
      archiveCall: "unsupported",
      archiveReadback: "active",
      archiveNotTested: true,
      recoveryReadback: "not-read",
      recoveryVerified: false,
    })
    expect(fake.calls.updates).toHaveLength(0)
    expect(clock.scheduled).toBeUndefined()
    expect(writeArchiveProbeResult(dirs.env, outcome.result, outcome.forbidden)).toBe(true)
  })

  test("a stripped archive field leaves the root active and never unarchives", async () => {
    const { fake, clock, outcome } = await runArchiveCase({ stripArchive: true })

    expect(outcome.result).toMatchObject({
      ok: false,
      stage: "verify-archive",
      reason: "archive",
      archiveCall: "accepted",
      archiveReadback: "active",
      archiveNotTested: false,
      recoveryReadback: "not-read",
      recoveryVerified: false,
    })
    expect(fake.calls.updates).toEqual([{ sessionID: expect.any(String), archived: true }])
    expect(clock.scheduled).toBeUndefined()
  })

  test("a transport error with archived readback is treated as applied and recovery still verifies", async () => {
    const { fake, outcome, oldID } = await runArchiveCase({ throwArchive: "applied" })

    expect(outcome.result).toMatchObject({
      archiveCall: "error",
      archiveReadback: "archived",
      archiveNotTested: false,
      ok: false,
    })
    await outcome.recoverNow()
    expect(outcome.result).toMatchObject({
      ok: true,
      stage: "complete",
      recoveryReadback: "active",
      recoveryVerified: true,
    })
    expect(fake.calls.updates).toEqual([
      { sessionID: oldID, archived: true },
      { sessionID: oldID, archived: false },
    ])
  })

  test("an unknown archive state fails closed without unarchive", async () => {
    const { fake, clock, outcome } = await runArchiveCase({ archiveUnknown: true })

    expect(outcome.result).toMatchObject({
      ok: false,
      stage: "verify-archive",
      reason: "archive",
      archiveCall: "accepted",
      archiveReadback: "unknown",
      archiveNotTested: false,
      recoveryReadback: "not-read",
      recoveryVerified: false,
    })
    expect(fake.calls.updates).toHaveLength(1)
    expect(clock.scheduled).toBeUndefined()
  })

  test("recovery failure cannot pass and does not retry", async () => {
    const { fake, outcome, oldID } = await runArchiveCase({ recoveryStuck: true })

    await outcome.recoverNow()

    expect(outcome.result).toMatchObject({
      ok: false,
      stage: "verify-recovery",
      reason: "recovery",
      archiveReadback: "archived",
      recoveryReadback: "archived",
      recoveryVerified: false,
    })
    expect(fake.calls.updates).toEqual([
      { sessionID: oldID, archived: true },
      { sessionID: oldID, archived: false },
    ])
  })

  test("only the exact fixed archive switch value is enabled", () => {
    expect(archiveProbeEnabled({ SP_PROBE_ARCHIVE: "1" })).toBe(true)
    expect(archiveProbeEnabled({ SP_PROBE_ARCHIVE: "true" })).toBe(false)
    expect(archiveProbeEnabled({ SP_PROBE_ARCHIVE: "0" })).toBe(false)
    expect(archiveProbeEnabled({})).toBe(false)
  })

  test("archiveNotTested cannot be false without an actual attempt", () => {
    const result = { ...createArchiveProbeResult(), archiveNotTested: false, archiveCall: "not-attempted" as const }
    expect(isArchiveProbeResult(result)).toBe(false)
  })
})

describe("actual runner environment contract", () => {
  test("New-ProbeEnvironmentBlock output passes the plugin isolation validator", () => {
    if (process.platform !== "win32") return
    const dirs = makeContractRoot()
    mkdirSync(path.join(dirs.root, "outside"))
    const env = readRunnerEnvironment(dirs.root)

    expect(String(env.SP_PROBE_ROOT).toLowerCase()).toBe(dirs.root.toLowerCase())
    expect(String(env.SP_PROBE_PROJECT).toLowerCase()).toBe(dirs.project.toLowerCase())
    expect(String(env.SP_PROBE_RESULT).toLowerCase()).toBe(dirs.resultPath.toLowerCase())
    expect(env.SP_PROBE_PHASE).toBe("probe")
    expect(env.SP_PROBE_ISOLATED).toBeUndefined()
    expect(env.SP_PROBE_ARCHIVE).toBeUndefined()

    const archiveEnv = readRunnerEnvironment(dirs.root, true)
    expect(archiveEnv.SP_PROBE_ARCHIVE).toBe("1")

    const context = {
      ...createFakeContext(dirs.project).context,
      location: {
        directory: path.join(dirs.project, "subroot"),
        project: { directory: dirs.project, canonical: dirs.project },
      },
    } as unknown as NativeProbeContext

    expect(validateIsolation(context, archiveEnv)).toBe(true)
    expect(validateIsolation(context, env)).toBe(true)
    expect(
      validateIsolation({ ...context, location: { directory: dirs.project } } as unknown as NativeProbeContext, env),
    ).toBe(false)
    expect(
      validateIsolation(
        {
          ...context,
          location: {
            directory: dirs.project,
            project: { directory: dirs.root },
          },
        } as unknown as NativeProbeContext,
        env,
      ),
    ).toBe(true)
    expect(
      validateIsolation(
        {
          ...context,
          location: {
            directory: dirs.project,
            project: { directory: path.join(dirs.project, "subroot") },
          },
        } as unknown as NativeProbeContext,
        env,
      ),
    ).toBe(true)
    expect(
      validateIsolation(
        {
          ...context,
          location: {
            directory: path.join(dirs.root, "outside"),
            project: { directory: dirs.project },
          },
        } as unknown as NativeProbeContext,
        env,
      ),
    ).toBe(true)
    expect(
      validateIsolation(
        {
          ...context,
          location: {
            directory: dirs.project,
            project: { directory: path.join(dirs.root, "outside") },
          },
        } as unknown as NativeProbeContext,
        env,
      ),
    ).toBe(false)
    expect(
      validateIsolation(context, { ...env, SP_PROBE_RESULT: path.join(dirs.root, "probe-result.json") }),
    ).toBe(false)
  })

  test("actual bundle validates the actual runner environment contract", async () => {
    if (process.platform !== "win32") return
    const bundlePath = path.join(
      process.cwd(),
      ".package-verify-work",
      "m1-native-tui-plugin-20261024",
      "tui.tsx",
    )
    if (!existsSync(bundlePath)) return
    const bundle = (await import(pathToFileURL(bundlePath).href)) as {
      default?: { id?: string }
      validateIsolation?: (context: NativeProbeContext, env: ProbeEnv) => boolean
      archiveProbeEnabled?: (env: ProbeEnv) => boolean
      runArchiveTuiProbe?: (
        context: NativeProbeContext,
        env: ProbeEnv,
        timing?: { schedule?: (callback: () => void, delayMs: number) => unknown; cancel?: (handle: unknown) => void; recoveryDelayMs?: number },
      ) => Promise<{ result: { ok: boolean }; forbidden: readonly string[]; recoverNow: () => Promise<void> }>
      writeArchiveProbeResult?: (env: ProbeEnv, result: unknown, forbidden: readonly string[]) => boolean
    }
    expect(bundle.default?.id).toBe("sessionport-native-replacement-tui-probe")
    expect(typeof bundle.validateIsolation).toBe("function")

    const dirs = makeContractRoot()
    const env = readRunnerEnvironment(dirs.root)
    const archiveEnv = readRunnerEnvironment(dirs.root, true)
    const context = {
      location: {
        directory: path.join(dirs.project, "subroot"),
        project: { directory: dirs.project, canonical: dirs.project },
      },
    } as unknown as NativeProbeContext
    expect(bundle.validateIsolation!(context, env)).toBe(true)
    expect(bundle.validateIsolation!(context, archiveEnv)).toBe(true)
    expect(bundle.archiveProbeEnabled?.(archiveEnv)).toBe(true)
    expect(bundle.archiveProbeEnabled?.(env)).toBe(false)

    const fake = createFakeContext(dirs.project)
    const clock = fakeTiming()
    const outcome = await bundle.runArchiveTuiProbe!(fake.context, archiveEnv, clock.timing)
    expect(outcome.result.ok).toBe(false)
    await outcome.recoverNow()
    expect(outcome.result.ok).toBe(true)
    expect(bundle.writeArchiveProbeResult!(archiveEnv, outcome.result, outcome.forbidden)).toBe(true)
  })
})

describe("native replacement result writer", () => {
  test("rejects a foreign result path", async () => {
    const dirs = makeRoot()
    const result = createProbeResult()
    const foreign = { ...dirs.env, SP_PROBE_RESULT: path.join(dirs.root, "probe-result.json") }
    expect(writeNativeProbeResult(foreign, result, [])).toBe(false)
    expect(existsSync(path.join(dirs.root, "probe-result.json"))).toBe(false)
  })

  test("rejects extra keys and forbidden content before writing", async () => {
    const dirs = makeRoot()
    const result = createProbeResult()
    expect(writeNativeProbeResult(dirs.env, { ...result, extra: "x" } as unknown as NativeProbeResult, [])).toBe(false)
    expect(writeNativeProbeResult(dirs.env, { ...result, ok: true } as NativeProbeResult, [])).toBe(false)
    expect(
      writeNativeProbeResult(dirs.env, { ...result, archiveNotTested: false } as unknown as NativeProbeResult, []),
    ).toBe(false)
    expect(writeNativeProbeResult(dirs.env, result, ["sessionport-native-replacement-tui"])).toBe(false)
    expect(existsSync(dirs.resultPath)).toBe(false)
  })

  test("writes atomically and preserves the exact bounded schema", async () => {
    const dirs = makeRoot()
    const result = createProbeResult()
    expect(writeNativeProbeResult(dirs.env, result, [])).toBe(true)
    const raw = readFileSync(dirs.resultPath, "utf8")
    const parsed = JSON.parse(raw)
    expect(isNativeProbeResult(parsed)).toBe(true)
    expect(Object.keys(parsed).sort()).toEqual([...EXPECTED_KEYS].sort())
    expect(existsSync(`${dirs.resultPath}.tmp`)).toBe(false)
  })
})

describe("native replacement source guard", () => {
  const source = readFileSync(new URL("./entry.tsx", import.meta.url), "utf8")

  test("contains the required public-context and plugin markers", () => {
    for (const marker of [
      "Plugin.define",
      'append: "app"',
      "let started = false",
      "if (started) return",
      "context.client.session.import",
      "context.client.session.get",
      "context.client.message.list",
      "context.data.session.sync",
      "context.data.session.message.sync",
      "context.ui.router.navigate",
      "SP_PROBE_ROOT",
      "SP_PROBE_PROJECT",
      "SP_PROBE_RESULT",
      "archiveNotTested: true",
      "composerNotTested: true",
      "pickerNotTested: true",
      "runArchiveTuiProbe",
      "SP_PROBE_ARCHIVE",
      "archiveNotTested",
      "recoveryVerified",
      "mutationTargetOldOnly",
      "session.update",
      "onCleanup",
    ]) {
      expect(source).toContain(marker)
    }
  })

  test("does not call forbidden public operations", () => {
    for (const pattern of [
      /context\.client\.session\.list\s*\(/,
      /context\.client\.provider/,
      /\.prompt\s*\(/,
      /\.command\s*\(/,
      /\.shell\s*\(/,
      /\.generate\s*\(/,
      /\.tool\s*\(/,
      /\.model\s*\(/,
      /\.login\s*\(/,
      /\.delete\s*\(/,
      /\.remove\s*\(/,
      /\.update\s*\(/,
      /\.archive\s*\(/,
      /\.unarchive\s*\(/,
      /process\.exit\s*\(/,
      /child_process/,
      /fetch\s*\(/,
    ]) {
      expect(source).not.toMatch(pattern)
    }
  })
})
