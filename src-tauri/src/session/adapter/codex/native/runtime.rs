//! Session-owned native process, distinct from each application's turn owner.
use super::{
    events,
    protocol::{self, Envelope, InterruptState},
    requests::{NativeScope, RequestLedger},
    startup::{returned_thread, NativeSettings},
    transport::{self, Transport},
};
use crate::ipc::{AppError, ErrorCode};
use crate::session::application::*;
use serde_json::json;
use std::collections::HashSet;
use std::sync::{Arc, Mutex};

pub(super) struct NativeRuntime {
    pub(super) inner: Arc<Inner>,
}
type Launcher = Arc<
    dyn Fn(&TurnContext, transport::Receiver) -> Result<Arc<Transport>, AppError> + Send + Sync,
>;
pub(super) struct Inner {
    pub(super) state: Mutex<State>,
    launcher: Launcher,
}
#[derive(Default)]
pub(super) struct State {
    pub closed: bool,
    identity: Option<(ExecutionIdentity, Vec<(String, String)>, String)>,
    pub transport: Option<Arc<Transport>>,
    pub thread_id: Option<String>,
    pub turn: Option<Turn>,
    pub ledger: Option<RequestLedger>,
    pub completed_turns: HashSet<String>,
}
pub(super) struct Turn {
    pub context: TurnContext,
    pub emitter: Arc<Emitter>,
    pub native: Option<NativeScope>,
    pub interrupt: InterruptState,
    pub items: events::Items,
    pub finished: bool,
    pub retired: bool,
    pub start_sent: bool,
}
pub(super) struct Emitter {
    context: TurnContext,
    sink: Arc<dyn RuntimeEventSink>,
    sequence: Mutex<u64>,
}
impl Emitter {
    pub(super) fn publish(&self, event: RuntimeEvent) -> Result<ApplyOutcome, AppError> {
        let mut sequence = self.sequence.lock().unwrap();
        *sequence += 1;
        self.sink.publish(RuntimeEventEnvelope {
            scope: self.context.scope.clone(),
            sequence: *sequence,
            event,
        })
    }
    fn require(&self, event: RuntimeEvent) -> Result<(), AppError> {
        match self.publish(event)? {
            ApplyOutcome::Applied => Ok(()),
            _ => Err(transport::unavailable()),
        }
    }
}
impl NativeRuntime {
    pub(super) fn new() -> Self {
        Self::with_launcher(Arc::new(Transport::spawn))
    }
    pub(super) fn with_launcher(launcher: Launcher) -> Self {
        Self {
            inner: Arc::new(Inner {
                state: Mutex::new(State::default()),
                launcher,
            }),
        }
    }
}
impl RuntimePort for NativeRuntime {
    fn preflight(&self, ctx: &TurnContext) -> Result<(), AppError> {
        if !ctx.execution.account_authenticated {
            return Err(AppError::new(
                ErrorCode::AccountNotAuthenticated,
                "Sign in to this Codex account first",
            ));
        }
        if ctx.mode != TurnMode::Normal {
            return Err(AppError::new(
                ErrorCode::RuntimeUnsupported,
                "Codex does not support automatic prompt replay or this turn mode",
            ));
        }
        if ctx.runtime != "native" && !(cfg!(windows) && ctx.runtime == "wsl") {
            return Err(AppError::new(
                ErrorCode::RuntimeUnsupported,
                "This Codex execution environment is unavailable",
            ));
        }
        let state = self.inner.state.lock().unwrap();
        if state.closed {
            return Err(transport::unavailable());
        }
        let identity = (
            ctx.execution.identity.clone(),
            ctx.execution.environment.clone(),
            ctx.session_id.clone(),
        );
        if state
            .identity
            .as_ref()
            .is_some_and(|saved| saved != &identity)
        {
            return Err(AppError::new(
                ErrorCode::RuntimeUnavailable,
                "Codex account or process environment changed; reconnect explicitly",
            ));
        }
        Ok(())
    }
    fn begin_turn(
        &self,
        ctx: TurnContext,
        sink: Arc<dyn RuntimeEventSink>,
    ) -> Result<Arc<dyn TurnControl>, AppError> {
        self.preflight(&ctx)?;
        let emitter = Arc::new(Emitter {
            context: ctx.clone(),
            sink,
            sequence: Mutex::new(0),
        });
        {
            let mut state = self.inner.state.lock().unwrap();
            if state.closed {
                return Err(transport::unavailable());
            }
            if state.turn.as_ref().is_some_and(|turn| !turn.finished) {
                return Err(AppError::new(
                    ErrorCode::SessionBusy,
                    "Codex is still completing the previous turn",
                ));
            }
            state.identity = Some((
                ctx.execution.identity.clone(),
                ctx.execution.environment.clone(),
                ctx.session_id.clone(),
            ));
            state.turn = Some(Turn {
                context: ctx.clone(),
                emitter: emitter.clone(),
                native: None,
                interrupt: InterruptState::default(),
                items: events::Items::default(),
                finished: false,
                retired: false,
                start_sent: false,
            });
        }
        let inner = self.inner.clone();
        let scope = ctx.scope.clone();
        std::thread::spawn(move || {
            if let Err(error) = inner.start(&ctx, &emitter) {
                inner.failed_start(&ctx.scope, error);
            }
        });
        Ok(Arc::new(super::control::Control {
            inner: Arc::downgrade(&self.inner),
            scope,
        }))
    }
}
impl SessionRuntime for NativeRuntime {
    fn close(&self) {
        self.inner.close();
    }
}
impl Drop for NativeRuntime {
    fn drop(&mut self) {
        self.inner.close();
    }
}
impl Inner {
    pub(super) fn close(&self) {
        let connection = {
            let mut state = self.state.lock().unwrap();
            if state.closed {
                return;
            }
            state.closed = true;
            if let Some(ledger) = &mut state.ledger {
                ledger.close();
            }
            if let Some(turn) = &mut state.turn {
                turn.retired = true;
                turn.finished = true;
            }
            state.transport.take()
        };
        if let Some(connection) = connection {
            connection.close();
        }
    }
    fn connection(self: &Arc<Self>, ctx: &TurnContext) -> Result<Arc<Transport>, AppError> {
        {
            let state = self.state.lock().unwrap();
            if state.closed {
                return Err(transport::unavailable());
            }
            if let Some(connection) = &state.transport {
                return Ok(connection.clone());
            }
        }
        let weak = Arc::downgrade(self);
        let connection = (self.launcher)(
            ctx,
            Arc::new(move |event| {
                if let Some(inner) = weak.upgrade() {
                    inner.receive(event);
                }
            }),
        )?;
        {
            let mut state = self.state.lock().unwrap();
            if state.closed {
                drop(state);
                connection.close();
                return Err(transport::unavailable());
            }
            state.transport = Some(connection.clone());
        }
        let deadline = Transport::deadline();
        connection.call(deadline, |id| {
            Ok(protocol::initialize(id, env!("CARGO_PKG_VERSION")))
        })?;
        connection.write(&json!({"method":"initialized"}))?;
        Ok(connection)
    }
    fn start(self: &Arc<Self>, ctx: &TurnContext, emitter: &Emitter) -> Result<(), AppError> {
        let connection = self.connection(ctx)?;
        emitter.require(RuntimeEvent::Capabilities(
            crate::session::adapter::native_capabilities(crate::session::AgentRuntime::Codex),
        ))?;
        let cwd = super::invocation::native_path(ctx, &ctx.cwd)?;
        let settings = NativeSettings {
            cwd: &cwd,
            model: &ctx.model_id,
            effort: ctx.effort.as_deref(),
            permission_mode: &ctx.permission_mode,
        };
        let thread = self.state.lock().unwrap().thread_id.clone();
        let thread = if let Some(thread) = thread {
            if ctx.resume.as_deref() != Some(thread.as_str()) {
                return Err(AppError::new(
                    ErrorCode::RuntimeUnavailable,
                    "Codex saved thread changed; reconnect explicitly",
                ));
            }
            thread
        } else {
            let result = connection.call(Transport::deadline(), |id| {
                settings
                    .thread_request(id, ctx.resume.as_deref())
                    .map_err(|_| transport::protocol_error())
            })?;
            let thread = returned_thread(&result, ctx.resume.as_deref())
                .map_err(|_| transport::protocol_error())?;
            // A successful checked sink commit is a prerequisite of turn/start.
            emitter.require(RuntimeEvent::ResumeAnchor(thread.clone()))?;
            let mut state = self.state.lock().unwrap();
            if state.closed {
                return Err(transport::unavailable());
            }
            state.thread_id = Some(thread.clone());
            thread
        };
        {
            let mut state = self.state.lock().unwrap();
            if state.closed {
                return Err(transport::unavailable());
            }
            let turn = state
                .turn
                .as_mut()
                .filter(|turn| turn.context.scope == ctx.scope)
                .ok_or_else(transport::unavailable)?;
            if turn.retired {
                turn.finished = true;
                return Ok(());
            }
            turn.start_sent = true;
        }
        let prompt =
            crate::session::prefixed_prompt(ctx.execution.response_prefix.as_deref(), &ctx.text);
        let images = ctx
            .execution
            .local_images
            .iter()
            .map(|path| super::invocation::native_path(ctx, path))
            .collect::<Result<Vec<_>, _>>()?;
        let result = connection.call(Transport::deadline(), |id| {
            settings
                .turn_request(id, &thread, &prompt, &images)
                .map_err(|_| transport::protocol_error())
        })?;
        let native_turn = result["turn"]["id"]
            .as_str()
            .filter(|id| !id.is_empty())
            .ok_or_else(transport::protocol_error)?;
        {
            let state = self.state.lock().unwrap();
            let turn = state
                .turn
                .as_ref()
                .filter(|turn| turn.context.scope == ctx.scope)
                .ok_or_else(transport::unavailable)?;
            if turn
                .native
                .as_ref()
                .is_some_and(|scope| scope.turn_id != native_turn)
            {
                return Err(transport::protocol_error());
            }
        }
        // Native turn/started, not this response, makes interrupt ready.

        Ok(())
    }
    fn failed_start(&self, scope: &RuntimeScope, error: AppError) {
        let emitter = {
            let mut state = self.state.lock().unwrap();
            let Some(turn) = state
                .turn
                .as_mut()
                .filter(|turn| turn.context.scope == *scope && !turn.finished)
            else {
                return;
            };
            turn.finished = true;
            turn.emitter.clone()
        };
        let _ = emitter.publish(RuntimeEvent::TurnFailed(error.clone()));
        // Delivery may be uncertain. Close once; never replay the user prompt.
        self.connection_lost(error);
    }
    pub(super) fn connection_lost(&self, error: AppError) {
        let (connection, emitter, resolutions) = {
            let mut state = self.state.lock().unwrap();
            if state.closed {
                return;
            }
            state.closed = true;
            let resolutions = state
                .ledger
                .as_mut()
                .map(RequestLedger::close)
                .unwrap_or_default();
            let emitter = state.turn.as_mut().map(|turn| {
                turn.finished = true;
                turn.emitter.clone()
            });
            (state.transport.take(), emitter, resolutions)
        };
        if let Some(connection) = connection {
            connection.close();
        }
        if let Some(emitter) = emitter {
            for resolution in resolutions {
                let _ = emitter.publish(events::resolved(resolution));
            }
            let _ = emitter.publish(RuntimeEvent::ConnectionClosed(error));
        }
    }
    pub(super) fn receive(self: &Arc<Self>, event: Result<Envelope, AppError>) {
        match event {
            Err(error) => self.connection_lost(error),
            Ok(Envelope::Notification { method, params }) => self.notification(&method, &params),
            Ok(Envelope::Request { id, method, params }) => {
                self.server_request(id, &method, params)
            }
            _ => {}
        }
    }
}
