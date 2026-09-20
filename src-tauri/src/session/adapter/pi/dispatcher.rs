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
    CapabilityState, RuntimeCapabilities, RuntimeCommandInfo, RuntimeConnectContext,
    RuntimeModelRef, RuntimeSessionControl, RuntimeSubmission, SubmissionReceipt,
    RUNTIME_CAPABILITIES,
};
use crate::session::events;
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
    /// pi-skills-capabilities FR-6: `Arc`-shared (not a bare `Mutex`) so
    /// `spawn_reader`'s own defensive stop (an extension-policy violation)
    /// can terminate the tracked process tree without waiting for an
    /// explicit `shutdown()` call from elsewhere.
    kill: Arc<Mutex<Option<Box<dyn FnMut() + Send>>>>,
    reader: Mutex<Option<std::thread::JoinHandle<()>>>,
    /// pi-skills-capabilities FR-3: mutable — `images` is corrected once the
    /// connect handshake's model descriptor is known, after the baseline
    /// snapshot below is built with no model in hand yet.
    capabilities: Mutex<RuntimeCapabilities>,
    /// FR-4: "snapshot runtime ID and sessionFile" — captured off the
    /// `get_state` handshake's `data`. Read by `handshake_info()` below,
    /// pi-session-durability's cross-check after a resume handshake.
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

/// pi-session-durability: `session_file` is what `recovery::run_reconnect`
/// cross-checks after a `--resume` handshake — Pi reporting a DIFFERENT file
/// than the one just resumed is corruption worth catching, not a value to
/// discard. `runtime_id` rides along on the same response; still unread by
/// anything (no dependent feature needs it yet).
#[derive(Default, Clone)]
pub(crate) struct HandshakeInfo {
    #[allow(dead_code)]
    pub(crate) runtime_id: Option<String>,
    pub(crate) session_file: Option<String>,
    /// pi-models-metrics: the model/effort/available-levels the SAME
    /// `get_state` handshake reported, when parseable — lets the connect
    /// path populate `SessionMeta.model.efforts`/`effort` on the FIRST
    /// `session.meta` after connecting, per the lead's clarification, without
    /// a second round trip. `None`/empty when the handshake reply carries no
    /// parseable model (never treated as a connect failure — see
    /// `parse_model_from_state`'s own doc).
    pub(crate) model: Option<(events::RuntimeModelDescriptor, Option<String>, Vec<String>)>,
}

/// Baseline: nothing is advertised as supported yet beyond what a real
/// feature actually implements — an explicit, valid "unsupported" snapshot
/// rather than a missing one, so `resolve_capability` never falls back to a
/// legacy default for Pi.
///
/// pi-turn-controls: `steering`/`followUps`/`compaction` flip to `available`
/// here — the three capability keys that feature actually implements
/// (`session_submit`'s steer/followUp modes, `session_compact`'s Pi branch).
///
/// pi-models-metrics: `modelSwitching`/`contextMetrics`/`costMetrics` flip
/// too — `session_switch_model`/`session_switch_effort`'s Pi branch and
/// `session_metrics` are real for every connected Pi session, independent of
/// which model is selected.
///
/// pi-skills-capabilities FR-3: `skills` flips true — `get_commands` is
/// dispatchable the instant a connection exists (this function only ever
/// runs on an already-certified, already-connected child, so "discovery is
/// available" is unconditional here). `resumableSessions` flips true too —
/// this adapter's own `recovery` module implements `--resume`/`get_entries`,
/// so a Pi session genuinely IS resumable ("follow certified adapter
/// support"). Every OTHER named-false key gets its OWN plain-English
/// reason (FR-3's "skillsInstall, mcp, subagents, workflows, permissions,
/// remoteControl and usageBar false"); `images`/`interactiveCommands` (not
/// named by FR-3) keep the generic placeholder — `images` is corrected
/// right after this call, once the connect handshake's model descriptor is
/// known (see `connect_engine`'s own comment); this MVP implements no
/// interactive-commands routing for Pi at all.
fn baseline_capabilities() -> RuntimeCapabilities {
    RUNTIME_CAPABILITIES
        .iter()
        .map(|key| {
            let state = match *key {
                "steering" | "followUps" | "compaction" | "modelSwitching" | "contextMetrics"
                | "costMetrics" | "skills" | "resumableSessions" => CapabilityState {
                    available: true,
                    reason: None,
                },
                "skillsInstall" => capability_unavailable(
                    "Pi has no separate install step — only running an already-loaded skill is supported",
                ),
                "mcp" => capability_unavailable("Pi has no MCP server control surface in this release"),
                "subagents" => {
                    capability_unavailable("Pi has no subagent dispatch equivalent in this release")
                }
                "workflows" => {
                    capability_unavailable("Pi has no Workflow-tool equivalent in this release")
                }
                "permissions" => capability_unavailable(
                    "Pi tools run with your user permissions; François does not approve each tool call",
                ),
                "remoteControl" => {
                    capability_unavailable("Remote Control has no Pi equivalent in this release")
                }
                "usageBar" => {
                    capability_unavailable("Pi reports no plan-limit meters the usage bar can read")
                }
                _ => capability_unavailable("not yet supported for Pi sessions"),
            };
            (key.to_string(), state)
        })
        .collect()
}

