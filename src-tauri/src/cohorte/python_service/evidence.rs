//! Run evidence comes from the bounded native export, never process guesses.
use super::*;
use crate::cohorte::{
    Artifact, CheckResult, ErrorInfo, Finding, ReviewRound, RunUsage, SeverityCounts, Step,
    StepWorktree, TokenUsage, Worktree,
};
use std::collections::BTreeMap;
fn phase(state: &str, status: &str) -> Phase {
    Phase {
        state: state.to_ascii_uppercase(),
        label: state.into(),
        status: status.into(),
        iteration: 1,
        started_at: None,
        ended_at: None,
        duration_ms: None,
        outcome: None,
        steps: vec![],
        checks: vec![],
    }
}
fn text(value: &Value) -> String {
    super::super::sanitize::line(
        value.as_str().unwrap_or(""),
        super::super::sanitize::MESSAGE_BYTES,
    )
}
pub(super) fn apply(run: &mut CohorteRun, doc: &Value) {
    let mut phases: BTreeMap<String, Phase> = BTreeMap::new();
    let mut context = None;
    let mut usage = TokenUsage::default();
    let mut has_usage = false;
    let mut usage_total = 0u64;
    let events = doc["events"].as_array().cloned().unwrap_or_default();
    for event in &events {
        let ty = event["type"].as_str().unwrap_or("");
        let data = &event["data"];
        let at = millis_or_zero(&event["occurred_at"]);
        run.last_sequence = run.last_sequence.max(event["seq"].as_u64().unwrap_or(0));
        if ty == "run.context" {
            context = Some(data);
        }
        if let Some(name) = ty
            .strip_prefix("phase.")
            .and_then(|ty| ty.strip_suffix(".completed"))
        {
            let p = phases
                .entry(name.into())
                .or_insert_with(|| phase(name, "completed"));
            p.status = "completed".into();
            p.ended_at = Some(at);
            if name == "checks" {
                if let Some(passed) = data["passed"].as_bool() {
                    p.outcome = Some(if passed { "passed" } else { "failed" }.into());
                    p.checks.push(CheckResult {
                        name: "configured checks".into(),
                        status: if passed { "passed" } else { "failed" }.into(),
                        argv: vec![],
                        exit_code: None,
                        duration_ms: 0.,
                    });
                }
            }
            if name == "review" {
                let findings = data["findings"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .enumerate()
                    .map(|(index, f)| finding(f, index))
                    .collect::<Vec<_>>();
                let mut counts = SeverityCounts::default();
                for f in &findings {
                    match f.severity.as_str() {
                        "critical" => counts.critical += 1,
                        "major" => counts.major += 1,
                        "minor" => counts.minor += 1,
                        _ => counts.info += 1,
                    }
                }
                run.review = Some(ReviewRound {
                    phase_run_id: None,
                    started_at: at,
                    verdict: data["verdict"].as_str().map(String::from),
                    blocking: findings.iter().filter(|f| f.blocking).count() as u64,
                    findings,
                    counts,
                    clean: data["ready"].as_bool(),
                });
                run.tail_truncated |= data["findings_truncated"] == true;
            }
        }
        if ty == "agent.turn.started" {
            if let Some(name) = data["phase"].as_str() {
                let p = phases
                    .entry(name.into())
                    .or_insert_with(|| phase(name, "running"));
                if p.ended_at.is_some() {
                    p.iteration += 1;
                    p.ended_at = None;
                    p.started_at = Some(at);
                    p.status = "running".into();
                    p.checks.clear();
                } else {
                    p.started_at.get_or_insert(at);
                }
            }
        }
        if matches!(
            ty,
            "run.failed"
                | "run.blocked"
                | "run.effect_uncertain"
                | "run.waiting_auth"
                | "run.waiting_quota"
        ) {
            let error = data.get("error").unwrap_or(data);
            run.last_error = Some(ErrorInfo {
                code: text(&error["code"]),
                class: None,
                message: text(&error["message"]),
                remediation: error["remediation"]
                    .as_str()
                    .map(super::super::sanitize::summary),
                retryable: error["retryable"].as_bool(),
            });
        }
        if ty == "agent.usage" && (data["input_tokens"].is_u64() || data["output_tokens"].is_u64())
        {
            has_usage = true;
            let cached_extra = if data["provider"] == "codex" {
                0
            } else {
                data["cache_tokens"].as_u64().unwrap_or(0)
            };
            usage_total = usage_total
                .saturating_add(data["input_tokens"].as_u64().unwrap_or(0))
                .saturating_add(data["output_tokens"].as_u64().unwrap_or(0))
                .saturating_add(cached_extra);
            usage.input = usage
                .input
                .saturating_add(data["input_tokens"].as_u64().unwrap_or(0));
            usage.output = usage
                .output
                .saturating_add(data["output_tokens"].as_u64().unwrap_or(0));
            usage.cache_read = usage
                .cache_read
                .saturating_add(data["cache_tokens"].as_u64().unwrap_or(0));
        }
    }
    if has_usage {
        usage.total = usage_total;
        run.usage = Some(RunUsage {
            tokens: usage,
            cost: None,
        });
    }
    if let Some(context) = context {
        if let Some(path) = context["worktree"].as_str() {
            run.worktrees.push(Worktree {
                slot: "execution".into(),
                path: path.into(),
                branch: String::new(),
                agent_id: None,
                removed: false,
            });
        }
        for (key, label) in [
            ("spec_ref", "Frozen spec"),
            ("profile_ref", "Frozen profile"),
        ] {
            if let Some(id) = context[key]["id"].as_str() {
                run.artifacts.push(Artifact {
                    kind: key.into(),
                    label: label.into(),
                    path: None,
                    meta: Some(format!("{id}@{}", context[key]["revision"])),
                });
            }
        }
    }
    let attempts = doc["attempts"].as_array().cloned().unwrap_or_default();
    for task in doc["tasks"].as_array().into_iter().flatten() {
        let native = &task["payload"]["task"];
        let role = native["role"].as_str().unwrap_or("unknown");
        let p = phases
            .entry("build".into())
            .or_insert_with(|| phase("build", "pending"));
        let latest = attempts
            .iter()
            .filter(|a| a["task_id"] == task["id"])
            .max_by_key(|a| a["ordinal"].as_u64().unwrap_or(0));
        let surface = native["surface_ids"]
            .as_array()
            .and_then(|surfaces| surfaces.first())
            .and_then(Value::as_str)
            .map(String::from);
        let state = task["status"].as_str().unwrap_or("unknown");
        p.steps.push(Step {
            agent_id: text(&task["id"]),
            role: role.into(),
            surface,
            label: super::super::sanitize::summary(native["id"].as_str().unwrap_or(role)),
            status: match state {
                "succeeded" | "completed" | "integrated" => "completed",
                "running" => "running",
                "failed" => "failed",
                _ => state,
            }
            .into(),
            lifecycle: Some(state.into()),
            attempt: latest.and_then(|a| a["ordinal"].as_u64()).unwrap_or(0),
            incarnation: latest.and_then(|a| a["generation"].as_u64()).unwrap_or(0),
            started_at: latest
                .map(|a| millis_or_zero(&a["started_at"]))
                .filter(|at| *at > 0),
            ended_at: None,
            duration_ms: None,
            worktree: latest.and_then(|a| {
                a["payload"]["worktree"].as_str().map(|path| StepWorktree {
                    path: path.into(),
                    branch: a["payload"]["branch"].as_str().map(String::from),
                })
            }),
            summary: None,
            findings: None,
            last_error: None,
            pending_approval_id: None,
        });
    }
    for check in doc["checks"].as_array().into_iter().flatten() {
        let payload = &check["payload"];
        let p = phases
            .entry("checks".into())
            .or_insert_with(|| phase("checks", "pending"));
        p.checks.push(CheckResult {
            name: text(&check["name"]),
            status: text(&check["status"]),
            argv: payload["argv"]
                .as_array()
                .map(|args| {
                    args.iter()
                        .filter_map(Value::as_str)
                        .map(String::from)
                        .collect()
                })
                .unwrap_or_default(),
            exit_code: payload["exit_code"].as_i64(),
            duration_ms: payload["duration_ms"].as_f64().unwrap_or(0.),
        });
    }
    let current = run
        .current_phase
        .clone()
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !current.is_empty() {
        let p = phases
            .entry(current.clone())
            .or_insert_with(|| phase(&current, projection::phase_status(run.view.as_str())));
        if matches!(run.view.as_str(), "failed" | "cancelled") {
            p.status = run.view.clone();
        }
    }
    let order = [
        "intake",
        "brainstorm",
        "spec",
        "plan",
        "build",
        "checks",
        "review",
        "fix",
        "ship",
    ];
    let mut ordered: Vec<Phase> = order
        .iter()
        .filter_map(|name| phases.remove(*name))
        .collect();
    ordered.extend(phases.into_values());
    run.phases = ordered;
    run.iteration.fix_rounds = doc["run"]["state"]["fix_cycles"].as_u64().unwrap_or(0);
    run.iteration.review_rounds = events
        .iter()
        .filter(|e| e["type"] == "phase.review.completed")
        .count() as u64;
}
fn finding(raw: &Value, index: usize) -> Finding {
    let native = raw["severity"].as_str().unwrap_or("unknown");
    let severity = match native {
        "high" => "major",
        "medium" | "low" => "minor",
        other => other,
    };
    Finding {
        id: raw["id"]
            .as_str()
            .map(String::from)
            .unwrap_or_else(|| format!("native-{index}")),
        severity: severity.into(),
        kind: raw["kind"].as_str().unwrap_or("review").into(),
        rule: raw["rule"].as_str().unwrap_or("").into(),
        title: super::super::sanitize::summary(
            raw["message"]
                .as_str()
                .or_else(|| raw["title"].as_str())
                .unwrap_or(""),
        ),
        expected: text(&raw["expected"]),
        actual: text(&raw["actual"]),
        file: raw["file"].as_str().map(String::from),
        line: raw["line"].as_u64(),
        end_line: None,
        symbol: None,
        confidence: raw["confidence"].as_f64().unwrap_or(0.),
        suggested_fix: raw["suggested_fix"].as_str().map(String::from),
        scope: "run".into(),
        disposition: "open".into(),
        reviewer_agent_id: None,
        blocking: matches!(native, "critical" | "high"),
        label: native.into(),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_export_projects_phases_checks_review_context_tasks_and_known_usage() {
        let mut run = crate::cohorte::testutil::sample_run();
        run.phases.clear();
        run.worktrees.clear();
        run.artifacts.clear();
        run.current_phase = Some("SHIP".into());
        run.view = "waiting".into();
        run.host.alive = None;
        apply(
            &mut run,
            &json!({"run":{"state":{"fix_cycles":2}},"events":[
            {"type":"run.context","data":{"worktree":"/fixture/worktree","spec_ref":{"id":"spec","revision":1},"profile_ref":{"id":"profile","revision":2}}},
            {"type":"phase.checks.completed","data":{"passed":false}},
            {"type":"phase.review.completed","data":{"ready":false,"verdict":"fix","findings":[{"severity":"high","message":"Real finding"}]}},
            {"type":"agent.usage","data":{"input_tokens":20,"output_tokens":3}}],
            "tasks":[{"id":"task","status":"succeeded","payload":{"task":{"id":"api","role":"implementer","surface_ids":["api"]}}}],"attempts":[{"task_id":"task","ordinal":2,"payload":{"worktree":"/fixture/api","branch":"work"}}]}),
        );
        assert_eq!(run.host.alive, None);
        assert_eq!(run.review.as_ref().unwrap().blocking, 1);
        assert_eq!(
            run.phases
                .iter()
                .find(|p| p.state == "CHECKS")
                .unwrap()
                .checks[0]
                .status,
            "failed"
        );
        assert_eq!(
            run.phases
                .iter()
                .find(|p| p.state == "BUILD")
                .unwrap()
                .steps[0]
                .attempt,
            2
        );
        assert_eq!(run.artifacts.len(), 2);
        assert_eq!(run.worktrees.len(), 1);
        assert_eq!(run.usage.unwrap().tokens.total, 23);
        assert_eq!(run.iteration.fix_rounds, 2);
    }
}
