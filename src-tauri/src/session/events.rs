//! the SessionEvent wire union emitted on francois://session/event.

use super::*;

use crate::ipc::{AppError, RuntimeFailure};
use crate::permissions::{PermissionAsk, PermissionRule};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};

/// Ordered, session-scoped runtime events. This intentionally carries only
/// core-normalised values; Pi's wire DTOs stay inside its future adapter.
#[derive(Serialize, Clone)]
#[serde(tag = "kind")]
#[allow(dead_code)]
pub enum RuntimeEventPayload {
    #[serde(rename = "run.state")]
    RunState { state: RuntimeRunState },
    #[serde(rename = "capabilities")]
    Capabilities {
        #[serde(serialize_with = "serialize_capabilities")]
        capabilities: RuntimeCapabilities,
    },
    #[serde(rename = "failure")]
    Failure { failure: RuntimeFailure },
}

// ---------- SessionEvent (contract/common.ts, reproduced) ----------

#[derive(Serialize, Clone)]
#[serde(tag = "type")]
pub enum SessionEvent {
    #[serde(rename = "session.meta")]
    Meta { meta: SessionMeta },
    #[serde(rename = "session.status")]
    Status {
        #[serde(rename = "sessionId")]
        session_id: String,
        status: String,
    },
    #[serde(rename = "session.removed")]
    Removed {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
    #[serde(rename = "message.user")]
    MessageUser {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "blockId")]
        block_id: String,
        text: String,
    },
    #[serde(rename = "assistant.delta")]
    AssistantDelta {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "blockId")]
        block_id: String,
        text: String,
        /// UTF-16 code units of this block already streamed BEFORE this chunk
        /// (UTF-16 because the webview counts `String.length` that way, and the
        /// two counts must agree for the frontend's overlap check to work).
        offset: usize,
    },
    #[serde(rename = "assistant.done")]
    AssistantDone {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "blockId")]
        block_id: String,
        /// The block's COMPLETE text — authoritative, so a listener that missed
        /// a delta is repaired here instead of rendering a truncated answer.
        text: String,
    },
    #[serde(rename = "tool.start")]
    ToolStart {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "blockId")]
        block_id: String,
        tool: String,
        summary: String,
        /// The model a subagent dispatch named — omitted otherwise, so the live
        /// path and `getTranscript` agree on "absent ⇒ inherits the session's".
        #[serde(skip_serializing_if = "Option::is_none")]
        model: Option<String>,
    },
    #[serde(rename = "tool.done")]
    ToolDone {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "blockId")]
        block_id: String,
        meta: String,
        /// command-inspect FR-10: same flag as `ToolConversationBlock.hasDetail`
        /// — `Some(true)` iff FR-1 wrote a `StepDetail` record for this block;
        /// omitted (never `Some(false)`) otherwise.
        #[serde(rename = "hasDetail", skip_serializing_if = "Option::is_none")]
        has_detail: Option<bool>,
    },
    #[serde(rename = "command.started")]
    CommandStarted {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "blockId")]
        block_id: String,
        command: String,
    },
    #[serde(rename = "command.output")]
    CommandOutput {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "blockId")]
        block_id: String,
        card: Value,
    },
    #[serde(rename = "question.asked")]
    QuestionAsked {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "blockId")]
        block_id: String,
        questions: Vec<SessionQuestion>,
    },
    #[serde(rename = "question.resolved")]
    QuestionResolved {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "blockId")]
        block_id: String,
        state: String, // "answered" | "cancelled"
        /// Present iff answered — omitted (never null) otherwise (§9).
        #[serde(skip_serializing_if = "Option::is_none")]
        answers: Option<Value>,
    },
    #[serde(rename = "permission.asked")]
    PermissionAsked {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "blockId")]
        block_id: String,
        ask: PermissionAsk,
    },
    #[serde(rename = "permission.resolved")]
    PermissionResolved {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "blockId")]
        block_id: String,
        state: String, // "allowed" | "denied" | "cancelled"
        /// Present iff the decision wrote a rule — omitted (never null) otherwise.
        #[serde(skip_serializing_if = "Option::is_none")]
        rule: Option<PermissionRule>,
    },
    #[serde(rename = "session.commands")]
    Commands {
        #[serde(rename = "sessionId")]
        session_id: String,
        commands: Vec<SlashCommandInfo>,
    },
    #[serde(rename = "agent.update")]
    AgentUpdate { agent: AgentInfo },
    /// async-agents FR-10: a trail step was appended, or an existing `seq`
    /// re-emitted with its `meta` filled.
    #[serde(rename = "agent.step")]
    AgentStepEvent {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "agentId")]
        agent_id: String,
        step: AgentStep,
    },
    /// workflow-panel FR-3: a `Workflow` run was minted, acked, or reached a
    /// terminal state. Carries the whole run — the panel has no other read.
    #[serde(rename = "workflow.update")]
    WorkflowUpdate { run: WorkflowRun },
    #[serde(rename = "mcp.update")]
    McpUpdate {
        #[serde(rename = "sessionId")]
        session_id: String,
        server: McpServerInfo,
    },
    #[serde(rename = "context.usage")]
    ContextUsage {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "usedTokens")]
        used_tokens: u64,
        #[serde(rename = "limitTokens")]
        limit_tokens: u64,
    },
    #[serde(rename = "session.resumeFailed")]
    ResumeFailed {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
    #[serde(rename = "session.cleared")]
    Cleared {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
    #[serde(rename = "session.error")]
    Error {
        #[serde(rename = "sessionId")]
        session_id: String,
        error: AppError,
    },
    #[serde(rename = "runtime.event")]
    #[allow(dead_code)]
    RuntimeEvent {
        #[serde(rename = "sessionId")]
        #[serde(serialize_with = "serialize_uuid")]
        session_id: String,
        #[serde(serialize_with = "serialize_uuid")]
        generation: String,
        #[serde(serialize_with = "serialize_safe_integer")]
        sequence: u64,
        #[serde(rename = "runId", skip_serializing_if = "Option::is_none")]
        #[serde(serialize_with = "serialize_optional_uuid")]
        run_id: Option<String>,
        #[serde(rename = "requestId", skip_serializing_if = "Option::is_none")]
        #[serde(serialize_with = "serialize_optional_uuid")]
        request_id: Option<String>,
        #[serde(serialize_with = "serialize_safe_integer")]
        at: u64,
        event: RuntimeEventPayload,
    },
}

pub(crate) fn emit(app: &AppHandle, ev: SessionEvent) {
    let _ = app.emit(EVENT_CHANNEL, ev);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::testutil::*;
    use serde_json::json;

    #[test]
    fn session_cleared_event_serializes_to_contract_shape() {
        let ev = serde_json::to_value(SessionEvent::Cleared {
            session_id: "s1".into(),
        })
        .unwrap();
        assert_eq!(
            ev,
            serde_json::json!({ "type": "session.cleared", "sessionId": "s1" })
        );
    }

    #[test]
    fn runtime_event_serializes_to_the_ordered_contract_envelope() {
        let capabilities = adapter::RUNTIME_CAPABILITIES
            .into_iter()
            .map(|key| {
                (
                    key.into(),
                    adapter::CapabilityState {
                        available: false,
                        reason: Some("Runtime is not connected.".into()),
                    },
                )
            })
            .collect();
        let event = SessionEvent::RuntimeEvent {
            session_id: uuid(),
            generation: uuid(),
            sequence: 1,
            run_id: None,
            request_id: Some(uuid()),
            at: 1_000,
            event: RuntimeEventPayload::Capabilities { capabilities },
        };
        let value = serde_json::to_value(event).unwrap();
        assert_eq!(value["type"], "runtime.event");
        assert_eq!(value["sequence"], 1);
        assert_eq!(value["event"]["kind"], "capabilities");
        assert!(value.get("runId").is_none());

        let _ = RuntimeEventPayload::RunState {
            state: RuntimeRunState::Idle,
        };
        let _ = RuntimeEventPayload::Failure {
            failure: RuntimeFailure::validated(
                "runtime",
                "RUNTIME_EXITED",
                "stopped",
                false,
                None,
                None,
            )
            .unwrap(),
        };
    }

    #[test]
    fn command_event_members_serialize_to_contract_shape() {
        let started = serde_json::to_value(SessionEvent::CommandStarted {
            session_id: "s1".into(),
            block_id: "b1".into(),
            command: "usage".into(),
        })
        .unwrap();
        assert_eq!(
            started,
            json!({ "type": "command.started", "sessionId": "s1", "blockId": "b1", "command": "usage" })
        );
        let card = serde_json::to_value(CommandCard::Notice {
            text: "a usage check is already running".into(),
        })
        .unwrap();
        let output = serde_json::to_value(SessionEvent::CommandOutput {
            session_id: "s1".into(),
            block_id: "b2".into(),
            card,
        })
        .unwrap();
        assert_eq!(
            output,
            json!({ "type": "command.output", "sessionId": "s1", "blockId": "b2",
            "card": { "kind": "notice", "text": "a usage check is already running" } })
        );
    }

    #[test]
    fn question_event_members_serialize_to_contract_shape() {
        let questions = vec![SessionQuestion {
            question: "Q".into(),
            header: "H".into(),
            options: vec![QuestionOption {
                label: "A".into(),
                description: "d".into(),
                preview: None,
                recommended: false,
            }],
            multi_select: true,
        }];
        let asked = serde_json::to_value(SessionEvent::QuestionAsked {
            session_id: "s1".into(),
            block_id: "q1".into(),
            questions,
        })
        .unwrap();
        assert_eq!(
            asked,
            json!({ "type": "question.asked", "sessionId": "s1", "blockId": "q1",
                "questions": [{ "question": "Q", "header": "H", "multiSelect": true,
                    "options": [{ "label": "A", "description": "d" }] }] })
        );

        // cancelled: absent answers is OMITTED, never null (§9)
        let cancelled = serde_json::to_value(SessionEvent::QuestionResolved {
            session_id: "s1".into(),
            block_id: "q1".into(),
            state: "cancelled".into(),
            answers: None,
        })
        .unwrap();
        assert_eq!(
            cancelled,
            json!({ "type": "question.resolved", "sessionId": "s1",
                "blockId": "q1", "state": "cancelled" })
        );

        let answered = serde_json::to_value(SessionEvent::QuestionResolved {
            session_id: "s1".into(),
            block_id: "q1".into(),
            state: "answered".into(),
            answers: Some(json!({ "Q": "A" })),
        })
        .unwrap();
        assert_eq!(
            answered,
            json!({ "type": "question.resolved", "sessionId": "s1",
                "blockId": "q1", "state": "answered", "answers": { "Q": "A" } })
        );
    }

    #[test]
    fn permission_event_members_serialize_to_contract_shape() {
        let ask = crate::permissions::build_ask("Bash", &json!({ "command": "ls" }), "/repo");
        let asked = serde_json::to_value(SessionEvent::PermissionAsked {
            session_id: "s1".into(),
            block_id: "p1".into(),
            ask,
        })
        .unwrap();
        assert_eq!(asked["type"], "permission.asked");
        assert_eq!(asked["sessionId"], "s1");
        assert_eq!(asked["blockId"], "p1");
        assert_eq!(asked["ask"]["toolName"], "Bash");
        assert_eq!(asked["ask"]["pattern"], "Bash(ls:*)");

        // `rule` is OMITTED (never null) when no rule was written (§9).
        let cancelled = serde_json::to_value(SessionEvent::PermissionResolved {
            session_id: "s1".into(),
            block_id: "p1".into(),
            state: "cancelled".into(),
            rule: None,
        })
        .unwrap();
        assert_eq!(
            cancelled,
            json!({ "type": "permission.resolved", "sessionId": "s1", "blockId": "p1",
                "state": "cancelled" })
        );

        let allowed = serde_json::to_value(SessionEvent::PermissionResolved {
            session_id: "s1".into(),
            block_id: "p1".into(),
            state: "allowed".into(),
            rule: Some(sample_rule()),
        })
        .unwrap();
        assert_eq!(allowed["rule"]["pattern"], "Bash(npm test:*)");
        assert_eq!(allowed["rule"]["tier"], "local");
        assert_eq!(allowed["rule"]["enabled"], true);
    }

    #[test]
    fn session_commands_event_serializes_to_contract_shape() {
        // §5.3: { type: 'session.commands', sessionId, commands } with
        // SlashCommandInfo camelCase; `scope` omitted (not null) when absent.
        let ev = SessionEvent::Commands {
            session_id: "s1".into(),
            commands: vec![
                SlashCommandInfo {
                    name: "usage".into(),
                    description: "plan usage limits (session + weekly)".into(),
                    source: "builtin",
                    scope: None,
                },
                SlashCommandInfo {
                    name: "deploy".into(),
                    description: "ship it".into(),
                    source: "skill",
                    scope: Some("project".into()),
                },
                SlashCommandInfo {
                    name: "compact".into(),
                    description: String::new(),
                    source: "cli",
                    scope: None,
                },
            ],
        };
        let v = serde_json::to_value(&ev).unwrap();
        assert_eq!(v["type"], "session.commands");
        assert_eq!(v["sessionId"], "s1");
        let cmds = v["commands"].as_array().unwrap();
        assert_eq!(cmds.len(), 3);
        assert_eq!(cmds[0]["name"], "usage");
        assert_eq!(
            cmds[0]["description"],
            "plan usage limits (session + weekly)"
        );
        assert_eq!(cmds[0]["source"], "builtin");
        assert!(cmds[0].get("scope").is_none()); // omitted when absent
        assert_eq!(cmds[1]["source"], "skill");
        assert_eq!(cmds[1]["scope"], "project");
        assert_eq!(cmds[2]["source"], "cli");
        assert_eq!(cmds[2]["description"], ""); // always present, empty for cli
    }

    #[test]
    fn agent_step_event_serializes_to_contract_shape() {
        // §5: { type: 'agent.step', sessionId, agentId, step }
        let ev = SessionEvent::AgentStepEvent {
            session_id: "s1".into(),
            agent_id: "a1".into(),
            step: AgentStep {
                seq: 3,
                kind: "notice".into(),
                at: 5_000,
                tool: None,
                label: "ended with the turn".into(),
                meta: None,
            },
        };
        let v = serde_json::to_value(&ev).unwrap();
        assert_eq!(v["type"], "agent.step");
        assert_eq!(v["sessionId"], "s1");
        assert_eq!(v["agentId"], "a1");
        assert_eq!(v["step"]["seq"], 3);
        assert_eq!(v["step"]["kind"], "notice");
        assert_eq!(v["step"]["label"], "ended with the turn");
    }

    #[test]
    fn run_state_maps_onto_the_closed_session_status_vocabulary() {
        // pi-runtime-boundary: `stopping` has no wire status of its own and
        // reads as still-busy `running`; `failed` is the terminal `error`.
        assert_eq!(RuntimeRunState::Starting.session_status(), status::STARTING);
        assert_eq!(RuntimeRunState::Running.session_status(), status::RUNNING);
        assert_eq!(RuntimeRunState::Stopping.session_status(), status::RUNNING);
        assert_eq!(RuntimeRunState::Idle.session_status(), status::IDLE);
        assert_eq!(RuntimeRunState::Failed.session_status(), status::ERROR);
    }

    #[test]
    fn workflow_update_event_serializes_to_contract_shape() {
        // workflow-panel §5: { type: 'workflow.update', run } — the whole run,
        // with no sessionId of its own at the envelope level (it rides on `run`).
        let ev = SessionEvent::WorkflowUpdate {
            run: test_workflow_run(),
        };
        let v = serde_json::to_value(&ev).unwrap();
        assert_eq!(v["type"], "workflow.update");
        assert_eq!(v["run"]["sessionId"], "s1");
        assert_eq!(v["run"]["name"], "review-changes");
        assert_eq!(v["run"]["status"], "running");
        assert!(v.get("sessionId").is_none());
    }
}

// pi-rpc-sessions: PartialEq/Eq/Debug added so the adapter's dispatcher can
// compare/log its own connection state without a duplicate enum.
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
#[allow(dead_code)]
pub enum RuntimeRunState {
    Starting,
    Running,
    Idle,
    Stopping,
    Failed,
}
impl RuntimeRunState {
    /// The `Session.status` a `run.state` event settles the session onto
    /// (pi-runtime-boundary): `Stopping` still counts as busy (cancellation in
    /// flight, no dedicated wire status for it) and `Failed` is the terminal
    /// `status::ERROR` — the caller pairs it with clearing/setting
    /// `error_message`, never this function alone.
    pub(crate) fn session_status(self) -> &'static str {
        match self {
            Self::Starting => status::STARTING,
            Self::Running | Self::Stopping => status::RUNNING,
            Self::Idle => status::IDLE,
            Self::Failed => status::ERROR,
        }
    }
}
#[allow(dead_code)]
pub(crate) struct RuntimeEventSequence {
    session_id: String,
    generation: String,
    sequence: u64,
}
impl RuntimeEventSequence {
    pub(crate) fn generation(&self) -> &str {
        &self.generation
    }
    pub(crate) fn new(session_id: String) -> Result<Self, AppError> {
        if !crate::ipc::valid_correlation(&session_id) {
            return Err(AppError::runtime(
                crate::ipc::RuntimeErrorCode::InvalidInput,
                "invalid session id",
            ));
        }
        Ok(Self {
            session_id,
            generation: uuid(),
            sequence: 0,
        })
    }
    pub(crate) fn next(
        &mut self,
        at: u64,
        run_id: Option<String>,
        request_id: Option<String>,
        event: RuntimeEventPayload,
    ) -> Result<SessionEvent, AppError> {
        const MAX_SAFE: u64 = 9_007_199_254_740_991;
        if at > MAX_SAFE
            || self.sequence >= MAX_SAFE
            || run_id
                .iter()
                .chain(request_id.iter())
                .any(|id| !crate::ipc::valid_correlation(id))
        {
            return Err(AppError::runtime(
                crate::ipc::RuntimeErrorCode::InvalidInput,
                "invalid runtime event envelope",
            ));
        }
        if let RuntimeEventPayload::Capabilities { capabilities } = &event {
            adapter::validate_capabilities(capabilities)?;
        }
        self.sequence += 1;
        Ok(SessionEvent::RuntimeEvent {
            session_id: self.session_id.clone(),
            generation: self.generation.clone(),
            sequence: self.sequence,
            run_id,
            request_id,
            at,
            event,
        })
    }
}
#[cfg(test)]
mod ordering_tests {
    use super::*;
    #[test]
    fn ordered_uuid_generation_and_validation() {
        assert!(RuntimeEventSequence::new("bad".into()).is_err());
        let mut seq = RuntimeEventSequence::new(uuid()).unwrap();
        let a = serde_json::to_value(
            seq.next(
                1,
                None,
                Some(uuid()),
                RuntimeEventPayload::RunState {
                    state: RuntimeRunState::Starting,
                },
            )
            .unwrap(),
        )
        .unwrap();
        let b = serde_json::to_value(
            seq.next(
                2,
                None,
                None,
                RuntimeEventPayload::RunState {
                    state: RuntimeRunState::Idle,
                },
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(a["generation"], b["generation"]);
        assert!(crate::ipc::valid_correlation(
            a["generation"].as_str().unwrap()
        ));
        assert_eq!(b["sequence"], 2);
        assert!(seq
            .next(
                3,
                None,
                Some("unsafe".into()),
                RuntimeEventPayload::RunState {
                    state: RuntimeRunState::Failed
                }
            )
            .is_err());
        assert!(seq
            .next(
                u64::MAX,
                None,
                None,
                RuntimeEventPayload::RunState {
                    state: RuntimeRunState::Idle
                }
            )
            .is_err());
    }
}

fn serialize_uuid<S: serde::Serializer>(id: &str, serializer: S) -> Result<S::Ok, S::Error> {
    if !crate::ipc::valid_correlation(id) {
        return Err(serde::ser::Error::custom("invalid runtime UUID"));
    }
    serializer.serialize_str(id)
}
fn serialize_optional_uuid<S: serde::Serializer>(
    id: &Option<String>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    if id
        .as_ref()
        .is_some_and(|id| !crate::ipc::valid_correlation(id))
    {
        return Err(serde::ser::Error::custom("invalid runtime correlation"));
    }
    id.serialize(serializer)
}
fn serialize_safe_integer<S: serde::Serializer>(
    value: &u64,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    if *value > 9_007_199_254_740_991 {
        return Err(serde::ser::Error::custom("unsafe runtime integer"));
    }
    serializer.serialize_u64(*value)
}
fn serialize_capabilities<S: serde::Serializer>(
    caps: &RuntimeCapabilities,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    adapter::validate_capabilities(caps)
        .map_err(|_| serde::ser::Error::custom("invalid capability snapshot"))?;
    caps.serialize(serializer)
}
