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
//! function, stall detection) lives in `remote_discovery.rs`; this file owns the
//! process/thread lifecycle, the registry, and the state machine around them.

use super::*;

use crate::ipc::{err, ok, IpcResult};
use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};
use tauri::{AppHandle, Emitter, State};

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

// ---------- other pure helpers ----------

/// argv after `claude` for the host process. `resume` threads an EXISTING Claude
/// thread (so the conversation is continuous from Francois to the phone); otherwise
/// we mint the id ourselves with `--session-id` so the transcript path is known
/// before the child has said anything.
pub(crate) fn remote_args(thread_id: &str, resume: bool, name: &str) -> Vec<String> {
    vec![
        if resume { "--resume" } else { "--session-id" }.to_string(),
        thread_id.to_string(),
        "--remote-control".to_string(),
        name.to_string(),
    ]
}

// ---------- post-spawn teardown guard (C7) ----------

/// Reaps the freshly spawned child on every early return between `spawn_command`
/// succeeding and the child being handed off to the reader thread.
/// `portable_pty::Child` does NOT kill on drop by itself, and a host that never
/// reaches the registry can never be found by `kill_all_remote` — an authenticated
/// Remote Control host would then survive with a live remote session Francois has
/// no way to stop. `disarm()` releases the child once it is safely owned by a
/// thread that WILL reap it.
struct KillOnErr(Option<Box<dyn Child + Send + Sync>>);

impl KillOnErr {
    fn disarm(mut self) -> Box<dyn Child + Send + Sync> {
        self.0.take().expect("disarm called at most once")
    }
}

