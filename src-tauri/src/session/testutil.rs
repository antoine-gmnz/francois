//! Shared fixtures for the session module's unit tests — and, under the
//! `harness` feature (core-architecture-wave3 FR-3), for the `tests/` and
//! `benches/` targets, which are separate crates and can reach nothing else.

use super::*;

use crate::permissions::PermissionRule;
use serde_json::Value;
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::json;

// ---------- multi-provider-seam (specs/multi-provider-seam.md) ----------

/// A `TurnControl` that is NOT the Claude one (FR-2/FR-9): no child, no stdin,
/// no pending maps — just the ids it still holds and a record of what was done
/// to it. Everything the engine does to a live turn goes through this trait, so
/// a test can drive that path with an adapter the engine has never heard of;
/// anything that stops working here is the seam leaking.
pub struct FakeTurnControl {
    questions: Mutex<Vec<String>>,
    /// `(blockId, rule pattern)` — the pattern half is what
    /// `pending_permission_pattern` peeks, and it disappears WITH the id the
    /// moment the ask is claimed, exactly as the real pending entry does.
    permissions: Mutex<Vec<(String, String)>>,
    pub interrupted: AtomicBool,
    pub killed: AtomicBool,
}

impl FakeTurnControl {
    /// A turn holding `questions` parked asks (`q1`, `q2`, …) and
    /// `permissions` parked approvals (`p1`, `p2`, …).
    pub fn new(questions: usize, permissions: usize) -> Arc<FakeTurnControl> {
        Arc::new(FakeTurnControl {
            questions: Mutex::new((1..=questions).map(|i| format!("q{i}")).collect()),
            permissions: Mutex::new(
                (1..=permissions)
                    .map(|i| {
                        let id = format!("p{i}");
                        let pattern = FakeTurnControl::pattern_of(&id);
                        (id, pattern)
                    })
                    .collect(),
            ),
            interrupted: AtomicBool::new(false),
            killed: AtomicBool::new(false),
        })
    }

    /// The rule pattern the parked approval `id` carries — a real
    /// `permissions::build_ask` shape, so a rule written from it round-trips
    /// through the settings.json merge like any other.
    pub fn pattern_of(id: &str) -> String {
        format!("Bash({id}:*)")
    }
}

/// Removal IS the claim — same exactly-once semantics the real handle gives,
/// which is what makes `ControlAck::NotPending` mean the same thing for both.
fn claim(ids: &Mutex<Vec<String>>, id: &str) -> bool {
    let mut ids = ids.lock().unwrap();
    match ids.iter().position(|held| held == id) {
        Some(i) => {
            ids.remove(i);
            true
        }
        None => false,
    }
}

/// The permission counterpart of `claim` — same removal-is-the-claim rule over
/// the `(id, pattern)` pairs.
fn claim_permission(asks: &Mutex<Vec<(String, String)>>, id: &str) -> bool {
    let mut asks = asks.lock().unwrap();
    match asks.iter().position(|(held, _)| held == id) {
        Some(i) => {
            asks.remove(i);
            true
        }
        None => false,
    }
}

impl TurnControl for FakeTurnControl {
    fn interrupt(&self) {
        self.interrupted.store(true, Ordering::SeqCst);
    }
    fn kill(&self) {
        self.killed.store(true, Ordering::SeqCst);
    }
    fn answer_question(&self, id: &str, _answers: &Value) -> ControlAck {
        if claim(&self.questions, id) {
            ControlAck::Applied
        } else {
            ControlAck::NotPending
        }
    }
    fn decide_permission(&self, id: &str, _decision: PermissionDecision) -> ControlAck {
        if claim_permission(&self.permissions, id) {
            ControlAck::Applied
        } else {
            ControlAck::NotPending
        }
    }
    fn pending_permission_pattern(&self, id: &str) -> Option<String> {
        self.permissions
            .lock()
            .unwrap()
            .iter()
            .find(|(held, _)| held == id)
            .map(|(_, pattern)| pattern.clone())
    }
    fn pending_counts(&self) -> PendingCounts {
        PendingCounts {
            questions: self.questions.lock().unwrap().len(),
            permissions: self.permissions.lock().unwrap().len(),
        }
    }
    fn drain_pending(&self) -> (Vec<String>, Vec<String>) {
        (
            self.questions.lock().unwrap().drain(..).collect(),
            self.permissions
                .lock()
                .unwrap()
                .drain(..)
                .map(|(id, _)| id)
                .collect(),
        )
    }
}

// ---------- interactive-commands (specs/interactive-commands.md) ----------

