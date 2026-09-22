//! `stream_event` handlers: the `content_block_start` / `content_block_delta`
//! / `content_block_stop` triad that turns the assistant's incremental
//! deltas into transcript blocks and subagent dispatches.

use super::{BlockKind, StreamEnvironment, ToolRec};
use crate::session::application::RuntimeEvent;
use crate::session::{
    agent_identity, dispatch_model, finalize_tool_input, is_subagent_tool, is_workflow_tool,
    now_ms, resolve_background, tool_summary, uuid, AgentInfo, ContextTracker,
};

use serde_json::Value;
use std::collections::HashMap;

#[allow(clippy::too_many_arguments)]
pub fn handle_stream_event(
    env: &dyn StreamEnvironment,
    session_id: &str,
    cwd: &str,
    ev: &Value,
    blocks: &mut HashMap<u64, (String, BlockKind, String)>,
    tools: &mut HashMap<String, ToolRec>,
    text_accum: &mut HashMap<String, String>,
    // FR-2: the streamed UTF-16 offset, tracked incrementally alongside
    // `text_accum` — same key lifecycle (inserted at the same line
    // `start_text_block` seeds `text_accum`, read/updated in `handle_text_delta`).
    text_utf16: &mut HashMap<String, usize>,
    open_block: &mut Option<(String, BlockKind)>,
    ctx_usage: &mut ContextTracker,
) {
    ctx_usage.observe_stream_event(ev);
    let event_type = ev.get("type").and_then(|t| t.as_str()).unwrap_or("");
    match event_type {
        "content_block_start" => {
            handle_content_block_start(env, session_id, ev, blocks, tools, text_accum, text_utf16)
        }
        "content_block_delta" => handle_content_block_delta(
            env, session_id, ev, blocks, tools, text_accum, text_utf16, open_block,
        ),
        "content_block_stop" => handle_content_block_stop(
            env, session_id, cwd, ev, blocks, tools, text_accum, open_block,
        ),
        _ => {}
    }
}

/// `content_block_start`: opens the bookkeeping slot for a new text or
/// tool_use block. Other block types (e.g. `thinking`) are ignored.
#[allow(clippy::too_many_arguments)]
fn handle_content_block_start(
    env: &dyn StreamEnvironment,
    session_id: &str,
    ev: &Value,
    blocks: &mut HashMap<u64, (String, BlockKind, String)>,
    tools: &mut HashMap<String, ToolRec>,
    text_accum: &mut HashMap<String, String>,
    text_utf16: &mut HashMap<String, usize>,
) {
    let idx = ev.get("index").and_then(|i| i.as_u64()).unwrap_or(0);
    let content_block = ev.get("content_block").cloned().unwrap_or(Value::Null);
    let block_type = content_block
        .get("type")
        .and_then(|t| t.as_str())
        .unwrap_or("");
    match block_type {
        "text" => start_text_block(idx, blocks, text_accum, text_utf16),
        "tool_use" => start_tool_use_block(env, session_id, idx, &content_block, blocks, tools),
        _ => {} // thinking etc. — ignored
    }
}

/// Mint the bookkeeping slot for a new text block. Pure: no engine access.
fn start_text_block(
    idx: u64,
    blocks: &mut HashMap<u64, (String, BlockKind, String)>,
    text_accum: &mut HashMap<String, String>,
    text_utf16: &mut HashMap<String, usize>,
) {
    let block_id = uuid();
    blocks.insert(idx, (block_id.clone(), BlockKind::Text, String::new()));
    text_accum.insert(block_id.clone(), String::new());
    // FR-2: same key lifecycle as `text_accum` — seeded 0 here, incremented in
    // `handle_text_delta`, so the two maps can never disagree on which block ids
    // they know about.
    text_utf16.insert(block_id, 0);
}

/// Parse the `content_block` payload of a `tool_use` block start into its
/// `(tool name, tool_use_id, start input)`. Pure NDJSON parsing.
fn parse_tool_use_block(content_block: &Value) -> (String, String, Value) {
    let tool = content_block
        .get("name")
        .and_then(|n| n.as_str())
        .unwrap_or("")
        .to_string();
    let tool_use_id = content_block
        .get("id")
        .and_then(|i| i.as_str())
        .unwrap_or("")
        .to_string();
    let start_input = content_block
        .get("input")
        .cloned()
        .unwrap_or(Value::Object(Default::default()));
    (tool, tool_use_id, start_input)
}

