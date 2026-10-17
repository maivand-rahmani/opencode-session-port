/**
 * SessionPort TUI wiring (Phase 2 experimental Windows lane).
 *
 * Public surface:
 * - `installSessionPortWiring(context, options?)` — install root gated to the
 *   explicit `win32`/`darwin`/`linux` allowlist: pinned-sodium initialization,
 *   real adapters/artifact I/O/password modal, command registration through the
 *   existing component-scoped seam, and the slot disposer returned unchanged.
 * - `createSessionPortHandlers(dependencies)` — fully injected composition of
 *   the `/checkpoint` and `/restore` command callbacks (fake-based testable).
 * - Experimental runtime defaults (crypto profile + collection bounds +
 *   password byte limit) and the sanitized report helpers.
 *
 * Boundaries: no shell/Git, no LLM/model call, no historical tool replay, no
 * direct database access, no `project.update`; only already-sealed ciphertext
 * is written, only encrypted artifacts are read, and every failure report is
 * generic/sanitized. No production approval, format freeze, or platform-support
 * claim is made (O-01/O-02/O-03 remain PARTIALLY RESOLVED for the experimental
 * build only — the `-win-` profile selector name is historical; OQ-16 stays
 * OPEN).
 */

export {
	createSessionPortHandlers,
	parseCheckpointOutputArgument,
	parseRestoreArtifactArgument,
} from "./composition.ts";
export type {
	SessionPortHandlerDependencies,
	SessionPortNotifier,
	SessionPortPasswordProvider,
} from "./composition.ts";
export { installSessionPortWiring } from "./install.ts";
export type { SessionPortInstallOptions } from "./install.ts";
export {
	EXPERIMENTAL_COLLECTION_POLICY,
	EXPERIMENTAL_CRYPTO_POLICY,
	EXPERIMENTAL_CRYPTO_POLICY_DEFINITION,
	EXPERIMENTAL_CRYPTO_POLICY_ID,
	EXPERIMENTAL_MAX_PASSWORD_BYTES,
} from "./experimental-profile.ts";
export {
	reportCheckpointFailure,
	reportCheckpointOutcome,
	reportRestoreAuthenticationFailed,
	reportRestoreCanceled,
	reportRestoreCapabilityUnavailable,
	reportRestoreExecution,
	reportRestoreFailure,
	reportRestoreNoActiveProject,
	reportRestoreNoCheckpointFound,
	reportRestoreUsage,
} from "./reports.ts";
export type { SessionPortNotification, SessionPortNotificationVariant } from "./reports.ts";
