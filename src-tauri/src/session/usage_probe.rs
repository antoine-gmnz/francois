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
use chrono::TimeZone;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};

/// FR-6/7/11: begin the /usage//cost detached side-spawn — reserve the single probe
/// slot, emit command.started + a pending block, then probe on a detached thread.
/// Invisible to the turn lifecycle: status, queue, claude_session_id and
/// contextUsedTokens are never touched.
pub fn start_usage_probe(app: &AppHandle, session_id: &str, command: &str) {
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
            s.agent_runtime,
            slot,
        ))
    });
    let (cwd, model_id, runtime, worktree_distro, account_id, agent_runtime, slot) = match reserved
    {
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
    let account_config_dir = if agent_runtime == AgentRuntime::Codex {
        crate::account::config_dir_of(app, &account_id)
    } else {
        crate::account::claude_config_dir_of(app, &account_id)
    };
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
            agent_runtime,
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
pub fn run_probe(
    app: AppHandle,
    session_id: String,
    block_id: String,
    command: String,
    cwd: String,
    model_id: String,
    runtime: String,
    worktree_distro: Option<String>,
    account_config_dir: Option<String>,
    agent_runtime: AgentRuntime,
    slot: Arc<Mutex<Option<Child>>>,
) {
    let is_codex = agent_runtime == AgentRuntime::Codex;
    let (program, argv) = if is_codex {
        (
            crate::process_util::codex_program(),
            vec!["app-server".into(), "--listen".into(), "stdio://".into()],
        )
    } else {
        let args: Vec<String> = vec![
            "-p".into(),
            format!("/{command}"),
            "--output-format".into(),
            "stream-json".into(),
            "--verbose".into(),
            "--model".into(),
            model_id,
        ];
        claude_invocation(&runtime, &cwd, args, worktree_distro.as_deref())
    };
    // multi-account FR-21/FR-24.
    let env = if is_codex {
        account_env_for_kind(
            account_config_dir.as_deref(),
            crate::account::AccountKind::CodexCli,
            &runtime,
            &[],
        )
    } else {
        account_env(account_config_dir.as_deref(), &runtime, &[])
    };
    let mut cmd = crate::process_util::spawn(program)
        .args(argv)
        .envs(env)
        .stdin(if is_codex {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped());
    if runtime != "wsl" {
        cmd = cmd.current_dir(&cwd); // wsl probes get their cwd via `--cd` inside the distro
    }
    let mut child = match cmd.start() {
        Ok(c) => c,
        Err(_) => {
            // FR-10 with session-engine FR-45's actionable wording where determinable.
            let text = if runtime == "wsl" {
                "couldn't fetch usage \u{2014} WSL not found. Install it (wsl --install) or use the native runtime."
            } else {
                if is_codex {
                    "couldn't fetch usage \u{2014} Codex CLI not found. Install it and ensure `codex` is on PATH."
                } else {
                    "couldn't fetch usage \u{2014} Claude Code CLI not found. Install it and ensure `claude` is on PATH."
                }
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
    let mut stdin = child.stdin.take();
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

    if is_codex {
        // Keep stdin alive while reading: app-server processes requests
        // asynchronously, and closing it here can make it exit after only the
        // initialize response before account/rateLimits/read is handled.
        let Some(input) = stdin.as_mut() else {
            finish_probe(
                &app,
                &session_id,
                &block_id,
                &command,
                CommandCard::Notice {
                    text: "couldn't fetch usage — Codex app server did not open stdin".into(),
                },
            );
            return;
        };
        if let Err(error) = write_codex_usage_requests(input) {
            if let Some(mut c) = slot.lock().unwrap().take() {
                let _ = c.kill();
                let _ = c.wait();
            }
            finish_probe(
                &app,
                &session_id,
                &block_id,
                &command,
                CommandCard::Notice {
                    text: format!("couldn't fetch usage — {error}"),
                },
            );
            return;
        }
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
                Ok(l) => {
                    let done = is_codex && is_codex_rate_limits_response(&l);
                    lines.push(l);
                    if done {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    }
    drop(stdin);
    if let Some(mut c) = slot.lock().unwrap().take() {
        if is_codex {
            let _ = c.kill();
        }
        let _ = c.wait();
    }
    done.store(true, Ordering::SeqCst);

    // Remediation R1: prefer a fully-parsed answer over the timeout notice —
    // an answer read just before the 30s kill must not be discarded (probe_card).
    let card = if is_codex {
        codex_probe_card(&command, &lines, timed_out.load(Ordering::SeqCst))
    } else {
        probe_card(&command, &lines, timed_out.load(Ordering::SeqCst))
    };
    finish_probe(&app, &session_id, &block_id, &command, card);
}

fn write_codex_usage_requests(input: &mut ChildStdin) -> std::io::Result<()> {
    let requests = [
        serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "clientInfo": {
                    "name": "francois",
                    "title": "Francois",
                    "version": env!("CARGO_PKG_VERSION")
                },
                "capabilities": { "experimentalApi": true }
            }
        }),
        serde_json::json!({
            "jsonrpc": "2.0",
            "method": "initialized",
            "params": {}
        }),
        serde_json::json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "account/rateLimits/read",
            "params": {}
        }),
    ];
    for request in requests {
        writeln!(input, "{request}")?;
    }
    input.flush()
}

fn is_codex_rate_limits_response(line: &str) -> bool {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
        return false;
    };
    json_id_is(&value, 2) && (value.get("result").is_some() || value.get("error").is_some())
}

fn codex_probe_card(command: &str, lines: &[String], timed_out: bool) -> CommandCard {
    if timed_out {
        return CommandCard::Notice {
            text: "couldn't fetch usage — timed out".into(),
        };
    }
    for line in lines {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if !json_id_is(&value, 2) {
            continue;
        }
        if let Some(message) = value
            .get("error")
            .and_then(|error| error.get("message"))
            .and_then(serde_json::Value::as_str)
        {
            return CommandCard::Notice {
                text: format!("couldn't fetch usage — {message}"),
            };
        }
        if let Some(answer) = value.get("result").and_then(codex_usage_answer) {
            return usage_card(command, &answer);
        }
    }
    CommandCard::Notice {
        text: "couldn't fetch usage — Codex returned no rate-limit data".into(),
    }
}

fn json_id_is(value: &serde_json::Value, expected: i64) -> bool {
    value
        .get("id")
        .and_then(|id| id.as_i64().or_else(|| id.as_str()?.parse().ok()))
        == Some(expected)
}

fn field<'a>(
    value: &'a serde_json::Value,
    camel: &str,
    snake: &str,
) -> Option<&'a serde_json::Value> {
    value.get(camel).or_else(|| value.get(snake))
}

