//! workflow-details: the AppHandle half of the feature — the `notify` watch on
//! a run directory (FR-6), the `workflow.detail` emissions, and the attribution
//! of a parked ask to the run that raised it (FR-20..FR-24).
//!
//! Everything PURE lives next door in `workflow_details/` (the scan, the
//! detail projection, the ladder, the attributed-set bookkeeping); this file
//! only locks → computes → drops the lock → emits, which is the file-wide rule
//! the whole `session` module follows.
//!
//! The watch mirrors `diff/watch.rs`: one recursive `notify` watcher, a burst
//! coalesced by a 300 ms debounce, and a handle whose DROP is what stops both
//! the filesystem events and the debounce thread (the channel disconnects).
//! The handle lives on the run's `ScanEntry`, so there is at most one watch per
//! run and dropping the entry stops it.

use super::*;

use notify::{RecursiveMode, Watcher};
use serde::Serialize;
use serde_json::Value;
use std::path::Path;
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

/// FR-6: every burst of filesystem events inside this window becomes ONE flush.
const WATCH_DEBOUNCE_MS: u64 = 300;

// ---------- francois:workflows:event (§5) ----------

/// contract WorkflowDetailEvent — a tagged union with exactly one arm today,
/// declared as one so a second event never changes the wire shape.
#[derive(Serialize, Clone, PartialEq, Debug)]
#[serde(tag = "type")]
pub(crate) enum WorkflowDetailEvent {
    #[serde(rename = "workflow.detail")]
    Detail {
        #[serde(rename = "sessionId")]
        session_id: String,
        detail: WorkflowDetail,
    },
}

pub(crate) fn emit_workflow_event(app: &AppHandle, ev: WorkflowDetailEvent) {
    let _ = app.emit(WORKFLOW_EVENT_CHANNEL, ev);
}

// ---------- FR-6: the watch ----------

/// Block until the first event, then swallow everything that lands within
/// `window` — a burst of writes becomes exactly one flush. `false` ⇔ the
/// watcher was dropped (the channel disconnected) and the loop is over.
fn wait_debounced(rx: &Receiver<()>, window: Duration) -> bool {
    if rx.recv().is_err() {
        return false;
    }
    loop {
        match rx.recv_timeout(window) {
            Ok(()) => continue,
            Err(RecvTimeoutError::Timeout) => return true,
            Err(RecvTimeoutError::Disconnected) => return false,
        }
    }
}

/// FR-5/FR-6: rescan the run directory and emit the whole detail. Returns
/// whether the watch should keep running — a terminal run gets exactly ONE
/// final flush and then stops, and a run that no longer resolves stops at once.
pub(crate) fn flush_workflow_detail(app: &AppHandle, run_id: &str) -> bool {
    let engine = app.state::<Engine>();
    let Ok(detail) = compute_detail(&engine, run_id) else {
        stop_workflow_watch(&engine, run_id); // gone, or never had a directory
        return false;
    };
    let terminal = run_is_terminal(&engine, run_id);
    emit_workflow_event(
        app,
        WorkflowDetailEvent::Detail {
            session_id: detail.session_id.clone(),
            detail,
        },
    );
    if terminal {
        stop_workflow_watch(&engine, run_id);
    }
    !terminal
}

/// FR-6: start the recursive watch on a run's directory. At most one per run —
/// a second `workflows_detail` finds the handle already parked on the run's
/// `ScanEntry` and does nothing.
pub(crate) fn start_workflow_watch(app: &AppHandle, run_id: &str, dir: &str) {
    if watch_is_running(app, run_id) {
        return;
    }
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    let mut watcher =
        match notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            if res.is_ok() {
                let _ = tx.send(());
            }
        }) {
            Ok(w) => w,
            Err(_) => return, // FR-10: no watcher is a stale tab, never an error
        };
    if watcher
        .watch(Path::new(dir), RecursiveMode::Recursive)
        .is_err()
    {
        return;
    }
    {
        // Re-checked under the lock: two `workflows_detail` calls can race here,
        // and the loser's watcher is dropped rather than left running blind.
        let engine = app.state::<Engine>();
        let mut scans = engine.workflow_scans.lock().unwrap();
        let entry = scans.entry(run_id.to_string()).or_default();
        if entry.watcher.is_some() {
            return;
        }
        entry.watcher = Some(watcher);
    }
    let (app, run_id) = (app.clone(), run_id.to_string());
    std::thread::spawn(move || {
        while wait_debounced(&rx, Duration::from_millis(WATCH_DEBOUNCE_MS)) {
            if !flush_workflow_detail(&app, &run_id) {
                break; // the run went terminal: that flush was the last one
            }
        }
    });
}

fn watch_is_running(app: &AppHandle, run_id: &str) -> bool {
    let engine = app.state::<Engine>();
    let mut scans = engine.workflow_scans.lock().unwrap();
    scans
        .entry(run_id.to_string())
        .or_default()
        .watcher
        .is_some()
}

/// Drop a run's watcher — that drop is what ends the filesystem events and the
/// debounce thread. The scan STATE is kept: the tab can still read the run, and
/// re-opening it restarts the watch from the offsets already consumed (FR-5).
pub(crate) fn stop_workflow_watch(engine: &Engine, run_id: &str) {
    if let Some(entry) = engine.workflow_scans.lock().unwrap().get_mut(run_id) {
        entry.watcher = None;
    }
}

