// Connection tests for the session engine's runtime plumbing — split out of
// runtime.rs to keep it under the ~1000-line cap; included via `#[path]`
// from there (same pattern as adapter/pi/dispatcher.rs + dispatcher_tests.rs).

use super::*;
use crate::session::testutil::fake_accounts;
use adapter::{RuntimeSessionControl, RuntimeSubmission, SubmissionReceipt};
struct MockConnection {
    engine: std::sync::Weak<Engine>,
    calls: Arc<Mutex<Vec<&'static str>>>,
}
impl MockConnection {
    fn record(&self, call: &'static str) {
        let engine = self.engine.upgrade().unwrap();
        assert!(engine.sessions.try_lock().is_ok());
        assert!(engine.runtime_connections.try_lock().is_ok());
        assert!(engine.runtime_events.try_lock().is_ok());
        self.calls.lock().unwrap().push(call);
    }
}
impl RuntimeSessionControl for MockConnection {
    fn submit(&self, input: RuntimeSubmission) -> Result<SubmissionReceipt, AppError> {
        assert_eq!(input.text, "hello");
        self.record("submit");
        Ok(SubmissionReceipt { request_id: uuid() })
    }
    fn capabilities(&self) -> RuntimeCapabilities {
        enabled_caps()
    }
    fn cancel(&self) -> Result<(), AppError> {
        self.record("cancel");
        Ok(())
    }
    fn shutdown(&self) -> Result<(), AppError> {
        self.record("shutdown");
        Ok(())
    }
}
fn enabled_caps() -> RuntimeCapabilities {
    adapter::RUNTIME_CAPABILITIES
        .into_iter()
        .map(|k| {
            (
                k.into(),
                adapter::CapabilityState {
                    available: true,
                    reason: None,
                },
            )
        })
        .collect()
}
fn model() -> adapter::RuntimeModelRef {
    adapter::RuntimeModelRef {
        provider_id: "provider".into(),
        model_id: "model".into(),
    }
}
#[test]
fn replacement_rejects_retired_child_and_publishes_authoritative_meta_first() {
    let mut session = testutil::test_session();
    session.id = uuid();
    session.agent_runtime = AgentRuntime::Pi;
    let id = session.id.clone();
    let engine = Arc::new(testutil::test_engine_with(session));
    let c = || {
        Arc::new(MockConnection {
            engine: Arc::downgrade(&engine),
            calls: Arc::new(Mutex::new(Vec::new())),
        }) as Arc<dyn RuntimeSessionControl>
    };
    let (old, first) = engine
        .install_runtime_connection(&fake_accounts(), id.clone(), c(), model(), enabled_caps())
        .unwrap();
    assert!(matches!(first.as_slice(), [SessionEvent::Meta { .. }]));
    let (current, _) = engine
        .install_runtime_connection(&fake_accounts(), id.clone(), c(), model(), enabled_caps())
        .unwrap();
    let mut caps = enabled_caps();
    caps.insert(
        "permissions".into(),
        adapter::CapabilityState {
            available: false,
            reason: Some("Disabled".into()),
        },
    );
    assert!(engine
        .runtime_event(
            &fake_accounts(),
            &old,
            1,
            None,
            None,
            events::RuntimeEventPayload::Capabilities {
                capabilities: caps.clone()
            }
        )
        .is_err());
    assert!(engine.require_capability(&id, "permissions").is_ok());
    let batch = engine
        .runtime_event(
            &fake_accounts(),
            &current,
            2,
            None,
            None,
            events::RuntimeEventPayload::Capabilities { capabilities: caps },
        )
        .unwrap();
    assert!(matches!(
        batch.as_slice(),
        [
            SessionEvent::Meta { .. },
            SessionEvent::RuntimeEvent { sequence: 1, .. }
        ]
    ));
    assert!(engine.require_capability(&id, "permissions").is_err());
    let ui = serde_json::to_value(&batch[0]).unwrap();
    let core = engine
        .with_session(&id, |s| {
            serde_json::to_value(s.meta(&fake_accounts())).unwrap()
        })
        .unwrap();
    assert_eq!(ui["meta"], core);
    assert_eq!(core["runtimeModel"]["modelId"], "model");
}
/// pi-models-metrics (lead clarification): `model.changed`/`metrics`
/// must NEVER bundle a `session.meta` ahead of themselves in the SAME
/// batch — unlike every other `RuntimeEventPayload` variant. This is the
/// invariant `apply_pi_model_switch`/`session_metrics` (session/commands/
/// lifecycle.rs, runtime_models.rs) depend on to pin the emission order
/// the contract requires: `model.changed` FIRST, then the authoritative
/// `session.meta` (built and emitted SEPARATELY, once the session has
/// already been mutated) — a `session.meta` published from inside this
/// same batch would carry `model.efforts` from BEFORE the switch, since
/// the frontend projects `model.changed` without efforts.
#[test]
fn model_changed_and_metrics_events_publish_no_bundled_session_meta() {
    let mut session = testutil::test_session();
    session.id = uuid();
    session.agent_runtime = AgentRuntime::Pi;
    let id = session.id.clone();
    let engine = Arc::new(testutil::test_engine_with(session));
    let c = Arc::new(MockConnection {
        engine: Arc::downgrade(&engine),
        calls: Arc::new(Mutex::new(Vec::new())),
    });
    let (producer, _first) = engine
        .install_runtime_connection(&fake_accounts(), id.clone(), c, model(), enabled_caps())
        .unwrap();

    let descriptor = events::RuntimeModelDescriptor {
        model_ref: model(),
        display_name: "Model".into(),
        input: vec!["text".into()],
        context_window: Some(200_000),
        max_output_tokens: None,
        reasoning: true,
        auth_state: "verified".into(),
        availability: "available".into(),
        unavailable_reason: None,
    };
    let batch = engine
        .runtime_event(
            &fake_accounts(),
            &producer,
            1,
            None,
            None,
            events::RuntimeEventPayload::ModelChanged {
                model: descriptor,
                effort: Some("high".into()),
            },
        )
        .unwrap();
    assert!(matches!(
        batch.as_slice(),
        [SessionEvent::RuntimeEvent { .. }]
    ));

    let metrics = events::RuntimeMetrics {
        input_tokens: Some(1),
        output_tokens: Some(1),
        cache_read_tokens: None,
        cache_write_tokens: None,
        context_tokens: None,
        context_window: None,
        context_basis: "unknown".into(),
        cost_usd: None,
        cost_basis: "unknown".into(),
        measured_at: 1_000,
        stale: false,
    };
    let batch = engine
        .runtime_event(
            &fake_accounts(),
            &producer,
            2,
            None,
            None,
            events::RuntimeEventPayload::Metrics { metrics },
        )
        .unwrap();
    assert!(matches!(
        batch.as_slice(),
        [SessionEvent::RuntimeEvent { .. }]
    ));
}

