---
id: collapse-right-column
title: Collapsible right-column panels
status: shipped
created: 2026-07-31
depends_on: [app-shell, agents-panel, mcp-panel, skills-panel]
design_files: [] # none by decision (2026-07-31): §8 brief + specs/design/collapse-right-column.md is the design source
reviewed_base: 55616e66ad1fb7d2f5c10f3d49167c55de4a1b39
reviewed_digest: a93d38ff75288b72
---

# Collapsible right-column panels

## 1. Summary

The right column stacks three cards — `AGENTS [3]`, `MCP SERVERS [4]`, `SKILLS [5]` — at fixed flex
ratios (1.3 / 0.95 / 1.05) inside a 296px column, so each gets roughly a third of the window height
and all three are cramped. This feature lets a card be **collapsed to its header row**, freeing its
vertical space for the cards that stay expanded. The whole column can already be hidden with `]`;
this is the per-card version of that, so a user reading a long agent trail can fold MCP and SKILLS
away without losing their live counts.

## 2. Goals & non-goals

- **Goals**
  - Collapse/expand each right-column card independently, by mouse (header click) and keyboard (`c`).
  - Collapsed card keeps a visible header strip with its **live** count and hotkey.
  - Expanded cards absorb the freed space, keeping their relative ratios.
  - The collapsed set survives an app restart (localStorage, like `showLeftPane`/`showRightPane`).
  - Command-palette entry per card, so the feature is discoverable without the hotkey.
- **Non-goals**
  - Drag-to-resize splitters between the cards / persisted per-card heights — a possible later spec.
  - Collapsing the sessions sidebar or the main pane's cards. `[`/`]` already hide whole columns.
  - Reordering the cards.
  - Any Rust/core change: this feature adds **no IPC channel** and touches no backend state.

## 3. User stories / flows

**Fold a card away with the mouse.** A user reading a long agent activity trail clicks the
`MCP SERVERS 3 · [4]` header. The card folds to its header row; the AGENTS and SKILLS cards grow to
fill the freed height. The MCP header still reads `MCP SERVERS 3 · [4]` and its count keeps updating
as servers connect. Clicking the same header again unfolds it.

