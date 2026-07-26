---
id: projects
title: Projects — configured workspaces
status: shipped
created: 2026-07-25
depends_on: [session-engine, sessions-sidebar, fleet-board, command-palette, durable-sessions, app-shell]
design_files:
  - https://claude.ai/design/p/bbe7b653-3cdc-4772-a79d-ec08c546db22?file=Claude+Terminal.dc.html
design_project: bbe7b653-3cdc-4772-a79d-ec08c546db22
---

# Projects — configured workspaces

> **needs new domain: `project`** — PIPELINE.md §Conventions currently lists
> `app · session · conversation · diff · shell · agents · mcp · skills · palette · cli`.
> This feature adds `project` (channels `francois:project:*` → commands `project_*`).
> Add it to the Domains line at `/build` time.
>
> No new surface: `src/features/projects/` (frontend) and `src-tauri/src/project/` (core)
> both live inside existing surfaces.

## 1. Summary

Today a Francois session is configured entirely from scratch: the new-session modal asks
for a directory, a model, an effort, a permission mode, a runtime, and an allow-git flag,
every single time — and nothing remembers that "the francois repo is always Opus 5 /
acceptEdits / native / allow-git". There is no entity above the session. This feature
introduces the **project**: a named, persisted workspace rooted at a directory, owning
(a) a set of **session defaults** that pre-fill the new-session modal, and (b) a set of
**coding standards & rules** that Francois writes into that repo's own `CLAUDE.md`, inside
a delimited managed block, so plain `claude` runs and teammates pick them up natively via
git.

The registry lives in Francois's app data dir (`projects.json`, next to `sessions.json`);
the standards live in the repo. Sessions gain an optional `projectId`; the project chosen
at creation **contributes its root as the session's `cwd`**. Pane `[1]` gets a compact project
switcher above the fleet board that filters the board to one project; all editing happens
in a **Projects modal** (⌘K → "Manage projects"), styled after `permission-guardrails`'
rules editor.

Defaults are a **snapshot at creation**: they pre-fill the modal and are then copied onto
the session, which owns them forever after. Standards are **live** — `claude` re-reads
`CLAUDE.md` every turn, so editing them affects running sessions immediately with no
Francois machinery at all.

## 2. Goals & non-goals

- **Goals**:
  - A persisted **project registry** (`projects.json` in the app data dir): create, list,
    update, remove. Each project = id, name, absolute root, session defaults, timestamps.
  - **Session defaults** per project (`modelId`, `effort`, `permissionMode`, `runtime`,
    `allowGit`) that pre-fill the new-session modal — every field still overridable.
  - **Standards & coding rules** edited in Francois, written to `<root>/CLAUDE.md` inside a
    `<!-- francois:standards:start -->` / `:end` managed block, never touching a byte
    outside it.
  - `SessionMeta.projectId` (optional): choosing a project in the new-session modal links
    the session, supplies its working directory, and pre-fills its defaults (FR-21).
  - A **project switcher** at the top of pane `[1]` that filters the fleet board to one
    project (or `All`), composing with fleet-board's existing `/` name/path filter.
  - A **Projects modal** (⌘K → "Manage projects") owning all project CRUD + config +
    standards editing.
  - Full backward compatibility: sessions without a `projectId` — including every session
    already persisted by `durable-sessions` — keep working unchanged.
- **Non-goals**:
  - **The agent fleet** — a project's roster of named agents (per-agent model, rules,
    allowed tools, `.claude/agents/*.md` authoring) and the one-action bulk launch of a
    session per roster entry. Deferred to a dependent spec, **`specs/project-fleet.md`**,
    written after this ships.
  - **Permission rules.** Those stay per-session/per-tier in `permission-guardrails`
    (`.claude/settings.json`); a project does not own or override them.
  - **MCP servers and skills.** `mcp-panel` / `skills-panel` keep reading `<cwd>/.mcp.json`
    and `<cwd>/.claude/{skills,commands}` as today.
  - **Live inheritance.** Editing a project's defaults never mutates an existing session
    (decided: snapshot at creation).
  - **Watching `CLAUDE.md` for external edits.** Read-on-open only, same as the
    permissions editor (`permission-guardrails` §2).
  - **Preserving hand-written content *inside* the managed block** in a shape Francois does
    not emit (see §7, case 9). Content outside the markers is always preserved.
  - Project templates, cloning, import/export, cross-device sync, per-project env vars,
    per-project git remotes or worktrees.
  - Migrating existing sessions into projects retroactively (no backfill pass; linking
    happens only at creation — see FR-19).
  - Starting a session in a SUBDIRECTORY of a project while staying linked to it — the
    project contributes its root verbatim (FR-21 amendment).

## 3. User stories / flows

1. **Create a project.** User presses `⌘K` → types `proj` → `Manage projects` → the modal
   opens with an empty list and an inline empty state. Clicks `+ New project` → a native
   directory dialog opens (`francois:session:pickDirectory`, already shipped). User picks
   `D:\francois` → a project row appears named `francois` (basename of the root), selected,
   with its config form on the right and all defaults unset ("inherit").
2. **Set defaults.** In the config form the user sets model `Opus 5`, effort `high`,
   permission mode `acceptEdits`, runtime `native`, and toggles `allow git` on. Each change
   saves immediately (no Save button); the row's subtitle updates.
3. **Write standards.** User scrolls to `Standards` and types three rules:
   `No source file over 1000 lines`, `Tests before implementation`,
   `Group by feature, never by technical kind` — pressing `⏎` in the input commits each as
   a bullet. A footer reads `→ D:\francois\CLAUDE.md · francois block`. The core
   read-modify-writes `CLAUDE.md`, inserting the managed block at the end; the hand-written
   contents above it are byte-identical afterwards.
4. **Inherit on a new session.** With the board scoped to `francois`, the user presses `Esc`
   then `n`. The modal opens with `project` already reading `francois` (FR-30), a dim
   `runs in D:\francois` line **instead of a directory picker**, the name pre-filled to
   `francois`, and model / effort / permission-mode / runtime / allow-git all arriving from
   the project's defaults. The user changes only the name to `core` and presses `⏎`. The
   session is created with `projectId` set; its own model/effort/etc. are now its own.
5. **Override at creation.** Same flow, but the user switches the model to `Haiku 4.5`
   before submitting. The session is created with `Haiku 4.5`; the project's default is
   untouched.
6. **Opt out.** In the new-session modal the user sets the project field to `— none —`.
   The session is created with no `projectId` and no pre-fill (the fields revert to the
   pre-feature defaults). Nothing else changes.
7. **Filter the board.** Pane `[1]` shows `▾ All projects` above the cards. The user clicks
   it → a dropdown lists `All projects`, `francois`, `survey-engine`, a separator, and
   `Manage projects…`. They pick `francois` → the board now shows only that project's
   sessions; the strip reads `▾ francois` and the pane header count reflects the filtered
   list. Typing `/core` narrows further (both filters apply).
