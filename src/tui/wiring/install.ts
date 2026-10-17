/// <reference types="node" />
/**
 * SessionPort TUI install/composition root (Phase 2 experimental wiring).
 *
 * `installSessionPortWiring` is the only host-facing composition entry:
 *
 * - **Explicit platform allowlist (`win32`/`darwin`/`linux`), experimental
 *   only.** On any other platform it returns `undefined` immediately: no sodium
 *   initialization, no host-context access, no command registration, and no
 *   platform-support claim. Windows has bounded actual-host evidence; macOS and
 *   Linux are enabled but NOT host-tested, and cross-OS artifact interchange is
 *   UNVERIFIED.
 * - On an allowed platform it initializes the pinned `libsodium-wrappers-sumo@0.8.4`
 *   runtime first (`await sodium.ready` plus primitive/constant validation
 *   through `createCheckpointCryptoFactory`; `createRemappedIdDeriver` also
 *   awaits/validates it) and fails closed: a rejected initialization aborts
 *   setup before any command is registered.
 * - Native commands are registered through the existing component-scoped
 *   `installSessionPortCommands` (E39: the keymap layer must live inside the
 *   app-slot component scope). The slot disposer is returned unchanged so the
 *   host can clean up its contribution as the host contract permits; command
 *   handlers own their errors and report sanitized copy, so a handler never
 *   throws raw host data at the host.
 * - Completed non-empty restore executions are presented through the
 *   designer-owned `showRestoreReportDialog` (aggregate/per-session facts only);
 *   empty results and dialog-display failures keep sanitized toast copy.
 *
 * This module statically imports the designer-owned UI modules (password modal
 * and restore report dialog), which import the optional UI peers
 * (`@opentui/solid`, `solid-js`). The entry (`src/tui.ts`) imports this module
 * dynamically only after its own allowlist check, so unsupported-platform
 * plugin setup never evaluates those modules.
 *
 * Test seams (platform/factory/deriver/password provider) exist only for
 * fake-based tests; production calls use the real defaults. The real password
 * provider is the designer-owned masked TUI modal, invoked with the
 * experimental 4-KiB limit.
 */

import type { Plugin } from "@opencode/plugin/tui";
import type { CheckpointCryptoFactory } from "../../core/contracts/index.ts";
import { createCheckpointCryptoFactory } from "../../core/crypto/index.ts";
import { createRemappedIdDeriver, type RemappedIdDeriver } from "../../core/restore/index.ts";
import { readEncryptedArtifact, resolveCheckpointOutputPath, writeEncryptedArtifact } from "../artifacts/files.ts";
import { requestPassword as showPasswordDialog } from "../ui/password-dialog.tsx";
import { showRestoreReportDialog } from "../ui/restore-report-dialog.tsx";
import { installSessionPortCommands } from "../ui/sessionport-commands.tsx";
import { createSessionPortHandlers, type SessionPortPasswordProvider } from "./composition.ts";
import { EXPERIMENTAL_CRYPTO_POLICY_DEFINITION } from "./experimental-profile.ts";

/** Test-only seams; production omits every field. */
export interface SessionPortInstallOptions {
	/** Platform gate override for tests; defaults to `process.platform`. */
	readonly platform?: string;
	/** Crypto-factory seam; the default creates the experimental profile (historical `-win-` selector name) and awaits pinned sodium. */
	readonly createCryptoFactory?: () => Promise<CheckpointCryptoFactory>;
	/** Remapped-ID deriver seam; the default awaits/validates pinned sodium. */
	readonly createIdDeriver?: () => Promise<RemappedIdDeriver>;
	/** Password-provider seam; the default is the designer-owned masked TUI modal. */
	readonly requestPassword?: SessionPortPasswordProvider;
}

/** Explicit platform allowlist; unsupported platforms fail closed before any host access. */
const SUPPORTED_PLATFORMS: readonly string[] = ["win32", "darwin", "linux"];

/**
 * Installs the SessionPort commands for the experimental lane and returns the
 * slot disposer, or `undefined` when this platform is not registered. Fails
 * closed (rejects) when the pinned runtime or the host command surface is
 * unavailable; nothing is registered in that case.
 */
export async function installSessionPortWiring(
	context: Plugin.Context,
	options: SessionPortInstallOptions = {},
): Promise<(() => void) | undefined> {
	// Explicit allowlist gate: no registration and no host access on unsupported platforms.
	if (!SUPPORTED_PLATFORMS.includes(options.platform ?? process.platform)) return undefined;

	// Pinned-runtime initialization (fail closed): the default factory awaits
	// `sodium.ready` and validates every primitive the provisional format needs;
	// the deriver repeats the readiness/validation before registration.
	const cryptoFactory = await (options.createCryptoFactory ?? createExperimentalCryptoFactory)();
	const idDeriver = await (options.createIdDeriver ?? createRemappedIdDeriver)();

	const handlers = createSessionPortHandlers({
		client: context.client,
		getActiveDirectory: () => context.location?.directory,
		dialog: context.ui.dialog,
		notify: (notification) => {
			context.ui.toast.show({
				title: notification.title,
				message: notification.message,
				variant: notification.variant,
			});
		},
		showRestoreReport: (model) => showRestoreReportDialog(context, model),
		requestPassword:
			options.requestPassword ?? ((mode, maxPasswordBytes) => showPasswordDialog(context, mode, maxPasswordBytes)),
		cryptoFactory,
		idDeriver,
		resolveCheckpointOutputPath,
		writeEncryptedArtifact,
		readEncryptedArtifact,
	});

	// E39: registration must stay inside the existing app-slot/keymap
	// component scope; the slot disposer is returned unchanged.
	return installSessionPortCommands(context, handlers);
}

/**
 * Default factory: the experimental profile over the pinned runtime. The
 * `sessionport-experimental-win-v1` selector name is historical and is not
 * portability evidence; macOS/Linux enablement changes no profile value.
 */
async function createExperimentalCryptoFactory(): Promise<CheckpointCryptoFactory> {
	return createCheckpointCryptoFactory([EXPERIMENTAL_CRYPTO_POLICY_DEFINITION]);
}
