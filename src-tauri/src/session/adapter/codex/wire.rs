//! Parsing the `codex exec --json` event stream (multi-provider-codex
//! FR-12/FR-13/FR-14/FR-15). Pure: a `&str` line in, a `CodexEvent` out. The
//! translation into transcript blocks lives in `runner.rs`; this file only says
//! what Codex said.
//!
//! Mirrors `CodexEvent`/`CodexItem` in contract/multi-provider-codex.ts.
//! Verified against codex-cli 0.147.0 (live capture + the binary's own serde
//! tables), not inferred from docs.
//!
//! **Everything here is lenient on purpose (FR-12).** Codex prints
//! human-readable preamble on some paths ("Reading additional input from
//! stdin…"), and ships new event and item kinds between releases. A parser that
//! errored on either would turn a cosmetic upstream change into "turns fail on
//! the new Codex", so an unparseable line and an unknown `type` are both
//! `Unknown` — visible to the caller, never fatal.

use serde::Deserialize;
use serde_json::Value;

/// FR-15: token accounting off `turn.completed`.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub(super) struct Usage {
    #[serde(default)]
    pub(super) input_tokens: u64,
    #[serde(default)]
    pub(super) cached_input_tokens: u64,
    #[serde(default)]
    pub(super) cache_write_input_tokens: u64,
    #[serde(default)]
    pub(super) output_tokens: u64,
    #[serde(default)]
    pub(super) reasoning_output_tokens: u64,
}

impl Usage {
    /// What the context meter shows. Cached input still OCCUPIES the window even
    /// though it is billed differently, so it counts; `reasoning_output_tokens`
    /// is a subset of `output_tokens` and adding it would double-count.
    pub(super) fn context_used(&self) -> u64 {
        self.input_tokens + self.cached_input_tokens + self.output_tokens
    }
}

/// One item in a turn. `id` addresses it across `item.started` →
/// `item.completed`, which is what lets a tool card go live and complete in
/// place (FR-14).
#[derive(Debug, Clone, PartialEq)]
pub(super) struct Item {
    pub(super) id: String,
    pub(super) kind: ItemKind,
}

#[derive(Debug, Clone, PartialEq)]
pub(super) enum ItemKind {
    AgentMessage {
        text: String,
    },
    /// Parsed so it is not mistaken for an unknown kind, then dropped by the
    /// runner: the core has no thinking block (§2 non-goal).
    Reasoning,
    CommandExecution {
        command: String,
        aggregated_output: String,
        exit_code: Option<i64>,
    },
    FileChange {
        paths: Vec<String>,
    },
    McpToolCall {
        server: String,
        tool: String,
        status: String,
    },
    WebSearch {
        query: String,
    },
    TodoList {
        count: usize,
    },
    /// An item kind this version of Francois does not know. Codex adds them
    /// between releases; none of them may break a turn.
    Unknown,
}

#[derive(Debug, Clone, PartialEq)]
pub(super) enum CodexEvent {
    /// The resume anchor for every later turn (FR-8).
    ThreadStarted {
        thread_id: String,
    },
    TurnStarted,
    TurnCompleted {
        usage: Usage,
    },
    /// `turn.failed` and the bare `error` event both land here — they mean the
    /// same thing to a transcript and differ only in which layer produced them.
    Failed {
        message: String,
    },
    ItemStarted {
        item: Item,
    },
    ItemUpdated {
        item: Item,
    },
    ItemCompleted {
        item: Item,
    },
    /// A line that was not JSON, carried no `type`, or named an event kind we do
    /// not handle. Never fatal (FR-12).
    Unknown,
}

const UNKNOWN_ERROR: &str = "codex reported an error with no message";

