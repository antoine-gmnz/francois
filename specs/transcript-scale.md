---
id: transcript-scale
title: Transcript scale — bounded buffers, paged scrollback, one event router
status: in-review
branch: feat/transcript-scale
created: 2026-08-20
depends_on: [transcript-perf, conversation-view, session-engine, durable-sessions, notifications, audio-cues]
reviewed_base:
reviewed_digest:
design_files: []
---

# Transcript scale — bounded buffers, paged scrollback, one event router

## 1. Summary

`transcript-perf` took the per-keystroke and per-token cost out of the SESSION tab, but left three
costs that scale with *how much there is* rather than how fast it arrives, and it named all three as
non-goals. `Session.block_buffer` (`session/mod.rs:534`) is uncapped and is re-read from disk **in
full for every session at boot** (`persistence.rs:639`), so a fleet of long sessions pays its whole
history in RAM before the window opens. `conversation_get_transcript` (`queries.rs:15`) maps that
entire buffer in one call, and the frontend puts every returned block in the DOM, so mounting or
switching to a long session costs O(transcript) regardless of how well memoized it now is. Separately
there are **nine** live `onSessionEvent` call sites, each receiving every event of every session and
filtering in JS — a fan-out the 2026-08-17 audio-cues decision already ruled against for derivation,
honoured today only by `notifications/trigger.ts`. This feature bounds what the core holds, bounds
what the frontend renders, pages both backwards on demand, and puts every raw consumer behind one
session-keyed router.

## 2. Goals & non-goals

- **Goals**
  - Core memory per session is bounded by a constant, at boot and at steady state.
  - Older transcript stays fully reachable — bounding memory must not lose history.
  - The DOM holds a bounded window of the transcript; earlier blocks are reachable on demand.
  - Exactly one Tauri `session` listener exists in the webview, whatever is mounted.
- **Non-goals**
  - **Height-estimating virtual scrolling.** The window is paged explicitly (an "earlier" control),
    not scroll-position-driven. A transcript is append-only and read at its tail; a render cap plus
    paging gets the same bound with no height measurement and no dependency.
  - **Any new dependency.** No `react-window`/`react-virtuoso` — see the 2026-08-18 no-deps line.
  - **A parsed-transcript cache in the core.** Paging re-reads and re-folds the file per request
    (FR-8); a cache would re-introduce the unbounded memory this feature exists to remove.
  - **Capping or paging the per-agent transcript** (`agent_steps` already has `AGENT_TRAIL_CAP`) or
    the PTY scrollback.
  - Changing what `append_transcript` writes, or the on-disk JSONL shape.

## 3. User stories / flows

1. **Opening a long session.** A session with thousands of blocks is selected. The transcript appears
   at its tail immediately. Above the first rendered block sits one line: `▲ 2,140 earlier blocks`.
2. **Reading back.** The user clicks it (or focuses it and presses `⏎`). A page of earlier blocks is
   prepended. The block they were looking at does not move — the viewport stays put. The line above
   updates its count, and disappears when the transcript is fully expanded.
3. **A parked approval from earlier.** A session was left with an approval card parked and hundreds
   of blocks streamed past it. Reopening the session still shows that card, live and answerable — an
   unresolved ask is never evicted and never paged out.
4. **Restarting the app with a big fleet.** Twelve long-running sessions are restored. Memory reflects
   twelve bounded tails, not twelve full histories, and the first paint is not waiting on them.

## 4. Functional requirements

### A. Bounded core buffer

- **FR-1** `TRANSCRIPT_BUFFER_CAP: usize = 400` in `session/mod.rs`, beside `AGENT_TRAIL_CAP`. After
  a block is appended to `Session.block_buffer`, blocks are evicted from the **head** until the
  buffer is at the cap.
- **FR-2** Eviction **stops at the oldest unsettled block** and evicts nothing at or after it. A
  block is unsettled when it is `streaming`, or is a `Question`/`Permission` block that is not yet
  resolved. The buffer may therefore exceed the cap while an ask is parked; it returns to the cap
  once that ask resolves. Rationale: an evicted block that a later event upserts would be
  re-appended at the tail, silently reordering the transcript.
