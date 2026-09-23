//! FR-24/25/29 — the run reducer. A `RunProjection` folds status documents
//! and wire members into Francois' reading of one run, and renders it as the
//! contract's `CohorteRun` (view, current phase, phases in table order, gate,
//! latest review, artifacts, usage).

use super::documents::{AgentNode, StatusRun};
use super::gate;
use super::sanitize::short_id;
use super::{
    AgentRef, ApprovalRequest, Artifact, ArtifactRef, CohorteRun, ErrorInfo, Finding, Phase,
    ReviewRound, RunGit, RunHost, RunIteration, RunRuntime, RunUsage, SeverityCounts, Step,
    StepWorktree, Stop, TokenUsage, Worktree,
};
use std::collections::{BTreeMap, BTreeSet};

mod fold;

pub(crate) const ACTIVE_STATES: &[&str] = &[
    "BRAINSTORM",
    "SPEC",
    "PREFLIGHT",
    "BUILD",
    "TEST",
    "REVIEW",
    "FIX",
    "SHIP",
];
const SUSPENDED_OR_HALTED: &[&str] = &[
    "PAUSED",
    "WAITING_APPROVAL",
    "AUTH_REQUIRED",
    "QUOTA_EXCEEDED",
    "FAILED",
    "BLOCKED",
];
/// FR-24: 3 × Cohorte's 15 s heartbeat.
const HEARTBEAT_FRESH_MS: u64 = 45_000;

pub(crate) fn is_terminal(state: &str) -> bool {
    matches!(state, "COMPLETED" | "CANCELLED")
}

/// R-1: a run in one of these states never carries a gate.
pub(crate) fn closes_gates(state: &str) -> bool {
    matches!(state, "COMPLETED" | "CANCELLED" | "FAILED")
}

fn is_active(state: &str) -> bool {
    ACTIVE_STATES.contains(&state)
}

fn title_case(state: &str) -> String {
    let lower = state.to_lowercase();
    let mut c = lower.chars();
    match c.next() {
        Some(f) => f.to_uppercase().chain(c).collect(),
        None => String::new(),
    }
}

fn step_label(role: &str, surface: Option<&str>) -> String {
    match surface {
        Some(s) => format!("{role} · {s}"),
        None => role.to_string(),
    }
}

fn new_phase(state: &str) -> Phase {
    Phase {
        state: state.to_string(),
        label: title_case(state),
        status: "pending".into(),
        iteration: 0,
        started_at: None,
        ended_at: None,
        duration_ms: None,
        outcome: None,
        steps: Vec::new(),
        checks: Vec::new(),
    }
}

fn new_step(agent_id: &str, role: &str, surface: Option<&str>) -> Step {
    Step {
        agent_id: agent_id.to_string(),
        role: role.to_string(),
        surface: surface.map(str::to_string),
        label: step_label(role, surface),
        status: "pending".into(),
        lifecycle: None,
        attempt: 0,
        incarnation: 0,
        started_at: None,
        ended_at: None,
        duration_ms: None,
        worktree: None,
        summary: None,
        findings: None,
        last_error: None,
        pending_approval_id: None,
    }
}

struct Pending {
    request: Option<ApprovalRequest>,
    requested_at: u64,
}

struct Review {
    round: ReviewRound,
    completed: Option<(Vec<String>, u64)>,
    seq: u64,
}

/// What `approval.resolved` closed — the watcher turns it into `gate.resolved`.
pub(crate) struct Resolution {
    pub(crate) approval_id: String,
    pub(crate) decision: String,
    pub(crate) actor: Option<String>,
}

