//! agent-tab — the per-agent transcript behind the dynamic main-pane tab
//! (specs/agent-tab.md §4 FR-1..FR-8).
//!
//! A second, richer projection of the lines async-agents already attributes to a
//! subagent (FR-8 there): where `agents.rs` reduces each one to a 120-char
//! `AgentStep`, this module buffers it as a full `BufBlock` — the same shape the
//! session's own transcript uses, serialized through the same `classify_block` —
//! so the tab body can reuse the SESSION tab's renderer verbatim.
//!
//! Everything here is PURE over `Session` and returns what its caller must emit,
//! per the file-wide rule that no emit happens while `Engine.sessions` is held.

use super::*;
use crate::ipc::ErrorCode;

use crate::ipc::{err, ok, IpcResult};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use tauri::{AppHandle, Emitter, State};

/// FR-5: the transcript is a bounded window; the oldest block is dropped on
/// overflow and counted, so truncation is never silent.
const AGENT_BLOCK_CAP: usize = 400;

/// FR-1: per-block ceiling on assistant text. A subagent that dumps a whole file
/// into one message must not pin it in memory for the session's lifetime.
const AGENT_BLOCK_TEXT_CAP: usize = 8_000;

// ---------- francois:agents:event (agent-tab §5) ----------

#[derive(Serialize, Clone)]
#[serde(tag = "type")]
pub enum AgentEvent {
    #[serde(rename = "agent.block")]
    Block {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "agentId")]
        agent_id: String,
        block: Value,
    },
}

pub fn emit_agent_event(app: &AppHandle, ev: AgentEvent) {
    let _ = app.emit(AGENT_EVENT_CHANNEL, ev);
}

// ---------- francois:agents:transcript (agent-tab §5) ----------

#[derive(Serialize, Clone, PartialEq, Debug)]
pub struct AgentTranscript {
    blocks: Vec<Value>,
    dropped: u32,
}

/// §5 `francois:agents:transcript`: the agent's windowed blocks + the eviction
/// count. None ⇔ the agentId matches no agent in ANY session (AGENT_NOT_FOUND),
/// the same rule as `activity_of`.
pub fn transcript_of(map: &HashMap<String, Session>, agent_id: &str) -> Option<AgentTranscript> {
    map.values()
        .find(|s| s.agents.contains_key(agent_id))
        .map(|s| AgentTranscript {
            blocks: s
                .agent_blocks
                .get(agent_id)
                .map(|d| d.iter().map(classify_block).collect())
                .unwrap_or_default(),
            dropped: s.agent_blocks_dropped.get(agent_id).copied().unwrap_or(0),
        })
}

// ---------- appending (FR-1..FR-5) ----------

/// A freshly appended block: its id (so a `tool_use` can be filled later by its
/// `tool_result`) and the emission its caller owes the frontend.
pub struct NewAgentBlock {
    pub(crate) block_id: String,
    pub(crate) emission: AgentEmission,
}

/// FR-1/FR-5: append one block to an agent's transcript. Mints the `blockId`,
/// evicts past the window (counting the eviction) and returns the emission. An
/// unknown agent is a no-op, mirroring `push_step`.
fn push_block(s: &mut Session, agent_id: &str, mut block: BufBlock) -> Option<NewAgentBlock> {
    if !s.agents.contains_key(agent_id) {
        return None;
    }
    let n = {
        let n = s.agent_block_seq.entry(agent_id.to_string()).or_insert(0);
        *n += 1;
        *n
    };
    let block_id = format!("{agent_id}:{n}");
    block.block_id = block_id.clone();
    let buf = s.agent_blocks.entry(agent_id.to_string()).or_default();
    buf.push_back(block);
    let mut evicted = 0u32;
    while buf.len() > AGENT_BLOCK_CAP {
        buf.pop_front();
        evicted += 1;
    }
    if evicted > 0 {
        *s.agent_blocks_dropped
            .entry(agent_id.to_string())
            .or_insert(0) += evicted;
    }
    let block = classify_block(s.agent_blocks.get(agent_id)?.back()?);
    Some(NewAgentBlock {
        block_id,
        emission: AgentEmission::Block {
            agent_id: agent_id.to_string(),
            block,
        },
    })
}

