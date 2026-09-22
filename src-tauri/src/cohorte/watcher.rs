//! FR-15..FR-23, FR-26 — the watcher. `WatchSet` is the declarative root set
//! with its 30 s linger; `RootWatch` owns one root's runs (projection, HWM,
//! log ring, emitted-state) and turns CLI outputs into events; the loop at the
//! bottom schedules polls per FR-17/FR-18 on one thread per root. A
//! `RootWatch` lock is never held across a spawn: jobs are picked under the
//! lock, run without it, and their outputs folded under it again.

use super::catalogue::{
    CohorteEvent, GateOpened, GateResolved, RunRemoved, RunUpdated, WatchError, WatchStatus,
};
use super::cli::{self, argv, Kind};
use super::documents::{parse_status, StatusDoc, StatusRun};
use super::projection::{is_terminal, RunProjection};
use super::wire::{coalesce, normalise, Normalised};
use super::{CohorteRun, Inner, LogEntry};
use crate::github::gh::RoutedRun;
use crate::ids::now_ms;
use crate::ipc::{AppError, ErrorCode};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet, HashSet, VecDeque};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub(crate) const LINGER_MS: u64 = 30_000;
const DROP_AFTER_MS: u64 = 10 * 60_000;
const MAX_BACKOFF_MS: u64 = 60_000;
const LOG_RING: usize = 500;
/// dev.8's `tail` dumps at most this many durable events (FR-20).
const DUMP_LIMIT: usize = 1000;
const TICK: Duration = Duration::from_millis(250);

// ---------- the declarative root set (FR-15) ----------

#[derive(Default)]
pub(crate) struct WatchSet {
    active: BTreeSet<String>,
    lingering: BTreeMap<String, u64>,
}

impl WatchSet {
    /// Returns the roots that were neither active nor lingering (to start).
    pub(crate) fn update(&mut self, roots: &[String], now: u64) -> Vec<String> {
        let next: BTreeSet<String> = roots.iter().cloned().collect();
        let mut started = Vec::new();
        for r in &next {
            if self.lingering.remove(r).is_none() && !self.active.contains(r) {
                started.push(r.clone());
            }
        }
        for gone in self.active.difference(&next) {
            self.lingering.insert(gone.clone(), now + LINGER_MS);
        }
        self.active = next;
        started
    }

    /// Drop lingering roots whose 30 s ran out; returns them.
    pub(crate) fn expire(&mut self, now: u64) -> Vec<String> {
        let out: Vec<String> = self
            .lingering
            .iter()
            .filter(|(_, at)| **at <= now)
            .map(|(r, _)| r.clone())
            .collect();
        for r in &out {
            self.lingering.remove(r);
        }
        out
    }

    pub(crate) fn is_watched(&self, root: &str) -> bool {
        self.active.contains(root) || self.lingering.contains_key(root)
    }
}

// ---------- the schedule (FR-17/FR-18) ----------

pub(crate) fn status_interval(any_non_terminal: bool, fg: bool) -> u64 {
    match (any_non_terminal, fg) {
        (true, true) => 3_000,
        (true, false) => 30_000,
        (false, true) => 15_000,
        (false, false) => 60_000,
    }
}

/// `None` = do not tail (terminal and already tailed once).
pub(crate) fn tail_interval(view: &str, fg: bool) -> u64 {
    match (view, fg) {
        ("running", true) => 2_000,
        ("running", false) => 15_000,
        (_, true) => 5_000,
        (_, false) => 30_000,
    }
}

/// A failed poll doubles its interval up to 60 s; success resets it.
pub(crate) fn backoff(base: u64, failures: u32) -> u64 {
    if failures == 0 {
        return base;
    }
    base.saturating_mul(1u64 << failures.min(16))
        .min(MAX_BACKOFF_MS.max(base))
}

// ---------- one run ----------

pub(crate) struct RunSlot {
    pub(crate) proj: RunProjection,
    hwm: u64,
    backfilled: bool,
    seen_ephemeral: HashSet<(u64, u64)>,
    log: VecDeque<LogEntry>,
    last_json: Option<String>,
    gates_opened: BTreeSet<String>,
    host_alive: Option<bool>,
    next_tail_at: u64,
    tail_failures: u32,
    terminal_tailed: bool,
}

