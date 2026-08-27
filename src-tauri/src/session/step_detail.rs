//! command-inspect: the per-tool-step capture record (`StepDetail`, contract
//! `contract/command-inspect.ts` §5), its append-only sidecar
//! (`transcripts/<sessionId>.details.jsonl`), and the
//! `francois:conversation:stepDetail` command that reads it back.
//!
//! Capture is adapter-agnostic: every adapter that settles a tool call builds
//! one `StepDetail` (via `build_step_detail`) and appends it through
//! `SessionEnv::append_step_detail` (session/env.rs) — the same abstraction
//! `append_transcript` already uses, so the parse path stays testable without
//! a live `AppHandle`. The sidecar itself follows the exact pattern
//! `persistence.rs` already established for the transcript file it shadows
//! (same `valid_session_id` guard, same append/read/sweep shape).

use super::*;

use crate::ipc::{err, ok, ErrorCode, IpcResult};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager, State};

/// FR-5: cut the kept tail on a line boundary at this many bytes.
const OUTPUT_CAP_BYTES: usize = 64 * 1024;

// ---------- StepDetail (contract/command-inspect.ts §5) ----------

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct StepCommand {
    pub(crate) command: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) description: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct StepOutput {
    pub(crate) text: String,
    #[serde(rename = "totalLines")]
    pub(crate) total_lines: u64,
    #[serde(rename = "totalBytes")]
    pub(crate) total_bytes: u64,
    #[serde(rename = "droppedLines")]
    pub(crate) dropped_lines: u64,
    #[serde(rename = "stderrLines", skip_serializing_if = "Option::is_none")]
    pub(crate) stderr_lines: Option<u64>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind")]
pub enum StepBody {
    #[serde(rename = "command")]
    Command {
        command: StepCommand,
        output: StepOutput,
    },
    #[serde(rename = "generic")]
    Generic {
        #[serde(rename = "inputJson")]
        input_json: String,
        output: StepOutput,
    },
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct StepDetail {
    #[serde(rename = "blockId")]
    pub(crate) block_id: String,
    pub(crate) tool: String,
    pub(crate) cwd: String,
    pub(crate) runtime: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) distro: Option<String>,
    #[serde(rename = "startedAt")]
    pub(crate) started_at: u64,
    #[serde(rename = "endedAt", skip_serializing_if = "Option::is_none")]
    pub(crate) ended_at: Option<u64>,
    #[serde(rename = "isError")]
    pub(crate) is_error: bool,
    #[serde(rename = "exitCode", skip_serializing_if = "Option::is_none")]
    pub(crate) exit_code: Option<i64>,
    pub(crate) body: StepBody,
}

// ---------- capture (FR-1..FR-6) ----------

/// FR-2: `distro` only when `runtime == "wsl"` and `cwd` parses as a WSL UNC path.
pub(crate) fn derive_distro(runtime: &str, cwd: &str) -> Option<String> {
    if runtime != "wsl" {
        return None;
    }
    crate::wsl::wsl_unc_to_linux(cwd).map(|(distro, _linux_path)| distro)
}

/// Drop every `__`-prefixed key the engine injects into a tool's finalized
/// input for its own bookkeeping (`__agentId`, `__workflowId`, a stray
/// `__acc`) — none of them were part of what the model actually sent.
fn strip_internal_keys(input: &Value) -> Value {
    match input.as_object() {
        Some(obj) => Value::Object(
            obj.iter()
                .filter(|(k, _)| !k.starts_with("__"))
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect(),
        ),
        None => input.clone(),
    }
}

/// FR-5/FR-6: the tail slice actually kept, cut on a line boundary at
/// `OUTPUT_CAP_BYTES`, alongside the TRUE totals of the full result.
pub(crate) fn compute_output(full: &str, stderr_lines: Option<u64>) -> StepOutput {
    let total_bytes = full.len() as u64;
    if full.is_empty() {
        return StepOutput {
            text: String::new(),
            total_lines: 0,
            total_bytes: 0,
            dropped_lines: 0,
            stderr_lines,
        };
    }
    let total_lines = line_count(full) as u64;
    if full.len() <= OUTPUT_CAP_BYTES {
        return StepOutput {
            text: full.to_string(),
            total_lines,
            total_bytes,
            dropped_lines: 0,
            stderr_lines,
        };
    }
    let mut start = full.len() - OUTPUT_CAP_BYTES;
    while start < full.len() && !full.is_char_boundary(start) {
        start += 1;
    }
    // Drop the leading partial line in the cap window — the kept text starts
    // clean at the next line boundary, never mid-line. If the window has no
    // newline at all (one unbroken blob over the cap), fall back to the raw
    // window verbatim rather than dropping the whole captured output.
    let tail = match full[start..].find('\n') {
        Some(nl) => &full[start..][nl + 1..],
        None => &full[start..],
    };
    let kept_lines = line_count(tail) as u64;
    StepOutput {
        text: tail.to_string(),
        total_lines,
        total_bytes,
        dropped_lines: total_lines.saturating_sub(kept_lines),
        stderr_lines,
    }
}

/// FR-3: `'command'` for `Bash` when its input carries a string `command` —
/// verbatim, never re-quoted/re-escaped/normalized. Every other case
/// (including a malformed Bash call) falls back to `'generic'`, matching §7's
/// "unparseable input is never a capture failure". The generic path reuses
/// `permissions::input_json` (same pretty-print + 4000-char cap
/// `PermissionAsk.inputJson` already applies) once the `__`-prefixed keys are
/// stripped, rather than re-implementing that truncation here.
fn build_body(tool: &str, input: &Value, output: StepOutput) -> StepBody {
    let clean = strip_internal_keys(input);
    if tool == "Bash" {
        if let Some(command) = clean.get("command").and_then(|v| v.as_str()) {
            let description = clean
                .get("description")
                .and_then(|v| v.as_str())
                .map(String::from);
            return StepBody::Command {
                command: StepCommand {
                    command: command.to_string(),
                    description,
                },
                output,
            };
        }
    }
    StepBody::Generic {
        input_json: crate::permissions::input_json(&clean),
        output,
    }
}

/// FR-1..FR-6: assemble one settled step's record. `exit_code`/`stderr_lines`
/// are `None` for a runtime that states neither (claude-code, FR-4/FR-6) —
/// callers for a runtime that DOES state one pass it through.
// The 11 parameters mirror `StepDetail`'s own fields 1:1 (plus the raw
// `input`/`result_text`/`stderr_lines` that `build_body`/`compute_output`
// still need to derive `body`) — a builder struct would clear this if the
// list grows past `StepDetail`'s own shape.
#[allow(clippy::too_many_arguments)]
pub(crate) fn build_step_detail(
    block_id: &str,
    tool: &str,
    cwd: &str,
    runtime: &str,
    started_at: u64,
    ended_at: u64,
    is_error: bool,
    exit_code: Option<i64>,
    input: &Value,
    result_text: &str,
    stderr_lines: Option<u64>,
) -> StepDetail {
    let output = compute_output(result_text, stderr_lines);
    StepDetail {
        block_id: block_id.to_string(),
        tool: tool.to_string(),
        cwd: cwd.to_string(),
        runtime: runtime.to_string(),
        distro: derive_distro(runtime, cwd),
        started_at,
        ended_at: Some(ended_at),
        is_error,
        exit_code,
        body: build_body(tool, input, output),
    }
}

// ---------- sidecar (FR-1/FR-7/FR-11) ----------

/// `transcripts/<sessionId>.details.jsonl` — same sanitization `transcript_path`
/// applies (persistence.rs), so a session id can never escape the transcripts dir.
pub(crate) fn step_detail_path(app: &AppHandle, session_id: &str) -> Option<std::path::PathBuf> {
    if !valid_session_id(session_id) {
        return None;
    }
    app.path().app_data_dir().ok().map(|d| {
        d.join("transcripts")
            .join(format!("{session_id}.details.jsonl"))
    })
}

/// FR-1: append-only. Best-effort, like `append_transcript` — a write failure
/// must never break the turn.
pub(crate) fn append_step_detail(app: &AppHandle, session_id: &str, detail: &StepDetail) {
    use std::io::Write as _;
    let Some(path) = step_detail_path(app, session_id) else {
        return;
    };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let mut line = serde_json::to_string(detail).unwrap_or_default();
    line.push('\n');
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let _ = f.write_all(line.as_bytes());
    }
}

