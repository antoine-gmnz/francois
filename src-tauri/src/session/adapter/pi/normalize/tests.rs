// Tests for the Pi transcript reducer — split out of normalize/mod.rs to keep it
// under the ~1000-line cap; included via `#[path]` from there.

use super::testutil::tool_update;
use super::*;
use serde_json::json;

fn only_notice(events: &[RuntimeEventPayload]) -> (&str, &str) {
    match events.first().expect("expected one event") {
        RuntimeEventPayload::Notice { tone, text, .. } => (tone, text),
        _ => panic!("expected a notice"),
    }
}

fn is_failure(events: &[RuntimeEventPayload]) -> bool {
    matches!(events.first(), Some(RuntimeEventPayload::Failure { .. }))
}

// ---------------------------------------------------------- FR-1: mapping table

#[test]
fn agent_and_turn_boundary_events_produce_no_transcript_output() {
    let mut r = TranscriptReducer::new();
    for line in [
        json!({"type":"agent_start"}),
        json!({"type":"agent_end"}),
        json!({"type":"agent_settled"}),
        json!({"type":"turn_end","reason":"done"}),
        json!({"type":"queue_update","queued":1}),
    ] {
        assert!(r.on_event(&line, 0).is_empty());
    }
}

// ---------------------------------------------------------- FR-2: assistant text

#[test]
fn assistant_text_streams_with_a_stable_block_id_and_utf16_offsets() {
    let mut r = TranscriptReducer::new();
    r.on_event(
        &json!({"type":"message_start","role":"assistant","messageId":"m1"}),
        0,
    );
    let first = r.on_event(
        &json!({"type":"content_delta","messageId":"m1","contentIndex":0,
            "delta":{"type":"text","text":"caf\u{e9}"}}), // 'é' = 1 UTF-16 unit
        0,
    );
    let RuntimeEventPayload::AssistantDelta {
        block_id,
        offset,
        text,
        ..
    } = &first[0]
    else {
        panic!("expected an assistant.delta");
    };
    assert_eq!(offset, &0);
    assert_eq!(text, "caf\u{e9}");
    let block_id = block_id.clone();

    // Surrogate-pair content: the offset after "café" (4 UTF-16 units)
    // must be exact, not a byte length.
    let second = r.on_event(
        &json!({"type":"content_delta","messageId":"m1","contentIndex":0,
            "delta":{"type":"text","text":"\u{1f600}"}}), // 😀 = 2 UTF-16 units
        0,
    );
    let RuntimeEventPayload::AssistantDelta {
        block_id: b2,
        offset,
        ..
    } = &second[0]
    else {
        panic!("expected an assistant.delta");
    };
    assert_eq!(b2, &block_id, "same content slot ⇒ same stable blockId");
    assert_eq!(*offset, 4);

    let end = r.on_event(
        &json!({"type":"text_end","messageId":"m1","contentIndex":0}),
        0,
    );
    assert_eq!(
        end,
        vec![RuntimeEventPayload::AssistantComplete {
            block_id,
            text: "caf\u{e9}\u{1f600}".into(),
            outcome: "complete".into(),
        }]
    );
}

#[test]
fn multiple_content_slots_on_one_message_each_get_their_own_block_id() {
    let mut r = TranscriptReducer::new();
    let a = r.on_event(
        &json!({"type":"content_delta","messageId":"m1","contentIndex":0,
            "delta":{"type":"text","text":"first"}}),
        0,
    );
    let b = r.on_event(
        &json!({"type":"content_delta","messageId":"m1","contentIndex":1,
            "delta":{"type":"text","text":"second"}}),
        0,
    );
    let (
        RuntimeEventPayload::AssistantDelta { block_id: id_a, .. },
        RuntimeEventPayload::AssistantDelta { block_id: id_b, .. },
    ) = (&a[0], &b[0])
    else {
        panic!("expected assistant.delta events");
    };
    assert_ne!(id_a, id_b);
}

#[test]
fn a_final_message_authoritatively_replaces_accumulated_content_and_upserts_on_replay() {
    let mut r = TranscriptReducer::new();
    r.on_event(
        &json!({"type":"content_delta","messageId":"m1","contentIndex":0,
            "delta":{"type":"text","text":"Hel"}}),
        0,
    );
    let end = r.on_event(
        &json!({"type":"message_end","messageId":"m1","role":"assistant",
            "content":[{"type":"text","text":"Hello"}]}),
        10,
    );
    assert_eq!(
        end,
        vec![RuntimeEventPayload::AssistantComplete {
            block_id: r.messages["m1"].slots[&0].block_id.clone(),
            text: "Hello".into(),
            outcome: "complete".into(),
        }]
    );

    // Edge cases §7: "Duplicate final output: upsert" — a replayed
    // message_end (say, after a reconnect) re-applies the same content
    // rather than being dropped or duplicating the block.
    let replay = r.on_event(
        &json!({"type":"message_end","messageId":"m1","role":"assistant",
            "content":[{"type":"text","text":"Hello"}]}),
        20,
    );
    assert_eq!(replay.len(), 1);
    assert!(matches!(
        &replay[0],
        RuntimeEventPayload::AssistantComplete { .. }
    ));
}