impl RunSlot {
    fn new(root: &str, run_id: &str) -> Self {
        RunSlot {
            proj: RunProjection::new(root, run_id),
            hwm: 0,
            backfilled: false,
            seen_ephemeral: HashSet::new(),
            log: VecDeque::new(),
            last_json: None,
            gates_opened: BTreeSet::new(),
            host_alive: None,
            next_tail_at: 0,
            tail_failures: 0,
            terminal_tailed: false,
        }
    }

    fn push_log(&mut self, ev: &CohorteEvent) {
        let (Some(h), Some(ty)) = (ev.header(), ev.log_type()) else {
            return;
        };
        self.log.push_back(LogEntry {
            run_id: h.run_id.clone(),
            sequence: h.sequence,
            sub: h.sub,
            at: h.at,
            type_: ty.to_string(),
            severity: h.severity.clone(),
            summary: h.summary.clone(),
            agent_id: h.agent.as_ref().map(|a| a.agent_id.clone()),
            phase: h.phase.as_ref().map(|p| p.state.clone()),
        });
        while self.log.len() > LOG_RING {
            self.log.pop_front();
        }
    }

    /// FR-23: `run.updated` when the projection changed; `gate.opened` edges.
    fn derived(&mut self, root: &str, now: u64, out: &mut Vec<CohorteEvent>) {
        let run = self.proj.to_run(now);
        let mut cmp = run.clone();
        cmp.refreshed_at = 0;
        let json = serde_json::to_string(&cmp).unwrap_or_default();
        if self.last_json.as_deref() != Some(json.as_str()) {
            self.last_json = Some(json);
            out.push(CohorteEvent::RunUpdated(RunUpdated {
                run: Box::new(run.clone()),
            }));
        }
        if let Some(g) = &run.gate {
            if self.gates_opened.insert(g.request.approval_id.clone()) {
                out.push(CohorteEvent::GateOpened(GateOpened {
                    project_root: root.to_string(),
                    gate: Box::new(g.clone()),
                }));
            }
        }
    }

    fn resolved(
        &self,
        root: &str,
        approval_id: &str,
        decision: &str,
        actor: Option<String>,
    ) -> Option<CohorteEvent> {
        self.gates_opened.contains(approval_id).then(|| {
            CohorteEvent::GateResolved(GateResolved {
                project_root: root.to_string(),
                run_id: self.proj.run_id().to_string(),
                approval_id: approval_id.to_string(),
                decision: decision.to_string(),
                actor,
            })
        })
    }

    fn fold_status(&mut self, root: &str, s: &StatusRun, now: u64, out: &mut Vec<CohorteEvent>) {
        for gone in self.proj.apply_status(s, now) {
            out.extend(self.resolved(root, &gone, "unknown", None));
        }
    }

    /// FR-20/21/22 — one tail dump.
    pub(crate) fn ingest_dump(&mut self, root: &str, stdout: &[u8], now: u64) -> Vec<CohorteEvent> {
        let mut parsed: Vec<Normalised> = String::from_utf8_lossy(stdout)
            .lines()
            .filter_map(|l| serde_json::from_str::<Value>(l.trim()).ok())
            .filter(Value::is_object)
            .filter_map(|v| normalise(root, &v, now))
            .collect();
        parsed.sort_by_key(|n| {
            n.event
                .header()
                .map(|h| (h.sequence, h.sub))
                .unwrap_or_default()
        });
        let durable = parsed
            .iter()
            .filter(|n| n.event.header().is_some_and(|h| h.sub == 0))
            .count();
        let hwm = self.hwm;
        let mut in_dump: HashSet<(u64, u64)> = HashSet::new();
        let kept: Vec<Normalised> = parsed
            .into_iter()
            .filter(|n| {
                let h = n.event.header().unwrap();
                let key = (h.sequence, h.sub);
                if !in_dump.insert(key) {
                    return false;
                }
                if h.sub == 0 {
                    h.sequence > hwm
                } else {
                    h.sequence >= hwm && !self.seen_ephemeral.contains(&key)
                }
            })
            .collect();
        if durable >= DUMP_LIMIT && !kept.iter().any(|n| n.event.header().unwrap().sub == 0) {
            self.proj.tail_truncated = true;
        }
        let backfill = !self.backfilled;
        let mut wire = Vec::new();
        let mut derived = Vec::new();
        for n in coalesce(kept) {
            let h = n.event.header().unwrap().clone();
            if h.sub == 0 {
                self.hwm = self.hwm.max(h.sequence);
            } else {
                self.seen_ephemeral.insert((h.sequence, h.sub));
            }
            if let Some(s) = &n.snapshot {
                self.fold_status(root, s, now, &mut derived);
            }
            if let Some(r) = self.proj.apply(&n.event) {
                derived.extend(self.resolved(root, &r.approval_id, &r.decision, r.actor));
            }
            self.push_log(&n.event);
            let forward = match &n.event {
                CohorteEvent::Heartbeat(w) => {
                    let flip = self.host_alive != Some(w.payload.host_alive);
                    self.host_alive = Some(w.payload.host_alive);
                    flip
                }
                _ => true,
            };
            if !backfill && forward {
                wire.push(n.event);
            }
        }
        self.seen_ephemeral.retain(|(seq, _)| *seq >= self.hwm);
        self.backfilled = true;
        self.proj.refreshed_at = now;
        self.derived(root, now, &mut derived);
        wire.extend(derived);
        wire
    }
}

