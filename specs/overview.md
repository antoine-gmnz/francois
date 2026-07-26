---
id: overview
title: Overview — the cross-project dashboard
status: shipped
created: 2026-07-25
depends_on: [projects, fleet-board, session-engine, sessions-sidebar, app-shell, diff-view, agents-panel, command-palette]
---

# Overview — the cross-project dashboard

## 1. Summary

`projects` gave pane `[1]` a switcher that scopes the fleet board to one project, with
`All projects` as the unscoped default. But the middle pane never learned about that
scope: on `All projects` it still shows whichever session happened to be selected last —
one conversation, standing in for a whole fleet. That is the wrong altitude. This feature
adds a fourth main tab, **`OVERVIEW`**, a read-only dashboard of what is happening across
every project: a totals strip, a needs-attention list, a per-project session rollup, and a
live activity feed. Switching the board back to `All projects` selects it automatically —
zooming out in pane `[1]` now zooms the middle pane out with it — and clicking any row
drills back down into that session.

The tab is **purely derivative**. It owns no IPC command, no event channel, and no
subscription: everything it renders already flows through the single session/diff
subscription pane `[1]` owns. The only new state is the activity log, an in-memory ring
buffer fed from that same handler.

## 2. Goals & non-goals

- **Goals**:
  - A `OVERVIEW` main tab, first in the strip, reachable by click, by the global `o`
    key, and by the palette command `view-overview`.
  - Auto-selection when the board's scope widens to `All projects` (including at launch,
    and including the fallback when the active project is removed — projects §7 case 16).
  - Four regions: **fleet totals**, **needs attention**, **per-project rollup**,
    **recent activity**.
  - Every session row drills into that session (selects it and leaves the tab).
  - The tab works **scoped** as well as unscoped: with a project active it shows that one
    project, so `o` is never a dead key.
  - Lifting fleet-board's per-session derived map (`fileCount`, `runningAgentCount`) into
    the shared store so the dashboard reads the numbers the board already computed —
    **one subscription, one diff seed per session**.
- **Non-goals**:
  - **Persisting the activity feed.** It is in-memory and starts empty at every launch;
    nothing in the core retains cross-session history and this feature does not add it.
  - **Acting on sessions from the dashboard** — no start/stop/prompt/commit controls. It
    reads; the session's own tabs act. (Removal stays pane `[1]`'s context menu.)
  - **Cross-project aggregates the core would have to compute** (token spend per project,
    commits per day, a burndown). Everything shown is already in the frontend's hands.
  - **A per-project drill-down page.** Scoping the switcher already does that.
  - Replacing the fleet board. Pane `[1]` stays the navigator; this is the read surface.

## 3. User stories / flows

1. **Launch unscoped.** The user's last scope was `All projects`, so the app opens on
   `OVERVIEW`: `4 sessions · 2 projects │ 1 active · 2 ready · 1 error`, a
   `NEEDS ATTENTION` block naming the errored session, then `francois` and
   `survey-engine` with their sessions beneath them.
2. **Drill in.** They click the `core` row under `francois`. The session becomes active,
   the tab flips to `SESSION`, and focus moves to the main pane — the conversation is
   there, exactly as if they had clicked its card in pane `[1]`.
3. **Zoom back out.** They press `o`. `OVERVIEW` returns. Pressing `o` again goes back to
   `SESSION`.
4. **Scope down.** From the dashboard they pick `francois` in the switcher. The tab is
   left alone (they may be mid-conversation elsewhere), and if they are still on
   `OVERVIEW` it now shows only `francois` — header `PROJECT`, no unlinked bucket.
5. **Scope back up.** They pick `All projects`. The middle pane returns to `OVERVIEW`
   whatever it was showing — widening the scope means there is no longer one session in
   view.
6. **Something breaks.** A session errors mid-turn. Its dot goes red on the board, a row
   appears at the top of `NEEDS ATTENTION` with the error message, and a red
   `errored` line lands at the top of the activity feed. Clicking either opens it.
7. **Uncommitted work.** A session finishes and leaves 6 changed files. It appears under
   the errors as `6 uncommitted files`. A **running** session with changed files does
   not — it is still working.
8. **Quiet fleet.** Nothing is running and nothing is dirty: the strip reads
   `3 sessions · 2 projects │ all quiet` rather than a row of zeroes.
