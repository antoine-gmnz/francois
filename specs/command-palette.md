---
id: command-palette
title: Command Palette (⌘K)
status: frozen
created: 2026-07-18
depends_on: [app-shell, session-engine, sessions-sidebar, diff-view, agents-panel, mcp-panel, skills-panel]
---

# Command Palette (⌘K)

## 1. Summary

The command palette is the app-wide ⌘K/Ctrl+K modal overlay: a text input over a filterable list of commands, plus an optional second filtered list ("secondary step") for commands that need one more pick (model, installed skill, running agent). It is a **pure frontend feature** — it owns no IPC channels of its own and persists no server-side state. This spec defines the command-registry API (`contract/command-palette.ts`) that every other UI feature registers against, the open/close/navigation/filtering behavior of the modal itself, and a minimal app-wide toast primitive used to surface delegated-call failures. It does **not** own the ⌘K/Ctrl+K keystroke itself: per the already-frozen `app-shell` spec, app-shell installs the single global, capture-phase `keydown` listener for the whole app (`KEY_BINDINGS`, action `'togglePalette'`, scope `'global'`) and dispatches into this feature's exported `togglePalette()` — that is what makes ⌘K work everywhere, including from inside the SHELL tab's terminal, without this feature needing any focus-state awareness of its own. Running a command means invoking the owning feature's IPC channel, or (for three of the seven built-ins) opening that feature's own overlay — this spec is the registry, not the owner of what any individual command does.

The registry is open: features beyond the seven built-ins enumerated here may register their own commands (e.g. `agents-panel`'s frozen spec already registers an eighth, "New agent") — see FR-7.

Note on domains: `PIPELINE.md` reserves the `palette` IPC domain (`francois:palette:*`) for naming consistency, but this feature defines **no channels under it** — see §2 non-goals.

## 2. Goals & non-goals

- **Goals**:
  - Define the command-registry API (`PaletteCommand`, `PaletteContext`, `SecondaryStep`) that every other UI feature registers against.
  - Own the palette's own internal state once open: which row is selected, the filter query, and the top-level/secondary-step transition — everything *inside* the 588px panel.
  - Define the seven built-in commands shown in the mock: which feature registers each, what it delegates to, its `hint`/`enabled` behavior — reconciled against the already-frozen `app-shell`, `session-engine`, `sessions-sidebar`, `agents-panel`, `mcp-panel`, and `skills-panel` specs, several of which already pin exact integration details for their own entries (cited throughout §4).
  - Define a minimal, app-wide toast primitive (`showToast`) used to surface `ok:false` results from delegated calls, since the palette closes optimistically before those calls resolve.
- **Non-goals**:
  - No IPC channels of its own — `francois:palette:*` is intentionally unused. Any async work a command performs uses the owning feature's channel (e.g. `francois:session:switchModel`), defined in that feature's own contract, not here.
  - Owning the ⌘K/Ctrl+K keystroke or the Escape/`dismiss` keystroke — both are `app-shell`'s (`KEY_BINDINGS`, per its frozen spec); this feature only exposes `togglePalette()`/reacts to a dismiss dispatch (§4).
  - No fuzzy/typo-tolerant scoring beyond ordered subsequence match; no Levenshtein.
  - No command history / most-recently-used reordering, no user-defined custom commands or macros, no multi-select.
  - No definition of *what data* populates a `SecondaryStep`'s items beyond the shape (`{id, label, hint?}`) — the exact source is owned by the registering feature's own spec (e.g. `skills-panel` §5/§6 already defines that its installed-skills cache is what backs "Run skill").
  - No general "modal stack" arbitration beyond what `app-shell`'s single `dismiss` dispatch already implies (§7).

## 3. User stories / flows

**A — Open from anywhere, run a stateless command (keyboard)**
1. User is in the SHELL tab with the xterm instance focused, mid-command.
2. User presses `Ctrl+K` (or `⌘K` on macOS). app-shell's global listener (scope `'global'`, never suspended) fires, dispatches `togglePalette`, which calls this feature's `togglePalette()`. The palette opens; the xterm instance never receives the keystroke (app-shell FR-28: shell-terminal must not bind this chord itself).
3. Palette input auto-focuses with an empty query; all enabled built-ins show in registration order, first row selected.
4. User types `diff`. List narrows to "View diff". User presses `⏎`.
5. `run(ctx)` performs the exact same `mainTab`/`focusedPane` transition as app-shell's own `d`/`toggleDiff` binding (app-shell FR-29), returns `void` → palette closes immediately. Because this command changed which main-pane tab is showing, focus does **not** restore to the pre-open element (which could be the now-hidden SHELL tab's terminal) — see FR-16's `view-diff` exception.

**B — Secondary step, success (mouse + keyboard)**
1. User opens the palette, clicks "Switch model".
2. `run(ctx)` returns a `SecondaryStep` (placeholder "switch model", items = the model catalog). Palette swaps to secondary mode: breadcrumb pill "Switch model", empty query, items listed.
3. User presses `↓` to "opus", presses `⏎`.
4. `onPick('opus')` fire-and-forget invokes `francois:session:switchModel`; palette closes immediately (optimistic).
5. The call resolves `ok:true` — no toast.