// ---------- one root ----------

pub(crate) enum Job {
    Status,
    Tail(String, u64),
}

pub(crate) struct RootWatch {
    root: String,
    pub(crate) runs: BTreeMap<String, RunSlot>,
    status_failures: u32,
    healthy: Option<bool>,
    next_status_at: u64,
    cli_missing_streak: u32,
    pub(crate) suspended: bool,
    pub(crate) polled: bool,
    pub(crate) thread_running: bool,
    pub(crate) stopped_at: Option<u64>,
}

impl RootWatch {
    pub(crate) fn new(root: &str) -> Self {
        RootWatch {
            root: root.to_string(),
            runs: BTreeMap::new(),
            status_failures: 0,
            healthy: None,
            next_status_at: 0,
            cli_missing_streak: 0,
            suspended: false,
            polled: false,
            thread_running: false,
            stopped_at: None,
        }
    }

    fn any_non_terminal(&self) -> bool {
        self.runs.values().any(|s| !is_terminal(s.proj.state()))
    }

    fn slot(&mut self, run_id: &str) -> &mut RunSlot {
        let root = self.root.clone();
        self.runs
            .entry(run_id.to_string())
            .or_insert_with(|| RunSlot::new(&root, run_id))
    }

    /// Jobs due at `now`: the status poll, plus at most one tail (round-robin
    /// = the most overdue run), so one root never has two tails in flight.
    pub(crate) fn due(&self, now: u64) -> Vec<Job> {
        let mut jobs = Vec::new();
        if now >= self.next_status_at {
            jobs.push(Job::Status);
        }
        if let Some((id, slot)) = self
            .runs
            .iter()
            .filter(|(_, s)| now >= s.next_tail_at && !s.terminal_tailed)
            .min_by_key(|(_, s)| s.next_tail_at)
        {
            jobs.push(Job::Tail(id.clone(), slot.hwm));
        }
        jobs
    }

    /// FR-18/19: schedule the next status poll; a health flip → `watch.status`.
    fn record_status(
        &mut self,
        result: Result<(), AppError>,
        now: u64,
        fg: bool,
    ) -> Option<CohorteEvent> {
        let base = status_interval(self.any_non_terminal(), fg);
        let (healthy, error) = match result {
            Ok(()) => {
                self.status_failures = 0;
                self.cli_missing_streak = 0;
                (true, None)
            }
            Err(e) => {
                self.status_failures += 1;
                if e.code == ErrorCode::CohorteCliMissing {
                    self.cli_missing_streak += 1;
                }
                (false, Some(e))
            }
        };
        let wait = backoff(base, self.status_failures);
        self.next_status_at = now + wait;
        let flipped = match self.healthy {
            None => !healthy,
            Some(h) => h != healthy,
        };
        self.healthy = Some(healthy);
        flipped.then(|| {
            CohorteEvent::WatchStatus(WatchStatus {
                project_root: self.root.clone(),
                healthy,
                error: error.map(|e| WatchError {
                    code: e.code,
                    message: e.message,
                }),
                next_poll_in_ms: wait,
            })
        })
    }

