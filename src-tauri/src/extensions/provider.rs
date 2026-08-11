//! FR-19..FR-24 — provider execution, and the FR-54 line adapter.
//!
//! Everything a provider is allowed to be happens here: an argv ARRAY (never a
//! shell string), a scrubbed environment, a cwd pinned to the panel's declared
//! root, closed stdin, a 10 s timeout, a 4 MiB output cap, and an app-wide
//! semaphore of four in-flight processes.
//!
//! There is no `sh -c` and no string concatenation on the path from a definition
//! to a spawn: `render_args` turns a `&[Arg]` into a `Vec<String>` where the only
//! variable content is a number Rust renders or a token that already passed
//! `TOKEN_PATTERN` (FR-38), always behind a compiled-in literal prefix.

use super::schema::sanitize_field;
use super::{
    Arg, FieldTransform, LineFormat, NdjsonFormat, ProviderSpec, StatusTone, TableRow, ToneRule,
    EXT_OUTPUT_CAP_BYTES, EXT_STDERR_MAX_CHARS, EXT_TIMEOUT_MS,
};
use crate::process_util::no_window;
use serde_json::Value;
use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

/// The four FR-24/FR-21/FR-22 failure causes. Every one of them names its cause
/// to the user (FR-49), so none of them is ever a silent empty panel.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum ProviderError {
    /// FR-24: the binary could not be spawned at all.
    Missing { argv0: String },
    /// FR-21: killed at the timeout.
    Timeout { timeout_ms: u64 },
    /// FR-24: a non-zero exit. `stderr` is truncated and sanitized (FR-51).
    Exit { code: i32, stderr: String },
    /// FR-22: killed past the output cap; NO partial payload is forwarded.
    Capped { cap_bytes: usize },
}

// ---------- FR-23: the app-wide semaphore of 4 ----------

/// `(in_flight, waiters)`. A plain counting semaphore — `Condvar` wakes the next
/// queued call when a slot frees. NOT a cap on pending calls: a queued call
/// simply waits, and its FR-21 timeout is measured from when it STARTS
/// (`run_capped` takes the slot before it starts its clock).
///
/// FR-23 says "queued" — it does not require strict FIFO wake order, which is
/// the accepted reading here: `Condvar::notify_one` gives no ordering
/// guarantee over which waiter wakes first (`std::sync::Condvar` is
/// deliberately silent on this — it is not the OS futex's wait-queue order on
/// every platform). In practice this is "FIFO-ish" under the light contention
/// four fleet-scoped panels ever produce, and a queued call still runs to
/// completion under its own FR-21 cap regardless of wake order — nothing here
/// depends on strict ordering to be correct, only to be fair. If FR-23 is ever
/// read as requiring strict FIFO, back this with an explicit ordered waiter
/// list (e.g. a `VecDeque` of per-waiter one-shot channels) instead of the bare
/// counting semaphore.
static SLOTS: OnceLock<(Mutex<usize>, Condvar)> = OnceLock::new();

fn slots() -> &'static (Mutex<usize>, Condvar) {
    SLOTS.get_or_init(|| (Mutex::new(0), Condvar::new()))
}

/// Held for the lifetime of one provider process. Releasing is `Drop`, so a
/// panic on the spawn path cannot leak a slot and wedge the whole system.
pub(crate) struct Slot;

impl Drop for Slot {
    fn drop(&mut self) {
        let (lock, cv) = slots();
        let mut n = lock.lock().unwrap();
        *n = n.saturating_sub(1);
        cv.notify_one();
    }
}

pub(crate) fn acquire_slot(limit: usize) -> Slot {
    let (lock, cv) = slots();
    let mut n = lock.lock().unwrap();
    while *n >= limit {
        n = cv.wait(n).unwrap();
    }
    *n += 1;
    Slot
}

/// How many provider processes are in flight right now — the cap's own witness.
#[cfg(test)]
pub(crate) fn in_flight() -> usize {
    *slots().0.lock().unwrap()
}

// ---------- FR-19: argv assembly ----------

