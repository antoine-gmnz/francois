---
id: async-agents
title: Async agents — correct lifecycle + activity trail
status: frozen
created: 2026-07-25
depends_on: [session-engine, agents-panel, conversation-view]
---

# Async agents — correct lifecycle + activity trail

## 1. Summary

Claude Code's subagent tool runs **asynchronously by default**: the `tool_result` for an `Agent`
dispatch is a *spawn acknowledgement* delivered in milliseconds, not the agent's result. Francois
currently treats that ack as completion (`session.rs` "Task completion → agent done (FR-39)"), so
pane **[3]** flips a four-minute subagent to `done` with an elapsed time of `0s`. This spec replaces
session-engine's FR-37/FR-39/FR-40 subagent lifecycle with one that distinguishes synchronous from
background dispatch, and only stamps `endedAt` when the agent has actually finished.

The same stream already carries everything needed to see *inside* a running subagent: a subagent's
own assistant messages and tool results arrive as top-level `assistant`/`user` lines whose
`parent_tool_use_id` is the dispatch's `tool_use_id`. Francois drops those lines on the floor today.
This spec attributes them to their agent and turns them into an **activity trail** — a bounded,
ordered list of steps per agent — surfaced as a live "what it is doing right now" line on the card
and a scrollable trail in the expanded card.

## 2. Goals & non-goals

- **Goals**:
  - Classify every subagent dispatch as `background` or synchronous, and record it on `AgentInfo`.
  - Never stamp `endedAt` from a background dispatch's spawn ack; stamp it from the completion
    notification, from turn end, or from a kill — so the card's elapsed time is the agent's real
    wall-clock lifetime.
  - Attribute every `parent_tool_use_id`-bearing stream line to its agent and keep it **out** of the
    parent's SESSION transcript.
  - Own one new IPC channel (`francois:agents:activity`) and one new event member (`agent.step`).
  - Extend `AgentInfo` with `background`, `lastActivity`, `stepCount`.
  - Render the trail in pane [3]: a live activity line on the collapsed card, the full step list in
    the expanded card, and an `async` marker on background agents.
- **Non-goals**:
  - Making a background subagent outlive its turn. Francois runs one `claude -p` process per turn
    (`session.rs`, the `result` line drops stdin so the CLI can exit); a background agent dies with
    that process. FR-16 finalizes accordingly — keeping agents alive across turns is a separate
    feature and would require the persistent-session runtime, not this spec.
  - Actually *interrupting* a harness-side background agent from `francois:agents:kill`. The v1 note
    in `session.rs` stands: kill is a local bookkeeping operation (FR-18).
  - Persisting the trail. It is in-memory, per session, discarded on restart (§6) — durable-sessions
    owns the transcript file and gains nothing here.
  - The nested rendering of a subagent's inner conversation inside the SESSION tab's subagent block.
    This spec deliberately keeps inner events out of the transcript (FR-8); pane [3] is the one place
    they surface.
  - The `progress` ramp described in session-engine FR-38/§5.4. It was never implemented and
    `AgentInfo` carries no `progress` field; the elapsed clock is the progress signal. This spec does
    not reintroduce it.
  - Aggregate "N agents running" counters (app-shell) and the fleet board's per-session rollup —
    both consume `agent.update` unchanged and need no edit beyond the new optional fields.

## 3. User stories / flows

1. **Watch an async agent run.** The user sends a turn that dispatches a subagent. Within a second a
   card appears in pane [3]: name, task, `running`, an `async` marker, and a ticking elapsed timer.
   The meta row keeps updating — `◷ 12s · ⧉ Read src/session.rs`, then `◷ 31s · ⧉ Grep is_subagent_tool`
   — so the user can tell the agent is alive and roughly where it is. When the agent finishes, the
   card flips to `done`, the timer freezes at the real duration (e.g. `4m 07s`), and the task line
   becomes the result excerpt.
