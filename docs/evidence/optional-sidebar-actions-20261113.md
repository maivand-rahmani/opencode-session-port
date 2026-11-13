# Optional sidebar quick actions — evidence (2026-11-13)

## Scope

The owner asked whether OpenCode exposes enough API for two fast actions in the
session sidebar, then required the feature to be enabled from inside OpenCode
rather than by editing `cli.json`. This record covers the optional,
off-by-default `Checkpoint` / `Restore` footer actions and their native settings
modal. It is separate from the phase 2/3 lineage and in-place update work; see
[two-machine-lineage-update-20261113.md](two-machine-lineage-update-20261113.md).

## API finding

The pinned TUI plugin package (`@opencode/plugin` 2.0.22) publishes a documented
slot surface, not a dedicated action-button API:

| Requirement | Public API |
| --- | --- |
| Placement | `context.ui.slot({ append: "sidebar.footer", render })` |
| Session context | slot input `{ sessionID }` |
| Click | OpenTUI raw `onMouseUp` / `onMouseOver` / `onMouseOut` (no `onClick`) |
| Action | `context.keymap.dispatch(commandID)` |
| Theme | semantic `context.theme.text.*` tokens |
| Cleanup | the disposer returned by `ui.slot` |
| Persistence | `context.storage.store(key, { initial })` — durable, restart-safe, live-synced |
| Settings UI | `context.ui.dialog.set(...)` + `context.ui.dialog.show(...)` |

`SlotMap` declares `sidebar.content` and `sidebar.footer`; the type comment says
slot paths and inputs are documented API kept stable across host refactors. The
host's own sidebar footer uses the same click pattern: a row with `onMouseUp`
that dispatches a command. There is no sidebar keyboard focus and no slot
priority.

**Built-in settings modal limit.** OpenCode 2.0.22's `/settings` page is a
static `settings` array in the host, and its Experiments page is a static
`experiments` array. The public plugin API exposes no registration point for
either. A plugin therefore cannot add a row to the host's `/settings` modal
without modifying host internals. SessionPort provides its own native settings
modal, opened from the command palette / `/sessionport`, using only public
dialog and storage APIs.

Sources inspected in the pinned clone:

- `packages/plugin/src/tui/context.ts` — `SlotMap`, `SlotClaim`, `UI.slot`,
  `Keymap.dispatch`, `Storage.store`, `Context.options`.
- `packages/tui/src/routes/session/sidebar.tsx` — mounts `sidebar.content` and
  `sidebar.footer`; fixed 42-column sidebar.
- `packages/tui/src/feature-plugins/sidebar/footer.tsx` — host click pattern.
- `packages/tui/src/component/session-frame.tsx` — sidebar hidden for child
  sessions, config `session.sidebar: "hide"`, or a narrow terminal in `auto`
  mode.
- `packages/tui/src/component/dialog-config.tsx` and
  `dialog-experiments.tsx` — static host settings/experiment registries.
- `packages/tui/src/plugin/context.tsx` — plugin storage and context creation.

## Persistence and toggle

The install lane creates one plugin-scoped durable store:

```ts
context.storage.store("settings", { initial: { sidebarActions: false } })
```

The store is host-owned, persisted to disk, survives TUI restarts, and is
live-synced across running TUI instances. The host namespaces it by plugin ID,
so it cannot collide with other plugins.

The settings modal is reachable from:

- `/sessionport`
- the command palette entry **SessionPort settings**
  (`sessionport.settings`, group `SessionPort`)

Toggling **Sidebar quick actions** writes the store; the sidebar reads the same
reactive store, so the footer updates immediately. No `cli.json` entry or
restart is required.

## Behavior

- Two text actions are appended to `sidebar.footer`; built-in footer content is
  preserved because the claim uses `append`, never `replace`.
- While disabled, the footer claim renders an empty box: no labels, no hit
  targets, no visible footprint.
- Clicking dispatches the existing native command IDs
  (`sessionport.checkpoint`, `sessionport.restore`), so previews, password
  prompts, confirmations, reports, and error handling are the same code path as
  the slash commands.
- Hover uses the action theme token; labels use muted text otherwise. No raw
  hue or unrelated semantic token is used.
- The claim is disposed with the command slot during plugin cleanup.
- Commands, slash discovery, and the palette remain the keyboard path. The
  actions are pointer-only, and only appear when the host renders the sidebar.

## Verification

| Check | Result |
| --- | --- |
| `tests/tui/ui/settings-dialog.test.tsx` | 4 pass / 0 fail — native modal render, keyboard toggle + persisted state, rejected save, cleanup callback, Esc close |
| `tests/tui/ui/sidebar-actions.test.tsx` | 3 pass / 0 fail — enabled labels/click dispatch, disabled empty render, cleanup |
| `tests/tui/ui/sessionport-commands.test.ts` | 4 pass / 0 fail — settings command appears only with a handler, palette + `/sessionport` metadata |
| `tests/tui/wiring/install.test.ts` | storage-backed footer claim, settings command opens the modal, both disposers run |
| `tests/tui/fixtures/entry-isolated.fixture.ts` | 6 pass / 0 fail — storage-backed activation, app + footer claims, three local commands |
| Focused run (settings, sidebar, install, entry, commands) | 28 pass / 0 fail, 5 files |
| Non-cloud full suite | 970 pass / 0 fail, 66 files |
| `bun run typecheck` | clean |
| `bun run build:tui` | `dist/tui.js`, 1,137,291 bytes; bundle contains `SessionPort settings`, `Sidebar quick actions`, and `sessionport.sidebar.checkpoint` |
| `bun run verify:package` | `ok: true`, no problems; 92 packed files including `settings-dialog.tsx` |

## Limits and non-claims

- **No live-host sidebar click or settings-modal test was performed.** The API
  and host usage were inspected in the pinned v2.0.22 source; the UI paths are
  exercised only in synthetic OpenTUI renderer tests. The running TUI must be
  restarted to load the rebuilt bundle.
- **Not inside the host `/settings` page.** That page is not plugin-extensible
  in 2.0.22. The toggle lives in SessionPort's own native modal, reached from
  the command palette or `/sessionport`.
- **Terminal mouse capture must be enabled.** OpenCode defaults mouse capture to
  on, but the actions cannot work in a terminal where the user disabled it.
  Keyboard commands are the fallback.
- **The sidebar is not keyboard-focusable.** These are pointer shortcuts, not an
  accessible keyboard surface of their own.
- **Visibility follows the host.** Child sessions, `session.sidebar: "hide"`,
  and narrow terminals hide the whole sidebar including these actions.
- **Version coupling.** The slot paths, storage API, and dialog API are public in
  2.0.22 and were unchanged in the inspected 2.1.x/2.2.x surfaces, but a future
  host that removes them would break registration. Registration errors surface
  through the host plugin error boundary; the command surface remains
  independent.
- **No new privilege.** The actions dispatch existing commands; they add no
  filesystem, crypto, network, or host-database behavior.
