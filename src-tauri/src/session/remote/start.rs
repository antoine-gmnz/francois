//! `francois:remote:start` — the one concern `mod.rs` carves out: resolving the
//! host's argv/name/thread, opening the PTY, spawning the interactive `claude
//! --remote-control` process on it, and wiring the three background threads
//! (reader, watchdog, transcript poller) that race to publish its session URL.
//! Everything here funnels into `remote_start`, the module's single command.

use super::*;
use crate::ipc::{err, ok, IpcResult};
use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, MasterPty, PtySize};
use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};
use tauri::{AppHandle, State};

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

/// Resolves the caller-supplied Remote Control name: trims and falls back to
/// the session's own name when blank, then sanitizes so it can never be read
/// as a CLI flag (M2: a leading '-' would turn the name into one).
pub(crate) fn resolve_host_name(name: Option<String>, session_name: &str) -> String {
    let name = name
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| session_name.to_string());
    sanitize_name(&name, session_name)
}

/// Resolves the thread to run Remote Control on: resumes the session's real
/// Claude thread when it has one, so the phone picks up the SAME conversation
/// (durable-sessions persists `claudeSessionId`, so this survives an app
/// restart). Otherwise mints a fresh id so the transcript path is known
/// before the child has said anything.
pub(crate) fn resolve_thread_id(claude_session_id: Option<String>) -> (String, bool) {
    match claude_session_id {
        Some(id) if !id.is_empty() => (id, true),
        _ => (uuid::Uuid::new_v4().to_string(), false),
    }
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

// ---------- spawning the host process ----------

/// A freshly spawned Remote Control host plus the handles `remote_start` needs
/// to keep (registry entry, watchdog) or hand off to the reader thread. Mirrors
/// the previous inline body of `remote_start` verbatim — only named, with the
/// per-step `match { ... return err(...) }` folded into `Result`'s `?`.
struct SpawnedHost {
    master: Box<dyn MasterPty + Send>,
    reader: Box<dyn Read + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    watchdog_killer: Box<dyn ChildKiller + Send + Sync>,
    /// Still wrapped in the C7 teardown guard — `remote_start` disarms it once
    /// the entry is safely on its way into the registry.
    guard: KillOnErr,
}

/// Opens the PTY, builds argv/env exactly like a normal turn
/// (`claude_invocation`), and spawns the interactive `claude --remote-control`
/// host on it. C7: every fallible step here goes through `KillOnErr` — an
/// early `?` return drops it and reaps the child, so a half-spawned host never
/// survives past this function.
fn spawn_host_process(
    exe: &str,
    argv: &[String],
    cwd: &str,
    runtime: &str,
) -> Result<SpawnedHost, (&'static str, String)> {
    let pair = native_pty_system()
        .openpty(PtySize {
            // Wide enough that the CLI's footer/notice carrying the URL is not
            // wrapped mid-token, which would defeat `extract_url_from_output`.
            rows: 50,
            cols: 200,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|err| ("PTY_ERROR", format!("could not open a pty: {err}")))?;

    let mut cmd = CommandBuilder::new(exe);
    for arg in argv {
        cmd.arg(arg);
    }
    if runtime != "wsl" {
        cmd.cwd(cwd); // wsl positions itself via `--cd` inside claude_invocation
    }
    for (k, v) in std::env::vars() {
        cmd.env(k, v);
    }
    cmd.env("TERM", "xterm-256color");
    if let Some(path) = claude_path_env() {
        cmd.env("PATH", path);
    }
    if runtime == "wsl" {
        // H4: forward TERM across the wsl.exe boundary. This is the ONLY URL
        // source for the wsl runtime (spec §7 #7), so a TUI degraded by a missing
        // TERM breaks the feature there outright.
        cmd.env("WSLENV", wsl_term_env());
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|err| ("SPAWN_FAILED", format!("could not start {exe}: {err}")))?;
    drop(pair.slave);
    let mut guard = KillOnErr(Some(child));

    // C7: every fallible step from here to the return goes through `guard` — an
    // early return drops it and reaps the child.
    let killer = guard.0.as_mut().unwrap().clone_killer();
    let reader = pair.master.try_clone_reader().map_err(|err| {
        (
            "PTY_ERROR",
            format!("could not read the host output: {err}"),
        )
    })?;
    let watchdog_killer = guard.0.as_mut().unwrap().clone_killer();

    Ok(SpawnedHost {
        master: pair.master,
        reader,
        killer,
        watchdog_killer,
        guard,
    })
}

// ---------- the three background threads ----------

/// Reader thread: drains the host's PTY output for the plain-text URL a fresh
/// session prints (the ONLY source for the wsl runtime — see the module doc)
/// and for a stalled consent dialog, which this thread kills the child for
/// since the host would otherwise wait forever for a keypress nobody will
/// send. Also the thing that notices the host exiting without ever going
/// active. Draining the PTY is not optional: an unread master eventually
/// blocks the child. No deadline logic (the watchdog owns that).
fn spawn_reader_thread(
    app: AppHandle,
    session_id: String,
    state: Arc<Mutex<RemoteState>>,
    stopped: Arc<AtomicBool>,
    mut reader: Box<dyn Read + Send>,
    mut child: Box<dyn Child + Send + Sync>,
) {
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
                            publish_active(&app, &session_id, &state, &stopped, url);
                        }
                        Some(ReaderAction::Blocked(why)) => {
                            // Parked on a consent dialog — it will never
                            // register, and it will not exit on its own
                            // either. Fail now with the fix instead of after
                            // the deadline, and reap the child so it does not
                            // linger waiting for a keypress nobody will send.
                            fail_if_not_active(&app, &session_id, &state, &stopped, why);
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
                &session_id,
                &state,
                &stopped,
                "the Remote Control host exited before publishing a session URL",
            );
        }
    });
}

