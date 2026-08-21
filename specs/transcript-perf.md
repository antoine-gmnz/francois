---
id: transcript-perf
title: Transcript performance + queued-prompt ordering
status: shipped
branch: feat/transcript-perf
created: 2026-08-20
depends_on: [conversation-view, session-engine, message-history, durable-sessions]
reviewed_base: 893a1f3248e4e0d4617f1fc6b241faeedba8332f
reviewed_digest: 0ee34ebada7267d0
design_files: []
---

# Transcript performance + queued-prompt ordering

## 1. Summary

The SESSION tab does O(transcript) work on every keystroke and every streamed token, and the
frontend and the core disagree about where a prompt typed mid-turn belongs. `ConversationView`
holds the composer's `input` state *and* renders the whole transcript, with no memoization
anywhere in the feature — so one character re-runs `compactBlocks` + `groupTurns` over every
block and re-renders every `Turn`/`Markdown`. Each `assistant.delta` does the same, then reads
`scrollHeight` in a layout effect, forcing a synchronous reflow per token. Separately, a queued
prompt is appended to the frontend's block list at *send* time while the core only creates its
block at *drain* time (`commands/turn.rs` enqueues without buffering; `turn.rs` buffers in
`begin_turn`), so the prompt renders inside the running reply, splits it into two turns, and
lands somewhere else after a reload. This feature isolates the render, coalesces deltas, moves
queued prompts out of the transcript into a pending strip they can be retracted from, and takes
the O(n²) string copy out of the core's delta hot path.

## 2. Goals & non-goals

- **Goals**
  - A keystroke re-renders the composer only — zero `Turn` renders.
  - Streamed deltas flush at most once per animation frame, with one scroll write per flush.
  - A queued prompt never enters the transcript until the core runs it; live order and persisted
    order are identical by construction.
  - A queued prompt can be retracted before it runs (`francois:session:unqueue`).
  - The core's per-delta buffer write is amortized O(1), not O(block length).
- **Non-goals**
  - **Virtualizing / windowing the transcript.** The DOM still holds every block. Isolating the
    render removes the per-keystroke and per-token cost, which is the reported symptom; bounding
    the node count is a separate feature, to be opened on a measurement, not a suspicion.
  - **Capping `Session.block_buffer` or paging `conversation:getTranscript`.** One in-memory copy
    of a transcript the user actually generated is defensible; capping it silently truncates what
    hydration can return, and paged hydration is its own contract change.
  - **Coalescing deltas in the core.** Changing emission cadence would rewrite the stream fixtures
    (`session/stream/fixtures/turn.expected.json`) for a win the frontend flush already takes.
  - Editing a queued prompt in place, or reordering the queue.

## 3. User stories / flows

1. **Typing during a long reply.** A session with a few hundred blocks is streaming. The user
   types into the composer. Every character appears immediately; the transcript above keeps
   streaming and does not re-render on their keystrokes.
2. **Queueing a follow-up.** Mid-turn, the user types a second prompt and presses `⏎`. It does
   **not** appear in the transcript. A pending row appears directly above the composer reading
   the prompt's first line with a `✕`. The streaming reply above is untouched — still one turn,
   one header. When the running turn finishes and the core drains the queue, the row disappears
   and the prompt appears in the transcript at the top of its own turn, immediately followed by
   its reply. A reload shows exactly the same order.
3. **Retracting it.** Before the turn finishes, the user clicks the `✕` on a pending row. The row
   goes and its text is appended to the composer draft, caret at the end, ready to edit or re-send.
4. **Losing the race.** The user clicks `✕` at the moment the turn drains that prompt. The core
   answers `removed: false`, the composer is left alone, and the row disappears on its own when
   `message.user` lands — the prompt is running, and the transcript says so.

## 4. Functional requirements

### A. Render isolation (frontend)

