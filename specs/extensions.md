---
id: extensions
title: Extensions
status: shipped
branch: feat/extensions
created: 2026-08-04
depends_on: [app-shell, agent-tab, workflow-details, projects, command-palette, session-engine, webview-hardening]
loop_pass: 0
loop_phase:
reviewed_base: 17087af4d93ce4d836c3b64a90ccff0fd02f77ad
reviewed_digest: ad5e44d1898aa2a7
design_files: []
---

# Extensions

> **BLOCKED on an external commit.** The `cohorte` extension reads `cohorte panels <name> --json`,
> which does not exist yet (see §2 Non-goals). `ext:git` and `ext:docker` are unblocked and build
> today; the cohorte panels build against the contract in §5 and stay in the `EXT_PROVIDER_EXIT`
> error state until that subcommand ships. Do not treat a red cohorte panel as a defect before then.

## 1. Summary

Francois can only show what Francois knows how to render. This feature adds a **compiled-in set of
three extensions** — `cohorte`, `git`, `docker` — each contributing a main-pane `ext:<id>` tab built
from four declarative primitives and fed by an **out-of-process provider binary** spawned by the Rust
core. The registry is a plain array in the Francois binary: no manifest is ever read from disk, at any
scope, so a repository cannot declare a panel or impersonate one. Panels are **read-only** — no panel
mutates data — with one deliberate exception, the cohorte-dashboard launch button. Extensions are
detected per project root, user-toggleable, and default on.

## 2. Goals & non-goals

**Goals**

- A declarative registry compiled into the binary: one array, no per-extension code seam. Every
  difference between extensions is a **declared field a primitive honours and Francois clamps**.
- Four primitives: `key-value`, `table` (typed columns, status tags, provider pagination), `stat-row`,
  `log-tail` (file source **or** provider process).
- Provider execution in the Rust core under hard caps: argv arrays, scrubbed env, cwd confinement,
  timeout, output cap, concurrency cap, schema validation.
- Per-project detection (filesystem/PATH predicates only), cached, explicitly refreshable.
- A toggle modal (⌘K + titlebar) plus a per-tab disable affordance; state persisted in `app_data_dir()`.
- An error state per failure cause, always naming the cause. Never a silent empty panel, never a
  disappearing tab.

**Non-goals**

- **Panel actions that mutate** — `git checkout`, `docker restart`, cohorte update/reset. With them go
  general argv slots (§5 I5 of the brainstorm brief) and row-level actions. They return **together**,
  as their own feature. The single `token` slot in FR-38 is not that feature arriving early: it is
  confined to `log-tail` targeting and cannot appear anywhere else.
- **A section inside the Overview tab.** Fleet-scoped panels live in the `ext:cohorte` tab in v1 — one
  host for the renderers, one lifecycle to hang refresh and stream-kill on.
- **A sparkline primitive.** `stat-row` + `table` carry cost & runtime.
- Contributed JS or CSS · manifest discovery from disk at any scope · a published schema, third-party
  validator, or compatibility promise · signing or provenance · consent screens or a repo-trust gate.
- **Embedding cohorte's web UI** in an iframe or child webview. Already settled by `specs/_decisions.md`
  ("No third-party origin in the webview") and shipped as `frame-src 'none'; child-src 'none'` in
  `tauri.conf.json`. Not an open question.
- Panels in the right rail or the sidebar (main-pane tabs only) · write access to session state from a
  panel · a git commit graph · charts.
- **No OS-level sandbox** around providers (no `sandbox-exec` / AppContainer promise) — they run with
  the user's privileges. Authorization and output distrust carry the weight, not confinement.
- **Anything inside the cohorte repo.** A `cohorte panels <name> --json` entry in its `bin/cli.js`
  reusing `dashboard/server/{doctor,fleet,metrics,usage}.js`, plus the loops provider it lacks, is a
  separate feature on cohorte's side. cohorte ships no manifest and its distribution does not change.

## 3. User stories / flows

1. **A panel appears where its tool is in use.** I open a session in a git repo that also runs cohorte.
   The tab strip reads `SESSION · DIFF · SHELL · ext:cohorte · ext:git`. Docker is not installed, so no
   docker tab is offered anywhere.
2. **Reading an extension.** I click `ext:git`. The pane scrolls through Branches, Stashes, Remotes and
   Log, each a table with its own header. Nothing spawned until that click.
3. **Paging.** The Log table shows 100 commits and a `Load more` row. Clicking it round-trips to the
   provider for the next page and appends. Closing the tab discards the cursor.
4. **Watching a log.** In `ext:docker` I click a container row in Containers; the Logs section below
   begins streaming that container's output, appending, bounded. Switching to another tab stops the
   stream after a grace period; returning restarts it from empty.
5. **Turning one off.** Docker's tab is noise on this machine. From the tab itself I click `disable`
   (or open Extensions from ⌘K and flip the toggle). The tab closes, any live stream is killed, and
   nothing docker-related spawns again until I turn it back on.
6. **A provider is too old.** My cohorte predates `cohorte panels`. Every cohorte section shows an
   error naming the cause and the required version — `needs cohorte ≥ 2.4.0 · exited 1` — with the
   resolved command underneath. The tab is still there; nothing looks broken-without-explanation.
