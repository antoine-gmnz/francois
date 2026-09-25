//! Codex's pure translation half: `CodexEvent` → `Effect`, plus the
//! command-inspect capture a completed item states about itself.
//!
//! Split out of `runner.rs` (which keeps the `AppHandle` half — `apply`,
//! `begin_turn`, `run_reader`) along the seam that file's own doc comment
//! already named: everything interesting about a stream — which blocks it
//! produces, in what order, addressed by which id — is on this side, and
//! needs no `AppHandle`, so every test of this adapter lives here.

use super::wire::{CodexEvent, ItemKind, PatchChange, Todo};
use crate::ids::now_ms;

use serde_json::{json, Value};
use std::collections::HashMap;

// ---------- the pure translation (FR-13/FR-14) ----------

/// One thing a `CodexEvent` asks the engine to do. Naming the effects rather
/// than performing them inline is what lets the whole FR-13 table be tested.
#[derive(Debug, Clone, PartialEq)]
pub(super) enum Effect {
    /// FR-8: store Codex's `thread_id` as the session's resume anchor.
    Anchor(String),
    ToolStart {
        block_id: String,
        tool: String,
        summary: String,
    },
    ToolDone {
        block_id: String,
        tool: String,
        meta: String,
    },
    /// FR-13: a whole assistant message. No delta variant — this transport has
    /// none (§2).
    Assistant {
        block_id: String,
        text: String,
    },
    /// FR-15: context window occupancy.
    Usage(u64),
    Failed(String),
}

/// How one Codex item renders as a Francois tool block (FR-14). `None` for the
/// item kinds that produce no block at all (`agent_message` has its own effect,
/// `reasoning` is dropped, unknown kinds are ignored).
fn tool_view(kind: &ItemKind, roots: &[String]) -> Option<(String, String)> {
    match kind {
        ItemKind::CommandExecution { command, .. } => {
            Some(("Bash".to_string(), shell_summary(command)))
        }
        // Named `Edit` rather than `FileChange` so it reaches the SAME
        // downstream behaviour a Claude edit does — `finish_tool_block` keys the
        // diff-view recompute off this exact name (FR-14).
        ItemKind::FileChange { changes, .. } => {
            let paths: Vec<String> = changes.iter().map(|c| relative(&c.path, roots)).collect();
            Some(("Edit".to_string(), summarize_paths(&paths)))
        }
        ItemKind::McpToolCall { server, tool, .. } => Some((
            format!("mcp__{server}__{tool}"),
            if tool.is_empty() {
                server.clone()
            } else {
                tool.clone()
            },
        )),
        ItemKind::WebSearch { query } => Some(("WebSearch".to_string(), query.clone())),
        ItemKind::TodoList { todos } => Some((
            "TodoWrite".to_string(),
            format!(
                "{} item{}",
                todos.len(),
                if todos.len() == 1 { "" } else { "s" }
            ),
        )),
        ItemKind::AgentMessage { .. } | ItemKind::Reasoning | ItemKind::Unknown => None,
    }
}

/// The completion meta for a finished item.
///
/// For a command this follows the Claude path's `meta_bash` convention
/// (`"N lines"` / `"done"`) so the two runtimes read alike — **except** on a
/// non-zero exit, which says so instead. A failed command that reported
/// "3 lines" would bury the only fact that matters about it.
fn tool_meta(kind: &ItemKind) -> String {
    match kind {
        ItemKind::CommandExecution {
            aggregated_output,
            exit_code,
            ..
        } => match exit_code {
            Some(code) if *code != 0 => format!("exit {code}"),
            _ => {
                if aggregated_output.trim().is_empty() {
                    "done".to_string()
                } else {
                    format!("{} lines", aggregated_output.lines().count())
                }
            }
        },
        // Claude's `meta_edit` convention: `+added −removed`, summed over files.
        ItemKind::FileChange { status, .. } if failed_patch(status) => status.clone(),
        ItemKind::FileChange { changes, .. } if changes.is_empty() => "done".to_string(),
        ItemKind::FileChange { changes, .. } => {
            let (added, removed) = changes.iter().fold((0, 0), |(a, r), change| {
                let (add, rem) = change_counts(change);
                (a + add, r + rem)
            });
            format!("+{added} \u{2212}{removed}")
        }
        ItemKind::McpToolCall { status, error, .. } => {
            if status == "failed" || error.is_some() {
                "failed".to_string()
            } else {
                "done".to_string()
            }
        }
        _ => "done".to_string(),
    }
}

