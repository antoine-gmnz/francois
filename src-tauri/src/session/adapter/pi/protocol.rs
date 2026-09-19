//! session/adapter/pi/protocol.rs — FR-2/FR-3/FR-4/FR-6: the pure Pi RPC
//! correlation + connection state machine. No I/O at all, which is what lets
//! its edge cases (interleaved replies, duplicates, unknown events, the
//! internal state machine, the 32-outstanding cap) be unit-tested directly
//! with real `mpsc` channels and no process in sight — fragmented UTF-8/
//! oversize framing lives in `wire`'s own tests, and the live wrapper around
//! this engine (`PiConnection`, the reader thread, `RuntimeSessionControl`)
//! lives in `dispatcher.rs`. Split out of `dispatcher.rs` purely for
//! CLAUDE.md's ~1000-line file cap — "one concern per child" already draws
//! this exact line (correlation/state vs. the live connection).

use crate::ipc::{AppError, ErrorCode};
use crate::session::events::RuntimeRunState;
use std::collections::{HashMap, HashSet};
use std::sync::mpsc;
use std::time::Duration;

use super::wire::{self, Frame, ParseError, PiCommand, PiCommandBody, PiCommandKind};

// ---------------------------------------------------------------- deadlines

/// FR-5: fixed per spec — "configurable only in internal tests initially",
/// hence no public setter; only `ProtocolEngine::with_deadlines` (test-only)
/// overrides them.
#[derive(Clone, Copy)]
pub(crate) struct Deadlines {
    pub(crate) init: Duration,
    pub(crate) read_only: Duration,
    pub(crate) prompt: Duration,
    #[allow(dead_code)] // no compaction command wired up in this MVP yet
    pub(crate) compaction: Duration,
}

impl Default for Deadlines {
    fn default() -> Self {
        Self {
            init: Duration::from_secs(15),
            read_only: Duration::from_secs(10),
            prompt: Duration::from_secs(30),
            compaction: Duration::from_secs(180),
        }
    }
}

impl Deadlines {
    fn for_kind(self, kind: PiCommandKind) -> Duration {
        match kind {
            PiCommandKind::GetState => self.init,
            PiCommandKind::Prompt => self.prompt,
            PiCommandKind::Interrupt => self.read_only,
        }
    }
}

// ---------------------------------------------------------------- protocol engine

/// FR-2: no more than this many commands may be outstanding at once.
const MAX_OUTSTANDING: usize = 32;

pub(crate) enum PendingOutcome {
    Response(wire::PiResponse),
    /// FR-6: the connection failed while this command was still outstanding.
    ConnectionFailed(String),
}

struct PendingEntry {
    kind: PiCommandKind,
    tx: mpsc::Sender<PendingOutcome>,
}

/// One line's effect, for the caller to act on: publish a run-state change,
/// log a diagnostic, or settle the connection as failed. `Default` is
/// "nothing to do" — e.g. `agent_end` (FR-4: no transition), or every call
/// after the first once a failure has already latched (FR-3/FR-6).
#[derive(Default)]
pub(crate) struct LineOutcome {
    pub(crate) run_state: Option<RuntimeRunState>,
    pub(crate) diagnostic: Option<String>,
    pub(crate) failure: Option<(ErrorCode, String)>,
}

/// FR-2/FR-3/FR-4/FR-6: the pure correlation + connection state machine.
/// Never touches I/O or the session lock — it doesn't have one.
pub(crate) struct ProtocolEngine {
    state: RuntimeRunState,
    pending: HashMap<String, PendingEntry>,
    /// FR-3: one diagnostic notice per unknown kind for this connection's
    /// whole life — a reconnect is a brand new `ProtocolEngine` (a new
    /// "generation"), so this naturally resets per generation.
    unknown_notified: HashSet<String>,
    event_counts: HashMap<String, u64>,
    /// FR-8: total wire lines this connection has decoded (response, event,
    /// or malformed frame alike) — one half of the "frame/error counts" the
    /// diagnostics log carries.
    frame_count: u64,
    /// FR-8: lines that were diagnosed as some kind of anomaly (unknown
    /// response id, duplicate reply, unknown event kind) or that failed the
    /// connection outright — the other half.
    error_count: u64,
    failed: bool,
    stopping: bool,
    deadlines: Deadlines,
}

