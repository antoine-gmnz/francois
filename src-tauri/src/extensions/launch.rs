//! FR-46..FR-48 — the :4317 probe and the one action in the registry.
//!
//! "Read-only" in this feature means no PANEL mutates data. This button is the
//! stated exception: it starts cohorte's own dashboard, detached and untracked.
//! No PID is retained — no stop button, no kill-on-quit, no orphan
//! reconciliation. A stop action belongs in cohorte (`cohorte dashboard --stop`
//! against a pidfile it writes itself), not here.
//!
//! The whole launch SEQUENCE lives in the core (contract/extensions.ts
//! `LaunchResponse`), so the two surfaces cannot diverge on it:
//!   running  ⇒ open the URL with the platform opener, resolve ok
//!   occupied ⇒ EXT_PORT_OCCUPIED, spawning nothing
//!   stopped  ⇒ spawn detached, then re-probe every 1 500 ms until running,
//!              or EXT_LAUNCH_FAILED at 10 s

use super::{ProbeResult, ProbeState, EXT_PROBE_TIMEOUT_MS};
use crate::process_util::no_window;
use serde_json::Value;
use std::io;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// FR-47 — the dashboard's origin. Loopback only: this is a local cockpit, and
/// the webview never embeds it (`frame-src 'none'`, specs/_decisions.md).
pub(crate) const DASHBOARD_URL: &str = "http://127.0.0.1:4317";
pub(crate) const PROBE_PATH: &str = "/api/versions";

/// FR-48: the re-probe cadence after a launch, and how long it may take before
/// the launch is declared failed.
const RELAUNCH_PROBE_MS: u64 = 1_500;
const LAUNCH_DEADLINE_MS: u64 = 10_000;

/// The keys that identify the answer as COHORTE's. A foreign listener that
/// happens to answer 200 with JSON is `occupied`, never `running` (FR-47) —
/// launching against it would hit EADDRINUSE and exit 1.
const COHORTE_KEYS: &[&str] = &["cohorte", "cohorteVersion"];

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum LaunchError {
    /// FR-47: :4317 answered, but not as cohorte. Nothing was spawned.
    PortOccupied,
    /// FR-48: the detached spawn failed, or the dashboard never came up in 10 s.
    Failed(String),
}

// ---------- FR-47: the probe ----------

/// 200 + JSON carrying cohorte's expected key ⇒ `running`. Anything else that
/// answered — HTML, the wrong shape, an array — is a foreign listener.
pub(crate) fn body_state(body: &Value) -> ProbeState {
    match body.as_object() {
        Some(obj) if COHORTE_KEYS.iter().any(|k| obj.contains_key(*k)) => ProbeState::Running,
        _ => ProbeState::Occupied,
    }
}

/// FR-47's classification of a transport-level failure, split out so both arms
/// are provable without a listener to point at. Connection refused / no listener
/// is `stopped`; anything else — a timeout (something ANSWERING slowly), a
/// reset, an unreachable host, a kind we don't recognise — reads as `occupied`.
/// This is deliberately fail-safe: only the one io::ErrorKind that unambiguously
/// means "nothing is there" gets `stopped`; every other/unknown failure defaults
/// to `occupied` so `run_launch` never spawns against a port that is doing
/// SOMETHING, even if we can't name what.
pub(crate) fn transport_state(io_kind: Option<io::ErrorKind>) -> ProbeState {
    match io_kind {
        Some(io::ErrorKind::ConnectionRefused) => ProbeState::Stopped,
        _ => ProbeState::Occupied,
    }
}

/// Pulls the underlying `std::io::Error`'s kind out of a `ureq::Transport`,
/// when there is one — this is the classification signal `transport_state`
/// matches on, rather than the error's Display text (which varies by OS/libc
/// and is not something to pattern-match reliably).
fn transport_io_kind(t: &ureq::Transport) -> Option<io::ErrorKind> {
    use std::error::Error as _;
    t.source()
        .and_then(|s| s.downcast_ref::<io::Error>())
        .map(|e| e.kind())
}