/// command-inspect FR-1/FR-9: what a completed item states about itself,
/// captured as a side channel alongside its (already-summarized) `ToolDone`
/// effect rather than as fields ON it — `started_at`/`ended_at` are wall
/// clock, which the FR-13/FR-14 tests below (which pin whole `Vec<Effect>`s
/// verbatim) could never assert; keeping capture data off `Effect` means none
/// of those tests need to change for this feature to exist.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct ToolCapture {
    pub(super) tool: String,
    pub(super) started_at: u64,
    pub(super) ended_at: u64,
    pub(super) input: Value,
    pub(super) output: String,
    pub(super) exit_code: Option<i64>,
    pub(super) is_error: bool,
}

/// What Codex's own wire format states about a completed item — `(input,
/// output, exitCode, isError)`. Only `CommandExecution` carries a raw
/// output/exit code at all; every other kind captures its identifying fields
/// as the generic body's input and an empty output (FR-9: "an adapter fills
/// what its wire format carries").
fn capture_for(kind: &ItemKind) -> (Value, String, Option<i64>, bool) {
    match kind {
        ItemKind::CommandExecution {
            command,
            aggregated_output,
            exit_code,
        } => (
            json!({ "command": command }),
            aggregated_output.clone(),
            *exit_code,
            exit_code.is_some_and(|c| c != 0),
        ),
        // The files as the input, their unified diff as the output — the diff
        // is what the expanded row shows.
        ItemKind::FileChange { changes, status } => (
            json!({ "changes": changes.iter().map(|c| match &c.move_path {
                Some(to) => json!({ "path": c.path, "kind": c.kind, "movePath": to }),
                None => json!({ "path": c.path, "kind": c.kind }),
            }).collect::<Vec<_>>() }),
            changes.iter().map(unified_diff).collect(),
            None,
            failed_patch(status),
        ),
        ItemKind::McpToolCall {
            server,
            tool,
            status,
            arguments,
            result,
            error,
        } => (
            json!({ "server": server, "tool": tool, "arguments": arguments }),
            error.clone().unwrap_or_else(|| mcp_result_text(result)),
            None,
            status == "failed" || error.is_some(),
        ),
        ItemKind::WebSearch { query } => (json!({ "query": query }), String::new(), None, false),
        // Claude's `TodoWrite` input verbatim; Codex has no present-continuous
        // form, so `activeForm` repeats the step.
        ItemKind::TodoList { todos } => (
            json!({ "todos": todos.iter().map(|Todo { content, status }| json!({
                "content": content, "status": status, "activeForm": content,
            })).collect::<Vec<_>>() }),
            String::new(),
            None,
            false,
        ),
        ItemKind::AgentMessage { .. } | ItemKind::Reasoning | ItemKind::Unknown => {
            (Value::Null, String::new(), None, false)
        }
    }
}

/// Codex reports the command it ran as a full shell invocation
/// (`"C:\…\pwsh.exe" -Command ls`, or `bash -lc 'npm test'`). The wrapper is
/// noise in a transcript — the user cares about `ls`. Strips a leading program
/// plus a single command-string flag, and returns the input untouched when it
/// does not match that shape, so an unrecognised form degrades to "slightly
/// verbose" rather than "mangled".
fn shell_summary(command: &str) -> String {
    let trimmed = command.trim();
    let Some((_program, rest)) = split_program(trimmed) else {
        return trimmed.to_string();
    };
    let rest = rest.trim_start();
    for flag in ["-Command", "-command", "-lc", "-c"] {
        if let Some(tail) = rest.strip_prefix(flag) {
            // Only when the flag is a whole token — `-command-ish` is not a match.
            if tail.starts_with(char::is_whitespace) {
                return unquote(tail.trim()).to_string();
            }
        }
    }
    trimmed.to_string()
}

