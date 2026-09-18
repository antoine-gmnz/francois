//! Session-scoped connections and capability enforcement.
use super::*;

/// Core-minted producer identity, retained by one connection's reader.
#[allow(dead_code)]
pub(crate) struct RuntimeProducer {
    session_id: String,
    generation: String,
}

impl Engine {
    pub(crate) fn require_capability(
        &self,
        id: &str,
        key: &str,
    ) -> Result<(), (ErrorCode, &'static str)> {
        if self
            .unsupported_runtime_records
            .lock()
            .unwrap()
            .contains_key(id)
        {
            return Err((
                ErrorCode::RuntimeUnsupported,
                "unsupported runtime record retained for recovery",
            ));
        }
        self.with_session(id, |s| {
            adapter::resolve_capability(s.agent_runtime, s.effective_capabilities.as_ref(), key)
        })
        .ok_or((ErrorCode::SessionNotFound, "no such session"))?
        .then_some(())
        .ok_or((
            ErrorCode::RuntimeUnsupported,
            "runtime capability is unavailable",
        ))
    }
    #[allow(dead_code)]
    pub(crate) fn connect_runtime(
        &self,
        accounts: &dyn crate::account::AccountKinds,
        ctx: adapter::RuntimeConnectContext,
        runtime: AgentRuntime,
    ) -> Result<(RuntimeProducer, Vec<SessionEvent>), AppError> {
        let ctx = ctx.validate()?;
        let id = ctx.session_id.clone();
        let model = ctx.model.clone();
        let connection = adapter_for(runtime).connect_session(ctx)?;
        let capabilities = connection.capabilities();
        self.install_runtime_connection(accounts, id, connection, model, capabilities)
    }
    #[allow(dead_code)]
    pub(crate) fn install_runtime_connection(
        &self,
        accounts: &dyn crate::account::AccountKinds,
        id: String,
        connection: Arc<dyn adapter::RuntimeSessionControl>,
        model: adapter::RuntimeModelRef,
        capabilities: RuntimeCapabilities,
    ) -> Result<(RuntimeProducer, Vec<SessionEvent>), AppError> {
        let sequence = match model
            .validate()
            .and_then(|()| adapter::validate_capabilities(&capabilities))
            .and_then(|()| events::RuntimeEventSequence::new(id.clone()))
        {
            Ok(sequence) => sequence,
            Err(error) => {
                let _ = connection.shutdown();
                return Err(error);
            }
        };
        let generation = sequence.generation().to_string();
        let mut streams = self.runtime_events.lock().unwrap();
        let meta = self.with_session_mut(&id, |s| {
            s.runtime_generation = Some(generation.clone());
            s.runtime_model = Some(model);
            s.effective_capabilities = Some(capabilities);
            s.meta(accounts)
        });
        let Some(meta) = meta else {
            drop(streams);
            let _ = connection.shutdown();
            return Err(AppError::runtime(
                crate::ipc::RuntimeErrorCode::NotFound,
                "no such session",
            ));
        };
        streams.insert(id.clone(), sequence);
        let previous = self
            .runtime_connections
            .lock()
            .unwrap()
            .insert(id.clone(), connection);
        drop(streams);
        if let Some(previous) = previous {
            let _ = previous.shutdown();
        }
        Ok((
            RuntimeProducer {
                session_id: id,
                generation,
            },
            vec![SessionEvent::Meta { meta }],
        ))
    }
    #[allow(dead_code)]
    pub(crate) fn submit_runtime(
        &self,
        id: &str,
        input: adapter::RuntimeSubmission,
    ) -> Result<adapter::SubmissionReceipt, AppError> {
        let connection = self.runtime_connections.lock().unwrap().get(id).cloned();
        connection
            .ok_or_else(|| {
                AppError::runtime(
                    crate::ipc::RuntimeErrorCode::Unavailable,
                    "runtime is not connected",
                )
            })?
            .submit(input)
    }
    pub(crate) fn cancel_runtime(&self, id: &str) -> Result<(), AppError> {
        let connection = self.runtime_connections.lock().unwrap().get(id).cloned();
        if let Some(connection) = connection {
            connection.cancel()?;
        }
        Ok(())
    }
    pub(crate) fn shutdown_runtime(&self, id: &str) -> Result<(), AppError> {
        let mut streams = self.runtime_events.lock().unwrap();
        streams.remove(id);
        self.with_session_mut(id, |s| {
            s.runtime_generation = None;
            s.effective_capabilities = None;
        });
        let connection = self.runtime_connections.lock().unwrap().remove(id);
        drop(streams);
        if let Some(connection) = connection {
            connection.shutdown()?;
        }
        Ok(())
    }
    pub(crate) fn shutdown_runtimes(&self) {
        let mut streams = self.runtime_events.lock().unwrap();
        streams.clear();
        for session in self.sessions.lock().unwrap().values_mut() {
            session.runtime_generation = None;
            session.effective_capabilities = None;
        }
        let connections: Vec<_> = self
            .runtime_connections
            .lock()
            .unwrap()
            .drain()
            .map(|(_, c)| c)
            .collect();
        drop(streams);
        for connection in connections {
            let _ = connection.shutdown();
        }
    }

