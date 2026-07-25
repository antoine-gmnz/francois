//! the stdio control channel: AskUserQuestion parking and permission asks.

use serde::{Deserialize, Serialize};
use serde_json::Value;

// ---------- session questions (specs/session-questions.md) ----------
//
// The stdio control channel: every session turn runs with `--input-format
// stream-json --permission-prompt-tool stdio`, so the CLI emits `control_request`
// lines instead of silently stripping AskUserQuestion from the toolset. Only
// AskUserQuestion parks a turn (FR-6); every other permission ask is denied
// instantly (FR-8) and unknown subtypes get an error response (FR-9), so the CLI
// can never park on something Francois does not render.

/// Mirrors QuestionOption in contract/common.ts. Lenient on missing fields (FR-7).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub(crate) struct QuestionOption {
    #[serde(default)]
    pub(crate) label: String,
    #[serde(default)]
    pub(crate) description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) preview: Option<String>,
}

/// Mirrors SessionQuestion in contract/common.ts. multiSelect defaults to false
/// when absent (FR-7); everything renders verbatim.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub(crate) struct SessionQuestion {
    #[serde(default)]
    pub(crate) question: String,
    #[serde(default)]
    pub(crate) header: String,
    #[serde(default)]
    pub(crate) options: Vec<QuestionOption>,
    #[serde(rename = "multiSelect", default)]
    pub(crate) multi_select: bool,
}

/// permission-guardrails FR-12: what the CLI is told when the user denies a call.
/// (Replaces session-questions' blanket "not supported yet" deny — every gated
/// call now parks on an approval card instead.)
pub(crate) const PERMISSION_DENY_MSG: &str = "Francois: the user denied this tool call.";

/// FR-7: parse the AskUserQuestion input leniently. None ⇔ no non-empty
/// `questions` array (or unparseable entries) → auto-deny, no card.
pub(crate) fn parse_questions(input: &Value) -> Option<Vec<SessionQuestion>> {
    let arr = input.get("questions")?.as_array()?;
    if arr.is_empty() {
        return None;
    }
    arr.iter()
        .map(|q| serde_json::from_value(q.clone()).ok())
        .collect()
}

/// §5.5 allow response: `updatedInput` = verbatim original input + the answers map.
pub(crate) fn allow_response(request_id: &str, input: &Value, answers: &Value) -> Value {
    let mut updated = input.clone();
    if let Some(obj) = updated.as_object_mut() {
        obj.insert("answers".into(), answers.clone());
    }
    serde_json::json!({ "type": "control_response", "response": {
        "subtype": "success", "request_id": request_id,
        "response": { "behavior": "allow", "updatedInput": updated } } })
}

/// §5.5 deny response (FR-7 malformed / FR-8 other tools / FR-13 best-effort).
pub(crate) fn deny_response(request_id: &str, message: &str) -> Value {
    serde_json::json!({ "type": "control_response", "response": {
        "subtype": "success", "request_id": request_id,
        "response": { "behavior": "deny", "message": message } } })
}

/// §5.5 error response for unsupported control_request subtypes (FR-9).
pub(crate) fn error_response(request_id: &str) -> Value {
    serde_json::json!({ "type": "control_response", "response": {
        "subtype": "error", "request_id": request_id, "error": "unsupported control request" } })
}

/// Allow response for a non-question tool (the `allowGit` auto-approve path):
/// echo the original input verbatim as `updatedInput` with behavior "allow".
pub(crate) fn allow_tool_response(request_id: &str, input: &Value) -> Value {
    serde_json::json!({ "type": "control_response", "response": {
        "subtype": "success", "request_id": request_id,
        "response": { "behavior": "allow", "updatedInput": input } } })
}

/// True iff a Bash `can_use_tool` input invokes git/gh directly — the first
/// whitespace token of `input.command` is `git` or `gh`. Compound commands
/// (`cd x && git …`) are intentionally NOT matched: only the leading program
/// counts, so nothing else can ride along on an auto-approval.
pub(crate) fn is_git_command(input: &Value) -> bool {
    input
        .get("command")
        .and_then(|c| c.as_str())
        .map(|cmd| matches!(cmd.split_whitespace().next(), Some("git") | Some("gh")))
        .unwrap_or(false)
}