impl ProtocolEngine {
    pub(crate) fn new() -> Self {
        Self {
            state: RuntimeRunState::Starting,
            pending: HashMap::new(),
            unknown_notified: HashSet::new(),
            event_counts: HashMap::new(),
            frame_count: 0,
            error_count: 0,
            failed: false,
            stopping: false,
            deadlines: Deadlines::default(),
        }
    }

    #[cfg(test)]
    pub(crate) fn with_deadlines(deadlines: Deadlines) -> Self {
        Self {
            deadlines,
            ..Self::new()
        }
    }

    /// Test-only introspection today — production code never asks a
    /// `ProtocolEngine` its own state, since `on_*`'s return values already
    /// carry every transition the caller needs to act on.
    #[allow(dead_code)]
    pub(crate) fn state(&self) -> RuntimeRunState {
        self.state
    }

    #[allow(dead_code)]
    pub(crate) fn is_failed(&self) -> bool {
        self.failed
    }

    /// FR-8: `(frame_count, error_count)` — the running totals every
    /// diagnostics log line threads into its `frames=`/`errors=` fields.
    pub(crate) fn counts(&self) -> (u64, u64) {
        (self.frame_count, self.error_count)
    }

    /// FR-7: stop admitting new commands — shutdown's first step.
    pub(crate) fn stop_admissions(&mut self) {
        self.stopping = true;
    }

    /// FR-2/FR-5: register a fresh outstanding command, capped at
    /// `MAX_OUTSTANDING`. Returns the command to write, its deadline, and the
    /// receiver its eventual (or connection-failed) outcome arrives on.
    pub(crate) fn send(
        &mut self,
        body: PiCommandBody,
    ) -> Result<(PiCommand, Duration, mpsc::Receiver<PendingOutcome>), AppError> {
        if self.failed || self.stopping {
            return Err(AppError::new(
                ErrorCode::RuntimeUnavailable,
                "the Pi connection is not accepting commands",
            ));
        }
        if self.pending.len() >= MAX_OUTSTANDING {
            return Err(AppError::new(
                ErrorCode::RuntimeUnavailable,
                "too many outstanding Pi RPC commands",
            ));
        }
        let command = PiCommand {
            id: crate::ids::uuid(),
            body,
        };
        let kind = command.kind();
        let (tx, rx) = mpsc::channel();
        self.pending
            .insert(command.id.clone(), PendingEntry { kind, tx });
        Ok((command, self.deadlines.for_kind(kind), rx))
    }

    /// The caller gave up waiting (its own deadline elapsed) — drop the entry
    /// so a very late reply is classified as "unknown id" (FR-3) rather than
    /// retained forever. Unused on the path that already fails the whole
    /// connection on timeout (see `PiConnection::dispatch`) but kept for a
    /// caller that only wants to abandon its OWN wait without failing others.
    #[allow(dead_code)]
    pub(crate) fn forget(&mut self, id: &str) {
        self.pending.remove(id);
    }

    /// FR-2/FR-3: react to one already-framed, already-decoded line.
    pub(crate) fn on_line(&mut self, line: &str) -> LineOutcome {
        if self.failed {
            return LineOutcome::default();
        }
        self.frame_count += 1;
        match wire::parse_line(line) {
            Ok(Frame::Response(resp)) => self.on_response(resp),
            Ok(Frame::Event(ev)) => self.on_event(ev),
            Err(ParseError::NotAFrame) => self.fail(
                ErrorCode::RuntimeProtocolError,
                "frame is neither a response nor an event",
            ),
            Err(ParseError::InvalidJson) => self.fail(
                ErrorCode::RuntimeProtocolError,
                "malformed frame: invalid JSON",
            ),
            Err(ParseError::EmptyEventType) => {
                self.fail(ErrorCode::RuntimeProtocolError, "event missing its type")
            }
            Err(ParseError::MissingField { kind, field }) => self.fail(
                ErrorCode::RuntimeProtocolError,
                &format!("{kind} event missing required field {field}"),
            ),
        }
    }