fn buf_block(
    kind: BlockKind,
    text: String,
    tool: String,
    summary: String,
    streaming: bool,
) -> BufBlock {
    BufBlock {
        block_id: String::new(), // minted by push_block
        kind,
        text,
        tool,
        summary,
        meta: None,
        card: None,
        streaming,
        // design 9a: an agent tab's blocks are timed the same as a session's —
        // the tab renders the same turn header, so the clock has to be real.
        at: now_ms(),
        // command-inspect FR-8: an agent tab's transcript is in-memory-only
        // and never captures — always false, never set anywhere else here.
        has_detail: false,
    }
}

/// Char-capped, NEWLINES PRESERVED — unlike `tools::truncate`, which collapses
/// them because it builds one-line labels. The tab renders markdown, so a
/// collapsed body would lose every list, heading and code fence.
fn cap_chars(s: &str, n: usize) -> String {
    if s.chars().count() > n {
        s.chars().take(n).collect()
    } else {
        s.to_string()
    }
}

/// FR-1: the subagent said something — the FULL text (capped), not the step's
/// 120-char first line. Blank after trimming ⇒ no block, matching FR-9 there.
pub fn push_agent_text(s: &mut Session, agent_id: &str, text: &str) -> Option<NewAgentBlock> {
    let text = cap_chars(text.trim(), AGENT_BLOCK_TEXT_CAP);
    if text.is_empty() {
        return None;
    }
    push_block(
        s,
        agent_id,
        buf_block(
            BlockKind::Assistant,
            text,
            String::new(),
            String::new(),
            false,
        ),
    )
}

/// FR-1/FR-3: the subagent called a tool. Classified exactly as the parent
/// transcript classifies a top-level tool.start, and left `isStreaming: true`
/// until its `tool_result` fills the meta (FR-2).
/// `model` names the one a NESTED dispatch asked for, and rides the block's
/// `text` exactly as it does in the parent transcript (BufBlock field reuse).
pub fn push_agent_tool(
    s: &mut Session,
    agent_id: &str,
    tool: &str,
    summary: &str,
    model: Option<String>,
) -> Option<NewAgentBlock> {
    let is_dispatch = is_subagent_tool(tool);
    let kind = if is_dispatch {
        BlockKind::Subagent
    } else {
        BlockKind::Tool
    };
    push_block(
        s,
        agent_id,
        buf_block(
            kind,
            if is_dispatch {
                model.unwrap_or_default()
            } else {
                String::new()
            },
            tool.to_string(),
            summary.to_string(),
            true,
        ),
    )
}

/// FR-4: the block-level twin of a `notice` step. Minted from `push_step` so the
/// two can never drift.
pub fn push_agent_notice(s: &mut Session, agent_id: &str, label: &str) -> Option<NewAgentBlock> {
    if label.is_empty() {
        return None;
    }
    push_block(
        s,
        agent_id,
        buf_block(
            BlockKind::Notice,
            label.to_string(),
            String::new(),
            String::new(),
            false,
        ),
    )
}

/// FR-2/FR-3: a `tool_result` closes its block — fill `meta`, stop streaming and
/// re-emit the SAME blockId. A block already evicted past the window (FR-5) is a
/// no-op, exactly like `fill_step_meta` past the trail window.
pub fn fill_agent_block_meta(
    s: &mut Session,
    agent_id: &str,
    block_id: &str,
    meta: &str,
) -> Option<AgentEmission> {
    let buf = s.agent_blocks.get_mut(agent_id)?;
    let block = buf.iter_mut().find(|b| b.block_id == block_id)?;
    block.meta = Some(meta.to_string());
    block.streaming = false;
    Some(AgentEmission::Block {
        agent_id: agent_id.to_string(),
        block: classify_block(block),
    })
}