#[test]
fn a_fast_message_with_no_prior_deltas_still_finalizes_from_message_end() {
    let mut r = TranscriptReducer::new();
    let end = r.on_event(
        &json!({"type":"message_end","messageId":"m1","role":"assistant",
            "content":[{"type":"text","text":"instant"}], "outcome":"complete"}),
        0,
    );
    assert_eq!(end.len(), 1);
    match &end[0] {
        RuntimeEventPayload::AssistantComplete { text, outcome, .. } => {
            assert_eq!(text, "instant");
            assert_eq!(outcome, "complete");
        }
        _ => panic!("expected assistant.complete"),
    }
}

#[test]
fn a_late_delta_after_text_end_never_reopens_the_finalized_block() {
    // HIGH (review round 2): text_end already finalized this slot — a
    // late/duplicate delta must not reopen it with no matching
    // assistant.complete to follow.
    let mut r = TranscriptReducer::new();
    r.on_event(
        &json!({"type":"content_delta","messageId":"m1","contentIndex":0,
            "delta":{"type":"text","text":"Hel"}}),
        0,
    );
    r.on_event(
        &json!({"type":"text_end","messageId":"m1","contentIndex":0}),
        0,
    );
    let late = r.on_event(
        &json!({"type":"content_delta","messageId":"m1","contentIndex":0,
            "delta":{"type":"text","text":"lo"}}),
        0,
    );
    assert!(late.is_empty());
    assert_eq!(r.messages["m1"].slots[&0].text, "Hel");
}

#[test]
fn a_late_delta_after_message_end_never_reopens_the_finalized_message() {
    // HIGH (review round 2): message_end already finalized the whole
    // message — a late delta on a BRAND NEW content index must not
    // reopen it either.
    let mut r = TranscriptReducer::new();
    r.on_event(
        &json!({"type":"message_end","messageId":"m1","role":"assistant",
            "content":[{"type":"text","text":"done"}]}),
        0,
    );
    let late = r.on_event(
        &json!({"type":"content_delta","messageId":"m1","contentIndex":1,
            "delta":{"type":"text","text":"more"}}),
        0,
    );
    assert!(late.is_empty());
    assert!(!r.messages["m1"].slots.contains_key(&1));
}

#[test]
fn late_thinking_and_signature_deltas_after_message_end_emit_nothing() {
    for delta_kind in ["thinking", "signature"] {
        let mut r = TranscriptReducer::new();
        r.on_event(
            &json!({"type":"message_end","messageId":"m1","role":"assistant",
                "content":[{"type":"text","text":"done"}]}),
            0,
        );

        let late = r.on_event(
            &json!({"type":"content_delta","messageId":"m1","contentIndex":1,
                "delta":{"type":delta_kind,"text":"private"}}),
            0,
        );

        assert!(late.is_empty(), "late {delta_kind} delta must be ignored");
        assert!(!r.messages["m1"].slots.contains_key(&1));
    }
}

#[test]
fn a_content_index_past_u32_max_is_a_protocol_error_not_a_silent_truncation() {
    // LOW (review round 2): `contentIndex as u32` used to wrap silently
    // into whatever slot the truncated value collided with.
    let mut r = TranscriptReducer::new();
    let out = r.on_event(
        &json!({"type":"content_delta","messageId":"m1",
            "contentIndex": (u32::MAX as u64) + 1,
            "delta":{"type":"text","text":"x"}}),
        0,
    );
    assert!(is_failure(&out));
}

// ---------------------------------------------------------- FR-5: thinking/signature

#[test]
fn thinking_and_signature_content_become_a_neutral_notice_once_per_slot_not_prose() {
    let mut r = TranscriptReducer::new();
    let first = r.on_event(
        &json!({"type":"content_delta","messageId":"m1","contentIndex":0,
            "delta":{"type":"thinking","text":"reasoning…"}}),
        0,
    );
    let (tone, _) = only_notice(&first);
    assert_eq!(tone, "info");
    // A second thinking delta on the SAME slot notifies nothing further.
    let second = r.on_event(
        &json!({"type":"content_delta","messageId":"m1","contentIndex":0,
            "delta":{"type":"thinking","text":"more…"}}),
        0,
    );
    assert!(second.is_empty());
    // Never concatenated into assistant text.
    assert!(r.messages["m1"].slots[&0].text.is_empty());
}