- **FR-3** `persistence.rs:639` keeps only the tail: the `read_transcript` result is truncated by the
  same rule (FR-1 + FR-2) before it becomes `block_buffer`. Boot cost is `sessions × cap`.
- **FR-4** Eviction never writes to, truncates or removes the persisted JSONL. `append_transcript`,
  `clear_transcript` and `parse_transcript` are unchanged.

### B. Paged hydration (contract + core)

- **FR-5** `conversation_get_transcript` takes optional `before` and `limit` and resolves a
  `TranscriptPage` (§5) instead of a bare array.
- **FR-6** **No `before`** ⇒ the in-memory tail, oldest-first. `hasMore` is true iff a block older
  than the first returned one exists in the persisted transcript.
- **FR-7** **`before: BlockId`** ⇒ the core reads and folds the persisted transcript
  (`read_transcript`), finds that `blockId`, and returns up to `limit` blocks immediately preceding
  it, oldest-first. Paging is computed over the **folded** sequence, never over raw line offsets — a
  question/permission block is written twice and folds to one entry, so a line index is not a block
  index. A `before` that is not in the file ⇒ empty `blocks`, `hasMore: false`, not an error.
- **FR-8** Paging re-reads and re-folds the file on every request, by design: scrollback is
  user-initiated and rare, and the alternative is the unbounded cache FR-1 removes. This must be
  stated in the code, not just here.
- **FR-9** `limit` is **clamped** to `1..=500` (default 200) — an out-of-range value is corrected,
  never an `INVALID_INPUT`.
- **FR-10** Both existing callers move to the new shape: `useConversationTranscript` (FR-11..15) and
  `useWorkflowAskCards`, which reads the transcript for pending ask cards and is correct against the
  tail alone because FR-2 pins unresolved asks into it.

### C. Frontend render window

- **FR-11** The transcript renders at most `RENDER_WINDOW = 200` of the most recent held blocks.
  Blocks outside the window are not rendered and not in the DOM.
- **FR-12** When blocks are held or exist beyond the window, one row renders above the first
  rendered block stating the count of earlier blocks. It is a `<button>` — clickable, focusable,
  `⏎`/`Space` activated.
- **FR-13** Activating it widens the window by one page (200). If the reducer holds no earlier
  blocks and `hasMore` was true, it first calls `getTranscript` with `before` = the oldest held
  `blockId` and prepends the result; the reducer prepends by `blockId`, never duplicating a block
  it already holds.
- **FR-14** Expansion preserves the reading position: the element at the top of the viewport stays
  there (`scrollTop += scrollHeight delta`, measured in a layout effect). Expansion never sets
  `isPinned` and never scrolls to the bottom.
- **FR-15** A `seed` (hydration, session switch, `session.cleared`) resets the window to
  `RENDER_WINDOW` and the pin to bottom — existing FR-17/18 pin behaviour is otherwise unchanged.
- **FR-16** No third-party virtualization/windowing dependency is added.

### D. One session-event router

- **FR-17** `src/lib/session-events.ts` owns the **single** `onSessionEvent` subscription in the
  webview. It is established on the first registration and **never torn down** — a teardown/re-listen
  cycle re-opens the event-loss window `useHydratedSubscription` was ordered to close.
- **FR-18** `subscribeSessionEvents(scope, handler): Promise<UnlistenFn>` where `scope` is a
  `SessionId` or `'*'`. It resolves only once the underlying Tauri listener is **live**, preserving
  the subscribe-before-fetch guarantee `startHydratedSubscription` depends on; a registration made
  while that listener is already live resolves immediately.
- **FR-19** A session's id is resolved with the existing rule — `e.meta.id` for `session.meta`,
  `e.sessionId` otherwise. An event with **no** session id reaches every handler. A session-scoped
  handler receives only its own session's events; a `'*'` handler receives all.
- **FR-20** A handler that throws never blocks the others (matching `registerTriggerSink`).
- **FR-21** All nine current call sites subscribe through the router and drop their own JS filter:
  `useConversationTranscript`, `useSessionFleetSync`, `useAgentsFeed`, `AgentView`, `McpPanel`,
  `useWorkflowsFeed`, `useWorkflowDetail`, `useWorkflowAskCards`, `notifications/trigger`.
  `onSessionEvent` in `lib/api.ts` stays exported but is called **only** by the router.
