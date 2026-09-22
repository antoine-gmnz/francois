use super::protocol::*;
use super::requests::*;
use serde_json::{json, Value};
use std::collections::BTreeMap;

fn scope() -> NativeScope {
    NativeScope {
        session_id: "session-a".into(),
        generation: 7,
        thread_id: "thread".into(),
        turn_id: "turn".into(),
    }
}
fn ledger() -> RequestLedger {
    RequestLedger::new(scope())
}
fn command(id: Value) -> Value {
    json!({"id":id,"method":"item/commandExecution/requestApproval","params":{"kind":"command","threadId":"thread","turnId":"turn","itemId":"item","startedAtMs":1,"environmentId":"local","approvalId":"callback","command":"echo safe","availableDecisions":["accept",{"acceptWithExecpolicyAmendment":{"execpolicy_amendment":["echo"]}},"cancel"]}})
}
fn file(id: Value) -> Value {
    json!({"id":id,"method":"item/fileChange/requestApproval","params":{"threadId":"thread","turnId":"turn","itemId":"file-item","startedAtMs":1,"reason":"Save requested edit","grantRoot":"/repo"}})
}
fn questions(id: Value) -> Value {
    json!({"id":id,"method":"item/tool/requestUserInput","params":{"threadId":"thread","turnId":"turn","itemId":"question-item","isBlocking":false,"autoResolutionMs":null,"questions":[{"id":"first","header":"One","question":"Same text","isOther":false,"isSecret":false,"options":[{"label":"Blue","description":"Calm"}]},{"id":"secret","header":"Two","question":"Same text","isOther":false,"isSecret":true,"options":null}]}})
}
fn insert(ledger: &mut RequestLedger, frame: Value) -> PendingRequest {
    let Envelope::Request { id, method, params } = decode_value(frame).unwrap() else {
        panic!("request")
    };
    ledger.insert(&scope(), id, &method, params).unwrap()
}

#[test]
fn exact_string_and_numeric_request_ids_never_collide() {
    let mut ledger = ledger();
    let one = insert(&mut ledger, command(json!(1)));
    let string = insert(&mut ledger, command(json!("1")));
    assert_ne!(one.block_id, string.block_id);
    assert_eq!(
        ledger
            .resolve(&scope(), &RequestId::Integer(1))
            .unwrap()
            .block_id,
        one.block_id
    );
    assert_eq!(
        ledger
            .resolve(&scope(), &RequestId::String("1".into()))
            .unwrap()
            .block_id,
        string.block_id
    );
}

#[test]
fn malformed_protocol_never_exposes_input_in_errors() {
    for frame in [
        json!([]),
        json!({"id":null,"result":{}}),
        json!({"id":1,"result":{},"error":{"message":"SENTINEL"}}),
        json!({"id":1.5,"result":{}}),
        json!({"id":true,"method":"foo","params":{}}),
    ] {
        let error = decode_value(frame).unwrap_err();
        assert_eq!(format!("{error:?}"), "MalformedEnvelope");
    }
    assert_eq!(
        decode_frame(b"SENTINEL\n").unwrap_err(),
        ProtocolError::MalformedEnvelope
    );
}

#[test]
fn unsupported_server_method_returns_error_with_original_id() {
    assert_eq!(
        unsupported_request(&RequestId::String("opaque".into())),
        json!({"id":"opaque","error":{"code":-32601,"message":"Unsupported native server request"}})
    );
    let mut ledger = ledger();
    assert_eq!(
        ledger.insert(&scope(), RequestId::Integer(9), "item/tool/call", json!({})),
        Err(RequestError::UnsupportedMethod)
    );
}

#[test]
fn command_uses_actual_offered_choices_and_does_not_grant_policy_amendments() {
    let mut ledger = ledger();
    let request = insert(&mut ledger, command(json!(4)));
    assert_eq!(
        request.allowed_decisions(),
        vec![NativeDecision::Accept, NativeDecision::Cancel]
    );
    assert_eq!(
        ledger
            .claim_permission(&scope(), &request.block_id, NativeDecision::Decline)
            .err(),
        Some(RequestError::UnsupportedDecision)
    );
    let reply = ledger
        .claim_permission(&scope(), &request.block_id, NativeDecision::Cancel)
        .unwrap();
    assert_eq!(
        reply.wire(),
        &json!({"id":4,"result":{"decision":"cancel"}})
    );
}