pub(crate) struct RunProjection {
    root: String,
    run_id: String,
    title: Option<String>,
    spec_id: Option<String>,
    spec_kind: Option<String>,
    profile: Option<String>,
    state: String,
    /// R-9: the sequence the current `state` was read at — an event only
    /// overwrites it when it is newer.
    state_seq: u64,
    /// R-9: the latest status document's `lastSequence`.
    pub(crate) status_last_seq: Option<u64>,
    since: Option<u64>,
    resume_to: Option<String>,
    started_at: Option<u64>,
    ended_at: Option<u64>,
    stop: Option<Stop>,
    last_error: Option<ErrorInfo>,
    iteration: RunIteration,
    host_snapshot: Option<bool>,
    host_event: Option<bool>,
    record_heartbeat: Option<u64>,
    heartbeat_at: Option<u64>,
    pid: Option<u64>,
    git: RunGit,
    runtime: Option<RunRuntime>,
    snapshot_digest: Option<String>,
    cohorte_version: Option<String>,
    unattended: Option<bool>,
    snapshot_order: Option<Vec<String>>,
    first_phase_started: Option<String>,
    phases: Vec<Phase>,
    worktrees: Vec<Worktree>,
    reviews: Vec<Review>,
    pending: BTreeMap<String, Pending>,
    last_resolved_seq: u64,
    artifacts: Vec<(String, Artifact)>,
    diff_paths: BTreeSet<String>,
    diff_stat: (u64, u64),
    usage: Option<RunUsage>,
    pub(crate) last_sequence: u64,
    pub(crate) tail_truncated: bool,
    pub(crate) refreshed_at: u64,
}

impl RunProjection {
    pub(crate) fn new(root: &str, run_id: &str) -> Self {
        RunProjection {
            root: root.to_string(),
            run_id: run_id.to_string(),
            title: None,
            spec_id: None,
            spec_kind: None,
            profile: None,
            state: "IDLE".into(),
            state_seq: 0,
            status_last_seq: None,
            since: None,
            resume_to: None,
            started_at: None,
            ended_at: None,
            stop: None,
            last_error: None,
            iteration: RunIteration::default(),
            host_snapshot: None,
            host_event: None,
            record_heartbeat: None,
            heartbeat_at: None,
            pid: None,
            git: RunGit::default(),
            runtime: None,
            snapshot_digest: None,
            cohorte_version: None,
            unattended: None,
            snapshot_order: None,
            first_phase_started: None,
            phases: Vec::new(),
            worktrees: Vec::new(),
            reviews: Vec::new(),
            pending: BTreeMap::new(),
            last_resolved_seq: 0,
            artifacts: Vec::new(),
            diff_paths: BTreeSet::new(),
            diff_stat: (0, 0),
            usage: None,
            last_sequence: 0,
            tail_truncated: false,
            refreshed_at: 0,
        }
    }

    pub(crate) fn state(&self) -> &str {
        &self.state
    }

    pub(crate) fn run_id(&self) -> &str {
        &self.run_id
    }

    pub(crate) fn is_pending(&self, approval_id: &str) -> bool {
        self.pending.contains_key(approval_id)
    }

    pub(crate) fn request(&self, approval_id: &str) -> Option<&ApprovalRequest> {
        self.pending.get(approval_id)?.request.as_ref()
    }

    fn phase_mut(&mut self, state: &str) -> &mut Phase {
        if let Some(i) = self.phases.iter().position(|p| p.state == state) {
            return &mut self.phases[i];
        }
        self.phases.push(new_phase(state));
        self.phases.last_mut().unwrap()
    }

    /// The phase an event without its own `phase` header belongs to.
    fn current_state(&self) -> Option<String> {
        if is_active(&self.state) {
            return Some(self.state.clone());
        }
        if let Some(r) = &self.resume_to {
            return Some(r.clone());
        }
        self.phases
            .iter()
            .rev()
            .find(|p| p.status == "running")
            .or(self.phases.last())
            .map(|p| p.state.clone())
    }

    /// The latest step of `agent_id` (in `phase` when given).
    fn step_mut(&mut self, agent_id: &str, phase: Option<&str>) -> Option<&mut Step> {
        let in_phase = phase.and_then(|ph| self.phases.iter().position(|p| p.state == ph));
        let found = match in_phase {
            Some(pi) if self.phases[pi].steps.iter().any(|s| s.agent_id == agent_id) => Some(pi),
            _ => self
                .phases
                .iter()
                .rposition(|p| p.steps.iter().any(|s| s.agent_id == agent_id)),
        }?;
        self.phases[found]
            .steps
            .iter_mut()
            .rev()
            .find(|s| s.agent_id == agent_id)
    }