**C — Secondary step, failure**
1. Same as B, but the session finished/errored between opening the palette and the pick resolving.
2. `francois:session:switchModel` resolves `{ ok:false, error }`. Palette is already closed (per B.4). `showToast(error.message, 'error')` renders a toast over the main window for ~4s.

**D — Delegating to another feature's own overlay**
1. User opens the palette, runs "Attach MCP server".
2. `run(ctx)` returns `void`, having called mcp-panel's exposed action to open *its own* attach flow at step 1 — the same action mcp-panel's pane-4 header `+` control uses (mcp-panel FR-17). The palette closes immediately (optimistic, FR-16); mcp-panel's attach overlay (a separate component, styled after this feature's panel per mcp-panel §8 but not built from this feature's `SecondaryStep`) opens and takes over.
3. "New session" behaves identically, delegating to sessions-sidebar's own new-session modal.

**E — Back navigation**
1. User opens the palette, runs "Kill agent" → secondary step (running agents).
2. User presses `Esc`. app-shell dispatches `dismiss`; because the palette is in a secondary step, it pops to the top level: query cleared, selection reset to 0. Palette stays open.
3. User presses `Esc` again. `dismiss` is dispatched again; the palette is now at the top level, so it performs a full close. Focus returns to the element focused before step 1.
4. (Equivalent: instead of `Esc` in step 2, the user clears the secondary query to empty and presses `Backspace` once more — same result, FR-15.)

