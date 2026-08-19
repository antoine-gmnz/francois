---
id: unbound-panes
title: Unbound panes
status: shipped
branch: feat/extend-screen-split
created: 2026-08-18
depends_on: [split-by-4, split-session, app-shell, shell-terminal, multiple-shells, projects, project-groups, sessions-sidebar, fleet-board, multi-account, wsl-filesystem, command-palette]
amends: split-by-4
loop_pass: 0
loop_phase:
reviewed_base: bf2052b758093c1d89e4e97eddf70cd3a5d09e6a
reviewed_digest: 9f4c1a19b61f67c7
design_files: []
---

# Unbound panes

## 1. Summary

`split-by-4` built the pane list on two assumptions that are now the tax rather than the design:
panes are **project-scoped** (FR-21 leaves split when you widen to All projects, `⊞` fills from
in-scope sessions, `▯▯`/`⊞` are disabled at `activeProjectId === null`) and **pane ≡ session**
(FR-19/FR-27 forbid showing a session twice, and `PaneSlot` is `{sessionId, tab}`). So the exact
moment the fleet story pays off — three repos running, one parked on a permission card — the app
drops you to one pane; and you can never keep a terminal on screen in the 3–4 pane grid.

One model change fixes both: **`PaneSlot` becomes a discriminated union** of a *session* pane and a
*shell* pane, and `activeProjectId` stops gating panes. Cross-project splits, a shell beside a
session, a terminal inside the quad, and the same session in two panes on different tabs all fall
out of it. The `shell` domain contract is rewritten in place (per the live decision) so a shell can
be owned by a **project** instead of a session.

## 2. Goals & non-goals

- **Goals**
  - `activeProjectId` filters the roster and OVERVIEW **only**; panes survive every scope change.
  - Panes may hold sessions from different projects at once, and the same session more than once on
    independent tabs.
  - A new pane kind: exactly one PTY rooted at a **registered project's root**, rendering in `split`
    and `grid` alike.
  - Project identity legible wherever two same-named sessions can meet: pane header, grid rail tile,
    roster pane badge — as a **neutral marker**, never accent.
  - Focusing a shell pane blanks nothing: the titlebar quota, [3]–[6], the status bar, the palette
    and the letter globals keep the **last focused session's** context.
- **Non-goals**
  - Widening the title-bar switcher past `all | project`, or a per-pane project scope — refused; it
    re-opens what the `project-groups` decision closed.
  - Restoring the Session·Diff·Shell strip in the grid. `split-by-4` FR-9 stands: a session pane
    shows its transcript, a shell pane shows its terminal.
  - The `multiple-shells` chip strip (6 shells, `⌘T`/`⌘W`, unread dots) inside a shell pane. One
    pane, one shell; want two terminals, open two shell panes.
  - A shell rooted at an arbitrary browsed folder **or at a session's worktree cwd** — project roots
    only this pass. The owner union makes a third variant additive later.
  - Persisting shell scrollback or shell names across restart (`multiple-shells` §Persistence holds).
  - OVERVIEW / `agent:` / `workflow:` tabs in a pane; the 5c attention stack; five+ panes; vertical
    stacking; a draggable divider.

## 3. User stories / flows

1. **Widen without losing the grid.** Four sessions across three repos are in a 2×2 grid. I switch
   the title-bar scope to *All projects*. The grid does not move; only the roster widens. Each pane
   header carries its repo's marker, so the two `main` sessions are told apart at a glance.
2. **Fill across the fleet.** At All-projects scope I click `⊞`. The panes fill with the four most
   recently active sessions in the whole fleet, whatever repo they belong to.
3. **A terminal in the quad.** Pane 3 is empty. It offers *pick a session* / *open a shell here*. I
   choose the shell and pick `acme-api`; a PTY spawns at that repo's root and stays on screen while
   the other three panes stream.
4. **Watch and type.** I assign the session already in pane 1 to pane 2 as well, and set pane 2 to
   SHELL. I now read its terminal while typing into its transcript.
5. **Focus a shell pane.** I click into the shell pane. The lime rule moves there; the titlebar
   quota, the right column and the status bar keep showing the session I was last on — nothing
   blanks. `⌘T`/`⌘W` do nothing here.
