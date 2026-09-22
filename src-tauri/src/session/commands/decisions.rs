//! park/decide commands over the stdio control channel: answer a question,
//! decide a gated permission ask.

#[cfg(test)]
use crate::ipc::AppError;
use crate::ipc::ErrorCode;
use crate::ipc::{err, IpcResult};
#[cfg(test)]
use crate::permissions::PermissionRule;
use crate::session::*;
use std::collections::HashMap;
use tauri::{AppHandle, State};

/// francois:session:answerQuestion (session-questions FR-11/FR-12, §5.4).
/// Writes the §5.5 allow control_response (verbatim input + answers) to the
/// parked turn's stdin, then resolves the block as answered. Never resolves `ok`
/// unless the response reached the child's stdin.
#[tauri::command(async)]
pub fn session_answer_question(
    app: AppHandle,
    engine: State<'_, Engine>,
    session_id: String,
    block_id: String,
    answers: HashMap<String, String>,
) -> IpcResult<Option<()>> {
    if let Err(e) = engine.ensure_available(&session_id) {
        return e.into();
    }

    if answers.is_empty() {
        return err(ErrorCode::InvalidInput, "answers is empty");
    }
    let answers_value = serde_json::to_value(&answers).unwrap_or_else(|_| serde_json::json!({}));
    application::answer_question(
        &runtime_bridge::EngineState(&engine),
        &runtime_bridge::AppEffects {
            app: app.clone(),
            cwd: String::new(),
        },
        &session_id,
        &block_id,
        &answers_value,
    )
    .map(|_| None)
    .into()
}

/// FR-7's rule-first half, split out of `permissions_decide` (which needs an
/// `AppHandle` and a `State<Engine>`, so it cannot be unit-tested) precisely so
/// the must-be-pending authorization gate is pinned by tests.
///
/// The gate: the pattern comes from the LIVE turn (`TurnControl`'s peek, which
/// claims nothing), never from the session's transcript buffer. A resolved
/// permission card keeps its `ask` — `buf_permission_resolve` only flips
/// `state` — so reading the pattern there would let a decision on an already
/// allowed/denied/cancelled blockId persist an "always" rule to settings.json
/// before the decision itself failed `PERMISSION_NOT_PENDING`. Being pending IS
/// the authorization.
#[cfg(test)]
fn remember_rule(
    engine: &Engine,
    control: &dyn TurnControl,
    session_id: &str,
    block_id: &str,
    tier: Option<String>,
    allow: bool,
) -> Result<PermissionRule, AppError> {
    let Some(pattern) = control.pending_permission_pattern(block_id) else {
        return Err(AppError::new(
            ErrorCode::PermissionNotPending,
            "that request is no longer pending",
        ));
    };
    // FR-6: local by default. VALIDATED — `tier_path` treats anything ≠
    // "global" as local, so an unvalidated string used to flow on into the
    // emitted PermissionRule's `tier`/`id`, violating the PermissionTier union
    // and minting an id `permissions_list` can never produce (so the editor
    // could never act on that rule).
    let tier = tier.unwrap_or_else(|| "local".into());
    if !crate::permissions::is_valid_tier(&tier) {
        return Err(AppError::new(ErrorCode::InvalidInput, "unknown tier"));
    }
    let path = crate::permissions::tier_path(engine, session_id, &tier)?;
    let effect = if allow { "allow" } else { "deny" };
    // core-architecture-wave3 FR-6: `write_rule` already raises
    // SETTINGS_WRITE_FAILED, so the re-code this used to carry is gone.
    crate::permissions::write_rule(&path, &tier, effect, &pattern)
}