    fn on_response(&mut self, resp: wire::PiResponse) -> LineOutcome {
        let Some(entry) = self.pending.get(&resp.id) else {
            // FR-3: unknown id, or a duplicate of an already-resolved one
            // (resolving removes the entry, so a second reply for the same
            // id lands here too) — discard and diagnose, not fatal.
            self.error_count += 1;
            return LineOutcome {
                diagnostic: Some(format!(
                    "discarded a response with an unknown or already-resolved id (command {})",
                    super::process::sanitize_diagnostic(&resp.command, 64)
                )),
                ..Default::default()
            };
        };
        if entry.kind.wire_name() != resp.command {
            // FR-3: wrong command for a known id — a response cannot
            // complete a different command than it answers.
            return self.fail(
                ErrorCode::RuntimeProtocolError,
                "response command does not match its pending request",
            );
        }
        let entry = self.pending.remove(&resp.id).expect("just matched above");
        let mut run_state = None;
        // FR-4: success is ACCEPTANCE only. `get_state`'s acceptance IS
        // completion (the handshake has nothing further to wait for);
        // `prompt`'s acceptance only starts the run — `agent_settled` (an
        // EVENT, not this response) is what completes it.
        if resp.success {
            run_state = match (entry.kind, self.state) {
                (PiCommandKind::GetState, RuntimeRunState::Starting) => {
                    self.state = RuntimeRunState::Idle;
                    Some(RuntimeRunState::Idle)
                }
                (PiCommandKind::Prompt, RuntimeRunState::Idle) => {
                    self.state = RuntimeRunState::Running;
                    Some(RuntimeRunState::Running)
                }
                _ => None,
            };
        }
        let _ = entry.tx.send(PendingOutcome::Response(resp));
        LineOutcome {
            run_state,
            ..Default::default()
        }
    }

    fn on_event(&mut self, ev: wire::PiEvent) -> LineOutcome {
        match ev {
            // FR-4: `agent_settled` governs completion — the ONLY event that
            // moves a running turn back to idle.
            wire::PiEvent::AgentSettled => {
                if self.state == RuntimeRunState::Running {
                    self.state = RuntimeRunState::Idle;
                    LineOutcome {
                        run_state: Some(RuntimeRunState::Idle),
                        ..Default::default()
                    }
                } else {
                    Default::default()
                }
            }
            // FR-4: "agent_end alone does not transition to idle" —
            // deliberately no state change. `turn_end` is informational too
            // in this MVP (its `reason` field is validated, not acted on).
            wire::PiEvent::AgentEnd | wire::PiEvent::TurnEnd => Default::default(),
            // pi-transcript-events FR-1 (review round 3): known, healthy
            // transcript traffic that `normalize::TranscriptReducer` already
            // owns (fed the same raw line by
            // `dispatcher::apply_transcript_line`) — no run-state change, no
            // error/diagnostic. `Unknown` stays the only path that counts an
            // error and notifies.
            wire::PiEvent::Recognized(_) => Default::default(),
            wire::PiEvent::Unknown(kind) => {
                *self.event_counts.entry(kind.clone()).or_insert(0) += 1;
                self.error_count += 1;
                if self.unknown_notified.insert(kind.clone()) {
                    LineOutcome {
                        diagnostic: Some(format!(
                            "unknown event kind ignored: {}",
                            super::process::sanitize_diagnostic(&kind, 64)
                        )),
                        ..Default::default()
                    }
                } else {
                    Default::default()
                }
            }
        }
    }

    /// FR-2: an oversize/malformed frame the reader could not even decode
    /// into a line — never reaches `on_line`, so it counts itself as a frame
    /// here instead.
    pub(crate) fn on_frame_error(&mut self, reason: &str) -> LineOutcome {
        self.frame_count += 1;
        self.fail(ErrorCode::RuntimeProtocolError, reason)
    }