9. **Cold start.** No sessions and no projects: a centered `nothing running yet` with
   `n new session` and `⊟ manage projects` shortcuts.

## 4. Functional requirements

### The tab

- **FR-1**: `MainTab` gains `'overview'`. It renders **first** in the tab strip —
  `OVERVIEW · SESSION · DIFF · SHELL` — so the strip reads left-to-right from the whole
  fleet down to one session's files.
- **FR-2**: The tab is selected by clicking it, by the global `o`/`O` key, and by the
  palette command `view-overview` (glyph `▦`, name `Overview`). `o` and the palette
  command **toggle**: pressing them while on `OVERVIEW` returns to `SESSION`, the same
  grammar `d` (diff) and `t` (shell) already use. `o` obeys the existing global-key
  guards — an open modal, a focused input, or the terminal swallows it.
- **FR-3**: `OVERVIEW` is the initial `mainTab` when the restored `activeProjectId` is
  `null`; otherwise the initial tab stays `'session'`. Resolved once at store creation
  from the same `localStorage` read `activeProjectId` uses.
- **FR-4**: Whenever `activeProjectId` **becomes** `null`, `mainTab` is set to
  `'overview'`. Scoping to a non-null project **never** changes `mainTab`.
- **FR-5**: Selecting a session in pane `[1]` (click or `⏎`) sets `mainTab` to
  `'session'` **only when it was `'overview'`**. From `DIFF` or `SHELL` the tab is left
  alone — moving between sessions while reviewing diffs must not eject the user from
  `DIFF`.
- **FR-6**: The tab needs no active session and no project. It mounts and unmounts freely
  and holds no subscription, so nothing is torn down or re-seeded by visiting it.
- **FR-7**: The main pane's right-hand meta cluster (model / permission mode / ctx /
  elapsed) stays gated on `mainTab === 'session'` — it describes one session and has no
  meaning on the dashboard.

### Data sources

- **FR-8**: fleet-board's per-session `SessionDerived` map moves from `Sidebar`'s local
  `useState` into the shared store (`derived`, with `mergeDerived` / `dropDerived`).
  Pane `[1]` remains its **sole writer** — it owns the only `francois:session:event` and
  `francois:diff:event` subscription — and the dashboard is a reader. A second
  subscription is forbidden: it would double every `diff_get_summary` seed.
- **FR-9**: `mergeDerived` keeps fleet-board FR-7's guard: a merge for a session no longer
  in the cache is dropped, so a late `diff_get_summary` resolution cannot resurrect an
  entry for a removed session.
- **FR-10**: Pane `[1]` stays mounted (`display: none`) when the `[` toggle hides its
  column, so the dashboard's data keeps flowing with the sessions column closed.

### Fleet totals strip

- **FR-11**: The strip shows `<n> sessions`, and when unscoped `<n> projects` (groups
  holding **at least one** session), then one segment per non-zero figure among
  `active` · `ready` · `done` · `error` · `files` · `agents`, in that order.
- **FR-12**: **Zero-valued segments are omitted.** A strip that always reads `0 error`
  trains the eye to skip the word that must register when it is not zero.
- **FR-13**: `files` sums every known non-zero `fileCount`; a `null` (unknown) count
  contributes `0`, never `NaN`. `agents` sums `runningAgentCount`.
- **FR-14**: With sessions present but every segment zero, the strip reads `all quiet`
  rather than ending after the counts.
- **FR-15**: The strip is labelled `FLEET` when unscoped and `PROJECT` when scoped, and
  aggregates over **exactly the groups rendered** — so it honours the scope for free.

### Needs attention

- **FR-16**: Lists, in order: every `error` session (most recent activity first), then
  every **settled** (`idle` or `done`) session with a known `fileCount > 0` (likewise
  most recent first). A `running` session is **never** listed — it is still working.
- **FR-17**: An errored session appears **once**, as an error, even if it also has
  uncommitted files. `detail` is its `errorMessage`, falling back to `session failed`.
- **FR-18**: An uncommitted row's `detail` is `<n> uncommitted file(s)`, correctly
  singular. A `fileCount` of `0` or `null` never yields a row.
- **FR-19**: The whole section is hidden when the list is empty — an empty
  `NEEDS ATTENTION` heading is noise.

### Per-project rollup

