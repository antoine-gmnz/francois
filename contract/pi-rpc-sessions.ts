// contract/pi-rpc-sessions.ts — Pi RPC process and session lifecycle.
// Authored from specs/pi-rpc-sessions.md §5.
//
// No new public IPC surface: `session_create`, `session_send`, `session_remove`,
// `session_list`, `session_interrupt` and the `francois://session/event` envelope are
// unchanged in shape. This feature only makes the Pi adapter emit the error codes and
// `RuntimeFailure` that pi-runtime-boundary already added to `common.ts`'s `ErrorCode`
// union and `Result` (RUNTIME_UNAVAILABLE, RUNTIME_INCOMPATIBLE, RUNTIME_TIMEOUT,
// RUNTIME_PROTOCOL_ERROR, MODEL_UNAVAILABLE, RUNTIME_EXITED, PROVIDER_AUTH_FAILED,
// PROVIDER_UNAVAILABLE — all already present, verified against contract/common.ts).
//
// The wire protocol this feature implements (`PiCommand`, `PiResponse`, the certified
// event union, the dispatcher's internal state machine) is Rust-only and lives in
// `src-tauri/src/session/adapter/pi/wire.rs`. It never crosses IPC and is deliberately
// not defined here — see pi-runtime-boundary.md §"Rust-only" for the same pattern.
//
// Re-exported for callers that want this feature's exact vocabulary without pulling in
// all of common.ts's runtime axis.
export type { ErrorCode, RuntimeEventEnvelope, RuntimeEventPayload, RuntimeFailure, SessionEvent } from './common';
