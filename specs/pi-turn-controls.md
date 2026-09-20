---
id: pi-turn-controls
title: Pi steering, follow-ups, cancellation and compaction
status: frozen
branch: feat/pi-turn-controls
created: 2026-09-18
depends_on: [pi-rpc-sessions, pi-transcript-events, pi-session-durability]
reviewed_base:
reviewed_digest:
design_files: []
---

# Pi steering, follow-ups, cancellation and compaction

## 1. Summary

Expose explicit normal, steering and follow-up intent while preserving queue ordering and
stopping all admitted work when the user presses Stop. Use audited Pi RPC semantics from
[the research](research/pi-integration-audit.md); abort alone does not clear Pi's queue.

## 2. Goals & non-goals

- Goals: explicit delivery modes, visible queue states, cancellation with real process
  consequences, and manual/automatic compaction without corrupting history.
- Non-goals: tool approval framework, changing immutable account/runtime mid-session,
  editing individual messages already handed to Pi, or a second agent loop.

## 3. User stories / flows

Idle: Enter sends normally. Busy: composer exposes Steer now or Follow up; Enter follows
the selected mode and Alt+Enter explicitly submits a follow-up. Queued intent stays in
the composer strip until consumed. Stop cancels current work and removes remaining queue
entries, retaining text as recoverable drafts. Compact is available from the palette/run
menu only while idle; automatic compaction appears as progress in the current run.

## 4. Functional requirements

- FR-1: Core validates selected delivery mode against capabilities and current state.
  Normal when busy returns SESSION_BUSY; steer when idle returns INVALID_INPUT; follow-up
  when idle is submitted as a normal prompt, preserving the user's recorded intent.
- FR-2: Configure Pi steering/follow-up delivery as one-at-a-time. Pi owns delivery timing;
  François does not interrupt a running tool to force steering. Explain steering as taking
  effect at the next Pi steering opportunity, not an immediate tool kill.
- FR-3: Core owns client-message IDs and the admissions ledger. Pi has no assumed echoed
  request ID on message events. Associate consumption using certified queue order, one-at-
  a-time delivery and native entries. Identical messages remain distinct. Unresolvable
  identity becomes delivery-unknown; never mark it delivered based on text alone.
- FR-4: Max 20 pending intents/session, 1 MiB UTF-8 text per message, existing attachment
  count/size caps and 32 MiB encoded frame cap. Acceptance creates/updates a pending entry;
  only a consumed user event creates the transcript block. Retrying a clientMessageId
  returns its current receipt without sending again; different content with same ID is invalid.
- FR-5: Local unsent intent may be removed individually. Once Pi accepts it, individual
  unqueue is unavailable; offer Clear queued messages (all pending). Do not implement
  remove-one by clearing/re-enqueuing a live queue, which can duplicate consumed work.
- FR-6: Stop closes admission, sends clear_queue and waits for its response, then abort;
  clear again after idle to handle a queue transition race. Await agent_settled/confirmed
  idle, then publish completion. Abort/retry/compaction paths share this operation. If a
  command fails or exceeds 5 s total stop budget, terminate the tracked child tree and mark
  uncertain entries delivery-unknown. Never allow drained messages to auto-start after Stop.
- FR-7: Pi events racing clear/abort are reconciled in reader order; consumed messages
  remain in transcript, only unconsumed entries return to drafts. Double Stop is idempotent.
  A stop during startup cancels startup. Idle Stop is a no-op success.
- FR-8: Manual compaction goes through the Pi session connection, never spawn_claude.
  Mark compacting until terminal result/settled state; failed compaction retains conversation
  and shows error. Auto-compaction/retries do not emit premature completion notifications.
- FR-9: Shutdown/crash preserves unsent/unknown draft states for recovery but never
  automatically submits them on reopen. Pending text is private session data, not log data.

## 5. API contract

Amend `contract/session-engine.ts`; shared event types go in `common.ts`.

