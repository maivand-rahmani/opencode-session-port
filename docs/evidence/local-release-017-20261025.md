# SessionPort 0.1.7 local-release evidence — 2026-10-25

## Status

**Bounded local evidence recorded. No publication receipt or green hosted CI.** This record covers the corrected 0.1.7 local-release package/source validation and the r2 runtime restore-function proof. It does not establish npm publication, a green hosted CI run, a packaged-TUI or native-2.1.1 proof, Linux host support, production data safety, or M1/HOST-01 acceptance.

All hashes below are SHA-256. Local `.package-verify-work/` artifacts are untracked working evidence, not part of the published package.

## Provenance

| Item | Recorded value |
| --- | --- |
| Runtime result | [`result.json`](../../.package-verify-work/local-release-017/result.json), `1851` bytes, SHA-256 `6c55fc09423e7a2028def4f2187c1ef3e5d2ba9fbbdec2bbba633e1bea2ac280`; `status: "ok"`, `allRequiredCasesPassed: true` |
| Run manifest | [`manifest.json`](../../.package-verify-work/local-release-017/manifest.json), `4687` bytes, SHA-256 `6f5370b37266d2250867c3c6598dceb87cc2defcc4a51ada83485cda320fb95f` |
| Bundled entry | [`entry.bundle.mjs`](../../.package-verify-work/local-release-017/entry.bundle.mjs), `854131` bytes, SHA-256 `746ed297f7ab1529bc7fbba19cc226e7771b09bd185e1094d42a079413aeeb67`; built from `scripts/host-probes/local-release/entry.ts` by project transform, with no `dist` build and no `npm pack` |
| Host image | Stock `sha256:118cc62ff6c1b24a9a48a87a5d56f1c8da23df1c791620e81d6ddffb8ef31192`, OpenCode `2.1.3`, `linux/amd64` |
| Runtime isolation | `network: none`; read-only rootfs; `cap-drop ALL`; `no-new-privileges`; uid/gid `1000`; pids `256`; memory `1g`; no ports; no environment; bundle-only read-only mount; no `--rm`; containers retained |
| Package evidence | [`evidence.json`](../../.package-verify-work/mvnzvasx-fcnqkz62/evidence.json), `38679` bytes, SHA-256 `04814fb423031e69d5a98e108e0bbf32bdd53b782cb5fdd8cd1b9b0a85ea6124`; `problems: []` |
| Tarball | [`opencode-session-port-0.1.7.tgz`](../../.package-verify-work/mvnzvasx-fcnqkz62/tarball/opencode-session-port-0.1.7.tgz), `487705` bytes, SHA-256 `b4d517ba0a2ca0f7ea38a7d154a9c55d1f8103ce4c223447c0866999bfa65103` |
| Preserved r1 failure | [`result-r1.json`](../../.package-verify-work/local-release-017/result-r1.json), `1861` bytes, SHA-256 `48fc05932cb46c0371d888b08ed76d82f12a165cd4a648071b81e08d0e421774`; `status: "failed"`, run exit `1` |

The tarball hash is the r2 package-verification artifact captured before the 2026-10-25 README edit. README is a packed file, so a rebuilt release tarball will have a different hash; rerun package verification after the documentation edit and before publication. A README content edit does not change the 85-file count.

## Runtime scope and claim label

The recorded label is **`production-functions-on-public-http-bridge; NOT packaged-TUI; NOT actual-SDK`**. The bundle exercised the actual `runLocalRestore` orchestration, the real experimental checkpoint crypto factory, artifact I/O and recovery-path resolution, public-client adapters, and the core replacement executor. It excluded a fake policy shim, a `dist` build, and `npm pack`.

The installed `@opencode/plugin` did not export a constructible client factory, so the actual SDK was **not** constructed (`expectedVersion: "2.0.22"`, `constructed: false`, `reason: "no-exported-client-factory"`). The public HTTP bridge was used only for the host API proof. TUI context was not available, and the stock Linux 2.1.3 host is not the owner's 2.1.1 native Windows TUI.

The corrected r2 run exited `0` in `4` seconds after a preflight exit `0`; attempt count was `1`. Both owned profiles were stopped and removed (`hostStopped: true`, `profileRemoved: true`); the preflight/run containers and stage artifacts were retained as required.

## Runtime checks

- `session.remove` and `session.get` were callable; paged message listing used `3` requests.
- Global reference inventory was complete and unfiltered, covered `2` projects, and included both the other project and the destination.
- No tool execution was observed.

### Case 1 — replace standalone old target

The old target had `3` messages and the candidate had `2`. The preview contained a replace action; import count was `1`; remove count was exactly `1`. The candidate had a different ID, was parentless, retained re-derived message IDs, and preserved the sentinel; the old target was absent afterward and the candidate survived.

