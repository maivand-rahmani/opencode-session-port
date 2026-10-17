/**
 * SessionPort TUI command composition (Phase 2 experimental wiring).
 *
 * `createSessionPortHandlers` composes the completed Phase 2-4 seams into the
 * two injected command callbacks consumed by `installSessionPortCommands`:
 *
 * `/checkpoint [artifact-path]`
 *   1. resolve the active project from `context.location.directory` through the
 *      public `location.get` resolver (exact response matching; fail closed);
 *   2. `runCheckpointFlow` — exhaustive project-scoped collection (fail, never
 *      truncate, on any collection cap), matching password prompt, P-15 path
 *      resolution, seal, exclusive encrypted write;
 *   3. report path/size/session-count facts or a sanitized failure.
 *
 * `/restore <artifact-path>`
 *   1. require the artifact path argument (nothing runs without it);
 *   2. probe `session.import` capability FIRST — before any artifact read,
 *      decrypt, or import (O-12);
 *   3. enumerate existing host projects via `project.list`, let the user select
 *      with `selectRestoreProject`;
 *   4. call `location.get` ONLY for the selected candidate and require an exact
 *      project-ID/directory match (E42 side effect; OQ-16 stays OPEN);
 *   5. `runRestorePreflightWithPasswordAttempts` — up to three password
 *      attempts, full authentication, strict parse, destination snapshot, the
 *      required metadata-only cross-project session-ID occupancy inventory
 *      (reusing the already-validated selection candidates; no second
 *      `project.list`, no `location.get`, no message reads), and `planRestore`
 *      before anything else happens;
 *   6. `runRestoreExecution` — sequential parent-first imports with the
 *      explicit target on every call, no retries, no rollback promise;
 *   7. present the completed non-empty result through the designer-owned
 *      keyboard-navigable report dialog (aggregate/per-session facts only); an
 *      empty result keeps the truthful non-success notification, and a
 *      dialog-display failure falls back to bounded aggregate-only copy.
 *
 * Hard boundaries: no shell/Git, no LLM/model call, no historical tool replay,
 * no direct database access, no `project.update`; passwords stay masked and are
 * owned/zeroed by the orchestration helpers; only already-sealed ciphertext is
 * written and only encrypted artifacts are read. Everything is injected through
 * `SessionPortHandlerDependencies`, so tests use fake clients, fake crypto,
 * fake artifact I/O, fake dialogs, and a fake report presenter only.
 *
 * Platform policy: registration is gated in `install.ts`; this module itself
 * makes no platform-support claim.
 */

import type { ByteSource, CheckpointCryptoFactory } from "../../core/contracts/index.ts";
import { collectCheckpointPayload } from "../../core/sessions/index.ts";
import type { RemappedIdDeriver } from "../../core/restore/index.ts";
import type { ResolveCheckpointOutputPathOptions } from "../artifacts/files.ts";
import { createLocationResolver, LocationResolutionError } from "../adapters/location-resolver.ts";
import { createProjectDestinationsAdapter } from "../adapters/project-destinations.ts";
import { createSessionIdInventory } from "../adapters/session-id-inventory.ts";
import { createSessionReadAdapter } from "../adapters/session-read.ts";
import { createSessionImportAdapter, probeSessionImportCapability } from "../adapters/session-import.ts";
import {
	runCheckpointFlow,
	runRestoreExecution,
	runRestorePreflightWithPasswordAttempts,
	type RestoreExecutionResult,
} from "../orchestration/index.ts";
import { requireCallable, isRecordValue } from "../orchestration/shared.ts";
import { selectRestoreProject, type RestoreProjectDialog } from "../ui/restore-project-selector.ts";
import type { RestoreReportPresentationModel } from "../ui/restore-report-flow.ts";
import type { SessionPortCommandHandlers } from "../ui/sessionport-commands.tsx";
import {
	EXPERIMENTAL_COLLECTION_POLICY,
	EXPERIMENTAL_CRYPTO_POLICY,
	EXPERIMENTAL_MAX_PASSWORD_BYTES,
} from "./experimental-profile.ts";
import {
	mapRestoreExecutionToReportPresentation,
	reportCheckpointFailure,
	reportCheckpointOutcome,
	reportRestoreAuthenticationFailed,
	reportRestoreCanceled,
	reportRestoreCapabilityUnavailable,
	reportRestoreExecution,
	reportRestoreExecutionFallback,
	reportRestoreFailure,
	reportRestoreUsage,
	type SessionPortNotification,
} from "./reports.ts";

