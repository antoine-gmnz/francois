//! Framework-free session commands and normalized runtime effects.
mod commands;
mod values;
use super::RuntimeCapabilities;
use super::{
    AgentInfo, AgentRuntime, CommandCard, McpServerInfo, ResponseMode, SessionQuestion, StepDetail,
};
use crate::ipc::{AppError, ErrorCode};
use crate::permissions::{PermissionAsk, PermissionRule};
pub(crate) use commands::*;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
pub(crate) use values::*;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct RuntimeScope {
    pub session_id: String,
    pub turn_id: String,
    pub generation: u64,
}
#[derive(Clone, Default)]
pub(crate) struct ExecutionConfig {
    pub identity: ExecutionIdentity,
    pub environment: Vec<(String, String)>,
    pub response_prefix: Option<String>,
    pub account_authenticated: bool,
    pub local_images: Vec<String>,
}
#[derive(Clone, Default, PartialEq, Eq)]
pub(crate) struct ExecutionIdentity {
    pub account_id: String,
    pub home: Option<String>,
    pub runtime: String,
    pub worktree_distro: Option<String>,
}
pub(crate) trait SessionRuntime: RuntimePort + Send + Sync {
    fn close(&self);
}
pub(crate) struct SessionRuntimeBinding {
    pub identity: ExecutionIdentity,
    pub runtime: Arc<dyn SessionRuntime>,
}
pub(crate) struct SessionSnapshot {
    pub runtime: AgentRuntime,
    pub status: String,
    pub owner: Option<Arc<RuntimeOwner>>,
    pub settings_revision: u64,
}
pub(crate) trait SessionStatePort {
    fn snapshot(&self, session_id: &str) -> Result<SessionSnapshot, AppError>;
    fn claim_start(
        &self,
        context: TurnContext,
    ) -> Result<(TurnContext, Arc<RuntimeOwner>), AppError>;
    fn install(&self, scope: &RuntimeScope, control: Arc<dyn TurnControl>) -> bool;
    fn claim_close(&self, session_id: &str) -> Result<Option<Arc<RuntimeOwner>>, AppError>;
    fn dispatch_control(
        &self,
        scope: &RuntimeScope,
        action: &mut dyn FnMut(&RuntimeOwner) -> Result<(), AppError>,
    ) -> Result<(), AppError>;
    fn compare_settings(
        &self,
        session_id: &str,
        revision: u64,
        settings: SettingsResult,
    ) -> Result<(), AppError>;
}
#[derive(Clone)]
pub(crate) struct SettingsResult {
    pub model_id: String,
    pub model_label: String,
    pub context_limit: u64,
    pub effort: Option<String>,
}
pub(crate) trait RuntimePort {
    fn preflight(&self, context: &TurnContext) -> Result<(), AppError>;
    fn begin_turn(
        &self,
        context: TurnContext,
        sink: Arc<dyn RuntimeEventSink>,
    ) -> Result<Arc<dyn TurnControl>, AppError>;
}
pub(crate) trait RuntimeEventSink: Send + Sync {
    fn publish(&self, envelope: RuntimeEventEnvelope) -> Result<ApplyOutcome, AppError>;
}
pub(crate) trait RuntimeEffectPort: Send + Sync {
    fn apply(&self, scope: &RuntimeScope, event: RuntimeEvent) -> Result<(), AppError>;
}
pub(crate) trait PermissionRulePort {
    fn remember(
        &self,
        session_id: &str,
        pattern: &str,
        tier: Option<&str>,
        allow: bool,
    ) -> Result<PermissionRule, AppError>;
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ApplyOutcome {
    Applied,
    Duplicate,
    Stale,
    Closed,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum RequestKind {
    Question,
    Permission,
}
#[derive(Clone)]
pub(crate) struct RuntimeEventEnvelope {
    pub scope: RuntimeScope,
    pub sequence: u64,
    pub event: RuntimeEvent,
}
// Claude and App Server consume the remaining normalized members in08/09.
#[allow(dead_code)]
#[derive(Clone)]
pub(crate) enum RuntimeEvent {
    StreamLive,
    AssistantAppend {
        block_id: String,
        text: String,
    },
    AssistantChunk {
        block_id: String,
        text: String,
        offset: usize,
    },
    ToolInputReady {
        block_id: String,
        tool: String,
        summary: String,
        is_task: bool,
        model: Option<String>,
    },
    CommandOutput {
        block_id: String,
        command: String,
        card: CommandCard,
    },
    McpObserved(McpServerInfo),
    CommandsObserved(Vec<String>),
    SubagentStarted {
        tool_use_id: String,
        agent: AgentInfo,
    },
    SubagentInput {
        agent_id: String,
        background: bool,
        name: String,
        task: String,
    },
    SubagentResult {
        agent_id: String,
        text: String,
        is_error: bool,
        at: u64,
    },
    SubagentObserved {
        parent_tool_use_id: String,
        items: Vec<SubagentObservation>,
        at: u64,
    },
    WorkflowStarted {
        run_id: String,
        tool_use_id: String,
        at: u64,
    },
    WorkflowInput {
        run_id: String,
        input: Value,
    },
    WorkflowResult {
        run_id: String,
        text: String,
        is_error: bool,
    },
    WorkflowAsk {
        block_id: String,
        kind: String,
        tool_name: Option<String>,
        parent_tool_use_id: Option<String>,
        agent_id: Option<String>,
    },
    CompletionNotice {
        text: String,
    },
    ResumeRejected,
    Capabilities(RuntimeCapabilities),
    ConnectionClosed(AppError),
    ResumeAnchor(String),
    PromptDelivered(ResponseMode),
    AssistantDelta {
        block_id: String,
        text: String,
    },
    AssistantFinal {
        block_id: String,
        text: String,
    },
    ToolStarted {
        block_id: String,
        tool: String,
        summary: String,
    },
    ToolCompleted {
        block_id: String,
        meta: String,
        detail: Option<StepDetail>,
        affects_workspace: bool,
    },
    Usage {
        context_used_tokens: Option<u64>,
        input_tokens: Option<u64>,
        output_tokens: Option<u64>,
        cost: Option<f64>,
    },
    PermissionAsked {
        block_id: String,
        ask: PermissionAsk,
    },
    QuestionAsked {
        block_id: String,
        questions: Vec<SessionQuestion>,
        blocking: Option<bool>,
    },
    RequestResolved {
        block_id: String,
        kind: RequestKind,
        outcome: String,
    },
    QuestionAnswered {
        block_id: String,
        answers: Value,
    },
    PermissionDecided {
        block_id: String,
        outcome: String,
        rule: Option<PermissionRule>,
    },
    TurnFinished,
    TurnFailed(AppError),
}
#[derive(Clone)]
pub(crate) enum SubagentObservation {
    Text(String),
    ToolUse {
        id: Option<String>,
        name: String,
        input: Value,
    },
    ToolResult {
        tool_use_id: String,
        text: String,
        is_error: bool,
    },
}
pub(crate) struct RuntimeOwner {
    pub scope: RuntimeScope,
    inner: Mutex<OwnerState>,
    dispatch: Mutex<()>,
}
#[derive(Default)]
struct OwnerState {
    closed: bool,
    last_sequence: u64,
    interrupted: bool,
    disconnected: bool,
    control: Option<Arc<dyn TurnControl>>,
    requests: HashMap<(RequestKind, String), bool>,
    replies: HashSet<(RequestKind, String)>,
    nonblocking_questions: HashSet<String>,
}
impl RuntimeOwner {
    pub fn new(scope: RuntimeScope) -> Self {
        Self {
            scope,
            inner: Mutex::new(OwnerState::default()),
            dispatch: Mutex::new(()),
        }
    }
    pub fn pending_counts(&self) -> PendingCounts {
        let state = self.inner.lock().unwrap();
        let mut counts = PendingCounts::default();
        for ((kind, id), pending) in &state.requests {
            if !pending {
                continue;
            }
            match kind {
                RequestKind::Permission => counts.permissions += 1,
                RequestKind::Question if !state.nonblocking_questions.contains(id) => {
                    counts.questions += 1
                }
                RequestKind::Question => {}
            }
        }
        counts
    }
}

/// Reduction has no I/O. A claimed envelope returns the effects to apply.
fn reduce(state: &mut OwnerState, event: RuntimeEvent) -> Vec<RuntimeEvent> {
    if let RuntimeEvent::QuestionAsked {
        block_id,
        blocking: Some(false),
        ..
    } = &event
    {
        state.nonblocking_questions.insert(block_id.clone());
    }
    let request = match &event {
        RuntimeEvent::PermissionAsked { block_id, .. } => {
            Some((RequestKind::Permission, block_id.clone(), true))
        }
        RuntimeEvent::QuestionAsked { block_id, .. } => {
            Some((RequestKind::Question, block_id.clone(), true))
        }
        RuntimeEvent::RequestResolved { block_id, kind, .. } => {
            Some((*kind, block_id.clone(), false))
        }
        RuntimeEvent::QuestionAnswered { block_id, .. } => {
            Some((RequestKind::Question, block_id.clone(), false))
        }
        RuntimeEvent::PermissionDecided { block_id, .. } => {
            Some((RequestKind::Permission, block_id.clone(), false))
        }
        _ => None,
    };
    if let Some((kind, id, asked)) = request {
        let key = (kind, id);
        if asked && state.requests.contains_key(&key) {
            return vec![];
        }
        if !asked && state.requests.get(&key) == Some(&false) {
            return vec![];
        }
        state.requests.insert(key, asked);
    }
    let mut effects = Vec::new();
    if matches!(
        event,
        RuntimeEvent::TurnFinished
            | RuntimeEvent::TurnFailed(_)
            | RuntimeEvent::ConnectionClosed(_)
            | RuntimeEvent::ResumeRejected
    ) {
        state.closed = true;
        for ((kind, id), pending) in &mut state.requests {
            if *pending {
                *pending = false;
                effects.push(RuntimeEvent::RequestResolved {
                    block_id: id.clone(),
                    kind: *kind,
                    outcome: "cancelled".into(),
                });
            }
        }
    }
    effects.push(event);
    effects
}
/// The owner serializes publication with close/replacement, without a registry
/// lock. Reduction finishes before any outward effect is executed.
pub(crate) fn apply_event(
    owner: &RuntimeOwner,
    effects: &dyn RuntimeEffectPort,
    envelope: RuntimeEventEnvelope,
) -> Result<ApplyOutcome, AppError> {
    let _dispatch = owner.dispatch.lock().unwrap();
    if envelope.scope != owner.scope {
        return Ok(ApplyOutcome::Stale);
    }
    let mut state = owner.inner.lock().unwrap();
    if envelope.sequence <= state.last_sequence {
        return Ok(ApplyOutcome::Duplicate);
    }
    let disconnect = matches!(&envelope.event, RuntimeEvent::ConnectionClosed(_));
    if state.closed && !disconnect || state.disconnected {
        return Ok(ApplyOutcome::Closed);
    }
    if disconnect {
        state.disconnected = true;
    }
    state.last_sequence = envelope.sequence;
    let outward = reduce(&mut state, envelope.event);
    drop(state);
    for event in outward {
        effects.apply(&owner.scope, event)?;
    }
    Ok(ApplyOutcome::Applied)
}
pub(crate) fn install_control(owner: &RuntimeOwner, control: Arc<dyn TurnControl>) -> bool {
    let mut state = owner.inner.lock().unwrap();
    if state.closed {
        drop(state);
        control.kill();
        return false;
    }
    if state.interrupted {
        control.interrupt();
    }
    state.control = Some(control);
    true
}
pub(crate) fn close_owner(
    owner: &RuntimeOwner,
    effects: &dyn RuntimeEffectPort,
) -> Result<(), AppError> {
    let _dispatch = owner.dispatch.lock().unwrap();
    let mut state = owner.inner.lock().unwrap();
    if state.closed {
        return Ok(());
    }
    state.closed = true;
    let control = state.control.take();
    let mut requests = HashSet::new();
    for ((kind, id), pending) in &mut state.requests {
        if *pending {
            *pending = false;
            requests.insert((*kind, id.clone()));
        }
    }
    drop(state);
    if let Some(control) = control {
        let (questions, permissions) = control.drain_pending();
        requests.extend(questions.into_iter().map(|id| (RequestKind::Question, id)));
        requests.extend(
            permissions
                .into_iter()
                .map(|id| (RequestKind::Permission, id)),
        );
        control.interrupt();
        control.kill();
    }
    for (kind, block_id) in requests {
        effects.apply(
            &owner.scope,
            RuntimeEvent::RequestResolved {
                kind,
                block_id,
                outcome: "cancelled".into(),
            },
        )?;
    }
    Ok(())
}
#[cfg(test)]
mod tests;
