/**
 * SessionPort host-free packaging verification (frozen packaging lane).
 *
 * Scope:
 * - static manifest / root-shim / packaged-tsconfig invariants, including the
 *   compiled `dist/tui.js` entry, required UI peers, and `prepack` build hook;
 * - npm and Bun pack listings checked against the `files` allowlist
 *   (`tui.ts`, `src/**`, `dist/**`, `tsconfig.json` plus npm-mandatory
 *   manifest/README);
 * - tarball creation into a repository-local owned scratch directory;
 * - clean isolated consumers (npm baseline, npm host-peer-supplied, Bun
 *   baseline) that install the tarball with lifecycle scripts disabled and
 *   verify: installed file layout, export resolution to the compiled bundle,
 *   the directory-based `<directory>/tui` entrypoint convention, compiled
 *   entry static checks (no React, no raw JSX residue, host externals kept),
 *   pinned runtime-dependency resolution (`libsodium-wrappers-sumo` `ready`,
 *   `pako` public low-level API), dependency-boundary classification
 *   (consumer-local vs parent-repo resolution), and `@opencode/plugin/source.bun`
 *   `prepareSource` scanner parity for a host-style staged copy of the
 *   package: the root shim, the compiled entry, and the explicitly scanned
 *   deferred `src/tui/wiring/index.ts` module.
 *
 * Boundaries: no registry write commands (pack only), no publish, no Git, no
 * OpenCode launch, no plugin setup / host client / UI invocation, no model or
 * LLM calls, no user data, no passwords or history fixtures. Scratch lives
 * under `<repo>/.package-verify-work/<unique>/`; the allowlist categorically
 * excludes it from the package, and cleanup only ever removes that verified
 * owned scratch root. Synthetic package files only.
 *
 * Environment notes (recorded in evidence):
 * - Scratch is inside the repository, so Node/Bun bare-specifier resolution
 *   can walk up into the repository's own `node_modules`. Every dependency
 *   fact is therefore classified as "inside the consumer" or "outside"
 *   (parent-repo) so an absent package is never silently satisfied.
 * - The three UI peers are required (no `peerDependenciesMeta`), so a default
 *   npm/bun consumer install now resolves `@opentui/*` and `solid-js` from the
 *   registry; the host-peer-supplied case still pins the exact tested versions
 *   (0.5.14 / 1.9.12) with a simulation-only legacy peer flag.
 * - `Host.resolve` eagerly probes sibling entries (`server`, `rpc`); on Bun
 *   1.3.10 a missing sibling throws `ResolveMessage` (not `instanceof Error`),
 *   which the pinned loader rethrows. The directory/tui lookup itself is
 *   verified directly.
 * - Bun registry resolution can stall intermittently in this environment (a
 *   stalled `bun install` observed 2026-10-15 kept ~65 idle TCP connections
 *   with no progress for 10+ minutes). Bun 1.3.10 has no `--offline` install
 *   mode (`--offline` is silently ignored and installs still resolve against
 *   the registry), so the Bun consumer install is bounded and retried once
 *   with a fresh bounded attempt; if both attempts stall it fails and reports
 *   instead of hanging.
 *
 * Usage (from the repository root):
 *   bun run scripts/package-verify/verify.ts                 # static + pack listings
 *   bun run scripts/package-verify/verify.ts --install       # + tarball + consumers
 *   bun run scripts/package-verify/verify.ts --install --cleanup
 *   bun run scripts/package-verify/verify.ts --install --keep
 *
 * `--install` retains `tarball/` and `evidence.json` under the scratch root on
 * success unless `--cleanup` is given; failures always retain the scratch root
 * for inspection. The retained/removed path is always reported.
 */

import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REPO_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const SCRATCH_DIR_NAME = ".package-verify-work";
export const EXPECTED_PACKAGE_NAME = "opencode-session-port";
export const EXPECTED_VERSION = "0.1.7";
export const EXPECTED_LICENSE = "MIT";
export const EXPECTED_DESCRIPTION =
	"SessionPort: experimental OpenCode TUI plugin for password-encrypted session checkpoint and restore.";
export const EXPECTED_KEYWORDS = ["opencode", "opencode-plugin", "tui", "session", "checkpoint", "restore", "encryption"];
/**
 * Reviewed GitHub identity for OIDC trusted publishing (CI-02). The manifest
 * must declare exactly this object; any other or malformed repository metadata
 * is rejected. Publishing itself stays outside this verifier.
 */
export const EXPECTED_REPOSITORY = {
	type: "git",
	url: "git+https://github.com/maivand-rahmani/opencode-session-port.git",
} as const;
export const PACKAGE_FILES_ALLOWLIST = ["tui.ts", "src/**", "dist/**", "tsconfig.json"] as const;
export const EXPECTED_EXPORTS = { "./tui": "./dist/tui.js" } as const;
/** Compiled bundle produced by `build:tui` (prepack) and shipped via `exports["./tui"]`. */
export const BUILT_ENTRY_PATH = "dist/tui.js";
/** External specifiers the compiled bundle must keep unbundled for the host runtime. */
export const REQUIRED_EXTERNAL_IMPORTS = ["@opencode/plugin", "@opentui/solid", "solid-js"] as const;
export const EXPECTED_DEPENDENCIES: Record<string, string> = {
	"@opencode/plugin": "2.0.22",
	"libsodium-wrappers-sumo": "0.8.4",
	pako: "3.0.2",
};
export const EXPECTED_PEER_DEPENDENCIES: Record<string, string> = {
	"@opentui/core": "0.5.14",
	"@opentui/solid": "0.5.14",
	"solid-js": "1.9.12",
};
export const EXPECTED_DEV_DEPENDENCIES: Record<string, string> = {
	"@opentui/core": "0.5.14",
	"@opentui/solid": "0.5.14",
	"@types/node": "24.12.2",
	"solid-js": "1.9.12",
	typescript: "5.9.3",
};
/** Host-supplied UI peers (required; resolved by the host runtime in real installs). */
export const HOST_PEER_ALLOWLIST = ["solid-js", "@opentui/core", "@opentui/solid", "@opencode/theme"];
/** Product runtime dependencies that must always resolve from a clean install. */
export const RUNTIME_DEPENDENCIES = ["@opencode/plugin", "libsodium-wrappers-sumo", "pako"];
export const REQUIRED_PACKED_PATHS = [
	"package.json",
	"README.md",
	"LICENSE",
	"tui.ts",
	"src/tui.ts",
	"src/tui/wiring/index.ts",
	// 2026-10-18 checkpoint dependency closure: the new core modules must be
	// present in every packed tarball (they are reached through src/**).
	"src/core/sessions/dependencies.ts",
	"src/core/sessions/references.ts",
	BUILT_ENTRY_PATH,
	"tsconfig.json",
];
export const FORBIDDEN_PACKED_FILES = new Set([
	"AGENTS.md",
	"wasm-probe.json",
	"bun.lock",
	"bun.lockb",
	"package-lock.json",
	".ignore",
	".gitignore",
	"npm-debug.log",
]);
export const FORBIDDEN_PACKED_PREFIXES = [
	"tests/",
	"scripts/",
	"docs/",
	".slim/",
	".vscode/",
	".git/",
	"node_modules/",
	`${SCRATCH_DIR_NAME}/`,
];
export const FORBIDDEN_MANIFEST_FIELDS = [
	"publishConfig",
	// "repository" is approved infra (EXPECTED_REPOSITORY, validated exactly).
	"author",
	"contributors",
	"homepage",
	"bugs",
	"funding",
	"engines",
	"os",
	"cpu",
	"bin",
	"main",
];

