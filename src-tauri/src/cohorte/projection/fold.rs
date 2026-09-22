//! FR-29 — the wire-member half of the run reducer: how each Cohorte event
//! folds into the projection (anything not handled only produces a log entry).

use super::*;
use crate::cohorte::catalogue::CohorteEvent;
use crate::cohorte::payloads::ApprovalResolved;

impl RunProjection {
    pub(crate) fn apply(&mut self, ev: &CohorteEvent) -> Option<Resolution> {
        let h = ev.header()?;
        let (at, seq) = (h.at, h.sequence);
        let hphase = h.phase.as_ref().map(|p| p.state.clone());
        if h.sub == 0 && seq > self.last_sequence {
            self.last_sequence = seq;
        }
        match ev {
            CohorteEvent::PipelineStarted(w) => {
                let p = &w.payload;
                self.spec_id = Some(p.spec.id.clone());
                self.spec_kind = Some(p.spec.kind.clone());
                self.profile = Some(p.profile.clone());
                self.runtime = Some(RunRuntime {
                    id: p.runtime.id.clone(),
                    version: p.runtime.version.clone(),
                    pin_digest: Some(p.runtime.pin_digest.clone()),
                });
                self.snapshot_digest = Some(p.snapshot_digest.clone());
                self.cohorte_version = Some(p.cohorte_version.clone());
                self.unattended = Some(p.unattended);
                self.git.base_branch = p.base.branch.clone();
                self.git.base_sha = Some(p.base.sha.clone());
                self.git.integration_branch = Some(p.integration_branch.clone());
                self.started_at.get_or_insert(at);
            }
            CohorteEvent::PipelineCompleted(w) => {
                self.ended_at = Some(at);
                self.stop = Some(w.payload.stop.clone());
                self.git.integration_head = Some(w.payload.integration.head_sha.clone());
                self.usage = Some(RunUsage {
                    tokens: w.payload.totals.tokens.clone(),
                    cost: w.payload.totals.cost.clone(),
                });
            }
            CohorteEvent::PipelineFailed(w) => {
                self.state = w.payload.state.clone();
                self.last_error = Some(w.payload.error.clone());
                self.stop = Some(w.payload.stop.clone());
            }
            CohorteEvent::RunStateChanged(w) => {
                self.state = w.payload.to.clone();
                self.since = Some(at);
                self.resume_to = w.payload.resume_to.clone();
                if w.payload.stop.is_some() {
                    self.stop = w.payload.stop.clone();
                }
            }
            CohorteEvent::RunPaused(w) => {
                for id in w.payload.parked_agents.clone() {
                    if let Some(s) = self.step_mut(&id, None) {
                        s.status = "paused".into();
                    }
                }
            }
            CohorteEvent::RunResumed(_) => self.host_event = Some(true),
            CohorteEvent::RunHostAttached(w) => {
                self.host_event = Some(true);
                self.pid = Some(w.payload.pid);
            }
            CohorteEvent::RunHostDetached(_) => self.host_event = Some(false),
            CohorteEvent::RunCancelled(_) => {
                self.ended_at = Some(at);
                for s in self.phases.iter_mut().flat_map(|p| p.steps.iter_mut()) {
                    if matches!(s.status.as_str(), "running" | "pending") {
                        s.status = "cancelled".into();
                    }
                }
            }
            CohorteEvent::PhaseStarted(w) => {
                let st = w.payload.phase.state.clone();
                self.first_phase_started.get_or_insert(st.clone());
                let iteration = w.payload.phase.iteration;
                let ph = self.phase_mut(&st);
                let new_iteration = ph.status != "pending" && iteration > ph.iteration;
                ph.status = "running".into();
                ph.started_at = Some(at);
                ph.ended_at = None;
                ph.duration_ms = None;
                ph.iteration = iteration;
                for a in &w.payload.planned {
                    let exists = ph.steps.iter().any(|s| s.agent_id == a.agent_id);
                    if new_iteration || !exists {
                        ph.steps
                            .push(new_step(&a.agent_id, &a.role, a.surface.as_deref()));
                    }
                }
            }
            CohorteEvent::PhaseCompleted(w) => {
                let ph = self.phase_mut(&w.payload.phase.state);
                ph.status = match w.payload.outcome.as_str() {
                    "passed" => "completed",
                    "failed" => "failed",
                    "needs-human" => "waiting-approval",
                    "skipped" => "skipped",
                    other => other,
                }
                .to_string();
                ph.outcome = Some(w.payload.outcome.clone());
                ph.ended_at = Some(at);
                ph.duration_ms = Some(w.payload.duration_ms);
                ph.checks = w.payload.checks.clone();
                for o in w.payload.outputs.clone() {
                    self.add_artifact(&o);
                }
            }
            CohorteEvent::CheckCompleted(w) => {
                if let Some(st) = hphase.clone().or_else(|| self.current_state()) {
                    self.phase_mut(&st).checks.push(w.payload.clone());
                }
            }
            CohorteEvent::Error(w) => self.last_error = Some(w.payload.error.clone()),
            CohorteEvent::AgentDeclared(w) => {
                self.ensure_step(&w.payload.agent, hphase.as_deref());
            }
            CohorteEvent::AgentSpawned(w) => {
                let wt = w.payload.worktree.clone();
                if let Some(s) = self.ensure_step(&w.payload.agent, hphase.as_deref()) {
                    if let Some(wt) = &wt {
                        s.worktree = Some(StepWorktree {
                            path: wt.path.clone(),
                            branch: Some(wt.branch.clone()),
                        });
                    }
                }
                if let Some(wt) = wt {
                    self.add_worktree(
                        &wt.slot,
                        &wt.path,
                        &wt.branch,
                        Some(&w.payload.agent.agent_id),
                    );
                }
            }
            CohorteEvent::AgentStarted(w) => {
                if let Some(s) = self.ensure_step(&w.payload.agent, hphase.as_deref()) {
                    s.status = "running".into();
                    s.started_at = Some(at);
                }
            }
            CohorteEvent::AgentStateChanged(w) => {
                let pending = self.pending.values().any(|p| {
                    p.request
                        .as_ref()
                        .and_then(|r| r.agent.as_ref())
                        .map(|a| &a.agent_id)
                        == Some(&w.payload.agent.agent_id)
                });
                let to = w.payload.to.clone();
                if let Some(s) = self.ensure_step(&w.payload.agent, hphase.as_deref()) {
                    s.lifecycle = Some(to.clone());
                    let status = match to.as_str() {
                        "running" | "spawning" | "retrying" | "escalated" => Some("running"),
                        "waiting" if pending || s.pending_approval_id.is_some() => {
                            Some("waiting-approval")
                        }
                        "waiting" => Some("running"),
                        "paused" => Some("paused"),
                        "completed" => Some("completed"),
                        "failed" => Some("failed"),
                        "cancelled" => Some("cancelled"),
                        _ => None,
                    };
                    if let Some(st) = status {
                        s.status = st.into();
                    }
                }
            }
            CohorteEvent::AgentCompleted(w) => {
                let p = &w.payload;
                if let Some(s) = self.ensure_step(&p.agent, hphase.as_deref()) {
                    s.status = match p.status.as_str() {
                        "needs-input" => "waiting-approval",
                        other => other,
                    }
                    .to_string();
                    s.ended_at = Some(at);
                    s.duration_ms = s.started_at.map(|st| at.saturating_sub(st) as f64);
                    s.summary = Some(p.summary.clone());
                    s.findings = Some(p.findings);
                }
                for a in p.artifacts.clone() {
                    if a.kind == "report" {
                        self.add_artifact(&a);
                    }
                }
            }
            CohorteEvent::AgentFailed(w) => {
                let retry = w.payload.will_retry;
                if let Some(s) = self.ensure_step(&w.payload.agent, hphase.as_deref()) {
                    s.last_error = Some(w.payload.error.clone());
                    if !retry {
                        s.status = "failed".into();
                    }
                }
            }
            CohorteEvent::ModelResponded(w) => {
                let u = self.usage.get_or_insert(RunUsage {
                    tokens: TokenUsage::default(),
                    cost: None,
                });
                let t = &w.payload.tokens;
                u.tokens.input += t.input;
                u.tokens.output += t.output;
                u.tokens.cache_read += t.cache_read;
                u.tokens.cache_write += t.cache_write;
                u.tokens.total += t.total;
                if let Some(c) = &w.payload.cost {
                    match &mut u.cost {
                        Some(acc) if acc.currency == c.currency => acc.amount += c.amount,
                        Some(_) => {}
                        None => u.cost = Some(c.clone()),
                    }
                }
            }
            CohorteEvent::FileWritten(w) => {
                self.touch(&w.payload.file.path.clone(), &w.payload.file.op.clone());
                if let Some(d) = &w.payload.diff_stat {
                    self.diff_stat.0 += d.added;
                    self.diff_stat.1 += d.removed;
                }
            }
            CohorteEvent::FileChanged(w) => {
                for f in w.payload.files.clone() {
                    self.touch(&f.path, &f.op);
                }
            }
            CohorteEvent::ToolCompleted(w) => {
                for f in w.payload.files_touched.clone() {
                    self.touch(&f.path, &f.op);
                }
            }
            CohorteEvent::ReviewStarted(w) => {
                self.iteration.review_rounds = self
                    .iteration
                    .review_rounds
                    .max(self.reviews.len() as u64 + 1);
                self.reviews.push(Review {
                    round: empty_round(Some(w.payload.phase.phase_run_id.clone()), at),
                    completed: None,
                    seq,
                });
            }
            CohorteEvent::ReviewFinding(w) => {
                if !matches!(w.payload.disposition.as_str(), "refuted" | "duplicate") {
                    let mut f: Finding = w.payload.finding.clone();
                    f.disposition = w.payload.disposition.clone();
                    let r = self.review_mut(at, seq);
                    r.round.findings.push(f);
                    relabel(r);
                }
            }
            CohorteEvent::ReviewCompleted(w) => {
                let p = &w.payload;
                let r = self.review_mut(at, seq);
                r.round.verdict = Some(p.verdict.clone());
                r.round.blocking = p.blocking;
                r.round.counts = p.counts.clone();
                r.round.clean = Some(p.clean);
                r.completed = Some((p.blocking_items.clone(), p.blocking));
                relabel(r);
            }
            CohorteEvent::ReviewApproved(_) => {
                self.review_mut(at, seq).round.verdict = Some("approved".into());
            }
            CohorteEvent::ApprovalRequested(w) => {
                let req = w.payload.clone();
                if let Some(agent) = &req.agent {
                    let id = agent.agent_id.clone();
                    let aid = req.approval_id.clone();
                    if let Some(s) = self.step_mut(&id, hphase.as_deref()) {
                        s.pending_approval_id = Some(aid);
                    }
                }
                let entry = self
                    .pending
                    .entry(req.approval_id.clone())
                    .or_insert(Pending {
                        request: None,
                        requested_at: at,
                    });
                entry.requested_at = entry.requested_at.min(at);
                entry.request = Some(req);
            }
            CohorteEvent::ApprovalResolved(w) => return self.resolve(&w.payload, seq),
            CohorteEvent::GitWorktreeCreated(w) => {
                let p = w.payload.clone();
                self.add_worktree(&p.slot, &p.path, &p.branch, None);
            }
            CohorteEvent::GitWorktreeRemoved(w) => {
                for wt in self.worktrees.iter_mut() {
                    if wt.slot == w.payload.slot || wt.path == w.payload.path {
                        wt.removed = true;
                    }
                }
            }
            CohorteEvent::GitMergeCompleted(w) => {
                if self.git.integration_branch.as_deref() == Some(w.payload.into.as_str()) {
                    self.git.integration_head = Some(w.payload.merge_sha.clone());
                }
            }
            CohorteEvent::Heartbeat(w) => {
                self.host_event = Some(w.payload.host_alive);
                self.heartbeat_at = Some(at);
            }
            _ => {}
        }
        None
    }

