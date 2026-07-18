---
id: skills-panel
title: Skills panel
status: frozen
created: 2026-07-18
updated: 2026-07-18
depends_on: [session-engine, app-shell]
---

# Skills panel

## 0. Amendment — real-discovery refactor (supersedes the "catalog" model below)

> This amendment reflects the shipped implementation and **supersedes** FR-3/FR-5/FR-6/FR-11/FR-12,
> §5's install semantics, §6, and any "catalog" wording elsewhere. It was ratified after review.

The panel reflects what Claude Code **actually** loads, not a static catalog:

- **Installed (✦)** = the union of real invocables the CLI has available for the session:
  SKILL.md skills **and** slash-command `*.md` files, discovered from **project**
  (`<cwd>/.claude/{skills,commands}`), **user** (`~/.claude/{skills,commands}`), and every
  **enabled plugin** (`~/.claude/settings.json` `enabledPlugins` → the plugin's `skills/` +
  `commands/` under `~/.claude/plugins/marketplaces/<mkt>/{plugins,external_plugins}/<plugin>/`).
  Dedupe by name, precedence **project > user > plugin**, and **skill > command** within a scope.
- **Available (◇)** = SKILL.md skills from marketplace plugins that are **not** enabled, sorted
  alpha after the installed rows, excluding names already installed.
- `SkillInfo` gains `scope` (`project|user|plugin`), `kind` (`skill|command`), and `pluginId`
  (`<plugin>@<marketplace>`). Rows show a scope badge; command rows show a `/` prefix + `cmd` badge.
- **Install = enable the owning plugin** (`skills_install` writes `enabledPlugins[pluginId] = true`
  in `~/.claude/settings.json`; global, applies on the next turn; **not** a per-project folder copy).
  It parses the existing settings safely (absent → start fresh; **present-but-unparseable → abort,
  never clobber**) and writes atomically (temp + rename). Errors: `SESSION_NOT_FOUND`, `SKILL_ERROR`.
  The confirm dialog discloses that enabling also turns on the plugin's **hooks and MCP servers**.
- `skills:list` no longer has a "catalog load failure" path (discovery never errors); it fails only
  with `SESSION_NOT_FOUND`. The empty state reads `no skills or commands found`.
- `skills:run` composes `/<name>` for an **installed** entry (guarded against non-installed names →
  `INVALID_INPUT`). Known limitation: namespaced plugin commands (`/<plugin>:<cmd>`) and nested
  command files are not yet resolved — user/project skills and top-level commands work.

## 1. Summary

The skills panel is the right-column pane `[5]` that lists the skills relevant to the active
session: the skills already installed into the session's project (discovered on disk) and, below
them, the skills from a curated catalog that are not yet installed. It lets the user inspect what
the session can do, install a catalog skill into the project with one action, and trigger a skill
run (`/‹name› ‹args›`) either directly from the panel or from the `⌘K` command palette's "Run
skill" entry.

## 2. Goals & non-goals

- **Goals**:
  - Discover the active session's installed skills from the project and user `.claude/skills`
    directories, and merge them with the not-yet-installed entries from a static catalog shipped
    with the app.
  - Render the merged list per the mock's SKILLS panel (`Claude Terminal.dc.html` lines 216–233):
    glyph, name, description, status label.
  - Let the user install an available (catalog) skill into the session's project, and run an
    installed skill, from the keyboard and the mouse, without leaving the pane.
  - Keep the list live: refresh automatically after an install and when the skills directories
    change on disk.
  - Expose the same run channel to the `⌘K` command palette's "Run skill" entry.
  - Handle the case where the catalog itself can't be read distinctly from "no skills yet".
- **Non-goals**:
  - Uninstalling/removing an installed skill — not in the mock, not specified here; would be a
    future addition to this same feature.
  - Editing a skill's `SKILL.md` or any catalog contents — read-only browsing + install only.
  - Managing the catalog (adding, removing, or remotely syncing catalog entries) — the catalog is
    a static JSON asset shipped with the app; catalog authoring lives outside this feature.
  - The command palette's own list/submenu rendering and navigation — owned by `command-palette`;
    this spec only guarantees the data and the `francois:skills:run` channel it calls.
  - Interpreting what a slash command does once sent — owned by `session-engine` / Claude Code.
  - Multi-session skill views — like the rest of the app (`PROJECT.md` §Open decisions), only the
    active session's skills are shown.