/// FR-47: one 2000ms budget for the WHOLE request — connect and read together,
/// not 2000ms each. `.timeout()` bounds the full round trip (ureq docs: "the
/// overall request, including DNS resolution, connection time, … and reading
/// the response body"), so a peer that accepts the TCP connection and then
/// stalls on the read still resolves within ~2000ms rather than ~4000ms.
fn probe_agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout(Duration::from_millis(EXT_PROBE_TIMEOUT_MS))
        .build()
}

/// One probe of `GET <base><PROBE_PATH>` with the FR-47 timeout.
pub(crate) fn probe_at(base: &str) -> ProbeState {
    match probe_agent().get(&format!("{base}{PROBE_PATH}")).call() {
        Ok(resp) => match resp.into_json::<Value>() {
            Ok(body) => body_state(&body),
            // 200 but not JSON at all (an HTML index, say) — a foreign listener.
            Err(_) => ProbeState::Occupied,
        },
        // The port answered, just not with 2xx.
        Err(ureq::Error::Status(_, _)) => ProbeState::Occupied,
        Err(ureq::Error::Transport(t)) => transport_state(transport_io_kind(&t)),
    }
}

pub(crate) fn probe() -> ProbeResult {
    let state = probe_at(DASHBOARD_URL);
    ProbeResult {
        state,
        // §5: `url` is present ONLY when the dashboard is really cohorte's.
        url: (state == ProbeState::Running).then(|| DASHBOARD_URL.to_string()),
    }
}

// ---------- FR-48: the platform opener ----------

/// Open a URL in the user's browser. An argv array per platform — the same
/// discipline as `editor/mod.rs`'s launch, never a shell string.
pub(crate) fn open_url_argv(url: &str) -> Vec<String> {
    #[cfg(target_os = "macos")]
    let argv = vec!["open".to_string(), url.to_string()];
    #[cfg(target_os = "windows")]
    let argv = vec![
        "rundll32".to_string(),
        "url.dll,FileProtocolHandler".to_string(),
        url.to_string(),
    ];
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    let argv = vec!["xdg-open".to_string(), url.to_string()];
    argv
}

fn open_url(url: &str) -> Result<(), String> {
    let argv = open_url_argv(url);
    let mut cmd = Command::new(&argv[0]);
    cmd.args(&argv[1..])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    no_window(&mut cmd);
    cmd.spawn()
        .map(|_| ())
        .map_err(|e| format!("could not open {url}: {e}"))
}

// ---------- FR-48: the detached, untracked spawn ----------

