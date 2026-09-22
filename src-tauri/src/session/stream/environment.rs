use crate::ipc::{AppError, ErrorCode};
use crate::session::application::{
    ApplyOutcome, RuntimeEvent, RuntimeEventEnvelope, RuntimeEventSink, TurnContext,
};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// How long a run of deltas accumulates before the next one flushes it — long
/// enough to fold a fast stream into a handful of events per second, short
/// enough that the answer still reads as typing. Same figure and same reasoning
/// as the shell's `SHELL_EMIT_COALESCE`.
const ASSISTANT_DELTA_COALESCE: Duration = Duration::from_millis(8);

#[derive(Clone, Default)]
pub(crate) struct StreamSettings {
    pub cwd: String,
    pub runtime: String,
    pub allow_git: bool,
}

/// Native parsing receives immutable settings and emits semantic observations.
pub(crate) trait StreamEnvironment: Sync {
    fn settings(&self, session_id: &str) -> StreamSettings;
    fn publish(&self, event: RuntimeEvent);
    fn failure(&self) -> Option<AppError> {
        None
    }
    fn flush(&self) {}
}

struct Delta {
    block_id: String,
    text: String,
    offset: usize,
    since: Instant,
}

pub(crate) struct NativeStream {
    context: TurnContext,
    sink: Arc<dyn RuntimeEventSink>,
    sequence: Mutex<u64>,
    error: Mutex<Option<AppError>>,
    delta: Mutex<Option<Delta>>,
}
impl NativeStream {
    pub(crate) fn new(context: TurnContext, sink: Arc<dyn RuntimeEventSink>) -> Self {
        Self {
            context,
            sink,
            sequence: Mutex::new(0),
            error: Mutex::new(None),
            delta: Mutex::new(None),
        }
    }
    fn send(&self, event: RuntimeEvent) {
        if self.error.lock().unwrap().is_some() {
            return;
        }
        let mut sequence = self.sequence.lock().unwrap();
        *sequence += 1;
        let result = self.sink.publish(RuntimeEventEnvelope {
            scope: self.context.scope.clone(),
            sequence: *sequence,
            event,
        });
        let error = match result {
            Ok(ApplyOutcome::Applied | ApplyOutcome::Duplicate) => None,
            Ok(ApplyOutcome::Closed | ApplyOutcome::Stale) => Some(AppError::new(
                ErrorCode::RuntimeUnavailable,
                "Claude turn ownership ended",
            )),
            Err(error) => Some(error),
        };
        if error.is_some() {
            *self.error.lock().unwrap() = error;
        }
    }
    /// A turn whose own effect was refused (a failed native-anchor commit)
    /// still owes its owner one terminal outcome carrying that refusal;
    /// everything else after the refusal stays dropped. A turn whose ownership
    /// already ended is answered `Closed`/`Stale` by the owner — a no-op.
    pub(crate) fn fail_refused(&self) {
        let error = self.error.lock().unwrap().take();
        if let Some(error) = error {
            self.send(RuntimeEvent::TurnFailed(error));
        }
    }
}
impl StreamEnvironment for NativeStream {
    fn settings(&self, _: &str) -> StreamSettings {
        StreamSettings {
            cwd: self.context.cwd.clone(),
            runtime: self.context.runtime.clone(),
            allow_git: self.context.allow_git,
        }
    }
    fn publish(&self, event: RuntimeEvent) {
        if let RuntimeEvent::AssistantChunk {
            block_id,
            text,
            offset,
        } = event
        {
            let previous = {
                let mut pending = self.delta.lock().unwrap();
                match pending.as_mut() {
                    Some(delta)
                        if delta.block_id == block_id
                            && delta.since.elapsed() < ASSISTANT_DELTA_COALESCE =>
                    {
                        delta.text.push_str(&text);
                        None
                    }
                    _ => pending.replace(Delta {
                        block_id,
                        text,
                        offset,
                        since: Instant::now(),
                    }),
                }
            };
            if let Some(delta) = previous {
                self.send(RuntimeEvent::AssistantChunk {
                    block_id: delta.block_id,
                    text: delta.text,
                    offset: delta.offset,
                });
            }
        } else if matches!(event, RuntimeEvent::AssistantAppend { .. }) {
            self.send(event);
        } else {
            self.flush();
            self.send(event);
        }
    }
    fn failure(&self) -> Option<AppError> {
        self.error.lock().unwrap().clone()
    }
    fn flush(&self) {
        if let Some(delta) = self.delta.lock().unwrap().take() {
            self.send(RuntimeEvent::AssistantChunk {
                block_id: delta.block_id,
                text: delta.text,
                offset: delta.offset,
            });
        }
    }
}

#[cfg(any(test, feature = "harness"))]
impl<T: crate::session::SessionEnv> StreamEnvironment for T {
    fn settings(&self, id: &str) -> StreamSettings {
        self.engine()
            .with_session(id, |s| StreamSettings {
                cwd: s.cwd.clone(),
                runtime: s.runtime.clone(),
                allow_git: s.allow_git,
            })
            .unwrap_or_default()
    }
    fn publish(&self, event: RuntimeEvent) {
        let cwd = self.engine().cwd_of("s1").unwrap_or_default();
        crate::session::runtime_bridge::project_runtime_event(self, "s1", &cwd, event).unwrap();
    }
}
