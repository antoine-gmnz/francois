//! FR-20/FR-22 — the budgets one invocation runs under, and the pool that
//! bounds how many of them exist at once.
//!
//! Nothing here knows what a plugin is. `Guard` is a set of counters and two
//! deadlines shared between the interrupt handler (owned by the runtime) and the
//! host closures (owned by the context); `IsolatePool` is a semaphore with a
//! per-plugin DROP rule. Keeping them apart from the engine plumbing is what
//! lets the limits be read without reading QuickJS.

use super::*;

use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Condvar, Mutex as StdMutex};

/// FR-20: the methods that count against the 8-I/O budget — the spec's
/// parenthetical, verbatim (`fetch` + `storage.*`).
pub(super) fn is_metered_io(method: &str) -> bool {
    method == "fetch" || method.starts_with("storage.")
}

/// FR-22: read-state calls are not I/O in FR-20's sense, but they are not free
/// either, and their cost lands on the paths this feature promises to keep
/// responsive: `diff.summary` takes the per-session git lock and SPAWNS a git
/// process, `sessions.list` locks and serializes every session. Unmetered, a
/// plugin can loop either one for the full wall clock — and every blocking host
/// call credits its own duration back to the CPU deadline, so the loop never
/// trips that one.
///
/// So they get their own, looser budget: generous enough that no honest panel
/// notices, tight enough that the loop is a bounded burst rather than ten
/// seconds of process spawning.
pub(crate) const READ_STATE_MAX_CALLS: u32 = 32;

pub(super) fn is_read_state(method: &str) -> bool {
    matches!(
        method.split('.').next().unwrap_or(""),
        "sessions" | "agents" | "diff" | "projects" | "usage"
    )
}

// ============================================================================
// FR-20 — the limits
// ============================================================================

/// Shared between the interrupt handler (owned by the runtime) and the host
/// closures (owned by the context). Both run on this one thread, so the atomics
/// are for ownership, not contention.
pub(super) struct Guard {
    /// Epoch-ms at which the CPU budget expires. PUSHED FORWARD by the duration
    /// of each blocking host call (FR-20).
    cpu_deadline: AtomicU64,
    wall_deadline: u64,
    io_calls: AtomicU32,
    fetch_calls: AtomicU32,
    read_state_calls: AtomicU32,
    /// Set by whichever limit tripped first, so the error names the real cause
    /// rather than whatever QuickJS reported downstream.
    tripped: StdMutex<Option<&'static str>>,
}

impl Guard {
    pub(super) fn new(now: u64) -> Self {
        Guard {
            cpu_deadline: AtomicU64::new(now + ISOLATE_CPU_DEADLINE_MS),
            wall_deadline: now + ISOLATE_WALL_DEADLINE_MS,
            io_calls: AtomicU32::new(0),
            fetch_calls: AtomicU32::new(0),
            read_state_calls: AtomicU32::new(0),
            tripped: StdMutex::new(None),
        }
    }

    pub(super) fn trip(&self, reason: &'static str) {
        let mut slot = self.tripped.lock().unwrap();
        if slot.is_none() {
            *slot = Some(reason);
        }
    }