6. **Close down.** I close pane 0. The next **session** pane is promoted into it; when only shell
   panes remain, pane 0 becomes an empty session pane and the shells keep their slots below.

## 4. Functional requirements

**Scope decoupling** *(supersedes `split-by-4` FR-21 and the scope clauses of FR-15/FR-18)*

- **FR-1** `activeProjectId` filters the roster list and the OVERVIEW tab **only**. It no longer
  gates the pane list, the pane count, or any pane's contents. `split-by-4` **FR-21 is deleted** —
  widening to All projects leaves `extraPanes`, `focusedPaneIndex`, `activeSessionId` and every
  pane's tab untouched. The existing clear-agent-tabs + OVERVIEW-selection behaviour is unchanged.
- **FR-1a** OVERVIEW is **app-scoped, not pane-scoped** — `clampToPaneTab` maps `'overview'` to
  `'session'`, so no pane can render it. While `mainTab === 'overview'` the main view therefore
  shows the **full-width OVERVIEW body** and the panes **wait underneath**: `extraPanes`,
  `focusedPaneIndex` and every pane's tab are untouched, so leaving OVERVIEW restores the same
  split. Selecting OVERVIEW **never unsplits** — FR-1 keeps the auto-selection on a widen to All
  projects, so an unsplit there would destroy the panes on every scope change, which is the exact
  behaviour FR-1 deletes. The left column keeps the regime's own treatment (the 46px session rail
  in `grid`), so the roster never remounts on an OVERVIEW toggle and the waiting split stays
  legible. Pure predicate: `showsPanes(paneCount, mainTab)` in `src/app/appShell.ts`.
- **FR-2** `▯` / `▯▯` / `⊞` are **never disabled**. An empty pane is a real pane (`split-by-4`
  FR-15), so there is nothing a scope can make unsplittable. The `activeProjectId === null` clause
  in `split-by-4` FR-15 and the same clause hiding **Open in new pane** (FR-18) are both deleted;
  FR-18 stays hidden only at four panes.
- **FR-3** `splitCandidates` loses its scope argument: it returns the `n` most recently active
  sessions **in the whole fleet** not already in a pane, `lastActivityAt` desc, and the remaining
  panes pad empty. Growing the count and `openInNewPane` both read it.

**The pane model**

- **FR-4** `PaneSlot` becomes a discriminated union on `kind` (§5). Pane 0 is **always**
  `kind: 'session'` — `split-by-4` FR-1's identity (pane 0 ≡ `activeSessionId` + `mainTab`) is
  preserved verbatim, so no existing consumer's semantics move.
- **FR-5** A session may occupy **any number of panes**, each on its own tab. `split-by-4` FR-19's
  swap-on-reassign becomes a plain assign, and FR-27's de-duplication on pane-0 reassignment is
  deleted; FR-27's other half (a removed session is dropped from *every* pane, the grid compacts)
  stands. `isShellVisible` (FR-25) and the `turnDone` visible-set (FR-26) already test every pane,
  so they hold unchanged.

**Shell panes**

