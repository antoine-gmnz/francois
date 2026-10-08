//! cohorte-actions §4.1 (FR-1..FR-6) — the intake action: `cohorte --json
//! intake --text|--file|--url --title <title>`, spawned once, no shell. This
//! is a DIFFERENT execution path from `cli.rs`'s `positional-3.0` dialect
//! (approve/deny/pause/…) — the executable resolution and `--data-dir`
//! handling instead mirror `python_rpc::cli()` / `service_endpoint()` (FR-2),
//! since intake talks to the same Python CLI the `cohorte/1` service does.
//!
//! `cli::Runner` (program, dir, args, timeout, cap) -> RoutedRun is reused
//! here verbatim — its signature already fits, and so does its test fake
//! (`testutil::FakeRunner`) — rather than inventing a second injectable
//! runner trait for one more spawn site.

use super::cli::{self, Runner};
use super::python_rpc;
use crate::diff::GitHost;
use crate::github::gh::{run_argv_bounded, RoutedRun};
use crate::ipc::{AppError, ErrorCode, IpcResult};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::Path;
use std::time::{Duration, Instant};

/// FR-10: `COHORTE_TIMEOUT`.
const INTAKE_TIMEOUT: Duration = Duration::from_secs(30);
/// FR-10: `COHORTE_OUTPUT_CAPPED`.
const OUTPUT_CAP: usize = 4 * 1024 * 1024;
const BRAINSTORM_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const TITLE_MAX: usize = 200;
const TEXT_MAX: usize = 24_000;
const URL_MAX: usize = 2_000;
/// FR-3: `--text` values longer than this render as `<text, N lines>`.
const TEXT_DISPLAY_MAX: usize = 60;

// ---------- contract §5 shapes ----------

#[derive(Deserialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CohorteIntakeSource {
    Text { text: String },
    File { path: String },
    Url { url: String },
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CohorteIntakeRequest {
    /// detected project root — the spawn's cwd.
    pub root: String,
    pub title: String,
    pub source: CohorteIntakeSource,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CohorteIntakeResult {
    pub feature_id: String,
    pub title: String,
    pub triage: String,
    pub reasons: Vec<String>,
    pub questions: Vec<String>,
    /// FR-3 display string.
    pub command: String,
    pub duration_ms: u64,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CohorteCommandPreview {
    pub command: String,
}

// ---------- FR-1/FR-2: the one runner ----------

/// Spawns `python_rpc::cli()` through `process_util` (login-shell PATH), no
/// WSL routing — always `GitHost::Native`, `cwd = dir` (FR-2). Reuses
/// `run_argv_bounded` (`cli::SystemRunner`'s own spawn half) for the
/// timeout/cap/kill-tree machinery rather than re-implementing it.
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

// ---------- FR-10: validation ----------

fn invalid(message: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::InvalidInput, message)
}

fn validate(req: &CohorteIntakeRequest) -> Result<(), AppError> {
    let title = req.title.trim();
    if title.is_empty() || title.chars().count() > TITLE_MAX {
        return Err(invalid("Title must be 1-200 characters"));
    }
    match &req.source {
        CohorteIntakeSource::Text { text } => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                return Err(invalid("Text is required"));
            }
            if trimmed.chars().count() > TEXT_MAX {
                return Err(invalid(
                    "Text is too long for the command line — save it to a file and use File",
                ));
            }
        }
        CohorteIntakeSource::File { path } => {
            let candidate = Path::new(path);
            if !candidate.is_absolute() {
                return Err(invalid("File path must be absolute"));
            }
            let meta = std::fs::metadata(candidate).map_err(|_| invalid("File does not exist"))?;
            if !meta.is_file() {
                return Err(invalid("Path is not a regular file"));
            }
        }
        CohorteIntakeSource::Url { url } => {
            if !(url.starts_with("http://") || url.starts_with("https://")) {
                return Err(invalid("URL must start with http:// or https://"));
            }
            if url.len() > URL_MAX {
                return Err(invalid("URL is too long"));
            }
        }
    }
    Ok(())
}

// ---------- FR-10: argv, FR-3: display ----------

