---
id: agents-panel
title: Agents panel
status: frozen
created: 2026-07-18
depends_on: [session-engine, app-shell]
---

# Agents panel

## 1. Summary

The Agents panel is right-column pane **[3]** (`Claude Terminal.dc.html` lines 178–198, `agData`/`agents`). It shows the subagents of the currently **active session** as a scrollable list of cards — status dot, name, status label, one-line task, and a progress bar — hydrated once via an IPC snapshot and then kept live by the shared session event stream. From this pane the user dispatches new subagents (`a` key or the ⌘K palette) and kills running ones (hover ✕, `x` key, or the palette's "Kill agent" secondary list).

## 2. Goals & non-goals

- **Goals**:
  - Render the active session's subagents as ordered cards (running → idle → done/error), live-updated from `agent.update` events.
  - Own and expose three IPC channels: `francois:agents:list`, `francois:agents:dispatch`, `francois:agents:kill`.
  - Support keyboard (`↑`/`↓` select, `⏎` expand, `x` kill) and mouse (click select, hover ✕) interaction on pane [3].
  - Provide a "new agent" prompt modal and contribute palette entries ("New agent", "Kill agent" → running-agent list) that the command-palette shell renders.
  - Define the empty state and the four card-status visual states.
- **Non-goals**:
  - Actually orchestrating a Claude Code subagent (the Task-mechanism / crafted message that makes the SDK spawn work) — that's **session-engine**'s job; this spec treats `agents:dispatch` as a single opaque IPC call into it.
  - Aggregating agent counts across *all* sessions for the title bar's "◉ N agents running" indicator — that's **app-shell**'s job (it can subscribe to the same `agent.update` events independently); this pane only ever shows the active session's agents.
  - The right column's outer grid/flex layout (proportions between AGENTS / MCP SERVERS / SKILLS, the 10px gaps, the section's `border`/focus-ring color, and which pane key (`1`–`5`) is currently focused) — owned by **app-shell**. This spec owns everything *inside* the AGENTS `<section>`.
  - The ⌘K modal shell, its text-filter/fuzzy-match behavior, and command registry mechanics — owned by **command-palette**. This spec only defines the two entries it contributes and the data they need.
  - Session selection / the definition of "active session" — owned by **sessions-sidebar** / app-shell; this spec only consumes `activeSessionId`.

## 3. User stories / flows

1. **View subagents.** User selects a session in the sidebar. Pane [3] shows "AGENTS · N · [3]" and hydrates the card list for that session via `francois:agents:list`. As the session runs, `agent.update` events reorder and repaint cards live (progress bars fill, a queued agent moves from idle to running, a finished one moves to the done/error tail with its result as the task line).
2. **Dispatch a new agent (keyboard).** User presses `a` (no other modal open, a session is active). A small prompt modal opens with a text input. User types a task description and presses `⏎`. The modal calls `francois:agents:dispatch`; on success it closes. Moments later an `agent.update` event adds the new card to the panel.
3. **Dispatch a new agent (palette).** User opens ⌘K, selects "New agent", which opens the same prompt modal (palette closes first).
4. **Kill a running agent (mouse).** User hovers a running card; the status label swaps to a ✕. Clicking it calls `francois:agents:kill` for that agent immediately.
5. **Kill a running agent (keyboard).** User focuses pane [3] (`3` or click), moves selection with `↑`/`↓` onto a running card, presses `x`. Same kill call.
6. **Kill a running agent (palette).** User opens ⌘K, selects "Kill agent", which shows a secondary list of the active session's *running* agents (name + task as the hint); selecting one kills it.
7. **Inspect a task in full.** User selects a card with `↑`/`↓` and presses `⏎`; the card expands in place to show the full, non-truncated task text (and current progress %). Pressing `⏎` again, or moving selection, collapses it.
8. **No agents yet.** A freshly started session with no subagents shows "no agents yet · press a" instead of a card list.

## 4. Functional requirements

**Hydration & live state**

