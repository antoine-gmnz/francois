//! Ordered native notifications and server requests for the current turn only.
use super::{
    events,
    protocol::{self, RequestId},
    requests::{NativeScope, RequestError, RequestLedger},
    runtime::Inner,
    transport,
};
use crate::session::application::RuntimeEvent;
use serde_json::Value;
use std::sync::Arc;

impl Inner {
    pub(super) fn server_request(self: &Arc<Self>, id: RequestId, method: &str, params: Value) {
        let (connection, emission) = {
            let mut state = self.state.lock().unwrap();
            if state.closed {
                return;
            }
            let Some(connection) = state.transport.clone() else {
                return;
            };
            let current = state
                .turn
                .as_ref()
                .filter(|turn| !turn.finished && !turn.retired)
                .and_then(|turn| {
                    turn.native
                        .clone()
                        .map(|scope| (scope, turn.emitter.clone(), turn.context.cwd.clone()))
                });
            let emission = if let Some((scope, emitter, cwd)) = current {
                state
                    .ledger
                    .as_mut()
                    .map(|ledger| ledger.insert(&scope, id.clone(), method, params))
                    .map(|result| match result {
                        Ok(request) => Ok((emitter, events::asked(&request, &cwd))),
                        Err(error) => Err(error),
                    })
            } else {
                None
            };
            (connection, emission)
        };
        match emission {
            Some(Ok((emitter, event))) => {
                if let Err(error) = emitter.publish(event) {
                    self.connection_lost(error);
                }
            }
            // Replays have no new reply authority: do not write a second response.
            Some(Err(RequestError::Replay)) => {}
            _ => {
                if let Err(error) = connection.write(&protocol::unsupported_request(&id)) {
                    self.connection_lost(error);
                }
            }
        }
    }
    pub(super) fn notification(self: &Arc<Self>, method: &str, params: &Value) {
        let mut output = vec![];
        let mut interrupt = None;
        let emitter = {
            let mut state = self.state.lock().unwrap();
            if state.closed {
                return;
            }
            let Some(thread_id) = state.thread_id.clone() else {
                return;
            };
            if params["threadId"].as_str() != Some(thread_id.as_str()) {
                return;
            }
            if method == "turn/started" {
                let Some(id) = params["turn"]["id"].as_str().filter(|id| !id.is_empty()) else {
                    drop(state);
                    self.connection_lost(transport::protocol_error());
                    return;
                };
                if state.completed_turns.contains(id) {
                    return;
                }
                let Some(turn) = state
                    .turn
                    .as_mut()
                    .filter(|turn| !turn.finished && turn.start_sent)
                else {
                    return;
                };
                if turn
                    .native
                    .as_ref()
                    .is_some_and(|scope| scope.turn_id != id)
                {
                    return;
                }
                let scope = NativeScope {
                    session_id: turn.context.session_id.clone(),
                    generation: turn.context.scope.generation,
                    thread_id: thread_id.clone(),
                    turn_id: id.into(),
                };
                let first = turn.native.is_none();
                if first {
                    output.push(RuntimeEvent::StreamLive);
                    output.push(RuntimeEvent::PromptDelivered(turn.context.response_mode));
                }
                turn.native = Some(scope.clone());
                let should_interrupt = turn.interrupt.started();
                if first {
                    if let Some(ledger) = &mut state.ledger {
                        if ledger.advance_turn(scope.clone()).is_err() {
                            drop(state);
                            self.connection_lost(transport::protocol_error());
                            return;
                        }
                    } else {
                        state.ledger = Some(RequestLedger::new(scope.clone()));
                    }
                }
                if should_interrupt {
                    interrupt = state
                        .transport
                        .clone()
                        .map(|connection| (scope, connection));
                }
            }
            let Some(turn) = state.turn.as_ref() else {
                return;
            };
            let Some(scope) = turn.native.clone() else {
                return;
            };
            if turn.finished {
                return;
            }
            let emitter = turn.emitter.clone();
            if method == "serverRequest/resolved" {
                let Ok(id) = RequestId::parse(&params["requestId"]) else {
                    return;
                };
                if let Some(resolution) = state
                    .ledger
                    .as_mut()
                    .and_then(|ledger| ledger.resolve(&scope, &id))
                {
                    output.push(events::resolved(resolution));
                }
            } else {
                let native_turn = if method == "turn/started" || method == "turn/completed" {
                    params["turn"]["id"].as_str()
                } else {
                    params["turnId"].as_str()
                };
                if native_turn != Some(scope.turn_id.as_str()) {
                    return;
                }
                match method {
                    "turn/started" => {}
                    "item/started" | "item/completed" => {
                        if params["item"]["type"] == "fileChange" {
                            if let Some(ledger) = &mut state.ledger {
                                let _ = ledger.observe_file_item(&scope, params["item"].clone());
                            }
                        }
                        let turn = state.turn.as_mut().unwrap();
                        output.extend(turn.items.item(
                            &params["item"],
                            method == "item/completed",
                            &turn.context,
                        ));
                    }
                    "item/agentMessage/delta" => {
                        if let (Some(id), Some(delta)) =
                            (params["itemId"].as_str(), params["delta"].as_str())
                        {
                            if let Some(event) = state.turn.as_mut().unwrap().items.delta(id, delta)
                            {
                                output.push(event);
                            }
                        }
                    }
                    "thread/tokenUsage/updated" => {
                        let usage = &params["tokenUsage"];
                        output.push(RuntimeEvent::Usage {
                            context_used_tokens: usage["last"]["totalTokens"].as_u64(),
                            input_tokens: usage["total"]["inputTokens"].as_u64(),
                            output_tokens: usage["total"]["outputTokens"].as_u64(),
                            cost: None,
                        });
                    }
                    "turn/completed" => {
                        let turn = state.turn.as_mut().unwrap();
                        turn.finished = true;
                        turn.interrupt.completed();
                        output.extend(turn.items.close(&turn.context));
                        if let Some(ledger) = &mut state.ledger {
                            output.extend(ledger.drain().into_iter().map(events::resolved));
                        }
                        state.completed_turns.insert(scope.turn_id);
                        output.push(if params["turn"]["status"] == "failed" {
                            RuntimeEvent::TurnFailed(transport::protocol_error())
                        } else {
                            RuntimeEvent::TurnFinished
                        });
                    }
                    "error" => {
                        if params["willRetry"] != true {
                            output.push(RuntimeEvent::TurnFailed(transport::protocol_error()));
                        }
                    }
                    _ => {}
                }
            }
            emitter
        };
        for event in output {
            if let Err(error) = emitter.publish(event) {
                self.connection_lost(error);
                break;
            }
        }
        if let Some((scope, connection)) = interrupt {
            Self::send_interrupt(self, scope, connection);
        }
    }
}