fn capability_unavailable(reason: &str) -> CapabilityState {
    CapabilityState {
        available: false,
        reason: Some(reason.to_string()),
    }
}

/// pi-skills-capabilities FR-3: `images` follows the CURRENT model's
/// advertised input list — nothing else observes it in this MVP (no
/// separate images probe).
fn images_capability_state(input: &[String]) -> CapabilityState {
    let available = input.iter().any(|k| k == "image");
    CapabilityState {
        available,
        reason: (!available)
            .then(|| "the connected model does not report image input support".to_string()),
    }
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

/// pi-skills-capabilities FR-6 (defensive; no certified wire shape exists
/// for this — see this feature's own handoff): `--no-extensions` means a
/// certified Pi child should never emit anything about an extension's own
/// UI, so ANY event whose `type` mentions "extension" is treated as a
/// policy violation rather than fed to `ProtocolEngine` (which would just
/// count/ignore an unrecognized kind and let the connection keep running).
/// Checked ahead of `on_line` so the reader can stop the child before the
/// correlation engine even sees the line — "never automatically confirm a
/// request as an approval bridge" holds trivially (nothing here ever reads
/// such an event's fields to reply to it), and this is the "cancel/surface
/// a policy failure/stop it" half.
fn extension_policy_violation(line: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(line).ok()?;
    let kind = value.get("type")?.as_str()?;
    kind.to_ascii_lowercase()
        .contains("extension")
        .then(|| format!("baseline session received an extension event ({kind}); stopping"))
}

fn spawn_reader(
    mut stdout: Box<dyn Read + Send>,
    engine: Arc<Mutex<ProtocolEngine>>,
    publisher: Arc<dyn EventPublisher>,
    stderr_ring: Arc<Mutex<Vec<u8>>>,
    reducer: Arc<Mutex<TranscriptReducer>>,
    kill: Arc<Mutex<Option<Box<dyn FnMut() + Send>>>>,
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
                            if let Some(reason) = extension_policy_violation(&line) {
                                let outcome = engine.lock().unwrap().on_policy_violation(&reason);
                                let ctx = counts_ctx(&engine);
                                publish_with_stderr(&publisher, outcome, &stderr_ring, ctx);
                                finalize_transcript(&reducer, &publisher);
                                // FR-6: "stop it" — terminate the tracked
                                // process tree right here, rather than only
                                // marking the connection failed and waiting
                                // for an explicit Stop/session_remove to
                                // reap it later.
                                if let Some(kill_fn) = kill.lock().unwrap().as_mut() {
                                    kill_fn();
                                }
                                break 'reader;
                            }
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
        // pi-skills-capabilities FR-6: shared with `spawn_reader`'s own
        // defensive stop, not moved exclusively into `Self.kill` — see
        // `PiConnection.kill`'s own doc.
        let kill: Arc<Mutex<Option<Box<dyn FnMut() + Send>>>> =
            Arc::new(Mutex::new(Some(handle.kill)));
        let reader = spawn_reader(
            handle.stdout,
            engine.clone(),
            publisher.clone(),
            stderr_ring.clone(),
            reducer.clone(),
            kill.clone(),
        );
        let conn = Arc::new(Self {
            engine,
            write_lock: Mutex::new(()),
            stdin: Mutex::new(Some(handle.stdin)),
            wait_timeout: Mutex::new(Some(handle.wait_timeout)),
            kill,
            reader: Mutex::new(Some(reader)),
            capabilities: Mutex::new(baseline_capabilities()),
            handshake_info: Mutex::new(HandshakeInfo::default()),
            publisher,
            stderr_ring,
            reducer,
        });
        // FR-4: no model call or user prompt needed — `get_state` alone.
        match conn.dispatch(PiCommandBody::GetState) {
            Ok(resp) => {
                if let Some(data) = &resp.data {
                    // pi-models-metrics: best-effort — the SAME handshake
                    // reply, read through the ONE mapping function this
                    // adapter owns for it.
                    let model = super::models::parse_model_from_state(Some(data));
                    // pi-skills-capabilities FR-3: `images` follows the
                    // CURRENT model's advertised input — unknown at the
                    // moment `baseline_capabilities()` ran above (before this
                    // handshake reply existed), corrected here the instant
                    // it does.
                    if let Some((descriptor, _, _)) = &model {
                        conn.capabilities.lock().unwrap().insert(
                            "images".to_string(),
                            images_capability_state(&descriptor.input),
                        );
                    }
                    *conn.handshake_info.lock().unwrap() = HandshakeInfo {
                        runtime_id: data
                            .get("runtimeId")
                            .and_then(|v| v.as_str())
                            .map(String::from),
                        session_file: data
                            .get("sessionFile")
                            .and_then(|v| v.as_str())
                            .map(String::from),
                        model,
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

    /// `pub(super)` (pi-turn-controls): `adapter::pi::controls`'s own tests
    /// use this too, to prove `clear_queue`/`abort`/`compact` each surface a
    /// bounded `RUNTIME_TIMEOUT` rather than waiting on a silent child forever.
    #[cfg(test)]
    pub(super) fn connect_with_deadlines(
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
    ///
    /// `pub(super)` (pi-turn-controls): `adapter::pi::controls` — a SIBLING
    /// module of this one, not a child — dispatches its own new command
    /// kinds (`clear_queue`/`abort`/`compact`) through this exact method
    /// rather than duplicating the write/correlate/timeout machinery above.
    pub(super) fn dispatch(&self, body: PiCommandBody) -> Result<wire::PiResponse, AppError> {
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

impl PiConnection {
    /// pi-session-durability FR-4: fetch the durable entry list (+ leaf id)
    /// for projection rebuild. Read-only, and never called while a prompt is
    /// in flight — `recovery::reconnect_session` runs this right after the
    /// handshake, before the connection is handed to the engine for ordinary
    /// use. Not part of `RuntimeSessionControl`: no other runtime has an
    /// equivalent verb, so this stays a Pi-specific method on the concrete
    /// type the adapter's own reconnect flow holds.
    pub(crate) fn get_entries(&self, cursor: Option<String>) -> Result<wire::PiResponse, AppError> {
        self.dispatch(PiCommandBody::GetEntries { cursor })
    }

    /// pi-session-durability: the identity `get_state`'s handshake reported
    /// for THIS connection — a clone, since the live value is behind a mutex
    /// no caller should hold onto.
    pub(crate) fn handshake_info(&self) -> HandshakeInfo {
        self.handshake_info.lock().unwrap().clone()
    }

    /// pi-models-metrics FR-5/FR-6: raw `set_model` dispatch — the mapping
    /// from the read-back response into `RuntimeModelDescriptor` lives in
    /// `adapter::pi::models` (one mapping function per command, per this
    /// adapter's provenance convention), not here.
    fn set_model(&self, model: &RuntimeModelRef, effort: Option<&str>) -> Result<(), AppError> {
        self.dispatch(PiCommandBody::SetModel {
            provider_id: model.provider_id.clone(),
            model_id: model.model_id.clone(),
            effort: effort.map(str::to_string),
        })
        .map(|_| ())
    }

    /// pi-models-metrics FR-7: raw `get_session_stats` dispatch.
    fn get_session_stats_raw(&self) -> Result<wire::PiResponse, AppError> {
        self.dispatch(PiCommandBody::GetSessionStats)
    }
}

impl RuntimeSessionControl for PiConnection {
    /// FR-7: resolve any attachments `input.text` references into the
    /// prompt's own image content, rejecting BEFORE anything is dispatched
    /// when a referenced image outruns this connection's own `images`
    /// capability — checked here (not only by the generic session-level
    /// gate) because `PiConnection` alone knows what the wire actually needs.
    fn submit(&self, input: RuntimeSubmission) -> Result<SubmissionReceipt, AppError> {
        let images_supported = self
            .capabilities
            .lock()
            .unwrap()
            .get("images")
            .is_some_and(|c| c.available);
        let body = wire::build_prompt_body(input.text, &input.attachments, images_supported)?;
        self.dispatch(body).map(|resp| SubmissionReceipt {
            request_id: resp.id,
        })
    }

    fn capabilities(&self) -> RuntimeCapabilities {
        self.capabilities.lock().unwrap().clone()
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

    /// pi-models-metrics FR-5/FR-6: send `set_model`, then read state back
    /// (a fresh `get_state`) BEFORE reporting success — never trust the
    /// `set_model` acceptance alone. A read-back that does not carry a
    /// parseable current model, or whose effort does not match what was
    /// requested (Pi silently declining/clamping the level), is
    /// `RUNTIME_PROTOCOL_ERROR`/`INVALID_INPUT` respectively; either way the
    /// session's previous selection is left untouched by the CALLER, because
    /// this method never mutates anything itself (FR-5's "failure preserves
    /// the previous selection").
    ///
    /// KNOWN GAP (this feature's handoff): a malformed-but-wire-successful
    /// read-back does not additionally force this whole connection into a
    /// failed state the way a genuine protocol violation
    /// (`ProtocolEngine::fail`) does — the edge case "read-back failure
    /// leaves the session unavailable for sending" is only partially covered
    /// (the switch itself is refused and nothing is applied; the connection
    /// stays otherwise usable) until a certified wire capture says what a
    /// real malformed reply looks like.
    fn switch_model(
        &self,
        model: RuntimeModelRef,
        effort: Option<String>,
    ) -> Result<(events::RuntimeModelDescriptor, Option<String>, Vec<String>), AppError> {
        self.set_model(&model, effort.as_deref())?;
        let state = self.dispatch(PiCommandBody::GetState)?;
        let Some((descriptor, applied_effort, efforts)) =
            super::models::parse_model_from_state(state.data.as_ref())
        else {
            return Err(AppError::new(
                ErrorCode::RuntimeProtocolError,
                "Pi's model read-back was malformed",
            ));
        };
        if !super::models::effort_matches(effort.as_deref(), applied_effort.as_deref()) {
            return Err(AppError::new(
                ErrorCode::InvalidInput,
                "this model does not support the requested effort level",
            ));
        }
        Ok((descriptor, applied_effort, efforts))
    }

    /// pi-models-metrics FR-7: `get_session_stats`, mapped by the ONE mapping
    /// function `adapter::pi::models` owns for this command.
    fn read_metrics(&self) -> Result<events::RuntimeMetrics, AppError> {
        let resp = self.get_session_stats_raw()?;
        Ok(super::models::parse_metrics_response(
            resp.data.as_ref(),
            crate::ids::now_ms(),
        ))
    }

    /// pi-turn-controls FR-5/FR-6: delegates to `controls::clear_queue` — the
    /// wire construction lives there (this feature's own file), not here.
    fn clear_queue(&self) -> Result<(), AppError> {
        super::controls::clear_queue(self)
    }

    /// pi-turn-controls FR-6.
    fn abort(&self) -> Result<(), AppError> {
        super::controls::abort(self)
    }

    /// pi-turn-controls FR-8.
    fn compact(&self) -> Result<(), AppError> {
        super::controls::compact(self)
    }

    /// pi-skills-capabilities FR-1: `get_commands`, mapped by the ONE
    /// mapping function `adapter::pi::resources` owns for it.
    fn list_commands(&self) -> Result<Vec<RuntimeCommandInfo>, AppError> {
        let resp = self.dispatch(PiCommandBody::GetCommands)?;
        Ok(super::resources::parse_get_commands_response(
            resp.data.as_ref(),
        ))
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