    /// FR-18: detection is re-run after 3 consecutive CLI-missing failures.
    pub(crate) fn needs_redetect(&mut self) -> bool {
        if self.cli_missing_streak >= 3 {
            self.cli_missing_streak = 0;
            return true;
        }
        false
    }

    /// Project `status --json` output → events (FR-14, FR-23), plus the
    /// poll's error when it failed.
    pub(crate) fn apply_project_status(
        &mut self,
        out: &RoutedRun,
        now: u64,
        fg: bool,
    ) -> (Vec<CohorteEvent>, Option<AppError>) {
        let args = argv::status(None).unwrap_or_default();
        let mut events = Vec::new();
        let parsed = match cli::read_failure(&args, out, cli::READ_TIMEOUT, cli::READ_CAP) {
            Some(e) => Err(e),
            None if out.code != 0 => Err(cli::command_failed(&args, out)),
            None => parse_status(&out.stdout).ok_or_else(|| cli::output_invalid(&args)),
        };
        let doc = match parsed {
            Ok(d) => d,
            Err(e) => {
                events.extend(self.record_status(Err(e.clone()), now, fg));
                return (events, Some(e));
            }
        };
        let (runs, pending) = match doc {
            StatusDoc::Project { runs, pending } => (runs, pending),
            StatusDoc::Run(r) => (vec![r], None),
        };
        let listed: BTreeSet<String> = runs.iter().map(|r| r.run_id.clone()).collect();
        let removed: Vec<String> = self
            .runs
            .keys()
            .filter(|k| !listed.contains(*k))
            .cloned()
            .collect();
        for id in removed {
            self.runs.remove(&id);
            events.push(CohorteEvent::RunRemoved(RunRemoved {
                project_root: self.root.clone(),
                run_id: id,
            }));
        }
        let root = self.root.clone();
        for r in &runs {
            let slot = self.slot(&r.run_id);
            slot.fold_status(&root, r, now, &mut events);
            if let Some(list) = &pending {
                let ids: BTreeSet<&str> = list.iter().map(|v| v.approval_id.as_str()).collect();
                for gone in slot.proj.reconcile_pending(&ids) {
                    events.extend(slot.resolved(&root, &gone, "unknown", None));
                }
            }
            slot.proj.refreshed_at = now;
            slot.derived(&root, now, &mut events);
        }
        self.polled = true;
        events.extend(self.record_status(Ok(()), now, fg));
        (events, None)
    }

    /// `status <run> --json` → the run folded; exit 1 / no document = not found.
    pub(crate) fn apply_run_status(
        &mut self,
        run_id: &str,
        out: &RoutedRun,
        now: u64,
    ) -> Result<Vec<CohorteEvent>, AppError> {
        let args = argv::status(Some(run_id))?;
        if let Some(e) = cli::read_failure(&args, out, cli::READ_TIMEOUT, cli::READ_CAP) {
            return Err(e);
        }
        let not_found = || {
            AppError::with_detail(
                ErrorCode::CohorteRunNotFound,
                format!("no Cohorte run {run_id}"),
                json!({ "runId": run_id }),
            )
        };
        let doc = match parse_status(&out.stdout) {
            Some(StatusDoc::Run(r)) if r.run_id == run_id => r,
            _ if out.code == 1 => return Err(not_found()),
            Some(_) if out.code == 0 => return Err(not_found()),
            _ if out.code != 0 => return Err(cli::command_failed(&args, out)),
            _ => {
                let t = String::from_utf8_lossy(&out.stdout);
                return Err(if matches!(t.trim(), "" | "undefined" | "null") {
                    not_found()
                } else {
                    cli::output_invalid(&args)
                });
            }
        };
        let root = self.root.clone();
        let mut events = Vec::new();
        let slot = self.slot(run_id);
        slot.fold_status(&root, &doc, now, &mut events);
        slot.proj.refreshed_at = now;
        slot.derived(&root, now, &mut events);
        Ok(events)
    }

