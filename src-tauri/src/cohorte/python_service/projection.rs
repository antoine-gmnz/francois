//! Native Python run records projected from persisted evidence.
use super::*;
pub(super) fn gate_for(run_id: &str, requests: &[Value]) -> Option<Gate> {
    let pending: Vec<&Value> = requests.iter().filter(|r| inbox::unexpired(r)).collect();
    let request = *pending.first()?;
    let id = request["id"].as_str()?.to_owned();
    let kind = request["kind"].as_str().unwrap_or("question").to_owned();
    let is_question = kind == "question";
    let payload = &request["payload"];
    let reason = payload["reason"]
        .as_str()
        .or_else(|| payload["question"].as_str())
        .or_else(|| payload["prompt"].as_str())
        .unwrap_or(&kind)
        .to_owned();
    let options = payload["options"].as_array().map(|v| {
        v.iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect()
    });
    let approve = GateAction {
        id: "approve".into(),
        stops_run: false,
        cli: vec![],
    };
    let deny = GateAction {
        id: "deny".into(),
        stops_run: kind == "ship",
        cli: vec![],
    };
    Some(Gate {
        run_id: run_id.into(),
        request: ApprovalRequest {
            approval_id: id,
            kind,
            agent: None,
            phase: None,
            tool: None,
            affected_paths: vec![],
            preview: ApprovalPreview {
                kind: "text".into(),
                text: reason.clone(),
                truncated: false,
            },
            options,
            rule_id: "cohorte/1".into(),
            reason,
            asks: vec![],
            allowed_decisions: vec![],
            expires_at: None,
            unattended: "wait".into(),
            cli: "Cohorte local service".into(),
        },
        requested_at: millis(&request["created_at"]),
        phase_index: None,
        phase_count: 0,
        findings: vec![],
        actions: if is_question {
            vec![]
        } else {
            vec![approve, deny]
        },
        more_pending: pending.len().saturating_sub(1) as u64,
    })
}

pub(super) fn run_view(status: &str, has_gate: bool) -> &'static str {
    match status {
        "queued" => "idle",
        "waiting_user" if has_gate => "gate",
        "waiting_user" => "waiting",
        "waiting_auth" => "auth",
        "waiting_quota" => "quota",
        "paused" => "paused",
        "blocked" | "blocked_uncertain" => "blocked",
        "failed" => "failed",
        "completed" => "completed",
        "cancelled" => "cancelled",
        _ => "running",
    }
}

pub(super) fn project_run(
    client: &mut RpcClient,
    root: &str,
    raw: &Value,
    cursor: u64,
) -> Result<CohorteRun, AppError> {
    let run_id = raw["id"].as_str().ok_or_else(|| bad("Run has no id"))?;
    let feature_id = raw["feature_id"]
        .as_str()
        .ok_or_else(|| bad("Run has no feature id"))?;
    let feature = client
        .call("features.get", json!({"feature_id":feature_id}))
        .ok();
    let requests = client.call("requests.list", json!({"run_id":run_id}))?;
    let gate = gate_for(run_id, items(&requests)?);
    let status = raw["status"].as_str().unwrap_or("queued");
    let stage = raw["stage"].as_str().unwrap_or("plan").to_ascii_uppercase();
    let started = millis(&raw["created_at"]);
    let updated = millis(&raw["updated_at"]);
    let terminal = matches!(status, "completed" | "cancelled" | "failed");
    let title = feature
        .as_ref()
        .and_then(|f| f["title"].as_str())
        .unwrap_or(feature_id)
        .to_owned();
    let phase = Phase {
        state: stage.clone(),
        label: stage.to_ascii_lowercase(),
        status: phase_status(status).into(),
        iteration: 1,
        started_at: Some(started),
        ended_at: terminal.then_some(updated),
        duration_ms: None,
        outcome: None,
        steps: vec![],
        checks: vec![],
    };
    let mut run = CohorteRun {
        project_root: root.into(),
        run_id: run_id.into(),
        title,
        spec_id: feature_id.into(),
        spec_kind: feature
            .as_ref()
            .and_then(|f| f["kind"].as_str())
            .map(str::to_owned),
        profile: "feature".into(),
        state: if status == "running" {
            stage.clone()
        } else {
            status.to_ascii_uppercase()
        },
        view: run_view(status, gate.is_some()).into(),
        current_phase: Some(stage),
        resume_to: None,
        since: updated,
        started_at: started,
        ended_at: terminal.then_some(updated),
        stop: None,
        last_error: None,
        iteration: RunIteration::default(),
        host: RunHost {
            alive: None,
            heartbeat_at: None,
            pid: None,
        },
        git: RunGit {
            base_branch: "main".into(),
            base_sha: raw["base_commit"].as_str().map(str::to_owned),
            ..RunGit::default()
        },
        runtime: None,
        snapshot_digest: raw["candidate_tree_hash"].as_str().map(str::to_owned),
        cohorte_version: None,
        unattended: None,
        ship_ready: Some(false),
        phases: vec![phase],
        worktrees: vec![],
        gate,
        review: None,
        artifacts: vec![],
        usage: None,
        last_sequence: cursor,
        tail_truncated: false,
        refreshed_at: now_ms(),
    };
    let export = history::summary(client, raw, items(&requests)?)?;
    evidence::apply(&mut run, &export);
    if export["limited"] == true {
        run.tail_truncated = true;
        run.usage = None;
        if run.last_error.is_none() {
            run.last_error = Some(crate::cohorte::ErrorInfo {
                code: "OUTPUT_INVALID".into(),
                class: None,
                message: "The native export exceeded its frame limit; showing bounded event evidence. Task details and ship approval could not be verified.".into(),
                remediation: Some("Inspect the full run with the configured Cohorte CLI.".into()),
                retryable: Some(false),
            });
        }
    }
    run.ship_ready = Some(ship_authorized(raw, items(&requests)?, &export));
    Ok(run)
}

