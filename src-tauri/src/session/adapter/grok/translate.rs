//! Grok's pure translation half: `GrokEvent` → `Effect`, plus the
//! command-inspect capture a completed tool call states about itself.
//!
//! Split out of `runner.rs` (which keeps the `AppHandle` half — `apply`,
//! `begin_turn`, `run_reader`) along the seam that file's own doc comment
//! already named: nothing here needs a live `AppHandle`, which is why every
//! test of this adapter lives in this module.

use super::wire::GrokEvent;
use crate::session::*;

use serde_json::Value;
use std::collections::HashMap;

// ---------- the pure translation (FR-13..FR-18) ----------

/// One thing a `GrokEvent` asks the engine to do.
#[derive(Debug, Clone, PartialEq)]
pub(super) enum Effect {
    /// FR-14: a streamed chunk of assistant text. `accumulated` is the
    /// block's full text so far (what the transcript buffer stores);
    /// `delta`/`offset` are what rides `SessionEvent::AssistantDelta`.
    TextDelta {
        block_id: String,
        delta: String,
        accumulated: String,
        offset: usize,
    },
    TextDone {
        block_id: String,
        text: String,
    },
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
    /// FR-16: context window occupancy, off `end`'s aggregate usage only.
    Usage(u64),
    Failed(String),
}

/// FR-15: ACP `kind` → the Claude Code tool vocabulary a permission rule and
/// a transcript card both key off (the standing naming decision). Unmapped
/// (including `think`/`switch_mode`/`other`/anything future) falls through to
/// the caller's own `toolName`/`title` — a generic card, never dropped.
fn kind_to_claude_name(kind: &str) -> Option<&'static str> {
    match kind {
        "read" => Some("Read"),
        // `delete`/`move` mutate the working tree exactly like `edit` does —
        // same displayed name, so the SAME diff-recompute trigger `apply`
        // keys off ("Edit") fires for all three.
        "edit" | "delete" | "move" => Some("Edit"),
        "search" => Some("Grep"),
        "execute" => Some("Bash"),
        "fetch" => Some("WebFetch"),
        _ => None,
    }
}

/// FR-15: the displayed tool name for a `tool_call`. `kind` wins when it maps
/// to Claude Code's vocabulary; otherwise the CLI's own `toolName` (its
/// internal tool id, e.g. `read_file`), then `title`, then a bare fallback —
/// never dropped, per FR-15's "unknown kind renders as a generic tool card".
fn tool_display_name(kind: Option<&str>, tool_name: Option<&str>, title: Option<&str>) -> String {
    if let Some(mapped) = kind.and_then(kind_to_claude_name) {
        return mapped.to_string();
    }
    tool_name
        .or(title)
        .filter(|s| !s.is_empty())
        .unwrap_or("Tool")
        .to_string()
}

/// command-inspect FR-1/FR-9: what a completed tool_call states about itself,
/// captured as a side channel alongside its (already-summarized) `ToolDone`
/// effect — same reasoning `codex::runner::ToolCapture` documents: kept off
/// `Effect` because `started_at`/`ended_at` are wall clock, which the
/// FR-13..FR-18 exact-`Vec<Effect>` tests below could never pin down. Grok's
/// ACP-style wire carries no raw command/output/exit code at all — only
/// `title`/`kind`/`toolName`/`status` — so every capture is `'generic'`
/// (FR-9: "an adapter fills what its wire format carries").
#[derive(Debug, Clone, PartialEq)]
pub(super) struct ToolCapture {
    pub(super) tool: String,
    pub(super) started_at: u64,
    pub(super) ended_at: u64,
    pub(super) input: Value,
    pub(super) is_error: bool,
}

/// The `{title, kind, toolName}` triple Grok stated at `tool_call`, as a JSON
/// object with only the fields it actually carried — never a fabricated
/// `null`.
fn capture_input(title: Option<&str>, kind: Option<&str>, tool_name: Option<&str>) -> Value {
    let mut o = serde_json::Map::new();
    if let Some(t) = title {
        o.insert("title".to_string(), Value::String(t.to_string()));
    }
    if let Some(k) = kind {
        o.insert("kind".to_string(), Value::String(k.to_string()));
    }
    if let Some(tn) = tool_name {
        o.insert("toolName".to_string(), Value::String(tn.to_string()));
    }
    Value::Object(o)
}

