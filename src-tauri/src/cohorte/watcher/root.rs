//! One root: its runs, the status/tail folding into events, and the
//! schedule of its polls (FR-16..FR-19, FR-23).

use super::*;

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
            .min_by_key(|(_, s)| (is_terminal(s.proj.state()), s.next_tail_at))
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
        let mut removed: Vec<String> = Vec::new();
        for (id, slot) in self.runs.iter_mut() {
            if listed.contains(id) {
                slot.keep_cycles = 0;
            } else if slot.keep_cycles > 0 {
                slot.keep_cycles -= 1;
            } else {
                removed.push(id.clone());
            }
        }
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
        let fresh = !self.runs.contains_key(run_id);
        let slot = self.slot(run_id);
        if fresh {
            slot.keep_cycles = 1;
        }
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cohorte::testutil::{approval_envelope, envelope, fixture_record, out};

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

    /// R-6: a non-terminal run's tail is picked before a terminal one.
    #[test]
    fn non_terminal_runs_are_tailed_first() {
        let mut w = RootWatch::new("/r");
        let doc = json!([
            fixture_record("run_done", "COMPLETED"),
            fixture_record("run_live", "BUILD")
        ]);
        w.apply_project_status(&out(0, &doc.to_string()), 0, true);
        let jobs = w.due(10_000);
        assert!(matches!(&jobs[1], Job::Tail(id, _) if id == "run_live"));
    }

    /// R-5: a slot created by `status <run>` survives one status cycle that
    /// does not list it, then goes.
    #[test]
    fn a_refreshed_slot_survives_one_status_cycle() {
        let mut w = RootWatch::new("/r");
        w.apply_run_status(
            "run_a",
            &out(0, &fixture_record("run_a", "BUILD").to_string()),
            0,
        )
        .unwrap();
        w.apply_project_status(&out(0, "[]"), 0, true);
        assert!(w.runs.contains_key("run_a"));
        let (evs, _) = w.apply_project_status(&out(0, "[]"), 0, true);
        assert!(!w.runs.contains_key("run_a"));
        assert!(evs.iter().any(|e| matches!(e, CohorteEvent::RunRemoved(_))));
    }

    /// R-1: a status showing a terminal state closes an opened gate.
    #[test]
    fn a_terminal_status_resolves_the_open_gate() {
        let mut w = RootWatch::new("/r");
        w.apply_project_status(
            &out(
                0,
                &json!([fixture_record("run_a", "WAITING_APPROVAL")]).to_string(),
            ),
            0,
            true,
        );
        let d = approval_envelope(13, "apr_1", "ship", &[]).to_string();
        let evs = w.apply_tail("run_a", &out(0, &d), 0, true);
        assert!(evs.iter().any(|e| matches!(e, CohorteEvent::GateOpened(_))));
        let mut rec = fixture_record("run_a", "CANCELLED");
        rec["lastSequence"] = json!(20);
        let (evs, _) = w.apply_project_status(&out(0, &json!([rec]).to_string()), 1, true);
        assert!(evs
            .iter()
            .any(|e| matches!(e, CohorteEvent::GateResolved(g) if g.decision == "unknown")));
        assert!(w.runs["run_a"].proj.to_run(1).gate.is_none());
        // the same approval in a later backfill never re-opens
        let evs = w.apply_tail("run_a", &out(0, &d), 2, true);
        assert!(!evs.iter().any(|e| matches!(e, CohorteEvent::GateOpened(_))));
    }
}