/// FR-11: the LAST line for `block_id` wins; a malformed line is skipped
/// rather than failing the whole read (§7). Pure — the whole read rule lives
/// here so it is testable without an `AppHandle`; scanning from the end also
/// stops at the first hit instead of parsing the whole sidecar.
pub(crate) fn pick_last_detail(content: &str, block_id: &str) -> Option<StepDetail> {
    content
        .lines()
        .rev()
        .filter_map(|l| serde_json::from_str::<StepDetail>(l).ok())
        .find(|d| d.block_id == block_id)
}

/// FR-11: read one settled step's record back off the sidecar.
pub(crate) fn read_step_detail(
    app: &AppHandle,
    session_id: &str,
    block_id: &str,
) -> Option<StepDetail> {
    let path = step_detail_path(app, session_id)?;
    let content = std::fs::read_to_string(&path).ok()?;
    pick_last_detail(&content, block_id)
}

/// FR-7: swept alongside the transcript file it shadows.
pub(crate) fn remove_step_detail_sidecar(app: &AppHandle, session_id: &str) {
    if let Some(path) = step_detail_path(app, session_id) {
        let _ = std::fs::remove_file(&path);
    }
}

/// The on-disk retention bound for the sidecar — matches `TRANSCRIPT_COMPACT_CAP`
/// (persistence.rs) so a compacted sidecar never outlives the transcript blocks
/// it shadows. `append_step_detail` only ever appends, so without a
/// disk-side counterpart to that bound the sidecar grows for the whole life
/// of every retained session.
pub(crate) const STEP_DETAIL_COMPACT_CAP: usize = super::persistence::TRANSCRIPT_COMPACT_CAP;

