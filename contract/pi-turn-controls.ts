// contract/pi-turn-controls.ts — canonical imports for Pi steering, follow-ups,
// cancellation and compaction. Authored from specs/pi-turn-controls.md §5.
//
// The spec amends EXISTING contracts in place, so this file deliberately defines no
// duplicate shapes:
//   - common.ts owns the shared/event vocabulary: DeliveryMode · RuntimeMessageReceipt ·
//     RuntimeQueueEntry · ControlRuntimePayload (queue.changed / compaction / retry,
//     merged into RuntimeEventPayload) · the QUEUE_FULL error code.
//   - session-engine.ts owns the requests: RuntimeMessageInput (session_submit),
//     RuntimeQueueClearInput/Output (session_clear_queue), and the amended semantics of
//     session_unqueue · session_interrupt · session_compact for a Pi session.
//
// Bounds the core enforces (FR-4): 20 pending intents per session, 1 MiB of UTF-8 text per
// message, the existing attachment count/size caps, and a 32 MiB encoded frame cap.

export type {
  ControlRuntimePayload,
  DeliveryMode,
  RuntimeMessageReceipt,
  RuntimeQueueEntry,
} from './common';
export type {
  RuntimeMessageInput,
  RuntimeQueueClearInput,
  RuntimeQueueClearOutput,
  SessionCompactInput,
  SessionInterruptInput,
  SessionUnqueueInput,
} from './session-engine';

export const MAX_PENDING_INTENTS = 20;
export const MAX_MESSAGE_BYTES = 1024 * 1024; // UTF-8
