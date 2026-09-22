//! Current-turn reply authority; controls never publish under the caller's lock.
use super::{
    protocol,
    requests::{NativeDecision, PreparedReply, RequestError, RequestKind},
    runtime::Inner,
    transport::Transport,
};
use crate::session::application::*;
use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::{Arc, Weak};

pub(super) struct Control {
    pub inner: Weak<Inner>,
    pub scope: RuntimeScope,
}
impl Control {
    fn send(&self, reply: PreparedReply, connection: Arc<Transport>) -> ControlAck {
        if let Err(error) = connection.write(reply.wire()) {
            let weak = self.inner.clone();
            std::thread::spawn(move || {
                if let Some(inner) = weak.upgrade() {
                    inner.connection_lost(error);
                }
            });
            return ControlAck::ChannelClosed;
        }
        // Cancel is already the native decision; no fabricated Deny and no
        // duplicate interrupt request is needed to implement that choice.
        ControlAck::AwaitingConfirmation
    }
}
impl TurnControl for Control {
    fn interrupt(&self) {
        let Some(inner) = self.inner.upgrade() else {
            return;
        };
        inner.interrupt(&self.scope);
    }
    fn kill(&self) {
        let Some(inner) = self.inner.upgrade() else {
            return;
        };
        inner.interrupt(&self.scope);
        let mut state = inner.state.lock().unwrap();
        if let Some(turn) = state
            .turn
            .as_mut()
            .filter(|turn| turn.context.scope == self.scope)
        {
            turn.retired = true;
            if !turn.start_sent {
                turn.finished = true;
            }
        }
    }
    fn answer_question(&self, id: &str, answers: &Value) -> ControlAck {
        let Some(inner) = self.inner.upgrade() else {
            return ControlAck::NotPending;
        };
        let Ok(answers) = serde_json::from_value::<BTreeMap<String, String>>(answers.clone())
        else {
            return ControlAck::InvalidAnswer;
        };
        let prepared = {
            let mut state = inner.state.lock().unwrap();
            if state.closed {
                return ControlAck::NotPending;
            }
            let Some(scope) = state
                .turn
                .as_ref()
                .filter(|turn| turn.context.scope == self.scope && !turn.finished && !turn.retired)
                .and_then(|turn| turn.native.clone())
            else {
                return ControlAck::NotPending;
            };
            let Some(connection) = state.transport.clone() else {
                return ControlAck::ChannelClosed;
            };
            let Some(ledger) = state.ledger.as_mut() else {
                return ControlAck::NotPending;
            };
            match ledger.claim_answers(&scope, id, answers) {
                Ok(reply) => (reply, connection),
                Err(RequestError::InvalidAnswer) => return ControlAck::InvalidAnswer,
                Err(_) => return ControlAck::NotPending,
            }
        };
        self.send(prepared.0, prepared.1)
    }
    fn decide_permission(&self, id: &str, decision: PermissionDecision) -> ControlAck {
        let Some(inner) = self.inner.upgrade() else {
            return ControlAck::NotPending;
        };
        let decision = match decision {
            PermissionDecision::Allow => NativeDecision::Accept,
            PermissionDecision::Deny => NativeDecision::Decline,
            PermissionDecision::Cancel => NativeDecision::Cancel,
        };
        let prepared = {
            let mut state = inner.state.lock().unwrap();
            if state.closed {
                return ControlAck::NotPending;
            }
            let Some(scope) = state
                .turn
                .as_ref()
                .filter(|turn| turn.context.scope == self.scope && !turn.finished && !turn.retired)
                .and_then(|turn| turn.native.clone())
            else {
                return ControlAck::NotPending;
            };
            let Some(connection) = state.transport.clone() else {
                return ControlAck::ChannelClosed;
            };
            let Some(ledger) = state.ledger.as_mut() else {
                return ControlAck::NotPending;
            };
            match ledger.claim_permission(&scope, id, decision) {
                Ok(reply) => (reply, connection),
                Err(RequestError::UnsupportedDecision) => return ControlAck::Unsupported,
                Err(_) => return ControlAck::NotPending,
            }
        };
        self.send(prepared.0, prepared.1)
    }
    fn pending_permission_pattern(&self, _id: &str) -> Option<String> {
        None
    }
    fn pending_counts(&self) -> PendingCounts {
        let Some(inner) = self.inner.upgrade() else {
            return PendingCounts::default();
        };
        let state = inner.state.lock().unwrap();
        if state.closed
            || !state.turn.as_ref().is_some_and(|turn| {
                turn.context.scope == self.scope && !turn.finished && !turn.retired
            })
        {
            return PendingCounts::default();
        }
        let mut counts = PendingCounts::default();
        if let Some(ledger) = &state.ledger {
            for request in ledger.pending() {
                match request.kind {
                    RequestKind::Questions(_) => {
                        if request.is_blocking() {
                            counts.questions += 1;
                        }
                    }
                    _ => counts.permissions += 1,
                }
            }
        }
        counts
    }
    fn drain_pending(&self) -> (Vec<String>, Vec<String>) {
        let Some(inner) = self.inner.upgrade() else {
            return (vec![], vec![]);
        };
        let mut state = inner.state.lock().unwrap();
        if !state
            .turn
            .as_ref()
            .is_some_and(|turn| turn.context.scope == self.scope)
        {
            return (vec![], vec![]);
        }
        let mut questions = vec![];
        let mut permissions = vec![];
        if let Some(ledger) = &mut state.ledger {
            for resolution in ledger.drain() {
                if resolution.is_question {
                    questions.push(resolution.block_id);
                } else {
                    permissions.push(resolution.block_id);
                }
            }
        }
        (questions, permissions)
    }
}
impl Inner {
    pub(super) fn interrupt(self: &Arc<Self>, scope: &RuntimeScope) {
        let ready = {
            let mut state = self.state.lock().unwrap();
            if state.closed {
                return;
            }
            let Some(turn) = state
                .turn
                .as_mut()
                .filter(|turn| turn.context.scope == *scope && !turn.finished)
            else {
                return;
            };
            if !turn.interrupt.request() {
                return;
            }
            turn.native.clone().zip(state.transport.clone())
        };
        if let Some((scope, connection)) = ready {
            Self::send_interrupt(self, scope, connection);
        }
    }
    pub(super) fn send_interrupt(
        self: &Arc<Self>,
        scope: super::requests::NativeScope,
        connection: Arc<Transport>,
    ) {
        let weak = Arc::downgrade(self);
        std::thread::spawn(move || {
            let result = connection.call(Transport::deadline(), |id| {
                Ok(protocol::interrupt(id, &scope.thread_id, &scope.turn_id))
            });
            if let Err(error) = result {
                if let Some(inner) = weak.upgrade() {
                    if error.code == crate::ipc::ErrorCode::SessionNotRunning {
                        let mut state = inner.state.lock().unwrap();
                        if let Some(turn) = state
                            .turn
                            .as_mut()
                            .filter(|turn| !turn.finished && turn.native.as_ref() == Some(&scope))
                        {
                            turn.interrupt.not_active();
                        }
                        return;
                    }
                    let still_active = inner
                        .state
                        .lock()
                        .unwrap()
                        .turn
                        .as_ref()
                        .is_some_and(|turn| !turn.finished && turn.native.as_ref() == Some(&scope));
                    if still_active {
                        inner.connection_lost(error);
                    }
                }
            }
        });
    }
}