## 3. User stories / flows

**A — Panel loads with the active session**
1. A session becomes active (new session created, or user selects a different session in the
   sidebar).
2. The panel requests `francois:skills:list` for that session's id and shows a loading list
   (existing rows dim in place; on first load, an empty scroll area) until the result resolves.
3. On success, rows render installed skills first, then available skills, each group alpha-sorted.
   The header count updates (`N · [5]`).

**B — Run an installed skill, keyboard**
1. User presses `5` (or clicks the panel) to focus the skills pane; the panel gets the accent
   focus ring and accent title.
2. `↑`/`↓` move the row highlight (wraps not required; stops at ends).
3. User presses `⏎` on an installed row (glyph `✦`). A small run-skill modal opens: skill name in
   the header, an optional single-line arguments input, `⏎ run` / `esc cancel` hints.
4. User optionally types arguments, presses `⏎`. The modal calls `francois:skills:run` with
   `{ sessionId, name, args }`. On `ok: true` the modal closes and the message appears in the
   SESSION tab (owned by `conversation-view`/`session-engine`) as any other user message would.
   On `ok: false`, the modal stays open and shows the error message under the input.

**C — Run an installed skill, mouse**
1. User clicks an installed row while the panel is not focused: the click both focuses the panel,
   selects that row, and opens the run-skill modal (a click behaves like moving selection to that
   row with `↑`/`↓` and then pressing `⏎` — one click, not two).

**D — Install an available skill, keyboard**
1. `↑`/`↓` to an available row (glyph `◇`).
2. `⏎` opens the install-confirm modal: skill name + description, "Install" (default-selected) /
   "Cancel" options, `↑↓ choose` / `⏎ confirm` / `esc cancel` hints.
3. With "Install" selected, `⏎` calls `francois:skills:install` with `{ sessionId, name }`. While
   pending, the modal shows the "Install" row dimmed with no further input accepted. On success
   the modal closes; the panel re-fetches `skills:list` (also triggered by the `skills.changed`
   event, see FR-9) and the row now renders with `✦`/`installed`. On failure, the modal stays open
   and shows the error under the two options.

**E — Install an available skill, mouse**
1. Clicking an available row selects it and opens the install-confirm modal, same as `⏎` in D.

**F — Filter the list**
1. With the panel focused, `/` opens a one-line filter input at the top of the list (below the
   header, above the rows).
2. Typing filters rows (case-insensitive substring match against `name` and `description`);
   filtering does not re-order groups (installed still precedes available within the filtered
   set). Selection moves to the first visible row.
3. `esc` clears the filter text and closes the filter input, restoring the full list and the
   selection to index 0. Filtering never re-fetches from the Rust core — it operates on the
   last successful `skills:list` result held in the frontend.

**G — Run a skill from the command palette**
1. User opens `⌘K`, selects "Run skill". The palette (owned by `command-palette`) shows a
   secondary list of the active session's *installed* skills only (it re-uses the same
   `skills:list` data, filtered to `installed: true`).
2. Selecting one and pressing `⏎` in the palette invokes `francois:skills:run` with
   `{ sessionId, name }` (no `args` — the palette path does not prompt for arguments). The palette
   closes; the message appears in the SESSION tab exactly as in flow B.

**H — Catalog unavailable**
1. `skills:list` resolves `{ ok: false, error: { code: 'SKILL_ERROR', ... } }` (see FR-11).
2. The panel renders a single dim, error-colored row with the error message instead of the normal
   list. Pressing `⏎` on that row (it is always index 0 and always selected in this state) retries
   `skills:list`.

## 4. Functional requirements

1. **FR-1** — On session focus/switch (active `sessionId` changes) and on panel mount, the
   frontend invokes `francois:skills:list` with `{ sessionId }` and replaces its held list on
   response; filter text and selection reset to defaults on session switch.
2. **FR-2** — `skills:list`'s data, on success, is ordered: all entries with `installed: true`
   first, then all entries with `installed: false`; within each group, entries are sorted by
   `name` ascending, case-insensitive (`localeCompare` with `sensitivity: 'base'`).
