//! FR-8: one agent's own conversation, as the `AgentBlock` vocabulary agent-tab
//! already defines — produced by the same classification and serialized through
//! the same `classify_block`, so the tab body reuses the SESSION tab's renderer
//! verbatim.

use super::*;

use std::collections::VecDeque;

// ---------- FR-8: one agent's transcript ----------

/// FR-8: the agent's own conversation as `AgentBlock`s — the agent-tab
/// vocabulary, through the same `classify_block` serializer, so the tab body
/// reuses the SESSION tab's renderer verbatim. A missing file is an EMPTY
/// transcript, never an error (FR-10).
pub fn read_agent_transcript(dir: &Path, agent_id: &str) -> WorkflowAgentTranscript {
    let mut cursor = 0u64;
    let (lines, _) = read_new_lines(&dir.join(format!("agent-{agent_id}.jsonl")), &mut cursor);
    build_agent_blocks(agent_id, &lines)
}

fn build_agent_blocks(agent_id: &str, lines: &[String]) -> WorkflowAgentTranscript {
    let mut buf: VecDeque<BufBlock> = VecDeque::new();
    let mut dropped = 0u32;
    let mut seq = 0u32;
    // tool_use_id → (blockId, tool, input) for the `tool_result` that fills it.
    let mut open: HashMap<String, (String, String, Value)> = HashMap::new();
    for line in lines {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let line_type = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
        let Some(content) = v
            .get("message")
            .and_then(|m| m.get("content"))
            .and_then(|c| c.as_array())
        else {
            continue;
        };
        for item in content {
            match item.get("type").and_then(|t| t.as_str()).unwrap_or("") {
                // the agent said something (its own prompt rides on the row, not here)
                "text" if line_type == "assistant" => {
                    let text = cap_chars(
                        item.get("text")
                            .and_then(|t| t.as_str())
                            .unwrap_or("")
                            .trim(),
                        AGENT_BLOCK_TEXT_CAP,
                    );
                    if text.is_empty() {
                        continue;
                    }
                    seq += 1;
                    let block_id = format!("{agent_id}:{seq}");
                    push_capped(
                        &mut buf,
                        &mut dropped,
                        BufBlock {
                            text,
                            ..BufBlock::new(&block_id, crate::session::BlockKind::Assistant)
                        },
                    );
                }
                "tool_use" => {
                    let tool = item
                        .get("name")
                        .and_then(|n| n.as_str())
                        .unwrap_or("")
                        .to_string();
                    let input = item.get("input").cloned().unwrap_or(Value::Null);
                    let kind = if is_subagent_tool(&tool) {
                        crate::session::BlockKind::Subagent
                    } else {
                        crate::session::BlockKind::Tool
                    };
                    seq += 1;
                    let block_id = format!("{agent_id}:{seq}");
                    push_capped(
                        &mut buf,
                        &mut dropped,
                        BufBlock {
                            tool: tool.clone(),
                            summary: tool_summary(&tool, &input, ""),
                            streaming: true,
                            ..BufBlock::new(&block_id, kind)
                        },
                    );
                    if let Some(id) = item.get("id").and_then(|i| i.as_str()) {
                        open.insert(id.to_string(), (block_id, tool, input));
                    }
                }
                "tool_result" => {
                    let Some(tuid) = item.get("tool_use_id").and_then(|t| t.as_str()) else {
                        continue;
                    };
                    // a block already evicted past the window is a no-op
                    let Some((block_id, tool, input)) = open.remove(tuid) else {
                        continue;
                    };
                    let is_error = item
                        .get("is_error")
                        .and_then(|e| e.as_bool())
                        .unwrap_or(false);
                    let meta = if is_error {
                        "error".to_string()
                    } else {
                        tool_meta(&tool, &input, &extract_result_text(item.get("content")))
                    };
                    if let Some(b) = buf.iter_mut().find(|b| b.block_id == block_id) {
                        b.meta = Some(meta);
                        b.streaming = false;
                    }
                }
                _ => {} // `thinking` and everything else is dropped (FR-8)
            }
        }
    }
    WorkflowAgentTranscript {
        blocks: buf.iter().map(classify_block).collect(),
        dropped,
    }
}