fn codex_usage_answer(result: &serde_json::Value) -> Option<String> {
    let snapshot = field(result, "rateLimitsByLimitId", "rate_limits_by_limit_id")
        .and_then(|buckets| buckets.get("codex"))
        .or_else(|| field(result, "rateLimits", "rate_limits"));
    let mut lines = Vec::new();
    for (key, fallback_label) in [
        ("primary", "Current session"),
        ("secondary", "Current week"),
    ] {
        let Some(snapshot) = snapshot else {
            break;
        };
        let window_key = match key {
            "primary" => ("primary", "primary_window"),
            _ => ("secondary", "secondary_window"),
        };
        let Some(window) = field(snapshot, window_key.0, window_key.1) else {
            continue;
        };
        let Some(used) = field(window, "usedPercent", "used_percent")
            .and_then(number_as_f64)
            .map(|percent| percent.round().clamp(0.0, 100.0) as u64)
        else {
            continue;
        };
        let label = match field(window, "windowDurationMins", "window_duration_mins")
            .and_then(number_as_i64)
        {
            Some(300) => "Current session",
            Some(10080) => "Current week",
            _ => fallback_label,
        };
        let reset = field(window, "resetsAt", "resets_at")
            .and_then(number_as_i64)
            .and_then(|seconds| chrono::Local.timestamp_opt(seconds, 0).single())
            .map(|at| at.format("%Y-%m-%d %H:%M %Z").to_string())
            .unwrap_or_else(|| "unknown".into());
        lines.push(format!("{label}: {used}% used · resets {reset}"));
    }
    if !lines.is_empty() {
        return Some(lines.join("\n"));
    }

    let plan = snapshot
        .and_then(|value| field(value, "planType", "plan_type"))
        .and_then(serde_json::Value::as_str);
    let allowed = field(result, "ordinaryUsageAllowed", "ordinary_usage_allowed")
        .and_then(serde_json::Value::as_bool)
        .map(|allowed| if allowed { "allowed" } else { "not allowed" });
    match (plan, allowed) {
        (Some(plan), Some(allowed)) => Some(format!(
            "Codex usage limits: {allowed}\nPlan: {plan}\nNo reset windows were returned."
        )),
        (Some(plan), None) => Some(format!(
            "Codex usage limits\nPlan: {plan}\nNo reset windows were returned."
        )),
        (None, Some(allowed)) => Some(format!(
            "Codex usage limits: {allowed}\nNo reset windows were returned."
        )),
        (None, None) => None,
    }
}

