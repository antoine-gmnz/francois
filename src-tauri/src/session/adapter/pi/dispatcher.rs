//! session/adapter/pi/dispatcher.rs — FR-1/FR-5/FR-7: the live per-session Pi
//! RPC connection. `protocol::ProtocolEngine` (a sibling module — split out
//! purely for CLAUDE.md's ~1000-line file cap) is the pure correlation/
//! state-machine core; this file owns the I/O around it: the reader thread,
//! the child's stdin, the `RuntimeSessionControl` implementation, and
//! publishing `francois://session/event` runtime envelopes.
//!
//! `PiConnection` is the live wrapper `PiAdapter::connect_session` hands back
//! — it owns the reader thread, the child's stdin, and the wait/kill pair
//! FR-7 names. It is exercised without a real Pi binary: its tests
//! substitute a loopback TCP pair for the child's stdio (this crate wires up
//! no AppHandle test harness at all — see `claude_code.rs`'s tests for the
//! same constraint — so `EventPublisher` is the seam that keeps
//! `PiConnection` testable without one).

use crate::ipc::{AppError, ErrorCode, RuntimeFailure};
use crate::session::adapter::{
    CapabilityState, RuntimeCapabilities, RuntimeConnectContext, RuntimeSessionControl,
    RuntimeSubmission, SubmissionReceipt, RUNTIME_CAPABILITIES,
};
use crate::session::events::{RuntimeEventPayload, RuntimeRunState};
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

use super::normalize::TranscriptReducer;
use super::process::{self, ProcessHandle};
use super::protocol::{LineOutcome, PendingOutcome, ProtocolEngine};
use super::wire::{self, PiCommandBody};

#[cfg(test)]
use super::protocol::Deadlines;

// ---------------------------------------------------------------- publishing

/// FR-8: the structured fields every diagnostics-log line carries alongside
/// its message, when the call site has them. `request_id`/`command`/
/// `duration_ms` are only known inside `PiConnection::dispatch`'s own
/// command-scoped calls (a reader-thread disconnect has no in-flight command
/// to name); `frame_count`/`error_count` (off `ProtocolEngine::counts`) and
/// `exit_status` (off `PiConnection::shutdown`'s wait/kill outcome) are
/// filled wherever they are available. Never a raw frame, prompt text, or
/// environment — see `EventPublisher::diagnostic`'s own doc.
#[derive(Default, Clone)]
pub(crate) struct DiagnosticContext {
    pub(crate) request_id: Option<String>,
    pub(crate) command: Option<&'static str>,
    pub(crate) duration_ms: Option<u128>,
    pub(crate) exit_status: Option<&'static str>,
    pub(crate) frame_count: u64,
    pub(crate) error_count: u64,
}

/// FR-4: "Emit run.state ... and failure with RuntimeFailure ... the existing
/// core → frontend francois://session/event runtime envelope" — abstracted so
/// `PiConnection` is testable with no `AppHandle` at all.
pub(crate) trait EventPublisher: Send + Sync {
    fn run_state(&self, state: RuntimeRunState);
    fn failure(&self, code: ErrorCode, reason: &str, ctx: DiagnosticContext);
    fn diagnostic(&self, message: &str, ctx: DiagnosticContext);
    /// pi-transcript-events FR-6/FR-8: one normalized transcript payload off
    /// `normalize::TranscriptReducer` — `message.user`/`assistant.delta`/
    /// `assistant.complete`/`tool.update`/`notice`. Same envelope/ordering
    /// path as `run_state`/`failure` (one `RuntimeEventSequence` per
    /// connection), so the frontend's single listener sees transcript and
    /// run-state events interleaved in the order they actually happened.
    fn transcript(&self, event: RuntimeEventPayload);
}

/// The real publisher: re-derives the session's CURRENT generation itself on
/// every publish (`Engine::runtime_event_for_session`), so it holds no
/// producer of its own and cannot go stale across a reconnect.
pub(crate) struct AppPublisher {
    app: AppHandle,
    session_id: String,
}