3. **FR-3** — Installed skills are discovered by scanning, for the session's `cwd`:
   `<cwd>/.claude/skills/*/SKILL.md` (project skills) and `<home>/.claude/skills/*/SKILL.md` (user
   skills), where `<home>` is the OS user home directory. Every immediate subdirectory that
   contains a `SKILL.md` file becomes one `SkillInfo` with `installed: true`; `name` is that
   subdirectory's basename. If the same name exists in both the project and the user directory,
   the project entry wins (its `SKILL.md` is the one parsed; it is the entry listed).
4. **FR-4** — `description` for an installed skill is parsed from `SKILL.md`'s YAML frontmatter
   `description` field: take the text up to (not including) the first `.`, `!`, or `?` that is
   followed by whitespace or end-of-string; trim surrounding whitespace; if the result is longer
   than 100 characters, hard-truncate to 100 and append `…`. If the frontmatter is missing, is not
   valid YAML, or has no `description` field, `description` is `''`.
5. **FR-5** — Available skills are the entries of the app's static skill catalog (see §6) whose
   `name` is not present among that session's installed names (FR-3); each becomes a `SkillInfo`
   with `installed: false` and `description` taken verbatim from the catalog entry (already
   one-line; no truncation applied by the app).
6. **FR-6** — `francois:skills:install` copies the catalog skill's folder recursively into
   `<cwd>/.claude/skills/<name>/` for the given session (creating `.claude/skills/` if it does not
   exist). `name` not present in the catalog → `SKILL_ERROR`. Any filesystem failure while
   creating directories or copying files → `SKILL_ERROR` with the underlying error in `detail`. If
   `<cwd>/.claude/skills/<name>/` already exists, install is a no-op success (idempotent — does
   not overwrite).
7. **FR-7** — On a successful `skills:install`, and whenever the Rust core's filesystem watcher
   observes a change under `<cwd>/.claude/skills/` or `<home>/.claude/skills/` for a session that
   has been listed at least once, the Rust core emits `francois:skills:event` with
   `{ type: 'skills.changed', sessionId }` for the affected session. The frontend, on receiving
   this event for the currently active session, re-invokes `skills:list`.
8. **FR-8** — `francois:skills:run` composes the text `` /<name> `` when `args` is absent, empty,
   or all-whitespace, otherwise `` /<name> <args> `` with `args` trimmed of leading/trailing
   whitespace and inserted verbatim (a single leading space, no further escaping). It delegates
   in-process to session-engine's send-user-message capability for that session (not a second
   frontend round-trip); whatever error that capability raises is passed through unchanged in
   addition to the errors below.
9. **FR-9** — `francois:skills:run` returns `INVALID_INPUT` (before delegating to session-engine)
   when `name` does not correspond to a currently *installed* skill for that session — i.e.
   running an available (not-installed) skill is rejected; the client must install it first.
10. **FR-10** — `francois:skills:run` and `francois:skills:install` and `francois:skills:list`
    each return `SESSION_NOT_FOUND` when `sessionId` does not match a known session.
11. **FR-11** — `francois:skills:list` returns `{ ok: false, error: { code: 'SKILL_ERROR', ... } }`
    when the static catalog cannot be loaded (missing file, unparseable JSON) — this is a total
    failure of the call (installed skills are not returned partially); it is distinct from the
    empty-list success case in FR-12.
12. **FR-12** — When `skills:list` succeeds and both the installed and available groups are empty,
    the panel renders the neutral empty state, not an error.
13. **FR-13** — The pane header right-hand label shows `N · [5]` where `N` is
    `installed.length + available.length` from the last successful `skills:list` response
    (unaffected by the `/` filter — filtering narrows the visible rows, not the count).
14. **FR-14** — Keyboard, panel focused: `↑`/`↓` move row selection by one (clamped, no wrap);
    `⏎` on a selected installed row opens the run-skill modal (flow B); `⏎` on a selected available
    row opens the install-confirm modal (flow D); `/` opens the filter input (flow F); typing in
    the filter input does not move panel selection until `esc` or the input loses focus.
15. **FR-15** — Mouse: clicking any row focuses the panel, selects that row, and performs the same
    action as `⏎` on that row (flows C, E) — one click, not select-then-click-again.
16. **FR-16** — The command palette's "Run skill" entry sources its secondary list from the same
    in-memory `skills:list` result held for the active session, filtered to `installed: true`;
    selecting an entry there calls `francois:skills:run` with `args` omitted (flow G).

