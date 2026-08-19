//! `stream_event` handlers: the `content_block_start` / `content_block_delta`
//! / `content_block_stop` triad that turns the assistant's incremental
//! deltas into transcript blocks and subagent dispatches.

use super::{BlockKind, ToolRec};
use crate::session::*;

use serde_json::Value;
use std::collections::HashMap;

#[allow(clippy::too_many_arguments)]
pub(crate) fn handle_stream_event(
    env: &dyn SessionEnv,
    session_id: &str,
    cwd: &str,
    ev: &Value,
    blocks: &mut HashMap<u64, (String, BlockKind, String)>,
    tools: &mut HashMap<String, ToolRec>,
    text_accum: &mut HashMap<String, String>,
    open_block: &mut Option<(String, BlockKind)>,
    ctx_usage: &mut ContextTracker,
) {
    ctx_usage.observe_stream_event(ev);
    let event_type = ev.get("type").and_then(|t| t.as_str()).unwrap_or("");
    match event_type {
        "content_block_start" => {
            handle_content_block_start(env, session_id, ev, blocks, tools, text_accum)
        }
        "content_block_delta" => {
            handle_content_block_delta(env, session_id, ev, blocks, tools, text_accum, open_block)
        }
        "content_block_stop" => handle_content_block_stop(
            env, session_id, cwd, ev, blocks, tools, text_accum, open_block,
        ),
        _ => {}
    }
}

/// `content_block_start`: opens the bookkeeping slot for a new text or
/// tool_use block. Other block types (e.g. `thinking`) are ignored.
fn handle_content_block_start(
    env: &dyn SessionEnv,
    session_id: &str,
    ev: &Value,
    blocks: &mut HashMap<u64, (String, BlockKind, String)>,
    tools: &mut HashMap<String, ToolRec>,
    text_accum: &mut HashMap<String, String>,
) {
    let idx = ev.get("index").and_then(|i| i.as_u64()).unwrap_or(0);
    let content_block = ev.get("content_block").cloned().unwrap_or(Value::Null);
    let block_type = content_block
        .get("type")
        .and_then(|t| t.as_str())
        .unwrap_or("");
    match block_type {
        "text" => start_text_block(idx, blocks, text_accum),
        "tool_use" => start_tool_use_block(env, session_id, idx, &content_block, blocks, tools),
        _ => {} // thinking etc. — ignored
    }
}

/// Mint the bookkeeping slot for a new text block. Pure: no engine access.
fn start_text_block(
    idx: u64,
    blocks: &mut HashMap<u64, (String, BlockKind, String)>,
    text_accum: &mut HashMap<String, String>,
) {
    let block_id = uuid();
    blocks.insert(idx, (block_id.clone(), BlockKind::Text, String::new()));
    text_accum.insert(block_id, String::new());
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
    env: &dyn SessionEnv,
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
        },
    );
    // stash tool_use_id in the block accum slot's kind — track via separate map:
    blocks
        .get_mut(&idx)
        .map(|entry| entry.2 = tool_use_id.clone());
    if is_task {
        mint_subagent(env, session_id, &tool_use_id, tools);
    }
    // workflow-panel FR-2: the run's clock starts at the dispatch, exactly like
    // a subagent's. Its name/phases stay provisional until the input finishes
    // accumulating (FR-4, in finish_tool_block).
    if is_workflow {
        let run_uuid = on_workflow_start(env, session_id, &tool_use_id);
        if let Some(rec) = tools.get_mut(&tool_use_id) {
            rec.input["__workflowId"] = Value::String(run_uuid);
        }
    }
}

