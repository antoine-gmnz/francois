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

    fn publish(&self, event: RuntimeEventPayload) {
        let engine = self.app.state::<crate::session::Engine>();
        if let Ok(batch) = engine.runtime_event_for_session(
            &self.app,
            &self.session_id,
            crate::ids::now_ms(),
            None,
            None,
            event,
        ) {
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

fn spawn_reader(
    mut stdout: Box<dyn Read + Send>,
    engine: Arc<Mutex<ProtocolEngine>>,
    publisher: Arc<dyn EventPublisher>,
    stderr_ring: Arc<Mutex<Vec<u8>>>,
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
                    break;
                }
                Ok(n) => match framer.feed(&buf[..n]) {
                    Ok(lines) => {
                        for line in lines {
                            let outcome = engine.lock().unwrap().on_line(&line);
                            let terminal = outcome.failure.is_some();
                            let ctx = counts_ctx(&engine);
                            publish_with_stderr(&publisher, outcome, &stderr_ring, ctx);
                            if terminal {
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
        let reader = spawn_reader(
            handle.stdout,
            engine.clone(),
            publisher.clone(),
            stderr_ring.clone(),
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
                Err(AppError::new(ErrorCode::RuntimeTimeout, reason))
            }
        }
    }
}

impl RuntimeSessionControl for PiConnection {
    fn submit(&self, input: RuntimeSubmission) -> Result<SubmissionReceipt, AppError> {
        self.dispatch(PiCommandBody::Prompt { text: input.text })
            .map(|resp| SubmissionReceipt {
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
mod connection_tests {
    use super::*;
    use std::net::{TcpListener, TcpStream};

    /// The "fake child" the spec's acceptance criteria ask for: a loopback
    /// TCP pair stands in for the process's stdin/stdout, so these tests
    /// exercise the REAL reader thread, REAL `mpsc` timeouts, and the REAL
    /// `RuntimeSessionControl` implementation with no external `pi` binary
    /// and no AppHandle.
    fn test_pipe_pair() -> (TcpStream, TcpStream) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let client = TcpStream::connect(addr).unwrap();
        let (server, _) = listener.accept().unwrap();
        client.set_nodelay(true).ok();
        server.set_nodelay(true).ok();
        (client, server)
    }

    #[derive(Default)]
    struct Recording {
        run_states: Mutex<Vec<RuntimeRunState>>,
        failures: Mutex<Vec<(ErrorCode, String)>>,
    }
    impl EventPublisher for Recording {
        fn run_state(&self, s: RuntimeRunState) {
            self.run_states.lock().unwrap().push(s);
        }
        fn failure(&self, code: ErrorCode, reason: &str, _ctx: DiagnosticContext) {
            self.failures
                .lock()
                .unwrap()
                .push((code, reason.to_string()));
        }
        fn diagnostic(&self, _message: &str, _ctx: DiagnosticContext) {}
    }

    /// `dispatcher_end` is what `PiConnection` writes to/reads from;
    /// `fake_child_end` is driven directly by the test, standing in for the
    /// Pi process on the other side of the pipe.
    fn handle_over(dispatcher_end: TcpStream, kill_flag: Arc<Mutex<bool>>) -> ProcessHandle {
        let stdout = dispatcher_end.try_clone().unwrap();
        // A short read timeout makes a killed fake child's socket-shutdown
        // observable on the READER's next poll rather than depending on an
        // in-flight blocking `read()` being interrupted by a shutdown on a
        // different cloned handle, which is not reliable cross-platform —
        // see `spawn_reader`'s WouldBlock/TimedOut handling.
        stdout
            .set_read_timeout(Some(Duration::from_millis(50)))
            .unwrap();
        // A real `kill_tree` on a real child closes ITS end of the pipe,
        // which is what unblocks the dispatcher's blocking `read()` — a fake
        // `kill` that only flips a flag would leave the reader thread (and
        // so `shutdown()`'s `join()`) hanging forever whenever the fake
        // child is still "alive" (i.e. `fake_child` not yet dropped) at
        // shutdown time. `TcpStream::shutdown` affects the whole socket, not
        // just this one cloned handle, so it is the honest stand-in here.
        let socket = dispatcher_end.try_clone().unwrap();
        ProcessHandle {
            stdin: Box::new(dispatcher_end),
            stdout: Box::new(stdout),
            wait_timeout: Box::new({
                let kill_flag = kill_flag.clone();
                move |_| *kill_flag.lock().unwrap()
            }),
            kill: Box::new(move || {
                *kill_flag.lock().unwrap() = true;
                let _ = socket.shutdown(std::net::Shutdown::Both);
            }),
            stderr_ring: Arc::new(Mutex::new(Vec::new())),
        }
    }

    fn read_line(child: &mut TcpStream) -> String {
        let mut byte = [0u8; 1];
        let mut line = Vec::new();
        loop {
            let n = child.read(&mut byte).unwrap();
            assert!(
                n > 0,
                "the dispatcher's peer closed before a full line arrived"
            );
            if byte[0] == b'\n' {
                break;
            }
            line.push(byte[0]);
        }
        String::from_utf8(line).unwrap()
    }

    fn write_line(child: &mut TcpStream, line: &str) {
        child.write_all(line.as_bytes()).unwrap();
        child.write_all(b"\n").unwrap();
    }

    fn extract_id(line: &str) -> String {
        serde_json::from_str::<serde_json::Value>(line).unwrap()["id"]
            .as_str()
            .unwrap()
            .to_string()
    }

    fn resp(id: &str, command: &str, success: bool) -> String {
        serde_json::json!({ "id": id, "command": command, "success": success }).to_string()
    }

    #[test]
    fn a_fake_child_completes_the_handshake_and_two_prompts_on_one_connection() {
        let (dispatcher_end, mut fake_child) = test_pipe_pair();
        let handle = handle_over(dispatcher_end, Arc::new(Mutex::new(false)));
        let publisher = Arc::new(Recording::default());
        let publisher_for_connect = publisher.clone();
        let connect =
            std::thread::spawn(move || PiConnection::connect_with(publisher_for_connect, handle));

        let req = read_line(&mut fake_child);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&req).unwrap()["type"],
            "get_state"
        );
        write_line(&mut fake_child, &resp(&extract_id(&req), "get_state", true));

        let conn = connect.join().unwrap().unwrap();
        assert_eq!(conn.engine.lock().unwrap().state(), RuntimeRunState::Idle);

        // FR acceptance: "Two prompts use one child."
        for _ in 0..2 {
            let conn2 = conn.clone();
            let submit =
                std::thread::spawn(move || conn2.submit(RuntimeSubmission { text: "hi".into() }));
            let req = read_line(&mut fake_child);
            let v: serde_json::Value = serde_json::from_str(&req).unwrap();
            assert_eq!(v["type"], "prompt");
            write_line(
                &mut fake_child,
                &resp(v["id"].as_str().unwrap(), "prompt", true),
            );
            submit.join().unwrap().unwrap();
            write_line(&mut fake_child, r#"{"type":"agent_settled"}"#);
            wait_until(|| conn.engine.lock().unwrap().state() == RuntimeRunState::Idle);
        }

        conn.shutdown().unwrap();
        assert!(publisher
            .run_states
            .lock()
            .unwrap()
            .contains(&RuntimeRunState::Running));
    }

    #[test]
    fn eof_after_the_handshake_fails_the_connection_once_and_refuses_further_submits() {
        let (dispatcher_end, mut fake_child) = test_pipe_pair();
        let handle = handle_over(dispatcher_end, Arc::new(Mutex::new(false)));
        let publisher = Arc::new(Recording::default());
        let publisher_for_connect = publisher.clone();
        let connect =
            std::thread::spawn(move || PiConnection::connect_with(publisher_for_connect, handle));
        let req = read_line(&mut fake_child);
        write_line(&mut fake_child, &resp(&extract_id(&req), "get_state", true));
        let conn = connect.join().unwrap().unwrap();

        drop(fake_child); // EOF on the dispatcher's stdout
        wait_until(|| conn.engine.lock().unwrap().is_failed());

        assert!(conn.submit(RuntimeSubmission { text: "x".into() }).is_err());
        assert_eq!(publisher.failures.lock().unwrap().len(), 1); // exactly once
    }

    #[test]
    fn shutdown_terminates_the_tracked_process_when_it_does_not_exit_on_its_own_and_is_idempotent()
    {
        let (dispatcher_end, mut fake_child) = test_pipe_pair();
        let kill_flag = Arc::new(Mutex::new(false));
        let handle = handle_over(dispatcher_end, kill_flag.clone());
        let publisher = Arc::new(Recording::default());
        let connect = std::thread::spawn(move || PiConnection::connect_with(publisher, handle));
        let req = read_line(&mut fake_child);
        write_line(&mut fake_child, &resp(&extract_id(&req), "get_state", true));
        let conn = connect.join().unwrap().unwrap();

        conn.shutdown().unwrap();
        assert!(
            *kill_flag.lock().unwrap(),
            "a process that never exits on its own must be terminated"
        );
        conn.shutdown().unwrap(); // FR-7: session_remove + app-exit may both call this
    }

    #[test]
    fn a_handshake_that_never_answers_times_out_bounded_and_kills_the_child() {
        let (dispatcher_end, _fake_child) = test_pipe_pair(); // never responds
        let kill_flag = Arc::new(Mutex::new(false));
        let handle = handle_over(dispatcher_end, kill_flag.clone());
        let publisher = Arc::new(Recording::default());
        let deadlines = Deadlines {
            init: Duration::from_millis(100),
            read_only: Duration::from_millis(100),
            prompt: Duration::from_millis(100),
            compaction: Duration::from_millis(100),
        };
        let started = std::time::Instant::now();
        let err = PiConnection::connect_with_deadlines(publisher, handle, deadlines)
            .err()
            .unwrap();
        assert_eq!(err.code, ErrorCode::RuntimeTimeout);
        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(*kill_flag.lock().unwrap());
    }

    fn wait_until(mut condition: impl FnMut() -> bool) {
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while !condition() {
            assert!(
                std::time::Instant::now() < deadline,
                "condition never became true"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
    }
}
