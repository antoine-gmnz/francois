//! Product regressions for the Codex feature audit, using a native wire peer.
use super::integration_tests::{context, runtime, Sink};
use crate::session::application::*;
use std::sync::Arc;

#[test]
fn remote_control_uses_same_live_process_and_ephemeral_pairing_then_confirms_stop() {
    let (native, _) = runtime("remote");
    let sink = Arc::new(Sink::default());
    native.begin_turn(context(1, None), sink.clone()).unwrap();
    sink.terminal();
    let paired = native
        .resource(ResourceRequest::RemoteStart("Project".into()))
        .unwrap();
    assert_eq!(paired["phase"], "pairing");
    assert_eq!(paired["pairingCode"], "MANUAL-1");
    assert_eq!(paired["environmentId"], "native-environment");
    // Idempotency preserves the valid code and creates no second registration.
    assert_eq!(
        native
            .resource(ResourceRequest::RemoteStart("Project".into()))
            .unwrap(),
        paired
    );
    assert_eq!(
        native.resource(ResourceRequest::RemoteStop).unwrap()["phase"],
        "off"
    );
    native.close();
}

#[test]
fn replacement_profile_prompt_reaches_native_thread_start() {
    let (native, _) = runtime("profile");
    let sink = Arc::new(Sink::default());
    let mut ctx = context(1, None);
    ctx.system_prompt = Some("PROFILE-REPLACEMENT".into());
    native.begin_turn(ctx, sink.clone()).unwrap();
    match sink.wait(|event| matches!(event, RuntimeEvent::AssistantFinal { .. })) {
        RuntimeEvent::AssistantFinal { text, .. } => assert_eq!(text, "PROFILE-REPLACEMENT"),
        _ => unreachable!(),
    }
    native.close();
}

#[test]
fn plan_setting_selects_native_plan_collaboration_mode() {
    let (native, _) = runtime("plan-mode");
    let sink = Arc::new(Sink::default());
    let mut ctx = context(1, None);
    ctx.permission_mode = "plan".into();
    native.begin_turn(ctx, sink.clone()).unwrap();
    match sink.wait(|event| matches!(event, RuntimeEvent::AssistantFinal { .. })) {
        RuntimeEvent::AssistantFinal { text, .. } => assert_eq!(text, "plan"),
        _ => unreachable!(),
    }
    native.close();
}

#[test]
fn compaction_uses_native_compact_rpc_and_tracks_its_real_turn() {
    let (native, _) = runtime("compact");
    let sink = Arc::new(Sink::default());
    let mut ctx = context(1, Some("opaque-fixture-thread"));
    ctx.mode = TurnMode::Compact;
    native.begin_turn(ctx, sink.clone()).unwrap();
    sink.terminal();
    assert!(sink
        .events
        .lock()
        .unwrap()
        .iter()
        .any(|event| matches!(event.event, RuntimeEvent::TurnFinished)));
    assert!(sink.events.lock().unwrap().iter().any(|event| matches!(&event.event, RuntimeEvent::ToolStarted { tool, .. } if tool == "ContextCompaction")));
    native.close();
}

#[test]
fn native_public_item_details_are_retained_without_private_reasoning() {
    let mut items = super::events::Items::default();
    let ctx = context(1, None);
    for item in [
        serde_json::json!({"id":"reason","type":"reasoning","summary":["Public summary"],"content":["PRIVATE-REASONING"]}),
        serde_json::json!({"id":"plan","type":"plan","text":"Public plan"}),
        serde_json::json!({"id":"image","type":"imageView","path":"/tmp/image.png"}),
    ] {
        let events = items.item(&item, true, &ctx);
        let detail = events
            .iter()
            .find_map(|event| match event {
                RuntimeEvent::ToolCompleted { detail, .. } => detail.as_ref(),
                _ => None,
            })
            .expect("visible item detail");
        assert!(!serde_json::to_string(detail)
            .unwrap()
            .contains("PRIVATE-REASONING"));
    }
}

#[test]
fn native_spawn_ack_does_not_complete_the_child_and_child_transcript_is_observed() {
    let (native, _) = runtime("agents");
    let sink = Arc::new(Sink::default());
    native.begin_turn(context(1, None), sink.clone()).unwrap();
    sink.terminal();
    let events = sink.events.lock().unwrap();
    assert!(events.iter().any(|event| matches!(&event.event, RuntimeEvent::SubagentStarted { agent, .. } if serde_json::to_value(agent).unwrap()["status"] == "running")));
    assert!(events.iter().any(|event| matches!(&event.event, RuntimeEvent::SubagentObserved { items, .. } if items.iter().any(|item| matches!(item, SubagentObservation::Text(text) if text == "child result")))));
    native.close();
}

