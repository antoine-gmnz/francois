use super::*;
use crate::permissions::PermissionRule;

pub(crate) fn resolve_question(
    env: &dyn SessionEnv,
    session_id: &str,
    block_id: &str,
    state: &str,
    answers: Option<&Value>,
) {
    let answers =
        answers.map(|answers| redact_answers(env.engine(), session_id, block_id, answers));
    let answers = answers.as_ref();
    let block = env
        .engine()
        .with_session_mut(session_id, |s| {
            s.buf_question_resolve(block_id, state, answers)
        })
        .flatten();
    if let Some(b) = &block {
        env.append_transcript(session_id, b);
    }
    // workflow-details FR-22/FR-26: every resolution path funnels through here
    // (the answer command, `control_cancel_request`, the turn-end drain and
    // `kill_all`), so dropping the attribution here covers all of them at once.
    remove_workflow_ask(env, session_id, block_id);
    env.emit_session(SessionEvent::QuestionResolved {
        session_id: session_id.into(),
        block_id: block_id.into(),
        state: state.into(),
        answers: answers.cloned(),
    });
}

pub(crate) fn resolve_permission(
    env: &dyn SessionEnv,
    session_id: &str,
    block_id: &str,
    state: &str,
    rule: Option<&PermissionRule>,
) {
    let rule_value = rule.and_then(|r| serde_json::to_value(r).ok());
    let block = env
        .engine()
        .with_session_mut(session_id, |s| {
            s.buf_permission_resolve(block_id, state, rule_value.as_ref())
        })
        .flatten();
    if let Some(b) = &block {
        env.append_transcript(session_id, b);
    }
    remove_workflow_ask(env, session_id, block_id); // FR-22/FR-26, as above
    env.emit_session(SessionEvent::PermissionResolved {
        session_id: session_id.into(),
        block_id: block_id.into(),
        state: state.into(),
        rule: rule.cloned(),
    });
}

pub(crate) fn finalize_text_block(
    env: &dyn SessionEnv,
    session_id: &str,
    block_id: &str,
    text: String,
) {
    let block = env
        .engine()
        .with_session_mut(session_id, |s| s.finish_assistant(block_id, text.clone()))
        .flatten();
    if let Some(block) = block {
        env.append_transcript(session_id, &block);
    }
    env.emit_session(SessionEvent::AssistantDone {
        session_id: session_id.into(),
        block_id: block_id.into(),
        text,
    });
}

fn redact_answers(engine: &Engine, id: &str, block_id: &str, answers: &Value) -> Value {
    let mut redacted = answers.clone();
    let secret_keys = engine
        .with_session(id, |session| {
            session
                .block_buffer
                .iter()
                .find(|block| block.block_id == block_id)
                .and_then(|block| block.card.as_ref())
                .and_then(|card| card.get("questions"))
                .and_then(Value::as_array)
                .map(|questions| {
                    questions
                        .iter()
                        .filter(|q| q.get("isSecret").and_then(Value::as_bool) == Some(true))
                        .filter_map(|q| {
                            q.get("id")
                                .or_else(|| q.get("question"))
                                .and_then(Value::as_str)
                                .map(str::to_owned)
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default()
        })
        .unwrap_or_default();
    if let Some(object) = redacted.as_object_mut() {
        for key in secret_keys {
            if object.contains_key(&key) {
                object.insert(key, Value::String("[redacted]".into()));
            }
        }
    }
    redacted
}
