//! the /usage · /cost probe lifecycle (specs/interactive-commands.md FR-6..11).
//!
//! Split out of interactive.rs, which had grown past the ~1000-line convention by
//! carrying three unrelated concerns at once: the slash grammar, the CommandCard
//! builders, and this — a detached side-spawn with its own process, watchdog
//! thread and slot-reservation protocol. Only the last one owns a child process,
//! so it is the one that pulls in `std::process` / `std::io` / atomics; keeping
//! it here leaves interactive.rs as pure grammar-and-cards.
//!
//! The card builders it calls back into (`probe_card`, `finalize_command_block`)
//! stay in interactive.rs and resolve through session/mod.rs's re-export.

use super::*;
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};

/// FR-6/7/11: begin the /usage//cost detached side-spawn — reserve the single probe
/// slot, emit command.started + a pending block, then probe on a detached thread.
/// Invisible to the turn lifecycle: status, queue, claude_session_id and
/// contextUsedTokens are never touched.
pub(crate) fn start_usage_probe(app: &AppHandle, session_id: &str, command: &str) {
    let engine = app.state::<Engine>();
    let block_id = uuid();
    let reserved = engine.with_session_mut(session_id, |s| {
        let slot = s.reserve_probe(&block_id)?;
        s.buf_command_pending(&block_id, command);
        s.last_activity_at = now_ms();
        Some((
            s.cwd.clone(),
            s.model_id.clone(),
            s.runtime.clone(),
            s.worktree_distro.clone(),
            s.account_id.clone(),
            slot,
        ))
    });
    let (cwd, model_id, runtime, worktree_distro, account_id, slot) = match reserved {
        None => return, // no such session
        Some(None) => {
            // FR-11: one in-flight probe per session → instant notice on a fresh block.
            finalize_command_block(
                app,
                session_id,
                &uuid(),
                command,
                &CommandCard::Notice {
                    text: "a usage check is already running".into(),
                },
            );
            return;
        }
        Some(Some(t)) => t,
    };
    emit(
        app,
        SessionEvent::CommandStarted {
            session_id: session_id.into(),
            block_id: block_id.clone(),
            command: command.into(),
        },
    );
    // multi-account FR-21: the side-probe reports THIS session's account's usage,
    // so it spawns under that account's config dir.
    let account_config_dir = crate::account::config_dir_of(app, &account_id);
    let app = app.clone();
    let sid = session_id.to_string();
    let command = command.to_string();
    std::thread::spawn(move || {
        run_probe(
            app,
            sid,
            block_id,
            command,
            cwd,
            model_id,
            runtime,
            worktree_distro,
            account_config_dir,
            slot,
        )
    });
}

/// FR-7/8/9/10: the detached probe body. Same invocation machinery as turns
/// (session runtime incl. WSL + session cwd); NO --resume, no permission flags.
/// `worktree_distro` (session-worktree FR-10): the session's stored distro, so
/// a WSL worktree probe routes to the repo's actual distro rather than the
/// machine's default one.
#[allow(clippy::too_many_arguments)]
pub(crate) fn run_probe(
    app: AppHandle,
    session_id: String,
    block_id: String,
    command: String,
    cwd: String,
    model_id: String,
    runtime: String,
    worktree_distro: Option<String>,
    account_config_dir: Option<String>,
    slot: Arc<Mutex<Option<Child>>>,
) {
    let args: Vec<String> = vec![
        "-p".into(),
        format!("/{command}"),
        "--output-format".into(),
        "stream-json".into(),
        "--verbose".into(),
        "--model".into(),
        model_id,
    ];
    let (program, argv) = claude_invocation(&runtime, &cwd, args, worktree_distro.as_deref());
    let mut cmd = Command::new(program);
    cmd.args(argv);
    if runtime != "wsl" {
        cmd.current_dir(&cwd); // wsl probes get their cwd via `--cd` inside the distro
    }
    if let Some(path) = claude_path_env() {
        cmd.env("PATH", path);
    }
    // multi-account FR-21/FR-24.
    for (k, v) in account_env(account_config_dir.as_deref(), &runtime, &[]) {
        cmd.env(k, v);
    }
    no_window(&mut cmd);
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(_) => {
            // FR-10 with session-engine FR-45's actionable wording where determinable.
            let text = if runtime == "wsl" {
                "couldn't fetch usage \u{2014} WSL not found. Install it (wsl --install) or use the native runtime."
            } else {
                "couldn't fetch usage \u{2014} Claude Code CLI not found. Install it and ensure `claude` is on PATH."
            };
            finish_probe(
                &app,
                &session_id,
                &block_id,
                &command,
                CommandCard::Notice { text: text.into() },
            );
            return;
        }
    };
    let stdout = child.stdout.take();
    *slot.lock().unwrap() = Some(child);

    // If the session was removed between reserve and spawn, its remove-path kill
    // found an empty slot — kill the child ourselves and vanish (§7, FR-14).
    let still_wanted = app
        .state::<Engine>()
        .with_session(&session_id, |s| {
            s.pending_probe
                .as_ref()
                .map(|p| p.block_id == block_id)
                .unwrap_or(false)
        })
        .unwrap_or(false);
    if !still_wanted {
        if let Some(mut c) = slot.lock().unwrap().take() {
            let _ = c.kill();
            let _ = c.wait();
        }
        return;
    }

    // FR-10: 30s watchdog → kill. `done` stops the watchdog after a normal finish.
    let done = Arc::new(AtomicBool::new(false));
    let timed_out = Arc::new(AtomicBool::new(false));
    {
        let (slot, done, timed_out) = (slot.clone(), done.clone(), timed_out.clone());
        std::thread::spawn(move || {
            for _ in 0..(PROBE_TIMEOUT_SECS * 10) {
                std::thread::sleep(std::time::Duration::from_millis(100));
                if done.load(Ordering::SeqCst) {
                    return;
                }
            }
            timed_out.store(true, Ordering::SeqCst);
            if let Some(c) = slot.lock().unwrap().as_mut() {
                let _ = c.kill();
            }
        });
    }

    let mut lines: Vec<String> = Vec::new();
    if let Some(out) = stdout {
        for line in BufReader::new(out).lines() {
            match line {
                Ok(l) => lines.push(l),
                Err(_) => break,
            }
        }
    }
    if let Some(mut c) = slot.lock().unwrap().take() {
        let _ = c.wait();
    }
    done.store(true, Ordering::SeqCst);

    // Remediation R1: prefer a fully-parsed answer over the timeout notice —
    // an answer read just before the 30s kill must not be discarded (probe_card).
    let card = probe_card(&command, &lines, timed_out.load(Ordering::SeqCst));
    finish_probe(&app, &session_id, &block_id, &command, card);
}

/// Release the probe slot and finalize its pending block (FR-9/10 — a pending
/// command block is never left open). If the session was removed mid-probe,
/// nothing is emitted (session-engine FR-14).
pub(crate) fn finish_probe(
    app: &AppHandle,
    session_id: &str,
    block_id: &str,
    command: &str,
    card: CommandCard,
) {
    let should_finalize = app.state::<Engine>().with_session_mut(session_id, |s| {
        match &s.pending_probe {
            Some(p) if p.block_id == block_id => {
                s.pending_probe = None;
                true
            }
            // superseded or cancelled — never finalize another probe's block
            _ => false,
        }
    });
    if should_finalize != Some(true) {
        return;
    }
    finalize_command_block(app, session_id, block_id, command, &card);
}