/// Compact one session's step-detail sidecar to its last
/// `STEP_DETAIL_COMPACT_CAP` records, deduped so only the LAST line for each
/// `block_id` survives — the same "last wins" rule `pick_last_detail` already
/// reads by (FR-11). Best-effort, temp+rename: an interrupted compaction
/// leaves the ORIGINAL file intact, and any read/write failure here is
/// silently ignored, matching `compact_transcript_file`'s discipline.
/// Callers must never run this on a session mid-turn — same edge case #7
/// `compact_all_transcripts` already guards against.
pub(crate) fn compact_step_detail(app: &AppHandle, session_id: &str) {
    let Some(path) = step_detail_path(app, session_id) else {
        return;
    };
    compact_step_detail_file(&path);
}

/// The pure file-rewrite half of `compact_step_detail`, over a plain path —
/// split out so it is testable without an `AppHandle`.
fn compact_step_detail_file(path: &std::path::Path) {
    let Ok(content) = std::fs::read_to_string(path) else {
        return;
    };
    // Keep only the last record per block_id (FR-11 "last wins"), then trim
    // to the last STEP_DETAIL_COMPACT_CAP of those, oldest-first.
    let mut seen = std::collections::HashSet::new();
    let mut kept: Vec<StepDetail> = content
        .lines()
        .rev()
        .filter_map(|l| serde_json::from_str::<StepDetail>(l).ok())
        .filter(|d| seen.insert(d.block_id.clone()))
        .collect();
    kept.reverse();
    if kept.len() > STEP_DETAIL_COMPACT_CAP {
        kept = kept.split_off(kept.len() - STEP_DETAIL_COMPACT_CAP);
    }
    if kept.len() == content.lines().count() {
        return; // already deduped and at/under the cap — nothing to rewrite
    }
    let mut out = String::new();
    for d in &kept {
        out.push_str(&serde_json::to_string(d).unwrap_or_default());
        out.push('\n');
    }
    let tmp = path.with_extension("jsonl.tmp");
    if std::fs::write(&tmp, out.as_bytes()).is_ok() && std::fs::rename(&tmp, path).is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
}

/// FR-10 counterpart for the sidecar: compact every session's step-detail
/// file on a clean shutdown, alongside `compact_all_transcripts`. Skips a
/// session mid-turn (edge case #7), same as the transcript compaction.
pub fn compact_all_step_details(app: &AppHandle) {
    let engine = app.state::<Engine>();
    let ids: Vec<String> = {
        let map = engine.sessions.lock().unwrap_or_else(|p| p.into_inner());
        map.values()
            .filter(|s| !status::is_busy(&s.status))
            .map(|s| s.id.clone())
            .collect()
    };
    for id in ids {
        compact_step_detail(app, &id);
    }
}