/// Watchdog thread: ALWAYS spawned, every runtime (C5: the deadline used to
/// live inside the native-only transcript thread, so a stalled wsl host —
/// where the PTY is the ONLY url source, FR-12 unconditional — read
/// "connecting…" forever). Holds its OWN killer (`clone_killer()` may be
/// called more than once) so it can kill the child itself: the deadline path
/// never used to do that, so a deadlined host would survive
/// `remote_stop`/exit until something else reaped it.
fn spawn_watchdog_thread(
    app: AppHandle,
    session_id: String,
    state: Arc<Mutex<RemoteState>>,
    stopped: Arc<AtomicBool>,
    mut killer: Box<dyn ChildKiller + Send + Sync>,
    started_at: u64,
) {
    std::thread::spawn(move || {
        let deadline = SystemTime::UNIX_EPOCH + Duration::from_millis(started_at) + URL_DEADLINE;
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
                    &session_id,
                    &state,
                    &stopped,
                    "Remote Control published no session URL before the deadline",
                );
                let _ = killer.kill();
                return;
            }
            std::thread::sleep(POLL_INTERVAL);
        }
    });
}

/// Transcript poller thread (native runtime only — the PTY reader is the sole
/// url source for wsl, wired by the caller): a pure URL source, tailing
/// `~/.claude/projects/<slug>/<threadId>.jsonl` for the `bridge_status` record
/// Remote Control appends once it goes live. No deadline logic here (the
/// watchdog owns that). No-ops if `dirs::home_dir()` is unavailable.
fn spawn_transcript_poller_thread(
    app: AppHandle,
    session_id: String,
    state: Arc<Mutex<RemoteState>>,
    stopped: Arc<AtomicBool>,
    cwd: String,
    thread_id: String,
    started_at: u64,
) {
    let Some(home) = dirs::home_dir() else {
        return;
    };
    let dir = home
        .join(".claude")
        .join("projects")
        .join(project_slug(&cwd));
    let expected = dir.join(format!("{thread_id}.jsonl"));
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
            let url = found.or_else(|| scan_dir_for_url(&dir, &expected, started_at));
            if let Some(url) = url {
                publish_active(&app, &session_id, &state, &stopped, url);
                return;
            }
            std::thread::sleep(POLL_INTERVAL);
        }
    });
}

// ---------- the command ----------

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

    let Some((cwd, runtime, session_name, claude_session_id, worktree_distro)) =
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

    let name = resolve_host_name(name, &session_name);
    let (thread_id, resume) = resolve_thread_id(claude_session_id);
    let (exe, argv) = claude_invocation(
        &runtime,
        &cwd,
        remote_args(&thread_id, resume, &name),
        worktree_distro.as_deref(),
    );

    let host = match spawn_host_process(&exe, &argv, &cwd, &runtime) {
        Ok(host) => host,
        Err((code, message)) => return err(code, message),
    };

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

    let child = host.guard.disarm();

    spawn_reader_thread(
        app.clone(),
        session_id.clone(),
        state.clone(),
        stopped.clone(),
        host.reader,
        child,
    );
    spawn_watchdog_thread(
        app.clone(),
        session_id.clone(),
        state.clone(),
        stopped.clone(),
        host.watchdog_killer,
        started_at,
    );
    if runtime != "wsl" {
        spawn_transcript_poller_thread(
            app.clone(),
            session_id.clone(),
            state.clone(),
            stopped.clone(),
            cwd.clone(),
            thread_id.clone(),
            started_at,
        );
    }

    let status = RemoteStatus {
        session_id: session_id.clone(),
        state: state.lock().unwrap().clone(),
    };
    map.insert(
        session_id.clone(),
        RemoteEntry {
            killer: host.killer,
            state,
            stopped,
            _master: host.master,
        },
    );
    drop(map);

    ok(status)
}

#[cfg(test)]
mod tests {
    use super::*;

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

    // ---- resolve_host_name / resolve_thread_id: pulled out of remote_start ----

    #[test]
    fn resolve_host_name_prefers_the_trimmed_caller_name() {
        assert_eq!(
            resolve_host_name(Some("  My Host  ".to_string()), "fallback"),
            "My Host"
        );
    }

    #[test]
    fn resolve_host_name_falls_back_to_the_session_name_when_blank() {
        assert_eq!(
            resolve_host_name(Some("   ".to_string()), "fallback"),
            "fallback"
        );
        assert_eq!(resolve_host_name(None, "fallback"), "fallback");
    }

    #[test]
    fn resolve_host_name_sanitizes_a_leading_dash() {
        // M2: a leading '-' would otherwise be read as a CLI flag.
        assert!(!resolve_host_name(Some("-x".to_string()), "fallback").starts_with('-'));
    }

    #[test]
    fn resolve_thread_id_resumes_an_existing_thread() {
        assert_eq!(
            resolve_thread_id(Some("abc-123".to_string())),
            ("abc-123".to_string(), true)
        );
    }

    #[test]
    fn resolve_thread_id_mints_a_fresh_id_when_there_is_none() {
        let (id, resume) = resolve_thread_id(None);
        assert!(!resume);
        assert!(uuid::Uuid::parse_str(&id).is_ok());
    }

    #[test]
    fn resolve_thread_id_mints_a_fresh_id_when_the_existing_one_is_empty() {
        let (id, resume) = resolve_thread_id(Some(String::new()));
        assert!(!resume);
        assert!(uuid::Uuid::parse_str(&id).is_ok());
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
            None,
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