**F — No active session**
1. No session is selected (`activeSessionId === null`). User opens the palette.
2. Only "New session" and "View diff" are enabled/visible ("View diff"'s hint reads "0 files changed"); "Switch model", "Attach MCP server", "Run skill", "Compact context" are hidden (disabled); "Kill agent" is hidden (`runningAgentCount` is 0 with no session).

**G — Dismiss via backdrop**
1. User opens the palette, clicks anywhere on the dimmed backdrop outside the 588px panel.
2. Palette performs a full close regardless of level (this is a direct DOM interaction on the palette's own backdrop, not routed through app-shell's key dispatch); focus returns to the previously focused element.

## 4. Functional requirements

**Open / close (owned by app-shell, consumed here)**

- FR-1: ⌘K/Ctrl+K is app-shell's `togglePalette` `KeyBinding` (`{ key: 'k', requiresModKey: true, action: 'togglePalette', scope: 'global' }`, per the frozen app-shell spec). app-shell installs the sole window-level, capture-phase `keydown` listener for it; this feature installs no competing listener. app-shell's dispatch mechanism (an implementation detail on its side) calls this feature's exported `togglePalette()`. The same function is what the status bar's `⌘K commands` hint calls on click (app-shell design brief, FR-24/`STATUS_BAR_HINTS`).
- FR-2: On open, this feature captures `document.activeElement` as the element to restore focus to on close, then moves DOM focus to its own input. Moving focus off whatever was previously focused (e.g. xterm's hidden textarea) is what prevents further keystrokes reaching it while the palette is open.
- FR-3: Escape is app-shell's `dismiss` `KeyBinding` (scope `'suspended-in-terminal'` — suppressed only while the SHELL terminal has focus, otherwise always fires, including while this feature's own filter input has focus, since it is a real text input and `dismiss` is not in the `'suspended-in-text-input'` set). While the palette is open and receives this dispatch: if currently in a secondary step, pop to the top level (query and selection reset to empty/0, palette stays open); if already at the top level, perform a full close (FR-2 restore applies, subject to the `view-diff` exception in FR-16). Backdrop click always performs a full close regardless of level — a direct mouse interaction on the palette's own backdrop DOM, independent of app-shell's key dispatch.
- FR-4: `togglePalette()` opens if closed, closes (fully) if open. `openPalette()` / `closePalette()` are idempotent (no-op if already in the requested state). `closePalette()` always performs a full close (it does not pop a secondary step first — that distinction is FR-3's, internal to this feature, and is not part of the exported API surface).
- FR-5: Opening always starts fresh at the top level with an empty query and selection index 0, regardless of how the palette was last closed.

**Registry & filtering**

- FR-6: Each dependent feature calls `registerPaletteCommand(cmd)` once during its own bootstrap, before first paint. The seven built-ins from the mock are registered in this fixed order (this order is what an empty query displays, per FR-10):

  | order | id | owning feature |
  |---|---|---|
  | 1 | `new-session` | sessions-sidebar |
  | 2 | `switch-model` | session-engine |
  | 3 | `attach-mcp-server` | mcp-panel |
  | 4 | `run-skill` | skills-panel |
  | 5 | `view-diff` | app-shell |
  | 6 | `compact-context` | session-engine |
  | 7 | `kill-agent` | agents-panel |

  `view-diff` is registered by app-shell rather than diff-view: the action it performs (a `mainTab`/`focusedPane` transition) is app-shell's own internal state, written only by app-shell's own handlers per its spec (§6); diff-view supplies no more than the file count app-shell already derives for its own DIFF-tab badge (diff-view FR-18), which this command's `hint` reads (FR-21).
- FR-7: The registry is not limited to the seven built-ins above — any feature may call `registerPaletteCommand` for additional commands. `agents-panel`'s frozen spec, for example, already registers an eighth: `"New agent"` (glyph `⇉`, hint `"describe a task"`, `run` opens agents-panel's new-agent modal and returns `void`). FR-6's fixed order governs only the relative order of the seven commands listed there; any other registered command appears wherever its owning feature's bootstrap calls `registerPaletteCommand`, and is filtered/ranked identically to the built-ins (FR-10) once registered.
- FR-8: A command is included in the top-level list only if `enabled` is absent or `enabled(ctx)` returns `true`. Disabled commands are omitted entirely — never rendered grayed-out.
- FR-9: `PaletteContext` (see §5) is (re)computed fresh by the palette immediately before every filter/render pass while the palette is open (so `enabled`/`run` always see live values).
- FR-10: Filtering is case-insensitive ordered-subsequence match of the query against `PaletteCommand.name` (top level) or `SecondaryStepItem.label` (secondary step). A query `q` matches a string `s` iff every character of `q.toLowerCase()` occurs in `s.toLowerCase()` in order (not necessarily contiguous). Matching uses the greedy leftmost alignment: scan `s` left to right consuming characters of `q` in order; the index in `s` at which the *first* character of `q` was consumed is that entry's **match position**. Ranking: match position ascending, ties broken by `name`/`label` alphabetically (locale-independent, code-point order). An empty query matches everything and is **not** ranked by this rule — it returns entries in registration order (top level) or item-array order (secondary step).
- FR-11: Selection resets to index 0 whenever the query changes (i.e. on every keystroke that alters the filtered set). Arrow-key navigation (FR-12) does not change the query and does not reset selection.

**Keyboard & mouse navigation (scoped to the palette's own focused input — not a competing global listener, see FR-1)**

- FR-12: `↓` / `↑` move the selection by one, wrapping (from last to first / first to last). Hovering a row with the mouse also updates the selection to that row, keeping keyboard and mouse in sync. Clicking a row runs it immediately (equivalent to pressing `⏎` while it is selected).
- FR-13: `⏎` with a top-level command selected invokes that command's `run(ctx)`. `⏎` with a secondary-step item selected invokes that step's `onPick(item.id)`.
- FR-14: Because the palette's filter field is a real, focusable text input, app-shell's suspension rule (its FR-26) suppresses every `'suspended-in-text-input'` binding (`1`–`5`, `d`, `t`, `n`, `a`, `/`, `Enter`) while it has focus — none of those reach app-shell's dispatcher while typing in the palette, so `↑`/`↓`/`⏎`/character keys/`Backspace` are free for this feature's own local input handling without conflicting with app-shell's registry (app-shell edge case #8 makes this same observation).
- FR-15: `Backspace` pressed while the secondary-step query is already empty pops to the top level, identically to the dismiss-while-in-secondary case (FR-3). `Backspace` with a non-empty query edits the query normally (does not pop).

**Running a command**

- FR-16: `run(ctx)` and `onPick(id)` are called synchronously and return synchronously (`run`: `void | SecondaryStep`; `onPick`: `void`). Any asynchronous delegated call they make (an `invoke(...)` call) is fire-and-forget from the palette's point of view (FR-18). If `run` returns `void`, the palette closes immediately after the call (optimistic close) and focus restores per FR-2/FR-3 — **except** `view-diff`: because its effect changes which main-pane tab is showing (possibly navigating away from the SHELL tab), DOM focus moves to `document.body` instead of the pre-open element, so a stray keystroke cannot leak into a now-hidden terminal; the visual pane-focus ring (app-shell's `focusedPane`) reflects `'main'` regardless, via that command's own effect. If `run` returns a `SecondaryStep`, the palette enters secondary mode instead (placeholder/items render, query and selection reset, palette stays open).
- FR-17: `onPick(id)` always closes the palette immediately after invocation (same optimistic-close semantics as FR-16, restoring focus per FR-2/FR-3) — none of the three built-ins that use `SecondaryStep` (`switch-model`, `run-skill`, `kill-agent`) chain into a further step.
- FR-18: The command implementation is responsible for awaiting its own promise and calling `showToast(error.message, 'error')` if the resolved `Result` has `ok: false`, or `showToast('Command failed unexpectedly', 'error')` if the promise rejects. The palette itself never awaits or inspects these calls.
- FR-19: Because `run(ctx)` must return a `SecondaryStep` synchronously (not a `Promise`), any command that does so must already have its `items` data available synchronously at the moment `run` is called. `run-skill` and `kill-agent` satisfy this from data their registering feature already holds for its own pane (skills-panel's `skills:list` cache, skills-panel FR-16; agents-panel's per-session agent map, agents-panel FR-1–FR-4). `switch-model` has no such pre-existing shared cache in any dependency spec; session-engine's registration code is expected to fetch `francois:session:models` once (it is a static catalog that "always succeeds barring INTERNAL", session-engine FR-13) ahead of user interaction — e.g. at its own bootstrap, alongside the `registerPaletteCommand` call — and serve `run` from that local cache.

**Built-in commands**

- FR-20: Glyphs, names, and static hint text match the mock exactly (verbatim, including spacing):

  | id | glyph | name | hint (static or template) |
  |---|---|---|---|
  | `new-session` | `＋` | New session | `spin up in cwd` |
  | `switch-model` | `⇄` | Switch model | `sonnet · opus · haiku` |
  | `attach-mcp-server` | `⊞` | Attach MCP server | `from registry` |
  | `run-skill` | `✦` | Run skill | `browse installed` |
  | `view-diff` | `≡` | View diff | `{count} file{s} changed` (dynamic) |
  | `compact-context` | `⊙` | Compact context | `{used} → summary` (dynamic) |
  | `kill-agent` | `⊗` | Kill agent | `select running` |

- FR-21: `hint` takes no arguments (`() => string`, per §5) — the two dynamic hints close over the registering feature's own live state rather than reading `PaletteContext` (which is only passed to `enabled`/`run`).
  - `view-diff` hint: `` `${n} file${n === 1 ? '' : 's'} changed` `` where `n` is app-shell's own derived DIFF-tab badge count (diff-view FR-18: the `fileCount` from the latest `diff.changed` event, seeded by `getSummary`, for the active session) — `0` when there is no active session or no data has arrived yet.
  - `compact-context` hint: `` `${formatTokens(used)} → summary` `` where `used` comes from app-shell's own cached `SessionMeta` (app-shell §6: "a cache of the latest `SessionMeta` per `SessionId`") for the active session, and `formatTokens(t) = t >= 1000 ? (t/1000).toFixed(1) + 'K' : String(t)` (matches the `48.2K` convention used elsewhere in the app). If no `SessionMeta` has been cached yet for the active session (app-shell's own transient fallback window, its edge case #3), the hint renders `→ summary` with no leading token count.
- FR-22: `enabled(ctx)` per command:
  - `new-session`: always `true`.
  - `switch-model`, `attach-mcp-server`, `run-skill`, `compact-context`: `ctx.activeSessionId !== null`.
  - `view-diff`: always `true` (the DIFF tab is always reachable, even showing 0 files changed with no active session).
  - `kill-agent`: `ctx.runningAgentCount > 0`.
- FR-23: `run`/`onPick` delegation targets:
  - `new-session.run`: calls sessions-sidebar's exposed action to open its new-session modal — the same action its footer `"+ new session [n]"` control and the global `n` key use (sessions-sidebar FR-18). Returns `void`.
  - `switch-model.run`: returns a `SecondaryStep` (`placeholder: 'switch model'`, one item per cached `ModelInfo` — `id: model.id`, `label: model.label`) built from the local cache described in FR-19. `onPick(modelId)` fire-and-forget invokes `francois:session:switchModel` with `{ sessionId: ctx.activeSessionId, modelId }` (session-engine §3.4); on `ok:false`, `showToast(error.message, 'error')` (FR-18).
  - `attach-mcp-server.run`: calls mcp-panel's exposed action to open its own attach flow at step 1 — the same action its pane-4 header `+` control uses (mcp-panel FR-17). mcp-panel's attach flow is a separate overlay it owns end to end (registry list, param form, and the `francois:mcp:registry`/`francois:mcp:attach` calls) — this command does not use this feature's `SecondaryStep` and does not itself touch any `francois:mcp:*` channel. Returns `void`.
  - `run-skill.run`: returns a `SecondaryStep` (`placeholder: 'browse installed skills'`, one item per installed `SkillInfo` from skills-panel's held `skills:list` result — `id: name`, `label: name`, `hint: description`, per skills-panel FR-16). `onPick(skillName)` fire-and-forget invokes `francois:skills:run` with `{ sessionId: ctx.activeSessionId, name: skillName }` (`args` omitted — the palette path never prompts for arguments, per skills-panel flow G/FR-16); on `ok:false`, toast.
  - `view-diff.run`: performs the exact same `mainTab`/`focusedPane` transition as app-shell's own `d`/`toggleDiff` handler (app-shell FR-29: sets `focusedPane: 'main'`; sets `mainTab` to `'diff'` unless it is already `'diff'`, in which case it sets `'session'`). Because it is registered by app-shell (FR-6), this is app-shell invoking its own existing internal action, not a cross-feature call. Returns `void`. (Documented consequence: running this command while already on the DIFF tab toggles *away* from it, identically to pressing `d` a second time — an accepted, cited edge case, not a bug, see §7.)
  - `compact-context.run`: fire-and-forget invokes `francois:session:compact` with `{ sessionId: ctx.activeSessionId }` (session-engine §3.5); on `ok:false` (including `SESSION_ALREADY_RUNNING` if a turn was in flight), toast. Returns `void`.
  - `kill-agent.run`: returns a `SecondaryStep` (`placeholder: 'select running agent'`, one item per running `AgentInfo` from agents-panel's active-session agent map — `id: agent.id`, `label: agent.name`, `hint: agent.task`, per agents-panel FR-22). `onPick(agentId)` fire-and-forget invokes `francois:agents:kill` with `{ agentId }` (agents-panel FR-20); on `ok:false`, toast.

**Toasts**

- FR-24: `showToast(message, kind)` enqueues a toast; it is rendered at the app root (outside the palette's own DOM subtree), independent of whether the palette is open, and is visible above all other panes. Up to 3 toasts are visible concurrently; additional toasts queue FIFO and appear as a visible slot frees (by timeout or user dismissal).
- FR-25: Each toast auto-dismisses after 4000ms, or immediately if the user clicks it.

## 5. API contract

Everything below is the full content of `contract/command-palette.ts`. It imports only from `contract/common.ts`; no other feature contract is imported (features that consume this registry import *this* file, not the reverse).

```ts
import type { SessionId } from './common';

// ---------- registry context ----------

/**
 * Snapshot passed to `enabled` and `run`. Recomputed by the palette runtime
 * immediately before every filter/render pass while the palette is open
 * (FR-9). Sourced from other features' already-existing state — see FR-21/
 * FR-23 for exactly which cache backs each field; command-palette does not
 * own or duplicate any of it.
 */
export interface PaletteContext {
  /** Currently active/selected session, or null if none (app-shell's AppShellState.activeSessionId). */
  activeSessionId: SessionId | null;
  /** Count of the active session's agents with status 'running' (agents-panel's own per-session map). 0 if no active session. */
  runningAgentCount: number;
}

// ---------- secondary step (second filtered list) ----------

export interface SecondaryStepItem {
  id: string;
  label: string;
  hint?: string;
}

export interface SecondaryStep {
  /** Shown in the input row in place of "run a command" (FR-16). */
  placeholder: string;
  /** Rendered as filterable rows; label is matched the same way name is at the top level (FR-10). */
  items: SecondaryStepItem[];
  /** Invoked with the picked item's id (FR-13, FR-17). Must return synchronously. */
  onPick: (id: string) => void;
}

// ---------- command registry ----------

export interface PaletteCommand {
  /** kebab-case, unique across the registry, e.g. 'new-session'. */
  id: string;
  /** Single glyph rendered in the 16px glyph column (FR-20). */
  glyph: string;
  /** Display name; also the string filtered/ranked against (FR-10). */
  name: string;
  /** Right-aligned dynamic hint. No arguments — reads live state via closure (FR-21). Omit for no hint. */
  hint?: () => string;
  /** Defaults to always-enabled if omitted (FR-22). */
  enabled?: (ctx: PaletteContext) => boolean;
  /** Must return synchronously; a SecondaryStep enters secondary mode, void closes the palette (FR-16). */
  run: (ctx: PaletteContext) => void | SecondaryStep;
}

/** Called once per command by the owning feature at bootstrap (FR-6, FR-7). Throws if `id` is already registered. */
export function registerPaletteCommand(command: PaletteCommand): void;

/** Removes a previously registered command (hot-reload / tests). No-op if `id` is not registered. */
export function unregisterPaletteCommand(id: string): void;

// ---------- open / close ----------
// Consumed by app-shell's global key dispatcher (togglePalette/dismiss, FR-1/FR-3) and by
// app-shell's status-bar "⌘K commands" hint (togglePalette). No other feature is expected
// to call these directly.

export function openPalette(): void;
export function closePalette(): void;
export function togglePalette(): void;
export function isPaletteOpen(): boolean;

// ---------- toasts (FR-24, FR-25) ----------

export type ToastKind = 'error' | 'info' | 'success';

/** Enqueues a transient, app-wide toast. Rendered outside the palette's own DOM subtree. */
export function showToast(message: string, kind: ToastKind): void;
```

There are no IPC channels or `SessionEvent`/other tagged-union members defined by this contract (§2 non-goals) — this file exports only the registry/runtime API above.

## 6. Data & state

All state below is frontend-only, in-memory, feature-local (a small zustand store), and **not persisted** — every `openPalette()` starts fresh (FR-5).

```ts
interface PaletteState {
  open: boolean;
  mode: 'root' | 'secondary';
  query: string;                 // top-level filter text
  selectedIndex: number;         // top-level selection
  secondaryStep: SecondaryStep | null;
  secondaryQuery: string;
  secondarySelectedIndex: number;
  restoreFocusTo: Element | null;  // captured on open (FR-2), consumed on close
}
```

- **Command registry**: a module-level ordered array (insertion-order = registration order, FR-6/FR-7/FR-10), populated by `registerPaletteCommand` calls made by each dependent feature during its own bootstrap. Not part of React/zustand state — read fresh on every filter pass.
- **Toast queue**: a separate, independent module-level/zustand list, `{ id: string; message: string; kind: ToastKind; createdAt: number }[]`, capped at 3 concurrently visible (FR-24) with its own 4000ms-per-toast timers (FR-25). Independent of `PaletteState.open` — toasts outlive the palette closing (this is the point: the delegated call that produced the error resolves *after* the palette has already closed, per FR-16/FR-17).
- **Derived state** (recomputed, not stored): the filtered/ranked top-level or secondary-step list (FR-10), and `PaletteContext` (FR-9), both recomputed on every render pass while `open === true`.
- `PaletteContext` sources (already-existing state owned by the named feature, not redefined here):

  | field | source |
  |---|---|
  | `activeSessionId` | app-shell's `AppShellState.activeSessionId` (written exclusively by sessions-sidebar; every other feature, including this one, only reads it) |
  | `runningAgentCount` | agents-panel's per-session agent map, already scoped to the active session (agents-panel FR-1–FR-4), filtered `status === 'running'`, `.length` |

## 7. Edge cases & errors

- **No active session, palette opened**: per FR-22, only `new-session` and `view-diff` are visible; the rest are hidden (not grayed). `view-diff`'s hint reads `0 files changed`.
- **`view-diff` run while already on the DIFF tab**: toggles away to the SESSION tab, per FR-23 (this command reuses app-shell's own `d`/`toggleDiff` transition verbatim, which is itself a toggle, not an idempotent "go to diff" — a documented, accepted consequence, not a defect in this spec).
- **Top-level query matches nothing**: render a centered empty-state row, "no matching commands", 13px `#565a63`, same row padding as a normal row, no glyph/hint.
- **Secondary-step query matches nothing** (including a picker step with a legitimately empty source list — e.g. no installed skills, though `kill-agent` itself is never offered with zero running agents per FR-22): same empty-state text and styling as above, inside the secondary-step list area.
- **Delegated call rejects (throws) instead of resolving a `Result`**: treated as an unexpected internal failure; the command's fire-and-forget wrapper catches it and calls `showToast('Command failed unexpectedly', 'error')` (no `AppError` object exists to read a `message` from in this case — FR-18).
- **Delegated call resolves `ok:false`**: `showToast(error.message, 'error')` (FR-18, FR-24). The palette has already closed by the time this can happen (optimistic close, FR-16/FR-17) — the toast is the only surfacing.
- **Race: picked item no longer valid by the time `onPick` resolves** (e.g. `kill-agent` picks an agent that already finished, `AGENT_NOT_FOUND`): surfaced as an ordinary `ok:false` toast, no special-cased UI; user can reopen the palette and retry.
- **`Backspace` with a non-empty secondary query**: edits the query character-by-character, normal text-input behavior (only an *already-empty* query pops on `Backspace`, FR-15).
- **Rapid re-toggle** (`⌘K` pressed twice quickly): `togglePalette()` is a synchronous boolean flip (FR-4); no debounce needed, no transitional state to race.
- **`Attach MCP server` / `New session` open their own overlay while the palette is closing**: since both close the palette optimistically before the delegated overlay finishes mounting, there is a brief moment with no overlay visible; both target overlays grab their own DOM focus on mount (mirroring FR-2's own pattern), so no separate focus-restore handling is needed on this feature's side for those two commands.
- **`restoreFocusTo` element no longer in the DOM at close time** (e.g. removed by an unrelated re-render while the palette was open): falls back to `document.body`.
- **More than 3 toasts fire concurrently**: the 4th+ queue FIFO and appear as a visible slot frees (FR-24); this requires reopening the palette between each command (since it closes optimistically), so in practice it is bounded by how fast a user can reopen/re-run.

## 8. Design brief

### Screens / regions
Full-window overlay, absolutely positioned over the entire 1360×864 app window (including the 44px title bar) — reference `Claude Terminal.dc.html` lines 252–276, the `<!-- COMMAND PALETTE -->` block, and `cmdData`/`commands` in the script (lines ~387–401). Rendered via a portal at the app root, above the title bar, the 3-column grid, and the status bar (app-shell's design brief explicitly scopes its own "Screens / regions" to everything *except* this modal's interior). Toasts (§8 Toast, not present in the mock) render at an even higher stacking layer, independent of the palette. Note: mcp-panel's own attach-flow overlay and skills-panel's/agents-panel's own modals are visually styled after this panel's tokens (per their own design briefs) but are separate components, not part of this feature.

### Components
1. **Backdrop** — full-window scrim, click-to-dismiss (always a full close, FR-3).
2. **Panel** — the 588px card: input row + list + footer.
3. **Input row** — prompt glyph, text/placeholder + cursor, esc hint; in secondary mode, additionally a breadcrumb pill.
4. **Command row** (top level) / **Item row** (secondary step) — glyph + name/label + hint, default and selected states.
5. **Empty state** — "no matching commands" row.
6. **Footer** — keymap hints, text differs between top level and secondary mode.
7. **Toast** — app-root-level transient notice (not in the mock; defined here for the first time).

### States
- Panel: closed / open-root / open-secondary.
- Row: default / selected (keyboard or mouse-hover) / (never disabled-visible — disabled rows are absent, FR-8).
- Input: empty (placeholder + cursor) / has query.
- List: populated / empty-state / scrolled (overflow, §Resize).
- Toast: entering / visible / exiting; kind = error / info / success.

### Interactions
- `⌘K`/`Ctrl+K`: app-shell's global `togglePalette` dispatch (FR-1) — fires from anywhere.
- Click backdrop: full close. Click panel: no-op (click is stopped from bubbling to the backdrop).
- Type: filters + re-ranks (FR-10), resets selection to 0 (FR-11).
- `↑`/`↓`: move selection, wraps (FR-12). Mouse hover: same as `↓`/`↑` landing on that row.
- `⏎` / row click: run/pick (FR-13).
- `Esc`: app-shell's `dismiss` dispatch (FR-3) — secondary → root, then root → close. Backdrop click and a top-level `dismiss`/close both restore focus (FR-2/FR-3, subject to the `view-diff` exception, FR-16).
- `Backspace` on empty secondary query: same as dismiss-in-secondary (FR-15).

### Visual notes (exact tokens)

**Backdrop**: `position: absolute; inset: 0; background: rgba(6,7,9,0.62); display:flex; align-items:flex-start; justify-content:center; padding-top:118px;`

**Panel**: `width: 588px; background:#191b21; border:1px solid #34363f; border-radius:8px; box-shadow:0 30px 80px -20px rgba(0,0,0,0.85); overflow:hidden;` Font throughout: JetBrains Mono.

**Input row**: `display:flex; align-items:center; gap:11px; padding:14px 16px; border-bottom:1px solid #24262d;`
- Prompt glyph `›`: `color:#c8a15a; font-size:15px;`
- Text: `flex:1; font-size:14px; color:#d3d6dc;` — placeholder text is the literal string "run a command" in the same 14px/#d3d6dc style when the query is empty; typed query replaces it verbatim (no separate placeholder color/dim treatment — matches the mock, which renders the placeholder in full text color, not dimmed).
- Cursor: `display:inline-block; width:8px; height:16px; background:#c8a15a; vertical-align:text-bottom; margin-left:2px; animation: blink 1s step-end infinite;` — a blinking block caret at the end of the current text (present whether the query is empty or not; the mock's static frame only shows the empty-query case — this is a documented extrapolation matching the identical blink-cursor convention used elsewhere in the app, e.g. the SESSION input bar and agents-panel's new-agent modal, both of which use the same `width:8px;height:16px` caret).
- `esc` hint (top level only — see secondary-mode override below): `font-size:10px; color:#565a63;`

**Secondary-mode input row addition** (not in the mock — defined here): a breadcrumb pill sits immediately left of the text, in the gap between the `›` glyph and the text: `font-size:10px; color:#a9adb6; background:#26282f; border-radius:8px; padding:1px 6px;` containing the parent command's `name` (e.g. "Switch model"). The `esc` hint on the right becomes `back` (`font-size:10px; color:#565a63;`) to signal `Esc` pops rather than closes while in this mode.

**List container**: `padding:6px;`

**Row** (command or item): `display:flex; align-items:center; gap:12px; padding:10px 12px; border-radius:5px;` No gap/margin between stacked rows (flush, per mock).
- Default: `background:transparent;` glyph `width:16px; text-align:center; font-size:12px; color:#868a93;` name/label `font-size:13px; color:#c4c7ce; flex-shrink:0;` hint `font-size:11px; color:#565a63; flex:1; text-align:right;`
- Selected: `background:#26282f;` glyph `color:#c8a15a;` name/label `color:#dfe2e8;` hint unchanged (`#565a63`). No transition — instant background swap on selection change (matches the sidebar's un-animated row-selection convention).

**Empty state** (not in mock — defined here): centered text row, `padding:10px 12px; font-size:13px; color:#565a63;` reading "no matching commands".

**Footer**: `display:flex; gap:16px; padding:9px 16px; border-top:1px solid #24262d; font-size:10px; color:#565a63;` key glyphs (`↑↓`, `⏎`, `esc`) in `color:#868a93;`, labels in the inherited `#565a63`.
- Top level: `↑↓ navigate` · `⏎ run` · `esc dismiss`.
- Secondary step: `↑↓ navigate` · `⏎ select` · `esc back` (not in mock — defined here, per FR-3's actual semantics).

**Toast** (not in mock — defined here): anchored bottom-center of the window, 16px above the 32px status bar; stacked toasts offset 8px further up each. Card: `background:#1b1d23; border-radius:6px; padding:10px 16px; font-size:12px; color:#dfe2e8; box-shadow:0 30px 80px -20px rgba(0,0,0,0.85);` with a 12px leading glyph: error `✕` in `#c46b62` with `border:1px solid rgba(196,107,98,0.4)`; info `●` in `#868a93` with `border:1px solid #34363f`; success `●` in `#7fa07a` with `border:1px solid rgba(127,160,122,0.4)`. Click anywhere on a toast dismisses it early (FR-25).

**Motion**: panel entrance `opacity 0→1, transform: scale(0.98)→scale(1)` over 120ms ease-out; backdrop fades in over 120ms; exit (`Esc`/backdrop-click) reverses over 100ms ease-in, no exit on secondary→root (that transition is instant, no fade, since the panel itself never unmounts). Toast entrance: `opacity 0→1, translateY(6px)→0` over 140ms ease-out; exit `opacity 1→0` over 160ms ease-in. Existing app-wide motion tokens reused where relevant: `blink 1s step-end infinite` (cursor), `pulse 1.4s ease-in-out infinite` (not used by this feature — no pulsing elements here).

### Resize / responsive
- Panel width is fixed at 588px regardless of window width; if the window is narrower than `588px + 32px` margin, the panel clamps to `calc(100vw - 32px)` (16px side margins), text/rows reflow normally (hint text may need to truncate — apply `text-overflow: ellipsis; white-space: nowrap; overflow: hidden;` to the hint span first, before the name span, since hint is lower priority than name/label).
- The `padding-top: 118px` backdrop offset is fixed (not proportional) — on very short windows the list area's `max-height` (below) shrinks first before the panel would ever be pushed off-screen; if the window height is less than `118px + panel content height`, the panel's list area further clamps its `max-height` so the footer stays visible.
- List area: `max-height: 336px` (8 rows), scrolling beyond that with the app's standard 8px thin scrollbar (`.scz`-equivalent: `#2a2c33` thumb, transparent track, 4px radius). The 7 built-in top-level commands never trigger scroll (7 rows ≈ 280px, matching the mock's no-scrollbar frame); secondary steps with more items (e.g. many installed skills or running agents), or the registry growing beyond 8 entries once other features register additional commands (FR-7), do scroll.

## 9. Acceptance criteria

- [ ] ⌘K/Ctrl+K opens/closes the palette from any focus state, including while the SHELL tab's terminal is focused, via app-shell's global `togglePalette` dispatch — this feature installs no competing global listener (FR-1).
- [ ] `Esc` at the top level and backdrop click both perform a full close and restore focus to the element focused immediately before opening, except `view-diff`'s documented exception (FR-2, FR-3, FR-16).
- [ ] Panel renders at exactly 588px wide, 118px from the window top, `#191b21` background, `1px solid #34363f` border, `8px` radius, and the specified box-shadow (§8).
- [ ] Empty query shows all enabled built-ins in the fixed registration order of FR-6; typing filters via case-insensitive ordered-subsequence match and re-ranks by match position then alphabetically (FR-10).
- [ ] A command with `enabled(ctx) === false` never appears in the list (not grayed, not present) (FR-8, FR-22).
- [ ] ↑/↓ moves the selection and wraps at both ends; typing resets selection to index 0 (FR-11, FR-12).
- [ ] `new-session` and `attach-mcp-server` each return `void` from `run` and delegate to their owning feature's own separate overlay (sessions-sidebar's new-session modal; mcp-panel's attach flow at step 1), rather than using this feature's `SecondaryStep` (FR-23, §7).
- [ ] `switch-model`, `run-skill`, and `kill-agent` each return a `SecondaryStep`, and `onPick` on each closes the palette immediately after firing its delegated call (no chaining) (FR-16, FR-17, FR-23).
- [ ] `run-skill`'s secondary-step pick invokes `francois:skills:run` with `args` omitted (no argument prompt in the palette path) (FR-23, matching skills-panel FR-16).
- [ ] Every built-in command's glyph, name, and static hint text match FR-20 exactly; `view-diff` and `compact-context` render their dynamic hints per FR-21, sourced from app-shell's own caches.
- [ ] `view-diff`'s `run` performs the identical `mainTab`/`focusedPane` transition as app-shell's own `d` key, including toggling away from DIFF if already there (FR-23, §7).
- [ ] A delegated call resolving `{ ok:false }` produces a toast with the `AppError.message`, kind `'error'`, auto-dismissing after 4000ms, rendered even though the palette has already closed (FR-18, FR-24, FR-25).
- [ ] With no active session, only `new-session` and `view-diff` are visible/enabled (FR-22, §7).
- [ ] An empty filtered result (top level or secondary) renders the "no matching commands" empty state (§7).
- [ ] A command registered by a feature other than the seven built-in owners (e.g. agents-panel's "New agent") appears in the list, filters, and runs identically to a built-in (FR-7).
- [ ] `registerPaletteCommand`/`unregisterPaletteCommand`/`openPalette`/`closePalette`/`togglePalette`/`isPaletteOpen`/`showToast` all match the signatures in §5 and are the sole exports of `contract/command-palette.ts`.

## Remediation

(Empty until a review returns findings.)