/// FR-8: at most 400 blocks, oldest dropped, and the drop is COUNTED so the
/// truncation is never silent.
fn push_capped(buf: &mut VecDeque<BufBlock>, dropped: &mut u32, block: BufBlock) {
    buf.push_back(block);
    while buf.len() > AGENT_BLOCK_CAP {
        buf.pop_front();
        *dropped += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::testutil::*;
    use super::*;
    use serde_json::json;

    // ---------- FR-8: one agent's transcript ----------

    #[test]
    fn agent_transcript_classifies_text_and_fills_a_tool_block_from_its_result() {
        let d = RunDir::new();
        let lines = format!(
            "{}{}{}{}",
            user_line_at("2026-07-31T10:00:00.000Z", "the prompt"),
            json!({ "type": "assistant", "timestamp": 1, "message": { "content": [
                { "type": "thinking", "thinking": "hmm" },
                { "type": "text", "text": "  reading it  " },
                { "type": "tool_use", "id": "toolu_1", "name": "Read",
                  "input": { "file_path": "/x/a.ts" } }] } })
            .to_string()
                + "\n",
            json!({ "type": "user", "timestamp": 2, "message": { "content": [
                { "type": "tool_result", "tool_use_id": "toolu_1", "content": "l1\nl2\nl3" }] } })
            .to_string()
                + "\n",
            json!({ "type": "assistant", "timestamp": 3, "message": { "content": [
                { "type": "tool_use", "id": "toolu_2", "name": "Agent",
                  "input": { "subagent_type": "reviewer" } }] } })
            .to_string()
                + "\n",
        );
        d.write("agent-a1.jsonl", &lines);
        let t = read_agent_transcript(d.path(), "a1");
        assert_eq!(t.dropped, 0);
        assert_eq!(t.blocks.len(), 3); // thinking dropped, the user prompt is not a block
        assert_eq!(t.blocks[0]["kind"], "assistant");
        assert_eq!(t.blocks[0]["text"], "reading it");
        assert_eq!(t.blocks[1]["kind"], "tool");
        assert_eq!(t.blocks[1]["tool"], "Read");
        assert_eq!(t.blocks[1]["summary"], "/x/a.ts");
        assert_eq!(t.blocks[1]["meta"], "3 lines"); // filled by its tool_result
        assert_eq!(t.blocks[1]["isStreaming"], false);
        assert_eq!(t.blocks[2]["kind"], "subagent");
        assert_eq!(t.blocks[2]["agentName"], "reviewer");
        assert_eq!(t.blocks[2]["isStreaming"], true); // still open
    }

    #[test]
    fn agent_transcript_windows_at_the_cap_and_counts_the_drops() {
        let d = RunDir::new();
        let mut body = String::new();
        for i in 0..(AGENT_BLOCK_CAP + 50) {
            body.push_str(&assistant_line(
                "2026-07-31T10:00:00.000Z",
                &format!("line {i}"),
                0,
                0,
            ));
        }
        d.write("agent-a1.jsonl", &body);
        let t = read_agent_transcript(d.path(), "a1");
        assert_eq!(t.blocks.len(), AGENT_BLOCK_CAP);
        assert_eq!(t.dropped, 50);
        assert_eq!(t.blocks[0]["text"], "line 50");
    }

    #[test]
    fn agent_transcript_caps_block_text_and_survives_a_missing_file() {
        let d = RunDir::new();
        d.write(
            "agent-a1.jsonl",
            &assistant_line(
                "2026-07-31T10:00:00.000Z",
                &"y".repeat(AGENT_BLOCK_TEXT_CAP + 500),
                0,
                0,
            ),
        );
        let t = read_agent_transcript(d.path(), "a1");
        assert_eq!(
            t.blocks[0]["text"].as_str().unwrap().chars().count(),
            AGENT_BLOCK_TEXT_CAP
        );
        // FR-10: an agent minted from the journal alone has no file → empty, not an error
        assert_eq!(
            read_agent_transcript(d.path(), "a9"),
            WorkflowAgentTranscript {
                blocks: Vec::new(),
                dropped: 0
            }
        );
    }
}