/// FR-12: parse one stdout line. Never fails — see the module doc.
pub(super) fn parse_line(line: &str) -> CodexEvent {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return CodexEvent::Unknown;
    }
    let Ok(v) = serde_json::from_str::<Value>(trimmed) else {
        return CodexEvent::Unknown;
    };
    let Some(kind) = v.get("type").and_then(|t| t.as_str()) else {
        return CodexEvent::Unknown;
    };
    match kind {
        "thread.started" => match v.get("thread_id").and_then(|t| t.as_str()) {
            // A thread.started with no id is not an anchor — treating it as one
            // would resume `""` on the next turn.
            Some(id) if !id.is_empty() => CodexEvent::ThreadStarted {
                thread_id: id.to_string(),
            },
            _ => CodexEvent::Unknown,
        },
        "turn.started" => CodexEvent::TurnStarted,
        "turn.completed" => CodexEvent::TurnCompleted {
            usage: v
                .get("usage")
                .and_then(|u| serde_json::from_value::<Usage>(u.clone()).ok())
                .unwrap_or_default(),
        },
        "turn.failed" => CodexEvent::Failed {
            message: v
                .get("error")
                .and_then(|e| e.get("message"))
                .and_then(|m| m.as_str())
                .filter(|m| !m.trim().is_empty())
                .unwrap_or(UNKNOWN_ERROR)
                .to_string(),
        },
        "error" => CodexEvent::Failed {
            message: v
                .get("message")
                .and_then(|m| m.as_str())
                .filter(|m| !m.trim().is_empty())
                .unwrap_or(UNKNOWN_ERROR)
                .to_string(),
        },
        "item.started" | "item.updated" | "item.completed" => {
            let Some(item) = v.get("item").and_then(parse_item) else {
                return CodexEvent::Unknown;
            };
            match kind {
                "item.started" => CodexEvent::ItemStarted { item },
                "item.updated" => CodexEvent::ItemUpdated { item },
                _ => CodexEvent::ItemCompleted { item },
            }
        }
        _ => CodexEvent::Unknown,
    }
}

fn parse_item(v: &Value) -> Option<Item> {
    let id = v.get("id").and_then(|i| i.as_str())?.to_string();
    let kind = match v.get("type").and_then(|t| t.as_str()).unwrap_or("") {
        "agent_message" => ItemKind::AgentMessage {
            text: str_field(v, "text"),
        },
        "reasoning" => ItemKind::Reasoning,
        "command_execution" => ItemKind::CommandExecution {
            command: str_field(v, "command"),
            aggregated_output: str_field(v, "aggregated_output"),
            // null while in_progress — `as_i64` on null gives None, which is the
            // distinction the runner needs to tell "running" from "exited 0".
            exit_code: v.get("exit_code").and_then(|c| c.as_i64()),
        },
        "file_change" => ItemKind::FileChange {
            paths: v
                .get("changes")
                .and_then(|c| c.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|c| c.get("path").and_then(|p| p.as_str()))
                        .map(String::from)
                        .collect()
                })
                .unwrap_or_default(),
        },
        "mcp_tool_call" => ItemKind::McpToolCall {
            server: str_field(v, "server"),
            tool: str_field(v, "tool"),
            status: str_field(v, "status"),
        },
        "web_search" => ItemKind::WebSearch {
            query: str_field(v, "query"),
        },
        "todo_list" => ItemKind::TodoList {
            count: v
                .get("items")
                .and_then(|i| i.as_array())
                .map(|a| a.len())
                .unwrap_or(0),
        },
        _ => ItemKind::Unknown,
    };
    Some(Item { id, kind })
}