    fn ensure_step(&mut self, agent: &AgentRef, phase: Option<&str>) -> Option<&mut Step> {
        if self.step_mut(&agent.agent_id, phase).is_none() {
            let state = phase.map(str::to_string).or_else(|| self.current_state())?;
            self.phase_mut(&state).steps.push(new_step(
                &agent.agent_id,
                &agent.role,
                agent.surface.as_deref(),
            ));
        }
        let step = self.step_mut(&agent.agent_id, phase)?;
        step.attempt = agent.attempt;
        step.incarnation = agent.incarnation;
        Some(step)
    }

    fn add_artifact(&mut self, a: &ArtifactRef) {
        if self.artifacts.iter().any(|(id, _)| id == &a.artifact_id) {
            return;
        }
        let label = a
            .path
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or(&a.path)
            .to_string();
        self.artifacts.push((
            a.artifact_id.clone(),
            Artifact {
                kind: a.kind.clone(),
                label,
                path: None,
                meta: None,
            },
        ));
    }

    fn touch(&mut self, path: &str, op: &str) {
        if op != "read" {
            self.diff_paths.insert(path.to_string());
        }
    }

    fn review_mut(&mut self, at: u64, seq: u64) -> &mut Review {
        if self.reviews.is_empty() {
            self.reviews.push(Review {
                round: empty_round(None, at),
                completed: None,
                seq,
            });
        }
        self.reviews.last_mut().unwrap()
    }

    // ---------- status documents ----------

    /// Overlay one run of any status shape (FR-14) or an embedded snapshot.
    /// Returns the approvals that vanished from a status that lists pending
    /// approvals (→ `gate.resolved`, decision unknown).
    pub(crate) fn apply_status(&mut self, s: &StatusRun, now: u64) -> Vec<String> {
        macro_rules! set {
            ($field:ident, $v:expr) => {
                if let Some(v) = $v.clone() {
                    self.$field = Some(v);
                }
            };
        }
        set!(title, s.title);
        set!(spec_id, s.spec_id);
        set!(spec_kind, s.spec_kind);
        set!(profile, s.profile);
        if s.last_sequence.is_none_or(|ls| ls >= self.state_seq) {
            self.state = s.state.clone();
            self.state_seq = s.last_sequence.unwrap_or(self.last_sequence);
        }
        if s.last_sequence.is_some() {
            self.status_last_seq = s.last_sequence;
        }
        set!(since, s.since);
        self.resume_to = s.resume_to.clone();
        set!(stop, s.stop);
        set!(last_error, s.last_error);
        if let Some(it) = &s.iteration {
            self.iteration = it.clone();
        }
        self.host_snapshot = s.host_alive;
        if s.host_alive.is_none() {
            self.record_heartbeat = s.heartbeat_at;
        }
        set!(heartbeat_at, s.heartbeat_at);
        set!(pid, s.pid);
        if let Some(b) = &s.base_branch {
            self.git.base_branch = b.clone();
        }
        if s.base_sha.is_some() {
            self.git.base_sha = s.base_sha.clone();
        }
        if s.integration_branch.is_some() {
            self.git.integration_branch = s.integration_branch.clone();
        }
        if s.integration_head.is_some() {
            self.git.integration_head = s.integration_head.clone();
        }
        set!(snapshot_digest, s.snapshot_digest);
        if let Some(rt) = &s.runtime {
            let pin = self
                .runtime
                .as_ref()
                .filter(|r| r.id == rt.id)
                .and_then(|r| r.pin_digest.clone());
            self.runtime = Some(RunRuntime {
                pin_digest: pin,
                ..rt.clone()
            });
        }
        set!(cohorte_version, s.cohorte_version);
        set!(unattended, s.unattended);
        set!(started_at, s.started_at);
        set!(ended_at, s.ended_at);
        if let Some(nodes) = &s.phases {
            self.snapshot_order = Some(nodes.iter().map(|n| n.state.clone()).collect());
            for n in nodes {
                let ph = self.phase_mut(&n.state);
                if let Some(l) = &n.label {
                    ph.label = l.clone();
                }
                ph.status = n.status.clone();
                ph.iteration = n.iteration;
                ph.started_at = n.started_at.or(ph.started_at);
                ph.ended_at = n.ended_at.or(ph.ended_at);
                if n.outcome.is_some() {
                    ph.outcome = n.outcome.clone();
                }
                if !n.checks.is_empty() {
                    ph.checks = n.checks.clone();
                }
                for a in &n.agents {
                    self.overlay_agent(&n.state, a);
                }
            }
        }
        let mut vanished = Vec::new();
        if let Some(list) = &s.pending {
            let listed: BTreeSet<&str> = list.iter().map(|v| v.approval_id.as_str()).collect();
            vanished = self.reconcile_pending(&listed);
            for v in list {
                self.pending
                    .entry(v.approval_id.clone())
                    .or_insert(Pending {
                        request: None,
                        requested_at: v.since.unwrap_or(now),
                    });
            }
        }
        if closes_gates(&self.state) {
            vanished.extend(self.clear_pending());
        }
        vanished
    }

