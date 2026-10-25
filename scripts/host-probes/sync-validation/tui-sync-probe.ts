/**
 * SessionPort native `/sync` validation probe plugin (Windows actual-TUI,
 * disposable isolated root).
 *
 * Staged under `<root>\config\plugins\sp-native-sync-probe\tui.ts` by
 * `run-command-integration-probe.ps1 -NativeSyncValidation`. It installs the
 * REAL `installSessionPortWiring` with the real product defaults (real crypto
 * profile, real masked modal, real cloud-auth flow) and one test-only wrapper:
 * `context.options.sessionportCloud` carries the explicit isolated runtime
 * configuration, and `ui.toast.show` is observed for bounded facts
 * (variant token + message length only) while still being forwarded to the
 * host. The login dialog is not wrapped or read: the verification URL/code
 * stay in the host UI only. The host alert callback is forwarded without
 * reading its title/message/content (only a fixed status observation and a
 * bounded persist are recorded).
 *
 * The plugin never dispatches `/sync`, never calls the controller directly,
 * never logs in programmatically, and makes no model/prompt/tool call. The
 * owner issues `/sync login`, `/sync status`, and `/sync logout` manually.
 *
 * Before wiring, it reads the unique fresh service/account once through the
 * real pinned keyring adapter (real AsyncEntry, no fake vault) and fails
 * closed without installing if an entry already exists or absence cannot be
 * proven. Nothing is written, overwritten, or deleted here.
 *
 * The result JSON carries fixed-safe booleans/counts only: no user code,
 * verification URL, token, credential, identity, dialog content, or path.
 */