impl AppPublisher {
    pub(crate) fn new(app: AppHandle, session_id: String) -> Self {
        Self { app, session_id }
    }

    /// pi-transcript-events FR-6: `runtime_event_for_session` also hands back
    /// the `BufBlock` this event just settled in the session's own
    /// `block_buffer` (if any) — persisted here, the one call site that
    /// actually holds an `AppHandle`, before the wire envelope goes out. A
    /// run-state/capabilities/failure publish never settles a block, so
    /// `block` is `None` on those and this is a no-op for them.
    fn publish(&self, event: RuntimeEventPayload) {
        let engine = self.app.state::<crate::session::Engine>();
        if let Ok((batch, block)) = engine.runtime_event_for_session(
            &self.app,
            &self.session_id,
            crate::ids::now_ms(),
            None,
            None,
            event,
        ) {
            if let Some(block) = &block {
                crate::session::persistence::append_transcript(&self.app, &self.session_id, block);
            }
            for ev in batch {
                crate::session::emit(&self.app, ev);
            }
        }
    }

    /// FR-8: origin/sessionId/generation/requestId/command/duration/exit
    /// status/frame+error counts, then a bounded, sanitized message — never a
    /// raw frame, prompt text, or environment. Generation is re-derived from
    /// the session's CURRENT runtime event producer on every call (same
    /// reasoning as `publish`) rather than cached, so a log line from a
    /// stale/retired connection still names the generation it belonged to at
    /// the time — `"-"` once the session itself is gone.
    fn log(&self, message: &str, ctx: DiagnosticContext) {
        let generation = self
            .app
            .state::<crate::session::Engine>()
            .generation_for_session(&self.session_id)
            .unwrap_or_else(|| "-".into());
        crate::diagnostics::append_log(
            &self.app,
            "pi-rpc.log",
            &format!(
                "origin=pi sessionId={} generation={} requestId={} command={} durationMs={} exitStatus={} frames={} errors={} {}",
                self.session_id,
                generation,
                ctx.request_id.as_deref().unwrap_or("-"),
                ctx.command.unwrap_or("-"),
                ctx.duration_ms
                    .map(|d| d.to_string())
                    .unwrap_or_else(|| "-".into()),
                ctx.exit_status.unwrap_or("-"),
                ctx.frame_count,
                ctx.error_count,
                process::sanitize_diagnostic(message, 500)
            ),
        );
    }
}

impl EventPublisher for AppPublisher {
    fn run_state(&self, state: RuntimeRunState) {
        self.publish(RuntimeEventPayload::RunState { state });
    }

    /// FR-7's edge cases: never infer PROVIDER_* from message text — this
    /// MVP's wire shape carries no structured evidence for that, so every
    /// connection failure stays an honest runtime-origin failure.
    fn failure(&self, code: ErrorCode, reason: &str, ctx: DiagnosticContext) {
        let message = process::sanitize_diagnostic(reason, 512);
        if let Ok(failure) =
            RuntimeFailure::validated("runtime", code.as_str(), &message, false, None, None)
        {
            self.publish(RuntimeEventPayload::Failure { failure });
        }
        self.log(&message, ctx);
    }

    fn diagnostic(&self, message: &str, ctx: DiagnosticContext) {
        self.log(message, ctx);
    }

    fn transcript(&self, event: RuntimeEventPayload) {
        self.publish(event);
    }
}

fn publish(publisher: &Arc<dyn EventPublisher>, outcome: LineOutcome, ctx: DiagnosticContext) {
    if let Some(state) = outcome.run_state {
        publisher.run_state(state);
    }
    if let Some((code, reason)) = &outcome.failure {
        publisher.failure(*code, reason, ctx.clone());
    }
    if let Some(diag) = &outcome.diagnostic {
        publisher.diagnostic(diag, ctx);
    }
}