/// Mint the bookkeeping slot for a new tool_use block, then — if the tool is
/// a subagent dispatch — mint the FR-37 agent record too.
fn start_tool_use_block(
    env: &dyn StreamEnvironment,
    session_id: &str,
    idx: u64,
    content_block: &Value,
    blocks: &mut HashMap<u64, (String, BlockKind, String)>,
    tools: &mut HashMap<String, ToolRec>,
) {
    let block_id = uuid();
    let (tool, tool_use_id, start_input) = parse_tool_use_block(content_block);
    blocks.insert(idx, (block_id.clone(), BlockKind::Tool, String::new()));
    let is_task = is_subagent_tool(&tool);
    let is_workflow = is_workflow_tool(&tool);
    tools.insert(
        tool_use_id.clone(),
        ToolRec {
            block_id: block_id.clone(),
            tool: tool.clone(),
            input: start_input,
            is_task,
            is_workflow,
            started_at: now_ms(),
        },
    );
    // stash tool_use_id in the block accum slot's kind — track via separate map:
    if let Some(entry) = blocks.get_mut(&idx) {
        entry.2 = tool_use_id.clone();
    }
    if is_task {
        mint_subagent(env, session_id, &tool_use_id, tools);
    }
    // workflow-panel FR-2: the run's clock starts at the dispatch, exactly like
    // a subagent's. Its name/phases stay provisional until the input finishes
    // accumulating (FR-4, in finish_tool_block).
    if is_workflow {
        let run_uuid = uuid();
        env.publish(RuntimeEvent::WorkflowStarted {
            run_id: run_uuid.clone(),
            tool_use_id: tool_use_id.clone(),
            at: now_ms(),
        });
        if let Some(rec) = tools.get_mut(&tool_use_id) {
            rec.input["__workflowId"] = Value::String(run_uuid);
        }
    }
}

/// async-agents FR-37: a `Task` (or other subagent) dispatch starts — mint
/// its `AgentInfo` record and stash the correlation key.
fn mint_subagent(
    env: &dyn StreamEnvironment,
    session_id: &str,
    tool_use_id: &str,
    tools: &mut HashMap<String, ToolRec>,
) {
    let agent_id = uuid();
    let (name, desc) = tools
        .get(tool_use_id)
        .map(|rec| agent_identity(&rec.input))
        .unwrap_or_else(|| ("subagent".into(), "subagent".into()));
    let agent = AgentInfo {
        id: agent_id.clone(),
        session_id: session_id.into(),
        name,
        task: desc,
        status: "running".into(),
        started_at: now_ms(),
        ended_at: None,
        background: false,
        last_activity: None,
        step_count: 0,
    };
    if let Some(rec) = tools.get_mut(tool_use_id) {
        rec.input["__agentId"] = Value::String(agent_id);
    }
    env.publish(RuntimeEvent::SubagentStarted {
        tool_use_id: tool_use_id.into(),
        agent,
    });
}

#[allow(clippy::too_many_arguments)]
fn handle_content_block_delta(
    env: &dyn StreamEnvironment,
    session_id: &str,
    ev: &Value,
    blocks: &mut HashMap<u64, (String, BlockKind, String)>,
    tools: &mut HashMap<String, ToolRec>,
    text_accum: &mut HashMap<String, String>,
    text_utf16: &mut HashMap<String, usize>,
    open_block: &mut Option<(String, BlockKind)>,
) {
    let idx = ev.get("index").and_then(|i| i.as_u64()).unwrap_or(0);
    let delta = ev.get("delta").cloned().unwrap_or(Value::Null);
    let delta_type = delta.get("type").and_then(|t| t.as_str()).unwrap_or("");
    match delta_type {
        "text_delta" => handle_text_delta(
            env, session_id, idx, &delta, blocks, text_accum, text_utf16, open_block,
        ),
        "input_json_delta" => handle_input_json_delta(idx, &delta, blocks, tools),
        _ => {} // thinking_delta / signature_delta — ignored
    }
}

#[allow(clippy::too_many_arguments)]
fn handle_text_delta(
    env: &dyn StreamEnvironment,
    _session_id: &str,
    idx: u64,
    delta: &Value,
    blocks: &mut HashMap<u64, (String, BlockKind, String)>,
    text_accum: &mut HashMap<String, String>,
    text_utf16: &mut HashMap<String, usize>,
    open_block: &mut Option<(String, BlockKind)>,
) {
    let Some((block_id, BlockKind::Text, _)) = blocks.get(&idx).cloned() else {
        return;
    };
    let text = delta
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let accum = text_accum.entry(block_id.clone()).or_default();
    let slot = text_utf16.entry(block_id.clone()).or_insert(0);
    let offset = *slot;
    *slot += text.encode_utf16().count();
    accum.push_str(&text);
    env.publish(RuntimeEvent::AssistantAppend {
        block_id: block_id.clone(),
        text: text.clone(),
    });
    *open_block = Some((block_id.clone(), BlockKind::Text));
    env.publish(RuntimeEvent::AssistantChunk {
        block_id,
        text,
        offset,
    });
}

