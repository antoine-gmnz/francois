//! Shared fixtures for the session module's unit tests.

use super::*;

use crate::permissions::PermissionRule;
use serde_json::Value;
use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;

use serde_json::json;

// ---------- interactive-commands (specs/interactive-commands.md) ----------

pub(crate) fn test_session() -> Session {
    Session {
        id: "s1".into(),
        name: "n".into(),
        cwd: "/x".into(),
        model_id: "sonnet".into(),
        status: "idle".into(),
        context_used_tokens: 0,
        context_limit_tokens: 200_000,
        started_at: 0,
        last_activity_at: 0,
        error_message: None,
        effort: None,
        permission_mode: "default".into(),
        runtime: "native".into(),
        allow_git: false,
        project_id: None,
        worktree: None,
        worktree_distro: None,
        account_id: "default".into(),
        queue: VecDeque::new(),
        claude_session_id: None,
        current: None,
        pending_probe: None,
        agents: HashMap::new(),
        agent_order: Vec::new(),
        agent_by_tool: HashMap::new(),
        agent_steps: HashMap::new(),
        agent_step_seq: HashMap::new(),
        agent_inner_tools: HashMap::new(),
        agent_backend_ref: HashMap::new(),
        agent_blocks: HashMap::new(),
        agent_block_seq: HashMap::new(),
        agent_blocks_dropped: HashMap::new(),
        block_buffer: Vec::new(),
        attachments: Vec::new(),
        mcp: HashMap::new(),
        workflows: HashMap::new(),
        workflow_order: Vec::new(),
        workflow_by_tool: HashMap::new(),
        workflow_scripts: HashMap::new(),
        cli_commands: Vec::new(),
    }
}

/// workflow-panel: a minimal running run, for the event/serde shape tests.
pub(crate) fn test_workflow_run() -> WorkflowRun {
    WorkflowRun {
        id: "w1".into(),
        session_id: "s1".into(),
        name: "review-changes".into(),
        description: "Review changed files across dimensions".into(),
        status: "running".into(),
        started_at: 1_000,
        ended_at: None,
        phases: Vec::new(),
        run_id: None,
        last_activity: None,
        transcript_dir: None,
        pending_asks: None,
    }
}

pub(crate) fn test_engine_with(session: Session) -> Engine {
    let mut map = HashMap::new();
    map.insert(session.id.clone(), session);
    Engine {
        sessions: Mutex::new(map),
        // workflow-details §6: the scan/watch and attributed-ask registries start
        // empty for every test — no shared global state between tests.
        ..Default::default()
    }
}

pub(crate) fn ndjson(lines: &[Value]) -> Vec<String> {
    lines
        .iter()
        .map(|v| serde_json::to_string(v).unwrap())
        .collect()
}

/// The §5.5 question-arrival fixture, verbatim.
pub(crate) fn ask_fixture() -> Value {
    json!({
        "type": "control_request",
        "request_id": "req-1",
        "request": {
            "subtype": "can_use_tool",
            "tool_name": "AskUserQuestion",
            "display_name": "AskUserQuestion",
            "input": { "questions": [{
                "question": "Which color do you prefer?",
                "header": "Color",
                "options": [
                    { "label": "Red", "description": "The color red" },
                    { "label": "Blue", "description": "The color blue" }
                ],
                "multiSelect": false
            }] },
            "tool_use_id": "toolu_1"
        }
    })
}

// ---------- permission-guardrails (specs/permission-guardrails.md) ----------

pub(crate) fn perm_session() -> Session {
    let mut s = test_session();
    s.cwd = "/repo".into();
    s
}

pub(crate) fn sample_rule() -> PermissionRule {
    PermissionRule {
        id: "local|allow|Bash(npm test:*)".into(),
        pattern: "Bash(npm test:*)".into(),
        effect: "allow".into(),
        tier: "local".into(),
        enabled: true,
        label: "npm test (any arguments)".into(),
    }
}

// ---------- async-agents (specs/async-agents.md) ----------

pub(crate) fn agent_fixture(id: &str, name: &str, background: bool) -> AgentInfo {
    AgentInfo {
        id: id.into(),
        session_id: "s1".into(),
        name: name.into(),
        task: "look around".into(),
        status: "running".into(),
        started_at: 1_000,
        ended_at: None,
        background,
        last_activity: None,
        step_count: 0,
    }
}

/// Mint an agent with its FR-1 correlation key, as content_block_start does.
pub(crate) fn mint_agent(s: &mut Session, id: &str, name: &str, tuid: &str, background: bool) {
    s.insert_agent(agent_fixture(id, name, background));
    s.agent_by_tool.insert(tuid.into(), id.into());
}

pub(crate) fn emitted_steps(ems: &[AgentEmission]) -> Vec<AgentStep> {
    ems.iter()
        .filter_map(|e| match e {
            AgentEmission::Step { step, .. } => Some(step.clone()),
            _ => None,
        })
        .collect()
}

/// agent-tab: the serialized AgentBlocks an emission list carries, in order.
pub(crate) fn emitted_blocks(ems: &[AgentEmission]) -> Vec<Value> {
    ems.iter()
        .filter_map(|e| match e {
            AgentEmission::Block { block, .. } => Some(block.clone()),
            _ => None,
        })
        .collect()
}

pub(crate) fn emitted_updates(ems: &[AgentEmission]) -> Vec<AgentInfo> {
    ems.iter()
        .filter_map(|e| match e {
            AgentEmission::Update { agent } => Some(agent.clone()),
            _ => None,
        })
        .collect()
}
