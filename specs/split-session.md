---
id: split-session
title: Split session
status: shipped
branch: feat/split-session
created: 2026-08-05
depends_on: [app-shell, sessions-sidebar, conversation-view, diff-view, shell-terminal, collapse-right-column, agent-tab, workflow-details]
loop_pass: 0
loop_phase: done
reviewed_base: b3a61023e12e08abc93a550ddf4a4e69cbd6d08f
reviewed_digest: 2780255c1c86c5c1
design_files: ["https://claude.ai/design/p/a4b15728-147c-4932-b83c-f60a5fc60db7?file=Francois+Redesign.dc.html"]
---

# Split session

## 1. Summary

Two live sessions side by side in the main pane, so you can answer one session's permission card while
the other keeps streaming edits. Today exactly one session is active and every pane reads it; this
feature adds a **second main pane** with its own session, its own SESSION/DIFF/SHELL strip and its own
composer, and one **focused side** that owns the keyboard. Design source: `Francois Redesign.dc.html`
**turn 5b — Split** (turn 5 heading: *Keeping several sessions open at once*).

## 2. Goals & non-goals

- **Goals**
  - Exactly two main panes, left + right, each showing one session's SESSION / DIFF / SHELL.
  - One focused side: lime top rule, live composer, and the titlebar quota + right column follow it.
  - The unfocused pane keeps streaming, but its composer cannot receive keystrokes.
  - Enter split from the titlebar `▯ ▯▯` control or the sidebar context menu; leave it with `⤢` on
    either pane (that pane is promoted to full width) or `▯`.
  - Survive quit/reopen: the two session ids + focused side persist to localStorage.
- **Non-goals**
  - **5a open tabs** (per-session tab strip + ⌘-number) and **5c attention stack** — separate specs.
  - Drag-and-drop into the split, and palette/keyboard entry points — deliberately dropped this pass;
    the titlebar toggle and the context menu are the two entry points.
  - Three or more panes; vertical (stacked) split; a draggable divider — the split is 1fr/1fr.
  - Agent (`agent:<id>`), workflow (`workflow:<id>`) and OVERVIEW tabs inside a split pane.
  - Any Rust/core change. No new IPC, no new persisted core state.

## 3. User stories / flows

1. **Split.** Two sessions exist in the current project. I click `▯▯` in the titlebar. The main pane
   becomes two; the left keeps my current session and tab, the right opens the most recently active
   *other* session on SESSION. The left stays focused. The roster narrows to 238px and the right
   column folds to a 46px icon rail — the ~340px the split costs.
2. **Answer the other one.** The right pane shows `waiting on you` and a permission card. I click the
   right pane; its header gets the lime rule and the `focus` chip, its composer goes live, the
   titlebar quota switches to that session, and the right column's counts re-scope to it. I click
   **Allow**. The left pane never stopped streaming.
3. **Put a specific session on the right.** I right-click a session in the roster → **Open in right
   pane**. It lands in the right pane and that side takes focus. Its row shows a `right` badge; the
   left pane's session shows a `left` badge.
4. **Promote.** I click `⤢` on the right pane. Split ends, that session becomes the single active one
   on the tab it was showing, and the right column unfolds back to 296px.
5. **Independent tabs.** The left pane is on SESSION while the right is on DIFF with a `12` badge.
   Switching one pane's tab never moves the other's.

## 4. Functional requirements

**Layout**

- **FR-1** When `splitSessionId !== null` the main pane renders two sections in a `1fr 1fr` grid with a
  12px gap; otherwise it renders exactly what it renders today (single pane, full `MainTabStrip`).
- **FR-2** In split, the left column narrows 276px → 238px, and the right column renders as a **46px
  icon rail** whenever `showRightPane === false` instead of `display:none`. `]` toggles between the
  rail and the full 296px column; `[` still hides the left column outright.
- **FR-3** Entering split sets `showRightPane = false` (folding the column to the rail) **without
  persisting** that change, so leaving split restores whatever the user had before.
- **FR-4** Each pane renders its own header (status dot, session name, `focus` chip or status label,
  context tokens, `⤢`) and its own 3-tab strip: **Session · Diff · Shell**. The Diff tab carries the
  same badge count `MainTabStrip` shows today, scoped to that pane's session.

**Focus**

- **FR-5** `focusedSide: 'left' | 'right'` names the pane that owns the keyboard. Clicking anywhere in
  a pane sets `focusedSide` to that side **and** `focusedPane = 'main'`.