## 5. API contract

Domain: `skills`. All frontend→core calls resolve `Result<T>` (`Result` from `contract/common.ts`,
never throws). Content below is the exact, complete content of `contract/skills-panel.ts`.

| Channel | Direction | Payload | `Result<T>` data | Error codes |
|---|---|---|---|---|
| `francois:skills:list` | frontend → core (invoke) | `SkillsListRequest` | `SkillInfo[]` | `SESSION_NOT_FOUND`, `SKILL_ERROR` |
| `francois:skills:install` | frontend → core (invoke) | `SkillsInstallRequest` | `void` | `SESSION_NOT_FOUND`, `SKILL_ERROR` |
| `francois:skills:run` | frontend → core (invoke) | `SkillsRunRequest` | `void` | `SESSION_NOT_FOUND`, `INVALID_INPUT`, plus any error code session-engine's send returns, passed through |
| `francois:skills:event` | core → frontend (event) | — | `SkillsEvent` | n/a (not a `Result`) |

```ts
// contract/skills-panel.ts — IPC contract for the skills panel (pane [5]).
// Imports shared vocabulary from contract/common.ts; never redefines it.

import type { Result, SessionId, SkillInfo } from './common';

// ---------- francois:skills:list ----------
// frontend -> core (invoke). Returns installed skills first, then available skills, each
// group sorted alphabetically by name (case-insensitive). See FR-1..FR-5, FR-11, FR-12.
export interface SkillsListRequest {
  sessionId: SessionId;
}
export type SkillsListResult = Result<SkillInfo[]>;

// ---------- francois:skills:install ----------
// frontend -> core (invoke). Copies the named catalog skill into the session project's
// `.claude/skills/<name>/`. See FR-6.
export interface SkillsInstallRequest {
  sessionId: SessionId;
  name: string; // catalog skill name
}
export type SkillsInstallResult = Result<void>;

// ---------- francois:skills:run ----------
// frontend -> core (invoke). Sends `/<name> <args>` as a user message to the session by
// delegating to session-engine's send. `name` must already be installed. See FR-8, FR-9.
export interface SkillsRunRequest {
  sessionId: SessionId;
  name: string; // installed skill name
  args?: string; // optional free-text arguments, appended after the slash command
}
export type SkillsRunResult = Result<void>;

// ---------- francois:skills:event ----------
// core -> frontend (event), one channel for the domain, tagged union with a `type`
// discriminator (same pattern as SessionEvent in contract/common.ts). See FR-7.
export type SkillsEvent =
  | { type: 'skills.changed'; sessionId: SessionId };
```

## 6. Data & state

**Rust core**
- No persistent database. The source of truth is the filesystem (`SKILL.md` files) plus the
  static catalog asset shipped with the app (e.g. `resources/skills-catalog.json` +
  `resources/skills-catalog/<name>/` folders — exact packaging path is a build detail, not
  IPC-facing). Catalog entry shape (internal, not part of this contract):
  ```ts
  interface SkillCatalogEntry {
    name: string;
    description: string; // already one-line; used verbatim as SkillInfo.description
  }
  ```
- `skills:list` computes the result on every call by re-scanning the project and user skills
  directories and re-reading the catalog; the Rust core does not need to cache installed
  state across calls, only the catalog file itself may be cached in memory after first
  successful parse (invalidated by `SKILL_ERROR` — a later call retries the read from disk).