// ---------------------------------------------------------- FR-7: attachments

#[test]
fn a_user_message_carries_resolved_attachment_refs_never_base64() {
    let mut r = TranscriptReducer::new();
    let events = r.on_event(
        &json!({"type":"message_start","role":"user","messageId":"m1","text":"see this",
            "attachments":[
                {"id":"a1","name":"cat.png","mimeType":"image/png"},
                {"id":"a2","name":"gone.png","mimeType":"image/png","state":"missing"}
            ], "clientMessageId":"c1"}),
        0,
    );
    let RuntimeEventPayload::MessageUser {
        text,
        attachments,
        client_message_id,
        ..
    } = &events[0]
    else {
        panic!("expected message.user");
    };
    assert_eq!(text, "see this");
    assert_eq!(client_message_id.as_deref(), Some("c1"));
    assert_eq!(attachments.len(), 2);
    assert_eq!(attachments[0].state, "available");
    assert_eq!(attachments[1].state, "missing");
}

/// pi-transcript-events (review remediation): `name`/`mimeType` must be
/// bounded and control/bidi-stripped, same as every other diagnostic string
/// that rides across the boundary — a wire attacker-controlled attachment
/// name is not exempt just because it's metadata, not tool output.
#[test]
fn attachment_name_and_mime_type_are_bounded_and_sanitized() {
    let mut r = TranscriptReducer::new();
    let huge_name = format!("evil\u{202e}name{}", "x".repeat(600));
    let events = r.on_event(
        &json!({"type":"message_start","role":"user","messageId":"m1","text":"see this",
        "attachments":[
            {"id":"a1","name":huge_name,"mimeType":"image\npng\u{202e}"}
        ]}),
        0,
    );
    let RuntimeEventPayload::MessageUser { attachments, .. } = &events[0] else {
        panic!("expected message.user");
    };
    assert_eq!(attachments.len(), 1);
    assert!(attachments[0].name.len() <= 500);
    assert!(!attachments[0].name.contains('\u{202e}'));
    assert!(!attachments[0].mime_type.contains('\n'));
    assert!(!attachments[0].mime_type.contains('\u{202e}'));
}

#[test]
fn a_queued_prompt_not_yet_accepted_never_reaches_the_transcript() {
    let mut r = TranscriptReducer::new();
    let events = r.on_event(
        &json!({"type":"message_start","role":"user","messageId":"m1","text":"queued","accepted":false}),
        0,
    );
    assert!(events.is_empty());
}

// ---------------------------------------------------------- FR-9: crash/stop finalize

#[test]
fn finalize_interrupted_settles_open_text_as_interrupted_never_complete() {
    let mut r = TranscriptReducer::new();
    r.on_event(
        &json!({"type":"content_delta","messageId":"m1","contentIndex":0,
            "delta":{"type":"text","text":"partial"}}),
        0,
    );
    let out = r.finalize_interrupted(999);
    assert_eq!(
        out,
        vec![RuntimeEventPayload::AssistantComplete {
            block_id: r.messages["m1"].slots[&0].block_id.clone(),
            text: "partial".into(),
            outcome: "interrupted".into(),
        }]
    );
    // Idempotent: calling it again emits nothing further.
    assert!(r.finalize_interrupted(1000).is_empty());
}

#[test]
fn finalize_interrupted_never_marks_a_pending_tool_succeeded() {
    let mut r = TranscriptReducer::new();
    r.on_event(
        &json!({"type":"toolcall_start","toolCallId":"pending1","name":"Read"}),
        0,
    );
    r.on_event(
        &json!({"type":"toolcall_start","toolCallId":"running1","name":"Bash"}),
        0,
    );
    r.on_event(
        &json!({"type":"tool_execution_start","toolCallId":"running1"}),
        0,
    );

    let out = r.finalize_interrupted(500);
    assert_eq!(tool_update(&out, "pending1").status, "cancelled");
    assert_eq!(tool_update(&out, "running1").status, "unknown");
    assert!(out.iter().all(|e| match e {
        RuntimeEventPayload::ToolUpdate { tool, .. } => tool.status != "succeeded",
        _ => true,
    }));
}

#[test]
fn finalize_interrupted_leaves_an_already_settled_tool_and_finalized_message_untouched() {
    let mut r = TranscriptReducer::new();
    r.on_event(
        &json!({"type":"toolcall_start","toolCallId":"t1","name":"Bash"}),
        0,
    );
    r.on_event(
        &json!({"type":"tool_execution_end","toolCallId":"t1","isError":false,"output":"ok"}),
        0,
    );
    r.on_event(
        &json!({"type":"message_end","messageId":"m1","role":"assistant",
            "content":[{"type":"text","text":"done"}]}),
        0,
    );
    assert!(r.finalize_interrupted(999).is_empty());
}