/// `input_json_delta`: accumulate the tool call's partial JSON input onto its
/// `ToolRec` (as the `__acc` string, resolved to real input at block stop).
fn handle_input_json_delta(
    idx: u64,
    delta: &Value,
    blocks: &mut HashMap<u64, (String, BlockKind, String)>,
    tools: &mut HashMap<String, ToolRec>,
) {
    // the block accum slot's third field currently holds the tool_use_id.
    let Some(entry) = blocks.get_mut(&idx) else {
        return;
    };
    let tool_use_id = entry.2.clone();
    let partial = delta
        .get("partial_json")
        .and_then(|t| t.as_str())
        .unwrap_or("");
    if let Some(rec) = tools.get_mut(&tool_use_id) {
        let acc = rec
            .input
            .get("__acc")
            .and_then(|val| val.as_str())
            .unwrap_or("")
            .to_string();
        rec.input["__acc"] = Value::String(acc + partial);
    }
}

fn handle_content_block_stop(
    env: &dyn StreamEnvironment,
    session_id: &str,
    cwd: &str,
    ev: &Value,
    blocks: &mut HashMap<u64, (String, BlockKind, String)>,
    tools: &mut HashMap<String, ToolRec>,
    text_accum: &mut HashMap<String, String>,
    open_block: &mut Option<(String, BlockKind)>,
) {
    let idx = ev.get("index").and_then(|i| i.as_u64()).unwrap_or(0);
    let Some((block_id, kind, slot)) = blocks.get(&idx).cloned() else {
        return;
    };
    match kind {
        BlockKind::Text => finish_text_block(env, session_id, &block_id, text_accum, open_block),
        BlockKind::Tool => {
            finish_tool_block(env, session_id, cwd, &block_id, &slot, tools, open_block)
        }
    }
}

fn finish_text_block(
    env: &dyn StreamEnvironment,
    session_id: &str,
    block_id: &str,
    text_accum: &mut HashMap<String, String>,
    open_block: &mut Option<(String, BlockKind)>,
) {
    let text = text_accum.get(block_id).cloned().unwrap_or_default();
    publish_text_block(env, session_id, block_id, text);
    *open_block = None;
}

/// Settle an assistant text block: final text into the transcript buffer,
/// persist it (durable-sessions FR-2), and announce it with its COMPLETE text
/// so a listener that missed a delta stops rendering a truncated answer.
///
/// Shared with `close_open_block` (lines.rs), which reaches this same path when
/// the reader dies with a block still open — an interrupted answer used to
/// never reach the buffer at all, so it vanished from the transcript on reload.
pub fn publish_text_block(
    env: &dyn StreamEnvironment,
    _session_id: &str,
    block_id: &str,
    text: String,
) {
    env.publish(RuntimeEvent::AssistantFinal {
        block_id: block_id.into(),
        text,
    });
}

