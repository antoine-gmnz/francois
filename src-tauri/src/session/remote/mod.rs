//! remote-control (specs/remote-control.md) — Francois HOSTS Claude Code's native
//! Remote Control for a session.
//!
//! Francois spawns an interactive `claude [--resume <id>|--session-id <id>]
//! --remote-control <name>` in a PTY it owns, then learns the claude.ai session URL
//! from two independent sources, whichever lands first:
//!
//!  1. **The CLI's own transcript** — when Remote Control goes live the CLI appends
//!     `{"type":"system","subtype":"bridge_status","url":"https://claude.ai/code/session_…"}`
//!     to `~/.claude/projects/<slug>/<threadId>.jsonl`. Verified live on CLI
//!     2.1.212 / 2.1.215 / 2.1.217. This is the structured, ANSI-free source.
//!  2. **The PTY stream** — the TUI also prints the URL in plain text. Covers the
//!     `wsl` runtime, where the transcript lives inside the distro rather than the
//!     Windows-side `~/.claude`.
//!
//! Why a PTY and not the usual per-turn `claude -p` (turn.rs): Remote Control is a
//! no-op in print mode. Verified — `claude -p --remote-control …` is accepted
//! silently, registers no session and emits no URL. It needs a real interactive
//! process, so this module keeps one alive per remote-controlled session.
//!
//! Direction note: only Anthropic's web/mobile clients can DRIVE a Remote Control
//! session (outbound HTTPS to api.anthropic.com, no local protocol, no inbound
//! port). Francois is the host, never the remote client.
//!
//! Pure URL-discovery logic (transcript/PTY-output parsing, the reader's decision
//! function, stall detection) lives in `remote_discovery.rs`. This file owns the
//! contract shapes, the registry, and the state machine around them — the one
//! remaining concern, spawning and wiring a host process (`remote_start` plus its
//! thread helpers), is `start.rs`; re-exported here so every existing
//! `session::remote_start` path keeps resolving unchanged.

use super::*;

use crate::ipc::{ok, IpcResult};
use portable_pty::{ChildKiller, MasterPty};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

mod start;
pub(crate) use start::*;

const EVENT_CHANNEL_REMOTE: &str = "francois://remote/event";

/// How long the host may take to publish a URL before we call it failed.
/// Registration is a network round-trip plus a full interactive startup (hooks,
/// MCP servers, plugin sync), so this is generous on purpose.
const URL_DEADLINE: Duration = Duration::from_secs(120);
const POLL_INTERVAL: Duration = Duration::from_millis(250);

// ---------- contract shapes (contract/remote-control.ts, mirrored by hand) ----------

/// contract AppError — mirrored locally because `crate::ipc::AppError` is not
/// `Clone` and this one is carried inside cloneable state. Same JSON shape.
#[derive(Serialize, Clone)]
pub(crate) struct RemoteError {
    pub(crate) code: String,
    pub(crate) message: String,
}

/// contract RemoteControlState — tagged on `phase`.
#[derive(Serialize, Clone)]
#[serde(tag = "phase", rename_all = "camelCase")]
pub(crate) enum RemoteState {
    Off,
    #[serde(rename_all = "camelCase")]
    Starting {
        name: String,
        started_at: u64,
    },
    #[serde(rename_all = "camelCase")]
    Active {
        name: String,
        started_at: u64,
        url: String,
    },
    #[serde(rename_all = "camelCase")]
    Failed {
        name: String,
        error: RemoteError,
    },
}

/// contract RemoteControlStatus.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteStatus {
    pub(crate) session_id: String,
    pub(crate) state: RemoteState,
}

/// contract RemoteControlEvent — `francois://remote/event`.
#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
enum RemoteEvent {
    #[serde(rename = "remote.status", rename_all = "camelCase")]
    Status {
        session_id: String,
        state: RemoteState,
    },
}

// ---------- registry ----------

struct RemoteEntry {
    killer: Box<dyn ChildKiller + Send + Sync>,
    state: Arc<Mutex<RemoteState>>,
    stopped: Arc<AtomicBool>,
    /// Held so the master side stays open for the lifetime of the host.
    _master: Box<dyn MasterPty + Send>,
}

#[derive(Default)]
pub struct RemoteRegistry(Mutex<std::collections::HashMap<String, RemoteEntry>>);

// ---------- pure state transitions (unit-tested) ----------

/// `starting` → `active`, once. Both URL sources (and, indirectly, the deadline
/// watchdog) race, so the transition is guarded: whichever arrives once the state
/// has already moved on is a no-op. An already-`active` host that later gets a
/// SECOND url candidate keeps the first (FR-11); an already-`failed` one stays
/// failed.
pub(crate) fn to_active(cur: &RemoteState, url: String) -> Option<RemoteState> {
    match cur {
        RemoteState::Starting { name, started_at } => Some(RemoteState::Active {
            name: name.clone(),
            started_at: *started_at,
            url,
        }),
        _ => None,
    }
}

