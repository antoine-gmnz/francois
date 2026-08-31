//! Provider execution (unchanged from `extensions` FR-19..FR-24), and the
//! extension-install FR-21/FR-23 `lines` adapter.
//!
//! Everything a provider is allowed to be happens here: an argv ARRAY (never a
//! shell string), a scrubbed environment, a cwd pinned to the panel's declared
//! root, closed stdin, a 10 s timeout, a 4 MiB output cap, and an app-wide
//! semaphore of four in-flight processes.
//!
//! There is no `sh -c` and no shell interpretation anywhere on the path from a
//! manifest to a spawn: `render_args` substitutes `${offset}`/`${limit}`
//! (Rust-rendered numbers) and `${token}` (a value that has already passed
//! `TOKEN_PATTERN`) into literal, compiled-once argv elements — never through
//! a shell, and never by concatenating raw provider or repo text.

use super::schema::sanitize_field;
use super::{ProviderSpec, EXT_OUTPUT_CAP_BYTES, EXT_STDERR_MAX_CHARS, EXT_TIMEOUT_MS};
use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

/// The four FR-24/FR-21/FR-22 failure causes.
#[derive(Debug, Clone, PartialEq)]
pub enum ProviderError {
    Missing { argv0: String },
    Timeout { timeout_ms: u64 },
    Exit { code: i32, stderr: String },
    Capped { cap_bytes: usize },
}

// ---------- FR-23: the app-wide semaphore of 4 ----------

static SLOTS: OnceLock<(Mutex<usize>, Condvar)> = OnceLock::new();

fn slots() -> &'static (Mutex<usize>, Condvar) {
    SLOTS.get_or_init(|| (Mutex::new(0), Condvar::new()))
}

pub struct Slot;

impl Drop for Slot {
    fn drop(&mut self) {
        let (lock, cv) = slots();
        let mut n = lock.lock().unwrap();
        *n = n.saturating_sub(1);
        cv.notify_one();
    }
}

pub fn acquire_slot(limit: usize) -> Slot {
    let (lock, cv) = slots();
    let mut n = lock.lock().unwrap();
    while *n >= limit {
        n = cv.wait(n).unwrap();
    }
    *n += 1;
    Slot
}

#[cfg(test)]
pub(crate) fn in_flight() -> usize {
    *slots().0.lock().unwrap()
}

// ---------- FR-19: argv assembly ----------

/// Substitute `${offset}`/`${limit}`/`${token}` in a template argv element.
/// `token` renders empty (dropping nothing — the element stays, just without
/// its slot filled) when `None`; callers that must drop the whole element
/// when no token is present do so themselves (log-tail's own `process_argv`).
pub fn render_arg(template: &str, offset: u32, limit: u32, token: Option<&str>) -> String {
    let mut out = template.replace("${offset}", &offset.to_string());
    out = out.replace("${limit}", &limit.to_string());
    if let Some(token) = token {
        out = out.replace("${token}", token);
    }
    out
}

pub fn render_args(args: &[String], offset: u32, limit: u32, token: Option<&str>) -> Vec<String> {
    args.iter()
        .map(|a| render_arg(a, offset, limit, token))
        .collect()
}

/// The full argv for one provider call. `page_args` are appended only for a
/// paginated request — an unpaginated panel spawns the same argv every time.
pub fn build_argv(spec: &ProviderSpec, paginated: bool, offset: u32, limit: u32) -> Vec<String> {
    let mut argv = vec![spec.argv0.clone()];
    argv.extend(render_args(&spec.args, offset, limit, None));
    if paginated {
        argv.extend(render_args(&spec.page_args, offset, limit, None));
    }
    argv
}

// ---------- FR-20: the scrubbed environment ----------
//
// core-architecture-wave3 FR-7: the allowlist and the scrub itself moved to
// `process_util`, where they became `CommandBuilder::scrubbed_env` — the
// facade's answer to spawn concern 3. `apply_ext_env` is gone with them: both
// provider spawn sites now name `.scrubbed_env(path_override)` on the builder,
// which is the same single implementation they used to share by convention.
// These two re-exports keep `extensions`' own tests (and any caller reasoning
// about what an extension child may read) pointing at the allowlist by the name
// they already know.