/// async-agents FR-37: a `Task` (or other subagent) dispatch starts — mint
/// its `AgentInfo` record and stash the correlation key.
fn mint_subagent(
    env: &dyn SessionEnv,
    session_id: &str,
    tool_use_id: &str,
    tools: &mut HashMap<String, ToolRec>,
) {
    let agent_id = uuid();
    // Provisional: on a streamed dispatch the input is still empty here, so both
    // fall back to the placeholder. finish_tool_block re-derives them (FR-37).
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
        started_at: now_ms(), // async-agents FR-7: never changes
        ended_at: None,
        // async-agents FR-3: conservative until content_block_stop
        // resolves the FR-2 ladder over the complete input JSON.
        background: false,
        last_activity: None,
        step_count: 0,
    };
    {
        let mut map = env.engine().sessions.lock().unwrap();
        if let Some(s) = map.get_mut(session_id) {
            s.insert_agent(agent.clone());
            // async-agents FR-1: the correlation key. Session-scoped
            // (not turn-local) so FR-13/FR-16 reach it after the
            // tool call closed.
            s.agent_by_tool
                .insert(tool_use_id.to_string(), agent_id.clone());
        }
    }
    // record agent_id against the tool for completion
    if let Some(rec) = tools.get_mut(tool_use_id) {
        rec.input["__agentId"] = Value::String(agent_id.clone());
    }
    env.emit_session(SessionEvent::AgentUpdate { agent });
}

fn handle_content_block_delta(
    env: &dyn SessionEnv,
    session_id: &str,
    ev: &Value,
    blocks: &mut HashMap<u64, (String, BlockKind, String)>,
    tools: &mut HashMap<String, ToolRec>,
    text_accum: &mut HashMap<String, String>,
    open_block: &mut Option<(String, BlockKind)>,
) {
    let idx = ev.get("index").and_then(|i| i.as_u64()).unwrap_or(0);
    let delta = ev.get("delta").cloned().unwrap_or(Value::Null);
    let delta_type = delta.get("type").and_then(|t| t.as_str()).unwrap_or("");
    match delta_type {
        "text_delta" => {
            handle_text_delta(env, session_id, idx, &delta, blocks, text_accum, open_block)
        }
        "input_json_delta" => handle_input_json_delta(idx, &delta, blocks, tools),
        _ => {} // thinking_delta / signature_delta — ignored
    }
}