7. **Reaching the real cockpit.** The cohorte tab's Health header carries a button. It reads `Open
   dashboard` when a probe finds cohorte on :4317, `Launch dashboard` when the port is silent, and is
   disabled with `port 4317 is taken by something else` when the port answers but is not cohorte.
   Launching asks me to confirm the exact resolved command first, then spawns it detached and opens the
   URL in my browser.
8. **A project becomes detected.** I run `/cohorte-init-pipeline` in a repo Francois already knows.
   Nothing changes until I hit `Re-detect` in the Extensions modal (or reopen the project), which
   invalidates the cache for that root and the tab appears.

## 4. Functional requirements

### Registry & detection

- **FR-1** The extension registry is a **compiled-in array** of `ExtensionDefinition` values in the Rust
  core. No manifest is read from disk at any scope — not from a repo, not from `~/.claude`, not from an
  enabled Claude Code plugin. There is no code path that parses an extension definition from a file.
- **FR-2** The registry contains exactly three entries in this order: `cohorte`, `git`, `docker`.
- **FR-3** Detection is a **filesystem or PATH predicate only** and never executes repo-supplied
  content. It grants nothing but whether a tab is offered.
  | Extension | Detected when |
  | --- | --- |
  | `cohorte` | `<root>/.claude/pipeline.json` exists, parses, and carries `"pipeline": "cohorte"` |
  | `git` | `<root>/.git` exists (file or directory) |
  | `docker` | `docker` resolves on PATH **and** `docker info` exits 0 within the FR-21 timeout |
- **FR-4** Detection results are **cached per normalized project root**. A cached entry is reused on
  every session switch and every tab open. The cache is invalidated only by (a) `extensions_detect`
  for that root, (b) the project being (re)opened, or (c) app restart. There is no watcher and no TTL.
- **FR-5** The `docker` predicate runs `docker info` — an exec, unlike the other two. It is subject to
  every provider cap in FR-19..FR-24, and its result is cached by FR-4 like any other, so a session
  switch never re-runs it.
- **FR-6** An extension is **enabled by default**. `ExtensionToggles` (`{ [id]: boolean }`) is the only
  mutable input to the extension system and persists to `app_data_dir()` alongside the existing state
  written by `session/persistence.rs`. A missing key reads as `true`.
- **FR-7** **Off means off.** A disabled extension contributes no tab, and its providers never spawn —
  not lazily, not for detection, not for a badge count. `extensions_panel`, `extensions_open_stream`,
  `extensions_probe` and `extensions_launch` all return `EXT_NOT_ENABLED` for a disabled extension,
  before any process is created.
- **FR-8** Disabling an extension whose tab is open closes that tab, kills any live stream it owns, and
  discards its cursor state, within the same event loop turn as the toggle write. Enabling an extension
  spawns nothing until its tab is opened.

### Tabs & lifecycle

- **FR-9** Each available extension contributes one main-pane tab with `MainTab` value `ext:<id>`,
  reusing the dynamic-tab machinery in `src/features/agents/agent-tab.ts` and the dispatch in
  `src/app/MainPaneBody.tsx`. `extIdFromTab` mirrors `agentIdFromTab` / `workflowIdFromTab`, and
  `mainPaneBranch` gains an `ext` branch.
- **FR-10** Extension tabs sit **after** `SHELL` and **before** any `agent:` / `workflow:` tab, ordered
  by their registry position (FR-2). They are **not** subject to `AGENT_TAB_CAP` and never evict an
  agent or workflow tab.
- **FR-11** An extension tab is offered when the extension is enabled **and** detected for the active
  session's project root. Fleet-scoped panels do not change this: an extension with only fleet panels
  still requires detection at some root to be offered.
- **FR-12** **Extension tabs survive a session change**, unlike `agent:` / `workflow:` tabs. On session
  change the tab **re-scopes**: project-scoped panels re-fetch against the new session's project root,
  fleet-scoped panels are untouched, and all cursor state and live streams for project-scoped panels are
  discarded first.
- **FR-13** If the new session's project root does not detect that extension, the tab **remains open**
  and its body renders `not available in <project name>` — a distinct state from any error in FR-49.
  It re-populates if a later session's root detects it.
- **FR-14** With no active session (the "All projects" / OVERVIEW state), project-scoped panels render
  `select a session`; fleet-scoped panels still load, because they take no root.
- **FR-15** A tab is keyed by its extension id and remounts on key change, matching `AgentView` /
  `WorkflowView`.
- **FR-16** Closing an extension tab kills every live stream it owns and discards every cursor. It does
  not change the toggle — the tab is offered again on the next strip render.

### Panel layout

- **FR-17** An extension tab renders its panels as **stacked sections in one scrolling pane**, in
  declaration order, each with its own header (label + per-section error/refresh state).
- **FR-18** Opening the tab fetches **every** panel in it. Those fetches are subject to the concurrency
  cap (FR-23) and queue behind it; each section shows its own loading state until its own fetch lands.
  A slow or failing section never blocks a sibling.

### Provider execution

- **FR-19** Providers are spawned by the Rust core as an **argv array**, never a shell string. There is
  no `sh -c`, no shell interpolation, and no string concatenation anywhere on the path from a definition
  to a spawn.
- **FR-20** A provider runs with cwd set to the panel's **declared root** (the project root for
  `scope: 'project'`, the user's home for `scope: 'fleet'`), **no stdin** (closed immediately), and a
  **scrubbed environment**: `PATH`, `HOME`, `USER`, `LANG`, `TMPDIR`, and the platform's required
  minimum only. The app's own environment is never inherited; no Anthropic credential, session token,
  or `CLAUDE_*` variable is ever passed to a provider.
- **FR-21** **Timeout: 10 000 ms** per provider call. On expiry the child is killed (process group where
  the platform supports it) and the call resolves `EXT_PROVIDER_TIMEOUT`. `log-tail` process sources are
  exempt from this timeout and bounded by FR-40 instead.
- **FR-22** **Output cap: 4 MiB** of stdout per call. On the byte that exceeds it the child is killed and
  the call resolves `EXT_OUTPUT_CAPPED`. No partial payload is ever forwarded to the webview.
- **FR-23** **Concurrency cap: 4** in-flight provider processes app-wide. Further calls queue FIFO. The
  queue is not a cap on pending calls: a queued call still honours FR-21 measured from when it starts.
- **FR-24** A provider that cannot be spawned at all (binary missing from PATH, permission denied)
  resolves `EXT_PROVIDER_MISSING`. A provider that exits non-zero resolves `EXT_PROVIDER_EXIT` with
  `detail: { code, stderr }`, where `stderr` is truncated to 2 000 chars and sanitized by FR-51.
- **FR-25** Provider stdout is parsed as JSON and **validated against the payload schema for the panel's
  declared primitive**. A payload that does not validate resolves `EXT_SCHEMA_INVALID`. A validated
  payload is forwarded whole; a partially-valid payload is never partially rendered.
- **FR-26** Every panel definition declares `minVersionLabel` (e.g. `"cohorte ≥ 2.4.0"`). It is used
  **only** to compose the error message (FR-49) — Francois runs **no version probe** and parses no
  `--version` output. The value for `cohorte` is pinned to the first cohorte release shipping
  `cohorte panels`; `git` and `docker` declare `null`.
- **FR-27** PATH resolution grants nothing new: Francois already spawns `git` for the DIFF tab and
  `claude` for every session. Recorded so a reviewer does not treat it as introduced here.

### Refresh & pagination

- **FR-28** A panel may declare `refreshMs`. Francois **clamps it to a floor of 2 000 ms** — silently,
  with no user-visible indication. A definition declaring less is corrected, not rejected. `null` means
  no auto-refresh.
- **FR-29** Auto-refresh runs only while the panel's tab is the **active** main tab. It stops on tab
  switch, tab close and window blur, and resumes on return. A refresh never overlaps its own previous
  fetch: a fetch still in flight when the interval fires skips that tick.
- **FR-30** A refresh that fails replaces the section body with the error state (FR-49) rather than
  keeping stale rows — a panel must never show data that is silently no longer being updated.
- **FR-31** A `table` panel may declare `paginated: true`. The provider then accepts `--offset <n>
  --limit <n>` and returns `{ rows, offset, hasMore }`. **Page size is 100 rows.**
- **FR-32** Cursor state (accumulated pages + next offset) is owned by the **frontend, per open panel**.
  At most **20 pages (2 000 rows) are retained** per open panel; requesting past that disables the
  `Load more` control and shows `showing first 2000 rows`.
- **FR-33** **Every page fetch is a fresh provider spawn** under the identical argv, env, cwd, timeout,
  output and concurrency caps as the first (FR-19..FR-24). Pagination introduces no long-lived process.
- **FR-34** Cursor state is discarded on tab close, on session change (FR-12), on toggle-off, and on any
  refresh. A remount never resumes from a stale offset.

### Primitives

- **FR-35** `key-value` renders an ordered list of `{ key, value, tone }` rows, tone driving a status
  glyph (`ok` · `warn` · `error` · `neutral` · `busy`).
- **FR-36** `table` renders typed columns declared by the panel (`text` · `status` · `number` · `time` ·
  `path`). A `status` cell renders as a tag using the row's `tone`; `time` renders an epoch-ms value in
  the app's existing relative format; `path` renders monospace and truncates from the left. A row
  carrying a key not in the declared columns is ignored; a declared column missing from a row renders
  empty. Neither is an error.
- **FR-37** `stat-row` renders tiles of `{ label, value, sublabel? }`, wrapping.
- **FR-38** `log-tail` renders an append-only, bottom-latched, monospace block from one of two declared
  sources:
  - **`file`** — a path relative to the panel's declared root.
  - **`process`** — an argv array spawned and streamed.
  A `log-tail` panel may declare **one `token` slot** in its path or argv. This is the **only** slot in
  the system: it may appear in no other primitive and in no other field. Its value is validated as
  `^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$` — a leading `-` is therefore structurally impossible — and is
  passed after `--` where the target binary supports it. **The value may come only from a sibling
  panel's validated provider rows in the same tab**, selected by the user clicking a row. It is never
  typed by the user and never read from repository content. An unfilled slot renders
  `select a row above`, spawns nothing, and is not an error.
- **FR-39** A `log-tail` **file** source may open only paths resolving (after symlink resolution) under
  its panel's declared root. Anything else resolves `EXT_PATH_OUTSIDE_ROOT` and opens no handle. This
  keeps `specs/reports/<id>.loop.log` and refuses `~/.ssh/id_rsa`.
- **FR-40** A `log-tail` buffer is a ring of **2 000 lines / 1 MiB**, oldest dropped. The dropped count
  renders as a dim leading row (`… N earlier lines`), matching `earlierBlocksNotice` in `agent-tab.ts`.

### Streaming lifecycle

- **FR-41** **Nothing spawns until the user opens the panel's tab** — not on detection, not on session
  switch, not in the background, and never while the extension is disabled.
- **FR-42** **One live stream per panel.** Opening a stream for a panel that already has one closes the
  first. Opening a stream for a different target (FR-38) is the same operation.
- **FR-43** A stream is killed when its tab closes, when its extension is disabled, on session change for
  a project-scoped panel, and when its tab stops being the active main tab for longer than a **10 s grace
  period**. Returning to the tab within the grace period keeps the stream; returning after it restarts
  from an **empty** buffer.
- **FR-44** Every stream is addressed by a core-minted `streamId`. Chunks arrive as
  `francois://extensions/event`; the frontend drops any chunk whose `streamId` it does not currently own,
  so a late chunk from a killed stream can never append to a new one.
