---
id: agent-tab
title: Agent tabs — a subagent's session in the main pane
status: shipped
created: 2026-07-28
depends_on: [async-agents, agents-panel, conversation-view, app-shell]
reviewed_base: 7a8e8f82074639ef2c6fdda618e8e14cfb4a94a4
reviewed_digest: c9df171c66729790
---

# Agent tabs — a subagent's session in the main pane

## 1. Summary

A subagent is visible today only as a card in pane **[3]**, and the only way to look inside it is the
`⏎` expansion: a 180px scroller of one-line steps whose labels are truncated to 120 chars, with tool
bodies dropped entirely (`async-agents` FR-19..FR-22). You can tell an agent is alive; you cannot read
what it did.

The stream already carries the material. `session/stream.rs` diverts every line bearing a
`parent_tool_use_id` to its agent (async-agents FR-8) and `apply_attributed_line` reduces it to a
one-line `AgentStep`. This feature keeps a **second, richer projection of those same lines** — a
per-agent block buffer in the exact `ConversationBlock` vocabulary the SESSION tab renders — and
surfaces it as a **dynamic main-pane tab**: clicking a card in pane [3] opens (or focuses) a closable
tab after SHELL showing that subagent's own conversation, full text and tool cards included.

## 2. Goals & non-goals

- **Goals**:
  - Keep a bounded, per-agent transcript of the subagent's own assistant text and tool calls, built
    from the lines async-agents already attributes — full text, not a 120-char label.
  - Own one new IPC channel (`francois:agents:transcript`) and one new event stream
    (`francois:agents:event`, member `agent.block`).
  - Make the main pane's tab set dynamic: any number of agent tabs (capped) after SHELL, each
    closable, scoped to the active session.
  - Render the tab body with the SESSION tab's block renderer, not a second one.
- **Non-goals**:
  - Replacing the pane [3] trail. `⏎` still expands the in-place 180px trail (async-agents FR-19) —
    the tab is the "read it properly" path, the trail is the peek.
  - Token-by-token streaming inside the tab. `stream_event` lines stay dropped (async-agents FR-9), so
    a subagent's text lands as one block when its `assistant` line completes.
  - Persisting the transcript. In-memory, per session, discarded on restart — the same rule as the
    trail (async-agents §6). `sessions.json` and the transcript file are untouched.
  - Sending input to a subagent, or any control over it beyond the existing kill (async-agents FR-18).
  - Nested agents. A subagent dispatching its own subagent renders as one `subagent` block inside the
    parent agent's tab and gets no tab of its own (async-agents §7, unchanged).

## 3. User stories / flows

1. **Read a running subagent.** A card appears in pane [3]. The user clicks it: a `⇉ explorer` tab
   appears after SHELL, is activated, and focus moves to the main pane. The body shows the subagent's
   own messages and tool cards, appending live as it works, auto-scrolled to the newest.
2. **Read several at once.** The user clicks a second card. A second tab appears next to the first;
   both stay open and the newly clicked one is active. Clicking a tab switches between them.
3. **Close.** The user clicks the tab's `✕` (or presses `w` with the tab active). The tab disappears
   and the main pane falls back to SESSION.
4. **Switch sessions.** Agent ids are session-scoped, so all agent tabs close and the main pane falls
   back to SESSION (or OVERVIEW when the scope widens to All projects, app-shell unchanged).
5. **Peek without leaving the pane.** `↑`/`↓` and `⏎` in pane [3] behave exactly as before — the
   in-place trail. Only a *click* opens a tab.

## 4. Functional requirements

### Core — the per-agent transcript

- **FR-1.** For every line async-agents FR-8 attributes to an agent, the engine appends **blocks** to
  that agent's transcript alongside the FR-9 steps, from the same content blocks and in the same
  order:
  - `text` → an **assistant** block whose `text` is the block's full text (trimmed), truncated only at
    `AGENT_BLOCK_TEXT_CAP` (8000 chars). Blank after trimming ⇒ no block, matching FR-9.
  - `tool_use` → a **tool** block (`tool` = the name, `summary` = the same `tool_summary` the step
    uses), or a **subagent** block when `is_subagent_tool(name)` — the same classification the parent
    transcript applies (`classifyToolStart`).
  - `thinking` and any other block type → no block.
- **FR-2.** A `tool_result` attributed to the agent fills the `meta` of the block minted for its
  `tool_use_id` and re-emits that block; it never appends one. A result for an unknown `tool_use_id` is
  ignored. `meta` is the same value FR-9 computes for the step (`tool_meta`, or `error`).
- **FR-3.** A tool block is `isStreaming: true` from FR-1 until FR-2 fills its `meta`; every other
  block kind is appended already final (`isStreaming: false`).