/// The completion meta for a finished tool card. `status` is Grok's own
/// (`pending`/`in_progress`/`completed`/`failed`) — no richer output shape is
/// documented per-tool, so this is intentionally coarse rather than guessed.
fn tool_meta(status: Option<&str>) -> String {
    match status {
        Some("failed") => "failed".to_string(),
        _ => "done".to_string(),
    }
}

/// FR-13..FR-18: the stream → effects state machine.
///
/// Stateful for two reasons: (1) consecutive `text` chunks belong to ONE open
/// assistant block until something else interrupts them (a tool call, a
/// response boundary, the turn's end); (2) a `tool_call`'s id must survive
/// until its `tool_call_update` closes the same card (FR-15).
pub(super) struct Translator<F: FnMut() -> String> {
    new_id: F,
    /// The currently-streaming assistant block: (block_id, accumulated text).
    open_text: Option<(String, String)>,
    /// Grok `toolCallId` → (Francois block id, displayed tool name, what
    /// `tool_call` stated as the capture input, when it opened).
    open_tools: HashMap<String, (String, String, Value, u64)>,
    /// command-inspect: captures produced by the LAST `on_event`, not yet
    /// claimed by `take_capture`.
    captures: Vec<(String, ToolCapture)>,
}

impl<F: FnMut() -> String> Translator<F> {
    pub(super) fn new(new_id: F) -> Self {
        Self {
            new_id,
            open_text: None,
            open_tools: HashMap::new(),
            captures: Vec::new(),
        }
    }

    /// command-inspect: claim the capture stashed for `block_id`, if any.
    pub(super) fn take_capture(&mut self, block_id: &str) -> Option<ToolCapture> {
        let idx = self.captures.iter().position(|(id, _)| id == block_id)?;
        Some(self.captures.remove(idx).1)
    }

    /// Finalize whatever text block is open, if any — called before any
    /// non-text event so a tool call or the turn's end never lands mid-block.
    fn close_text(&mut self) -> Option<Effect> {
        let (block_id, text) = self.open_text.take()?;
        Some(Effect::TextDone { block_id, text })
    }

