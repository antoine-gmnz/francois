---
id: split-by-4
title: Split by 4
status: frozen
branch: feat/split-by-4
created: 2026-08-05
depends_on: [split-session, app-shell, sessions-sidebar, conversation-view, diff-view, shell-terminal, collapse-right-column, agent-tab, workflow-details, fleet-board]
supersedes: split-session
loop_pass: 0
loop_phase: build
design_files: ["https://claude.ai/design/p/a4b15728-147c-4932-b83c-f60a5fc60db7?file=Francois+Redesign.dc.html"]
---

# Split by 4

## 1. Summary

`split-session` put **two** sessions side by side. This generalizes it to **up to four**, in a 2×2
grid, and adds the chrome the fourth pane forces: at three panes and up a pane stops being a small
window and becomes **one surface each** — no per-pane tab strip, a state-driven footer, the roster
folded to a 46px tile rail and the right column gone. Design source: `Francois Redesign.dc.html`
**turn 5d — Quad** (turn 5 heading: *Keeping several sessions open at once*), with turn 5b — Split
unchanged as the two-pane case.

One model replaces `split-session`'s left/right pair: an ordered list of **1–4 panes**, pane 0 being
`activeSessionId` + `mainTab` exactly as today. `▯` / `▯▯` / `⊞` in the titlebar set the count to 1 /
2 / 4; `⤢` promotes one pane to full width; `✕` drops one pane out of the grid.

## 2. Goals & non-goals

- **Goals**
  - 1–4 main panes. `▯▯` fills two, `⊞` fills up to four with the most recently active in-scope
    sessions; `✕` drops a pane (4→3→2→1) and `⤢` promotes one to full width.
  - **Two chromes.** At two panes: turn 5b exactly as shipped (per-pane Session/Diff/Shell strip,
    roster at 238px, right column folded to its 46px rail). At three or four: turn 5d — no per-pane
    tab strip, transcript only, state-driven footer, roster folded to a 46px session rail, right
    column hidden outright.
  - One focused pane owns the keyboard and the live composer; every other pane keeps streaming with
    an inert footer. `⌘1`–`⌘4` focus a pane by number, `⌥⇥` jumps to the next pane waiting on you.
  - The titlebar quota, the right column, the status bar, the palette and the single-letter globals
    all follow the focused pane — unchanged from `split-session`, generalized past two.
  - Survive quit/reopen: the pane list + focused index persist to localStorage, and a persisted
    `split-session` record still loads.
- **Non-goals**
  - **5a open tabs** and **5c attention stack** — separate specs, still.
  - Five or more panes; vertical-only stacking; a draggable divider — the grid is `1fr 1fr`.
  - Per-pane DIFF/SHELL in the 5d chrome. At three panes and up a pane shows its transcript, and
    *Review diff* promotes it to full width on DIFF instead.
  - Agent (`agent:<id>`), workflow (`workflow:<id>`) and OVERVIEW tabs inside any pane.
  - Drag-and-drop into the grid; palette entry points.
  - Any Rust/core change. No new IPC, no new persisted core state.

## 3. User stories / flows

1. **Go to four.** Four sessions exist in the project. I click `⊞`. The main pane becomes a 2×2 grid
   holding my current session plus the three most recently active others; the roster folds to a
   46px rail of two-letter tiles and the right column disappears. Pane 1 stays focused.
2. **Answer one of them.** Pane 2 shows `waiting 4m` and a permission card. Its footer reads
   `⌘2 to focus and type`. I press `⌘2` (or click it): the lime rule, the `focus` chip and the live
   composer move there, the titlebar quota and status bar re-scope to it, and I click **Allow**. The
   other three never stopped streaming.
3. **Sweep.** I press `⌥⇥` repeatedly and focus lands on each pane that is parked on an approval or
   a question, in pane order, skipping the ones that are merely working.
4. **Drop one.** Pane 3 finished; its footer reads **Review diff** · `close pane ✕`. I click `✕` and
   the grid compacts to three panes — two on top, one spanning the bottom row.