- **FR-4.** Every `AgentStep` of kind `notice` (async-agents FR-5/FR-15/FR-16/FR-18 — `dispatched in
  background`, the completion notice, `ended with the turn`, `killed from the panel`) also appends a
  **notice** block carrying the same label. Step/notice-block parity is structural: notices are minted
  in exactly one place (`push_step`).
- **FR-5.** The transcript holds at most **400** blocks per agent. On overflow the oldest is dropped
  and a per-agent `dropped` counter increments, so the window is never silent (§7). `blockId` is
  `"{agentId}:{n}"` with `n` strictly increasing per agent from 1 — stable React key and fill target.
- **FR-6.** Nothing here is serialized. All of it is cleared with the session, exactly like the trail.

### Core — channels

- **FR-7.** `francois:agents:transcript` returns the agent's windowed blocks plus its `dropped` count,
  or `AGENT_NOT_FOUND` when the id matches no agent in any session's registry — the same rule and
  code as `francois:agents:activity`.
- **FR-8.** Every appended or updated block is emitted as `agent.block` on `francois:agents:event`,
  carrying `sessionId`, `agentId` and the whole block.

### Frontend — the tab strip

- **FR-9.** The main pane's tab set becomes `OVERVIEW · SESSION · DIFF · SHELL` followed by zero or
  more **agent tabs**, in the order they were opened. An agent tab's id is `agent:{agentId}`.
- **FR-10.** A **click** on a card in pane [3] opens that agent's tab if absent, activates it, and
  moves focus to the main pane. The card is also selected, as before. Clicking a card whose tab is
  already open only activates it (no duplicate).
- **FR-11.** At most **6** agent tabs are open at once. Opening a 7th closes the oldest tab that is
  not the one being activated.
- **FR-12.** An agent tab renders `⇉ {name}` (name truncated to 14 chars with `…`), a status dot in
  the agent's status colour, and a `✕` on hover. `✕` closes it without changing the selection in
  pane [3].
- **FR-13.** Closing the **active** agent tab activates `session`. Closing an inactive one leaves the
  active tab alone.
