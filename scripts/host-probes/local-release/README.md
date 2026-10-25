# Local-release 0.1.7 live proof

Status: **r2 actual run PASSED**. r1 failure history is preserved. Product code was not changed by this probe.

## r2 result

- Bundle: `.package-verify-work/local-release-017/entry.bundle.mjs`
  - `854131` bytes, SHA-256 `746ed297f7ab1529bc7fbba19cc226e7771b09bd185e1094d42a079413aeeb67`
  - Built with Bun's own node target from `entry.ts` to the artifact path only. No `dist` build, no npm pack.
- Result: `.package-verify-work/local-release-017/result.json`
  - `1851` bytes, SHA-256 `6c55fc09423e7a2028def4f2187c1ef3e5d2ba9fbbdec2bbba633e1bea2ac280`
  - `status: "ok"`, `allRequiredCasesPassed: true`
- Host image: `sha256:118cc62ff6c1b24a9a48a87a5d56f1c8da23df1c791620e81d6ddffb8ef31192`, stock OpenCode `2.1.3`, linux/amd64.
- Isolation: `--network none`, read-only, cap-drop ALL, no-new-privileges, uid/gid 1000, pids 256, memory 1g, tmpfs 64m + 16m, no ports, no env, bundle-only read-only mount, no `--rm`.
- Preflight exit 0; run exit 0 in 4 seconds; one attempt. Both r2 containers retained.
- Label: production functions through a public-API HTTP bridge; **not** packaged-TUI and **not** actual-SDK. Stock 2.1.3 source API, not the owner 2.1.1 native TUI.

## r2 verified checks

- `session.remove` callable; `session.get` callable; `message.list` paged (3 page requests for a 3-message session).
- Unfiltered global reference inventory complete across two projects.
- Case 1: replace preview, old deleted exactly once, candidate parentless with derived message IDs and 2-message history, candidate survives, encrypted recovery authenticated with the current old 3-message baseline.
- Case 2: fork source copied with `incoming-reference` warning, old unchanged, no DELETE.
- Case 3: real late PATCH returned 204 and changed the title; old kept with `target-changed`, no DELETE.
- Case 4: injected missing `session.remove` produced `delete-capability-unavailable` copy; old kept, no DELETE.
- No tool execution or replay; synthetic fixtures only. Host stopped and profile removed.

## r1 history

r1 failed due three harness defects, now fixed and guarded:
1. exact-read helper threw on 404 instead of returning absence;
2. external recovery decryption reused the flow password array after it was zeroed;
3. PATCH success accepted only 200, not 204.

`result-r1.json` preserves the failed run (`1861` bytes, SHA-256 `48fc05932cb46c0371d888b08ed76d82f12a165cd4a648071b81e08d0e421774`). r1 containers/stage were retained.

## Guard tests

`bun test scripts/host-probes/local-release/entry.test.ts` covers explicit-404 vs 500/unavailable, fail-closed exact read, independent password copies, and 200/204 PATCH success. No product, test-root, package, dist, crypto, docs-root, Git, or publish action was taken.