// ---------------------------------------------------------------- connection

/// FR-1/FR-2/FR-5/FR-7: the live `RuntimeSessionControl` a Pi session's
/// `connect_session` hands back. Owns the child's stdin, the reader thread,
/// and the wait/kill pair — never the Engine's session lock, which it has no
/// way to reach.
pub(crate) struct PiConnection {
    engine: Arc<Mutex<ProtocolEngine>>,
    /// FR-5: one per-session dispatcher — every user-affecting command
    /// (submit/cancel) holds this for its whole round trip, so two can never
    /// race on the wire.
    write_lock: Mutex<()>,
    stdin: Mutex<Option<Box<dyn Write + Send>>>,
    wait_timeout: Mutex<Option<Box<dyn FnMut(Duration) -> bool + Send>>>,
    kill: Mutex<Option<Box<dyn FnMut() + Send>>>,
    reader: Mutex<Option<std::thread::JoinHandle<()>>>,
    capabilities: RuntimeCapabilities,
    /// FR-4: "snapshot runtime ID and sessionFile" — captured off the
    /// `get_state` handshake's `data`. Neither is read anywhere yet (no
    /// dependent feature exists in this repo to consume them); they are
    /// still snapshotted now because FR-4 names it as part of the handshake
    /// itself, not as a later feature's job to add.
    #[allow(dead_code)]
    handshake_info: Mutex<HandshakeInfo>,
    /// CRITICAL fix (review round 1): `dispatch()`'s own write-failure/
    /// timeout branches must fail the WHOLE connection and publish the
    /// result exactly like the reader thread's EOF/read-error path does —
    /// this is the SAME publisher/ring `spawn_reader` was handed at
    /// `connect_engine` time, so both paths converge on one diagnostics
    /// story instead of the dispatcher silently dropping its own failure.
    publisher: Arc<dyn EventPublisher>,
    stderr_ring: Arc<Mutex<Vec<u8>>>,
    /// pi-transcript-events FR-6/FR-9: one transcript normalizer for this
    /// connection's whole life — shared with the reader thread (which is the
    /// only side that ever calls `on_event`) so `dispatch()`'s OWN
    /// write-failure/timeout paths, which fail the whole connection just
    /// like a disconnect does, can finalize the SAME reducer state rather
    /// than a second, empty one.
    reducer: Arc<Mutex<TranscriptReducer>>,
}

#[derive(Default, Clone)]
pub(crate) struct HandshakeInfo {
    #[allow(dead_code)]
    pub(crate) runtime_id: Option<String>,
    #[allow(dead_code)]
    pub(crate) session_file: Option<String>,
}

/// Baseline: nothing is advertised as supported yet (non-goals: no MCP/
/// subagents/skills UI, no model/auth UI for Pi in this feature) — an
/// explicit, valid "unsupported" snapshot rather than a missing one, so
/// `resolve_capability` never falls back to a legacy default for Pi.
///
/// KNOWN GAP (review round 1, MEDIUM): FR-4 says the handshake initializes
/// "using get_state and required capability probes", but no such probe RPC
/// is named anywhere in `wire.rs`'s (provisional, uncaptured — see its own
/// doc comment) command set, and every capability here is hardcoded `false`
/// rather than actually probed. Every capability being unsupported is
/// consistent with this feature's own non-goals (no MCP/subagents/skills/
/// model/auth UI for Pi), so it is not user-visible yet — but it means FR-4
/// is only half-implemented, not signed off as a no-op. Flagged in this
/// feature's handoff for the lead to either amend FR-4 to say "get_state
/// only, no capability probes, in this MVP" or supply the real probe RPC
/// shape once a certified capture exists.
fn baseline_capabilities() -> RuntimeCapabilities {
    RUNTIME_CAPABILITIES
        .iter()
        .map(|key| {
            (
                key.to_string(),
                CapabilityState {
                    available: false,
                    reason: Some("not yet supported for Pi sessions".into()),
                },
            )
        })
        .collect()
}

