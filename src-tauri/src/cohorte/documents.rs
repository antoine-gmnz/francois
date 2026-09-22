//! FR-14 / FR-10 / FR-11 — the CLI's `--json` documents, read leniently.
//! `status` accepts three shapes, in order: (a) a `documentVersion: 1`
//! ProjectStatusDocument / RunSnapshotDocument, (b) a dev.8 `RunRecord[]`,
//! (c) a dev.8 `RunRecord`. Every RFC3339 string becomes epoch ms (absent when
//! unparseable, never 0); unknown fields are ignored and unknown enum values
//! kept verbatim; every free-text string is sanitised.

use super::sanitize::{self, iso_ms_value};
use super::{CheckResult, DoctorCheck, ErrorInfo, HealthRow, RunIteration, RunRuntime, Stop};
use serde_json::Value;

/// `ApprovalView` of a status document (no request payload — FR-29).
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ApprovalView {
    pub(crate) approval_id: String,
    pub(crate) since: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Default)]
pub(crate) struct AgentNode {
    pub(crate) agent_id: String,
    pub(crate) role: String,
    pub(crate) surface: Option<String>,
    pub(crate) label: Option<String>,
    pub(crate) status: Option<String>,
    pub(crate) lifecycle: Option<String>,
    pub(crate) attempt: u64,
    pub(crate) incarnation: u64,
    pub(crate) worktree: Option<String>,
    pub(crate) summary: Option<String>,
    pub(crate) last_error: Option<ErrorInfo>,
    pub(crate) pending_approval: Option<String>,
}

/// A PhaseNode, reduced to its LATEST phase run (FR-25: FIX may run several).
#[derive(Clone, Debug, PartialEq, Default)]
pub(crate) struct PhaseNode {
    pub(crate) state: String,
    pub(crate) label: Option<String>,
    pub(crate) status: String,
    pub(crate) iteration: u64,
    pub(crate) started_at: Option<u64>,
    pub(crate) ended_at: Option<u64>,
    pub(crate) outcome: Option<String>,
    pub(crate) agents: Vec<AgentNode>,
    pub(crate) checks: Vec<CheckResult>,
}