- **FR-22** `notifications/trigger.ts` registers as a `'*'` consumer. Its `registerTriggerSink` API,
  `deriveTrigger` and the one-`deriveState` invariant are unchanged — the router replaces how it
  subscribes, not how it derives.

## 5. API contract

`conversation-view` owns `contract/conversation-view.ts`; per the 2026-08-04 decision this feature
**amends that file in place** and creates no `contract/transcript-scale.ts`. No new channels, no new
events, `SessionEvent` untouched. The router (§D) is an internal frontend module, not contract.

```ts
// contract/conversation-view.ts — amended (FR-5..FR-9)

export interface GetTranscriptRequest {
  sessionId: SessionId;
  /** Page backwards: the blocks immediately BEFORE this one. Omitted ⇒ the live
   *  tail the core holds in memory. */
  before?: BlockId;
  /** Blocks to return. Clamped by the core to 1..=500; default 200. */
  limit?: number;
}

export interface TranscriptPage {
  /** Oldest-first and contiguous, already folded — a re-appended question or
   *  permission block appears once, in its resolved state, at the position of
   *  its first occurrence. */
  blocks: ConversationBlock[];
  /** true ⇒ older blocks exist; page again with `before` = blocks[0].blockId. */
  hasMore: boolean;
}
// invoke('conversation_get_transcript', req: GetTranscriptRequest): Promise<Result<TranscriptPage>>
// errors: SESSION_NOT_FOUND
```

**Breaking shape change**: this channel resolved `Result<ConversationBlock[]>`. Both callers move in
the same commit (FR-10); there is no compatibility window because both sides ship together.

Rust mirror: `conversation_get_transcript` in `src-tauri/src/session/commands/queries.rs` takes
`before: Option<String>` / `limit: Option<usize>` and resolves `IpcResult<Value>` shaped as
`TranscriptPage`. The disk read for a `before` page happens **outside** the `engine.sessions` lock.

## 6. Data & state

- **Core.** No new persisted state and no new fields. `Session.block_buffer` keeps its type and
  gains an eviction rule (FR-1/2) applied at every append and at load (FR-3). The persisted JSONL is
  the authority for anything evicted — this is what makes the cap safe rather than lossy.
- **Frontend.** `TranscriptState` gains one number: `windowSize`, the count of trailing blocks
  rendered (FR-11), reset by `seed`. The reducer gains a `prepend` action (FR-13) that is a no-op for
  a `blockId` already held. `hasMore` is hook state beside `hydrated`.
- **Router.** `Map<SessionId | '*', Set<handler>>` plus the one `UnlistenFn` and a `live` promise, all
  module-level in `src/lib/session-events.ts` — deliberately not a store, since nothing renders from it.

## 7. Edge cases & errors

| Case | Behaviour |
|---|---|
| Unresolved ask older than the cap | pinned in memory, never evicted, still answerable (FR-2) |
| A block streams past the cap | eviction stops at it; buffer exceeds the cap until it settles (FR-2) |
| `before` block not in the file (`/clear`ed since) | empty page, `hasMore: false`, no error (FR-7) |
| Transcript file missing (never persisted) | empty page, `hasMore: false` (FR-7) |
| `limit: 0` or `limit: 10000` | clamped to 1 / 500 (FR-9) |
| `session.cleared` with the window expanded | `seed` resets blocks, `windowSize` and the pin (FR-15) |
| Page arrives after a session switch | discarded by the existing mounted guard; no dispatch |
| Expansion while a turn is streaming | deltas keep applying to the tail; the viewport stays anchored (FR-14) |
| Two rapid activations of "earlier" | the second is ignored while a page is in flight; the row shows no spinner |
| Router handler throws | logged-and-skipped, others still run (FR-20) |
| Subscribe called before the listener is live | resolves when it is; no event is missed (FR-18) |
| Last consumer unmounts | handler removed, Tauri listener stays live (FR-17) |

## 8. Design brief

> full brief: `specs/design/transcript-scale.md`