- **FR-45** A process source that exits emits `ext.stream.ended` with its exit code. A non-zero exit
  renders the error state (FR-49) **below** the retained buffer rather than replacing it — the lines
  already read are still what the user wanted.

### The launch action (the one exception to read-only)

> "Read-only" here means **no data mutation from a panel**. Providers execute by design, and so does
> this button. Stated explicitly so a reviewer does not read it as a contradiction.

- **FR-46** The `cohorte:health` panel declares one action with **static argv** — `["cohorte",
  "dashboard", "--open"]`. It has no slots and no interpolation. It is the only action in the registry,
  and adding a second is a decision to reopen, not an implementation detail.
- **FR-47** Its state comes from `extensions_probe`, which issues `GET http://127.0.0.1:4317/api/versions`
  with a 2 000 ms timeout and classifies the result:
  | Probe result | State | Control |
  | --- | --- | --- |
  | 200 + JSON carrying cohorte's expected key | `running` | `Open dashboard` → opens the URL |
  | connection refused / no listener | `stopped` | `Launch dashboard` |
  | any other answer (non-200, HTML, wrong shape, timeout) | `occupied` | disabled, `port 4317 is taken by something else` |
  A foreign listener is never reported as running, and Launch is never offered against it — spawning
  would hit `EADDRINUSE` and exit 1.
