//! The JSON spec conversation exposed by Python Cohorte 1.0.0a21.

use super::cli::{self, Runner};
use super::python_rpc;
use crate::diff::GitHost;
use crate::github::gh::{run_argv_bounded, RoutedRun};
use crate::ipc::{AppError, ErrorCode, IpcResult};
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;

const OUTPUT_CAP: usize = 4 * 1024 * 1024;
const PROPOSE_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const SHORT_TIMEOUT: Duration = Duration::from_secs(60);

struct SystemRunner;

impl Runner for SystemRunner {
    fn run(
        &self,
        _program: &str,
        dir: &str,
        args: &[String],
        timeout: Duration,
        cap: usize,
    ) -> RoutedRun {
        run_argv_bounded(
            "cohorte",
            &python_rpc::cli(),
            args,
            &GitHost::Native,
            dir,
            timeout,
            cap,
            true,
        )
    }
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CohorteSpecRequest {
    pub root: String,
    pub feature_id: String,
    pub action: String,
    pub message: Option<String>,
    pub answers: Option<Vec<String>>,
    pub contract: Option<String>,
    pub expect_proposal_revision: Option<u64>,
    pub expect_draft_revision: Option<u64>,
    pub request_id: Option<String>,
    pub spec_hash: Option<String>,
    pub profile_hash: Option<String>,
    pub candidate_index: Option<u64>,
}

fn invalid(message: &str) -> AppError {
    AppError::new(ErrorCode::InvalidInput, message)
}

fn spec_argv(req: &CohorteSpecRequest) -> Result<Vec<String>, AppError> {
    let id = req.feature_id.trim();
    if id.is_empty()
        || id.len() > 80
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        return Err(invalid("Invalid spec feature ID"));
    }
    let mut args = vec!["spec-session".into(), id.into()];
    match req.action.as_str() {
        "show" | "prepare" => {}
        "propose" => {
            if let Some(message) = &req.message {
                if message.trim().is_empty() || message.chars().count() > 4000 {
                    return Err(invalid("Spec feedback must be 1-4000 characters"));
                }
                args.extend(["--message".into(), message.trim().into()]);
            }
        }
        "accept" => {
            let Some(proposal) = req.expect_proposal_revision else {
                return Err(invalid("Expected proposal revision is required"));
            };
            let Some(draft) = req.expect_draft_revision else {
                return Err(invalid("Expected draft revision is required"));
            };
            if proposal == 0 {
                return Err(invalid("Expected proposal revision must be positive"));
            }
            args.extend([
                "--expect-proposal-revision".into(),
                proposal.to_string(),
                "--expect-draft-revision".into(),
                draft.to_string(),
            ]);
            for answer in req.answers.as_deref().unwrap_or_default() {
                if answer.len() > 4000 || !answer.contains('=') {
                    return Err(invalid("Spec answers must be N=answer, at most 4000 bytes"));
                }
                args.extend(["--answer".into(), answer.clone()]);
            }
            if let Some(contract) = &req.contract {
                if contract.trim().is_empty() || contract.len() > 1000 {
                    return Err(invalid("Invalid contract path"));
                }
                args.extend(["--contract".into(), contract.clone()]);
            }
        }
        "freeze" => {
            let Some(request_id) = req.request_id.as_deref() else {
                return Err(invalid("Freeze request ID is required"));
            };
            let Some(spec_hash) = req.spec_hash.as_deref() else {
                return Err(invalid("Spec hash is required"));
            };
            let Some(profile_hash) = req.profile_hash.as_deref() else {
                return Err(invalid("Profile hash is required"));
            };
            if request_id.is_empty()
                || request_id.len() > 100
                || !request_id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
                || ![spec_hash, profile_hash].iter().all(|hash| {
                    hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit())
                })
            {
                return Err(invalid("Invalid freeze approval identifiers"));
            }
            args.extend([
                "--request-id".into(),
                request_id.into(),
                "--spec-hash".into(),
                spec_hash.into(),
                "--profile-hash".into(),
                profile_hash.into(),
            ]);
        }
        "ratify" => {
            let Some(index) = req.candidate_index else {
                return Err(invalid("Standing decision index is required"));
            };
            if !(1..=3).contains(&index) {
                return Err(invalid("Standing decision index must be 1-3"));
            }
            args.extend(["--candidate-index".into(), index.to_string()]);
        }
        _ => return Err(invalid("Unknown spec action")),
    }
    args.insert(2, req.action.clone());
    args.extend(["--repo".into(), req.root.clone()]);
    Ok(args)
}