#[test]
fn file_approval_has_its_own_verified_defaults_and_exact_payload() {
    for decision in [
        NativeDecision::Accept,
        NativeDecision::Decline,
        NativeDecision::Cancel,
    ] {
        let mut ledger = ledger();
        let request = insert(&mut ledger, file(json!("file-request")));
        assert_eq!(
            request.allowed_decisions(),
            vec![
                NativeDecision::Accept,
                NativeDecision::Decline,
                NativeDecision::Cancel
            ]
        );
        assert_eq!(
            ledger
                .claim_permission(&scope(), &request.block_id, decision)
                .unwrap()
                .wire(),
            &json!({"id":"file-request","result":{"decision":decision.as_str()}})
        );
    }
}

#[test]
fn file_details_never_leak_between_item_turn_thread_or_generation() {
    let mut ledger = ledger();
    let detail = json!({"type":"fileChange","id":"file-item","changes":[{"path":"/repo/a","kind":{"type":"update","move_path":null},"diff":"+safe"}],"status":"inProgress"});
    for changed in 0..4 {
        let mut stale = scope();
        match changed {
            0 => stale.session_id.push('x'),
            1 => stale.thread_id.push('x'),
            2 => stale.turn_id.push('x'),
            _ => stale.generation += 1,
        }
        assert_eq!(
            ledger.observe_file_item(&stale, detail.clone()),
            Err(RequestError::StaleScope)
        );
    }
    ledger.observe_file_item(&scope(), detail).unwrap();
    let request = insert(&mut ledger, file(json!(1)));
    assert_eq!(request.file_changes().unwrap()[0]["path"], "/repo/a");
    let mut other = file(json!(2));
    other["params"]["itemId"] = json!("other");
    assert!(insert(&mut ledger, other).file_changes().is_none());
}

#[test]
fn questions_keep_opaque_ids_flags_freeform_and_redact_only_resolution() {
    let mut ledger = ledger();
    let request = insert(&mut ledger, questions(json!(0)));
    assert!(!request.is_blocking());
    let answers = BTreeMap::from([
        ("first".into(), "Blue".into()),
        ("secret".into(), "SENTINEL".into()),
    ]);
    let reply = ledger
        .claim_answers(&scope(), &request.block_id, answers)
        .unwrap();
    assert_eq!(
        reply.wire(),
        &json!({"id":0,"result":{"answers":{"first":{"answers":["Blue"]},"secret":{"answers":["SENTINEL"]}}}})
    );
    let resolution = ledger.resolve(&scope(), &RequestId::Integer(0)).unwrap();
    assert_eq!(
        resolution.outcome,
        ResolutionOutcome::Answers(BTreeMap::from([
            ("first".into(), "Blue".into()),
            ("secret".into(), "[redacted]".into())
        ]))
    );
    assert!(!format!("{resolution:?}").contains("SENTINEL"));
}

#[test]
fn questions_reject_unknown_ids_missing_answers_and_invented_other_choices() {
    let mut ledger = ledger();
    let request = insert(&mut ledger, questions(json!(0)));
    for answers in [
        BTreeMap::from([("Same text".into(), "Blue".into())]),
        BTreeMap::from([
            ("first".into(), "Green".into()),
            ("secret".into(), "x".into()),
        ]),
        BTreeMap::new(),
    ] {
        assert_eq!(
            ledger
                .claim_answers(&scope(), &request.block_id, answers)
                .err(),
            Some(RequestError::InvalidAnswer)
        );
    }
}

