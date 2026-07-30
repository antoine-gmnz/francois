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
    // Snapshot the turn's shared handles, then RELEASE the sessions lock — the
    // stdin write below can block and must never stall every other command.
    let handles = match engine.with_session(&session_id, |s| {
        s.current
            .as_ref()
            .map(|t| (t.stdin.clone(), t.pending_questions.clone()))
    }) {
        None => return err("SESSION_NOT_FOUND", "no such session"),
        Some(h) => h,
    };
    let Some((stdin, pending)) = handles else {
        // No turn in flight ⇒ nothing can be pending (turn over).
        return err("QUESTION_NOT_PENDING", "that question is no longer pending");
    };
    // Claim the entry — removal is the exactly-once guarantee (FR-13): a concurrent
    // cancel / turn-end that got there first already resolved this question.
    let claimed = {
        let mut p = pending.lock().unwrap();
        p.remove(&block_id)
    };
    let Some(q) = claimed else {
        return err("QUESTION_NOT_PENDING", "that question is no longer pending");
    };
    let answers_value = serde_json::to_value(&answers).unwrap_or_else(|_| serde_json::json!({}));
    let payload = allow_response(&q.request_id, &q.input, &answers_value);
    if !write_control_line(&stdin, &payload) {
        // §5.4: the child died between park and answer — FR-13 cancels the
        // question, and the caller learns it is no longer pending.
        resolve_question(&app, &session_id, &block_id, "cancelled", None);
        return err("QUESTION_NOT_PENDING", "that question is no longer pending");
    }
    resolve_question(
        &app,
        &session_id,
        &block_id,
        "answered",
        Some(&answers_value),
    );
    ok(None)
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
    // Snapshot the turn's shared handles, then RELEASE the sessions lock — the
    // stdin write below can block and must never stall every other command.
    let handles = match engine.with_session(&session_id, |s| {
        s.current
            .as_ref()
            .map(|t| (t.stdin.clone(), t.pending_permissions.clone()))
    }) {
        None => return err("SESSION_NOT_FOUND", "no such session"),
        Some(h) => h,
    };
    let Some((stdin, pending)) = handles else {
        // No turn in flight ⇒ nothing can be pending (§7 #16).
        return err(
            "PERMISSION_NOT_PENDING",
            "that request is no longer pending",
        );
    };

    // FR-7: PEEK (don't claim) to learn the pattern, write the rule, and only
    // then claim. A concurrent decide could write the same rule twice — the merge
    // is idempotent (§7 #1) — but only one of them can claim the entry.
    let mut rule: Option<PermissionRule> = None;
    if remember {
        let pattern = {
            let p = pending.lock().unwrap();
            match p.get(&block_id) {
                Some(q) => q.ask.pattern.clone(),
                None => {
                    return err(
                        "PERMISSION_NOT_PENDING",
                        "that request is no longer pending",
                    )
                }
            }
        };
        // FR-6: local by default. VALIDATED — `tier_path` treats anything ≠
        // "global" as local, so an unvalidated string used to flow on into the
        // emitted PermissionRule's `tier`/`id`, violating the PermissionTier
        // union and minting an id `permissions_list` can never produce (so the
        // editor could never act on that rule).
        let tier = tier.unwrap_or_else(|| "local".into());
        if !crate::permissions::is_valid_tier(&tier) {
            return err("INVALID_INPUT", "unknown tier");
        }
        let path = match crate::permissions::tier_path(&engine, &session_id, &tier) {
            Ok(p) => p,
            Err((code, msg)) => return err(code, msg),
        };
        let effect = if allow { "allow" } else { "deny" };
        match crate::permissions::write_rule(&path, &tier, effect, &pattern) {
            Ok(r) => rule = Some(r),
            Err(msg) => return err("SETTINGS_WRITE_FAILED", msg),
        }
    }

    // FR-8: claim the entry — removal is the exactly-once guarantee (FR-10). A
    // concurrent cancel / turn-end that got there first already resolved this ask.
    let Some(q) = claim_pending(&pending, &block_id) else {
        // Lost the race after the rule was already written (the peek→claim gap).
        // The rule IS on disk and the card is about to render `cancelled`, so say
        // where it went rather than leaving it invisible until the editor is opened.
        if let Some(r) = &rule {
            eprintln!(
                "permission-guardrails: wrote rule {} but the request was cancelled first",
                r.id
            );
        }
        return err(
            "PERMISSION_NOT_PENDING",
            "that request is no longer pending",
        );
    };
    let payload = if allow {
        allow_tool_response(&q.request_id, &q.input) // FR-3: verbatim updatedInput
    } else {
        deny_response(&q.request_id, PERMISSION_DENY_MSG) // FR-12
    };
    if !write_control_line(&stdin, &payload) {
        // FR-9: the child died between park and decision. The rule (if any) was
        // already written, so it rides along on the cancelled resolution — FR-22's
        // "rule written: …" line must still render, or an "always allow" would
        // take effect on disk with no trace anywhere in the transcript.
        resolve_permission(&app, &session_id, &block_id, "cancelled", rule.as_ref());
        return err(
            "PERMISSION_NOT_PENDING",
            "that request is no longer pending",
        );
    }
    let state = if allow { "allowed" } else { "denied" };
    resolve_permission(&app, &session_id, &block_id, state, rule.as_ref());
    ok(None)
}