2. **Inspect an agent.** The user focuses pane [3], moves selection onto the running card and presses
   `⏎`. The card expands: full task text, then the activity trail — one row per step, newest at the
   bottom, auto-scrolling as new steps arrive. `⏎` again collapses it.
3. **Inspect a finished agent.** Same flow on a `done` card; the trail is served from the core's
   in-memory record and ends with the `finished` notice, so the user can reconstruct what it did.
4. **Synchronous subagent.** A dispatch with `run_in_background: false` (or the stock `Task` tool)
   behaves exactly as before: `running` → `done` on its `tool_result`, no `async` marker. Its trail is
   populated the same way.
5. **Agent still running when the turn ends.** The turn's `result` arrives while a background agent is
   still `running`. The card flips to `done` with the elapsed time frozen at turn end and a final
   `ended with the turn` notice in its trail — never a card stuck on `running` forever.
6. **Turn errors mid-agent.** The session errors; running agents flip to `error` (unchanged
   session-engine FR-40) and their trails end with an `ended with the turn` notice.

## 4. Functional requirements

### Dispatch classification

- **FR-1.** On `content_block_start` for a subagent tool (`Task` | `Agent`, per `isSubagentTool` /
  `is_subagent_tool`), the engine mints the `AgentInfo` as today (session-engine FR-37) and
  additionally records the dispatch's `tool_use_id` as that agent's **correlation key**. The
  correlation key is core-internal and never crosses IPC.
- **FR-2.** `background` is resolved at `content_block_stop` for that block, once the full input JSON
  is assembled, by this exact ladder:
  1. `input.run_in_background === false` → `background: false`
  2. `input.run_in_background === true` → `background: true`
  3. field absent and tool name is `Agent` → `background: true`
  4. field absent and tool name is `Task` → `background: false`

  The engine emits an `agent.update` carrying the resolved `background` at that point. (Rationale:
  the stock `Task` tool is synchronous; the `Agent` tool of the harness Francois targets runs in the
  background unless explicitly told otherwise. FR-11 is the safety net when this inference is wrong.)
- **FR-3.** `background` is fixed for the agent's lifetime once resolved. Between `content_block_start`
  and `content_block_stop` the agent is reported with `background: false` (the conservative default);
  no `endedAt` can be stamped in that window because no `tool_result` can arrive before the tool call
  is complete.

### Completion

- **FR-4.** For `background: false`, the paired `tool_result` completes the agent: `status: 'done'`
  (or `'error'` when the result's `is_error` is true), `endedAt = now`, `task` = the first line of the
  result text truncated to 80 chars (unchanged when that line is empty). This is session-engine FR-39
  restricted to synchronous dispatch; the `is_error` → `'error'` mapping is new (today every
  `tool_result` produces `'done'`).
- **FR-5.** For `background: true`, the paired `tool_result` is a **spawn acknowledgement**, not a
  completion. The engine MUST NOT change `status` and MUST NOT set `endedAt`. It instead:
  - stores the ack's text (trimmed, ≤200 chars) as the agent's core-internal `backendRef`, used for
    FR-9 matching,
  - appends an `AgentStep { kind: 'notice', label: 'dispatched in background' }` (FR-12),
  - emits `agent.update`.
- **FR-6.** In both cases the paired `tool.done` for the transcript block is emitted exactly as today
  — the SESSION tab's subagent card describes the *tool call*, and a background dispatch's tool call
  genuinely did finish at that moment.
- **FR-7.** `startedAt` is the FR-1 mint time and never changes. `endedAt` is set by exactly one of:
  FR-4 (synchronous completion), FR-9 (async completion notice), FR-16 (turn end),
  session-engine FR-40 (session error), or `francois:agents:kill` (FR-18). Nothing else may set it.
  The panel's elapsed formula stays `(endedAt ?? now) - startedAt`.

### Inner-event attribution

- **FR-8.** Every top-level stream line carrying a non-null `parent_tool_use_id` is attributed to the
  agent whose FR-1 correlation key equals it, and is **never** passed to the parent-turn handlers
  (`handle_stream_event` / `handle_tool_results`). The SESSION transcript therefore stays a record of
  the parent turn only. A `parent_tool_use_id` matching no known dispatch is ignored entirely.
- **FR-9.** Step extraction from attributed lines:
  - **`assistant` line** — for each content block, in order:
    - `text` → one `AgentStep { kind: 'text', label: <first non-blank line, ≤120 chars> }`; blocks
      that are blank after trimming produce no step.
    - `tool_use` → one `AgentStep { kind: 'tool', tool: <name>, label: <the same summary the engine
      derives for a top-level tool.start, per session-engine §5.4> }`, and the engine remembers that
      block's `tool_use_id` against the step's `seq` in a **per-agent** map (never the parent's
      tool index — the two must not be able to collide).
    - `thinking` and any other block type → no step.
  - **`user` line** — for each `tool_result`, the step remembered for its `tool_use_id` gets
    `meta = <the same meta the engine derives for a top-level tool.done>`, or `'error'` when
    `is_error` is true, and is re-emitted. A `tool_result` for an unknown `tool_use_id` is ignored.
  - **`stream_event` line** — dropped. Its content also arrives on the non-partial `assistant` line
    above; consuming both would double every step.
- **FR-10.** Every appended or updated step is emitted as `agent.step` (§5). Appending a step also
  sets the agent's `lastActivity` to that step's `label` and increments `stepCount`, and emits an
  `agent.update`. Updating an existing step's `meta` emits `agent.step` only (`lastActivity` and
  `stepCount` are unchanged by a `meta` fill).