The encrypted recovery artifact path was reported, existed, and authenticated. Its payload held exactly the current old `3` messages with the sentinel preserved. The fixture had **no tool parts** (`noToolParts: true`); standalone completed/error tool-part behavior is covered by the earlier rich host-graph evidence and core tests, not by this r2 run.

### Case 2 — incoming-reference/fork source

The source was treated as a fork/incoming-reference case: SessionPort produced a copy warning (`copyReason: "incoming-reference"`), import count was `2`, remove count was `0`, the old target remained present and unchanged, the candidate was parentless with `2` messages, and no recovery artifact was written.

### Case 3 — changed target

A late `PATCH` returned `204` and actually changed the target title. SessionPort kept the old target (`removeCount: 0`, `oldPresent: true`) with outcome reason `target-changed`, rather than deleting a changed target.

### Case 4 — delete capability unavailable

The missing delete capability was injected. SessionPort previewed a copy (`copyReason: "delete-capability-unavailable"`), performed `0` removes, kept the old target, still imported, and executed no tools. This demonstrates fail-safe copy behavior under the injected condition, not a real host permission model.

## Boundaries

- Synthetic flat fixtures only; no real history, internal database, provider, LLM, tool replay, Git, publication, package update, or `dist` build.
- No live wrong-password rejection or permission-readback test; `recoveryAuthenticated: true` is a correct-password readback only. Case 4 is fault injection, not the host permission model.
- Not a packaged-TUI, actual-SDK, or owner 2.1.1 native proof; the stock Linux 2.1.3 run is not a platform-support claim.
- No CAS, production-durability, or general data-safety claim.

## Harness corrections and retained r1 failure

The preserved r1 result failed only on harness behavior: an exact-read `404` was not mapped to absence; external recovery decryption used a copy of the flow password after `runLocalRestore` zeroed its own copy; and a late `PATCH 204` was not treated as applied. The r2 corrections were:

1. exact-read `404` maps to `undefined`, while non-`404` errors fail closed;
2. external recovery decryption uses a parent-owned independent password copy, while `runLocalRestore` still zeroes its own flow copy;
3. late `PATCH` accepts `200` or `204`.

Six guard tests for these fixes are recorded as passing. The r1 artifact is preserved and is not relabeled as a pass. No product, test-root, or root-package edits were made; only the allowed probe/evidence paths changed.

## Package verification

The r2 package verification recorded `problems: []` and installed/checked three consumer scenarios: npm baseline, npm host-peer-supplied, and Bun baseline. Each installed package had the same **85-file set**; `dist/tui.js` was present at `1048437` bytes; the dependency scan reported no missing packages. The tarball is the one listed in Provenance.

- The npm and Bun listings are the same file set (the listing order differs).
- The host-peer-supplied case performed a native import twice; both returned the same default identifier `sessionport` and a setup function, with identity true.
- The npm and Bun baselines intentionally did not native-import because the parent-repo `node_modules` could satisfy bare imports; their compiled-entry resolution and dependency scans were checked directly, while the host-peer case also loaded deferred wiring.
- Under Bun 1.3.10, `Host.resolve` eagerly probes absent sibling entries and throws a non-`Error` `ResolveMessage`; the directory/`tui` resolution it performs was verified directly.

This is package-consumer evidence, not a packaged-TUI runtime or actual-SDK proof.

## Source validation and hosted CI

The source product is unchanged from the oracle-GO state. The recorded local root suite result is **976 pass / 1 skip / 0 fail**, with a passing root typecheck. Those are local source results, not hosted-CI results.

The recorded source snapshot is `main` push `5399bab`. GitHub Actions run [40208597611](https://github.com/maivand-rahmani/opencode-session-port/actions/runs/40208597611) failed in the source full-test suite (`cloud/auth/state`, `invalid-state-directory`) on the Windows runner. `fix130` was active at record time. **Local test success is not CI success, and no green-CI claim is made.**

## Publication status

No publication receipt is recorded. Registry `latest` is determined by npm at read time, not by this document or a tag; check the [npm package](https://www.npmjs.com/package/opencode-session-port). Do not infer published, registry-live, or production status from this evidence record. No commit, push, tag, publication, remote action, or CI rerun was performed in this documentation lane.

## References

- [README.md](../../README.md) — operator install and recovery workflow.
- [docs/local-release-0.1.7.md](../local-release-0.1.7.md) — authoritative local-release policy and non-claims.
- [r2 manifest](../../.package-verify-work/local-release-017/manifest.json) and [r2 result](../../.package-verify-work/local-release-017/result.json) — local evidence artifacts.