    pub(super) fn reason(&self) -> Option<&'static str> {
        *self.tripped.lock().unwrap()
    }

    /// The interrupt handler QuickJS polls. `true` stops execution.
    pub(super) fn should_interrupt(&self) -> bool {
        let now = now_ms();
        if now > self.wall_deadline {
            self.trip(MSG_WALL);
            return true;
        }
        if now > self.cpu_deadline.load(Ordering::Relaxed) {
            self.trip(MSG_CPU);
            return true;
        }
        false
    }

    /// FR-20: has the whole-invocation clock run out? Trips the guard as a side
    /// effect so a plugin cannot swallow the refusal and report success.
    pub(super) fn wall_expired(&self) -> bool {
        if now_ms() > self.wall_deadline {
            self.trip(MSG_WALL);
            return true;
        }
        false
    }

    /// FR-20: give back the time spent blocked in a host call, so a slow network
    /// never reads as a runaway loop. The wall-clock deadline is NOT extended —
    /// that one exists precisely to bound total time including I/O.
    pub(super) fn credit_io(&self, elapsed_ms: u64) {
        self.cpu_deadline.fetch_add(elapsed_ms, Ordering::Relaxed);
    }

    /// FR-20: a budget breach KILLS the invocation, it does not merely reject the
    /// promise. `trip` is what makes it final: `run_inner` checks `reason()` even
    /// on an apparent success, so a plugin cannot catch the refusal, return a
    /// normal spec and have the invocation succeed. "Any breach kills the isolate
    /// and yields PLUGIN_RUNTIME_ERROR" is not satisfied by a catchable error.
    pub(super) fn charge_call(&self, method: &str) -> Result<(), &'static str> {
        if is_read_state(method) {
            if self.read_state_calls.fetch_add(1, Ordering::Relaxed) + 1 > READ_STATE_MAX_CALLS {
                self.trip(MSG_IO_CALLS);
                return Err(MSG_IO_CALLS);
            }
            return Ok(());
        }
        if !is_metered_io(method) {
            return Ok(());
        }
        if self.io_calls.fetch_add(1, Ordering::Relaxed) + 1 > ISOLATE_MAX_IO_CALLS {
            self.trip(MSG_IO_CALLS);
            return Err(MSG_IO_CALLS);
        }
        if method == "fetch"
            && self.fetch_calls.fetch_add(1, Ordering::Relaxed) + 1 > FETCH_MAX_PER_INVOCATION
        {
            self.trip(MSG_FETCHES);
            return Err(MSG_FETCHES);
        }
        Ok(())
    }
}

// ============================================================================
// FR-22 — the pool
// ============================================================================

/// At most `ISOLATE_MAX_CONCURRENT` isolates across all plugins, and at most one
/// in flight per plugin.
///
/// The per-plugin rule is a DROP, not a queue (FR-22 / §7 #24): a refresh tick
/// that arrives while the previous one is still running is discarded silently.
/// Queueing would let a slow plugin build an unbounded backlog of stale renders.
#[derive(Default)]
pub(crate) struct IsolatePool {
    state: StdMutex<PoolState>,
    slot_freed: Condvar,
}

#[derive(Default)]
pub(super) struct PoolState {
    running: usize,
    in_flight: std::collections::HashSet<String>,
}

pub(crate) struct PoolGuard<'a> {
    pool: &'a IsolatePool,
    plugin_id: String,
}

impl Drop for PoolGuard<'_> {
    fn drop(&mut self) {
        let mut state = self.pool.state.lock().unwrap();
        state.running -= 1;
        state.in_flight.remove(&self.plugin_id);
        drop(state);
        self.pool.slot_freed.notify_one();
    }
}