- **FR-11.** **Liveness self-heal.** If an attributed line (FR-8) arrives for an agent whose `status`
  is not `running`, the engine first restores `status: 'running'`, clears `endedAt`, emits
  `agent.update`, and only then applies FR-9. Observed inner activity always outranks an inferred
  completion — this is what keeps a wrong FR-2 inference from producing a wrong elapsed time.
- **FR-12.** The trail holds at most **200** steps per agent. On overflow the oldest step is dropped;
  `seq` keeps increasing and `stepCount` keeps counting, so the trail is a window and `stepCount` is
  the true total. `seq` starts at 1 per agent and is strictly increasing.

### Async completion notice

- **FR-13.** A top-level line (`parent_tool_use_id` null or absent) of type `user` whose text content
  contains the substring `task-notification` (case-insensitive) is a background-agent completion
  notice.
- **FR-14.** The engine resolves a notice to an agent by trying, in order, and stopping at the first
  hit:
  1. a `background` agent of this session, still `running`, whose `backendRef` (FR-5) appears
     verbatim in the notice text;
  2. a `background` agent of this session, still `running`, whose `name` appears in the notice text;
  3. if exactly one `background` agent of this session is still `running`, that agent.

  A notice that resolves to no agent is ignored (and does not reach the transcript either — it is a
  harness-injected line, not user content).
- **FR-15.** A resolved notice sets `status: 'done'`, or `'error'` when the notice text matches
  `/\b(fail(ed|ure)?|error)\b/i`; sets `endedAt = now`; sets `task` to the first non-blank line of the
  notice truncated to 80 chars (unchanged when that line is empty); appends an
  `AgentStep { kind: 'notice', label: <first non-blank line, ≤120 chars> }`; and emits `agent.step`
  followed by `agent.update`.
- **FR-16.** **Turn-end finalization.** When a turn ends, every agent of that session still `running`
  is finalized before the turn's terminal `session.status` is emitted: `endedAt = now`, `status` =
  `'error'` if the turn errored (session-engine FR-40, unchanged) else `'done'`, plus an
  `AgentStep { kind: 'notice', label: 'ended with the turn' }`, then `agent.step` + `agent.update` per
  agent. This is the backstop that makes a correct elapsed time independent of FR-13's string match:
  the worst case is an elapsed time truncated to turn end, never one truncated to spawn time and
  never a card stuck on `running`.

