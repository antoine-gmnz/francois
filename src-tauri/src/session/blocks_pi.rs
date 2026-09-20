//! session/blocks_pi.rs — pi-transcript-events FR-2..FR-9: the four
//! `block_buffer` mutations a normalized Pi transcript event performs, split
//! out of `session/mod.rs` (which is over the 1000-line cap) per PIPELINE.md's
//! "each child owns one concern" rule. `runtime.rs`'s transcript arms are the
//! only callers.
//!
//! All four hand their block back to the caller, and all four take that clone
//! BEFORE `trim_block_buffer` runs: settling a block is exactly what unpins
//! the trim, so the trim in the same call can evict the very block just
//! settled. Re-finding it by id afterwards loses it (review round 7's HIGH,
//! the same regression `buf_tool_done` carries its own test for).

use super::*;

impl Session {
    /// FR-6/FR-7: append a normalized Pi user block, with resolved attachment
    /// refs riding alongside (never base64) — present only when non-empty,
    /// matching every other optional `BufBlock` field's omit-when-absent
    /// convention (see `classify_block_user_attachments_present_only_when_set`).
    /// Returns the appended block, captured BEFORE the trim, so the caller
    /// persists what it buffered instead of re-finding it by id afterwards
    /// (see `buf_tool_update_pi`'s own note on why the re-find loses blocks).
    pub(super) fn buf_message_user_pi(
        &mut self,
        block_id: &str,
        text: String,
        attachments: Vec<events::RuntimeAttachmentRef>,
    ) -> BufBlock {
        let attachments = (!attachments.is_empty()).then(|| {
            serde_json::to_value(&attachments).unwrap_or_else(|_| Value::Array(Vec::new()))
        });
        self.block_buffer.push(BufBlock {
            text,
            attachments,
            ..BufBlock::new(block_id, BlockKind::User)
        });
        let appended = self
            .block_buffer
            .last()
            .cloned()
            .expect("just pushed above");
        self.trim_block_buffer();
        appended
    }

    /// FR-2/FR-9: settle a normalized Pi assistant content slot in place, or
    /// append one that streamed no prior delta — same upsert `finish_assistant`
    /// performs for every other runtime, plus the `outcome` field. Left absent
    /// for a normal completion (contract note: "absent ⇒ a normal completion"),
    /// set only for `interrupted`/`error`. Returns the finalized block so the
    /// caller persists it exactly once, at settlement.
    pub(super) fn finish_assistant_pi(
        &mut self,
        block_id: &str,
        text: String,
        outcome: &str,
    ) -> Option<BufBlock> {
        let outcome_field = (outcome != "complete").then(|| outcome.to_string());
        let out = match self
            .block_buffer
            .iter_mut()
            .rev()
            .find(|b| b.block_id == block_id)
        {
            Some(b) => {
                b.text = text;
                b.streaming = false;
                b.outcome = outcome_field;
                Some(b.clone())
            }
            None => {
                self.block_buffer.push(BufBlock {
                    text,
                    outcome: outcome_field,
                    ..BufBlock::new(block_id, BlockKind::Assistant)
                });
                self.block_buffer.last().cloned()
            }
        };
        self.trim_block_buffer();
        out
    }

    /// FR-3/FR-4: append (pending) or update (running/settled) a normalized
    /// Pi tool block in place — one row for the whole lifecycle, never a
    /// second one for the same call id (edge cases §7: "do not append a
    /// second tool row"). `execution` carries the whole sanitized snapshot on
    /// every call; only a TERMINAL status (never `pending`/`running`) returns
    /// the block, so a caller persists exactly once, at settlement — mid-
    /// lifecycle rows stay live-only, matching every other runtime's own
    /// `buf_tool`/`buf_tool_done` split.
    pub(super) fn buf_tool_update_pi(
        &mut self,
        block_id: &str,
        tool: events::RuntimeToolCall,
    ) -> Option<BufBlock> {
        let streaming = matches!(tool.status.as_str(), "pending" | "running");
        let name = tool.name.clone();
        // MEDIUM (review round 3): derive a genuinely informative summary
        // from the tool's own input the same way every other adapter does
        // (`grok`/`codex`/`openai`/`stream` all call `tools::tool_summary`),
        // and recompute it on EVERY update — `input_text` starts empty at
        // `toolcall_start`, accumulates through `toolcall_delta`, and becomes
        // authoritative at `toolcall_end`, so the bare tool name from the
        // first insert must not be left standing once real input exists.
        let summary = tool_summary_from_input_text(&name, &tool.input_text, &self.cwd);
        let execution = serde_json::to_value(&tool).ok();
        // HIGH (review round 7): the clone is taken HERE, before the trim —
        // settling this block is exactly what unpins `trim_transcript`, so the
        // trim below can evict the very block this call settled. Re-finding it
        // by id afterwards returned `None` for that case and the settled tool
        // row was never persisted (same regression `buf_tool_done` already
        // carries its own test for).
        let settled = match self
            .block_buffer
            .iter_mut()
            .find(|b| b.block_id == block_id)
        {
            Some(b) => {
                b.tool = name;
                b.summary = summary;
                b.execution = execution;
                b.streaming = streaming;
                (!streaming).then(|| b.clone())
            }
            None => {
                self.block_buffer.push(BufBlock {
                    tool: name,
                    summary,
                    execution,
                    streaming,
                    ..BufBlock::new(block_id, BlockKind::Tool)
                });
                (!streaming)
                    .then(|| self.block_buffer.last().cloned())
                    .flatten()
            }
        };
        self.trim_block_buffer();
        settled
    }