#[test]
fn idle_connection_submission_cancellation_and_shutdown_release_locks() {
    let mut session = testutil::test_session();
    session.id = uuid();
    let id = session.id.clone();
    let engine = Arc::new(testutil::test_engine_with(session));
    let calls = Arc::new(Mutex::new(Vec::new()));
    let c = Arc::new(MockConnection {
        engine: Arc::downgrade(&engine),
        calls: calls.clone(),
    });
    engine
        .install_runtime_connection(&fake_accounts(), id.clone(), c, model(), enabled_caps())
        .unwrap();
    assert!(engine.with_session(&id, |s| s.current.is_none()).unwrap());
    let receipt = engine
        .submit_runtime(
            &id,
            RuntimeSubmission {
                text: "hello".into(),
                attachments: Vec::new(),
            },
        )
        .unwrap();
    assert!(crate::ipc::valid_correlation(&receipt.request_id));
    engine.cancel_runtime(&id).unwrap();
    engine.shutdown_runtime(&id).unwrap();
    assert_eq!(*calls.lock().unwrap(), vec!["submit", "cancel", "shutdown"]);
    engine.shutdown_runtimes();
    assert_eq!(calls.lock().unwrap().len(), 3);
}
#[test]
fn shutdown_and_replacement_share_the_installation_lock_order() {
    for all in [false, true] {
        let mut s = testutil::test_session();
        s.id = uuid();
        let id = s.id.clone();
        let engine = Arc::new(testutil::test_engine_with(s));
        let make = || {
            Arc::new(MockConnection {
                engine: Arc::downgrade(&engine),
                calls: Arc::new(Mutex::new(Vec::new())),
            }) as Arc<dyn RuntimeSessionControl>
        };
        engine
            .install_runtime_connection(
                &fake_accounts(),
                id.clone(),
                make(),
                model(),
                enabled_caps(),
            )
            .unwrap();
        let connections = engine.runtime_connections.lock().unwrap();
        let worker = engine.clone();
        let worker_id = id.clone();
        let stop = std::thread::spawn(move || {
            if all {
                worker.shutdown_runtimes()
            } else {
                worker.shutdown_runtime(&worker_id).unwrap()
            }
        });
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        while engine
            .with_session(&id, |s| s.runtime_generation.is_some())
            .unwrap()
        {
            assert!(std::time::Instant::now() < deadline);
            std::thread::yield_now();
        }
        let held = engine.runtime_events.try_lock().is_err();
        drop(connections);
        stop.join().unwrap();
        assert!(
            held,
            "shutdown must hold installation lock until the matching connection is retired"
        );
        let (producer, _) = engine
            .install_runtime_connection(
                &fake_accounts(),
                id.clone(),
                make(),
                model(),
                enabled_caps(),
            )
            .unwrap();
        assert!(engine
            .with_session(&id, |s| s.runtime_generation.as_ref()
                == Some(&producer.generation))
            .unwrap());
        assert!(engine.runtime_connections.lock().unwrap().contains_key(&id));
    }
}