- **FR-1.** Whenever `activeSessionId` becomes non-null (initial load or session switch), the frontend subscribes to `francois:session:event` (if not already) and issues `francois:agents:list` with `{ sessionId: activeSessionId }`. While the request is in flight, the panel is in a `loading` state (no empty-state text shown yet, no error).
- **FR-2.** From the moment a session becomes active, `agent.update` events with `agent.sessionId === activeSessionId` are buffered/applied regardless of whether the `list` response has arrived yet, so a fast subagent event can never be lost to a race with the snapshot request. When the `list` response arrives, its entries seed the agent map for any id not already present from a buffered event; entries already present from a buffered/live update are **not** overwritten by the (possibly slightly stale) snapshot.
- **FR-3.** On `agent.update`, if `agent.sessionId !== activeSessionId` the event is ignored by this pane (it may still matter to app-shell's title-bar aggregate — not this spec's concern). Otherwise the agent is upserted into the local map by `id` (insert if new, replace fields if existing).
- **FR-4.** On active-session change (including to `null`, e.g. last session removed), the panel discards the previous session's agent map, `selectedAgentId`, `expandedAgentId`, and closes the new-agent modal if open, then re-runs FR-1 for the new session (or shows the empty/no-session state if `activeSessionId` is `null`).
- **FR-5.** If `activeSessionId` is `null` (no sessions exist), the panel does not call `francois:agents:list`; it renders as if it had zero agents (see FR-9) and the `a` key / "New agent" palette entry are no-ops.

**Header & ordering**

- **FR-6.** Header renders the literal label "AGENTS" and, right-aligned, `"{N} · [3]"` where `N` is the count of agents currently held in the active session's map (all statuses, including done/error — completed agents are never dropped for the session's lifetime).
- **FR-7.** Cards render in three ordered buckets: `running` (rank 0), `idle` (rank 1), `done` and `error` (rank 2, interleaved). Within a bucket, order is the agent's first-seen order — i.e. a stable sort by bucket rank over the agent map's natural (insertion-ordered) iteration, where an `agent.update` for an already-known id updates its fields in place without changing its position.

**Card rendering**

- **FR-8.** Each card shows: a status dot (color per `AgentStatus`, pulsing only when `running`), the agent `name`, a right-aligned status label in the same status color, a one-line `task` (ellipsized), and a progress bar filled to `progress`%.
- **FR-9.** The task line always renders the agent's current `AgentInfo.task` string verbatim — no client-side substitution logic. (When session-engine transitions an agent to `done`, it is expected to have already replaced `task` with the one-line result, e.g. `"0 vulnerabilities found"`; this pane just displays whatever it's given.)
- **FR-10.** Progress bar width is `clamp(agent.progress, 0, 100)`. Additionally, when `agent.status === 'done'`, the panel renders the bar pinned to 100% regardless of the received `progress` value (defensive UI guarantee; the engine is expected to send 100 already since progress is monotonic, but the UI must never show a "done" card with a visibly incomplete bar).
- **FR-11.** Empty state ("no agents yet · press a") renders only when not loading and the active session's agent map has zero entries (including when there is no active session, per FR-5).

**Selection & expansion (pane [3] keyboard)**

- **FR-12.** `↑`/`↓`, while pane [3] is the app-shell-focused pane, move `selectedAgentId` to the previous/next card in render order (FR-7); it clamps at the first/last card (no wraparound). Clicking a card also sets `selectedAgentId` (mouse parity), independent of which pane currently holds app-shell focus.
- **FR-13.** `⏎`, while pane [3] is focused and a card is selected, toggles `expandedAgentId` for that card: set it if unset or set to a different card; clear it if it's already the selected card. Changing `selectedAgentId` (via `↑`/`↓` or click) while a different card is expanded collapses the previous expansion (at most one card is expanded at a time, and it is always the currently selected one).
- **FR-14.** Expanded rendering: the task line drops its single-line ellipsis (wraps instead) and an explicit `"{progress}%"` numeral is shown next to the progress bar. All other card chrome is unchanged.

**Dispatch (new agent)**

- **FR-15.** The global `a` key opens the new-agent modal when: no other modal (palette, this modal itself) is currently open, and `activeSessionId` is non-null. The "New agent" palette command performs the same action (closing the palette first). Precedence between global keys and text-input focus (e.g. not triggering while typing in the SESSION input bar) is app-shell's global key dispatcher; this spec only requires "no modal already open."
- **FR-16.** The modal holds one text field (`taskText`). Submitting (`⏎`, or a submit affordance) with `taskText` trimmed to non-empty calls `francois:agents:dispatch` with `{ sessionId: activeSessionId, task: taskText.trim() }`.
  - Empty/whitespace-only `taskText`: do not call the channel; show `INVALID_INPUT`-style inline validation and keep the modal open (see §7).