/// `&[Arg]` → argv. `Offset`/`Limit` render a number Rust owns; `Token` renders
/// a value the caller has ALREADY validated against `TOKEN_PATTERN` (FR-38) —
/// `None` drops the element rather than emitting an empty argument.
pub(crate) fn render_args(
    args: &[Arg],
    offset: u32,
    limit: u32,
    token: Option<&str>,
) -> Vec<String> {
    args.iter()
        .filter_map(|a| match a {
            Arg::Lit(s) => Some((*s).to_string()),
            Arg::Offset(prefix) => Some(format!("{prefix}{offset}")),
            Arg::Limit(prefix) => Some(format!("{prefix}{limit}")),
            Arg::Token(prefix) => token.map(|t| format!("{prefix}{t}")),
        })
        .collect()
}

/// The full argv for one provider call. `page_args` are appended only for a
/// paginated request (FR-31) — an unpaginated panel spawns the same argv every
/// time, whatever the frontend sends.
pub(crate) fn build_argv(
    spec: &ProviderSpec,
    paginated: bool,
    offset: u32,
    limit: u32,
) -> Vec<String> {
    let mut argv = vec![spec.argv0.to_string()];
    argv.extend(render_args(spec.args, offset, limit, None));
    if paginated {
        argv.extend(render_args(spec.page_args, offset, limit, None));
    }
    argv
}

// ---------- FR-20: the scrubbed environment ----------

/// The only variables that reach a provider. The app's own environment is never
/// inherited, so no Anthropic credential, session token or `CLAUDE_*` variable
/// can be read by one — not by accident and not by design.
pub(crate) const ENV_ALLOWLIST: &[&str] = &[
    "PATH",
    "HOME",
    "USER",
    "LANG",
    "TMPDIR",
    // Windows' required minimum: without these a spawned process cannot resolve
    // system DLLs (`SystemRoot`/`windir`), extensions (`PATHEXT`) or its own home.
    "SystemRoot",
    "windir",
    "PATHEXT",
    "COMSPEC",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
];

/// FR-20: keep the allowlist, drop everything else. Pure over the source vars so
/// the rule is provable without spawning anything. Matches EXACTLY — no
/// case-folding — because env vars are case-SENSITIVE on Unix; `path` or `Path`
/// is a distinct, non-allowlisted variable from `PATH` and must not slip
/// through just because it differs only in case (Windows' own vars are looked
/// up case-insensitively by the OS regardless of the literal casing kept here).
pub(crate) fn scrub_env<I: IntoIterator<Item = (String, String)>>(
    vars: I,
) -> Vec<(String, String)> {
    vars.into_iter()
        .filter(|(k, _)| ENV_ALLOWLIST.contains(&k.as_str()))
        .collect()
}

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
                    // FR-22: checked after each 16 KiB read, not byte-exact — up
                    // to one read (16 KiB) past `cap` can be buffered before we
                    // notice and flag the child for the kill. That buffered tail
                    // is still discarded: nothing partial is ever forwarded, only
                    // the moment the kill fires is coarser than the byte boundary.
                    capped.store(true, Ordering::SeqCst);
                    break;
                }
            }
        }
    }
    out
}

/// Drains a reader to EOF regardless of size, retaining only the first `cap`
/// bytes. Unlike `read_capped`, this never stops early — used for stderr,
/// which is not what FR-22's kill-on-overrun cap is watching (stdout is), so
/// stopping early here would leave the pipe undrained: if a provider writes
/// more to stderr than the OS pipe buffer holds before it exits, its `write()`
/// blocks forever on a reader that quit, and the whole call reads as a timeout
/// instead of the real exit code + stderr.
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
                // Keep reading past `cap` — the excess is discarded, not
                // retained, but the pipe must stay drained until the writer
                // (the provider) closes it on its own.
            }
        }
    }
    out
}

/// FR-21: "process group where the platform supports it" — the child is put in
/// its own group at spawn (below), so a provider that forked helpers takes them
/// all down with it rather than leaving orphans behind.
pub(crate) fn kill_group(child: &mut Child) {
    #[cfg(unix)]
    {
        // SAFETY: `killpg` on our own child's group id; a failed call (the child
        // already reaped) is ignored exactly like `child.kill()`'s error is.
        unsafe {
            libc::killpg(child.id() as i32, libc::SIGKILL);
        }
    }
    let _ = child.kill();
}