- **FR-48** Launching requires a **human click** and an explicit confirmation showing the **resolved
  command** verbatim. This is a Francois-owned confirm dialog in the `RemoveAccountConfirm` /
  `src/ui/Modal` idiom — **not** the session permission card, which belongs to a Claude Code tool call
  and has no meaning for an app-level spawn. The process is spawned **detached and never tracked**: no
  PID ownership, no stop button, no kill-on-quit, no orphan reconciliation. A stop action belongs in
  cohorte (`cohorte dashboard --stop` against a pidfile it writes itself), not here. On success Francois
  re-probes after 1 500 ms and opens the URL when the probe turns `running`; if it does not within 10 s
  it renders `EXT_LAUNCH_FAILED`. The detached launch **inherits Francois's environment** — a deliberate
  exception to FR-20's provider scrub, recorded here at review round 2. The scrub exists because provider
  spawns are unattended and auto-refreshing; a launch is one explicit human click on a named command, and
  mirrors how `editor/mod.rs` already launches external tools.

### Rendering hygiene & error states

- **FR-49** Once an extension is detected, **the tab always exists**. Every failure renders an explicit
  in-section error state **naming the cause**, never confusable with a legitimate zero-row result:
  `<cause> · <minVersionLabel, if declared>` over the resolved command in monospace, plus a `Retry`
  control. A zero-row success renders the section's declared empty copy instead.
- **FR-50** No provider-derived string is ever passed to `dangerouslySetInnerHTML`, and no primitive
  renders markdown. If that ever changes, `src/features/conversation/MarkdownView.tsx` is the sink to
  audit first.
- **FR-51** Every provider-derived string is sanitized **in the core, before it crosses IPC** — not at
  display time: ANSI escape sequences and C0/C1 control characters (except `\n` in `log-tail` bodies)
  are stripped, and each field is truncated to **512 characters** with a trailing `…`.
- **FR-52** Any provider-derived value that would become an `href` or `src` passes a scheme allowlist of
  `https:` and `http:` only. A value failing it renders as inert text, never as a link. `img-src` and
  `font-src` in the CSP are the net behind this and **may not be relaxed to make a panel render** —
  `specs/_decisions.md` freezes them.

### The three extensions

- **FR-53** `ext:cohorte` — `minVersionLabel: "cohorte ≥ 2.4.0"`, provider `cohorte`. Sections in order:
  | Panel | Primitive | Scope | Provider argv |
  | --- | --- | --- | --- |
  | `cohorte:health` | `key-value` (+ the FR-46 action) | project | `cohorte panels health --json` |
  | `cohorte:fleet` | `table` | fleet | `cohorte panels fleet --json` |
  | `cohorte:specs` | `table` | project | `cohorte panels specs --json` |
  | `cohorte:loops` | `table`, `refreshMs: 5000` | project | `cohorte panels loops --json` |
  | `cohorte:loop-log` | `log-tail`, file source `specs/reports/{token}.loop.log`, target from `cohorte:loops` | project | — |
  | `cohorte:cost` | `stat-row` | project | `cohorte panels cost --json` |
  Fleet needs **no fan-out from Francois**: cohorte's `fleet.js` already maps over every tracked project,
  so Francois calls the provider **once** and receives the whole fleet. There is no per-project spawn and
  no `--project` slot.
- **FR-54** `ext:git` — `minVersionLabel: null`, provider `git`.
  | Panel | Primitive | Scope | Provider argv |
  | --- | --- | --- | --- |
  | `git:branches` | `table` | project | `git for-each-ref --format=… refs/heads` |
  | `git:stashes` | `table` | project | `git stash list --format=…` |
  | `git:remotes` | `table` | project | `git remote -v` |
  | `git:log` | `table`, `paginated: true` | project | `git log --format=… --skip=<offset> -n <limit>` |
  git emits no JSON, so the **core** adapts its output to the payload schema. That adapter is part of
  provider execution, not a per-extension code seam: it converts a declared `format` string into rows and
  is reusable by any future line-oriented provider.