/// One run as any status shape reports it.
#[derive(Clone, Debug, PartialEq, Default)]
pub(crate) struct StatusRun {
    pub(crate) run_id: String,
    pub(crate) profile: Option<String>,
    pub(crate) title: Option<String>,
    pub(crate) spec_id: Option<String>,
    pub(crate) spec_kind: Option<String>,
    pub(crate) state: String,
    pub(crate) since: Option<u64>,
    pub(crate) resume_to: Option<String>,
    pub(crate) stop: Option<Stop>,
    pub(crate) last_error: Option<ErrorInfo>,
    pub(crate) iteration: Option<RunIteration>,
    /// snapshot `run.host.alive` (authoritative when present, FR-24).
    pub(crate) host_alive: Option<bool>,
    pub(crate) heartbeat_at: Option<u64>,
    pub(crate) pid: Option<u64>,
    pub(crate) base_branch: Option<String>,
    pub(crate) base_sha: Option<String>,
    pub(crate) integration_branch: Option<String>,
    pub(crate) integration_head: Option<String>,
    pub(crate) snapshot_digest: Option<String>,
    pub(crate) runtime: Option<RunRuntime>,
    pub(crate) cohorte_version: Option<String>,
    pub(crate) unattended: Option<bool>,
    pub(crate) started_at: Option<u64>,
    pub(crate) ended_at: Option<u64>,
    pub(crate) last_sequence: Option<u64>,
    /// `RunSnapshotDocument.phases` (table order, pending included).
    pub(crate) phases: Option<Vec<PhaseNode>>,
    /// `RunSnapshotDocument.approvals.pending` — `None` when the shape has no list.
    pub(crate) pending: Option<Vec<ApprovalView>>,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum StatusDoc {
    /// `pending`: the project-wide pending list (ProjectStatusDocument), if any.
    Project {
        runs: Vec<StatusRun>,
        pending: Option<Vec<ApprovalView>>,
    },
    Run(StatusRun),
}

fn text(v: &Value, max: usize) -> Option<String> {
    v.as_str().map(|s| sanitize::line(s, max))
}
fn id(v: &Value) -> Option<String> {
    text(v, 256)
}
fn short(v: &Value) -> Option<String> {
    text(v, 512)
}

pub(crate) fn error_info(v: &Value) -> Option<ErrorInfo> {
    Some(ErrorInfo {
        code: id(&v["code"])?,
        class: id(&v["class"]),
        message: text(&v["message"], sanitize::MESSAGE_BYTES).unwrap_or_default(),
        remediation: text(&v["remediation"], sanitize::MESSAGE_BYTES),
        retryable: v["retryable"].as_bool(),
    })
}

pub(crate) fn stop(v: &Value) -> Option<Stop> {
    Some(Stop {
        reason: id(&v["reason"])?,
        detail: text(&v["detail"], sanitize::MESSAGE_BYTES).unwrap_or_default(),
        resumable: v["resumable"].as_bool().unwrap_or(false),
        resume_requires: id(&v["resumeRequires"]),
    })
}

fn check(v: &Value) -> Option<CheckResult> {
    Some(CheckResult {
        name: short(&v["name"])?,
        status: id(&v["status"])?,
        argv: v["argv"]
            .as_array()
            .map(|a| a.iter().filter_map(short).collect())
            .unwrap_or_default(),
        exit_code: v["exitCode"].as_i64(),
        duration_ms: v["durationMs"].as_f64().unwrap_or(0.0),
    })
}

fn approval_view(v: &Value) -> Option<ApprovalView> {
    Some(ApprovalView {
        approval_id: id(&v["approvalId"])?,
        since: iso_ms_value(v.get("since")),
    })
}

fn approval_list(v: &Value) -> Option<Vec<ApprovalView>> {
    v.as_array()
        .map(|a| a.iter().filter_map(approval_view).collect())
}

fn agent_node(v: &Value) -> Option<AgentNode> {
    Some(AgentNode {
        agent_id: id(&v["agentId"])?,
        role: short(&v["role"]).unwrap_or_default(),
        surface: id(&v["surface"]),
        label: short(&v["label"]),
        status: id(&v["status"]),
        lifecycle: id(&v["lifecycle"]),
        attempt: v["attempt"].as_u64().unwrap_or(0),
        incarnation: v["incarnation"].as_u64().unwrap_or(0),
        worktree: short(&v["worktree"]),
        summary: text(&v["summary"], sanitize::MESSAGE_BYTES),
        last_error: error_info(&v["lastError"]),
        pending_approval: id(&v["pendingApproval"]),
    })
}

fn phase_node(v: &Value) -> Option<PhaseNode> {
    let state = id(&v["state"])?;
    let latest = v["runs"].as_array().and_then(|runs| {
        runs.iter()
            .max_by_key(|r| r["iteration"].as_u64().unwrap_or(0))
    });
    let empty = Value::Null;
    let run = latest.unwrap_or(&empty);
    Some(PhaseNode {
        state,
        label: short(&v["label"]),
        status: id(&v["status"]).unwrap_or_else(|| "pending".into()),
        iteration: run["iteration"].as_u64().unwrap_or(0),
        started_at: iso_ms_value(run.get("startedAt")),
        ended_at: iso_ms_value(run.get("endedAt")),
        outcome: id(&run["outcome"]),
        agents: run["agents"]
            .as_array()
            .map(|a| a.iter().filter_map(agent_node).collect())
            .unwrap_or_default(),
        checks: run["checks"]
            .as_array()
            .map(|a| a.iter().filter_map(check).collect())
            .unwrap_or_default(),
    })
}

fn runtime_of(plan: &Value) -> Option<RunRuntime> {
    let rt = &plan["runtime"];
    Some(RunRuntime {
        id: id(&rt["id"])?,
        version: id(&rt["version"]).unwrap_or_default(),
        pin_digest: None,
    })
}

/// RunNode (snapshot/summary) or dev.8 RunRecord — the two spell a few
/// fields differently; both are read here.
fn status_run(v: &Value) -> Option<StatusRun> {
    let run_id = id(&v["runId"])?;
    let state = id(&v["state"])?;
    let spec = &v["spec"];
    let git = &v["git"];
    let host = &v["host"];
    let iteration = v["iteration"].as_object().map(|_| RunIteration {
        fix_rounds: v["iteration"]["fixRounds"].as_u64().unwrap_or(0),
        max_fix_rounds: v["iteration"]["maxFixRounds"].as_u64().unwrap_or(0),
        review_rounds: v["iteration"]["reviewRounds"].as_u64().unwrap_or(0),
    });
    Some(StatusRun {
        run_id,
        profile: id(&v["profile"]),
        title: text(&v["title"], 512),
        spec_id: id(&spec["id"]).or_else(|| id(&v["specId"])),
        spec_kind: id(&spec["kind"]),
        state,
        since: iso_ms_value(v.get("since")).or_else(|| iso_ms_value(v.get("updatedAt"))),
        resume_to: id(&v["resumeTo"]),
        stop: stop(&v["stop"]),
        last_error: error_info(&v["lastError"]),
        iteration,
        host_alive: host["alive"].as_bool(),
        heartbeat_at: iso_ms_value(host.get("heartbeatAt"))
            .or_else(|| iso_ms_value(v.get("hostHeartbeatAt"))),
        pid: host["pid"].as_u64().or_else(|| v["hostPid"].as_u64()),
        base_branch: id(&git["base"]["branch"]).or_else(|| id(&v["baseBranch"])),
        base_sha: id(&git["base"]["sha"]).or_else(|| id(&v["baseSha"])),
        integration_branch: id(&git["integrationBranch"]).or_else(|| id(&v["integrationBranch"])),
        integration_head: id(&git["integrationHead"]).or_else(|| id(&v["integrationHead"])),
        snapshot_digest: id(&v["snapshotDigest"]),
        runtime: runtime_of(&v["plan"]),
        cohorte_version: id(&v["cohorteVersion"]),
        unattended: v["plan"]["unattended"].as_bool(),
        started_at: iso_ms_value(v.get("startedAt")),
        ended_at: iso_ms_value(v.get("endedAt")),
        last_sequence: v["lastSequence"].as_u64(),
        phases: None,
        pending: None,
    })
}

/// A RunSnapshotDocument (also embedded in a `snapshot` stream line).
pub(crate) fn snapshot_run(doc: &Value) -> Option<StatusRun> {
    let mut run = status_run(&doc["run"])?;
    run.phases = doc["phases"]
        .as_array()
        .map(|a| a.iter().filter_map(phase_node).collect());
    run.pending = approval_list(&doc["approvals"]["pending"]);
    if run.cohorte_version.is_none() {
        run.cohorte_version = id(&doc["cohorteVersion"]);
    }
    if let Some(seq) = doc["lastSequence"].as_u64() {
        run.last_sequence = Some(seq);
    }
    Some(run)
}

/// FR-14 — `None` = not a document Francois can read (→ COHORTE_OUTPUT_INVALID).
pub(crate) fn parse_status(stdout: &[u8]) -> Option<StatusDoc> {
    let v: Value = serde_json::from_slice(stdout).ok()?;
    match &v {
        Value::Object(o) if o.get("documentVersion").and_then(Value::as_u64) == Some(1) => {
            if v["run"].is_object() {
                snapshot_run(&v).map(StatusDoc::Run)
            } else {
                let runs = v["runs"].as_array()?;
                Some(StatusDoc::Project {
                    runs: runs.iter().filter_map(status_run).collect(),
                    pending: approval_list(&v["pendingApprovals"]),
                })
            }
        }
        Value::Array(items) => Some(StatusDoc::Project {
            runs: items.iter().filter_map(status_run).collect(),
            pending: None,
        }),
        Value::Object(o) if o.contains_key("runId") && o.contains_key("state") => {
            status_run(&v).map(StatusDoc::Run)
        }
        _ => None,
    }
}

// ---------- doctor (FR-10) ----------

pub(crate) struct DoctorDoc {
    pub(crate) ok: bool,
    pub(crate) generated_at: Option<u64>,
    pub(crate) checks: Vec<DoctorCheck>,
}

pub(crate) fn parse_doctor(stdout: &[u8]) -> Option<DoctorDoc> {
    let v: Value = serde_json::from_slice(stdout).ok()?;
    let checks = v["checks"].as_array()?;
    Some(DoctorDoc {
        ok: v["ok"].as_bool().unwrap_or(false),
        generated_at: iso_ms_value(v.get("generatedAt")),
        checks: checks
            .iter()
            .filter_map(|c| {
                Some(DoctorCheck {
                    id: id(&c["id"])?,
                    status: id(&c["status"]).unwrap_or_else(|| "error".into()),
                    summary: text(&c["summary"], sanitize::MESSAGE_BYTES).unwrap_or_default(),
                    detail: text(&c["detail"], sanitize::MESSAGE_BYTES),
                    remediation: text(&c["remediation"], sanitize::MESSAGE_BYTES),
                })
            })
            .collect(),
    })
}

/// `cohorte config validate`'s row: exit 0 → ok; anything else → error with
/// the first line Cohorte printed.
pub(crate) fn validate_row(code: i32, stdout: &[u8], stderr: &str) -> HealthRow {
    let (status, summary) = if code == 0 {
        ("ok", ".cohorte/config.yaml valid".to_string())
    } else {
        let out = String::from_utf8_lossy(stdout);
        let first = out
            .lines()
            .chain(stderr.lines())
            .map(str::trim)
            .find(|l| !l.is_empty())
            .unwrap_or("invalid");
        ("error", sanitize::line(first, sanitize::MESSAGE_BYTES))
    };
    HealthRow {
        command: "cohorte config validate".into(),
        status: status.into(),
        summary,
        remediation: None,
    }
}

/// FR-10 row order: aggregate, config validate, then every check not ok/skipped.
pub(crate) fn doctor_rows(checks: &[DoctorCheck], validate: HealthRow) -> Vec<HealthRow> {
    let count = |s: &str| checks.iter().filter(|c| c.status == s).count();
    let (ok, warn, err) = (count("ok"), count("warning"), count("error"));
    let mut summary = format!("{ok} checks passed · {warn} warnings");
    if err > 0 {
        summary.push_str(&format!(" · {err} errors"));
    }
    let agg = if err > 0 {
        "error"
    } else if warn > 0 {
        "warning"
    } else {
        "ok"
    };
    let mut rows = vec![
        HealthRow {
            command: "cohorte doctor".into(),
            status: agg.into(),
            summary,
            remediation: None,
        },
        validate,
    ];
    rows.extend(
        checks
            .iter()
            .filter(|c| c.status != "ok" && c.status != "skipped")
            .map(|c| HealthRow {
                command: format!("cohorte doctor · {}", c.id),
                status: c.status.clone(),
                summary: c.summary.clone(),
                remediation: c.remediation.clone(),
            }),
    );
    rows
}

// ---------- config get (FR-11, FR-3) ----------

pub(crate) fn parse_config(stdout: &[u8]) -> Option<Value> {
    serde_json::from_slice::<Value>(stdout)
        .ok()
        .filter(Value::is_object)
}

/// `runtime.id` (or a bare `runtime` string).
pub(crate) fn runtime_id(config: &Value) -> Option<String> {
    id(&config["runtime"]["id"]).or_else(|| id(&config["runtime"]))
}

fn rule_label(rule: &Value) -> Option<String> {
    let program = short(&rule["program"])?;
    let next = rule["subcommand"]
        .as_array()
        .and_then(|a| a.first())
        .and_then(short)
        .or_else(|| {
            let p = &rule["positionals"];
            match p["kind"].as_str() {
                Some("exact") | Some("enum") => p["values"].as_array()?.first().and_then(short),
                _ => None,
            }
        });
    Some(match next {
        Some(n) => format!("{program} {n}"),
        None => program,
    })
}

/// FR-11: `ship` unless ship is auto, then one label per dangerous/ask
/// command rule (deduped, order kept), then `network access`.
pub(crate) fn gated_steps(config: &Value) -> Vec<String> {
    let policy = &config["policy"];
    let mut out: Vec<String> = Vec::new();
    let mut push = |s: String| {
        if !out.contains(&s) {
            out.push(s);
        }
    };
    if policy["approvals"]["ship"].as_str() != Some("auto") {
        push("ship".into());
    }
    for list in [&policy["dangerousCommands"], &policy["commands"]["ask"]] {
        for rule in list.as_array().into_iter().flatten() {
            if let Some(l) = rule_label(rule) {
                push(l);
            }
        }
    }
    // The spec names `network.provisioning`; dev.8's config schema spells it
    // `provision.network` — either turns the network gate on.
    if config["network"]["provisioning"].as_bool() == Some(true)
        || config["provision"]["network"].as_bool() == Some(true)
    {
        push("network access".into());
    }
    out
}

pub(crate) fn unattended(config: &Value) -> Option<String> {
    id(&config["policy"]["approvals"]["unattended"])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cohorte::testutil::{fixture_record, fixture_snapshot_doc};
    use serde_json::json;

    #[test]
    fn a_project_status_document_parses() {
        let doc = json!({
            "documentVersion": 1, "protocolVersion": "1.0",
            "project": { "id": "orbit", "root": "/r" },
            "runs": [{ "runId": "run_a", "profile": "feature", "title": "Auth retry",
                "state": "REVIEW", "status": "running", "since": "2026-01-01T00:00:00.000Z",
                "startedAt": "2026-01-01T00:00:00.000Z", "futureField": 1 }],
            "pendingApprovals": [{ "approvalId": "apr_x", "kind": "ship", "what": "w",
                "since": "2026-01-01T00:00:01.000Z", "cli": "cohorte approve apr_x" }]
        });
        let Some(StatusDoc::Project { runs, pending }) = parse_status(doc.to_string().as_bytes())
        else {
            panic!("not a project doc")
        };
        assert_eq!(runs[0].run_id, "run_a");
        assert_eq!(runs[0].started_at, Some(1_767_225_600_000));
        assert_eq!(pending.unwrap()[0].since, Some(1_767_225_601_000));
    }

    #[test]
    fn a_run_record_array_parses() {
        let doc = json!([
            fixture_record("run_a", "BUILD"),
            fixture_record("run_b", "COMPLETED")
        ]);
        let Some(StatusDoc::Project { runs, pending }) = parse_status(doc.to_string().as_bytes())
        else {
            panic!()
        };
        assert_eq!(runs.len(), 2);
        assert!(pending.is_none());
        assert_eq!(runs[0].spec_id.as_deref(), Some("auth-retry"));
        assert_eq!(runs[0].base_branch.as_deref(), Some("main"));
        assert_eq!(runs[0].runtime.as_ref().unwrap().id, "pi");
        assert_eq!(runs[0].started_at, Some(1_767_225_600_000));
    }

    #[test]
    fn a_single_run_record_parses_and_bad_timestamps_are_absent() {
        let mut rec = fixture_record("run_a", "FAILED");
        rec["startedAt"] = json!("not a date");
        let Some(StatusDoc::Run(run)) = parse_status(rec.to_string().as_bytes()) else {
            panic!()
        };
        assert_eq!(run.state, "FAILED");
        assert_eq!(run.started_at, None);
        assert_eq!(run.heartbeat_at, Some(1_767_225_610_000));
    }

    #[test]
    fn a_run_snapshot_document_parses_phases_and_pending() {
        let doc = fixture_snapshot_doc("run_a");
        let Some(StatusDoc::Run(run)) = parse_status(doc.to_string().as_bytes()) else {
            panic!()
        };
        let phases = run.phases.unwrap();
        assert_eq!(phases[0].state, "PREFLIGHT");
        assert_eq!(phases[1].agents[0].agent_id, "agt_implementer_api");
        assert_eq!(run.pending.unwrap()[0].approval_id, "apr_1");
        assert_eq!(run.host_alive, Some(true));
    }

    #[test]
    fn anything_else_is_invalid() {
        assert!(parse_status(b"not json").is_none());
        assert!(parse_status(b"{\"hello\":1}").is_none());
        assert!(parse_status(b"undefined").is_none());
    }

    #[test]
    fn doctor_rows_follow_fr10() {
        let doc = parse_doctor(
            json!({ "documentVersion": 1, "cohorteVersion": "3.0.0", "ok": false,
                "generatedAt": "2026-01-01T00:00:00.000Z",
                "checks": [
                    { "id": "node", "status": "ok", "summary": "node 22" },
                    { "id": "git", "status": "ok", "summary": "git 2.4" },
                    { "id": "sandbox", "status": "warning", "summary": "advisory", "remediation": "install bwrap" },
                    { "id": "auth", "status": "error", "summary": "no login\u{1b}[0m" },
                    { "id": "x", "status": "skipped", "summary": "-" }
                ] })
            .to_string()
            .as_bytes(),
        )
        .unwrap();
        let rows = doctor_rows(&doc.checks, validate_row(0, b"valid\n", ""));
        assert_eq!(rows[0].summary, "2 checks passed · 1 warnings · 1 errors");
        assert_eq!(rows[0].status, "error");
        assert_eq!(rows[1].summary, ".cohorte/config.yaml valid");
        assert_eq!(rows[2].command, "cohorte doctor · sandbox");
        assert_eq!(rows[2].remediation.as_deref(), Some("install bwrap"));
        assert_eq!(rows[3].summary, "no login");
        assert_eq!(rows.len(), 4);
        let bad = validate_row(1, b"invalid\n", "");
        assert_eq!(
            (bad.status.as_str(), bad.summary.as_str()),
            ("error", "invalid")
        );
    }

    #[test]
    fn gated_steps_follow_fr11() {
        let cfg = json!({
            "runtime": { "id": "pi" },
            "policy": {
                "approvals": { "ship": "human", "unattended": "wait" },
                "dangerousCommands": [
                    { "id": "a", "program": "git", "subcommand": ["push"] },
                    { "id": "b", "program": "npm", "positionals": { "kind": "exact", "values": ["publish"] } }
                ],
                "commands": { "ask": [ { "id": "c", "program": "git", "subcommand": ["push"] }, { "id": "d", "program": "rm" } ] }
            },
            "provision": { "network": true }
        });
        assert_eq!(
            gated_steps(&cfg),
            vec!["ship", "git push", "npm publish", "rm", "network access"]
        );
        assert_eq!(unattended(&cfg).as_deref(), Some("wait"));
        assert_eq!(runtime_id(&cfg).as_deref(), Some("pi"));
        let auto = json!({ "policy": { "approvals": { "ship": "auto" } } });
        assert!(gated_steps(&auto).is_empty());
        assert_eq!(
            runtime_id(&json!({ "runtime": "fake" })).as_deref(),
            Some("fake")
        );
        assert!(parse_config(b"[1]").is_none());
    }
}
