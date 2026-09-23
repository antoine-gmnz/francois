//! FR-28 — the 68 wire payload mirrors (contract §2), one struct per Cohorte
//! type, normalised: sealed/large blobs dropped, ISO → ms, text sanitised by
//! `wire.rs` before these are built. `catalogue.rs` binds them to type strings.

use super::{
    Actor, AgentRef, ArtifactRef, BudgetCounters, CheckResult, Cost, ErrorInfo, FileTouch, Finding,
    ModelRef, PhaseRef, Quota, SeverityCounts, Stop, TokenUsage,
};
use serde::{Deserialize, Serialize};

// ---------- run family ----------

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct SpecRef {
    pub id: String,
    pub kind: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimePin {
    pub id: String,
    pub version: String,
    pub pin_digest: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct BranchSha {
    pub branch: String,
    pub sha: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PipelineStarted {
    pub profile: String,
    pub spec: SpecRef,
    pub runtime: RuntimePin,
    pub snapshot_digest: String,
    pub base: BranchSha,
    pub integration_branch: String,
    pub cohorte_version: String,
    pub unattended: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Integration {
    pub branch: String,
    pub head_sha: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Totals {
    pub tokens: TokenUsage,
    pub cost: Option<Cost>,
    pub fix_rounds: u64,
    pub duration_ms: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct PipelineCompleted {
    pub stop: Stop,
    pub integration: Integration,
    pub totals: Totals,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PipelineFailed {
    pub state: String,
    pub error: ErrorInfo,
    pub stop: Stop,
    pub checkpoint_sequence: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RunStateChanged {
    pub from: String,
    pub to: String,
    pub reason: String,
    pub actor: Actor,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume_to: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop: Option<Stop>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RunPaused {
    pub parked_agents: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct RunResumed {
    pub mode: String,
    pub takeover: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RunCancelled {
    pub reason: String,
    pub cancelled_agents: Vec<String>,
    pub worktrees_kept: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RunHostAttached {
    pub host_id: String,
    pub pid: u64,
    pub cohorte_version: String,
    pub takeover: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RunHostDetached {
    pub host_id: String,
    pub cause: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlannedAgent {
    pub agent_id: String,
    pub role: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub surface: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct PhaseStarted {
    pub phase: PhaseRef,
    pub planned: Vec<PlannedAgent>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PhaseCompleted {
    pub phase: PhaseRef,
    pub outcome: String,
    pub outputs: Vec<ArtifactRef>,
    pub checks: Vec<CheckResult>,
    pub duration_ms: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct CheckStarted {
    pub name: String,
    pub argv: Vec<String>,
    pub slot: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ErrorPayload {
    pub error: ErrorInfo,
    pub fatal: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointCreated {
    pub at_sequence: u64,
    pub cause: String,
}

// ---------- agent family ----------

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentDeclared {
    pub agent: AgentRef,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_agent_id: Option<String>,
    pub owner: String,
    pub owned_paths: Vec<String>,
    pub requested_model: ModelRef,
    pub routing_reason: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SpawnWorktree {
    pub slot: String,
    pub path: String,
    pub branch: String,
    pub base_sha: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Sandbox {
    pub level: String,
    pub backend: String,
    pub filesystem: String,
    pub network: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentSpawned {
    pub agent: AgentRef,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree: Option<SpawnWorktree>,
    pub tools: Vec<String>,
    pub auth_mode: String,
    pub sandbox: Sandbox,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct AgentOnly {
    pub agent: AgentRef,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentStateChanged {
    pub agent: AgentRef,
    pub from: String,
    pub to: String,
    pub reason: String,
    pub attempt_consumed: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct AgentCompleted {
    pub agent: AgentRef,
    pub status: String,
    pub summary: String,
    pub confidence: f64,
    pub findings: u64,
    pub questions: Vec<String>,
    pub artifacts: Vec<ArtifactRef>,
    pub usage: BudgetCounters,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentFailed {
    pub agent: AgentRef,
    pub error: ErrorInfo,
    pub will_retry: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_incarnation: Option<u64>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct TurnStarted {
    pub turn: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TurnCompleted {
    pub turn: u64,
    pub tool_calls: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MessageStarted {
    pub message_id: String,
    pub role: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MessageDelta {
    pub message_id: String,
    pub channel: String,
    pub delta: String,
    pub coalesced: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MessageCompleted {
    pub message_id: String,
    pub role: String,
    pub preview: String,
    pub bytes: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MessageAccepted {
    pub agent: AgentRef,
    pub message_id: String,
    pub delivery: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct RuntimeWarning {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<AgentRef>,
    pub code: String,
    pub message: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelRequested {
    pub request_id: String,
    pub model: ModelRef,
    pub expected_auth_mode: String,
    pub attempt: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelResponded {
    pub request_id: String,
    pub requested_model: ModelRef,
    pub effective_model: ModelRef,
    pub auth_mode: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub http_status: Option<u64>,
    pub duration_ms: f64,
    pub tokens: TokenUsage,
    pub cost: Option<Cost>,
    pub quota: Quota,
    pub attempt: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<ErrorInfo>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ContextBuilt {
    pub agent: AgentRef,
    pub token_estimate: u64,
    pub token_limit: u64,
    pub entries: u64,
    pub exclusions: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct EscalationStep {
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct EscalationApplied {
    pub agent: AgentRef,
    pub step: EscalationStep,
    pub because: String,
}

// ---------- tool family ----------

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToolRequested {
    pub tool_call_id: String,
    pub tool: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToolDenied {
    pub tool_call_id: String,
    pub tool: String,
    pub stage: String,
    pub rule_id: String,
    pub reason: String,
    pub overridable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approval_id: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ToolRejected {
    pub tool: String,
    pub cause: String,
    pub message: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToolStarted {
    pub tool_call_id: String,
    pub tool: String,
    pub decision: String,
    pub rule_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replay_of_approval: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToolProgress {
    pub tool_call_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bytes: Option<u64>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToolCompleted {
    pub tool_call_id: String,
    pub tool: String,
    pub is_error: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i64>,
    pub timed_out: bool,
    pub duration_ms: f64,
    pub waited_ms: f64,
    pub preview: String,
    pub files_touched: Vec<FileTouch>,
    pub replayed: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileRead {
    pub tool_call_id: String,
    pub file: FileTouch,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct DiffStat {
    pub added: u64,
    pub removed: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileWritten {
    pub tool_call_id: String,
    pub file: FileTouch,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diff_stat: Option<DiffStat>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileChanged {
    pub slot: String,
    pub files: Vec<FileTouch>,
    pub detected_by: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attributed_to: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ReviewRef {
    #[serde(rename = "ref")]
    pub ref_: String,
    pub sha: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReviewStarted {
    pub phase: PhaseRef,
    pub review_ref: ReviewRef,
    pub surfaces: Vec<String>,
    pub reviewers: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ReviewFinding {
    pub finding: Finding,
    pub reviewer: AgentRef,
    pub disposition: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReviewCompleted {
    pub verdict: String,
    pub blocking: u64,
    pub blocking_items: Vec<String>,
    pub unreviewed: Vec<String>,
    pub counts: SeverityCounts,
    pub clean: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Waiver {
    pub finding_id: String,
    pub approval_id: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReviewApproved {
    pub review_ref: ReviewRef,
    pub waivers: Vec<Waiver>,
}

// ---------- governance family ----------

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalResolved {
    pub approval_id: String,
    pub decision: String,
    pub actor: Actor,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answer: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct BudgetScope {
    pub level: String,
    pub id: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct BudgetUpdated {
    pub scope: BudgetScope,
    pub consumed: BudgetCounters,
    pub limit: BudgetCounters,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub threshold: Option<u64>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct BudgetExceeded {
    pub scope: BudgetScope,
    pub counter: String,
    pub limit: f64,
    pub consumed: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QuotaUpdated {
    pub provider: String,
    pub auth_mode: String,
    pub quota: Quota,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct AuthRequired {
    pub provider: String,
    pub cause: String,
    pub cli: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct RetryTarget {
    pub kind: String,
    pub id: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RetryScheduled {
    pub target: RetryTarget,
    pub attempt: u64,
    pub max_attempts: u64,
    pub delay_ms: f64,
    pub cause: ErrorInfo,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CommandAccepted {
    pub command_id: String,
    pub command_type: String,
    pub actor: Actor,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CommandCompleted {
    pub command_id: String,
    pub command_type: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CommandRejected {
    pub command_id: String,
    pub command_type: String,
    pub error: ErrorInfo,
    /// R-4, Francois-derived: this app issued the command in the last 60 s.
    /// Absent on the wire (Cohorte never sends it) → false until the core marks it.
    #[serde(default)]
    pub issued_by_francois: bool,
}

// ---------- git family ----------

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeCreated {
    pub slot: String,
    pub path: String,
    pub branch: String,
    pub base_sha: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct WorktreeProvisioned {
    pub slot: String,
    pub network: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeQuarantined {
    pub slot: String,
    pub reset_to: String,
    pub patch: ArtifactRef,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct WorktreeRemoved {
    pub slot: String,
    pub path: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct CommitCreated {
    pub slot: String,
    pub branch: String,
    pub sha: String,
    pub kind: String,
    pub paths: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MergeCompleted {
    pub from: String,
    pub into: String,
    pub merge_sha: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct MergeConflicted {
    pub from: String,
    pub into: String,
    pub files: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct RepoChangeDetected {
    pub slot: String,
    pub expected: String,
    pub actual: String,
    pub files: Vec<FileTouch>,
}

// ---------- stream family ----------

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotPayload {
    pub last_sequence: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HeartbeatPayload {
    pub host_alive: bool,
    pub last_sequence: u64,
}
