//! session/admission/deliver.rs — pi-turn-controls §5/§6: `admit_and_deliver`
//! (the ONE internal admission entry point) and `publish_queue_changed`.
//! Split out of the former single-file `admission.rs` purely for
//! CLAUDE.md's ~1000-line file cap; no behaviour changed by the split.
//!
//! `admit_and_deliver` is a three-line composition over two halves that need
//! no `AppHandle` — `admission_gate` (every refusal, before anything is
//! written) and `admit_and_dispatch` (admit → persist → wire → settle, with
//! the publish/persist pair injected). That is what makes the whole ladder
//! testable in a crate that wires up no Tauri app harness at all (see
//! commands/submit.rs's own doc comment on the same constraint).

use tauri::AppHandle;

use super::super::adapter::{self, RuntimeSubmission};
use super::super::events::RuntimeEventPayload;
use super::super::{status, AgentRuntime, Attachment, Engine, Session};
use super::*;

/// FR-4: resolve `attachment_ids` against the session's OWN records — an
/// unresolvable id is INVALID_INPUT; the existing per-file/kind caps were
/// already enforced when each attachment was staged/committed.
fn resolve_attachments(session: &Session, ids: &[String]) -> Result<Vec<Attachment>, AppError> {
    ids.iter()
        .map(|id| {
            session
                .attachments
                .iter()
                .find(|a| &a.id == id)
                .cloned()
                .ok_or_else(|| AppError::new(ErrorCode::InvalidInput, "unknown attachment id"))
        })
        .collect()
}

/// FR-4: the outbound frame this submission would encode to, estimated —
/// text bytes plus each attachment's base64-inflated size (base64 is ~4/3 of
/// raw bytes). Pure so the 32 MiB cap decision is unit-testable without an
/// `AppHandle`; `admit_and_deliver` is the only caller.
fn estimated_frame_bytes(text: &str, attachment_bytes: impl Iterator<Item = u64>) -> u64 {
    text.len() as u64
        + attachment_bytes
            .map(|b| b.saturating_mul(4) / 3)
            .sum::<u64>()
}

/// pi-skills-capabilities FR-5: pure half of the POLICY GATE below. Only a Pi
/// session reaches it (the runtime gate above runs first), and it FAILS
/// CLOSED: `false` both while `acknowledgedUnrestrictedTools` is still false
/// and when there is no policy on record at all.
///
/// LOW/MED (review): "no policy" used to pass. `session_create` refuses a Pi
/// account without one, so the only ways to get here are a pre-feature
/// persisted record (the field is omitted, not null) or a bug — and in both
/// cases the launch policy the user is being asked to acknowledge is simply
/// unknown, which is not the same thing as acknowledged. Such a session can
/// never connect either (`adapter::pi::process::pi_args` refuses a context
/// with no pinned policy), so this refusal costs no working flow.
fn resource_policy_ok(policy: Option<adapter::pi::RuntimeResourcePolicy>) -> bool {
    policy.is_some_and(|p| p.acknowledged_unrestricted_tools)
}