    /// FR-6: EOF or a read error on the child's stdout.
    pub(crate) fn on_disconnect(&mut self, reason: &str) -> LineOutcome {
        self.fail(ErrorCode::RuntimeExited, reason)
    }

    /// FR-5/Edge cases §7: the dispatcher's own wait deadline elapsed while a
    /// command was still outstanding — "ambiguous, not permission to
    /// replay", so this fails the WHOLE connection exactly like
    /// `on_disconnect` does, but keeps `RuntimeTimeout` as the terminal code
    /// instead of borrowing `RuntimeExited`.
    pub(crate) fn on_timeout(&mut self, reason: &str) -> LineOutcome {
        self.fail(ErrorCode::RuntimeTimeout, reason)
    }

    /// FR-3/FR-6: once a failure wins, later calls are no-ops — the terminal
    /// result is emitted exactly once, and every outstanding request is
    /// rejected immediately rather than left to time out one by one.
    fn fail(&mut self, code: ErrorCode, reason: &str) -> LineOutcome {
        if self.failed {
            return LineOutcome::default();
        }
        self.failed = true;
        self.error_count += 1;
        self.state = RuntimeRunState::Failed;
        for (_, entry) in self.pending.drain() {
            let _ = entry
                .tx
                .send(PendingOutcome::ConnectionFailed(reason.to_string()));
        }
        LineOutcome {
            run_state: Some(RuntimeRunState::Failed),
            failure: Some((code, reason.to_string())),
            ..Default::default()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn engine_for_test() -> ProtocolEngine {
        ProtocolEngine::with_deadlines(Deadlines {
            init: Duration::from_millis(200),
            read_only: Duration::from_millis(200),
            prompt: Duration::from_millis(200),
            compaction: Duration::from_millis(200),
        })
    }

    fn resp_line(id: &str, command: &str, success: bool) -> String {
        serde_json::json!({ "id": id, "command": command, "success": success }).to_string()
    }

    #[test]
    fn get_state_success_moves_starting_to_idle() {
        let mut e = engine_for_test();
        let (cmd, _deadline, rx) = e.send(PiCommandBody::GetState).unwrap();
        let outcome = e.on_line(&resp_line(&cmd.id, "get_state", true));
        assert_eq!(outcome.run_state, Some(RuntimeRunState::Idle));
        assert_eq!(e.state(), RuntimeRunState::Idle);
        match rx.recv().unwrap() {
            PendingOutcome::Response(r) => assert!(r.success),
            _ => panic!("expected a response"),
        }
    }

    /// FR acceptance: "Two prompts use one child; a multi-tool run stays busy
    /// until settled."
    #[test]
    fn two_prompts_on_one_engine_alternate_idle_and_running() {
        let mut e = engine_for_test();
        let (h, _, _) = e.send(PiCommandBody::GetState).unwrap();
        e.on_line(&resp_line(&h.id, "get_state", true));

        for _ in 0..2 {
            let (p, _, prx) = e
                .send(PiCommandBody::Prompt {
                    text: "hi".into(),
                    images: Vec::new(),
                })
                .unwrap();
            let outcome = e.on_line(&resp_line(&p.id, "prompt", true));
            assert_eq!(outcome.run_state, Some(RuntimeRunState::Running));
            match prx.recv().unwrap() {
                PendingOutcome::Response(r) => assert!(r.success),
                _ => panic!("expected a response"),
            }
            let outcome = e.on_line(r#"{"type":"agent_settled"}"#);
            assert_eq!(outcome.run_state, Some(RuntimeRunState::Idle));
        }
        assert_eq!(e.state(), RuntimeRunState::Idle);
    }

    #[test]
    fn agent_end_alone_does_not_move_back_to_idle() {
        let mut e = engine_for_test();
        let (h, _, _) = e.send(PiCommandBody::GetState).unwrap();
        e.on_line(&resp_line(&h.id, "get_state", true));
        let (p, _, _) = e
            .send(PiCommandBody::Prompt {
                text: "hi".into(),
                images: Vec::new(),
            })
            .unwrap();
        e.on_line(&resp_line(&p.id, "prompt", true));
        let outcome = e.on_line(r#"{"type":"agent_end"}"#);
        assert!(outcome.run_state.is_none());
        assert_eq!(e.state(), RuntimeRunState::Running);
    }

    #[test]
    fn an_unknown_response_id_is_discarded_and_diagnosed_not_fatal() {
        let mut e = engine_for_test();
        let outcome = e.on_line(&resp_line("nope", "get_state", true));
        assert!(outcome.diagnostic.is_some());
        assert!(!e.is_failed());
    }

    #[test]
    fn a_duplicate_reply_for_an_already_resolved_id_is_discarded_not_completed_twice() {
        let mut e = engine_for_test();
        let (h, _, rx) = e.send(PiCommandBody::GetState).unwrap();
        e.on_line(&resp_line(&h.id, "get_state", true));
        rx.recv().unwrap();
        let outcome = e.on_line(&resp_line(&h.id, "get_state", true));
        assert!(outcome.diagnostic.is_some());
        assert!(outcome.run_state.is_none());
        assert!(!e.is_failed());
    }

    #[test]
    fn a_reply_naming_the_wrong_command_for_a_known_id_fails_the_protocol() {
        let mut e = engine_for_test();
        let (h, _, rx) = e.send(PiCommandBody::GetState).unwrap();
        let outcome = e.on_line(&resp_line(&h.id, "prompt", true));
        assert!(e.is_failed());
        assert_eq!(outcome.run_state, Some(RuntimeRunState::Failed));
        match rx.recv().unwrap() {
            PendingOutcome::ConnectionFailed(_) => {}
            _ => panic!("expected the pending get_state to be rejected"),
        }
    }

    #[test]
    fn valid_unknown_event_kinds_are_counted_and_notified_once_per_kind() {
        let mut e = engine_for_test();
        let first = e.on_line(r#"{"type":"future_event"}"#);
        assert!(first.diagnostic.is_some());
        let second = e.on_line(r#"{"type":"future_event"}"#);
        assert!(second.diagnostic.is_none());
        assert_eq!(*e.event_counts.get("future_event").unwrap(), 2);
        assert!(!e.is_failed());
    }

    /// pi-transcript-events FR-1 (review round 3): the FR-1 transcript event
    /// vocabulary must never be misclassified as `Unknown` — no diagnostic,
    /// no error count, no run-state change, for a batch representative of
    /// normal, healthy transcript traffic on a turn.
    #[test]
    fn fr1_transcript_events_produce_no_diagnostic_or_error() {
        let mut e = engine_for_test();
        for line in [
            r#"{"type":"message_start"}"#,
            r#"{"type":"content_delta"}"#,
            r#"{"type":"text_end"}"#,
            r#"{"type":"message_end"}"#,
            r#"{"type":"toolcall_start"}"#,
            r#"{"type":"toolcall_delta"}"#,
            r#"{"type":"toolcall_end"}"#,
            r#"{"type":"tool_execution_start"}"#,
            r#"{"type":"tool_execution_update"}"#,
            r#"{"type":"tool_execution_end"}"#,
            r#"{"type":"compaction_start"}"#,
            r#"{"type":"compaction_end"}"#,
            r#"{"type":"retry"}"#,
            r#"{"type":"queue_update"}"#,
        ] {
            let outcome = e.on_line(line);
            assert!(outcome.diagnostic.is_none(), "{line} produced a diagnostic");
            assert!(outcome.failure.is_none(), "{line} produced a failure");
            assert!(outcome.run_state.is_none(), "{line} changed run state");
        }
        assert!(!e.is_failed());
        assert_eq!(e.counts().1, 0, "no FR-1 event should count as an error");
    }

    #[test]
    fn a_known_event_missing_a_required_field_fails_the_protocol() {
        let mut e = engine_for_test();
        let outcome = e.on_line(r#"{"type":"turn_end"}"#);
        assert!(e.is_failed());
        assert!(outcome.failure.is_some());
    }

    #[test]
    fn once_failed_no_second_terminal_result_is_emitted() {
        let mut e = engine_for_test();
        let first = e.on_line("not json");
        assert!(first.failure.is_some());
        let second = e.on_disconnect("also broken");
        assert!(second.failure.is_none());
        let third = e.on_line(r#"{"type":"agent_settled"}"#);
        assert!(third.run_state.is_none());
    }

    #[test]
    fn eof_rejects_every_outstanding_request_exactly_once() {
        let mut e = engine_for_test();
        let (_h, _, rx1) = e.send(PiCommandBody::GetState).unwrap();
        let (_p, _, rx2) = e
            .send(PiCommandBody::Prompt {
                text: "x".into(),
                images: Vec::new(),
            })
            .unwrap();
        let outcome = e.on_disconnect("the child exited");
        assert_eq!(outcome.run_state, Some(RuntimeRunState::Failed));
        for rx in [rx1, rx2] {
            match rx.recv().unwrap() {
                PendingOutcome::ConnectionFailed(_) => {}
                _ => panic!("expected every outstanding request to be rejected"),
            }
        }
    }

    #[test]
    fn no_more_than_32_commands_may_be_outstanding_at_once() {
        let mut e = engine_for_test();
        for _ in 0..32 {
            e.send(PiCommandBody::Interrupt).unwrap();
        }
        assert!(e.send(PiCommandBody::Interrupt).is_err());
    }

    #[test]
    fn admissions_stop_once_shutdown_has_been_requested() {
        let mut e = engine_for_test();
        e.stop_admissions();
        assert!(e.send(PiCommandBody::Interrupt).is_err());
    }

    /// CRITICAL fix (review round 1): a dispatch that timed out must fail the
    /// WHOLE connection with `RuntimeTimeout`, not just forget its own entry
    /// — and every OTHER outstanding request is rejected too, exactly like
    /// `on_disconnect`.
    #[test]
    fn on_timeout_fails_the_whole_connection_and_rejects_every_outstanding_request() {
        let mut e = engine_for_test();
        let (_h, _, rx1) = e.send(PiCommandBody::GetState).unwrap();
        let (_p, _, rx2) = e
            .send(PiCommandBody::Prompt {
                text: "x".into(),
                images: Vec::new(),
            })
            .unwrap();
        let outcome = e.on_timeout("get_state did not respond in time");
        assert!(e.is_failed());
        assert_eq!(outcome.run_state, Some(RuntimeRunState::Failed));
        assert_eq!(
            outcome.failure.as_ref().map(|(c, _)| *c),
            Some(ErrorCode::RuntimeTimeout)
        );
        for rx in [rx1, rx2] {
            match rx.recv().unwrap() {
                PendingOutcome::ConnectionFailed(_) => {}
                _ => panic!("expected every outstanding request to be rejected"),
            }
        }
        // Once failed, a second on_timeout/on_disconnect is a no-op (FR-3/FR-6).
        assert!(e.on_disconnect("also broken").failure.is_none());
    }

    /// FR-8: `counts()` tracks total decoded frames and anomalies
    /// (discarded/duplicate responses, unknown event kinds, the terminal
    /// failure itself) for the diagnostics log's `frames=`/`errors=` fields.
    #[test]
    fn counts_track_frames_and_anomalies() {
        let mut e = engine_for_test();
        let (h, _, _) = e.send(PiCommandBody::GetState).unwrap();
        e.on_line(&resp_line(&h.id, "get_state", true)); // 1 frame, 0 errors
        e.on_line(&resp_line("unknown-id", "get_state", true)); // 1 frame, 1 error
        e.on_line(r#"{"type":"future_event"}"#); // 1 frame, 1 error
        assert_eq!(e.counts(), (3, 2));
        e.on_line("not json"); // 1 frame, fails the connection: +1 error
        assert_eq!(e.counts(), (4, 3));
    }
}