    fn resolve(&mut self, p: &ApprovalResolved, seq: u64) -> Option<Resolution> {
        self.last_resolved_seq = self.last_resolved_seq.max(seq);
        self.clear_step_approval(&p.approval_id);
        self.pending.remove(&p.approval_id);
        Some(Resolution {
            approval_id: p.approval_id.clone(),
            decision: p.decision.clone(),
            actor: Some(format!("{}:{}", p.actor.kind, p.actor.id)),
        })
    }

    fn add_worktree(&mut self, slot: &str, path: &str, branch: &str, agent: Option<&str>) {
        if let Some(wt) = self.worktrees.iter_mut().find(|w| w.path == path) {
            if agent.is_some() {
                wt.agent_id = agent.map(str::to_string);
            }
            wt.removed = false;
            return;
        }
        self.worktrees.push(Worktree {
            slot: slot.to_string(),
            path: path.to_string(),
            branch: branch.to_string(),
            agent_id: agent.map(str::to_string),
            removed: false,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::super::RunProjection;
    use crate::cohorte::testutil::{
        approval_envelope, envelope, feature_run_lines, finding_envelope, fold,
    };
    use serde_json::json;

    #[test]
    fn a_feature_run_folds_into_phases_steps_and_worktrees() {
        let p = fold(&feature_run_lines());
        let run = p.to_run(0);
        assert_eq!(run.spec_id, "auth-retry");
        assert_eq!(run.title, "auth-retry");
        let states: Vec<_> = run.phases.iter().map(|p| p.state.as_str()).collect();
        // first phase.started is PREFLIGHT → BRAINSTORM/SPEC dropped
        assert_eq!(
            states,
            vec!["PREFLIGHT", "BUILD", "TEST", "REVIEW", "FIX", "SHIP"]
        );
        let build = &run.phases[1];
        assert_eq!(build.status, "completed");
        assert_eq!(build.label, "Build");
        assert_eq!(build.steps[0].label, "implementer · api");
        assert_eq!(build.steps[0].status, "completed");
        assert_eq!(
            build.steps[0].worktree.as_ref().unwrap().path,
            "/r/../orbit-auth-retry"
        );
        assert_eq!(run.worktrees[0].branch, "cohorte/auth-retry/api");
        assert_eq!(
            run.git.integration_branch.as_deref(),
            Some("cohorte/auth-retry")
        );
        assert_eq!(
            run.runtime.as_ref().unwrap().pin_digest.as_deref(),
            Some("pin123")
        );
        assert_eq!(run.view, "running");
        assert_eq!(run.current_phase.as_deref(), Some("REVIEW"));
        assert!(run
            .artifacts
            .iter()
            .any(|a| a.kind == "diff" && a.meta.as_deref() == Some("+10 −2")));
        assert!(run.artifacts.iter().any(|a| a.kind == "log"));
    }

    #[test]
    fn an_approval_with_its_request_is_the_gate_and_resolution_closes_it() {
        let mut lines = feature_run_lines();
        lines.push(finding_envelope(
            20,
            Some("fnd_1"),
            "major",
            "unbounded retries",
        ));
        lines.push(approval_envelope(21, "apr_1", "review-leftovers", &[]));
        let mut p = fold(&lines);
        let run = p.to_run(0);
        let gate = run.gate.expect("gate");
        assert_eq!(run.view, "gate");
        assert_eq!(gate.findings.len(), 1);
        assert_eq!(gate.phase_index, Some(4));
        let ids: Vec<_> = gate.actions.iter().map(|a| a.id.as_str()).collect();
        assert_eq!(ids, vec!["approve", "fix", "deny"]);
        let res = crate::cohorte::testutil::resolve_envelope(22, "apr_1", "allow-once");
        let ev = crate::cohorte::wire::normalise("/r", &res, 0)
            .unwrap()
            .event;
        let r = p.apply(&ev).unwrap();
        assert_eq!(r.decision, "allow-once");
        assert_eq!(r.actor.as_deref(), Some("human:me"));
        assert!(p.to_run(0).gate.is_none());
    }

    #[test]
    fn a_new_fix_iteration_accumulates_steps() {
        let mut p = RunProjection::new("/r", "run_a");
        let started = |seq, iter| {
            envelope(
                seq,
                0,
                "phase.started",
                json!({
                    "phase": { "phaseRunId": format!("phs_FIX_{iter}"), "state": "FIX", "iteration": iter },
                    "contractId": "c", "contractVersion": 1, "budget": {},
                    "planned": [{ "agentId": "agt_fixer_main", "role": "fixer" }]
                }),
            )
        };
        for l in [started(1, 1), started(2, 2)] {
            p.apply(&crate::cohorte::wire::normalise("/r", &l, 0).unwrap().event);
        }
        let fix = p
            .to_run(0)
            .phases
            .into_iter()
            .find(|p| p.state == "FIX")
            .unwrap();
        assert_eq!(fix.iteration, 2);
        assert_eq!(fix.steps.len(), 2);
    }

    #[test]
    fn cancel_marks_running_steps_and_ends_the_run() {
        let mut lines = feature_run_lines();
        lines.push(envelope(
            30,
            0,
            "run.cancelled",
            json!({ "reason": "r", "cancelledAgents": [], "worktreesKept": false }),
        ));
        let run = fold(&lines).to_run(0);
        assert!(run.ended_at.is_some());
        let review = run.phases.iter().find(|p| p.state == "REVIEW").unwrap();
        assert_eq!(review.steps[0].status, "cancelled");
    }
}
