//! ConversationBlock serialization for the in-memory transcript buffer.

use super::*;

use serde_json::Value;

pub(crate) fn tool_glyph(tool: &str) -> (&'static str, &'static str) {
    match tool {
        "Read" => ("\u{29C9}", "#8b93a3"),
        "Grep" | "Search" => ("\u{2315}", "#8b93a3"),
        "Edit" | "Write" => ("\u{270E}", "#8fbab8"),
        _ => ("\u{25CF}", "#8b93a3"),
    }
}

/// design 9a: stamp `at` onto a serialized block, or leave the key out when the
/// buffer has no time for it (a line persisted before the field existed). The
/// contract types it optional for exactly that case — an absent key is what
/// tells the turn header to render without a clock, and `0` would not.
fn with_at(mut o: Value, b: &BufBlock) -> Value {
    if b.at != 0 {
        o["at"] = Value::from(b.at);
    }
    o
}

/// Serialize a buffered block to the ConversationBlock JSON shape (§5 of
/// conversation-view). Mirrors classifyToolStart in the TS contract.
pub(crate) fn classify_block(b: &BufBlock) -> Value {
    match b.kind {
        BlockKind::User => with_at(
            serde_json::json!({
                "kind": "user", "blockId": b.block_id, "isStreaming": b.streaming,
                "text": b.text, "queued": false,
            }),
            b,
        ),
        BlockKind::Assistant => {
            let (gc, bc) = if b.streaming {
                ("#c3f53f", "#e6e9ef")
            } else {
                ("#8b93a3", "#c3c9d4")
            };
            with_at(
                serde_json::json!({
                    "kind": "assistant", "blockId": b.block_id, "isStreaming": b.streaming,
                    "glyph": "\u{25CF}", "glyphColor": gc, "bodyColor": bc, "text": b.text,
                }),
                b,
            )
        }
        BlockKind::Tool => {
            let (glyph, gc) = tool_glyph(&b.tool);
            let mut o = serde_json::json!({
                "kind": "tool", "blockId": b.block_id, "isStreaming": b.streaming,
                "tool": b.tool, "glyph": glyph, "glyphColor": gc, "bodyColor": "#8b93a3",
                "summary": b.summary,
            });
            if let Some(m) = &b.meta {
                o["meta"] = Value::String(m.clone());
            }
            with_at(o, b)
        }
        BlockKind::Subagent => {
            let mut o = serde_json::json!({
                "kind": "subagent", "blockId": b.block_id, "isStreaming": b.streaming,
                "glyph": "\u{21C9}", "glyphColor": "#b39ede", "bodyColor": "#c3c9d4",
                "agentName": b.summary,
            });
            // The model the dispatch named (BufBlock field reuse). Key omitted
            // when it inherits the session's — never an empty string.
            if !b.text.is_empty() {
                o["agentModel"] = Value::String(b.text.clone());
            }
            if let Some(m) = &b.meta {
                o["meta"] = Value::String(m.clone());
            }
            with_at(o, b)
        }
        BlockKind::Notice => serde_json::json!({
            // agent-tab FR-4: AgentNoticeBlock — appended already final, so it
            // never streams and carries no glyph/color (the tab owns those).
            "kind": "notice", "blockId": b.block_id, "isStreaming": false,
            "text": b.text,
        }),
        BlockKind::Command => {
            // CommandConversationBlock (contract/interactive-commands.ts): `card` absent while pending.
            let mut o = serde_json::json!({
                "kind": "command", "blockId": b.block_id, "isStreaming": b.streaming,
                "command": b.tool,
            });
            if let Some(c) = &b.card {
                o["card"] = c.clone();
            }
            o
        }
        BlockKind::Question => {
            // QuestionConversationBlock (contract/session-questions.ts): isStreaming
            // ⇔ pending (FR-15); `answers` present iff answered, never null.
            let card = b.card.clone().unwrap_or_else(|| serde_json::json!({}));
            let mut o = serde_json::json!({
                "kind": "question", "blockId": b.block_id, "isStreaming": b.streaming,
                "questions": card.get("questions").cloned().unwrap_or_else(|| Value::Array(Vec::new())),
                "state": card.get("state").cloned().unwrap_or_else(|| Value::String("pending".into())),
            });
            if let Some(a) = card.get("answers") {
                o["answers"] = a.clone();
            }
            o
        }
        BlockKind::Permission => {
            // PermissionConversationBlock (contract/permission-guardrails.ts):
            // isStreaming ⇔ pending (FR-25); `rule` present iff one was written.
            let card = b.card.clone().unwrap_or_else(|| serde_json::json!({}));
            let mut o = serde_json::json!({
                "kind": "permission", "blockId": b.block_id, "isStreaming": b.streaming,
                "ask": card.get("ask").cloned().unwrap_or_else(|| serde_json::json!({})),
                "state": card.get("state").cloned().unwrap_or_else(|| Value::String("pending".into())),
            });
            if let Some(r) = card.get("rule") {
                o["rule"] = r.clone();
            }
            o
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::testutil::*;
    use serde_json::json;

    #[test]
    fn classify_block_maps_pending_and_finalized_command() {
        let mut s = test_session();
        s.buf_command_pending("c1", "usage");
        let pending = classify_block(&s.block_buffer[0]);
        assert_eq!(
            pending,
            json!({ "kind": "command", "blockId": "c1", "isStreaming": true, "command": "usage" })
        );

        s.buf_command_output("c1", "usage", json!({ "kind": "notice", "text": "n" }));
        assert_eq!(s.block_buffer.len(), 1); // upsert, not append (FR-20 semantics)
        let done = classify_block(&s.block_buffer[0]);
        assert_eq!(
            done,
            json!({ "kind": "command", "blockId": "c1", "isStreaming": false, "command": "usage",
            "card": { "kind": "notice", "text": "n" } })
        );
    }

    // design-refresh FR-11: Rust mirror of the contract's assistantColors /
    // classifyToolStart glyph-color map (contract/conversation-view.ts §5).
    #[test]
    fn tool_glyph_uses_new_palette() {
        assert_eq!(tool_glyph("Read"), ("\u{29C9}", "#8b93a3"));
        assert_eq!(tool_glyph("Grep"), ("\u{2315}", "#8b93a3"));
        assert_eq!(tool_glyph("Search"), ("\u{2315}", "#8b93a3"));
        assert_eq!(tool_glyph("Edit"), ("\u{270E}", "#8fbab8"));
        assert_eq!(tool_glyph("Write"), ("\u{270E}", "#8fbab8"));
        assert_eq!(tool_glyph("Bash"), ("\u{25CF}", "#8b93a3"));
    }

    #[test]
    fn classify_block_assistant_uses_new_palette() {
        let mut s = test_session();
        s.buf_assistant("a1", "hi".into());
        s.block_buffer[0].streaming = true;
        let streaming = classify_block(&s.block_buffer[0]);
        assert_eq!(streaming["glyphColor"], "#c3f53f");
        assert_eq!(streaming["bodyColor"], "#e6e9ef");

        s.block_buffer[0].streaming = false;
        let settled = classify_block(&s.block_buffer[0]);
        assert_eq!(settled["glyphColor"], "#8b93a3");
        assert_eq!(settled["bodyColor"], "#c3c9d4");
    }

    #[test]
    fn streaming_assistant_block_is_in_the_buffer_from_its_first_delta() {
        // What `getTranscript` returns mid-block. Before this, the block only
        // joined the buffer at content_block_stop, so a view hydrating mid-answer
        // seeded a transcript without it and rendered the answer minus its opening.
        let mut s = test_session();
        s.buf_assistant_streaming("a1", "Hel");
        assert_eq!(s.block_buffer.len(), 1);
        let partial = classify_block(&s.block_buffer[0]);
        assert_eq!(partial["kind"], "assistant");
        assert_eq!(partial["text"], "Hel");
        assert_eq!(partial["isStreaming"], true);

        // Later deltas replace the text in place — one block, never a run of them.
        s.buf_assistant_streaming("a1", "Hello");
        assert_eq!(s.block_buffer.len(), 1);
        assert_eq!(classify_block(&s.block_buffer[0])["text"], "Hello");
    }

    #[test]
    fn finish_assistant_settles_the_streaming_block_in_place() {
        let mut s = test_session();
        s.buf_assistant_streaming("a1", "Hel");
        let finished = s.finish_assistant("a1", "Hello".into()).expect("block");
        assert_eq!(finished.text, "Hello");
        assert_eq!(s.block_buffer.len(), 1, "settled in place, never appended");
        let block = classify_block(&s.block_buffer[0]);
        assert_eq!(block["text"], "Hello");
        assert_eq!(block["isStreaming"], false);
    }

    #[test]
    fn finish_assistant_appends_when_no_delta_ever_opened_the_block() {
        let mut s = test_session();
        let finished = s.finish_assistant("a1", "Hello".into()).expect("block");
        assert_eq!(finished.block_id, "a1");
        assert_eq!(s.block_buffer.len(), 1);
        assert_eq!(classify_block(&s.block_buffer[0])["text"], "Hello");
    }

    #[test]
    fn finish_assistant_settles_its_own_block_among_others() {
        // A tool block can land between a text block's deltas and its stop; the
        // finish must find the right block rather than the newest one.
        let mut s = test_session();
        s.buf_assistant_streaming("a1", "Hel");
        s.buf_tool("t1", "Read".into(), "file.rs".into(), false, None);
        s.finish_assistant("a1", "Hello".into()).expect("block");
        assert_eq!(s.block_buffer.len(), 2);
        assert_eq!(classify_block(&s.block_buffer[0])["text"], "Hello");
        assert_eq!(classify_block(&s.block_buffer[1])["kind"], "tool");
    }

    #[test]
    fn classify_block_tool_body_color_uses_new_palette() {
        let mut s = test_session();
        s.buf_tool("t1", "Read".into(), "file.rs".into(), false, None);
        let block = classify_block(&s.block_buffer[0]);
        assert_eq!(block["bodyColor"], "#8b93a3");
    }

    #[test]
    fn classify_block_subagent_uses_new_palette() {
        let mut s = test_session();
        s.buf_tool("s1", "Task".into(), "reviewer".into(), true, None);
        let block = classify_block(&s.block_buffer[0]);
        assert_eq!(block["kind"], "subagent");
        assert_eq!(block["glyphColor"], "#b39ede");
        assert_eq!(block["bodyColor"], "#c3c9d4");
    }

    #[test]
    fn classify_block_subagent_carries_a_named_model_only() {
        // The banner names the dispatch's model because it can differ from the
        // session's — and stays silent when the dispatch named none, rather
        // than restating what the session already shows.
        let mut s = test_session();
        s.buf_tool("s1", "Agent".into(), "reviewer".into(), true, None);
        assert!(classify_block(&s.block_buffer[0])
            .get("agentModel")
            .is_none());

        s.buf_tool(
            "s2",
            "Agent".into(),
            "reviewer".into(),
            true,
            Some("haiku".into()),
        );
        assert_eq!(classify_block(&s.block_buffer[1])["agentModel"], "haiku");

        // A plain tool never grows the field, whatever it was handed.
        s.buf_tool(
            "t1",
            "Read".into(),
            "a.rs".into(),
            false,
            Some("opus".into()),
        );
        let tool = classify_block(&s.block_buffer[2]);
        assert_eq!(tool["kind"], "tool");
        assert!(tool.get("agentModel").is_none());
    }
}
