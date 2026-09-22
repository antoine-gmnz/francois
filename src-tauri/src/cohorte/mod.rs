// cohorte/ — the `cohorte-integration` domain (specs/cohorte-integration.md,
// contract/cohorte-integration.ts). A Cohorte v3 run becomes a first-class
// citizen of Francois: the core detects `.cohorte/`, polls the CLI's `--json`
// documents and event dump, normalises every Protocol 1.0 event into a typed
// `CohorteEvent`, and answers gates by SHELLING OUT to the CLI — Francois never
// signs a command, never reads the SQLite store, never writes into `.cohorte/`.
//
// mod.rs owns the shared data model — the serde mirrors of the contract's
// records, projection, detection/doctor/policy documents and requests — plus
// `CohorteState` (Tauri managed state). The 68 wire payloads and the
// `CohorteEvent` union live in `catalogue.rs` only because together with this
// file they would pass the 1000-line cap. Children, one concern each:
//  * sanitize.rs   — FR-27: control/bidi stripping, NFC, caps, id validation, ISO → ms.
//  * payloads.rs   — FR-28: the 68 payload mirrors.
//  * catalogue.rs  — FR-28: `CohorteEvent` (tag `type`) over those payloads.
//  * wire.rs       — FR-28/FR-22: envelope → one `CohorteEvent`, coalescing.
//  * documents.rs  — FR-14/FR-10/FR-11: status (3 shapes), doctor, config, command result.
//  * projection.rs — FR-24/25/29: the run reducer → `CohorteRun`.
//  * gate.rs       — FR-39..FR-41: gate, finding labels, the offered actions.
//  * cli.rs        — FR-1a/FR-45/FR-47: argv builders, the one runner, exit mapping.
//  * detect.rs     — FR-2..FR-7: detection + the CLI probe, both cached.
//  * actions.rs    — FR-42..FR-46: approve / send-to-fix / deny / pause / resume / cancel.
//  * watcher.rs    — FR-15..FR-23, FR-26: scheduler, tail dedupe/HWM, log ring, emission.
//  * commands.rs   — the 14 `cohorte_*` Tauri commands.
//
// LOCK ORDER: `CohorteState` is a LEAF — nothing here takes another domain's
// lock. Inside it: `roots` (the map) before any one `RootWatch`, never the
// reverse; a `RootWatch` lock is never held across a CLI spawn.

mod actions;
mod catalogue;
mod cli;
mod commands;
mod detect;
mod documents;
mod gate;
mod payloads;
mod projection;
mod sanitize;
mod watcher;
mod wire;

#[cfg(test)]
mod testutil;

pub use catalogue::CohorteEvent;
pub use commands::*;

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::time::Instant;

/// francois:cohorte:event → `francois://cohorte/event` (§5).
pub const EVENT_CHANNEL: &str = "francois://cohorte/event";

/// FR-5, reported verbatim in `CohorteCliInfo.supportedRange`.
pub const SUPPORTED_RANGE: &str = ">=3.0.0-dev.1 <4.0.0";