/// FR-6: a session was removed — every watch of its runs stops, and the asks
/// attributed to them go with it. Nothing is left pointing at a run that no
/// longer exists.
pub(crate) fn unwatch_session_workflows(engine: &Engine, run_ids: &[String]) {
    {
        let mut scans = engine.workflow_scans.lock().unwrap();
        for id in run_ids {
            scans.remove(id);
        }
    }
    let mut asks = engine.workflow_asks.lock().unwrap();
    for id in run_ids {
        asks.remove(id);
    }
}

/// FR-6: the app is exiting — drop every watcher (and with it every debounce
/// thread). Called from `kill_all`.
pub(crate) fn stop_all_workflow_watches(engine: &Engine) {
    engine.workflow_scans.lock().unwrap().clear();
}

// ---------- FR-20..FR-24: attributing a parked ask ----------

/// FR-20: offer a just-parked ask to the attribution ladder. Called from
/// `handle_control_request` AFTER the ask is parked, never instead of it
/// (FR-21): everything here is additive, and a miss leaves the ask exactly as it
/// behaves today — a SESSION card, resolved by the existing commands under the
/// existing exactly-once claim.
pub(crate) fn attribute_workflow_ask(
    app: &AppHandle,
    session_id: &str,
    v: &Value,
    block_id: &str,
    kind: &str,
    tool_name: Option<&str>,
) {
    let engine = app.state::<Engine>();
    let seen = seen_agents(&engine);
    let found = {
        let map = engine.sessions.lock().unwrap();
        map.get(session_id).and_then(|s| attribute_ask(s, v, &seen))
    };
    let Some(a) = found else {
        return; // rung 4: not a workflow ask, and this feature ignores it
    };
    let ask = WorkflowPendingAsk {
        block_id: block_id.to_string(),
        kind: kind.to_string(),
        agent_id: a.agent_id,
        tool_name: tool_name.map(|t| t.to_string()),
        confidence: a.confidence,
    };
    let pushed = {
        let mut asks = engine.workflow_asks.lock().unwrap();
        push_ask(&mut asks, &a.run_id, ask)
    };
    let Some(n) = pushed else {
        return; // already attributed
    };
    emit_ask_count(app, session_id, &a.run_id, n);
    // FR-23: immediately — a blocked run produces no filesystem activity for the
    // 300 ms debounce to wait on.
    flush_workflow_detail(app, &a.run_id);
}

/// FR-22/FR-26: an attributed ask is gone — answered (here or in the SESSION
/// tab), cancelled by the CLI, or orphaned when the turn ended. Dropping it
/// restores the agent's disk-derived status and tells the tab at once. A
/// `blockId` that was never attributed is a no-op.
pub(crate) fn remove_workflow_ask(app: &AppHandle, session_id: &str, block_id: &str) {
    let engine = app.state::<Engine>();
    let dropped = {
        let mut asks = engine.workflow_asks.lock().unwrap();
        drop_ask(&mut asks, block_id)
    };
    let Some((run_id, remaining)) = dropped else {
        return;
    };
    emit_ask_count(app, session_id, &run_id, remaining);
    flush_workflow_detail(app, &run_id); // FR-23, the same immediacy
}

/// FR-24: mirror the run's ask count onto its `WorkflowRun` and emit it, so the
/// pane [6] card reads `waiting on you` without subscribing to this feature.
fn emit_ask_count(app: &AppHandle, session_id: &str, run_id: &str, n: u32) {
    let updated = app
        .state::<Engine>()
        .with_session_mut(session_id, |s| set_pending_asks(s, run_id, n))
        .flatten();
    emit_workflow_updates(app, updated.into_iter().collect());
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::testutil::test_workflow_run;
    use serde_json::json;

    #[test]
    fn a_burst_of_events_is_coalesced_into_one_flush() {
        // FR-6: exactly one `workflow.detail` per 300 ms window — the debounce
        // swallows the rest of the burst rather than emitting per write.
        let (tx, rx) = std::sync::mpsc::channel::<()>();
        for _ in 0..5 {
            tx.send(()).unwrap();
        }
        let window = Duration::from_millis(30);
        assert!(wait_debounced(&rx, window)); // one flush for all five
        drop(tx);
        // …and nothing was left queued behind it: the next wait sees only the
        // disconnect, which is the signal to stop the loop.
        assert!(!wait_debounced(&rx, window));
    }

    #[test]
    fn a_dropped_watcher_ends_the_debounce_loop() {
        let (tx, rx) = std::sync::mpsc::channel::<()>();
        drop(tx);
        assert!(!wait_debounced(&rx, Duration::from_millis(30)));
    }

    #[test]
    fn the_detail_event_serializes_the_contract_shape() {
        let detail = build_detail(
            &test_workflow_run(),
            "s1",
            "/tmp/run-1",
            true,
            &ScanState::default(),
            &[],
        );
        let v = serde_json::to_value(WorkflowDetailEvent::Detail {
            session_id: "s1".into(),
            detail,
        })
        .unwrap();
        assert_eq!(v["type"], "workflow.detail");
        assert_eq!(v["sessionId"], "s1");
        assert_eq!(v["detail"]["id"], "w1");
        assert_eq!(v["detail"]["transcriptDir"], "/tmp/run-1");
        assert_eq!(v["detail"]["hasScript"], true);
        assert_eq!(v["detail"]["agents"], json!([]));
        assert_eq!(v["detail"]["pendingAsks"], json!([]));
    }
}