/// `starting` → `failed`, once. An already-active host that later exits keeps its
/// URL rather than being retro-marked failed (FR-14) — `stop` is what clears it.
pub(crate) fn to_failed(cur: &RemoteState, message: &str) -> Option<RemoteState> {
    match cur {
        RemoteState::Starting { name, .. } => Some(RemoteState::Failed {
            name: name.clone(),
            error: RemoteError {
                code: "REMOTE_CONTROL_FAILED".to_string(),
                message: message.to_string(),
            },
        }),
        _ => None,
    }
}

// ---------- commands ----------

/// francois:remote:stop — kill the host. Idempotent; always resolves `off`.
#[tauri::command(async)]
pub fn remote_stop(
    app: AppHandle,
    reg: State<'_, RemoteRegistry>,
    session_id: String,
) -> IpcResult<RemoteStatus> {
    if let Some(entry) = reg.0.lock().unwrap().remove(&session_id) {
        teardown_entry(entry);
    }
    let status = RemoteStatus {
        session_id,
        state: RemoteState::Off,
    };
    emit_status(&app, &status.session_id, &status.state);
    ok(status)
}

/// francois:remote:get — current host state for a session.
#[tauri::command(async)]
pub fn remote_get(reg: State<'_, RemoteRegistry>, session_id: String) -> IpcResult<RemoteStatus> {
    let state = reg
        .0
        .lock()
        .unwrap()
        .get(&session_id)
        .map(|e| e.state.lock().unwrap().clone())
        .unwrap_or(RemoteState::Off);
    ok(RemoteStatus { session_id, state })
}

// ---------- teardown / emission ----------

/// C4/M8: the single place that flags `stopped` and kills the process — reused by
/// `remote_stop` and by `remote_start`'s replace-a-dead-host path (a bare
/// `map.remove` used to drop the entry's only `ChildKiller` without ever calling
/// `kill()`, leaking the process). Order matters: flag first so a still-running
/// reader/watchdog/poller thread does not report the kill as a spontaneous
/// failure; the state is set to `off` last so any thread holding this Arc sees a
/// terminal state and stops on its own.
fn teardown_entry(mut entry: RemoteEntry) {
    entry.stopped.store(true, Ordering::SeqCst);
    let _ = entry.killer.kill();
    *entry.state.lock().unwrap() = RemoteState::Off;
}

fn emit_status(app: &AppHandle, session_id: &str, state: &RemoteState) {
    let _ = app.emit(
        EVENT_CHANNEL_REMOTE,
        RemoteEvent::Status {
            session_id: session_id.to_string(),
            state: state.clone(),
        },
    );
}

/// `starting` → `active`, once (see `to_active`).
///
/// H1: `stopped` is checked UNDER THE SAME LOCK the state mutation happens under,
/// and the emit happens before the lock is released. Emitting after releasing the
/// lock used to let this interleave: reader passes a `stopped` check taken BEFORE
/// the lock → writes `Active`, drops lock → a concurrent `remote_stop` completes
/// (state `Off`, emits `off`, entry removed) → reader's emit of `active` lands
/// LAST. Doing both under one lock guarantees whichever of the two writers
/// (`teardown_entry`, which also locks this same mutex) runs second observes —
/// and its emission is — the one the client ends up seeing.
fn publish_active(
    app: &AppHandle,
    session_id: &str,
    state: &Arc<Mutex<RemoteState>>,
    stopped: &Arc<AtomicBool>,
    url: String,
) {
    let mut cur = state.lock().unwrap();
    if stopped.load(Ordering::SeqCst) {
        return;
    }
    if let Some(next) = to_active(&cur, url) {
        *cur = next;
        emit_status(app, session_id, &cur);
    }
}

/// `starting` → `failed`, once (see `to_failed`). Same lock-scoped `stopped` check
/// and in-lock emit as `publish_active` (H1) — see there for why.
fn fail_if_not_active(
    app: &AppHandle,
    session_id: &str,
    state: &Arc<Mutex<RemoteState>>,
    stopped: &Arc<AtomicBool>,
    message: &str,
) {
    let mut cur = state.lock().unwrap();
    if stopped.load(Ordering::SeqCst) {
        return;
    }
    if let Some(next) = to_failed(&cur, message) {
        *cur = next;
        emit_status(app, session_id, &cur);
    }
}