export const PACK_TIMEOUT_MS = 120_000;
export const INSTALL_TIMEOUT_MS = 600_000;
export const BUN_ONLINE_FALLBACK_TIMEOUT_MS = 300_000;
export const PROBE_TIMEOUT_MS = 90_000;
/** Extra time allowed for stdio to close after a deadline terminates the command. */
export const TERMINATION_GRACE_MS = 15_000;
/** Bound for the Windows `taskkill` tree-termination helper itself. */
export const TREE_KILL_TIMEOUT_MS = 10_000;
/** Bound for reaping the tree-kill helper after it was killed for exceeding its own bound. */
export const TREE_KILL_REAP_MS = 2_000;

/**
 * Deadline-termination outcome.
 * - `"reported"`: `taskkill` ran against a child confirmed live immediately
 *   before the call and exited 0 — the tool-reported tree termination only,
 *   never an independent verification of descendants.
 * - `"uncertain"`: every other path (already-exited child, helper spawn
 *   failure, nonzero helper exit, helper timeout, non-Windows fallback).
 */
export type CleanupStatus = "reported" | "uncertain";

export interface CommandResult {
	readonly status: number | null;
	readonly stdout: string;
	readonly stderr: string;
	readonly error?: string;
	/** Present only when a deadline terminated the command. */
	readonly cleanup?: CleanupStatus;
}

export interface ProbeFacts {
	readonly mode?: string;
	readonly [key: string]: unknown;
}

export interface TrackedEntry {
	readonly file: string;
	readonly directory: boolean;
}

// ---------------------------------------------------------------------------
// Command execution (bounded)
// ---------------------------------------------------------------------------

