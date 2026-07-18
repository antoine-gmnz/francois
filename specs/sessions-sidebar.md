---
id: sessions-sidebar
title: Sessions sidebar
status: frozen
created: 2026-07-18
depends_on: [session-engine, app-shell]
---

# Sessions sidebar

## 1. Summary

The sessions sidebar is pane `[1]`: the always-visible list of every Claude Code session Francois is orchestrating. It hydrates from `session-engine` and stays live via the shared session event stream, lets the user select which session drives the rest of the UI (main pane tabs, agents/MCP/skills panels), and is the sole entry point for creating a new session (directory + name + model) and for removing an existing one. This feature owns the app-wide "which session is active" state — every other pane reads it, only this one writes it.

## 2. Goals & non-goals

- **Goals**:
  - Render the live list of sessions (`SessionMeta`), hydrated once and kept in sync via events.
  - Own selection: mouse click and keyboard (`↑`/`↓` + `⏎`) both set the shared `activeSessionId`.
  - Provide an inline `/` filter over name/path.
  - Provide the "new session" flow: directory picker → name → model → create, with inline error handling.
  - Provide a minimal right-click "remove session" action with confirm.
  - Define and own the `francois:session:pickDirectory` IPC channel.
- **Non-goals** (out of scope here, live elsewhere):
  - Session lifecycle (spawn/stop, status transitions, transcript, context usage) — `session-engine`.
  - Rendering the selected session's conversation/diff/shell — `conversation-view`, `diff-view`, `shell-terminal`.
  - Global focus/pane-switching mechanics and the `1`–`5` key routing — `app-shell`.
  - The `⌘K` "New session" / "Switch model" command-palette entries and how they invoke this feature's actions — `command-palette` (when specced, it should call this feature's exposed actions rather than write `activeSessionId` itself).
  - Renaming a session, reordering/pinning, multi-select, or per-session settings beyond model-at-creation — deferred to a later spec revision.
  - Session persistence/restore across app restarts — out of scope for the whole app per `PROJECT.md`.

## 3. User stories / flows

**Cold start (hydration)**
1. Pane `[1]` mounts and calls `francois:session:list`.
2. On success, the returned `SessionMeta[]` becomes the local session cache, rendered in the order returned.
3. If the cache is non-empty and `activeSessionId` is unset, the first session in the list is auto-selected.
4. If the cache is empty, the empty state renders ("no sessions yet · press n").
5. The pane subscribes to `francois:session:event` for the remainder of its lifetime.