/// Kill every Remote Control host (app exit). The hosts are real interactive
/// `claude` processes — leaking them would leave orphaned remote sessions live on
/// the user's account.
pub fn kill_all_remote(app: &AppHandle) {
    use tauri::Manager;
    let Some(reg) = app.try_state::<RemoteRegistry>() else {
        return;
    };
    for (_, mut entry) in reg.0.lock().unwrap().drain() {
        entry.stopped.store(true, Ordering::SeqCst);
        let _ = entry.killer.kill();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- to_active / to_failed: the state machine's only transitions ----

    fn starting() -> RemoteState {
        RemoteState::Starting {
            name: "n".into(),
            started_at: 1,
        }
    }

    fn active() -> RemoteState {
        RemoteState::Active {
            name: "n".into(),
            started_at: 1,
            url: "https://claude.ai/code/session_01AB".into(),
        }
    }

    fn failed() -> RemoteState {
        RemoteState::Failed {
            name: "n".into(),
            error: RemoteError {
                code: "REMOTE_CONTROL_FAILED".into(),
                message: "boom".into(),
            },
        }
    }

    #[test]
    fn to_active_transitions_starting_once() {
        let next = to_active(&starting(), "https://claude.ai/code/session_01AB".into())
            .expect("starting -> active");
        match next {
            RemoteState::Active { url, .. } => {
                assert_eq!(url, "https://claude.ai/code/session_01AB")
            }
            _ => panic!("expected Active"),
        }
    }

    #[test]
    fn to_active_is_a_no_op_once_already_active() {
        // FR-11: both url sources race; whichever lands second must not overwrite
        // the winner's URL.
        assert!(to_active(&active(), "https://claude.ai/code/session_ZZ".into()).is_none());
    }

    #[test]
    fn to_active_is_a_no_op_on_failed_or_off() {
        assert!(to_active(&failed(), "https://claude.ai/code/session_01AB".into()).is_none());
        assert!(to_active(
            &RemoteState::Off,
            "https://claude.ai/code/session_01AB".into()
        )
        .is_none());
    }

    #[test]
    fn to_failed_transitions_starting_once() {
        let next = to_failed(&starting(), "why").expect("starting -> failed");
        match next {
            RemoteState::Failed { error, .. } => assert_eq!(error.message, "why"),
            _ => panic!("expected Failed"),
        }
    }

    #[test]
    fn to_failed_is_a_no_op_once_already_active() {
        // FR-14: a host that exits AFTER going active keeps its url — only `stop`
        // (which routes through `teardown_entry`, not `to_failed`) clears it.
        assert!(to_failed(&active(), "host exited").is_none());
    }

    #[test]
    fn to_failed_is_a_no_op_on_failed_or_off() {
        assert!(to_failed(&failed(), "why").is_none());
        assert!(to_failed(&RemoteState::Off, "why").is_none());
    }

    // ---- state serialization: the contract is a phase-tagged union ----

    #[test]
    fn state_serializes_as_the_contract_union() {
        let off = serde_json::to_value(RemoteState::Off).unwrap();
        assert_eq!(off, serde_json::json!({ "phase": "off" }));

        let starting = serde_json::to_value(RemoteState::Starting {
            name: "My Project".into(),
            started_at: 1_784_573_689_516,
        })
        .unwrap();
        assert_eq!(
            starting,
            serde_json::json!({
                "phase": "starting",
                "name": "My Project",
                "startedAt": 1_784_573_689_516u64
            })
        );

        let active = serde_json::to_value(RemoteState::Active {
            name: "n".into(),
            started_at: 1,
            url: "https://claude.ai/code/session_01AB".into(),
        })
        .unwrap();
        assert_eq!(
            active,
            serde_json::json!({
                "phase": "active",
                "name": "n",
                "startedAt": 1,
                "url": "https://claude.ai/code/session_01AB"
            })
        );

        let failed = serde_json::to_value(RemoteState::Failed {
            name: "n".into(),
            error: RemoteError {
                code: "REMOTE_CONTROL_FAILED".into(),
                message: "boom".into(),
            },
        })
        .unwrap();
        assert_eq!(
            failed,
            serde_json::json!({
                "phase": "failed",
                "name": "n",
                "error": { "code": "REMOTE_CONTROL_FAILED", "message": "boom" }
            })
        );
    }

    #[test]
    fn status_and_event_serialize_camel_case() {
        let status = serde_json::to_value(RemoteStatus {
            session_id: "s1".into(),
            state: RemoteState::Off,
        })
        .unwrap();
        assert_eq!(
            status,
            serde_json::json!({ "sessionId": "s1", "state": { "phase": "off" } })
        );

        let event = serde_json::to_value(RemoteEvent::Status {
            session_id: "s1".into(),
            state: RemoteState::Off,
        })
        .unwrap();
        assert_eq!(
            event,
            serde_json::json!({
                "type": "remote.status",
                "sessionId": "s1",
                "state": { "phase": "off" }
            })
        );
    }
}