- **FR-1** The composer's own state — `input`, `sendError`, `browse` (message-history walk),
  `dismissedToken`/`selIdx` (slash menu), and the attachments hook — moves out of the component
  that renders the transcript, into a composer-owned component or hook. A keystroke must re-render
  the composer subtree only.
- **FR-2** `Turn`, `Block`, `ToolRail`, `ToolRow`, `AssistantBody`, `UserBody`, `SubagentBanner`
  and `Markdown` are wrapped in `React.memo` with the default shallow comparison. Every prop they
  receive must be referentially stable across a render that does not change it.
- **FR-3** `compactBlocks()` and `groupTurns()` run inside a `useMemo` keyed on `state.blocks`,
  never on every render.
- **FR-4** The 1s clock reaches only the turn that is currently streaming; a settled turn receives
  a value that does not change on a tick. A tick while a session is busy must render exactly one
  `Turn`, not all of them.

### B. Delta coalescing (frontend)

- **FR-5** `assistant.delta` events accumulate in a buffer and flush to the transcript reducer at
  most once per animation frame. Deltas for the same `blockId` inside one frame merge into a
  single dispatch; arrival order is preserved.
- **FR-6** Any non-delta `SessionEvent` flushes the pending buffer **before** it applies, so a
  delta can never be reordered behind a `tool.start`, `assistant.done` or a card event.