#[cfg(unix)]
pub(crate) fn own_process_group(cmd: &mut Command) {
    use std::os::unix::process::CommandExt;
    // SAFETY: `setpgid` is async-signal-safe and allocates nothing, which is the
    // whole requirement on a pre_exec hook (same discipline as update/helper.rs).
    unsafe {
        cmd.pre_exec(|| {
            libc::setpgid(0, 0);
            Ok(())
        });
    }
}

#[cfg(not(unix))]
pub(crate) fn own_process_group(_cmd: &mut Command) {}

/// One provider call, start to finish, under every cap. Blocking — every caller
/// is a `#[tauri::command(async)]`, so this runs off the main thread.
pub(crate) fn run(argv: &[String], cwd: &Path) -> Result<Vec<u8>, ProviderError> {
    run_capped(
        argv,
        cwd,
        Duration::from_millis(EXT_TIMEOUT_MS),
        EXT_OUTPUT_CAP_BYTES,
        super::EXT_CONCURRENCY,
    )
}

/// The cap-parameterised body, so the timeout and the output cap are provable in
/// a test that takes milliseconds instead of ten seconds and four megabytes.
pub(crate) fn run_capped(
    argv: &[String],
    cwd: &Path,
    timeout: Duration,
    cap_bytes: usize,
    concurrency: usize,
) -> Result<Vec<u8>, ProviderError> {
    // FR-23: queue here, BEFORE the clock starts — a queued call still gets its
    // full timeout measured from when it actually starts.
    let _slot = acquire_slot(concurrency);

    let mut cmd = Command::new(&argv[0]);
    cmd.args(&argv[1..])
        .current_dir(cwd)
        // FR-20: no stdin — a provider can never block on, or read, our input.
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    cmd.env_clear();
    for (k, v) in scrub_env(std::env::vars()) {
        cmd.env(k, v);
    }
    no_window(&mut cmd);
    own_process_group(&mut cmd);

    // FR-24: every spawn failure — missing binary, permission denied, a cwd that
    // no longer exists — is the same user-visible cause: it could not run.
    let mut child = cmd.spawn().map_err(|_| ProviderError::Missing {
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
            // The child cannot be waited on at all — nothing usable will come
            // out of it, so it reads as a failed run rather than a hang.
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
    // The reader can trip the cap between the last poll and the child exiting.
    if capped.load(Ordering::SeqCst) {
        return Err(ProviderError::Capped { cap_bytes });
    }
    if !status.success() {
        return Err(ProviderError::Exit {
            code: status.code().unwrap_or(-1),
            // FR-24 + FR-51: truncated to 2 000 chars and sanitized IN THE CORE.
            stderr: sanitize_field(&String::from_utf8_lossy(&stderr), EXT_STDERR_MAX_CHARS),
        });
    }
    Ok(stdout)
}

/// FR-3/FR-5: the `docker info` predicate — an exec, so it runs under every cap
/// above. Only the exit status matters; stdout is discarded.
pub(crate) fn run_predicate(argv: &[String], cwd: &Path) -> Result<(), ProviderError> {
    run(argv, cwd).map(|_| ())
}

// ---------- FR-54: the declared-format line adapter ----------

fn tone_of(rule: &ToneRule, cells: &HashMap<String, String>) -> StatusTone {
    match rule {
        ToneRule::Fixed(t) => *t,
        ToneRule::Map {
            key,
            entries,
            default,
        } => {
            let value = cells.get(*key).map(|s| s.to_ascii_lowercase());
            value
                .and_then(|v| {
                    entries
                        .iter()
                        .find(|(k, _)| v == *k || v.starts_with(k))
                        .map(|(_, t)| *t)
                })
                .unwrap_or(*default)
        }
    }
}

fn apply_transform(raw: &str, transform: FieldTransform) -> String {
    match transform {
        FieldTransform::None => raw.to_string(),
        // git's `%ct` / `:unix` stamps are seconds; Francois timestamps are ms.
        // An unparseable value is passed through rather than blanked — the cell
        // stays inert text either way.
        FieldTransform::SecondsToMillis => match raw.trim().parse::<i64>() {
            Ok(secs) => (secs * 1_000).to_string(),
            Err(_) => raw.to_string(),
        },
    }
}

/// FR-54: line-oriented output → table rows. Reusable by any future
/// line-oriented provider — it is driven entirely by the declared `LineFormat`,
/// so `git` needs no per-extension code seam. Every cell is sanitized here, in
/// the core, before it can cross IPC (FR-51).
pub(crate) fn rows_from_lines(fmt: &LineFormat, stdout: &str) -> Vec<TableRow> {
    stdout
        .split('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l))
        .filter(|l| !l.trim().is_empty())
        .enumerate()
        .map(|(index, line)| {
            let mut parts = line.splitn(fmt.fields.len(), fmt.sep);
            let mut cells: HashMap<String, String> = HashMap::new();
            for field in fmt.fields.iter() {
                let raw = parts.next().unwrap_or("");
                let value = apply_transform(raw, field.transform);
                cells.insert(
                    field.key.to_string(),
                    sanitize_field(&value, super::EXT_FIELD_MAX_CHARS),
                );
            }
            let tone = tone_of(&fmt.tone, &cells);
            let id = fmt
                .id_field
                .and_then(|k| cells.get(k).cloned())
                .filter(|v| !v.is_empty())
                .unwrap_or_else(|| index.to_string());
            TableRow { id, cells, tone }
        })
        .collect()
}

/// One JSON object per line (`docker … --format '{{json .}}'`). A line that is
/// not a JSON object fails the whole payload (FR-25) — a partially-valid payload
/// is never partially rendered.
pub(crate) fn rows_from_ndjson(fmt: &NdjsonFormat, stdout: &str) -> Result<Vec<TableRow>, ()> {
    let mut rows = Vec::new();
    for (index, line) in stdout
        .split('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l))
        .filter(|l| !l.trim().is_empty())
        .enumerate()
    {
        let Ok(Value::Object(obj)) = serde_json::from_str::<Value>(line) else {
            return Err(());
        };
        let mut cells: HashMap<String, String> = HashMap::new();
        for (cell_key, json_key) in fmt.fields.iter() {
            let raw = match obj.get(*json_key) {
                Some(Value::String(s)) => s.clone(),
                Some(Value::Number(n)) => n.to_string(),
                Some(Value::Bool(b)) => b.to_string(),
                // A declared field missing from a row renders empty (FR-36).
                _ => String::new(),
            };
            cells.insert(
                (*cell_key).to_string(),
                sanitize_field(&raw, super::EXT_FIELD_MAX_CHARS),
            );
        }
        let tone = tone_of(&fmt.tone, &cells);
        let id = fmt
            .id_field
            .and_then(|k| cells.get(k).cloned())
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| index.to_string());
        rows.push(TableRow { id, cells, tone });
    }
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::extensions::{registry, FieldSpec};
    use std::sync::mpsc;

    // FR-19: an argv ARRAY. Numbers are rendered by Rust behind a compiled-in
    // prefix — nothing is concatenated out of provider-supplied text.
    #[test]
    fn page_args_are_appended_only_for_a_paginated_request() {
        let (_, log) = registry::panel("git:log").unwrap();
        let spec = log.provider.as_ref().unwrap();
        let argv = build_argv(spec, true, 200, 100);
        assert_eq!(argv[0], "git");
        assert_eq!(argv[1], "log");
        assert!(argv.contains(&"--skip=200".to_string()));
        assert!(argv.contains(&"-n".to_string()));
        assert!(argv.contains(&"100".to_string()));
        let plain = build_argv(spec, false, 200, 100);
        assert!(!plain.iter().any(|a| a.starts_with("--skip")));
    }

    #[test]
    fn an_unpaginated_panel_spawns_the_same_argv_whatever_the_offset() {
        let (_, branches) = registry::panel("git:branches").unwrap();
        let spec = branches.provider.as_ref().unwrap();
        assert_eq!(
            build_argv(spec, false, 0, 100),
            build_argv(spec, false, 900, 100)
        );
    }

    // FR-38: a token renders behind its literal prefix; an absent token drops
    // the element rather than emitting an empty argument.
    #[test]
    fn a_token_arg_renders_only_when_a_token_is_present() {
        let args = [Arg::Lit("logs"), Arg::Lit("--"), Arg::Token("")];
        assert_eq!(
            render_args(&args, 0, 0, Some("abc123")),
            vec!["logs", "--", "abc123"]
        );
        assert_eq!(render_args(&args, 0, 0, None), vec!["logs", "--"]);
    }

    // FR-20: the app's environment is NEVER inherited. No credential, no
    // session token, no CLAUDE_* variable reaches a provider.
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

    // FR-20: the match is EXACT, not case-folded — `path` is a distinct,
    // non-allowlisted variable from `PATH` on a case-sensitive (Unix) shell.
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

    // FR-23: the fifth call queues until a slot frees. Nothing here spawns —
    // the semaphore itself is what the cap is made of.
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
        assert!(
            rx.recv_timeout(Duration::from_millis(150)).is_err(),
            "a fifth call must not start while four are in flight"
        );
        drop(held);
        rx.recv_timeout(Duration::from_secs(5))
            .expect("the queued call must start once a slot frees");
        waiter.join().unwrap();
    }

    // FR-24: a binary that is not on PATH is EXT_PROVIDER_MISSING, carrying the
    // argv0 the error message names.
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

    // §7: a project root that no longer exists fails at the spawn, and the tab
    // stays — the same EXT_PROVIDER_MISSING cause.
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
                assert!(!stderr.is_empty(), "stderr must reach the error detail");
            }
            other => panic!("expected an exit error, got {other:?}"),
        }
    }

    // A provider that writes far more to stderr than `EXT_STDERR_MAX_CHARS`
    // retains — and more than a typical OS pipe buffer holds — must not block
    // on `write()` once the reader stops RETAINING bytes. If the reader also
    // stopped DRAINING them, the pipe backs up and the exit reads as a bogus
    // timeout instead of the real code + stderr.
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
        assert!(
            started.elapsed() < Duration::from_secs(4),
            "stderr must not block the child; call took {:?}",
            started.elapsed()
        );
        match err {
            ProviderError::Exit { code, stderr } => {
                assert_eq!(code, 7);
                assert!(!stderr.is_empty(), "stderr must reach the error detail");
            }
            other => panic!("expected an exit error, got {other:?}"),
        }
    }

    // FR-21: expiry kills the child and resolves a timeout — the cap is real,
    // not advisory.
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
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "child not killed"
        );
    }

    // FR-43/FR-21: `own_process_group` + `kill_group` together are what a
    // `log-tail` process source relies on too (stream.rs's `spawn_process_stream`)
    // — a shell that forks a background grandchild must lose it along with the
    // group, not leave it orphaned behind a bare-PID kill.
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
        let mut cmd = Command::new("/bin/sh");
        cmd.arg("-c")
            .arg(format!("sleep 30 & echo $! > {}; wait", pid_file.display()))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        own_process_group(&mut cmd);
        let mut child = cmd.spawn().unwrap();

        // Give the shell time to fork the grandchild and record its pid.
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

        // Give the kernel a moment to finish reaping the killed grandchild.
        std::thread::sleep(Duration::from_millis(100));
        // SAFETY: signal 0 only probes for existence — nothing is sent.
        let alive = unsafe { libc::kill(grandchild_pid, 0) } == 0;
        assert!(
            !alive,
            "the grandchild sleep must be killed along with the process group"
        );
    }

    // FR-22: past the cap the child is killed and NOTHING is forwarded.
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
            // `yes` lives in /bin on some distros; skip rather than fail there.
            Err(ProviderError::Missing { .. }) => {}
            other => panic!("expected a capped error, got {other:?}"),
        }
    }

    // FR-20, proven end-to-end: the child really sees the scrubbed environment.
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

    // FR-54: the adapter is driven by the declared format alone.
    #[test]
    fn the_line_adapter_splits_on_the_declared_separator() {
        let fmt = LineFormat {
            sep: "\u{1f}",
            fields: &[
                FieldSpec {
                    key: "branch",
                    transform: FieldTransform::None,
                },
                FieldSpec {
                    key: "when",
                    transform: FieldTransform::SecondsToMillis,
                },
            ],
            id_field: Some("branch"),
            tone: ToneRule::Fixed(StatusTone::Neutral),
        };
        let rows = rows_from_lines(&fmt, "main\u{1f}1700000000\nfeat/x\u{1f}1700000060\n");
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].id, "main");
        assert_eq!(rows[0].cells.get("when").unwrap(), "1700000000000");
        assert_eq!(rows[1].cells.get("branch").unwrap(), "feat/x");
    }

    // A field the provider left out renders empty rather than shifting the row.
    #[test]
    fn a_short_line_leaves_the_missing_cells_empty() {
        let fmt = LineFormat {
            sep: "\t",
            fields: &[
                FieldSpec {
                    key: "name",
                    transform: FieldTransform::None,
                },
                FieldSpec {
                    key: "url",
                    transform: FieldTransform::None,
                },
            ],
            id_field: None,
            tone: ToneRule::Fixed(StatusTone::Neutral),
        };
        let rows = rows_from_lines(&fmt, "origin\n");
        assert_eq!(rows[0].cells.get("url").unwrap(), "");
        // No id field declared ⇒ the row index is the stable id.
        assert_eq!(rows[0].id, "0");
    }

    // FR-51: sanitization happens in the CORE, on the way out of the adapter.
    #[test]
    fn adapted_cells_are_sanitized_before_they_can_cross_ipc() {
        let fmt = LineFormat {
            sep: "\u{1f}",
            fields: &[FieldSpec {
                key: "branch",
                transform: FieldTransform::None,
            }],
            id_field: Some("branch"),
            tone: ToneRule::Fixed(StatusTone::Neutral),
        };
        let rows = rows_from_lines(&fmt, "\u{1b}[31mmain\u{1b}[0m\u{7}\n");
        assert_eq!(rows[0].cells.get("branch").unwrap(), "main");
    }

    // FR-55: docker's NDJSON, with the compiled-in tone map — the provider's own
    // idea of a tone is never trusted.
    #[test]
    fn the_ndjson_adapter_maps_declared_keys_and_tones() {
        let (_, containers) = registry::panel("docker:containers").unwrap();
        let super::super::OutputFormat::Ndjson(fmt) = &containers.provider.as_ref().unwrap().output
        else {
            panic!("docker:containers must declare an ndjson output");
        };
        let stdout = concat!(
            r#"{"ID":"abc","Names":"web","Image":"nginx","State":"running","Status":"Up 2h"}"#,
            "\n",
            r#"{"ID":"def","Names":"db","Image":"pg","State":"exited","Status":"Exited (0)"}"#,
            "\n"
        );
        let rows = rows_from_ndjson(fmt, stdout).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].id, "abc");
        assert_eq!(rows[0].cells.get("name").unwrap(), "web");
        assert_eq!(rows[0].tone, StatusTone::Ok);
        assert_eq!(rows[1].tone, StatusTone::Neutral);
    }

    // FR-25: a line that is not a JSON object fails the WHOLE payload.
    #[test]
    fn a_non_object_ndjson_line_fails_the_payload() {
        let fmt = NdjsonFormat {
            fields: &[("id", "ID")],
            id_field: Some("id"),
            tone: ToneRule::Fixed(StatusTone::Neutral),
        };
        assert!(rows_from_ndjson(&fmt, "{\"ID\":\"a\"}\nnot json\n").is_err());
        assert!(rows_from_ndjson(&fmt, "[1,2]\n").is_err());
        assert!(rows_from_ndjson(&fmt, "").unwrap().is_empty());
    }
}