/* ------------------------------------------------------------------------- */
/* Injected dependency surface                                               */
/* ------------------------------------------------------------------------- */

/** One notification sink; the install layer maps it to `context.ui.toast`. */
export type SessionPortNotifier = (notification: SessionPortNotification) => void;

/**
 * Masked password provider: one call per prompt, resolves with the UTF-8 bytes
 * or `undefined` on cancel. The experimental 4-KiB byte limit is always passed.
 */
export type SessionPortPasswordProvider = (
	mode: "checkpoint" | "restore",
	maxPasswordBytes: number,
) => Promise<Uint8Array | undefined>;

/** Explicit, fully injected command dependencies. Every effect is supplied by the caller. */
export interface SessionPortHandlerDependencies {
	/** Host-provided public client (untrusted); all host methods go through the existing adapters. */
	readonly client: unknown;
	/** Live read of the active project directory (`context.location?.directory`). */
	readonly getActiveDirectory: () => string | undefined;
	/** Host dialog selection surface for the restore destination. */
	readonly dialog: RestoreProjectDialog;
	/** Sanitized notification sink. */
	readonly notify: SessionPortNotifier;
	/** Presents the completed restore report (designer-owned dialog in production). */
	readonly showRestoreReport: (model: RestoreReportPresentationModel) => void;
	/** Masked password provider (real UI or a fake in tests). */
	readonly requestPassword: SessionPortPasswordProvider;
	/** Initialized crypto factory; production uses the experimental profile (historical `-win-` selector name). */
	readonly cryptoFactory: CheckpointCryptoFactory;
	/** Remapped-ID deriver for restore planning. */
	readonly idDeriver: RemappedIdDeriver;
	/** P-15 artifact output-path resolver. */
	readonly resolveCheckpointOutputPath: (options: ResolveCheckpointOutputPathOptions) => Promise<string>;
	/** Exclusive encrypted-artifact writer (ciphertext only). */
	readonly writeEncryptedArtifact: (targetPath: string, source: ByteSource) => Promise<number>;
	/** Lazy encrypted-artifact reader (no IO until iterated). */
	readonly readEncryptedArtifact: (targetPath: string) => ByteSource;
}

/* ------------------------------------------------------------------------- */
/* createSessionPortHandlers                                                 */
/* ------------------------------------------------------------------------- */

/**
 * Builds the two command callbacks. Dependency shape is validated fail-closed
 * before any handler runs; host/API and orchestration errors are converted to
 * sanitized reports inside each handler and are never rethrown to the host.
 */
export function createSessionPortHandlers(dependencies: SessionPortHandlerDependencies): SessionPortCommandHandlers {
	if (!isRecordValue(dependencies)) {
		throw new TypeError("createSessionPortHandlers requires an explicit dependency object");
	}
	requireCallable(dependencies.getActiveDirectory, "getActiveDirectory");
	requireCallable(dependencies.notify, "notify");
	requireCallable(dependencies.showRestoreReport, "showRestoreReport");
	requireCallable(dependencies.requestPassword, "requestPassword");
	requireCallable(dependencies.resolveCheckpointOutputPath, "resolveCheckpointOutputPath");
	requireCallable(dependencies.writeEncryptedArtifact, "writeEncryptedArtifact");
	requireCallable(dependencies.readEncryptedArtifact, "readEncryptedArtifact");
	if (!isRecordValue(dependencies.cryptoFactory) || typeof dependencies.cryptoFactory.create !== "function") {
		throw new TypeError("createSessionPortHandlers requires a CheckpointCryptoFactory with a create(policy) function");
	}
	if (!isRecordValue(dependencies.idDeriver) || typeof dependencies.idDeriver.derive !== "function") {
		throw new TypeError("createSessionPortHandlers requires a RemappedIdDeriver with a derive(namespace, identity, id) function");
	}
	if (!isRecordValue(dependencies.dialog) || typeof dependencies.dialog.select !== "function") {
		throw new TypeError("createSessionPortHandlers requires a dialog with a select(options) function");
	}

	return {
		async checkpoint(rawInput: string | undefined): Promise<void> {
			await runCheckpointCommand(dependencies, rawInput);
		},
		async restore(rawInput: string | undefined): Promise<void> {
			await runRestoreCommand(dependencies, rawInput);
		},
	};
}