- **FR-17.** On a successful dispatch response (`Result<{ agentId }>` with `ok: true`), the modal closes and `taskText` resets. The panel does **not** synthesize a placeholder card; the new agent appears once its `agent.update` arrives (per FR-1–FR-3), which session-engine is expected to emit promptly.
- **FR-18.** `Escape`, or a click on the modal backdrop, cancels the modal (discards `taskText`) without calling the channel.

**Kill**

- **FR-19.** Kill is only ever offered for `running` agents: the hover-✕ affordance only appears on `running` cards, the `x` key only acts when the selected card's status is `running` (no-op otherwise), and the palette's "Kill agent" secondary list is populated only from the active session's `running` agents.
- **FR-20.** Any of the three triggers in FR-19 calls `francois:agents:kill` with `{ agentId }`. While the call is in flight, the panel marks that agent id as "pending kill" (cosmetic only — see §8); the flag is cleared as soon as the *next* `agent.update` for that id is received (regardless of the status it reports), or immediately on an error response.
- **FR-21.** A kill call does not remove the card or change its rendered status client-side; the panel waits for session-engine's own `agent.update` to reflect the outcome (session-engine decides what `AgentStatus` a killed agent lands on — `error` or `done` — this spec has no opinion).

**Palette contributions**

- **FR-22.** This spec contributes two entries to the command-palette registry (registry mechanics owned by command-palette):
  - `"New agent"` (glyph `⇉`, hint `"describe a task"`) — invokes the FR-15 flow.
  - `"Kill agent"` (glyph `⊗`, hint `"select running"`) — opens a secondary list sourced from the active session's running agents (`{ id: AgentId; name: string; task: string }[]`); selecting an entry invokes the FR-20 flow for that `agentId`. If there are zero running agents, this entry is disabled/omitted (palette's call, driven by this data being empty).

## 5. API contract

Domain: `agents`. All types below import from `contract/common.ts` and would live in `contract/agents-panel.ts` at `/build` time (not authored by this spec).

**Channels owned by this feature**

| Channel | Direction | Payload | Result data | Error codes |
|---|---|---|---|---|
| `francois:agents:list` | frontend → core (`invoke`) | `AgentsListRequest` | `AgentInfo[]` | `SESSION_NOT_FOUND` |
| `francois:agents:dispatch` | frontend → core (`invoke`) | `AgentsDispatchRequest` | `AgentsDispatchResponse` | `SESSION_NOT_FOUND`, `SESSION_NOT_RUNNING`, `INVALID_INPUT` |
| `francois:agents:kill` | frontend → core (`invoke`) | `AgentsKillRequest` | `void` | `AGENT_NOT_FOUND` |

**Events consumed (not owned)**

- `francois:session:event` → `SessionEvent` (from `contract/common.ts`). This spec only reacts to the `{ type: 'agent.update'; agent: AgentInfo }` member, filtered to `agent.sessionId === activeSessionId`. Emission semantics are session-engine's.

This feature defines no core→frontend event channel of its own.

**Type definitions**

```ts
import type { SessionId, AgentId, AgentInfo, Result } from './common';

// francois:agents:list
export interface AgentsListRequest {
  sessionId: SessionId;
}
export type AgentsListResponse = AgentInfo[];
// invoke('agents_list', req: AgentsListRequest): Promise<Result<AgentsListResponse>>

// francois:agents:dispatch
export interface AgentsDispatchRequest {
  sessionId: SessionId;
  task: string; // non-empty after trim(); engine assigns the AgentId and initial AgentInfo
}
export interface AgentsDispatchResponse {
  agentId: AgentId;
}
// invoke('agents_dispatch', req: AgentsDispatchRequest): Promise<Result<AgentsDispatchResponse>>

// francois:agents:kill
export interface AgentsKillRequest {
  agentId: AgentId;
}
// invoke('agents_kill', req: AgentsKillRequest): Promise<Result<void>>
```

**Error semantics specific to this feature**