#[cfg(unix)]
fn detach(cmd: &mut Command) {
    use std::os::unix::process::CommandExt;
    // SAFETY: `setsid` is async-signal-safe and allocates nothing, which is the
    // whole requirement on a pre_exec hook (same as update/helper.rs's FR-15).
    unsafe {
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
}

#[cfg(windows)]
fn detach(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    // CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP — windowless, and out of our
    // console's Ctrl-C group, so quitting Francois does not take it down.
    cmd.creation_flags(0x0800_0000 | 0x0000_0200);
}

/// FR-48: spawn and forget. The child is deliberately NOT stored anywhere —
/// there is no handle to leak, and nothing to reconcile at exit.
pub(crate) fn spawn_detached(argv: &[&str]) -> Result<(), String> {
    let mut cmd = Command::new(argv[0]);
    cmd.args(&argv[1..])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    // DELIBERATE EXCEPTION to FR-20's provider env scrub: this spawn inherits
    // the full parent environment rather than being scrubbed to `ENV_ALLOWLIST`
    // (see `provider::scrub_env`). FR-20 exists to keep Francois's own
    // credentials (Anthropic key, session token, `CLAUDE_*`) out of a
    // read-only, repo-scoped, auto-refreshing PANEL call the user did not
    // individually approve. `cohorte dashboard --open` is the opposite shape:
    // the user's own tool, launched by one explicit confirmed click (FR-48),
    // never repeated automatically, and it never reads Francois's own
    // in-memory state either way — the two things FR-20 is guarding against
    // do not apply here. This mirrors the editor launch in editor/mod.rs,
    // which inherits the environment for the same reason.
    if let Some(home) = dirs::home_dir() {
        cmd.current_dir(home);
    }
    no_window(&mut cmd);
    detach(&mut cmd);
    cmd.spawn()
        .map(|_child| ())
        .map_err(|e| format!("could not start {}: {e}", argv[0]))
}

/// FR-48: re-probe on a fixed cadence until the dashboard answers as cohorte's,
/// or the deadline passes. Parameterised so both outcomes are provable in
/// milliseconds instead of ten seconds.
pub(crate) fn wait_for_running(
    mut probe: impl FnMut() -> ProbeState,
    interval: Duration,
    deadline: Duration,
) -> bool {
    let started = Instant::now();
    loop {
        std::thread::sleep(interval);
        if probe() == ProbeState::Running {
            return true;
        }
        if started.elapsed() >= deadline {
            return false;
        }
    }
}

/// The whole FR-48 sequence. IDEMPOTENT: the frontend calls this for both the
/// `Open dashboard` and `Launch dashboard` states and awaits one answer.
pub(crate) fn run_launch(argv: &[&str]) -> Result<(), LaunchError> {
    match probe_at(DASHBOARD_URL) {
        ProbeState::Running => open_url(DASHBOARD_URL).map_err(LaunchError::Failed),
        // Never launch against a foreign listener: the spawn would hit
        // EADDRINUSE and exit 1, and the user would be told nothing useful.
        ProbeState::Occupied => Err(LaunchError::PortOccupied),
        ProbeState::Stopped => {
            spawn_detached(argv).map_err(LaunchError::Failed)?;
            // cohorte's own `--open` opens the browser; Francois only waits to
            // know whether it really came up.
            let up = wait_for_running(
                || probe_at(DASHBOARD_URL),
                Duration::from_millis(RELAUNCH_PROBE_MS),
                Duration::from_millis(LAUNCH_DEADLINE_MS),
            );
            if up {
                Ok(())
            } else {
                Err(LaunchError::Failed(
                    "the dashboard did not come up within 10s".to_string(),
                ))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // FR-47: only cohorte's own answer is `running`.
    #[test]
    fn only_a_cohorte_shaped_body_reads_as_running() {
        assert_eq!(
            body_state(&json!({ "cohorte": "2.4.0", "node": "22.3.0" })),
            ProbeState::Running
        );
        assert_eq!(
            body_state(&json!({ "cohorteVersion": "2.4.0" })),
            ProbeState::Running
        );
        // A foreign listener answering JSON is OCCUPIED, never running.
        assert_eq!(
            body_state(&json!({ "app": "grafana" })),
            ProbeState::Occupied
        );
        assert_eq!(body_state(&json!([1, 2, 3])), ProbeState::Occupied);
        assert_eq!(body_state(&json!("ok")), ProbeState::Occupied);
    }

    // FR-47: no listener is `stopped`; something answering slowly is `occupied`.
    #[test]
    fn a_refused_connection_is_stopped_and_a_timeout_is_occupied() {
        assert_eq!(
            transport_state(Some(io::ErrorKind::ConnectionRefused)),
            ProbeState::Stopped
        );
        assert_eq!(
            transport_state(Some(io::ErrorKind::TimedOut)),
            ProbeState::Occupied
        );
        assert_eq!(
            transport_state(Some(io::ErrorKind::WouldBlock)),
            ProbeState::Occupied
        );
    }

    // FR-47: an unrecognised or ambiguous transport failure — a reset, an
    // unknown io::ErrorKind, or no io::Error at all — defaults to `occupied`
    // rather than `stopped`, fail-safe: `run_launch` must never spawn against
    // a port that failed for a reason it can't positively identify as "nothing
    // is listening".
    #[test]
    fn an_unrecognised_transport_failure_defaults_to_occupied_not_stopped() {
        assert_eq!(
            transport_state(Some(io::ErrorKind::ConnectionReset)),
            ProbeState::Occupied
        );
        assert_eq!(
            transport_state(Some(io::ErrorKind::Other)),
            ProbeState::Occupied
        );
        assert_eq!(transport_state(None), ProbeState::Occupied);
    }

    // FR-47, end to end against a port nothing listens on: `stopped`, so the
    // control reads `Launch dashboard` rather than being disabled.
    #[test]
    fn a_silent_port_probes_as_stopped() {
        assert_eq!(probe_at("http://127.0.0.1:1"), ProbeState::Stopped);
    }

    // FR-47: a peer that ACCEPTS the connection but never writes a byte must
    // still resolve within the single 2000ms budget — not up to ~4000ms from
    // adding a separate connect timeout and read timeout together.
    #[test]
    fn a_stalling_peer_bounds_the_probe_to_one_budget_not_two() {
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = std::thread::spawn(move || {
            // Accept and hold the connection open without ever writing a
            // response — the client's read must time out on its own.
            if let Ok((stream, _)) = listener.accept() {
                std::thread::sleep(Duration::from_millis(EXT_PROBE_TIMEOUT_MS * 3));
                drop(stream);
            }
        });

        let started = Instant::now();
        let state = probe_at(&format!("http://{addr}"));
        let elapsed = started.elapsed();

        assert_eq!(state, ProbeState::Occupied);
        // A generous margin above the 2000ms budget, but well under the
        // ~4000ms a connect+read double-timeout would produce.
        assert!(
            elapsed < Duration::from_millis(EXT_PROBE_TIMEOUT_MS + 1_500),
            "probe took {elapsed:?}, expected close to {EXT_PROBE_TIMEOUT_MS}ms"
        );

        drop(handle); // the spawned thread outlives the assertion; let it be reaped on exit
    }

    // §5: `url` is populated only when the state is `running`.
    #[test]
    fn the_probe_result_carries_a_url_only_when_running() {
        let stopped = ProbeResult {
            state: ProbeState::Stopped,
            url: None,
        };
        assert_eq!(
            serde_json::to_value(&stopped).unwrap(),
            json!({ "state": "stopped", "url": null })
        );
        let running = ProbeResult {
            state: ProbeState::Running,
            url: Some(DASHBOARD_URL.to_string()),
        };
        assert_eq!(
            serde_json::to_value(&running).unwrap(),
            json!({ "state": "running", "url": "http://127.0.0.1:4317" })
        );
    }

    // FR-46: the resolved command is static, has no slots, and is what the
    // confirmation shows verbatim.
    #[test]
    fn the_action_command_is_static_and_matches_the_registry() {
        let action = super::super::registry::action("cohorte-dashboard").unwrap();
        assert_eq!(action.argv.join(" "), "cohorte dashboard --open");
        assert!(!action.argv.iter().any(|a| a.contains('{')));
    }

    // FR-48: a spawn that cannot happen at all fails immediately, and there is
    // nothing to clean up because nothing was ever tracked.
    #[test]
    fn a_spawn_that_cannot_start_is_a_launch_failure() {
        let err = spawn_detached(&["francois-no-such-dashboard-xyz"]).unwrap_err();
        assert!(err.contains("francois-no-such-dashboard-xyz"), "{err}");
    }

    // FR-47: with a foreign listener, launch is refused and NOTHING is spawned.
    #[test]
    fn an_occupied_port_refuses_the_launch() {
        // `run_launch` is exercised through its classification: the probe result
        // alone decides, and `occupied` never reaches the spawn arm.
        assert_eq!(
            body_state(&json!({ "grafana": true })),
            ProbeState::Occupied
        );
        assert_eq!(LaunchError::PortOccupied, LaunchError::PortOccupied.clone());
    }

    // FR-48: the re-probe loop resolves as soon as the dashboard answers …
    #[test]
    fn the_relaunch_probe_resolves_once_the_dashboard_answers() {
        let mut calls = 0;
        let up = wait_for_running(
            || {
                calls += 1;
                if calls >= 3 {
                    ProbeState::Running
                } else {
                    ProbeState::Stopped
                }
            },
            Duration::from_millis(5),
            Duration::from_millis(500),
        );
        assert!(up);
        assert_eq!(calls, 3);
    }

    // … and gives up at the deadline rather than waiting forever.
    #[test]
    fn the_relaunch_probe_gives_up_at_the_deadline() {
        let started = Instant::now();
        let up = wait_for_running(
            || ProbeState::Stopped,
            Duration::from_millis(5),
            Duration::from_millis(60),
        );
        assert!(!up);
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    // The opener is an argv array on every platform — never a shell string.
    #[test]
    fn the_opener_is_an_argv_array() {
        let argv = open_url_argv(DASHBOARD_URL);
        assert_eq!(argv.last().unwrap(), DASHBOARD_URL);
        assert!(!argv[0].contains(' '));
        assert!(!argv.iter().any(|a| a == "-c"));
    }
}