/* ------------------------------------------------------------------------- */
/* /checkpoint                                                               */
/* ------------------------------------------------------------------------- */

async function runCheckpointCommand(
	dependencies: SessionPortHandlerDependencies,
	rawInput: string | undefined,
): Promise<void> {
	const explicitOutputPath = parseCheckpointOutputArgument(rawInput);
	try {
		const activeDirectory = dependencies.getActiveDirectory();
		if (typeof activeDirectory !== "string" || activeDirectory.trim().length === 0) {
			throw new LocationResolutionError(
				"invalid-request",
				"The active project directory is unavailable; checkpoint requires an active project",
			);
		}
		// One explicit location.get for the active directory (E42 side effect).
		const resolved = await createLocationResolver(dependencies.client).resolveActiveProject(activeDirectory);
		const readPort = createSessionReadAdapter(dependencies.client);
		const outcome = await runCheckpointFlow(readPort, {
			projectID: resolved.projectID,
			projectDirectory: resolved.directory,
			policy: EXPERIMENTAL_COLLECTION_POLICY,
			cryptoFactory: dependencies.cryptoFactory,
			cryptoPolicy: EXPERIMENTAL_CRYPTO_POLICY,
			resolveCheckpointOutputPath: dependencies.resolveCheckpointOutputPath,
			writeEncryptedArtifact: dependencies.writeEncryptedArtifact,
			requestPassword: (purpose) => dependencies.requestPassword(purpose, EXPERIMENTAL_MAX_PASSWORD_BYTES),
			...(explicitOutputPath !== undefined ? { explicitOutputPath } : {}),
		});
		dependencies.notify(reportCheckpointOutcome(outcome));
	} catch (error) {
		dependencies.notify(reportCheckpointFailure(error));
	}
}

/* ------------------------------------------------------------------------- */
/* /restore                                                                  */
/* ------------------------------------------------------------------------- */