function quoteForCmd(value: string): string {
	if (value === "") return '""';
	// Whitespace, quotes, and cmd metacharacters must stay inside one quoted
	// token; doubled quotes are the cmd convention for a literal quote.
	return /[\s"&|<>^()]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

export interface SpawnPlan {
	readonly argv: string[];
	readonly windowsVerbatimArguments: boolean;
}

/**
 * Windows spawning plan (Ora-43 quoting follow-up):
 * - `.exe` commands (including the Bun executable) spawn directly: Bun builds
 *   the child command line itself, so spaced executable/argument paths are
 *   quoted correctly without a cmd.exe layer.
 * - Everything else (bare names like `npm` resolving to .cmd shims, and
 *   .cmd/.bat paths) runs through `cmd.exe /d /s /c "<inner>"` with
 *   `windowsVerbatimArguments` so Bun passes the pre-quoted command line
 *   verbatim. cmd's `/S` rule then strips the single outer quote pair and the
 *   inner cmd-quoted command line executes unchanged (verified against actual
 *   cmd and a spaced .cmd fixture, 2026-10-15; the previous unwrapped
 *   construction had Bun backslash-escape the inner quotes and mangled any
 *   argument containing spaces).
 */
export function planSpawn(command: string, args: string[], platform: string = process.platform): SpawnPlan {
	if (platform !== "win32") {
		return { argv: [command, ...args], windowsVerbatimArguments: false };
	}
	if (command.toLowerCase().endsWith(".exe")) {
		return { argv: [command, ...args], windowsVerbatimArguments: false };
	}
	const inner = [command, ...args].map(quoteForCmd).join(" ");
	return { argv: ["cmd.exe", "/d", "/s", "/c", `"${inner}"`], windowsVerbatimArguments: true };
}

/**
 * Bounded command runner. Uses Bun-native async spawn: node `spawnSync` of Bun
 * from a Bun parent deadlocks on `bun install` in this environment, and its
 * timeout does not reliably terminate the child.
 *
 * Deadlines must terminate the whole process tree, not just the direct child:
 * on Windows bare names and .cmd shims run through a `cmd.exe /c` wrapper, and
 * killing only the wrapper leaves npm/bun grandchildren alive holding the
 * stdio pipes open — `new Response(proc.stdout).text()` would then never
 * settle and the verifier would hang past its own deadline (observed with a
 * stalled `bun install` on 2026-10-15). See `terminateProcessTree` for the
 * bounded, honestly-reported termination semantics; the stdio settle is
 * additionally raced against a bounded termination grace so a command result
 * is always produced.
 */

/** Handle-backed view of a spawned process used by the deadline termination path. */
export interface TerminableProcess {
	readonly pid: number;
	/** True once the OS process behind this handle has exited (handle state, never a PID probe). */
	hasExited: () => boolean;
	/** Handle-backed termination of the direct child only (never PID-based). */
	kill: () => void;
}

/** A spawned tree-kill helper process (`taskkill`). */
export interface KillerProcess {
	readonly exited: Promise<number | null>;
	kill: () => void;
}

export interface TerminationDeps {
	readonly platform: string;
	/** Spawn the Windows tree-kill helper for a live PID; undefined when it cannot be spawned. */
	readonly spawnKiller: (pid: number) => KillerProcess | undefined;
	readonly killerTimeoutMs: number;
	readonly killerReapMs: number;
}

export interface TerminationReport {
	readonly cleanup: CleanupStatus;
	readonly detail: string;
}

/**
 * Concrete Bun 1.3.10 Windows handle semantics (probed 2026-10-15):
 * - `exitCode` is `null` while running and a number after a natural exit;
 * - after `kill()`, `exited` settles but `exitCode` stays `null`;
 * so liveness combines the settled `exited` signal with the numeric `exitCode`.
 */
export function toTerminableProcess(proc: {
	readonly pid: number;
	readonly exitCode: number | null | undefined;
	readonly exited: Promise<unknown>;
	kill: () => void;
}): TerminableProcess {
	let exited = false;
	void proc.exited.then(
		() => {
			exited = true;
		},
		() => {
			exited = true;
		},
	);
	return {
		pid: proc.pid,
		hasExited: () => exited || typeof proc.exitCode === "number",
		kill: () => proc.kill(),
	};
}

function defaultTerminationDeps(): TerminationDeps {
	return {
		platform: process.platform,
		spawnKiller: (pid) => {
			try {
				const killer = Bun.spawn(["taskkill", "/pid", String(pid), "/T", "/F"], {
					stdout: "ignore",
					stderr: "ignore",
					windowsHide: true,
				});
				return {
					exited: killer.exited.then(
						(code) => code,
						() => null,
					),
					kill: () => {
						try {
							killer.kill();
						} catch {
							// helper already exited
						}
					},
				};
			} catch {
				return undefined;
			}
		},
		killerTimeoutMs: TREE_KILL_TIMEOUT_MS,
		killerReapMs: TREE_KILL_REAP_MS,
	};
}

function fallbackKill(proc: TerminableProcess): void {
	try {
		proc.kill();
	} catch {
		// handle already exited
	}
}

/** Races a promise against a timer; the timer is always cleared. */
function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<T>((resolve) => {
		timer = setTimeout(() => resolve(onTimeout()), ms);
	});
	return Promise.race([promise, timeout]).finally(() => {
		if (timer !== undefined) clearTimeout(timer);
	});
}

/**
 * Best-effort bounded termination for a timed-out command.
 *
 * Honesty rules (Ora-43 remediation):
 * - The Windows tree kill is PID-based (`taskkill /T /F`), so it runs only
 *   after a liveness check immediately before the call; if the direct child
 *   already exited, no PID-based action is taken (PID-reuse window). A
 *   residual race between the check and taskkill cannot be eliminated without
 *   native job objects and is reported as uncertain on any helper failure.
 * - Only a `taskkill` exit 0 is labeled `"reported"` (tool-reported only).
 *   Spawn failure, nonzero exit, or helper timeout fall back to the
 *   handle-backed direct `proc.kill()` and report `"uncertain"`. Descendants
 *   are never claimed gone without the helper's success exit.
 * - The helper itself is bounded: it is killed after `killerTimeoutMs` and
 *   its reap is awaited only for `killerReapMs`, so no helper process can be
 *   left running by our own deadline path.
 */
export async function terminateProcessTree(
	proc: TerminableProcess,
	deps: TerminationDeps = defaultTerminationDeps(),
): Promise<TerminationReport> {
	if (deps.platform !== "win32") {
		fallbackKill(proc);
		return { cleanup: "uncertain", detail: "non-Windows direct-child kill only" };
	}
	if (proc.hasExited()) {
		return {
			cleanup: "uncertain",
			detail: "direct child already exited before termination; PID-based tree kill skipped, descendants not addressed",
		};
	}
	let killer: KillerProcess | undefined;
	try {
		killer = deps.spawnKiller(proc.pid);
	} catch {
		killer = undefined;
	}
	if (!killer) {
		fallbackKill(proc);
		return { cleanup: "uncertain", detail: "taskkill could not be spawned; direct-child kill only" };
	}
	const outcome = await withTimeout(
		killer.exited.then((code) => ({ kind: "exited" as const, code })),
		deps.killerTimeoutMs,
		() => ({ kind: "timeout" as const }),
	);
	if (outcome.kind === "exited") {
		if (outcome.code === 0) {
			return { cleanup: "reported", detail: "taskkill reported tree termination" };
		}
		fallbackKill(proc);
		return { cleanup: "uncertain", detail: `taskkill failed (status ${String(outcome.code)}); direct-child kill only` };
	}
	try {
		killer.kill();
	} catch {
		// helper already exited
	}
	const reaped = await withTimeout(
		killer.exited.then(() => true),
		deps.killerReapMs,
		() => false,
	);
	fallbackKill(proc);
	return {
		cleanup: "uncertain",
		detail: reaped
			? `taskkill exceeded ${deps.killerTimeoutMs}ms and was killed; direct-child kill only`
			: `taskkill exceeded ${deps.killerTimeoutMs}ms; helper kill requested but reap unconfirmed; direct-child kill only`,
	};
}

export async function runCommand(command: string, args: string[], cwd: string, timeoutMs: number): Promise<CommandResult> {
	const plan = planSpawn(command, args);
	const proc = Bun.spawn(plan.argv, {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		windowsHide: true,
		windowsVerbatimArguments: plan.windowsVerbatimArguments,
	});
	let timedOut = false;
	let termination: Promise<TerminationReport> | undefined;
	const timer = setTimeout(() => {
		timedOut = true;
		termination = terminateProcessTree(toTerminableProcess(proc));
	}, timeoutMs);
	try {
		const stdoutPromise = new Response(proc.stdout).text().catch(() => "");
		const stderrPromise = new Response(proc.stderr).text().catch(() => "");
		const exitedPromise = proc.exited.then(
			(status) => status,
			() => null,
		);
		const settledPromise = Promise.all([stdoutPromise, stderrPromise, exitedPromise]);
		const settled = await Promise.race([
			settledPromise,
			new Promise<null>((resolve) => {
				const guard = setTimeout(() => resolve(null), timeoutMs + TERMINATION_GRACE_MS);
				void settledPromise.finally(() => clearTimeout(guard));
			}),
		]);
		if (settled === null) {
			return {
				status: null,
				stdout: "",
				stderr: "",
				error: `timeout after ${timeoutMs}ms; stdio did not settle; process-tree cleanup uncertain`,
				cleanup: "uncertain",
			};
		}
		const [stdout, stderr, status] = settled;
		if (!timedOut) {
			return { status, stdout, stderr };
		}
		const report = (await termination) ?? { cleanup: "uncertain" as const, detail: "termination was not started" };
		const suffix = report.cleanup === "reported" ? "" : `; process-tree cleanup uncertain (${report.detail})`;
		return {
			status: null,
			stdout,
			stderr,
			error: `timeout after ${timeoutMs}ms${suffix}`,
			cleanup: report.cleanup,
		};
	} finally {
		clearTimeout(timer);
	}
}

export function npmCommand(): string {
	return "npm";
}

export function bunCommand(): string {
	return process.execPath;
}

export function npmInstallArgs(tarballPath: string): string[] {
	return ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--omit=dev", tarballPath];
}

export function npmHostPeerInstallArgs(): string[] {
	// Simulation-only relaxation: `@opentui/solid` 0.5.14 declares an exact
	// solid-js 1.9.12 peer and the repository now pins the same 1.9.12, but the
	// strict npm peer graph for the exact-pinned simulation has not been
	// re-verified in this registry-free pass, so the legacy flag is retained.
	// It is never used for the product baseline install.
	return [
		"install",
		"--ignore-scripts",
		"--no-audit",
		"--no-fund",
		"--omit=dev",
		"--save-exact",
		"--legacy-peer-deps",
		"@opentui/core@0.5.14",
		"@opentui/solid@0.5.14",
		"solid-js@1.9.12",
	];
}

export function bunInstallArgs(): string[] {
	// Bun 1.3.10 has no offline install mode (`--offline` is silently ignored);
	// this is the initial bounded attempt, retried once on failure.
	return ["install", "--ignore-scripts"];
}

export function bunOnlineInstallArgs(): string[] {
	return ["install", "--ignore-scripts"];
}

// ---------------------------------------------------------------------------
// Static invariants
// ---------------------------------------------------------------------------

function sameJson(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

export function checkManifest(manifest: Record<string, unknown>): string[] {
	const problems: string[] = [];
	const expect = (condition: boolean, message: string) => {
		if (!condition) problems.push(message);
	};
	expect(manifest.name === EXPECTED_PACKAGE_NAME, `manifest name must stay "${EXPECTED_PACKAGE_NAME}" (got ${String(manifest.name)})`);
	expect(manifest.version === EXPECTED_VERSION, `manifest version must stay "${EXPECTED_VERSION}" (got ${String(manifest.version)})`);
	expect(manifest.private === false, "manifest must declare private:false for publishing preparation (no publish is run)");
	expect(manifest.license === EXPECTED_LICENSE, `manifest license must stay "${EXPECTED_LICENSE}" (got ${String(manifest.license)})`);
	expect(manifest.description === EXPECTED_DESCRIPTION, `manifest description must stay "${EXPECTED_DESCRIPTION}" (got ${String(manifest.description)})`);
	expect(sameJson(manifest.keywords, [...EXPECTED_KEYWORDS]), `manifest keywords must stay ${JSON.stringify(EXPECTED_KEYWORDS)}`);
	const repository = manifest.repository;
	const repositoryRecord =
		repository !== null && typeof repository === "object" && !Array.isArray(repository) ? (repository as Record<string, unknown>) : null;
	const repositoryKeys = repositoryRecord === null ? [] : Object.keys(repositoryRecord).sort();
	expect(
		repositoryRecord !== null &&
			sameJson(repositoryKeys, ["type", "url"]) &&
			repositoryRecord.type === EXPECTED_REPOSITORY.type &&
			repositoryRecord.url === EXPECTED_REPOSITORY.url,
		`manifest repository must be exactly ${JSON.stringify(EXPECTED_REPOSITORY)} with no other keys`,
	);
	expect(sameJson(manifest.exports, EXPECTED_EXPORTS), `exports must stay exactly ${JSON.stringify(EXPECTED_EXPORTS)}`);
	expect(sameJson(manifest.files, [...PACKAGE_FILES_ALLOWLIST]), `files must stay exactly ${JSON.stringify(PACKAGE_FILES_ALLOWLIST)}`);
	expect(sameJson(manifest.dependencies, EXPECTED_DEPENDENCIES), "dependency pins must stay unchanged");
	expect(sameJson(manifest.peerDependencies, EXPECTED_PEER_DEPENDENCIES), "peer dependency pins must stay unchanged");
	expect(sameJson(manifest.devDependencies, EXPECTED_DEV_DEPENDENCIES), "dev dependency pins must stay unchanged");
	expect(
		manifest.peerDependenciesMeta === undefined,
		"peerDependenciesMeta must be absent: all three UI peers are required (no optional:true)",
	);
	for (const field of FORBIDDEN_MANIFEST_FIELDS) {
		expect(!(field in manifest), `manifest must not declare "${field}" (deferred registry/runtime metadata)`);
	}
	const scripts = (manifest.scripts ?? {}) as Record<string, unknown>;
	expect(scripts.typecheck === "tsc --noEmit", "typecheck script must stay unchanged");
	expect(scripts.test === "bun test", "test script must stay unchanged");
	expect(scripts["verify:package"] === "bun run scripts/package-verify/verify.ts", "verify:package script must point at the packaging verifier");
	expect(scripts["build:tui"] === "bun run scripts/build-tui.ts", "build:tui script must compile the Solid TSX entry with Bun.build");
	expect(scripts.prepack === "bun run build:tui", "prepack must run build:tui so every packed tarball ships dist/tui.js");
	for (const [name, value] of Object.entries(scripts)) {
		if (name === "prepack") continue; // required build hook; value pinned above
		if (/publish|postpack|prepare|postinstall|preinstall/.test(name) || /(?:npm|bun|pnpm|yarn)\s+publish/.test(String(value))) {
			problems.push(`script "${name}" is not allowed in this no-publish package`);
		}
	}
	return problems;
}

export function checkPackagedTsconfig(source: string): string[] {
	const problems: string[] = [];
	let parsed: { compilerOptions?: Record<string, unknown>; include?: unknown };
	try {
		parsed = JSON.parse(source) as typeof parsed;
	} catch (error) {
		return [`packaged tsconfig.json is not valid JSON: ${String(error)}`];
	}
	const compilerOptions = parsed.compilerOptions ?? {};
	if (compilerOptions.jsx !== "preserve") {
		problems.push('packaged tsconfig must keep jsx:"preserve" for @opentui/solid source semantics');
	}
	if (compilerOptions.jsxImportSource !== "@opentui/solid") {
		problems.push('packaged tsconfig must keep jsxImportSource:"@opentui/solid"');
	}
	if (!Array.isArray(parsed.include) || !parsed.include.includes("src")) {
		problems.push('packaged tsconfig include must cover "src"');
	}
	return problems;
}

export function checkRootShim(source: string): string[] {
	const problems: string[] = [];
	const scan = new Bun.Transpiler({ loader: "ts", target: "bun" }).scan(source);
	const imports = scan.imports;
	if (imports.length !== 1 || imports[0]?.path !== "./dist/tui.js" || imports[0]?.kind !== "import-statement") {
		problems.push(`root tui.ts must statically re-export exactly ./dist/tui.js so the directory loader hits the compiled bundle (saw ${JSON.stringify(imports)})`);
	}
	if (!scan.exports.includes("default")) {
		problems.push("root tui.ts must re-export the default export");
	}
	if (/Plugin\.define|\bsetup\s*\(/.test(source)) {
		problems.push("root tui.ts must stay a pure re-export shim (no registration or setup code)");
	}
	return problems;
}

/**
 * Static checks for the compiled bundle (`dist/tui.js`):
 * - parses as plain JavaScript (raw TSX/JSX residue would fail the js loader);
 * - imports no React package;
 * - keeps the required host externals external;
 * - contains no raw JSX syntax.
 */
export function checkBuiltEntry(source: string): string[] {
	const problems: string[] = [];
	let imports: Array<{ path: string }>;
	try {
		imports = new Bun.Transpiler({ loader: "js", target: "bun" }).scan(source).imports;
	} catch (error) {
		return [`dist/tui.js must be compiled JavaScript (raw TSX would fail the js-loader parse): ${String(error)}`];
	}
	const paths = imports.map((entry) => entry.path);
	for (const specifier of paths) {
		if (specifier === "react" || specifier.startsWith("react/") || specifier === "react-dom" || specifier.startsWith("react-dom/")) {
			problems.push(`dist/tui.js must not import React (saw ${specifier})`);
		}
	}
	for (const required of REQUIRED_EXTERNAL_IMPORTS) {
		if (!paths.some((specifier) => specifier === required || specifier.startsWith(`${required}/`))) {
			problems.push(`dist/tui.js must keep ${required} as an external import`);
		}
	}
	if (source.includes("</") || /<[A-Za-z][A-Za-z0-9.$]*[\s/>]/.test(source)) {
		problems.push("dist/tui.js must not contain raw JSX syntax");
	}
	return problems;
}

// ---------------------------------------------------------------------------
// Packed-listing classification
// ---------------------------------------------------------------------------

export function classifyPackedPath(rawPath: string): "allowlisted" | "auto" | "forbidden" | "unexpected" {
	const normalized = rawPath.replaceAll("\\", "/").replace(/^\.\//, "");
	if (normalized === "tui.ts" || normalized === "tsconfig.json" || normalized.startsWith("src/") || normalized.startsWith("dist/")) {
		return "allowlisted";
	}
	const lower = normalized.toLowerCase();
	if (normalized === "package.json" || /^readme(\.[a-z0-9]+)*$/.test(lower) || /^licen[cs]e(\.[a-z0-9]+)*$/.test(lower)) {
		return "auto";
	}
	if (FORBIDDEN_PACKED_FILES.has(normalized) || FORBIDDEN_PACKED_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
		return "forbidden";
	}
	return "unexpected";
}

export function checkPackedListing(paths: readonly string[]): string[] {
	const problems: string[] = [];
	const seen = new Set<string>();
	for (const rawPath of paths) {
		const normalized = rawPath.replaceAll("\\", "/").replace(/^\.\//, "");
		seen.add(normalized);
		const classification = classifyPackedPath(normalized);
		if (classification === "forbidden") {
			problems.push(`packed listing includes forbidden path: ${normalized}`);
		} else if (classification === "unexpected") {
			problems.push(`packed listing includes unexpected path outside the allowlist: ${normalized}`);
		}
	}
	for (const required of REQUIRED_PACKED_PATHS) {
		if (!seen.has(required)) problems.push(`packed listing is missing required path: ${required}`);
	}
	if (seen.size === 0) problems.push("packed listing is empty");
	return problems;
}

export function parseBunPackListing(stdout: string): string[] {
	const files: string[] = [];
	for (const match of stdout.matchAll(/^packed\s+\S+\s+(.+?)\s*$/gm)) {
		files.push(match[1]!.replaceAll("\\", "/"));
	}
	return files;
}

// ---------------------------------------------------------------------------
// Scanner graph classification
// ---------------------------------------------------------------------------

export function classifyScannerGraph(
	tracked: readonly TrackedEntry[],
	packageRoot: string,
): { localFiles: string[]; missingPackages: string[]; problems: string[] } {
	const problems: string[] = [];
	const localFiles: string[] = [];
	const missingPackages = new Set<string>();
	const normalizedRoot = path.resolve(packageRoot).toLowerCase();
	for (const entry of tracked) {
		const normalizedFile = path.resolve(entry.file);
		if (entry.directory) {
			const match = /node_modules[/\\](.+)$/.exec(normalizedFile);
			if (!match) {
				problems.push(`scanner tracked an unresolved local import directory: ${normalizedFile}`);
				continue;
			}
			const packageName = match[1]!.replaceAll("\\", "/");
			missingPackages.add(packageName);
			if (!HOST_PEER_ALLOWLIST.includes(packageName)) {
				problems.push(`scanner could not resolve non-host package: ${packageName}`);
			}
			continue;
		}
		if (!normalizedFile.toLowerCase().startsWith(normalizedRoot)) {
			problems.push(`scanner tracked a file outside the staged package: ${normalizedFile}`);
			continue;
		}
		const relative = path.relative(packageRoot, normalizedFile).replaceAll("\\", "/");
		localFiles.push(relative);
		if (!existsSync(normalizedFile)) {
			problems.push(`scanner tracked a missing local file: ${relative}`);
			continue;
		}
		const classification = classifyPackedPath(relative);
		if (classification !== "allowlisted" && classification !== "auto") {
			problems.push(`scanner tracked a local file outside the packaged allowlist: ${relative}`);
		}
	}
	return { localFiles, missingPackages: [...missingPackages].sort(), problems };
}

export function listInstalledFiles(packageRoot: string): string[] {
	const files: string[] = [];
	const walk = (directory: string) => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const absolute = path.join(directory, entry.name);
			if (entry.isDirectory()) {
				if (entry.name === "node_modules") continue;
				walk(absolute);
			} else {
				files.push(path.relative(packageRoot, absolute).replaceAll("\\", "/"));
			}
		}
	};
	walk(packageRoot);
	return files.sort();
}

export function packageNameOf(specifier: string): string {
	const parts = specifier.split("/");
	return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

export function isInsideConsumer(consumerDir: string, resolvedPath: string): boolean {
	const boundary = path.resolve(consumerDir, "node_modules").toLowerCase();
	const normalized = path.resolve(resolvedPath).toLowerCase();
	return normalized === boundary || normalized.startsWith(`${boundary}${path.sep}`);
}

export function stageInstalledPackage(packageRoot: string, stagedDir: string): void {
	mkdirSync(stagedDir, { recursive: true });
	// Copy top-level entries explicitly: fs.cpSync(src, existingDest) would nest
	// src inside dest, and package-internal node_modules must stay out.
	for (const entry of readdirSync(packageRoot, { withFileTypes: true })) {
		if (entry.name === "node_modules") continue;
		cpSync(path.join(packageRoot, entry.name), path.join(stagedDir, entry.name), { recursive: true });
	}
}

// ---------------------------------------------------------------------------
// Scratch root management (repository-local, owned, verified)
// ---------------------------------------------------------------------------

export function scratchRootPath(repoRoot: string, unique: string): string {
	return path.join(repoRoot, SCRATCH_DIR_NAME, unique);
}

export function createScratchRoot(repoRoot: string, unique?: string): string {
	const suffix = unique ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
	const root = scratchRootPath(repoRoot, suffix);
	if (existsSync(root)) throw new Error(`scratch root already exists: ${root}`);
	mkdirSync(root, { recursive: true });
	return root;
}

export function isOwnedScratchPath(repoRoot: string, target: string): boolean {
	const scratchRoot = path.resolve(path.join(repoRoot, SCRATCH_DIR_NAME));
	const resolved = path.resolve(target);
	const relative = path.relative(scratchRoot, resolved);
	return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function removeOwnedScratchPath(repoRoot: string, target: string): void {
	if (!isOwnedScratchPath(repoRoot, target)) {
		throw new Error(`refusing to remove path outside the owned scratch root: ${target}`);
	}
	rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}

// ---------------------------------------------------------------------------
// Pack + consumer orchestration
// ---------------------------------------------------------------------------

function requireSuccess(result: CommandResult, label: string, problems: string[], notes: string[]): boolean {
	if (result.status === 0) return true;
	const detail = result.error ?? result.stderr.trim().split("\n").slice(-6).join(" | ") ?? "";
	problems.push(`${label} failed (status ${String(result.status)}): ${detail.slice(0, 600)}`);
	notes.push(`${label} stdout tail: ${result.stdout.trim().split("\n").slice(-2).join(" | ").slice(0, 200)}`);
	return false;
}

/**
 * Parses `npm pack --json` stdout tolerantly: lifecycle-script output is kept
 * off stdout by `build:tui`, but npm may still prepend unrelated lines, so the
 * JSON array is located by its first `[`.
 */
export function parseNpmPackJson(stdout: string): Array<{ files?: Array<{ path?: string }> }> {
	const start = stdout.indexOf("[");
	if (start < 0) throw new Error("npm pack --json output contains no JSON array");
	return JSON.parse(stdout.slice(start)) as Array<{ files?: Array<{ path?: string }> }>;
}

async function npmDryRunListing(repoRoot: string, problems: string[], notes: string[]): Promise<string[]> {
	const result = await runCommand(npmCommand(), ["pack", "--dry-run", "--json"], repoRoot, PACK_TIMEOUT_MS);
	if (!requireSuccess(result, "npm pack --dry-run", problems, notes)) return [];
	try {
		const parsed = parseNpmPackJson(result.stdout);
		const files = (parsed[0]?.files ?? []).map((item) => String(item.path));
		if (files.length === 0) problems.push("npm pack --dry-run returned an empty file list");
		return files;
	} catch (error) {
		problems.push(`npm pack --dry-run output was not parseable JSON: ${String(error)}`);
		return [];
	}
}

async function bunDryRunListing(repoRoot: string, problems: string[], notes: string[]): Promise<string[]> {
	const result = await runCommand(bunCommand(), ["pm", "pack", "--dry-run"], repoRoot, PACK_TIMEOUT_MS);
	if (!requireSuccess(result, "bun pm pack --dry-run", problems, notes)) return [];
	const files = parseBunPackListing(result.stdout);
	if (files.length === 0) problems.push(`bun pm pack --dry-run produced no parseable listing (first line: ${result.stdout.split("\n")[0] ?? ""})`);
	return files;
}

export const PROBE_SOURCE = `// Synthetic package-verification probe (generated; no secrets, no host/UI/setup calls).
import path from "node:path";
import { readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { pathToFileURL } from "node:url";

const [mode, arg1, arg2, arg3] = process.argv.slice(2);
const facts = { mode };

/**
 * A package dependency is any specifier that must resolve through
 * node_modules. Relative/absolute/file: specifiers are local, and Node
 * builtins (bare like \`fs/promises\` or \`node:\`-prefixed, including
 * subpaths) are runtime-provided: neither is a package dependency.
 * isBuiltin is the authoritative builtin check, so lookalike package names
 * (fs-extra, stream-browserify, scoped names, builtin-like subpaths) are
 * not suppressed and unknown/unresolvable ones still surface as absent.
 */
const isDependencySpecifier = (specifier) => {
	if (!specifier || specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("node:") || specifier.startsWith("file:")) return false;
	return !isBuiltin(specifier);
};

async function load(specifier) {
	try {
		const mod = await import(specifier);
		return {
			ok: true,
			keys: Object.keys(mod).sort(),
			defaultId: typeof mod.default?.id === "string" ? mod.default.id : null,
			defaultSetup: typeof mod.default?.setup,
			mod,
		};
	} catch (error) {
		return {
			ok: false,
			errorName: error?.name ?? null,
			errorCode: error?.code ?? null,
			errorMessage: String(error?.message ?? error).slice(0, 400),
		};
	}
}

function summarize(loaded) {
	const { mod, ...rest } = loaded;
	return rest;
}

if (mode === "resolve") {
	const installed = arg1;
	const consumerRoot = path.resolve(installed, "..", "..");
	const boundary = path.resolve(consumerRoot, "node_modules").toLowerCase();
	const insideConsumer = (resolved) => {
		const normalized = path.resolve(resolved).toLowerCase();
		return normalized === boundary || normalized.startsWith(boundary + path.sep);
	};
	const locate = (spec) => {
		try {
			const resolved = Bun.resolveSync(spec, installed);
			return { path: resolved, insideConsumer: insideConsumer(resolved) };
		} catch (error) {
			return { absent: true, errorCode: error?.code ?? null };
		}
	};
	const resolveFrom = (spec) => Bun.resolveSync(spec, installed);
	facts.exportTui = resolveFrom("${EXPECTED_PACKAGE_NAME}/tui");
	facts.rootTui = resolveFrom(path.resolve(installed, "tui"));
	facts.dependencyLocations = Object.fromEntries(
		["@opencode/plugin", "libsodium-wrappers-sumo", "pako"].map((name) => [name, locate(name)]),
	);
	const host = await import(pathToFileURL(resolveFrom("@opencode/plugin/host")).href);
	const entries = (() => {
		try {
			return { ok: true, value: host.Host.resolve({ directory: installed }) };
		} catch (error) {
			return { ok: false, name: error?.name ?? null, code: error?.code ?? null, message: String(error?.message ?? error).slice(0, 300) };
		}
	})();
	if (entries.ok) {
		facts.hostResolve = { ok: true };
		facts.hostTui = entries.value.tui ?? null;
		facts.hostServer = entries.value.server ?? null;
	} else {
		facts.hostResolve = { ok: false, name: entries.name, code: entries.code, message: entries.message };
	}
	const sodiumModule = (await load(pathToFileURL(resolveFrom("libsodium-wrappers-sumo")).href)).mod;
	const sodium = sodiumModule?.default ?? sodiumModule;
	await sodium.ready;
	facts.sodiumReady = true;
	facts.sodiumCryptoPwhash = typeof sodium.crypto_pwhash;
	const pako = (await load(pathToFileURL(resolveFrom("pako")).href)).mod;
	facts.pako = Object.fromEntries(
		[
			"Z_BUF_ERROR", "Z_DATA_ERROR", "Z_MEM_ERROR", "Z_NEED_DICT", "Z_NO_FLUSH", "Z_OK",
			"Z_STREAM_END", "Z_STREAM_ERROR", "ZStream", "zlibInflate", "zlibInflateEnd", "zlibInflateInit2",
		].map((name) => [name, typeof pako[name]]),
	);
} else if (mode === "import") {
	const first = await load(arg1);
	facts.first = summarize(first);
	if (arg2) {
		const second = await load(arg2);
		facts.second = summarize(second);
		facts.identity = first.ok && second.ok && first.mod.default === second.mod.default;
	}
} else if (mode === "scan") {
	const prepare = await import(pathToFileURL(Bun.resolveSync("@opencode/plugin/source.bun", arg1)).href);
	const scan = async (entry) => {
		try {
			const tracked = [];
			await prepare.prepareSource(pathToFileURL(entry).href, (file, directory) => tracked.push({ file, directory: !!directory }));
			return tracked;
		} catch (error) {
			return { error: String(error?.message ?? error).slice(0, 400) };
		}
	};
	facts.entry = await scan(arg2);
	facts.wiring = await scan(arg3);
	const bare = new Map();
	const collect = (tracked) => {
		if (!Array.isArray(tracked)) return;
		for (const item of tracked) {
			if (item.directory || !/\\.[cm]?[jt]sx?$/.test(item.file)) continue;
			const loader = item.file.endsWith("tsx") ? "tsx" : item.file.endsWith("jsx") ? "jsx" : /\\.[cm]?ts$/.test(item.file) ? "ts" : "js";
			let imports = [];
			try {
				imports = new Bun.Transpiler({ loader, target: "bun" }).scan(readFileSync(item.file, "utf8")).imports;
			} catch {
				continue;
			}
			for (const imported of imports) {
				const specifier = imported.path;
				if (!isDependencySpecifier(specifier)) continue;
				try {
					const resolved = Bun.resolveSync(specifier, path.dirname(item.file));
					bare.set(specifier, { resolved, insideConsumer: insideConsumerFor(resolved) });
				} catch (error) {
					bare.set(specifier, { absent: true, errorCode: error?.code ?? null });
				}
			}
		}
	};
	function insideConsumerFor(resolved) {
		const consumerRoot = path.resolve(arg1, "..", "..");
		const boundary = path.resolve(consumerRoot, "node_modules").toLowerCase();
		const normalized = path.resolve(resolved).toLowerCase();
		return normalized === boundary || normalized.startsWith(boundary + path.sep);
	}
	collect(facts.entry);
	collect(facts.wiring);
	facts.bare = Object.fromEntries([...bare.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

console.log(JSON.stringify(facts));
`;

async function probeRun(
	consumerDir: string,
	args: string[],
	problems: string[],
	notes: string[],
	cwd: string = consumerDir,
): Promise<ProbeFacts | undefined> {
	const result = await runCommand(bunCommand(), ["run", path.join(consumerDir, "probe.mjs"), ...args], cwd, PROBE_TIMEOUT_MS);
	if (!requireSuccess(result, `probe ${args[0] ?? ""}`, problems, notes)) return undefined;
	const line = result.stdout
		.trim()
		.split("\n")
		.filter((candidate) => candidate.trim().startsWith("{"))
		.pop();
	if (!line) {
		problems.push(`probe ${args[0] ?? ""} produced no JSON output`);
		return undefined;
	}
	try {
		return JSON.parse(line) as ProbeFacts;
	} catch (error) {
		problems.push(`probe ${args[0] ?? ""} output was not JSON: ${String(error)}`);
		return undefined;
	}
}

function classifyDependencyBoundaries(
	facts: ProbeFacts | undefined,
	consumerDir: string,
	label: string,
	hostPeers: boolean,
	problems: string[],
	notes: string[],
): void {
	const bare = facts?.bare as Record<string, { resolved?: string; insideConsumer?: boolean; absent?: boolean }> | undefined;
	if (!bare) {
		problems.push(`${label}: scanner dependency-boundary facts unavailable`);
		return;
	}
	for (const [specifier, fact] of Object.entries(bare)) {
		const name = packageNameOf(specifier);
		if (fact.absent) {
			if (HOST_PEER_ALLOWLIST.includes(name)) {
				notes.push(`${label}: host peer ${name} is absent in this consumer (host-supplied in real installs)`);
			} else {
				problems.push(`${label}: dependency ${specifier} does not resolve from the installed package`);
			}
			continue;
		}
		if (fact.insideConsumer) continue;
		if (HOST_PEER_ALLOWLIST.includes(name)) {
			notes.push(`${label}: host peer ${name} resolves outside the consumer (parent-repo node_modules) and is treated as absent`);
			continue;
		}
		problems.push(`${label}: dependency ${specifier} resolved outside the clean consumer (parent-repo node_modules): ${String(fact.resolved)}`);
	}
	if (hostPeers) {
		const outside = Object.entries(bare).filter(([, fact]) => !fact.absent && !fact.insideConsumer);
		if (outside.length > 0) {
			problems.push(`${label}: host-peer-supplied consumer must resolve every dependency locally (outside: ${outside.map(([specifier]) => specifier).join(", ")})`);
		}
	}
}

function classifyScan(
	facts: ProbeFacts | undefined,
	stagedDir: string,
	label: string,
	problems: string[],
	notes: string[],
): { entry: string[]; wiring: string[]; missing: string[] } {
	const entryTracked = facts?.entry;
	const wiringTracked = facts?.wiring;
	if (!Array.isArray(entryTracked) || !Array.isArray(wiringTracked)) {
		problems.push(`${label}: scanner graph unavailable (${JSON.stringify(entryTracked)?.slice(0, 200)})`);
		return { entry: [], wiring: [], missing: [] };
	}
	const entry = classifyScannerGraph(entryTracked as TrackedEntry[], stagedDir);
	const wiring = classifyScannerGraph(wiringTracked as TrackedEntry[], stagedDir);
	problems.push(...entry.problems.map((problem) => `${label} entry graph: ${problem}`));
	problems.push(...wiring.problems.map((problem) => `${label} wiring graph: ${problem}`));
	if (!entry.localFiles.includes(BUILT_ENTRY_PATH)) {
		problems.push(`${label}: entry scanner graph must include the compiled ${BUILT_ENTRY_PATH} bundle`);
	}
	if (wiring.localFiles.length === 0) {
		problems.push(`${label}: explicit wiring scan tracked no local files`);
	}
	notes.push(
		`${label}: scanner tracked ${entry.localFiles.length} entry files / ${wiring.localFiles.length} wiring files; missing packages: ${
			entry.missingPackages.length > 0 ? entry.missingPackages.join(", ") : "none"
		}`,
	);
	return { entry: entry.localFiles, wiring: wiring.localFiles, missing: entry.missingPackages };
}

function checkInstalledLayout(packageRoot: string, label: string, problems: string[], notes: string[]): string[] {
	const files = listInstalledFiles(packageRoot);
	problems.push(...checkPackedListing(files).map((problem) => `${label}: ${problem}`));
	notes.push(`${label}: installed package has ${files.length} files`);
	return files;
}

async function verifyConsumer(options: {
	readonly label: string;
	readonly consumerDir: string;
	readonly packageRoot: string;
	readonly hostPeers: boolean;
	readonly problems: string[];
	readonly notes: string[];
}): Promise<Record<string, unknown>> {
	const { label, consumerDir, packageRoot, hostPeers, problems, notes } = options;
	const evidence: Record<string, unknown> = { label, hostPeers };
	evidence.files = checkInstalledLayout(packageRoot, label, problems, notes);

	const builtEntry = path.join(packageRoot, BUILT_ENTRY_PATH);
	if (!existsSync(builtEntry)) {
		problems.push(`${label}: installed package must contain the compiled entry ${BUILT_ENTRY_PATH}`);
	} else {
		const builtSource = readFileSync(builtEntry, "utf8");
		problems.push(...checkBuiltEntry(builtSource).map((problem) => `${label}: ${problem}`));
		notes.push(`${label}: compiled ${BUILT_ENTRY_PATH} present (${builtSource.length} bytes); React/JSX/external-import static checks ran`);
		evidence.builtEntry = { path: BUILT_ENTRY_PATH, bytes: builtSource.length };
	}

	const resolve = await probeRun(consumerDir, ["resolve", packageRoot], problems, notes);
	if (resolve) {
		const exportTui = String(resolve.exportTui ?? "").replaceAll("\\", "/");
		const rootTui = String(resolve.rootTui ?? "").replaceAll("\\", "/");
		const expectedRootTui = path.resolve(packageRoot, "tui.ts").replaceAll("\\", "/");
		if (!exportTui.endsWith(`/${BUILT_ENTRY_PATH}`)) {
			problems.push(`${label}: ${EXPECTED_PACKAGE_NAME}/tui export must resolve to ${BUILT_ENTRY_PATH} (got ${exportTui})`);
		}
		if (rootTui !== expectedRootTui) problems.push(`${label}: directory/tui resolution must hit the root shim (got ${rootTui})`);
		const locations = (resolve.dependencyLocations ?? {}) as Record<string, { insideConsumer?: boolean; absent?: boolean }>;
		for (const name of RUNTIME_DEPENDENCIES) {
			const fact = locations[name];
			if (!fact || fact.absent) {
				problems.push(`${label}: runtime dependency ${name} must resolve from the clean install`);
			} else if (!fact.insideConsumer) {
				problems.push(`${label}: runtime dependency ${name} must resolve inside the consumer, not parent-repo node_modules`);
			}
		}
		const hostResolve = resolve.hostResolve as { ok?: boolean; name?: string | null; code?: string | null } | undefined;
		if (hostResolve?.ok) {
			const hostTui = resolve.hostTui === null ? null : String(resolve.hostTui).replaceAll("\\", "/");
			if (!hostTui || !hostTui.endsWith("/tui.ts")) problems.push(`${label}: Host.resolve must return the root tui.ts entrypoint (got ${String(hostTui)})`);
			if (resolve.hostServer !== null) problems.push(`${label}: Host.resolve must not expose a server entrypoint (got ${String(resolve.hostServer)})`);
		} else if (hostResolve?.name === "ResolveMessage" && hostResolve?.code === "ERR_MODULE_NOT_FOUND") {
			notes.push(
				`${label}: Host.resolve eagerly probes sibling entries and rethrows absent ones under Bun ${Bun.version} (ResolveMessage is not instanceof Error); the directory/tui resolution it performs is verified directly`,
			);
		} else {
			problems.push(`${label}: Host.resolve probe failed unexpectedly: ${JSON.stringify(hostResolve)}`);
		}
		if (resolve.sodiumReady !== true) problems.push(`${label}: libsodium ready must initialize from installed dependencies`);
		if (resolve.sodiumCryptoPwhash !== "function") problems.push(`${label}: libsodium crypto_pwhash must be available`);
		const pako = (resolve.pako ?? {}) as Record<string, string>;
		for (const [name, type] of Object.entries(pako)) {
			if (type === "undefined") problems.push(`${label}: pako public export ${name} is missing`);
		}
		evidence.resolve = resolve;
	}

	const stagedDir = path.join(consumerDir, "staged-plugin");
	stageInstalledPackage(packageRoot, stagedDir);
	const scan = await probeRun(
		consumerDir,
		["scan", packageRoot, path.join(stagedDir, "tui.ts"), path.join(stagedDir, "src", "tui", "wiring", "index.ts")],
		problems,
		notes,
	);
	evidence.scan = classifyScan(scan, stagedDir, label, problems, notes);
	classifyDependencyBoundaries(scan, consumerDir, label, hostPeers, problems, notes);

	if (hostPeers) {
		const directEntry = pathToFileURL(path.join(packageRoot, BUILT_ENTRY_PATH)).href;
		const imported = await probeRun(consumerDir, ["import", `${EXPECTED_PACKAGE_NAME}/tui`, directEntry], problems, notes, packageRoot);
		const first = imported?.first as { ok?: boolean; defaultId?: string | null; defaultSetup?: string } | undefined;
		if (!first?.ok) problems.push(`${label}: host-peer-supplied import of ${EXPECTED_PACKAGE_NAME}/tui must succeed`);
		if (first?.defaultId !== "sessionport") problems.push(`${label}: imported default export must stay the sessionport plugin`);
		if (first?.defaultSetup !== "function") problems.push(`${label}: imported plugin must expose its setup function`);
		if (imported?.identity !== true) problems.push(`${label}: root shim and src/tui.ts must expose the same default export`);
		const wiringUrl = pathToFileURL(path.join(packageRoot, "src", "tui", "wiring", "index.ts")).href;
		const wiring = await probeRun(consumerDir, ["import", wiringUrl], problems, notes, packageRoot);
		const wiringFirst = wiring?.first as { ok?: boolean; keys?: string[] } | undefined;
		if (!wiringFirst?.ok) problems.push(`${label}: deferred wiring module must load natively with host peers supplied`);
		const keys = wiringFirst?.keys ?? [];
		for (const required of ["installSessionPortWiring", "createSessionPortHandlers", "EXPERIMENTAL_CRYPTO_POLICY"]) {
			if (!keys.includes(required)) problems.push(`${label}: wiring module is missing export ${required}`);
		}
		notes.push(
			`${label}: compiled entry + deferred wiring load checked without invoking setup (wiring probe cwd at the package root so the packaged tsconfig supplies the @opentui/solid JSX transform)`,
		);
		evidence.import = imported;
		evidence.wiring = wiring;
	} else {
		notes.push(
			`${label}: baseline native import intentionally not attempted because parent-repo node_modules would satisfy bare imports; dependency boundaries above record clean-consumer absence`,
		);
	}
	return evidence;
}

function createConsumer(consumerDir: string, tarballPath: string | undefined, bunStyle: boolean): void {
	mkdirSync(consumerDir, { recursive: true });
	const manifest: Record<string, unknown> = {
		name: `${EXPECTED_PACKAGE_NAME}-package-verify-consumer`,
		version: "1.0.0",
		private: true,
		type: "module",
	};
	if (bunStyle && tarballPath) {
		manifest.dependencies = { [EXPECTED_PACKAGE_NAME]: `file:${tarballPath.replaceAll("\\", "/")}` };
	}
	writeFileSync(path.join(consumerDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
	writeFileSync(path.join(consumerDir, "probe.mjs"), PROBE_SOURCE);
}

function tarballSha256(tarballPath: string): string {
	return createHash("sha256").update(readFileSync(tarballPath)).digest("hex");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
	const flags = new Set(process.argv.slice(2));
	const withInstall = flags.has("--install");
	const cleanup = flags.has("--cleanup");
	const keep = flags.has("--keep");
	const problems: string[] = [];
	const notes: string[] = [];
	const evidence: Record<string, unknown> = {
		generatedAt: new Date().toISOString(),
		repoRoot: REPO_ROOT,
		withInstall,
		bunVersion: Bun.version,
		nodeVersion: process.version,
	};

	const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as Record<string, unknown>;
	problems.push(...checkManifest(manifest));
	problems.push(...checkRootShim(readFileSync(path.join(REPO_ROOT, "tui.ts"), "utf8")));
	problems.push(...checkPackagedTsconfig(readFileSync(path.join(REPO_ROOT, "tsconfig.json"), "utf8")));

	const scratchRoot = createScratchRoot(REPO_ROOT);
	writeFileSync(path.join(scratchRoot, "canary.txt"), "scratch canary; must never be packed\n");
	evidence.scratchRoot = scratchRoot;

	const npmFiles = await npmDryRunListing(REPO_ROOT, problems, notes);
	problems.push(...checkPackedListing(npmFiles).map((problem) => `npm listing: ${problem}`));
	const bunFiles = await bunDryRunListing(REPO_ROOT, problems, notes);
	problems.push(...checkPackedListing(bunFiles).map((problem) => `bun listing: ${problem}`));
	evidence.npmListing = npmFiles;
	evidence.bunListing = bunFiles;

	let tarballPath: string | undefined;
	if (withInstall) {
		const tarballDir = path.join(scratchRoot, "tarball");
		mkdirSync(tarballDir, { recursive: true });
		const packResult = await runCommand(npmCommand(), ["pack", "--pack-destination", tarballDir], REPO_ROOT, PACK_TIMEOUT_MS);
		if (requireSuccess(packResult, "npm pack (tarball)", problems, notes)) {
			tarballPath = path.join(tarballDir, `${EXPECTED_PACKAGE_NAME}-${EXPECTED_VERSION}.tgz`);
			if (!existsSync(tarballPath)) {
				problems.push(`npm pack did not produce the expected tarball at ${tarballPath}`);
				tarballPath = undefined;
			} else {
				evidence.tarball = { path: tarballPath, sha256: tarballSha256(tarballPath) };
				notes.push(`tarball: ${tarballPath}`);
			}
		}
	}

	if (tarballPath) {
		const consumers: Record<string, unknown> = {};

		// npm baseline (host optional peers absent).
		const npmBaselineDir = path.join(scratchRoot, "npm-baseline");
		createConsumer(npmBaselineDir, undefined, false);
		const npmBaselineInstall = await runCommand(npmCommand(), npmInstallArgs(tarballPath), npmBaselineDir, INSTALL_TIMEOUT_MS);
		if (requireSuccess(npmBaselineInstall, "npm baseline install", problems, notes)) {
			const packageRoot = path.join(npmBaselineDir, "node_modules", EXPECTED_PACKAGE_NAME);
			if (!existsSync(path.join(packageRoot, "package.json"))) {
				problems.push(`npm baseline install did not place ${EXPECTED_PACKAGE_NAME} in the consumer node_modules`);
			} else {
				consumers.npmBaseline = await verifyConsumer({ label: "npm baseline", consumerDir: npmBaselineDir, packageRoot, hostPeers: false, problems, notes });
			}
		}

		// npm host-peer-supplied (pinned optional peers simulate the host runtime).
		const npmPeersDir = path.join(scratchRoot, "npm-host-peers");
		createConsumer(npmPeersDir, undefined, false);
		const npmPeersInstall = await runCommand(npmCommand(), npmInstallArgs(tarballPath), npmPeersDir, INSTALL_TIMEOUT_MS);
		if (requireSuccess(npmPeersInstall, `npm host-peer install (${EXPECTED_PACKAGE_NAME})`, problems, notes)) {
			const peersInstall = await runCommand(npmCommand(), npmHostPeerInstallArgs(), npmPeersDir, INSTALL_TIMEOUT_MS);
			if (requireSuccess(peersInstall, "npm host-peer install (pinned peers)", problems, notes)) {
				notes.push("npm host-peer-supplied case: pinned simulation peers installed with --legacy-peer-deps (simulation only; baseline install is unaffected)");
				const packageRoot = path.join(npmPeersDir, "node_modules", EXPECTED_PACKAGE_NAME);
				consumers.npmHostPeers = await verifyConsumer({ label: "npm host-peer-supplied", consumerDir: npmPeersDir, packageRoot, hostPeers: true, problems, notes });
			}
		}

		// Bun baseline (npm-format tarball consumption under Bun with scripts disabled).
		const bunDir = path.join(scratchRoot, "bun-baseline");
		createConsumer(bunDir, tarballPath, true);
		let bunInstall = await runCommand(bunCommand(), bunInstallArgs(), bunDir, INSTALL_TIMEOUT_MS);
		if (bunInstall.status !== 0) {
			notes.push(
				`bun baseline install did not complete (status ${String(bunInstall.status)}${
					bunInstall.cleanup ? `, cleanup: ${bunInstall.cleanup}` : ""
				}); retrying once with a fresh bounded attempt`,
			);
			bunInstall = await runCommand(bunCommand(), bunOnlineInstallArgs(), bunDir, BUN_ONLINE_FALLBACK_TIMEOUT_MS);
		}
		if (requireSuccess(bunInstall, "bun baseline install", problems, notes)) {
			const packageRoot = path.join(bunDir, "node_modules", EXPECTED_PACKAGE_NAME);
			if (!existsSync(path.join(packageRoot, "package.json"))) {
				problems.push(`bun baseline install did not place ${EXPECTED_PACKAGE_NAME} in the consumer node_modules`);
			} else {
				consumers.bunBaseline = await verifyConsumer({ label: "bun baseline", consumerDir: bunDir, packageRoot, hostPeers: false, problems, notes });
			}
		}

		evidence.consumers = consumers;
	}

	evidence.problems = problems;
	evidence.notes = notes;
	writeFileSync(path.join(scratchRoot, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);

	const summary = {
		ok: problems.length === 0,
		problems,
		notes,
		scratchRoot,
		retained: [] as string[],
	};
	if (problems.length === 0) {
		if (cleanup) {
			removeOwnedScratchPath(REPO_ROOT, scratchRoot);
			summary.retained = [];
			notes.push(`scratch removed: ${scratchRoot}`);
		} else {
			if (!keep) {
				for (const name of ["npm-baseline", "npm-host-peers", "bun-baseline"]) {
					const consumerDir = path.join(scratchRoot, name);
					if (existsSync(consumerDir)) removeOwnedScratchPath(REPO_ROOT, consumerDir);
				}
			}
			summary.retained = [scratchRoot];
			notes.push(`scratch retained: ${scratchRoot}`);
		}
	} else {
		summary.retained = [scratchRoot];
		notes.push(`verification failed; scratch retained for inspection: ${scratchRoot}`);
	}
	console.log(JSON.stringify(summary, null, 2));
	return problems.length === 0 ? 0 : 1;
}

if (import.meta.main) {
	process.exitCode = await main();
}