- `SESSION_NOT_FOUND` (`list`, `dispatch`): `sessionId` does not match any session known to session-engine.
- `SESSION_NOT_RUNNING` (`dispatch`): the target session's `SessionStatus` is `'done'` or `'error'` (its Claude Code process is not alive to receive a dispatch). Dispatch is **allowed** when status is `'idle'` or `'running'`.
- `INVALID_INPUT` (`dispatch`): `task` is empty or whitespace-only after trimming.
- `AGENT_NOT_FOUND` (`kill`): `agentId` does not match any agent known to session-engine.

No new `ErrorCode` members are needed beyond what `contract/common.ts` already defines.

## 6. Data & state

**Rust core** — this spec owns the three IPC handlers, implemented as a thin layer over session-engine's in-memory agent registry and dispatch/kill primitives. It holds no state of its own in the core; `AgentInfo` and subagent lifecycle are session-engine's source of truth.

**Frontend** — a store (e.g. a zustand slice) scoped to the active session, holding:

- `agents: Map<AgentId, AgentInfo>` — the active session's agents, insertion-ordered by first sighting (either from the `list` response, in response-array order, or from the first `agent.update` seen for a previously-unknown id). `Map.set` on an existing key does not change its position, so this ordering is preserved across updates and satisfies the "stable by start order" ordering rule in FR-7 without a separate timestamp field.
- `loading: boolean` — true while the `list` request for the current `activeSessionId` is in flight.
- `listError: AppError | null` — set if `list` resolves `ok: false`; cleared on the next successful hydration.
- `selectedAgentId: AgentId | null`.
- `expandedAgentId: AgentId | null`.
- `pendingKillAgentIds: Set<AgentId>` — cosmetic only (FR-20); never persisted, never affects `agents`.
- `newAgentModal: { open: boolean; taskText: string; submitting: boolean; error: AppError | null }`.

Derived (not stored): header count `N = agents.size`; render order = stable sort of `agents.values()` by bucket rank (FR-7); empty-state boolean = `!loading && agents.size === 0`.

**Persistence**: none. All of the above is transient view state, rebuilt from `list` + `agent.update` on every session switch and app restart; nothing here is written to disk.

## 7. Edge cases & errors