/// The `intake` verb's own args, without `--json`/`--data-dir` (FR-3 omits
/// both from the display; FR-2 adds them back for the actual spawn).
pub(crate) fn intake_argv(req: &CohorteIntakeRequest) -> Vec<String> {
    let mut args = vec!["intake".to_string()];
    match &req.source {
        CohorteIntakeSource::Text { text } => {
            args.push("--text".into());
            args.push(text.trim().to_string());
        }
        CohorteIntakeSource::File { path } => {
            args.push("--file".into());
            args.push(path.clone());
        }
        CohorteIntakeSource::Url { url } => {
            args.push("--url".into());
            args.push(url.clone());
        }
    }
    args.push("--title".into());
    args.push(req.title.trim().to_string());
    args
}

fn quote(arg: &str) -> String {
    if arg.is_empty() || arg.chars().any(|c| c.is_whitespace() || c == '"') {
        // Backslashes first, so an escaped quote can't read as a closing one.
        format!("\"{}\"", arg.replace('\\', "\\\\").replace('"', "\\\""))
    } else {
        arg.to_string()
    }
}

/// FR-3: `cohorte` + args joined by spaces; an arg with whitespace or a quote
/// is double-quoted, and a `--text` value over 60 chars is abbreviated to
/// `<text, N lines>`. Backs both `cohorte_action_preview` and the spawned
/// argv's display, so the two cannot drift.
pub(crate) fn display(args: &[String]) -> String {
    let mut rendered: Vec<String> = Vec::with_capacity(args.len());
    let mut i = 0;
    while i < args.len() {
        if args[i] == "--text" && i + 1 < args.len() {
            rendered.push(args[i].clone());
            let text = &args[i + 1];
            rendered.push(if text.chars().count() > TEXT_DISPLAY_MAX {
                format!("<text, {} lines>", text.lines().count().max(1))
            } else {
                quote(text)
            });
            i += 2;
            continue;
        }
        rendered.push(quote(&args[i]));
        i += 1;
    }
    format!("cohorte {}", rendered.join(" "))
}

fn string_array(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

// ---------- FR-10: the spawn ----------

pub(crate) fn run_intake(
    runner: &dyn Runner,
    req: &CohorteIntakeRequest,
) -> Result<CohorteIntakeResult, AppError> {
    validate(req)?;
    let core_args = intake_argv(req);
    let mut full_args = python_rpc::data_dir_args();
    full_args.push("--json".into());
    full_args.extend(core_args.iter().cloned());

    let started = Instant::now();
    let out = runner.run("cohorte", &req.root, &full_args, INTAKE_TIMEOUT, OUTPUT_CAP);
    let duration_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);

    if let Some(error) = cli::read_failure(&full_args, &out, INTAKE_TIMEOUT, OUTPUT_CAP) {
        return Err(error);
    }
    let doc = serde_json::from_slice::<Value>(&out.stdout)
        .ok()
        .filter(Value::is_object);
    let Some(doc) = doc else {
        return Err(if out.code == 0 {
            cli::output_invalid(&full_args)
        } else {
            cli::command_failed(&full_args, &out)
        });
    };
    if doc["ok"] != true {
        let message = doc["error"]["message"]
            .as_str()
            .unwrap_or("Cohorte rejected the request")
            .to_string();
        return Err(AppError::with_detail(
            ErrorCode::CohorteRejected,
            message,
            json!({ "cohorteCode": doc["error"]["code"] }),
        ));
    }
    let data = &doc["data"];
    let feature_id = data["feature_id"]
        .as_str()
        .ok_or_else(|| cli::output_invalid(&full_args))?
        .to_string();
    let report = &data["report"];
    Ok(CohorteIntakeResult {
        feature_id,
        title: report["title"]
            .as_str()
            .unwrap_or_else(|| req.title.trim())
            .to_string(),
        triage: report["triage"].as_str().unwrap_or("").to_string(),
        reasons: string_array(&report["reasons"]),
        questions: string_array(&report["questions"]),
        command: display(&core_args),
        duration_ms,
    })
}