struct WaitingShutdown {
    entered: std::sync::mpsc::Sender<()>,
    release: Mutex<std::sync::mpsc::Receiver<()>>,
    engine: std::sync::Weak<Engine>,
}
impl RuntimeSessionControl for WaitingShutdown {
    fn submit(&self, _: RuntimeSubmission) -> Result<SubmissionReceipt, AppError> {
        unreachable!()
    }
    fn cancel(&self) -> Result<(), AppError> {
        Ok(())
    }
    fn capabilities(&self) -> RuntimeCapabilities {
        enabled_caps()
    }
    fn shutdown(&self) -> Result<(), AppError> {
        let engine = self.engine.upgrade().unwrap();
        assert!(engine.runtime_events.try_lock().is_ok());
        assert!(engine.runtime_connections.try_lock().is_ok());
        assert!(engine.sessions.try_lock().is_ok());
        self.entered.send(()).unwrap();
        self.release
            .lock()
            .unwrap()
            .recv_timeout(std::time::Duration::from_secs(3))
            .unwrap();
        Ok(())
    }
}
#[test]
fn concurrent_replacement_survives_single_and_all_shutdown_io() {
    for all in [false, true] {
        let mut s = testutil::test_session();
        s.id = uuid();
        let id = s.id.clone();
        let engine = Arc::new(testutil::test_engine_with(s));
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let old = Arc::new(WaitingShutdown {
            entered: entered_tx,
            release: Mutex::new(release_rx),
            engine: Arc::downgrade(&engine),
        });
        let (retired, _) = engine
            .install_runtime_connection(&fake_accounts(), id.clone(), old, model(), enabled_caps())
            .unwrap();
        let worker = engine.clone();
        let worker_id = id.clone();
        let stop = std::thread::spawn(move || {
            if all {
                worker.shutdown_runtimes()
            } else {
                worker.shutdown_runtime(&worker_id).unwrap()
            }
        });
        entered_rx
            .recv_timeout(std::time::Duration::from_secs(3))
            .unwrap();
        let calls = Arc::new(Mutex::new(Vec::new()));
        let current = Arc::new(MockConnection {
            engine: Arc::downgrade(&engine),
            calls: calls.clone(),
        }) as Arc<dyn RuntimeSessionControl>;
        let (producer, _) = engine
            .install_runtime_connection(
                &fake_accounts(),
                id.clone(),
                current.clone(),
                model(),
                enabled_caps(),
            )
            .unwrap();
        release_tx.send(()).unwrap();
        stop.join().unwrap();
        assert!(Arc::ptr_eq(
            engine.runtime_connections.lock().unwrap().get(&id).unwrap(),
            &current
        ));
        assert!(calls.lock().unwrap().is_empty());
        assert!(engine
            .with_session(&id, |s| s.runtime_generation.as_ref()
                == Some(&producer.generation))
            .unwrap());
        let event = || events::RuntimeEventPayload::Capabilities {
            capabilities: enabled_caps(),
        };
        assert!(engine
            .runtime_event(&fake_accounts(), &retired, 1, None, None, event())
            .is_err());
        assert!(engine
            .runtime_event(&fake_accounts(), &producer, 1, None, None, event())
            .is_ok());
    }
}