fn response_error(resp: &wire::PiResponse) -> AppError {
    AppError::new(
        ErrorCode::RuntimeUnavailable,
        resp.error
            .clone()
            .unwrap_or_else(|| format!("{} was rejected", resp.command)),
    )
}

/// FR-2/FR-8: never log the stderr ring's TEXT, sanitized or not — a
/// control-character strip does nothing to redact a secret-shaped substring
/// (an API key, a bearer token) a misbehaving or malicious child might write
/// to its own stderr. Only its size and a non-reversible digest are safe to
/// write to `pi-rpc.log`; still logged alongside the failure (never as the
/// failure's own message, which stays the protocol/EOF reason).
fn stderr_tail_digest(ring: &Arc<Mutex<Vec<u8>>>) -> Option<String> {
    use std::hash::{Hash, Hasher};
    let bytes = ring.lock().unwrap();
    if bytes.is_empty() {
        return None;
    }
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut hasher);
    Some(format!(
        "stderr tail: {} bytes (digest {:016x})",
        bytes.len(),
        hasher.finish()
    ))
}

/// FR-8: a `DiagnosticContext` carrying only the connection-wide counts off
/// `ProtocolEngine::counts` — the reader thread has no in-flight command to
/// attach a requestId/command/duration to.
fn counts_ctx(engine: &Arc<Mutex<ProtocolEngine>>) -> DiagnosticContext {
    let (frame_count, error_count) = engine.lock().unwrap().counts();
    DiagnosticContext {
        frame_count,
        error_count,
        ..Default::default()
    }
}

/// pi-transcript-events FR-1/FR-6: hand one already-framed line to the
/// transcript reducer and publish whatever it produces — but only for
/// EVENT-shaped lines (`wire::looks_like_response` false). A response line
/// carries no `type` field, so the reducer would misread it as "missing its
/// type" and fail; `ProtocolEngine::on_line` (called separately, right
/// beside this) already owns response correlation. Malformed JSON is not
/// reported here a second time — `ProtocolEngine::on_line`'s own parse
/// already fails the whole connection for that line.
fn apply_transcript_line(
    reducer: &Arc<Mutex<TranscriptReducer>>,
    publisher: &Arc<dyn EventPublisher>,
    line: &str,
) {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
        return;
    };
    if wire::looks_like_response(&value) {
        return;
    }
    let events = reducer
        .lock()
        .unwrap()
        .on_event(&value, crate::ids::now_ms());
    for event in events {
        publisher.transcript(event);
    }
}

/// pi-transcript-events FR-9: crash/stop finalizes every still-open assistant
/// slot as `interrupted` and every unsettled tool call as `cancelled`/
/// `unknown` — called once, right after this connection reaches ANY terminal
/// `LineOutcome` (EOF, a read error, an oversize/malformed frame, or a
/// protocol failure), the same "whole connection is now failed" moment
/// `on_disconnect`/`on_frame_error`/`fail` already latch. Idempotent by
/// construction: `spawn_reader`'s loop breaks right after, so this can only
/// ever run once per connection.
fn finalize_transcript(
    reducer: &Arc<Mutex<TranscriptReducer>>,
    publisher: &Arc<dyn EventPublisher>,
) {
    let events = reducer
        .lock()
        .unwrap()
        .finalize_interrupted(crate::ids::now_ms());
    for event in events {
        publisher.transcript(event);
    }
}

