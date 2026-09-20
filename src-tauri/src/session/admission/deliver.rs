//! session/admission/deliver.rs — pi-turn-controls §5/§6: `admit_and_deliver`
//! (the ONE internal admission entry point) and `publish_queue_changed`.
//! Split out of the former single-file `admission.rs` purely for
//! CLAUDE.md's ~1000-line file cap; no behaviour changed by the split.

use tauri::AppHandle;

use super::super::adapter::{self, RuntimeSubmission};
use super::super::events::RuntimeEventPayload;
use super::super::{status, Attachment, Engine, Session};
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

/// pi-skills-capabilities FR-5: pure half of the POLICY GATE below — `true`
/// for every non-Pi session (no policy on record at all) and for a Pi
/// session whose policy has already been acknowledged; `false` only while a
/// Pi session's `acknowledgedUnrestrictedTools` is still `false`.
fn resource_policy_ok(policy: Option<adapter::pi::RuntimeResourcePolicy>) -> bool {
    policy.is_none_or(|p| p.acknowledged_unrestricted_tools)
}

/// pi-turn-controls §5/§6: the ONE internal admission entry point
/// `session_submit` calls — and that a later wave's `skills_run` will also
/// call, BEFORE its own turn dispatch. Revalidates session/capability/state
/// itself; never trusts a caller's own narrowing (FR-1).
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
    // POLICY GATE (pi-skills-capabilities FR-5): refuse the first submit
    // while a Pi session's launch-policy acknowledgment is still false. A
    // session with no policy at all — every non-Pi session, since
    // `session_create` requires one only for a Pi account — is never gated
    // here; the very next check below answers SESSION_NOT_FOUND properly
    // for an unknown id, so treating "no policy on record" as "nothing to
    // acknowledge" costs nothing.
    let policy = engine
        .with_session(session_id, |s| s.resource_policy)
        .flatten();
    if !resource_policy_ok(policy) {
        return Err(AppError::new(
            ErrorCode::RuntimePolicyRequired,
            "acknowledge that Pi tools run with your user permissions before sending",
        ));
    }

    let Some((busy, agent_runtime, effective_caps, attachments)) =
        engine.with_session(session_id, |s| {
            (
                status::is_busy(&s.status),
                s.agent_runtime,
                s.effective_capabilities.clone(),
                resolve_attachments(s, &attachment_ids),
            )
        })
    else {
        return Err(AppError::new(ErrorCode::SessionNotFound, "no such session"));
    };
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

    // Edge cases §7 / FR-6: "Reject while stopping."
    if engine.with_admissions(session_id, |l| l.is_closed()) {
        return Err(AppError::new(
            ErrorCode::SessionBusy,
            "the session is stopping",
        ));
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

    let (receipt, is_new) = engine
        .with_admissions(session_id, |l| {
            l.admit(
                client_message_id,
                text,
                delivery,
                &attachment_ids,
                crate::ids::now_ms(),
            )
        })
        .map_err(AdmitError::into_app_error)?;

    if !is_new {
        return Ok(receipt);
    }
    publish_queue_changed(app, engine, accounts, session_id);

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
    publish_queue_changed(app, engine, accounts, session_id);
    write_admission_sidecar(app, engine, session_id);

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

    #[test]
    fn a_non_pi_session_with_no_policy_is_never_gated() {
        assert!(resource_policy_ok(None));
    }

    #[test]
    fn an_unacknowledged_pi_policy_fails_the_gate() {
        assert!(!resource_policy_ok(Some(policy(false))));
    }

    #[test]
    fn an_acknowledged_pi_policy_passes_the_gate() {
        assert!(resource_policy_ok(Some(policy(true))));
    }
}