/// FR-7: "a sidecar with no transcript is removed on load" — a startup sweep
/// of the transcripts dir for a `<id>.details.jsonl` with no sibling
/// `<id>.jsonl`. Best-effort: a directory that cannot be listed is a no-op.
pub(crate) fn sweep_orphaned_step_detail_sidecars(app: &AppHandle) {
    let Some(dir) = app
        .path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("transcripts"))
    else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let Some(id) = name.strip_suffix(".details.jsonl") else {
            continue;
        };
        if !valid_session_id(id) {
            continue;
        }
        if !dir.join(format!("{id}.jsonl")).exists() {
            let _ = std::fs::remove_file(&path);
        }
    }
}

// ---------- francois:conversation:stepDetail ----------

/// Tauri command `conversation_step_detail` (FR-11). Read-only, never blocks
/// on a turn — resolves straight off the sidecar.
#[tauri::command(async)]
pub fn conversation_step_detail(
    app: AppHandle,
    engine: State<'_, Engine>,
    session_id: String,
    block_id: String,
) -> IpcResult<Value> {
    if engine.with_session(&session_id, |_| ()).is_none() {
        return err(ErrorCode::SessionNotFound, "no such session");
    }
    match read_step_detail(&app, &session_id, &block_id) {
        Some(detail) => ok(serde_json::to_value(detail).unwrap()),
        None => err(ErrorCode::StepDetailNotFound, "no record for that step"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ---------- derive_distro (FR-2) ----------

    #[test]
    fn distro_only_on_wsl_runtime_with_a_wsl_unc_cwd() {
        assert_eq!(
            derive_distro("wsl", "\\\\wsl$\\Ubuntu-22.04\\home\\u\\api"),
            Some("Ubuntu-22.04".into())
        );
        assert_eq!(derive_distro("native", "\\\\wsl$\\Ubuntu\\home\\u"), None);
        assert_eq!(derive_distro("wsl", "/home/u/api"), None); // not a UNC path
        assert_eq!(derive_distro("wsl", "D:\\acme-api"), None);
    }

    // ---------- compute_output (FR-5/FR-6) ----------

    #[test]
    fn empty_result_yields_no_strip_worth_of_data() {
        let o = compute_output("", None);
        assert_eq!(
            o,
            StepOutput {
                text: String::new(),
                total_lines: 0,
                total_bytes: 0,
                dropped_lines: 0,
                stderr_lines: None,
            }
        );
    }

    #[test]
    fn a_result_at_or_under_the_cap_is_kept_whole_with_zero_dropped_lines() {
        let text = "line1\nline2\nline3";
        let o = compute_output(text, None);
        assert_eq!(o.text, text);
        assert_eq!(o.total_lines, 3);
        assert_eq!(o.total_bytes, text.len() as u64);
        assert_eq!(o.dropped_lines, 0);
    }

    #[test]
    fn a_result_over_the_cap_keeps_the_tail_cut_on_a_line_boundary() {
        // Each line is 10 bytes ("0000000\n" style padded to a fixed width) so the
        // math is exact: 8000 lines of 9 bytes = 72000 bytes, well over the 64KB cap.
        let mut full = String::new();
        for i in 0..8000 {
            full.push_str(&format!("{i:08}\n"));
        }
        let o = compute_output(&full, None);
        assert_eq!(o.total_bytes, full.len() as u64);
        assert_eq!(o.total_lines, 8000);
        assert!(o.text.len() <= OUTPUT_CAP_BYTES);
        assert!(o.dropped_lines > 0);
        assert_eq!(o.total_lines, o.dropped_lines + line_count(&o.text) as u64);
        // The kept text starts at a line boundary — never a partial line.
        assert!(full.ends_with(&o.text));
        assert!(!o.text.is_empty());
    }

    #[test]
    fn a_result_with_no_newline_in_the_cap_window_keeps_the_raw_tail_instead_of_going_empty() {
        // One unbroken blob well over the cap — no '\n' anywhere, so the
        // line-boundary search inside the cap window never finds one. The
        // kept text must still be non-empty (a mid-line cut is acceptable;
        // dropping everything is not).
        let full = "x".repeat(OUTPUT_CAP_BYTES * 2);
        let o = compute_output(&full, None);
        assert_eq!(o.total_bytes, full.len() as u64);
        assert!(!o.text.is_empty());
        assert!(o.text.len() <= OUTPUT_CAP_BYTES);
        assert!(full.ends_with(&o.text));
    }

    #[test]
    fn stderr_lines_passes_through_when_the_runtime_states_it() {
        let o = compute_output("a\nb", Some(2));
        assert_eq!(o.stderr_lines, Some(2));
        let o2 = compute_output("a\nb", None);
        assert_eq!(o2.stderr_lines, None);
    }

    // ---------- build_step_detail / build_body (FR-3) ----------

    #[test]
    fn bash_input_becomes_a_verbatim_command_body() {
        let input = json!({ "command": "npm  test", "description": "run the suite" });
        let d = build_step_detail(
            "b1",
            "Bash",
            "D:\\acme-api",
            "native",
            100,
            200,
            false,
            None,
            &input,
            "ok\n",
            None,
        );
        match d.body {
            StepBody::Command { command, .. } => {
                assert_eq!(command.command, "npm  test"); // untouched double space
                assert_eq!(command.description.as_deref(), Some("run the suite"));
            }
            other => panic!("expected a command body, got {other:?}"),
        }
    }

    #[test]
    fn bash_input_without_a_string_command_falls_back_to_generic() {
        let input = json!({ "not_command": 1 });
        let d = build_step_detail(
            "b1", "Bash", "/x", "native", 0, 0, false, None, &input, "", None,
        );
        assert!(matches!(d.body, StepBody::Generic { .. }));
    }

    #[test]
    fn every_other_tool_gets_the_generic_pretty_printed_input() {
        let input = json!({ "file_path": "src/x.ts" });
        let d = build_step_detail(
            "b1", "Edit", "/x", "native", 0, 0, false, None, &input, "", None,
        );
        match d.body {
            StepBody::Generic { input_json, .. } => {
                assert!(input_json.contains("\"file_path\""));
                assert!(input_json.contains("src/x.ts"));
            }
            other => panic!("expected a generic body, got {other:?}"),
        }
    }

    #[test]
    fn generic_input_json_truncates_to_four_thousand_chars() {
        let input = json!({ "big": "x".repeat(9000) });
        let d = build_step_detail(
            "b1", "Grep", "/x", "native", 0, 0, false, None, &input, "", None,
        );
        match d.body {
            StepBody::Generic { input_json, .. } => {
                assert!(input_json.chars().count() <= 4000 + 2);
                assert!(input_json.ends_with('…'));
            }
            other => panic!("expected a generic body, got {other:?}"),
        }
    }

    #[test]
    fn internal_engine_keys_never_leak_into_a_captured_body() {
        let input = json!({ "command": "ls", "__agentId": "a1", "__workflowId": "w1" });
        let d = build_step_detail(
            "b1", "Bash", "/x", "native", 0, 0, false, None, &input, "", None,
        );
        match d.body {
            StepBody::Command { command, .. } => assert_eq!(command.command, "ls"),
            other => panic!("expected a command body, got {other:?}"),
        }
        // Also true on the generic path.
        let input2 = json!({ "file_path": "a.ts", "__agentId": "a1" });
        let d2 = build_step_detail(
            "b1", "Edit", "/x", "native", 0, 0, false, None, &input2, "", None,
        );
        match d2.body {
            StepBody::Generic { input_json, .. } => assert!(!input_json.contains("__agentId")),
            other => panic!("expected a generic body, got {other:?}"),
        }
    }

    #[test]
    fn unparseable_non_object_input_still_renders_as_generic_never_a_capture_failure() {
        let input = json!("just a string, not an object");
        let d = build_step_detail(
            "b1",
            "MysteryTool",
            "/x",
            "native",
            0,
            0,
            false,
            None,
            &input,
            "",
            None,
        );
        match d.body {
            StepBody::Generic { input_json, .. } => assert!(input_json.contains("just a string")),
            other => panic!("expected a generic body, got {other:?}"),
        }
    }

    // ---------- StepDetail round-trip against the contract shape ----------

    #[test]
    fn step_detail_serializes_to_the_contract_shape_with_absent_fields_omitted() {
        let input = json!({ "command": "npm test" });
        let d = build_step_detail(
            "b1",
            "Bash",
            "/repo",
            "native",
            100,
            4300,
            true,
            None,
            &input,
            "14 failed\n",
            None,
        );
        let v = serde_json::to_value(&d).unwrap();
        assert_eq!(v["blockId"], "b1");
        assert_eq!(v["tool"], "Bash");
        assert_eq!(v["cwd"], "/repo");
        assert_eq!(v["runtime"], "native");
        assert!(v.get("distro").is_none()); // native ⇒ no distro key
        assert_eq!(v["startedAt"], 100);
        assert_eq!(v["endedAt"], 4300);
        assert_eq!(v["isError"], true);
        assert!(v.get("exitCode").is_none()); // claude-code never states one (FR-4)
        assert_eq!(v["body"]["kind"], "command");
        assert_eq!(v["body"]["command"]["command"], "npm test");
        assert!(v["body"]["command"].get("description").is_none());
        assert_eq!(v["body"]["output"]["text"], "14 failed\n");
        assert!(v["body"]["output"].get("stderrLines").is_none());
    }

    #[test]
    fn step_detail_with_wsl_runtime_carries_its_distro() {
        let input = json!({ "command": "ls" });
        let d = build_step_detail(
            "b1",
            "Bash",
            "\\\\wsl$\\Ubuntu-22.04\\home\\u\\api",
            "wsl",
            0,
            0,
            false,
            None,
            &input,
            "",
            None,
        );
        let v = serde_json::to_value(&d).unwrap();
        assert_eq!(v["distro"], "Ubuntu-22.04");
    }

    #[test]
    fn a_runtime_that_states_an_exit_code_and_stderr_count_carries_both() {
        let input = json!({ "command": "npm test" });
        let d = build_step_detail(
            "b1",
            "Bash",
            "/repo",
            "native",
            0,
            0,
            true,
            Some(1),
            &input,
            "boom\n",
            Some(3),
        );
        let v = serde_json::to_value(&d).unwrap();
        assert_eq!(v["exitCode"], 1);
        assert_eq!(v["body"]["output"]["stderrLines"], 3);
    }

    #[test]
    fn step_detail_round_trips_through_json() {
        let input = json!({ "file_path": "a.ts" });
        let d = build_step_detail(
            "b1", "Read", "/repo", "native", 1, 2, false, None, &input, "hi\n", None,
        );
        let line = serde_json::to_string(&d).unwrap();
        let back: StepDetail = serde_json::from_str(&line).unwrap();
        assert_eq!(back, d);
    }

    // ---------- sidecar: last line wins, corrupt lines skipped (FR-11/§7) ----------

    fn line_for(block_id: &str, command: &str) -> String {
        let d = build_step_detail(
            block_id,
            "Bash",
            "/repo",
            "native",
            0,
            1,
            false,
            None,
            &json!({ "command": command }),
            "",
            None,
        );
        serde_json::to_string(&d).unwrap()
    }

    #[test]
    fn the_last_line_for_a_block_id_wins() {
        let content = format!(
            "{}
{}
{}
",
            line_for("b1", "first"),
            line_for("b2", "other block"),
            line_for("b1", "second"),
        );
        let d = pick_last_detail(&content, "b1").expect("a record");
        match d.body {
            StepBody::Command { command, .. } => assert_eq!(command.command, "second"),
            other => panic!("expected a command body, got {other:?}"),
        }
    }

    #[test]
    fn a_corrupt_line_is_skipped_rather_than_failing_the_whole_read() {
        let content = format!(
            "{}
not json at all
{{\"blockId\":\"b1\"}}
",
            line_for("b1", "survivor"),
        );
        let d = pick_last_detail(&content, "b1").expect("the surviving record");
        match d.body {
            StepBody::Command { command, .. } => assert_eq!(command.command, "survivor"),
            other => panic!("expected a command body, got {other:?}"),
        }
    }

    #[test]
    fn a_block_id_with_no_surviving_line_has_no_record() {
        let content = format!(
            "{}
",
            line_for("b1", "ls")
        );
        assert!(pick_last_detail(&content, "b2").is_none());
        assert!(pick_last_detail("", "b1").is_none());
    }

    // ---------- sidecar: append / read-last-wins / sweep ----------
    //
    // No `AppHandle` test harness exists in this crate (see session/env.rs's
    // doc comment) — `step_detail_path`/`append_step_detail`/`read_step_detail`
    // all take one, so they are exercised through `conversation_step_detail`'s
    // pure counterpart below and through the four adapters' own capture tests
    // instead of directly here.

    #[test]
    fn conversation_step_detail_reports_session_not_found_before_touching_the_sidecar() {
        // The command layer's own guard, proven without a real AppHandle: an
        // engine that has never heard of the session must short-circuit.
        let engine =
            crate::session::testutil::test_engine_with(crate::session::testutil::test_session());
        assert!(engine.with_session("nope", |_| ()).is_none());
        assert!(engine.with_session("s1", |_| ()).is_some());
    }
}