    #[allow(dead_code)]
    pub(crate) fn runtime_event(
        &self,
        accounts: &dyn crate::account::AccountKinds,
        producer: &RuntimeProducer,
        at: u64,
        run_id: Option<String>,
        request_id: Option<String>,
        event: events::RuntimeEventPayload,
    ) -> Result<Vec<SessionEvent>, AppError> {
        let mut streams = self.runtime_events.lock().unwrap();
        let sequence = streams
            .get_mut(&producer.session_id)
            .filter(|s| s.generation() == producer.generation)
            .ok_or_else(|| {
                AppError::runtime(
                    crate::ipc::RuntimeErrorCode::Unavailable,
                    "runtime event producer is retired",
                )
            })?;
        // Snapshot the accepted event BEFORE `sequence.next` moves it, so a
        // run-state/failure mutation is only ever applied once the envelope
        // (correlation ids, safe-integer bounds, capability shape) validated —
        // an invalid envelope must leave the session untouched.
        let accepted = event.clone();
        let envelope = sequence.next(at, run_id, request_id, event)?;
        let mut batch = Vec::new();
        // pi-runtime-boundary: `run.state`/`failure` events settle the matching
        // Session's status/error BEFORE any later event (e.g. `capabilities`)
        // publishes `session.meta` — otherwise that later publish re-serializes
        // the session's now-stale status and reverts a running turn or clears
        // an in-flight failure message.
        let meta = match accepted {
            events::RuntimeEventPayload::Capabilities { capabilities } => {
                self.with_session_mut(&producer.session_id, |s| {
                    s.effective_capabilities = Some(capabilities);
                    s.meta(accounts)
                })
            }
            events::RuntimeEventPayload::RunState { state } => {
                self.with_session_mut(&producer.session_id, |s| {
                    let next = state.session_status();
                    s.status = next.into();
                    if next != status::ERROR {
                        s.error_message = None;
                    }
                    s.meta(accounts)
                })
            }
            events::RuntimeEventPayload::Failure { failure } => {
                self.with_session_mut(&producer.session_id, |s| {
                    s.status = status::ERROR.into();
                    s.error_message = Some(failure.message().to_string());
                    s.meta(accounts)
                })
            }
        };
        if let Some(meta) = meta {
            batch.push(SessionEvent::Meta { meta });
        }
        batch.push(envelope);
        Ok(batch)
    }
}

#[cfg(test)]
mod connection_tests {
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
                .install_runtime_connection(
                    &fake_accounts(),
                    id.clone(),
                    old,
                    model(),
                    enabled_caps(),
                )
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
}
