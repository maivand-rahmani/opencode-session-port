# Local-release 0.1.7 live proof

Status: **bounded actual run executed once; result failed**. The failure is in the probe harness, not yet in the production restore path. No second run was attempted. Containers and stage evidence are retained on the remote host.

## What ran

- Bundle: `.package-verify-work/local-release-017/entry.bundle.mjs`
  - `853368` bytes, SHA-256 `fe735153373b4ff2e2c8eb5b04d5bee01bf14d200fd1fc7cd56be5b84c212e2e`
  - Built with Bun's own `node` target from `scripts/host-probes/local-release/entry.ts` to the artifact path only. No `dist` build, no npm pack.
- Host image: `sha256:118cc62ff6c1b24a9a48a87a5d56f1c8da23df1c791620e81d6ddffb8ef31192`, stock OpenCode `2.1.3`, `linux/amd64`.
- Isolation: `--network none`, read-only rootfs, `--cap-drop ALL`, `no-new-privileges`, uid/gid `1000`, pids `256`, memory `1g`, tmpfs `/run/sessionport` `64m` and `/tmp` `16m`, no ports, no environment, one read-only bundle mount, no `--rm`.
- One preflight `node --check` (exit 0) and one actual run (exit 1). Containers retained:
  - preflight `f65b14c0cc33c067096c03ce0352ed97a780a0e231c8789c880dc2ce313646df`
  - run `c2692dc3c7456704817beca4161c707f035e5dac10aacfba64d2863ca89d0d9b`

## Production code exercised

`runLocalRestore` with the real experimental crypto factory, real encrypted checkpoint/readback and recovery artifact I/O, real public-client adapters, real ID derivation, and the real replacement executor. The host client is a public-API HTTP bridge because the installed `@opencode/plugin@2.0.22` package does not export a constructible `OpenCodeClient` and the stock image exposes no TUI context. This is **not** a packaged-TUI or actual-SDK claim.

## Passed observations

- `session.remove` callable on the real host.
- `session.get` callable and `message.list` paged with `limit: 2` (3 pages for a 3-message session).
- Global unfiltered `session.list` reference inventory complete across **two** projects, including both the destination and a second project.
- Case 1: replace preview; candidate parentless, derived message IDs, sentinel preserved; old deleted once; candidate survives readback; no tool parts.
- Case 2: fork source produced a copy warning (`incoming-reference`), parentless candidate, old unchanged, no delete.
- Case 3: late real PATCH changed the old target; no delete and `target-changed` outcome.
- Case 4: remove-capability omission produced `delete-capability-unavailable` copy with no delete.
- Host stopped and profile removed; no tool/provider/LLM execution.

## Exact failure

- Case 1 report outcome was not observed as `replaced` even though the DELETE count was 1 and the old target was absent. The probe's exact-read helper throws 404 instead of returning absence; the executor's delete reconciliation therefore treated the post-delete read as unreadable.
- Recovery file existed and was reported, but post-run decryption failed because the probe reused the same password array that `runLocalRestore` zeroes in `finally`.
- Case 3 PATCH actually changed the title (`oldTitleChanged: true`) but returned HTTP `204`; the probe only counted `200` as applied.

See `.package-verify-work/local-release-017/result.json` for the structural result and `manifest.json` for hashes, container IDs, and failure labels. No product, test-root, package, dist, crypto, docs-root, Git, or publish action was taken by this probe. Parent owns the corrected rerun and any production change.