One new element: the **earlier-blocks row**, the first child of the reading column above the oldest
rendered block. Flat treatment (design 9a): no stroke, no shadow — it is a full-bleed row on the
recessed block tone `#101319` within the reading column, one line tall, matching the pending strip's
geometry from `transcript-perf`. A `▲` caret and the count in `--text-muted`
(`▲ 2,140 earlier blocks`); the whole row is the hit target, with the standard keyboard focus ring
(a survivor of the flat pass). No accent — this is navigation, not the live thing, and not something
asking to be come to. No motion on expand: the content prepends and the viewport is held (FR-14), so
any transition would fight the anchor. An inert (unfocused) pane renders the row but does not
activate it, matching the composer's `inert` gate.

`design_files: []` stays empty — one row built from existing tokens and existing composer chrome does
not warrant a fresh Claude Design page, matching the `attach-to-worktree` / `session-permission-mode`
/ `transcript-perf` precedent.

## 9. Acceptance criteria

- [ ] A session that appends past the cap holds exactly `TRANSCRIPT_BUFFER_CAP` blocks, and the
      evicted ones are still in the persisted JSONL (FR-1, FR-4).
- [ ] A parked permission block older than the cap survives eviction and is still resolvable; the
      buffer returns to the cap once it resolves (FR-2).
- [ ] Restoring a session whose transcript file holds 5,000 blocks yields a `block_buffer` at the cap
      (FR-3).
- [ ] `getTranscript` with no `before` returns the tail with `hasMore: true` when older blocks exist
      on disk (FR-6).
- [ ] Paging with `before` across a transcript containing a question asked-then-answered returns that
      block **once**, resolved, and no page boundary lands mid-fold (FR-7).
- [ ] `limit: 0` and `limit: 9999` both resolve `ok` with 1 and 500 blocks (FR-9).
- [ ] A 3,000-block session mounts with at most `RENDER_WINDOW` blocks in the DOM (FR-11).
- [ ] Activating the earlier row prepends a page and leaves the previously-top element at the same
      viewport offset, without re-pinning (FR-13, FR-14).
- [ ] `grep -rn 'onSessionEvent' src/ --include=*.ts --include=*.tsx` returns hits only in
      `lib/api.ts`, `lib/session-events.ts` and their tests (FR-21).
- [ ] With three panes mounted on three sessions, exactly one Tauri `session` listener is registered
      (FR-17).
- [ ] A router handler that throws does not stop a later handler from receiving the same event (FR-20).
- [ ] Audio cues and banners still fire exactly once per trigger through the router (FR-22).
- [ ] `npm test` and `cargo test` pass; no new entry in `package.json` dependencies (FR-16).

## Remediation

- 2026-08-21 — round 1 (`/cohorte-review` REVISE): 7 findings (3 CRITICAL / 1 HIGH / 1 MEDIUM /
  2 LOW), all fixed. The two CRITICAL core defects were the same shape — `trim_block_buffer()` ran
  *inside* `buf_tool_done`/`buf_command_output` before the caller re-`find`ed the settled block to
  persist it, so a block that was itself pinning eviction was evicted before it ever reached the
  JSONL; both mutators now capture the clone pre-trim and return `Option<BufBlock>`, and all five
  call sites persist the returned value. The CRITICAL frontend defect was FR-21 dropping the hook's
  session filter, letting `agent.update`/`workflow.update` (neither carries a `sessionId`) force a
  cross-session `flushDeltas()`; `isTranscriptRelevantEvent` now rejects both. Plus two regression
  tests for the eviction/settle interaction, `session/transcript_cap.rs` split out, the
  `windowedBlocks` cut extended to a turn boundary, and the `queries.rs` read race documented.

**Carried forward from round 1** (fixed as specified, residue left deliberately — re-raise if a
re-review judges either worth closing):

- `src-tauri/src/session/mod.rs` is **still 1413 lines**, over the ~1000-line ceiling. The MEDIUM's
  named fix (split the eviction concern into `session/transcript_cap.rs`) landed, but it moved out
  less than the two new regression tests added back. The breach predates this feature (1248 lines on
  `main`); closing it means splitting `Session`'s `buf_*` mutators into their own child module — a
  separately-scoped refactor.
- `earlierRowState`'s hidden-block count is still `blocks.length - windowSize`, so now that
  `windowStartIndex` can back the cut up to a turn boundary, the "earlier" row can overstate the
  hidden count by at most one partial turn. Bounded and cosmetic.
