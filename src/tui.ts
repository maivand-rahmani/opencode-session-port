import { Plugin } from "@opencode/plugin/tui"

/**
 * SessionPort TUI plugin entrypoint (Phase 2 experimental wiring).
 *
 * Setup checks `process.platform` first and only on an explicitly allowed
 * platform (`win32`, `darwin`, or `linux`) dynamically imports
 * `installSessionPortWiring`, which:
 * - registers `/checkpoint` and `/restore` only on those platforms; every other
 *   platform gets no registration and no platform-support claim;
 * - initializes the pinned `libsodium-wrappers-sumo@0.8.4` runtime first and
 *   fails closed if it is unavailable (setup rejects; nothing is registered);
 * - registers commands inside the existing app-slot/keymap component scope
 *   (E39) and returns the slot disposer to the host.
 *
 * The platform gate deliberately runs before the dynamic import: the wiring
 * module statically imports the designer-owned UI modules, which import the
 * optional UI peers (`@opentui/solid`, `solid-js`). Unsupported-platform plugin
 * setup therefore never evaluates them, and no OpenTUI dependency is added to
 * the package surface.
 *
 * Platform status: Windows has bounded actual-host evidence; macOS and Linux
 * are owner-approved experimental targets enabled here but NOT host-tested, and
 * cross-OS artifact interchange is UNVERIFIED. Command handlers own their
 * errors and report sanitized copy; no raw host error crosses to the host. The
 * active experimental defaults are recorded in `docs/archive/v1/decision-log.md`; this
 * is not a production approval or format freeze.
 */

/** Explicit allowlist; unsupported platforms fail closed before any host call. */
const SUPPORTED_PLATFORMS: readonly string[] = ["win32", "darwin", "linux"]

export default Plugin.define({
  id: "sessionport",
  async setup(context) {
    if (!SUPPORTED_PLATFORMS.includes(process.platform)) return undefined
    const { installSessionPortWiring } = await import("./tui/wiring/index.ts")
    return installSessionPortWiring(context)
  },
})