- **FR-20**: One group per project **in registry order** (`project_list` / FR-5 of
  `projects`), **including projects owning no session** — a dashboard must be able to say
  a project is idle. An empty group renders a `—` placeholder.
- **FR-21**: A synthetic **`unlinked`** group holds every session with no `projectId`, or
  with a `projectId` the registry does not know (projects FR-18). It is appended **last**
  and only when non-empty.
- **FR-22**: With `activeProjectId` non-null, only that project's group renders and the
  unlinked bucket is hidden — those sessions are not in that project, and pane `[1]`
  hides them too (projects FR-27).
- **FR-23**: Sessions inside a group are ordered by `lastActivityAt` **descending**.
- **FR-24**: A group header shows the name, a `missing` tag when `rootExists` is `false`
  (projects FR-2), the abbreviated root, and a subtitle: the session count plus only the
  statuses worth naming (`active`, `error`, `done`). `idle` is the resting state and is
  never named, so an all-ready group reads as just `2 sessions`.
- **FR-25**: A session row shows the status dot (pulsing only while `running`, per
  fleet-board FR-9), name, status label, model label, context tokens, the diff count when
  `> 0`, the running-agent count when `> 0`, and relative last activity. The trailing
  cells are **fixed-width** so the columns align down the whole rollup.
- **FR-26**: Clicking a session row selects it, sets `mainTab` to `'session'`, and focuses
  the main pane.

### Recent activity

- **FR-27**: An in-memory ring buffer of `ActivityEntry`, capped at `MAX_ACTIVITY` (200),
  newest first, written from pane `[1]`'s existing event handler. **Never persisted** —
  it starts empty at every launch.
- **FR-28**: Recorded kinds and their triggers:
  | kind | trigger |
  |---|---|
  | `session.started` | a `session.meta` for an id the cache has never seen |
  | `turn.finished` | `session.status` `running → idle` |
  | `session.done` | `session.status` `* → done` |
  | `session.error` | `session.status` `* → error` (detail = `errorMessage`) |
  | `session.removed` | `session.removed` |
  | `agent.finished` | `agent.update` transitioning to `done` (detail = agent name) |
  | `agent.failed` | `agent.update` transitioning to `error` (detail = agent name) |
- **FR-29**: `* → running` is **never** recorded: it fires on every prompt and would
  drown the feed. A no-op transition (`from === to`) is never recorded. An `agent.update`
  that does not change that agent's status is never recorded — steps re-emit constantly.
- **FR-30**: `sessionName` and `projectId` are captured **at record time**, not resolved
  at render, so a later rename or removal never rewrites history.
- **FR-31**: The feed is scoped by `activeProjectId`: non-null keeps only entries whose
  captured `projectId` matches (so unlinked entries drop out); `null` shows everything.
- **FR-32**: At most 40 entries render. Each row shows relative time, the session name,
  the kind's label, and the detail, tinted by tone (`error` red, `success` green,
  `active` accent, `neutral` faint). Clicking a row opens that session.
- **FR-33**: `id` is `<at>-<seq>` with a process-local counter — `Date.now()` alone
  collides, since several events routinely land in the same millisecond and React would
  see duplicate keys.

### Presentation

- **FR-34**: Relative times re-render on a 30s interval so idle rows age without an event
  (fleet-board FR-25).
- **FR-35**: With no sessions **and** no projects the whole body is replaced by a centered
  `nothing running yet` with `n new session` and `⊟ manage projects` shortcuts.
- **FR-36**: The status bar gains `o overview`, next to `d diff` and `t shell`.

## 5. API contract

`contract/overview.ts`. **Frontend-only, exactly like `fleet-board`**: no Tauri command,
no `francois://…/event` member, no new `ErrorCode`, no addition to `common.ts`. It imports
`SessionMeta` / `SessionStatus` / `ProjectId` / `SessionId` from `common.ts`, `ProjectMeta`
from `projects.ts`, and `SessionDerived` from `fleet-board.ts`, and redefines none of them.

Exported types: `DerivedMap`, `StatusCounts`, `OverviewGroup`, `FleetTotals`,
`AttentionReason`, `AttentionItem`, `ActivityKind`, `ActivityEntry`, `ActivityTone`.
Exported constants: `UNLINKED_GROUP_NAME`, `MAX_ACTIVITY`, `ACTIVITY_LABEL`.
Exported pure functions: `emptyStatusCounts`, `countByStatus`, `groupSessionsByProject`,
`computeFleetTotals`, `needsAttention`, `appendActivity`, `filterActivityByProject`,
`activityTone`, `statusTransitionKind`.