- **`list` fails (`SESSION_NOT_FOUND`)** — e.g. the user switched to a session that was concurrently removed. The panel shows an inline error line in place of the card list (reusing the panel body area, not a toast), keeps `N` at `0`, and does not retry automatically; a subsequent session switch (FR-4) is the recovery path.
- **No active session (`activeSessionId === null`)** — panel shows the same empty-state copy as a zero-agent session ("no agents yet · press a"), but `a` / "New agent" are no-ops (FR-5, FR-15) since there is no `sessionId` to target.
- **`dispatch` fails with `INVALID_INPUT`** — modal stays open, `taskText` is preserved (not cleared), an inline message renders under the input; user can edit and resubmit or `Escape` to cancel.
- **`dispatch` fails with `SESSION_NOT_FOUND` / `SESSION_NOT_RUNNING`** — modal stays open with an inline error (using `AppError.message`); the user can only `Escape` (no retry target makes sense once the session is gone/dead) or cancel — there is no auto-close, so they don't lose their typed task text without seeing why.
- **`kill` fails with `AGENT_NOT_FOUND`** — the `pendingKillAgentIds` flag is cleared (FR-20) and, since session-engine no longer recognizes this agent, its card is removed from the local `agents` map immediately (the only case where this spec removes a card client-side, since the alternative is a permanently-stale zombie card that can never receive another `agent.update`).
- **Race: agent transitions off `running` between a kill trigger and the call resolving** — no special handling; the call still goes to the engine, which owns the outcome. No additional error surface is defined for this (kill is deliberately framed as "interruptive but recoverable," not requiring a confirm dialog per the spec brief).
- **Long task text** — collapsed cards always ellipsize (`white-space: nowrap; overflow: hidden; text-overflow: ellipsis`) per FR-8; full text is only ever visible via the expanded state (FR-14). The new-agent modal input does not truncate on submit; only `.trim()` is applied client-side.
- **Switching sessions while the modal or an expansion is open** — both are force-reset per FR-4 (modal discards `taskText`; expansion/selection clear) since neither remains meaningful against a different session's agent set.
- **Zero running agents when opening "Kill agent" from the palette** — the secondary list is empty; per FR-22 the palette either disables or omits the entry (palette's UI call), so this pane never needs to render an "empty kill list" state of its own.

## 8. Design brief

### Screens / regions

Right column, top section — pane **[3]**, `Claude Terminal.dc.html` lines 178–198 (`agData`/`agents` render). Sits above MCP SERVERS `[4]` and SKILLS `[5]` in a `flex-direction: column` right column (flex ratio `1.3` of that column — app-shell's concern, not this spec's). Two new overlay regions belong to this spec: the **new-agent modal** (styled after, but distinct from, the ⌘K palette at lines 252–276) and the **hover-✕ affordance** on running cards.

### Components

- **AGENTS section header** — label + count, mirrors every other pane header (`SESSIONS`, `MCP SERVERS`, `SKILLS`) in this app: `padding: 9px 12px`, `border-bottom: 1px solid #24262d`, `display: flex; justify-content: space-between; align-items: center`.
  - Label: `"AGENTS"`, `font-size: 11px`, `letter-spacing: 0.14em`, `font-weight: 700`, color `#c8a15a` when pane [3] is app-shell-focused, else `#868a93`.
  - Count: `"{N} · [3]"`, `font-size: 10px`, color `#565a63`.
- **Agent card** (one per agent, in a `.scz` scrollable list, `padding: 8px` on the list container, `gap`/`margin-bottom: 4px` between cards):
  - Card box: `padding: 9px 9px`, `border-radius: 4px`, `background: #1a1c22`.
  - **Row 1** (`display: flex; align-items: center; gap: 8px`):
    - Status dot: `8px × 8px`, `border-radius: 50%`, color per status (below); `animation: pulse 1.4s ease-in-out infinite` only when `running`.
    - Name: `font-size: 12px`, `color: #c4c7ce`, `font-weight: 500`, `flex: 1`, single line.
    - Status label (default, non-hover state): right-aligned, `font-size: 10px`, color = same status color as the dot; text is the status word (`running` / `idle` / `done` / `error`).
  - **Row 2** — task line: `font-size: 10.5px`, `color: #6b7079`, `margin: 5px 0 7px 16px` (16px indent so it aligns past the dot), collapsed: `white-space: nowrap; overflow: hidden; text-overflow: ellipsis`.
  - **Row 3** — progress bar: track `height: 3px`, `border-radius: 2px`, `background: #26282f`, `margin-left: 16px`, `overflow: hidden`; fill `height: 100%`, `width: {progress}%`, `background:` the dot color for that status (fill color always tracks the *current* status color, e.g. a bar left over from `running` turns `#7fa07a` the instant status flips to `done`), `border-radius: 2px`.
- **New-agent modal** — small prompt overlay, palette-styled (see Visual notes).
- **Palette contributions** (rendered by command-palette's own list component, styling out of this spec's scope beyond the data): `"New agent"` row (glyph `⇉`), `"Kill agent"` row (glyph `⊗`) and its running-agent secondary rows.

### States

Card, by `AgentStatus`:

| Status | Dot / fill color | Dot animation | Status label text/color |
|---|---|---|---|
| `running` | `#d0a45c` | `pulse 1.4s ease-in-out infinite` | `running`, `#d0a45c` |
| `idle` (queued) | `#6b7079` | none | `idle`, `#6b7079` |
| `done` | `#7fa07a` | none | `done`, `#7fa07a` |
| `error` | `#c46b62` | none | `error`, `#c46b62` |

Other card/panel states:

- **Selected** (keyboard `↑`/`↓` or click, independent of pane focus, per FR-12): card background lifts to `#20222a` and gains a `2px solid #c8a15a` left border-accent (same treatment as the SESSIONS sidebar's selected row, lines 57 `s.bg`/`s.marker`), replacing the flat `#1a1c22`.
- **Hover, running card only** (FR-19): the row-1 status label is replaced by a `✕` glyph, `font-size: 10px`, default color `#6b7079`, hover-on-glyph color `#c46b62`; clicking it triggers kill. Non-running cards show no hover affordance beyond the browser default pointer.
- **Pending kill** (FR-20, cosmetic only): while `agentId ∈ pendingKillAgentIds`, the whole card renders at `opacity: 0.55` and the hover-✕ / `x` key are inert for that card (prevents double-kill spam); no new status color is introduced (there is no "killing" `AgentStatus`).
- **Expanded** (FR-13/14, the currently-selected card only): row 2 becomes `white-space: normal; overflow: visible` (full task text, wraps), and a `"{progress}%"` numeral (`font-size: 10px`, `color: #6b7079`) appears inline to the right of the progress bar. Row 1 and the bar's color/width logic are unchanged. Collapse returns row 2 to the ellipsized single line.
- **Empty**: panel body shows centered-left text `"no agents yet · press a"`, `font-size: 11px`, `color: #565a63`, with `"a"` in `#a9adb6` matching the status-bar hint styling (`Claude Terminal.dc.html` line 242, `<span style="color:#a9adb6;">a</span> new agent`), vertically centered in the scroll area with `padding: 24px 12px`.
- **Loading**: no card list and no empty-state copy — leave the body blank (or, if a spinner primitive exists elsewhere in the app, reuse it; this spec does not mandate one).
- **List error**: inline line in the body, `font-size: 11px`, `color: #c46b62`, showing `AppError.message`.

### Interactions

- Click anywhere on the AGENTS `<section>` header/body focuses pane [3] (app-shell's `focusAgents`, line 178 `onClick="{{ focusAgents }}"`) — unchanged existing pattern, not owned by this spec but this spec's content lives inside that section.
- Click a card → select it (`selectedAgentId`), independent of current pane focus.
- `↑`/`↓`, pane [3] focused → move selection through the ordered list (FR-12), no wraparound.
- `⏎`, pane [3] focused, card selected → toggle expand (FR-13).
- `x`, pane [3] focused, selected card `running` → kill (FR-19/20); no-op otherwise.
- Hover a running card → ✕ appears in place of the status label; click → kill.
- `a` (global, no modal open, active session exists) → open new-agent modal.
- ⌘K → "New agent" → open new-agent modal (palette closes).
- ⌘K → "Kill agent" → secondary list of running agents → select → kill.

**New-agent modal**, mirroring the ⌘K palette's structure (`Claude Terminal.dc.html` lines 252–276) at a smaller scale:

- Backdrop: `position: absolute; inset: 0; background: rgba(6,7,9,0.62); display: flex; align-items: flex-start; justify-content: center; padding-top: 118px`. Click on backdrop → cancel (FR-18).
- Panel: `width: 420px` (vs. the palette's `588px` — this is the "small" variant), `background: #191b21`, `border: 1px solid #34363f`, `border-radius: 8px`, `overflow: hidden`, `box-shadow: 0 30px 80px -20px rgba(0,0,0,0.85)`. Click inside → does not bubble to backdrop (`stopPropagation`, same as palette's `stop`).
- Input row: `padding: 14px 16px; border-bottom: 1px solid #24262d; display: flex; align-items: center; gap: 11px`.
  - Prompt glyph `›`, `color: #c8a15a`, `font-size: 15px`.
  - Text: `font-size: 14px`, `flex: 1`; empty → placeholder `"describe the subagent's task…"` in `#565a63`; typed text in `#d3d6dc` with a trailing blinking block caret (`width: 8px; height: 16px; background: #c8a15a; animation: blink 1s step-end infinite`), same caret used for the palette input and the SESSION input bar.
  - `esc` hint, `font-size: 10px`, `color: #565a63`, right-aligned.
- Inline error row (only when `newAgentModal.error` is set, i.e. an `INVALID_INPUT`/`SESSION_*` response): `padding: 0 16px 10px`, `font-size: 10.5px`, `color: #c46b62`.
- Footer hint row: `display: flex; gap: 16px; padding: 9px 16px; border-top: 1px solid #24262d; font-size: 10px; color: #565a63`: `"⏎ dispatch"`, `"esc cancel"` (hint-key portions in `#868a93`, matching the palette footer's `↑↓ navigate` / `⏎ run` / `esc dismiss` treatment at lines 269–273).
- Submitting state: input dims slightly (`opacity: 0.7`) and is non-interactive while `newAgentModal.submitting` is true (i.e., while the `dispatch` call is in flight).

### Visual notes

- Typography: JetBrains Mono throughout, weights 400/500/700 only, matching the rest of the app.
- Card background `#1a1c22`; card radius `4px`; card list container padding `8px`; `4px` bottom margin between cards.
- Status colors (shared app-wide tokens, `Claude Terminal.dc.html` `renderVals` `C` object, lines 300–303): running `#d0a45c`, idle `#6b7079`, done `#7fa07a`, error `#c46b62`, accent `#c8a15a`.
- Text tokens used here: primary `#c4c7ce`, dim `#6b7079`, faint `#565a63`, bright input text `#d3d6dc`.
- Track color `#26282f`; track/bar radius `2px`; track height `3px`.
- Selection accent border `#c8a15a` (2px), selection background `#20222a` — reused from the sidebar's selected-row treatment.
- Motion: dot pulse `1.4s ease-in-out infinite` (`opacity 1 ↔ 0.35`, keyframes already defined app-wide as `@keyframes pulse`); modal caret blink `1s step-end infinite` (`@keyframes blink`, `opacity 1 ↔ 0`). No motion is introduced for expand/collapse or selection (instant state changes, consistent with the rest of the mock which uses no card-level transitions).
- Scrollbars: the card list uses the app-wide `.scz` thin-scrollbar treatment (`8px`, thumb `#2a2c33`, transparent track).

### Resize / responsive

- The AGENTS section's height is controlled by app-shell's right-column flex ratio; this spec only guarantees its own body (`flex: 1; overflow: auto`) scrolls independently once the card list exceeds available height — no card ever compresses below its natural height (task line ellipsizes; the card itself does not shrink further).
- Card width always fills the section's content width minus the `8px` list padding; name/task ellipsize rather than wrap (except when expanded, FR-14).
- The new-agent modal has a fixed `420px` width regardless of window size (same fixed-width approach as the `588px` command palette) since the app window itself has a fixed design reference size (1360×864) and no responsive breakpoints are defined for this app.

## 9. Acceptance criteria

- [ ] Selecting a session with subagents populates pane [3] via `francois:agents:list`, showing the correct header count `"N · [3]"` (FR-1, FR-6).
- [ ] While a session runs, `agent.update` events for that session update existing cards' dot color/status/task/progress live, and add new cards, without a full re-fetch (FR-2, FR-3).
- [ ] `agent.update` events for a non-active session never affect the panel (FR-3).
- [ ] Switching the active session clears the previous session's cards, selection, expansion, and modal, then re-hydrates for the new session (FR-4).
- [ ] Cards render in order: all `running`, then all `idle`, then `done`/`error` interleaved by first-seen order; an update to an existing agent's status re-buckets it without disturbing its relative position within the new bucket (FR-7).
- [ ] A `done` card's progress bar always renders at 100% even if the last received `progress` value was less than 100 (FR-10).
- [ ] A session with zero agents (or no active session) shows "no agents yet · press a" (FR-5, FR-11).
- [ ] `↑`/`↓` moves selection through the ordered card list with clamping (no wrap) at the ends, when pane [3] is focused (FR-12); clicking a card also selects it regardless of pane focus.
- [ ] `⏎` on a selected card expands it to show the full task text and a `%` numeral; navigating away or pressing `⏎` again collapses it (FR-13, FR-14).
- [ ] `a`, with no modal open and an active session, opens the new-agent modal; submitting a non-empty task calls `francois:agents:dispatch` and closes the modal on success (FR-15–FR-17).
- [ ] Submitting an empty/whitespace task shows inline `INVALID_INPUT` feedback without closing the modal or calling the channel (FR-16, §7).
- [ ] `Escape` or backdrop click cancels the new-agent modal and discards typed text (FR-18).
- [ ] Hovering a `running` card swaps its status label for a ✕; clicking it calls `francois:agents:kill` (FR-19, FR-20).
- [ ] `x`, with a `running` card selected and pane [3] focused, calls `francois:agents:kill`; `x` on a non-running selected card is a no-op (FR-19).
- [ ] The ⌘K "Kill agent" entry's secondary list contains exactly the active session's `running` agents (name + task); selecting one kills it (FR-22).
- [ ] A card marked "pending kill" renders at reduced opacity and ignores further kill triggers until the next `agent.update` for that id arrives (FR-20).
- [ ] An `AGENT_NOT_FOUND` response to `kill` removes that card from the panel immediately (§7).
- [ ] A `SESSION_NOT_FOUND` response to `list` shows an inline error in the panel body instead of a card list or the empty-state copy (§7).

## Remediation

(Empty until a review returns findings.)