    pub(super) fn on_event(&mut self, event: GrokEvent) -> Vec<Effect> {
        match event {
            GrokEvent::Text { text } => {
                let (block_id, accumulated) = match self.open_text.take() {
                    Some(existing) => existing,
                    None => ((self.new_id)(), String::new()),
                };
                let offset = accumulated.encode_utf16().count();
                let mut accumulated = accumulated;
                accumulated.push_str(&text);
                let effect = Effect::TextDelta {
                    block_id: block_id.clone(),
                    delta: text,
                    accumulated: accumulated.clone(),
                    offset,
                };
                self.open_text = Some((block_id, accumulated));
                vec![effect]
            }
            GrokEvent::ToolCall {
                call_id,
                title,
                kind,
                tool_name,
            } => {
                let mut effects: Vec<Effect> = self.close_text().into_iter().collect();
                // Idempotent: a duplicate tool_call for an id already open
                // (Grok is not documented to repeat one, but §FR-12 leniency
                // means never trusting a stream not to) opens no second card.
                if !self.open_tools.contains_key(&call_id) {
                    let block_id = (self.new_id)();
                    let tool =
                        tool_display_name(kind.as_deref(), tool_name.as_deref(), title.as_deref());
                    let input =
                        capture_input(title.as_deref(), kind.as_deref(), tool_name.as_deref());
                    let summary = title
                        .or(tool_name)
                        .filter(|s| !s.is_empty())
                        .unwrap_or_default();
                    self.open_tools
                        .insert(call_id, (block_id.clone(), tool.clone(), input, now_ms()));
                    effects.push(Effect::ToolStart {
                        block_id,
                        tool,
                        summary,
                    });
                }
                effects
            }
            GrokEvent::ToolCallUpdate { call_id, status } => {
                let mut effects: Vec<Effect> = self.close_text().into_iter().collect();
                let is_error = status.as_deref() == Some("failed");
                let meta = tool_meta(status.as_deref());
                match self.open_tools.remove(&call_id) {
                    Some((block_id, tool, input, started_at)) => {
                        self.captures.push((
                            block_id.clone(),
                            ToolCapture {
                                tool: tool.clone(),
                                started_at,
                                ended_at: now_ms(),
                                input,
                                is_error,
                            },
                        ));
                        effects.push(Effect::ToolDone {
                            block_id,
                            tool,
                            meta,
                        });
                    }
                    // An update with no matching start still has to appear —
                    // same "never silently drop the tool call" reasoning
                    // `codex::runner::Translator` documents. No capture: there
                    // is no `tool_call` to have stated anything about it.
                    None => {
                        let block_id = (self.new_id)();
                        effects.push(Effect::ToolStart {
                            block_id: block_id.clone(),
                            tool: "Tool".into(),
                            summary: String::new(),
                        });
                        effects.push(Effect::ToolDone {
                            block_id,
                            tool: "Tool".into(),
                            meta,
                        });
                    }
                }
                effects
            }
            GrokEvent::End { stop_reason, usage } => {
                let mut effects: Vec<Effect> = self.close_text().into_iter().collect();
                // FR-16: no usage reported ⇒ the meter stays empty, never
                // estimated.
                if !usage.is_zero() {
                    effects.push(Effect::Usage(usage.context_used()));
                }
                // FR-17: `refusal` ends the turn errored; every other stop
                // reason (including `cancelled`, which the reader loop's own
                // `interrupted` flag already accounts for) ends it cleanly.
                if stop_reason.as_deref() == Some("refusal") {
                    effects.push(Effect::Failed("grok refused this request".to_string()));
                }
                effects
            }
            GrokEvent::Error { message } => {
                let mut effects: Vec<Effect> = self.close_text().into_iter().collect();
                effects.push(Effect::Failed(message));
                effects
            }
            // FR-18: dropped explicitly, not by falling through.
            GrokEvent::Thought | GrokEvent::Plan => Vec::new(),
            // Recognized, no block corresponds to either.
            GrokEvent::ResponseUsage | GrokEvent::AvailableCommands => Vec::new(),
            GrokEvent::Unknown => Vec::new(),
        }
    }

