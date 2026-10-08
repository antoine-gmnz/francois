//! Codex collaboration lifecycle and child transcript projection.
use super::{
    protocol,
    runtime::Inner,
    startup::returned_thread,
    transport::{self, Transport},
};
use crate::ipc::{AppError, ErrorCode};
use crate::session::{
    application::{RuntimeEvent, SubagentObservation, TurnContext},
    AgentInfo,
};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

#[derive(Default)]
pub(super) struct Agents {
    children: HashMap<String, Child>,
    activity_generation: Option<u64>,
    activity_items: HashSet<String>,
}
struct Child {
    id: String,
    correlation: String,
    turn: Option<String>,
    generation: u64,
    retired_turns: HashSet<String>,
    status: String,
    completed: HashSet<String>,
}
impl Agents {
    pub(super) fn contains(&self, thread: &str) -> bool {
        self.children.contains_key(thread)
    }
    pub(super) fn running(&self) -> bool {
        self.children
            .values()
            .any(|child| child.status == "running")
    }
    pub(super) fn child_running(&self, thread: &str, generation: u64) -> bool {
        self.children
            .get(thread)
            .is_some_and(|child| child.generation == generation && child.status == "running")
    }
    pub(super) fn generation_matches(&self, thread: &str, generation: u64) -> bool {
        self.children
            .get(thread)
            .is_some_and(|child| child.generation == generation)
    }
    pub(super) fn matches_turn(&self, thread: &str, turn: &str) -> bool {
        self.children.get(thread).is_some_and(|child| {
            child
                .turn
                .as_deref()
                .map_or(!child.retired_turns.contains(turn), |current| {
                    current == turn
                })
        })
    }
    pub(super) fn closed(&mut self) -> Vec<RuntimeEvent> {
        let threads = self.threads();
        threads
            .into_iter()
            .flat_map(|thread| self.set_status(&thread, "failed"))
            .collect()
    }
    pub(super) fn threads(&self) -> Vec<String> {
        self.children.keys().cloned().collect()
    }
    pub(super) fn active(&self) -> Vec<(String, String)> {
        self.children
            .iter()
            .filter(|(_, child)| child.status == "running")
            .filter_map(|(thread, child)| child.turn.clone().map(|turn| (thread.clone(), turn)))
            .collect()
    }
    pub(super) fn call(&mut self, item: &Value, ctx: &TurnContext) -> Vec<RuntimeEvent> {
        let mut output = vec![];
        for thread in item["receiverThreadIds"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            if !self.children.contains_key(thread) {
                // A receiver is proof of a native dispatch. The acknowledgement
                // alone never means that receiver completed its task.
                if self.children.len() >= 128 {
                    continue;
                }
                let id = if ctx
                    .text
                    .starts_with("Delegate this task to a new Codex subagent")
                    && !self.children.values().any(|child| child.id == ctx.block_id)
                {
                    ctx.block_id.clone()
                } else {
                    crate::ids::uuid()
                };
                let correlation = crate::ids::uuid();
                let task = item["prompt"]
                    .as_str()
                    .unwrap_or("Codex subagent")
                    .to_string();
                let agent = AgentInfo {
                    id: id.clone(),
                    session_id: ctx.session_id.clone(),
                    name: format!("Agent {}", self.children.len() + 1),
                    task,
                    status: "running".into(),
                    started_at: crate::ids::now_ms(),
                    ended_at: None,
                    background: true,
                    last_activity: None,
                    step_count: 0,
                };
                self.children.insert(
                    thread.into(),
                    Child {
                        id,
                        correlation: correlation.clone(),
                        turn: None,
                        generation: ctx.scope.generation,
                        retired_turns: HashSet::new(),
                        status: "running".into(),
                        completed: HashSet::new(),
                    },
                );
                output.push(RuntimeEvent::SubagentStarted {
                    tool_use_id: correlation,
                    agent,
                });
            }
            if let Some(child) = self.children.get_mut(thread) {
                if child.generation != ctx.scope.generation {
                    if let Some(old) = child.turn.take() {
                        child.retired_turns.insert(old);
                    }
                    child.completed.clear();
                    child.generation = ctx.scope.generation;
                }
            }
            if let Some(status) = item["agentsStates"][thread]["status"].as_str() {
                output.extend(self.set_status(thread, status));
            }
        }
        output
    }
    /// Code-mode agents (Codex 0.159+) report identity through activity items;
    /// their collaboration-tool acknowledgements can have no receivers.
    pub(super) fn activity(&mut self, item: &Value, ctx: &TurnContext) -> Vec<RuntimeEvent> {
        let Some(thread) = item["agentThreadId"].as_str().filter(|id| !id.is_empty()) else {
            return vec![];
        };
        let status = match item["kind"].as_str() {
            Some("started" | "interacted") => "running",
            Some("completed") => "completed",
            Some("interrupted") => "interrupted",
            _ => return vec![],
        };
        let Some(id) = item["id"].as_str().filter(|id| !id.is_empty()) else {
            return vec![];
        };
        if self.activity_generation != Some(ctx.scope.generation) {
            self.activity_items.clear();
            self.activity_generation = Some(ctx.scope.generation);
        }
        if !self.activity_items.insert(id.into()) {
            return vec![];
        }
        let mut events = self.call(
            &json!({
                "receiverThreadIds": [thread],
                "agentsStates": { (thread): { "status": status } }
            }),
            ctx,
        );
        if let Some(name) = item["agentPath"]
            .as_str()
            .and_then(|path| path.rsplit('/').find(|segment| !segment.is_empty()))
        {
            for event in &mut events {
                if let RuntimeEvent::SubagentStarted { agent, .. } = event {
                    agent.name = name.into();
                }
            }
        }
        events
    }
    fn set_status(&mut self, thread: &str, status: &str) -> Vec<RuntimeEvent> {
        let Some(child) = self.children.get_mut(thread) else {
            return vec![];
        };
        let status = match status {
            "pendingInit" | "running" | "inProgress" => "running",
            "completed" | "shutdown" => "done",
            "errored" | "failed" | "notFound" | "interrupted" => "error",
            _ => return vec![],
        };
        if child.status == status {
            return vec![];
        }
        child.status = status.into();
        vec![RuntimeEvent::SubagentState {
            agent_id: child.id.clone(),
            status: status.into(),
            at: crate::ids::now_ms(),
        }]
    }
    pub(super) fn notification(&mut self, method: &str, params: &Value) -> Vec<RuntimeEvent> {
        let Some(thread) = params["threadId"].as_str() else {
            return vec![];
        };
        if method == "turn/started" {
            if let Some(child) = self.children.get_mut(thread) {
                let next = params["turn"]["id"].as_str().map(String::from);
                let Some(next_id) = next.as_ref() else {
                    return vec![];
                };
                if child.retired_turns.contains(next_id) {
                    return vec![];
                }
                if params["_snapshot"] == true
                    && child
                        .turn
                        .as_ref()
                        .is_some_and(|current| current != next_id)
                {
                    return vec![];
                }
                if child.turn == next && params["_snapshot"] == true {
                    return vec![];
                }
                if child.turn != next {
                    if let Some(old) = child.turn.take() {
                        child.retired_turns.insert(old);
                    }
                    child.completed.clear();
                }
                child.turn = next;
            }
            return self.set_status(thread, "running");
        }
        if method == "turn/completed" {
            let Some(turn) = params["turn"]["id"].as_str() else {
                return vec![];
            };
            if !self.matches_turn(thread, turn) {
                return vec![];
            }
            if let Some(child) = self.children.get_mut(thread) {
                child.retired_turns.insert(turn.into());
            }
            return self.set_status(
                thread,
                params["turn"]["status"].as_str().unwrap_or("failed"),
            );
        }
        let Some(child) = self.children.get_mut(thread) else {
            return vec![];
        };
        if child
            .turn
            .as_deref()
            .is_some_and(|turn| params["turnId"].as_str() != Some(turn))
        {
            return vec![];
        }
        if method != "item/completed" {
            return vec![];
        }
        let item = &params["item"];
        let Some(id) = item["id"].as_str() else {
            return vec![];
        };
        if !child.completed.insert(id.into()) {
            return vec![];
        }
        let local_id = crate::ids::uuid();
        let items = match item["type"].as_str() {
            Some("agentMessage") => vec![SubagentObservation::Text(
                item["text"].as_str().unwrap_or_default().into(),
            )],
            Some("commandExecution") => vec![
                SubagentObservation::ToolUse {
                    id: Some(local_id.clone()),
                    name: "Bash".into(),
                    input: json!({"command":item["command"]}),
                },
                SubagentObservation::ToolResult {
                    tool_use_id: local_id.clone(),
                    text: item["aggregatedOutput"].as_str().unwrap_or_default().into(),
                    is_error: item["exitCode"].as_i64().is_some_and(|code| code != 0),
                },
            ],
            Some("mcpToolCall") => vec![
                SubagentObservation::ToolUse {
                    id: Some(local_id.clone()),
                    name: format!(
                        "mcp__{}__{}",
                        item["server"].as_str().unwrap_or_default(),
                        item["tool"].as_str().unwrap_or_default()
                    ),
                    input: item["arguments"].clone(),
                },
                SubagentObservation::ToolResult {
                    tool_use_id: local_id.clone(),
                    text: item["result"].to_string(),
                    is_error: item["status"] == "failed",
                },
            ],
            Some("fileChange") => vec![
                SubagentObservation::ToolUse {
                    id: Some(local_id.clone()),
                    name: "Edit".into(),
                    input: json!({"changes":item["changes"]}),
                },
                SubagentObservation::ToolResult {
                    tool_use_id: local_id.clone(),
                    text: item["changes"].to_string(),
                    is_error: item["status"] == "failed",
                },
            ],
            Some("plan") => vec![SubagentObservation::Text(
                item["text"].as_str().unwrap_or_default().into(),
            )],
            Some("reasoning") => vec![SubagentObservation::Text(
                item["summary"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join("\n"),
            )],
            Some("webSearch") => vec![SubagentObservation::ToolUse {
                id: Some(local_id),
                name: "WebSearch".into(),
                input: json!({"query":item["query"]}),
            }],
            Some("imageView") => vec![SubagentObservation::ToolUse {
                id: Some(local_id),
                name: "ViewImage".into(),
                input: json!({"path":item["path"]}),
            }],
            _ => vec![],
        };
        if items.is_empty() {
            return vec![];
        }
        vec![RuntimeEvent::SubagentObserved {
            parent_tool_use_id: child.correlation.clone(),
            items,
            at: crate::ids::now_ms(),
        }]
    }
}
impl Inner {
    pub(super) fn stop_agent(&self, id: &str) -> Result<Value, AppError> {
        let (connection, thread, turn) = {
            let state = self.state.lock().unwrap();
            let (thread, child) = state
                .agents
                .children
                .iter()
                .find(|(_, child)| child.id == id)
                .ok_or_else(|| AppError::new(ErrorCode::AgentNotFound, "No such native agent"))?;
            (
                state.transport.clone().ok_or_else(transport::unavailable)?,
                thread.clone(),
                child.turn.clone(),
            )
        };
        let turn = match turn {
            Some(turn) => turn,
            None => {
                let result = connection.call(Transport::deadline(), |request_id| {
                    Ok(protocol::request(
                        request_id,
                        "thread/read",
                        json!({"threadId":thread,"includeTurns":true}),
                    ))
                })?;
                result["thread"]["turns"]
                    .as_array()
                    .and_then(|turns| {
                        turns
                            .iter()
                            .rev()
                            .find(|turn| turn["status"] == "inProgress")
                    })
                    .and_then(|turn| turn["id"].as_str())
                    .map(String::from)
                    .ok_or_else(|| {
                        AppError::new(
                            ErrorCode::SessionNotRunning,
                            "This agent has no active native turn",
                        )
                    })?
            }
        };
        connection.call(Transport::deadline(), |id| {
            Ok(protocol::interrupt(id, &thread, &turn))
        })?;
        Ok(Value::Null)
    }
    pub(super) fn subscribe_child(
        self: &Arc<Self>,
        thread: String,
        ctx: TurnContext,
        connection: Arc<Transport>,
    ) {
        let weak = Arc::downgrade(self);
        std::thread::spawn(move || {
            let result = connection.call(Transport::deadline(), |id| {
                Ok(protocol::request(
                    id,
                    "thread/resume",
                    json!({"threadId":thread,"excludeTurns":false}),
                ))
            });
            let Some(inner) = weak.upgrade() else {
                return;
            };
            let valid_scope = {
                let state = inner.state.lock().unwrap();
                !state.closed
                    && state
                        .turn
                        .as_ref()
                        .is_some_and(|turn| turn.context.scope == ctx.scope)
                    && state
                        .agents
                        .generation_matches(&thread, ctx.scope.generation)
            };
            if !valid_scope {
                return;
            }
            let result = match result {
                Ok(result) if returned_thread(&result, Some(&thread)).is_ok() => result,
                _ => {
                    inner.child_subscription_failed(&ctx.scope, &thread, AppError::new(ErrorCode::RuntimeUnavailable, "Codex could not subscribe to the subagent transcript. Reconnect the session to recover its native state."));
                    return;
                }
            };
            for turn in result["thread"]["turns"]
                .as_array()
                .into_iter()
                .flatten()
                .rev()
                .take(1)
            {
                let scoped = |method: &str, payload: Value| {
                    let mut payload = payload;
                    payload["_snapshot"] = json!(true);
                    payload["_snapshotGeneration"] = json!(ctx.scope.generation);
                    inner.notification(method, &payload);
                };
                scoped(
                    "turn/started",
                    json!({"threadId":thread,"turn":{"id":turn["id"],"status":"inProgress"}}),
                );
                for item in turn["items"].as_array().into_iter().flatten() {
                    if matches!(item["status"].as_str(), Some("inProgress" | "pending")) {
                        continue;
                    }
                    scoped(
                        "item/completed",
                        json!({"threadId":thread,"turnId":turn["id"],"item":item}),
                    );
                }
                if turn["status"] != "inProgress" {
                    scoped("turn/completed", json!({"threadId":thread,"turn":turn}));
                }
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::adapter::codex::native::integration_tests::context;
    #[test]
    fn activity_items_discover_named_children_once_and_track_restarts() {
        let mut agents = Agents::default();
        let ctx = context(1, None);
        let item = json!({"type":"subAgentActivity","id":"activity-1","kind":"started","agentThreadId":"child","agentPath":"/root/backend"});
        let events = agents.activity(&item, &ctx);
        assert!(
            matches!(&events[0], RuntimeEvent::SubagentStarted { agent, .. } if agent.name == "backend" && agent.session_id == ctx.session_id && agent.status == "running")
        );
        assert!(agents.activity(&item, &ctx).is_empty());
        assert!(agents.activity(&json!({"id":"done", "kind":"completed", "agentThreadId":"child"}), &ctx).iter().any(|event| matches!(event, RuntimeEvent::SubagentState { status, .. } if status == "done")));
        assert!(!agents.running());
        assert!(agents.activity(&item, &ctx).is_empty());
        assert!(!agents.running());
        assert!(agents.activity(&json!({"id":"followup", "kind":"interacted", "agentThreadId":"child"}), &ctx).iter().any(|event| matches!(event, RuntimeEvent::SubagentState { status, .. } if status == "running")));
        assert!(agents
            .activity(
                &json!({"id":"done", "kind":"completed", "agentThreadId":"child"}),
                &ctx
            )
            .is_empty());
        assert!(agents.running());
        assert!(agents.activity(&json!({"id":"stop", "kind":"interrupted", "agentThreadId":"child"}), &ctx).iter().any(|event| matches!(event, RuntimeEvent::SubagentState { status, .. } if status == "error")));
        assert!(agents
            .activity(&json!({"kind":"unknown", "agentThreadId":"unknown"}), &ctx)
            .is_empty());
        assert!(!agents.contains("unknown"));
        assert!(agents
            .activity(&json!({"kind":"started", "agentThreadId":""}), &ctx)
            .is_empty());
    }

    #[test]
    fn stale_child_completion_and_snapshot_cannot_replace_a_newer_turn() {
        let mut agents = Agents::default();
        let ctx = context(1, None);
        agents.call(
            &json!({"receiverThreadIds":["child"],"agentsStates":{"child":{"status":"running"}}}),
            &ctx,
        );
        agents.notification(
            "turn/started",
            &json!({"threadId":"child","turn":{"id":"old"}}),
        );
        agents.notification(
            "turn/started",
            &json!({"threadId":"child","turn":{"id":"new"}}),
        );
        assert!(agents
            .notification(
                "turn/completed",
                &json!({"threadId":"child","turn":{"id":"old","status":"completed"}})
            )
            .is_empty());
        assert!(agents
            .notification(
                "turn/started",
                &json!({"threadId":"child","_snapshot":true,"turn":{"id":"old"}})
            )
            .is_empty());
        assert_eq!(agents.active(), vec![("child".into(), "new".into())]);
        assert!(agents.generation_matches("child", 1));
        assert!(!agents.generation_matches("child", 2));
        assert!(!agents
            .notification(
                "turn/completed",
                &json!({"threadId":"child","turn":{"id":"new","status":"completed"}})
            )
            .is_empty());
        assert!(agents
            .notification(
                "turn/started",
                &json!({"threadId":"child","turn":{"id":"new"}})
            )
            .is_empty());
        assert!(!agents.running());
    }
}