/// tool: finalize input (accumulated json overrides start input), derive
/// summary, emit `tool.start`. `tool_use_id` is the block's accum-slot
/// field, which for a tool block holds the tool_use_id rather than text.
fn finish_tool_block(
    env: &dyn StreamEnvironment,
    _session_id: &str,
    cwd: &str,
    block_id: &str,
    tool_use_id: &str,
    tools: &mut HashMap<String, ToolRec>,
    open_block: &mut Option<(String, BlockKind)>,
) {
    let Some(rec) = tools.get_mut(tool_use_id) else {
        return;
    };
    rec.input = finalize_tool_input(&rec.input);
    let summary = tool_summary(&rec.tool, &rec.input, cwd);
    let model = rec.is_task.then(|| dispatch_model(&rec.input)).flatten();
    // The shared projector applies the transcript before specialized observations,
    // preserving the original dispatch/input/ToolStart ordering.
    if rec.is_task {
        if let Some(agent_id) = rec.input.get("__agentId").and_then(Value::as_str) {
            let (name, task) = agent_identity(&rec.input);
            env.publish(RuntimeEvent::SubagentInput {
                agent_id: agent_id.into(),
                background: resolve_background(&rec.input, &rec.tool),
                name,
                task,
            });
        }
    }
    if rec.is_workflow {
        if let Some(run_id) = rec.input.get("__workflowId").and_then(Value::as_str) {
            env.publish(RuntimeEvent::WorkflowInput {
                run_id: run_id.into(),
                input: rec.input.clone(),
            });
        }
    }
    *open_block = Some((block_id.into(), BlockKind::Tool));
    env.publish(RuntimeEvent::ToolInputReady {
        block_id: block_id.into(),
        tool: rec.tool.clone(),
        summary,
        is_task: rec.is_task,
        model,
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ---------- parse_tool_use_block (content_block_start / tool_use) ----------

    #[test]
    fn parse_tool_use_block_extracts_name_id_input() {
        let content_block = json!({
            "type": "tool_use",
            "name": "Read",
            "id": "toolu_1",
            "input": { "file_path": "/a.rs" }
        });
        let (tool, tool_use_id, input) = parse_tool_use_block(&content_block);
        assert_eq!(tool, "Read");
        assert_eq!(tool_use_id, "toolu_1");
        assert_eq!(input, json!({ "file_path": "/a.rs" }));
    }

    #[test]
    fn parse_tool_use_block_missing_fields_default_empty() {
        let content_block = json!({ "type": "tool_use" });
        let (tool, tool_use_id, input) = parse_tool_use_block(&content_block);
        assert_eq!(tool, "");
        assert_eq!(tool_use_id, "");
        assert_eq!(input, json!({}));
    }

    // ---------- start_text_block (content_block_start / text) ----------

    #[test]
    fn start_text_block_inserts_text_kind_and_empty_accum() {
        let mut blocks = HashMap::new();
        let mut text_accum = HashMap::new();
        let mut text_utf16 = HashMap::new();
        start_text_block(0, &mut blocks, &mut text_accum, &mut text_utf16);
        let (block_id, kind, slot) = blocks.get(&0).cloned().expect("block inserted");
        assert_eq!(kind, BlockKind::Text);
        assert_eq!(slot, "");
        assert_eq!(text_accum.get(&block_id), Some(&String::new()));
        // FR-2: text_utf16 shares text_accum's exact key lifecycle.
        assert_eq!(text_utf16.get(&block_id), Some(&0));
    }

    // ---------- handle_text_delta (FR-2: incremental UTF-16 offset) ----------

    #[test]
    fn handle_text_delta_tracks_offset_incrementally_without_reencoding() {
        let env = crate::session::testenv::TestEnv::default();
        let mut blocks = HashMap::new();
        let mut text_accum = HashMap::new();
        let mut text_utf16 = HashMap::new();
        let mut open_block = None;
        start_text_block(0, &mut blocks, &mut text_accum, &mut text_utf16);

        // Multi-byte / surrogate-pair content: "é" (1 UTF-16 unit) then "😀"
        // (2 UTF-16 units, a surrogate pair) — a naive byte-length offset would
        // be wrong for either.
        handle_text_delta(
            &env,
            "s1",
            0,
            &json!({ "type": "text_delta", "text": "é" }),
            &mut blocks,
            &mut text_accum,
            &mut text_utf16,
            &mut open_block,
        );
        handle_text_delta(
            &env,
            "s1",
            0,
            &json!({ "type": "text_delta", "text": "😀" }),
            &mut blocks,
            &mut text_accum,
            &mut text_utf16,
            &mut open_block,
        );

        let block_id = blocks.get(&0).unwrap().0.clone();
        // Offset after both deltas equals the total UTF-16 length streamed so far.
        assert_eq!(text_utf16.get(&block_id), Some(&3));
        assert_eq!(text_accum.get(&block_id).unwrap(), "é😀");
    }

    #[test]
    fn handle_text_delta_missing_offset_entry_defaults_to_zero() {
        // FR-2 edge case: a delta arriving without its content_block_start has
        // no text_utf16 entry — treat it as 0, exactly as text_accum's
        // or_default() does, so the two maps fail the same way.
        let env = crate::session::testenv::TestEnv::default();
        let mut blocks = HashMap::new();
        blocks.insert(0u64, ("b1".to_string(), BlockKind::Text, String::new()));
        let mut text_accum = HashMap::new();
        let mut text_utf16 = HashMap::new();
        let mut open_block = None;
        handle_text_delta(
            &env,
            "s1",
            0,
            &json!({ "type": "text_delta", "text": "hi" }),
            &mut blocks,
            &mut text_accum,
            &mut text_utf16,
            &mut open_block,
        );
        assert_eq!(text_utf16.get("b1"), Some(&2));
    }
}