5. **Read a diff.** I click **Review diff** on a finished pane. Split ends, that session becomes the
   single active one, and the main pane opens on DIFF.
6. **Back to two.** I click `▯▯`. The grid drops to the shipped two-pane chrome: each pane gets its
   Session/Diff/Shell strip back, the roster reopens at 238px, the right column comes back as its
   46px icon rail.
7. **Reopen the roster.** In the grid I click `»` at the foot of the rail (or press `[`). The full
   238px roster comes back over the panes' width; the rail is gone until I fold it again.

## 4. Functional requirements

**The pane list**

- **FR-1** The main pane renders `paneCount` sections, `1 ≤ paneCount ≤ 4`. Pane 0's session and tab
  are `activeSessionId` and `mainTab` — unchanged meaning, so no existing consumer's semantics move.
  Panes 1..3 live in `extraPanes: PaneSlot[]`.
- **FR-2** `paneCount === 1` renders exactly what the shell renders today (single section, full
  `MainTabStrip`). `paneCount === 2` renders a `1fr 1fr` single row. `paneCount ≥ 3` renders a
  `1fr 1fr / 1fr 1fr` grid; at exactly three panes the third spans both columns of the bottom row.
  Every gap is 12px.
- **FR-3** The **layout regime** is a pure function of the count: `single` (1), `split` (2), `grid`
  (≥3). It is the only thing that selects between the two pane chromes and the two shell-column
  layouts — nothing branches on the count directly.

**Shell columns**

- **FR-4** `single`: `276 | 1fr | 296`. `split`: `238 | 1fr | (296 | 46 rail)` — as shipped.
  `grid`: `(238 | 46 rail) | 1fr | (296 | —)`; there is no right-column rail in `grid`, the column
  is either full width or absent.
- **FR-5** Entering `split` folds the right column (`showRightPane = false`); entering `grid` folds
  **both** columns (`showLeftPane = false` too). Neither fold is persisted, so leaving restores
  whatever the user had. `]` toggles the right column, `[` the left, in every regime.
- **FR-6** In `grid`, `showLeftPane === false` renders a **46px session rail** in the left track
  instead of `display:none`: one 30px tile per in-scope session carrying its first two characters, a
  status dot, and the accent left rail on the focused pane's session. Clicking a tile assigns that
  session to the focused pane. The rail ends with `+` (new session) and `»` (reopen the roster).

**Pane chrome**

- **FR-7** Every pane renders a header: its 1-based **index** (in `grid` only), a status dot, the
  session name, the `focus` chip when focused or the status label otherwise, context tokens, and
  `⤢`.
- **FR-8** In `split`, each pane also renders its own **Session · Diff · Shell** strip with its own
  diff badge, and its body follows that tab — as shipped.
- **FR-9** In `grid`, a pane renders **no tab strip**; the body is always the transcript. `⤢`
  promotes it on `session`.
- **FR-10** The focused pane renders the 2px accent top rule, `--border-focus`, `--bg-panel` and a
  live composer. Every other pane renders no rule, `--border-2`, `--bg-elevated` and an **inert
  footer** — clicking it only moves focus, never sends and never opens a caret.
- **FR-11** The inert footer is state-driven:
  - `split` → `click to focus this pane`, as shipped.
  - `grid`, session settled (`idle` / `done` / `error`) → **Review diff** · spacer · `close pane ✕`.
  - `grid`, otherwise → `› ⌘<n> to focus and type` · `✕`.
  **Review diff** leaves the grid, promoting that pane onto `diff`. `✕` removes that pane
  (FR-15).

**Focus**

- **FR-12** `focusedPaneIndex: number` names the pane that owns the keyboard; it is clamped into
  `0..paneCount-1` on every read and every write. Clicking anywhere in a pane sets it to that pane's
  index **and** `focusedPane = 'main'`.
- **FR-13** `focusedSessionId(state)` — pane `focusedPaneIndex`'s session — is what the titlebar
  quota, the right column ([3]–[6]), the status bar, the palette's session-scoped commands, the
  `n`/`a`/`d`/`t`/`w`/`c` globals and `AccountChip` read. At `paneCount === 1` it equals
  `activeSessionId`, so every consumer stays behaviour-identical outside split.
