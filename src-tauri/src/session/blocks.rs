//! ConversationBlock serialization for the in-memory transcript buffer.

use super::*;

use serde_json::Value;

pub(crate) fn tool_glyph(tool: &str) -> (&'static str, &'static str) {
    match tool {
        "Read" => ("\u{29C9}", "#868a93"),
        "Grep" | "Search" => ("\u{2315}", "#868a93"),
        "Edit" | "Write" => ("\u{270E}", "#7fa07a"),
        _ => ("\u{25CF}", "#868a93"),
    }
}

/// Serialize a buffered block to the ConversationBlock JSON shape (§5 of
/// conversation-view). Mirrors classifyToolStart in the TS contract.
pub(crate) fn classify_block(b: &BufBlock) -> Value {
    match b.kind {
        BlockKind::User => serde_json::json!({
            "kind": "user", "blockId": b.block_id, "isStreaming": b.streaming,
            "text": b.text, "queued": false,
        }),
        BlockKind::Assistant => {
            let (gc, bc) = if b.streaming {
                ("#c8a15a", "#dfe2e8")
            } else {
                ("#868a93", "#c4c7ce")
            };
            serde_json::json!({
                "kind": "assistant", "blockId": b.block_id, "isStreaming": b.streaming,
                "glyph": "\u{25CF}", "glyphColor": gc, "bodyColor": bc, "text": b.text,
            })
        }
        BlockKind::Tool => {
            let (glyph, gc) = tool_glyph(&b.tool);
            let mut o = serde_json::json!({
                "kind": "tool", "blockId": b.block_id, "isStreaming": b.streaming,
                "tool": b.tool, "glyph": glyph, "glyphColor": gc, "bodyColor": "#868a93",
                "summary": b.summary,
            });
            if let Some(m) = &b.meta {
                o["meta"] = Value::String(m.clone());
            }
            o
        }
        BlockKind::Subagent => {
            let mut o = serde_json::json!({
                "kind": "subagent", "blockId": b.block_id, "isStreaming": b.streaming,
                "glyph": "\u{21C9}", "glyphColor": "#c8a15a", "bodyColor": "#b9bcc4",
                "agentName": b.summary,
            });
            if let Some(m) = &b.meta {
                o["meta"] = Value::String(m.clone());
            }
            o
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
}