impl IsolatePool {
    /// `None` ⇒ this plugin already has an invocation in flight; the caller drops
    /// the tick. Otherwise blocks until a global slot frees.
    pub(crate) fn acquire(&self, plugin_id: &str) -> Option<PoolGuard<'_>> {
        let mut state = self.state.lock().unwrap();
        if state.in_flight.contains(plugin_id) {
            return None;
        }
        while state.running >= ISOLATE_MAX_CONCURRENT {
            state = self.slot_freed.wait(state).unwrap();
            // Re-check: another waiter for the SAME plugin may have started while
            // we were parked.
            if state.in_flight.contains(plugin_id) {
                return None;
            }
        }
        state.running += 1;
        state.in_flight.insert(plugin_id.to_string());
        Some(PoolGuard {
            pool: self,
            plugin_id: plugin_id.to_string(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin::testutil::iso::*;
    use serde_json::json;

    // ---------- FR-20: the limits ----------

    #[test]
    fn an_infinite_loop_trips_the_cpu_deadline() {
        // §7 #13. The isolate dies; the caller is unaffected.
        let started = Instant::now();
        let e = run_panel("export default { panel() { while (true) {} } }").unwrap_err();
        assert_eq!(e, MSG_CPU);
        assert!(
            started.elapsed().as_millis() < (ISOLATE_WALL_DEADLINE_MS + 2_000) as u128,
            "should trip on the CPU deadline, not the wall one"
        );
    }

    #[test]
    fn a_recursive_allocation_trips_a_limit_rather_than_taking_the_process_down() {
        // §7 #15. Whether the engine reports memory or the deadline first is not
        // the contract — that it STOPS, with a message, is.
        let e = run_panel("export default { panel() { const a = []; while (true) a.push(new Array(10000).fill('x')) } }")
            .unwrap_err();
        assert!(
            [MSG_MEMORY, MSG_CPU, MSG_WALL].contains(&e.as_str()),
            "unexpected: {e}"
        );
    }

    #[test]
    fn deep_recursion_is_caught_by_the_stack_limit() {
        let e = run_panel("export default { panel() { const f = () => f(); return f() } }")
            .unwrap_err();
        assert!(!e.is_empty(), "a stack overflow must surface as an error");
    }

    #[test]
    fn breaching_the_io_call_budget_kills_the_invocation() {
        // FR-20: "any breach KILLS the isolate and yields PLUGIN_RUNTIME_ERROR".
        // The plugin below catches the refusal and returns a perfectly good
        // spec — and must still fail, or the budget is advisory.
        let host = FakeHost::new(&[("storage.get", json!("v"))]);
        let e = run_isolate(
            r#"export default { async panel() {
                let ok = 0;
                for (let i = 0; i < 12; i++) {
                  try { await francois.storage.get('k'); ok++; } catch (e) { break; }
                }
                return { version: 1, nodes: [{ type: 'text', value: 'swallowed ' + ok }] };
            } }"#,
            PluginCapabilities::default(),
            host,
        )
        .unwrap_err();
        assert_eq!(e, MSG_IO_CALLS);
    }

    #[test]
    fn breaching_the_fetch_budget_kills_the_invocation() {
        // FR-20 again, for the tighter of the two counters.
        let caps = PluginCapabilities {
            network: Some(PluginNetwork {
                hosts: vec!["acme.dev".into()],
            }),
            ..Default::default()
        };
        let host = FakeHost::new(&[("fetch", json!({ "status": 200, "ok": true }))]);
        let e = run_isolate(
            r#"export default { async panel() {
                for (let i = 0; i < 6; i++) {
                  try { await francois.fetch('https://acme.dev/x'); } catch (e) {}
                }
                return { version: 1, nodes: [] };
            } }"#,
            caps,
            host,
        )
        .unwrap_err();
        assert_eq!(e, MSG_FETCHES);
    }

    #[test]
    fn read_state_calls_carry_their_own_budget() {
        // FR-22: `diff.summary` spawns a git process and `sessions.list` locks
        // and serializes every session. Unmetered, this loop runs for the whole
        // wall clock — and because each blocking call credits its duration back
        // to the CPU deadline, that one never fires either.
        let caps = PluginCapabilities {
            read_state: Some(true),
            ..Default::default()
        };
        let host = FakeHost::new(&[("diff.summary", json!({ "files": [] }))]);
        let e = run_isolate(
            r#"export default { async panel() {
                for (let i = 0; i < 500; i++) {
                  try { await francois.diff.summary('s1'); } catch (e) {}
                }
                return { version: 1, nodes: [] };
            } }"#,
            caps,
            host,
        )
        .unwrap_err();
        assert_eq!(e, MSG_IO_CALLS);
    }

    #[test]
    fn an_honest_panels_read_state_calls_are_never_metered_out() {
        // The budget has to be invisible to a panel that reads what it needs and
        // renders — a handful of calls per invocation.
        let caps = PluginCapabilities {
            read_state: Some(true),
            ..Default::default()
        };
        let host = FakeHost::new(&[("sessions.list", json!([]))]);
        let v = run_isolate(
            r#"export default { async panel() {
                for (let i = 0; i < 8; i++) await francois.sessions.list();
                return { version: 1, nodes: [{ type: 'text', value: 'ok' }] };
            } }"#,
            caps,
            host,
        )
        .unwrap();
        assert_eq!(v["nodes"][0]["value"], "ok");
    }

    #[test]
    fn logging_is_not_metered_against_the_io_budget() {
        // FR-26: the log ring is in memory — metering it would make a debug line
        // cost a fetch.
        let host = FakeHost::new(&[("storage.get", json!("v"))]);
        let v = run_isolate(
            r#"export default { async panel() {
                for (let i = 0; i < 50; i++) francois.log('noise', i);
                await francois.storage.get('k');
                return { version: 1, nodes: [{ type: 'text', value: 'ok' }] };
            } }"#,
            PluginCapabilities::default(),
            host,
        )
        .unwrap();
        assert_eq!(v["nodes"][0]["value"], "ok");
    }

    #[test]
    fn time_spent_blocked_in_a_host_call_does_not_burn_the_cpu_deadline() {
        // FR-20's pause. Four calls of 700 ms each is 2.8 s of wall time — well
        // past the 2 s CPU deadline — but none of it is the plugin computing.
        let host = FakeHost::slow(&[("storage.get", json!("v"))], 700);
        let v = run_isolate(
            r#"export default { async panel() {
                for (let i = 0; i < 4; i++) await francois.storage.get('k');
                return { version: 1, nodes: [{ type: 'text', value: 'survived' }] };
            } }"#,
            PluginCapabilities::default(),
            host,
        )
        .unwrap();
        assert_eq!(v["nodes"][0]["value"], "survived");
    }

    #[test]
    fn the_wall_clock_deadline_still_bounds_a_slow_host() {
        // §7 #14: the CPU pause must NOT make an invocation unbounded.
        let host = FakeHost::slow(&[("storage.get", json!("v"))], 1_500);
        let started = Instant::now();
        let e = run_isolate(
            r#"export default { async panel() {
                for (let i = 0; i < 8; i++) await francois.storage.get('k');
                return { version: 1, nodes: [] };
            } }"#,
            PluginCapabilities::default(),
            host,
        )
        .unwrap_err();
        assert_eq!(e, MSG_WALL);
        assert!(
            started.elapsed().as_secs() < 20,
            "the wall deadline must actually bound it"
        );
    }

    #[test]
    fn nothing_survives_between_invocations() {
        // FR-17: a fresh runtime + context each time.
        let source = r#"export default { panel() {
            globalThis.__leak = (globalThis.__leak || 0) + 1;
            return { version: 1, nodes: [{ type: 'text', value: String(globalThis.__leak) }] };
        } }"#;
        for _ in 0..3 {
            assert_eq!(run_panel(source).unwrap()["nodes"][0]["value"], "1");
        }
    }

    // ---------- FR-22: the pool ----------

    #[test]
    fn a_second_invocation_for_the_same_plugin_is_dropped_not_queued() {
        // §7 #24: a tick that arrives while one is in flight is discarded.
        let pool = IsolatePool::default();
        let first = pool.acquire("acme-ci").expect("first should start");
        assert!(pool.acquire("acme-ci").is_none(), "same plugin ⇒ dropped");
        assert!(
            pool.acquire("other").is_some(),
            "a different plugin is free"
        );
        drop(first);
        assert!(pool.acquire("acme-ci").is_some(), "released on drop");
    }

    #[test]
    fn the_pool_caps_total_concurrency() {
        let pool = IsolatePool::default();
        let mut held = Vec::new();
        for i in 0..ISOLATE_MAX_CONCURRENT {
            held.push(pool.acquire(&format!("p{i}")).expect("under the cap"));
        }
        // The next one for a NEW plugin must wait, so prove it does not return
        // immediately by racing it against a release.
        let released = Arc::new(std::sync::atomic::AtomicBool::new(false));
        std::thread::scope(|s| {
            let flag = Arc::clone(&released);
            s.spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(120));
                flag.store(true, Ordering::SeqCst);
                held.pop(); // frees one slot
            });
            let guard = pool.acquire("late").expect("eventually admitted");
            assert!(
                released.load(Ordering::SeqCst),
                "acquire returned before a slot was freed"
            );
            drop(guard);
        });
    }
}