/// francois:permissions:decide (permission-guardrails FR-6..FR-9, §5.4).
///
/// Ordering matters and is spec'd (FR-7): an `*Always` decision writes the RULE
/// FIRST, and a write failure claims nothing, decides nothing and writes no
/// control_response — the card stays pending so the user can retry or fall back
/// to a once-decision. Nothing half-applies.
#[tauri::command(async)]
pub fn permissions_decide(
    app: AppHandle,
    engine: State<'_, Engine>,
    session_id: String,
    block_id: String,
    decision: String,
    tier: Option<String>,
) -> IpcResult<Option<()>> {
    if let Err(e) = engine.ensure_available(&session_id) {
        return e.into();
    }

    if let Err((code, msg)) = engine.require_capability(&session_id, "permissions") {
        return err(code, msg);
    }
    let (choice, remember) = if decision == "cancel" {
        (PermissionDecision::Cancel, false)
    } else if let Some((allow, remember)) = crate::permissions::decide_outcome(&decision) {
        (
            if allow {
                PermissionDecision::Allow
            } else {
                PermissionDecision::Deny
            },
            remember,
        )
    } else {
        return err(ErrorCode::InvalidInput, "unknown decision");
    };
    application::decide_permission(
        &runtime_bridge::EngineState(&engine),
        &runtime_bridge::AppEffects {
            app: app.clone(),
            cwd: String::new(),
        },
        &runtime_bridge::Rules(&engine),
        &session_id,
        &block_id,
        choice,
        remember,
        tier.as_deref(),
    )
    .map(|_| None)
    .into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::testutil::{test_engine_with, test_session, FakeTurnControl};
    use std::path::{Path, PathBuf};

    fn tmpdir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("francois-decide-{tag}-{}", uuid()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A session rooted at `cwd`, so the local tier resolves to
    /// `<cwd>/.claude/settings.local.json` — "was a rule written?" is then just
    /// "does that directory exist?", with no global settings file in reach.
    fn engine_at(cwd: &Path) -> Engine {
        let mut s = test_session();
        s.cwd = cwd.to_string_lossy().into_owned();
        test_engine_with(s)
    }

    #[test]
    fn an_always_decision_writes_the_pending_asks_rule() {
        let dir = tmpdir("pending");
        let engine = engine_at(&dir);
        let control = FakeTurnControl::new(0, 1); // one parked approval: p1
        let rule = remember_rule(&engine, control.as_ref(), "s1", "p1", None, true)
            .expect("a pending ask authorizes the write");
        assert_eq!(rule.pattern, FakeTurnControl::pattern_of("p1"));
        assert_eq!(rule.tier, "local"); // FR-6: local by default
        assert_eq!(rule.effect, "allow");
        assert!(dir.join(".claude").join("settings.local.json").exists());
        // The gate PEEKS: the ask is still parked for `decide_permission` to claim.
        assert_eq!(control.pending_counts().permissions, 1);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// REGRESSION (multi-provider-seam review): the pattern was briefly peeked
    /// off the session's transcript buffer, where a RESOLVED permission card
    /// keeps its `ask` forever (`buf_permission_resolve` only flips `state`). A
    /// second `permissions_decide(remember: true)` on an already
    /// allowed/denied/cancelled blockId therefore still found a pattern and
    /// persisted an "always" rule to settings.json, before the decision itself
    /// failed `PERMISSION_NOT_PENDING`. Being pending IS the authorization.
    /// Buffer a permission card the way `handle_control_request` does, then
    /// leave it `pending` or flip it as `resolve_permission` would.
    fn buffer_card(engine: &Engine, block_id: &str, resolved_as: Option<&str>) {
        engine.with_session_mut("s1", |s| {
            let ask = serde_json::to_value(crate::permissions::build_ask(
                "Bash",
                &serde_json::json!({ "command": "npm test" }),
                "/repo",
            ))
            .unwrap();
            s.buf_permission(block_id, ask);
            if let Some(state) = resolved_as {
                s.buf_permission_resolve(block_id, state, None);
            }
        });
    }

    #[test]
    fn a_second_always_decision_on_a_decided_ask_writes_nothing() {
        let dir = tmpdir("decided");
        let engine = engine_at(&dir);
        let control = FakeTurnControl::new(0, 1);
        // The first decision claims the ask and resolves its card — exactly what
        // `permissions_decide` + `resolve_permission` leave behind.
        assert_eq!(
            control.decide_permission("p1", PermissionDecision::Allow),
            ControlAck::Applied
        );
        buffer_card(&engine, "p1", Some("allowed"));
        let code = remember_rule(&engine, control.as_ref(), "s1", "p1", None, true)
            .expect_err("that request is no longer pending")
            .code;
        assert_eq!(code, ErrorCode::PermissionNotPending);
        assert!(
            !dir.join(".claude").exists(),
            "write_rule must never run for an ask that is no longer pending"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The narrower half of the same gate: the LIVE turn is the authority, not
    /// the card's `state`. A `control_cancel_request` claims the ask straight
    /// out of the pending map and the card only flips once `resolve_permission`
    /// lands, so a card still reading `pending` proves nothing — deciding
    /// against it must still write no rule.
    #[test]
    fn a_still_pending_looking_card_with_no_live_ask_authorizes_nothing() {
        let dir = tmpdir("cancelled");
        let engine = engine_at(&dir);
        buffer_card(&engine, "p1", None);
        let control = FakeTurnControl::new(0, 0); // the ask was claimed elsewhere
        let code = remember_rule(&engine, control.as_ref(), "s1", "p1", None, false)
            .expect_err("the transcript buffer is not the authority")
            .code;
        assert_eq!(code, ErrorCode::PermissionNotPending);
        assert!(!dir.join(".claude").exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_unknown_tier_is_rejected_before_anything_is_written() {
        let dir = tmpdir("tier");
        let engine = engine_at(&dir);
        let control = FakeTurnControl::new(0, 1);
        let code = remember_rule(
            &engine,
            control.as_ref(),
            "s1",
            "p1",
            Some("root".into()),
            true,
        )
        .expect_err("unknown tier")
        .code;
        assert_eq!(code, ErrorCode::InvalidInput);
        assert!(!dir.join(".claude").exists());
        assert_eq!(control.pending_counts().permissions, 1);
        std::fs::remove_dir_all(&dir).ok();
    }
}
