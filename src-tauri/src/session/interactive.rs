//! locally intercepted slash commands (specs/interactive-commands.md).

use super::*;

use serde::Serialize;
use serde_json::Value;
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};

// ---------- interactive-commands card shapes (contract/common.ts, reproduced) ----------
//
// The CommandCard union + UsageMeter/HelpEntry vocabulary are canonical in
// contract/common.ts; the intercept set / help entries / grammar are canonical in
// contract/interactive-commands.ts. Mirrored here by hand (specs/interactive-commands.md §5).

// `UsageMeter` (contract UsageMeter) is defined in usage.rs and imported above —
// the /usage card and the usage bar must serialize the identical shape.

/// contract HelpEntry — one /help card row.
#[derive(Serialize, Clone)]
pub(crate) struct HelpEntry {
    pub(crate) command: &'static str,
    pub(crate) description: &'static str,
}

/// contract CommandCard — the tagged payload of command.output.
#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub(crate) enum CommandCard {
    /// /usage & /cost, parsed (FR-9). meters non-empty; tail preformatted.
    Usage {
        command: String,
        meters: Vec<UsageMeter>,
        tail: String,
    },
    /// /context (FR-19). The three parse fields serialize as JSON null when the
    /// tokens line didn't match (contract: `number | null` — never omitted).
    Context {
        #[serde(rename = "percentUsed")]
        percent_used: Option<u64>,
        #[serde(rename = "usedLabel")]
        used_label: Option<String>,
        #[serde(rename = "limitLabel")]
        limit_label: Option<String>,
        body: String,
    },
    /// /model bare (FR-12). currentId is a snapshot; the live marker derives from SessionMeta.
    Model {
        models: Vec<ModelInfo>,
        #[serde(rename = "currentId")]
        current_id: String,
    },
    /// /status (FR-14).
    Status { meta: SessionMeta },
    /// /help (FR-15).
    Help { entries: Vec<HelpEntry> },
    /// Dim one-liner: unknown/unavailable command, probe failure, model switch ack.
    Notice { text: String },
    /// Generic CLI-local output that fits no richer card.
    Text { command: String, text: String },
}

// ---------- interactive commands (specs/interactive-commands.md) ----------
//
// Grammar, intercept set, and help entries mirror contract/interactive-commands.ts
// (parseCommand / INTERCEPTED_COMMANDS / HELP_ENTRIES) exactly; the parse rules
// mirror spec §5 (probed against claude 2.1.217, 2026-07-22).

/// FR-2 intercept set — mirrors INTERCEPTED_COMMANDS. These never spawn a turn.
pub(crate) const INTERCEPTED_COMMANDS: [&str; 5] = ["usage", "cost", "model", "status", "help"];

/// /help card contents — mirrors HELP_ENTRIES (FR-15), in display order.
pub(crate) fn help_entries() -> Vec<HelpEntry> {
    vec![
        HelpEntry {
            command: "usage",
            description: "plan usage limits (session + weekly)",
        },
        HelpEntry {
            command: "cost",
            description: "alias of /usage",
        },
        HelpEntry {
            command: "context",
            description: "context window breakdown (runs on the session thread)",
        },
        HelpEntry {
            command: "model",
            description: "show or switch the session model",
        },
        HelpEntry {
            command: "status",
            description: "session snapshot (cwd, model, runtime, context)",
        },
        HelpEntry {
            command: "help",
            description: "this list",
        },
        HelpEntry {
            command: "clear",
            description: "clear this session's transcript and reset context",
        },
    ]
}