#[test]
fn asynchronous_questions_and_command_progress_are_visible() {
    let mut items = super::events::Items::default();
    let ctx = context(1, None);
    let output = items.item(&serde_json::json!({"id":"async","type":"agentMessage","text":"Select next step","delivery":"async","questions":[{"title":"Continue?","options":["yes","no"]}]}),true,&ctx);
    assert!(
        matches!(&output[0], RuntimeEvent::AssistantFinal { text,.. } if text.contains("Continue?\n- yes\n- no"))
    );
    items.item(
        &serde_json::json!({"id":"cmd","type":"commandExecution","command":"ls"}),
        false,
        &ctx,
    );
    let RuntimeEvent::ToolSnapshot { tool, .. } = items
        .progress(
            &serde_json::json!({"itemId":"cmd","delta":"visible during execution"}),
            true,
        )
        .unwrap()
    else {
        panic!()
    };
    assert_eq!(tool.status, "running");
    assert_eq!(tool.output_text, "visible during execution");
    assert_ne!(tool.id, "cmd");
    let result = items.item(&serde_json::json!({"id":"cmd","type":"commandExecution","command":"ls","aggregatedOutput":"final authoritative output","exitCode":0}),true,&ctx);
    assert!(result.iter().any(|event| matches!(event, RuntimeEvent::ToolSnapshot {tool,..} if tool.status=="succeeded" && tool.output_text=="final authoritative output")));
    assert!(items
        .progress(&serde_json::json!({"itemId":"cmd","delta":"late"}), true)
        .is_none());
}

#[test]
fn failed_child_subscription_fails_the_parent_instead_of_hanging() {
    let (native, _) = runtime("child-subscribe-fail");
    let sink = Arc::new(Sink::default());
    native.begin_turn(context(1, None), sink.clone()).unwrap();
    sink.wait(|event| matches!(event, RuntimeEvent::ConnectionClosed(_)));
    assert!(sink.events.lock().unwrap().iter().any(|event|matches!(&event.event,RuntimeEvent::ConnectionClosed(error) if error.message.contains("subagent transcript"))));
    native.close();
}
#[test]
fn skill_selection_survives_response_prefix() {
    let (native, _) = runtime("skill-prefix");
    let sink = Arc::new(Sink::default());
    let mut ctx = context(1, None);
    ctx.text = "$demo Explain this".into();
    ctx.execution.response_prefix = Some("Respond briefly".into());
    native.begin_turn(ctx, sink.clone()).unwrap();
    match sink.wait(|event| matches!(event, RuntimeEvent::AssistantFinal { .. })) {
        RuntimeEvent::AssistantFinal { text, .. } => {
            let input: serde_json::Value = serde_json::from_str(&text).unwrap();
            assert!(input
                .as_array()
                .unwrap()
                .iter()
                .any(|input| input["type"] == "skill" && input["name"] == "demo"));
        }
        _ => unreachable!(),
    }
    native.close();
}

#[test]
fn remote_waits_for_enrollment_and_converts_native_epoch_seconds() {
    let (native, _) = runtime("remote-warmup");
    let sink = Arc::new(Sink::default());
    native.begin_turn(context(1, None), sink.clone()).unwrap();
    sink.terminal();
    let paired = native
        .resource(ResourceRequest::RemoteStart("Project".into()))
        .unwrap();
    let now = crate::ids::now_ms();
    let expires = paired["expiresAt"].as_u64().unwrap();
    assert!(expires > now + 500_000 && expires < now + 700_000);
    assert_eq!(paired["pairingCode"], "MANUAL-1");
    native.close();
}

#[test]
fn code_mode_activity_discovers_agents_and_streams_their_transcript() {
    let (native, _) = runtime("agent-activity");
    let sink = Arc::new(Sink::default());
    native.begin_turn(context(1, None), sink.clone()).unwrap();
    sink.terminal();
    let events = sink.events.lock().unwrap();
    assert_eq!(
        events
            .iter()
            .filter(|event| matches!(&event.event, RuntimeEvent::SubagentStarted { .. }))
            .count(),
        1
    );
    assert!(events.iter().any(|event| matches!(&event.event, RuntimeEvent::SubagentStarted { agent, .. } if agent.name == "backend")));
    assert!(events.iter().any(|event| matches!(&event.event, RuntimeEvent::SubagentObserved { items, .. } if items.iter().any(|item| matches!(item, SubagentObservation::Text(text) if text == "activity child result")))));
    assert!(events.iter().any(|event| matches!(&event.event, RuntimeEvent::SubagentState { status, .. } if status == "done")));
    drop(events);
    native.close();
}

#[test]
fn parent_completion_waits_for_the_last_activity_completed_item() {
    let (native, _) = runtime("agent-activity-parent-first");
    let sink = Arc::new(Sink::default());
    native.begin_turn(context(1, None), sink.clone()).unwrap();
    sink.terminal();
    let events = sink.events.lock().unwrap();
    let done = events.iter().position(|event| matches!(&event.event, RuntimeEvent::SubagentState { status, .. } if status == "done")).unwrap();
    let terminal = events
        .iter()
        .position(|event| matches!(&event.event, RuntimeEvent::TurnFinished))
        .unwrap();
    assert!(done < terminal);
    drop(events);
    native.close();
}