- **FR-14** `⌘1`–`⌘4` focus pane 1–4 when that pane exists (no-op otherwise), from any focus
  including a terminal. `⌥⇥` focuses the next pane after the focused one whose session
  `statusNeedsAttention`, wrapping; a no-op when none does. Both are suppressed while a modal is
  open.

**Count changes**

- **FR-15** The titlebar carries a three-button segmented control after the quota cluster: `▯`
  (single), `▯▯` (two), `⊞` (up to four). A button is **lit** when it names the layout on screen —
  `⊞` across the whole grid range, three panes and four — and lit is presentation only: a click is a
  no-op **only** when the target count already equals the current one, so `⊞` at three panes still
  adds the fourth. Splitting needs a **project**, not a second session: `▯▯` and `⊞` are disabled
  only when *entering* a split with `activeProjectId === null` or no session in scope; once split
  all three stay live, so an unsplittable scope can never strand you in a layout. `title` explains a
  disabled button. Growing the count fills the new panes with the most recently active in-scope
  sessions not already in a pane, by `lastActivityAt` desc, each on `session`, and **pads the rest
  with empty panes** (`sessionId: null`) — so a project holding one session splits into that session
  plus a pane waiting for its next. An empty pane is a real pane: it takes focus, it persists, it is
  closable, and the next session picked or created in it fills it. `openInNewPane` fills the first
  empty pane rather than appending beside it. Shrinking keeps the **focused** pane and then the
  lowest-indexed ones, empty panes included.
- **FR-16** `⤢` on any pane leaves split entirely and promotes that pane: `activeSessionId` and
  `mainTab` become that pane's session and tab.
- **FR-17** `✕` removes one pane. Removing pane 0 shifts pane 1 into its slot (`activeSessionId` /
  `mainTab` follow). `focusedPaneIndex` clamps. At `paneCount === 1` there is no `✕`.
- **FR-18** The sidebar context menu offers **Open in right pane** (at one pane) / **Open in new
  pane** (at two or three), above Rename. It fills the first empty pane, or appends one, and focuses
  it. It is hidden for a session already in a pane, at `activeProjectId === null`, and at four
  panes — it needs no second session in scope, since the row it sits on *is* the session it opens.
- **FR-19** Selecting a session anywhere (roster click, `⏎`, the rail, the palette, a freshly
  created session) assigns it to the **focused** pane. Assigning a session that already sits in
  another pane **swaps** the two panes rather than showing it twice.
- **FR-20** Entering any split clamps `mainTab` out of `overview` / `agent:<id>` / `workflow:<id>` to
  `session` and closes every agent and workflow tab (`clearAgentTabs`). While split those tabs
  cannot be opened; clicking an agent or workflow card is a no-op.
- **FR-21** Widening the scope to **All projects** (`activeProjectId === null`) leaves split,
  alongside the existing clear-agent-tabs + OVERVIEW behaviour.

**Sidebar**

- **FR-22** In `split` the two paned rows keep their shipped `left` / `right` badges. At three panes
  and up the badge is the pane **number** (`1`–`4`). Every paned row renders the selected treatment;
  only the focused pane's row carries the accent left rail.

**Persistence**

- **FR-23** `{ extraPanes, focusedPaneIndex }` persists to `localStorage` under `francois.split` as
  one JSON record, written on every change, read once at store creation. A malformed, non-object or
  partial value degrades to not-split without throwing. A **legacy** `split-session` record
  (`{ splitSessionId, splitTab, focusedSide }`) is read as one extra pane.
- **FR-24** On hydration, any persisted pane whose session is not in the session list is dropped;
  if that empties the list the app opens single-pane. An **empty** pane is not stale — it is a
  layout the user chose, and it survives the reload waiting for its session.

**Per-session correctness**

- **FR-25** A session's PTY shell stays visible while **any** pane shows it on SHELL —
  `isShellVisible` tests every pane.