- **FR-55** `ext:docker` — `minVersionLabel: null`, provider `docker`.
  | Panel | Primitive | Scope | Provider argv |
  | --- | --- | --- | --- |
  | `docker:containers` | `table`, `refreshMs: 5000` | project | `docker ps -a --format '{{json .}}'` |
  | `docker:images` | `table` | project | `docker images --format '{{json .}}'` |
  | `docker:logs` | `log-tail`, process source `docker logs -f --tail 200 -- {token}`, target from `docker:containers` | project | — |
  Docker's scope is `project` only so its panels share the tab's lifecycle; the daemon is machine-wide
  and the cwd is immaterial to it.

### Toggle surface

- **FR-56** An **Extensions modal** (`src/ui/Modal`, in the `AccountsModal` idiom) is reachable from ⌘K
  (`palette` command `Extensions`) and from the titlebar. It lists **every** registry entry — including
  undetected ones, shown as `unavailable here` with the reason from FR-3, never hidden — each with a
  toggle and its detection state.
- **FR-57** The modal carries a **`Re-detect`** control that invalidates the detection cache for the
  active project root and re-runs every predicate (FR-4).
- **FR-58** Each extension tab carries a **`disable` affordance** in its header that flips that
  extension's toggle. This is where discoverability comes from.

## 5. API contract

`contract/extensions.ts` — canonical TypeScript, mirrored by serde structs in the Rust core.

```ts
import type { AppError, Result } from './common';

// ---------- identity ----------

export type ExtensionId = 'cohorte' | 'git' | 'docker';
/** `${ExtensionId}:${slug}` — e.g. 'git:log'. */
export type PanelId = string;
/** Core-minted, uuid v4. */
export type StreamId = string;

export type PanelScope = 'fleet' | 'project';
export type PrimitiveKind = 'key-value' | 'table' | 'stat-row' | 'log-tail';
export type StatusTone = 'ok' | 'warn' | 'error' | 'neutral' | 'busy';
export type ColumnKind = 'text' | 'status' | 'number' | 'time' | 'path';

// ---------- the registry, as the frontend sees it ----------

export interface ColumnDef {
  key: string;
  label: string;
  kind: ColumnKind;
  /** Relative flex weight in the table row. Defaults to 1 when absent. */
  weight?: number;
}

export interface PanelInfo {
  id: PanelId;
  label: string;
  scope: PanelScope;
  primitive: PrimitiveKind;
  /** `table` only (FR-31). */
  paginated: boolean;
  /** Already clamped to the FR-28 floor by the core. `null` = no auto-refresh. */
  refreshMs: number | null;
  /** `table` only; `null` for every other primitive. */
  columns: ColumnDef[] | null;
  /** Copy for a validated zero-row payload (FR-49). */
  emptyCopy: string;
  /** FR-38: the panel id whose rows fill this panel's `token`, and the row key
   * to read it from. `null` when the panel declares no slot. */
  tokenSource: { panelId: PanelId; rowKey: string } | null;
  /** FR-46. Exactly one panel in the registry sets this. */
  action: PanelAction | null;
}

export interface PanelAction {
  id: 'cohorte-dashboard';
  label: string;
  /** The resolved command shown in the FR-48 confirmation. Static; no slots. */
  resolvedCommand: string;
}

export interface ExtensionInfo {
  id: ExtensionId;
  label: string;
  /** FR-6 toggle state. */
  enabled: boolean;
  /** FR-3, for the root the list was queried with. */
  detected: boolean;
  /** Why not detected — rendered by the modal's `unavailable here` row (FR-56). */
  undetectedReason: string | null;
  /** FR-26. Message composition only; never probed. */
  minVersionLabel: string | null;
  panels: PanelInfo[];
}

// ---------- panel payloads (one per primitive) ----------

export interface KeyValueRow {
  key: string;
  value: string;
  tone: StatusTone;
}

export interface TableRow {
  /** Stable within a page; used as the React key and as the FR-38 token source. */
  id: string;
  cells: Record<string, string>;
  tone: StatusTone;
}

export interface StatTile {
  label: string;
  value: string;
  sublabel?: string;
}

export type PanelData =
  | { primitive: 'key-value'; rows: KeyValueRow[] }
  | { primitive: 'table'; rows: TableRow[]; offset: number; hasMore: boolean }
  | { primitive: 'stat-row'; tiles: StatTile[] };
// `log-tail` never resolves through `extensions_panel` — it opens a stream instead.

// ---------- requests ----------

export interface ListExtensionsRequest {
  /** Absolute project root to evaluate detection against. `null` = fleet-only
   * (FR-14): every extension reports `detected: false` with a reason. */
  root: string | null;
}

export interface SetExtensionEnabledRequest {
  extensionId: ExtensionId;
  enabled: boolean;
  /** Absolute project root to re-evaluate detection against for the refreshed
   * list this call returns. `null` = fleet-only (mirrors `ListExtensionsRequest`).
   * Required so a toggle from one project's tab never evaluates against
   * whichever root a different session queried most recently (review round 2). */
  root: string | null;
}

export interface DetectExtensionsRequest {
  /** Invalidates this root's cache entry and re-runs every predicate (FR-57). */
  root: string;
}

export interface PanelRequest {
  panelId: PanelId;
  /** Required for `scope: 'project'`; ignored for `scope: 'fleet'`. */
  root: string | null;
  /** FR-31, paginated tables only. */
  offset?: number;
  limit?: number;
}

export interface OpenStreamRequest {
  panelId: PanelId;
  root: string | null;
  /** FR-38. Must match `^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$` — the core
   * re-validates and never trusts the frontend's check. */
  token: string | null;
}

export interface CloseStreamRequest {
  streamId: StreamId;
}

export interface LaunchRequest {
  actionId: 'cohorte-dashboard';
}

export interface ProbeResult {
  state: 'running' | 'stopped' | 'occupied';
  /** Present only when `state === 'running'`. */
  url: string | null;
}

// ---------- events ----------

export type ExtensionEvent =
  | { type: 'ext.stream.started'; streamId: StreamId; panelId: PanelId }
  | { type: 'ext.stream.chunk'; streamId: StreamId; lines: string[] }
  | { type: 'ext.stream.ended'; streamId: StreamId; exitCode: number | null }
  | { type: 'ext.stream.error'; streamId: StreamId; error: AppError };
```