#[test]
fn accepted_run_state_survives_a_later_capabilities_publish() {
    let mut session = testutil::test_session();
    session.id = uuid();
    let id = session.id.clone();
    let engine = Arc::new(testutil::test_engine_with(session));
    let c = Arc::new(MockConnection {
        engine: Arc::downgrade(&engine),
        calls: Arc::new(Mutex::new(Vec::new())),
    }) as Arc<dyn RuntimeSessionControl>;
    let (producer, _) = engine
        .install_runtime_connection(&fake_accounts(), id.clone(), c, model(), enabled_caps())
        .unwrap();

    let batch = engine
        .runtime_event(
            &fake_accounts(),
            &producer,
            1,
            None,
            None,
            events::RuntimeEventPayload::RunState {
                state: events::RuntimeRunState::Running,
            },
        )
        .unwrap();
    assert!(matches!(batch.as_slice(), [SessionEvent::Meta { .. }, _]));
    assert!(engine
        .with_session(&id, |s| s.status == status::RUNNING)
        .unwrap());

    // A later, unrelated `capabilities` publish must NOT revert the status
    // it just observed — the CRITICAL this regresses.
    let batch = engine
        .runtime_event(
            &fake_accounts(),
            &producer,
            2,
            None,
            None,
            events::RuntimeEventPayload::Capabilities {
                capabilities: enabled_caps(),
            },
        )
        .unwrap();
    let core = engine
        .with_session(&id, |s| {
            serde_json::to_value(s.meta(&fake_accounts())).unwrap()
        })
        .unwrap();
    assert_eq!(core["status"], status::RUNNING);
    let ui = serde_json::to_value(&batch[0]).unwrap();
    assert_eq!(ui["meta"], core);
}

#[test]
fn accepted_failure_survives_a_later_capabilities_publish() {
    let mut session = testutil::test_session();
    session.id = uuid();
    let id = session.id.clone();
    let engine = Arc::new(testutil::test_engine_with(session));
    let c = Arc::new(MockConnection {
        engine: Arc::downgrade(&engine),
        calls: Arc::new(Mutex::new(Vec::new())),
    }) as Arc<dyn RuntimeSessionControl>;
    let (producer, _) = engine
        .install_runtime_connection(&fake_accounts(), id.clone(), c, model(), enabled_caps())
        .unwrap();
    let failure = crate::ipc::RuntimeFailure::validated(
        "runtime",
        "RUNTIME_EXITED",
        "the child exited",
        false,
        None,
        None,
    )
    .unwrap();

    engine
        .runtime_event(
            &fake_accounts(),
            &producer,
            1,
            None,
            None,
            events::RuntimeEventPayload::Failure { failure },
        )
        .unwrap();
    assert!(engine
        .with_session(&id, |s| s.status == status::ERROR
            && s.error_message.as_deref() == Some("the child exited"))
        .unwrap());

    // A later, unrelated `capabilities` publish must NOT clear the failure
    // it just observed — the CRITICAL this regresses.
    let batch = engine
        .runtime_event(
            &fake_accounts(),
            &producer,
            2,
            None,
            None,
            events::RuntimeEventPayload::Capabilities {
                capabilities: enabled_caps(),
            },
        )
        .unwrap();
    let core = engine
        .with_session(&id, |s| {
            serde_json::to_value(s.meta(&fake_accounts())).unwrap()
        })
        .unwrap();
    assert_eq!(core["status"], status::ERROR);
    assert_eq!(core["errorMessage"], "the child exited");
    let ui = serde_json::to_value(&batch[0]).unwrap();
    assert_eq!(ui["meta"], core);
}