    /// `tail <run>` output → events; a capped/failed dump is not folded (FR-95).
    pub(crate) fn apply_tail(
        &mut self,
        run_id: &str,
        out: &RoutedRun,
        now: u64,
        fg: bool,
    ) -> Vec<CohorteEvent> {
        let root = self.root.clone();
        let Some(slot) = self.runs.get_mut(run_id) else {
            return Vec::new();
        };
        let ok = !out.spawn_failed && !out.timed_out && !out.capped && out.code == 0;
        let events = if ok {
            slot.tail_failures = 0;
            slot.ingest_dump(&root, &out.stdout, now)
        } else {
            slot.tail_failures += 1;
            Vec::new()
        };
        let run_view = slot.proj.to_run(now).view;
        if is_terminal(slot.proj.state()) && ok {
            slot.terminal_tailed = true;
        }
        slot.next_tail_at = now + backoff(tail_interval(&run_view, fg), slot.tail_failures);
        events
    }

    pub(crate) fn runs_sorted(&self, now: u64) -> Vec<CohorteRun> {
        let mut runs: Vec<CohorteRun> = self.runs.values().map(|s| s.proj.to_run(now)).collect();
        runs.sort_by(|a, b| {
            is_terminal(&a.state)
                .cmp(&is_terminal(&b.state))
                .then(b.started_at.cmp(&a.started_at))
        });
        runs
    }

    /// FR-26: the newest `limit` entries, oldest first.
    pub(crate) fn log(&self, run_id: &str, limit: usize) -> Option<Vec<LogEntry>> {
        let slot = self.runs.get(run_id)?;
        let skip = slot.log.len().saturating_sub(limit);
        Some(slot.log.iter().skip(skip).cloned().collect())
    }
}

// ---------- the driver ----------