### Channels

| Logical channel | Tauri command | Request | Resolves |
| --- | --- | --- | --- |
| `francois:extensions:list` | `extensions_list` | `ListExtensionsRequest` | `Result<ExtensionInfo[]>` |
| `francois:extensions:setEnabled` | `extensions_set_enabled` | `SetExtensionEnabledRequest` | `Result<ExtensionInfo[]>` |
| `francois:extensions:detect` | `extensions_detect` | `DetectExtensionsRequest` | `Result<ExtensionInfo[]>` |
| `francois:extensions:panel` | `extensions_panel` | `PanelRequest` | `Result<PanelData>` |
| `francois:extensions:openStream` | `extensions_open_stream` | `OpenStreamRequest` | `Result<StreamId>` |
| `francois:extensions:closeStream` | `extensions_close_stream` | `CloseStreamRequest` | `Result<null>` |
| `francois:extensions:probe` | `extensions_probe` | `null` | `Result<ProbeResult>` |
| `francois:extensions:launch` | `extensions_launch` | `LaunchRequest` | `Result<null>` |
| `francois:extensions:event` | event `francois://extensions/event` | — | `ExtensionEvent` |

`setEnabled` and `detect` return the **full refreshed list** rather than an ack, so the frontend never
re-queries to learn what changed.

### New `ErrorCode` members (appended to `contract/common.ts`)

```ts
  | 'EXT_NOT_ENABLED'       // extensions FR-7: the extension is toggled off; nothing was spawned
  | 'EXT_NOT_DETECTED'      // extensions FR-3: the extension's predicate does not hold for that root; when raised because no home directory could be resolved (fleet-scoped panels), detail: { command } per FR-49
  | 'EXT_PANEL_NOT_FOUND'   // extensions: a panelId that is not in the compiled registry
  | 'EXT_PROVIDER_MISSING'  // extensions FR-24: the binary could not be spawned (detail: { argv0, command })
  | 'EXT_PROVIDER_TIMEOUT'  // extensions FR-21: killed at 10s (detail: { timeoutMs, command })
  | 'EXT_PROVIDER_EXIT'     // extensions FR-24: non-zero exit (detail: { code, stderr, command })
  | 'EXT_SCHEMA_INVALID'    // extensions FR-25: stdout did not validate; nothing was rendered
  | 'EXT_OUTPUT_CAPPED'     // extensions FR-22: killed past 4 MiB (detail: { capBytes, command })
  | 'EXT_PATH_OUTSIDE_ROOT' // extensions FR-39: a log-tail file source escaped its declared root
  | 'EXT_INVALID_TOKEN'     // extensions FR-38: the token slot failed its charset/length rule
  | 'EXT_STREAM_NOT_FOUND'  // extensions: closeStream addressed an unknown or already-ended stream
  | 'EXT_PORT_OCCUPIED'     // extensions FR-47: :4317 answered but is not cohorte
  | 'EXT_LAUNCH_FAILED'     // extensions FR-48: the detached spawn failed, or never came up in 10s
```

## 6. Data & state

**Core (`src-tauri/src/extensions/`)** — `mod.rs` owns the shared model (`ExtensionDefinition`,
`PanelDefinition`, `ProviderSpec`, `Source`), with children for one concern each:

- `registry.rs` — the compiled `&'static [ExtensionDefinition]` array (FR-1/FR-2). Pure data.
- `detect.rs` — predicates + the per-root cache `HashMap<PathBuf, HashSet<ExtensionId>>` (FR-3..FR-5).
- `provider.rs` — spawn, scrubbed env, timeout, output cap, the app-wide semaphore of 4 (FR-19..FR-24),
  and the declared-`format` line adapter FR-54 needs.
- `schema.rs` — per-primitive validation + FR-51 sanitization (FR-25).
- `stream.rs` — live streams keyed by `StreamId`, kill-on-close, the FR-43 grace timer.
- `launch.rs` — the probe and the detached spawn (FR-46..FR-48).
- `toggles.rs` — `ExtensionToggles` persisted to `app_data_dir()` (FR-6).

Persisted: **`ExtensionToggles` only.** The detection cache and every stream are in-memory and rebuild
on restart.

**Frontend (`src/features/extensions/`)** — `extensionsStore.ts` (zustand, in `src/lib/` per convention)
holds the `ExtensionInfo[]` list, and per-open-panel: `{ status, data, cursor: { pages, nextOffset },
error, selectedToken, streamId, lines, dropped }`. All of it is **session-lifetime, never persisted**.
`extensions.ts` holds the pure logic — token validation, cursor accumulation with the FR-32 cap, ring
buffer append with drop counting, error-message composition (FR-49) — and is where the vitest coverage
lives.