/// FR-1 grammar — mirrors parseCommand: the trimmed text is a command iff it is a
/// single line matching `^/([A-Za-z][A-Za-z0-9_-]*)(\s+\S.*)?$`. Returns
/// (token lowercased, arg trimmed). None → normal passthrough turn.
pub(crate) fn parse_command(text: &str) -> Option<(String, Option<String>)> {
    let t = text.trim();
    if t.contains('\n') {
        return None;
    }
    let rest = t.strip_prefix('/')?;
    let bytes = rest.as_bytes();
    if bytes.is_empty() || !bytes[0].is_ascii_alphabetic() {
        return None;
    }
    let mut end = 1;
    while end < bytes.len()
        && (bytes[end].is_ascii_alphanumeric() || bytes[end] == b'_' || bytes[end] == b'-')
    {
        end += 1;
    }
    let token = rest[..end].to_lowercase();
    let after = &rest[end..];
    if after.is_empty() {
        return Some((token, None));
    }
    // the char right after the token must be whitespace (`\s+\S.*`), else no match
    if !after.chars().next().is_some_and(|c| c.is_whitespace()) {
        return None;
    }
    let arg = after.trim();
    if arg.is_empty() {
        return None; // unreachable for trimmed input; defensive
    }
    Some((token, Some(arg.to_string())))
}

/// FR-2: parse + filter to the intercept set. None → normal passthrough turn.
pub(crate) fn intercepted_command(text: &str) -> Option<(String, Option<String>)> {
    parse_command(text).filter(|(c, _)| INTERCEPTED_COMMANDS.contains(&c.as_str()))
}

/// FR-9: parse a /usage//cost answer. ≥1 meter → usage card (meters + tail: the
/// non-meter lines, blank runs collapsed to one, trimmed); else a raw text card.
pub(crate) fn usage_card(command: &str, answer: &str) -> CommandCard {
    let mut meters: Vec<UsageMeter> = Vec::new();
    let mut tail_lines: Vec<&str> = Vec::new();
    for line in answer.lines() {
        match parse_meter_line(line) {
            Some(m) => meters.push(m),
            None => tail_lines.push(line),
        }
    }
    if meters.is_empty() {
        // format drifted — never an error, just the raw answer (FR-9, §7)
        return CommandCard::Text {
            command: command.to_string(),
            text: answer.to_string(),
        };
    }
    let mut collapsed: Vec<&str> = Vec::new();
    for l in tail_lines {
        if l.trim().is_empty()
            && collapsed
                .last()
                .map(|p| p.trim().is_empty())
                .unwrap_or(true)
        {
            continue; // collapse blank-line runs (and drop leading blanks)
        }
        collapsed.push(l);
    }
    let tail = collapsed.join("\n").trim().to_string();
    CommandCard::Usage {
        command: command.to_string(),
        meters,
        tail,
    }
}

/// FR-19: first match of `\*\*Tokens:\*\*\s*(\S+)\s*/\s*(\S+)\s*\((\d+)%\)` →
/// (usedLabel, limitLabel, percentUsed). None on drift → body-only context card.
pub(crate) fn parse_context_tokens(text: &str) -> Option<(String, String, u64)> {
    let mut search = text;
    while let Some(pos) = search.find("**Tokens:**") {
        let after = &search[pos + 11..];
        if let Some(hit) = parse_context_tokens_tail(after) {
            return Some(hit);
        }
        search = after;
    }
    None
}

pub(crate) fn parse_context_tokens_tail(after: &str) -> Option<(String, String, u64)> {
    let s = after.trim_start();
    let slash = s.find('/')?;
    let used = s[..slash].trim_end();
    if used.is_empty() || used.chars().any(|c| c.is_whitespace()) {
        return None;
    }
    let rest = s[slash + 1..].trim_start();
    let paren = rest.find('(')?;
    let limit = rest[..paren].trim_end();
    if limit.is_empty() || limit.chars().any(|c| c.is_whitespace()) {
        return None;
    }
    let tail = &rest[paren + 1..];
    let digits_end = tail
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(tail.len());
    if digits_end == 0 || !tail[digits_end..].starts_with("%)") {
        return None;
    }
    Some((
        used.to_string(),
        limit.to_string(),
        tail[..digits_end].parse().ok()?,
    ))
}