/// pi-rpc-sessions FR-4/FR-8: `runtime_event_for_session` is what a
/// connection's OWN reader thread calls (it holds no `RuntimeProducer`
/// of its own) — confirm it round-trips to the SAME generation
/// `install_runtime_connection` minted, and that once the connection is
/// retired it fails with the same "retired" error `runtime_event` itself
/// raises for a stale generation, rather than panicking or silently
/// dropping the event.
#[test]
fn runtime_event_for_session_round_trips_the_current_generation_then_retires() {
    let mut session = testutil::test_session();
    session.id = uuid();
    let id = session.id.clone();
    let engine = Arc::new(testutil::test_engine_with(session));
    let c = Arc::new(MockConnection {
        engine: Arc::downgrade(&engine),
        calls: Arc::new(Mutex::new(Vec::new())),
    }) as Arc<dyn RuntimeSessionControl>;
    let (producer, _) = engine
        .install_runtime_connection(&fake_accounts(), id.clone(), c, model(), enabled_caps())
        .unwrap();

    let (batch, block) = engine
        .runtime_event_for_session(
            &fake_accounts(),
            &id,
            1,
            None,
            None,
            events::RuntimeEventPayload::RunState {
                state: events::RuntimeRunState::Running,
            },
        )
        .unwrap();
    assert!(matches!(batch.as_slice(), [SessionEvent::Meta { .. }, _]));
    assert!(block.is_none()); // run.state settles no transcript block
    assert!(engine
        .with_session(&id, |s| s.runtime_generation.as_deref()
            == Some(producer.generation.as_str()))
        .unwrap());
    assert!(engine
        .with_session(&id, |s| s.status == status::RUNNING)
        .unwrap());

    engine.shutdown_runtime(&id).unwrap();
    let result = engine.runtime_event_for_session(
        &fake_accounts(),
        &id,
        2,
        None,
        None,
        events::RuntimeEventPayload::RunState {
            state: events::RuntimeRunState::Idle,
        },
    );
    let err = match result {
        Err(e) => e,
        Ok(_) => panic!("expected the retired producer to be rejected"),
    };
    assert_eq!(err.code, ErrorCode::RuntimeUnavailable);
    assert!(err.message.contains("retired"));
}

/// pi-transcript-events (review remediation): `runtime_event_for_session`
/// reads back the settled block off `Session.block_buffer` for exactly
/// the events `transcript_persist_id` names — a `ToolUpdate` in a
/// non-terminal status (`pending`) must read back `None` (visible live,
/// nothing to persist yet), and the SAME call id settling
/// (`succeeded`) must read back `Some` with the block's own `blockId`.
#[test]
fn tool_update_for_session_reads_back_no_block_while_pending_and_the_settled_block_once_it_succeeds(
) {
    let mut session = testutil::test_session();
    session.id = uuid();
    let id = session.id.clone();
    let engine = Arc::new(testutil::test_engine_with(session));
    let c = Arc::new(MockConnection {
        engine: Arc::downgrade(&engine),
        calls: Arc::new(Mutex::new(Vec::new())),
    }) as Arc<dyn RuntimeSessionControl>;
    engine
        .install_runtime_connection(&fake_accounts(), id.clone(), c, model(), enabled_caps())
        .unwrap();

    let pending_call = events::RuntimeToolCall {
        id: "t1".into(),
        name: "Read".into(),
        status: "pending".into(),
        input_text: String::new(),
        output_text: String::new(),
        input_truncated: false,
        output_truncated: false,
        started_at: None,
        completed_at: None,
    };
    let (_, block) = engine
        .runtime_event_for_session(
            &fake_accounts(),
            &id,
            1,
            None,
            None,
            events::RuntimeEventPayload::ToolUpdate {
                block_id: "b1".into(),
                tool: pending_call,
            },
        )
        .unwrap();
    assert!(
        block.is_none(),
        "a pending tool call has nothing to persist yet"
    );

    let succeeded_call = events::RuntimeToolCall {
        id: "t1".into(),
        name: "Read".into(),
        status: "succeeded".into(),
        input_text: serde_json::json!({ "file_path": "/x/a.rs" }).to_string(),
        output_text: "contents".into(),
        input_truncated: false,
        output_truncated: false,
        started_at: Some(0),
        completed_at: Some(10),
    };
    let (_, block) = engine
        .runtime_event_for_session(
            &fake_accounts(),
            &id,
            2,
            None,
            None,
            events::RuntimeEventPayload::ToolUpdate {
                block_id: "b1".into(),
                tool: succeeded_call,
            },
        )
        .unwrap();
    let block = block.expect("a terminal tool status settles the block for persistence");
    assert_eq!(block.block_id, "b1");
    assert_eq!(
        engine.with_session(&id, |s| s.block_buffer.len()).unwrap(),
        1
    );
}