async function runRestoreCommand(
	dependencies: SessionPortHandlerDependencies,
	rawInput: string | undefined,
): Promise<void> {
	const artifactPath = parseRestoreArtifactArgument(rawInput);
	if (artifactPath === undefined) {
		dependencies.notify(reportRestoreUsage());
		return;
	}

	// O-12: capability absence is the first check — before any file read,
	// decrypt, destination enumeration, or import.
	const capability = probeSessionImportCapability(dependencies.client);
	if (!capability.available) {
		dependencies.notify(reportRestoreCapabilityUnavailable());
		return;
	}

	let executionStarted = false;
	try {
		// Candidate enumeration and user selection happen before any location.get
		// or artifact access; a canceled selection changes nothing.
		const destinations = await createProjectDestinationsAdapter(dependencies.client).listDestinations();
		const selected = await selectRestoreProject(dependencies.dialog, destinations);
		if (selected === undefined) {
			dependencies.notify(reportRestoreCanceled());
			return;
		}

		// location.get ONLY for the selected candidate; exact ID/directory match
		// is required before any artifact read/decrypt/import (E42; OQ-16 OPEN).
		const resolved = await createLocationResolver(dependencies.client).resolveSelectedProject({
			projectID: selected.projectID,
			targetDirectory: selected.targetDirectory,
		});

		// Destination snapshot uses the same explicit project scope and the
		// experimental collection bounds; it is read by runRestorePreflight only
		// after full authentication and strict parsing. The cross-project
		// session-ID inventory reuses the already-validated selection candidates
		// (no second project.list) and scans only session metadata (no message
		// reads, no location.get, no import).
		const readPort = createSessionReadAdapter(dependencies.client);
		const sessionIdInventory = createSessionIdInventory({
			readPort,
			projects: destinations,
			selectedProjectID: resolved.projectID,
			policy: EXPERIMENTAL_COLLECTION_POLICY,
		});
		const outcome = await runRestorePreflightWithPasswordAttempts(dependencies.client, {
			artifactPath,
			destinationProjectID: resolved.projectID,
			targetDirectory: resolved.directory,
			cryptoFactory: dependencies.cryptoFactory,
			cryptoPolicy: EXPERIMENTAL_CRYPTO_POLICY,
			readEncryptedArtifact: dependencies.readEncryptedArtifact,
			requestPassword: (purpose) => dependencies.requestPassword(purpose, EXPERIMENTAL_MAX_PASSWORD_BYTES),
			readDestination: async (projectID) =>
				(await collectCheckpointPayload(readPort, { projectID, policy: EXPERIMENTAL_COLLECTION_POLICY })).sessions,
			readGloballyVisibleSessionIDs: () => sessionIdInventory.readGloballyVisibleSessionIDs(),
			idDeriver: dependencies.idDeriver,
		});

		if (outcome.status === "capability-unavailable") {
			dependencies.notify(reportRestoreCapabilityUnavailable());
			return;
		}
		if (outcome.status === "canceled") {
			dependencies.notify(reportRestoreCanceled());
			return;
		}
		if (outcome.status === "authentication-failed") {
			dependencies.notify(reportRestoreAuthenticationFailed());
			return;
		}

		// Only a completed preflight reaches execution; every import carries the
		// explicit target directory through the existing adapter (O-16).
		const importer = createSessionImportAdapter(dependencies.client);
		executionStarted = true;
		const result = await runRestoreExecution({
			plan: outcome.plan,
			importer,
			targetDirectory: outcome.targetDirectory,
		});
		reportRestoreOutcome(dependencies, result);
	} catch (error) {
		dependencies.notify(reportRestoreFailure(error, executionStarted));
	}
}

/* ------------------------------------------------------------------------- */
/* Restore outcome presentation                                              */
/* ------------------------------------------------------------------------- */

/**
 * Presents one completed restore execution. A non-empty result is mapped to the
 * designer's `RestoreReportPresentationModel` and shown in the keyboard-
 * navigable report dialog (up to the experimental session cap of outcomes, one
 * navigable entry each) instead of a per-session toast. An empty result keeps
 * the truthful non-success notification.
 *
 * If the report dialog (or the mapping into its model) throws after execution,
 * the execution is still reported as finished through bounded aggregate-only
 * copy: a display failure is never reported as an execution failure, and no raw
 * exception text or per-session content reaches the notification.
 */
function reportRestoreOutcome(dependencies: SessionPortHandlerDependencies, result: RestoreExecutionResult): void {
	if (result.summary.total === 0) {
		dependencies.notify(reportRestoreExecution(result));
		return;
	}
	try {
		dependencies.showRestoreReport(mapRestoreExecutionToReportPresentation(result));
	} catch {
		dependencies.notify(reportRestoreExecutionFallback(result));
	}
}

/* ------------------------------------------------------------------------- */
/* Raw-argument parsing (no flag syntax; no trimming of path values)         */
/* ------------------------------------------------------------------------- */

/**
 * `/checkpoint` accepts one optional raw argument: the explicit artifact output
 * path. `undefined` or an all-whitespace argument uses the P-15 default
 * `.sessionport/` location; any other argument is trimmed of surrounding
 * whitespace and passed to the P-15 resolver verbatim (no flag parsing, no
 * shell expansion, no quote handling).
 */
export function parseCheckpointOutputArgument(rawInput: string | undefined): string | undefined {
	if (rawInput === undefined) return undefined;
	const trimmed = rawInput.trim();
	return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * `/restore` requires one raw argument: the artifact path. `undefined` or an
 * all-whitespace argument yields `undefined` so the caller reports usage
 * without touching the host; any other argument is trimmed of surrounding
 * whitespace and used verbatim.
 */
export function parseRestoreArtifactArgument(rawInput: string | undefined): string | undefined {
	if (rawInput === undefined) return undefined;
	const trimmed = rawInput.trim();
	return trimmed.length === 0 ? undefined : trimmed;
}
