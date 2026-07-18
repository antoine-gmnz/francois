---
id: app-shell
title: App Shell
status: frozen
created: 2026-07-18
depends_on: [session-engine]
---

# App Shell

## 1. Summary

The app shell is the application frame everything else mounts into: the custom window chrome (title bar + window controls), the three-column TUI grid that hosts the five panes and the main pane's tab strip, the focus model shared across those panes, the status bar, the global keyboard shortcut registry, and the design-tokens module that every other feature's styling is built on. It owns layout, chrome, and cross-cutting behavior (focus, tabs, keybindings) — it does not own the content rendered inside any pane or tab, which belongs to the feature that owns that domain (sessions-sidebar, conversation-view, diff-view, shell-terminal, agents-panel, mcp-panel, skills-panel, command-palette).

## 2. Goals & non-goals

- **Goals**:
  - Custom, frameless window chrome: title bar with window controls, centered app/project title, live "N agents running" indicator.
  - The three-column / two-row CSS grid layout at the pixel values, gaps, and panel styling shown in the mock.
  - A reusable pane "chrome" (border, focus ring, header title/count/hotkey) for the 5 focusable panes.
  - The main pane's container and its SESSION / DIFF / SHELL tab strip, including the DIFF badge slot and active-tab visuals.
  - The 5-pane focus model (`focusedPane`) with keyboard and mouse activation.
  - The always-visible status bar with the exact keymap hints, focus label, and version string.
  - A single global keyboard shortcut registry, including the text-input/terminal suspension rule.
  - A design-tokens module enumerating the full palette/typography/motion constants from `PROJECT.md` §Visual design system, owned here so every other feature imports from one place.
  - The three window-control IPC channels (`francois:app:minimize|maximize|close`).
- **Non-goals**:
  - Session list content and "+ new session" behavior — `sessions-sidebar`.
  - SESSION tab transcript, input bar, and the tab-header's model/context/elapsed metadata — `conversation-view` (app-shell only reserves the layout slot, see FR-14).
  - DIFF tab file strip, unified diff view, stage/commit — `diff-view` (app-shell only renders the badge count `diff-view` supplies).
  - SHELL tab terminal content, PTY, `⌃C`/`⌃L` — `shell-terminal`.
  - Agents / MCP servers / skills list content — `agents-panel` / `mcp-panel` / `skills-panel` (app-shell only renders their pane chrome and the count they supply).
  - Command palette modal, its command registry, and its open/closed state — `command-palette`. app-shell only defines and dispatches the `togglePalette` / `dismiss` keyboard actions.
  - Claude Code process lifecycle and the `francois:session:event` channel itself — `session-engine`. app-shell only consumes two members of `SessionEvent`.
  - Window bounds/position persistence across launches — undecided per `PROJECT.md` §Open decisions; out of scope for v1.

## 3. User stories / flows

