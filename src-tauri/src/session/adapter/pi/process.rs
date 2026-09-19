//! session/adapter/pi/process.rs — FR-1/FR-7/FR-10: turning a
//! `RuntimeConnectContext` into a running, certified Pi child. `discovery`
//! (pi-runtime-distribution) already answers "is a compatible Pi installed
//! and where" — this module only spends that answer: resolve the certified
//! path, build the baseline-locked-down argv, spawn it through
//! `process_util`'s facade (login-shell PATH, `CREATE_NO_WINDOW`, its own
//! process group so `process_util::kill_tree` can reach grandchildren), and
//! hand the dispatcher plain `Read`/`Write` handles plus a `wait`/`kill` pair
//! — it never sees a `Child` itself.

use crate::ipc::{AppError, ErrorCode};
use crate::session::adapter::RuntimeConnectContext;
use std::io::Read;
use std::process::{Child, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// FR-2/FR-8: the sanitized stderr ring's cap. Diagnostics only — never the
/// stdout wire protocol, and never surfaced to the frontend verbatim.
const STDERR_RING_BYTES: usize = 64 * 1024;

// ---------------------------------------------------------------- argv

/// FR-1/FR-6/FR-10: the baseline, locked-down Pi RPC argv. `--no-extensions`
/// and the absence of any `-e` are unconditional (FR-10: "Do not invoke `pi
/// install`/`pi update`" and never pass extension args in this MVP);
/// `--no-approve` is unconditional too — the session's project-resource
/// choice that could relax it (task 09) does not exist on
/// `RuntimeConnectContext` yet, so there is nothing to read permission from.
/// `ctx.resume` carries FR-6's recorded reference for a reconnect — its
/// absence means a fresh Pi conversation, never a silent new-thread fallback
/// disguised as a resume.
pub(crate) fn pi_args(ctx: &RuntimeConnectContext) -> Vec<String> {
    let mut args = vec![
        "--mode".into(),
        "rpc".into(),
        "--provider".into(),
        ctx.model.provider_id.clone(),
        "--model".into(),
        ctx.model.model_id.clone(),
        "--no-extensions".into(),
        "--no-approve".into(),
    ];
    if let Some(reference) = &ctx.resume {
        args.push("--resume".into());
        args.push(reference.clone());
    }
    args
}

// ---------------------------------------------------------------- spawn

/// What the dispatcher needs from a spawned child: its two pipes as trait
/// objects (so tests can substitute an in-memory duplex with no real process
/// at all — see `dispatcher`'s tests), plus a `wait`/`kill` pair over the
/// TRACKED process tree (FR-7).
pub(crate) struct ProcessHandle {
    pub(crate) stdin: Box<dyn std::io::Write + Send>,
    pub(crate) stdout: Box<dyn Read + Send>,
    /// FR-7: block up to `timeout` for the child to exit on its own; `true`
    /// if it had (or already had, if called again).
    pub(crate) wait_timeout: Box<dyn FnMut(Duration) -> bool + Send>,
    /// FR-7: terminate the TRACKED process tree, not just the direct child.
    pub(crate) kill: Box<dyn FnMut() + Send>,
    /// FR-2/FR-8: the bounded, sanitized stderr ring — read for diagnostics
    /// only, never for wire-protocol data.
    pub(crate) stderr_ring: Arc<Mutex<Vec<u8>>>,
}

/// FR-1: resolve the certified executable, build the baseline argv, and
/// spawn it in `ctx.cwd` — the session's OWN working directory/worktree,
/// which is what makes it an "owned session directory": no two concurrent
/// Pi children ever share one. Never touches the session lock (it doesn't
/// have one) and never blocks past the spawn itself.
pub(crate) fn spawn(ctx: &RuntimeConnectContext) -> Result<ProcessHandle, AppError> {
    let status =
        super::discovery::probe_installation(&ctx.runtime, ctx.worktree_distro.as_deref(), false)?;
    if status.state != super::discovery::InstallState::Ready {
        return Err(status.error.unwrap_or_else(|| {
            AppError::new(ErrorCode::RuntimeUnavailable, "Pi is not available")
        }));
    }
    let exe = status.executable_path.ok_or_else(|| {
        AppError::new(
            ErrorCode::RuntimeUnavailable,
            "Pi reported ready with no resolved executable path",
        )
    })?;

    let mut child = crate::process_util::spawn(&exe)
        .args(pi_args(ctx))
        .current_dir(&ctx.cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .configure(crate::process_util::own_process_group)
        .start()
        .map_err(|e| {
            AppError::new(
                ErrorCode::RuntimeUnavailable,
                format!("could not start pi: {e}"),
            )
        })?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| AppError::new(ErrorCode::RuntimeProtocolError, "pi child has no stdin"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::new(ErrorCode::RuntimeProtocolError, "pi child has no stdout"))?;
    let stderr = child.stderr.take();

    let stderr_ring: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
    if let Some(stderr) = stderr {
        let ring = stderr_ring.clone();
        std::thread::spawn(move || drain_stderr_ring(stderr, ring));
    }

    let child = Arc::new(Mutex::new(child));
    let wait_child = child.clone();
    let kill_child = child.clone();
    Ok(ProcessHandle {
        stdin: Box::new(stdin),
        stdout: Box::new(stdout),
        wait_timeout: Box::new(move |timeout| wait_for_exit(&wait_child, timeout)),
        kill: Box::new(move || crate::process_util::kill_tree(&mut kill_child.lock().unwrap())),
        stderr_ring,
    })
}

/// FR-7's "waits up to 5s": poll `try_wait` rather than the blocking `wait`,
/// so the caller keeps its own deadline rather than trusting the OS to honor
/// one.
fn wait_for_exit(child: &Arc<Mutex<Child>>, timeout: Duration) -> bool {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        if matches!(child.lock().unwrap().try_wait(), Ok(Some(_))) {
            return true;
        }
        if std::time::Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// FR-2/FR-8: drain stderr on its own thread (so a chatty child can never
/// block stdout draining) into a bounded ring — oldest bytes drop first, the
/// diagnostics reader only ever wants the tail.
fn drain_stderr_ring(mut stderr: impl Read, ring: Arc<Mutex<Vec<u8>>>) {
    let mut buf = [0u8; 4096];
    loop {
        match stderr.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                let mut r = ring.lock().unwrap();
                r.extend_from_slice(&buf[..n]);
                if r.len() > STDERR_RING_BYTES {
                    let drop = r.len() - STDERR_RING_BYTES;
                    r.drain(..drop);
                }
            }
        }
    }
}

/// FR-8: a bounded, control-character-free snippet safe to write to the
/// diagnostics log — never the raw ring content, never prompt text.
pub(crate) fn sanitize_diagnostic(text: &str, max_chars: usize) -> String {
    text.chars()
        .filter(|c| !c.is_control() || *c == ' ')
        .take(max_chars)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::adapter::{RuntimeLaunchPolicy, RuntimeModelRef, RuntimeProfileSnapshot};

    fn ctx(resume: Option<&str>) -> RuntimeConnectContext {
        RuntimeConnectContext {
            session_id: crate::ids::uuid(),
            cwd: env!("CARGO_MANIFEST_DIR").into(),
            runtime: "native".into(),
            worktree_distro: None,
            account_id: crate::ids::uuid(),
            launch_policy: RuntimeLaunchPolicy {
                permission_mode: "default".into(),
                allow_git: false,
            },
            profile_snapshot: RuntimeProfileSnapshot {
                system_prompt: None,
                extra_args: Vec::new(),
            },
            model: RuntimeModelRef {
                provider_id: "anthropic".into(),
                model_id: "claude-x".into(),
            },
            resume: resume.map(String::from),
        }
    }

    #[test]
    fn baseline_argv_always_locks_extensions_and_approval_off() {
        let args = pi_args(&ctx(None));
        assert!(args.windows(2).any(|w| w == ["--mode", "rpc"]));
        assert!(args.windows(2).any(|w| w == ["--provider", "anthropic"]));
        assert!(args.windows(2).any(|w| w == ["--model", "claude-x"]));
        assert!(args.iter().any(|a| a == "--no-extensions"));
        assert!(args.iter().any(|a| a == "--no-approve"));
        assert!(!args.iter().any(|a| a == "-e"));
        assert!(!args.iter().any(|a| a == "--resume"));
    }

    #[test]
    fn a_recorded_reference_becomes_an_explicit_resume_flag() {
        let args = pi_args(&ctx(Some("pi-ref-1")));
        assert!(args.windows(2).any(|w| w == ["--resume", "pi-ref-1"]));
    }

    #[test]
    fn a_missing_certified_pi_fails_spawn_with_the_discovery_verdict() {
        // No real Pi is installed on the test host, so this exercises the
        // "not ready" branch honestly rather than assuming a fixture.
        let err = spawn(&ctx(None)).err().unwrap();
        assert!(matches!(
            err.code,
            ErrorCode::RuntimeUnavailable | ErrorCode::RuntimeIncompatible
        ));
    }

    /// FR-2/FR-8 + acceptance §9 "stderr flood remain[s] bounded":
    /// `drain_stderr_ring` must never let the ring grow past
    /// `STDERR_RING_BYTES`, and must keep the TAIL (most recent bytes) once
    /// it starts dropping, not the head.
    #[test]
    fn drain_stderr_ring_stays_bounded_under_a_flood_and_keeps_the_tail() {
        struct Flood {
            remaining: usize,
        }
        impl Read for Flood {
            fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                if self.remaining == 0 {
                    return Ok(0); // EOF
                }
                let n = buf.len().min(self.remaining);
                // Fill with an ascending byte pattern so the tail is
                // identifiable once the ring has been trimmed.
                for (i, b) in buf[..n].iter_mut().enumerate() {
                    let offset = (STDERR_RING_BYTES * 3 - self.remaining + i) % 256;
                    *b = offset as u8;
                }
                self.remaining -= n;
                Ok(n)
            }
        }
        let total = STDERR_RING_BYTES * 3;
        let ring: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
        drain_stderr_ring(Flood { remaining: total }, ring.clone());
        let bytes = ring.lock().unwrap();
        assert!(bytes.len() <= STDERR_RING_BYTES);
        assert!(!bytes.is_empty());
        // The last byte written by the flood must be the last byte in the
        // ring — proof the TAIL survived, not an arbitrary earlier chunk.
        let expected_last = ((total - 1) % 256) as u8;
        assert_eq!(*bytes.last().unwrap(), expected_last);
    }

    #[test]
    fn sanitize_diagnostic_strips_control_characters_and_bounds_length() {
        let out = sanitize_diagnostic("safe\ntext\x07here", 100);
        assert!(!out.contains('\n'));
        assert!(!out.contains('\u{7}'));
        assert_eq!(sanitize_diagnostic(&"x".repeat(50), 10).len(), 10);
    }
}
