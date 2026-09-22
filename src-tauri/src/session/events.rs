//! the SessionEvent wire union emitted on francois://session/event.

use super::*;

use crate::permissions::{PermissionAsk, PermissionRule};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};

/// pi-models-metrics/pi-transcript-events/pi-turn-controls: the
/// `RuntimeEventPayload` wire union and the payload structs its variants
/// carry — see that module's own doc for why it is a sibling rather than a
/// child. Re-exported here (not glob-exported) because every other file in
/// this crate already reaches these names through `events::*`.
pub use runtime_events::{RuntimeEventPayload, RuntimeMetrics};

/// pi-session-durability: whether a runtime-owned session can continue its
/// native conversation. Mirrors contract/common.ts `RuntimeRecovery` exactly —
/// presentation only, the native file path stays core-private and never
/// crosses IPC. `message`/`lastVerifiedAt` are validated the same way
/// `RuntimeFailure`'s own display text is (bounded, control/bidi-free).
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
// Retained wire vocabulary for saved Pi metadata.
#[allow(dead_code)]
pub enum RuntimeRecoveryState {
    Ready,
    Disconnected,
    Missing,
    Corrupt,
    Incompatible,
    AccountMissing,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct RuntimeRecovery {
    pub state: RuntimeRecoveryState,
    #[serde(rename = "lastVerifiedAt", skip_serializing_if = "Option::is_none")]
    pub last_verified_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl RuntimeRecovery {
    /// The state a Pi session starts in (never connected) and returns to on
    /// quit/reopen — history is readable, the next send or an explicit
    /// reconnect re-attaches. Carries no message: `disconnected` is not a
    /// fault (design brief: "Disconnected: readable history, reconnect on
    /// send").
    pub(crate) fn disconnected() -> Self {
        Self {
            state: RuntimeRecoveryState::Disconnected,
            last_verified_at: None,
            message: None,
        }
    }
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
        #[serde(skip_serializing_if = "Option::is_none")]
        blocking: Option<bool>,
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
    use crate::ipc::RuntimeFailure;
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
            id: None,
            is_other: None,
            is_secret: None,
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
            blocking: None,
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
                    invocation: None,
                },
                SlashCommandInfo {
                    name: "deploy".into(),
                    description: "ship it".into(),
                    source: "skill",
                    scope: Some("project".into()),
                    invocation: None,
                },
                SlashCommandInfo {
                    name: "compact".into(),
                    description: String::new(),
                    source: "cli",
                    scope: None,
                    invocation: None,
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

    /// pi-session-durability: `RuntimeRecovery` mirrors contract/common.ts
    /// exactly — kebab-case state, `lastVerifiedAt`/`message` omitted (never
    /// null) when absent.
    #[test]
    fn runtime_recovery_serializes_to_the_contract_shape() {
        let disconnected = serde_json::to_value(RuntimeRecovery::disconnected()).unwrap();
        assert_eq!(disconnected, json!({ "state": "disconnected" }));

        let ready = serde_json::to_value(RuntimeRecovery {
            state: RuntimeRecoveryState::Ready,
            last_verified_at: Some(1_000),
            message: None,
        })
        .unwrap();
        assert_eq!(ready, json!({ "state": "ready", "lastVerifiedAt": 1_000 }));

        for (state, wire) in [
            (RuntimeRecoveryState::Missing, "missing"),
            (RuntimeRecoveryState::Corrupt, "corrupt"),
            (RuntimeRecoveryState::Incompatible, "incompatible"),
            (RuntimeRecoveryState::AccountMissing, "account-missing"),
        ] {
            let failed = serde_json::to_value(RuntimeRecovery {
                state,
                last_verified_at: None,
                message: Some("cause".into()),
            })
            .unwrap();
            assert_eq!(failed, json!({ "state": wire, "message": "cause" }));
        }
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