fn spawn_reader(
    mut stdout: Box<dyn Read + Send>,
    engine: Arc<Mutex<ProtocolEngine>>,
    publisher: Arc<dyn EventPublisher>,
    stderr_ring: Arc<Mutex<Vec<u8>>>,
    reducer: Arc<Mutex<TranscriptReducer>>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let mut framer = wire::FrameReader::new();
        let mut buf = [0u8; 8192];
        'reader: loop {
            match stdout.read(&mut buf) {
                Ok(0) => {
                    let outcome = engine
                        .lock()
                        .unwrap()
                        .on_disconnect("the Pi child closed its output");
                    let ctx = counts_ctx(&engine);
                    publish_with_stderr(&publisher, outcome, &stderr_ring, ctx);
                    finalize_transcript(&reducer, &publisher);
                    break;
                }
                Ok(n) => match framer.feed(&buf[..n]) {
                    Ok(lines) => {
                        for line in lines {
                            apply_transcript_line(&reducer, &publisher, &line);
                            let outcome = engine.lock().unwrap().on_line(&line);
                            let terminal = outcome.failure.is_some();
                            let ctx = counts_ctx(&engine);
                            publish_with_stderr(&publisher, outcome, &stderr_ring, ctx);
                            if terminal {
                                finalize_transcript(&reducer, &publisher);
                                break 'reader;
                            }
                        }
                    }
                    Err(e) => {
                        let reason = match e {
                            wire::FrameError::OversizeRecord => {
                                "a wire record exceeded the 32 MiB cap"
                            }
                            wire::FrameError::InvalidUtf8 => "a wire record was not valid UTF-8",
                        };
                        let outcome = engine.lock().unwrap().on_frame_error(reason);
                        let ctx = counts_ctx(&engine);
                        publish_with_stderr(&publisher, outcome, &stderr_ring, ctx);
                        finalize_transcript(&reducer, &publisher);
                        break;
                    }
                },
                // A real `ChildStdout` carries no read timeout and blocks
                // indefinitely, which is exactly what a long-lived Pi child
                // needs — but a test transport MAY set one (to make a killed
                // fake child's socket-shutdown observable promptly rather
                // than depending on an in-flight blocking call being
                // interrupted, which is not reliable cross-platform); a
                // timeout is not a disconnect, just an empty poll.
                Err(e)
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) => {}
                Err(e) => {
                    let outcome = engine
                        .lock()
                        .unwrap()
                        .on_disconnect(&format!("read error: {e}"));
                    let ctx = counts_ctx(&engine);
                    publish_with_stderr(&publisher, outcome, &stderr_ring, ctx);
                    finalize_transcript(&reducer, &publisher);
                    break;
                }
            }
        }
    })
}

fn publish_with_stderr(
    publisher: &Arc<dyn EventPublisher>,
    outcome: LineOutcome,
    stderr_ring: &Arc<Mutex<Vec<u8>>>,
    ctx: DiagnosticContext,
) {
    let is_failure = outcome.failure.is_some();
    publish(publisher, outcome, ctx.clone());
    if is_failure {
        if let Some(tail) = stderr_tail_digest(stderr_ring) {
            publisher.diagnostic(&tail, ctx);
        }
    }
}

impl PiConnection {
    fn connect_engine(
        publisher: Arc<dyn EventPublisher>,
        handle: ProcessHandle,
        engine: ProtocolEngine,
    ) -> Result<Arc<Self>, AppError> {
        let engine = Arc::new(Mutex::new(engine));
        let stderr_ring = handle.stderr_ring.clone();
        let reducer = Arc::new(Mutex::new(TranscriptReducer::new()));
        let reader = spawn_reader(
            handle.stdout,
            engine.clone(),
            publisher.clone(),
            stderr_ring.clone(),
            reducer.clone(),
        );
        let conn = Arc::new(Self {
            engine,
            write_lock: Mutex::new(()),
            stdin: Mutex::new(Some(handle.stdin)),
            wait_timeout: Mutex::new(Some(handle.wait_timeout)),
            kill: Mutex::new(Some(handle.kill)),
            reader: Mutex::new(Some(reader)),
            capabilities: baseline_capabilities(),
            handshake_info: Mutex::new(HandshakeInfo::default()),
            publisher,
            stderr_ring,
            reducer,
        });
        // FR-4: no model call or user prompt needed — `get_state` alone.
        match conn.dispatch(PiCommandBody::GetState) {
            Ok(resp) => {
                if let Some(data) = &resp.data {
                    *conn.handshake_info.lock().unwrap() = HandshakeInfo {
                        runtime_id: data
                            .get("runtimeId")
                            .and_then(|v| v.as_str())
                            .map(String::from),
                        session_file: data
                            .get("sessionFile")
                            .and_then(|v| v.as_str())
                            .map(String::from),
                    };
                }
                Ok(conn)
            }
            Err(e) => {
                // FR-7/FR-9: a failed handshake must not orphan the child —
                // shutdown() terminates the tracked tree and joins the reader
                // even though the connection never left `connect_session`.
                let _ = conn.shutdown();
                Err(e)
            }
        }
    }

