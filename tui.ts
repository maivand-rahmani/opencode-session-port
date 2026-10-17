/**
 * SessionPort TUI entrypoint shim for the host's directory-based plugin
 * resolution (`Host.resolve` probes `<directory>/tui` by path, before any
 * package `exports` lookup). It re-exports the product entrypoint unchanged;
 * all behavior (platform allowlist gate, pinned-sodium initialization, deferred
 * `./tui/wiring/index.ts` import) stays in `src/tui.ts`.
 *
 * This file is part of the packaged `files` allowlist so an installed copy of
 * the package resolves under the pinned Host.resolve convention. It adds no
 * registration, host access, or activation of its own.
 *
 * The re-export targets the compiled bundle `dist/tui.js`, not the TSX source:
 * the directory loader probes `<directory>/tui` by path and would otherwise
 * bypass the `exports["./tui"]` bundle entirely. `dist/tui.js` is produced by
 * `build:tui` (wired as `prepack`) from `src/tui.ts`.
 */
export { default } from "./dist/tui.js"