- **FR-6** The focused pane renders the lime top rule, `--border-focus` border, `--bg-panel`
  background and a live composer. The unfocused pane renders no rule, `--border-2`, `--bg-elevated`,
  and an **inert composer** reading `click to focus this pane` — clicking it only moves focus, never
  sends and never opens a caret.
- **FR-7** `focusedSessionId(state)` — `focusedSide === 'right' ? splitSessionId : activeSessionId` —
  is the session the titlebar quota, the right column ([3]–[6]), the status bar, the palette's
  session-scoped commands and the `n`/`a`/`d`/`t`/`w`/`c` shortcuts read. When not split it equals
  `activeSessionId`, so every existing consumer is behaviour-identical outside split.
- **FR-8** Selecting a session in the roster (click, `⏎`, palette) assigns it to the **focused** side.
  Assigning a session to the side that already holds the other pane's session **swaps** the two panes
  rather than showing it twice.

**Enter / leave**

- **FR-9** The titlebar carries a two-button segmented control after the quota cluster: `▯` (single,
  on when not split) and `▯▯` (split, on when split). `▯▯` is **disabled** when `activeProjectId ===
  null` or fewer than two sessions are in scope; `title` explains why.
- **FR-10** `▯▯` splits with the most recently active session in scope other than `activeSessionId`
  (by `lastActivityAt` descending), on tab `session`. `▯` leaves split, keeping the **focused** pane's
  session and tab as the single active pane.
- **FR-11** The sidebar context menu gains **Open in right pane**, above Rename. It sets
  `splitSessionId` to that session, `focusedSide = 'right'`, and is hidden for the session already in
  the left pane and when `▯▯` would be disabled.
- **FR-12** `⤢` on either pane leaves split and promotes that pane: `activeSessionId` and `mainTab`
  become that pane's session and tab.
- **FR-13** Entering split clamps `mainTab` out of `overview` / `agent:<id>` / `workflow:<id>` to
  `session`, and closes every agent and workflow tab (the existing `clearAgentTabs`). While split,
  those tabs cannot be opened; clicking an agent or workflow card is a no-op.
- **FR-14** Widening the scope to **All projects** (`activeProjectId === null`) leaves split, alongside
  the existing clear-agent-tabs + OVERVIEW behaviour.

**Sidebar**

- **FR-15** In split, the session row for the left pane shows a `left` badge (`--text-hint` on
  `--bg-hover-2`) and the right pane's row a `right` badge (`--accent` on `--accent-soft-bg`). Both
  rows render the selected treatment; only the focused side's row carries the accent left rail.

**Persistence**

- **FR-16** `{ splitSessionId, splitTab, focusedSide }` persists to `localStorage` under
  `francois.split` as one JSON record, written on every change, read once at store creation. A
  malformed, non-object or partial value degrades to not-split without throwing.
- **FR-17** On reload, a persisted `splitSessionId` that is not in the hydrated session list is
  dropped — the app opens single-pane.

**Per-session correctness**

- **FR-18** A session's PTY shell stays visible while its pane is on SHELL, whichever side that is —
  `isShellVisible` stops testing the global `activeSessionId`/`mainTab` pair and tests both panes.
- **FR-19** Notifications suppress `turnDone` for **either** visible session, not just the focused
  one, when the window is focused.
- **FR-20** Removing a session that is in the right pane leaves split. Removing the session in the
  left pane behaves as today (reassign) and leaves split.

## 5. API contract

**No IPC surface.** Frontend-only: no Tauri command, no event, no serde struct, and therefore **no
`contract/split-session.ts`** — `contract/` is unchanged (same shape as `collapse-right-column`). The
interface to pin down is the new layout-store state in `src/lib/layoutStore.ts` and the props it
threads.