/// FR-19 body normalization: remove `**` bold markers; strip leading `#`-runs
/// (plus one space) from heading lines; table pipes kept verbatim.
pub(crate) fn normalize_context_body(text: &str) -> String {
    text.lines()
        .map(|line| {
            let line = line.replace("**", "");
            if let Some(stripped) = line.strip_prefix('#') {
                let rest = stripped.trim_start_matches('#');
                rest.strip_prefix(' ').unwrap_or(rest).to_string()
            } else {
                line
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// FR-19: build the /context card from the synthetic answer.
pub(crate) fn context_card(answer: &str) -> CommandCard {
    let body = normalize_context_body(answer);
    match parse_context_tokens(answer) {
        Some((used, limit, pct)) => CommandCard::Context {
            percent_used: Some(pct),
            used_label: Some(used),
            limit_label: Some(limit),
            body,
        },
        None => CommandCard::Context {
            percent_used: None,
            used_label: None,
            limit_label: None,
            body,
        },
    }
}

// `synthetic_text` (FR-16 detection) and `probe_answer` (FR-8 answer extraction)
// moved to usage.rs and are imported above — same functions, same behavior.

/// FR-9/10 probe verdict (pure; unit-tested). A fully-parsed answer always wins —
/// even when the 30s watchdog fired while the final bytes were being read — so
/// `timed_out` is consulted only in the no-parsed-answer arm.
pub(crate) fn probe_card(command: &str, lines: &[String], timed_out: bool) -> CommandCard {
    match probe_answer(lines) {
        Some(answer) if !answer.is_empty() => usage_card(command, &answer),
        _ if timed_out => CommandCard::Notice { text: "couldn't fetch usage \u{2014} timed out".into() },
        _ => CommandCard::Notice {
            text: "couldn't fetch usage \u{2014} the Claude Code CLI returned no answer. Run `claude` once in a terminal to authenticate.".into(),
        },
    }
}

/// FR-17: classify a CLI-local answer into a card, in order: (a) context turn →
/// context card; (b) unknown/unavailable → notice verbatim; (c) text card.
pub(crate) fn classify_local_answer(turn_command: Option<&str>, answer: &str) -> CommandCard {
    if turn_command == Some("context") {
        return context_card(answer);
    }
    if answer.starts_with("Unknown command: ")
        || answer.contains("isn't available in this environment")
    {
        return CommandCard::Notice {
            text: answer.to_string(),
        };
    }
    CommandCard::Text {
        command: turn_command.unwrap_or("").to_string(),
        text: answer.to_string(),
    }
}

/// FR-18 predicate: fire the defensive fallback? (turn succeeded, no synthetic
/// message seen, zero assistant/tool blocks, non-empty result string).
pub(crate) fn command_fallback_fires(
    success: bool,
    saw_synthetic: bool,
    saw_blocks: bool,
    result_text: Option<&str>,
) -> bool {
    success && !saw_synthetic && !saw_blocks && result_text.map(|r| !r.is_empty()).unwrap_or(false)
}

/// FR-13: resolve a /model argument against the catalog — exact id match first,
/// else case-insensitive label match.
pub(crate) fn resolve_model_arg<'a>(models: &'a [ModelInfo], arg: &str) -> Option<&'a ModelInfo> {
    models
        .iter()
        .find(|m| m.id == arg)
        .or_else(|| models.iter().find(|m| m.label.eq_ignore_ascii_case(arg)))
}

/// FR-12: the current catalog snapshot for the /model card — same source as
/// francois:session:models (the warmed cache). FR-12/13 require instant: a cold
/// cache serves the tier-alias fallback immediately and kicks a background
/// refresh — never a synchronous fetch on the intercepted-send path.
pub(crate) fn model_catalog_snapshot() -> Vec<ModelInfo> {
    let cached = model_cache().lock().unwrap().clone();
    let (models, needs_refresh) = snapshot_from_cache(cached);
    if needs_refresh {
        std::thread::spawn(|| {
            refresh_models();
        });
    }
    models
}

/// Pure snapshot decision (unit-tested): a warm cache is served as-is; a cold
/// cache yields the tier-alias catalog plus a background-refresh request.
pub(crate) fn snapshot_from_cache(cached: Vec<ModelInfo>) -> (Vec<ModelInfo>, bool) {
    if cached.is_empty() {
        (catalog(), true)
    } else {
        (cached, false)
    }
}

/// Upsert + persist a finalized command block and emit its command.output
/// (FR-9/10/12–18, FR-24). No-op if the session is gone (session-engine FR-14).
pub(crate) fn finalize_command_block(
    app: &AppHandle,
    session_id: &str,
    block_id: &str,
    command: &str,
    card: &CommandCard,
) {
    let card_json = serde_json::to_value(card).unwrap_or(Value::Null);
    let engine = app.state::<Engine>();
    let block = {
        let mut map = engine.sessions.lock().unwrap();
        let Some(s) = map.get_mut(session_id) else {
            return;
        };
        s.buf_command_output(block_id, command, card_json.clone());
        s.last_activity_at = now_ms();
        s.block_buffer
            .iter()
            .find(|b| b.block_id == block_id)
            .cloned()
    };
    if let Some(b) = &block {
        append_transcript(app, session_id, b);
    }
    emit(
        app,
        SessionEvent::CommandOutput {
            session_id: session_id.into(),
            block_id: block_id.into(),
            card: card_json,
        },
    );
}

/// Per-command flow for an intercepted command (FR-5..FR-15). The user block is
/// already buffered and message.user emitted (FR-4).
pub(crate) fn run_intercepted_command(
    app: &AppHandle,
    session_id: &str,
    command: &str,
    arg: Option<&str>,
) {
    match command {
        // FR-5: a present arg is ignored for usage/cost/status/help.
        "usage" | "cost" => start_usage_probe(app, session_id, command),
        "model" => run_model_command(app, session_id, arg),
        "status" => {
            // FR-14: instant snapshot card
            let meta = {
                let engine = app.state::<Engine>();
                let map = engine.sessions.lock().unwrap();
                map.get(session_id).map(|s| s.meta())
            };
            if let Some(meta) = meta {
                finalize_command_block(
                    app,
                    session_id,
                    &uuid(),
                    "status",
                    &CommandCard::Status { meta },
                );
            }
        }
        "help" => {
            finalize_command_block(
                app,
                session_id,
                &uuid(),
                "help",
                &CommandCard::Help {
                    entries: help_entries(),
                },
            );
        }
        _ => {}
    }
}

/// /model — bare: catalog card (FR-12); with an argument: resolve + switch or an
/// unknown-model notice (FR-13). Instant either way; no status change.
pub(crate) fn run_model_command(app: &AppHandle, session_id: &str, arg: Option<&str>) {
    let models = model_catalog_snapshot();
    let Some(arg) = arg else {
        let current_id = {
            let engine = app.state::<Engine>();
            let map = engine.sessions.lock().unwrap();
            let Some(s) = map.get(session_id) else { return };
            s.model_id.clone()
        };
        finalize_command_block(
            app,
            session_id,
            &uuid(),
            "model",
            &CommandCard::Model { models, current_id },
        );
        return;
    };
    match resolve_model_arg(&models, arg) {
        Some(m) => {
            let (id, label) = (m.id.clone(), m.label.clone());
            if apply_model_switch(app, session_id, &id).is_some() {
                finalize_command_block(
                    app,
                    session_id,
                    &uuid(),
                    "model",
                    &CommandCard::Notice {
                        text: format!("model \u{2192} {label}"),
                    },
                );
            }
        }
        None => {
            let ids: Vec<&str> = models.iter().map(|m| m.id.as_str()).collect();
            finalize_command_block(
                app,
                session_id,
                &uuid(),
                "model",
                &CommandCard::Notice {
                    text: format!(
                        "unknown model: {arg} \u{2014} available: {}",
                        ids.join(", ")
                    ),
                },
            );
        }
    }
}

/// FR-6/7/11: begin the /usage//cost detached side-spawn — reserve the single probe
/// slot, emit command.started + a pending block, then probe on a detached thread.
/// Invisible to the turn lifecycle: status, queue, claude_session_id and
/// contextUsedTokens are never touched.
pub(crate) fn start_usage_probe(app: &AppHandle, session_id: &str, command: &str) {
    let engine = app.state::<Engine>();
    let block_id = uuid();
    let (cwd, model_id, runtime, slot) = {
        let mut map = engine.sessions.lock().unwrap();
        let Some(s) = map.get_mut(session_id) else {
            return;
        };
        let Some(slot) = s.reserve_probe(&block_id) else {
            // FR-11: one in-flight probe per session → instant notice on a fresh block.
            drop(map);
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
        };
        s.buf_command_pending(&block_id, command);
        s.last_activity_at = now_ms();
        (s.cwd.clone(), s.model_id.clone(), s.runtime.clone(), slot)
    };
    emit(
        app,
        SessionEvent::CommandStarted {
            session_id: session_id.into(),
            block_id: block_id.clone(),
            command: command.into(),
        },
    );
    let app = app.clone();
    let sid = session_id.to_string();
    let command = command.to_string();
    std::thread::spawn(move || {
        run_probe(app, sid, block_id, command, cwd, model_id, runtime, slot)
    });
}

/// FR-7/8/9/10: the detached probe body. Same invocation machinery as turns
/// (session runtime incl. WSL + session cwd); NO --resume, no permission flags.
#[allow(clippy::too_many_arguments)]
pub(crate) fn run_probe(
    app: AppHandle,
    session_id: String,
    block_id: String,
    command: String,
    cwd: String,
    model_id: String,
    runtime: String,
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
    let (program, argv) = claude_invocation(&runtime, &cwd, args);
    let mut cmd = Command::new(program);
    cmd.args(argv);
    if runtime != "wsl" {
        cmd.current_dir(&cwd); // wsl probes get their cwd via `--cd` inside the distro
    }
    if let Some(path) = claude_path_env() {
        cmd.env("PATH", path);
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
    let still_wanted = {
        let engine = app.state::<Engine>();
        let map = engine.sessions.lock().unwrap();
        map.get(&session_id)
            .and_then(|s| s.pending_probe.as_ref())
            .map(|p| p.block_id == block_id)
            .unwrap_or(false)
    };
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
    {
        let engine = app.state::<Engine>();
        let mut map = engine.sessions.lock().unwrap();
        let Some(s) = map.get_mut(session_id) else {
            return;
        };
        match &s.pending_probe {
            Some(p) if p.block_id == block_id => s.pending_probe = None,
            _ => return, // superseded or cancelled — never finalize another probe's block
        }
    }
    finalize_command_block(app, session_id, block_id, command, &card);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::testutil::*;
    use serde_json::json;

    #[test]
    fn help_and_merge_include_clear_builtin() {
        // /clear is discoverable via /help and the merged slash-command registry,
        // but is NOT in the intercept set (the frontend calls session_clear).
        assert!(help_entries().iter().any(|h| h.command == "clear"));
        let merged = merge_commands(&help_entries(), &[], &[]);
        let clear = merged.iter().find(|c| c.name == "clear").unwrap();
        assert_eq!(clear.source, "builtin");
        assert!(!INTERCEPTED_COMMANDS.contains(&"clear"));
        assert_eq!(INTERCEPTED_COMMANDS.len(), 5); // unchanged
    }

    #[test]
    fn command_grammar_parses_and_lowercases() {
        // FR-1: single-line `/token [arg]`, token lowercased, arg trimmed
        assert_eq!(parse_command("/usage"), Some(("usage".into(), None)));
        assert_eq!(parse_command("  /USAGE  "), Some(("usage".into(), None)));
        assert_eq!(
            parse_command("/model opus"),
            Some(("model".into(), Some("opus".into())))
        );
        // arg keeps its case and interior spacing; ends trimmed
        assert_eq!(
            parse_command("/model  Opus 4.5 "),
            Some(("model".into(), Some("Opus 4.5".into())))
        );
        assert_eq!(
            parse_command("/spec-x_2 arg"),
            Some(("spec-x_2".into(), Some("arg".into())))
        );
    }

    #[test]
    fn command_grammar_rejects_non_commands() {
        assert_eq!(parse_command("hello"), None);
        assert_eq!(parse_command("/"), None);
        assert_eq!(parse_command("/9lives"), None); // token must start with a letter
        assert_eq!(parse_command("/foo!bar"), None); // arg must be whitespace-separated
        assert_eq!(parse_command("/usage\nmore"), None); // multiline is never a command (FR-1)
        assert_eq!(parse_command("  /usage\nmore  "), None);
    }

    #[test]
    fn intercept_set_matches_contract() {
        // FR-2: exactly usage/cost/model/status/help are intercepted
        for c in [
            "/usage",
            "/cost",
            "/model",
            "/status",
            "/help",
            "/USAGE",
            "/usage extra words",
        ] {
            assert!(
                intercepted_command(c).is_some(),
                "{c} should be intercepted"
            );
        }
        // passthrough: /context, /compact, custom skills, unknowns, multiline, plain text
        for c in [
            "/context",
            "/compact",
            "/spec something",
            "/frobnicate",
            "/usage\nx",
            "usage",
        ] {
            assert!(intercepted_command(c).is_none(), "{c} must pass through");
        }
    }

    // The meter-grammar tests (`meter_line_*`), the answer-extraction tests
    // (`probe_answer_*`) and `synthetic_detection_requires_synthetic_model` moved
    // to usage.rs with their functions (usage-bar §6) — unchanged.

    #[test]
    fn usage_card_parses_meters_and_tail() {
        let answer = "Current session: 14% used \u{b7} resets Jul 22, 5:29pm (Europe/Paris)\nCurrent week (all models): 34% used \u{b7} resets Jul 25, 11:00am (Europe/Paris)\n\n\nWhat's contributing:\n\u{2022} lots of turns";
        let CommandCard::Usage {
            command,
            meters,
            tail,
        } = usage_card("usage", answer)
        else {
            panic!("expected a usage card");
        };
        assert_eq!(command, "usage");
        assert_eq!(meters.len(), 2);
        assert_eq!(meters[1].label, "Current week (all models)");
        // tail = answer minus meter lines, blank runs collapsed, trimmed (§5)
        assert_eq!(tail, "What's contributing:\n\u{2022} lots of turns");
    }

    #[test]
    fn usage_tail_collapses_blank_runs() {
        let answer = "Current session: 1% used \u{b7} resets soon\ntop\n\n\n\nbottom";
        let CommandCard::Usage { tail, .. } = usage_card("cost", answer) else {
            panic!("expected a usage card");
        };
        assert_eq!(tail, "top\n\nbottom");
    }

    #[test]
    fn usage_card_drift_falls_back_to_text() {
        // FR-9: no meter matches → raw text card, never an error
        let CommandCard::Text { command, text } = usage_card("usage", "totally new format") else {
            panic!("expected a text card");
        };
        assert_eq!(command, "usage");
        assert_eq!(text, "totally new format");
    }

    #[test]
    fn context_tokens_parses_and_drifts() {
        assert_eq!(
            parse_context_tokens("## Context\n**Tokens:** 26.4k / 200k (13%)\nmore"),
            Some(("26.4k".into(), "200k".into(), 13))
        );
        assert_eq!(
            parse_context_tokens("**Tokens:** 26.4k/200k (13%)"),
            Some(("26.4k".into(), "200k".into(), 13))
        );
        // drift → None (FR-19 body-only fallback)
        assert!(parse_context_tokens("Tokens: 26.4k / 200k (13%)").is_none());
        assert!(parse_context_tokens("**Tokens:** 26.4k of 200k (13%)").is_none());
        assert!(parse_context_tokens("").is_none());
    }

    #[test]
    fn context_card_normalizes_body() {
        let answer = "## Context Usage\n**Tokens:** 26.4k / 200k (13%)\n| Category | Tokens |\n|---|---|\n**System prompt** stays";
        let CommandCard::Context {
            percent_used,
            used_label,
            limit_label,
            body,
        } = context_card(answer)
        else {
            panic!("expected a context card");
        };
        assert_eq!(percent_used, Some(13));
        assert_eq!(used_label.as_deref(), Some("26.4k"));
        assert_eq!(limit_label.as_deref(), Some("200k"));
        // `**` removed, heading '#'-run + one space stripped, table pipes verbatim (FR-19)
        assert_eq!(body, "Context Usage\nTokens: 26.4k / 200k (13%)\n| Category | Tokens |\n|---|---|\nSystem prompt stays");
    }

    #[test]
    fn context_card_without_tokens_line_is_body_only() {
        let CommandCard::Context {
            percent_used,
            used_label,
            limit_label,
            body,
        } = context_card("just text")
        else {
            panic!("expected a context card");
        };
        assert!(percent_used.is_none() && used_label.is_none() && limit_label.is_none());
        assert_eq!(body, "just text");
    }

    #[test]
    fn model_snapshot_cold_cache_serves_catalog_instantly() {
        // Remediation R1 / FR-12-13: cold cache → tier-alias fallback served
        // immediately (background refresh requested), never a synchronous fetch.
        let (models, needs_refresh) = snapshot_from_cache(Vec::new());
        assert!(needs_refresh);
        assert_eq!(
            models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            ["sonnet", "opus", "haiku"]
        );
        // warm cache is served as-is, no refresh kicked
        let (models, needs_refresh) =
            snapshot_from_cache(vec![model("claude-opus-4-8", "Opus 4.8")]);
        assert!(!needs_refresh);
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "claude-opus-4-8");
    }

    #[test]
    fn probe_card_prefers_parsed_answer_over_timeout() {
        // Remediation R1 / FR-10 watchdog-finish race: an answer fully read just
        // before the 30s kill wins; timed_out only matters with no parsed answer.
        let lines = ndjson(&[
            json!({ "type": "assistant", "message": { "model": "<synthetic>",
            "content": [{ "type": "text", "text": "Current session: 14% used \u{b7} resets soon" }] } }),
        ]);
        assert!(matches!(
            probe_card("usage", &lines, true),
            CommandCard::Usage { .. }
        ));
        assert!(matches!(
            probe_card("usage", &lines, false),
            CommandCard::Usage { .. }
        ));
        // no parsed answer + timed out → timeout notice
        let CommandCard::Notice { text } = probe_card("usage", &[], true) else {
            panic!("expected a notice")
        };
        assert!(text.contains("timed out"));
        // no parsed answer, no timeout → no-answer notice
        let CommandCard::Notice { text } = probe_card("usage", &[], false) else {
            panic!("expected a notice")
        };
        assert!(text.contains("no answer"));
    }

    #[test]
    fn classify_local_answer_follows_fr17_order() {
        // (a) context turn → context card
        assert!(matches!(
            classify_local_answer(Some("context"), "**Tokens:** 1k / 2k (50%)"),
            CommandCard::Context { .. }
        ));
        // (b) unknown / unavailable → notice, verbatim
        let CommandCard::Notice { text } =
            classify_local_answer(Some("frobnicate"), "Unknown command: /frobnicate")
        else {
            panic!("expected a notice card");
        };
        assert_eq!(text, "Unknown command: /frobnicate");
        assert!(matches!(
            classify_local_answer(
                Some("status"),
                "/status isn't available in this environment."
            ),
            CommandCard::Notice { .. }
        ));
        // (c) otherwise → text card with the turn's command token (or '')
        let CommandCard::Text { command, text } =
            classify_local_answer(Some("foo"), "some local output")
        else {
            panic!("expected a text card");
        };
        assert_eq!(
            (command.as_str(), text.as_str()),
            ("foo", "some local output")
        );
        let CommandCard::Text { command, .. } = classify_local_answer(None, "output") else {
            panic!("expected a text card");
        };
        assert_eq!(command, "");
    }

    #[test]
    fn fr18_fallback_truth_table() {
        assert!(command_fallback_fires(
            true,
            false,
            false,
            Some("Unknown command: /x")
        ));
        assert!(!command_fallback_fires(false, false, false, Some("x"))); // turn not a success
        assert!(!command_fallback_fires(true, true, false, Some("x"))); // synthetic already carded
        assert!(!command_fallback_fires(true, false, true, Some("x"))); // real blocks streamed
        assert!(!command_fallback_fires(true, false, false, Some(""))); // empty result
        assert!(!command_fallback_fires(true, false, false, None));
    }

    #[test]
    fn command_card_kinds_serialize_to_contract_shape() {
        let usage = serde_json::to_value(CommandCard::Usage {
            command: "cost".into(),
            meters: vec![UsageMeter {
                label: "Current session".into(),
                percent_used: 14,
                resets_at: "Jul 22, 5:29pm (Europe/Paris)".into(),
            }],
            tail: "tail".into(),
        })
        .unwrap();
        assert_eq!(
            usage,
            json!({ "kind": "usage", "command": "cost", "tail": "tail",
            "meters": [{ "label": "Current session", "percentUsed": 14, "resetsAt": "Jul 22, 5:29pm (Europe/Paris)" }] })
        );

        // context nulls serialize as JSON null (contract: number | null), never omitted
        let ctx = serde_json::to_value(CommandCard::Context {
            percent_used: None,
            used_label: None,
            limit_label: None,
            body: "b".into(),
        })
        .unwrap();
        assert_eq!(
            ctx,
            json!({ "kind": "context", "percentUsed": null, "usedLabel": null, "limitLabel": null, "body": "b" })
        );

        let model_card = serde_json::to_value(CommandCard::Model {
            models: vec![model("opus", "Opus")],
            current_id: "opus".into(),
        })
        .unwrap();
        assert_eq!(
            model_card,
            json!({ "kind": "model", "currentId": "opus", "models": [{ "id": "opus", "label": "Opus" }] })
        );

        let help = serde_json::to_value(CommandCard::Help {
            entries: help_entries(),
        })
        .unwrap();
        assert_eq!(help["kind"], "help");
        assert_eq!(help["entries"].as_array().unwrap().len(), 7);
        assert_eq!(
            help["entries"][0],
            json!({ "command": "usage", "description": "plan usage limits (session + weekly)" })
        );

        let text = serde_json::to_value(CommandCard::Text {
            command: "".into(),
            text: "raw".into(),
        })
        .unwrap();
        assert_eq!(
            text,
            json!({ "kind": "text", "command": "", "text": "raw" })
        );

        let status = serde_json::to_value(CommandCard::Status {
            meta: test_session().meta(),
        })
        .unwrap();
        assert_eq!(status["kind"], "status");
        assert_eq!(status["meta"]["permissionMode"], "default");
        assert_eq!(status["meta"]["contextLimitTokens"], 200_000);
    }

    #[test]
    fn probe_guard_is_single_flight_per_session() {
        let mut s = test_session();
        assert!(s.reserve_probe("b1").is_some());
        assert!(s.reserve_probe("b2").is_none()); // FR-11: at most one in-flight probe
        s.pending_probe = None; // probe finalized
        assert!(s.reserve_probe("b3").is_some());
    }

    #[test]
    fn model_arg_resolution_id_then_label_case_insensitive() {
        let models = vec![
            model("claude-opus-4-8", "Opus 4.8"),
            model("sonnet", "Sonnet"),
        ];
        // exact id
        assert_eq!(
            resolve_model_arg(&models, "claude-opus-4-8").unwrap().label,
            "Opus 4.8"
        );
        // label, case-insensitive (FR-13)
        assert_eq!(
            resolve_model_arg(&models, "opus 4.8").unwrap().id,
            "claude-opus-4-8"
        );
        assert_eq!(resolve_model_arg(&models, "SONNET").unwrap().id, "sonnet");
        // id match wins over a label collision
        let tricky = vec![model("sonnet", "Opus"), model("opus", "Opus")];
        assert_eq!(resolve_model_arg(&tricky, "opus").unwrap().id, "opus");
        // unknown
        assert!(resolve_model_arg(&models, "gpt-5").is_none());
    }
}