    /// R-1: drop every pending approval (the run ended); returns their ids.
    pub(crate) fn clear_pending(&mut self) -> Vec<String> {
        let ids: Vec<String> = self.pending.keys().cloned().collect();
        for id in &ids {
            self.clear_step_approval(id);
        }
        self.pending.clear();
        ids
    }

    /// Drop every pending approval absent from an authoritative list.
    pub(crate) fn reconcile_pending(&mut self, listed: &BTreeSet<&str>) -> Vec<String> {
        let gone: Vec<String> = self
            .pending
            .keys()
            .filter(|k| !listed.contains(k.as_str()))
            .cloned()
            .collect();
        for g in &gone {
            self.pending.remove(g);
            self.clear_step_approval(g);
        }
        gone
    }

    fn clear_step_approval(&mut self, approval_id: &str) {
        for s in self.phases.iter_mut().flat_map(|p| p.steps.iter_mut()) {
            if s.pending_approval_id.as_deref() == Some(approval_id) {
                s.pending_approval_id = None;
            }
        }
    }

    fn overlay_agent(&mut self, state: &str, a: &AgentNode) {
        let pi = self.phases.iter().position(|p| p.state == state).unwrap();
        let steps = &mut self.phases[pi].steps;
        let step = match steps.iter_mut().rev().find(|s| s.agent_id == a.agent_id) {
            Some(s) => s,
            None => {
                steps.push(new_step(&a.agent_id, &a.role, a.surface.as_deref()));
                steps.last_mut().unwrap()
            }
        };
        if let Some(l) = &a.label {
            step.label = l.clone();
        }
        if let Some(st) = &a.status {
            step.status = st.clone();
        }
        if a.lifecycle.is_some() {
            step.lifecycle = a.lifecycle.clone();
        }
        step.attempt = a.attempt;
        step.incarnation = a.incarnation;
        if let Some(path) = &a.worktree {
            let branch = step.worktree.as_ref().and_then(|w| w.branch.clone());
            step.worktree = Some(StepWorktree {
                path: path.clone(),
                branch,
            });
        }
        if a.summary.is_some() {
            step.summary = a.summary.clone();
        }
        if a.last_error.is_some() {
            step.last_error = a.last_error.clone();
        }
        step.pending_approval_id = a.pending_approval.clone();
    }

    // ---------- rendering ----------

    /// FR-25: the table order for the profile (or the snapshot's).
    fn ordered_phases(&self) -> Vec<Phase> {
        let seen: Vec<String> = self.phases.iter().map(|p| p.state.clone()).collect();
        let mut order: Vec<String> = match &self.snapshot_order {
            Some(o) => o.clone(),
            None => match self.profile.as_deref().unwrap_or("feature") {
                "feature" => {
                    let skip_early = self.first_phase_started.as_deref() == Some("PREFLIGHT");
                    ACTIVE_STATES
                        .iter()
                        .filter(|s| !(skip_early && matches!(**s, "BRAINSTORM" | "SPEC")))
                        .map(|s| s.to_string())
                        .collect()
                }
                "bugfix" => ACTIVE_STATES[2..].iter().map(|s| s.to_string()).collect(),
                "review" => {
                    let mut o = vec!["REVIEW".to_string()];
                    o.extend(seen.iter().filter(|s| *s == "FIX" || *s == "TEST").cloned());
                    o
                }
                _ => Vec::new(),
            },
        };
        for s in seen {
            if !order.contains(&s) {
                order.push(s);
            }
        }
        order
            .iter()
            .map(|st| {
                self.phases
                    .iter()
                    .find(|p| &p.state == st)
                    .cloned()
                    .unwrap_or_else(|| new_phase(st))
            })
            .collect()
    }