    pub(crate) fn connect_with(
        publisher: Arc<dyn EventPublisher>,
        handle: ProcessHandle,
    ) -> Result<Arc<Self>, AppError> {
        Self::connect_engine(publisher, handle, ProtocolEngine::new())
    }

    #[cfg(test)]
    fn connect_with_deadlines(
        publisher: Arc<dyn EventPublisher>,
        handle: ProcessHandle,
        deadlines: Deadlines,
    ) -> Result<Arc<Self>, AppError> {
        Self::connect_engine(publisher, handle, ProtocolEngine::with_deadlines(deadlines))
    }

    /// FR-8: a `DiagnosticContext` for a command this connection just tried
    /// to dispatch — connection-wide counts plus this command's own
    /// requestId/command name/elapsed duration.
    fn command_ctx(&self, command: &wire::PiCommand, started: Instant) -> DiagnosticContext {
        DiagnosticContext {
            request_id: Some(command.id.clone()),
            command: Some(command.kind().wire_name()),
            duration_ms: Some(started.elapsed().as_millis()),
            ..counts_ctx(&self.engine)
        }
    }

    /// FR-1/FR-5: never called while holding a session lock (this type has no
    /// way to reach one) — writes and waits entirely on its own state.
    fn dispatch(&self, body: PiCommandBody) -> Result<wire::PiResponse, AppError> {
        let _write_guard = self.write_lock.lock().unwrap(); // FR-5: one dispatcher at a time
        let started = Instant::now();
        let (command, deadline, rx) = self.engine.lock().unwrap().send(body)?;
        {
            let mut stdin = self.stdin.lock().unwrap();
            let Some(writer) = stdin.as_mut() else {
                // The connection is already shutting down (stdin taken by
                // `shutdown()`) — this command was never sent, so there is
                // nothing to fail the WHOLE connection over; drop just this
                // entry, silently.
                self.engine.lock().unwrap().forget(&command.id);
                return Err(AppError::new(
                    ErrorCode::RuntimeUnavailable,
                    "the Pi connection is shutting down",
                ));
            };
            if let Err(e) = writer
                .write_all(command.to_line().as_bytes())
                .and_then(|_| writer.flush())
            {
                // FR-6: a write failure means the pipe (and so the
                // connection) is gone — fail the WHOLE connection, not just
                // this command, and publish the terminal outcome exactly
                // like the reader thread's own EOF/read-error path does
                // (contradicted the method's own doc before this fix).
                let reason = format!("could not write to pi: {e}");
                let ctx = self.command_ctx(&command, started);
                let outcome = self.engine.lock().unwrap().on_disconnect(&reason);
                publish_with_stderr(&self.publisher, outcome, &self.stderr_ring, ctx);
                finalize_transcript(&self.reducer, &self.publisher);
                return Err(AppError::new(ErrorCode::RuntimeExited, reason));
            }
        }
        match rx.recv_timeout(deadline) {
            Ok(PendingOutcome::Response(resp)) if resp.success => Ok(resp),
            Ok(PendingOutcome::Response(resp)) => Err(response_error(&resp)),
            Ok(PendingOutcome::ConnectionFailed(reason)) => {
                Err(AppError::new(ErrorCode::RuntimeExited, reason))
            }
            Err(_) => {
                // Edge cases §7: "Timeout after acceptance is ambiguous, not
                // permission to replay" — fail the WHOLE connection rather
                // than retry or leave the entry parked forever, and publish
                // the terminal outcome (contradicted the method's own doc
                // before this fix, which only forgot this one entry).
                let reason = format!("{} did not respond in time", command.kind().wire_name());
                let ctx = self.command_ctx(&command, started);
                let outcome = self.engine.lock().unwrap().on_timeout(&reason);
                publish_with_stderr(&self.publisher, outcome, &self.stderr_ring, ctx);
                finalize_transcript(&self.reducer, &self.publisher);
                Err(AppError::new(ErrorCode::RuntimeTimeout, reason))
            }
        }
    }
}