- **FR-7** The buffer flushes on unmount and on session switch — a pending delta is never dropped.
- **FR-8** The pin-to-bottom write (`scrollTop = scrollHeight`) happens at most once per flush.
- **FR-9** `assistant.done` still applies its authoritative complete text, repairing anything the
  stream lost. Merge semantics (`mergeDelta`'s offset handling) are unchanged.

### C. Queued prompts (frontend + core)

- **FR-10** A prompt sent while the session is busy (`isBusyStatus`) is parked in a per-session
  **pending queue** and produces no transcript block. An idle-session send keeps today's
  optimistic-block behaviour unchanged.
- **FR-11** The `session:send` response reconciles a wrong guess: `queued: true` with an optimistic
  block already dispatched removes that block and parks the prompt; `queued: false` while parked
  leaves it parked — the imminent `message.user` resolves it (FR-12).
- **FR-12** `message.user` is the **single** point at which a queued prompt enters the transcript:
  it removes the `blockId` from the pending queue (if present) and upserts the block as today.
- **FR-13** A failed send removes the `blockId` from both the pending queue and the transcript,
  restores the text to the composer and shows the error (existing behaviour, extended to the
  pending queue).
- **FR-14** `session.cleared`, a terminal `session.error`, `session.removed`, and a turn ending in
  error all clear that session's pending queue — the core's `s.queue.clear()` has already discarded
  those prompts, and the strip must not show work that will never run.
- **FR-15** The pending queue is keyed by `sessionId` and outlives the keyed remount of
  `ConversationView`, like `composer-draft`. It is purged with the session in `dropDerived`.
- **FR-16** The strip renders one row per pending prompt in FIFO order, each showing the prompt's
  first line (ellipsised) and a `✕`. No strip is rendered when the queue is empty.
- **FR-17** `✕` invokes `francois:session:unqueue`. On `removed: true` the row goes and the text is
  **appended** to the composer draft — separated by a newline when the draft is non-empty — with
  the caret at the end and the textarea re-grown.
- **FR-18** On `removed: false` the composer is left untouched; the row clears via FR-12.
- **FR-19** *(core)* `session_unqueue` removes the entry whose `blockId` matches from
  `Session.queue` and returns `{ removed }`. It never touches a running turn, never changes
  `SessionStatus`, and emits no event. Unknown session ⇒ `SESSION_NOT_FOUND`.
- **FR-20** *(contract)* `SessionSendInput` declares the `blockId` the frontend already sends and
  the Rust command already accepts — a drift fix, no behaviour change.
- **FR-21** `UserConversationBlock.queued` is removed from the contract, from `classify_block`'s
  output, and the `.block-user__queued` badge is deleted. Under FR-10 a transcript user block is
  never queued, so the field would be permanently `false`.

### D. Core hot path

- **FR-22** `buf_assistant_streaming` **appends** the new chunk to the buffered block's text
  instead of replacing it. It takes both the chunk and the accumulated text: it appends the chunk
  when the block exists, and seeds a new block with the accumulated text when it does not (so a
  block first seen mid-stream still carries its head).
- **FR-23** The engine lock in `handle_text_delta` is held only for that push — no allocation or
  serialization of the full block text inside the critical section.
- **FR-24** The emitted `assistant.delta` payload is unchanged (`text` = the chunk, `offset` = the
  UTF-16 length of the prefix already streamed). `session/stream/fixtures/turn.expected.json` must
  pass byte-identical.

## 5. API contract

The `session` domain already owns `contract/session-engine.ts`; per the 2026-08-04 decision this
feature **amends that file in place** and creates no `contract/transcript-perf.ts`.
`contract/conversation-view.ts` is amended for FR-21. No new events; `SessionEvent` is untouched.

```ts
// contract/session-engine.ts — amended

// ---------- francois:session:send (amended, FR-20) ----------
export interface SessionSendInput {
  sessionId: SessionId;
  /** Client-minted so the optimistic block matches the eventual message.user
   *  (conversation-view FR-15/21). Already sent and already accepted by the
   *  core — declared here to close the drift. Omitted ⇒ the core mints one. */
  blockId?: BlockId;
  text: string; // non-empty after trim
}

export interface SessionSendOutput {
  queued: boolean;        // true ⇒ a turn was in flight and this text was enqueued
  queuePosition?: number; // 1-based FIFO position; present iff queued === true
}
// invoke('session_send', req: SessionSendInput): Promise<Result<SessionSendOutput>>
// errors: SESSION_NOT_FOUND · SESSION_NOT_RUNNING · INVALID_INPUT (empty text, queue full)

// ---------- francois:session:unqueue (NEW, FR-19) ----------
export interface SessionUnqueueInput {
  sessionId: SessionId;
  blockId: BlockId; // the id session:send was called with
}

export interface SessionUnqueueOutput {
  /** false ⇒ the turn already drained it (or it was never queued); the caller
   *  leaves the composer alone and lets message.user clear the row. */
  removed: boolean;
}
// invoke('session_unqueue', req: SessionUnqueueInput): Promise<Result<SessionUnqueueOutput>>
// errors: SESSION_NOT_FOUND
```

```ts
// contract/conversation-view.ts — amended (FR-21)

export interface UserConversationBlock extends ConversationBlockBase {
  kind: 'user';
  text: string;
  // `queued: boolean` REMOVED — a queued prompt is no longer a transcript block.
}
```

Rust mirror: `session_unqueue` is a `#[tauri::command(async)]` in
`src-tauri/src/session/commands/turn.rs` beside `session_send`, registered in `main.rs`, resolving
`IpcResult<SessionUnqueueOutput>` — it never rejects.

## 6. Data & state

- **Core.** `Session.queue: VecDeque<(String, String)>` is unchanged in shape; `session_unqueue`
  is a new reader/writer of it under the existing `engine.sessions` lock. `block_buffer` keeps its
  current lifetime and cap (none) — only the per-delta write changes (FR-22). Nothing new is
  persisted; the queue is deliberately in-memory, exactly as today.
- **Frontend.** One new piece of state: the per-session pending queue,
  `Map<SessionId, PendingPrompt[]>` where `PendingPrompt = { blockId, text }`, held in a
  module-level map beside `composer-draft` (FR-15) with a subscription so the strip re-renders.
  Derived: the strip's rows are the queue in FIFO order. Everything else in this feature is a
  restructuring of existing state, not new state — `TranscriptState` and `transcriptReducer` keep
  their shape apart from FR-21's dropped field.
- The rAF delta buffer (FR-5) is a ref inside the transcript hook, never state — it must not
  itself trigger a render.

## 7. Edge cases & errors

| Case | Behaviour |
|---|---|
| `✕` races the drain | `removed: false` · composer untouched · row cleared by `message.user` (FR-18) |
| Send fails while parked | row removed, text back in the composer, error banner (FR-13) |
| Turn errors with prompts queued | core clears its queue; strip clears (FR-14) |
| `/clear` with prompts queued | `session.cleared` clears the strip (FR-14) |
| Session removed while parked | pending queue purged with the session (FR-15) |
| Queue full (20) | existing `INVALID_INPUT` "send queue is full (20 pending)" · nothing parked |
| `session_unqueue` on an unknown session | `SESSION_NOT_FOUND` · row left in place, no composer change |
| `session_unqueue` on an idle session | `removed: false` (empty queue) — not an error |
| Session switch mid-stream | pending deltas flush before teardown (FR-7); pending queue survives (FR-15) |
| Delta arrives for an unknown block | unchanged — the reducer's insert-if-unseen path still applies |
| Inert (unfocused) pane | the strip renders read-only: it states what is queued, and `✕` is inert, matching the composer's own `inert` gate |

## 8. Design brief

> full brief: `specs/design/transcript-perf.md`

One new element: the **pending strip**, a stack of rows inside `.composer-col`, between
`.composer-banners` and `.composer-bar` — the slot banners already use, so a row pushes the
composer down rather than overlapping it. Flat treatment (design 9a/turn 9a): no stroke, no
shadow; separation from the bar below comes from the recessed block tone `#101319`. Each row is
one line — a `⟳` glyph and the label tone `--warn` (inherited from the `.block-user__queued`
badge this replaces, which is the established "waiting, not live" tone and correctly not the
accent), the prompt's first line in `--text-muted` truncated with an ellipsis, and a trailing
plain `✕` dismiss button (instant, not a confirm-in-place control — same precedent as
`AttachmentChip.tsx`'s `×`). Rows are full-bleed within the reading column, FIFO top-to-bottom. No
motion on insert or removal.

`design_files: []` stays empty — a strip built from existing composer chrome and existing tokens
does not warrant a fresh Claude Design page, matching the precedent set by `attach-to-worktree`
and `session-permission-mode`.

## 9. Acceptance criteria

- [ ] Typing one character into the composer with a ≥200-block transcript renders zero `Turn`
      components (FR-1, FR-2, FR-3).
- [ ] A 1s clock tick during a running turn renders exactly one `Turn` (FR-4).
- [ ] A burst of N deltas inside one animation frame produces one reducer dispatch per `blockId`
      and one scroll write, with text identical to applying them one at a time (FR-5, FR-8, FR-9).
- [ ] A `tool.start` arriving between two deltas applies after the first and before the second
      (FR-6).
- [ ] Sending while a turn runs adds a pending row and **no** transcript block; the running reply
      remains a single turn with one header (FR-10, FR-16).
- [ ] When the turn drains, the row disappears and the prompt appears at the head of its own turn;
      reloading the session shows the same order (FR-12).
- [ ] `✕` on a pending row removes it from the core's queue and appends its text to the composer
      draft (FR-17); a lost race leaves the composer untouched (FR-18).
- [ ] A turn that errors with prompts queued leaves an empty strip (FR-14).
- [x] `session_unqueue` on an unknown session resolves `SESSION_NOT_FOUND` and never rejects
      (FR-19).
- [x] `cargo test` passes with `turn.expected.json` unchanged (FR-24).
- [x] `grep -r 'queued' contract/ src/features/conversation/` returns no `UserConversationBlock`
      hit (FR-21).

## Remediation

- 2026-08-21 — round 1 (REVISE), 3 findings, all fixed