fn str_field(v: &Value, key: &str) -> String {
    v.get(key)
        .and_then(|s| s.as_str())
        .unwrap_or_default()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    // The four lines below are VERBATIM from a live `codex exec --json` run
    // against codex-cli 0.147.0 on 2026-08-17 — not hand-written to match the
    // parser. A fixture the parser's author invented proves only that they are
    // self-consistent.
    const LIVE_THREAD_STARTED: &str =
        r#"{"type":"thread.started","thread_id":"01a00f3d-6d04-73d3-96e0-00edad63ce9d"}"#;
    const LIVE_AGENT_MESSAGE: &str = r#"{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"I’ll check the current folder."}}"#;
    const LIVE_COMMAND_STARTED: &str = r#"{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"pwsh.exe -Command ls","aggregated_output":"","exit_code":null,"status":"in_progress"}}"#;
    const LIVE_TURN_COMPLETED: &str = r#"{"type":"turn.completed","usage":{"input_tokens":27022,"cached_input_tokens":19968,"cache_write_input_tokens":0,"output_tokens":114,"reasoning_output_tokens":44}}"#;

    // ---------- FR-8: the resume anchor ----------

    #[test]
    fn thread_started_yields_the_resume_anchor() {
        assert_eq!(
            parse_line(LIVE_THREAD_STARTED),
            CodexEvent::ThreadStarted {
                thread_id: "01a00f3d-6d04-73d3-96e0-00edad63ce9d".into()
            }
        );
    }

    #[test]
    fn a_thread_started_without_an_id_is_not_an_anchor() {
        // Storing "" would make the next turn `codex exec resume ""`.
        assert_eq!(
            parse_line(r#"{"type":"thread.started"}"#),
            CodexEvent::Unknown
        );
        assert_eq!(
            parse_line(r#"{"type":"thread.started","thread_id":""}"#),
            CodexEvent::Unknown
        );
    }

    // ---------- FR-12: leniency ----------

    #[test]
    fn a_non_json_line_is_ignored_rather_than_fatal() {
        // Codex really does print this when stdin is piped.
        assert_eq!(
            parse_line("Reading additional input from stdin..."),
            CodexEvent::Unknown
        );
        assert_eq!(parse_line(""), CodexEvent::Unknown);
        assert_eq!(parse_line("   "), CodexEvent::Unknown);
        assert_eq!(parse_line("{ truncated"), CodexEvent::Unknown);
    }

    #[test]
    fn valid_json_without_a_type_is_ignored() {
        assert_eq!(parse_line(r#"{"thread_id":"x"}"#), CodexEvent::Unknown);
        assert_eq!(parse_line(r#"[1,2,3]"#), CodexEvent::Unknown);
    }

    #[test]
    fn an_unknown_event_kind_is_ignored() {
        assert_eq!(
            parse_line(r#"{"type":"turn.something_new","data":1}"#),
            CodexEvent::Unknown
        );
    }

    #[test]
    fn an_unknown_item_kind_still_parses_as_an_item_with_its_id() {
        // Not Unknown at the EVENT level: the item exists and has an id, we just
        // have no block for it. Keeping the id means a later `item.completed`
        // for the same id is still recognisably the same item.
        let ev = parse_line(
            r#"{"type":"item.started","item":{"id":"item_9","type":"collab_tool_call"}}"#,
        );
        assert_eq!(
            ev,
            CodexEvent::ItemStarted {
                item: Item {
                    id: "item_9".into(),
                    kind: ItemKind::Unknown
                }
            }
        );
    }

    #[test]
    fn an_item_event_without_an_id_is_ignored() {
        assert_eq!(
            parse_line(r#"{"type":"item.completed","item":{"type":"agent_message","text":"hi"}}"#),
            CodexEvent::Unknown
        );
        assert_eq!(
            parse_line(r#"{"type":"item.completed"}"#),
            CodexEvent::Unknown
        );
    }

    // ---------- items ----------

    #[test]
    fn an_agent_message_carries_its_whole_text() {
        assert_eq!(
            parse_line(LIVE_AGENT_MESSAGE),
            CodexEvent::ItemCompleted {
                item: Item {
                    id: "item_0".into(),
                    kind: ItemKind::AgentMessage {
                        text: "I’ll check the current folder.".into()
                    }
                }
            }
        );
    }

    #[test]
    fn a_running_command_has_no_exit_code_and_a_finished_one_does() {
        let started = parse_line(LIVE_COMMAND_STARTED);
        match started {
            CodexEvent::ItemStarted { item } => match item.kind {
                ItemKind::CommandExecution {
                    command, exit_code, ..
                } => {
                    assert_eq!(command, "pwsh.exe -Command ls");
                    // `null`, not 0 — the distinction the runner needs.
                    assert_eq!(exit_code, None);
                }
                other => panic!("expected a command execution, got {other:?}"),
            },
            other => panic!("expected item.started, got {other:?}"),
        }

        let done = parse_line(
            r#"{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"ls","aggregated_output":"a.txt\n","exit_code":0,"status":"completed"}}"#,
        );
        match done {
            CodexEvent::ItemCompleted { item } => match item.kind {
                ItemKind::CommandExecution {
                    exit_code,
                    aggregated_output,
                    ..
                } => {
                    assert_eq!(exit_code, Some(0));
                    assert_eq!(aggregated_output, "a.txt\n");
                }
                other => panic!("expected a command execution, got {other:?}"),
            },
            other => panic!("expected item.completed, got {other:?}"),
        }
    }

    #[test]
    fn a_file_change_collects_its_paths() {
        let ev = parse_line(
            r#"{"type":"item.completed","item":{"id":"i2","type":"file_change","changes":[{"path":"src/a.ts","kind":"update"},{"path":"src/b.ts","kind":"add"}],"status":"completed"}}"#,
        );
        match ev {
            CodexEvent::ItemCompleted { item } => {
                assert_eq!(
                    item.kind,
                    ItemKind::FileChange {
                        paths: vec!["src/a.ts".into(), "src/b.ts".into()]
                    }
                );
            }
            other => panic!("expected item.completed, got {other:?}"),
        }
    }

    #[test]
    fn a_file_change_with_no_changes_array_is_still_a_file_change() {
        let ev = parse_line(r#"{"type":"item.started","item":{"id":"i2","type":"file_change"}}"#);
        match ev {
            CodexEvent::ItemStarted { item } => {
                assert_eq!(item.kind, ItemKind::FileChange { paths: vec![] });
            }
            other => panic!("expected item.started, got {other:?}"),
        }
    }

    #[test]
    fn mcp_web_search_and_todo_items_parse() {
        let ev = parse_line(
            r#"{"type":"item.completed","item":{"id":"i3","type":"mcp_tool_call","server":"serena","tool":"find_symbol","status":"completed"}}"#,
        );
        match ev {
            CodexEvent::ItemCompleted { item } => assert_eq!(
                item.kind,
                ItemKind::McpToolCall {
                    server: "serena".into(),
                    tool: "find_symbol".into(),
                    status: "completed".into()
                }
            ),
            other => panic!("unexpected {other:?}"),
        }

        let ev = parse_line(
            r#"{"type":"item.completed","item":{"id":"i4","type":"web_search","query":"tauri 2 ipc"}}"#,
        );
        match ev {
            CodexEvent::ItemCompleted { item } => assert_eq!(
                item.kind,
                ItemKind::WebSearch {
                    query: "tauri 2 ipc".into()
                }
            ),
            other => panic!("unexpected {other:?}"),
        }

        let ev = parse_line(
            r#"{"type":"item.completed","item":{"id":"i5","type":"todo_list","items":[{"text":"a"},{"text":"b"},{"text":"c"}]}}"#,
        );
        match ev {
            CodexEvent::ItemCompleted { item } => {
                assert_eq!(item.kind, ItemKind::TodoList { count: 3 })
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn reasoning_parses_as_itself_so_it_is_dropped_deliberately_not_by_accident() {
        let ev = parse_line(
            r#"{"type":"item.completed","item":{"id":"i6","type":"reasoning","text":"thinking about it"}}"#,
        );
        match ev {
            CodexEvent::ItemCompleted { item } => assert_eq!(item.kind, ItemKind::Reasoning),
            other => panic!("unexpected {other:?}"),
        }
    }

    // ---------- FR-15: usage ----------

    #[test]
    fn turn_completed_carries_usage_and_counts_the_window_not_the_bill() {
        match parse_line(LIVE_TURN_COMPLETED) {
            CodexEvent::TurnCompleted { usage } => {
                assert_eq!(usage.input_tokens, 27022);
                assert_eq!(usage.cached_input_tokens, 19968);
                assert_eq!(usage.output_tokens, 114);
                assert_eq!(usage.reasoning_output_tokens, 44);
                // Cached input occupies the window; reasoning output is a SUBSET
                // of output_tokens and must not be added twice.
                assert_eq!(usage.context_used(), 27022 + 19968 + 114);
            }
            other => panic!("expected turn.completed, got {other:?}"),
        }
    }

    #[test]
    fn turn_completed_without_usage_reports_zero_rather_than_failing() {
        match parse_line(r#"{"type":"turn.completed"}"#) {
            CodexEvent::TurnCompleted { usage } => assert_eq!(usage.context_used(), 0),
            other => panic!("expected turn.completed, got {other:?}"),
        }
    }

    // ---------- failure ----------

    #[test]
    fn turn_failed_and_error_both_yield_a_message() {
        assert_eq!(
            parse_line(r#"{"type":"turn.failed","error":{"message":"model overloaded"}}"#),
            CodexEvent::Failed {
                message: "model overloaded".into()
            }
        );
        assert_eq!(
            parse_line(r#"{"type":"error","message":"stream disconnected"}"#),
            CodexEvent::Failed {
                message: "stream disconnected".into()
            }
        );
    }

    #[test]
    fn a_failure_with_no_message_still_says_something() {
        // An empty error block must not produce a blank error card.
        assert_eq!(
            parse_line(r#"{"type":"turn.failed"}"#),
            CodexEvent::Failed {
                message: UNKNOWN_ERROR.into()
            }
        );
        assert_eq!(
            parse_line(r#"{"type":"error","message":"   "}"#),
            CodexEvent::Failed {
                message: UNKNOWN_ERROR.into()
            }
        );
    }

    // ---------- the whole captured turn ----------

    /// The full stdout of a real `codex exec --json` run, replayed line by line.
    /// This is the FR-13 vocabulary end to end: the anchor, the turn markers, an
    /// assistant message, a command going live and then completing, and usage.
    #[test]
    fn a_captured_turn_replays_into_the_expected_event_sequence() {
        let captured = include_str!("fixtures/exec_turn.jsonl");
        let events: Vec<CodexEvent> = captured.lines().map(parse_line).collect();

        assert!(matches!(events[0], CodexEvent::ThreadStarted { .. }));
        assert!(matches!(events[1], CodexEvent::TurnStarted));
        assert!(matches!(
            events.last(),
            Some(CodexEvent::TurnCompleted { .. })
        ));

        // Nothing in a real stream should be Unknown — if this trips, the
        // vocabulary moved and FR-13's table is out of date.
        let unknown = events
            .iter()
            .filter(|e| matches!(e, CodexEvent::Unknown))
            .count();
        assert_eq!(unknown, 0, "unhandled lines in a real stream: {events:?}");

        // The same command item goes live and then completes — one block, two
        // events, addressed by id (FR-14).
        let started_ids: Vec<&str> = events
            .iter()
            .filter_map(|e| match e {
                CodexEvent::ItemStarted { item } => Some(item.id.as_str()),
                _ => None,
            })
            .collect();
        let completed_ids: Vec<&str> = events
            .iter()
            .filter_map(|e| match e {
                CodexEvent::ItemCompleted { item } => Some(item.id.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(started_ids, vec!["item_1"]);
        assert!(completed_ids.contains(&"item_1"));
    }
}