```ts
// src/lib/layoutStore.ts — additions to LayoutSlice
import type { SessionId } from '../../contract/common';

/** The three tabs a split pane can show. A strict subset of MainTab. */
export type PaneTab = 'session' | 'diff' | 'shell';
export type SplitSide = 'left' | 'right';

export interface SplitState {
  splitSessionId: SessionId | null; // null ⇒ not split. The RIGHT pane's session.
  splitTab: PaneTab;                // the RIGHT pane's tab; default 'session'
  focusedSide: SplitSide;           // default 'left'
}

export interface LayoutSlice {
  // …existing members unchanged…
  splitSessionId: SessionId | null;
  splitTab: PaneTab;
  focusedSide: SplitSide;
  /** FR-10/FR-11: open `sessionId` in the right pane (focusedSide → 'right'). Swaps if it is
   *  already the left pane's session (FR-8). Also applies FR-3 and FR-13. */
  openInRightPane: (sessionId: SessionId) => void;
  /** FR-10/FR-12: leave split, keeping `side`'s session + tab as the single active pane.
   *  Defaults to the focused side. No-op when not split. */
  unsplit: (side?: SplitSide) => void;
  setSplitTab: (tab: PaneTab) => void;
  /** FR-5. Also sets focusedPane = 'main'. */
  setFocusedSide: (side: SplitSide) => void;
}

/** Pure, exported for tests (FR-16): normalizes whatever came out of localStorage — a malformed,
 *  non-object, array or partially-typed value returns the not-split default. */
export function parseSplitState(raw: string | null): SplitState;

/** FR-16 */
export const SPLIT_STORAGE_KEY = 'francois.split';

/** FR-7. Exported selector, not a store member — derived, never stored. */
export function focusedSessionId(s: Pick<AppState, 'splitSessionId' | 'focusedSide' | 'activeSessionId'>): SessionId | null;
```

```ts
// src/app/appShell.ts — additions
/** FR-10: which session `▯▯` opens on the right — the most recently active in scope other than
 *  `exclude`, by lastActivityAt desc. null ⇒ `▯▯` is disabled (FR-9). */
export function splitCandidate(sessions: readonly SessionMeta[], exclude: SessionId | null): SessionMeta | null;

/** FR-13: MainTab → the PaneTab a split pane can show; overview/agent:/workflow: clamp to 'session'. */
export function clampToPaneTab(tab: MainTab): PaneTab;
```

Component props (all additive, existing call sites keep compiling):

```ts
// src/app/SplitPane.tsx — new
export interface SplitPaneProps {
  side: SplitSide;
  sessionId: SessionId | null;
  tab: PaneTab;
  focused: boolean;
  home: string;
  onFocus: () => void;
  onTab: (tab: PaneTab) => void;
  onPromote: () => void;      // ⤢ — FR-12
}

// src/features/conversation/ConversationView.tsx
export interface ConversationViewProps {
  sessionId: string;
  inert?: boolean;            // FR-6: composer renders "click to focus this pane"
  onFocusRequest?: () => void;
}

// src/features/sessions/SessionContextMenu.tsx — additive
onOpenInRightPane?: (sessionId: SessionId) => void;   // FR-11; absent ⇒ item hidden

// src/features/sessions/SessionListBody.tsx — additive
splitSessionId?: SessionId | null;   // FR-15: drives the left/right badges
focusedSide?: SplitSide;
```

## 6. Data & state

- **Core (Rust)**: unchanged. No new state, no new persistence.
- **Frontend**: three new fields in `LayoutSlice` (§5), persisted as one localStorage record.
  `activeSessionId` and `mainTab` keep their exact current meaning — **the left pane's** session and
  tab — so the left pane never remounts when focus moves and no existing consumer changes semantics.
- **Derived**: `focusedSessionId` (§5) — computed, never stored. Every call site that means *the
  session the user is looking at* migrates from `activeSessionId` to it: `UsageBar`, `StatusBar`,
  `AgentsPanel`/`McpPanel`/`SkillsPanel`/`WorkflowsPanel` keys, `useAppShortcuts`'
  `getActiveSessionId`, the palette's session-scoped commands, `AccountChip`, and
  `attachments.projectIdOf`. Call sites that mean *the left pane* (`Sidebar`'s selection rail,
  `reassignAfterRemoval`, `useRowCursorClamp`) keep reading `activeSessionId`.
- **Two-session reads**: `isShellVisible` (FR-18) and the notification visible-set (FR-19) test the
  pair `{ activeSessionId+mainTab, splitSessionId+splitTab }`, not one id.

## 7. Edge cases & errors

No error codes — nothing here crosses IPC. Every case is a UI state.

1. **Fewer than 2 sessions in scope / All-projects scope** → `▯▯` disabled with a `title`; the context
   menu item is hidden (FR-9, FR-11).
2. **Right-pane session removed** (or its project deleted) → leave split, left pane full width (FR-20).
3. **Left-pane session removed** → existing `reassignAfterRemoval` picks the next session, then split
   ends (FR-20). The right pane's session is never silently promoted into the left slot.
4. **Assigning the right pane's session to the left side (or vice versa)** → the two panes swap; never
   the same session twice (FR-8).
5. **Persisted `splitSessionId` missing on reload** → single pane, record rewritten clean (FR-17).
6. **Malformed `francois.split` JSON / localStorage unavailable** → not split, no throw (FR-16).
7. **Window too narrow for two panes** — below ~900px of main-pane width the split renders anyway; the
   panes just get cramped. Non-goal: no automatic unsplit, no min-width guard.