- **FR-6** A `kind: 'shell'` pane holds exactly **one** PTY, owned by a registered project and
  rooted at its `root`. It renders the terminal plus the existing footer, and **no** chip strip.
  `⌘T` / `⌘W` are **no-ops** while a shell pane is focused — they keep their single meaning (act on
  the SHELL tab's chip strip) and simply do not apply here, so no new PTY carve-out is documented.
  A shell pane renders no `⤢` (promoting to a full-width sessionless app is out of scope).
- **FR-7** On mount with `shellId === null`, the pane calls `shell_create` with owner
  `{ kind: 'project', projectId }` and stores the returned `ShellId` **in memory only**. On remount
  with a live `shellId` it calls `shell_ensure` with that id for scrollback replay. Spawn reuses
  `shell_spawn_target` unchanged, so `wsl-filesystem` translation and the existing consent path
  apply as they do for a session shell.
- **FR-8** A shell pane is never index 0. Closing pane 0 promotes the next **session** pane into the
  slot (not simply pane 1); if no session pane remains, **pane 0 becomes an empty session pane**
  (`sessionId: null` — an already-valid shipped state) and the shell panes keep their slots below
  it. `focusedPaneIndex` clamps as before.
- **FR-9** Four entry points, all resolving to a registered project: the **empty pane**'s two-choice
  affordance (*pick a session* / *open a shell here*), a **palette** command (*Open shell pane…*),
  the **pane header menu** (*convert this pane to a shell* / *open a shell pane beside*), and the
  roster's **project row context menu** (*Open a shell pane here*). Each picks a project when the
  entry point does not already name one.
- **FR-10** Closing a shell pane, converting it back to a session pane, or dropping it by shrinking
  the count calls `shell_dispose` on its shell. Quitting kills it with every other PTY.
- **FR-11** Shell panes render identically in `split` and `grid` — the regime governs the *session*
  pane's chrome (`split-by-4` FR-8/FR-9), and a shell pane has no tab strip in either.

**Focus fallback**

- **FR-12** The store tracks `lastFocusedSessionId`: the session of the most recently focused
  *session* pane. When the focused pane is a shell pane, `focusedSessionId` (`split-by-4` FR-13)
  resolves through it, so the titlebar quota, the right column [3]–[6], the status bar, the
  palette's session-scoped commands, `AccountChip` and the `n`/`a`/`d`/`t`/`w`/`c` globals keep
  rendering that session — **nothing blanks** (`diff-navigator`: a detail pane never blanks on a
  non-selectable row). It is `null` only when no session pane has ever been focused this run.
- **FR-13** Because focus can now cross projects **and accounts**, everything cached per
  project/account re-resolves on a `focusedSessionId` change rather than stale-rendering: the
  session-welcome `repoBrief`, DIFF state, the usage/quota meters and the account chip. Any memo
  keyed on `activeProjectId` alone is re-keyed on the focused session's `projectId` + `accountId`.

**Project identity in the chrome**

- **FR-14** A **neutral project marker** (never accent — `session-profiles`: acid marks the one
  focused surface, repeatable surfaces get a marker) renders in three places, each disambiguating
  two same-named sessions from different repos: the pane header (session and shell panes both), the
  grid session-rail tile (`split-by-4` FR-6), and the roster's pane badge (FR-22). A shell pane's
  header shows the project name in place of a session name.
- **FR-15** The grid session rail spans the **whole fleet**, ordered `lastActivityAt` desc — the
  same order `splitCandidates` uses, so the rail and `⊞` never disagree. It scrolls vertically with
  no cap; sessions currently in a pane are **pinned to the top** so a paned session is never
  scrolled out of reach. `+` and `»` stay at the foot.
- **FR-16** A roster pane badge survives a paned session that is **not in the filtered list** (it is
  simply not rendered — no phantom row), and a session badged in **two** panes renders both indices
  (`1·3`). Only the focused pane's row carries the accent left rail.

**Persistence**

- **FR-17** `francois.split` persists `{ extraPanes, focusedPaneIndex }` with the union shape. A
  shell pane persists as **`{ kind: 'shell', projectId }`** — `shellId` is runtime state and is
  stripped on write, so hydration spawns a fresh shell exactly as the SHELL tab does on first open.
  Three record generations must load: the union shape, the `split-by-4` shape (a bare
  `{sessionId, tab}` reads as `kind: 'session'`), and the legacy `split-session` shape. A shell pane
  whose `projectId` is no longer registered is dropped on hydration, like a stale session pane
  (`split-by-4` FR-24).

## 5. API contract

`contract/shell-terminal.ts` is **rewritten in place** — the `shell` domain keeps its name and its
one file (live decision: re-keying a domain never forks it into a second file). The change is that a
shell's owner becomes a union; every command and both events move from `sessionId` to `owner`.
No new `ErrorCode` — `PROJECT_NOT_FOUND` and `PROJECT_ROOT_MISSING` already exist.

```ts
// contract/shell-terminal.ts — changed members only; the rest of the file is unchanged.
import type { SessionId, ProjectId, Result } from './common';

export type ShellId = string;

/** Who a shell belongs to for its whole life. A project-owned shell is rooted at
 *  that project's `root` and has no session (unbound-panes FR-6). */
export type ShellOwner =
  | { kind: 'session'; sessionId: SessionId }
  | { kind: 'project'; projectId: ProjectId };

export interface ShellInfo {
  id: ShellId;
  owner: ShellOwner;          // was: sessionId: SessionId
  name: string;
  shellName: string;
  cwd: string;
  alive: boolean;
  exitCode?: number;
}

export interface ShellEnsurePayload { owner: ShellOwner; shellId?: ShellId }
// invoke('shell_ensure', ShellEnsurePayload): Promise<Result<ShellEnsureData>>
//   ShellEnsureData is unchanged; `shells` is the OWNER's strip (a project owner's
//   strip is its own project-owned shells only, never a session's).

export interface ShellCreatePayload { owner: ShellOwner }
// invoke('shell_create', ShellCreatePayload): Promise<Result<ShellInfo>>

// shell_restart / shell_rename / shell_dispose / shell_write / shell_resize are
// UNCHANGED — they address a ShellId and never named an owner.

export type ShellEvent =
  | { type: 'shell.data'; shellId: ShellId; owner: ShellOwner; data: string }
  | { type: 'shell.exit'; shellId: ShellId; owner: ShellOwner; exitCode: number };
```

**Core behaviour for a `project` owner.** `cwd` is the project's `root` (`PROJECT_NOT_FOUND` if the
id is not in the registry; `PROJECT_ROOT_MISSING` if the root is gone or is not a directory — both
checked **before** spawning, so a refused create spawns nothing). The runtime (`native` | `wsl`) is
resolved from that root exactly as `engine.cwd_of` does for a session. `SHELL_CAP` (6) applies per
**owner**, so `SHELL_LIMIT_REACHED` can be returned for a project too. `Registry` keys entries by
owner rather than `session_id`: `first_of_owner`, `shells_of_owner`, `count_of_owner`,
`belongs_to(shell_id, owner)`; `dispose_session_shells` disposes only `kind: 'session'` entries for
that id and is untouched by project shells.