pub fn test_session() -> Session {
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
        permission_mode_since: 0,
        runtime: "native".into(),
        allow_git: false,
        project_id: None,
        worktree: None,
        worktree_distro: None,
        account_id: "default".into(),
        cloud: None,
        agent_runtime: AgentRuntime::ClaudeCode,
        protocol: ProviderProtocol::Anthropic,
        system_prompt: None,
        extra_args: Vec::new(),
        profile: None,
        response_mode: ResponseMode::Default,
        response_mode_sent: None,
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
        transcript_truncated: false,
        attachments: Vec::new(),
        mcp: HashMap::new(),
        workflows: HashMap::new(),
        workflow_order: Vec::new(),
        workflow_by_tool: HashMap::new(),
        workflow_scripts: HashMap::new(),
        cli_commands: Vec::new(),
        grok_sandbox_notice_emitted: false,
    }
}

/// workflow-panel: a minimal running run, for the event/serde shape tests.
pub fn test_workflow_run() -> WorkflowRun {
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

/// The state a turn actually replays from: `do_send` sets `starting` before it
/// spawns, so `system/init` has a status to promote. A fixture rather than a
/// field poke, because `Session`'s fields are private and core-architecture-wave3
/// FR-2 says to widen by name only what a caller genuinely needs — an external
/// target needs this *state*, not the field.
pub fn starting_session() -> Session {
    let mut s = test_session();
    s.status = "starting".into();
    s
}

/// core-architecture-wave3 FR-11's stand-in for an `AppHandle`. Every session
/// is a Claude Code account unless the test says otherwise, which matches
/// `account::kind_of`'s own fallback for `default` and for an id that no longer
/// resolves — a session whose account vanished runs as Claude Code, a working
/// state, rather than as a provider whose credentials it does not have.
#[derive(Default)]
pub struct FakeAccounts {
    kinds: HashMap<String, crate::account::AccountKind>,
}

impl FakeAccounts {
    pub fn with(mut self, account_id: &str, kind: crate::account::AccountKind) -> Self {
        self.kinds.insert(account_id.to_string(), kind);
        self
    }
}

impl crate::account::AccountKinds for FakeAccounts {
    fn kind_of(&self, account_id: &str) -> crate::account::AccountKind {
        self.kinds
            .get(account_id)
            .copied()
            .unwrap_or(crate::account::AccountKind::ClaudeCodeOauth)
    }
}

/// The no-configuration case, spelled once so the ~15 call sites that only need
/// *an* account source do not each construct one.
pub fn fake_accounts() -> FakeAccounts {
    FakeAccounts::default()
}

pub fn test_engine_with(session: Session) -> Engine {
    let mut map = HashMap::new();
    map.insert(session.id.clone(), session);
    Engine {
        sessions: Mutex::new(map),
        // workflow-details §6: the scan/watch and attributed-ask registries start
        // empty for every test — no shared global state between tests.
        ..Default::default()
    }
}

pub fn ndjson(lines: &[Value]) -> Vec<String> {
    lines
        .iter()
        .map(|v| serde_json::to_string(v).unwrap())
        .collect()
}

/// The §5.5 question-arrival fixture, verbatim.
pub fn ask_fixture() -> Value {
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

pub fn perm_session() -> Session {
    let mut s = test_session();
    s.cwd = "/repo".into();
    s
}

pub fn sample_rule() -> PermissionRule {
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

pub fn agent_fixture(id: &str, name: &str, background: bool) -> AgentInfo {
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
pub fn mint_agent(s: &mut Session, id: &str, name: &str, tuid: &str, background: bool) {
    s.insert_agent(agent_fixture(id, name, background));
    s.agent_by_tool.insert(tuid.into(), id.into());
}

pub fn emitted_steps(ems: &[AgentEmission]) -> Vec<AgentStep> {
    ems.iter()
        .filter_map(|e| match e {
            AgentEmission::Step { step, .. } => Some(step.clone()),
            _ => None,
        })
        .collect()
}

/// agent-tab: the serialized AgentBlocks an emission list carries, in order.
pub fn emitted_blocks(ems: &[AgentEmission]) -> Vec<Value> {
    ems.iter()
        .filter_map(|e| match e {
            AgentEmission::Block { block, .. } => Some(block.clone()),
            _ => None,
        })
        .collect()
}

pub fn emitted_updates(ems: &[AgentEmission]) -> Vec<AgentInfo> {
    ems.iter()
        .filter_map(|e| match e {
            AgentEmission::Update { agent } => Some(agent.clone()),
            _ => None,
        })
        .collect()
}