### Panel (pane [3])

- **FR-17.** Card rendering additions, over agents-panel FR-8:
  - A `background` agent shows an `async` marker in row 1, between the name and the status label.
  - The meta row renders `◷ {elapsed} elapsed` as today and, when `lastActivity` is present, appends
    ` · {lastActivity}`, ellipsized to the row width. The elapsed portion never truncates.
  - `lastActivity` is rendered for every status, not only `running` — a finished agent's last line is
    its `ended with the turn` / completion notice, which is useful.
- **FR-18.** Killing an agent (agents-panel FR-19/FR-20/FR-21) additionally appends an
  `AgentStep { kind: 'notice', label: 'killed from the panel' }` and sets `endedAt = now` alongside
  the existing `status: 'error'`. The v1 limitation is unchanged: the harness-side background agent is
  not actually interrupted, so FR-11 may legitimately resurrect the card if it keeps emitting — that
  is the honest reading of what happened and is not treated as an error.
- **FR-19.** Expanding a card (agents-panel FR-13, `⏎`) issues `francois:agents:activity` for that
  `agentId` and renders the returned steps below the full task text. While the request is in flight
  the trail area renders nothing (no spinner, matching agents-panel's `loading` convention).
- **FR-20.** From the moment a card is expanded, `agent.step` events for that `agentId` are applied
  live: an event whose `step.seq` is unknown appends, an event whose `seq` is already present replaces
  that step in place (this is how FR-9's `meta` fill lands). Events buffered before the
  `activity` response arrives are applied after it, and the response never overwrites a step already
  present from a buffered event — the same race rule as agents-panel FR-2.
- **FR-21.** The trail auto-scrolls to the newest step when a step is appended **unless** the user has
  scrolled up inside it (within 8px of the bottom counts as "at the bottom"). Collapsing and
  re-expanding resets to the bottom and re-issues FR-19.
- **FR-22.** Only the expanded card subscribes/hydrates. Collapsing a card discards its local trail
  copy; the core keeps the authoritative trail, so re-expanding rebuilds it via FR-19. At most one
  card is expanded at a time (agents-panel FR-13, unchanged).
- **FR-23.** Switching the active session discards trails along with the agent map (agents-panel
  FR-4, unchanged).

## 5. API contract

Domain: `agents`. Types live in `contract/async-agents.ts`; the three `AgentInfo` fields are added to
`contract/common.ts` because `agent.update` is shared vocabulary (app-shell, fleet-board and
sessions-sidebar all consume it).

**Channels owned by this feature**

| Channel | Direction | Payload | Result data | Error codes |
|---|---|---|---|---|
| `francois:agents:activity` | frontend → core (`invoke`) | `AgentsActivityRequest` | `AgentStep[]` | `AGENT_NOT_FOUND` |

Physical binding: `invoke('agents_activity', { agentId })` → `Promise<Result<AgentStep[]>>`.

**Events owned by this feature**

Added as a member of `SessionEvent` (`francois:session:event` → Tauri `francois://session/event`):

```ts
| { type: 'agent.step'; sessionId: SessionId; agentId: AgentId; step: AgentStep }
```

`agent.update` is unchanged in shape; its `AgentInfo` payload gains the fields below.

**Type definitions**

`contract/common.ts` — `AgentInfo` gains three fields (no other change; `AgentStatus` is unchanged):

```ts
export interface AgentInfo {
  id: AgentId;
  sessionId: SessionId;
  name: string;
  task: string;
  status: AgentStatus;
  startedAt: number;
  endedAt?: number;
  /**
   * true when the dispatch was asynchronous (async-agents FR-2). For these, the dispatch's
   * tool_result is a spawn ack and never sets `endedAt` (FR-5) — the elapsed clock keeps running.
   */
  background: boolean;
  /** Label of the newest AgentStep (async-agents FR-10); absent until the first step. */
  lastActivity?: string;
  /** Total steps ever observed for this agent — may exceed the 200-step trail window (FR-12). */
  stepCount: number;
}
```

`contract/async-agents.ts`:

```ts
import type { SessionId, AgentId, AgentStep, Result } from './common';

// francois:agents:activity
export interface AgentsActivityRequest {
  agentId: AgentId;
}
export type AgentsActivityResponse = AgentStep[];
// invoke('agents_activity', req: AgentsActivityRequest): Promise<Result<AgentsActivityResponse>>

// ---------- consumed ----------
// francois:session:event → SessionEvent; this feature reacts to
//   { type: 'agent.step'; sessionId; agentId; step }  — filtered to the expanded agent (FR-20)
//   { type: 'agent.update'; agent }                   — for background / lastActivity / stepCount

export type { AgentStep, Result };
```

`AgentStep` lives in `contract/common.ts` (it rides on `SessionEvent`, which is shared vocabulary):

```ts
export type AgentStepKind =
  | 'text'   // the subagent said something
  | 'tool'   // the subagent called a tool
  | 'notice'; // lifecycle marker minted by the engine (dispatch / completion / kill / turn end)

export interface AgentStep {
  /** Strictly increasing per agent, starting at 1 — stable sort key and React key (FR-12). */
  seq: number;
  kind: AgentStepKind;
  /** epoch ms the step was observed. */
  at: number;
  /** Tool name for kind 'tool' (e.g. 'Read'); absent for the other kinds. */
  tool?: string;
  /** One line: tool summary, text excerpt, or notice text. Never empty. */
  label: string;
  /** kind 'tool' only: the derived meta once the step's tool_result arrived; absent while open. */
  meta?: string;
}
```

**Error semantics**

- `AGENT_NOT_FOUND` (`activity`): `agentId` matches no agent in any session's registry. Consistent
  with `francois:agents:kill`, and handled by the panel the same way (agents-panel §7: the card is
  dropped).

No new `ErrorCode` members are needed.

## 6. Data & state

**Rust core** (`src-tauri/src/session.rs`, per-session state):

- `agents: HashMap<AgentId, AgentInfo>` + `agent_order: Vec<AgentId>` — unchanged, now carrying the
  three new fields.
- `agent_by_tool: HashMap<String /* dispatch tool_use_id */, AgentId>` — the FR-1 correlation key.
  Lives on the session (not the turn-local `tools` map) so FR-13/FR-16 can reach it after the tool
  call is closed. Cleared with the session.
- `agent_steps: HashMap<AgentId, VecDeque<AgentStep>>` — the ≤200-step trail (FR-12).
- `agent_step_seq: HashMap<AgentId, u32>` — next `seq`.
- `agent_inner_tools: HashMap<AgentId, HashMap<String /* inner tool_use_id */, u32 /* seq */>>` —
  FR-9's per-agent inner tool index, deliberately separate from the parent turn's `tools` map.
- `agent_backend_ref: HashMap<AgentId, String>` — FR-5's ack text, for FR-14 matching.

None of this is serialized. `sessions.json` and the transcript file are untouched by this feature;
after a restart an agent's trail is gone and its card is gone with it (agents are already
session-lifetime-only, agents-panel §6).

**Frontend** (`src/AgentsPanel.tsx`), added to the existing per-session state:

- `trail: AgentStep[]` — the expanded card's steps, ordered by `seq`.
- `trailLoading: boolean`, `trailError: AppError | null` — the FR-19 request's state.
- `trailAtBottom: boolean` — FR-21's auto-scroll latch.

All discarded on collapse (FR-22) and on session switch (FR-23). Derived, not stored: the meta-row
string (`elapsed` + `lastActivity`), and the `async` marker (`agent.background`).

## 7. Edge cases & errors

- **The FR-13 notice format is the one unverified assumption in this spec.** It was derived from the
  harness's documented behaviour ("Subagents run in the background by default; you'll be notified when
  one completes") and not from a captured stream. FR-16 exists specifically so that a miss here costs
  precision (elapsed truncated to turn end) rather than correctness (elapsed truncated to spawn time,
  which is today's bug). **Verification step at `/build` time:** capture one real turn's NDJSON
  (`claude -p --output-format stream-json --include-partial-messages --verbose`) that dispatches a
  background agent, confirm the notice line's shape, and tighten FR-13/FR-14 to it — the FR-14 ladder
  is written so that step 3 alone already handles the common single-agent case.
- **FR-2 infers wrong (a `Task` that was actually async, or an `Agent` that was sync).** Either way
  FR-11 corrects it the moment inner activity contradicts the inferred completion, and FR-16 closes it
  at turn end. The visible cost is a card that briefly reads `done` and returns to `running`.
- **Two background agents complete and only FR-14 step 3 could have matched.** Step 3 requires
  *exactly one* running background agent, so with two in flight an unmatched notice is ignored and
  both are closed by FR-16 at turn end. No agent is ever attributed another's result.
- **Inner activity arrives for an agent that was killed (FR-18).** FR-11 resurrects it to `running`.
  Documented and intended — the kill did not actually stop the harness-side agent.
- **`agent.step` arrives for a collapsed or unknown card.** Ignored by the panel (FR-22); the core's
  trail is authoritative and FR-19 will serve it on expand.
- **`activity` returns 200 steps but `stepCount` is 640.** The trail is a window (FR-12). The expanded
  card renders a single dim leading row — `… {stepCount - trail.length} earlier steps` — so the
  truncation is never silent.
- **`activity` fails with `AGENT_NOT_FOUND`.** The expanded card shows the inline error line (§8) and,
  per agents-panel §7's existing rule for `kill`, the card is removed from the local map on the next
  render pass.
- **An attributed `assistant` line contains only `thinking`.** No step, no `agent.update` — the trail
  never shows empty rows.
- **A subagent dispatches its own subagent.** The inner `Agent` tool_use produces a `kind: 'tool'`
  step in the *parent* agent's trail (label = the nested agent's summary) and no `AgentInfo` of its
  own. Nested agent registration is out of scope; pane [3] stays one level deep.
- **Turn ends while a `tool_result` for an inner tool never arrived.** That step keeps `meta: undefined`
  and renders without a right-hand meta — an honest "we never saw it finish".
- **`background` is added as a required field on `AgentInfo`.** Every TS construction site
  (`src/*.test.ts`, `contract/fleet-board.test.ts`, palette fixtures) must be updated at `/build`
  time; `stepCount` likewise defaults to `0`. The Rust side is the only production constructor.

## 8. Design brief

### Screens / regions

Pane **[3]**, inside the AGENTS `<section>` (`Claude Terminal.dc.html` lines 178–198), extending the
agent card defined in `specs/agents-panel.md` §8. Two additions: the **async marker** and the meta-row
activity suffix on the collapsed card, and the **activity trail** inside the expanded card. No other
region of the app changes. Tokens below are given as the CSS custom properties the implementation
already uses (`src/styles.css`), with the mock's hex in parentheses.

### Components

- **Async marker** (row 1, between the name and the status label, `background === true` only):
  the literal text `async`, `font-size: 9px`, `letter-spacing: 0.08em`, `color: var(--text-faint)`
  (`#565a63`), `padding: 1px 5px`, `border-radius: 8px`, `background: var(--bg-raised)` (`#20222a`),
  `flex-shrink: 0`. It sits left of the status label and is **not** replaced by the hover-✕ (which
  only replaces the status label, agents-panel FR-19).
- **Meta row** (row 3, unchanged structure): `◷` / `·` glyph, then `{elapsed}`, then `elapsed` when
  running, then — when `lastActivity` is set — a ` · ` separator in `var(--text-disabled)` and the
  activity text in `var(--text-muted)` (`#6b7079`), `font-size: 10px`,
  `white-space: nowrap; overflow: hidden; text-overflow: ellipsis`, `flex: 1`, `min-width: 0`. The
  glyph and elapsed portion are `flex-shrink: 0` so only the activity text ellipsizes.
- **Activity trail** (expanded card only), directly below the full task line, `margin-left: 16px`
  (aligned with the task line, past the status dot), `margin-top: 6px`,
  `border-top: 1px solid var(--border)` (`#24262d`), `padding-top: 6px`, `max-height: 180px`,
  `overflow-y: auto`, using the app-wide `.scz` thin scrollbar.
  - **Truncation row** (only when `stepCount > trail.length`): `… {N} earlier steps`, `font-size: 10px`,
    `color: var(--text-disabled)`, `padding: 2px 0 4px`.
  - **Step row**: `display: flex; align-items: baseline; gap: 7px; padding: 2px 0; font-size: 10px`.
    - Glyph, `width: 10px; flex-shrink: 0; text-align: center`, per kind:
      `text` → `●` in `var(--text-dim)` (`#868a93`);
      `tool` → `⧉` in `var(--accent-2)` (`#d0a45c`);
      `notice` → `·` in `var(--text-faint)` (`#565a63`).
    - Label, `flex: 1; min-width: 0; color: var(--text-muted)` (`#6b7079`),
      `white-space: nowrap; overflow: hidden; text-overflow: ellipsis`. For `kind: 'tool'` the tool
      name is prefixed in `var(--text-dim)` followed by a space, then the summary — e.g.
      `Read src/session.rs` — matching how the SESSION tab renders a tool card.
    - Meta (`kind: 'tool'` with `meta` set), right-aligned, `font-size: 9.5px`,
      `color: var(--text-faint)`, `flex-shrink: 0`. The literal `error` meta renders in
      `var(--error)` (`#c46b62`).
  - **Trail error row**: `font-size: 10px`, `color: var(--error)`, `padding: 4px 0`, showing
    `AppError.message`.
  - **Empty trail** (expanded, hydrated, zero steps): `no activity yet`, `font-size: 10px`,
    `color: var(--text-disabled)`, `padding: 4px 0`.

### States

Card states are unchanged from agents-panel §8 (running / idle / done / error, selected, hover,
pending-kill, expanded, empty, loading, list-error). Added:

| State | Rendering |
|---|---|
| `background === true` | `async` marker in row 1 (all statuses) |
| `lastActivity` set | ` · {lastActivity}` appended to the meta row, ellipsized |
| expanded, trail loading | task text wraps; trail area renders nothing |
| expanded, trail loaded, ≥1 step | step rows, newest last, scrolled to bottom |
| expanded, trail loaded, 0 steps | `no activity yet` |
| expanded, trail windowed | leading `… N earlier steps` row |
| expanded, trail errored | inline error row in `var(--error)` |

A **pending-kill** card at `opacity: 0.55` dims the trail with it (it is inside the card) — no separate
treatment.

### Interactions

- `⏎` on the selected card (agents-panel FR-13) now also triggers the FR-19 fetch; collapse discards
  the trail (FR-22).
- New steps append at the bottom and auto-scroll (FR-21) unless the user has scrolled up; scrolling
  inside the trail does not change selection and does not bubble to pane focus.
- Clicking inside the trail selects the card like any other click on it (agents-panel FR-12); no row
  inside the trail is individually clickable in this version.
- The trail is not keyboard-navigable — `↑`/`↓` keep moving card selection (agents-panel FR-12), which
  collapses the expansion, which is the intended way out.

### Visual notes

- Typography JetBrains Mono throughout, weights 400/500 in the trail (no 700).
- No motion is introduced. The trail's auto-scroll is instantaneous (`scrollTop = scrollHeight`), matching
  the mock's convention of un-animated list updates. The running dot's `pulse 1.4s ease-in-out infinite`
  is unchanged and is now, correctly, the signal that an async agent is genuinely still working.
- The trail deliberately reuses the SESSION tab's tool-card vocabulary (glyph + name + summary + meta)
  at a smaller scale, so an agent's trail reads like a miniature transcript.

### Resize / responsive

- The trail's `max-height: 180px` is fixed; the card grows up to that and the pane's own `overflow: auto`
  (agents-panel §8) takes over beyond it. A card never pushes the pane's header or the panes below it.
- Every trail row ellipsizes rather than wraps at any pane width, including the expanded state — the
  expansion widens the *task* line only (agents-panel FR-14).

## 9. Acceptance criteria

- [ ] An `Agent` dispatch with no `run_in_background` field yields `AgentInfo.background === true`; a
      `Task` dispatch yields `false`; an explicit `run_in_background` always wins over the tool name. (FR-2)
- [ ] A background dispatch's `tool_result` leaves `status: 'running'` and `endedAt` unset, and the
      card's elapsed timer keeps ticking. (FR-5, FR-7)
- [ ] A synchronous dispatch's `tool_result` still produces `status: 'done'`, `endedAt` set, and the
      result excerpt as `task`; a `tool_result` with `is_error: true` produces `status: 'error'`. (FR-4)
- [ ] Both dispatch kinds still emit exactly one `tool.done` for the transcript block. (FR-6)
- [ ] An `assistant` line with `parent_tool_use_id` set produces no `assistant.delta` / `assistant.done`
      / `tool.start` on the SESSION transcript, and produces `agent.step` events on the matching agent
      instead. (FR-8, FR-9)
- [ ] A `stream_event` line with `parent_tool_use_id` set produces no event at all — the trail's step
      count for that agent is identical whether or not `--include-partial-messages` is on. (FR-9)
- [ ] An inner `tool_result` fills the `meta` of the step whose `tool_use_id` it matches and re-emits
      that same `seq`, without appending a new step and without changing `stepCount`. (FR-9, FR-10)
- [ ] An attributed line for an agent already marked `done` restores it to `running` and clears
      `endedAt`. (FR-11)
- [ ] After 250 steps, `agents_activity` returns 200 steps starting at `seq` 51, `stepCount` is 250, and
      the expanded card shows `… 50 earlier steps`. (FR-12, §7)
- [ ] A top-level `user` line containing `task-notification` closes the single running background agent
      with `status: 'done'` and `endedAt` at notice time; a notice matching `/error|fail/i` closes it as
      `'error'`. (FR-13, FR-14, FR-15)
- [ ] A notice arriving while two background agents run is ignored, and both are closed by turn end. (FR-14, §7)
- [ ] When a turn ends cleanly, no agent of that session is left `running`: each gets `endedAt` at turn
      end, `status: 'done'`, and a final `ended with the turn` notice step. (FR-16)
- [ ] When a turn errors, still-running agents get `status: 'error'` (session-engine FR-40) *and*
      `endedAt`, and the same notice step. (FR-16)
- [ ] A card for a `background` agent renders the `async` marker; a synchronous one does not. (FR-17)
- [ ] The meta row of a running agent shows `◷ {elapsed} elapsed · {lastActivity}` and ellipsizes only
      the activity portion. (FR-17)
- [ ] `⏎` on a card issues `agents_activity` once and renders the returned steps; `⏎` again collapses
      and discards them; re-expanding re-issues the call. (FR-19, FR-22)
- [ ] `agent.step` events arriving while a card is expanded append (unknown `seq`) or replace (known
      `seq`) in place, and events buffered before the `activity` response are applied after it without
      being overwritten by it. (FR-20)
- [ ] The trail auto-scrolls to the newest step, but not while the user is scrolled up inside it. (FR-21)
- [ ] `agents_activity` for an unknown `agentId` resolves `ok: false` with `AGENT_NOT_FOUND`. (§5, §7)
- [ ] A four-minute background subagent's card, from dispatch to completion, reports an elapsed time
      within one second of four minutes — the regression this spec exists for. (FR-5, FR-7, FR-16)

## Remediation

(Empty until a review returns findings.)