```ts
type DeliveryMode = 'normal' | 'steer' | 'followUp';
interface RuntimeMessageInput {
  sessionId: SessionId;
  clientMessageId: string; // UUID, required for Pi
  text: string;
  delivery: DeliveryMode;
  attachmentIds: string[];
}
interface RuntimeMessageReceipt {
  clientMessageId: string;
  state: 'admitting' | 'queued' | 'consumed' | 'cancelled' | 'delivery-unknown' | 'rejected';
  delivery: DeliveryMode;
  queuePosition?: number;
}
interface RuntimeQueueEntry extends RuntimeMessageReceipt {
  text: string;
  attachmentIds: string[];
  createdAt: number;
}
interface RuntimeQueueClearInput { sessionId: SessionId }
interface RuntimeQueueClearOutput { entries: RuntimeQueueEntry[] }
```

Use `francois:session:submit` → `session_submit(req:RuntimeMessageInput)` →
`Result<RuntimeMessageReceipt>` for the explicit delivery API. Existing session_send remains
valid for old runtimes; Pi callers use submit. Internally both route through the same
per-session admissions owner, never two independent queues.
`francois:session:clearQueue` → `session_clear_queue(req)` → `Result<RuntimeQueueClearOutput>`.
Existing `session_unqueue` returns RUNTIME_UNSUPPORTED for already Pi-owned messages;
`session_interrupt` returns `Result<null>` after stop is confirmed or reports RUNTIME_TIMEOUT/
RUNTIME_EXITED if cleanup cannot be confirmed. Existing `session_compact` returns
`Result<null>` on completion, with the 180 s operation deadline from task 03.

All verbs revalidate session/capability/state: errors SESSION_NOT_FOUND, INVALID_INPUT,
SESSION_BUSY, RUNTIME_UNSUPPORTED, RUNTIME_EXITED, RUNTIME_TIMEOUT, RUNTIME_PROTOCOL_ERROR,
PROVIDER_AUTH_FAILED, PROVIDER_UNAVAILABLE, INTERNAL. Add QUEUE_FULL for capacity failure.
Duplicate IDs use existing receipt only within the same session and retained ledger.

Extend `RuntimeEventPayload` with:

```ts
type ControlRuntimePayload =
  | { kind: 'queue.changed'; entries: RuntimeQueueEntry[] }
  | { kind: 'compaction'; state: 'started' | 'completed' | 'failed'; automatic: boolean; message?: string }
  | { kind: 'retry'; state: 'waiting' | 'running' | 'finished'; attempt: number; delayMs?: number };
```

Raw Pi queue texts are normalized to ledger IDs before emission. Never put raw Pi requests
in contracts. `RuntimeSubmission` / `SubmissionReceipt` from task 01 mirror the message input/
receipt minus routing sessionId already captured by the connection.

## 6. Data & state

Per-session ledger stores IDs, payloads, delivery states, admission order and consumed entry
association. Persist transitions atomically in an app-data sidecar; unknown state after a
crash remains unknown until entry reconciliation, with explicit Resend as a new ID action.
No queue state is reconstructed by scanning transcript text for equal strings.

Expected files: `adapter/pi/{dispatcher,controls}.rs`, `session/commands/turn.rs`,
`session/turn.rs`, `src/features/conversation/{Composer,ComposerPane,pending-queue}`,
command palette compact/stop actions, event router and notification sink.

## 7. Edge cases & errors

Stop during provider retry must prevent the next retry; Stop while a tool ignores abort
escalates through tracked process cleanup. Report observed cleanup limitations, never
“cancelled” merely because the UI hid output. A failed compact cannot clear display history.
Steering with unsupported image input is rejected before admission. Reject while stopping.

## 8. Design brief

Composer mode control, queue strip, clear-all and persistent Stop; status explains delivery.
> full brief: specs/design/pi-turn-controls.md

## 9. Acceptance criteria

- [ ] Normal/steer/follow-up take their documented path and queue ordering (FR-1–3).
- [ ] Repeated identical text with distinct IDs is consumed separately; retry ID is idempotent.
- [ ] Stop with both Pi queues populated never executes queued work afterwards (FR-6–7).
- [ ] Stop during tool/retry/compaction/startup and double Stop have deterministic outcomes.
- [ ] Failed compaction preserves transcript and context; no Claude executable is invoked.
- [ ] Crashed/queued intent returns as unsent or unknown, without auto-resend (FR-9).
- [ ] Fake-process races and real certified queue/abort captures pass; composer reducer tests pass.

## Remediation

(Empty.)
