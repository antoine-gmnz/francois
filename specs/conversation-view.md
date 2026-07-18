---
id: conversation-view
title: Conversation view (SESSION tab)
status: frozen
created: 2026-07-18
depends_on: [session-engine, app-shell]
---

# Conversation view (SESSION tab)

## 1. Summary

Conversation-view owns the content of the main pane's **SESSION** tab (`Claude Terminal.dc.html:71-116`): a scrolling, structured transcript of the active session's Claude Code activity — user messages, assistant text, tool calls, and subagent dispatches, rendered as typed blocks with streaming support — plus the follow-up input bar at the bottom. It also owns the session-meta cluster on the main pane header's right side (model label, context usage, elapsed time), which is visible only while the SESSION tab is active. The transcript is built by hydrating a snapshot from session-engine's in-memory per-session event buffer and then applying the live `SessionEvent` stream in place, so a freshly opened or re-focused session always renders full history plus anything still in flight.

## 2. Goals & non-goals

- **Goals**:
  - Render the ordered transcript of a session as typed `ConversationBlock`s (user / assistant / tool / subagent), matching the mock's glyphs, colors, and metadata format exactly.
  - Stream assistant text with a blinking block cursor; open/close tool blocks with `tool.start`/`tool.done`.
  - Hydrate on mount and on session switch with no gaps and no duplicated text (defined dedup/ordering protocol).
  - Provide a precise, testable auto-scroll/pin model with a "jump to latest" affordance.
  - Provide the input bar: multiline compose, Enter-to-send, `/`-passthrough, queued-while-running chip, disabled states for `done`/`error`.
  - Render the session-meta cluster (model, context usage, elapsed time) on the header, SESSION tab only.
- **Non-goals**:
  - The tab strip itself (SESSION / DIFF / SHELL labels, badge, active-tab switching, keyboard shortcuts `d`/`t`) — owned by `app-shell`.
  - DIFF tab content — `diff-view`. SHELL tab content — `shell-terminal`.
  - Session list, selection, and creation (`activeSessionId` source) — owned by `sessions-sidebar`; this feature only reads whatever the app's shared UI state exposes as the active session.
  - Spawning/stopping sessions, computing context usage/elapsed on the backend, and the authoritative transcript buffer — owned by `session-engine`.
  - Agents/MCP/skills panels and the command palette (including its "Compact context", "Switch model", "Kill agent" actions) — their own specs.
  - Message virtualization / windowing for very long transcripts (flagged as a future perf concern, not required for v1).

## 3. User stories / flows