/// Everything `admit_and_deliver` decides BEFORE it touches the ledger —
/// session, runtime, policy, attachments, the FR-4 frame cap, the two
/// mid-operation refusals and the FR-1 mode/state matrix. Engine-only, so the
/// whole ladder is testable without an `AppHandle` (same reason
/// `clear_queue_bracketed`, commands/submit.rs, takes its remote half as a
/// closure). Hands back the resolved attachments the dispatch then sends.
///
/// Nothing here writes anything: a refusal leaves no ledger entry and no
/// sidecar file behind, which is the point of gating before `admit` rather
/// than after it.
fn admission_gate(
    engine: &Engine,
    session_id: &str,
    text: &str,
    delivery: DeliveryMode,
    attachment_ids: &[String],
) -> Result<Vec<Attachment>, AppError> {
    let Some((busy, agent_runtime, recovering, policy, effective_caps, attachments)) = engine
        .with_session(session_id, |s| {
            (
                status::is_busy(&s.status),
                s.agent_runtime,
                s.recovery_busy,
                s.resource_policy,
                s.effective_capabilities.clone(),
                resolve_attachments(s, attachment_ids),
            )
        })
    else {
        return Err(AppError::new(ErrorCode::SessionNotFound, "no such session"));
    };

    // RUNTIME GATE (MED, review): `session_submit` is the Pi verb — §5's
    // "Existing session_send remains valid for old runtimes; Pi callers use
    // submit". It used to have no runtime check at all, so a `session_submit`
    // aimed at a Claude session admitted an entry, failed the dispatch
    // (`submit_runtime` finds no connection), and left a `delivery-unknown`
    // row plus a sidecar file on disk that NOTHING could clear: the composer
    // for a non-Pi session never renders the queue strip, so there is no
    // Discard to press. Refused first, before anything is written.
    if agent_runtime != AgentRuntime::Pi {
        return Err(AppError::new(
            ErrorCode::RuntimeUnsupported,
            "this session's runtime does not accept explicit-delivery submissions",
        ));
    }

    // POLICY GATE (pi-skills-capabilities FR-5): refuse the first submit
    // while a Pi session's launch-policy acknowledgment is still false — or
    // absent entirely. See `resource_policy_ok`.
    if !resource_policy_ok(policy) {
        return Err(AppError::new(
            ErrorCode::RuntimePolicyRequired,
            "acknowledge that Pi tools run with your user permissions before sending",
        ));
    }

    let attachments = attachments?;

    // FR-4: the 32 MiB encoded-frame cap — refused BEFORE any encoding or
    // dispatch, never left to the wire's own inbound `MAX_RECORD_BYTES` check
    // to discover on the other side of a connection that already spent the
    // round trip.
    if estimated_frame_bytes(text, attachments.iter().map(|a| a.bytes)) > MAX_FRAME_BYTES {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "message with its attachments is over the 32 MiB encoded frame limit",
        ));
    }

    // MED (review): a reconnect in flight REBUILDS this session's projection
    // from the recorded native conversation, so anything admitted underneath
    // it is erased without ever reaching Pi — `recovery_busy` was claimed and
    // released by `recovery.rs` and then read nowhere else. A submit racing a
    // reconnect is refused for exactly the reason a submit racing a Stop is.
    if recovering {
        return Err(AppError::new(
            ErrorCode::SessionBusy,
            "this session is reconnecting",
        ));
    }

    // Edge cases §7 / FR-6: "Reject while stopping." A FAST PATH only — it
    // probes under its own lock acquisition, so a Stop landing between here
    // and the `admit` below still has to be caught; `AdmissionLedger::admit`
    // repeats the check under the same acquisition as its insert and is the
    // authoritative one. Kept here so error precedence does not change: a
    // submit arriving during a Stop is refused before the FR-1 mode/state
    // matrix gets to complain about anything else. Both answer with
    // `stopping_error()`, so the caller cannot tell which check caught it.
    if engine.with_admissions(session_id, |l| l.is_closed()) {
        return Err(stopping_error());
    }

    // FR-1: the delivery mode/state matrix.
    match delivery {
        DeliveryMode::Normal if busy => {
            return Err(AppError::new(
                ErrorCode::SessionBusy,
                "a turn is already running",
            ))
        }
        DeliveryMode::Steer if !busy => {
            return Err(AppError::new(
                ErrorCode::InvalidInput,
                "steer is only valid while a turn is running",
            ))
        }
        _ => {}
    }
    // FR-1: a follow-up submitted while IDLE takes the normal-prompt path
    // verbatim (only the recorded intent differs), so it needs no `followUps`
    // capability — that capability only gates the actual QUEUING behavior,
    // which only happens while busy. `steer` is unreachable here while idle
    // (rejected above), so it always needs `steering`.
    let capability_key = match delivery {
        DeliveryMode::Steer => Some("steering"),
        DeliveryMode::FollowUp if busy => Some("followUps"),
        DeliveryMode::FollowUp | DeliveryMode::Normal => None,
    };
    if let Some(key) = capability_key {
        if !adapter::resolve_capability(agent_runtime, effective_caps.as_ref(), key) {
            return Err(AppError::new(
                ErrorCode::RuntimeUnsupported,
                "runtime capability is unavailable",
            ));
        }
    }
    Ok(attachments)
}