    fn view(&self, has_gate: bool) -> &'static str {
        if has_gate {
            return "gate";
        }
        match self.state.as_str() {
            s if is_active(s) => "running",
            "WAITING_APPROVAL" => "waiting",
            "PAUSED" => "paused",
            "AUTH_REQUIRED" => "auth",
            "QUOTA_EXCEEDED" => "quota",
            "FAILED" => "failed",
            "BLOCKED" => "blocked",
            "COMPLETED" => "completed",
            "CANCELLED" => "cancelled",
            "IDLE" => "idle",
            _ => "running",
        }
    }

    fn artifacts_out(&self) -> Vec<Artifact> {
        let mut out: Vec<Artifact> = self.artifacts.iter().map(|(_, a)| a.clone()).collect();
        if !self.diff_paths.is_empty() {
            out.push(Artifact {
                kind: "diff".into(),
                label: format!("diff · {} files", self.diff_paths.len()),
                path: None,
                meta: Some(format!("+{} −{}", self.diff_stat.0, self.diff_stat.1)),
            });
        }
        out.push(Artifact {
            kind: "log".into(),
            label: format!("cohorte tail {}", short_id(&self.run_id)),
            path: None,
            meta: Some("activity log".into()),
        });
        out
    }

    pub(crate) fn to_run(&self, now: u64) -> CohorteRun {
        let phases = self.ordered_phases();
        let latest = self.reviews.last();
        let review_findings = latest
            .filter(|r| r.seq > self.last_resolved_seq)
            .map(|r| r.round.findings.as_slice());
        let known: Vec<(&ApprovalRequest, u64)> = self
            .pending
            .values()
            .filter_map(|p| p.request.as_ref().map(|r| (r, p.requested_at)))
            .collect();
        let gate = if closes_gates(&self.state) {
            None
        } else {
            gate::build(&self.run_id, known, &phases, review_findings)
        };
        let current_phase = if is_active(&self.state) {
            Some(self.state.clone())
        } else if SUSPENDED_OR_HALTED.contains(&self.state.as_str()) {
            self.resume_to.clone()
        } else {
            None
        };
        let alive = self.host_snapshot.or(self.host_event).unwrap_or_else(|| {
            self.record_heartbeat
                .is_some_and(|hb| now.saturating_sub(hb) <= HEARTBEAT_FRESH_MS)
        });
        let started_at = self.started_at.unwrap_or(0);
        CohorteRun {
            project_root: self.root.clone(),
            run_id: self.run_id.clone(),
            title: self
                .title
                .clone()
                .filter(|t| !t.is_empty())
                .or_else(|| self.spec_id.clone())
                .unwrap_or_else(|| self.run_id.clone()),
            spec_id: self.spec_id.clone().unwrap_or_default(),
            spec_kind: self.spec_kind.clone(),
            profile: self.profile.clone().unwrap_or_else(|| "feature".into()),
            state: self.state.clone(),
            view: self.view(gate.is_some()).into(),
            current_phase,
            resume_to: self.resume_to.clone(),
            since: self.since.unwrap_or(started_at),
            started_at,
            ended_at: self.ended_at,
            stop: self.stop.clone(),
            last_error: self.last_error.clone(),
            iteration: self.iteration.clone(),
            host: RunHost {
                alive,
                heartbeat_at: self.heartbeat_at,
                pid: self.pid,
            },
            git: self.git.clone(),
            runtime: self.runtime.clone(),
            snapshot_digest: self.snapshot_digest.clone(),
            cohorte_version: self.cohorte_version.clone(),
            unattended: self.unattended,
            phases,
            worktrees: self.worktrees.clone(),
            gate,
            review: latest.map(rendered_round),
            artifacts: self.artifacts_out(),
            usage: self.usage.clone(),
            last_sequence: self.last_sequence,
            tail_truncated: self.tail_truncated,
            refreshed_at: self.refreshed_at,
        }
    }
}

