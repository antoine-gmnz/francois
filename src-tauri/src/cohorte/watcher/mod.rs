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
use super::{lock, CohorteRun, Inner, LogEntry};

mod driver;
mod root;

use crate::github::gh::RoutedRun;
use crate::ids::now_ms;
use crate::ipc::{AppError, ErrorCode};
pub(crate) use root::RootWatch;
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
    /// R-5: a slot created by `status <run>` survives this many project
    /// statuses that do not list it (the list may lag, or be capped).
    keep_cycles: u8,
}

/// R-8: dev.8 `tail` prints through `sanitizeHuman`, which writes `\xHH`
/// escapes — not JSON. Rewrite them to `\u00HH` (an escaped backslash is kept).
pub(crate) fn fix_hex_escapes(line: &str) -> String {
    let b: Vec<char> = line.chars().collect();
    let mut out = String::with_capacity(line.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == '\\' && i + 1 < b.len() {
            if b[i + 1] == 'x'
                && i + 3 < b.len()
                && b[i + 2].is_ascii_hexdigit()
                && b[i + 3].is_ascii_hexdigit()
            {
                out.push_str("\\u00");
                out.push(b[i + 2]);
                out.push(b[i + 3]);
                i += 4;
            } else {
                out.push(b[i]);
                out.push(b[i + 1]);
                i += 2;
            }
            continue;
        }
        out.push(b[i]);
        i += 1;
    }
    out
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
            keep_cycles: 0,
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
        let mut parsed: Vec<Normalised> = Vec::new();
        let mut unreadable = Vec::new();
        for line in String::from_utf8_lossy(stdout).lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let v = serde_json::from_str::<Value>(line)
                .or_else(|_| serde_json::from_str::<Value>(&fix_hex_escapes(line)));
            match v
                .ok()
                .filter(Value::is_object)
                .and_then(|v| normalise(root, &v, now))
            {
                Some(n) => parsed.push(n),
                None => unreadable.push(line.len()),
            }
        }
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
        let new_durable = kept.iter().any(|n| n.event.header().unwrap().sub == 0);
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
            for r in self.proj.apply(&n.event) {
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
        // R-8: an unreadable line is a parse warning in the run log, never silent.
        for bytes in unreadable {
            self.log.push_back(LogEntry {
                run_id: self.proj.run_id().to_string(),
                sequence: self.hwm,
                sub: 0,
                at: now,
                type_: "francois.parse-warning".into(),
                severity: "warning".into(),
                summary: format!("unreadable tail line ({bytes} bytes) skipped"),
                agent_id: None,
                phase: None,
            });
            while self.log.len() > LOG_RING {
                self.log.pop_front();
            }
        }
        // R-9: the dump is capped when it is full and either nothing is new
        // or the status says Cohorte holds events past what we folded.
        if durable >= DUMP_LIMIT
            && (!new_durable || self.proj.status_last_seq.is_some_and(|s| s > self.hwm))
        {
            self.proj.tail_truncated = true;
        }
        self.seen_ephemeral.retain(|(seq, _)| *seq >= self.hwm);
        self.backfilled = true;
        self.proj.refreshed_at = now;
        self.derived(root, now, &mut derived);
        wire.extend(derived);
        wire
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cohorte::testutil::{approval_envelope, envelope, resolve_envelope};

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
        // R-8: the two unreadable lines are logged as parse warnings.
        assert_eq!(s.log.len(), 3);
        assert_eq!(
            s.log
                .iter()
                .filter(|e| e.type_ == "francois.parse-warning")
                .count(),
            2
        );
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

    /// R-8: `\xHH` escapes are rewritten; an unreadable line is logged.
    #[test]
    fn hex_escapes_parse_and_unreadable_lines_are_logged() {
        assert_eq!(fix_hex_escapes(r#""a\x1b[0m""#), r#""a\u001b[0m""#);
        assert_eq!(fix_hex_escapes(r#""a\\x41""#), r#""a\\x41""#);
        let mut s = RunSlot::new("/r", "run_a");
        let mut l = envelope(
            1,
            0,
            "checkpoint.created",
            json!({ "atSequence": 1, "cause": "interval" }),
        )
        .to_string();
        l = l.replace(
            "\"summary\":\"checkpoint.created\"",
            r#""summary":"cp \x1b[1mbold""#,
        );
        let bytes = format!("{l}\nnot json at all\n");
        s.ingest_dump("/r", bytes.as_bytes(), 0);
        let types: Vec<_> = s.log.iter().map(|e| e.type_.as_str()).collect();
        assert_eq!(types, vec!["checkpoint.created", "francois.parse-warning"]);
        assert_eq!(s.log[0].summary, "cp bold");
        assert_eq!(s.log[1].severity, "warning");
    }

    /// R-9: a full dump whose last events are behind the status' lastSequence
    /// is truncated even when it brought something new.
    #[test]
    fn status_last_sequence_drives_tail_truncated() {
        let mut s = RunSlot::new("/r", "run_a");
        s.proj.status_last_seq = Some(1500);
        s.ingest_dump("/r", &dump(1..=1000), 0);
        assert!(s.proj.tail_truncated);
        let mut s = RunSlot::new("/r", "run_a");
        s.proj.status_last_seq = Some(1000);
        s.ingest_dump("/r", &dump(1..=1000), 0);
        assert!(!s.proj.tail_truncated);
    }
}