#[allow(unused_imports)] // named for the tests below, and for anyone reading extensions/
pub use crate::process_util::{scrub_env, ENV_ALLOWLIST};

// ---------- FR-21/FR-22/FR-24: the spawn ----------

fn read_capped(mut reader: impl Read, cap: usize, capped: &AtomicBool) -> Vec<u8> {
    let mut out: Vec<u8> = Vec::new();
    let mut buf = [0u8; 16 * 1024];
    loop {
        match reader.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                out.extend_from_slice(&buf[..n]);
                if out.len() > cap {
                    capped.store(true, Ordering::SeqCst);
                    break;
                }
            }
        }
    }
    out
}

fn drain_capped(mut reader: impl Read, cap: usize) -> Vec<u8> {
    let mut out: Vec<u8> = Vec::new();
    let mut buf = [0u8; 16 * 1024];
    loop {
        match reader.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if out.len() < cap {
                    let take = (cap - out.len()).min(n);
                    out.extend_from_slice(&buf[..take]);
                }
            }
        }
    }
    out
}

pub fn kill_group(child: &mut Child) {
    #[cfg(unix)]
    {
        unsafe {
            libc::killpg(child.id() as i32, libc::SIGKILL);
        }
    }
    let _ = child.kill();
}

#[cfg(unix)]
pub(crate) fn own_process_group(cmd: &mut Command) {
    use std::os::unix::process::CommandExt;
    unsafe {
        cmd.pre_exec(|| {
            libc::setpgid(0, 0);
            Ok(())
        });
    }
}

#[cfg(not(unix))]
pub fn own_process_group(_cmd: &mut Command) {}

pub fn run(argv: &[String], cwd: &Path) -> Result<Vec<u8>, ProviderError> {
    run_capped(
        argv,
        cwd,
        Duration::from_millis(EXT_TIMEOUT_MS),
        EXT_OUTPUT_CAP_BYTES,
        super::EXT_CONCURRENCY,
    )
}