// ---------- FR-6: Tauri commands ----------

#[tauri::command(async)]
pub fn cohorte_action_intake(req: CohorteIntakeRequest) -> IpcResult<CohorteIntakeResult> {
    run_intake(&SystemRunner, &req).into()
}

#[tauri::command(async)]
pub fn cohorte_action_preview(req: CohorteIntakeRequest) -> IpcResult<CohorteCommandPreview> {
    (|| {
        validate(&req)?;
        Ok(CohorteCommandPreview {
            command: display(&intake_argv(&req)),
        })
    })()
    .into()
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CohorteBrainstormRequest {
    pub root: String,
    pub feature_id: String,
    pub idea: Option<String>,
    pub source: Option<String>,
    pub message: Option<String>,
    pub answer: Option<String>,
    pub context: Option<String>,
    pub obsidian_idea: Option<String>,
}

fn brainstorm_argv(req: &CohorteBrainstormRequest) -> Result<Vec<String>, AppError> {
    let id = req.feature_id.trim();
    if id.is_empty()
        || id.len() > 80
        || !id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    {
        return Err(invalid(
            "Brainstorm feature ID must be 1-80 lowercase letters, digits, or hyphens",
        ));
    }
    if req
        .message
        .as_deref()
        .is_some_and(|value| value.trim().is_empty())
        || req
            .answer
            .as_deref()
            .is_some_and(|value| value.trim().is_empty())
    {
        return Err(invalid("A reply cannot be blank"));
    }
    if req.message.is_some() && req.answer.is_some() {
        return Err(invalid("Send either a message or an approved answer"));
    }
    let mut args = vec!["brainstorm".into()];
    match req.source.as_deref() {
        Some("continue") => {
            if req.obsidian_idea.is_some() {
                return Err(invalid("An Obsidian card can only start a new brainstorm"));
            }
            if req.message.is_none() && req.answer.is_none() {
                return Err(invalid(
                    "A continued brainstorm needs a message or an answer",
                ));
            }
            args.extend(["--continue".into(), id.into()]);
        }
        Some("intake") => {
            if req.obsidian_idea.is_some() {
                return Err(invalid("An Obsidian card cannot be combined with intake"));
            }
            args.extend(["--from-intake".into(), id.into()]);
        }
        None => {
            let idea = req.idea.as_deref().unwrap_or("").trim();
            if idea.is_empty() || idea.len() > 4000 {
                return Err(invalid(
                    "A new brainstorm needs an idea of at most 4000 bytes",
                ));
            }
            args.extend([
                "--feature-id".into(),
                id.into(),
                "--idea".into(),
                idea.into(),
            ]);
            if let Some(source_id) = &req.obsidian_idea {
                let valid = source_id.split_once(':').is_some_and(|(digest, line)| {
                    digest.len() == 64
                        && digest.bytes().all(|byte| byte.is_ascii_hexdigit())
                        && line.parse::<usize>().is_ok_and(|number| number > 0)
                });
                if !valid || source_id.len() > 80 {
                    return Err(invalid(
                        "Obsidian idea source is invalid; refresh the idea list",
                    ));
                }
                args.extend(["--obsidian-idea".into(), source_id.clone()]);
            }
        }
        _ => return Err(invalid("Unknown brainstorm source")),
    }
    if let Some(message) = &req.message {
        args.extend(["--message".into(), message.trim().into()]);
    }
    if let Some(answer) = &req.answer {
        args.extend(["--answer".into(), answer.trim().into()]);
    }
    if let Some(context) = &req.context {
        if context.len() > 8192 {
            return Err(invalid("Brainstorm context exceeds 8192 bytes"));
        }
        if !context.trim().is_empty() {
            args.extend(["--context".into(), context.clone()]);
        }
    }
    args.extend(["--repo".into(), req.root.clone(), "--live".into()]);
    Ok(args)
}

fn run_brainstorm(runner: &dyn Runner, req: &CohorteBrainstormRequest) -> Result<Value, AppError> {
    let core_args = brainstorm_argv(req)?;
    let mut args = vec!["--json".into()];
    args.extend(python_rpc::data_dir_args());
    args.extend(core_args);
    let out = runner.run("cohorte", &req.root, &args, BRAINSTORM_TIMEOUT, OUTPUT_CAP);
    if let Some(error) = cli::read_failure(&args, &out, BRAINSTORM_TIMEOUT, OUTPUT_CAP) {
        return Err(error);
    }
    let document: Value =
        serde_json::from_slice(&out.stdout).map_err(|_| cli::output_invalid(&args))?;
    if document["ok"] != true {
        return Err(AppError::with_detail(
            ErrorCode::CohorteRejected,
            document["error"]["message"]
                .as_str()
                .unwrap_or("Cohorte rejected the brainstorm"),
            json!({"cohorteCode":document["error"]["code"]}),
        ));
    }
    validated_brief(&document, &req.feature_id, &args)
}

fn validated_brief(document: &Value, feature_id: &str, args: &[String]) -> Result<Value, AppError> {
    let brief = &document["data"]["brief"];
    if brief["feature_id"] != feature_id
        || !brief["contributions"].is_array()
        || !brief["synthesis"].is_object()
        || !document["data"]["brief_ref"].is_object()
    {
        return Err(cli::output_invalid(args));
    }
    Ok(document["data"].clone())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CohorteBriefRequest {
    pub root: String,
    pub feature_id: String,
}

fn read_brief(runner: &dyn Runner, req: &CohorteBriefRequest) -> Result<Value, AppError> {
    let id = req.feature_id.trim();
    if id.is_empty()
        || id.len() > 80
        || !id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    {
        return Err(invalid("Invalid brainstorm feature ID"));
    }
    let mut args = vec!["--json".into()];
    args.extend(python_rpc::data_dir_args());
    args.extend(["brief".into(), "show".into(), id.into()]);
    let out = runner.run(
        "cohorte",
        &req.root,
        &args,
        Duration::from_secs(30),
        OUTPUT_CAP,
    );
    if let Some(error) = cli::read_failure(&args, &out, Duration::from_secs(30), OUTPUT_CAP) {
        return Err(error);
    }
    let document: Value =
        serde_json::from_slice(&out.stdout).map_err(|_| cli::output_invalid(&args))?;
    if document["ok"] != true {
        return Err(AppError::with_detail(
            ErrorCode::CohorteRejected,
            document["error"]["message"]
                .as_str()
                .unwrap_or("Could not read the brainstorm"),
            json!({"cohorteCode":document["error"]["code"]}),
        ));
    }
    validated_brief(&document, id, &args)
}

#[tauri::command(async)]
pub fn cohorte_action_brainstorm(req: CohorteBrainstormRequest) -> IpcResult<Value> {
    run_brainstorm(&SystemRunner, &req).into()
}

#[derive(Deserialize)]
pub struct CohorteIdeasRequest {
    pub root: String,
}

fn read_ideas(runner: &dyn Runner, req: &CohorteIdeasRequest) -> Result<Value, AppError> {
    let mut args = vec!["--json".into()];
    args.extend(python_rpc::data_dir_args());
    args.extend(["brainstorm-ideas".into(), "--repo".into(), req.root.clone()]);
    let out = runner.run("cohorte", &req.root, &args, INTAKE_TIMEOUT, OUTPUT_CAP);
    if let Some(error) = cli::read_failure(&args, &out, INTAKE_TIMEOUT, OUTPUT_CAP) {
        return Err(error);
    }
    let document: Value =
        serde_json::from_slice(&out.stdout).map_err(|_| cli::output_invalid(&args))?;
    if document["ok"] != true {
        return Err(AppError::with_detail(
            ErrorCode::CohorteRejected,
            document["error"]["message"]
                .as_str()
                .unwrap_or("Could not read Obsidian ideas"),
            json!({"cohorteCode":document["error"]["code"]}),
        ));
    }
    let ideas = document["data"]["ideas"]
        .as_array()
        .ok_or_else(|| cli::output_invalid(&args))?;
    if ideas.iter().any(|idea| {
        !idea["title"].is_string()
            || !idea["source_id"].is_string()
            || !idea["notes"]
                .as_array()
                .is_some_and(|notes| notes.iter().all(Value::is_string))
    }) {
        return Err(cli::output_invalid(&args));
    }
    Ok(Value::Array(ideas.clone()))
}

#[tauri::command(async)]
pub fn cohorte_action_ideas(req: CohorteIdeasRequest) -> IpcResult<Value> {
    read_ideas(&SystemRunner, &req).into()
}

#[tauri::command(async)]
pub fn cohorte_action_brief(req: CohorteBriefRequest) -> IpcResult<Value> {
    read_brief(&SystemRunner, &req).into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cohorte::testutil::{missing, out, FakeRunner};

    #[test]
    fn brainstorm_message_and_decision_use_distinct_cli_flags() {
        let base = CohorteBrainstormRequest {
            root: "/repo".into(),
            feature_id: "safe-export".into(),
            idea: None,
            source: Some("continue".into()),
            message: Some("Why not remote storage?".into()),
            answer: None,
            context: None,
            obsidian_idea: None,
        };
        assert_eq!(
            brainstorm_argv(&base).unwrap(),
            vec![
                "brainstorm",
                "--continue",
                "safe-export",
                "--message",
                "Why not remote storage?",
                "--repo",
                "/repo",
                "--live"
            ]
        );
        let approved = CohorteBrainstormRequest {
            message: None,
            answer: Some("Keep exports local".into()),
            context: None,
            ..base.clone()
        };
        assert_eq!(
            brainstorm_argv(&approved).unwrap()[3..5],
            ["--answer", "Keep exports local"]
        );
        assert!(brainstorm_argv(&CohorteBrainstormRequest {
            message: Some("question".into()),
            ..approved
        })
        .is_err());
    }

    #[test]
    fn brainstorm_bridge_returns_the_saved_native_brief() {
        let runner = FakeRunner::default();
        runner.on("cohorte --json brainstorm --feature-id", out(0, r#"{"ok":true,"data":{"brief":{"feature_id":"safe-export","contributions":[],"synthesis":{"recommendation":"local"}},"brief_ref":{"id":"brief:safe-export","revision":1,"sha256":"abc"}}}"#));
        let request = CohorteBrainstormRequest {
            root: "/repo".into(),
            feature_id: "safe-export".into(),
            idea: Some("Safe export".into()),
            source: None,
            message: None,
            answer: None,
            context: None,
            obsidian_idea: None,
        };
        let result = run_brainstorm(&runner, &request).unwrap();
        assert_eq!(result["brief_ref"]["revision"], 1);
        assert_eq!(runner.count("cohorte --json brainstorm --feature-id"), 1);
    }

    #[test]
    fn obsidian_ideas_are_read_and_notes_reach_the_panel() {
        let runner = FakeRunner::default();
        runner.on(
            "cohorte --json brainstorm-ideas --repo",
            out(0, r##"{"ok":true,"data":{"ideas":[{"title":"Export CSV #export-csv","notes":["Pour les clients"],"feature_id":"export-csv","source_id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:2"}]}}"##),
        );
        let ideas = read_ideas(
            &runner,
            &CohorteIdeasRequest {
                root: "/repo".into(),
            },
        )
        .unwrap();
        assert_eq!(ideas[0]["notes"][0], "Pour les clients");

        let request = CohorteBrainstormRequest {
            root: "/repo".into(),
            feature_id: "export-csv".into(),
            idea: Some("Export CSV #export-csv".into()),
            source: None,
            message: None,
            answer: None,
            context: None,
            obsidian_idea: Some(ideas[0]["source_id"].as_str().unwrap().into()),
        };
        let args = brainstorm_argv(&request).unwrap();
        assert!(args.windows(2).any(|pair| pair[0] == "--obsidian-idea"
            && pair[1] == ideas[0]["source_id"].as_str().unwrap()));
    }

    #[test]
    fn brief_bridge_reloads_the_latest_native_revision() {
        let runner = FakeRunner::default();
        runner.on("cohorte --json brief show safe-export", out(0, r#"{"ok":true,"data":{"brief":{"feature_id":"safe-export","contributions":[],"synthesis":{"recommendation":"local"}},"brief_ref":{"id":"brief:safe-export","revision":2,"sha256":"abc"}}}"#));
        let result = read_brief(
            &runner,
            &CohorteBriefRequest {
                root: "/repo".into(),
                feature_id: "safe-export".into(),
            },
        )
        .unwrap();
        assert_eq!(result["brief_ref"]["revision"], 2);
    }

    #[test]
    fn live_python_brief_bridge_when_fixture_is_configured() {
        let Ok(root) = std::env::var("COHORTE_LIVE_BRIEF_ROOT") else {
            return;
        };
        let result = read_brief(
            &SystemRunner,
            &CohorteBriefRequest {
                root,
                feature_id: "export-safety".into(),
            },
        )
        .unwrap();
        assert_eq!(result["brief"]["feature_id"], "export-safety");
        assert!(result["brief"]["prior_decisions"]
            .as_array()
            .is_some_and(|entries| !entries.is_empty()));
    }

    #[test]
    fn live_python_conversation_bridge_when_fixture_is_configured() {
        let Ok(root) = std::env::var("COHORTE_LIVE_BRIEF_ROOT") else {
            return;
        };
        let result = run_brainstorm(&SystemRunner, &CohorteBrainstormRequest {
            root,
            feature_id: "export-safety".into(),
            idea: None,
            source: Some("continue".into()),
            message: Some("L'équipe UX peut-elle critiquer la recommandation QA et proposer un compromis ?".into()),
            answer: None,
            context: None,
            obsidian_idea: None,
        }).unwrap();
        assert!(result["brief_ref"]["revision"]
            .as_u64()
            .is_some_and(|revision| revision >= 3));
        assert!(result["brief"]["user_messages"]
            .as_array()
            .is_some_and(|entries| !entries.is_empty()));
    }

    fn text_req(root: &str, title: &str, text: &str) -> CohorteIntakeRequest {
        CohorteIntakeRequest {
            root: root.into(),
            title: title.into(),
            source: CohorteIntakeSource::Text { text: text.into() },
        }
    }

    // ---------- argv ----------

    #[test]
    fn intake_argv_builds_the_flag_form_per_source() {
        assert_eq!(
            intake_argv(&text_req("/r", "Webhook retries", "please add retries")),
            vec![
                "intake",
                "--text",
                "please add retries",
                "--title",
                "Webhook retries"
            ]
        );
        assert_eq!(
            intake_argv(&CohorteIntakeRequest {
                root: "/r".into(),
                title: "t".into(),
                source: CohorteIntakeSource::File {
                    path: "/tmp/brief.md".into()
                },
            }),
            vec!["intake", "--file", "/tmp/brief.md", "--title", "t"]
        );
        assert_eq!(
            intake_argv(&CohorteIntakeRequest {
                root: "/r".into(),
                title: "t".into(),
                source: CohorteIntakeSource::Url {
                    url: "https://example.com/issue/1".into()
                },
            }),
            vec![
                "intake",
                "--url",
                "https://example.com/issue/1",
                "--title",
                "t"
            ]
        );
    }

    #[test]
    fn intake_argv_trims_title_and_text() {
        let req = text_req("/r", "  Webhook retries  ", "  words  ");
        assert_eq!(
            intake_argv(&req),
            vec!["intake", "--text", "words", "--title", "Webhook retries"]
        );
    }

    // ---------- display (FR-3) ----------

    #[test]
    fn display_prefixes_cohorte_and_quotes_whitespace() {
        assert_eq!(
            display(&intake_argv(&text_req("/r", "Webhook retries", "brief"))),
            r#"cohorte intake --text brief --title "Webhook retries""#
        );
    }

    #[test]
    fn display_escapes_backslashes_inside_quotes_only() {
        assert_eq!(
            display(&intake_argv(&text_req("/r", r#"say "hi" \o/"#, "brief"))),
            r#"cohorte intake --text brief --title "say \"hi\" \\o/""#
        );
        // An unquoted arg (a plain Windows path) keeps its backslashes as-is.
        assert_eq!(quote(r"C:\x\brief.md"), r"C:\x\brief.md");
    }

    #[test]
    fn display_abbreviates_a_long_text_value() {
        let long = (0..5)
            .map(|_| "one two three four five six seven eight nine ten\n")
            .collect::<String>();
        let args = intake_argv(&text_req("/r", "t", &long));
        assert_eq!(
            display(&args),
            "cohorte intake --text <text, 5 lines> --title t"
        );
    }

    #[test]
    fn display_omits_json_and_data_dir() {
        // FR-3: display is built from `core_args` (never `full_args`), so it
        // never carries `--json`/`--data-dir` even when they are present on
        // the actual spawn.
        let core = intake_argv(&text_req("/r", "t", "brief"));
        let mut full = vec![
            "--data-dir".to_string(),
            "/d".to_string(),
            "--json".to_string(),
        ];
        full.extend(core.iter().cloned());
        assert_eq!(display(&core), "cohorte intake --text brief --title t");
        assert!(!display(&core).contains("--json"));
        assert!(!display(&core).contains("--data-dir"));
        assert_ne!(full.len(), core.len());
    }

    // ---------- validation (FR-10) ----------

    #[test]
    fn title_must_be_one_to_two_hundred_chars() {
        assert_eq!(
            validate(&text_req("/r", "", "brief")).unwrap_err().code,
            ErrorCode::InvalidInput
        );
        assert_eq!(
            validate(&text_req("/r", "   ", "brief")).unwrap_err().code,
            ErrorCode::InvalidInput
        );
        assert_eq!(
            validate(&text_req("/r", &"a".repeat(201), "brief"))
                .unwrap_err()
                .code,
            ErrorCode::InvalidInput
        );
        assert!(validate(&text_req("/r", &"a".repeat(200), "brief")).is_ok());
    }

    #[test]
    fn text_cap_is_the_windows_command_line_limit() {
        assert!(validate(&text_req("/r", "t", &"a".repeat(TEXT_MAX))).is_ok());
        let err = validate(&text_req("/r", "t", &"a".repeat(TEXT_MAX + 1))).unwrap_err();
        assert_eq!(err.code, ErrorCode::InvalidInput);
        assert!(err.message.contains("save it to a file"));
        assert_eq!(
            validate(&text_req("/r", "t", "  ")).unwrap_err().code,
            ErrorCode::InvalidInput
        );
    }

    #[test]
    fn file_source_requires_an_absolute_existing_regular_file() {
        let dir = std::env::temp_dir().join(format!("francois-intake-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("brief.md");
        std::fs::write(&file, "hi").unwrap();

        let req = |path: &str| CohorteIntakeRequest {
            root: "/r".into(),
            title: "t".into(),
            source: CohorteIntakeSource::File { path: path.into() },
        };
        assert_eq!(
            validate(&req("relative/brief.md")).unwrap_err().code,
            ErrorCode::InvalidInput
        );
        assert_eq!(
            validate(&req(&dir.join("missing.md").to_string_lossy()))
                .unwrap_err()
                .code,
            ErrorCode::InvalidInput
        );
        assert_eq!(
            validate(&req(&dir.to_string_lossy())).unwrap_err().code,
            ErrorCode::InvalidInput
        );
        assert!(validate(&req(&file.to_string_lossy())).is_ok());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn url_source_requires_http_scheme_and_a_length_cap() {
        let req = |url: &str| CohorteIntakeRequest {
            root: "/r".into(),
            title: "t".into(),
            source: CohorteIntakeSource::Url { url: url.into() },
        };
        assert_eq!(
            validate(&req("ftp://example.com")).unwrap_err().code,
            ErrorCode::InvalidInput
        );
        assert!(validate(&req("https://example.com/x")).is_ok());
        assert!(validate(&req("http://example.com/x")).is_ok());
        let long = format!("https://example.com/{}", "a".repeat(URL_MAX));
        assert_eq!(
            validate(&req(&long)).unwrap_err().code,
            ErrorCode::InvalidInput
        );
    }

    // ---------- run_intake (spawn, exit-code mapping) ----------

    fn ok_stdout() -> String {
        json!({
            "ok": true,
            "data": {
                "feature_id": "intake-0c3497d0407b",
                "source_ref": {},
                "report_ref": {},
                "report": {
                    "title": "Webhook retries",
                    "triage": "questions",
                    "reasons": ["no retry budget documented"],
                    "questions": ["which endpoints need retries?"]
                }
            }
        })
        .to_string()
    }

    #[test]
    fn a_successful_intake_maps_the_verified_shape_and_displays_the_core_args() {
        let runner = FakeRunner::default();
        runner.on("cohorte", out(0, &ok_stdout()));
        let req = text_req("/r", "Webhook retries", "please add retries");
        let result = run_intake(&runner, &req).unwrap();
        assert_eq!(result.feature_id, "intake-0c3497d0407b");
        assert_eq!(result.title, "Webhook retries");
        assert_eq!(result.triage, "questions");
        assert_eq!(result.reasons, vec!["no retry budget documented"]);
        assert_eq!(
            result.questions,
            vec!["which endpoints need retries?".to_string()]
        );
        assert_eq!(
            result.command,
            r#"cohorte intake --text "please add retries" --title "Webhook retries""#
        );
        let calls = runner.calls();
        assert_eq!(calls.len(), 1);
        assert!(calls[0].contains("--json"), "{calls:?}");
        assert!(!calls[0].contains("--data-dir"), "{calls:?}");
    }

    #[test]
    fn an_ok_false_document_is_a_cohorte_rejected_with_the_upstream_code() {
        let runner = FakeRunner::default();
        runner.on(
            "cohorte",
            out(
                1,
                r#"{"ok": false, "error": {"code": "VALIDATION_ERROR", "message": "not a git checkout"}}"#,
            ),
        );
        let err = run_intake(&runner, &text_req("/r", "t", "brief")).unwrap_err();
        assert_eq!(err.code, ErrorCode::CohorteRejected);
        assert_eq!(err.message, "not a git checkout");
        assert_eq!(err.detail.unwrap()["cohorteCode"], "VALIDATION_ERROR");
    }

    #[test]
    fn unparseable_stdout_on_a_zero_exit_is_output_invalid() {
        let runner = FakeRunner::default();
        runner.on("cohorte", out(0, "not json"));
        let err = run_intake(&runner, &text_req("/r", "t", "brief")).unwrap_err();
        assert_eq!(err.code, ErrorCode::CohorteOutputInvalid);
    }

    #[test]
    fn unparseable_stdout_on_a_nonzero_exit_is_command_failed() {
        let runner = FakeRunner::default();
        runner.on("cohorte", out(2, "not json"));
        let err = run_intake(&runner, &text_req("/r", "t", "brief")).unwrap_err();
        assert_eq!(err.code, ErrorCode::CohorteCommandFailed);
    }

    #[test]
    fn a_missing_cli_is_cohorte_cli_missing() {
        let runner = FakeRunner::default();
        runner.on("cohorte", missing());
        let err = run_intake(&runner, &text_req("/r", "t", "brief")).unwrap_err();
        assert_eq!(err.code, ErrorCode::CohorteCliMissing);
    }

    #[test]
    fn a_validation_failure_never_spawns() {
        let runner = FakeRunner::default();
        let err = run_intake(&runner, &text_req("/r", "", "brief")).unwrap_err();
        assert_eq!(err.code, ErrorCode::InvalidInput);
        assert!(runner.calls().is_empty());
    }

    #[test]
    fn preview_never_spawns_and_matches_the_executed_display() {
        let req = text_req("/r", "Webhook retries", "please add retries");
        let preview = (|| -> Result<CohorteCommandPreview, AppError> {
            validate(&req)?;
            Ok(CohorteCommandPreview {
                command: display(&intake_argv(&req)),
            })
        })()
        .unwrap();
        assert_eq!(
            preview.command,
            r#"cohorte intake --text "please add retries" --title "Webhook retries""#
        );
    }
}