    /// Whatever is still open when the stream ends — a killed child would
    /// otherwise leave a text block half-written or a tool card spinning
    /// forever.
    pub(super) fn close_open(&mut self) -> Vec<Effect> {
        let mut effects = Vec::new();
        if let Some(e) = self.close_text() {
            effects.push(e);
        }
        let mut open: Vec<(String, (String, String, Value, u64))> =
            self.open_tools.drain().collect();
        // HashMap order is not stable; the transcript's is.
        open.sort_by(|a, b| a.0.cmp(&b.0));
        for (_, (block_id, tool, ..)) in open {
            effects.push(Effect::ToolDone {
                block_id,
                tool,
                meta: "interrupted".to_string(),
            });
        }
        effects
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::adapter::grok::wire::parse_line;
    use serde_json::json;

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

    // ---------- FR-13: the captured (doc-derived) turn, end to end ----------

    #[test]
    fn the_captured_turn_translates_into_the_expected_blocks() {
        let effects = translate_all(include_str!("fixtures/exec_turn.jsonl"));
        assert_eq!(
            effects,
            vec![
                Effect::TextDelta {
                    block_id: "b1".into(),
                    delta: "I\u{2019}ll check the current folder.".into(),
                    accumulated: "I\u{2019}ll check the current folder.".into(),
                    offset: 0,
                },
                Effect::TextDone {
                    block_id: "b1".into(),
                    text: "I\u{2019}ll check the current folder.".into(),
                },
                Effect::ToolStart {
                    block_id: "b2".into(),
                    tool: "Read".into(),
                    summary: "Read".into(),
                },
                Effect::ToolDone {
                    block_id: "b2".into(),
                    tool: "Read".into(),
                    meta: "done".into(),
                },
                Effect::TextDelta {
                    block_id: "b3".into(),
                    delta: "Here's a summary of src/main.rs.".into(),
                    accumulated: "Here's a summary of src/main.rs.".into(),
                    offset: 0,
                },
                Effect::TextDone {
                    block_id: "b3".into(),
                    text: "Here's a summary of src/main.rs.".into(),
                },
                Effect::Usage(812 + 45),
            ]
        );
    }

    // ---------- FR-14: consecutive text chunks are ONE block ----------

    #[test]
    fn consecutive_text_events_accumulate_into_one_block_with_growing_offsets() {
        let effects = translate_all(
            "{\"type\":\"text\",\"data\":\"Hel\"}\n{\"type\":\"text\",\"data\":\"lo\"}",
        );
        assert_eq!(
            effects,
            vec![
                Effect::TextDelta {
                    block_id: "b1".into(),
                    delta: "Hel".into(),
                    accumulated: "Hel".into(),
                    offset: 0,
                },
                Effect::TextDelta {
                    block_id: "b1".into(),
                    delta: "lo".into(),
                    accumulated: "Hello".into(),
                    offset: 3,
                },
                Effect::TextDone {
                    block_id: "b1".into(),
                    text: "Hello".into(),
                },
            ]
        );
    }

    #[test]
    fn a_tool_call_closes_any_open_text_block_first() {
        let effects = translate_all(
            r#"{"type":"text","data":"checking"}
{"type":"tool_call","toolCallId":"c1","title":"Read","kind":"read","toolName":"read_file"}"#,
        );
        assert_eq!(
            effects,
            vec![
                Effect::TextDelta {
                    block_id: "b1".into(),
                    delta: "checking".into(),
                    accumulated: "checking".into(),
                    offset: 0,
                },
                Effect::TextDone {
                    block_id: "b1".into(),
                    text: "checking".into(),
                },
                Effect::ToolStart {
                    block_id: "b2".into(),
                    tool: "Read".into(),
                    summary: "Read".into(),
                },
                // `translate_all` always drains `close_open` — the tool call
                // above never received its `tool_call_update`.
                Effect::ToolDone {
                    block_id: "b2".into(),
                    tool: "Read".into(),
                    meta: "interrupted".into(),
                },
            ]
        );
    }

    // ---------- FR-15: tool name mapping ----------

    #[test]
    fn an_unmapped_kind_falls_back_to_tool_name_then_title() {
        let effects = translate_all(
            r#"{"type":"tool_call","toolCallId":"c1","title":"Update plan","kind":"think","toolName":"update_plan"}"#,
        );
        match &effects[0] {
            Effect::ToolStart { tool, .. } => assert_eq!(tool, "update_plan"),
            other => panic!("expected ToolStart, got {other:?}"),
        }
    }

    #[test]
    fn edit_delete_and_move_kinds_all_display_as_edit() {
        for kind in ["edit", "delete", "move"] {
            let line = format!(
                r#"{{"type":"tool_call","toolCallId":"c1","kind":"{kind}","toolName":"x"}}"#
            );
            let effects = translate_all(&line);
            match &effects[0] {
                Effect::ToolStart { tool, .. } => assert_eq!(tool, "Edit", "kind={kind}"),
                other => panic!("expected ToolStart, got {other:?}"),
            }
        }
    }

    #[test]
    fn a_finishing_edit_tool_is_named_edit_so_the_diff_view_recomputes() {
        let effects = translate_all(
            r#"{"type":"tool_call","toolCallId":"c1","kind":"edit","toolName":"search_replace","title":"Edit"}
{"type":"tool_call_update","toolCallId":"c1","status":"completed"}"#,
        );
        match &effects[1] {
            Effect::ToolDone { tool, meta, .. } => {
                assert_eq!(tool, "Edit");
                assert_eq!(meta, "done");
            }
            other => panic!("expected ToolDone, got {other:?}"),
        }
    }

    #[test]
    fn a_failed_tool_call_reports_failed_not_done() {
        let effects = translate_all(
            r#"{"type":"tool_call","toolCallId":"c1","kind":"execute","toolName":"run_terminal_cmd"}
{"type":"tool_call_update","toolCallId":"c1","status":"failed"}"#,
        );
        match effects.last().unwrap() {
            Effect::ToolDone { meta, .. } => assert_eq!(meta, "failed"),
            other => panic!("expected ToolDone, got {other:?}"),
        }
    }

    #[test]
    fn an_update_with_no_matching_start_still_produces_a_card() {
        let effects =
            translate_all(r#"{"type":"tool_call_update","toolCallId":"c1","status":"completed"}"#);
        assert_eq!(
            effects,
            vec![
                Effect::ToolStart {
                    block_id: "b1".into(),
                    tool: "Tool".into(),
                    summary: String::new(),
                },
                Effect::ToolDone {
                    block_id: "b1".into(),
                    tool: "Tool".into(),
                    meta: "done".into(),
                },
            ]
        );
    }

    // ---------- FR-13: what produces nothing ----------

    #[test]
    fn thought_plan_response_usage_and_available_commands_produce_no_blocks() {
        let effects = translate_all(
            r#"{"type":"thought","data":"hmm"}
{"type":"plan","entries":[]}
{"type":"usage","messageId":"r1","usage":{}}
{"type":"available_commands","tools":[],"commands":[]}
not json at all
{"type":"brand.new.event"}"#,
        );
        assert_eq!(effects, Vec::new());
    }

    // ---------- interruption ----------

    #[test]
    fn a_stream_that_dies_mid_tool_call_closes_the_open_card() {
        let effects = translate_all(
            r#"{"type":"tool_call","toolCallId":"c1","kind":"execute","toolName":"run_terminal_cmd","title":"sleep 100"}"#,
        );
        assert_eq!(
            effects,
            vec![
                Effect::ToolStart {
                    block_id: "b1".into(),
                    tool: "Bash".into(),
                    summary: "sleep 100".into(),
                },
                Effect::ToolDone {
                    block_id: "b1".into(),
                    tool: "Bash".into(),
                    meta: "interrupted".into(),
                },
            ]
        );
    }

    #[test]
    fn a_stream_that_dies_mid_text_still_closes_the_block() {
        let effects = translate_all(r#"{"type":"text","data":"partial"}"#);
        assert_eq!(
            effects,
            vec![
                Effect::TextDelta {
                    block_id: "b1".into(),
                    delta: "partial".into(),
                    accumulated: "partial".into(),
                    offset: 0,
                },
                Effect::TextDone {
                    block_id: "b1".into(),
                    text: "partial".into(),
                },
            ]
        );
    }

    // ---------- FR-16/17: end ----------

    #[test]
    fn end_reports_usage_once() {
        let effects = translate_all(
            r#"{"type":"end","stopReason":"end_turn","usage":{"input_tokens":100,"output_tokens":10,"cache_read_input_tokens":50,"cache_creation_input_tokens":0,"reasoning_tokens":4}}"#,
        );
        assert_eq!(effects, vec![Effect::Usage(160)]);
    }

    #[test]
    fn end_with_no_usage_reports_nothing_rather_than_estimating() {
        let effects = translate_all(r#"{"type":"end","stopReason":"cancelled"}"#);
        assert_eq!(effects, Vec::new());
    }

    #[test]
    fn a_refusal_stop_reason_ends_the_turn_errored() {
        let effects = translate_all(r#"{"type":"end","stopReason":"refusal"}"#);
        assert_eq!(
            effects,
            vec![Effect::Failed("grok refused this request".into())]
        );
    }

    #[test]
    fn an_error_line_surfaces_as_a_failure_effect() {
        assert_eq!(
            translate_all(r#"{"type":"error","message":"rate limited"}"#),
            vec![Effect::Failed("rate limited".into())]
        );
    }

    #[test]
    fn a_failure_mid_stream_does_not_stop_earlier_blocks_from_rendering() {
        let effects = translate_all(
            r#"{"type":"text","data":"starting"}
{"type":"error","message":"boom"}"#,
        );
        assert_eq!(
            effects,
            vec![
                Effect::TextDelta {
                    block_id: "b1".into(),
                    delta: "starting".into(),
                    accumulated: "starting".into(),
                    offset: 0,
                },
                Effect::TextDone {
                    block_id: "b1".into(),
                    text: "starting".into(),
                },
                Effect::Failed("boom".into()),
            ]
        );
    }

    // ---------- command-inspect FR-1/FR-9: the capture side channel ----------

    #[test]
    fn capture_input_only_carries_the_fields_grok_actually_stated() {
        assert_eq!(
            capture_input(Some("sleep 100"), Some("execute"), Some("run_terminal_cmd")),
            json!({ "title": "sleep 100", "kind": "execute", "toolName": "run_terminal_cmd" })
        );
        assert_eq!(capture_input(None, None, None), json!({}));
        assert_eq!(
            capture_input(Some("Read"), None, None),
            json!({ "title": "Read" })
        );
    }

    #[test]
    fn a_completed_tool_call_stashes_a_capture_claimable_exactly_once() {
        let mut t = Translator::new(counter());
        let effects = t.on_event(parse_line(
            r#"{"type":"tool_call","toolCallId":"c1","title":"sleep 100","kind":"execute","toolName":"run_terminal_cmd"}"#,
        ));
        let block_id = match &effects[0] {
            Effect::ToolStart { block_id, .. } => block_id.clone(),
            other => panic!("expected ToolStart, got {other:?}"),
        };
        t.on_event(parse_line(
            r#"{"type":"tool_call_update","toolCallId":"c1","status":"completed"}"#,
        ));
        let cap = t.take_capture(&block_id).expect("a capture was stashed");
        assert_eq!(cap.tool, "Bash");
        assert_eq!(
            cap.input,
            json!({ "title": "sleep 100", "kind": "execute", "toolName": "run_terminal_cmd" })
        );
        assert!(!cap.is_error);
        assert!(cap.ended_at >= cap.started_at);
        assert!(t.take_capture(&block_id).is_none());
    }

    #[test]
    fn a_failed_tool_call_update_captures_is_error() {
        let mut t = Translator::new(counter());
        let effects = t.on_event(parse_line(
            r#"{"type":"tool_call","toolCallId":"c1","title":"npm test","kind":"execute"}"#,
        ));
        let block_id = match &effects[0] {
            Effect::ToolStart { block_id, .. } => block_id.clone(),
            other => panic!("expected ToolStart, got {other:?}"),
        };
        t.on_event(parse_line(
            r#"{"type":"tool_call_update","toolCallId":"c1","status":"failed"}"#,
        ));
        assert!(t.take_capture(&block_id).unwrap().is_error);
    }

    #[test]
    fn an_update_with_no_matching_start_stashes_no_capture() {
        let mut t = Translator::new(counter());
        let effects = t.on_event(parse_line(
            r#"{"type":"tool_call_update","toolCallId":"c1","status":"completed"}"#,
        ));
        let block_id = match &effects[1] {
            Effect::ToolDone { block_id, .. } => block_id.clone(),
            other => panic!("expected ToolDone, got {other:?}"),
        };
        assert!(t.take_capture(&block_id).is_none());
    }

    #[test]
    fn an_interrupted_close_stashes_no_capture() {
        let mut t = Translator::new(counter());
        let effects = t.on_event(parse_line(
            r#"{"type":"tool_call","toolCallId":"c1","title":"sleep 100"}"#,
        ));
        let block_id = match &effects[0] {
            Effect::ToolStart { block_id, .. } => block_id.clone(),
            other => panic!("expected ToolStart, got {other:?}"),
        };
        t.close_open();
        assert!(t.take_capture(&block_id).is_none());
    }
}
