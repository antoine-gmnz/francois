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
        app: &tauri::AppHandle,
        accounts: &dyn crate::account::AccountKinds,
        ctx: adapter::RuntimeConnectContext,
        runtime: AgentRuntime,
    ) -> Result<(RuntimeProducer, Vec<SessionEvent>), AppError> {
        let ctx = ctx.validate()?;
        let id = ctx.session_id.clone();
        let model = ctx.model.clone();
        let connection = adapter_for(runtime).connect_session(app, ctx)?;
        let capabilities = connection.capabilities();
        self.install_runtime_connection(accounts, id, connection, model, capabilities)
    }

    /// pi-rpc-sessions FR-4: what a connection's OWN background reader calls
    /// to publish a `run.state`/`failure` envelope — re-deriving the
    /// session's CURRENT generation from `runtime_events` on every call
    /// rather than caching one, so it can never go stale across a reconnect
    /// (the connection itself is built by `connect_session`, before
    /// `install_runtime_connection` has even minted a `RuntimeProducer`).
    ///
    /// pi-transcript-events FR-6: also returns the `BufBlock` this event just
    /// settled in the session's own transcript buffer, if any — `None` for
    /// every event that carries no persistable finalization (run.state,
    /// capabilities, failure, a still-open assistant/tool block). The caller
    /// (`AppPublisher::publish`, which alone holds the `AppHandle`) is what
    /// then calls `persistence::append_transcript` with it — this method has
    /// no I/O of its own, same as `runtime_event`.
    ///
    /// HIGH (review round 7): the block is what the `buf_*_pi` helper itself
    /// hands back (their own pre-trim clone), never a re-`find` by id after
    /// the fact — settling a block is exactly what unpins `trim_transcript`,
    /// so a re-find after the apply returns `None` for precisely the block
    /// the trim just evicted, and that settled block is never persisted.
    #[allow(dead_code)]
    pub(crate) fn runtime_event_for_session(
        &self,
        accounts: &dyn crate::account::AccountKinds,
        session_id: &str,
        at: u64,
        run_id: Option<String>,
        request_id: Option<String>,
        event: events::RuntimeEventPayload,
    ) -> Result<(Vec<SessionEvent>, Option<BufBlock>), AppError> {
        let generation = self
            .runtime_events
            .lock()
            .unwrap()
            .get(session_id)
            .map(|s| s.generation().to_string())
            .ok_or_else(|| {
                AppError::runtime(
                    crate::ipc::RuntimeErrorCode::Unavailable,
                    "runtime event producer is retired",
                )
            })?;
        let producer = RuntimeProducer {
            session_id: session_id.to_string(),
            generation,
        };
        let mut settled = None;
        let batch = self.runtime_event_settling(
            accounts,
            &producer,
            at,
            run_id,
            request_id,
            event,
            &mut settled,
        )?;
        Ok((batch, settled))
    }
    /// pi-rpc-sessions FR-8: the session's CURRENT generation, for
    /// diagnostics logging only (`pi-rpc.log`'s `generation=` field) — `None`
    /// once the connection has been retired/replaced, in which case a caller
    /// logs `"-"` rather than a stale generation.
    pub(crate) fn generation_for_session(&self, session_id: &str) -> Option<String> {
        self.runtime_events
            .lock()
            .unwrap()
            .get(session_id)
            .map(|s| s.generation().to_string())
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
    /// pi-models-metrics: the live connection for a session, if any — what
    /// `session_switch_model`/`session_switch_effort`/`session_metrics`'s Pi
    /// branches dispatch `switch_model`/`read_metrics` through. Same shape as
    /// `submit_runtime`/`cancel_runtime`'s own lookup.
    pub(crate) fn runtime_connection_for(
        &self,
        id: &str,
    ) -> Option<Arc<dyn adapter::RuntimeSessionControl>> {
        self.runtime_connections.lock().unwrap().get(id).cloned()
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
        self.runtime_event_settling(accounts, producer, at, run_id, request_id, event, &mut None)
    }

    /// `runtime_event`, plus the ONE out-parameter its transcript arms have to
    /// hand back: the `BufBlock` a `buf_*_pi` helper just settled, captured by
    /// the helper itself before its own trim. Private, so every caller that
    /// does not persist keeps `runtime_event`'s simpler signature.
    #[allow(clippy::too_many_arguments)]
    fn runtime_event_settling(
        &self,
        accounts: &dyn crate::account::AccountKinds,
        producer: &RuntimeProducer,
        at: u64,
        run_id: Option<String>,
        request_id: Option<String>,
        event: events::RuntimeEventPayload,
        settled: &mut Option<BufBlock>,
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
        // pi-turn-controls FR-3: set inside the `MessageUser` arm below when a
        // consumed user message actually settled a pending admission — never
        // by matching text, only by the echoed `clientMessageId` or, failing
        // that, admission order (`AdmissionLedger::mark_consumed`).
        let mut admission_consumed = false;
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
            // pi-transcript-events §5/FR-6: the five transcript-normalization
            // variants (`message.user` .. `notice`) carry no session-level
            // status/capability mutation of their own — a `session.meta`
            // re-publish here would be a no-op (`meta` stays `None`). They
            // DO fold into the session's own `block_buffer`, so
            // `conversation_get_transcript`/a reload sees exactly what the
            // live envelope just showed — `runtime_event_for_session` reads
            // the settled block back out afterward for the caller to persist.
            events::RuntimeEventPayload::MessageUser {
                block_id,
                text,
                attachments,
                client_message_id,
            } => {
                *settled = self.with_session_mut(&producer.session_id, |s| {
                    s.buf_message_user_pi(&block_id, text, attachments)
                });
                // pi-turn-controls FR-3: this is the ONLY signal the ledger
                // trusts to settle an admission "consumed", and the echoed
                // `clientMessageId` `normalize` parsed off this very event is
                // the only EXACT association there is — admission order is
                // not wire order, so oldest-first (the fallback, for an echo
                // that names nothing) settles the wrong row whenever Pi
                // consumes out of order. Never by matching text.
                if self
                    .with_admissions(&producer.session_id, |l| {
                        l.mark_consumed(client_message_id.as_deref())
                    })
                    .is_some()
                {
                    admission_consumed = true;
                }
                None
            }
            events::RuntimeEventPayload::AssistantDelta { block_id, text, .. } => {
                self.with_session_mut(&producer.session_id, |s| {
                    s.buf_assistant_streaming(&block_id, &text, &text);
                });
                None
            }
            events::RuntimeEventPayload::AssistantComplete {
                block_id,
                text,
                outcome,
            } => {
                *settled = self
                    .with_session_mut(&producer.session_id, |s| {
                        s.finish_assistant_pi(&block_id, text, &outcome)
                    })
                    .flatten();
                None
            }
            events::RuntimeEventPayload::ToolUpdate { block_id, tool } => {
                // `None` while the call is still pending/running: visible live
                // through the envelope below, nothing to persist until it
                // settles (the helper owns that rule).
                *settled = self
                    .with_session_mut(&producer.session_id, |s| {
                        s.buf_tool_update_pi(&block_id, tool)
                    })
                    .flatten();
                None
            }
            events::RuntimeEventPayload::Notice {
                block_id,
                tone,
                text,
            } => {
                *settled = self.with_session_mut(&producer.session_id, |s| {
                    s.buf_notice_pi(&block_id, tone, text)
                });
                None
            }
            // pi-models-metrics (lead clarification): NO session-level
            // mutation or `session.meta` build here, unlike every arm above —
            // the caller (`apply_pi_model_switch`/`session_metrics`) mutates
            // the session directly and controls emission order itself
            // (`model.changed`/`metrics` FIRST, then the authoritative
            // `session.meta` carrying `model.efforts`/`effort`/`metrics` —
            // the frontend projects `model.changed` without efforts, so a
            // `session.meta` published from in here, ahead of it in the same
            // batch, would have its efforts clobbered by the stale ones).
            // This arm exists only so the match stays exhaustive; the call
            // reaches it purely for `runtime_event`'s validated, sequenced
            // envelope.
            events::RuntimeEventPayload::ModelChanged { .. } => None,
            events::RuntimeEventPayload::Metrics { .. } => None,
            // pi-turn-controls: none of these three carry a session-level
            // status/capability mutation of their own — `queue.changed` is
            // published EXPLICITLY (by the admissions ledger callers, or just
            // below when a `MessageUser` in this same call settled one), and
            // `compaction`/`retry` are progress notices with nothing to fold
            // onto `SessionMeta`.
            events::RuntimeEventPayload::QueueChanged { .. }
            | events::RuntimeEventPayload::Compaction { .. }
            | events::RuntimeEventPayload::Retry { .. } => None,
        };
        if let Some(meta) = meta {
            batch.push(SessionEvent::Meta { meta });
        }
        batch.push(envelope);
        // pi-turn-controls FR-3: a SECOND envelope, same sequence — the FULL
        // pending snapshot, published the instant a consumed message actually
        // left the ledger (rather than waiting for the next submit's own publish).
        if admission_consumed {
            let entries = self.with_admissions(&producer.session_id, |l| l.snapshot_pending());
            if let Ok(extra) = sequence.next(
                at,
                None,
                None,
                events::RuntimeEventPayload::QueueChanged { entries },
            ) {
                batch.push(extra);
            }
        }
        Ok(batch)
    }
}

#[cfg(test)]
#[path = "runtime_tests.rs"]
mod connection_tests;
