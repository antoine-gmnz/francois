---
id: process-child-supervision
feature_id: process-child-supervision
title: "06 · Consolidate subprocess ownership and cleanup"
status: frozen
branch: feat-rollback-pi-changes
created: 2026-09-21
depends_on: [pi-selective-rollback, process-runtime-boundaries]
design_files: []
---

# 06 · Native child supervision

## 1. Summary

Reuse the existing process_util facade to own native Claude/Codex child lifetimes, bounded protocol reads and shutdown. Provider framing remains in adapters; supervision owns transport resources, not agent execution.

## 2. Goals & non-goals

One owner per child/stdin/stdout/stderr reader; deterministic cleanup and isolation. Keep thread-per-turn architecture and existing runtime behavior. No new async runtime, universal process service, external daemon or unrelated shell/extension rewrite.

## 3. Flows

An adapter resolves/spawns an owned child through process_util, performs its protocol handshake, streams output through its parser and releases ownership after completion. Stop targets only the current child/turn. Session/app close shuts down owned resources, including a child still starting; later completion cannot reattach it to a closed session.

## 4. Functional requirements

- **FR-1** Keep executable resolution, login-shell PATH, native Windows exe/cmd preference, no_window, WSL cwd/env conversion and per-account environment helpers. Launch via argv values; never concatenate prompt/settings into shell code.
- **FR-2** Introduce or reuse a small owned child primitive in process_util/session process infrastructure. It owns Child and stdio pumps, is thread-safe where existing callers need it, and supports idempotent cancel/close/wait. Do not expose std::process handles to application use cases.
- **FR-3** Lifecycle: starting → running → stopping → exited. A startup completion after cancellation is immediately cleaned up. Closing one session/account never terminates another child. PID alone is not a reusable global ownership key.
- **FR-4** Graceful protocol interruption is adapter-owned. During close/shutdown, supervision enforces cleanup after 2 seconds if child does not exit, then terminates its owned tree and waits/reaps it. A successful turn interrupt may leave a session-scoped server alive; do not conflate it with shutdown. Use process groups on Unix and an owned job/tree strategy on Windows; preserve existing WSL semantics and record any platform limitation in test evidence. Never kill a process by name.
- **FR-5** Streaming line reader caps a frame at 8 MiB of bytes before newline; oversized frame returns RUNTIME_PROTOCOL_ERROR and closes the affected transport. Partial UTF-8/frame boundaries are buffered, not parsed early. EOF with an incomplete nonempty frame is surfaced to the parser as protocol failure; ordinary newline-terminated valid frames retain ordering.
- **FR-6** Drain stderr concurrently so a flood cannot deadlock stdout. Keep at most 64 KiB diagnostic tail, sanitize before IPC/log publication, and never log prompt/answers/credentials/raw protocol envelopes. Diagnostic overflow is recorded as truncation, not unlimited allocation.
- **FR-7** Native interactive handshake deadline is 10 seconds; metadata probes keep their existing own deadlines/caches. Timeouts produce RUNTIME_TIMEOUT and cleanup. Native model turns are not given an arbitrary wall-time timeout; Stop remains available.
- **FR-8** Process/transport failures never auto-replay a started or ambiguously delivered turn/reply. Propagate missing executable SPAWN_FAILED, unavailable transport RUNTIME_UNAVAILABLE, malformed frame RUNTIME_PROTOCOL_ERROR or deadline RUNTIME_TIMEOUT through existing typed errors.
- **FR-9** Integrate the primitive into Claude/Codex adapter launch paths incrementally, preserving Claude per-turn lifetime and future session-scoped Codex App Server. Keep current Codex metadata ProbeChild behavior until equivalence tests justify sharing the owner; do not merge metadata probe cache/lifetime with agent turns.

## 5. API contract

No IPC shape or channel change. Existing contract/common.ts AppError/ErrorCode vocabulary applies. contract/process-child-supervision.ts re-exports existing errors/results; Rust internal child ownership API is core-private and can be shaped to existing consumers without frontend coordination. Native parser decisions remain adapter-local.

## 6. Ownership

Core owns src-tauri/src/process_util.rs and child modules, session spawn/stdio/adapter launch integration, and scripts/quality spawn-boundary tests. No frontend or contract modifications by implementer. Reuse existing environment module and bounded probe tests; do not reintroduce Pi runtime code.

## 7. Edges

Broken pipe, stderr flood, close-before-spawn, close-during-handshake, late reader completion, double close and account removal are covered. Distinct current handles must remain isolated even if operating-system PIDs are reused. Failure to kill/reap is reported without claiming cleanup success.

## 8. Design

No visual change; existing error/Stop presentation.

## 9. Acceptance criteria

- [ ] Fake-process tests cover missing CLI, partial UTF-8/JSONL, oversized frame, stderr flood, timeout, crash and idempotent shutdown. (FR-1–8)
- [ ] Two owned children remain isolated; close during startup/blocked read cleans all resources with no late attach. (FR-2–4)
- [ ] Existing Claude/Codex argv/env/WSL/account/model probe tests pass. (FR-1,9)
- [ ] Process tests run without logged-in accounts/native model calls; supported-platform smoke matrix records actual OS coverage, not assumed portability.
- [ ] cargo test/check/clippy, rustfmt and no-bare-Command::new conventions pass or baseline failures are explicit.

## 10. Readiness

READY after rollback/boundary prerequisites. Numeric bounds and lifetimes are implementation choices frozen here, not quotations from the inaccessible conversation. No cross-surface API ambiguity remains.

## Remediation