impl Drop for KillOnErr {
    fn drop(&mut self) {
        if let Some(mut c) = self.0.take() {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}

// ---------- commands ----------

/// francois:remote:start — spawn the Remote Control host for a session.
///
/// Resolves `starting`; the caller waits for `remote.status` to reach `active`.
/// Idempotent: an already-starting/active host is returned as-is rather than
/// spawning a second one (the CLI allows only one remote session per process).
#[tauri::command(async)]
pub fn remote_start(
    app: AppHandle,
    engine: State<'_, Engine>,
    reg: State<'_, RemoteRegistry>,
    session_id: String,
    name: Option<String>,
) -> IpcResult<RemoteStatus> {
    let mut map = reg.0.lock().unwrap();

    if let Some(entry) = map.get(&session_id) {
        let state = entry.state.lock().unwrap().clone();
        if matches!(
            state,
            RemoteState::Starting { .. } | RemoteState::Active { .. }
        ) {
            return ok(RemoteStatus { session_id, state });
        }
        // A dead host (failed) is replaced below — but only once we know the
        // session still exists (M8): removing it here, before that check, would
        // leave the registry at `off` while the frontend still shows `failed` if
        // the lookup below then returns SESSION_NOT_FOUND.
    }

    let Some((cwd, runtime, session_name, claude_session_id)) =
        engine.remote_target_of(&session_id)
    else {
        return err("SESSION_NOT_FOUND", "no such session");
    };

    if let Some(entry) = map.remove(&session_id) {
        // C4: tear the dead host down for real — a bare `remove` used to just drop
        // the entry, which drops the entry's only `ChildKiller` without ever
        // calling `kill()`, leaking the process.
        teardown_entry(entry);
    }

    let name = name
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| session_name.clone());
    // M2: never let a leading '-' turn the name into a CLI flag.
    let name = sanitize_name(&name, &session_name);

    // Resume the real thread when the session has one, so the phone picks up the
    // SAME conversation (durable-sessions persists `claudeSessionId`, so this
    // survives an app restart). Otherwise mint the id so we know the transcript path.
    let (thread_id, resume) = match claude_session_id {
        Some(id) if !id.is_empty() => (id, true),
        _ => (uuid::Uuid::new_v4().to_string(), false),
    };

    let (exe, argv) = claude_invocation(&runtime, &cwd, remote_args(&thread_id, resume, &name));

    let pty_system = native_pty_system();
    let pair = match pty_system.openpty(PtySize {
        // Wide enough that the CLI's footer/notice carrying the URL is not wrapped
        // mid-token, which would defeat `extract_url_from_output`.
        rows: 50,
        cols: 200,
        pixel_width: 0,
        pixel_height: 0,
    }) {
        Ok(p) => p,
        Err(e) => return err("PTY_ERROR", format!("could not open a pty: {e}")),
    };

    let mut cmd = CommandBuilder::new(&exe);
    for a in &argv {
        cmd.arg(a);
    }
    if runtime != "wsl" {
        cmd.cwd(&cwd); // wsl positions itself via `--cd` inside claude_invocation
    }
    for (k, v) in std::env::vars() {
        cmd.env(k, v);
    }
    cmd.env("TERM", "xterm-256color");
    if runtime == "wsl" {
        // H4: forward TERM across the wsl.exe boundary. This is the ONLY URL
        // source for the wsl runtime (spec §7 #7), so a TUI degraded by a missing
        // TERM breaks the feature there outright.
        cmd.env("WSLENV", wsl_term_env());
    }

    let child = match pair.slave.spawn_command(cmd) {
        Ok(c) => c,
        Err(e) => return err("SPAWN_FAILED", format!("could not start {exe}: {e}")),
    };
    drop(pair.slave);
    let mut guard = KillOnErr(Some(child));

    // C7: every fallible step from here to the registry insert goes through
    // `guard` — an early return drops it and reaps the child.
    let killer = guard.0.as_mut().unwrap().clone_killer();
    let reader = match pair.master.try_clone_reader() {
        Ok(r) => r,
        Err(e) => return err("PTY_ERROR", format!("could not read the host output: {e}")),
    };
    let watchdog_killer = guard.0.as_mut().unwrap().clone_killer();

    let started_at = now_ms();
    let state = Arc::new(Mutex::new(RemoteState::Starting {
        name: name.clone(),
        started_at,
    }));
    let stopped = Arc::new(AtomicBool::new(false));

    // H2: emit `starting` NOW, before any source thread exists to race ahead of
    // us — the transcript poller's first tick has no initial sleep, so publishing
    // `active` (or the watchdog publishing `failed`) before this emit used to be
    // possible, and this emit (unconditional, not lock-gated) would then land
    // AFTER it and permanently pin the badge on a stale `starting` (FR-11 makes
    // every OTHER transition single-shot, but this call bypassed that guard).
    emit_status(&app, &session_id, &state.lock().unwrap().clone());

    let mut child = guard.disarm();

    // Reader — URL detection + blocked-prompt detection (kills the child itself)
    // + EOF → failed. Draining the PTY is not optional: an unread master
    // eventually blocks the child. No deadline logic (the watchdog owns that).
    {
        let state = state.clone();
        let stopped = stopped.clone();
        let app = app.clone();
        let sid = session_id.clone();
        let mut reader = reader;
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            let mut carry = String::new();
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if stopped.load(Ordering::SeqCst) {
                            break;
                        }
                        let chunk = String::from_utf8_lossy(&buf[..n]).into_owned();
                        match feed(&mut carry, &chunk) {
                            Some(ReaderAction::Url(url)) => {
                                publish_active(&app, &sid, &state, &stopped, url);
                            }
                            Some(ReaderAction::Blocked(why)) => {
                                // Parked on a consent dialog — it will never
                                // register, and it will not exit on its own
                                // either. Fail now with the fix instead of after
                                // the deadline, and reap the child so it does not
                                // linger waiting for a keypress nobody will send.
                                fail_if_not_active(&app, &sid, &state, &stopped, why);
                                let _ = child.clone_killer().kill();
                                break;
                            }
                            None => {}
                        }
                    }
                }
            }
            let _ = child.wait();
            // The host exited. If it never published a URL, that is the failure
            // the user needs to see (bad auth, ineligible account, pruned thread…).
            if !stopped.load(Ordering::SeqCst) {
                fail_if_not_active(
                    &app,
                    &sid,
                    &state,
                    &stopped,
                    "the Remote Control host exited before publishing a session URL",
                );
            }
        });
    }

    // Watchdog — ALWAYS spawned, every runtime (C5: the deadline used to live
    // inside the native-only transcript thread, so a stalled wsl host — where the
    // PTY is the ONLY url source, FR-12 unconditional — read "connecting…"
    // forever). Holds its OWN killer (`clone_killer()` may be called more than
    // once) so it can kill the child itself: the deadline path never used to do
    // that, so a deadlined host would survive `remote_stop`/exit until something
    // else reaped it.
    {
        let mut watchdog_killer = watchdog_killer;
        let state = state.clone();
        let stopped = stopped.clone();
        let app = app.clone();
        let sid = session_id.clone();
        std::thread::spawn(move || {
            let deadline =
                SystemTime::UNIX_EPOCH + Duration::from_millis(started_at) + URL_DEADLINE;
            loop {
                if stopped.load(Ordering::SeqCst) {
                    return;
                }
                if !matches!(*state.lock().unwrap(), RemoteState::Starting { .. }) {
                    return; // the reader or the transcript poller already resolved it
                }
                if SystemTime::now() >= deadline {
                    fail_if_not_active(
                        &app,
                        &sid,
                        &state,
                        &stopped,
                        "Remote Control published no session URL before the deadline",
                    );
                    let _ = watchdog_killer.kill();
                    return;
                }
                std::thread::sleep(POLL_INTERVAL);
            }
        });
    }

    // Transcript poller (native only) — a pure URL source. No deadline logic (the
    // watchdog owns that).
    if runtime != "wsl" {
        if let Some(home) = dirs::home_dir() {
            let dir = home
                .join(".claude")
                .join("projects")
                .join(project_slug(&cwd));
            let expected = dir.join(format!("{thread_id}.jsonl"));
            let state = state.clone();
            let stopped = stopped.clone();
            let app = app.clone();
            let sid = session_id.clone();
            let since_ms = started_at;
            std::thread::spawn(move || {
                // C2: seed from the file's CURRENT length, not 0 — otherwise a
                // `--resume` of a previously remote-controlled thread has its
                // WHOLE existing transcript read on the first poll, and
                // `scan_transcript` returns the OLDEST `bridge_status` record: a
                // permanently dead URL is published (FR-8, and FR-11 makes it
                // stick).
                let mut offset = std::fs::metadata(&expected).map(|m| m.len()).unwrap_or(0);
                loop {
                    if stopped.load(Ordering::SeqCst) {
                        return;
                    }
                    if !matches!(*state.lock().unwrap(), RemoteState::Starting { .. }) {
                        return; // the PTY reader (or the watchdog) got there first
                    }
                    let (found, next) = tail_for_url(&expected, offset);
                    offset = next;
                    let url = found.or_else(|| scan_dir_for_url(&dir, &expected, since_ms));
                    if let Some(url) = url {
                        publish_active(&app, &sid, &state, &stopped, url);
                        return;
                    }
                    std::thread::sleep(POLL_INTERVAL);
                }
            });
        }
    }

    let status = RemoteStatus {
        session_id: session_id.clone(),
        state: state.lock().unwrap().clone(),
    };
    map.insert(
        session_id.clone(),
        RemoteEntry {
            killer,
            state,
            stopped,
            _master: pair.master,
        },
    );
    drop(map);

    ok(status)
}

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

    // ---- remote_args ----

    #[test]
    fn remote_args_resumes_an_existing_thread() {
        assert_eq!(
            remote_args("abc-123", true, "My Project"),
            vec!["--resume", "abc-123", "--remote-control", "My Project"]
        );
    }

    #[test]
    fn remote_args_mints_the_id_when_there_is_no_thread_yet() {
        assert_eq!(
            remote_args("fresh-uuid", false, "Francois"),
            vec!["--session-id", "fresh-uuid", "--remote-control", "Francois"]
        );
    }

    #[test]
    fn remote_args_never_uses_print_mode() {
        // Remote Control is a silent no-op under `-p` (verified live) — a regression
        // that reintroduced print mode here would "succeed" while doing nothing.
        let args = remote_args("x", true, "n");
        assert!(!args.iter().any(|a| a == "-p" || a == "--print"));
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

    /// LIVE end-to-end check of the one thing unit tests cannot fake: that an
    /// interactive `claude --remote-control` in a PTY really registers a remote
    /// session and publishes its URL where this module looks for it.
    ///
    /// `#[ignore]` because it needs a logged-in claude.ai subscription and network,
    /// and it briefly creates a REAL remote session on the account. Run with:
    ///   cargo test --  --ignored live_pty_host_publishes_a_session_url --nocapture
    #[test]
    #[ignore = "live: needs claude.ai auth + network; creates a real remote session"]
    fn live_pty_host_publishes_a_session_url() {
        // Must be a directory where `claude` has already been run interactively —
        // otherwise the host parks on a trust/MCP consent dialog (see
        // `blocking_prompt`) and never registers. Override with FRANCOIS_RC_PROBE_CWD.
        let cwd = std::env::var("FRANCOIS_RC_PROBE_CWD").unwrap_or_else(|_| {
            std::env::current_dir()
                .unwrap()
                .to_string_lossy()
                .to_string()
        });
        let thread_id = uuid::Uuid::new_v4().to_string();
        let (exe, argv) = claude_invocation(
            "native",
            &cwd,
            remote_args(&thread_id, false, "Francois live probe"),
        );

        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 50,
                cols: 200,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty");
        let mut cmd = CommandBuilder::new(&exe);
        for a in &argv {
            cmd.arg(a);
        }
        cmd.cwd(&cwd);
        for (k, v) in std::env::vars() {
            cmd.env(k, v);
        }
        cmd.env("TERM", "xterm-256color");
        let mut child = pair.slave.spawn_command(cmd).expect("spawn claude");
        drop(pair.slave);

        // Drain the master, mirroring the production reader: an unread PTY blocks
        // the child. Also the wsl-runtime URL source, so assert on it too.
        let mut reader = pair.master.try_clone_reader().expect("reader");
        let seen = Arc::new(Mutex::new(String::new()));
        {
            let seen = seen.clone();
            std::thread::spawn(move || {
                let mut buf = [0u8; 8192];
                while let Ok(n) = reader.read(&mut buf) {
                    if n == 0 {
                        break;
                    }
                    seen.lock()
                        .unwrap()
                        .push_str(&String::from_utf8_lossy(&buf[..n]));
                }
            });
        }

        let dir = dirs::home_dir()
            .unwrap()
            .join(".claude")
            .join("projects")
            .join(project_slug(&cwd));
        let transcript = dir.join(format!("{thread_id}.jsonl"));

        // Poll BOTH sources each tick and stop at the first hit — production races
        // them the same way, and a fresh `--session-id` host has no transcript at all
        // until its first turn, so waiting out the deadline on the transcript alone
        // would be 120s of nothing.
        let deadline = SystemTime::now() + URL_DEADLINE;
        let mut from_transcript = None;
        let mut from_output = None;
        let mut offset = 0u64;
        while SystemTime::now() < deadline {
            let (found, next) = tail_for_url(&transcript, offset);
            offset = next;
            from_transcript = found;
            from_output = extract_url_from_output(&seen.lock().unwrap().clone());
            if from_transcript.is_some() || from_output.is_some() {
                break;
            }
            std::thread::sleep(POLL_INTERVAL);
        }

        // Always tear the real remote session down before asserting.
        let _ = child.clone_killer().kill();
        let _ = child.wait();

        let url = from_transcript.clone().or_else(|| from_output.clone());
        if url.is_none() {
            let normalized = normalize_pty(&seen.lock().unwrap().clone());
            if let Some(why) = blocking_prompt(&normalized) {
                panic!("host stalled on a consent dialog, not a code defect: {why}");
            }
            panic!(
                "no session URL from either source.\n  transcript: {}\n  normalized output: {}",
                transcript.display(),
                normalized.chars().take(1500).collect::<String>()
            );
        }
        let url = url.unwrap();
        assert!(
            url.starts_with("https://claude.ai/code/session_"),
            "unexpected url shape: {url}"
        );
        eprintln!("live URL: {url}\n  transcript source: {from_transcript:?}\n  output source: {from_output:?}");
    }
}