/// What to do with an inbound `control_request` line. Pure; unit-tested.
pub(crate) enum ControlDecision {
    /// AskUserQuestion with well-formed input: park it (session-questions FR-6).
    Ask {
        request_id: String,
        input: Value,
        questions: Vec<SessionQuestion>,
    },
    /// Any other gated tool call: park an approval card (permission-guardrails
    /// FR-1(d)) — this is what replaced session-questions' blanket deny.
    Permission {
        request_id: String,
        tool_name: String,
        input: Value,
    },
    /// Answer immediately with this control_response payload (FR-7/9 + allowGit).
    Respond(Value),
}

pub(crate) fn decide_control_request(v: &Value, allow_git: bool) -> ControlDecision {
    let request_id = v
        .get("request_id")
        .and_then(|r| r.as_str())
        .unwrap_or("")
        .to_string();
    let req = v.get("request");
    let subtype = req
        .and_then(|r| r.get("subtype"))
        .and_then(|s| s.as_str())
        .unwrap_or("");
    if subtype != "can_use_tool" {
        return ControlDecision::Respond(error_response(&request_id));
    }
    let tool = req
        .and_then(|r| r.get("tool_name"))
        .and_then(|t| t.as_str())
        .unwrap_or("");
    let input = req
        .and_then(|r| r.get("input"))
        .cloned()
        .unwrap_or(Value::Null);
    if tool != "AskUserQuestion" {
        // permission-guardrails FR-1(c): the allowGit fast path is evaluated
        // BEFORE parking, so an allowGit session still auto-approves a direct
        // git/gh Bash call with no card (pre-feature parity, §3 flow 8).
        if allow_git && tool == "Bash" && is_git_command(&input) {
            return ControlDecision::Respond(allow_tool_response(&request_id, &input));
        }
        // FR-1(d): everything else parks an approval card.
        return ControlDecision::Permission {
            request_id,
            tool_name: tool.to_string(),
            input,
        };
    }
    match parse_questions(&input) {
        Some(questions) => ControlDecision::Ask {
            request_id,
            input,
            questions,
        },
        None => ControlDecision::Respond(deny_response(
            &request_id,
            "malformed AskUserQuestion input",
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::testutil::*;
    use serde_json::json;

    #[test]
    fn control_request_ask_user_question_parks_with_verbatim_questions() {
        // FR-6/FR-7: AskUserQuestion parks — request_id + verbatim input kept for
        // the eventual allow response, questions parsed verbatim for the card.
        let ControlDecision::Ask {
            request_id,
            input,
            questions,
        } = decide_control_request(&ask_fixture(), false)
        else {
            panic!("expected Ask");
        };
        assert_eq!(request_id, "req-1");
        assert_eq!(input, ask_fixture()["request"]["input"]); // verbatim (FR-11)
        assert_eq!(questions.len(), 1);
        assert_eq!(questions[0].question, "Which color do you prefer?");
        assert_eq!(questions[0].header, "Color");
        assert!(!questions[0].multi_select);
        assert_eq!(questions[0].options[1].label, "Blue");
        assert_eq!(questions[0].options[1].description, "The color blue");
        assert_eq!(questions[0].options[1].preview, None);
    }

    #[test]
    fn control_request_parsing_is_lenient_on_optional_fields() {
        // FR-7: multiSelect defaults to false when absent; preview passes through.
        let v = json!({ "type": "control_request", "request_id": "r", "request": {
            "subtype": "can_use_tool", "tool_name": "AskUserQuestion",
            "input": { "questions": [{ "question": "Q", "header": "H",
                "options": [{ "label": "A", "description": "d", "preview": "p" }] }] } } });
        let ControlDecision::Ask { questions, .. } = decide_control_request(&v, false) else {
            panic!("expected Ask");
        };
        assert!(!questions[0].multi_select);
        assert_eq!(questions[0].options[0].preview.as_deref(), Some("p"));
    }

    #[test]
    fn control_request_other_tool_parks_a_permission_ask() {
        // permission-guardrails FR-1(d): what session-questions FR-8 used to deny
        // outright now parks an approval card, carrying the request verbatim.
        let v = json!({ "type": "control_request", "request_id": "req-9", "request": {
            "subtype": "can_use_tool", "tool_name": "Bash", "input": { "command": "npm test" } } });
        let ControlDecision::Permission {
            request_id,
            tool_name,
            input,
        } = decide_control_request(&v, false)
        else {
            panic!("expected Permission");
        };
        assert_eq!(request_id, "req-9");
        assert_eq!(tool_name, "Bash");
        assert_eq!(input, json!({ "command": "npm test" })); // FR-3: verbatim
    }

    #[test]
    fn permission_deny_message_is_the_fr12_text() {
        assert_eq!(
            deny_response("r", PERMISSION_DENY_MSG),
            json!({ "type": "control_response", "response": {
                "subtype": "success", "request_id": "r", "response": { "behavior": "deny",
                "message": "Francois: the user denied this tool call." } } })
        );
    }

    #[test]
    fn allow_git_auto_approves_only_direct_git_and_gh_calls() {
        let bash = |cmd: &str| {
            json!({ "type": "control_request", "request_id": "g", "request": {
                "subtype": "can_use_tool", "tool_name": "Bash", "input": { "command": cmd } } })
        };
        // permission-guardrails FR-1(c): allowGit is evaluated BEFORE parking, so
        // it still answers instantly; everything else now parks a card instead of
        // being denied.
        let parks = |v: &Value, allow_git: bool| -> bool {
            matches!(
                decide_control_request(v, allow_git),
                ControlDecision::Permission { .. }
            )
        };

        // allowGit on: a direct git/gh call is allowed with the input echoed verbatim.
        let commit = bash("git commit -m \"x\"");
        let ControlDecision::Respond(payload) = decide_control_request(&commit, true) else {
            panic!("expected Respond");
        };
        assert_eq!(payload["response"]["response"]["behavior"], "allow");
        assert_eq!(
            payload["response"]["response"]["updatedInput"],
            commit["request"]["input"]
        );
        assert!(!parks(&bash("gh pr create"), true));

        // allowGit on but NOT a direct git call → no fast path; the user decides.
        assert!(parks(&bash("rm -rf /"), true));
        assert!(parks(&bash("cd x && git push"), true)); // nothing rides along
        assert!(parks(&bash("github-cli status"), true));

        // allowGit off → even a git call goes to a card.
        assert!(parks(&bash("git commit -m x"), false));
    }

    #[test]
    fn control_request_unknown_subtype_gets_error_response() {
        // FR-9: never let the CLI park on something we don't render.
        let v = json!({ "type": "control_request", "request_id": "req-2",
            "request": { "subtype": "hook_callback" } });
        let ControlDecision::Respond(payload) = decide_control_request(&v, false) else {
            panic!("expected Respond");
        };
        assert_eq!(
            payload,
            json!({ "type": "control_response", "response": {
                "subtype": "error", "request_id": "req-2", "error": "unsupported control request" } })
        );
    }

    #[test]
    fn control_request_malformed_questions_denies() {
        // FR-7: an input with no non-empty questions array is auto-denied, no card.
        for input in [
            json!({}),
            json!({ "questions": [] }),
            json!({ "questions": "x" }),
        ] {
            let v = json!({ "type": "control_request", "request_id": "r", "request": {
                "subtype": "can_use_tool", "tool_name": "AskUserQuestion", "input": input } });
            let ControlDecision::Respond(payload) = decide_control_request(&v, false) else {
                panic!("expected Respond");
            };
            assert_eq!(payload["response"]["response"]["behavior"], "deny");
            assert_eq!(
                payload["response"]["response"]["message"],
                "malformed AskUserQuestion input"
            );
        }
    }

    #[test]
    fn allow_response_merges_verbatim_input_with_answers() {
        // FR-11/FR-12 + §5.5: updatedInput = verbatim original input + answers map.
        let input = ask_fixture()["request"]["input"].clone();
        let answers = json!({ "Which color do you prefer?": "Blue" });
        let payload = allow_response("req-1", &input, &answers);
        let mut expected_input = input.clone();
        expected_input["answers"] = answers.clone();
        assert_eq!(
            payload,
            json!({ "type": "control_response", "response": {
                "subtype": "success", "request_id": "req-1",
                "response": { "behavior": "allow", "updatedInput": expected_input } } })
        );
    }
}