/// Split off the leading program token, honouring the double quotes Codex wraps
/// a path in when it contains spaces. `None` when there is no separator at all.
fn split_program(s: &str) -> Option<(&str, &str)> {
    if let Some(rest) = s.strip_prefix('"') {
        let end = rest.find('"')?;
        return Some((&rest[..end], &rest[end + 1..]));
    }
    s.split_once(char::is_whitespace)
}

fn unquote(s: &str) -> &str {
    for q in ['"', '\''] {
        if let Some(inner) = s.strip_prefix(q).and_then(|r| r.strip_suffix(q)) {
            return inner;
        }
    }
    s
}

fn failed_patch(status: &str) -> bool {
    matches!(status, "failed" | "declined")
}

/// Lines added/removed by one change. An `update` diff is unified hunks
/// (header lines skipped); `add`/`delete` carry the whole file.
fn change_counts(change: &PatchChange) -> (usize, usize) {
    let lines = change.diff.lines().count();
    match change.kind.as_str() {
        "add" => (lines, 0),
        "delete" => (0, lines),
        _ => change
            .diff
            .lines()
            .filter(|l| !l.starts_with("+++") && !l.starts_with("---"))
            .fold((0, 0), |(a, r), l| match l.as_bytes().first() {
                Some(b'+') => (a + 1, r),
                Some(b'-') => (a, r + 1),
                _ => (a, r),
            }),
    }
}

/// One change as a standard unified diff, so the expanded row reads like
/// `git diff` whatever the change kind.
fn unified_diff(change: &PatchChange) -> String {
    let body = |prefix: char| -> String {
        change
            .diff
            .lines()
            .map(|l| format!("{prefix}{l}\n"))
            .collect()
    };
    let n = change.diff.lines().count();
    match change.kind.as_str() {
        "add" => format!(
            "--- /dev/null\n+++ {}\n@@ -0,0 +1,{n} @@\n{}",
            change.path,
            body('+')
        ),
        "delete" => format!(
            "--- {}\n+++ /dev/null\n@@ -1,{n} +0,0 @@\n{}",
            change.path,
            body('-')
        ),
        _ => {
            let mut diff = change.diff.clone();
            if !diff.is_empty() && !diff.ends_with('\n') {
                diff.push('\n');
            }
            format!(
                "--- {}\n+++ {}\n{diff}",
                change.path,
                change.move_path.as_deref().unwrap_or(&change.path)
            )
        }
    }
}

/// An MCP result's text: its text content blocks, else the structured
/// content, else nothing.
fn mcp_result_text(result: &Value) -> String {
    let blocks: Vec<String> = result["content"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|b| match b["text"].as_str() {
            Some(text) if b["type"] == "text" => text.to_string(),
            _ => b.to_string(),
        })
        .collect();
    if !blocks.is_empty() {
        return blocks.join("\n");
    }
    match &result["structuredContent"] {
        Value::Null => String::new(),
        structured => structured.to_string(),
    }
}

/// `path` relative to the first root it sits under (on a separator boundary,
/// so `/repo2/x` is not under `/repo`); untouched when under none.
fn relative(path: &str, roots: &[String]) -> String {
    roots
        .iter()
        .map(|root| root.trim_end_matches(['/', '\\']))
        .filter(|root| !root.is_empty())
        .find_map(|root| {
            let rest = path.strip_prefix(root)?;
            let rest = rest.strip_prefix(['/', '\\'])?;
            (!rest.is_empty()).then(|| rest.to_string())
        })
        .unwrap_or_else(|| path.to_string())
}