- For each session that has been listed at least once, the Rust core keeps a filesystem
  watcher on `<cwd>/.claude/skills/` (project) and one shared watcher on `<home>/.claude/skills/`
  (user, process-wide, not per-session) to emit `skills.changed` (FR-7). Watcher setup failure
  (e.g. directory does not exist yet) degrades silently — the panel still gets correct data on
  every explicit `skills:list` call; it just won't auto-refresh on out-of-band disk edits until a
  future call re-establishes the watch (e.g. the directory is created by `skills:install`, which
  always re-establishes the watch on that project's `.claude/skills/` after copying).

**Frontend** (zustand slice owned by this feature)
- `skills: SkillInfo[]` — last successful result for the active session.
- `status: 'idle' | 'loading' | 'error'` and `error?: AppError` — reflects the in-flight/failed
  state of the last `skills:list` call (FR-11/FR-12/flow H).
- `selectedIndex: number` — index into the *filtered, ordered* row list currently rendered.
- `filter: { open: boolean; query: string }`.
- `runModal: { open: boolean; name: string; args: string; pending: boolean; error?: string } | null`.
- `installModal: { open: boolean; name: string; choice: 'install' | 'cancel'; pending: boolean; error?: string } | null`.
- A monotonically increasing request token per `skills:list` call; responses for a stale token
  (session switched again before the previous call resolved) are discarded, never applied to
  state. Every request-firing action (session switch, `skills.changed` event for the active
  session, manual retry from the error row) issues a new token.
- Subscribes to `francois:skills:event`; on `skills.changed` where `sessionId` matches the
  currently active session, re-invokes `skills:list` (does not blindly trust the event to carry
  the new data — always refetches).

## 7. Edge cases & errors

- **No `.claude/skills` directories at all** (fresh project, fresh machine): `installed` is `[]`;
  `available` is the full catalog (assuming it loads); not an error (FR-12).
- **`SKILL.md` present but frontmatter missing/unparseable/no `description`**: skill is still
  listed (FR-3); `description` is `''` — the row renders with an empty description line (still
  10px, same color, just no text; does not collapse the row height).
- **`SKILL.md` unreadable** (permission error, symlink loop, etc.): that one skill directory is
  skipped; it does not fail the whole `skills:list` call.
- **Same skill name in both project and user directories**: project entry wins (FR-3); the user
  one is not listed separately and is not shown as a second, duplicate row.
- **Catalog file missing or unparseable at `skills:list` time**: whole call fails with
  `SKILL_ERROR`; UI shows the dim error row (flow H), not the neutral empty state — even if
  `installed` would otherwise have been non-empty, since the call itself failed.
- **`skills:install` with an unknown catalog `name`**: `SKILL_ERROR`, message names the unknown
  skill; the install-confirm modal stays open and shows the message under the two options.
- **`skills:install` write failure** (disk full, permission denied, path too long, …):
  `SKILL_ERROR` with `detail` set to the underlying OS error; modal stays open with the message.
- **`skills:install` when the target folder already exists**: succeeds as a no-op (FR-6); the
  panel still re-fetches and shows the row as `installed` (it already was, from the discovery
  scan's point of view, once the copy — or no-op — completes).
- **`skills:run` with unknown `sessionId`**: `SESSION_NOT_FOUND`; the run modal, if open, shows
  the message under the input (this should not normally be reachable from the panel itself, since
  the panel only exists for an active, known session — it is reachable from a stale palette
  entry).
- **`skills:run` on a skill that is not (or no longer) installed**: `INVALID_INPUT` — e.g. the
  row was installed when the panel last fetched but was removed from disk out-of-band since; the
  modal shows the message and does not send anything to the session.
- **`skills:run`'s delegated send fails** (e.g. session-engine returns `SESSION_NOT_RUNNING`): the
  error is passed through unchanged (FR-8); the run modal shows that message under the input.
- **Empty `args` after trim**: sends `/<name>` with no trailing space (FR-8), not `/<name> `.
- **Filter matches nothing**: rows area shows a single dim row, `no skills match "<query>"`, no
  glyph column; `⏎`/click on it does nothing.
- **Very long name or description**: no server-side truncation for `name`; `description` is
  capped per FR-4 for installed skills and used verbatim (already short) for catalog entries;
  visual overflow beyond that is handled by CSS ellipsis (§8), never wraps to a second line.
- **Rapid session switching**: stale `skills:list` responses are discarded via the request token
  (see §6); the panel never flashes a previous session's skills onto the newly active session.

## 8. Design brief

### Screens / regions
Right column, third card, `Claude Terminal.dc.html` lines 216–233 (`SKILLS` section, `skillData`
at lines 371–385). Sits below `AGENTS` (`flex:1.3`) and `MCP SERVERS` (`flex:0.95`) in the same
`flex-direction:column` right-column container (line 176); this panel is `flex:1.05`. Two overlay
regions belong to this feature and paint above the whole 1360×864 window, like the command
palette overlay (lines 251–276): the run-skill modal and the install-confirm modal.

### Components

**Panel chrome** (unchanged from mock)
- `<section>`: `background:#16171c; border:1px solid <ring>; border-radius:5px; overflow:hidden`,
  `<ring>` = `#c8a15a` when the skills pane is the focused pane, else `#2a2c33`.
- Header row: `padding:9px 12px; border-bottom:1px solid #24262d; display:flex;
  align-items:center; justify-content:space-between`.
  - Title `SKILLS`: `font-size:11px; letter-spacing:0.14em; font-weight:700`, color `#c8a15a`
    when focused else `#868a93`.
  - Count `N · [5]`: `font-size:10px; color:#565a63`.
- List container: `flex:1; overflow:auto; padding:6px 8px` with the `.scz` scrollbar treatment
  (`8px` thin, thumb `#2a2c33`, track transparent).

**Skill row** (default, from mock lines 222–231)
- `display:flex; align-items:center; gap:9px; padding:8px 6px; border-bottom:1px solid #1d1f25`.
- Glyph column: `width:14px; text-align:center; font-size:11px; flex-shrink:0`; `✦` in `#c8a15a`
  for installed rows, `◇` in `#565a63` for available rows.
- Name + description column: `min-width:0; flex:1`.
  - Name: `font-size:12px; color:#c4c7ce`.
  - Description: `font-size:10px; color:#565a63; white-space:nowrap; overflow:hidden;
    text-overflow:ellipsis; margin-top:1px` (empty string renders as a blank line at the same
    height, no collapse).
- Status label: `font-size:9.5px; letter-spacing:0.04em; flex-shrink:0`; `installed` in `#7fa07a`,
  `available` in `#565a63`.
- No pulse/blink on this row in any state — skills are static, unlike agent/MCP dots.

**Skill row — hover** (new, not in the mock's static frame; cursor over any row, panel need not
be focused)
- `background:#1a1c22; cursor:pointer`. All text/glyph colors unchanged.

**Skill row — selected** (new; the keyboard-navigable row while the panel is focused, or the
row a mouse click landed on)
- `background:#20222a; border-left:2px solid #c8a15a` (reuses the sidebar's selected-row tokens,
  `Claude Terminal.dc.html` line 57), row padding-left reduced by `2px` to absorb the border so
  content does not shift. Name color brightens to `#dfe2e8`; glyph and status colors unchanged.
- Selected + hover (mouse over the already-selected row): same as selected, no extra treatment.

**Filter input** (new; appears only while `filter.open`)
- Inserted at the top of the list container, above the first row: `display:flex;
  align-items:center; gap:8px; padding:6px 8px; border-bottom:1px solid #24262d; margin:-6px -8px 6px`
  (bleeds to the container edges, matching the header's horizontal padding).
- Prompt glyph `/`: `font-size:12px; color:#c8a15a`.
- Text: typed value `font-size:11.5px; color:#d3d6dc`; placeholder `filter skills…` in `#565a63`
  when empty; trailing blinking block cursor `width:7px; height:13px; background:#c8a15a;
  animation:blink 1s step-end infinite` (same keyframe as the rest of the app).
- Right-aligned hint: `esc clear`, `font-size:9px; color:#3a3d45`.

**Empty state** (FR-12; renders in place of the row list, replacing the `.scz` container's
contents)
- `padding:24px 12px; text-align:center; font-size:11px; color:#565a63`: `no skills found ·
  browse the catalog`.

**Error row** (FR-11, flow H; renders in place of the row list; occupies index 0, always
selected)
- Single row, same row grid as a skill row but glyph column shows `⚠` in `#c46b62` (error token)
  instead of `✦`/`◇`; name column shows the `AppError.message` in `#c46b62`, `font-size:11px`, no
  description line; no status label. `background:#20222a; border-left:2px solid #c46b62` while
  selected (it is always selected — it is the only interactive row).

**Run-skill modal** (flow B; palette-panel styling, `Claude Terminal.dc.html` lines 253–276)
- Overlay: `position:absolute; inset:0; background:rgba(6,7,9,0.62); display:flex;
  align-items:center; justify-content:center` — centered (not top-aligned like the command
  palette, since this modal is short and unrelated to a scrolling list). Clicking the overlay
  (outside the modal box) cancels, same as the palette's backdrop click.
- Box: `width:380px; background:#191b21; border:1px solid #34363f; border-radius:8px;
  overflow:hidden; box-shadow:0 30px 80px -20px rgba(0,0,0,0.85)`.
- Header row: `padding:14px 16px; border-bottom:1px solid #24262d; display:flex;
  align-items:center; gap:10px`. Glyph `✦` in `#c8a15a`, `font-size:13px`. Title `Run <name>`,
  `font-size:14px; color:#d3d6dc`. Right-aligned `esc`, `font-size:10px; color:#565a63`.
- Body row: `padding:12px 16px; display:flex; align-items:center; gap:11px`. Prompt `›` in
  `#c8a15a; font-size:13px`. Input, `flex:1`: typed text `font-size:12.5px; color:#d3d6dc`;
  placeholder `arguments (optional)` in `#565a63`; trailing blinking cursor identical to the
  filter input's, `height:15px` to match the palette's own input cursor sizing (line 257).
- Error line (only when `runModal.error` is set): `padding:0 16px 10px; font-size:10.5px;
  color:#c46b62`.
- Footer hint row: `display:flex; gap:16px; padding:9px 16px; border-top:1px solid #24262d;
  font-size:10px; color:#565a63`: `<span style="color:#868a93;">⏎</span> run`,
  `<span style="color:#868a93;">esc</span> cancel` (same hint styling as the palette footer,
  lines 269–273).
- Pending state (call in flight): input becomes non-editable, footer `⏎ run` hint dims to
  `#3a3d45`.

**Install-confirm modal** (flow D; same palette-panel chrome as the run-skill modal)
- Overlay: identical to the run-skill modal's.
- Box: `width:360px`, same background/border/radius/shadow as the run-skill modal.
- Header row: `padding:14px 16px; border-bottom:1px solid #24262d`. Glyph `◇` in `#565a63`,
  `font-size:13px`, title `Install <name>?` `font-size:14px; color:#d3d6dc`. Below the title, the
  skill's `description`: `font-size:11px; color:#868a93; margin-top:3px`.
- Option list: `padding:6px`, two rows styled like command-palette command rows (lines 262–266):
  `display:flex; align-items:center; gap:12px; padding:10px 12px; border-radius:5px`.
  - Selected option: `background:#26282f`; label `#dfe2e8`; glyph `＋` (Install) / `⊗` (Cancel) in
    `#c8a15a`.
  - Unselected option: `background:transparent`; label `#c4c7ce`; glyph in `#565a63`.
  - Default selection on open: `Install`.
- Error line (only when `installModal.error` is set): `padding:0 16px 10px; font-size:10.5px;
  color:#c46b62`.
- Footer hint row: same tokens as the run-skill modal's, three hints: `↑↓ choose`, `⏎ confirm`,
  `esc cancel`.
- Pending state: both option rows dim (`opacity:0.5`), no further keyboard/mouse input accepted
  until the call resolves.

### States
Row: default · hover · selected · selected+error (error row only). Panel: loading (first fetch
after session switch — no distinct skeleton required, previous session's rows are already cleared
by then; brief flash is acceptable) · loaded-with-rows · loaded-empty (FR-12) · loaded-error
(FR-11). Filter: closed · open-empty (placeholder showing) · open-typed · open-no-matches. Run
modal: closed · open-empty-args · open-typed-args · pending · error. Install modal: closed ·
open-install-selected · open-cancel-selected · pending · error.

### Interactions
- `1`–`5`/click focus panes app-wide (owned by `app-shell`); `5` or a click on this panel's chrome
  focuses it.
- `↑`/`↓`: move `selectedIndex` by one row within the currently rendered (filtered) list; clamps
  at the first/last row, does not wrap.
- `⏎` / click on a row: installed → open run-skill modal; available → open install-confirm modal;
  error row → retry `skills:list`; a row in the "no matches" filter state → no-op.
- `/`: opens the filter input and moves keyboard focus into it; further character keys type into
  the filter, not into row navigation, until `esc`.
- `esc` inside the filter input: clears text, closes the input, restores full list, resets
  selection to row 0.
- Inside the run-skill modal: typing edits `args`; `⏎` submits (`skills:run`); `esc` or backdrop
  click closes without sending.
- Inside the install-confirm modal: `↑`/`↓` toggle between the two options; `⏎` confirms the
  selected option (`skills:install` if `Install`, close if `Cancel`); `esc` or backdrop click
  closes without installing.
- Both modals trap `↑`/`↓`/`⏎`/`esc` while open — the panel's own row navigation does not react to
  those keys until the modal closes.

### Visual notes
Typography: JetBrains Mono throughout (400 body / 500 name-emphasis / 700 section titles), sizes
as listed per component above. Colors used, all from `PROJECT.md` §Visual design system and the
mock: panel surface `#16171c`; borders `#24262d` (chrome), `#1d1f25` (row separators), `#2a2c33`
(unfocused ring), `#34363f` (modal border); accent `#c8a15a`; text primary `#c4c7ce`, bright
`#dfe2e8`, dim `#868a93`, faint `#565a63`; status ok/installed `#7fa07a`; status error `#c46b62`.
Radii: `5px` panel, `8px` modal, `4px`/`5px` rows. Motion: `blink 1s step-end infinite` for text
cursors (filter input, run-modal input) — no `pulse` animation anywhere in this feature (skills
have no running/connecting state to animate).

### Resize / responsive
The right column is a fixed `336px` (mock line 47, `grid-template-columns:264px 1fr 336px`); this
panel does not resize horizontally with the window in v1 — only the center pane does. Vertically,
the panel is a flex item (`flex:1.05`) alongside `AGENTS`/`MCP SERVERS`, so its available row-list
height changes with window height; overflow scrolls via `.scz`. Row content never wraps: name is
single-line, description ellipsizes (`text-overflow:ellipsis`), status label never shrinks (it is
`flex-shrink:0`) and is the last thing to be pushed off before the description gives way. Modals
are fixed-width and centered regardless of panel size; they do not resize with the window beyond
staying centered.

## 9. Acceptance criteria

- [ ] Selecting a session populates the panel from `francois:skills:list` for that session's id,
      installed rows before available rows, each group alphabetical (FR-1, FR-2).
- [ ] A directory under the project's `.claude/skills/` with a `SKILL.md` appears as an installed
      row named after the directory; the same under the user's `~/.claude/skills/` also appears,
      and a name collision resolves to the project's copy (FR-3).
- [ ] An installed skill's description is the first sentence of `SKILL.md`'s frontmatter
      `description`, capped at 100 characters with `…`; missing/invalid frontmatter yields an
      empty description without failing the row (FR-4, edge cases).
- [ ] Catalog entries not already installed for the session appear as available rows with `◇` and
      the catalog's description verbatim (FR-5).
- [ ] `francois:skills:install` copies the named catalog folder into
      `<cwd>/.claude/skills/<name>/`, is a no-op if that folder already exists, and returns
      `SKILL_ERROR` for an unknown name or a write failure (FR-6).
- [ ] After a successful install, a `skills.changed` event fires and the panel's next
      `skills:list` shows the skill as installed (FR-7).
- [ ] A filesystem change under either skills directory for a previously-listed session fires
      `skills.changed` for that session (FR-7).
- [ ] `francois:skills:run` sends `/<name>` when `args` is empty/whitespace-only, or
      `/<name> <trimmed args>` otherwise, by delegating in-process to session-engine's send
      (FR-8).
- [ ] `francois:skills:run` on a skill that is not installed for the session returns
      `INVALID_INPUT` and sends nothing (FR-9).
- [ ] `skills:list`/`skills:install`/`skills:run` all return `SESSION_NOT_FOUND` for an unknown
      `sessionId` (FR-10).
- [ ] A catalog load failure makes `skills:list` resolve `SKILL_ERROR` in full (no partial
      installed-only result), rendered as the dim error row, not the empty state (FR-11).
- [ ] An installed-and-available count of zero with a successful catalog load renders the
      `no skills found · browse the catalog` empty state, not an error (FR-12).
- [ ] The header count `N · [5]` reflects total installed+available from the last successful
      response, unchanged while filtering (FR-13).
- [ ] With the panel focused, `↑`/`↓` move selection, `⏎` opens the run modal for an installed row
      and the install-confirm modal for an available row, `/` opens the filter, and a click on any
      row performs the same action as `⏎` on that row (FR-14, FR-15).
- [ ] The command palette's "Run skill" list is sourced from the same installed-only data and
      calls `francois:skills:run` with `args` omitted (FR-16).
- [ ] Rapid session switching never renders a previous session's skills against the new session's
      header count or rows (§6 request-token discard, edge cases).

## Remediation

(Empty until a review returns findings.)