#[test]
fn duplicate_claim_resolve_and_replayed_request_do_not_write_again() {
    let mut ledger = ledger();
    let request = insert(&mut ledger, command(json!(1)));
    ledger
        .claim_permission(&scope(), &request.block_id, NativeDecision::Accept)
        .unwrap();
    assert_eq!(
        ledger
            .claim_permission(&scope(), &request.block_id, NativeDecision::Accept)
            .err(),
        Some(RequestError::AlreadyClaimed)
    );
    assert_eq!(
        ledger
            .resolve(&scope(), &RequestId::Integer(1))
            .unwrap()
            .outcome,
        ResolutionOutcome::Permission(NativeDecision::Accept)
    );
    assert!(ledger.resolve(&scope(), &RequestId::Integer(1)).is_none());
    assert_eq!(
        ledger.insert(
            &scope(),
            RequestId::Integer(1),
            "item/commandExecution/requestApproval",
            command(json!(1))["params"].clone()
        ),
        Err(RequestError::Replay)
    );
}

#[test]
fn native_resolution_without_claim_is_cancelled_and_close_drains_once() {
    let mut ledger = ledger();
    insert(&mut ledger, questions(json!(1)));
    assert_eq!(
        ledger
            .resolve(&scope(), &RequestId::Integer(1))
            .unwrap()
            .outcome,
        ResolutionOutcome::Cancelled
    );
    insert(&mut ledger, command(json!(2)));
    assert_eq!(ledger.close().len(), 1);
    assert!(ledger.close().is_empty());
    assert_eq!(
        ledger.insert(
            &scope(),
            RequestId::Integer(3),
            "item/fileChange/requestApproval",
            file(json!(3))["params"].clone()
        ),
        Err(RequestError::StaleScope)
    );
}

#[test]
fn native_resolution_before_write_returns_preserves_claimed_redacted_outcome() {
    let mut ledger = ledger();
    let request = insert(&mut ledger, questions(json!(1)));
    let reply = ledger
        .claim_answers(
            &scope(),
            &request.block_id,
            BTreeMap::from([
                ("first".into(), "Blue".into()),
                ("secret".into(), "SENTINEL".into()),
            ]),
        )
        .unwrap();
    let resolution = ledger.resolve(&scope(), &RequestId::Integer(1)).unwrap();
    assert!(matches!(resolution.outcome, ResolutionOutcome::Answers(_)));
    assert!(!format!("{resolution:?}").contains("SENTINEL"));
    assert!(reply.wire().to_string().contains("SENTINEL"));
    assert!(ledger.close().is_empty());
}

#[test]
fn initialize_and_interrupt_encode_only_native_fields() {
    assert_eq!(
        initialize(&RequestId::Integer(1), "0.42.0"),
        json!({"id":1,"method":"initialize","params":{"clientInfo":{"name":"francois","title":"Francois","version":"0.42.0"},"capabilities":{"experimentalApi":true}}})
    );
    assert_eq!(
        interrupt(&RequestId::String("stop".into()), "thread", "turn"),
        json!({"id":"stop","method":"turn/interrupt","params":{"threadId":"thread","turnId":"turn"}})
    );
}

#[test]
fn stale_reply_cannot_cross_session_or_turn() {
    let mut ledger = ledger();
    let request = insert(&mut ledger, command(json!(1)));
    let mut stale = scope();
    stale.generation += 1;
    assert_eq!(
        ledger
            .claim_permission(&stale, &request.block_id, NativeDecision::Accept)
            .err(),
        Some(RequestError::StaleScope)
    );
    assert!(ledger.resolve(&stale, &RequestId::Integer(1)).is_none());
}

#[test]
fn stop_waits_for_native_started_and_completion_clears_latched_intent() {
    let mut interrupt = InterruptState::default();
    assert!(!interrupt.request());
    assert!(interrupt.started());
    assert!(!interrupt.request());
    interrupt.completed();
    assert!(!interrupt.started());
    assert!(!interrupt.request());
}