impl RuntimeSessionControl for PiConnection {
    /// FR-7: resolve any attachments `input.text` references into the
    /// prompt's own image content, rejecting BEFORE anything is dispatched
    /// when a referenced image outruns this connection's own `images`
    /// capability — checked here (not only by the generic session-level
    /// gate) because `PiConnection` alone knows what the wire actually needs.
    fn submit(&self, input: RuntimeSubmission) -> Result<SubmissionReceipt, AppError> {
        let images_supported = self.capabilities.get("images").is_some_and(|c| c.available);
        let body = wire::build_prompt_body(input.text, &input.attachments, images_supported)?;
        self.dispatch(body).map(|resp| SubmissionReceipt {
            request_id: resp.id,
        })
    }

    fn capabilities(&self) -> RuntimeCapabilities {
        self.capabilities.clone()
    }

    fn cancel(&self) -> Result<(), AppError> {
        self.dispatch(PiCommandBody::Interrupt).map(|_| ())
    }

    /// FR-7: stop admissions, close stdin (letting Pi's own shutdown cleanup
    /// run — the audit's linked RPC implementation notes "EOF follows
    /// shutdown cleanup"), wait up to 5s, then terminate the tracked process
    /// tree and join the reader. Idempotent: `session_remove` and app-exit
    /// invoke the same owner (FR-7), and either may call this twice.
    fn shutdown(&self) -> Result<(), AppError> {
        self.engine.lock().unwrap().stop_admissions();
        self.stdin.lock().unwrap().take();
        let exited = match self.wait_timeout.lock().unwrap().as_mut() {
            Some(wait) => wait(Duration::from_secs(5)),
            None => true,
        };
        if !exited {
            if let Some(kill) = self.kill.lock().unwrap().as_mut() {
                kill();
            }
        }
        if let Some(handle) = self.reader.lock().unwrap().take() {
            let _ = handle.join();
        }
        // FR-7/FR-8: "exit status" logged once per shutdown call —
        // best-effort: `ProcessHandle` exposes only whether the child
        // exited on its own within the 5s grace period or had to be
        // terminated, not a real OS exit code (see this feature's handoff).
        self.publisher.diagnostic(
            "shutdown complete",
            DiagnosticContext {
                exit_status: Some(if exited { "exited" } else { "killed" }),
                ..counts_ctx(&self.engine)
            },
        );
        Ok(())
    }
}

/// FR-1: resolve the certified executable, spawn it, and run the FR-4
/// handshake. What `PiAdapter::connect_session` calls.
pub(crate) fn connect(
    app: &AppHandle,
    ctx: RuntimeConnectContext,
) -> Result<Arc<PiConnection>, AppError> {
    let handle = process::spawn(&ctx)?;
    let publisher: Arc<dyn EventPublisher> =
        Arc::new(AppPublisher::new(app.clone(), ctx.session_id.clone()));
    PiConnection::connect_with(publisher, handle)
}

#[cfg(test)]
#[path = "dispatcher_tests.rs"]
mod connection_tests;