import { readFileSync, renameSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

const PLUGIN_ID = "sp-native-sync-probe"
const PROBE_NAME = "sessionport-native-sync-validation"
const REGISTRATION_TIMEOUT_MS = 30000
const POLL_INTERVAL_MS = 200
const MAX_OBSERVED_NOTIFICATIONS = 32
export const MAX_OBSERVED_EVENTS = 16
const MAX_RESULT_WRITES = 12
const PINNED_KEYRING_VERSION = "2.1.2"
const PINNED_NATIVE_VERSION = "2.1.2"
// Fixed response-field allowlist. Only these names may appear in the harness
// record; any other key contributes to a count, never to the recorded names.
const NATIVE_RESPONSE_FIELDS = new Set([
  "deviceCode", "userCode", "verificationUri", "expiresIn", "pollInterval",
  "accessToken", "refreshToken", "expiresAt", "tokenType", "scope",
  "error", "errorDescription", "code"
])
// Fixed error-code categories. Recognized product wire codes are recorded by
// their fixed name; any other server code is recorded as unrecognized (never
// its raw dynamic text).
const NATIVE_WIRE_ERROR_CODES = new Set([
  "authorization-pending", "slow-down", "authorization-denied",
  "authorization-expired", "authorization-consumed", "invalid-credential",
  "refresh-replay", "state-conflict"
])
const NATIVE_OMITTED_ERROR_CODES = new Set([
  "rate-limited", "quota-not-provisioned", "unavailable", "internal-error"
])
const NATIVE_PATH_KINDS = new Map([
  ["/api/native/v1/device-authorizations", "begin"],
  ["/api/native/v1/token", "token"]
])
// Fixed status allowlist. A controller value outside this set is recorded as
// `unknown`, never as raw text.
const OBSERVED_STATUS_VALUES = new Set([
  "signed-in", "signed-out", "reauth-required", "unavailable", "busy",
  "unconfigured", "cancelled", "denied", "expired"
])
const SYNC_EVENTS = new Map([
  ["login", "sync:login"],
  ["status", "sync:status"],
  ["logout", "sync:logout"],
  ["usage", "sync:usage"],
  ["unsupported", "sync:unsupported"]
])
const INTERNAL_STATUS_EVENTS = new Map([
  ["login", "status:internal:login"],
  ["logout", "status:internal:logout"],
  ["usage", "status:internal:usage"],
  ["none", "status:internal:none"]
])
const OBSERVED_EVENT_ALLOWLIST = new Set([
  "sync:login", "sync:status", "sync:logout", "sync:usage", "sync:unsupported",
  "status:owner", "status:post-logout", "status:internal:login",
  "status:internal:logout",
  "status:internal:usage", "status:internal:none",
  "login:terminal", "logout:terminal", "alert:observed"
])
const DEFAULT_COMMAND_CONTEXT = Object.freeze({ action: "none" })

function observedStatus(value) {
  return typeof value === "string" && OBSERVED_STATUS_VALUES.has(value) ? value : "unknown"
}

function recordObservedEvent(observations, event) {
  // Ordered fixed-enum history only; bounded and never contains raw values.
  if (!OBSERVED_EVENT_ALLOWLIST.has(event)) return
  if (observations.events.length >= MAX_OBSERVED_EVENTS) return
  observations.events.push(event)
}


export function createNativeObservations() {
  return {
    terminalOutcome: "unknown",
    loginOutcome: "unknown",
    // Command-proven pre-logout status: set only by a controller.status call
    // made directly inside the owner's explicit `/sync status` dispatch before
    // a logout terminal result. Internal login/logout preflights never overwrite
    // it, and a later post-logout status is recorded separately.
    statusResult: "unknown",
    // Explicit `/sync logout` starts by preserving the current command-proven
    // status (or alert observation fallback) here.
    preLogoutStatusResult: "unknown",
    // Explicit `/sync status` observed after a logout terminal result. Kept
    // separate so the pre-logout evidence above is never lost.
    postLogoutStatusResult: "unknown",
    // Latest scalar controller.status response, including internal preflights.
    // Context only; it is not owner evidence.
    lastStatusResult: "unknown",
    // Latest status observed at the most recent host alert. Observation-only:
    // an alert is not proof of which command produced the status.
    alertStatusResult: "unknown",
    events: [],
    beginStatus: null,
    pollLastStatus: null,
    tokenStatus: null,
    errorCategory: "unknown",
    vaultCommitOutcome: "not-observed",
    beginFields: [],
    pollLastFields: [],
    tokenFields: [],
    unknownKeyCount: 0
  }
}

export function sanitizeNativeResponseText(text) {
  // Untrusted body: only allowlisted field names are copied; nested values and
  // arbitrary key names are never recorded. Error classification uses only a
  // fixed code set.
  const result = { fields: [], unknownKeyCount: 0, errorCategory: "unknown" }
  let parsed
  try { parsed = JSON.parse(text) } catch (error) { return result }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return result
  for (const key of Object.keys(parsed)) {
    if (NATIVE_RESPONSE_FIELDS.has(key)) result.fields.push(key)
    else result.unknownKeyCount += 1
  }
  const error = parsed.error
  if (error !== null && typeof error === "object" && !Array.isArray(error)) {
    const code = error.code
    if (typeof code === "string") {
      if (NATIVE_WIRE_ERROR_CODES.has(code)) result.errorCategory = code
      else if (NATIVE_OMITTED_ERROR_CODES.has(code)) result.errorCategory = "omitted-by-wire-allowlist"
      else result.errorCategory = "unrecognized-error-code"
    }
  }
  return result
}

export function wrapObservedController(controller, observations, commandContext) {
  // Real controller delegates; only fixed outcome/status strings are recorded.
  const context =
    commandContext !== null && typeof commandContext === "object"
      ? commandContext
      : DEFAULT_COMMAND_CONTEXT
  return {
    login: async function (options) {
      const outcome = await controller.login(options)
      observations.terminalOutcome = observedStatus(outcome?.status)
      recordObservedEvent(observations, "login:terminal")
      if (observations.loginOutcome === "unknown") observations.loginOutcome = observations.terminalOutcome
      observations.vaultCommitOutcome = outcome?.status === "signed-in" ? "controller-result-signed-in" : "not-observed"
      return outcome
    },
    status: async function () {
      // Snapshot the dispatch context before awaiting: slash commands are not
      // serialized by the host, so the mutable context may belong to another
      // command by the time the controller settles.
      const actionAtCall = context.action
      const logoutTerminalAtCall = context.logoutTerminal === true
      const outcome = await controller.status()
      const status = observedStatus(outcome?.status)
      observations.lastStatusResult = status
      if (actionAtCall === "status") {
        if (logoutTerminalAtCall) {
          // A later explicit status must not erase pre-logout evidence.
          observations.postLogoutStatusResult = status
          recordObservedEvent(observations, "status:post-logout")
        } else {
          observations.statusResult = status
          recordObservedEvent(observations, "status:owner")
        }
      } else {
        recordObservedEvent(
          observations,
          INTERNAL_STATUS_EVENTS.get(actionAtCall) ?? "status:internal:none"
        )
      }
      return outcome
    },
    logout: async function () {
      const outcome = await controller.logout()
      observations.terminalOutcome = observedStatus(outcome?.status)
      if (observations.terminalOutcome === "signed-out") context.logoutTerminal = true
      recordObservedEvent(observations, "logout:terminal")
      return outcome
    },
    dispose: function () {
      return controller.dispose()
    }
  }
}

export function recordAlertObservation(observations) {
  // Host alert reached without reading its title/message/content. Persisted
  // later by the harness alert wrapper. Observation-only: it cannot prove that
  // the alert was produced by an explicit owner status command.
  if (observations.lastStatusResult !== "unknown") {
    observations.alertStatusResult = observations.lastStatusResult
  }
  recordObservedEvent(observations, "alert:observed")
}

export function createObservedCloudAuthFactory(
  modules,
  observations,
  commandContext,
  controllerDependencies
) {
  // Exact factory used by the staged plugin; exported only for host-free tests
  // that drive the real command/wiring path.
  const extra = controllerDependencies && typeof controllerDependencies === "object"
    ? controllerDependencies
    : {}
  return function (cloudContext) {
    // Real controller (partial public seam: fetch only), real flow, real UI.
    const controller = modules.controllerModule.createCloudAuthController(
      cloudContext.options.sessionportCloud,
      Object.assign({}, extra, {
        fetch: createObservedFetch(function (url, init) {
          return Reflect.apply(globalThis.fetch, globalThis, [url, init])
        }, observations)
      })
    )
    const observedController = wrapObservedController(controller, observations, commandContext)
    const ui = modules.dialogModule.createCloudAuthUi(cloudContext)
    const handlers = modules.flowModule.createCloudAuthHandlers({ getController: function () { return observedController }, ui: ui })
    const reportUnsupported = async function () {
      const message = "Unsupported /sync action. Use login, status, or logout."
      try { await ui.alert({ title: "SessionPort cloud sign-in", message: message }) }
      catch (error) { try { ui.toast({ message: message, variant: "warning" }) } catch (inner) { } }
    }
    const sync = async function (rawInput) {
      // The only place an explicit owner command is provable. Context is
      // cleared in finally so a later internal preflight is never counted.
      const action = modules.cloudAuthModule.parseCloudAuthSyncAction(rawInput)
      recordObservedEvent(observations, SYNC_EVENTS.get(action) ?? "sync:unsupported")
      commandContext.action = action
      try {
        if (action === "usage") return await handlers.usage()
        if (action === "unsupported") return await reportUnsupported()
        if (action === "login") return await handlers.login()
        if (action === "status") return await handlers.status()
        const preLogout =
          observations.statusResult !== "unknown"
            ? observations.statusResult
            : observations.alertStatusResult
        if (preLogout !== "unknown") observations.preLogoutStatusResult = preLogout
        return await handlers.logout()
      } finally {
        commandContext.action = "none"
      }
    }
    return Object.freeze(Object.assign({}, handlers, { sync: sync }))
  }
}

export function createObservedFetch(realFetch, observations) {
  // Controller-scoped fetch only (no global monkeypatch). Records method, fixed
  // path kind, HTTP status, allowlisted field names, and a fixed error category.
  return async function (url, init) {
    const method = init !== undefined && typeof init.method === "string" ? init.method.toUpperCase() : "GET"
    let pathKind = "other"
    try {
      const pathname = new URL(url).pathname
      pathKind = NATIVE_PATH_KINDS.get(pathname) ?? "other"
    } catch (error) {
      pathKind = "other"
    }
    let response
    try {
      response = await Reflect.apply(realFetch, globalThis, [url, init])
    } catch (error) {
      observations.errorCategory = "transport-error"
      throw error
    }
    const status = typeof response.status === "number" ? response.status : null
    let text = ""
    try { text = await response.clone().text() } catch (error) { text = "" }
    const sanitized = sanitizeNativeResponseText(text)
    if (pathKind === "begin") {
      observations.beginStatus = status
      observations.beginFields = sanitized.fields
    } else if (pathKind === "token") {
      observations.pollLastStatus = status
      observations.pollLastFields = sanitized.fields
      if (status !== null && status >= 200 && status < 300) {
        observations.tokenStatus = status
        observations.tokenFields = sanitized.fields
      }
    }
    if (sanitized.errorCategory !== "unknown") observations.errorCategory = sanitized.errorCategory
    if (status !== null && status >= 200 && status < 300) observations.errorCategory = "none"
    else if (status !== null && status >= 400 && sanitized.errorCategory === "unknown") observations.errorCategory = "http-error-unmapped"
    return response
  }
}

function readEnv(env, name) {
  return typeof env[name] === "string" ? env[name] : ""
}

function norm(value) {
  return path.resolve(value)
}

function isUnder(child, parent) {
  const rel = path.relative(norm(parent), norm(child))
  if (rel === "") return true
  return !rel.startsWith("..") && !path.isAbsolute(rel)
}

function errorInfo(error) {
  let name = "Error"
  if (error && typeof error === "object" && typeof error.name === "string" && error.name.length > 0) {
    name = error.name
  }
  if (!/^[A-Za-z][A-Za-z0-9_.]*$/.test(name)) name = "Error"
  return { name: name }
}

function writeResult(resultPath, data) {
  const tmp = resultPath + ".tmp"
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8")
  renameSync(tmp, resultPath)
}

function delay(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms) })
}