// ---------------------------------------------------------- edge cases / malformed

#[test]
fn a_malformed_known_event_fails_with_runtime_protocol_error() {
    let mut r = TranscriptReducer::new();
    assert!(is_failure(
        &r.on_event(&json!({"type":"toolcall_start"}), 0)
    ));
    assert!(is_failure(
        &r.on_event(&json!({"type":"message_start","role":"bogus"}), 0)
    ));
    assert!(is_failure(&r.on_event(
        &json!({"type":"content_delta","messageId":"m1","contentIndex":0}),
        0
    )));
}

/// MEDIUM (review round 3): `content_delta` and its sibling `text_end` must
/// both fail explicitly on an out-of-range `contentIndex` rather than
/// silently wrapping it into a colliding `u32` slot.
#[test]
fn an_out_of_range_content_index_fails_explicitly_on_content_delta_and_text_end() {
    let mut r = TranscriptReducer::new();
    assert!(is_failure(&r.on_event(
        &json!({"type":"content_delta","messageId":"m1","contentIndex":u64::MAX,
            "delta":{"type":"text","text":"x"}}),
        0
    )));
    assert!(is_failure(&r.on_event(
        &json!({"type":"text_end","messageId":"m1","contentIndex":u64::MAX}),
        0
    )));
}

#[test]
fn a_frame_with_no_recognizable_type_fails_explicitly() {
    let mut r = TranscriptReducer::new();
    assert!(is_failure(&r.on_event(&json!({"foo":"bar"}), 0)));
    assert!(is_failure(&r.on_event(&json!({"type":""}), 0)));
}

#[test]
fn a_valid_unknown_event_kind_is_a_bounded_diagnostic_notified_once_per_kind() {
    let mut r = TranscriptReducer::new();
    let first = r.on_event(&json!({"type":"future_event","extra":true}), 0);
    let (tone, _) = only_notice(&first);
    assert_eq!(tone, "warning");
    let second = r.on_event(&json!({"type":"future_event"}), 0);
    assert!(second.is_empty());
}

// ---------------------------------------------------------- review remediation: bounded state

/// MEDIUM (review remediation): `TranscriptReducer.messages`/`.tools` must
/// not grow without bound over the connection's lifetime — a long session
/// finalizing/settling thousands of messages and tool calls must stay
/// bounded, same as `block_buffer` (transcript-scale FR-1/FR-2).
#[test]
fn finalized_messages_and_settled_tools_are_evicted_past_the_bound() {
    let mut r = TranscriptReducer::new();
    let over_the_cap = REDUCER_STATE_CAP + 20;
    for i in 0..over_the_cap {
        let message_id = format!("m{i}");
        r.on_event(
            &json!({"type":"message_end","messageId":message_id,"role":"assistant",
                "content":[{"type":"text","text":"done"}]}),
            0,
        );
        let tool_call_id = format!("t{i}");
        r.on_event(
            &json!({"type":"toolcall_start","toolCallId":tool_call_id,"name":"Bash"}),
            0,
        );
        r.on_event(
            &json!({"type":"tool_execution_end","toolCallId":tool_call_id,
                "isError":false,"output":"ok"}),
            0,
        );
    }
    assert!(
        r.messages.len() <= REDUCER_STATE_CAP,
        "messages grew past the bound: {}",
        r.messages.len()
    );
    assert!(
        r.tools.len() <= REDUCER_STATE_CAP,
        "tools grew past the bound: {}",
        r.tools.len()
    );
    // The oldest entries are the ones evicted — the most recent survive.
    assert!(!r.messages.contains_key("m0"));
    assert!(r.messages.contains_key(&format!("m{}", over_the_cap - 1)));
    assert!(!r.tools.contains_key("t0"));
    assert!(r.tools.contains_key(&format!("t{}", over_the_cap - 1)));
}

/// A duplicate final `message_end` for an already-finalized message (edge
/// cases §7's idempotent upsert) must not push a second eviction-order
/// entry — otherwise a single hot message_id could itself blow the bound
/// and evict unrelated, still-referenceable messages.
#[test]
fn a_duplicate_finalize_does_not_double_count_toward_the_eviction_bound() {
    let mut r = TranscriptReducer::new();
    for _ in 0..3 {
        r.on_event(
            &json!({"type":"message_end","messageId":"m1","role":"assistant",
                "content":[{"type":"text","text":"done"}]}),
            0,
        );
    }
    assert_eq!(
        r.finalized_messages.iter().filter(|id| *id == "m1").count(),
        1
    );
}