1. **Launch**: the app opens a frameless window at 1360×864. The grid renders with `focusedPane: 'main'` and `mainTab: 'session'` (matches the reference mock's initial state). Before any session exists, the title bar reads `francois · session orchestrator — no active session` and the agents indicator reads `0 agents running`.
2. **Focus by keyboard**: user presses `3` → `focusedPane` becomes `'agents'`; the agents pane border turns `#c8a15a` and its `AGENTS` title turns accent-colored; the status bar's `focus:` label updates to `agents`.
3. **Focus by mouse**: user clicks anywhere in the MCP pane (background or header, not a specific server row) → `focusedPane` becomes `'mcp'`.
4. **Diff toggle**: user presses `d` while focused on the sidebar → `focusedPane` becomes `'main'` and `mainTab` becomes `'diff'`; the DIFF tab shows accent text + bottom border and its badge. Pressing `d` again → `mainTab` returns to `'session'`. If the user was on `mainTab: 'shell'` and presses `d`, it goes straight to `'diff'` (not back to `'shell'`).
5. **Shell toggle**: same as above for `t` ↔ `'shell'`/`'session'`.
6. **Typing suspends shortcuts**: user clicks into the SESSION input bar (owned by conversation-view) and types the letter `d` — nothing happens to `mainTab`; the character is inserted normally. The user then presses `Esc` — the palette (if open) or another overlay dismisses, because `Escape` is not suspended in plain text inputs.
7. **Terminal suspends more**: user clicks into the SHELL terminal and presses `Esc` — the shell terminal receives it (app-shell's registry does not act on it); `Ctrl+K`/`Cmd+K` still opens the command palette from inside the terminal.
8. **Command palette from anywhere**: user presses `Cmd+K` (mac) or `Ctrl+K` (win/linux) while typing in the SESSION input bar → the `togglePalette` action fires regardless (delegates to `command-palette`).
9. **Window controls**: user clicks the leftmost title-bar dot → `francois:app:minimize` is invoked; the middle dot → `francois:app:maximize` (toggles maximize/restore); the rightmost dot → `francois:app:close`.
10. **Live agent counter**: a `session.meta`-selected session starts two subagents; as `agent.update` events arrive with `status: 'running'`, the title bar's dot starts pulsing and the count increments; when both agents finish (`status: 'done'`), the count returns to 0 and the dot stops pulsing — counting happens across *all* sessions, not just the active one.
11. **Switching active session**: `sessions-sidebar` writes a new `activeSessionId`. The title bar's project name updates once the matching `session.meta` event (already received or freshly emitted) is available; until then it shows the fallback text.
12. **Resize**: user resizes the window; the grid's side columns stay fixed (264px / 336px) and the main column absorbs the change (`1fr`); the right column's three sections keep their `1.3 / 0.95 / 1.05` flex ratio. Below 1040×680 the OS refuses to shrink further.

## 4. Functional requirements

### Window & title bar

- **FR-1**: The frontend boots inside a frameless Tauri window (no native title bar/menu). app-shell renders a custom title bar occupying the top 44px of the window.
- **FR-2**: Default window size is 1360×864.
- **FR-3**: Minimum window size is 1040×680, enforced via the Tauri window's `minWidth`/`minHeight` config (chosen so the 264/336 side columns and a usable main column remain visible without panel content clipping).
- **FR-4**: Title bar: height 44px, background `#191b21`, bottom border `1px solid #24262d`, horizontal padding 14px, 14px gap between its three zones (window-control dots / centered title / agents indicator).
- **FR-5**: Three 11×11px circular buttons, `#3a3d45`, 8px gap, left-aligned. Left to right they are **minimize, maximize, close** (matches the order of the channel names given in FR-6). Clicking each calls `invoke('app_minimize'|'app_maximize'|'app_close')` respectively.
- **FR-6**: The three window-control IPC channels are `francois:app:minimize`, `francois:app:maximize` (toggles maximize/restore of the focused window), `francois:app:close`; see §5 for signatures.
- **FR-7**: Center zone: `flex:1`, text centered, 12px, `0.03em` letter-spacing, reading `francois · session orchestrator — <project>` where `francois` is `#c8a15a`, both `·` and `—` separators are `#565a63`, `session orchestrator` is `#868a93`, and `<project>` is `#a9adb6`. `<project>` is the `name` field of the `SessionMeta` whose `id === activeSessionId`, kept current via `session.meta` events. When `activeSessionId` is `null`, or no matching `session.meta` has been received yet, the trailing segment reads `— no active session` with that whole segment in `#565a63` instead of `#a9adb6`/`#868a93`/accent split. Overflowing project names truncate with ellipsis inside the `flex:1` zone; the full string is available as a native tooltip.
- **FR-8**: Right zone: a 7×7px circular dot (`#d0a45c`) followed by 11px `#868a93` text reading `N agents running` (singular `1 agent running` when N = 1). `N` is the count of distinct `AgentInfo.id` values, across **all** sessions, whose most recently observed `status === 'running'`, derived purely from consuming `agent.update` `SessionEvent`s (last write per `agent.id` wins) — independent of `agents-panel`'s own per-session list and independent of `activeSessionId`. The dot animates `pulse 1.4s ease-in-out infinite` while N > 0; it is static when N = 0.

### Grid layout & panel chrome

- **FR-9**: Below the title bar, a CSS grid fills the remaining height (820px at default window size): `grid-template-columns: 264px 1fr 336px`, `grid-template-rows: 1fr 32px`, `gap: 10px`, `padding: 10px`.
- **FR-10**: Five panes mount into the grid: sidebar `[1]` (col 1 / row 1), main `[2]` (col 2 / row 1), and a right-hand flex column (col 3 / row 1, `display:flex; flex-direction:column; gap:10px; min-height:0`) stacking agents `[3]` (`flex:1.3`), MCP servers `[4]` (`flex:0.95`), and skills `[5]` (`flex:1.05`).
- **FR-11**: app-shell owns a shared pane-chrome treatment applied to all 5 panes: `border-radius:5px`, `overflow:hidden`, `min-height:0`, background `#16171c` for sidebar/agents/mcp/skills and `#131419` for main, and a 1px border whose color is the focus ring (`#c8a15a` when that pane is `focusedPane`, else `#2a2c33`).
- **FR-12**: Sidebar/agents/mcp/skills additionally get a header row (`padding:9px 12px`, bottom border `1px solid #24262d`, flex row, `justify-content:space-between`) with: a left-aligned 11px/700-weight/`0.14em`-letter-spaced title (`SESSIONS`, `AGENTS`, `MCP SERVERS`, `SKILLS`) colored `#c8a15a` when that pane is focused else `#868a93`; and a right-aligned 10px `#565a63` label reading `<count> · [<hotkey>]`, where `<count>` is supplied by the owning feature (sessions-sidebar/agents-panel/mcp-panel/skills-panel — app-shell only renders whatever number it is given) and `<hotkey>` is that pane's number key (`1`, `3`, `4`, `5`).
- **FR-13**: Clicking anywhere inside a pane's chrome (background, header, or any non-interactive area of its body) sets `focusedPane` to that pane. Interactive content inside a pane's body (list rows, buttons — owned by that pane's feature) must not prevent this from also happening (i.e. clicking a session row focuses the sidebar *and* selects the row).

### Main pane & tab strip

- **FR-14**: The main pane's header (`padding:9px 14px`, bottom border `1px solid #24262d`, flex row, `justify-content:space-between`) hosts the tab strip on the left and a reserved metadata slot on the right. The metadata slot is visible only while `mainTab === 'session'`; app-shell provides the flex slot and the visibility gate — the slot's content (model / context usage / elapsed time) and its formatting are owned by `conversation-view`.
- **FR-15**: Tab strip: three tabs, `SESSION`, `DIFF`, `SHELL`, 16px gap, each 11px/700-weight/`0.14em`-letter-spaced, `cursor:pointer`, `padding:2px 0`. The active tab (`mainTab`) renders `#c8a15a` text with a `2px solid #c8a15a` bottom border; inactive tabs render `#868a93` text with a transparent bottom border.
- **FR-16**: The `DIFF` tab label is followed by a badge: 9px text, background `#26282f`, text color `#a9adb6`, `1px 5px` padding, `border-radius:8px`, `vertical-align:middle`, containing the changed-file count supplied by `diff-view`. The badge is omitted entirely when that count is 0 or not yet known.
- **FR-17**: Clicking a tab sets `mainTab` to that tab and sets `focusedPane` to `'main'`.
- **FR-18**: Below the header, `flex:1; display:flex; flex-direction:column; min-height:0` is a single mount slot: app-shell renders exactly one of conversation-view's (`session`), diff-view's (`diff`), or shell-terminal's (`shell`) tab content based on `mainTab`, and defines nothing about their internals.

### Focus model

- **FR-19**: `focusedPane: PaneId` is one of the 5 pane ids (`'sidebar' | 'main' | 'agents' | 'mcp' | 'skills'`); default on launch is `'main'`.
- **FR-20**: The focused pane's chrome border is `1px solid #c8a15a` (see FR-11). For sidebar/agents/mcp/skills the header title additionally recolors to `#c8a15a` (see FR-12). The main pane has no static header title (it shows the tab strip instead); its focus state is communicated by the border ring alone, and is independent of which tab is active (governed separately by FR-15).
- **FR-21**: Pressing `1`–`5` sets `focusedPane` to sidebar/main/agents/mcp/skills respectively, subject to the suspension rule in FR-24.

### Status bar

- **FR-22**: A 32px bar spans the full grid width (`grid-column:1/-1; grid-row:2`), background `#16171c`, `1px solid #24262d` border, `5px` radius, `0 12px` padding, flex row, `16px` gap, base text 10.5px `#6b7079`.
- **FR-23**: Left-to-right hints, exact glyph/label text and colors (also see `STATUS_BAR_HINTS` in §5):

  | glyph | glyph color | label | label color |
  |---|---|---|---|
  | `1-5` | `#c8a15a` | switch pane | `#868a93` |
  | `⏎` | `#a9adb6` | open | `#6b7079` (inherited) |
  | `/` | `#a9adb6` | search | `#6b7079` (inherited) |
  | `⌘K` | `#c8a15a` | commands | `#868a93` |
  | `a` | `#a9adb6` | new agent | `#6b7079` (inherited) |
  | `d` | `#c8a15a` | diff | `#6b7079` (inherited) |
  | `t` | `#c8a15a` | shell | `#6b7079` (inherited) |

  The `⌘K` hint is additionally `cursor:pointer` and clicking it dispatches the same `togglePalette` action as the keyboard chord.
- **FR-24**: A `flex:1` spacer pushes the remainder right: `focus: ` (base color `#6b7079`) followed by `PANE_FOCUS_LABELS[focusedPane]` in `#c8a15a` (values: `sessions` / `session` / `agents` / `mcp` / `skills`), then the literal string `francois 0.1.0` in `#565a63`.

### Global keyboard registry

- **FR-25**: app-shell installs exactly one `keydown` listener, in the capture phase, at the window level, implementing the `KEY_BINDINGS` table from §5. On a match it calls `preventDefault()` and performs the binding's `action`.
- **FR-26**: **Suspension rule (critical).** Bindings with `scope: 'suspended-in-text-input'` (every binding except `togglePalette` and `dismiss`) do nothing when `document.activeElement` is a text-input-like element (`<input>`, `<textarea>`, `contenteditable`) **or** the SHELL terminal currently has keyboard focus — the SHELL terminal is treated as a text-input surface for this rule.
- **FR-27**: The `dismiss` binding (`Escape`) has `scope: 'suspended-in-terminal'`: it is suppressed only while the SHELL terminal has keyboard focus, and otherwise always fires — including while a plain text input (SESSION input bar, command palette filter field) has focus — so `Esc` remains available to dismiss overlays while composing text.
- **FR-28**: The `togglePalette` binding (`Cmd+K` / `Ctrl+K`) has `scope: 'global'`: it always fires, including while any text input or the SHELL terminal has focus, and is registered so it is not swallowed by xterm.js's own input handling or native `<input>` behavior (shell-terminal must not bind this chord itself).
- **FR-29**: `d` (`toggleDiff`) sets `focusedPane: 'main'` and sets `mainTab` to `'diff'` unless it is already `'diff'`, in which case it sets `'session'` (from `'shell'`, pressing `d` goes to `'diff'`, not back to `'shell'` — matches the reference mock exactly).
- **FR-30**: `t` (`toggleShell`) mirrors FR-29 for `'shell'` vs `'session'`.
- **FR-31**: `n` (`newSession`) and `a` (`newAgent`) dispatch delegated actions; app-shell does not implement session or agent creation — `sessions-sidebar` and `agents-panel` react to them.
- **FR-32**: `/` (`search`) dispatches a delegated `search` action scoped to the current `focusedPane`; each pane feature decides whether and how to react. Not implementing a search affordance for a given pane is acceptable and is that feature's decision, not app-shell's.
- **FR-33**: `Enter` (`activate`) dispatches a delegated `activate` action scoped to the current `focusedPane`; each pane feature decides what "open/activate the current selection" means.

### Design tokens & IPC errors

- **FR-34**: app-shell owns a frontend-only design-tokens module exporting the full palette, typography, and motion constants enumerated in §8 (not part of `contract/`, since it carries no IPC surface). Every other feature imports colors/timings from this module instead of hardcoding hex values.
- **FR-35**: `francois:app:minimize` / `francois:app:maximize` / `francois:app:close` resolve `Result<void>`. On `{ ok: false }` the frontend logs `error.code` and `error.message` to the console and takes no further action — app-shell defines no visible error surface for window-chrome failures in v1.

## 5. API contract

The exact interface that will live in `contract/app-shell.ts`. Imports shared types from `contract/common.ts` and never redefines them.

### IPC channels

| channel | direction | payload | `Result<T>` data | error codes |
|---|---|---|---|---|
| `francois:app:minimize` | frontend → core (`invoke`) | `void` | `void` | `INTERNAL` |
| `francois:app:maximize` | frontend → core (`invoke`) | `void` | `void` (toggles maximize/restore of the focused window) | `INTERNAL` |
| `francois:app:close` | frontend → core (`invoke`) | `void` | `void` | `INTERNAL` |

No new `ErrorCode` members are needed; these three channels only ever fail with `'INTERNAL'` (from `contract/common.ts`).

### Consumed events

app-shell does not own an event channel. It subscribes to session-engine's `francois:session:event` (payload `SessionEvent`, defined in `contract/common.ts` / owned by the `session-engine` spec) and reacts only to the two members named below — it must not redefine `SessionEvent`.

```ts
// contract/app-shell.ts — window chrome, grid layout, focus model, global keybindings.
// Imports shared vocabulary from contract/common.ts; never redefines it.

import type { SessionId, SessionEvent } from './common';

// ---------- window controls (frontend -> core, invoke) ----------
// francois:app:minimize  Promise<Result<void>>
// francois:app:maximize  Promise<Result<void>>   -- toggles maximize/restore
// francois:app:close     Promise<Result<void>>
// All three take no payload; the only error code any of them can resolve with is 'INTERNAL'.

// ---------- consumed events ----------
// app-shell subscribes to session-engine's `francois:session:event` channel and reacts
// only to these two SessionEvent members (agent.update -> title-bar agent counter,
// session.meta -> title-bar project name):
export type AppShellConsumedEvent = Extract<SessionEvent, { type: 'agent.update' | 'session.meta' }>;

// ---------- frontend store ----------

export type PaneId = 'sidebar' | 'main' | 'agents' | 'mcp' | 'skills';

export type MainTab = 'session' | 'diff' | 'shell';

export interface AppShellState {
  focusedPane: PaneId;               // default 'main'
  mainTab: MainTab;                  // default 'session'
  activeSessionId: SessionId | null; // default null.
    // WRITTEN by sessions-sidebar (session selection).
    // READ by app-shell (title-bar project name, via session.meta correlation) and by the
    // main-tab content features (conversation-view, diff-view, shell-terminal).
}

export const PANE_FOCUS_LABELS: Record<PaneId, string> = {
  sidebar: 'sessions',
  main: 'session',
  agents: 'agents',
  mcp: 'mcp',
  skills: 'skills',
};

// ---------- global keyboard registry ----------

export type KeyAction =
  | 'focusSidebar'
  | 'focusMain'
  | 'focusAgents'
  | 'focusMcp'
  | 'focusSkills'
  | 'toggleDiff'
  | 'toggleShell'
  | 'newSession'
  | 'newAgent'
  | 'search'
  | 'activate'
  | 'togglePalette'
  | 'dismiss';

/**
 * 'global'                   never suspended.
 * 'suspended-in-terminal'    suspended only while the SHELL terminal has keyboard focus.
 * 'suspended-in-text-input'  suspended while focus is in any text input OR the SHELL terminal.
 */
export type KeyScope = 'global' | 'suspended-in-terminal' | 'suspended-in-text-input';

export interface KeyBinding {
  key: string;             // KeyboardEvent.key; letters matched case-insensitively
  requiresModKey?: true;   // Cmd (mac) or Ctrl (win/linux) held; set only for togglePalette
  action: KeyAction;
  scope: KeyScope;
}

export const KEY_BINDINGS: readonly KeyBinding[] = [
  { key: '1', action: 'focusSidebar', scope: 'suspended-in-text-input' },
  { key: '2', action: 'focusMain', scope: 'suspended-in-text-input' },
  { key: '3', action: 'focusAgents', scope: 'suspended-in-text-input' },
  { key: '4', action: 'focusMcp', scope: 'suspended-in-text-input' },
  { key: '5', action: 'focusSkills', scope: 'suspended-in-text-input' },
  { key: 'd', action: 'toggleDiff', scope: 'suspended-in-text-input' },
  { key: 't', action: 'toggleShell', scope: 'suspended-in-text-input' },
  { key: 'n', action: 'newSession', scope: 'suspended-in-text-input' },
  { key: 'a', action: 'newAgent', scope: 'suspended-in-text-input' },
  { key: '/', action: 'search', scope: 'suspended-in-text-input' },
  { key: 'Enter', action: 'activate', scope: 'suspended-in-text-input' },
  { key: 'k', requiresModKey: true, action: 'togglePalette', scope: 'global' },
  { key: 'Escape', action: 'dismiss', scope: 'suspended-in-terminal' },
];

// ---------- status bar hints ----------

export interface StatusBarHint {
  glyph: string;
  label: string;
  glyphColor: string; // hex, from the design-tokens module
  labelColor: string; // hex, from the design-tokens module
}

export const STATUS_BAR_HINTS: readonly StatusBarHint[] = [
  { glyph: '1-5', label: 'switch pane', glyphColor: '#c8a15a', labelColor: '#868a93' },
  { glyph: '⏎', label: 'open', glyphColor: '#a9adb6', labelColor: '#6b7079' },
  { glyph: '/', label: 'search', glyphColor: '#a9adb6', labelColor: '#6b7079' },
  { glyph: '⌘K', label: 'commands', glyphColor: '#c8a15a', labelColor: '#868a93' },
  { glyph: 'a', label: 'new agent', glyphColor: '#a9adb6', labelColor: '#6b7079' },
  { glyph: 'd', label: 'diff', glyphColor: '#c8a15a', labelColor: '#6b7079' },
  { glyph: 't', label: 'shell', glyphColor: '#c8a15a', labelColor: '#6b7079' },
];
```

## 6. Data & state

**Rust core**: holds the single Tauri window instance app-shell's three commands act on. No other app-shell-owned state in the core; window bounds/position are not persisted across launches (v1, see §2 non-goals).

**Frontend — shared store (`AppShellState`)**: a zustand slice implementing exactly `focusedPane`, `mainTab`, `activeSessionId` as specified in §5. `activeSessionId` is written exclusively by `sessions-sidebar`; every other feature (including app-shell) only reads it. `focusedPane` and `mainTab` are written by app-shell's own click handlers and keyboard registry (and, for `newSession`/`newAgent`/`search`/`activate`, read by the delegated pane features to know which pane is "theirs" to act on).

**Frontend — app-shell-local derived state** (not part of `AppShellState`, since no other feature writes it):
- A `Map<AgentId, AgentInfo>` populated from every `agent.update` event received (across all sessions), used only to compute the title-bar's running count. This is intentionally separate from `agents-panel`'s own per-session agent list.
- A cache of the latest `SessionMeta` per `SessionId` (from `session.meta` events), used only to resolve `activeSessionId → project name` for the title bar.
- The dispatch mechanism used to deliver delegated `KeyAction`s (`newSession`, `newAgent`, `search`, `activate`, `togglePalette`, `dismiss`) to the features that own their behavior (e.g. store actions or an in-process event emitter) is an implementation detail, not part of the IPC contract, since it never crosses the Tauri command/event boundary.

**Design tokens**: a static, non-reactive module (e.g. `frontend/design/tokens.ts`) exporting the palette/typography/motion constants enumerated in §8 as plain objects/constants — not zustand state, not part of `contract/`.

**Persistence**: none owned by app-shell in v1 (window size/position, `focusedPane`, `mainTab` all reset to defaults on relaunch).

## 7. Edge cases & errors

1. **No sessions yet** (`activeSessionId === null`): title bar shows `francois · session orchestrator — no active session`; agents counter still functions (starts at 0); the grid, tab strip, and all 5 panes render normally — each pane's empty state is that pane's own feature's responsibility.
2. **`session.meta` for a non-active session**: app-shell caches it (per §6) but does not change the title bar unless its `id` matches the current `activeSessionId`.
3. **`activeSessionId` changes to a session whose `SessionMeta` hasn't arrived yet**: title bar shows the `no active session` fallback text until a matching `session.meta` event arrives.
4. **`agent.update` outlives its session**: if a session is removed (`session.removed`) without session-engine first sending a terminal `agent.update` (`done`/`idle`/`error`) for each of its running agents, app-shell's aggregate keeps counting them as running indefinitely. app-shell does not special-case `session.removed` (it is not in its consumed-event list); this is flagged as a session-engine responsibility to always terminate an agent's status before removing its session.
5. **Diff badge count unknown**: before `diff-view` has reported a count, the DIFF tab renders with no badge (same visual as count = 0).
6. **Window-control IPC failure**: `{ ok: false, error }` from any of the three channels is logged to the console (`error.code`, `error.message`); window state is left unchanged; no toast/modal (see FR-35).
7. **Double-click a window-control dot**: the Rust core's window operations (`minimize`/`maximize`/`close`) must be idempotent/no-op-safe against a rapid second invocation on an already-transitioning or already-closed window; app-shell's frontend performs no debouncing of its own.
8. **Command palette open, then a single-key shortcut is pressed**: this resolves via the existing suspension rule (FR-26) as long as `command-palette`'s filter field is implemented as a real text input — it then naturally suppresses `1`–`5`/`d`/`t`/`n`/`a`/`/`/`Enter`, while `Escape` and `Cmd/Ctrl+K` still work. If `command-palette` ever implements its filter without a real focusable text input, that spec must coordinate with this suspension rule directly.
9. **Out-of-order `agent.update`s for the same agent**: `AgentInfo` carries no sequence number or timestamp; app-shell applies last-event-received-wins with no reordering. This is an accepted limitation (session-engine's `progress` field is documented as monotonically non-decreasing per agent, which reduces but does not eliminate the risk of a stale `status` overwriting a newer one under network/IPC reordering).
10. **Very long project name**: truncates with ellipsis inside the title bar's `flex:1` center zone; the untruncated string is available via a native tooltip (`title` attribute).
11. **Window resized to its minimum (1040×680) or below**: the OS enforces the floor via `minWidth`/`minHeight`; app-shell defines no additional internal responsive breakpoints (see §8 Resize / responsive).

## 8. Design brief

### Screens / regions

Everything in `Claude Terminal.dc.html` **except** the interior of each pane's scrollable body and the command-palette modal's interior:
- Title bar: lines 31–44.
- Grid container + panel chrome (borders/backgrounds/headers only, not the `sc-for` list bodies): lines 47, 50–54, 71–88 (main header only, not lines 89–172's tab content), 176–234 (right-column wrapper + each section's chrome/header only), 236–248 (status bar).
- Command palette open/close affordance is app-shell's (via `togglePalette`/`dismiss`); the modal's own interior (lines 251–276) is `command-palette`'s.

### Components

- **TitleBar**: window-control dots, centered title, agents-running indicator.
- **WindowControlDot** (×3): minimize / maximize / close.
- **AgentsRunningIndicator**: pulsing dot + count text.
- **AppGrid**: the 264/1fr/336 × 1fr/32px grid.
- **PaneChrome** (reused for sidebar/agents/mcp/skills): border+background+radius, header (title + count/hotkey), body slot.
- **MainPaneContainer**: border+background+radius, header (TabStrip + metadata slot), body slot.
- **TabStrip**: SESSION / DIFF (+badge) / SHELL.
- **StatusBar**: keymap hints + focus label + version.
- **KeyHint**: glyph + label pair used in the status bar.

### States

- Pane chrome: unfocused (`#2a2c33` border, dim title) vs focused (`#c8a15a` border, accent title).
- Tab: inactive (`#868a93`, transparent underline) vs active (`#c8a15a`, `2px` accent underline).
- DIFF badge: present (count > 0) vs absent (count 0/unknown).
- Agents indicator: idle (N = 0, static dot) vs running (N > 0, pulsing dot, `1.4s ease-in-out infinite`, opacity 1 ↔ 0.35).
- Title bar project segment: resolved (project name shown) vs fallback (`no active session`).
- `⌘K` status-bar hint: default vs hover (`cursor:pointer`, no separate hover color specified by the mock).

### Interactions

- Click any pane's chrome → focus that pane (`focusedPane`).
- Click a tab → switch `mainTab` and focus `'main'`.
- Click a window-control dot → corresponding `francois:app:*` IPC call.
- Click the `⌘K` status-bar hint → `togglePalette`.
- Keyboard: full table in §5 (`KEY_BINDINGS`), suspension behavior per FR-26–FR-28.
- Motion: `pulse` (`1.4s ease-in-out infinite`, opacity `1 → 0.35 → 1`) on the agents-indicator dot while N > 0; `blink` (`1s step-end infinite`, opacity `1 → 0`) is used by tab-content features for streaming cursors, not by app-shell chrome itself.

### Visual notes — full token set (owned by app-shell's design-tokens module)

**Colors — surfaces & structure**
- Backdrop (outside the window): `#08090b`, radial gradient inner stop `#101116`.
- Window background: `#121318`; window border: `#2a2c33`; window radius: 9px.
- Title bar: `#191b21`; title bar border: `#24262d`.
- Panel surfaces: `#16171c` (sidebar/agents/mcp/skills), `#131419` (main), `#0f1015` (shell content background — owned by shell-terminal but sourced from this token set).
- Raised rows: `#1a1c22` (agent cards), `#1b1d23` (selected session row / user-message block / diff hunk-header background).
- Selected/hover row background: `#20222a`.
- Chips/badges: `#26282f` (DIFF badge, command-palette selected row).
- Hairline borders: `#24262d` (section dividers), `#2a2c33` (unfocused focus ring / window border), `#1d1f25` (mcp/skills row divider), `#34363f` (command-palette border).

**Colors — accent & status**
- Accent: `#c8a15a` (focus rings, active tab, prompts, cursors, hotkeys, selection markers); accent hover (links only): `#e0bd77`.
- Status: running `#d0a45c`, done/ok `#7fa07a`, error `#c46b62`, connecting `#c2b06a`, idle `#6b7079`.

**Colors — text**
- Primary: `#c4c7ce`. Bright: `#dfe2e8` / `#d3d6dc`. Dim: `#868a93`. Faint: `#565a63`. Muted mid: `#a9adb6`. Secondary body: `#b9bcc4`.

**Colors — diff tints** (used by diff-view, sourced from this token set)
- Add: `rgba(127,160,122,0.09)`. Delete: `rgba(196,107,98,0.09)`.

**Typography**
- Family: `'JetBrains Mono', ui-monospace, monospace`; weights 400 / 500 / 700.
- Sizes appearing in app-shell chrome: 9px (DIFF badge), 10px (pane count/hotkey label, meta separators), 10.5px (status bar text, title-bar agents-indicator text), 11px (pane titles, tab labels), 12px (title-bar centered title).
- Letter-spacing: `0.02em` (status text), `0.03em` (title-bar centered title), `0.14em` (pane/tab titles).

**Motion**
- `pulse`: `@keyframes pulse { 0%,100% { opacity:1 } 50% { opacity:0.35 } }`, `1.4s ease-in-out infinite`, used on running/connecting status dots (title-bar agents dot when N > 0).
- `blink`: `@keyframes blink { 0%,49% { opacity:1 } 50%,100% { opacity:0 } }`, `1s step-end infinite`, used for streaming/typing cursors (owned by conversation-view/shell-terminal/command-palette, sourced from this token set).

**Radii & spacing**
- Panel radius 5px; window radius 9px; command-palette modal radius 8px; chip/row radius 4px; badge radius 8px.
- Grid gap/padding 10px; panel header padding `9px 12px`; status bar horizontal padding 12px; main-pane header padding `9px 14px`.

**Scrollbars**
- 8px width/height thumb, `#2a2c33`, radius 4px; track transparent (mock's `.scz` utility class).

### Resize / responsive

- Window minimum 1040×680 (FR-3); below this the OS refuses further shrink, so no internal fallback/collapsed layout is defined.
- Side columns (264px sidebar, 336px right column) are fixed-width; the main column is `1fr` and absorbs all horizontal resize.
- The right column's three sections keep their `1.3 / 0.95 / 1.05` flex-basis ratio and resize proportionally with the window's height.
- Title bar (44px) and status bar (32px) are fixed height regardless of window size.
- Text that overflows fixed-width regions (project name, session paths, pane count labels) truncates with `text-overflow: ellipsis; white-space: nowrap` — no wrapping.

## 9. Acceptance criteria

- [ ] Window opens frameless at 1360×864 and cannot be resized below 1040×680 (FR-1–FR-3).
- [ ] Title bar renders the three window-control dots in minimize/maximize/close order, each wired to its `francois:app:*` IPC channel (FR-5, FR-6, §5).
- [ ] Title bar center reads `francois · session orchestrator — <project>` with the exact per-segment colors, resolves `<project>` from `session.meta` matched to `activeSessionId`, and falls back to `— no active session` when unresolved (FR-7).
- [ ] Title bar right side shows `N agents running` with a `#d0a45c` dot that pulses only when N > 0, counted across all sessions from `agent.update` events (FR-8).
- [ ] The grid renders `264px / 1fr / 336px` columns and `1fr / 32px` rows with 10px gap/padding, and the right column stacks agents/mcp/skills at `1.3/0.95/1.05` flex ratio (FR-9).
- [ ] All 5 panes show the shared chrome (border, radius, background) and, where applicable, the header title/count/hotkey pattern (FR-10–FR-12).
- [ ] Clicking any pane's chrome sets `focusedPane`; number keys `1`–`5` do the same subject to the suspension rule (FR-13, FR-21, FR-26).
- [ ] Focused pane shows a `1px solid #c8a15a` border and (for sidebar/agents/mcp/skills) an accent title; main pane's focus ring is independent of its active tab (FR-20).
- [ ] Main pane renders the SESSION/DIFF/SHELL tab strip with exact typography and active-tab styling, the DIFF badge sourced from diff-view (hidden at 0/unknown), and a metadata slot gated to `mainTab==='session'` (FR-14–FR-16).
- [ ] Clicking a tab switches `mainTab` and focuses `'main'`; exactly one tab-content mount is rendered at a time (FR-17, FR-18).
- [ ] Pressing `d`/`t` toggles `mainTab` between `diff`/`shell` and `session` per the exact mock semantics (not a strict 3-way cycle) and focuses `'main'` (FR-29, FR-30).
- [ ] Status bar renders all 7 hints with the exact glyph/label text and colors from FR-23, plus `focus: <label>` and `francois 0.1.0` (FR-22–FR-24).
- [ ] Global single-key shortcuts are suppressed while a text input or the SHELL terminal has keyboard focus; `Cmd/Ctrl+K` always works; `Escape` works everywhere except inside the SHELL terminal (FR-26–FR-28).
- [ ] `n`/`a`/`/`/`Enter` dispatch delegated actions and perform no session/agent/search/activation logic themselves (FR-31–FR-33).
- [ ] `contract/app-shell.ts` compiles and exposes exactly the channels, `AppShellState`, `PaneId`, `MainTab`, `KeyBinding`/`KEY_BINDINGS`, `PANE_FOCUS_LABELS`, and `StatusBarHint`/`STATUS_BAR_HINTS` defined in §5, importing (never redefining) `SessionId`/`SessionEvent` from `contract/common.ts`.
- [ ] A design-tokens module exists exporting the full color/typography/motion/spacing set enumerated in §8, and no other in-scope app-shell chrome element hardcodes a hex value outside it (FR-34).

## Remediation

(Empty until a review returns findings.)