fn handle_text_delta(
    env: &dyn SessionEnv,
    session_id: &str,
    idx: u64,
    delta: &Value,
    blocks: &mut HashMap<u64, (String, BlockKind, String)>,
    text_accum: &mut HashMap<String, String>,
    open_block: &mut Option<(String, BlockKind)>,
) {
    let Some((block_id, kind, _)) = blocks.get(&idx).cloned() else {
        return;
    };
    if kind != BlockKind::Text {
        return;
    }
    let text = delta
        .get("text")
        .and_then(|t| t.as_str())
        .unwrap_or("")
        .to_string();
    let accum = text_accum.entry(block_id.clone()).or_default();
    // The prefix already streamed for this block, counted the way the webview
    // counts a JS string — this is what lets the frontend recognise a chunk it
    // already has (hydration overlap) instead of appending it twice.
    let offset = accum.encode_utf16().count();
    accum.push_str(&text);
    // Keep the transcript buffer current with the partial text, so a view that
    // hydrates mid-block seeds the opening it would otherwise never receive.
    {
        let mut map = env.engine().sessions.lock().unwrap();
        if let Some(s) = map.get_mut(session_id) {
            s.buf_assistant_streaming(&block_id, accum);
        }
    }
    *open_block = Some((block_id.clone(), BlockKind::Text));
    env.emit_session(SessionEvent::AssistantDelta {
        session_id: session_id.into(),
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
    env: &dyn SessionEnv,
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
    env: &dyn SessionEnv,
    session_id: &str,
    block_id: &str,
    text_accum: &mut HashMap<String, String>,
    open_block: &mut Option<(String, BlockKind)>,
) {
    let text = text_accum.get(block_id).cloned().unwrap_or_default();
    finalize_text_block(env, session_id, block_id, text);
    *open_block = None;
}

/// Settle an assistant text block: final text into the transcript buffer,
/// persist it (durable-sessions FR-2), and announce it with its COMPLETE text
/// so a listener that missed a delta stops rendering a truncated answer.
///
/// Shared with `close_open_block` (lines.rs), which reaches this same path when
/// the reader dies with a block still open — an interrupted answer used to
/// never reach the buffer at all, so it vanished from the transcript on reload.
pub(crate) fn finalize_text_block(
    env: &dyn SessionEnv,
    session_id: &str,
    block_id: &str,
    text: String,
) {
    let block = {
        let mut map = env.engine().sessions.lock().unwrap();
        map.get_mut(session_id)
            .and_then(|s| s.finish_assistant(block_id, text.clone()))
    };
    if let Some(buf_block) = &block {
        env.append_transcript(session_id, buf_block); // durable-sessions FR-2
    }
    env.emit_session(SessionEvent::AssistantDone {
        session_id: session_id.into(),
        block_id: block_id.to_string(),
        text,
    });
}

/// tool: finalize input (accumulated json overrides start input), derive
/// summary, emit `tool.start`. `tool_use_id` is the block's accum-slot
/// field, which for a tool block holds the tool_use_id rather than text.
fn finish_tool_block(
    env: &dyn SessionEnv,
    session_id: &str,
    cwd: &str,
    block_id: &str,
    tool_use_id: &str,
    tools: &mut HashMap<String, ToolRec>,
    open_block: &mut Option<(String, BlockKind)>,
) {
    let Some(rec) = tools.get_mut(tool_use_id) else {
        return;
    };
    // async-agents FR-2: the accumulated __acc json becomes the
    // real input; __agentId survives the reparse (Finding 5).
    rec.input = finalize_tool_input(&rec.input);
    let summary = tool_summary(&rec.tool, &rec.input, cwd);
    // async-agents FR-2: the input JSON is complete now — resolve the dispatch
    // kind and its FR-37 name/task (only readable here), and tell the panel.
    let dispatch = if rec.is_task {
        rec.input
            .get("__agentId")
            .and_then(|val| val.as_str())
            .map(|agent_id| {
                let (name, task) = agent_identity(&rec.input);
                (
                    agent_id.to_string(),
                    resolve_background(&rec.input, &rec.tool),
                    name,
                    task,
                )
            })
    } else {
        None
    };
    // The dispatch's own model, which can differ from the session's (None on a
    // plain tool, or when the dispatch inherits).
    let model = if rec.is_task {
        dispatch_model(&rec.input)
    } else {
        None
    };
    let dispatch_emissions = {
        let mut map = env.engine().sessions.lock().unwrap();
        let mut ems = Vec::new();
        if let Some(s) = map.get_mut(session_id) {
            s.buf_tool(
                block_id,
                rec.tool.clone(),
                summary.clone(),
                rec.is_task,
                model.clone(),
            );
            if let Some((agent_id, is_background, name, task)) = &dispatch {
                ems = apply_dispatch_input(s, agent_id, *is_background, name, task);
            }
        }
        ems
    };
    emit_agent_emissions(env, session_id, dispatch_emissions);
    // workflow-panel FR-4: the script (and so its `export const meta` block) is
    // only complete now — read the run's real name, description, and phases off it.
    if rec.is_workflow {
        if let Some(run_uuid) = rec.input.get("__workflowId").and_then(|v| v.as_str()) {
            let (run_uuid, input) = (run_uuid.to_string(), rec.input.clone());
            on_workflow_input_complete(env, session_id, &run_uuid, &input);
        }
    }
    *open_block = Some((block_id.to_string(), BlockKind::Tool));
    env.emit_session(SessionEvent::ToolStart {
        session_id: session_id.into(),
        block_id: block_id.to_string(),
        tool: rec.tool.clone(),
        summary,
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
        start_text_block(0, &mut blocks, &mut text_accum);
        let (block_id, kind, slot) = blocks.get(&0).cloned().expect("block inserted");
        assert_eq!(kind, BlockKind::Text);
        assert_eq!(slot, "");
        assert_eq!(text_accum.get(&block_id), Some(&String::new()));
    }
}