fn empty_round(phase_run_id: Option<String>, at: u64) -> ReviewRound {
    ReviewRound {
        phase_run_id,
        started_at: at,
        verdict: None,
        findings: Vec::new(),
        counts: SeverityCounts::default(),
        blocking: 0,
        clean: None,
    }
}

fn relabel(r: &mut Review) {
    let completed = r.completed.as_ref().map(|(i, b)| (i.as_slice(), *b));
    gate::relabel(&mut r.round.findings, completed);
}

/// Before `review.completed`, counts/blocking are computed from the findings.
fn rendered_round(r: &Review) -> ReviewRound {
    let mut round = r.round.clone();
    if r.completed.is_none() {
        let mut c = SeverityCounts::default();
        for f in &round.findings {
            match f.severity.as_str() {
                "critical" => c.critical += 1,
                "major" => c.major += 1,
                "minor" => c.minor += 1,
                _ => c.info += 1,
            }
        }
        round.counts = c;
        round.blocking = round.findings.iter().filter(|f| f.blocking).count() as u64;
    }
    round
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cohorte::documents::parse_status;

    #[test]
    fn a_status_approval_without_its_request_reads_waiting() {
        let mut p = RunProjection::new("/r", "run_a");
        let doc = crate::cohorte::testutil::fixture_snapshot_doc("run_a");
        let Some(crate::cohorte::documents::StatusDoc::Run(s)) =
            parse_status(doc.to_string().as_bytes())
        else {
            panic!()
        };
        p.apply_status(&s, 0);
        let run = p.to_run(0);
        assert!(run.gate.is_none());
        assert_eq!(run.view, "waiting");
        assert_eq!(run.phases[0].state, "PREFLIGHT");
        assert_eq!(run.phases[1].steps[0].agent_id, "agt_implementer_api");
        // the approval vanishes from the next status → reported
        let mut s2 = s.clone();
        s2.pending = Some(vec![]);
        assert_eq!(p.apply_status(&s2, 0), vec!["apr_1".to_string()]);
    }

    #[test]
    fn views_follow_fr24() {
        let mut p = RunProjection::new("/r", "run_a");
        for (state, view) in [
            ("BUILD", "running"),
            ("PAUSED", "paused"),
            ("AUTH_REQUIRED", "auth"),
            ("QUOTA_EXCEEDED", "quota"),
            ("FAILED", "failed"),
            ("BLOCKED", "blocked"),
            ("COMPLETED", "completed"),
            ("CANCELLED", "cancelled"),
            ("IDLE", "idle"),
            ("SOMETHING_NEW", "running"),
        ] {
            p.state = state.into();
            assert_eq!(p.view(false), view, "{state}");
        }
        p.state = "PAUSED".into();
        p.resume_to = Some("BUILD".into());
        assert_eq!(p.to_run(0).current_phase.as_deref(), Some("BUILD"));
    }

    #[test]
    fn host_liveness_prefers_snapshot_then_events_then_record_heartbeat() {
        let mut p = RunProjection::new("/r", "run_a");
        p.record_heartbeat = Some(1_000);
        assert!(p.to_run(40_000).host.alive);
        assert!(!p.to_run(50_000).host.alive);
        p.host_event = Some(false);
        assert!(!p.to_run(1_000).host.alive);
        p.host_snapshot = Some(true);
        assert!(p.to_run(1_000).host.alive);
    }

    #[test]
    fn bugfix_review_and_unknown_profiles_order_phases() {
        let mut p = RunProjection::new("/r", "run_a");
        p.profile = Some("bugfix".into());
        assert_eq!(p.to_run(0).phases.len(), 6);
        p.profile = Some("review".into());
        p.phase_mut("FIX");
        let s: Vec<_> = p.to_run(0).phases.into_iter().map(|p| p.state).collect();
        assert_eq!(s, vec!["REVIEW", "FIX"]);
        p.profile = Some("custom".into());
        let s: Vec<_> = p.to_run(0).phases.into_iter().map(|p| p.state).collect();
        assert_eq!(s, vec!["FIX"]);
    }
}