#[test]
fn new_turn_cancels_old_requests_but_preserves_connection_replay_tombstones() {
    let mut ledger = ledger();
    let old = insert(&mut ledger, command(json!(1)));
    let mut next = scope();
    next.turn_id = "turn-two".into();
    next.generation += 1;
    assert_eq!(ledger.advance_turn(next.clone()).unwrap().len(), 1);
    let mut params = command(json!(1))["params"].clone();
    params["turnId"] = json!("turn-two");
    assert_eq!(
        ledger.insert(
            &next,
            RequestId::Integer(1),
            "item/commandExecution/requestApproval",
            params.clone()
        ),
        Err(RequestError::Replay)
    );
    let new = ledger
        .insert(
            &next,
            RequestId::Integer(2),
            "item/commandExecution/requestApproval",
            params,
        )
        .unwrap();
    // Block ids are application-local (FR-6/FR-12): unique per connection, but
    // never carrying a vendor turn/request id. Authority is scope-checked.
    assert!(!new.block_id.contains("turn-two"));
    assert_ne!(new.block_id, old.block_id);
    assert_eq!(
        ledger
            .claim_permission(&scope(), &new.block_id, NativeDecision::Accept)
            .err(),
        Some(RequestError::StaleScope)
    );
    assert!(ledger
        .claim_permission(&next, &new.block_id, NativeDecision::Accept)
        .is_ok());
    assert!(ledger.resolve(&next, &RequestId::Integer(1)).is_none());
}

#[test]
fn command_callback_kind_is_preserved_and_empty_decisions_do_not_restore_defaults() {
    let mut ledger = ledger();
    let mut frame = command(json!(1));
    frame["params"]["kind"] = json!("writeStdin");
    frame["params"]["availableDecisions"] = json!([]);
    let request = insert(&mut ledger, frame);
    assert!(request.allowed_decisions().is_empty());
    let RequestKind::Command(command) = request.kind else {
        panic!("command")
    };
    assert_eq!(command.kind, CommandApprovalKind::WriteStdin);
    assert_eq!(command.approval_id.as_deref(), Some("callback"));
}

#[test]
fn other_enabled_and_empty_options_accept_exact_freeform_values() {
    for options in [json!([]), json!([{"label":"Blue","description":"Calm"}])] {
        let mut ledger = ledger();
        let mut frame = questions(json!(0));
        frame["params"]["questions"][0]["options"] = options;
        frame["params"]["questions"][0]["isOther"] = json!(true);
        let request = insert(&mut ledger, frame);
        assert!(ledger
            .claim_answers(
                &scope(),
                &request.block_id,
                BTreeMap::from([
                    ("first".into(), "Custom exact text".into()),
                    ("secret".into(), "x".into())
                ])
            )
            .is_ok());
    }
}

#[test]
fn mismatched_native_identity_and_duplicate_question_ids_are_rejected() {
    for field in ["threadId", "turnId"] {
        let mut ledger = ledger();
        let mut params = command(json!(1))["params"].clone();
        params[field] = json!("other");
        assert_eq!(
            ledger.insert(
                &scope(),
                RequestId::Integer(1),
                "item/commandExecution/requestApproval",
                params
            ),
            Err(RequestError::StaleScope)
        );
    }
    let mut ledger = ledger();
    let mut params = questions(json!(1))["params"].clone();
    params["questions"][1]["id"] = json!("first");
    assert_eq!(
        ledger.insert(
            &scope(),
            RequestId::Integer(1),
            "item/tool/requestUserInput",
            params
        ),
        Err(RequestError::InvalidParams)
    );
}

#[test]
fn secret_options_restrict_choices_and_redact_accepted_value() {
    let mut ledger = ledger();
    let mut frame = questions(json!(1));
    frame["params"]["questions"][1]["options"] =
        json!([{"label":"SENTINEL","description":"An offered secret value"}]);
    let request = insert(&mut ledger, frame);
    let error = ledger
        .claim_answers(
            &scope(),
            &request.block_id,
            BTreeMap::from([
                ("first".into(), "Blue".into()),
                ("secret".into(), "UNEXPECTED_SECRET".into()),
            ]),
        )
        .err()
        .unwrap();
    assert_eq!(error, RequestError::InvalidAnswer);
    assert!(!format!("{error:?}").contains("UNEXPECTED_SECRET"));
    ledger
        .claim_answers(
            &scope(),
            &request.block_id,
            BTreeMap::from([
                ("first".into(), "Blue".into()),
                ("secret".into(), "SENTINEL".into()),
            ]),
        )
        .unwrap();
    let resolution = ledger.resolve(&scope(), &RequestId::Integer(1)).unwrap();
    assert!(!format!("{resolution:?}").contains("SENTINEL"));
}