    /// FR-5/FR-8: append a normalized Pi notice — always final, like every
    /// other `NoticeConversationBlock` producer (agent-tab's own notices carry
    /// no `tone`; this one, appended to the SESSION transcript, always does).
    pub(super) fn buf_notice_pi(&mut self, block_id: &str, tone: String, text: String) -> BufBlock {
        self.block_buffer.push(BufBlock {
            text,
            tone: Some(tone),
            ..BufBlock::new(block_id, BlockKind::Notice)
        });
        // Captured before the trim, like every other `buf_*_pi` helper.
        let appended = self
            .block_buffer
            .last()
            .cloned()
            .expect("just pushed above");
        self.trim_block_buffer();
        appended
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::testutil::test_session;

    // ---------- pi-transcript-events: buf_*_pi direct unit coverage ----------

    #[test]
    fn buf_message_user_pi_appends_text_and_omits_attachments_when_none() {
        let mut s = test_session();
        s.buf_message_user_pi("u1", "hi".into(), Vec::new());
        let block = &s.block_buffer[0];
        assert_eq!(block.block_id, "u1");
        assert!(matches!(block.kind, BlockKind::User));
        assert_eq!(block.text, "hi");
        assert!(block.attachments.is_none());
    }

    #[test]
    fn buf_message_user_pi_carries_resolved_attachment_refs() {
        let mut s = test_session();
        let attachments = vec![events::RuntimeAttachmentRef {
            id: "a1".into(),
            name: "cat.png".into(),
            mime_type: "image/png".into(),
            state: "available".into(),
        }];
        s.buf_message_user_pi("u1", "see this".into(), attachments);
        let stored = s.block_buffer[0].attachments.as_ref().unwrap();
        assert_eq!(stored[0]["id"], "a1");
        assert_eq!(stored[0]["state"], "available");
    }

    #[test]
    fn finish_assistant_pi_appends_when_no_delta_ever_opened_the_block() {
        let mut s = test_session();
        let finished = s
            .finish_assistant_pi("a1", "Hello".into(), "complete")
            .expect("block");
        assert_eq!(finished.block_id, "a1");
        assert!(!finished.streaming);
        // A normal completion leaves `outcome` unset (contract note: "absent
        // ⇒ a normal completion").
        assert!(finished.outcome.is_none());
    }

    #[test]
    fn finish_assistant_pi_settles_a_streaming_block_in_place_with_its_outcome() {
        let mut s = test_session();
        s.buf_assistant_streaming("a1", "Hel", "Hel");
        let finished = s
            .finish_assistant_pi("a1", "Hello".into(), "interrupted")
            .expect("block");
        assert_eq!(s.block_buffer.len(), 1);
        assert_eq!(finished.text, "Hello");
        assert!(!finished.streaming);
        assert_eq!(finished.outcome.as_deref(), Some("interrupted"));
    }

    #[test]
    fn buf_notice_pi_appends_an_already_final_block_with_its_tone() {
        let mut s = test_session();
        let notice = s.buf_notice_pi("n1", "warning".into(), "Retrying: rate limited".into());
        assert_eq!(notice.block_id, "n1");
        assert!(matches!(notice.kind, BlockKind::Notice));
        assert!(!notice.streaming);
        assert_eq!(notice.tone.as_deref(), Some("warning"));
        assert_eq!(notice.text, "Retrying: rate limited");
        assert_eq!(s.block_buffer.len(), 1);
    }

    /// Same regression class as `finishing_the_pinning_tool_block_still_
    /// returns_it_for_persistence`, for the Pi helper: a terminal `tool.update`
    /// is exactly what UNPINS the trim, so the trim in that same call can evict
    /// the block being settled. The clone must be captured BEFORE the trim —
    /// re-finding it by id afterwards yields `None` and the settled tool row is
    /// never persisted.
    #[test]
    fn settling_the_pinning_pi_tool_block_still_returns_it_for_persistence() {
        let mut s = test_session();
        let call = |status: &str| events::RuntimeToolCall {
            id: "t1".into(),
            name: "Bash".into(),
            status: status.into(),
            input_text: serde_json::json!({ "command": "ls" }).to_string(),
            output_text: String::new(),
            input_truncated: false,
            output_truncated: false,
            started_at: None,
            completed_at: None,
        };
        assert!(s.buf_tool_update_pi("tool-1", call("running")).is_none());
        for i in 0..(TRANSCRIPT_BUFFER_CAP + 20) {
            s.buf_user(&format!("b{i}"), "hi".into());
        }
        // The running tool call pins eviction at the head.
        assert!(s.block_buffer.len() > TRANSCRIPT_BUFFER_CAP);
        assert_eq!(s.block_buffer[0].block_id, "tool-1");

        let settled = s.buf_tool_update_pi("tool-1", call("succeeded"));
        assert_eq!(
            settled.as_ref().map(|b| b.block_id.as_str()),
            Some("tool-1")
        );
        assert!(!settled.unwrap().streaming);
        // Settling it unpinned the trim, which evicted it in the SAME call.
        assert_eq!(s.block_buffer.len(), TRANSCRIPT_BUFFER_CAP);
        assert!(
            !s.block_buffer.iter().any(|b| b.block_id == "tool-1"),
            "the trim evicted the block this call settled"
        );
    }

    /// The same, for the user block: `buf_message_user_pi` hands its append
    /// back so the caller persists exactly what it buffered, rather than
    /// re-finding it afterwards.
    #[test]
    fn buf_message_user_pi_returns_the_block_it_appended() {
        let mut s = test_session();
        let block = s.buf_message_user_pi("u1", "hi".into(), Vec::new());
        assert_eq!(block.block_id, "u1");
        assert!(matches!(block.kind, BlockKind::User));
    }
}