1. **Open a session with history.** User selects a session in the sidebar (or it's already active). SESSION tab shows the full transcript scrolled to the bottom, header shows model/context/elapsed, input bar is focused and ready.
2. **Send a first message in an empty session.** User types in the input bar, presses `Enter`. An optimistic "YOU" block appears at the bottom (bg `#1b1d23`), transcript re-pins to bottom, input clears.
3. **Send a follow-up while the assistant is still running.** Session `status === 'running'`. User types and presses `Enter` anyway — allowed. The new user block renders immediately with a `queued` chip next to "YOU"; the chip disappears once the engine's `message.user` event for that block arrives.
4. **Watch a tool call.** A `tool.start` event adds a one-line block (`⧉ Read  src/auth/middleware.ts`) with no meta yet; the matching `tool.done` appends ` · 128 lines` in faint text.
5. **Watch a subagent dispatch.** A `tool.start` with `tool: 'Task'` renders `⇉ Dispatched subagent  test-writer`; the matching `tool.done` appends ` · writing tests`.
6. **Read history while streaming.** User scrolls up mid-stream; the view unpins and stays put while new blocks keep arriving below the fold. A "↓ jump to latest" pill appears; clicking it scrolls to bottom and re-pins.
7. **Switch sessions and back.** User presses `2`-then-sidebar-select or clicks another session; SESSION tab shows a hydration state, then that session's transcript, pinned to bottom. Switching back to the first session re-hydrates it (no stale content flash from the second session).
8. **Session finishes.** `status` becomes `'done'`. Input bar becomes disabled with hint "session ended — press n for a new one"; transcript is left as-is (final state), still scrollable.
9. **Session errors.** `status` becomes `'error'`. Input bar disables with `SessionMeta.errorMessage` (or a generic fallback) as the hint.
10. **Run a slash command.** User types `/compact` and presses `Enter`. Text is sent byte-for-byte via `francois:session:send`, no client-side interpretation.
11. **Multiline compose.** User presses `Shift+Enter` to add a line break, keeps typing, then `Enter` to send the whole multi-line message as one block.
12. **No active session.** User has no session selected (e.g., first launch, all sessions removed). Main pane shows a centered empty-state hint instead of a transcript.

## 4. Functional requirements

**Tab ownership & header cluster**

- **FR-1**: Conversation-view renders inside the SESSION tab's content region only; it never renders the tab strip (labels, DIFF badge, active-tab border) — that markup and its click handlers belong to `app-shell`.
- **FR-2**: The session-meta cluster (`Claude Terminal.dc.html:80-86`) is rendered on the main pane header's right side if and only if the SESSION tab is the active main tab AND an `activeSessionId` is set. It is absent for DIFF/SHELL and for the no-session state.
- **FR-3**: The cluster shows, left to right, gap 14px: model label, `ctx` + used/limit, elapsed — see §8 for exact colors.
- **FR-4**: Context usage is formatted by `formatContextTokens(n: number): string`: if `n < 1000`, return `String(n)`; else divide by 1000, format to exactly one decimal place, then strip a trailing `.0` (so `48200` → `"48.2K"`, `200000` → `"200K"`, not `"200.0K"`). Applied independently to `contextUsedTokens` and `contextLimitTokens`.
- **FR-5**: Context usage renders as `<used>` in bright text (`#dfe2e8`) immediately followed by `/<limit>` in faint text (`#565a63`), e.g. `48.2K` bright + `/200K` faint — no space around the `/`.
- **FR-6**: Elapsed time is computed from `SessionMeta.startedAt`: `elapsedMs = clockNow - startedAt`, where `clockNow` ticks every 1000ms via a local interval while the SESSION tab and cluster are visible AND `status === 'running'`; when `status` is `'idle'`, `'done'`, or `'error'`, the clock freezes at `lastActivityAt - startedAt` (elapsed stops advancing once the session is no longer actively running). Format: if `elapsedMs < 3 600 000`, render `MM:SS` (minutes not padded past 2 digits, wraps into hours past 59:59); else render `H:MM:SS` (hours unpadded, minutes and seconds zero-padded to 2 digits). Both `MM` and `SS` are always zero-padded to 2 digits.
- **FR-7**: The model label shows `SessionMeta.model.label` verbatim (e.g. `Sonnet 4.5`).

**Hydration & live updates**

- **FR-8**: On mount, and whenever `activeSessionId` changes to a non-null value, conversation-view runs the hydration protocol (§6) for that session: subscribe to `francois:session:event` first (if not already globally subscribed), buffer events for the target session, call `francois:conversation:getTranscript({ sessionId })`, seed local state from the response, replay the buffered events in arrival order, then switch to applying further events live.
- **FR-9**: If `activeSessionId` changes again before a prior hydration's `getTranscript` call resolves, the stale response is discarded on arrival (compare the response's originating `sessionId` against the current `activeSessionId`; mismatch → discard, no state mutation).
- **FR-10**: Every event applied to the local block list is a keyed operation on `blockId` (§6 "Apply rules"). Applying the same `tool.start`, `tool.done`, `message.user`, or `assistant.done` event a second time for a `blockId` already reflecting that event's data is a no-op (idempotent upsert). `assistant.delta` is append-only and is never replayed twice under the hydration protocol in FR-8 (each delta is applied exactly once, either as part of the snapshot or as a buffered/live event, never both).
- **FR-11**: `assistant.delta` for an unseen `blockId` opens a new `AssistantConversationBlock` with `isStreaming: true` and `text` set to the event's `text`; for a known `blockId` it appends the event's `text` to the block's existing `text`.
- **FR-12**: `assistant.done` sets the matching block's `isStreaming` to `false`. If no block with that `blockId` exists (defensive case), the event is ignored.
- **FR-13**: `tool.start` creates a block keyed by `blockId`, `isStreaming: true`, classified per the glyph map (§8) from `event.tool`; `event.tool === 'Task'` creates a `SubagentConversationBlock` (parsing `agentName` from `event.summary`), every other tool name creates a `ToolConversationBlock` with `tool: event.tool`, `summary: event.summary`. If a block with that `blockId` already exists, the event is a no-op.
- **FR-14**: `tool.done` sets the matching block's `meta` to `event.meta` and `isStreaming` to `false`. If no block with that `blockId` exists (should not happen once hydrated — see FR-8's ordering guarantee), the event is ignored.
- **FR-15**: `message.user` upserts a `UserConversationBlock`: if `blockId` exists (the common case — the optimistic block from FR-19), set `text: event.text`, `queued: false`; if absent (message originated some other way), insert a new, non-queued user block with that `text`.
- **FR-16**: Blocks are kept in a single ordered list per session; new blocks are appended to the end on creation, existing blocks are mutated in place (position never changes).