- **FR-26** Notifications suppress `turnDone` for **every** visible session, not just the focused
  one, when the window is focused.
- **FR-27** Removing a session removes it from every pane and the grid compacts. If that was pane 0,
  the reassigned session takes the slot and any duplicate pane is dropped — a session is never shown
  twice.

## 5. API contract

**No IPC surface.** Frontend-only: no Tauri command, no event, no serde struct, and therefore **no
`contract/split-by-4.ts`** — `contract/` is unchanged. The interface to pin down is the layout-store
state in `src/lib/layoutStore.ts` and the props it threads.

```ts
// src/lib/layoutStore.ts — replaces split-session's SplitState
import type { SessionId } from '../../contract/common';

/** The three tabs a pane can show. A strict subset of MainTab. */
export type PaneTab = 'session' | 'diff' | 'shell';
export type LayoutRegime = 'single' | 'split' | 'grid';

export const MAX_PANES = 4;
export const SPLIT_STORAGE_KEY = 'francois.split';   // FR-23

/** One pane AFTER pane 0 (which is `activeSessionId` + `mainTab`).
 *  `sessionId: null` is an EMPTY pane (FR-15) — pane 0 has always been able to
 *  hold nothing, so this only makes the extras agree with it. */
export interface PaneSlot { sessionId: SessionId | null; tab: PaneTab; }

export interface SplitState {
  extraPanes: PaneSlot[];      // length 0..MAX_PANES-1
  focusedPaneIndex: number;    // 0..extraPanes.length
}

export interface LayoutSlice {
  // …existing members unchanged…
  extraPanes: PaneSlot[];
  focusedPaneIndex: number;
  /** FR-18/FR-19: append a pane holding `sessionId` and focus it. Focuses the
   *  existing pane instead when it already holds that session; swaps when it is
   *  pane 0's. No-op at MAX_PANES. Applies FR-5 and FR-20. */
  openInNewPane: (sessionId: SessionId) => void;
  /** FR-15: the titlebar control — grow to / shrink to `n` panes (1..MAX_PANES). */
  setPaneCount: (n: number, inScope: readonly SessionMeta[]) => void;
  /** FR-16: leave split, keeping pane `index`'s session + tab (default: focused). */
  unsplit: (index?: number, tab?: PaneTab) => void;
  /** FR-17. */
  closePane: (index: number) => void;
  setPaneTab: (index: number, tab: PaneTab) => void;
  /** FR-12. Also sets focusedPane = 'main'. */
  setFocusedPaneIndex: (index: number) => void;
  /** FR-14: `⌥⇥`. */
  focusNextWaitingPane: () => void;
}

// ---- pure selectors, exported for tests ----
export function paneCount(s: Pick<AppState, 'extraPanes'>): number;
export function layoutRegime(count: number): LayoutRegime;
export function paneSessionIdAt(s, i: number): SessionId | null;
export function paneTabAt(s, i: number): PaneTab;
export function paneIndexOf(s, sessionId: SessionId): number | null;
export function focusedSessionId(s): SessionId | null;      // FR-13
export function focusedTab(s): MainTab;
export function visibleSessionIds(s): SessionId[];          // FR-26
export function isShellVisible(s, sessionId): boolean;      // FR-25
export function clampPaneIndex(i: number, count: number): number;
/** FR-15: one segmented-control button's `{ on, disabled, actionable }`.
 *  `on` is presentation only — the click gate is `actionable`. */
export function layoutModeState(target: number, panes: number, canSplit: boolean): LayoutModeState;
/** FR-23: normalizes localStorage, including the legacy split-session record. */
export function parseSplitState(raw: string | null): SplitState;
```

```ts
// src/app/appShell.ts — additions (re-exported from layoutStore, per split-session)
/** FR-15: the `n` most recently active in-scope sessions not in `taken`, desc. */
export function splitCandidates(sessions: readonly SessionMeta[], taken: readonly SessionId[], n: number): SessionMeta[];
/** FR-15: kept — `splitCandidates(sessions, [exclude], 1)[0] ?? null`. */
export function splitCandidate(sessions: readonly SessionMeta[], exclude: SessionId | null): SessionMeta | null;
/** FR-20: MainTab → the PaneTab a pane can show; overview/agent:/workflow: clamp. */
export function clampToPaneTab(tab: MainTab): PaneTab;
```