8. **`⤢` on the unfocused pane** → promotes *that* pane and it becomes the single active one; focus
   follows the promoted session (FR-12).
9. **Agent or workflow card clicked while split** → no-op (FR-13); the cards stay clickable-looking
   but open nothing. Leaving split restores the normal behaviour.
10. **`[` hides the left column while split** → the two panes just get wider; the rail is unaffected.

## 8. Design brief

Source of truth: `Francois Redesign.dc.html` **turn 5b — Split**, 1280×800. Shell columns go
`276 | 1fr | 296` → `238 | 1fr | 46`; the main pane becomes `1fr 1fr` with a 12px gap. The focused
pane carries a 2px `--accent` top rule, a `focus` chip (`--bg-app` on `--accent`) and a live composer;
the unfocused pane sits on `--bg-elevated` with a `--text-disabled` composer reading *click to focus
this pane*. The titlebar quota is prefixed `focused · <name>` and gains the `▯ ▯▯` segmented control.
Sidebar rows gain `left` / `right` badges.

> full brief: `specs/design/split-session.md`

## 9. Acceptance criteria

- [ ] `▯▯` splits the main pane in two, with the most recently active other session on the right, and
      is disabled with an explanatory `title` below two in-scope sessions or at All-projects scope
      (FR-1, FR-9, FR-10).
- [ ] Right-clicking a roster row offers **Open in right pane**; choosing it lands that session on the
      right and focuses that side (FR-11).
- [ ] Clicking a pane moves the lime rule, the `focus` chip, the live composer, the titlebar quota,
      the right column's counts and the status bar to it (FR-5, FR-6, FR-7).
- [ ] The unfocused pane keeps streaming and its composer never accepts a keystroke (FR-6).
- [ ] Each pane's SESSION/DIFF/SHELL strip switches independently, with its own diff badge (FR-4).
- [ ] A permission card in the unfocused pane can be answered by clicking that pane, then **Allow** —
      the other pane's turn never pauses (§3 flow 2).
- [ ] `⤢` on either pane, and `▯`, leave split keeping that pane's session and tab, and restore the
      right column to whatever it was before the split (FR-3, FR-10, FR-12).
- [ ] In split, `]` toggles the right column between the 46px rail and the full 296px column; `[`
      still hides the left column (FR-2).
- [ ] The roster shows `left` and `right` badges on the two paned sessions (FR-15).
- [ ] Quitting and reopening restores the same two panes and focused side; a session that no longer
      exists opens single-pane instead (FR-16, FR-17).
- [ ] A shell in either pane keeps receiving output while that pane is on SHELL (FR-18).
- [ ] Entering split closes agent/workflow tabs and clamps OVERVIEW to SESSION; leaving split makes
      them available again (FR-13).
- [x] `npx tsc --noEmit` clean; `npm test` green, including `parseSplitState`, `splitCandidate`,
      `clampToPaneTab`, `focusedSessionId`, `openInRightPane`/`unsplit` swap + promote behaviour,
      `isShellVisible` for both panes, and the notification visible-set.

> **DoD status (review round 2, 2026-08-05).** Only the last box above is ticked — it is the one
> criterion the pipeline mechanically verified (preflight: `npx tsc --noEmit` clean + `npm test`
> green, and the reviewer confirmed every named test exists). **Every criterion above it stays
> open**: each describes a runtime interaction (clicking a pane, answering a permission card in the
> unfocused pane, quitting and reopening, live shell output) and nothing in the pipeline runs the
> app. The reviewer verified them at code level against the spec and against
> `Francois Redesign.dc.html` and found no divergence — but that is a code read, not an exercised
> flow. Tick them by hand once you have driven the app and they held.

## Remediation

- 2026-08-05 · round 1 (REVISE — 1 CRITICAL, 1 HIGH, 3 MEDIUM, 1 LOW) — 6 findings, all fixed.
  Pane-focus threaded `SplitPane` → `ShellTabView` → `ShellTerminal` (`canFocus`, gating
  `.focus()`, the key handler and `onData`); `openInRightPane` distinct-target guard;
  swap-free `reassignActiveSessionId` + pure `nextActiveAfterRemoval`; `NewSessionModal`
  routed through the focused side; all four rail badges via a new `panelCountsStore`;
  `focusedSessionId` reused in `RightRail`. Full report: `specs/reports/split-session.md`.