/// pi-turn-controls §5/§6: the ONE internal admission entry point
/// `session_submit` calls — and that `skills_run` also calls, BEFORE its own
/// turn dispatch. Revalidates session/capability/state itself; never trusts a
/// caller's own narrowing (FR-1).
pub(crate) fn admit_and_deliver(
    app: &AppHandle,
    engine: &Engine,
    accounts: &dyn crate::account::AccountKinds,
    session_id: &str,
    client_message_id: &str,
    text: &str,
    delivery: DeliveryMode,
    attachment_ids: Vec<String>,
) -> Result<RuntimeMessageReceipt, AppError> {
    let attachments = admission_gate(engine, session_id, text, delivery, &attachment_ids)?;
    // The two `AppHandle` side effects of an admission change, spelled once
    // and injected below, so the admit/dispatch half needs no Tauri app and
    // its ORDER against the wire call is testable.
    let on_change = || {
        publish_queue_changed(app, engine, accounts, session_id);
        write_admission_sidecar(app, engine, session_id);
    };
    admit_and_dispatch(
        engine,
        session_id,
        client_message_id,
        text,
        delivery,
        &attachment_ids,
        attachments,
        &on_change,
    )
}

/// `admit_and_deliver`'s second half: admit, dispatch, settle the outcome.
/// `on_change` republishes `queue.changed` and re-snapshots the FR-9 sidecar.
#[allow(clippy::too_many_arguments)]
fn admit_and_dispatch(
    engine: &Engine,
    session_id: &str,
    client_message_id: &str,
    text: &str,
    delivery: DeliveryMode,
    attachment_ids: &[String],
    attachments: Vec<Attachment>,
    on_change: &dyn Fn(),
) -> Result<RuntimeMessageReceipt, AppError> {
    let (receipt, is_new) = engine
        .with_admissions(session_id, |l| {
            l.admit(
                client_message_id,
                text,
                delivery,
                attachment_ids,
                crate::ids::now_ms(),
            )
        })
        .map_err(AdmitError::into_app_error)?;

    if !is_new {
        return Ok(receipt);
    }
    // MED (review): persisted BEFORE the dispatch, not only after it. The
    // wire call below can take a whole prompt deadline, and a crash inside
    // that window used to lose the draft entirely — FR-9's "shutdown/crash
    // preserves unsent/unknown draft states for recovery". It is written as
    // the `admitting` entry it currently IS; a reload reclassifies that as
    // `delivery-unknown`, which is exactly what it was.
    on_change();

    let dispatch_result = engine.submit_runtime(
        session_id,
        RuntimeSubmission {
            text: text.to_string(),
            attachments,
        },
    );

    let outcome = match &dispatch_result {
        Ok(_) => DispatchOutcome::Accepted,
        Err(e)
            if matches!(
                e.code,
                ErrorCode::RuntimeTimeout
                    | ErrorCode::RuntimeExited
                    | ErrorCode::RuntimeUnavailable
            ) =>
        {
            DispatchOutcome::Uncertain
        }
        Err(_) => DispatchOutcome::Rejected,
    };
    let updated = engine
        .with_admissions(session_id, |l| {
            l.mark_dispatch_result(client_message_id, outcome)
        })
        .unwrap_or(receipt);
    on_change();

    match dispatch_result {
        Ok(_) => Ok(updated),
        Err(e) => Err(e),
    }
}