pub fn run_capped(
    argv: &[String],
    cwd: &Path,
    timeout: Duration,
    cap_bytes: usize,
    concurrency: usize,
) -> Result<Vec<u8>, ProviderError> {
    // FR-7: resolved BEFORE acquire_slot, so the first-call `$SHELL -ilc` cost
    // (1-3s with a heavy rc file) never holds one of the four concurrency slots.
    let path_override = crate::process_util::login_shell_path_env();
    let path_override =
        path_override.and_then(|p| crate::process_util::filter_absolute_path_entries(&p));

    let _slot = acquire_slot(concurrency);

    let mut child = crate::process_util::spawn(&argv[0])
        .args(&argv[1..])
        .current_dir(cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .scrubbed_env(path_override.as_deref())
        .configure(own_process_group)
        .start()
        .map_err(|_| ProviderError::Missing {
            argv0: argv[0].clone(),
        })?;

    let capped = Arc::new(AtomicBool::new(false));
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let out_flag = capped.clone();
    let out_handle =
        stdout.map(|r| std::thread::spawn(move || read_capped(r, cap_bytes, &out_flag)));
    let err_handle =
        stderr.map(|r| std::thread::spawn(move || drain_capped(r, EXT_STDERR_MAX_CHARS * 4)));

    let started = Instant::now();
    let status = loop {
        if capped.load(Ordering::SeqCst) {
            kill_group(&mut child);
            let _ = child.wait();
            return Err(ProviderError::Capped { cap_bytes });
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Err(e) => {
                return Err(ProviderError::Exit {
                    code: -1,
                    stderr: sanitize_field(&e.to_string(), EXT_STDERR_MAX_CHARS),
                })
            }
            Ok(None) => {}
        }
        if started.elapsed() >= timeout {
            kill_group(&mut child);
            let _ = child.wait();
            return Err(ProviderError::Timeout {
                timeout_ms: timeout.as_millis() as u64,
            });
        }
        std::thread::sleep(Duration::from_millis(10));
    };

    let stdout = out_handle.and_then(|h| h.join().ok()).unwrap_or_default();
    let stderr = err_handle.and_then(|h| h.join().ok()).unwrap_or_default();
    if capped.load(Ordering::SeqCst) {
        return Err(ProviderError::Capped { cap_bytes });
    }
    if !status.success() {
        return Err(ProviderError::Exit {
            code: status.code().unwrap_or(-1),
            stderr: sanitize_field(&String::from_utf8_lossy(&stderr), EXT_STDERR_MAX_CHARS),
        });
    }
    Ok(stdout)
}

/// FR-12: the `commandSucceeds` predicate — an exec, so it runs under every
/// cap above. Only the exit status matters; stdout is discarded.
pub fn run_predicate(argv: &[String], cwd: &Path) -> Result<(), ProviderError> {
    run(argv, cwd).map(|_| ())
}

// ---------- FR-21/FR-23: the declared-format line adapter ----------

/// extension-install FR-23: a field literally named `tone` decides the row's
/// tone (falling back to `neutral` for anything not a valid `StatusTone`);
/// every other field lands in `cells` verbatim, sanitized (FR-51 of
/// `extensions`).
pub fn rows_from_lines(
    separator: &str,
    fields: &[String],
    id_field: Option<&str>,
    stdout: &str,
) -> Vec<super::TableRow> {
    stdout
        .split('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l))
        .filter(|l| !l.trim().is_empty())
        .enumerate()
        .map(|(index, line)| {
            let mut parts = line.splitn(fields.len().max(1), separator);
            let mut cells: HashMap<String, String> = HashMap::new();
            for field in fields.iter() {
                let raw = parts.next().unwrap_or("");
                cells.insert(
                    field.clone(),
                    sanitize_field(raw, super::EXT_FIELD_MAX_CHARS),
                );
            }
            let tone = cells
                .get("tone")
                .and_then(|t| super::StatusTone::from_wire(t))
                .unwrap_or(super::StatusTone::Neutral);
            // FR-23: `idField` defaults to the FIRST declared field when the
            // manifest omits it — only an empty row set has no fields to fall
            // back to, and that never reaches this closure.
            let id_key = id_field.or_else(|| fields.first().map(String::as_str));
            let id = id_key
                .and_then(|k| cells.get(k).cloned())
                .filter(|v| !v.is_empty())
                .unwrap_or_else(|| index.to_string());
            super::TableRow { id, cells, tone }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::extensions::{OutputFormat, PanelScope, PrimitiveKind};
    use std::sync::mpsc;

    fn git_provider() -> ProviderSpec {
        ProviderSpec {
            argv0: "git".into(),
            args: vec!["log".into(), "--format=%H".into()],
            page_args: vec!["--skip=${offset}".into(), "-n".into(), "${limit}".into()],
            output: OutputFormat::Json,
        }
    }

    #[test]
    fn page_args_are_appended_only_for_a_paginated_request() {
        let spec = git_provider();
        let argv = build_argv(&spec, true, 200, 100);
        assert_eq!(argv[0], "git");
        assert!(argv.contains(&"--skip=200".to_string()));
        assert!(argv.contains(&"-n".to_string()));
        assert!(argv.contains(&"100".to_string()));
        let plain = build_argv(&spec, false, 200, 100);
        assert!(!plain.iter().any(|a| a.starts_with("--skip")));
    }

    #[test]
    fn an_unpaginated_panel_spawns_the_same_argv_whatever_the_offset() {
        let spec = ProviderSpec {
            argv0: "git".into(),
            args: vec!["branch".into()],
            page_args: vec![],
            output: OutputFormat::Json,
        };
        assert_eq!(
            build_argv(&spec, false, 0, 100),
            build_argv(&spec, false, 900, 100)
        );
    }

    #[test]
    fn a_token_arg_renders_only_when_a_token_is_present() {
        let args = vec!["logs".to_string(), "--".to_string(), "${token}".to_string()];
        assert_eq!(
            render_args(&args, 0, 0, Some("abc123")),
            vec!["logs", "--", "abc123"]
        );
        assert_eq!(
            render_args(&args, 0, 0, None),
            vec!["logs", "--", "${token}"]
        );
    }

    #[test]
    fn the_environment_is_scrubbed_to_the_allowlist() {
        let source = vec![
            ("PATH".to_string(), "/usr/bin".to_string()),
            ("HOME".to_string(), "/home/u".to_string()),
            ("CLAUDE_CONFIG_DIR".to_string(), "/secret".to_string()),
            ("ANTHROPIC_API_KEY".to_string(), "sk-live".to_string()),
            ("AWS_SECRET_ACCESS_KEY".to_string(), "nope".to_string()),
            ("LANG".to_string(), "en_US.UTF-8".to_string()),
        ];
        let kept: Vec<String> = scrub_env(source).into_iter().map(|(k, _)| k).collect();
        assert_eq!(kept, vec!["PATH", "HOME", "LANG"]);
        assert!(!ENV_ALLOWLIST
            .iter()
            .any(|k| k.starts_with("CLAUDE") || k.starts_with("ANTHROPIC")));
    }

    #[test]
    fn the_allowlist_match_is_case_sensitive() {
        let source = vec![
            ("PATH".to_string(), "/usr/bin".to_string()),
            ("path".to_string(), "/sneaky".to_string()),
            ("Home".to_string(), "/sneaky2".to_string()),
        ];
        let kept: Vec<String> = scrub_env(source).into_iter().map(|(k, _)| k).collect();
        assert_eq!(kept, vec!["PATH"]);
    }

    #[test]
    fn the_fifth_concurrent_call_queues_until_a_slot_frees() {
        let held: Vec<Slot> = (0..4).map(|_| acquire_slot(4)).collect();
        assert_eq!(in_flight(), 4);
        let (tx, rx) = mpsc::channel();
        let waiter = std::thread::spawn(move || {
            let slot = acquire_slot(4);
            tx.send(()).unwrap();
            drop(slot);
        });
        assert!(rx.recv_timeout(Duration::from_millis(150)).is_err());
        drop(held);
        rx.recv_timeout(Duration::from_secs(5))
            .expect("the queued call must start once a slot frees");
        waiter.join().unwrap();
    }

    #[test]
    fn a_missing_binary_is_a_missing_provider() {
        let argv = vec!["francois-no-such-provider-xyz".to_string()];
        let err = run_capped(
            &argv,
            Path::new("."),
            Duration::from_secs(2),
            1024,
            super::super::EXT_CONCURRENCY,
        )
        .unwrap_err();
        assert_eq!(
            err,
            ProviderError::Missing {
                argv0: "francois-no-such-provider-xyz".into()
            }
        );
    }

    #[test]
    fn a_vanished_cwd_fails_at_the_spawn() {
        let argv = vec!["git".to_string(), "status".to_string()];
        let err = run_capped(
            &argv,
            Path::new("/francois/no/such/root"),
            Duration::from_secs(2),
            1024,
            super::super::EXT_CONCURRENCY,
        )
        .unwrap_err();
        assert!(matches!(err, ProviderError::Missing { .. }));
    }

    #[cfg(unix)]
    #[test]
    fn a_provider_that_exits_non_zero_reports_its_code_and_stderr() {
        let argv = vec![
            "/bin/ls".to_string(),
            "/francois/definitely/not/here".to_string(),
        ];
        let err = run_capped(
            &argv,
            Path::new("/"),
            Duration::from_secs(5),
            1024 * 1024,
            super::super::EXT_CONCURRENCY,
        )
        .unwrap_err();
        match err {
            ProviderError::Exit { code, stderr } => {
                assert_ne!(code, 0);
                assert!(!stderr.is_empty());
            }
            other => panic!("expected an exit error, got {other:?}"),
        }
    }

    #[cfg(unix)]
    #[test]
    fn stderr_past_the_retained_cap_never_blocks_the_child() {
        let argv = vec![
            "/bin/sh".to_string(),
            "-c".to_string(),
            "yes e 2>/dev/null | head -c 200000 >&2; exit 7".to_string(),
        ];
        let started = Instant::now();
        let err = run_capped(
            &argv,
            Path::new("/"),
            Duration::from_secs(5),
            1024 * 1024,
            super::super::EXT_CONCURRENCY,
        )
        .unwrap_err();
        assert!(started.elapsed() < Duration::from_secs(4));
        match err {
            ProviderError::Exit { code, stderr } => {
                assert_eq!(code, 7);
                assert!(!stderr.is_empty());
            }
            other => panic!("expected an exit error, got {other:?}"),
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_provider_that_overruns_is_killed_at_the_timeout() {
        let argv = vec!["/bin/sleep".to_string(), "30".to_string()];
        let started = Instant::now();
        let err = run_capped(
            &argv,
            Path::new("/"),
            Duration::from_millis(200),
            1024,
            super::super::EXT_CONCURRENCY,
        )
        .unwrap_err();
        assert_eq!(err, ProviderError::Timeout { timeout_ms: 200 });
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[cfg(unix)]
    #[test]
    fn kill_group_takes_down_a_forked_grandchild_too() {
        let pid_file = std::env::temp_dir().join(format!(
            "francois-ext-grandchild-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let mut child = crate::process_util::spawn("/bin/sh")
            .arg("-c")
            .arg(format!("sleep 30 & echo $! > {}; wait", pid_file.display()))
            .configure(own_process_group)
            .start()
            .unwrap();

        let mut grandchild_pid: Option<i32> = None;
        for _ in 0..50 {
            if let Ok(text) = std::fs::read_to_string(&pid_file) {
                if let Ok(pid) = text.trim().parse::<i32>() {
                    grandchild_pid = Some(pid);
                    break;
                }
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let grandchild_pid = grandchild_pid.expect("the grandchild pid must have been recorded");

        kill_group(&mut child);
        let _ = child.wait();
        let _ = std::fs::remove_file(&pid_file);

        std::thread::sleep(Duration::from_millis(100));
        let alive = unsafe { libc::kill(grandchild_pid, 0) } == 0;
        assert!(
            !alive,
            "the grandchild sleep must be killed along with the process group"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_provider_past_the_output_cap_is_killed_with_no_partial_payload() {
        let argv = vec!["/usr/bin/yes".to_string(), "francois".to_string()];
        let result = run_capped(
            &argv,
            Path::new("/"),
            Duration::from_secs(10),
            64 * 1024,
            super::super::EXT_CONCURRENCY,
        );
        match result {
            Err(ProviderError::Capped { cap_bytes }) => assert_eq!(cap_bytes, 64 * 1024),
            Err(ProviderError::Missing { .. }) => {}
            other => panic!("expected a capped error, got {other:?}"),
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_spawned_provider_never_sees_a_claude_variable() {
        std::env::set_var("CLAUDE_FRANCOIS_EXT_TEST", "secret");
        let argv = vec!["/usr/bin/env".to_string()];
        let out = run_capped(
            &argv,
            Path::new("/"),
            Duration::from_secs(5),
            1024 * 1024,
            super::super::EXT_CONCURRENCY,
        );
        std::env::remove_var("CLAUDE_FRANCOIS_EXT_TEST");
        if let Ok(bytes) = out {
            let text = String::from_utf8_lossy(&bytes);
            assert!(!text.contains("CLAUDE_FRANCOIS_EXT_TEST"), "{text}");
            assert!(!text.contains("secret"), "{text}");
        }
    }

    // ---- ext-path-resolution FR-3/FR-4/FR-5/FR-9 ----

    /// The (program, argv) of a child that prints only its own `PATH`.
    fn echo_path_argv() -> (&'static str, Vec<&'static str>) {
        if cfg!(windows) {
            ("cmd", vec!["/C", "echo %PATH%"])
        } else {
            ("/bin/sh", vec!["-c", "echo -n \"$PATH\""])
        }
    }

    // FR-3/FR-5: the child actually receives the (filtered) login shell's
    // PATH. Tolerates `None` (no usable $SHELL on this machine) rather than
    // being flaky, per acceptance criteria.
    #[test]
    fn apply_ext_env_overrides_path_with_the_filtered_login_shell_path() {
        let Some(login_path) = crate::process_util::login_shell_path_env() else {
            return; // FR-6: nominal on a machine with no usable $SHELL
        };
        let Some(filtered) = crate::process_util::filter_absolute_path_entries(&login_path) else {
            return; // every entry was relative/empty — nothing to assert
        };
        let first_entry = filtered.split(':').next().unwrap().to_string();

        let (program, argv) = echo_path_argv();
        let output = crate::process_util::spawn(program)
            .args(argv)
            .scrubbed_env(Some(&filtered))
            .output()
            .expect("the marker command must spawn");
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(
            stdout.contains(&first_entry),
            "expected the resolved login-shell PATH prefix {first_entry:?} in {stdout:?}"
        );
    }

    // FR-9 non-regression: the override goes through the SAME allowlist path
    // as every other extension env var — no extra variable leaks in.
    #[test]
    fn apply_ext_env_still_scrubs_to_the_allowlist_with_a_path_override() {
        std::env::set_var("FRANCOIS_EXT_PATH_TEST_SECRET", "leak-me-not");
        let output = crate::process_util::spawn("/usr/bin/env")
            .scrubbed_env(Some("/custom/bin:/usr/bin"))
            .output();
        std::env::remove_var("FRANCOIS_EXT_PATH_TEST_SECRET");
        if let Ok(output) = output {
            let stdout = String::from_utf8_lossy(&output.stdout);
            assert!(!stdout.contains("FRANCOIS_EXT_PATH_TEST_SECRET"));
            assert!(stdout.contains("PATH=/custom/bin:/usr/bin"));
        }
    }

    // FR-21/FR-23: the adapter is driven entirely by the declared format.
    #[test]
    fn the_line_adapter_splits_on_the_declared_separator() {
        let fields = vec!["branch".to_string(), "when".to_string()];
        let rows = rows_from_lines(
            "\u{1f}",
            &fields,
            Some("branch"),
            "main\u{1f}1700000000\nfeat/x\u{1f}1700000060\n",
        );
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].id, "main");
        assert_eq!(rows[0].cells.get("when").unwrap(), "1700000000");
        assert_eq!(rows[1].cells.get("branch").unwrap(), "feat/x");
    }

    #[test]
    fn a_short_line_leaves_the_missing_cells_empty() {
        let fields = vec!["name".to_string(), "url".to_string()];
        let rows = rows_from_lines("\t", &fields, None, "origin\n");
        assert_eq!(rows[0].cells.get("url").unwrap(), "");
        // FR-23: with no `idField` declared, the row falls back to the first
        // field (`name`), not the row index — it is non-empty here.
        assert_eq!(rows[0].id, "origin");
    }

    // FR-23: `idField` absent ⇒ the FIRST declared field, per
    // examples/extensions/plugin-example/README.md — not the row index.
    #[test]
    fn a_missing_id_field_defaults_to_the_first_declared_field() {
        let fields = vec!["branch".to_string(), "when".to_string()];
        let rows = rows_from_lines(
            "\u{1f}",
            &fields,
            None,
            "main\u{1f}1700000000\nfeat/x\u{1f}1700000060\n",
        );
        assert_eq!(rows[0].id, "main");
        assert_eq!(rows[1].id, "feat/x");
    }

    // Only when even the first field is empty does the row fall back to its
    // index — an id can never be the empty string.
    #[test]
    fn a_missing_id_field_falls_back_to_the_row_index_when_the_first_field_is_empty() {
        let fields = vec!["name".to_string(), "url".to_string()];
        let rows = rows_from_lines("\t", &fields, None, "\turl-only\n");
        assert_eq!(rows[0].id, "0");
    }

    #[test]
    fn adapted_cells_are_sanitized_before_they_can_cross_ipc() {
        let fields = vec!["branch".to_string()];
        let rows = rows_from_lines(
            "\u{1f}",
            &fields,
            Some("branch"),
            "\u{1b}[31mmain\u{1b}[0m\u{7}\n",
        );
        assert_eq!(rows[0].cells.get("branch").unwrap(), "main");
    }

    // FR-23: a field literally named `tone` decides the row's tone.
    #[test]
    fn a_tone_field_decides_the_row_tone() {
        let fields = vec!["name".to_string(), "tone".to_string()];
        let rows = rows_from_lines(
            "\u{1f}",
            &fields,
            Some("name"),
            "web\u{1f}error\nfoo\u{1f}bogus\n",
        );
        assert_eq!(rows[0].tone, super::super::StatusTone::Error);
        // An invalid tone value falls back to neutral rather than failing.
        assert_eq!(rows[1].tone, super::super::StatusTone::Neutral);
    }

    // Sanity: the panel scope/primitive enums used elsewhere still import.
    #[test]
    fn wire_enums_are_reachable_from_this_module() {
        assert_eq!(PanelScope::Project, PanelScope::Project);
        assert_eq!(PrimitiveKind::Table, PrimitiveKind::Table);
    }
}