Component props (all additive; existing call sites keep compiling):

```ts
// src/app/SplitPane.tsx
export interface SplitPaneProps {
  index: number;                  // 0-based; rendered 1-based in `grid` (FR-7)
  sessionId: SessionId | null;
  tab: PaneTab;
  focused: boolean;
  dense: boolean;                 // FR-9: the `grid` chrome
  home: string;
  onFocus: () => void;
  onTab: (tab: PaneTab) => void;
  onPromote: () => void;          // ⤢ — FR-16
  onClose?: () => void;           // ✕ — FR-17; absent ⇒ not closable
  onReviewDiff?: () => void;      // FR-11
}

// src/app/SessionRail.tsx — new (FR-6)
export interface SessionRailProps { onSelect: (id: SessionId) => void }

// src/features/conversation/ConversationView.tsx
export interface ConversationViewProps {
  sessionId: string;
  inert?: boolean;
  onFocusRequest?: () => void;
  inertFooter?: ReactNode;        // FR-11: replaces the default inert strip
}

// src/features/sessions/SessionContextMenu.tsx
onOpenInNewPane?: (sessionId: SessionId) => void;   // FR-18; absent ⇒ item hidden
openInNewPaneLabel?: string;

// src/features/sessions/SessionListBody.tsx
paneIndexOf?: (sessionId: string) => number | null;   // FR-22
paneCount?: number;
focusedPaneIndex?: number;
```

## 6. Data & state

- **Core (Rust)**: unchanged. No new state, no new persistence.
- **Frontend**: `extraPanes` + `focusedPaneIndex` in `LayoutSlice`, persisted as one localStorage
  record. `activeSessionId` and `mainTab` keep their exact current meaning — **pane 0** — so pane 0
  never remounts when focus moves and no existing consumer changes semantics.
- **Derived**: `focusedSessionId` / `focusedTab` (§5) — computed, never stored. Every call site that
  means *the session the user is looking at* already reads them (`UsageBar`, `StatusBar`,
  `AgentsPanel`/`McpPanel`/`SkillsPanel`/`WorkflowsPanel` keys, `useAppShortcuts`, the palette,
  `AccountChip`, `attachments.projectIdOf`); they are unchanged apart from being generalized past
  two panes. Call sites that mean *pane 0* (`Sidebar`'s selection rail, `reassignAfterRemoval`,
  `useRowCursorClamp`) keep reading `activeSessionId`.
- **N-session reads**: `isShellVisible` (FR-25) and the notification visible-set (FR-26) walk every
  pane, not a fixed pair.

## 7. Edge cases & errors

No error codes — nothing here crosses IPC. Every case is a UI state.

1. **All-projects scope, or a project with no session at all** → `▯▯` and `⊞` disabled with a
   `title`; the context-menu item hidden (FR-15, FR-18).
2. **`⊞` with fewer than 4 sessions in scope** → the remaining panes are empty and say so, offering
   *New session* (FR-15). At exactly 3 the third pane spans the bottom row (FR-2).
3. **A paned session removed** → dropped from its pane, grid compacts; pane 0's removal reassigns
   and de-duplicates (FR-27).
4. **Assigning a session that is already in another pane** → the two panes swap; never twice (FR-19).
5. **Persisted panes missing on reload** → dropped, record rewritten clean (FR-24).
6. **Malformed `francois.split` JSON / localStorage unavailable** → not split, no throw (FR-23).
7. **A legacy `split-session` record** → loads as one extra pane (FR-23).
8. **Window too narrow for four panes** — the grid renders anyway; the panes just get cramped. No
   automatic collapse, no min-width guard.