pub(super) fn get_run(
    client: &mut RpcClient,
    root: &str,
    run_id: &str,
    cursor: u64,
) -> Result<CohorteRun, AppError> {
    let raw = client.call("runs.get", json!({"run_id":run_id}))?;
    let registered = project(client, root)?;
    if raw["project_id"] != registered["id"] {
        return Err(AppError::new(
            ErrorCode::CohorteRejected,
            "This run belongs to another project",
        ));
    }
    project_run(client, root, &raw, cursor)
}

pub(super) fn runs(
    client: &mut RpcClient,
    root: &str,
    cursor: u64,
) -> Result<Vec<CohorteRun>, AppError> {
    let project = project(client, root)?;
    let project_id = project["id"]
        .as_str()
        .ok_or_else(|| bad("Project has no id"))?;
    let list = client.call("runs.list", json!({"project_id":project_id}))?;
    items(&list)?
        .iter()
        .map(|raw| project_run(client, root, raw, cursor))
        .collect()
}

pub(super) fn log_entry(raw: &Value) -> Option<LogEntry> {
    let ty = raw["type"].as_str()?;
    let data = &raw["data"];
    let failed =
        ty.contains("failed") || data["to"]["status"] == "failed" || data["passed"] == false;
    let warning =
        ty.contains("blocked") || ty.contains("waiting_auth") || ty.contains("waiting_quota");
    let summary = if ty == "run.state_changed" {
        format!(
            "{} → {} ({})",
            data["from"]["status"].as_str().unwrap_or("unknown"),
            data["to"]["status"].as_str().unwrap_or("unknown"),
            data["to"]["stage"].as_str().unwrap_or("unknown")
        )
    } else if ty == "phase.checks.completed" {
        format!(
            "Configured checks: {}",
            if data["passed"] == true {
                "passed"
            } else if data["passed"] == false {
                "failed"
            } else {
                "unknown"
            }
        )
    } else {
        ty.replace(['.', '_'], " ")
    };
    Some(LogEntry {
        run_id: raw["run_id"].as_str().unwrap_or("").into(),
        sequence: raw["seq"].as_u64()?,
        sub: 0,
        at: millis_or_zero(&raw["occurred_at"]),
        type_: ty.into(),
        severity: if failed {
            "error"
        } else if warning {
            "warning"
        } else {
            "info"
        }
        .into(),
        summary: super::super::sanitize::summary(&summary),
        agent_id: None,
        phase: None,
    })
}

pub(super) fn phase_status(status: &str) -> &'static str {
    match status {
        "queued" => "pending",
        "failed" => "failed",
        "cancelled" => "cancelled",
        "completed" => "completed",
        "running" => "running",
        _ => "pending",
    }
}

fn ship_authorized(raw: &Value, requests: &[Value], doc: &Value) -> bool {
    if raw["stage"] != "ship" || raw["status"] != "waiting_user" {
        return false;
    }
    let Some(hash) = raw["candidate_tree_hash"]
        .as_str()
        .filter(|s| !s.is_empty())
    else {
        return false;
    };
    let Some(request) = requests
        .iter()
        .filter(|r| r["kind"] == "ship")
        .max_by_key(|r| r["created_at"].as_str().unwrap_or(""))
    else {
        return false;
    };
    request["status"] == "answered"
        && request["subject_hash"] == hash
        && doc["approvals"].as_array().is_some_and(|approvals| {
            approvals.iter().any(|a| {
                a["request_id"] == request["id"]
                    && a["subject_hash"] == hash
                    && a["answer"]["approved"] == true
            })
        })
}

#[cfg(test)]
mod authorization_tests {
    use super::*;
    #[test]
    fn ship_requires_current_candidate_approval_not_clean_review() {
        let raw = json!({"id":"r","stage":"ship","status":"waiting_user","candidate_tree_hash":"current"});
        let pending = json!({"id":"gate","kind":"ship","status":"pending","subject_hash":"current","created_at":"2026-01-01"});
        let mut doc = json!({"approvals":[]});
        assert!(!ship_authorized(&raw, std::slice::from_ref(&pending), &doc));
        let mut request = pending;
        request["status"] = json!("answered");
        doc["approvals"] =
            json!([{"request_id":"gate","subject_hash":"current","answer":{"approved":false}}]);
        assert!(!ship_authorized(&raw, std::slice::from_ref(&request), &doc));
        doc["approvals"][0]["answer"]["approved"] = json!(true);
        assert!(ship_authorized(&raw, std::slice::from_ref(&request), &doc));
        request["subject_hash"] = json!("older");
        assert!(!ship_authorized(&raw, &[request], &doc));
        assert!(!ship_authorized(&raw, &[], &doc));
    }
}