fn summarize_paths(paths: &[String]) -> String {
    match paths.len() {
        0 => "files".to_string(),
        1 => paths[0].clone(),
        n => format!("{} +{} more", paths[0], n - 1),
    }
}

/// FR-13/FR-14: the stream → effects state machine.
///
/// Stateful for one reason: an item's `started` and its `completed` are two
/// events that must address **one** block, so the id assigned at the first
/// sighting has to survive until the second.
pub(super) struct Translator<F: FnMut() -> String> {
    new_id: F,
    /// Codex item id → (the Francois block id it was opened with, when it
    /// opened — the latter is command-inspect FR-2's `startedAt`).
    open: HashMap<String, (String, u64)>,
    /// command-inspect: captures produced by the LAST `on_event`/nowhere else
    /// yet claimed by `take_capture` — a side channel, not a field on
    /// `Effect` (see `ToolCapture`'s doc comment for why).
    captures: Vec<(String, ToolCapture)>,
    /// The session cwd, as every path spelling Codex may report it in (host
    /// and, under WSL, Linux) — row titles are relative to it, like Claude's.
    roots: Vec<String>,
}

impl<F: FnMut() -> String> Translator<F> {
    pub(super) fn new(new_id: F) -> Self {
        Self {
            new_id,
            open: HashMap::new(),
            captures: Vec::new(),
            roots: Vec::new(),
        }
    }

    /// command-inspect: claim the capture stashed for `block_id`, if any —
    /// called once per `ToolDone` effect, so a capture is never applied twice.
    pub(super) fn set_roots(&mut self, roots: Vec<String>) {
        self.roots = roots;
    }

    pub(super) fn take_capture(&mut self, block_id: &str) -> Option<ToolCapture> {
        let idx = self.captures.iter().position(|(id, _)| id == block_id)?;
        Some(self.captures.remove(idx).1)
    }

    pub(super) fn on_event(&mut self, event: CodexEvent) -> Vec<Effect> {
        match event {
            CodexEvent::ThreadStarted { thread_id } => vec![Effect::Anchor(thread_id)],
            CodexEvent::ItemStarted { item } | CodexEvent::ItemUpdated { item } => {
                match tool_view(&item.kind, &self.roots) {
                    // Opening is idempotent: `item.updated` for an item already
                    // live must not produce a second card.
                    Some((tool, summary)) if !self.open.contains_key(&item.id) => {
                        let block_id = (self.new_id)();
                        self.open.insert(item.id, (block_id.clone(), now_ms()));
                        vec![Effect::ToolStart {
                            block_id,
                            tool,
                            summary,
                        }]
                    }
                    _ => Vec::new(),
                }
            }
            CodexEvent::ItemCompleted { item } => match &item.kind {
                ItemKind::AgentMessage { text } if !text.trim().is_empty() => {
                    vec![Effect::Assistant {
                        block_id: (self.new_id)(),
                        text: text.clone(),
                    }]
                }
                kind => {
                    let Some((tool, summary)) = tool_view(kind, &self.roots) else {
                        return Vec::new();
                    };
                    let mut effects = Vec::new();
                    // An item whose `started` we never saw still has to appear —
                    // several kinds only ever emit `completed`, and a card that
                    // is never opened would silently drop the tool call.
                    let (block_id, started_at) = match self.open.remove(&item.id) {
                        Some(v) => v,
                        None => {
                            let id = (self.new_id)();
                            effects.push(Effect::ToolStart {
                                block_id: id.clone(),
                                tool: tool.clone(),
                                summary,
                            });
                            (id, now_ms())
                        }
                    };
                    let (input, output, exit_code, is_error) = capture_for(kind);
                    self.captures.push((
                        block_id.clone(),
                        ToolCapture {
                            tool: tool.clone(),
                            started_at,
                            ended_at: now_ms(),
                            input,
                            output,
                            exit_code,
                            is_error,
                        },
                    ));
                    effects.push(Effect::ToolDone {
                        block_id,
                        tool,
                        meta: tool_meta(kind),
                    });
                    effects
                }
            },
            CodexEvent::TurnCompleted { usage } => vec![Effect::Usage(usage.context_used())],
            CodexEvent::Failed { message } => vec![Effect::Failed(message)],
            CodexEvent::TurnStarted | CodexEvent::Unknown => Vec::new(),
        }
    }