fn number_as_f64(value: &serde_json::Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| value.as_str()?.parse::<f64>().ok())
}

fn number_as_i64(value: &serde_json::Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_f64().map(|number| number.round() as i64))
        .or_else(|| value.as_str()?.parse::<i64>().ok())
}

/// Release the probe slot and finalize its pending block (FR-9/10 — a pending
/// command block is never left open). If the session was removed mid-probe,
/// nothing is emitted (session-engine FR-14).
pub fn finish_probe(
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_rate_limits_render_as_usage_meters() {
        let result = serde_json::json!({
            "rateLimitsByLimitId": {
                "codex": {
                    "primary": {
                        "usedPercent": 23,
                        "windowDurationMins": 10080,
                        "resetsAt": 1790240362
                    },
                    "secondary": {
                        "usedPercent": 42,
                        "windowDurationMins": 300,
                        "resetsAt": 1790000000
                    }
                }
            }
        });
        let answer = codex_usage_answer(&result).expect("Codex returned rate limits");
        assert!(answer.contains("Current week: 23% used"));
        assert!(answer.contains("Current session: 42% used"));
        assert!(matches!(
            codex_probe_card(
                "usage",
                &[serde_json::json!({ "id": 2, "result": result }).to_string()],
                false,
            ),
            CommandCard::Usage { .. }
        ));
    }

    #[test]
    fn codex_rate_limits_response_detection_ignores_notifications() {
        assert!(!is_codex_rate_limits_response(
            r#"{"method":"remoteControl/status/changed","params":{}}"#
        ));
        assert!(is_codex_rate_limits_response(
            r#"{"id":2,"result":{"rateLimits":{"primary":{}}}}"#
        ));
    }

    #[test]
    fn codex_rate_limits_accept_snake_case_and_string_values() {
        let result = serde_json::json!({
            "rate_limits": {
                "primary_window": {
                    "used_percent": "17",
                    "window_duration_mins": "10080",
                    "resets_at": "1790240362"
                }
            },
            "ordinary_usage_allowed": true
        });
        let answer = codex_usage_answer(&result).expect("Codex returned rate limits");
        assert!(answer.contains("Current week: 17% used"));
        assert!(is_codex_rate_limits_response(
            r#"{"id":"2","result":{"rate_limits":{"primary_window":{}}}}"#
        ));
    }

    #[test]
    fn codex_plan_status_without_windows_is_still_visible() {
        let result = serde_json::json!({
            "rateLimits": { "planType": "pro" },
            "ordinaryUsageAllowed": true
        });
        let answer = codex_usage_answer(&result).expect("Codex returned plan status");
        assert!(answer.contains("Plan: pro"));
        assert!(answer.contains("No reset windows were returned."));
    }
}