`src/features/overview/overview.ts` owns the wording helpers — `mintActivityId`,
`TotalsSegment`, `totalsSegments`, `formatGroupSubtitle`.

Store additions (`src/lib/store.ts`): `derived` + `mergeDerived` + `dropDerived` (lifted
from `Sidebar`, FR-8), `activity` + `recordActivity` (FR-27), and `'overview'` on
`MainTab`.

## 6. Data & state

**Frontend only — the Rust core is untouched by this feature.**

- `src/features/overview/OverviewView.tsx` — the dashboard (no subscription, no IPC).
- `src/features/overview/overview.ts` — presentation helpers.
- `src/features/overview/overview.test.ts` — vitest over every pure helper.
- `contract/overview.ts` — the aggregation contract.
- Changed: `src/lib/store.ts` (FR-8/FR-27/`MainTab`), `src/app/App.tsx` (tab, `o` key,
  FR-4 effect, status bar), `src/features/sessions/Sidebar.tsx` (derived lifted to the
  store, activity recorded, FR-5 `selectSession`),
  `src/features/palette/paletteCommands.ts` (`view-overview`), `src/styles.css`
  (`.ov-split` / `.ov-main` / `.ov-rail`).

**Persistence**: none. The activity log is in-memory; the initial tab is derived from
`projects`' existing `francois.activeProjectId` key and stores nothing of its own.

**Derived state**: the groups, the totals, the attention list and the scoped feed are all
recomputed with `useMemo` from `sessions` + `projects` + `derived` + `activity` +
`activeProjectId`. Nothing is cached across renders.

## 7. Edge cases & errors

| # | case | behavior |
|---|---|---|
| 1 | No sessions and no projects | FR-35 empty state with the two shortcuts. |
| 2 | Projects exist, no sessions | Groups render with `no sessions` / `—`; the strip reads `0 sessions`. |
| 3 | Sessions exist, no projects | One `unlinked` group holds them all; the `PROJECTS` section shows it. |
| 4 | A session's `projectId` names a removed project | Reads as unlinked (projects FR-18), consistent with how the core drops it on next load. |
| 5 | The active project is removed while scoped to it | `setProjects` reconciles `activeProjectId` to `null` (projects §7 case 16) → FR-4 fires → the dashboard returns. |
| 6 | Scoped to a project with no sessions | One empty group + a `0 sessions` strip. The board shows its own FR-29 empty state independently. |
| 7 | `fileCount` still `null` (seed unresolved, or not a git repo) | No diff cell, no attention row, contributes `0` to the `files` total. |
| 8 | An errored session that also has uncommitted files | One row, as an error (FR-17). |
| 9 | A running session with uncommitted files | Not in `NEEDS ATTENTION` (FR-16); its files still count in the strip. |
| 10 | The active session is filtered out by the scope | Unchanged from projects §7 case 17 — it stays `activeSessionId`; the dashboard simply does not list it. |
| 11 | Two events in the same millisecond | Distinct ids via the counter (FR-33). |
| 12 | More than 200 events | Oldest fall off; the buffer stays at `MAX_ACTIVITY` (FR-27). |
| 13 | A session is renamed after an entry was recorded | The entry keeps the old name (FR-30) — it is a record of what happened. |
| 14 | A session is removed | Its `removed` entry survives in the feed; clicking it selects a nonexistent id, which the main pane already renders as its "select a session" empty state. |
| 15 | Left/right columns both hidden (`[` and `]`) | The dashboard widens; under 860px the activity rail stacks beneath the rollup (`.ov-split`). |
| 16 | `o` pressed with a modal open, an input focused, or the terminal focused | Swallowed by the existing global-key guards (FR-2). |
| 17 | A project whose root is missing | Group renders with the `missing` tag; its sessions still list normally (they may still be running). |

## 8. Design brief

All tokens are existing `src/styles.css` app-shell variables — **this feature introduces
no new token**.

**Tab strip.** `OVERVIEW` uses the identical `tabStyle` as the other three: 11px, 700,
`0.14em` tracking, `--accent` + a 2px accent underline when on, `--text-dim` off.

