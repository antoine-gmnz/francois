//! park/decide commands over the stdio control channel: answer a question,
//! decide a gated permission ask.

use crate::ipc::{err, ok, IpcResult};
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
    if answers.is_empty() {
        return err("INVALID_INPUT", "answers is empty");
    }
    // multi-provider-seam FR-8: reached only through `TurnControl` — no
    // Child/ChildStdin/pending map named here. Snapshot the handle, then
    // RELEASE the sessions lock — the control-channel write below can block
    // and must never stall every other command.
    let outer = engine.with_session(&session_id, |s| s.current.clone());
    let Some(outer) = outer else {
        return err("SESSION_NOT_FOUND", "no such session");
    };
    let Some(control) = outer else {
        // No turn in flight ⇒ nothing can be pending (turn over).
        return err("QUESTION_NOT_PENDING", "that question is no longer pending");
    };
    let answers_value = serde_json::to_value(&answers).unwrap_or_else(|_| serde_json::json!({}));
    match control.answer_question(&block_id, &answers_value) {
        ControlAck::NotPending => err("QUESTION_NOT_PENDING", "that question is no longer pending"),
        ControlAck::ChannelClosed => {
            // §5.4: the child died between park and answer — FR-13 cancels the
            // question, and the caller learns it is no longer pending.
            resolve_question(&app, &session_id, &block_id, "cancelled", None);
            refresh_parked_status(&app, &session_id);
            err("QUESTION_NOT_PENDING", "that question is no longer pending")
        }
        ControlAck::Applied => {
            resolve_question(
                &app,
                &session_id,
                &block_id,
                "answered",
                Some(&answers_value),
            );
            // The entry was claimed above, so this recomputes off the remaining
            // asks: back to `running`, or to the OTHER parked state when a
            // second ask is still up.
            refresh_parked_status(&app, &session_id);
            ok(None)
        }
    }
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
fn remember_rule(
    engine: &Engine,
    control: &dyn TurnControl,
    session_id: &str,
    block_id: &str,
    tier: Option<String>,
    allow: bool,
) -> Result<PermissionRule, (&'static str, String)> {
    let Some(pattern) = control.pending_permission_pattern(block_id) else {
        return Err((
            "PERMISSION_NOT_PENDING",
            "that request is no longer pending".into(),
        ));
    };
    // FR-6: local by default. VALIDATED — `tier_path` treats anything ≠
    // "global" as local, so an unvalidated string used to flow on into the
    // emitted PermissionRule's `tier`/`id`, violating the PermissionTier union
    // and minting an id `permissions_list` can never produce (so the editor
    // could never act on that rule).
    let tier = tier.unwrap_or_else(|| "local".into());
    if !crate::permissions::is_valid_tier(&tier) {
        return Err(("INVALID_INPUT", "unknown tier".into()));
    }
    let path = crate::permissions::tier_path(engine, session_id, &tier)?;
    let effect = if allow { "allow" } else { "deny" };
    crate::permissions::write_rule(&path, &tier, effect, &pattern)
        .map_err(|msg| ("SETTINGS_WRITE_FAILED", msg))
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
    let Some((allow, remember)) = crate::permissions::decide_outcome(&decision) else {
        return err("INVALID_INPUT", "unknown decision");
    };
    // multi-provider-seam FR-8: reached only through `TurnControl` — no
    // Child/ChildStdin/pending map named here. Snapshot the handle, then
    // RELEASE the sessions lock — the control-channel write below can block
    // and must never stall every other command.
    let outer = engine.with_session(&session_id, |s| s.current.clone());
    let Some(outer) = outer else {
        return err("SESSION_NOT_FOUND", "no such session");
    };
    let Some(control) = outer else {
        // No turn in flight ⇒ nothing can be pending (§7 #16).
        return err(
            "PERMISSION_NOT_PENDING",
            "that request is no longer pending",
        );
    };

    // FR-7: learn the pattern of the STILL-PENDING ask and write the rule
    // BEFORE deciding. A concurrent decide could write the same rule twice —
    // the merge is idempotent (§7 #1) — but only one of them can claim the
    // entry below.
    let mut rule: Option<PermissionRule> = None;
    if remember {
        match remember_rule(
            &engine,
            control.as_ref(),
            &session_id,
            &block_id,
            tier,
            allow,
        ) {
            Ok(r) => rule = Some(r),
            Err((code, msg)) => return err(code, msg),
        }
    }

    // FR-8: claim the entry — removal is the exactly-once guarantee (FR-10). A
    // concurrent cancel / turn-end that got there first already resolved this ask.
    let decision_arg = if allow {
        PermissionDecision::Allow
    } else {
        PermissionDecision::Deny
    };
    match control.decide_permission(&block_id, decision_arg) {
        ControlAck::NotPending => {
            // Lost the race after the rule was already written (the peek→claim
            // gap). The rule IS on disk and the card is about to render
            // `cancelled`, so say where it went rather than leaving it
            // invisible until the editor is opened.
            if let Some(r) = &rule {
                eprintln!(
                    "permission-guardrails: wrote rule {} but the request was cancelled first",
                    r.id
                );
            }
            err(
                "PERMISSION_NOT_PENDING",
                "that request is no longer pending",
            )
        }
        ControlAck::ChannelClosed => {
            // FR-9: the child died between park and decision. The rule (if any)
            // was already written, so it rides along on the cancelled
            // resolution — FR-22's "rule written: …" line must still render, or
            // an "always allow" would take effect on disk with no trace
            // anywhere in the transcript.
            resolve_permission(&app, &session_id, &block_id, "cancelled", rule.as_ref());
            refresh_parked_status(&app, &session_id);
            err(
                "PERMISSION_NOT_PENDING",
                "that request is no longer pending",
            )
        }
        ControlAck::Applied => {
            let state = if allow { "allowed" } else { "denied" };
            resolve_permission(&app, &session_id, &block_id, state, rule.as_ref());
            // The entry was claimed above, so this recomputes off the remaining
            // asks: back to `running`, or to `awaiting_input` when a question is
            // still parked behind this approval.
            refresh_parked_status(&app, &session_id);
            ok(None)
        }
    }
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
        let (code, _) = remember_rule(&engine, control.as_ref(), "s1", "p1", None, true)
            .expect_err("that request is no longer pending");
        assert_eq!(code, "PERMISSION_NOT_PENDING");
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
        let (code, _) = remember_rule(&engine, control.as_ref(), "s1", "p1", None, false)
            .expect_err("the transcript buffer is not the authority");
        assert_eq!(code, "PERMISSION_NOT_PENDING");
        assert!(!dir.join(".claude").exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_unknown_tier_is_rejected_before_anything_is_written() {
        let dir = tmpdir("tier");
        let engine = engine_at(&dir);
        let control = FakeTurnControl::new(0, 1);
        let (code, _) = remember_rule(
            &engine,
            control.as_ref(),
            "s1",
            "p1",
            Some("root".into()),
            true,
        )
        .expect_err("unknown tier");
        assert_eq!(code, "INVALID_INPUT");
        assert!(!dir.join(".claude").exists());
        assert_eq!(control.pending_counts().permissions, 1);
        std::fs::remove_dir_all(&dir).ok();
    }
}