async function waitForCommands(keymap, expectedIDs, timeoutMs) {
  const found = {}
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    let commands = null
    try { commands = keymap.commands() } catch (error) { commands = null }
    if (Array.isArray(commands)) {
      const seen = {}
      for (const command of commands) {
        if (command && typeof command.id === "string") seen[command.id] = true
      }
      for (const id of expectedIDs) if (seen[id]) found[id] = true
      if (expectedIDs.every(function (id) { return found[id] === true })) break
    }
    await delay(POLL_INTERVAL_MS)
  }
  return {
    registered: expectedIDs.filter(function (id) { return found[id] === true }).length,
    expected: expectedIDs.length,
    allRegistered: expectedIDs.every(function (id) { return found[id] === true })
  }
}

function readPinnedPackageVersion(repoDir, relativePath) {
  // Staged pinned package metadata only; no host/global path is read.
  try {
    const parsed = JSON.parse(readFileSync(path.join(repoDir, relativePath), "utf8"))
    if (!parsed || typeof parsed !== "object") return null
    return { name: typeof parsed.name === "string" ? parsed.name : null, version: typeof parsed.version === "string" ? parsed.version : null }
  } catch (error) {
    return null
  }
}

function readCloudAuthConfig(env, root) {
  // Explicit, isolated configuration exactly as declared for this validation:
  // loopback HTTP origin with the explicit opt-in, the four test limits, a fresh
  // UUID vault service, the fixed account name, and a private state directory
  // under the disposable root. Not a production default.
  const origin = readEnv(env, "SP_SYNC_ORIGIN")
  const vaultService = readEnv(env, "SP_SYNC_VAULT_SERVICE")
  const vaultAccount = readEnv(env, "SP_SYNC_VAULT_ACCOUNT")
  const stateDirectory = readEnv(env, "SP_SYNC_STATE_DIR")
  const maxSecretText = readEnv(env, "SP_SYNC_MAX_SECRET_BYTES")
  const maxSecretBytes = /^[0-9]{1,7}$/.test(maxSecretText) ? Number(maxSecretText) : 0
  if (origin !== "http://127.0.0.1:43117") return null
  if (!/^sessionport-m3-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(vaultService)) return null
  if (vaultAccount !== "credential") return null
  if (stateDirectory.length === 0 || !path.isAbsolute(stateDirectory) || !isUnder(stateDirectory, root)) return null
  if (maxSecretBytes < 4096 || maxSecretBytes > 8192) return null
  return {
    origin: origin,
    allowLoopbackHttp: true,
    requestTimeoutMillis: 1000,
    maxResponseBytes: 4096,
    maxCredentialBytes: 4096,
    maxSecretBytes: maxSecretBytes,
    vaultService: vaultService,
    vaultAccount: vaultAccount,
    stateDirectory: stateDirectory
  }
}