**Frontend model** (`src/lib/layoutStore.ts` — replaces `split-by-4`'s `PaneSlot`):

```ts
import type { SessionId, ProjectId } from '../../contract/common';
import type { ShellId } from '../../contract/shell-terminal';

export type PaneTab = 'session' | 'diff' | 'shell';

/** FR-4. `sessionId: null` is still the EMPTY pane. */
export type PaneSlot =
  | { kind: 'session'; sessionId: SessionId | null; tab: PaneTab }
  | { kind: 'shell'; projectId: ProjectId; shellId: ShellId | null };  // shellId NOT persisted

export interface SplitState { extraPanes: PaneSlot[]; focusedPaneIndex: number }

export interface LayoutSlice {
  // …existing members unchanged…
  lastFocusedSessionId: SessionId | null;              // FR-12
  /** FR-9: append (or fill the first empty) shell pane rooted at `projectId`, and focus it. */
  openShellPane: (projectId: ProjectId) => void;
  /** FR-9: turn pane `index` into a shell pane. No-op at index 0 (FR-8). */
  convertPaneToShell: (index: number, projectId: ProjectId) => void;
  /** FR-7: record the spawned shell for pane `index`, in memory only. */
  setPaneShellId: (index: number, shellId: ShellId | null) => void;
}

// ---- pure selectors (signatures that CHANGE; the rest keep split-by-4's) ----
export function paneSessionIdAt(s, i: number): SessionId | null;   // null for a shell pane
export function paneIndicesOf(s, sessionId: SessionId): number[];  // was paneIndexOf — FR-5/FR-16
export function focusedSessionId(s): SessionId | null;             // FR-12 fallback
/** FR-3: no scope argument. */
export function splitCandidates(sessions: readonly SessionMeta[], taken: readonly SessionId[], n: number): SessionMeta[];
/** FR-8: the index promoted into slot 0 when pane 0 closes; null ⇒ pane 0 goes empty. */
export function promotionTarget(panes: readonly PaneSlot[]): number | null;
/** FR-15: paned sessions first, then lastActivityAt desc. */
export function railOrder(sessions: readonly SessionMeta[], paned: readonly SessionId[]): SessionMeta[];
export function parseSplitState(raw: string | null): SplitState;   // FR-17: three generations
```

`SplitPaneProps` gains `slot: PaneSlot` in place of `sessionId`/`tab`, plus
`onConvertToShell?: (projectId: ProjectId) => void`. `SessionListBody` takes
`paneIndicesOf?: (sessionId: string) => number[]`.

## 6. Data & state

- **Core**: `Registry` entries carry a `ShellOwner` instead of a `String` session id; every
  per-session helper becomes per-owner. No new persistence — shells have never survived a restart.
- **Frontend**: `extraPanes` holds the union; `lastFocusedSessionId` is new store state.
  `activeSessionId` / `mainTab` keep their exact meaning (pane 0), so pane 0 never remounts.
- **Derived**: `focusedSessionId` / `focusedTab` / `visibleSessionIds` / `isShellVisible` are
  computed, never stored; only their pane walk changes (skip shell panes, allow duplicates).
- **Persisted**: `francois.split` only. `shellId` is deliberately excluded (FR-17).

## 7. Edge cases & errors

1. **Scope widened to All projects while split** → nothing moves; roster and OVERVIEW re-filter only
   (FR-1). OVERVIEW is auto-selected as before, so it takes the main view full-width while the
   panes wait underneath — it does not unsplit (FR-1a).
1b. **OVERVIEW selected by hand while split** (nav pill, `o`, palette) → same takeover; `o` toggles
   straight back to the untouched split (FR-1a).
2. **Shell pane's project removed from the registry while open** → the pane keeps its live PTY until
   closed (the process is real); on the next hydration it is dropped (FR-17).
3. **Project root deleted on disk before spawn** → `PROJECT_ROOT_MISSING`; the pane renders the
   error in place with a *Retry*, and no PTY is spawned.
4. **`shell_create` returns `SHELL_LIMIT_REACHED`** (6 shell panes on one project) → the pane
   renders the message; no further entry point offers that project until one closes.
5. **Same session in two panes, one on SHELL** → its PTY stays visible (`split-by-4` FR-25, already
   an every-pane test) and `turnDone` stays suppressed once, not twice (FR-26).
6. **Closing pane 0 with only shell panes left** → pane 0 becomes an empty session pane (FR-8).
7. **`⌘T` / `⌘W` with a shell pane focused** → no-op (FR-6).
8. **`⤢` on a shell pane** → not rendered (FR-6). `⌥⇥` skips shell panes; they never wait on you.
9. **A `split-by-4` or `split-session` record on first load** → reads as session panes (FR-17).
10. **A persisted shell pane at index 0** (only reachable by hand-editing localStorage) → coerced to
    an empty session pane on parse (FR-4/FR-8).
11. **Rail longer than the viewport at All-projects scope** → scrolls; paned sessions pinned to the
    top so none is unreachable (FR-15).
12. **Focus moves between panes of different accounts** → quota, repoBrief, diff and the account chip
    re-resolve rather than stale-render (FR-13).

## 8. Design brief

Two new chrome shapes inside existing pane geometry, so no fresh mockups — `design_files: []`, per
the `attach-to-worktree` / `multiple-shells` / `workflow-details` precedent. A **shell pane header**
(terminal glyph, project name, project marker, `✕`; no index-free tab strip, no `⤢`), the **empty
pane's two-choice affordance** (*pick a session* / *open a shell here*), and the **neutral project
marker** (a `--text-2` monospace two/three-letter tag on `--bg-app`, never `--accent`) in the pane
header, the 30px rail tile and the roster pane badge. Base: `Francois Redesign.dc.html` turn 5b —
Split and turn 5d — Quad, unchanged otherwise.

> full brief: `specs/design/unbound-panes.md`

## 9. Acceptance criteria

- [ ] Switching the title-bar scope to *All projects* while split leaves the panes, focus and tabs
      untouched; only the roster and OVERVIEW re-filter (FR-1).
- [ ] Selecting OVERVIEW while split shows it full-width and does **not** unsplit; selecting
      Sessions again restores the same panes, focus and tabs (FR-1a).
- [ ] `▯▯` / `⊞` are never disabled, and `⊞` at All-projects scope fills from the whole fleet by
      `lastActivityAt` desc, padding with empty panes (FR-2, FR-3).
- [ ] Two panes hold sessions from different repos and each header carries a neutral project marker;
      the marker also appears on the rail tile and the roster badge (FR-14).
- [ ] The same session sits in two panes on different tabs; both stream, neither is swapped away,
      its roster row badges both indices, and its PTY stays alive (FR-5, FR-16).
- [ ] An empty pane offers *open a shell here*; picking a project spawns one PTY at its root, and
      the pane renders it with no chip strip in both `split` and `grid` (FR-6, FR-7, FR-11).
- [ ] Focusing a shell pane keeps the quota, [3]–[6], the status bar and the account chip on the
      last focused session — nothing blanks; `⌘T`/`⌘W` and `⌥⇥` do nothing there (FR-6, FR-12).
- [ ] Closing pane 0 promotes the next session pane; with only shell panes left, pane 0 becomes an
      empty session pane (FR-8).
- [ ] Closing or converting a shell pane disposes its shell; quitting kills it (FR-10).
- [ ] Quit and reopen restores a shell pane as a **fresh** shell at the same project root; an
      unregistered project's pane is dropped; `split-by-4` and `split-session` records still load
      (FR-17).
- [x] `npx tsc --noEmit` clean; `npm test` green including `parseSplitState` (all three generations,
      shell panes, index-0 coercion), `splitCandidates` unscoped, `promotionTarget`, `railOrder`,
      `paneIndicesOf` with duplicates, `focusedSessionId` fallback, `openShellPane` /
      `convertPaneToShell` / `closePane`, and the visible-set with duplicates.
- [x] `cd src-tauri && cargo test` green including `ShellOwner` serde round-trips (both variants,
      both events), per-owner cap and lookup, project-root cwd + runtime resolution, and
      `dispose_session_shells` leaving project shells alone.

## Remediation

- 2026-08-18 — 4 findings (2 CRITICAL, 2 MEDIUM), all fixed: store-hydration seed of `lastFocusedSessionId` (`src/lib/layoutStore.ts` `initialLastFocusedSessionId`), per-project shell-cap filtering across all four entry points (`shellPaneEligibleProjects`), index-0 shell-pane coercion test (`src/lib/split-by-4.test.ts`), and `project_owner_target` unit coverage for project-root cwd + WSL/native runtime resolution (`src-tauri/src/shell/commands.rs`).

- 2026-08-18 (round 2) — 4 findings (1 CRITICAL, 1 MEDIUM, 2 LOW), all fixed: pane-0 guard on the empty-pane "Open a shell here" affordance (`src/app/SplitPane.tsx`, mirroring `paneMenuEntries`), `AttachError` replaced by the canonical `AppError`/`ErrorCode` (`src/app/ProjectShellPane.tsx`; the local `IPC_ERROR` catch became `PTY_ERROR`, a real `ErrorCode` member), static inline style moved to `.split-pane__empty-choice-anchor` (`src/app/app.css`), and the `SHELL_LIMIT_REACHED` message reworded to "at most 6 shells per session or project" (`src-tauri/src/shell/commands.rs`).

- 2026-08-18 (round 3) — 4 findings (1 CRITICAL, 1 HIGH, 2 MEDIUM), all fixed: per-project `shellPaneEligibleProjects` gate on the roster project-row context menu (`src/features/sessions/Sidebar.tsx`), `skipNextRunRef` guard so the mount effect no longer re-runs `shell_ensure` after its own `onSpawned` (`src/app/ProjectShellPane.tsx`), selector-narrowed `lastFocusedSessionId` subscription via `subscribeWithSelector` (`src/lib/store.ts`), and the `Registry` test module split out to `src-tauri/src/shell/registry_tests.rs` (mod.rs 650 lines).

- 2026-08-18 (round 4) — 4 findings (1 CRITICAL, 1 HIGH, 2 MEDIUM), all fixed: `projectMarker` rendered beside `paneLabel` in `SessionCard` row 1 via a new `projectName` prop (`src/features/sessions/SessionListBody.tsx`, `src/features/sessions/sidebar.css`), `{ equalityFn: shallow }` added to the `lastFocusedSessionId` subscription so it only fires on real focus/pane-shape/session changes (`src/lib/store.ts:81-95`), the empty-pane button relabeled back to "New session" with its hint restored since no session-picker component exists (`src/app/SplitPane.tsx`), and a "Close pane" button added for `PROJECT_NOT_FOUND` via a new `onClose` prop wired from `ShellPaneSection` (`src/app/ProjectShellPane.tsx`, `src/app/SplitPane.tsx`).