// =====================================================================
// 1. Shared records (normalised) — contract §1
// =====================================================================

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PhaseRef {
    pub phase_run_id: String,
    pub state: String,
    pub iteration: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentRef {
    pub agent_id: String,
    pub role: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub surface: Option<String>,
    pub incarnation: u64,
    pub attempt: u64,
}

/// base ErrorInfo, flattened: `cause`/`details`/`impact` dropped, text sanitised.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ErrorInfo {
    pub code: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub class: Option<String>,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remediation: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retryable: Option<bool>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Stop {
    pub reason: String,
    pub detail: String,
    pub resumable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume_requires: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub total: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct BudgetCounters {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_requests: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wall_clock_ms: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retries: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fix_rounds: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub concurrent_agents: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub estimated_quota_percent: Option<f64>,
}

/// MonetaryCost; the contract's `null` ('not_applicable') is `Option::None`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Cost {
    pub currency: String,
    pub amount: f64,
    pub basis: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QuotaWindow {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub used_percent: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resets_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit_label: Option<String>,
}

/// `{ known: false } | { known: true, provider, windows, observedAt }` — serde
/// cannot tag on a boolean, so the known-only fields are optional here and
/// absent (never null) when `known` is false.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Quota {
    pub known: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub windows: Option<Vec<QuotaWindow>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observed_at: Option<u64>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelRef {
    pub provider: String,
    pub model: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactRef {
    pub artifact_id: String,
    pub kind: String,
    pub path: String,
    pub bytes: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileTouch {
    pub path: String,
    pub op: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bytes: Option<u64>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CheckResult {
    pub name: String,
    pub status: String,
    pub argv: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i64>,
    pub duration_ms: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Lock {
    pub scope: String,
    pub key: String,
    pub mode: String,
    pub owner: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Actor {
    pub kind: String,
    pub id: String,
}

/// agent-output.ts Finding, normalised; `blocking`/`label` are FR-40's mapping.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    pub id: String,
    pub severity: String,
    pub kind: String,
    pub rule: String,
    pub title: String,
    pub expected: String,
    pub actual: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_line: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub symbol: Option<String>,
    pub confidence: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub suggested_fix: Option<String>,
    pub scope: String,
    pub disposition: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reviewer_agent_id: Option<String>,
    pub blocking: bool,
    pub label: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalPreview {
    pub kind: String,
    pub text: String,
    pub truncated: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalAsk {
    pub stage: String,
    pub rule_id: String,
    pub reason: String,
}

/// The full ApprovalRequest (refs.ts R6), normalised: sealed `args` dropped.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalRequest {
    pub approval_id: String,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<AgentRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phase: Option<PhaseRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    pub affected_paths: Vec<String>,
    pub preview: ApprovalPreview,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<String>>,
    pub rule_id: String,
    pub reason: String,
    pub asks: Vec<ApprovalAsk>,
    pub allowed_decisions: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<u64>,
    pub unattended: String,
    pub cli: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct SeverityCounts {
    pub critical: u64,
    pub major: u64,
    pub minor: u64,
    pub info: u64,
}

// =====================================================================
// 3. The projection the UI renders — contract §3
// =====================================================================

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StepWorktree {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    pub agent_id: String,
    pub role: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub surface: Option<String>,
    pub label: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lifecycle: Option<String>,
    pub attempt: u64,
    pub incarnation: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree: Option<StepWorktree>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub findings: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<ErrorInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_approval_id: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Phase {
    pub state: String,
    pub label: String,
    pub status: String,
    pub iteration: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome: Option<String>,
    pub steps: Vec<Step>,
    pub checks: Vec<CheckResult>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReviewRound {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phase_run_id: Option<String>,
    pub started_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verdict: Option<String>,
    pub findings: Vec<Finding>,
    pub counts: SeverityCounts,
    pub blocking: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clean: Option<bool>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GateAction {
    /// 'approve' | 'fix' | 'deny'
    pub id: String,
    pub stops_run: bool,
    pub cli: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Gate {
    pub run_id: String,
    pub request: ApprovalRequest,
    pub requested_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phase_index: Option<u64>,
    pub phase_count: u64,
    pub findings: Vec<Finding>,
    pub actions: Vec<GateAction>,
    pub more_pending: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    pub slot: String,
    pub path: String,
    pub branch: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    pub removed: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Artifact {
    pub kind: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub meta: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct RunIteration {
    pub fix_rounds: u64,
    pub max_fix_rounds: u64,
    pub review_rounds: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct RunHost {
    pub alive: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub heartbeat_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pid: Option<u64>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct RunGit {
    pub base_branch: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_sha: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub integration_branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub integration_head: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RunRuntime {
    pub id: String,
    pub version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pin_digest: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RunUsage {
    pub tokens: TokenUsage,
    pub cost: Option<Cost>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CohorteRun {
    pub project_root: String,
    pub run_id: String,
    pub title: String,
    pub spec_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spec_kind: Option<String>,
    pub profile: String,
    pub state: String,
    /// CohorteRunView: idle|running|gate|waiting|paused|auth|quota|failed|blocked|completed|cancelled
    pub view: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_phase: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume_to: Option<String>,
    pub since: u64,
    pub started_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop: Option<Stop>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<ErrorInfo>,
    pub iteration: RunIteration,
    pub host: RunHost,
    pub git: RunGit,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime: Option<RunRuntime>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snapshot_digest: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cohorte_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unattended: Option<bool>,
    pub phases: Vec<Phase>,
    pub worktrees: Vec<Worktree>,
    pub gate: Option<Gate>,
    pub review: Option<ReviewRound>,
    pub artifacts: Vec<Artifact>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<RunUsage>,
    pub last_sequence: u64,
    pub tail_truncated: bool,
    pub refreshed_at: u64,
}

/// One row of the activity log (FR-69). Every wire event yields one.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub run_id: String,
    pub sequence: u64,
    pub sub: u64,
    pub at: u64,
    #[serde(rename = "type")]
    pub type_: String,
    pub severity: String,
    pub summary: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phase: Option<String>,
}

// =====================================================================
// 4. Detection, doctor, policy — contract §4
// =====================================================================

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CliInfo {
    pub installed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    pub supported_range: String,
    pub compatible: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CohorteDetection {
    pub start_dir: String,
    /// detected | not-initialised | cli-missing | cli-incompatible | no-project
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dir: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub found_via: Option<String>,
    pub has_project_file: bool,
    pub state_backend: Option<String>,
    pub root_branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime: Option<String>,
    pub cli: CliInfo,
    pub checked_at: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HealthRow {
    pub command: String,
    pub status: String,
    pub summary: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remediation: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DoctorCheck {
    pub id: String,
    pub status: String,
    pub summary: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remediation: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CohorteDoctorReport {
    pub root: String,
    pub ok: bool,
    pub cohorte_version: String,
    pub generated_at: u64,
    pub checks: Vec<DoctorCheck>,
    pub rows: Vec<HealthRow>,
    pub ran_at: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CohortePolicySummary {
    pub root: String,
    pub gated_steps: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unattended: Option<String>,
    pub file: String,
    pub read_at: u64,
}

// =====================================================================
// 5. Commands — contract §5
// =====================================================================

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CohorteDetectRequest {
    pub start_dir: String,
    #[serde(default)]
    pub force: Option<bool>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CohorteRootRequest {
    pub root: String,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CohorteInitRequest {
    pub project_root: String,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CohorteWatchRequest {
    pub roots: Vec<String>,
    pub foreground: bool,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CohorteRunRequest {
    pub root: String,
    pub run_id: String,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CohorteRunLogRequest {
    pub root: String,
    pub run_id: String,
    #[serde(default)]
    pub limit: Option<u64>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CohorteApproveRequest {
    pub root: String,
    pub run_id: String,
    pub approval_id: String,
    #[serde(default)]
    pub answer: Option<String>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CohorteSendToFixRequest {
    pub root: String,
    pub run_id: String,
    pub approval_id: String,
    /// FR-45: 3.0.x takes no note — accepted for the contract, never passed.
    #[serde(default)]
    #[allow(dead_code)]
    pub note: Option<String>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CohorteDenyRequest {
    pub root: String,
    pub run_id: String,
    pub approval_id: String,
    pub stop_run: bool,
    /// FR-45: 3.0.x takes no note — accepted for the contract, never passed.
    #[serde(default)]
    #[allow(dead_code)]
    pub note: Option<String>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CohorteRunControlRequest {
    pub root: String,
    pub run_id: String,
    #[serde(default)]
    pub reason: Option<String>,
}

/// How one CLI step ended (FR-47). Exit 4 is NOT an error.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CommandStep {
    pub cli: String,
    /// completed | pending | rejected | skipped
    pub outcome: String,
    pub exit_code: i32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CommandOutcome {
    pub run_id: String,
    pub steps: Vec<CommandStep>,
    pub run: Option<CohorteRun>,
}

// =====================================================================
// 6. Core state (spec §6) — in memory, nothing persisted
// =====================================================================

/// The emitter every derived/wire event goes out through; set from the
/// `AppHandle` on the first command so the watcher threads can reach it.
pub(crate) type Emitter = Arc<dyn Fn(&CohorteEvent) + Send + Sync>;

pub(crate) struct Inner {
    /// FR-1a: the ONE process runner (injectable so tests never need a real CLI).
    pub(crate) runner: Arc<dyn cli::Runner>,
    /// The user's home — `~/.cohorte` is Cohorte's user config layer, not a project (FR-2).
    pub(crate) home: Option<PathBuf>,
    pub(crate) detections: Mutex<HashMap<String, (Instant, CohorteDetection)>>,
    /// FR-7: the last detection emitted per startDir, for the changed-edge.
    pub(crate) emitted_detections: Mutex<HashMap<String, CohorteDetection>>,
    /// FR-4: `cohorte --version` per host dialect, 5 minutes.
    pub(crate) cli_probes: Mutex<HashMap<String, (Instant, CliInfo)>>,
    pub(crate) roots: Mutex<HashMap<String, Arc<Mutex<watcher::RootWatch>>>>,
    pub(crate) watch_set: Mutex<watcher::WatchSet>,
    pub(crate) foreground: AtomicBool,
    /// FR-16: mutating commands are serialised per run.
    pub(crate) run_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    pub(crate) emitter: Mutex<Option<Emitter>>,
}

impl Inner {
    pub(crate) fn with_runner(runner: Arc<dyn cli::Runner>, home: Option<PathBuf>) -> Self {
        Inner {
            runner,
            home,
            detections: Mutex::new(HashMap::new()),
            emitted_detections: Mutex::new(HashMap::new()),
            cli_probes: Mutex::new(HashMap::new()),
            roots: Mutex::new(HashMap::new()),
            watch_set: Mutex::new(watcher::WatchSet::default()),
            foreground: AtomicBool::new(true),
            run_locks: Mutex::new(HashMap::new()),
            emitter: Mutex::new(None),
        }
    }

    pub(crate) fn emit(&self, events: &[CohorteEvent]) {
        let emitter = self.emitter.lock().unwrap().clone();
        if let Some(emit) = emitter {
            for ev in events {
                emit(ev);
            }
        }
    }
}

/// Tauri managed state (`.manage(cohorte::CohorteState::default())`).
#[derive(Clone)]
pub struct CohorteState {
    pub(crate) inner: Arc<Inner>,
}

impl Default for CohorteState {
    fn default() -> Self {
        CohorteState {
            inner: Arc::new(Inner::with_runner(
                Arc::new(cli::SystemRunner),
                dirs::home_dir(),
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_run_round_trips_through_serde_with_contract_field_names() {
        let run = testutil::sample_run();
        let json = serde_json::to_value(&run).unwrap();
        for key in [
            "projectRoot",
            "runId",
            "specId",
            "view",
            "lastSequence",
            "tailTruncated",
            "refreshedAt",
            "gate",
            "review",
        ] {
            assert!(json.get(key).is_some(), "missing {key}");
        }
        // Nullable-but-required fields serialise as null, never vanish.
        assert!(json["gate"].is_null());
        let back: CohorteRun = serde_json::from_value(json).unwrap();
        assert_eq!(back, run);
    }

    #[test]
    fn a_detection_serialises_its_nullable_fields_as_null() {
        let det = CohorteDetection {
            start_dir: "/p".into(),
            state: "not-initialised".into(),
            root: None,
            dir: None,
            found_via: None,
            has_project_file: false,
            state_backend: None,
            root_branch: None,
            runtime: None,
            cli: CliInfo {
                installed: false,
                version: None,
                supported_range: SUPPORTED_RANGE.into(),
                compatible: false,
            },
            checked_at: 1,
        };
        let json = serde_json::to_value(&det).unwrap();
        assert!(json["stateBackend"].is_null());
        assert!(json["rootBranch"].is_null());
        assert!(json.get("root").is_none());
        assert_eq!(json["cli"]["supportedRange"], SUPPORTED_RANGE);
        let back: CohorteDetection = serde_json::from_value(json).unwrap();
        assert_eq!(back, det);
    }

    #[test]
    fn the_log_entry_type_field_is_named_type() {
        let e = LogEntry {
            run_id: "run_a".into(),
            sequence: 1,
            sub: 0,
            at: 2,
            type_: "error".into(),
            severity: "error".into(),
            summary: "s".into(),
            agent_id: None,
            phase: None,
        };
        assert_eq!(serde_json::to_value(&e).unwrap()["type"], "error");
    }

    #[test]
    fn a_command_outcome_round_trips() {
        let o = CommandOutcome {
            run_id: "run_a".into(),
            steps: vec![CommandStep {
                cli: "cohorte deny run_a apr_b".into(),
                outcome: "rejected".into(),
                exit_code: 3,
                message: Some("nope".into()),
                error_code: Some("conflict/unexpected".into()),
            }],
            run: None,
        };
        let json = serde_json::to_value(&o).unwrap();
        assert_eq!(json["steps"][0]["exitCode"], 3);
        assert_eq!(json["steps"][0]["errorCode"], "conflict/unexpected");
        assert!(json["run"].is_null());
        assert_eq!(serde_json::from_value::<CommandOutcome>(json).unwrap(), o);
    }
}