/// Publish `queue.changed` with the FULL pending snapshot, through the same
/// runtime-event envelope every other Pi event uses. Best-effort: a session
/// with no live runtime-event producer yet (no connection installed) simply
/// has nothing to publish through — never surfaced as the call's own error.
pub(crate) fn publish_queue_changed(
    app: &AppHandle,
    engine: &Engine,
    accounts: &dyn crate::account::AccountKinds,
    session_id: &str,
) {
    let entries = engine.with_admissions(session_id, |l| l.snapshot_pending());
    if let Ok(batch) = engine.runtime_event_for_session(
        accounts,
        session_id,
        crate::ids::now_ms(),
        None,
        None,
        RuntimeEventPayload::QueueChanged { entries },
    ) {
        for ev in batch.0 {
            super::super::emit(app, ev);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    #[test]
    fn estimated_frame_bytes_accounts_for_base64_inflation_of_attachments() {
        assert_eq!(estimated_frame_bytes("hi", std::iter::empty()), 2);
        // 3 raw bytes base64-encode to 4 — the 4/3 estimate.
        assert_eq!(estimated_frame_bytes("", [3].into_iter()), 4);
        let under_cap = estimated_frame_bytes("small", [1_000].into_iter());
        assert!(under_cap < MAX_FRAME_BYTES);
        let over_cap = estimated_frame_bytes("", [MAX_FRAME_BYTES].into_iter());
        assert!(over_cap > MAX_FRAME_BYTES);
    }

    // ---------- pi-skills-capabilities FR-5: the POLICY GATE ----------

    fn policy(acknowledged: bool) -> adapter::pi::RuntimeResourcePolicy {
        adapter::pi::RuntimeResourcePolicy {
            project_resources: adapter::pi::ProjectResources::Ignore,
            extensions: adapter::pi::ExtensionsPolicy::Disabled,
            acknowledged_unrestricted_tools: acknowledged,
        }
    }

    /// LOW/MED (review): the gate used to FAIL OPEN on a session with no
    /// policy on record — the one state in which what the user is being asked
    /// to acknowledge is not even known.
    #[test]
    fn no_policy_on_record_fails_the_gate_closed() {
        assert!(!resource_policy_ok(None));
    }

    #[test]
    fn an_unacknowledged_pi_policy_fails_the_gate() {
        assert!(!resource_policy_ok(Some(policy(false))));
    }

    #[test]
    fn an_acknowledged_pi_policy_passes_the_gate() {
        assert!(resource_policy_ok(Some(policy(true))));
    }

    // ---------- the admission gate, end to end over an Engine ----------

    use crate::session::testutil::{test_engine_with, test_session};

    /// An idle Pi session whose policy is already acknowledged — the state in
    /// which a Normal submit is supposed to be accepted.
    fn pi_engine() -> Engine {
        let mut s = test_session();
        s.agent_runtime = AgentRuntime::Pi;
        s.resource_policy = Some(policy(true));
        test_engine_with(s)
    }

    fn gate(engine: &Engine, delivery: DeliveryMode) -> Result<Vec<Attachment>, AppError> {
        admission_gate(engine, "s1", "hello", delivery, &[])
    }

    #[test]
    fn an_idle_acknowledged_pi_session_passes_the_gate() {
        assert!(gate(&pi_engine(), DeliveryMode::Normal).is_ok());
    }

    #[test]
    fn an_unknown_session_is_not_found() {
        let engine = pi_engine();
        let err = admission_gate(&engine, "nope", "hi", DeliveryMode::Normal, &[]).unwrap_err();
        assert_eq!(err.code, ErrorCode::SessionNotFound);
    }

    /// MED (review): `session_submit` had no runtime gate, so a non-Pi
    /// session was left with an unremovable `delivery-unknown` ledger row and
    /// a sidecar file on disk. The refusal has to land BEFORE `admit`.
    #[test]
    fn a_non_pi_session_is_refused_and_leaves_no_ledger_entry_behind() {
        for runtime in [
            AgentRuntime::ClaudeCode,
            AgentRuntime::Codex,
            AgentRuntime::Grok,
            AgentRuntime::Francois,
        ] {
            let mut s = test_session();
            s.agent_runtime = runtime;
            let engine = test_engine_with(s);
            let err = gate(&engine, DeliveryMode::Normal).unwrap_err();
            assert_eq!(err.code, ErrorCode::RuntimeUnsupported, "{runtime:?}");
            assert!(
                engine
                    .with_admissions("s1", |l| l.snapshot_pending())
                    .is_empty(),
                "a refused submit must write nothing — there is no queue strip to remove it from"
            );
        }
    }

    #[test]
    fn a_pi_session_whose_policy_is_unacknowledged_or_absent_is_refused() {
        for p in [None, Some(policy(false))] {
            let mut s = test_session();
            s.agent_runtime = AgentRuntime::Pi;
            s.resource_policy = p;
            let engine = test_engine_with(s);
            let err = gate(&engine, DeliveryMode::Normal).unwrap_err();
            assert_eq!(err.code, ErrorCode::RuntimePolicyRequired);
        }
    }

    /// MED (review): `recovery_busy` was claimed and released by `recovery.rs`
    /// and read nowhere else, so a submit could be admitted and dispatched
    /// under a reconnect that then rebuilt the projection over it.
    #[test]
    fn a_submit_racing_a_reconnect_is_refused_as_busy() {
        let engine = pi_engine();
        engine.with_session_mut("s1", |s| s.recovery_busy = true);
        let err = gate(&engine, DeliveryMode::Normal).unwrap_err();
        assert_eq!(err.code, ErrorCode::SessionBusy);
        assert!(engine
            .with_admissions("s1", |l| l.snapshot_pending())
            .is_empty());
    }

    #[test]
    fn a_submit_racing_a_stop_is_refused_while_admission_is_closed() {
        let engine = pi_engine();
        let _closed = super::super::AdmissionClose::hold(&engine, "s1");
        let err = gate(&engine, DeliveryMode::Normal).unwrap_err();
        assert_eq!(err.code, ErrorCode::SessionBusy);
    }

    /// FR-1's mode/state matrix, still enforced from inside the gate.
    #[test]
    fn the_delivery_mode_matrix_survives_the_gate_extraction() {
        let engine = pi_engine();
        assert_eq!(
            gate(&engine, DeliveryMode::Steer).unwrap_err().code,
            ErrorCode::InvalidInput,
            "steer is only valid while a turn is running"
        );
        engine.with_session_mut("s1", |s| s.status = status::RUNNING.into());
        assert_eq!(
            gate(&engine, DeliveryMode::Normal).unwrap_err().code,
            ErrorCode::SessionBusy
        );
        // Busy + steer now needs the `steering` capability, which this
        // session (no capability snapshot, Pi baseline `false`) lacks.
        assert_eq!(
            gate(&engine, DeliveryMode::Steer).unwrap_err().code,
            ErrorCode::RuntimeUnsupported
        );
    }

    // ---------- FR-9: the draft is persisted BEFORE the wire call ----------

    /// A connection that records the order of everything that happened around
    /// its `submit` — the only way to prove the sidecar write precedes the
    /// dispatch rather than following it.
    struct RecordingConnection {
        log: Arc<Mutex<Vec<&'static str>>>,
    }

    impl adapter::RuntimeSessionControl for RecordingConnection {
        fn submit(
            &self,
            _input: RuntimeSubmission,
        ) -> Result<adapter::SubmissionReceipt, AppError> {
            self.log.lock().unwrap().push("dispatch");
            Ok(adapter::SubmissionReceipt {
                request_id: crate::ids::uuid(),
            })
        }
        fn capabilities(&self) -> crate::session::RuntimeCapabilities {
            Default::default()
        }
        fn cancel(&self) -> Result<(), AppError> {
            Ok(())
        }
        fn shutdown(&self) -> Result<(), AppError> {
            Ok(())
        }
    }

    /// MED (review): the sidecar was written only AFTER the dispatch resolved
    /// — a crash inside the wire call's own deadline lost the draft outright
    /// (FR-9).
    #[test]
    fn the_draft_is_persisted_before_the_dispatch_is_attempted() {
        let engine = pi_engine();
        let log = Arc::new(Mutex::new(Vec::new()));
        engine.runtime_connections.lock().unwrap().insert(
            "s1".into(),
            Arc::new(RecordingConnection { log: log.clone() })
                as Arc<dyn adapter::RuntimeSessionControl>,
        );
        let persisted = log.clone();
        let receipt = admit_and_dispatch(
            &engine,
            "s1",
            "c1",
            "hello",
            DeliveryMode::Normal,
            &[],
            Vec::new(),
            &|| persisted.lock().unwrap().push("persist"),
        )
        .unwrap();
        assert_eq!(receipt.state, AdmissionState::Queued);
        assert_eq!(
            *log.lock().unwrap(),
            vec!["persist", "dispatch", "persist"],
            "the draft must be on disk before the wire call, and updated after it"
        );
    }

    #[test]
    fn a_retried_client_message_id_is_answered_without_a_second_dispatch() {
        let engine = pi_engine();
        let log = Arc::new(Mutex::new(Vec::new()));
        engine.runtime_connections.lock().unwrap().insert(
            "s1".into(),
            Arc::new(RecordingConnection { log: log.clone() })
                as Arc<dyn adapter::RuntimeSessionControl>,
        );
        let dispatch = |engine: &Engine| {
            admit_and_dispatch(
                engine,
                "s1",
                "c1",
                "hello",
                DeliveryMode::Normal,
                &[],
                Vec::new(),
                &|| {},
            )
        };
        dispatch(&engine).unwrap();
        dispatch(&engine).unwrap();
        assert_eq!(
            log.lock()
                .unwrap()
                .iter()
                .filter(|c| **c == "dispatch")
                .count(),
            1,
            "FR-4: retrying an id returns its receipt without sending again"
        );
    }
}