**Scroll / pin behavior**

- **FR-17**: The transcript scroll container starts each session hydration pinned to bottom (`isPinned = true`) and is scrolled to `scrollHeight` after the initial render.
- **FR-18**: While `isPinned === true`, every block append or block mutation that changes rendered height scrolls the container to bottom synchronously after the DOM update (no animation).
- **FR-19**: A user-initiated scroll (wheel, trackpad, scrollbar drag, keyboard scroll) that leaves the container more than 32px from the bottom sets `isPinned = false` and shows the "↓ jump to latest" affordance (§8). A user-initiated scroll that lands within 32px of the bottom does **not** by itself re-pin — only the two triggers in FR-20 do (kept deterministic, not scroll-position-driven, to avoid pin/unpin thrashing while reading near the bottom).
- **FR-20**: `isPinned` is set back to `true`, and the container is scrolled to bottom, exactly on: (a) the user clicking the "jump to latest" affordance, or (b) the user successfully sending a message (FR-21). Both hide the affordance.

**Input bar**

- **FR-21**: Pressing `Enter` without `Shift` in the input bar, with non-whitespace-only content, does not insert a newline; it: generates a new `blockId` (uuid v4), optimistically appends a `UserConversationBlock { blockId, text, queued: true, isStreaming: false }`, re-pins the transcript (FR-20), clears the input box, and calls `francois:session:send({ sessionId: activeSessionId, blockId, text })`.
- **FR-22**: `Shift+Enter` inserts a literal newline and does not send.
- **FR-23**: Text beginning with `/` is sent through FR-21 unmodified — no client-side slash-command parsing, autocomplete, or interception.
- **FR-24**: Sending is permitted regardless of `status` being `'running'` or `'idle'` (engine-side FIFO queueing per session-engine).
- **FR-25**: The input bar is disabled (not focusable/editable, send blocked) when the active session's `status` is `'done'` or `'error'`. When `'done'`, the input area shows the hint "session ended — press n for a new one" in place of the placeholder. When `'error'`, it shows `SessionMeta.errorMessage` if present, else the literal string "session error". Both hints replace the normal placeholder text and use the same faint styling; the `›` prompt glyph dims to `#3a3d45`.
- **FR-26**: If `francois:session:send` resolves `ok: false`, the optimistic block from FR-21 is removed from the transcript, the original text is restored into the input box (not lost), and the error's `message` is shown as a transient inline notice below the input bar for 4 seconds.

**Empty states**

- **FR-27**: When there is no `activeSessionId`, the entire SESSION tab content area (transcript + input bar) is replaced by a single centered hint (§8); the header session-meta cluster is hidden per FR-2.
- **FR-28**: When a session is active but its transcript has zero blocks (fresh session, no events yet), the transcript area shows a centered block with the session's `cwd`, model label, and the line "waiting for your first prompt"; the input bar remains enabled/present underneath as normal.

## 5. API contract

Types below live in `contract/conversation-view.ts` and import shared vocabulary from `contract/common.ts`:

```ts
import type {
  SessionId,
  BlockId,
  Result,
} from './common';
```