    /// Whatever is still open when the stream ends. A child killed mid-command
    /// would otherwise leave a tool card spinning forever in the transcript.
    /// No capture is stashed for these — there is no completion data to state.
    pub(super) fn close_open(&mut self) -> Vec<Effect> {
        let mut ids: Vec<(String, (String, u64))> = self.open.drain().collect();
        // HashMap order is not stable; the transcript's is.
        ids.sort_by(|a, b| a.0.cmp(&b.0));
        ids.into_iter()
            .map(|(_, (block_id, _started_at))| Effect::ToolDone {
                block_id,
                tool: String::new(),
                meta: "interrupted".to_string(),
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::adapter::codex::wire::parse_line;

    /// Deterministic ids so a translation can be asserted whole.
    fn counter() -> impl FnMut() -> String {
        let mut n = 0;
        move || {
            n += 1;
            format!("b{n}")
        }
    }

    fn translate_all(lines: &str) -> Vec<Effect> {
        let mut t = Translator::new(counter());
        let mut out: Vec<Effect> = lines
            .lines()
            .flat_map(|l| t.on_event(parse_line(l)))
            .collect();
        out.extend(t.close_open());
        out
    }

    // ---------- FR-13: the captured turn, end to end ----------

    /// The real `codex exec --json` capture replayed into the exact block
    /// sequence a user would see. This is the FR-13/FR-14 table as one
    /// assertion, over bytes Codex actually produced.
    #[test]
    fn the_captured_turn_translates_into_the_expected_blocks() {
        let effects = translate_all(include_str!("fixtures/exec_turn.jsonl"));
        assert_eq!(
            effects,
            vec![
                Effect::Anchor("01a00f3d-6d04-73d3-96e0-00edad63ce9d".into()),
                Effect::Assistant {
                    block_id: "b1".into(),
                    text: "I’ll check the current folder.".into()
                },
                // The command goes live on item.started…
                Effect::ToolStart {
                    block_id: "b2".into(),
                    tool: "Bash".into(),
                    summary: "ls".into()
                },
                // …and completes in the SAME block on item.completed.
                Effect::ToolDone {
                    block_id: "b2".into(),
                    tool: "Bash".into(),
                    meta: "8 lines".into()
                },
                Effect::Assistant {
                    block_id: "b3".into(),
                    text: "a.txt".into()
                },
                Effect::Usage(27022 + 19968 + 114),
            ]
        );
    }

    // ---------- FR-14: one block across two events ----------

    #[test]
    fn item_updated_does_not_open_a_second_card() {
        let effects = translate_all(
            r#"{"type":"item.started","item":{"id":"i1","type":"command_execution","command":"ls","exit_code":null}}
{"type":"item.updated","item":{"id":"i1","type":"command_execution","command":"ls","aggregated_output":"partial","exit_code":null}}
{"type":"item.completed","item":{"id":"i1","type":"command_execution","command":"ls","aggregated_output":"a\nb\n","exit_code":0}}"#,
        );
        assert_eq!(effects.len(), 2, "one start, one done: {effects:?}");
        assert!(matches!(&effects[0], Effect::ToolStart { block_id, .. } if block_id == "b1"));
        assert!(matches!(&effects[1], Effect::ToolDone { block_id, .. } if block_id == "b1"));
    }

    #[test]
    fn an_item_that_only_ever_completes_still_produces_a_card() {
        // file_change and web_search commonly arrive completed-only. Without
        // this, the tool call would never appear in the transcript at all.
        let effects = translate_all(
            r#"{"type":"item.completed","item":{"id":"i1","type":"file_change","changes":[{"path":"src/a.ts"}],"status":"completed"}}"#,
        );
        assert_eq!(
            effects,
            vec![
                Effect::ToolStart {
                    block_id: "b1".into(),
                    tool: "Edit".into(),
                    summary: "src/a.ts".into()
                },
                Effect::ToolDone {
                    block_id: "b1".into(),
                    tool: "Edit".into(),
                    meta: "+0 \u{2212}0".into()
                },
            ]
        );
    }

    /// FR-14: the name is load-bearing, not cosmetic — `apply` keys the
    /// diff-view recompute off exactly `"Edit"`, so renaming this to something
    /// more descriptive would silently stop the DIFF tab updating.
    #[test]
    fn a_file_change_is_named_edit_so_the_diff_view_recomputes() {
        let effects = translate_all(
            r#"{"type":"item.completed","item":{"id":"i1","type":"file_change","changes":[{"path":"a"},{"path":"b"},{"path":"c"}]}}"#,
        );
        match &effects[1] {
            Effect::ToolDone { tool, meta, .. } => {
                assert_eq!(tool, "Edit");
                assert_eq!(meta, "+0 \u{2212}0");
            }
            other => panic!("expected ToolDone, got {other:?}"),
        }
    }

    // ---------- FR-13: what produces nothing ----------

    #[test]
    fn reasoning_turn_started_and_unknown_items_produce_no_blocks() {
        let effects = translate_all(
            r#"{"type":"turn.started"}
{"type":"item.completed","item":{"id":"i1","type":"reasoning","text":"hmm"}}
{"type":"item.started","item":{"id":"i2","type":"collab_tool_call"}}
{"type":"item.completed","item":{"id":"i2","type":"collab_tool_call"}}
not json at all
{"type":"brand.new.event"}"#,
        );
        assert_eq!(effects, Vec::new());
    }

    #[test]
    fn an_empty_assistant_message_does_not_open_a_blank_block() {
        let effects = translate_all(
            r#"{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"   "}}"#,
        );
        assert_eq!(effects, Vec::new());
    }

    // ---------- interruption ----------

    #[test]
    fn a_stream_that_dies_mid_command_closes_the_open_card() {
        // Otherwise the tool card spins forever in the transcript.
        let effects = translate_all(
            r#"{"type":"item.started","item":{"id":"i1","type":"command_execution","command":"sleep 100","exit_code":null}}"#,
        );
        assert_eq!(
            effects,
            vec![
                Effect::ToolStart {
                    block_id: "b1".into(),
                    tool: "Bash".into(),
                    summary: "sleep 100".into()
                },
                Effect::ToolDone {
                    block_id: "b1".into(),
                    tool: String::new(),
                    meta: "interrupted".into()
                },
            ]
        );
    }

    // ---------- meta ----------

    #[test]
    fn a_failed_command_reports_its_exit_code_rather_than_a_line_count() {
        let effects = translate_all(
            r#"{"type":"item.completed","item":{"id":"i1","type":"command_execution","command":"npm test","aggregated_output":"a\nb\nc\n","exit_code":1}}"#,
        );
        match effects.last().unwrap() {
            Effect::ToolDone { meta, .. } => assert_eq!(meta, "exit 1"),
            other => panic!("expected ToolDone, got {other:?}"),
        }
    }

    #[test]
    fn a_silent_successful_command_says_done() {
        let effects = translate_all(
            r#"{"type":"item.completed","item":{"id":"i1","type":"command_execution","command":"true","aggregated_output":"","exit_code":0}}"#,
        );
        match effects.last().unwrap() {
            Effect::ToolDone { meta, .. } => assert_eq!(meta, "done"),
            other => panic!("expected ToolDone, got {other:?}"),
        }
    }

    // ---------- shell_summary ----------

    #[test]
    fn the_shell_wrapper_is_stripped_from_a_command_summary() {
        // Verbatim from the live capture — the whole reason this helper exists.
        assert_eq!(
            shell_summary(
                r#""C:\Users\gnzan\AppData\Local\Microsoft\WindowsApps\pwsh.exe" -Command ls"#
            ),
            "ls"
        );
        assert_eq!(shell_summary("bash -lc 'npm test'"), "npm test");
        assert_eq!(shell_summary(r#"/bin/sh -c "echo hi""#), "echo hi");
    }

    #[test]
    fn an_unrecognised_command_shape_is_left_alone() {
        // Degrade to verbose, never to mangled.
        assert_eq!(shell_summary("ls -la"), "ls -la");
        assert_eq!(shell_summary("git status"), "git status");
        assert_eq!(shell_summary("cargo"), "cargo");
        assert_eq!(shell_summary(""), "");
        // `-command-ish` is not the `-command` flag.
        assert_eq!(shell_summary("pwsh -commandish x"), "pwsh -commandish x");
    }

    // ---------- FR-15 ----------

    #[test]
    fn usage_is_reported_once_at_turn_completion() {
        let effects = translate_all(
            r#"{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":50,"output_tokens":10,"reasoning_output_tokens":4}}"#,
        );
        assert_eq!(effects, vec![Effect::Usage(160)]);
    }

    // ---------- failures ----------

    #[test]
    fn turn_failed_and_error_both_surface_as_a_failure_effect() {
        assert_eq!(
            translate_all(r#"{"type":"turn.failed","error":{"message":"rate limited"}}"#),
            vec![Effect::Failed("rate limited".into())]
        );
        assert_eq!(
            translate_all(r#"{"type":"error","message":"disconnected"}"#),
            vec![Effect::Failed("disconnected".into())]
        );
    }

    #[test]
    fn a_failure_mid_stream_does_not_stop_earlier_blocks_from_rendering() {
        let effects = translate_all(
            r#"{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"starting"}}
{"type":"turn.failed","error":{"message":"boom"}}"#,
        );
        assert_eq!(
            effects,
            vec![
                Effect::Assistant {
                    block_id: "b1".into(),
                    text: "starting".into()
                },
                Effect::Failed("boom".into()),
            ]
        );
    }

    // ---------- command-inspect FR-1/FR-9: the capture side channel ----------

    #[test]
    fn capture_for_a_command_execution_carries_the_verbatim_command_and_exit_code() {
        let (input, output, exit_code, is_error) = capture_for(&ItemKind::CommandExecution {
            command: "ls -la".into(),
            aggregated_output: "a.txt\nb.txt\n".into(),
            exit_code: Some(0),
        });
        assert_eq!(input, json!({ "command": "ls -la" }));
        assert_eq!(output, "a.txt\nb.txt\n");
        assert_eq!(exit_code, Some(0));
        assert!(!is_error);
    }

    #[test]
    fn capture_for_a_failed_command_reports_is_error() {
        let (_, _, exit_code, is_error) = capture_for(&ItemKind::CommandExecution {
            command: "npm test".into(),
            aggregated_output: "3 failed\n".into(),
            exit_code: Some(1),
        });
        assert_eq!(exit_code, Some(1));
        assert!(is_error);
    }

    #[test]
    fn capture_for_non_command_kinds_is_generic_with_no_raw_output() {
        let (input, output, exit_code, is_error) = capture_for(&ItemKind::FileChange {
            changes: vec![PatchChange {
                path: "a.ts".into(),
                kind: "update".into(),
                move_path: None,
                diff: String::new(),
            }],
            status: String::new(),
        });
        assert_eq!(
            input,
            json!({ "changes": [{"path": "a.ts", "kind": "update"}] })
        );
        assert_eq!(output, "--- a.ts\n+++ a.ts\n");
        assert_eq!(exit_code, None);
        assert!(!is_error);

        let (_, output, _, is_error) = capture_for(&ItemKind::McpToolCall {
            server: "s".into(),
            tool: "t".into(),
            status: "failed".into(),
            arguments: json!({}),
            result: Value::Null,
            error: Some("tool exploded".into()),
        });
        assert!(is_error);
        assert_eq!(output, "tool exploded");
    }

    #[test]
    fn a_completed_command_stashes_a_capture_claimable_exactly_once() {
        let mut t = Translator::new(counter());
        let effects = t.on_event(parse_line(
            r#"{"type":"item.completed","item":{"id":"i1","type":"command_execution","command":"ls","aggregated_output":"a\nb\n","exit_code":0}}"#,
        ));
        let block_id = match &effects[0] {
            Effect::ToolStart { block_id, .. } => block_id.clone(),
            other => panic!("expected ToolStart, got {other:?}"),
        };
        let cap = t.take_capture(&block_id).expect("a capture was stashed");
        assert_eq!(cap.tool, "Bash");
        assert_eq!(cap.output, "a\nb\n");
        assert_eq!(cap.exit_code, Some(0));
        assert!(!cap.is_error);
        assert!(cap.ended_at >= cap.started_at);
        // Exactly-once: a second claim finds nothing left.
        assert!(t.take_capture(&block_id).is_none());
    }

    #[test]
    fn an_interrupted_close_stashes_no_capture() {
        let mut t = Translator::new(counter());
        t.on_event(parse_line(
            r#"{"type":"item.started","item":{"id":"i1","type":"command_execution","command":"sleep 100","exit_code":null}}"#,
        ));
        let closed = t.close_open();
        let block_id = match &closed[0] {
            Effect::ToolDone { block_id, .. } => block_id.clone(),
            other => panic!("expected ToolDone, got {other:?}"),
        };
        assert!(t.take_capture(&block_id).is_none());
    }

    #[test]
    fn a_delete_and_a_move_render_as_unified_diffs_with_claude_counts() {
        let kind = ItemKind::FileChange {
            changes: vec![
                PatchChange {
                    path: "old.txt".into(),
                    kind: "delete".into(),
                    move_path: None,
                    diff: "a\nb\n".into(),
                },
                PatchChange {
                    path: "from.rs".into(),
                    kind: "update".into(),
                    move_path: Some("to.rs".into()),
                    diff: "@@ -1 +1 @@\n-x\n+y".into(),
                },
            ],
            status: "completed".into(),
        };
        assert_eq!(tool_meta(&kind), "+1 \u{2212}3");
        let (input, output, _, is_error) = capture_for(&kind);
        assert!(!is_error);
        assert_eq!(input["changes"][1]["movePath"], "to.rs");
        assert_eq!(
            output,
            "--- old.txt\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-a\n-b\n--- from.rs\n+++ to.rs\n@@ -1 +1 @@\n-x\n+y\n"
        );
    }

    #[test]
    fn edit_titles_are_relative_to_the_session_cwd_in_either_path_spelling() {
        let roots = vec![
            r"\\wsl.localhost\Ubuntu\home\me\repo".to_string(),
            "/home/me/repo/".to_string(),
        ];
        assert_eq!(relative("/home/me/repo/src/a.rs", &roots), "src/a.rs");
        assert_eq!(
            relative(r"\\wsl.localhost\Ubuntu\home\me\repo\src\a.rs", &roots),
            r"src\a.rs"
        );
        // A sibling that merely shares the prefix, and the root itself, stay whole.
        assert_eq!(
            relative("/home/me/repo2/a.rs", &roots),
            "/home/me/repo2/a.rs"
        );
        assert_eq!(relative("/home/me/repo", &roots), "/home/me/repo");
        assert_eq!(relative(r"C:\repo\a.rs", &[r"C:\repo\".into()]), "a.rs");
    }

    #[test]
    fn a_declined_file_change_says_so_and_mcp_structured_content_is_kept() {
        let declined = ItemKind::FileChange {
            changes: vec![],
            status: "declined".into(),
        };
        assert_eq!(tool_meta(&declined), "declined");
        assert!(capture_for(&declined).3);
        assert_eq!(
            mcp_result_text(&json!({"content": [], "structuredContent": {"n": 2}})),
            r#"{"n":2}"#
        );
    }
}