Derived, never stored: whether a tab is offered (`enabled && detected`), and a panel's clamped
`refreshMs` (computed once by the core).

## 7. Edge cases & errors

| Case | Behaviour |
| --- | --- |
| Provider binary absent from PATH | `EXT_PROVIDER_MISSING` → section error `cohorte not found on PATH` + resolved command |
| Provider exits non-zero (the old-cohorte case) | `EXT_PROVIDER_EXIT` → `needs cohorte ≥ 2.4.0 · exited 1` + truncated stderr |
| Provider runs 10 s | `EXT_PROVIDER_TIMEOUT` → `timed out after 10s`, child killed |
| Provider prints 2 GB | `EXT_OUTPUT_CAPPED` → `output exceeded 4 MiB`, child killed, nothing rendered |
| Provider returns valid JSON of the wrong shape | `EXT_SCHEMA_INVALID` → `unexpected output shape`. Never a partial render |
| Provider returns `{ rows: [] }` | **Success**, not an error. The section's `emptyCopy` renders |
| A branch is named `<img src=x onerror=…>` | Rendered as inert text. FR-50 forbids the HTML sink, FR-51 strips control chars in the core, the CSP is the net |
| A container name carries ANSI | Stripped in the core before IPC (FR-51) |
| Toggle off while the tab is open and streaming | Tab closes, stream killed, cursors dropped, same turn (FR-8) |
| Session switch mid-stream | Project-scoped streams killed and cursors dropped; tab re-scopes (FR-12) |
| Session switch to a project that doesn't detect it | Tab stays, body reads `not available in <project>` (FR-13) |
| No active session | Project sections read `select a session`; fleet sections load (FR-14) |
| Late chunk from a killed stream | Dropped by `streamId` mismatch (FR-44) |
| Two panels ask for a stream at once | One live stream per panel; a second open on the same panel closes the first (FR-42) |
| Five sections open at once with cap 4 | The fifth queues; each section shows its own loading state (FR-18/FR-23) |
| `git log` past 2 000 rows | `Load more` disabled, `showing first 2000 rows` (FR-32) |
| log-tail with no row selected | `select a row above`. Not an error; nothing spawns (FR-38) |
| A token fails its charset | `EXT_INVALID_TOKEN`. The core re-validates and never trusts the frontend (FR-38) |
| log-tail file path escapes the root | `EXT_PATH_OUTSIDE_ROOT`, no handle opened (FR-39) |
| :4317 answers but is not cohorte | `occupied` → button disabled, `port 4317 is taken by something else` (FR-47) |
| Launch confirmed but the spawn fails | `EXT_LAUNCH_FAILED`; nothing is tracked, nothing to clean up (FR-48) |
| `docker info` hangs | The FR-21 timeout applies to the predicate too → docker reads as undetected, reason `docker daemon not reachable` (FR-5) |
| Project root deleted while a tab is open | The next fetch fails at spawn → `EXT_PROVIDER_MISSING`; the tab stays |

## 8. Design brief

Three `ext:<id>` main-pane tabs after SHELL, each a scrolling column of titled sections built from four
primitives (`key-value`, `table`, `stat-row`, `log-tail`), plus an Extensions modal in the `AccountsModal`
idiom and a per-tab `disable` affordance. Every section has its own loading, empty and error state; the
error state always names its cause over the resolved command in monospace. Follows the v2 identity —
acid `#c3f53f` is the live thing, one per view, and status tones never borrow the accent.

> full brief: `specs/design/extensions.md`

## 9. Acceptance criteria

- [x] No code path parses an extension definition from disk; the registry is a compiled array (FR-1)
- [ ] Three tabs appear in registry order after SHELL, only where detected and enabled (FR-2, FR-9..FR-11)
- [x] Detection is cached per root and only an explicit re-detect, reopen or restart invalidates it (FR-4)
- [x] A disabled extension spawns no process on any path, including detection (FR-7)
- [x] Toggling off closes the tab, kills the stream and drops cursors in the same turn (FR-8)
- [x] An extension tab survives a session change and re-scopes; agent/workflow tabs still close (FR-12)
- [x] A session whose root doesn't detect the extension leaves the tab open with `not available` (FR-13)
- [x] Every provider spawn is an argv array; no `sh -c` and no interpolation exists in the tree (FR-19)
- [x] A provider receives no app credential and no `CLAUDE_*` variable (FR-20)
- [x] Timeout 10s, output cap 4 MiB, concurrency 4, refresh floor 2000ms are enforced and unit-tested (FR-21..FR-23, FR-28)
- [x] A definition asking for `refreshMs: 250` is silently clamped to 2000 (FR-28)
- [x] A page fetch spawns fresh under every cap; no long-lived process backs pagination (FR-33)
- [x] Cursor state is discarded on close, session change, toggle-off and refresh (FR-34)
- [x] The `token` slot exists only on `log-tail`, is re-validated in the core, and rejects a leading `-` (FR-38)
- [x] A `log-tail` file source cannot open a path outside its declared root, symlinks resolved (FR-39)
- [x] One live stream per panel; a late chunk from a killed stream never appends (FR-42, FR-44)
- [x] Leaving a tab kills its stream after 10s; returning after that restarts from empty (FR-43)
- [ ] The probe reports `occupied` for a foreign listener and refuses to launch (FR-47)
- [ ] Launch shows the resolved command, requires a click, and tracks no PID (FR-48)
- [ ] Every failure renders an in-section error naming its cause; a zero-row success renders empty copy, and the two are visually distinct (FR-49)
- [x] A branch named `<img src=x onerror=…>` renders as inert text (FR-50..FR-52)
- [x] Control characters and ANSI are stripped in the **core**, verified by a serde round-trip test (FR-51)
- [ ] The Extensions modal lists undetected extensions as `unavailable here` with a reason (FR-56)
- [ ] `Re-detect` invalidates the active root's cache and re-runs every predicate (FR-57)
- [ ] Every extension tab carries a working `disable` affordance (FR-58)

