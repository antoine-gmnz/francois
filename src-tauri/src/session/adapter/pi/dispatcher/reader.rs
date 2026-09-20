//! session/adapter/pi/dispatcher/reader.rs — the thread that consumes the Pi
//! child's stdout, everything it does per inbound line (the extension-policy
//! gate, the transcript reducer, `ProtocolEngine`), and the ONE publish path
//! every terminal outcome converges on.
//!
//! Split out of `dispatcher.rs` for CLAUDE.md's ~1000-line cap, along the line
//! that was already drawn inside it: `dispatcher.rs` owns the connection
//! OBJECT (the child's stdin, the round-trip machinery, the
//! `RuntimeSessionControl` verbs), this module owns the inbound half. The
//! terminal helpers below are shared rather than reader-private on purpose —
//! `PiConnection::dispatch`'s own write-failure/timeout branches end the
//! connection in exactly the same way an EOF does, and both sides publishing
//! through the same two functions is what keeps that one story instead of two.

use std::io::Read;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use super::super::normalize::TranscriptReducer;
use super::super::protocol::{LineOutcome, ProtocolEngine};
use super::super::wire;
use super::child::{ChildLink, EXIT_GRACE};
use super::{DiagnosticContext, EventPublisher};

/// FR-8: a `DiagnosticContext` carrying only the connection-wide counts off
/// `ProtocolEngine::counts` — the reader thread has no in-flight command to
/// attach a requestId/command/duration to.
pub(super) fn counts_ctx(engine: &Arc<Mutex<ProtocolEngine>>) -> DiagnosticContext {
    let (frame_count, error_count) = engine.lock().unwrap().counts();
    DiagnosticContext {
        frame_count,
        error_count,
        ..Default::default()
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

pub(super) fn publish_with_stderr(
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

/// pi-transcript-events FR-1/FR-6: hand one already-parsed line to the
/// transcript reducer and publish whatever it produces — but only for
/// EVENT-shaped lines (`wire::looks_like_response` false). A response line
/// carries no `type` field, so the reducer would misread it as "missing its
/// type" and fail; `ProtocolEngine::on_line` (called separately, right beside
/// this) already owns response correlation. Malformed JSON never reaches here
/// at all — `ProtocolEngine::on_line`'s own parse already fails the whole
/// connection for that line.
fn apply_transcript_line(
    reducer: &Arc<Mutex<TranscriptReducer>>,
    publisher: &Arc<dyn EventPublisher>,
    value: &serde_json::Value,
) {
    if wire::looks_like_response(value) {
        return;
    }
    let events = reducer
        .lock()
        .unwrap()
        .on_event(value, crate::ids::now_ms());
    for event in events {
        publisher.transcript(event);
    }
}

/// pi-transcript-events FR-9: crash/stop finalizes every still-open assistant
/// slot as `interrupted` and every unsettled tool call as `cancelled`/
/// `unknown` — called once, right after this connection reaches ANY terminal
/// `LineOutcome` (EOF, a read error, an oversize/malformed frame, a protocol
/// failure) or a terminal dispatch outcome (a write failure, a timeout), the
/// same "whole connection is now failed" moment `on_disconnect`/
/// `on_frame_error`/`on_timeout`/`fail` already latch. Safe to reach twice
/// (`finalize_interrupted` is itself idempotent), which is what lets the
/// reader and a failing dispatch race without emitting a block twice.
pub(super) fn finalize_transcript(
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

/// pi-skills-capabilities FR-6 (defensive; no certified wire shape exists for
/// this — see this feature's own handoff): `--no-extensions` means a certified
/// Pi child should never emit anything about an extension's own UI, so ANY
/// event whose `type` mentions "extension" is treated as a policy violation
/// rather than fed to `ProtocolEngine` (which would just count/ignore an
/// unrecognized kind and let the connection keep running). Checked ahead of
/// `on_line` so the reader can stop the child before the correlation engine
/// even sees the line — "never automatically confirm a request as an approval
/// bridge" holds trivially (nothing here ever reads such an event's fields to
/// reply to it), and this is the "cancel/surface a policy failure/stop it"
/// half.
///
/// LOW (review round 4): the TOP-LEVEL `type` is the only place checked, and
/// deliberately so. It is the only event-kind discriminator this wire has —
/// `wire::parse_line` and `normalize::TranscriptReducer::on_event` both
/// dispatch on it alone. The only other `type` fields anywhere in the
/// adapter's documented shapes are CONTENT kinds from a closed set
/// (`delta.type` and `content[].type`: `text`/`thinking`/`signature`/
/// `tool_use`), not event kinds, so widening the scan to them would not catch
/// an extension event — it would only let a tool's own OUTPUT (attacker-
/// controlled text that happens to parse as JSON naming an "extension")
/// terminate a healthy session. Widen this only against a real capture that
/// shows an extension event nested somewhere.
fn extension_policy_violation(value: &serde_json::Value) -> Option<String> {
    let kind = value.get("type")?.as_str()?;
    kind.to_ascii_lowercase()
        .contains("extension")
        .then(|| format!("baseline session received an extension event ({kind}); stopping"))
}

/// One terminal outcome, published and then reaped. Every way this thread can
/// end a connection goes through here — and so does the child (review round 4
/// follow-up): only the extension-policy gate used to take it down, so an EOF,
/// a read error or a frame error left the process running, which is the same
/// leak the dispatch-side HIGH was about. A read error in particular says
/// nothing about whether the child is still alive.
///
/// `grace` is how long the child may take to exit on its own once its stdin is
/// closed — the FR-7 window for a connection that simply ended, and none at
/// all for the policy gate, whose whole job is to stop it now.
fn end_connection(
    engine: &Arc<Mutex<ProtocolEngine>>,
    publisher: &Arc<dyn EventPublisher>,
    stderr_ring: &Arc<Mutex<Vec<u8>>>,
    reducer: &Arc<Mutex<TranscriptReducer>>,
    child: &Arc<ChildLink>,
    outcome: LineOutcome,
    grace: Duration,
) {
    let ctx = counts_ctx(engine);
    publish_with_stderr(publisher, outcome, stderr_ring, ctx);
    finalize_transcript(reducer, publisher);
    child.retire(grace);
}

pub(super) fn spawn_reader(
    mut stdout: Box<dyn Read + Send>,
    engine: Arc<Mutex<ProtocolEngine>>,
    publisher: Arc<dyn EventPublisher>,
    stderr_ring: Arc<Mutex<Vec<u8>>>,
    reducer: Arc<Mutex<TranscriptReducer>>,
    child: Arc<ChildLink>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let mut framer = wire::FrameReader::new();
        let mut buf = [0u8; 8192];
        'reader: loop {
            let read = stdout.read(&mut buf);
            // HIGH (review round 4): a dispatch-side failure retires the whole
            // connection, and this thread is half of what "retired" has to
            // mean — it stops here rather than reading on, normalizing into a
            // session that has already failed. Checked the moment a read
            // returns, so bytes that arrived after retirement are not even
            // looked at.
            if child.is_retired() {
                break 'reader;
            }
            match read {
                Ok(0) => {
                    let outcome = engine
                        .lock()
                        .unwrap()
                        .on_disconnect("the Pi child closed its output");
                    end_connection(
                        &engine,
                        &publisher,
                        &stderr_ring,
                        &reducer,
                        &child,
                        outcome,
                        EXIT_GRACE,
                    );
                    break;
                }
                Ok(n) => match framer.feed(&buf[..n]) {
                    Ok(lines) => {
                        for line in lines {
                            // Retirement can land mid-batch, between two lines
                            // this same read produced.
                            if child.is_retired() {
                                break 'reader;
                            }
                            // LOW (review round 4): EXACTLY one parse per line,
                            // threaded through all three readers of it — the
                            // policy gate, the transcript reducer, and the
                            // correlation engine (`on_frame`). It used to be
                            // three, over records that may be megabytes.
                            let outcome = match serde_json::from_str::<serde_json::Value>(&line) {
                                Ok(value) => {
                                    if let Some(reason) = extension_policy_violation(&value) {
                                        let outcome =
                                            engine.lock().unwrap().on_policy_violation(&reason);
                                        // FR-6: "stop it" — the tracked process
                                        // tree comes down right here, with NO
                                        // grace period (unlike an ordinary
                                        // disconnect), rather than only marking
                                        // the connection failed and waiting for
                                        // an explicit Stop/session_remove to
                                        // reap it.
                                        end_connection(
                                            &engine,
                                            &publisher,
                                            &stderr_ring,
                                            &reducer,
                                            &child,
                                            outcome,
                                            Duration::ZERO,
                                        );
                                        break 'reader;
                                    }
                                    apply_transcript_line(&reducer, &publisher, &value);
                                    engine.lock().unwrap().on_frame(&value)
                                }
                                // Not JSON at all: neither the policy gate nor
                                // the reducer has anything to say about a line
                                // neither can read, and `on_line` owns that
                                // verdict — it fails the connection, so this
                                // branch is reached at most once.
                                Err(_) => engine.lock().unwrap().on_line(&line),
                            };
                            if outcome.failure.is_some() {
                                end_connection(
                                    &engine,
                                    &publisher,
                                    &stderr_ring,
                                    &reducer,
                                    &child,
                                    outcome,
                                    EXIT_GRACE,
                                );
                                break 'reader;
                            }
                            let ctx = counts_ctx(&engine);
                            publish_with_stderr(&publisher, outcome, &stderr_ring, ctx);
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
                        end_connection(
                            &engine,
                            &publisher,
                            &stderr_ring,
                            &reducer,
                            &child,
                            outcome,
                            EXIT_GRACE,
                        );
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
                    end_connection(
                        &engine,
                        &publisher,
                        &stderr_ring,
                        &reducer,
                        &child,
                        outcome,
                        EXIT_GRACE,
                    );
                    break;
                }
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn violation(line: &str) -> Option<String> {
        extension_policy_violation(&serde_json::from_str(line).unwrap())
    }

    #[test]
    fn a_top_level_extension_event_type_is_a_policy_violation() {
        assert!(violation(r#"{"type":"extension_ui_request"}"#).is_some());
        assert!(violation(r#"{"type":"EXTENSION_PROMPT"}"#).is_some());
    }

    #[test]
    fn ordinary_transcript_traffic_is_not_a_policy_violation() {
        assert!(violation(r#"{"type":"message_start","role":"user"}"#).is_none());
        assert!(violation(r#"{"id":"1","command":"get_state","success":true}"#).is_none());
    }

    /// LOW (review round 4): a NESTED `type` is a content kind, never an event
    /// kind — see `extension_policy_violation`'s own doc. A tool's output is
    /// attacker-controlled text, so scanning inside a line would hand any
    /// prompt the power to kill the session.
    #[test]
    fn a_nested_content_type_is_never_read_as_an_event_kind() {
        assert!(violation(
            r#"{"type":"tool_execution_end","toolCallId":"t1","output":"{\"type\":\"extension_ui_request\"}"}"#
        )
        .is_none());
        assert!(violation(
            r#"{"type":"content_delta","messageId":"m1","contentIndex":0,"delta":{"type":"text","text":"extension"}}"#
        )
        .is_none());
    }
}