**Fold a card away from the keyboard.** The user presses `4` to focus MCP, then `c`. The card
collapses and focus hands off to the main pane (a collapsed card can't own focus). Pressing `4`
again re-focuses MCP, which expands it in the same step.

**Restart.** The user quits with MCP and SKILLS collapsed. On the next launch the right column comes
back with those two folded and AGENTS full-height.

**Palette.** The user hits `⌘K`, types "skills", and picks `Toggle skills panel` — hint reads
`collapse · [5]` or `expand · [5]` depending on the current state. If the right column is hidden,
expanding from the palette reveals the column too.

## 4. Functional requirements

**State + persistence**

- **FR-1** The layout store owns `collapsedPanes: Record<RightPane, boolean>` where
  `RightPane = 'agents' | 'mcp' | 'skills'`. Default: all `false` (expanded).
- **FR-2** `toggleCollapsedPane(pane: RightPane)` flips one entry;
  `setCollapsedPane(pane: RightPane, collapsed: boolean)` sets it explicitly.
- **FR-3** Every mutation persists the whole record as JSON under the localStorage key
  `francois.collapsedPanes`. Reads and writes are wrapped in `try/catch` — a restricted storage
  environment (or the node test env, which has no `localStorage`) degrades silently to all-expanded,
  exactly like `loadPane`/`persistPane` in `src/lib/layoutStore.ts`.
- **FR-4** A malformed, non-object, or partial stored value never throws: unknown keys are dropped,
  missing keys default to `false`, non-boolean values default to `false`.

**Invariants**

- **FR-5** A collapsed pane never owns focus. `toggleCollapsedPane`/`setCollapsedPane` that collapses
  the currently focused pane hands `focusedPane` to `'main'` — mirroring `toggleRightPane`.
- **FR-6** `setFocusedPane(p)` where `p` is a collapsed right pane **expands** `p` (and persists it),
  alongside the existing "reveal the hidden column" behavior. So `3`/`4`/`5`, `a`, and every palette
  command that focuses a pane always land on a readable card.
- **FR-7** Collapsing a card never hides the right column, and `]` (`toggleRightPane`) never changes
  `collapsedPanes`. The two toggles are independent; hiding the column preserves the collapsed set.

**Interaction**

- **FR-8** Clicking a right-column card's **header row** toggles that card's collapsed state. The
  handler calls `stopPropagation()` so the card's own `onClick` focus handler does not also fire —
  a header click changes collapse state only, never focus (beyond FR-5's hand-off).
- **FR-9** Controls already living inside a header (MCP's `+` attach button) keep their own
  `stopPropagation()` and keep working while the card is collapsed.
- **FR-10** `c` in `buildShortcutActions` collapses the focused right pane (then FR-5 moves focus to
  `main`). It is a no-op when `focusedPane` is `'sidebar'` or `'main'`. Like every other single-letter
  global it is suppressed while a modal, text input, or the terminal has focus.
- **FR-11** Three palette commands — `toggle-agents-panel`, `toggle-mcp-panel`, `toggle-skills-panel`
  (names `Toggle agents panel` / `Toggle MCP panel` / `Toggle skills panel`, glyph `▾`) — toggle one
  card each. Dynamic hint: `collapse · [n]` when expanded, `expand · [n]` when collapsed. Expanding
  from the palette also sets `showRightPane = true` if the column is hidden.

**Rendering**

- **FR-12** Each of `AgentsPanel`, `McpPanel`, `SkillsPanel` takes a `collapsed: boolean` prop and,
  when it is `true`, renders **only** its header row — body list, scroll region, empty/error states
  and `HintBar` are not rendered.
- **FR-13** The panel components stay **mounted** when collapsed (App.tsx already keeps them mounted
  behind `display:none` for the hidden column). Their feeds, event subscriptions and palette caches
  keep running, so the header count stays live while folded.
- **FR-14** Modals and overlays a panel renders (new-agent modal, MCP attach flow, kill confirm) are
  unaffected by the collapsed state and stay visible if already open.
- **FR-15** In `.app-col-right`, a collapsed card's wrapper is `flex: 0 0 auto` (its natural header
  height); expanded cards keep their current ratios (`1.3` agents / `0.95` mcp / `1.05` skills) and
  therefore share the freed space in proportion. With all three collapsed the column shows three
  stacked header strips top-aligned, with `--bg-app` below them.
- **FR-16** The header shows a leading chevron: `▾` expanded, `▸` collapsed, in `--text-dim`, and the
  header row gets `cursor: pointer` plus a hover treatment. `PanelHeader` gains optional
  `collapsed`/`onToggleCollapse` props; `McpPanel`'s hand-rolled header mirrors the same markup.

## 5. API contract

**No IPC surface.** This feature is frontend-only: no Tauri command, no event, no serde struct, and
therefore **no `contract/collapse-right-column.ts`** — `contract/` is unchanged. The interface that
must be pinned down is the layout-store slice, extending `LayoutSlice` in `src/lib/layoutStore.ts`:

```ts
export type Pane = 'sidebar' | 'main' | 'agents' | 'mcp' | 'skills'; // existing
export type RightPane = 'agents' | 'mcp' | 'skills';                 // new, exported

export type CollapsedPanes = Record<RightPane, boolean>;

export interface LayoutSlice {
  // …existing members unchanged…
  collapsedPanes: CollapsedPanes;              // default { agents: false, mcp: false, skills: false }
  toggleCollapsedPane: (pane: RightPane) => void;
  setCollapsedPane: (pane: RightPane, collapsed: boolean) => void;
}

/** Pure, exported for tests: normalizes whatever came out of localStorage (FR-4). */
export function parseCollapsedPanes(raw: string | null): CollapsedPanes;

/** localStorage key (FR-3). */
export const COLLAPSED_PANES_STORAGE_KEY = 'francois.collapsedPanes';
```

Component props (`src/ui/PanelHeader.tsx`, additive and optional so existing call sites compile):

```ts
export interface PanelHeaderProps {
  title: string;
  count: number;
  paneKey: string | number;
  focused: boolean;
  collapsed?: boolean;          // renders ▸ instead of ▾
  onToggleCollapse?: () => void; // present ⇒ header row is clickable (cursor:pointer)
}
```

`AgentsPanel`, `McpPanel`, `SkillsPanel` each gain `collapsed: boolean` to their existing props
(`{ sessionId: string | null }`).

## 6. Data & state

- **Frontend, owned here**: `collapsedPanes` in the layout slice (`src/lib/layoutStore.ts`).
- **Persistence**: `localStorage['francois.collapsedPanes']`, one JSON object. No core involvement,
  nothing written to disk by Rust, nothing per-session — the collapsed set is a window preference and
  applies to every session and project.
- **Derived**: `App.tsx` maps `collapsedPanes[p]` to the wrapper class on each of the three panel
  divs and to each panel's `collapsed` prop. Palette hints derive from `useStore.getState()`.
- **Core**: unchanged.

## 7. Edge cases & errors

| Case | Behavior |
|---|---|
| `localStorage` unavailable / throws | All cards expanded; toggles work for the session, persistence silently skipped (FR-3). |
| Stored JSON malformed or not an object | Treated as all-expanded; the next mutation overwrites it with a valid record (FR-4). |
| All three collapsed | Allowed. Column keeps its 296px width, three header strips top-aligned, `--bg-app` below (FR-15). |
| Right column hidden (`]`) while cards are collapsed | Collapsed set preserved; showing the column again restores exactly that state (FR-7). |
| `c` pressed with focus on sidebar/main | No-op (FR-10). |
| `c` pressed while a modal/input/terminal has focus | Suppressed by the existing global-key guard (FR-10). |
| Pane focused via `3`/`4`/`5`/`a`/palette while collapsed | Expands first, then focuses (FR-6). |
| No active session (`sessionId === null`) | Orthogonal — headers still render their `0 ·[n]` count, collapse works normally. |
| MCP attach flow open while the card is collapsed | Overlay stays visible and usable (FR-14). |

No `AppError` codes: nothing here can fail in a way the user must be told about.

## 8. Design brief

Per-card collapse in the right column: each card's header row gains a leading chevron (`▾` expanded /
`▸` collapsed) and becomes a click target with a hover state; collapsed cards render as a bare
header strip (~34px) keeping their live `N · [n]` count, and expanded cards absorb the freed height.
Tokens and header type stay exactly as `.panel-header` in `src/styles.css` — this adds a glyph, a
hover background, and a fold, nothing else.

> full brief: `specs/design/collapse-right-column.md`

## 9. Acceptance criteria

- [ ] Clicking any right-column card header collapses it to a header strip; clicking again expands it (FR-8, FR-12).
- [ ] A collapsed card still shows its title, live count and `[n]` hotkey, and the count keeps updating (FR-12, FR-13).
- [ ] Collapsing one card visibly grows the other two; expanded cards keep their 1.3 / 0.95 / 1.05 proportions (FR-15).
- [ ] All three cards can be collapsed; the column then shows three strips top-aligned (FR-15).
- [x] `c` collapses the focused right pane and moves focus to main; it is a no-op from sidebar/main and inside inputs/terminal/modals (FR-5, FR-10).
- [x] `3`/`4`/`5` on a collapsed pane expands and focuses it (FR-6).
- [x] `]` hides/shows the column without altering which cards are collapsed (FR-7).
- [x] `⌘K` lists `Toggle agents/MCP/skills panel` with a hint that flips between `collapse · [n]` and `expand · [n]`; expanding from the palette reveals a hidden column (FR-11).
- [ ] The collapsed set is restored after an app restart (FR-3).
- [ ] Header chevron reads `▾` when expanded and `▸` when collapsed; the header row shows a pointer cursor and hover state (FR-16).
- [ ] MCP's `+` attach button still works from a collapsed header, and an open attach overlay is unaffected (FR-9, FR-14).
- [x] `npx tsc --noEmit` clean; vitest covers the store slice (toggle, persistence round-trip, FR-4 malformed input, FR-5/FR-6 focus invariants) and the `c` shortcut action in `src/app/appShell.test.ts`.

## Remediation

### 2026-07-31 — preflight failure (cargo test)
- 2026-07-31 — 1 finding, all fixed (core: E0599 at `src-tauri/src/main.rs:45` — `Manager` added to the `use tauri::{…}` import at line 26)

### 2026-07-31 — review round 1
- 2026-07-31 — 3 findings, all fixed (frontend: `McpPanel.tsx` collapsed header now co-applies `mcp-header--clickable` + `mcp-header--collapsed`; new `src/features/palette/paletteCommands.test.ts` covers the three pane-toggle commands' hint text, run() flip and `toggleRightPanelCommand`'s reveal-on-expand; `isRightPane` exported from `layoutStore.ts` and imported by `appShell.ts` instead of duplicated)