async function readVaultEntryAbsence(config) {
  // Real pinned adapter + real native AsyncEntry; read-only. The existing
  // keyring module is resolved from the staged pinned packages placed beside the
  // staged source copy, never from a host/global node_modules. No write, no
  // overwrite, no delete, and no entry value is retained.
  try {
    const keyring = await import("../../../repo/src/cloud/vault/keyring.ts")
    const binding = await import("../../../repo/src/node_modules/@napi-rs/keyring/index.js")
    const AsyncEntry = binding && typeof binding.AsyncEntry === "function"
      ? binding.AsyncEntry
      : binding && binding.default && typeof binding.default.AsyncEntry === "function"
        ? binding.default.AsyncEntry
        : null
    if (typeof keyring.createKeyringVault !== "function" || AsyncEntry === null) {
      return { checked: false, absent: null, bindingLoaded: false }
    }
    const vault = keyring.createKeyringVault(AsyncEntry, { maxSecretBytes: config.maxSecretBytes })
    const existing = await vault.read({ service: config.vaultService, account: config.vaultAccount })
    return { checked: true, absent: existing === null, bindingLoaded: true }
  } catch (error) {
    return { checked: false, absent: null, bindingLoaded: false, error: errorInfo(error).name }
  }
}

export default {
  id: PLUGIN_ID,
  async setup(context) {
    const env = process.env
    const root = readEnv(env, "SP_SYNC_ROOT")
    const resultPath = readEnv(env, "SP_SYNC_RESULT")
    const repoDir = readEnv(env, "SP_SYNC_REPO")

    let homedir = ""
    let tmpdir = ""
    let cwd = ""
    try { homedir = os.homedir() } catch (error) { homedir = "" }
    try { tmpdir = os.tmpdir() } catch (error) { tmpdir = "" }
    try { cwd = process.cwd() } catch (error) { cwd = "" }

    const keyringPackage = readPinnedPackageVersion(repoDir, "src/node_modules/@napi-rs/keyring/package.json")
    const nativePackage = readPinnedPackageVersion(repoDir, "src/node_modules/@napi-rs/keyring-win32-x64-msvc/package.json")

    const result = {
      probe: PROBE_NAME,
      pluginID: PLUGIN_ID,
      stage: "isolation-gate",
      ok: false,
      failure: null,
      runtime: {
        bun: typeof Bun !== "undefined" ? Bun.version : null,
        node: process.version,
        platform: process.platform,
        arch: process.arch
      },
      isolation: {
        rootPresent: root.length > 0,
        checks: {},
        homedirUnderRoot: homedir.length > 0 && isUnder(homedir, root),
        tmpdirUnderRoot: tmpdir.length > 0 && isUnder(tmpdir, root),
        cwdUnderRoot: cwd.length > 0 && isUnder(cwd, root),
        repoUnderRoot: repoDir.length > 0 && isUnder(repoDir, root),
        resultPathUnderRoot: resultPath.length > 0 && isUnder(resultPath, root)
      },
      probeMode: {
        nativeSync: true,
        testWrapperOnly: true,
        originIsLoopbackHttp: true,
        allowLoopbackHttp: true,
        loginDispatchedByProbe: false,
        checkpointRestoreUsesProductDefaults: true
      },
      pinnedPackages: {
        keyringName: keyringPackage && keyringPackage.name === "@napi-rs/keyring" ? keyringPackage.name : null,
        keyringVersionPinned: Boolean(keyringPackage && keyringPackage.version === PINNED_KEYRING_VERSION),
        nativeName: nativePackage && nativePackage.name === "@napi-rs/keyring-win32-x64-msvc" ? nativePackage.name : null,
        nativeVersionPinned: Boolean(nativePackage && nativePackage.version === PINNED_NATIVE_VERSION)
      },
      vaultScope: {
        distinctService: true,
        accountIsCredential: true,
        preflightChecked: false,
        preflightAbsent: null,
        preflightBindingLoaded: null
      },
      wiring: { installed: false, disposerCallable: false },
      commands: { expected: 3, registered: 0, allRegistered: false },
      observations: {
        native: createNativeObservations(),
        notifications: 0,
        maxNotifications: MAX_OBSERVED_NOTIFICATIONS,
        dialogContentRead: false,
        verificationCodeCaptured: false,
        identityCaptured: false
      }
    }

    let writes = 0
    function persist(stage) {
      if (stage !== undefined) result.stage = stage
      if (writes >= MAX_RESULT_WRITES) return
      writes += 1
      try { writeResult(resultPath, result) } catch (error) { }
    }

    const isolationOk =
      result.isolation.rootPresent &&
      result.isolation.homedirUnderRoot &&
      result.isolation.tmpdirUnderRoot &&
      result.isolation.cwdUnderRoot &&
      result.isolation.repoUnderRoot &&
      result.isolation.resultPathUnderRoot
    result.isolation.checks = {
      homedir: result.isolation.homedirUnderRoot,
      tmpdir: result.isolation.tmpdirUnderRoot,
      cwd: result.isolation.cwdUnderRoot,
      repo: result.isolation.repoUnderRoot,
      resultPath: result.isolation.resultPathUnderRoot
    }
    if (!isolationOk) {
      result.failure = { class: "isolation", code: "violations" }
      persist("isolation-gate")
      return
    }

    const config = readCloudAuthConfig(env, root)
    if (config === null) {
      result.failure = { class: "probe", code: "invalid-isolated-config" }
      persist("configuration")
      return
    }
    if (
      result.pinnedPackages.keyringVersionPinned !== true ||
      result.pinnedPackages.nativeVersionPinned !== true
    ) {
      result.failure = { class: "probe", code: "pinned-package-mismatch" }
      persist("pinned-packages")
      return
    }

    // Read-only preflight against the run-unique vault scope. Present or
    // unprovable both STOP before any wiring, write, overwrite, or delete.
    const absence = await readVaultEntryAbsence(config)
    result.vaultScope.preflightChecked = absence.checked
    result.vaultScope.preflightAbsent = absence.absent
    result.vaultScope.preflightBindingLoaded = absence.bindingLoaded
    if (absence.checked !== true || absence.absent !== true) {
      result.failure = { class: "probe", code: absence.checked === true ? "vault-entry-present" : "vault-preflight-failed" }
      persist("vault-preflight")
      return
    }

    const keymap = context && context.keymap
    if (!keymap || typeof keymap.commands !== "function") {
      result.failure = { class: "probe", code: "keymap-unavailable" }
      persist("host-surface")
      return
    }

    let wiringModule = null
    let commandsModule = null
    try {
      wiringModule = await import("../../../repo/src/tui/wiring/install.ts")
      commandsModule = await import("../../../repo/src/tui/ui/sessionport-commands.tsx")
    } catch (error) {
      result.failure = { class: "probe", code: "repo-import-failed", error: errorInfo(error) }
      persist("repo-import")
      return
    }
    if (!wiringModule || typeof wiringModule.installSessionPortWiring !== "function" || !commandsModule || !commandsModule.SESSIONPORT_COMMAND_IDS) {
      result.failure = { class: "probe", code: "repo-exports-unavailable" }
      persist("repo-import")
      return
    }

    const observations = result.observations.native
    const commandContext = { action: "none" }
    const toastOwner = context.ui && context.ui.toast ? context.ui.toast : null
    const toastShow = toastOwner && typeof toastOwner.show === "function" ? toastOwner.show : null
    const dialogOwner = context.ui && context.ui.dialog ? context.ui.dialog : null
    const dialogAlert = dialogOwner && typeof dialogOwner.alert === "function" ? dialogOwner.alert : null
    const dialogWrapper = dialogOwner === null ? undefined : Object.assign({}, dialogOwner, {
      alert: function (options) {
        // Alert observer: records a fixed-enum observation and persists the
        // current record without reading any alert field.
        recordAlertObservation(observations)
        try { persist() } catch (error) { }
        if (dialogAlert !== null) return Reflect.apply(dialogAlert, dialogOwner, arguments)
        return Promise.resolve()
      }
    })
    const uiWrapper = Object.assign({}, context.ui, {
      toast: Object.assign({}, toastOwner, {
        show: function (options) {
          // Bounded fixed-safe facts only: an allowlisted variant token and the
          // message length. No title/message text, code, URL, or identity is read.
          if (result.observations.notifications < MAX_OBSERVED_NOTIFICATIONS) {
            result.observations.notifications += 1
          }
          if (result.ok === true) {
            try { persist() } catch (error) { }
          }
          if (toastShow !== null) return Reflect.apply(toastShow, toastOwner, arguments)
          return undefined
        }
      }),
      dialog: dialogWrapper === undefined ? context.ui.dialog : dialogWrapper
    })
    // The ONLY test-wrapper difference: explicit isolated cloud runtime options.
    // The product defaults for checkpoint/restore and the real cloud controller
    // remain untouched.
    let contextWrapper = null
    try {
      contextWrapper = Object.assign({}, context, {
        ui: uiWrapper,
        options: Object.assign({}, context.options, { sessionportCloud: config })
      })
    } catch (error) {
      result.failure = { class: "probe", code: "context-options-unavailable", error: errorInfo(error) }
      persist("context-options")
      return
    }

    let observedCloudAuthFactory = null
    try {
      const cloudAuthModule = await import("../../../repo/src/tui/wiring/cloud-auth.ts")
      const flowModule = await import("../../../repo/src/tui/ui/cloud-auth-flow.ts")
      const dialogModule = await import("../../../repo/src/tui/ui/cloud-auth-dialog.tsx")
      const controllerModule = await import("../../../repo/src/cloud/auth/controller.ts")
      observedCloudAuthFactory = createObservedCloudAuthFactory(
        {
          cloudAuthModule: cloudAuthModule,
          flowModule: flowModule,
          dialogModule: dialogModule,
          controllerModule: controllerModule
        },
        observations,
        commandContext
      )
    } catch (error) {
      result.failure = { class: "probe", code: "outcome-instrumentation-import-failed", error: errorInfo(error) }
      persist("outcome-instrumentation")
      return
    }

    let disposer = null
    try {
      disposer = await wiringModule.installSessionPortWiring(contextWrapper, { createCloudAuth: observedCloudAuthFactory })
    } catch (error) {
      result.failure = { class: "probe", code: "wiring-install-failed", error: errorInfo(error) }
      persist("wiring-install")
      return
    }
    result.wiring.installed = true
    result.wiring.disposerCallable = typeof disposer === "function"
    const expectedIDs = [
      commandsModule.SESSIONPORT_COMMAND_IDS.checkpoint,
      commandsModule.SESSIONPORT_COMMAND_IDS.restore,
      commandsModule.SESSIONPORT_COMMAND_IDS.sync
    ]
    result.commands.expected = expectedIDs.length
    // Setup must return so the host can render the app slot and populate the
    // keymap; polling for registration here would deadlock. The bounded
    // registration wait runs in a scheduled task, and the result is written only
    // after registration (observing) or on a terminal failure.
    result.stage = "starting"
    setTimeout(function () {
      waitForCommands(keymap, expectedIDs, REGISTRATION_TIMEOUT_MS).then(function (registration) {
        result.commands.registered = registration.registered
        result.commands.allRegistered = registration.allRegistered
        if (!registration.allRegistered) {
          result.failure = { class: "probe", code: "commands-not-registered" }
          persist("command-registration")
          return
        }
        result.stage = "observing"
        result.ok = true
        persist()
      }).catch(function (error) {
        result.failure = { class: "probe", code: "registration-wait-failed", error: errorInfo(error) }
        persist("command-registration")
      })
    }, 500)
  }
}