### Owned by this feature

**Channel: `francois:conversation:getTranscript`**

- Domain: `conversation`. Direction: frontend → core (`invoke`).
- Payload: `GetTranscriptRequest`.
- Resolves: `Result<ConversationBlock[]>` — the full ordered block buffer for the session at the moment the Rust core handles the request, served from session-engine's in-memory per-session buffer (session-engine owns the buffer; this feature only owns the read channel and the `ConversationBlock` shape it returns).
- Error codes: `SESSION_NOT_FOUND` (no session with that id).

```ts
export interface GetTranscriptRequest {
  sessionId: SessionId;
}

/** Glyph characters used in the transcript's glyph column. '' = no glyph column (user blocks). */
export type ConversationGlyph = '●' | '⧉' | '⌕' | '✎' | '⇉' | '';

export type ConversationBlockKind = 'user' | 'assistant' | 'tool' | 'subagent';

interface ConversationBlockBase {
  blockId: BlockId;
  isStreaming: boolean;
}

/** "YOU" block. Fixed accent border/label styling (§8) — no data-driven glyph/color. */
export interface UserConversationBlock extends ConversationBlockBase {
  kind: 'user';
  text: string;
  /** true from optimistic send (FR-21) until the matching `message.user` event is applied (FR-15). */
  queued: boolean;
}

/** Assistant text line(s). Color/glyph vary with streaming state, hence explicit fields. */
export interface AssistantConversationBlock extends ConversationBlockBase {
  kind: 'assistant';
  glyph: '●';
  /** '#868a93' normally, '#c8a15a' while isStreaming (see §8 glyph map). */
  glyphColor: '#868a93' | '#c8a15a';
  /** '#c4c7ce' normally, '#dfe2e8' while isStreaming. */
  bodyColor: '#c4c7ce' | '#dfe2e8';
  text: string;
}

/** Tool call one-liner: `Read`, `Grep`, `Edit`, `Write`, or any other tool name (fallback glyph). */
export interface ToolConversationBlock extends ConversationBlockBase {
  kind: 'tool';
  tool: string; // raw tool name from `tool.start`
  glyph: '⧉' | '⌕' | '✎' | '●';
  glyphColor: '#868a93' | '#7fa07a';
  bodyColor: '#868a93';
  summary: string; // from `tool.start.summary`
  meta?: string; // from `tool.done.meta`; absent while isStreaming
}

/** Subagent dispatch line, classified from a `tool.start` with `tool === 'Task'`. */
export interface SubagentConversationBlock extends ConversationBlockBase {
  kind: 'subagent';
  glyph: '⇉';
  glyphColor: '#c8a15a';
  bodyColor: '#b9bcc4';
  agentName: string; // parsed from `tool.start.summary`
  meta?: string; // from `tool.done.meta`, e.g. 'writing tests'
}

export type ConversationBlock =
  | UserConversationBlock
  | AssistantConversationBlock
  | ToolConversationBlock
  | SubagentConversationBlock;
```

### Consumed (owned elsewhere — shapes pinned here because this feature builds against them)

