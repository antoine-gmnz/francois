//! The driver: one thread per watched root, the declarative watch set, and
//! the one-shot refreshes commands use. A `RootWatch` lock is never held
//! across a spawn.

use super::root::Job;
use super::*;

/// R-5: whatever happens in `run_loop` (a panic included), the root is
/// left not-running rather than stuck.
struct LoopGuard {
    handle: Arc<Mutex<RootWatch>>,
    armed: bool,
}

impl Drop for LoopGuard {
    fn drop(&mut self) {
        if self.armed {
            let mut w = lock(&self.handle);
            w.thread_running = false;
            w.stopped_at = Some(now_ms());
        }
    }
}

impl Inner {
    pub(crate) fn root_handle(&self, root: &str) -> Arc<Mutex<RootWatch>> {
        lock(&self.roots)
            .entry(root.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(RootWatch::new(root))))
            .clone()
    }

    pub(crate) fn existing_root(&self, root: &str) -> Option<Arc<Mutex<RootWatch>>> {
        lock(&self.roots).get(root).cloned()
    }

    /// One project status poll; `next_status_at` counts from the END of the
    /// poll (R-10). Returns the poll's error, if any.
    pub(crate) fn run_status(&self, root: &str, h: &Arc<Mutex<RootWatch>>) -> Option<AppError> {
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
            let mut w = lock(h);
            let (ev, error) = w.apply_project_status(&out, now_ms(), fg);
            (ev, error, w.needs_redetect())
        };
        self.emit(&events);
        if redetect && self.detect(root, true).state != "detected" {
            lock(h).suspended = true;
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
        let events = lock(h).apply_tail(run_id, &out, now_ms(), fg);
        self.emit(&events);
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
        let events = lock(&h).apply_run_status(run_id, &out, now_ms())?;
        self.emit(&events);
        let hwm = lock(&h).runs.get(run_id).map(|s| s.hwm).unwrap_or(0);
        self.run_tail(root, &h, run_id, hwm);
        let w = lock(&h);
        w.runs
            .get(run_id)
            .map(|s| s.proj.to_run(now_ms()))
            .ok_or_else(|| {
                AppError::with_detail(
                    ErrorCode::CohorteRunNotFound,
                    format!("no Cohorte run {run_id}"),
                    json!({ "runId": run_id }),
                )
            })
    }

    /// FR-15 — declarative; starts, keeps, lingers. The watch set stays
    /// locked across the spawn decisions so a lingering thread cannot decide
    /// to exit between them (R-10; lock order: watch_set → roots → RootWatch).
    pub(crate) fn set_watch(self: &Arc<Self>, roots: &[String], fg: bool) {
        self.foreground.store(fg, Ordering::Relaxed);
        let now = now_ms();
        let mut ws = lock(&self.watch_set);
        ws.update(roots, now);
        lock(&self.roots).retain(|_, h| {
            let w = lock(h);
            w.thread_running || w.stopped_at.is_none_or(|at| now < at + DROP_AFTER_MS)
        });
        for root in roots {
            let h = self.root_handle(root);
            let spawn = {
                let mut w = lock(&h);
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
        drop(ws);
    }

    fn run_loop(self: Arc<Self>, root: String) {
        let h = self.root_handle(&root);
        let mut guard = LoopGuard {
            handle: h.clone(),
            armed: true,
        };
        loop {
            {
                // R-10: the exit decision and the `thread_running` write
                // happen under the watch_set lock `set_watch` also holds.
                let mut ws = lock(&self.watch_set);
                let now = now_ms();
                ws.expire(now);
                if !ws.is_watched(&root) {
                    let mut w = lock(&h);
                    w.thread_running = false;
                    w.stopped_at = Some(now);
                    guard.armed = false;
                    return;
                }
            }
            let jobs = {
                let w = lock(&h);
                if w.suspended {
                    Vec::new()
                } else {
                    w.due(now_ms())
                }
            };
            for job in jobs {
                match job {
                    Job::Status => {
                        self.run_status(&root, &h);
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

    /// R-5: a panicking loop body cannot leave `thread_running` stuck.
    #[test]
    fn the_loop_guard_clears_thread_running() {
        let h = Arc::new(Mutex::new(RootWatch::new("/r")));
        lock(&h).thread_running = true;
        let h2 = h.clone();
        let r = std::thread::spawn(move || {
            let _g = LoopGuard {
                handle: h2,
                armed: true,
            };
            panic!("boom");
        })
        .join();
        assert!(r.is_err());
        assert!(!lock(&h).thread_running);
        assert!(lock(&h).stopped_at.is_some());
    }
}