**Body.** `.scz` scroll container, `14px 16px` padding.

- **Totals strip** — a baseline-aligned wrap row with a `1px solid var(--border)` bottom
  border. `FLEET`/`PROJECT` in 11px/700/`0.14em` `--accent`; each figure a 17px/500 number
  (`--text-bright` for counts, the status colour for its segment, `--accent` for agents)
  above a 10.5px `--text-faint` label; a `│` divider in `--text-disabled` between the
  counts and the segments.
- **Sections** — a 10px/700/`0.14em` `--text-dim` heading with a 10px `--text-faint`
  count, `20px` bottom margin.
- **Attention rows** — 7px/9px padding, `4px` radius, hover `--bg-elevated`, and a 2px
  left rail: `--error` for an error, `--text-disabled` for uncommitted, so the two reasons
  separate without a second hue. Name in 11.5px `--text`, detail in 10.5px (`--error` or
  `--text-hint`), relative time right in 10px `--text-faint`.
- **Group header** — name 12px/500 (`--text-bright`, or `--text-muted` when the group is
  empty), `missing` tag 9px `--error`, root 10px `--text-faint` ellipsized, subtitle right
  in 10px `--text-faint`.
- **Session rows** — 6px/9px padding, `4px` radius, selected `--bg-raised`, hover
  `--bg-elevated`. A 7px status dot (`pulse 1.4s` only while running), the name taking the
  slack, then fixed-width cells: status 44px, model 62px, ctx 62px, diff 34px, agents 30px,
  time 30px — all right-aligned so the rollup reads as a table.
- **Activity rail** — `.ov-rail`, 268px, stacking under 860px. Rows 4px/6px, 3px radius,
  hover `--bg-elevated`: a 26px 9.5px `--text-faint` time cell, then
  `<name> <verb> · <detail>` at 10.5px with the verb tinted by tone.

**Motion.** None beyond the status dot's existing `pulse`. The dashboard is a reading
surface; animating it would fight the fleet board's own pulses.

## 9. Acceptance criteria

`[x]` = covered by `src/features/overview/overview.test.ts`. `[ ]` = implemented and
typechecked, but behavioural wiring that only a run of the app exercises.

- [ ] Launching with the scope on `All projects` opens on `OVERVIEW`, not on a session. (FR-3)
- [ ] Widening the scope back to `All projects` returns the middle pane to `OVERVIEW`; scoping down to a project leaves the tab alone. (FR-4)
- [ ] Clicking a session row, or a card in pane `[1]` while on `OVERVIEW`, opens that session on the `SESSION` tab; doing it from `DIFF` stays on `DIFF`. (FR-5, FR-26)
- [ ] `o` toggles `OVERVIEW`↔`SESSION` and is swallowed by an open modal, a focused input, and the terminal. (FR-2)
- [ ] A session created from the new-session modal produces exactly one `started` entry, and restored sessions produce none. (FR-28)
- [x] The totals strip omits every zero segment and reads `all quiet` when sessions exist but nothing is happening. (FR-12, FR-14)
- [x] An unknown (`null`) diff count contributes `0` to the file total rather than `NaN`. (FR-13)
- [x] `NEEDS ATTENTION` lists errors before uncommitted work, each most-recent first, and never lists a running session. (FR-16)
- [x] An errored session with uncommitted files appears exactly once, as an error. (FR-17)
- [x] Projects owning no session still appear; the `unlinked` bucket appears last and only when non-empty. (FR-20, FR-21)
- [x] Scoping to a project hides both the other projects and the unlinked bucket. (FR-22)
- [x] A session whose `projectId` is not in the registry groups as unlinked. (FR-21, §7 case 4)
- [x] `* → running` never reaches the feed; `running → idle` reads as `finished a turn`. (FR-29)
- [x] The feed caps at 200 entries, dropping the oldest. (FR-27)
- [x] Entries minted in the same millisecond get distinct ids. (FR-33)
- [x] A renamed session's earlier feed entries keep the name they were recorded with. (FR-30)
- [ ] The dashboard issues no `diff_get_summary` of its own — the seed count per session is unchanged from before this feature. (FR-8)
- [ ] Verified in the running app: the tab renders, drills in, and the feed fills as sessions run.

## Remediation

(Empty until a review returns findings.)