impl Inner {
    pub(crate) fn root_handle(&self, root: &str) -> Arc<Mutex<RootWatch>> {
        self.roots
            .lock()
            .unwrap()
            .entry(root.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(RootWatch::new(root))))
            .clone()
    }

    pub(crate) fn existing_root(&self, root: &str) -> Option<Arc<Mutex<RootWatch>>> {
        self.roots.lock().unwrap().get(root).cloned()
    }

    fn run_status(&self, root: &str, h: &Arc<Mutex<RootWatch>>, now: u64) -> Option<AppError> {
        let args = argv::status(None).unwrap_or_default();
        let out = cli::run(
            self.runner.as_ref(),
            Kind::Read,
            root,
            &args,
            cli::READ_TIMEOUT,
            cli::READ_CAP,
        );
        let fg = self.foreground.load(Ordering::Relaxed);
        let (events, error, redetect) = {
            let mut w = h.lock().unwrap();
            let (ev, error) = w.apply_project_status(&out, now, fg);
            (ev, error, w.needs_redetect())
        };
        self.emit(&events);
        if redetect && self.detect(root, true).state != "detected" {
            h.lock().unwrap().suspended = true;
        }
        error
    }

    fn run_tail(&self, root: &str, h: &Arc<Mutex<RootWatch>>, run_id: &str, hwm: u64) {
        let Ok(args) = argv::tail(run_id, hwm) else {
            return;
        };
        let out = cli::run(
            self.runner.as_ref(),
            Kind::Read,
            root,
            &args,
            cli::READ_TIMEOUT,
            cli::TAIL_CAP,
        );
        let fg = self.foreground.load(Ordering::Relaxed);
        let events = h.lock().unwrap().apply_tail(run_id, &out, now_ms(), fg);
        self.emit(&events);
    }

    /// One full round for a root: status, then a tail of every run.
    pub(crate) fn poll_root_once(&self, root: &str) -> Result<(), AppError> {
        let h = self.root_handle(root);
        if let Some(e) = self.run_status(root, &h, now_ms()) {
            return Err(e);
        }
        let tails: Vec<(String, u64)> = {
            let w = h.lock().unwrap();
            w.runs.iter().map(|(id, s)| (id.clone(), s.hwm)).collect()
        };
        for (id, hwm) in tails {
            self.run_tail(root, &h, &id, hwm);
        }
        Ok(())
    }

    /// FR-17 "after any command": `status <run>` + `tail <run>`, emitted.
    pub(crate) fn refresh_run(&self, root: &str, run_id: &str) -> Result<CohorteRun, AppError> {
        let args = argv::status(Some(run_id))?;
        let h = self.root_handle(root);
        let out = cli::run(
            self.runner.as_ref(),
            Kind::Read,
            root,
            &args,
            cli::READ_TIMEOUT,
            cli::READ_CAP,
        );
        let events = h.lock().unwrap().apply_run_status(run_id, &out, now_ms())?;
        self.emit(&events);
        let hwm = h
            .lock()
            .unwrap()
            .runs
            .get(run_id)
            .map(|s| s.hwm)
            .unwrap_or(0);
        self.run_tail(root, &h, run_id, hwm);
        let w = h.lock().unwrap();
        Ok(w.runs[run_id].proj.to_run(now_ms()))
    }

    /// FR-15 — declarative; starts, keeps, lingers.
    pub(crate) fn set_watch(self: &Arc<Self>, roots: &[String], fg: bool) {
        self.foreground.store(fg, Ordering::Relaxed);
        let now = now_ms();
        self.watch_set.lock().unwrap().update(roots, now);
        self.roots.lock().unwrap().retain(|_, h| {
            let w = h.lock().unwrap();
            w.thread_running || w.stopped_at.is_none_or(|at| now < at + DROP_AFTER_MS)
        });
        for root in roots {
            let h = self.root_handle(root);
            let spawn = {
                let mut w = h.lock().unwrap();
                w.suspended = false;
                w.stopped_at = None;
                !std::mem::replace(&mut w.thread_running, true)
            };
            if spawn {
                let inner = Arc::clone(self);
                let root = root.clone();
                std::thread::spawn(move || inner.run_loop(root));
            }
        }
    }

    fn run_loop(self: Arc<Self>, root: String) {
        let h = self.root_handle(&root);
        loop {
            let now = now_ms();
            let watched = {
                let mut ws = self.watch_set.lock().unwrap();
                ws.expire(now);
                ws.is_watched(&root)
            };
            if !watched {
                let mut w = h.lock().unwrap();
                w.thread_running = false;
                w.stopped_at = Some(now);
                return;
            }
            let jobs = {
                let w = h.lock().unwrap();
                if w.suspended {
                    Vec::new()
                } else {
                    w.due(now)
                }
            };
            for job in jobs {
                match job {
                    Job::Status => {
                        self.run_status(&root, &h, now);
                    }
                    Job::Tail(id, hwm) => self.run_tail(&root, &h, &id, hwm),
                }
            }
            std::thread::sleep(TICK);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cohorte::testutil::{
        approval_envelope, envelope, fixture_record, out, resolve_envelope,
    };

    fn line(seq: u64) -> String {
        envelope(
            seq,
            0,
            "checkpoint.created",
            json!({ "atSequence": seq, "cause": "interval" }),
        )
        .to_string()
    }
    fn dump(seqs: impl IntoIterator<Item = u64>) -> Vec<u8> {
        seqs.into_iter()
            .map(line)
            .collect::<Vec<_>>()
            .join("\n")
            .into_bytes()
    }
    fn wire(evs: &[CohorteEvent]) -> Vec<u64> {
        evs.iter()
            .filter_map(|e| e.header().map(|h| h.sequence))
            .collect()
    }
    fn updated(evs: &[CohorteEvent]) -> usize {
        evs.iter()
            .filter(|e| matches!(e, CohorteEvent::RunUpdated(_)))
            .count()
    }

    /// AC-3.
    #[test]
    fn dumps_dedupe_by_hwm_and_backfill_silently() {
        let mut s = RunSlot::new("/r", "run_a");
        let first = s.ingest_dump("/r", &dump(1..=1000), 0);
        assert!(wire(&first).is_empty(), "backfill emits no wire event");
        assert_eq!(updated(&first), 1);
        assert_eq!(s.log.len(), LOG_RING);
        let second = s.ingest_dump("/r", &dump(1..=1000), 0);
        assert!(wire(&second).is_empty());
        assert!(
            s.proj.tail_truncated,
            "a capped dump with nothing new is truncated"
        );
        let mut shuffled: Vec<u64> = (1..=1000).collect();
        shuffled.extend([1003, 1001, 1002]);
        let third = s.ingest_dump("/r", &dump(shuffled), 0);
        assert_eq!(wire(&third), vec![1001, 1002, 1003]);
        assert_eq!(s.hwm, 1003);
    }

    #[test]
    fn non_json_lines_are_skipped() {
        let mut s = RunSlot::new("/r", "run_a");
        let mut bytes = b"garbage\n[1,2]\n".to_vec();
        bytes.extend(dump([1]));
        s.ingest_dump("/r", &bytes, 0);
        assert_eq!(s.log.len(), 1);
    }

    #[test]
    fn gate_opened_fires_once_even_on_backfill_and_resolution_closes_it() {
        let mut s = RunSlot::new("/r", "run_a");
        let d1 = approval_envelope(1, "apr_1", "tool", &[]).to_string();
        let evs = s.ingest_dump("/r", d1.as_bytes(), 0);
        assert_eq!(
            evs.iter()
                .filter(|e| matches!(e, CohorteEvent::GateOpened(_)))
                .count(),
            1
        );
        let evs = s.ingest_dump("/r", d1.as_bytes(), 0);
        assert!(!evs.iter().any(|e| matches!(e, CohorteEvent::GateOpened(_))));
        let d2 = format!("{d1}\n{}", resolve_envelope(2, "apr_1", "deny"));
        let evs = s.ingest_dump("/r", d2.as_bytes(), 0);
        assert_eq!(wire(&evs), vec![2]);
        let resolved: Vec<_> = evs
            .iter()
            .filter_map(|e| match e {
                CohorteEvent::GateResolved(g) => Some(g.decision.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(resolved, vec!["deny"]);
    }

    #[test]
    fn heartbeats_are_forwarded_only_on_a_flip() {
        let mut s = RunSlot::new("/r", "run_a");
        s.ingest_dump("/r", b"", 0); // backfill done
        let hb = |sub, alive: bool| {
            envelope(
                0,
                sub,
                "heartbeat",
                json!({ "hostAlive": alive, "lastSequence": 0 }),
            )
            .to_string()
        };
        let evs = s.ingest_dump(
            "/r",
            format!("{}\n{}", hb(1, true), hb(2, true)).as_bytes(),
            0,
        );
        assert_eq!(
            evs.iter()
                .filter(|e| matches!(e, CohorteEvent::Heartbeat(_)))
                .count(),
            1
        );
        let evs = s.ingest_dump("/r", hb(3, false).as_bytes(), 0);
        assert_eq!(
            evs.iter()
                .filter(|e| matches!(e, CohorteEvent::Heartbeat(_)))
                .count(),
            1
        );
    }

    /// AC-13.
    #[test]
    fn intervals_follow_the_table() {
        assert_eq!(status_interval(true, true), 3_000);
        assert_eq!(status_interval(false, true), 15_000);
        assert_eq!(status_interval(true, false), 30_000);
        assert_eq!(status_interval(false, false), 60_000);
        assert_eq!(tail_interval("running", true), 2_000);
        assert_eq!(tail_interval("gate", true), 5_000);
        assert_eq!(tail_interval("paused", false), 30_000);
        assert_eq!(tail_interval("running", false), 15_000);
    }

    #[test]
    fn failures_double_to_60s_and_success_resets() {
        assert_eq!(backoff(3_000, 1), 6_000);
        assert_eq!(backoff(3_000, 2), 12_000);
        assert_eq!(backoff(3_000, 10), 60_000);
        assert_eq!(backoff(60_000, 3), 60_000);
        let mut w = RootWatch::new("/r");
        let ev = w.record_status(Err(cli::cli_missing()), 0, true);
        assert!(
            matches!(ev, Some(CohorteEvent::WatchStatus(ref s)) if !s.healthy && s.next_poll_in_ms == 30_000)
        );
        assert!(
            w.record_status(Err(cli::cli_missing()), 0, true).is_none(),
            "no event without a flip"
        );
        assert_eq!(w.next_status_at, 60_000);
        w.record_status(Err(cli::cli_missing()), 0, true);
        assert!(w.needs_redetect());
        let ev = w.record_status(Ok(()), 100, true);
        assert!(matches!(ev, Some(CohorteEvent::WatchStatus(ref s)) if s.healthy));
        assert_eq!(w.next_status_at, 100 + 15_000);
    }

    #[test]
    fn linger_stops_a_root_after_30s() {
        let mut ws = WatchSet::default();
        assert_eq!(ws.update(&["/a".into()], 0), vec!["/a".to_string()]);
        assert!(ws.update(&["/a".into()], 1).is_empty(), "idempotent");
        ws.update(&[], 1_000);
        assert!(ws.is_watched("/a"));
        assert!(ws.expire(30_999).is_empty());
        assert!(
            ws.update(&["/a".into()], 2_000).is_empty(),
            "a quick switch back does not restart"
        );
        ws.update(&[], 5_000);
        assert_eq!(ws.expire(35_000), vec!["/a".to_string()]);
        assert!(!ws.is_watched("/a"));
    }

    #[test]
    fn project_status_upserts_removes_and_schedules() {
        let mut w = RootWatch::new("/r");
        let doc = json!([
            fixture_record("run_a", "BUILD"),
            fixture_record("run_b", "COMPLETED")
        ]);
        w.apply_project_status(&out(0, &doc.to_string()), 0, true);
        assert_eq!(w.runs.len(), 2);
        assert_eq!(w.next_status_at, 3_000);
        let jobs = w.due(3_000);
        assert_eq!(jobs.len(), 2, "status + ONE tail");
        let doc = json!([fixture_record("run_b", "COMPLETED")]);
        let evs = w
            .apply_project_status(&out(0, &doc.to_string()), 10, true)
            .0;
        assert!(evs
            .iter()
            .any(|e| matches!(e, CohorteEvent::RunRemoved(r) if r.run_id == "run_a")));
        assert_eq!(w.next_status_at, 15_010, "no non-terminal run left");
        let (evs, err) = w.apply_project_status(&out(0, "not json"), 20, true);
        assert_eq!(err.unwrap().code, ErrorCode::CohorteOutputInvalid);
        assert!(
            matches!(&evs[0], CohorteEvent::WatchStatus(s) if s.error.as_ref().unwrap().code == ErrorCode::CohorteOutputInvalid)
        );
    }

    #[test]
    fn a_terminal_run_is_tailed_once_then_never() {
        let mut w = RootWatch::new("/r");
        let doc = json!([fixture_record("run_b", "COMPLETED")]);
        w.apply_project_status(&out(0, &doc.to_string()), 0, true);
        w.apply_tail("run_b", &out(0, ""), 0, true);
        assert!(w.due(1_000_000).iter().all(|j| matches!(j, Job::Status)));
    }

    #[test]
    fn a_capped_tail_is_not_folded_and_backs_off() {
        let mut w = RootWatch::new("/r");
        w.apply_project_status(
            &out(0, &json!([fixture_record("run_a", "BUILD")]).to_string()),
            0,
            true,
        );
        let mut o = out(0, &String::from_utf8(dump([1])).unwrap());
        o.capped = true;
        assert!(w.apply_tail("run_a", &o, 0, true).is_empty());
        assert_eq!(w.runs["run_a"].hwm, 0);
        assert_eq!(w.runs["run_a"].next_tail_at, 4_000);
    }

    #[test]
    fn run_status_reports_not_found() {
        let mut w = RootWatch::new("/r");
        let e = w
            .apply_run_status("run_zz", &out(1, "undefined\n"), 0)
            .unwrap_err();
        assert_eq!(e.code, ErrorCode::CohorteRunNotFound);
        let ok = w.apply_run_status(
            "run_a",
            &out(0, &fixture_record("run_a", "BUILD").to_string()),
            0,
        );
        assert!(ok.is_ok());
        assert!(w.runs.contains_key("run_a"));
    }

    #[test]
    fn list_sorts_non_terminal_first_then_newest_and_log_returns_the_tail() {
        let mut w = RootWatch::new("/r");
        let mut old = fixture_record("run_old", "BUILD");
        old["startedAt"] = json!("2025-01-01T00:00:00.000Z");
        let doc = json!([
            fixture_record("run_done", "COMPLETED"),
            old,
            fixture_record("run_new", "BUILD")
        ]);
        w.apply_project_status(&out(0, &doc.to_string()), 0, true);
        let ids: Vec<_> = w.runs_sorted(0).into_iter().map(|r| r.run_id).collect();
        assert_eq!(ids, vec!["run_new", "run_old", "run_done"]);
        w.apply_tail(
            "run_new",
            &out(0, &String::from_utf8(dump(1..=10)).unwrap()),
            0,
            true,
        );
        let log = w.log("run_new", 3).unwrap();
        assert_eq!(
            log.iter().map(|l| l.sequence).collect::<Vec<_>>(),
            vec![8, 9, 10]
        );
        assert!(w.log("run_x", 3).is_none());
    }
}