8. **Edit standards mid-flight.** With a session running, the user opens the modal, adds a
   rule, and closes. The next turn's `claude` process reads the updated `CLAUDE.md` on its
   own — Francois emits nothing and restarts nothing.
9. **Remove a project.** User right-clicks a row (or clicks its `remove` control) → an
   inline confirm reads `remove project "francois"? sessions are kept; CLAUDE.md is not
   touched`. Confirming deletes the registry entry, clears `projectId` on its sessions
   (they remain, unlinked), and leaves every file on disk exactly as it was.
10. **Missing root.** The user renames the folder outside Francois. On the next modal open
    the row shows a dim `root missing` tag and its config form is read-only except for
    the root input and `Remove`. The switcher still lists it; creating a session under it
    is blocked with an inline message.

## 4. Functional requirements

### Registry & persistence

- **FR-1**: The core owns a project registry persisted at `<app_data_dir>/projects.json`,
  written **atomically** (temp file + rename) via the same helper `permission-guardrails`
  uses (`write_json_atomic`, `src-tauri/src/permissions/rules.rs`). Shape:
  `{ "version": 1, "projects": [ … ] }`, one entry per project holding exactly
  `id`, `name`, `root`, `defaults`, `createdAt`, `lastUsedAt`.
- **FR-2**: `rootExists` (§5 `ProjectMeta`) is **never persisted**. It is computed at
  `project_list` time by stat-ing `root` and is `false` when the path is absent or is not a
  directory.
- **FR-3**: A missing, empty, or unparseable `projects.json` yields an empty registry and is
  **not** an error — the app starts normally and the first write recreates the file. A
  registry entry that fails to deserialize is skipped, not fatal.
- **FR-4**: `id` is a uuid-v4 string minted by the core. `createdAt` and `lastUsedAt` are
  epoch ms. `lastUsedAt` is set on creation and refreshed whenever a session is created
  with that `projectId` (FR-20) — nothing else touches it.

### Project CRUD

- **FR-5**: `project_list` returns every project ordered by `lastUsedAt` **descending**,
  ties broken by `name` ascending (case-insensitive). It never fails for registry reasons
  (FR-3).
- **FR-6**: `project_create(root, name?, defaults?)` validates, in this order:
  1. `root` is a non-empty absolute path that exists and is a directory → else
     `INVALID_INPUT` (`"project root does not exist or is not a directory"`);
  2. no existing project has an equal normalized root (FR-8) → else
     `PROJECT_DUPLICATE_ROOT` (`"another project already owns that directory"`).
  `name` defaults to the basename of `root`; a supplied name is trimmed and must be
  non-empty and ≤ 80 chars → else `INVALID_INPUT`. Names are **not** unique. `defaults`
  omitted ⇒ all fields unset. On success the entry is appended, persisted, and returned.
- **FR-7**: `project_update(projectId, name?, root?, defaults?)` patches only the fields
  present in the payload. `defaults`, when present, **replaces the whole object** (an unset
  field is expressed by omitting it from `defaults`, which is how "inherit" is cleared).
  Unknown `projectId` → `PROJECT_NOT_FOUND`. A new `root` re-runs FR-6's validation
  (duplicate check excludes the project itself). Changing `root` does **not** re-link,
  unlink, or move any session. Returns the updated `ProjectMeta`.
- **FR-8**: **Root normalization** (used for storage, duplicate detection, and containment):
  the path is made absolute, `.`/`..` segments resolved, symlinks left as-is, trailing
  separators stripped, and separators normalized to the platform's. Comparison is
  **case-insensitive on Windows and case-sensitive elsewhere**, and always
  **component-wise** — `D:\a\bc` is not inside `D:\a\b`. The stored `root` is the
  normalized form.
- **FR-9**: `project_remove(projectId)` deletes the entry, persists, and then clears
  `projectId` on every session whose `projectId` matched — in the in-memory engine map and
  in `sessions.json` — emitting one `session.meta` `SessionEvent` per affected session.
  It **never** deletes, moves, or edits anything under `root` (including `CLAUDE.md`).
  Unknown `projectId` → `PROJECT_NOT_FOUND`.

### Standards & coding rules

- **FR-10**: `project_get_standards(projectId)` reads `<root>/CLAUDE.md` and returns
  `StandardsRead` (§5): the parsed `standards`, `fileExists`, and `blockPresent`. A missing
  file is **not** an error — it returns
  `{ standards: { notes: '', rules: [] }, fileExists: false, blockPresent: false }`.
  Unknown `projectId` → `PROJECT_NOT_FOUND`; a root that no longer exists →
  `PROJECT_ROOT_MISSING`.
- **FR-11**: **Block grammar.** The managed block is exactly, with `\n` line endings:

  ```
  <!-- francois:standards:start -->
  ## Coding standards
  {notes trimmed, then one blank line — omitted entirely when notes is empty}
  - {rule 1}
  - {rule 2}
  <!-- francois:standards:end -->
  ```

  Marker lines are matched **exactly**, on their own line, after trimming trailing
  whitespace. `STANDARDS_START` / `STANDARDS_END` are the constants in §5.
- **FR-12**: **Parse.** Within the block, the heading line (`## Coding standards`) is
  dropped. Everything before the **first** line matching `^- ` is `notes` (trimmed). From
  that line on, every line matching `^- (.+)$` yields one rule (the capture, trimmed); any
  other line there is **ignored** (see §7 case 9). A block that is absent yields
  `{ notes: '', rules: [] }` with `blockPresent: false`.
- **FR-13**: `project_set_standards(projectId, standards)` validates before touching disk:
  - each rule, trimmed, is non-empty, ≤ 500 chars, and contains no `\n` or `\r`;
  - `rules.length` ≤ 200;
  - `notes` is ≤ 8000 chars;
  - **neither `notes` nor any rule contains `STANDARDS_START` or `STANDARDS_END`** (a rule
    that did could close the block and take over the rest of the file);
  violations → `INVALID_INPUT` with a message naming the offending constraint. Then:
  - if the file exists and contains **exactly one** well-formed `START … END` pair, the
    span from the START line through the END line inclusive is replaced by the freshly
    rendered block and **every other byte of the file is preserved verbatim**;
  - if the file exists with **no** START and no END, the block is appended, separated from
    the prior content by exactly one blank line, with a trailing `\n`;
  - if the file does not exist, it is created containing only the block (plus trailing
    `\n`); the parent dir already exists (it is `root`);
  - **empty standards** (`rules` empty **and** `notes` empty after trim) instead **remove**
    the block, collapsing the whitespace it leaves to a single blank line; if there was no
    block, the call is a no-op and the file is not created.
  The write is atomic (temp file in the same directory + rename).