// ---------- command ----------

/// `francois:agents:transcript` (agent-tab §5) — the agent's bounded transcript.
/// AGENT_NOT_FOUND when the id is unknown everywhere, like `agents_activity`.
#[tauri::command(async)]
pub fn agents_transcript(
    engine: State<'_, Engine>,
    agent_id: String,
) -> IpcResult<AgentTranscript> {
    let map = engine.sessions.lock().unwrap_or_else(|p| p.into_inner());
    match transcript_of(&map, &agent_id) {
        Some(t) => ok(t),
        None => err(ErrorCode::AgentNotFound, "no such agent"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::testutil::*;
    use serde_json::json;

    fn blocks_of(s: &Session, agent_id: &str) -> Vec<Value> {
        s.agent_blocks
            .get(agent_id)
            .map(|d| d.iter().map(classify_block).collect())
            .unwrap_or_default()
    }

    fn emitted_block(e: &AgentEmission) -> Value {
        match e {
            AgentEmission::Block { block, .. } => block.clone(),
            _ => panic!("not a Block emission"),
        }
    }

    #[test]
    fn text_block_keeps_the_full_text_unlike_the_step_label() {
        // FR-1: the whole point of the feature — the step is a 120-char first
        // line, the block is everything.
        let mut s = test_session();
        mint_agent(&mut s, "a1", "explorer", "toolu_d", true);
        let long = format!("first line\n{}", "x".repeat(300));
        let nb = push_agent_text(&mut s, "a1", &long).expect("block");
        assert_eq!(nb.block_id, "a1:1");
        let b = emitted_block(&nb.emission);
        assert_eq!(b["kind"], "assistant");
        assert_eq!(b["isStreaming"], false);
        assert_eq!(b["text"].as_str().unwrap(), long.trim());
    }

    #[test]
    fn text_block_is_capped_and_blank_text_makes_none() {
        let mut s = test_session();
        mint_agent(&mut s, "a1", "explorer", "toolu_d", true);
        assert!(push_agent_text(&mut s, "a1", "   \n  ").is_none());
        let nb = push_agent_text(&mut s, "a1", &"y".repeat(AGENT_BLOCK_TEXT_CAP + 500)).unwrap();
        let b = emitted_block(&nb.emission);
        assert_eq!(
            b["text"].as_str().unwrap().chars().count(),
            AGENT_BLOCK_TEXT_CAP
        );
        // An unknown agent never buffers anything.
        assert!(push_agent_text(&mut s, "nope", "hello").is_none());
    }

    #[test]
    fn tool_block_streams_until_its_result_fills_the_meta() {
        // FR-2/FR-3: fill in place, same blockId, no append.
        let mut s = test_session();
        mint_agent(&mut s, "a1", "explorer", "toolu_d", true);
        let nb = push_agent_tool(&mut s, "a1", "Read", "src/session.rs", None).unwrap();
        let open = emitted_block(&nb.emission);
        assert_eq!(open["kind"], "tool");
        assert_eq!(open["tool"], "Read");
        assert_eq!(open["summary"], "src/session.rs");
        assert_eq!(open["isStreaming"], true);
        assert!(open.get("meta").is_none());

        let em = fill_agent_block_meta(&mut s, "a1", &nb.block_id, "120 lines").unwrap();
        let filled = emitted_block(&em);
        assert_eq!(filled["blockId"], json!(nb.block_id));
        assert_eq!(filled["isStreaming"], false);
        assert_eq!(filled["meta"], "120 lines");
        assert_eq!(blocks_of(&s, "a1").len(), 1); // filled, not appended
                                                  // An unknown blockId (evicted, or never minted) is a no-op.
        assert!(fill_agent_block_meta(&mut s, "a1", "a1:99", "x").is_none());
    }

    #[test]
    fn a_nested_dispatch_becomes_a_subagent_block() {
        // FR-1: one level deep — the nested Agent tool_use is a block in the
        // PARENT agent's transcript, never an agent of its own.
        let mut s = test_session();
        mint_agent(&mut s, "a1", "explorer", "toolu_d", true);
        let nb = push_agent_tool(&mut s, "a1", "Agent", "reviewer", None).unwrap();
        let b = emitted_block(&nb.emission);
        assert_eq!(b["kind"], "subagent");
        assert_eq!(b["agentName"], "reviewer");
        assert!(b.get("agentModel").is_none()); // inherited ⇒ the banner says nothing

        // …and a nested dispatch that NAMES a model carries it, exactly as the
        // parent transcript's banner does.
        let nb = push_agent_tool(&mut s, "a1", "Agent", "reviewer", Some("opus".into())).unwrap();
        assert_eq!(emitted_block(&nb.emission)["agentModel"], "opus");
    }

    #[test]
    fn notice_block_carries_the_label_and_never_streams() {
        let mut s = test_session();
        mint_agent(&mut s, "a1", "explorer", "toolu_d", true);
        let nb = push_agent_notice(&mut s, "a1", "ended with the turn").unwrap();
        assert_eq!(
            emitted_block(&nb.emission),
            json!({
                "kind": "notice", "blockId": "a1:1", "isStreaming": false,
                "text": "ended with the turn",
            })
        );
        assert!(push_agent_notice(&mut s, "a1", "").is_none());
    }

    #[test]
    fn transcript_windows_at_the_cap_and_counts_the_drops() {
        // FR-5 + §7: 450 blocks in ⇒ 400 out, starting at ordinal 51, dropped 50.
        let mut s = test_session();
        mint_agent(&mut s, "a1", "explorer", "toolu_d", true);
        for i in 0..(AGENT_BLOCK_CAP + 50) {
            push_agent_text(&mut s, "a1", &format!("line {i}")).unwrap();
        }
        let mut map = HashMap::new();
        map.insert(s.id.clone(), s);
        let t = transcript_of(&map, "a1").expect("found");
        assert_eq!(t.blocks.len(), AGENT_BLOCK_CAP);
        assert_eq!(t.dropped, 50);
        assert_eq!(t.blocks[0]["blockId"], "a1:51");
        assert_eq!(t.blocks[0]["text"], "line 50");
        assert_eq!(t.blocks[AGENT_BLOCK_CAP - 1]["blockId"], "a1:450");
    }

    #[test]
    fn transcript_of_unknown_agent_is_none() {
        // §5: AGENT_NOT_FOUND, the same rule as agents_activity.
        let mut s = test_session();
        mint_agent(&mut s, "a1", "explorer", "toolu_d", true);
        let mut map = HashMap::new();
        map.insert(s.id.clone(), s);
        assert!(transcript_of(&map, "nope").is_none());
        // A known agent with no activity yet is an EMPTY transcript, not an error.
        assert_eq!(
            transcript_of(&map, "a1"),
            Some(AgentTranscript {
                blocks: Vec::new(),
                dropped: 0
            })
        );
    }

    #[test]
    fn agent_block_event_serializes_to_the_contract_shape() {
        // §5: the AgentEvent wire shape the frontend listens for.
        let ev = AgentEvent::Block {
            session_id: "s1".into(),
            agent_id: "a1".into(),
            block: json!({ "kind": "notice", "blockId": "a1:1", "isStreaming": false, "text": "n" }),
        };
        assert_eq!(
            serde_json::to_value(&ev).unwrap(),
            json!({
                "type": "agent.block", "sessionId": "s1", "agentId": "a1",
                "block": { "kind": "notice", "blockId": "a1:1", "isStreaming": false, "text": "n" },
            })
        );
    }
}