- **FR-14.** ~~Switching the active session closes every agent tab; if an agent tab was active, `session`
  becomes active. (Agent ids are session-scoped — async-agents FR-23's rule for trails.)~~
  **Superseded by `fix-agent-view` FR-8** (2026-08-12): the open-tab list is keyed by session id, so a
  session switch no longer closes anything — the pane shows the incoming session's own tabs, and
  falls back to `session` only if it was on a dynamic tab. `clearAgentTabs` survives as the
  All-projects-widen path only.
- **FR-15.** Keyboard: with an agent tab active and no modal/input focused, `w` closes it (FR-13's
  fallback applies). `d` / `t` / `o` keep their existing toggle grammar and therefore leave an agent
  tab the same way they leave any other.

### Frontend — the tab body

- **FR-16.** Activating an agent tab issues `francois:agents:transcript` for its `agentId` and renders
  the returned blocks. While the request is in flight the body renders nothing (the `loading`
  convention of agents-panel).
- **FR-17.** `agent.block` events for that `agentId` are applied live: a block whose `blockId` is
  unknown appends, a known one replaces in place (this is how FR-2's `meta` fill lands). Events that
  arrive before the transcript response are applied **after** it and are never overwritten by it — the
  same race rule as async-agents FR-20.
- **FR-18.** The body auto-scrolls to the newest block unless the user has scrolled up inside it
  (within 8px of the bottom counts as at the bottom — async-agents FR-21's latch, reused).
- **FR-19.** The header shows the agent's name, its `async` marker when `background`, a status dot, the
  live elapsed time (`(endedAt ?? now) - startedAt`, async-agents FR-7) and the task line. It tracks
  `agent.update` from the session event stream.
- **FR-20.** `dropped > 0` renders a single dim leading row `… {dropped} earlier block(s)`.
- **FR-21.** `AGENT_NOT_FOUND` (or any transcript error) renders an inline error row with
  `AppError.message`; the tab stays open so the user can close it deliberately.

## 5. API contract

Domain: `agents`. Types live in `contract/agent-tab.ts`. `contract/common.ts` is **not** touched:
`AgentBlock` builds on conversation-view's block types, and common.ts is deliberately import-free —
which is why this feature takes its own domain event stream rather than a `SessionEvent` member.

**Channels owned by this feature**

| Channel | Direction | Payload | Result data | Error codes |
|---|---|---|---|---|
| `francois:agents:transcript` | frontend → core (`invoke`) | `AgentsTranscriptRequest` | `AgentTranscript` | `AGENT_NOT_FOUND` |

Physical binding: `invoke('agents_transcript', { agentId })` → `Promise<Result<AgentTranscript>>`.

**Events owned by this feature**

`francois:agents:event` → Tauri event `francois://agents/event`, payload `AgentEvent`:

```ts
{ type: 'agent.block'; sessionId: SessionId; agentId: AgentId; block: AgentBlock }
```

**Type definitions** — see `contract/agent-tab.ts` (authored with this spec):

```ts
export interface AgentNoticeBlock { kind: 'notice'; blockId: BlockId; isStreaming: false; text: string }
export type AgentBlock =
  | AssistantConversationBlock | ToolConversationBlock | SubagentConversationBlock | AgentNoticeBlock;
export interface AgentsTranscriptRequest { agentId: AgentId }
export interface AgentTranscript { blocks: AgentBlock[]; dropped: number }
export type AgentEvent = { type: 'agent.block'; sessionId: SessionId; agentId: AgentId; block: AgentBlock };
```

**Error semantics** — `AGENT_NOT_FOUND`: the `agentId` matches no agent in any session's registry.
Consistent with `francois:agents:activity` and `francois:agents:kill`. No new `ErrorCode` members.

## 6. Data & state

**Rust core** (`src-tauri/src/session/`, per-session, none of it serialized):

- `agent_blocks: HashMap<AgentId, VecDeque<BufBlock>>` — the ≤400-block window (FR-5), reusing the
  same `BufBlock` the parent transcript buffers and the same `classify_block` serializer.
- `agent_block_seq: HashMap<AgentId, u32>` — next `blockId` ordinal.
- `agent_blocks_dropped: HashMap<AgentId, u32>` — FR-5's eviction counter.
- `InnerTool` gains `block_id` so one `tool_result` fills both the step's and the block's `meta`.
- `BlockKind` gains `Notice`.

**Frontend**:

- `src/lib/store.ts`: `MainTab` gains the `` `agent:${string}` `` member; `agentTabs: AgentTabRef[]`
  (`{ id, name }`, open order) with `openAgentTab` / `closeAgentTab` / `clearAgentTabs`.
- `src/features/agents/agent-tab.ts`: `TranscriptState` (`blocks`, `buffer`, `dropped`, `loading`,
  `hydrated`, `error`, `atBottom`, `reqId`) — a direct sibling of `agent-trail.ts`'s `TrailState`,
  with the same reqId/buffer race discipline.

Derived, not stored: the header's elapsed string, the `async` marker, the `… N earlier blocks` row.

## 7. Edge cases & errors

- **Transcript returns 400 blocks but 640 were produced.** The window is a window: the leading
  `… 240 earlier blocks` row (FR-20) makes the truncation explicit.
- **A tool block never gets its result** (turn ended first). It keeps `isStreaming: true` and renders
  without a meta — the same honest "we never saw it finish" as the trail step.
- **`agent.block` arrives for a tab that is not open.** Ignored; the core's buffer is authoritative and
  FR-16 serves it on open.
- **The agent is killed, then revives** (async-agents FR-11). Nothing special: further blocks simply
  append after the `killed from the panel` notice block.
- **`AGENT_NOT_FOUND` on open.** FR-21's error row. Unlike the panel's card-drop rule the tab is NOT
  auto-closed — a tab vanishing under the cursor is worse than an empty one.
- **The tab's agent belongs to a removed session.** FR-14 already closed every agent tab on the
  session switch; a session removed while active leaves no agent tab behind.
- **The same agent clicked twice.** FR-10: activate, never duplicate.
- **7th tab opened.** FR-11 evicts the oldest, never the one being activated.

## 8. Design brief

### Screens / regions

The main pane's tab strip and body (`Claude Terminal.dc.html`, the SESSION/DIFF/SHELL strip). Agent
tabs extend the strip to the right of SHELL; the body is a new view in the same content area. Pane [3]
is unchanged except for the click behaviour.

### Components

- **Agent tab** (tab strip, after SHELL): the same `tabStyle` as the built-in tabs (11px, `0.14em`
  letter-spacing, 700, 2px bottom border in `var(--accent)` when active) with, left to right:
  a status dot (6px circle, `var(--accent-2)` running / `var(--success)` done / `var(--error)` error /
  `var(--text-muted)` idle, the running one pulsing like pane [3]'s), the `⇉` glyph in
  `var(--accent-2)`, and the agent name truncated to 14 chars. On hover the trailing `✕` appears in
  `var(--text-faint)`, `var(--error)` on its own hover. Not letter-spaced or upper-cased — an agent
  name is content, not a chrome label.
- **Tab body header** (fixed, above the scroller, `padding: 9px 14px`, `border-bottom: 1px solid
  var(--border)`): agent name in `var(--text-strong)`, the `async` marker (async-agents §8, reused
  verbatim), the status label in its status colour, then right-aligned `◷ {elapsed}` in
  `var(--text-faint)`. Second line: the task text, `font-size: 11px`, `color: var(--text-muted)`,
  ellipsized.
- **Block list**: the SESSION tab's block rendering, unchanged — same glyphs, colours, markdown and
  tool-card layout (`conversation-view` §8). This is the point of the feature: an agent's tab reads
  exactly like a session's.
- **Notice row**: `·` glyph in `var(--text-faint)` (async-agents §8's notice glyph) + the text in
  `var(--text-disabled)`, `font-size: 10.5px`, `padding: 2px 0`.
- **Truncation row**: `… {N} earlier block(s)`, `font-size: 10px`, `color: var(--text-disabled)`.
- **Error row**: `font-size: 11px`, `color: var(--error)`.
- **Empty** (hydrated, zero blocks): `no activity yet` (the trail's copy, reused), centered,
  `var(--text-faint)`.

### States

| State | Rendering |
|---|---|
| tab active | accent bottom border + accent label, like the built-in tabs |
| tab hover | `✕` replaces nothing — it appends at the right, the tab widens by its 12px |
| body loading | nothing (agents-panel's loading convention) |
| body hydrated, ≥1 block | block list, newest last, scrolled to bottom |
| body hydrated, 0 blocks | `no activity yet` |
| body windowed | leading `… N earlier blocks` row |
| body errored | inline error row |

### Interactions

- Click a card in pane [3] → tab opens/activates, focus moves to the main pane (FR-10).
- Click a tab → activates. Click `✕` (or `w`) → closes; the active one falls back to SESSION.
- New blocks append at the bottom and auto-scroll unless the user scrolled up (FR-18).
- No motion beyond the existing running-dot pulse.

### Resize / responsive

The strip is a flex row; agent tabs shrink (their name ellipsizes) before the built-in tabs do, and the
strip scrolls horizontally past that rather than wrapping. The body is the same full-height scroller as
the SESSION tab.

## 9. Acceptance criteria

- [x] An attributed `assistant` line with a text block produces an assistant block whose text is NOT
      truncated to 120 chars, alongside the existing 120-char step. (FR-1)
- [x] An attributed `tool_use` produces a tool block with the same summary as its step, and a
      `Task`/`Agent` tool_use produces a `subagent` block. (FR-1)
- [x] An inner `tool_result` fills that block's `meta` and re-emits the same `blockId` without
      appending. (FR-2, FR-3)
- [x] Every notice step has a matching notice block, for all four notice sites. (FR-4)
- [x] After 450 blocks, `agents_transcript` returns 400 blocks starting at ordinal 51 and
      `dropped: 50`. (FR-5, FR-20)
- [x] `agents_transcript` for an unknown `agentId` resolves `ok: false` with `AGENT_NOT_FOUND`. (FR-7)
- [ ] Clicking a card in pane [3] opens and activates `agent:{id}`, moves focus to main, and clicking
      it again does not duplicate the tab. (FR-10) — open/activate/no-duplicate verified by
      `agentTabStore.test.ts` + `agent-tab.test.ts`; the **focus-to-main** half is runtime-only and
      needs a `/smoke`.
- [x] Opening a 7th agent tab closes the oldest, never the one being opened. (FR-11)
- [x] Closing the active agent tab activates SESSION; closing an inactive one does not. (FR-13)
- [x] Switching sessions closes every agent tab and falls back to SESSION. (FR-14)
- [x] Blocks buffered from `agent.block` before the transcript response survive it. (FR-17)
- [ ] The body auto-scrolls to the newest block, but not while the user is scrolled up. (FR-18) —
      runtime DOM behaviour, needs a `/smoke`.
- [ ] `⏎` in pane [3] still expands the in-place trail; no agent tab is opened by the keyboard. (§2)
      — runtime keyboard flow, needs a `/smoke`.

## Remediation

- 2026-07-29 — /review round 2: **SHIP** (frontend SHIP · core SHIP). 4 findings (1 MEDIUM,
  3 LOW), none CRITICAL/HIGH or security — all parked in `specs/refactor-backlog.md` under
  `deferred:agent-tab` rather than fixed. Gates green: tsc clean, 506 frontend tests, 321 core tests.
- 2026-07-29 — /review round 1: 6 findings (1 CRITICAL, 3 MEDIUM, 2 LOW), all fixed.
  frontend 5/5 (FR-14 `clearAgentTabs()` on scope-widen · `AgentView` reqId computed before
  `setState` · tab-strip `overflowX` scroll container per §8 · `AgentTabRef.status: AgentStatus` ·
  dead `closeTranscript` export removed) · core 1/1 (notice-block assertions added to the two
  unpinned notice sites).