- **FR-14**: The core **refuses to write** and returns `STANDARDS_WRITE_FAILED` when the
  file is malformed with respect to the markers: a START with no following END, an END with
  no preceding START, or more than one START. The message names the file and the problem;
  the file is left untouched. (Mirrors `permission-guardrails`' "refuses to touch an
  unparseable settings file".)
- **FR-15**: I/O failure (permission denied, read-only volume, disk full) →
  `STANDARDS_WRITE_FAILED` for writes and `INTERNAL` for reads, in both cases with the OS
  error in `message`. The temp file is removed on failure.
- **FR-16**: On success `project_set_standards` returns a **fresh re-read** of the file
  (`StandardsRead`), not the payload it was given — so the editor never shows a stale view
  (the `permission-guardrails` FR-18 pattern).
- **FR-17**: Francois never restarts, signals, or otherwise notifies a running session when
  standards change. `claude` re-reads `CLAUDE.md` per turn; that is the whole mechanism.

### Session linking & inheritance

- **FR-18**: `SessionMeta` gains **optional** `projectId?: ProjectId`. Absent ⇒ unlinked.
  It is persisted in `sessions.json` and restored by `durable-sessions`' reload; a persisted
  session predating this feature simply has no such key and loads unlinked. A persisted
  `projectId` that no longer resolves to a registry entry is **dropped on load** (treated as
  unlinked) and the pruned value is persisted on the next write.
- **FR-19**: `session_create` accepts an optional `projectId`. When present it must resolve
  to a registry entry (→ `PROJECT_NOT_FOUND`) whose root exists (→ `PROJECT_ROOT_MISSING`);
  it is stored on the session verbatim. **The core does no auto-adoption and no default
  merging** — it stores exactly the `projectId` and the explicit `modelId`/`effort`/
  `permissionMode`/`runtime`/`allowGit` it is given. Resolution is the frontend's job
  (FR-21) so that what the user sees in the modal is exactly what is created.
- **FR-20**: A successful `session_create` carrying a `projectId` refreshes that project's
  `lastUsedAt` and persists the registry. Failure to persist is logged and ignored — it
  never fails session creation.
- **FR-21**: **The project owns the working directory.** The new-session modal's first
  control is `project`. Selecting one sets the session's `cwd` to that project's `root` and
  **removes the `DIRECTORY` row entirely** — the root is the working directory, so an
  editable path would be a second source of truth for the same value. In its place the modal
  shows a dim, read-only `runs in <root>` line. Every default the project declares overwrites
  the corresponding field; fields it leaves unset keep the pre-feature default. The derived
  session name is `basename(root)` unless the name was hand-edited. With `— none —` selected
  the `DIRECTORY` row returns and the pre-projects flow is restored unchanged. The whole
  `project` control is hidden while the registry is empty.

  > **Amended 2026-07-25, superseding the frozen text.** This FR originally specified
  > *auto-adopt by path*: the user picked a `cwd` and the modal resolved the deepest project
  > containing it. The user asked for the inverse — pick the project, inherit its path — so
  > the directory step disappears for a project-backed session. **Consequence:** a session can
  > no longer be started in a *subdirectory* of a project while staying linked to it (the
  > old spec's §3 flow 4, `D:\francois\src-tauri` linking to `francois`); that now requires
  > `— none —` and an unlinked session. `isPathInside` / `resolveProjectForCwd` remain
  > exported and unit-tested in `contract/projects.ts` but are **no longer called by the
  > modal** — they are what a future "adopt this directory" affordance would use.
- **FR-22**: The project field in the new-session modal is a normal control: the user may
  pick any project (which re-applies its defaults over the current values, per FR-21) or
  `— none —` (which clears `projectId` **and** resets the five fields to the pre-feature
  defaults). Any subsequent manual edit of a field wins — re-applying only happens on a
  project change.
- **FR-23**: Selecting a project whose `rootExists` is `false` is blocked: the modal shows
  an inline `project root is missing` message and the submit control is disabled until the
  user picks another project or `— none —`.
- **FR-24**: Editing a project's `defaults` **never** mutates an existing session. There is
  no re-emission of `session.meta` on `project_update`.

### Switcher & board filtering

- **FR-25**: A **project switcher** row renders at the top of pane `[1]`'s body, above
  fleet-board's cards and inside its scroll container's sticky header area. It reads
  `▾ All projects` or `▾ <project name>` (ellipsized). Clicking it opens a dropdown:
  `All projects`, then every project ordered per FR-5 (a project with `rootExists: false`
  is rendered dim with a `missing` tag but is still selectable), a separator, then
  `Manage projects…` which opens the modal.
- **FR-26**: `activeProjectId: ProjectId | null` is new shared frontend state owned by this
  feature (`null` = All). It is persisted to `localStorage` under `francois.activeProjectId`
  and restored on launch; a restored id that is not in the fetched list falls back to `null`.
- **FR-27**: When `activeProjectId` is non-null the fleet board renders only sessions whose
  `projectId` equals it. This composes with fleet-board's `/` filter by **AND**. The pane
  header count (`app-shell` FR-12) shows the count **after both filters**.
- **FR-28**: Changing `activeProjectId` resets fleet-board's keyboard cursor to index `0` of
  the newly visible list but **does not change `activeSessionId`** — the active session stays
  active (and stays rendered in the main pane) even when filtered out of the board. This
  preserves fleet-board's sole ownership of `activeSessionId`.
- **FR-29**: When `activeProjectId` is non-null and the visible list is empty, the board
  shows an empty state reading `no sessions in <project name>` with a `press n to start one`
  hint — distinct from the existing global no-sessions empty state.
- **FR-30**: Opening the new-session modal while `activeProjectId` is non-null pre-selects
  that project and applies its defaults (FR-21) — "inside a project, a new session belongs to
  it". A project whose `rootExists` is `false` is **not** pre-selected, or the modal would open
  already blocked by FR-23. With no active project the field starts at `— none —`.

### Projects modal

- **FR-31**: The modal is opened by the palette command `manage-projects` (glyph `⊟`, title
  `Manage projects`, hint `defaults & standards`, registered via `registerPaletteCommand`
  per `command-palette` FR-6) and by the switcher's `Manage projects…` item. State:
  `projectsOpen: boolean` in the shared store, alongside `permissionsOpen`.
- **FR-32**: The modal reads `project_list` on open and after every mutation, and
  `project_get_standards` whenever the selected project changes — never trusting cached
  state (the `permission-guardrails` FR-17/18 pattern).
- **FR-33**: Layout is two columns: a left list of projects (each row: name, abbreviated
  root, a `missing` tag when `rootExists` is false) with a `+ New project` control at the
  bottom; and a right config form for the selected project. Selecting a row swaps the form.
  With no projects the left column shows an empty state and the right column is blank.
- **FR-34**: The config form has three groups:
  1. **Identity** — `name` and `root`, both **editable text inputs** committing on blur or
     `⏎` (the delivered mock uses a free-text root rather than a picker button; a bad path
     surfaces the FR-6 validation inline, and `rootExists` then reports the truth);
  2. **Session defaults** — five uniform selects: `model`, `effort`, `permission mode`,
     `runtime`, `allow git` (options `yes`/`no`). Every one carries **`inherit`** as its
     first option, rendered in `#565a63`, which clears that default — `allow git` is a
     select rather than a toggle precisely because it has three states, not two;
  3. **Standards** — a `notes` textarea and a rules list (each row: the text, inline edit,
     a delete control, and drag-free `↑`/`↓` reorder controls), plus an add-rule input that
     commits on `⏎`. A footer reads `→ <root>/CLAUDE.md · francois block`.
- **FR-35**: Identity and defaults edits call `project_update` immediately (no Save button).
  Standards edits call `project_set_standards` on commit of each individual change
  (rule added / edited / deleted / reordered, notes blurred) with the **whole** standards
  object. A failure shows the error inline next to the group and re-reads (FR-32/FR-16) so
  the form returns to on-disk truth; the modal never throws.
- **FR-36**: `Remove` sits at the bottom of the form and requires an inline confirm reading
  `remove project "<name>"? sessions are kept; CLAUDE.md is not touched`. Confirming calls
  `project_remove` and selects the next row (or none).
- **FR-37**: `Escape` and a backdrop click close the modal. While it is open the app-shell
  single-letter global keys are suppressed — the same rule every other modal follows
  (`permission-guardrails` FR-29).
- **FR-38**: A project whose `rootExists` is `false` keeps its Identity group fully editable
  (so the root can be corrected in place) and renders the Defaults and Standards groups
  disabled (`opacity: .45`, `pointer-events: none`), with a single explanatory line under
  Identity: `root missing — fix the path to edit this project`.

## 5. API contract

Everything below is `contract/projects.ts`. Shared vocabulary (`Result`, `AppError`,
`ErrorCode`, `PermissionMode`, `ClaudeRuntime`, `SessionMeta`, `SessionEvent`) is imported
from `contract/common.ts` and never redefined. `ProjectId` and `ProjectDefaults` are
**added to `common.ts`** because `SessionMeta` (which lives there) references `ProjectId`.

**This feature defines no new event channel.** Every project mutation is initiated by this
app's own frontend and resolves with the new state, so a push channel would carry nothing
the response does not. The one piece of project state that reaches other features —
`SessionMeta.projectId` — rides on the existing `session.meta` `SessionEvent`.

### 5.1 Additions to `contract/common.ts`

```ts
// ---------- projects ----------

export type ProjectId = string; // uuid v4

/**
 * Session settings a project pre-fills into the new-session modal. Every field is
 * optional: an absent field means "inherit" — the modal keeps its pre-feature default
 * for that control. Defaults are a SNAPSHOT: they are copied onto the session at
 * creation and never re-applied afterwards (projects FR-24).
 */
export interface ProjectDefaults {
  modelId?: string;
  /** low | medium | high | xhigh | max — must be one the chosen model advertises. */
  effort?: string;
  permissionMode?: PermissionMode;
  runtime?: ClaudeRuntime;
  allowGit?: boolean;
}
```

`SessionMeta` gains one optional field (all other fields unchanged):

```ts
export interface SessionMeta {
  // … all existing fields unchanged …
  /**
   * The project this session was created under; absent when unlinked. Set at creation
   * only — editing a project's defaults never changes a session (projects FR-24).
   * Cleared (with a session.meta emission) when that project is removed (projects FR-9).
   */
  projectId?: ProjectId;
}
```

`ErrorCode` gains four members:

```ts
  | 'PROJECT_NOT_FOUND'      // projects: a projectId that is not in the registry
  | 'PROJECT_DUPLICATE_ROOT' // projects: another project already owns that normalized root
  | 'PROJECT_ROOT_MISSING'   // projects: the project's root no longer exists on disk
  | 'STANDARDS_WRITE_FAILED' // projects: CLAUDE.md could not be read-merged-written
```

### 5.2 `contract/projects.ts`

```ts
// contract/projects.ts — projects (registry, session defaults, standards).
// Authored from specs/projects.md §5. Imports shared vocabulary from common.ts;
// never redefines it. NO event channel is defined here (§5 preamble).
//
// Physical Tauri binding: francois:project:<verb> → command project_<verb>
// (snake_case), called via invoke('project_<verb>', payload) → Promise<Result<T>>.

import type {
  ProjectId,
  ProjectDefaults,
  Result,
  SessionId,
  SessionMeta,
  SessionEvent,
} from './common';

// ---------- the entity ----------

export interface ProjectMeta {
  id: ProjectId;
  /** Display name; defaults to basename(root). Trimmed, 1–80 chars. NOT unique. */
  name: string;
  /** Absolute, normalized (FR-8) directory path. Unique across the registry. */
  root: string;
  defaults: ProjectDefaults;
  createdAt: number; // epoch ms
  /** epoch ms; refreshed when a session is created under this project (FR-20). */
  lastUsedAt: number;
  /**
   * Derived at list time by stat-ing `root` — NEVER persisted (FR-2).
   * false ⇒ the directory is gone or is not a directory; the project is read-only
   * except for the Identity inputs and `Remove` (FR-38), and cannot back a new session (FR-23).
   */
  rootExists: boolean;
}

// ---------- standards ----------

/** The exact marker lines Francois owns inside CLAUDE.md (FR-11). Matched verbatim. */
export const STANDARDS_START = '<!-- francois:standards:start -->';
export const STANDARDS_END = '<!-- francois:standards:end -->';
/** The heading rendered as the block's first content line (FR-11). */
export const STANDARDS_HEADING = '## Coding standards';

/**
 * The structured content of the managed block. Rendered/parsed by the RUST CORE only
 * (it owns the file); the frontend edits this shape and never touches CLAUDE.md.
 * Rules are identified by their index — the whole object is written on every change.
 */
export interface ProjectStandards {
  /** Free-form markdown above the bullets; '' when unset. ≤ 8000 chars (FR-13). */
  notes: string;
  /** Ordered rules. Each: trimmed non-empty, ≤ 500 chars, single-line. ≤ 200 rules. */
  rules: string[];
}

/** What a standards read reports about the file on disk. */
export interface StandardsRead {
  standards: ProjectStandards;
  /** <root>/CLAUDE.md exists. */
  fileExists: boolean;
  /** the managed block was found (false ⇒ `standards` is empty). */
  blockPresent: boolean;
}

// ---------- francois:project:list — frontend -> core ----------
/** No payload. */
export type ProjectListRequest = void;
/** Ordered by lastUsedAt desc, then name asc (case-insensitive) — FR-5. */
export type ProjectListData = ProjectMeta[];
/** Never fails for registry reasons (FR-3). ok:false error codes: 'INTERNAL'. */
export type ProjectListResponse = Result<ProjectListData>;

// ---------- francois:project:create — frontend -> core ----------
export interface ProjectCreateRequest {
  /** absolute path to an existing directory; normalized by the core (FR-8). */
  root: string;
  /** omit ⇒ basename(root). Trimmed, 1–80 chars. */
  name?: string;
  /** omit ⇒ all defaults unset. */
  defaults?: ProjectDefaults;
}
/**
 * ok:false error codes:
 *   'INVALID_INPUT'          — root absent/not a directory/not absolute, or bad name
 *   'PROJECT_DUPLICATE_ROOT' — another project already owns that normalized root
 *   'INTERNAL'               — projects.json could not be written
 */
export type ProjectCreateResponse = Result<ProjectMeta>;

// ---------- francois:project:update — frontend -> core ----------
export interface ProjectUpdateRequest {
  projectId: ProjectId;
  /** present ⇒ replace the name. */
  name?: string;
  /** present ⇒ replace the root (re-validated per FR-6/FR-7). */
  root?: string;
  /** present ⇒ REPLACE the whole defaults object (an omitted field = inherit). */
  defaults?: ProjectDefaults;
}
/**
 * ok:false error codes:
 *   'PROJECT_NOT_FOUND' | 'INVALID_INPUT' | 'PROJECT_DUPLICATE_ROOT' | 'INTERNAL'
 */
export type ProjectUpdateResponse = Result<ProjectMeta>;

// ---------- francois:project:remove — frontend -> core ----------
export interface ProjectRemoveRequest {
  projectId: ProjectId;
}
/**
 * Deletes the entry and clears projectId on its sessions, emitting one session.meta
 * per affected session (FR-9). Touches nothing under `root`.
 * ok:false error codes: 'PROJECT_NOT_FOUND' | 'INTERNAL'
 */
export type ProjectRemoveResponse = Result<null>;

// ---------- francois:project:getStandards — frontend -> core ----------
export interface ProjectGetStandardsRequest {
  projectId: ProjectId;
}
/**
 * A missing CLAUDE.md is NOT an error (FR-10).
 * ok:false error codes: 'PROJECT_NOT_FOUND' | 'PROJECT_ROOT_MISSING' | 'INTERNAL'
 */
export type ProjectGetStandardsResponse = Result<StandardsRead>;

// ---------- francois:project:setStandards — frontend -> core ----------
export interface ProjectSetStandardsRequest {
  projectId: ProjectId;
  /** the WHOLE object; empty rules + empty notes removes the block (FR-13). */
  standards: ProjectStandards;
}
/**
 * Resolves with a FRESH RE-READ of the file, not the payload (FR-16).
 * ok:false error codes:
 *   'PROJECT_NOT_FOUND' | 'PROJECT_ROOT_MISSING'
 *   'INVALID_INPUT'          — rule/notes length, multiline rule, or a marker string inside
 *   'STANDARDS_WRITE_FAILED' — malformed marker pairing (FR-14) or an I/O failure (FR-15)
 */
export type ProjectSetStandardsResponse = Result<StandardsRead>;

// ---------- consumed (owned by session-engine; pinned here for build-ability) ----------

/**
 * session_create gains an optional projectId. The core stores it verbatim and does NO
 * default merging (FR-19) — the frontend resolves and applies defaults (FR-21).
 * Added error codes for this call: 'PROJECT_NOT_FOUND' | 'PROJECT_ROOT_MISSING'.
 */
export interface ProjectAwareSessionCreateRequest {
  cwd: string;
  name?: string;
  modelId?: string;
  effort?: string;
  permissionMode?: string;
  runtime?: string;
  allowGit?: boolean;
  /** NEW — the project this session belongs to; omit for unlinked. */
  projectId?: ProjectId;
}

/** projects handles exactly this SessionEvent member (to keep its own link map fresh). */
export type ProjectsHandledSessionEvent = Extract<
  SessionEvent,
  { type: 'session.meta' } | { type: 'session.removed' }
>;

// ---------- pure frontend helpers (owned here, unit-tested) ----------

/**
 * FR-8 containment, frontend side: true when `root` equals or is an ancestor of `cwd`,
 * compared component-wise, case-insensitively when `caseInsensitive` (Windows).
 * Both paths must already be normalized (separators unified, no trailing separator).
 */
export function isPathInside(cwd: string, root: string, caseInsensitive: boolean): boolean;

/**
 * The project whose root contains `cwd`, deepest (longest root) wins; projects with
 * rootExists === false are excluded. null when none match. NOT called by the modal
 * after the FR-21 amendment — kept as the primitive a future "adopt this directory"
 * affordance needs.
 */
export function resolveProjectForCwd(
  cwd: string,
  projects: ProjectMeta[],
  caseInsensitive: boolean,
): ProjectMeta | null;

/** FR-5 ordering, applied frontend-side after any local mutation. */
export function orderProjects(projects: ProjectMeta[]): ProjectMeta[];

/**
 * FR-27: the sessions the board should render.
 * activeProjectId === null ⇒ every session, unchanged.
 */
export function filterSessionsByProject(
  sessions: SessionMeta[],
  activeProjectId: ProjectId | null,
): SessionMeta[];

// ---------- shared frontend store fields owned by this feature ----------
export interface ProjectsState {
  projects: ProjectMeta[];
  setProjects: (p: ProjectMeta[]) => void;
  /** null = "All projects" (FR-26); persisted to localStorage 'francois.activeProjectId'. */
  activeProjectId: ProjectId | null;
  setActiveProjectId: (id: ProjectId | null) => void;
  /** the Projects modal (FR-31), alongside the existing permissionsOpen. */
  projectsOpen: boolean;
  setProjectsOpen: (o: boolean) => void;
}
```

### 5.3 Channel summary

| logical channel | Tauri command | payload | data | error codes |
|---|---|---|---|---|
| `francois:project:list` | `project_list` | — | `ProjectMeta[]` | `INTERNAL` |
| `francois:project:create` | `project_create` | `ProjectCreateRequest` | `ProjectMeta` | `INVALID_INPUT`, `PROJECT_DUPLICATE_ROOT`, `INTERNAL` |
| `francois:project:update` | `project_update` | `ProjectUpdateRequest` | `ProjectMeta` | `PROJECT_NOT_FOUND`, `INVALID_INPUT`, `PROJECT_DUPLICATE_ROOT`, `INTERNAL` |
| `francois:project:remove` | `project_remove` | `ProjectRemoveRequest` | `null` | `PROJECT_NOT_FOUND`, `INTERNAL` |
| `francois:project:getStandards` | `project_get_standards` | `ProjectGetStandardsRequest` | `StandardsRead` | `PROJECT_NOT_FOUND`, `PROJECT_ROOT_MISSING`, `INTERNAL` |
| `francois:project:setStandards` | `project_set_standards` | `ProjectSetStandardsRequest` | `StandardsRead` | `PROJECT_NOT_FOUND`, `PROJECT_ROOT_MISSING`, `INVALID_INPUT`, `STANDARDS_WRITE_FAILED` |
| `francois:session:create` (existing, **extended**) | `session_create` | `+ projectId?: ProjectId` | `SessionMeta` | `+ PROJECT_NOT_FOUND`, `+ PROJECT_ROOT_MISSING` |

## 6. Data & state

**Rust core** — new module directory `src-tauri/src/project/`:

- `mod.rs` — the shared data model (`Project`, `ProjectDefaults` serde structs mirroring §5)
  and the child declarations. Held in `Mutex<Vec<Project>>` as Tauri managed state, loaded
  once at startup.
- `registry.rs` — load/save `projects.json` (atomic write, FR-1), normalization (FR-8),
  duplicate detection, ordering (FR-5), `lastUsedAt` refresh. Its own `#[cfg(test)] mod tests`.
- `standards.rs` — the pure block parse/render/upsert/remove over a `&str` (FR-11..FR-14),
  plus the validation of FR-13. **Every function here is pure and string-in/string-out** so
  the test suite needs no filesystem for the grammar itself; the file I/O wrapper is thin
  and tested against temp dirs. Its own `#[cfg(test)] mod tests`.
- `commands.rs` — the six `#[tauri::command]` handlers, each returning `IpcResult<…>`.
- `testutil.rs` — `#[cfg(test)]` fixtures (a temp project root, a CLAUDE.md builder).

**Rust core — changes to existing modules**:

- `session/mod.rs` — `Session` gains `project_id: Option<String>`.
- `session/persistence.rs` — `project_id` is written into `sessions.json` and read back,
  with the drop-if-unresolvable rule of FR-18.
- `session/commands.rs` — `session_create` gains the `project_id: Option<String>` argument,
  validates it (FR-19), and refreshes `lastUsedAt` (FR-20).
- `main.rs` — registers the project state and the six new commands.

**Frontend** — new feature folder `src/features/projects/`:

- `ProjectSwitcher.tsx` — the pane `[1]` strip + dropdown (FR-25).
- `ProjectsModal.tsx` — the two-column modal (FR-31..FR-38).
- `projects.ts` — the pure helpers of §5 (`isPathInside`, `resolveProjectForCwd`,
  `orderProjects`, `filterSessionsByProject`) plus the `localStorage` read/write for
  `activeProjectId`.
- `projects.test.ts` — vitest over every pure helper.

**Frontend — changes to existing files**:

- `src/lib/store.ts` — the `ProjectsState` slice of §5.
- `src/lib/api.ts` — the six typed `invoke` wrappers.
- `src/features/sessions/Sidebar.tsx` — mounts `ProjectSwitcher` above the cards and applies
  `filterSessionsByProject` before its existing `/` filter (FR-27..FR-29).
- `src/features/sessions/NewSessionModal.tsx` — the project field, the hidden DIRECTORY row, and default
  application (FR-21..FR-23, FR-30).
- `src/features/palette/…` — registers the `manage-projects` command (FR-31).

**Persistence**: `<app_data_dir>/projects.json` (the registry) and `<root>/CLAUDE.md` (the
managed block). Nothing else is written. `activeProjectId` is browser `localStorage`, not a
core concern.

**Derived state**: `rootExists` (per FR-2, computed at every `project_list`); the filtered
session list (per FR-27, recomputed from `sessions` + `activeProjectId` + `sidebarFilter`);
the resolved project for a `cwd` (per FR-21, recomputed on every directory pick).

## 7. Edge cases & errors

| # | case | behavior |
|---|---|---|
| 1 | `projects.json` missing / empty / corrupt | Empty registry, no error; first write recreates it (FR-3). A single undeserializable entry is skipped, the rest load. |
| 2 | Two projects created for the same directory | Second → `PROJECT_DUPLICATE_ROOT`, inline message `another project already owns that directory` (FR-6). |
| 3 | Project root deleted or renamed outside Francois | `rootExists: false` (FR-2). Row shows `missing`; Identity stays editable so the root can be corrected, Defaults + Standards disabled (FR-38); new-session selection blocked (FR-23); `getStandards`/`setStandards` → `PROJECT_ROOT_MISSING`. |
| 4 | `CLAUDE.md` absent when reading standards | Not an error: `{ notes:'', rules:[] }`, `fileExists:false`, `blockPresent:false` (FR-10). |
| 5 | `CLAUDE.md` absent when writing non-empty standards | The file is created containing only the block (FR-13). |
| 6 | `CLAUDE.md` absent when writing empty standards | No-op; the file is **not** created (FR-13). |
| 7 | `CLAUDE.md` has a START with no END (truncated / hand-mangled) | Refuse to write → `STANDARDS_WRITE_FAILED`, message names the file; the file is untouched (FR-14). Reads return `blockPresent:false` with empty standards. |
| 8 | `CLAUDE.md` has two START markers | Same refusal as case 7 (FR-14). |
| 9 | Hand-written content inside the block that is not the heading, notes, or a `- ` bullet | Ignored on read (FR-12) and therefore **lost on the next write**. This is the documented cost of the managed block and is called out in the modal footer. Content outside the markers is always preserved byte-for-byte. |
| 10 | A rule containing `<!-- francois:standards:end -->` | Rejected before any I/O → `INVALID_INPUT` (FR-13). Prevents escaping the block. |
| 11 | A multiline rule (pasted text with newlines) | Rejected → `INVALID_INPUT`; the modal's add-rule input strips newlines on paste so this is only reachable by a non-UI caller. |
| 12 | `CLAUDE.md` is read-only / on a read-only volume / disk full | `STANDARDS_WRITE_FAILED` with the OS error in `message`; temp file removed; the original file intact (FR-15). |
| 13 | `session_create` with a `projectId` that was removed a moment earlier | `PROJECT_NOT_FOUND`; the modal re-reads `project_list` and resets its project field to `— none —`. |
| 14 | A persisted session references a project that no longer exists | `projectId` dropped on load, session loads unlinked, pruned value persisted on next write (FR-18). |
| 15 | Project removed while its sessions are running | Sessions keep running untouched; each gets `projectId` cleared plus one `session.meta` emission (FR-9). Nothing under `root` is modified. |
| 16 | `activeProjectId` in `localStorage` points at a removed project | Falls back to `null` (All) on launch (FR-26); the same happens live when the active project is removed. |
| 17 | The active session is filtered out by the switcher | It stays the active session and stays rendered in the main pane; only the board's list and cursor change (FR-28). |
| 18 | A project is active and its filtered list is empty | Board shows `no sessions in <name>` + `press n to start one` (FR-29). |
| 19 | A session is wanted in a SUBDIRECTORY of a project | Not expressible while linked (FR-21 amendment): the project contributes its root verbatim. Use `— none —` and an unlinked session. |
| 20 | Nested projects (`D:\repo` and `D:\repo\packages\api`) | Both are legal and both appear in the picker; the chosen one supplies its own root. Only exact-root duplicates are rejected (FR-6). |
| 21 | Case-differing roots on Windows (`D:\Repo` vs `D:\repo`) | Treated as the same root → `PROJECT_DUPLICATE_ROOT` (FR-8). On Linux/macOS they are distinct. |
| 22 | Project's default model no longer exists in `session_models` | The modal's model picker falls back to its own default and shows the stale id dim; the project is not auto-corrected. `session_create` stays permissive about model ids as it is today. |
| 23 | Project's default effort is not advertised by the chosen model | The effort control drops to the model's default; no error. |
| 24 | Project default `runtime: 'wsl'` on a non-Windows machine | The modal disables the WSL choice and falls back to `native`; `session_create` would reject it with `INVALID_INPUT` as it does today. |
| 25 | `project_update` renames a project to an existing name | Allowed — names are not unique (FR-6). Roots are the unique key. |

## 8. Design brief

### Screens & components

**A. Project switcher (pane `[1]`, new).** A single 26px row pinned at the top of the
sidebar body, above fleet-board's card list, sharing the pane's `#16171c` background with a
`1px solid #24262d` bottom border. Content: an 8px chevron glyph `▾` in `#565a63`, then the
label in 11px `#c8c5bd` — `All projects` when unfiltered, else the project name, ellipsized
(`text-overflow: ellipsis; white-space: nowrap`). Padding `6px 12px`. Hover raises the label
to `#e8e4dc` and the row background to `#1b1c22`. When a project is active the chevron and
label are `#c8a15a` (accent), matching how the app marks a scoped/filtered state elsewhere.

**B. Switcher dropdown.** Anchored under the strip, `#1b1c22` background, `1px solid #2a2c33`,
`5px` radius, `0 6px 20px rgba(0,0,0,.45)` shadow, `4px` vertical padding, max-height `260px`
with `.scz` scrolling. Rows are 24px, 11px text, `0 12px` padding: `All projects` first, then
one row per project showing the name left and its abbreviated root right in 10px `#565a63`.
A project with `rootExists: false` renders its name at `#6b7079` with a 9px `missing` tag in
`#c46b62`. The selected row carries a leading `✦` in `#c8a15a`. A `1px solid #24262d`
separator, then `Manage projects…` in 11px `#868a93`. Hover background `#22242b`.

**C. Projects modal.** Same shell as the permissions editor: centered, backdrop
`rgba(0,0,0,.55)`, panel `#16171c`, `1px solid #2a2c33`, `6px` radius, width
`min(860px, 94vw)`, max-height `min(620px, 88vh)`. Header row (`padding: 12px 16px`, bottom
border `1px solid #24262d`): title `PROJECTS` in 11px/700/`0.14em` `#c8a15a`, and on the
right a 10px `#565a63` count `<n> projects`. Body is a two-column flex: left `240px` list
with a `1px solid #24262d` right border, right column `1fr`, both `.scz` scrolling and
`min-height: 0`.

- **Left list rows** (`padding: 8px 12px`, 44px tall): name in 11.5px `#c8c5bd`, abbreviated
  root beneath in 10px `#565a63`. Selected row: background `#1f2128`, a 2px `#c8a15a` left
  rail, name in `#e8e4dc`. `missing` tag as in B. Bottom of the column: a full-width
  `+ New project` control, 11px `#868a93`, `10px 12px` padding, top border `1px solid #24262d`,
  hover `#c8a15a`.
- **Right config form**, `padding: 14px 16px`, `18px` gaps between the three groups. Each
  group opens with a 10px/700/`0.14em` label in `#868a93` — `IDENTITY`, `SESSION DEFAULTS`,
  `STANDARDS`. Field rows are label-left (10.5px `#6b7079`, `120px` wide) / control-right.
  Inputs and selects: `#131419` background, `1px solid #2a2c33`, `4px` radius, `6px 8px`
  padding, 11px, focus border `#c8a15a`. Identity's `name` and `root` are both editable text
  inputs. All five defaults are selects whose **first option reads `inherit`**; a field
  sitting on `inherit` renders its value in `#565a63`, an explicitly set one in `#c8c5bd`.
  `allow git`'s options are `inherit` / `yes` / `no`.
- **Standards group.** A `notes` textarea (min-height `64px`, same input treatment,
  `resize: vertical`, `line-height: 1.6`, placeholder
  `notes for every session in this project…`). Below it the rules list: each row 26px, `#131419` background, `4px`
  radius, `4px` vertical gap, `6px 8px` padding, showing a `-` bullet glyph in `#565a63`, the
  text in 11px `#c8c5bd` (click to edit inline), and on hover a right cluster of `↑` `↓` `×`
  controls in 10px `#565a63` → `#c8a15a` (`×` → `#c46b62`). Then an add-rule input with the
  placeholder `add a rule…`, committing on `⏎`. Footer line in 10px `#565a63`:
  `→ <root>\CLAUDE.md · francois block`, with the trailing warning
  `content inside the markers is managed by francois`.
- **Remove.** Bottom-right of the form, 10.5px `#6b7079` → `#c46b62` on hover. Confirming
  swaps it in place for the sentence `remove project "<name>"? sessions are kept; CLAUDE.md is
  not touched` in 10.5px `#c46b62` with `cancel` / `remove` controls.
- **Inline errors.** Directly beneath the offending group, 10.5px `#c46b62`, no icon —
  the same treatment the permissions editor uses.

**D. New-session modal (extended).** One new field, first in the form, above `directory`:
label `project`, a select listing `— none —` then every project (a `missing` one is dim and
disabled-looking but selectable, which then surfaces the FR-23 inline message
`project root is missing` in `#c46b62` beneath it and dims the submit control).

### States

- Switcher: unfiltered / filtered / dropdown open / hover.
- Modal: no projects (left empty state `no projects yet` in 11px `#565a63`, right column
  blank) / list with a selection / a `rootExists: false` selection (Defaults + Standards
  groups at `opacity: .45`, `pointer-events: none`, plus the FR-38 line) / a group in error /
  remove-confirm open.
- Standards: empty (`no rules yet` placeholder in 10.5px `#565a63`) / populated / a row in
  inline edit.
- Board: unfiltered / filtered non-empty / filtered empty (FR-29 empty state, centered, 11px
  `#565a63` with the `press n to start one` hint in 10px).

### Interactions & motion

- Switcher click toggles the dropdown; `Escape` or an outside click closes it. Dropdown
  entrance: `opacity 0→1` + `translateY(-2px)→0` over `90ms ease-out` — the same micro-motion
  the mock uses for overlays. No motion on selection.
- Modal: `Escape` and backdrop click close (FR-37); app-shell single-letter keys are
  suppressed while open. `⏎` in the name input and the add-rule input commits; `Escape` inside
  an inline rule edit reverts that row only, without closing the modal.
- Every mutation is optimistic-free: the control disables for the round-trip, then the fresh
  read repaints. No spinners — the round-trips are local file I/O.

### Responsive / resize

- The switcher strip is fixed-height and lives inside the fixed 264px column; only its label
  ellipsizes.
- The modal is `min(860px, 94vw)` × `min(620px, 88vh)`; below `740px` wide the two columns
  stack (list on top, capped at `160px` and scrolling, form beneath). Both columns scroll
  independently with `.scz`.

### Deliberate deltas from the mock

The mock predates this app's light theme and several shipped features, so where the
running app's own idiom differs, the app wins. Beyond the three recorded above (free-text
root, `allow git` as a select, palette glyph `⊟`), the implementation departs here — each
is intentional and was reached by looking at the built UI:

- **Switcher chevron is `▼` (U+25BC), not `▾` (U+25BE).** The small triangle carries almost
  no ink in JetBrains Mono; at 8px it read as a stray period rather than a disclosure
  control, in both themes.
- **Switcher hover uses `--bg-hover`, not `--bg-elevated`.** The latter is invisible against
  `--bg-panel` in the light theme; `--bg-hover` is what every other interactive row in pane
  `[1]` already uses.
- **The switcher carries a right-aligned project count**, mirroring the pane header's own
  `<count> · [1]` grammar so the strip reads as a control with contents. Hidden while the
  registry is empty.
- **The unfiltered switcher label sits at `--text-dim`**, not `--text` — it is a quiet scope
  line, and at full weight it competed with the session names directly beneath it.
- **FR-25 mount point**: the strip is a sibling *above* the filter row and the scroll
  container, not inside the scroll container's sticky header. It therefore never scrolls
  away. This supersedes FR-25's "inside its scroll container's sticky header area".
- **The dropdown's `Manage projects…` row sits OUTSIDE the `role="listbox"`** as a
  `role="button"`. It is an action, not a selectable scope, and must not be announced as an
  option.
- **New-session modal**: a missing-root project is marked with a `(missing)` text suffix
  rather than dim styling — `<option>` styling is unreliable across platforms.
- **Projects modal panel uses `max-height`, not `height`** — a fixed height renders a full
  620px panel around a one-line "no projects yet" empty state.

### Mock reference

`Claude Terminal.dc.html` has no projects region — derive the switcher from the sidebar
header treatment (lines 47, 50–54) and the dropdown/modal from the command-palette overlay
(the palette panel's background, border, radius, shadow, and row metrics) and the permissions
editor modal described in `specs/permission-guardrails.md` §8. All colors above are the
existing app-shell tokens from `src/styles.css`; this feature introduces **no new token**.

## 9. Acceptance criteria

- [ ] Creating a project from a picked directory persists it to `projects.json` and it
      survives an app restart. (FR-1, FR-6)
- [ ] A missing or corrupt `projects.json` starts the app with an empty registry and no
      error dialog; the next create rewrites the file. (FR-3)
- [ ] Two projects cannot share a root; on Windows the check is case-insensitive and
      component-wise (`D:\a\bc` is not inside `D:\a\b`). (FR-6, FR-8)
- [ ] `project_list` is ordered by `lastUsedAt` desc then name asc, and `rootExists` is
      `false` for a project whose folder was renamed away. (FR-2, FR-5)
- [ ] Writing standards into a `CLAUDE.md` that already has hand-written content leaves every
      byte outside the markers identical, and appends the block after exactly one blank line.
      (FR-13)
- [ ] Re-writing standards replaces only the marker span; the surrounding content is still
      byte-identical after three successive edits. (FR-13)
- [ ] Clearing all rules and notes removes the block entirely and does not create the file if
      it never existed. (FR-13)
- [ ] A `CLAUDE.md` with an unterminated or duplicated START marker is refused with
      `STANDARDS_WRITE_FAILED` and is left untouched on disk. (FR-14)
- [ ] A rule containing the END marker string is rejected with `INVALID_INPUT` before any
      file is opened. (FR-13)
- [ ] `project_set_standards` resolves with a fresh re-read of the file, and the editor
      repaints from it rather than from what was typed. (FR-16)
- [ ] Selecting a project in the new-session modal sets the session's cwd to its root,
      hides the DIRECTORY row, and pre-fills all five defaults. (FR-21)
- [ ] Opening the modal while the board is scoped to a project pre-selects it; a project
      with a missing root is never pre-selected. (FR-30)
- [ ] Overriding a pre-filled field at creation is honored, and the project's default is
      unchanged afterwards. (FR-22, FR-24)
- [ ] Setting the project field to `— none —` clears `projectId` and resets the five fields to
      the pre-feature defaults. (FR-22)
- [ ] Editing a project's defaults leaves every existing session's model / effort /
      permission mode / runtime / allow-git untouched. (FR-24)
- [ ] `SessionMeta.projectId` round-trips through `sessions.json` and `durable-sessions`'
      reload; a session persisted before this feature loads unlinked. (FR-18)
- [ ] A persisted `projectId` pointing at a removed project is dropped on load. (FR-18)
- [ ] Removing a project clears `projectId` on its sessions (one `session.meta` each), keeps
      the sessions, and modifies nothing under `root`. (FR-9)
- [ ] Selecting a project in the switcher filters the board to its sessions, composes with the
      `/` filter, and updates the pane header count. (FR-27)
- [ ] Filtering does not change `activeSessionId`; the main pane keeps rendering the active
      session even when it is filtered out of the board. (FR-28)
- [ ] `activeProjectId` survives a restart via `localStorage`, and falls back to `All` when it
      names a removed project. (FR-26)
- [ ] ⌘K → `Manage projects` opens the modal; `Escape` and backdrop click close it; while it
      is open the single-letter global keys do nothing. (FR-31, FR-37)
- [ ] A project with a missing root disables Defaults + Standards but keeps Identity and
      `Remove`, and cannot back a new session. (FR-23, FR-38)
- [ ] Adding a standards rule while a session is mid-turn changes nothing in Francois; the
      following turn's `claude` picks the rule up from `CLAUDE.md` on its own. (FR-17)

## Remediation

(Empty until a review returns findings.)