9. **`⤢` / `✕` on an unfocused pane** → acts on *that* pane; focus follows (FR-16, FR-17).
10. **Agent or workflow card clicked while split** → no-op (FR-20).
11. **`⌥⇥` on Windows** — the OS owns Alt+Tab, so the shortcut is reachable on macOS only. `⌘1`–`⌘4`
    (Ctrl on Windows) work everywhere.
12. **`⌘5`+** → no-op; there is no fifth pane.
13. **Three panes** (reached by closing one of four, or by two *Open in new pane*) → all three
    control buttons act: `▯`→1, `▯▯`→2, `⊞`→4, even though `⊞` reads as pressed (FR-15).

## 8. Design brief

Source of truth: `Francois Redesign.dc.html` **turn 5d — Quad**, 1280×800, with **turn 5b — Split**
still governing the two-pane case. Shell columns go `276 | 1fr | 296` → `46 | 1fr` in the grid; the
main pane becomes `1fr 1fr / 1fr 1fr` with a 12px gap. The focused pane carries a 2px `--accent` top
rule, a `focus` chip (`--bg-app` on `--accent`) and a live composer; every other pane sits on
`--bg-elevated` with a `--text-disabled` footer. Pane headers gain a monospace index; unfocused
footers carry `⌘<n> to focus and type` or *Review diff* · *close pane ✕*. The roster's tiles are
30px, two characters, monospace, with a 7px status dot at the top-right corner. The titlebar
segmented control gains `⊞`; the status bar reads `⌘1–<n> focus pane`, `⌥⇥ next waiting` and
`<n> panes · <m> sessions open`.

## 9. Acceptance criteria

- [ ] `⊞` fills up to four panes in a 2×2 grid with the most recently active in-scope sessions, and
      is disabled with an explanatory `title` only at All-projects scope or with no session in scope
      (FR-1, FR-2, FR-15).
- [ ] A project holding a single session still splits: the second pane reads *pane 2 is empty* and
      offers **New session**, and the session created there lands in it (FR-15, FR-19).
- [ ] At three or four panes the roster is a 46px tile rail, the right column is gone, and no pane
      shows a tab strip (FR-4, FR-6, FR-9).
- [ ] Clicking a pane — or pressing `⌘2`/`⌘3`/`⌘4` — moves the lime rule, the `focus` chip, the live
      composer, the titlebar quota, the right column's counts and the status bar to it (FR-10,
      FR-12, FR-13, FR-14).
- [ ] `⌥⇥` lands on each pane parked on an approval or a question, skipping the working ones (FR-14).
- [ ] Every unfocused pane keeps streaming and its footer never accepts a keystroke (FR-10, FR-11).
- [ ] A finished pane offers **Review diff** (promotes it onto DIFF) and `close pane ✕` (compacts
      the grid) (FR-11, FR-16, FR-17).
- [ ] `▯▯` from the grid returns to the shipped two-pane chrome — per-pane Session/Diff/Shell strips,
      238px roster, 46px right rail (FR-3, FR-4, FR-8, FR-15).
- [ ] `[` reopens the roster over the grid and `»` in the rail does the same; `]` brings the right
      column back (FR-5).
- [ ] The roster badges each paned row — `left`/`right` at two panes, `1`–`4` above (FR-22).
- [ ] Quitting and reopening restores the same panes and focused index; a session that no longer
      exists is dropped; a `split-session` record still loads (FR-23, FR-24).
- [ ] A shell in any pane keeps receiving output while that pane is on SHELL (FR-25).
- [ ] Removing a session drops it from its pane and never leaves it shown twice (FR-27).
- [ ] `npx tsc --noEmit` clean; `npm test` green, including `parseSplitState` (both record shapes),
      `splitCandidates`, `clampToPaneTab`, `layoutRegime`, `clampPaneIndex`, `focusedSessionId`,
      `paneIndexOf`, `openInNewPane`/`setPaneCount`/`closePane`/`unsplit` behaviour,
      `focusNextWaitingPane`, `isShellVisible` across panes, empty-pane padding/filling/persistence,
      `layoutModeState` across every pane count (three included), and the notification visible-set.