**Channel: `francois:session:event`** — owned by `session-engine` (domain `session`), direction core → frontend, payload `SessionEvent` (tagged union, `contract/common.ts`). Conversation-view subscribes and reacts to these members only: `session.meta`, `session.status`, `session.error`, `context.usage`, `message.user`, `assistant.delta`, `assistant.done`, `tool.start`, `tool.done`. It ignores `agent.update`, `mcp.update`, `session.removed` (other features' concern; `session.removed` for the active session is handled by app-shell clearing `activeSessionId`, which this feature then reacts to via FR-27).

**Channel: `francois:session:send`** — owned by `session-engine` (domain `session`), direction frontend → core (invoke). This feature depends on it having exactly this shape; the authoritative definition (and its own error semantics beyond what's listed) lives in the `session-engine` spec/contract:

```ts
export interface SendMessageRequest {
  sessionId: SessionId;
  blockId: BlockId; // client-generated uuid v4; echoed back by the eventual `message.user` event
  text: string;
}
// resolves Result<{ blockId: BlockId }>
// error codes this feature handles: SESSION_NOT_FOUND, SESSION_NOT_RUNNING, INVALID_INPUT
```

## 6. Data & state

**Frontend state** (zustand slice owned by this feature, keyed by `SessionId`):

```ts
interface ConversationSessionState {
  blocks: ConversationBlock[];          // display order, oldest first
  blockIndex: Map<BlockId, number>;     // blockId -> index into blocks, for O(1) upsert
  hydrated: boolean;                    // false until the first getTranscript response is applied
  pendingBuffer: SessionEvent[];        // events queued between subscribe and getTranscript resolving
  isPinned: boolean;                    // scroll pin state, per session
  status: SessionStatus;                // mirrors SessionMeta.status, updated by session.meta / session.status
  errorMessage?: string;                // mirrors SessionMeta.errorMessage
  meta: {
    modelLabel: string;
    contextUsedTokens: number;
    contextLimitTokens: number;
    startedAt: number;
    lastActivityAt: number;
  } | null;
}
```

State for sessions other than `activeSessionId` may be kept warm in memory (cheap: it's just arrays/maps) so switching back to a recently viewed session doesn't require a full re-hydration flash — but is not required to persist across app restarts (no disk persistence for this feature; session-engine's buffer is the durable-for-the-process source of truth).

**Hydration protocol (detail for FR-8/FR-9/FR-10):**

1. On entering a session (mount or `activeSessionId` change), ensure a subscription to `francois:session:event` is active (subscription is process-wide / owned once by the frontend shell; conversation-view attaches a per-session filter to it).
2. Mark the session's slice `hydrated: false`, `pendingBuffer: []`. Any event for that `sessionId` received from this point is pushed to `pendingBuffer` instead of being applied.
3. Call `francois:conversation:getTranscript({ sessionId })`.
4. On `ok: true`: set `blocks`/`blockIndex` from `data` (in order), then apply every event in `pendingBuffer` in array order using the normal apply rules (FR-10 to FR-15), clear `pendingBuffer`, set `hydrated: true`. From here on, incoming events for this session are applied immediately (no buffering).
5. On `ok: false`: show the transcript error state (§7), keep `pendingBuffer` intact, and offer retry (re-running from step 3); do not discard buffered events since they may still apply once a retry succeeds.
6. Ordering guarantee this relies on: `getTranscript`'s reply and `session:event` pushes travel over the same core→frontend IPC channel for a given window, so they are delivered in the order the Rust core sent them. Any event the Rust core emitted before computing the `getTranscript` snapshot is therefore already reflected in that snapshot; any event emitted after is guaranteed to arrive after the reply. This is what makes step 4's replay exactly-once rather than a risk of double-applying an `assistant.delta`.

**Derived (pure, no state):** `formatContextTokens(n)` (FR-4) and `formatElapsed(elapsedMs)` (FR-6) are pure functions of `meta` + a 1Hz clock tick; not persisted.

**Rust core:** conversation-view contributes exactly one Tauri command handler (`francois:conversation:getTranscript`) that reads session-engine's exported buffer accessor for the session and maps it to `ConversationBlock[]` (the block-classification logic in FR-13's glyph map is defined once, in the shared TypeScript contract, and mirrored between the Rust core, for building the snapshot, and the frontend, for live events, per this project's contract-mirroring convention — see PIPELINE.md). It owns no persistent state of its own; session-engine owns the buffer's lifetime (creation on session start, eviction on `session.removed`).

## 7. Edge cases & errors

| Case | Behavior |
|---|---|
| `getTranscript` resolves `SESSION_NOT_FOUND` | Transcript area shows an inline error block: "session not found" (dim/error styling), no input bar; typically transient during session teardown — app-shell clearing `activeSessionId` on `session.removed` resolves it. |
| `getTranscript` rejects due to IPC/transport failure (should not happen — invoke never throws per PIPELINE.md convention, but defensively) | Treated identically to `ok: false` with code `INTERNAL`; retry affordance shown. |
| `activeSessionId` changes mid-hydration | Stale response discarded (FR-9); new hydration for the new id proceeds normally. |
| Session removed (`session.removed`) while it is the active session | app-shell clears `activeSessionId`; this feature drops that session's slice and falls into the no-session empty state (FR-27). |
| `session:send` resolves `SESSION_NOT_FOUND` / `SESSION_NOT_RUNNING` / `INVALID_INPUT` | FR-26 applies: optimistic block removed, text restored to input, transient inline error shown. |
| Empty or whitespace-only input + `Enter` | No-op client-side — no block created, no IPC call. |
| Session ends (`done`/`error`) while a sent message is still unacked (`queued: true` and no `message.user` yet) | The block keeps its `queued` chip indefinitely (never claims success it can't verify); no additional error is synthesized for it. |
| `tool.done` / `assistant.done` arrives for a `blockId` the buffer doesn't know about, after hydration is complete | Ignored (FR-12, FR-14) — defensive only; should not occur given the FIFO ordering guarantee in §6. |
| Very long transcript (thousands of blocks) | No windowing/virtualization in v1 (non-goal); scroll remains a plain DOM scroll container. Acceptable perf ceiling is not specified here. |
| Window/pane resized very narrow | See §8 resize rules — text reflows, glyph column and meta suffix never wrap independently of body text. |
| Multiple rapid `Enter` sends before any ack | Each gets its own `blockId`/optimistic block, all shown `queued: true`, cleared independently as their `message.user` events arrive — order of acks may differ from send order if the engine reorders, but this feature never reorders blocks once inserted (FR-16). |

## 8. Design brief

### Screens / regions

Main pane `[2]`, SESSION tab content — `Claude Terminal.dc.html:88-116` (the `sc-if value="{{ isSession }}"` branch) plus the header's right-side cluster at `Claude Terminal.dc.html:80-86`. The header tab strip (`:72-79`) and the DIFF/SHELL branches (`:117-171`) are out of scope.

### Components

1. **Session-meta cluster** (header, right side, SESSION tab only).
2. **Transcript scroll container** — vertical list of `ConversationBlock`s.
3. **User block** ("YOU").
4. **Other block** (assistant / tool / subagent) — shared glyph-column layout, per-kind colors.
5. **Streaming cursor** — inline blinking rectangle appended to an open assistant block's text.
6. **Queued chip** — small pending indicator on an unacked user block.
7. **Jump-to-latest affordance** — floating pill over the transcript, bottom-center.
8. **Input bar** — prompt glyph, multiline textarea, right hint.
9. **Empty states** — no-session hint; no-blocks-yet hint.

### States

- **Session-meta cluster**: visible / hidden (per FR-2).
- **Transcript**: hydrating (no visible flash — previous session's content, if any, is replaced only once the new snapshot is ready; first-ever hydration shows nothing until data arrives, sub-100ms in practice) / hydrated-with-blocks / hydrated-empty (FR-28) / error (FR-27's sibling, `getTranscript` failure).
- **Assistant block**: idle (dim glyph `#868a93`, body `#c4c7ce`) / streaming (accent glyph `#c8a15a`, body bright `#dfe2e8`, cursor visible).
- **Tool/subagent block**: streaming (`isStreaming: true`, no meta suffix) / done (meta suffix present, `isStreaming: false`).
- **User block**: normal / queued (chip visible).
- **Scroll**: pinned / unpinned (affordance visible).
- **Input bar**: enabled-idle (placeholder shown) / enabled-typing / disabled-done / disabled-error.

### Interactions

- Sending: `Enter` (no modifier) sends; `Shift+Enter` newlines. Typing while `status` is `running`/`idle` is always allowed.
- Scrolling: any user scroll gesture that ends >32px from bottom unpins (FR-19); clicking "↓ jump to latest" scrolls to bottom and re-pins (FR-20); sending always re-pins (FR-20).
- Clicking a tool/subagent block does nothing in v1 (no drill-down — non-goal).
- Hover states follow the mock's general convention (subtle background lift on interactive rows only); transcript blocks are not interactive/hoverable since they're not clickable.

### Visual notes (exact tokens)

**Session-meta cluster** (`gap:14px; font-size:10.5px;` row, base color `#868a93`):
- Model label: `#868a93` (dim), e.g. `Sonnet 4.5`.
- `ctx` literal label: `#565a63` (faint).
- Used value: `#dfe2e8` (bright) — e.g. `48.2K`.
- `/` + limit value: `#565a63` (faint) — e.g. `/200K`, no space before `/`.
- Elapsed value: `#565a63` (faint), e.g. `02:14` or `1:04:37`.

**User block** (`Claude Terminal.dc.html:94-97`):
- Container: `background:#1b1d23; border-left:2px solid #c8a15a; border-radius:0 4px 4px 0; padding:10px 13px;`.
- Label row: `"YOU"`, `font-size:10px; letter-spacing:0.12em; color:#c8a15a; margin-bottom:5px;` — queued chip (if any) sits at the right end of this same row.
- Body: `font-size:13px; color:#d3d6dc; line-height:1.55;`.

**Queued chip**: text `queued`, `font-size:9.5px; letter-spacing:0.04em; color:#c2b06a;` (reuses the "connecting" status token — semantically "pending, not yet confirmed"), preceded by a 5px dot of the same color animated `pulse 1.4s ease-in-out infinite` (same pulse used for running/connecting dots elsewhere).

**Other blocks** (`Claude Terminal.dc.html:99-107`): row `display:flex; gap:10px;`.
- Glyph column: `width:16px; flex-shrink:0; text-align:center; font-size:12px; margin-top:1px;` color per glyph map below.
- Body: `min-width:0; flex:1; font-size:12.5px; line-height:1.55;` color per glyph map below.
- Meta suffix (when present): `<space>·<space>` + text, all `color:#565a63`.

**Glyph map:**

| Source | Glyph | glyphColor | bodyColor | Notes |
|---|---|---|---|---|
| assistant text, idle | `●` | `#868a93` | `#c4c7ce` | |
| assistant text, streaming | `●` | `#c8a15a` | `#dfe2e8` | cursor appended (below) |
| `tool.start` tool `Read` | `⧉` | `#868a93` | `#868a93` | body = `Read  <summary>` (two spaces) |
| `tool.start` tool `Grep` / `Search` | `⌕` | `#868a93` | `#868a93` | body = `<Tool>  <summary>` |
| `tool.start` tool `Edit` / `Write` | `✎` | `#7fa07a` | `#868a93` | body = `<Tool>  <summary>` |
| `tool.start` tool `Task` (subagent) | `⇉` | `#c8a15a` | `#b9bcc4` | body = `Dispatched subagent  <agentName>` |
| `tool.start`, any other tool | `●` | `#868a93` | `#868a93` | fallback |

**Streaming cursor**: `display:inline-block; width:8px; height:15px; background:#c8a15a; vertical-align:text-bottom; margin-left:2px; animation:blink 1s step-end infinite;` (`@keyframes blink { 0%,49%{opacity:1} 50%,100%{opacity:0} }`) — appended immediately after an assistant block's text while `isStreaming === true`; removed the instant `assistant.done` is applied.

**Transcript container**: `padding:16px 18px; display:flex; flex-direction:column; gap:14px; overflow:auto;` 8px thin scrollbar (`.scz` track transparent, thumb `#2a2c33`, radius 4px), matching the rest of the app.

**Jump-to-latest affordance**: floating pill, absolutely positioned bottom-center of the transcript container, 10px above its bottom edge. `padding:5px 12px; border-radius:12px; background:#20222a; border:1px solid #2a2c33; font-size:10.5px; color:#c8a15a; cursor:pointer;` label `↓ jump to latest`; hover `background:#26282f`.

**Input bar** (`Claude Terminal.dc.html:110-114`): `padding:10px 14px; border-top:1px solid #24262d; display:flex; align-items:flex-start; gap:10px;`.
- Prompt glyph `›`: `color:#c8a15a; font-size:13px;` (dims to `#3a3d45` when disabled).
- Textarea: `flex:1; font-size:12.5px; color:#d3d6dc;` (design token "primary"-ish per mock's transcript body), placeholder `send a follow-up, or run a command…` in `color:#565a63`; grows from 1 line up to ~6 lines (~130px) then scrolls internally; no border/background (blends into the bar).
- Disabled hint text (`done`/`error`, FR-25): same slot as placeholder, same `#565a63` styling.
- Right hint: `⌘K palette`, `font-size:10px; color:#3a3d45;` (same muted token as the sidebar's `[n]` hotkey hint).

**Empty states**:
- No active session (FR-27): single centered block, vertically and horizontally centered in the SESSION tab content area: `select a session, or press` `n` `to start one` — body `font-size:12.5px; color:#565a63;`, the `n` rendered like other hotkey hints (`color:#3a3d45`, or accent — reuse the sidebar's `+ new session [n]` hint styling for the `n`).
- No blocks yet (FR-28): centered block: cwd line (`font-size:12px; color:#868a93;`), model line (`font-size:11px; color:#565a63;`) directly below, then `waiting for your first prompt` (`font-size:12.5px; color:#565a63;` margin-top ~10px).

**Motion**: pulse `1.4s ease-in-out infinite` (queued chip dot); blink `1s step-end infinite` (streaming cursor). No transition/animation on scroll-to-bottom (instant jump per FR-18/FR-20).

### Resize / responsive

- Main pane width changes reflow body text only; the glyph column stays a fixed 16px, the meta suffix never wraps onto its own line independently — if the combined line doesn't fit, the whole body (including the meta suffix, since it's inline in the same flow) wraps normally as text.
- The input bar's textarea height adjustment (1–6 lines) is independent of pane width; only wrapping behavior changes with width.
- The jump-to-latest pill re-centers with the transcript container on resize; it never overlaps the input bar (always at least 10px above the container's bottom edge, which sits above the input bar).
- Minimum practical pane width is whatever `app-shell`'s grid enforces; below that this feature does not define additional truncation beyond normal text wrap/ellipsis already specified for the header cluster (which does not ellipsize — if the cluster doesn't fit, that's an app-shell layout concern).

## 9. Acceptance criteria

- [ ] SESSION tab content renders only the transcript + input bar; no tab-strip markup is duplicated here (FR-1).
- [ ] Session-meta cluster shows/hides exactly per FR-2, and only while SESSION is active.
- [ ] `formatContextTokens(48200) === '48.2K'` and `formatContextTokens(200000) === '200K'` (FR-4).
- [ ] Context usage renders used-bright/`/`-limit-faint per FR-5.
- [ ] Elapsed renders `MM:SS` under an hour and `H:MM:SS` at/over an hour, freezing when `status` leaves `running` (FR-6).
- [ ] Opening a session with existing history renders it fully via `getTranscript`, pinned to bottom (FR-8, FR-17).
- [ ] Rapidly switching `activeSessionId` never renders a stale session's transcript under the new session's header (FR-9).
- [ ] Replaying the same `tool.start`/`tool.done`/`message.user`/`assistant.done` event twice never duplicates or corrupts a block (FR-10).
- [ ] An `assistant.delta` stream renders progressively with a visible blinking cursor, and the cursor disappears exactly on `assistant.done` (FR-11, FR-12).
- [ ] `tool.start` with `tool: 'Task'` renders a `⇉` subagent block; `tool.done` appends its meta (FR-13, FR-14).
- [ ] Scrolling up during activity unpins and shows the jump-to-latest pill; clicking it re-pins and scrolls to bottom (FR-19, FR-20).
- [ ] Sending a message always re-pins the view even if previously unpinned (FR-20, FR-21).
- [ ] `Enter` sends, `Shift+Enter` inserts a newline, no data loss either way (FR-21, FR-22).
- [ ] Sending while `status === 'running'` shows a `queued` chip that clears when `message.user` arrives for that block (FR-15, §8 queued chip).
- [ ] Input bar disables with the exact hints specified for `done` and `error` (FR-25).
- [ ] A failed `session:send` restores the typed text and removes the optimistic block (FR-26).
- [ ] No active session shows the centered empty-state hint; an active session with zero blocks shows cwd/model/"waiting for your first prompt" (FR-27, FR-28).
- [ ] `/`-prefixed text is transmitted unmodified (FR-23).

## Remediation

(Empty until a review returns findings.)