fn run_spec(runner: &dyn Runner, req: &CohorteSpecRequest) -> Result<Value, AppError> {
    let mut args = vec!["--json".into()];
    args.extend(python_rpc::data_dir_args());
    args.extend(spec_argv(req)?);
    let timeout = if req.action == "propose" {
        PROPOSE_TIMEOUT
    } else {
        SHORT_TIMEOUT
    };
    let out = runner.run("cohorte", &req.root, &args, timeout, OUTPUT_CAP);
    if let Some(error) = cli::read_failure(&args, &out, timeout, OUTPUT_CAP) {
        return Err(error);
    }
    let document: Value =
        serde_json::from_slice(&out.stdout).map_err(|_| cli::output_invalid(&args))?;
    if document["ok"] != true {
        return Err(AppError::with_detail(
            ErrorCode::CohorteRejected,
            document["error"]["message"]
                .as_str()
                .unwrap_or("Cohorte rejected the spec action"),
            json!({"cohorteCode": document["error"]["code"]}),
        ));
    }
    let data = &document["data"];
    let valid = match req.action.as_str() {
        "show" => data["brief_ref"].is_object() && data["profile"].is_object(),
        "propose" => data["proposal"].is_object() && data["proposal_ref"].is_object(),
        "accept" => data["draft"].is_object() && data["draft_ref"].is_object(),
        "prepare" => {
            data["preparation"].is_object()
                && data["draft"].is_object()
                && data["candidate"].is_object()
                && data["profile_snapshot"].is_object()
        }
        "freeze" => data["spec"]["status"] == "frozen" && data["spec_ref"].is_object(),
        "ratify" => data["entry"].is_string(),
        _ => false,
    };
    if !valid {
        return Err(cli::output_invalid(&args));
    }
    Ok(data.clone())
}

#[tauri::command(async)]
pub fn cohorte_action_spec(req: CohorteSpecRequest) -> IpcResult<Value> {
    run_spec(&SystemRunner, &req).into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cohorte::testutil::{out, FakeRunner};

    fn request(action: &str) -> CohorteSpecRequest {
        CohorteSpecRequest {
            root: "/repo".into(),
            feature_id: "safe-export".into(),
            action: action.into(),
            message: None,
            answers: None,
            contract: None,
            expect_proposal_revision: None,
            expect_draft_revision: None,
            request_id: None,
            spec_hash: None,
            profile_hash: None,
            candidate_index: None,
        }
    }

    #[test]
    fn discussion_and_acceptance_have_distinct_flags() {
        let mut proposed = request("propose");
        proposed.message = Some("Could JSON be simpler?".into());
        assert!(spec_argv(&proposed).unwrap().contains(&"--message".into()));
        let mut accepted = request("accept");
        accepted.expect_proposal_revision = Some(2);
        accepted.expect_draft_revision = Some(0);
        accepted.answers = Some(vec!["1=JSON".into()]);
        let args = spec_argv(&accepted).unwrap();
        assert!(args.windows(2).any(|part| part == ["--answer", "1=JSON"]));
        assert!(!args.contains(&"--message".into()));
    }

    #[test]
    fn freeze_requires_exact_hashes_before_spawning() {
        let runner = FakeRunner::default();
        let mut req = request("freeze");
        req.request_id = Some("request-id".into());
        req.spec_hash = Some("bad".into());
        req.profile_hash = Some("a".repeat(64));
        assert!(run_spec(&runner, &req).is_err());
        assert_eq!(runner.count("cohorte"), 0);
    }

    #[test]
    fn show_returns_saved_spec_state() {
        let runner = FakeRunner::default();
        runner.on(
            "cohorte --json spec-session safe-export show",
            out(
                0,
                r#"{"ok":true,"data":{"brief_ref":{},"profile":{},"proposal":null,"draft":null}}"#,
            ),
        );
        let data = run_spec(&runner, &request("show")).unwrap();
        assert!(data["proposal"].is_null());
    }

    #[test]
    fn live_python_spec_bridge_when_fixture_is_configured() {
        let Ok(root) = std::env::var("COHORTE_LIVE_BRIEF_ROOT") else {
            return;
        };
        let mut req = request("show");
        req.root = root;
        req.feature_id = "export-safety".into();
        let data = run_spec(&SystemRunner, &req).unwrap();
        assert!(data["proposal_ref"]["revision"]
            .as_u64()
            .is_some_and(|revision| revision >= 2));
        assert!(data["feedback"]
            .as_array()
            .is_some_and(|messages| !messages.is_empty()));
    }
}