**Select a session with the mouse**
1. User clicks a row.
2. `activeSessionId` is set to that row's session id; pane `[1]` requests focus.
3. The row immediately shows the selected treatment; main pane and right panels re-render for the new session (their concern, not this spec's).

**Select a session with the keyboard**
1. Pane `[1]` is focused (via `1` or a click, per `app-shell`).
2. `↓`/`↑` move a local keyboard-cursor highlight through the visible rows, without changing `activeSessionId` yet.
3. `⏎` commits: `activeSessionId` is set to the cursor's session id.

**Filter the list**
1. Pane `[1]` is focused; user presses `/`.
2. An inline filter input appears at the top of the list and takes text focus.
3. User types; the visible row list narrows to name/path matches as they type. `↑`/`↓`/`⏎` keep working against the filtered list.
4. `Esc` clears the query and closes the filter input, restoring the full list.

**Create a new session (happy path)**
1. User clicks footer "+ new session [n]" or presses `n` anywhere in the app.
2. The new-session modal opens: directory field (empty), name field (empty), model select (loading, then populated).
3. User clicks "Browse…"; the native OS directory dialog opens via `francois:session:pickDirectory`.
4. User picks a directory; the field fills in, and the name field auto-fills with its basename.
5. User optionally edits the name, picks a model (or accepts the default first entry).
6. User clicks "Create session" (or presses `⏎`); the modal shows a busy state.
7. `francois:session:create` resolves ok; the modal closes, the new session is upserted into the list, and it becomes the active session.

**Create a new session (error path)**
1. Same as above through step 6.
2. `francois:session:create` resolves with `SPAWN_FAILED` or `INVALID_INPUT`.
3. The modal stays open, shows an inline error banner, and preserves the entered directory/name/model so the user can retry or fix input and resubmit.

**Cancel the new-session modal**
1. User clicks the backdrop, clicks "Cancel", or presses `Esc`.
2. Modal closes; no session is created; form state is discarded.

**Remove a session**
1. User right-clicks a row (native context menu suppressed).
2. A small menu appears with "Remove session".
3. Clicking it swaps the menu content for an inline confirm: `remove '<name>'?` with "Remove" / "Cancel".
4. Clicking "Remove" calls `francois:session:remove`; on success the row disappears (and selection is reassigned if it was active). Clicking "Cancel", clicking outside, or `Esc` dismisses the menu with no effect.

## 4. Functional requirements

- **FR-1 Hydration**: On mount, invoke `francois:session:list`. On success, populate the local session cache in the order returned. On failure, render an inline error with a retry action in place of the row list (see §7).
- **FR-2 Live updates**: Subscribe to `francois:session:event` for the pane's lifetime. Handle only `'session.meta'` (upsert by `id`, preserving existing position; unknown ids are appended at the end), `'session.status'` (patch `status` on the matching cached entry only), and `'session.removed'` (delete the matching cached entry). All other `SessionEvent` members are ignored by this feature.
- **FR-3 Header**: Renders `SESSIONS` (11px, letter-spacing 0.14em, weight 700) on the left and `<N> · [1]` on the right, where `N` is the total count of sessions in the local cache — unaffected by the filter.
- **FR-4 Row content**: Each row shows, top to bottom/left to right: an 8px status dot; the name (12.5px, weight 500); a path line (10.5px, `#565a63`, home directory abbreviated to `~` when resolvable — see §6 — else the raw absolute path, single line, ellipsis overflow); a status line `"<status> · <model.label>"` (10px, colored by status, `status` rendered verbatim from `SessionStatus`).
- **FR-5 Status colors & motion**: `running` → `#d0a45c` with a `pulse 1.4s ease-in-out infinite` animation on the dot; `idle` → `#6b7079`, no animation; `done` → `#7fa07a`, no animation; `error` → `#c46b62`, no animation. The dot fill and the status-line text share the same color for a given row.
- **FR-6 Selection visuals**: The row whose `id === activeSessionId` gets background `#20222a`, a 2px `#c8a15a` left border marker, and its name color brightens to `#dfe2e8`. All other rows: transparent background, transparent marker, name color `#c4c7ce`.
- **FR-7 Initial selection**: Immediately after the first successful hydration, if `activeSessionId` is `null` and the cache is non-empty, set `activeSessionId` to the first session's id. If the cache is empty, leave it `null` and render the empty state.
- **FR-8 Click selection**: Clicking a row sets `activeSessionId` to that row's id and requests focus for pane `[1]` (via `app-shell`'s focus mechanism). Takes effect immediately — no confirm step.
- **FR-9 Keyboard cursor**: While pane `[1]` is focused, `↑`/`↓` move a local keyboard-cursor among the currently visible (post-filter) rows, clamped at both ends (no wraparound). The cursor renders as a subtle outline independent of `activeSessionId` until committed.
- **FR-10 Keyboard commit**: `⏎`, while pane `[1]` is focused, sets `activeSessionId` to the session at the keyboard-cursor (same effect as FR-8). No-op if the visible list is empty.
- **FR-11 Cursor sync**: Whenever `activeSessionId` changes or the visible row list changes (filter applied/cleared, rows added/removed), the keyboard-cursor is clamped into range; if its session is no longer visible, it resets to the row matching `activeSessionId` if visible, else index `0`.
- **FR-12 Empty state**: When the local cache has zero sessions, the list area shows a centered hint `"no sessions yet · press n"`, and the header reads `"0 · [1]"`.
- **FR-13 Filter open**: `/`, while pane `[1]` is focused and the filter input does not already have focus, opens the inline filter input (below the header) and gives it text focus; sets `sidebarFilter` to `''`.
- **FR-14 Filter apply**: The visible row list is the subset of the local cache whose `name` or `cwd` contains `sidebarFilter` as a case-insensitive substring. Filtering never changes the header count (FR-3).
- **FR-15 Filter no-match**: If `sidebarFilter` is non-`null` and the visible list is empty while the cache is non-empty, show `"no matches · esc to clear"` in place of the row list.
- **FR-16 Filter clear**: `Esc`, while the filter input has focus, sets `sidebarFilter` to `null` (closes the input, restores the full list) and returns keyboard focus to the row list.
- **FR-17 Filter + navigation**: While the filter input has text focus, `↑`/`↓`/`⏎` still operate on the visible row list per FR-9/FR-10; the user does not need to blur the input first.
- **FR-18 New-session entry points**: The footer control `"+ new session [n]"` and the global `n` key (routed by `app-shell` per `PROJECT.md`'s keyboard model) both open the new-session modal. If the modal is already open, both are no-ops.
- **FR-19 Modal fields**: Directory (read-only display + "Browse…" trigger — no free-text path entry), Name (text input, defaults to `basename(cwd)` and re-syncs on directory change until the user edits it directly, after which it stays user-controlled), Model (select populated from `francois:session:models`, defaulting to the first entry once loaded).
- **FR-20 Directory picker**: "Browse…" (and clicking the directory field) invokes `francois:session:pickDirectory`. A non-`null` result sets the directory (and re-derives name from its basename if the name is not yet user-edited). A `null` result (cancel) leaves the form unchanged. An `ok: false` result shows an inline error near the field and leaves the form unchanged. The control is disabled while a request is in flight.
- **FR-21 Create validation**: "Create session" is disabled until directory is non-empty, name is non-empty, a model is selected, and no create request is in flight.
- **FR-22 Create submit**: Confirming invokes `francois:session:create` with a `NewSessionRequest`. On success: the modal closes, the returned `SessionMeta` is upserted into the local cache (independent of any later `'session.meta'` event for the same id, which becomes a no-op upsert), and `activeSessionId` is set to its id.
- **FR-23 Create errors**: `SPAWN_FAILED` and `INVALID_INPUT` render inline in the modal (banner above the actions); the modal stays open and form values are preserved for retry.
- **FR-24 Modal dismiss**: Clicking the backdrop, "Cancel", or `Esc` closes the modal with no side effects. It does not cancel an in-flight create request (see §7 for the resolution race).
- **FR-25 Context menu**: Right-clicking a row (default browser context menu suppressed) opens a small menu anchored to that row with a single item, "Remove session". The menu's target row need not be the active or cursor row.
- **FR-26 Remove confirm**: Clicking "Remove session" replaces the menu content with an inline confirm (`remove '<name>'?` + "Remove" / "Cancel"). "Remove" invokes `francois:session:remove`. "Cancel", a click outside the menu, or `Esc` closes the menu with no action.
- **FR-27 Remove result**: On a successful `francois:session:remove` response, the row is removed from the local cache immediately (does not wait for a `'session.removed'` event; a later event for an already-absent id is a no-op). If the removed session was active, selection is reassigned per §7. On failure (`SESSION_NOT_FOUND`), an inline error replaces the confirm buttons until the user dismisses the menu.

## 5. API contract

Contract file: `contract/sessions-sidebar.ts`. Imports shared types from `contract/common.ts` and never redefines them.

### Channels this feature owns

| Channel | Direction | Payload | Result data | Error codes |
|---|---|---|---|---|
| `francois:session:pickDirectory` | frontend → core (invoke) | none | `{ path: string } \| null` (`null` = user cancelled the native dialog — **not** an error) | `INTERNAL` |

### Channels this feature consumes (owned by `session-engine`; shapes pinned here so this feature builds standalone)

| Channel | Direction | Payload | Result data | Error codes |
|---|---|---|---|---|
| `francois:session:list` | frontend → core (invoke) | none | `SessionMeta[]` | `INTERNAL` |
| `francois:session:models` | frontend → core (invoke) | none | `ModelInfo[]` | `INTERNAL` |
| `francois:session:create` | frontend → core (invoke) | `NewSessionRequest` | `SessionMeta` (the created session) | `SPAWN_FAILED`, `INVALID_INPUT` |
| `francois:session:remove` | frontend → core (invoke) | `{ sessionId: SessionId }` | `void` | `SESSION_NOT_FOUND` |
| `francois:session:event` | core → frontend (event) | — | payload is `SessionEvent` (tagged union, `contract/common.ts`); this feature handles only `'session.meta'`, `'session.status'`, `'session.removed'` and ignores all other members | n/a (event channel) |

### `contract/sessions-sidebar.ts`

```ts
// contract/sessions-sidebar.ts — sessions-sidebar (pane [1]).
// Imports shared vocabulary from common.ts; never redefines it.

import type {
  SessionId,
  SessionMeta,
  ModelInfo,
  Result,
  SessionEvent,
} from './common';

// ---------- owned by this feature ----------

/** francois:session:pickDirectory — frontend -> core, no payload. */
export type PickDirectoryRequest = void;

/** null = user cancelled the native OS directory dialog (not an error). */
export type PickDirectoryData = { path: string } | null;

/** Result<PickDirectoryData>; ok:false error codes: 'INTERNAL'. */
export type PickDirectoryResponse = Result<PickDirectoryData>;

/**
 * UI-side shape assembled by the new-session modal; sent as the payload
 * of francois:session:create (channel owned by session-engine).
 */
export interface NewSessionRequest {
  cwd: string; // absolute path, chosen via francois:session:pickDirectory
  name: string; // defaults to basename(cwd); user-editable
  modelId: string; // ModelInfo.id selected in the modal
}

// ---------- consumed (owned by session-engine; pinned here for build-ability) ----------

/** francois:session:list — frontend -> core, no payload. Error codes: 'INTERNAL'. */
export type SessionListResponse = Result<SessionMeta[]>;

/** francois:session:models — frontend -> core, no payload. Error codes: 'INTERNAL'. */
export type SessionModelsResponse = Result<ModelInfo[]>;

/** francois:session:create — frontend -> core, payload NewSessionRequest. Error codes: 'SPAWN_FAILED' | 'INVALID_INPUT'. */
export type SessionCreateResponse = Result<SessionMeta>;

/** francois:session:remove — frontend -> core. Error codes: 'SESSION_NOT_FOUND'. */
export interface SessionRemoveRequest {
  sessionId: SessionId;
}
export type SessionRemoveResponse = Result<void>;

/**
 * francois:session:event — core -> frontend, payload SessionEvent (contract/common.ts).
 * sessions-sidebar handles only these members; all others belong to other features:
 *   - 'session.meta'    upsert into the local cache by id, preserving existing position
 *   - 'session.status'  patch .status on the matching cached entry
 *   - 'session.removed' delete the matching cached entry
 */
export type SidebarHandledSessionEvent = Extract<
  SessionEvent,
  { type: 'session.meta' } | { type: 'session.status' } | { type: 'session.removed' }
>;

// ---------- shared frontend store fields owned by this feature ----------

export interface SessionsSidebarStoreSlice {
  /**
   * The app-wide active session. Written ONLY by sessions-sidebar (click, keyboard
   * commit, initial-selection, post-create auto-select, post-remove reassignment).
   * Every other feature (app-shell, conversation-view, diff-view, shell-terminal,
   * agents-panel, mcp-panel, skills-panel, command-palette) reads it and must not
   * write it directly.
   */
  activeSessionId: SessionId | null;

  /**
   * null = filter UI closed. Non-null = filter UI open, value is the current query
   * ('' allowed — open with an empty query). Written and read only by this feature.
   */
  sidebarFilter: string | null;
}
```

## 6. Data & state

**Shared frontend store (zustand), owned by this feature** — see `SessionsSidebarStoreSlice` in §5: `activeSessionId`, `sidebarFilter`.

**Feature-local state** (not shared cross-feature):
- `sessions: SessionMeta[]` — the hydrated local cache, maintained per FR-1/FR-2/FR-22/FR-27.
- `rowCursor: number` — keyboard-highlight index into the currently visible (post-filter) row list; see FR-9/FR-11.
- `hydrationError: AppError | null` — set when `francois:session:list` fails; cleared on retry.
- New-session modal: `open: boolean`, `cwd: string`, `name: string`, `nameTouched: boolean` (stops auto-sync from `cwd` once the user edits `name` directly), `models: ModelInfo[]`, `modelsLoading: boolean`, `modelId: string`, `submitting: boolean`, `submitError: AppError | null`, `pickerError: AppError | null`.
- Context menu: `target: { sessionId: SessionId; x: number; y: number } | null`, `confirming: boolean`, `removeError: AppError | null`.

**Derived state**: visible row list (`sessions` filtered by `sidebarFilter` per FR-14); header count `N = sessions.length`; abbreviated path per row (see below).

**Read-only dependency (not owned here)**: `app-shell`'s shared focus state (referred to here as `focusedPane`) — this feature reads it to gate keyboard handling for pane `[1]` (FR-9/FR-10/FR-13/FR-16) and calls into `app-shell`'s focus-setter on row click (FR-8). Exact field/action names are `app-shell`'s to define; this spec only depends on "some way to know/request pane focus."

**Home-directory abbreviation**: performed client-side against a `homeDir: string` value expected to be exposed by `app-shell` via a Tauri command (exact mechanism is `app-shell`'s to define). If unavailable, this feature falls back to displaying the raw absolute `cwd` (still ellipsis-truncated) — see §7.

**Persistence**: none. `activeSessionId`, `sidebarFilter`, and the local cache are all in-memory only and reset on app restart, consistent with `PROJECT.md`'s "session persistence/restore… out of scope."

## 7. Edge cases & errors

- **`francois:session:list` fails**: list area shows `"failed to load sessions"` + a `retry` action that re-invokes the channel; header shows `"0 · [1]"` until a successful load.
- **Removing the active session**: reassign `activeSessionId` to the row that now occupies the removed row's index (its former next neighbor); if the removed row was last, reassign to the new last row; if the cache is now empty, set `activeSessionId` to `null` and show the empty state.
- **Stale create request after modal cancel**: if the user cancels the modal (FR-24) while `francois:session:create` is in flight and it later resolves successfully, the returned session is still upserted into the local cache (it is real and running) but does **not** forcibly override whatever `activeSessionId` the user has since set — auto-select (FR-22) only applies while the modal is still open at resolution time.
- **`francois:session:remove` fails with `SESSION_NOT_FOUND`** (e.g. removed concurrently elsewhere): inline error replaces the confirm buttons in the context menu; the row itself is likely already gone via a `'session.removed'` event by this point — the error is dismissed the same way as the confirm state (outside click / `Esc`).
- **`francois:session:pickDirectory` fails (`ok: false`, `INTERNAL`)**: inline error text near the directory field/"Browse…" button; form otherwise unchanged; the control re-enables for retry.
- **Model list loads empty** (`ok: true`, `data: []`): model select shows a disabled placeholder `"no models available"`; "Create session" stays disabled (FR-21).
- **Duplicate `'session.meta'` for an id already in the cache**: treated as an update in place (FR-2) — position never changes on update, only on creation (append).
- **Filter matches zero rows while the cache is non-empty**: `"no matches · esc to clear"` (FR-15), distinct from the zero-sessions empty state (FR-12).
- **`/` pressed while the filter input already has focus**: not intercepted — it is typed into the query like any other character (FR-13 only fires the "open" transition when the filter input does not already have focus).
- **Home directory unresolvable**: raw absolute `cwd` is shown, unabbreviated, still ellipsis-truncated on overflow (§6).
- **Rapid `session.status` flapping** (e.g. `running → error → running`): each event simply overwrites `.status` on the cached entry; the dot's color/animation reflects the latest value with no debouncing.
- **Double-invoking the directory picker**: the "Browse…"/directory-field control is disabled for the duration of an in-flight `francois:session:pickDirectory` call (FR-20); a second click before resolution is a no-op.
- **`n` pressed while the new-session modal is already open**: no-op (FR-18); does not reset in-progress form state.

## 8. Design brief

### Screens / regions

Pane `[1]`, the sidebar column of the three-column TUI grid (`Claude Terminal.dc.html` lines 50–68, the `<!-- SIDEBAR / sessions -->` section: header row, scrollable `.scz` row list, footer). Two overlays owned by this feature, layered above the grid the same way the command palette is (lines 251–276, `<!-- COMMAND PALETTE -->`): the new-session modal, and a small anchored context menu.

### Components

- **Header** — `SESSIONS` label + `N · [1]` count.
- **Row** — status dot, name, path line, status line. Variants: default, hover, selected, keyboard-cursor (see States).
- **StatusDot** — 4 status variants (`running`/`idle`/`done`/`error`), pulsing only for `running`.
- **FilterInput** — inline text input replacing/prepending the row list top.
- **EmptyState** / **NoMatchesState** — centered hint text.
- **Footer** — `+ new session [n]` control.
- **NewSessionModal** — overlay panel: DirectoryField (display + "Browse…"), NameInput, ModelSelect, error banner, Cancel/Create actions.
- **ContextMenu** — small floating panel: "Remove session" item → confirm sub-state (`remove '<name>'?` + Remove/Cancel) → optional inline error.

### States

- **Row — default**: bg `transparent`, name `#c4c7ce`, no marker.
- **Row — hover**: subtle raised bg, suggested `#1b1d23` (mirrors the mock's raised-row token from `PROJECT.md`'s Visual design system), cursor `pointer`.
- **Row — selected** (`activeSessionId` match): bg `#20222a`, 2px left border `#c8a15a`, name `#dfe2e8`.
- **Row — keyboard-cursor** (not yet committed): thin 1px inset outline in `#3a3d45`/`#565a63` around the row, independent of and combinable with the selected state.
- **Status dot — running**: fill `#d0a45c`, `animation: pulse 1.4s ease-in-out infinite` (reuse the mock's `@keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:0.35; } }`).
- **Status dot — idle**: fill `#6b7079`, no animation.
- **Status dot — done**: fill `#7fa07a`, no animation.
- **Status dot — error**: fill `#c46b62`, no animation.
- **Empty state**: list area shows centered text `"no sessions yet · press n"`, 11.5px, `#565a63`.
- **Filter — closed**: no input row rendered.
- **Filter — open, empty query**: input row visible, placeholder `filter…`, full list still visible below.
- **Filter — open, matches**: list narrowed to matches.
- **Filter — open, no matches**: centered `"no matches · esc to clear"`, same treatment as empty state.
- **New-session modal — loading models**: model select disabled, shows `loading…`.
- **New-session modal — ready**: all fields enabled per FR-21's validation.
- **New-session modal — submitting**: Create button shows a busy label (e.g. `creating…`), disabled; Cancel remains enabled.
- **New-session modal — error**: red-tinted inline banner (`#c46b62` text) above the actions, using `SPAWN_FAILED`/`INVALID_INPUT`'s `message`.
- **Context menu — default**: single `Remove session` row.
- **Context menu — confirming**: `remove '<name>'?` + Remove (danger) / Cancel.
- **Context menu — error**: inline error text (`#c46b62`) in place of the confirm buttons.

### Interactions

- **Mouse**: click row → select (FR-8) + focus pane; hover row → hover treatment; right-click row → open context menu at cursor position, suppressing the native menu; click footer button or the row area outside any row → n/a (only rows/footer/filter are interactive); click backdrop or "Cancel" → close modal; click outside context menu → close menu.
- **Keyboard** (pane `[1]` focused, per `app-shell`): `↑`/`↓` move `rowCursor` (FR-9); `⏎` commits selection (FR-10); `/` opens the filter (FR-13); inside the filter, `Esc` clears+closes it (FR-16), `↑`/`↓`/`⏎` still drive the row list (FR-17). Global: `n` opens the new-session modal (FR-18, routed by `app-shell`). Inside the modal: `Tab` cycles Directory (Browse trigger) → Name → Model → Cancel → Create; `⏎` inside Name or with Create focused submits when valid (FR-21/FR-22); `Esc` anywhere in the modal closes it (FR-24). Inside the context menu: `Esc` closes it (FR-26).

### Visual notes

Exact tokens (from the mock and `PROJECT.md`'s Visual design system):

- Header label: 11px, letter-spacing `0.14em`, weight 700, color = accent `#c8a15a` when pane focused else dim `#868a93` (focus-ring convention shared with every pane title in the mock).
- Header count: 10px, `#565a63`.
- Row padding `8px 9px`, gap `9px`, border-radius `4px`, `margin-bottom:2px` (mirrors `Claude Terminal.dc.html` line 57).
- Status dot: `8px × 8px`, `border-radius:50%`.
- Name: 12.5px, weight 500; default `#c4c7ce`, selected `#dfe2e8`.
- Path line: 10.5px, `#565a63`, `white-space:nowrap; overflow:hidden; text-overflow:ellipsis`, `margin-top:1px`.
- Status line: 10px, color = the row's status color, `letter-spacing:0.02em`, `margin-top:3px`.
- Selected row: bg `#20222a`, left border `2px solid #c8a15a`.
- Panel chrome: bg `#16171c`, border `1px solid #24262d` (`#c8a15a` when pane focused), `border-radius:5px`.
- Footer: `padding:8px 12px`, top border `1px solid #24262d`, text `10.5px #565a63`, hotkey glyph `#3a3d45`.
- Scrollbar: `.scz` pattern — 8px, thumb `#2a2c33`, track transparent.
- Filter input: bg `#1a1c22` (raised-row token), border `1px solid #2a2c33` (focus: `#c8a15a`), radius `4px`, padding `6px 8px`, text 12px `#c4c7ce`, placeholder `#565a63`.
- Empty/no-matches hint: 11.5px, `#565a63`, centered both axes within the list area.
- **New-session modal** (styled like the `⌘K` palette panel, `Claude Terminal.dc.html` lines 253–254): backdrop `rgba(6,7,9,0.62)` covering the pane grid; panel bg `#191b21`, border `1px solid #34363f`, radius `8px`, box-shadow `0 30px 80px -20px rgba(0,0,0,0.85)`, width `480px` (narrower than the palette's `588px` — three fields vs. a command list); header row `padding:14px 16px`, bottom border `1px solid #24262d`, title `run new session` style at 14px `#d3d6dc`; body `padding:14px 16px` with three stacked fields, each: label 10px `#868a93` letter-spacing `0.08em`, control bg `#1a1c22`, border `1px solid #2a2c33` (focus `#c8a15a`), radius `4px`, height `32px`, text 12.5px `#c4c7ce`; error banner: bg `rgba(196,107,98,0.09)` (diff-delete tint), text `#c46b62`, 11px, radius `4px`, padding `8px 10px`; footer `padding:9px 16px`, top border `1px solid #24262d`, Cancel (plain, `#868a93`) / Create (accent-filled, bg `#c8a15a`, text `#191b21`, disabled state bg `#3a3d45` text `#6b7079`).
- **Context menu**: bg `#1a1c22`, border `1px solid #2a2c33`, radius `5px`, min-width `160px`, box-shadow `0 12px 30px -10px rgba(0,0,0,0.7)`; item padding `8px 10px`, text 12px `#c4c7ce`; item hover bg `#26282f` (palette-selected-row token); "Remove" in the confirm sub-state uses `#c46b62`; Cancel uses `#868a93`.
- Motion: dot pulse `1.4s ease-in-out infinite` (`0%,100% opacity:1; 50% opacity:0.35`) for `running` only. No enter/exit transition on the modal or context menu (instant show/hide), matching the mock's `sc-if`-driven palette toggle.

### Resize / responsive

The sidebar's column width (mock: `264px` of the `264px 1fr 336px` grid) is owned by `app-shell`'s layout grid, not this spec. Row content must degrade gracefully at any width the grid gives it: name and path always truncate with ellipsis rather than wrap (`white-space:nowrap`); the status line never wraps either; the header count and footer label do not shrink below their content width (the grid, not this pane, is responsible for a minimum column width). The row list scrolls vertically (`.scz`, `overflow:auto`) when it exceeds the pane's height; header and footer are fixed-height and never scroll. The new-session modal and context menu are fixed-width overlays and are unaffected by sidebar column width.

## 9. Acceptance criteria

- [ ] Sidebar hydrates from `francois:session:list` and renders rows in the returned order (FR-1).
- [ ] `'session.meta'` / `'session.status'` / `'session.removed'` on `francois:session:event` update the list live without a re-hydration (FR-2).
- [ ] Header shows `SESSIONS` and `N · [1]`, `N` = total cached sessions regardless of filter (FR-3).
- [ ] Each row shows dot, name, path (home-abbreviated when resolvable, else raw), and `"<status> · <model label>"` (FR-4).
- [ ] All four status colors and the `running`-only 1.4s pulse render exactly as specified (FR-5).
- [ ] Selected row shows `#20222a` bg, 2px `#c8a15a` left marker, and `#dfe2e8` name (FR-6).
- [ ] With no prior selection, the first hydrated session is auto-selected; an empty cache leaves selection unset and shows the empty state (FR-7).
- [ ] Clicking a row sets `activeSessionId` immediately and requests pane focus (FR-8).
- [ ] `↑`/`↓` move a keyboard cursor without changing `activeSessionId`; `⏎` commits it (FR-9, FR-10).
- [ ] Empty state renders `"no sessions yet · press n"` when there are zero sessions (FR-12).
- [ ] `/` opens the inline filter; typing narrows the list by name/path (case-insensitive substring); `Esc` clears and closes it (FR-13, FR-14, FR-16).
- [ ] Filtering to zero matches (non-empty cache) shows `"no matches · esc to clear"` (FR-15).
- [ ] Footer button and global `n` both open the new-session modal; a second trigger while open is a no-op (FR-18).
- [ ] New-session modal: directory via `francois:session:pickDirectory` only, name auto-fills from basename until user-edited, model list from `francois:session:models` (FR-19, FR-20).
- [ ] Create is disabled until directory, name, and model are all set (FR-21).
- [ ] Successful create closes the modal, upserts the session, and auto-selects it (FR-22).
- [ ] `SPAWN_FAILED`/`INVALID_INPUT` on create render inline in the modal without closing it or discarding form state (FR-23).
- [ ] Right-click opens a context menu with "Remove session"; confirming calls `francois:session:remove`; success removes the row and reassigns `activeSessionId` if it was the active session (FR-25, FR-26, FR-27, §7).

## Remediation

(Empty until a review returns findings.)