## Remediation

- 2026-08-06 — review round 1: 8 findings, all fixed (frontend 5, core 3; contract `EXT_*` `detail` shapes extended with `command` per FR-49)
- 2026-08-07 — review round 2: 10 findings, all fixed (core 6, frontend 4; contract `SetExtensionEnabledRequest` gained `root: string | null`; FR-48 env-inheritance recorded as a deliberate FR-20 exception)
- 2026-08-07 — review round 3
  - [x] CRITICAL · `src/features/extensions/ExtensionView.tsx:983-986` · spec-violation (FR-12) · stale `selected` could leak the previous session's token into a just-remounted log-tail section — fixed: `selected` now resets synchronously during render (React "adjust state while rendering" pattern keyed on `sessionId`) instead of in a `useEffect`, so remounted children never observe a stale value.
  - [x] MEDIUM · `src-tauri/src/extensions/commands.rs:663-673` · quality · spawn-failure branch swallowed the real `io::Error` — fixed: `spawn_process_stream` now returns `Result<_, io::Error>`, and a new `spawn_error` helper distinguishes `NotFound` ("not found on PATH") from other causes ("could not be started: `{e}`"), with the raw detail in `detail.reason` on `EXT_PROVIDER_MISSING` (no dedicated code exists yet for this path — flagged as a minor contract note, not a shape break).
  - [x] LOW · `src-tauri/src/extensions/provider.rs:2429-2451` · quality · verified already documented in the surrounding comment ("FR-23 says 'queued' — does not require strict FIFO wake order"); no code change needed.
  - [x] LOW · `src-tauri/src/extensions/provider.rs:2560-2578` · quality · fixed: `read_capped`'s doc comment now states the real check granularity (after each 16 KiB read, so up to one 16 KiB read past `cap_bytes` can be buffered before the kill fires).
  - [x] LOW · `src-tauri/src/session/status.rs`, `src-tauri/src/session/stream/lines.rs` · quality · acknowledged as a process note for future commits; no code change required this round.
  - [ ] LOW · `src/features/palette/paletteCommands.ts:3210` · convention · **partially addressed** — `MainTabStrip.tsx`'s `▤` tab-chip glyph replaced with `lucide-react`'s `Puzzle` icon, but the palette command glyph was left as `▤`: it's one of ~25 single-Unicode `glyph: string` entries in the same registry, and converting only this one would require widening `PaletteCommand.glyph` to `string | ReactNode` plus touching `PaletteView.tsx`'s renderer — a registry-wide change outside this fix's scope. Left open pending a decision: codify the chip-glyph exception in PIPELINE.md §Conventions, or take on the registry-wide glyph→icon migration as its own pass.
- 2026-08-09 — review round 4 (merged verdict REVISE — frontend alone SHIP, core alone REVISE)
  - [x] CRITICAL · `src-tauri/src/extensions/stream.rs:405-422` · spec-violation (FR-43) · fixed: `spawn_process_stream` now calls `own_process_group(&mut cmd)` (made `pub(crate)` in `provider.rs`) before spawning, so `Live::kill()`'s `killpg` reaches the whole process group; new unix test `kill_group_takes_down_a_forked_grandchild_too` asserts the grandchild is dead after kill.
  - [x] MEDIUM · `src-tauri/src/extensions/provider.rs:2404-2409` · quality · fixed: `run_capped`'s stderr reader replaced with a `drain_capped` helper that keeps draining the pipe to EOF past the retained-message cap, discarding the excess instead of stopping early — no more spurious `EXT_PROVIDER_TIMEOUT`; new unix test `stderr_past_the_retained_cap_never_blocks_the_child` covers it.
  - [x] LOW · `src-tauri/src/extensions/commands.rs:306-308` · quality · fixed: real `offset`/`limit` now computed before the `panel_root` match and threaded into the `NoHome` arm's `build_argv` call.
  - [x] LOW · `src/app/MainPaneBody.tsx:39-46` · quality · fixed: dead fallback branch removed; `extIdFromTab` cast to `ExtensionId` with a comment explaining the invariant, `ExtensionView` renders unconditionally.
  - [x] LOW · `src/lib/extensionsStore.ts:95` · quality · fixed: `extStickyIds` narrowed from `string[]` to `ExtensionId[]`, matching every write site; no call-site changes needed.
  - (note: `src/features/palette/paletteCommands.ts:3210` was re-flagged as LOW/convention in this round's report too — it is the same open item already tracked above under round 3, not a new one; not duplicated here.)

- 2026-08-07 — review round 3: 5 findings, all fixed (frontend 3, core 2; no contract change — FR-12 session-change teardown now goes through `sessionsStore.setActiveSessionId` → `closeStreamsForRemovedPanels`, probe timeout unified to a single budget, transport-failure classification fails safe to `Occupied`)
- 2026-08-10 — review round 5: 4 findings, all fixed (frontend 3, core 1; no contract change — `nextFetchOffset` pure helper extracted into `extensions.ts` fixes the stale-offset pagination bug via a `stateRef`, log-tail lines now keyed by a monotonic line counter, and `resolve_under_root` distinguishes a vanished root from a genuine containment escape with a corrected message)
