//! FR-28 — the Cohorte Protocol 1.0 catalogue mirrored member by member: one
//! payload struct per type (contract §2), and `CohorteEvent`, the tagged union
//! (`type` discriminator) of the 68 wire members + `unknown` + the six derived
//! `francois.*` members. `wire.rs` builds these from raw envelopes; nothing
//! else constructs a wire member.

use super::payloads::*;
use super::{
    AgentRef, ApprovalRequest, CheckResult, CohorteDetection, CohorteRun, Gate, Lock, PhaseRef,
};
use crate::ipc::ErrorCode;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Shared by every wire member (contract `CohorteEventHeader`).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EventHeader {
    pub project_root: String,
    pub run_id: String,
    pub event_id: String,
    pub sequence: u64,
    pub sub: u64,
    pub durability: String,
    pub at: u64,
    pub source: String,
    pub severity: String,
    pub summary: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phase: Option<PhaseRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<AgentRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub causation_id: Option<String>,
}

/// `CohorteEventHeader & { type; payload }`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Wire<P> {
    #[serde(flatten)]
    pub header: EventHeader,
    pub payload: P,
}

// ---------- forward-compat + derived ----------

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UnknownEvent {
    #[serde(flatten)]
    pub header: EventHeader,
    pub cohorte_type: String,
    pub malformed: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct DetectionChanged {
    pub detection: CohorteDetection,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct RunUpdated {
    pub run: Box<CohorteRun>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RunRemoved {
    pub project_root: String,
    pub run_id: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GateOpened {
    pub project_root: String,
    pub gate: Box<Gate>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GateResolved {
    pub project_root: String,
    pub run_id: String,
    pub approval_id: String,
    /// CohorteApprovalDecision | 'unknown'
    pub decision: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct WatchError {
    pub code: ErrorCode,
    pub message: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WatchStatus {
    pub project_root: String,
    pub healthy: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<WatchError>,
    pub next_poll_in_ms: u64,
}

/// Declares the 68 wire members once and derives from that one list: the enum
/// variants, `WIRE_EVENT_TYPES`, the payload parser and the header accessor —
/// so the catalogue, the union and the parser cannot disagree.
macro_rules! catalogue {
    ($( $variant:ident = $name:literal => $payload:ty ),* $(,)?) => {
        /// `CohorteEvent` = `CohorteWireEvent | CohorteDerivedEvent` (contract §6).
        #[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
        #[serde(tag = "type")]
        pub enum CohorteEvent {
            $( #[serde(rename = $name)] $variant(Wire<$payload>), )*
            #[serde(rename = "unknown")]
            Unknown(UnknownEvent),
            #[serde(rename = "francois.detection.changed")]
            DetectionChanged(DetectionChanged),
            #[serde(rename = "francois.run.updated")]
            RunUpdated(RunUpdated),
            #[serde(rename = "francois.run.removed")]
            RunRemoved(RunRemoved),
            #[serde(rename = "francois.gate.opened")]
            GateOpened(GateOpened),
            #[serde(rename = "francois.gate.resolved")]
            GateResolved(GateResolved),
            #[serde(rename = "francois.watch.status")]
            WatchStatus(WatchStatus),
        }

        /// The Cohorte Protocol 1.0 catalogue, verbatim (`COHORTE_WIRE_EVENT_TYPES`).
        /// (Read by the catalogue parity tests; the parser matches the same list.)
        #[cfg(test)]
        pub(crate) const WIRE_EVENT_TYPES: &[&str] = &[$($name),*];

        impl CohorteEvent {
            /// `None` for a type outside the catalogue; `Some(Err)` when a known
            /// type's payload does not parse (→ `unknown`, malformed).
            pub(crate) fn from_parts(
                ty: &str,
                header: EventHeader,
                payload: Value,
            ) -> Option<Result<CohorteEvent, serde_json::Error>> {
                match ty {
                    $( $name => Some(
                        serde_json::from_value::<$payload>(payload)
                            .map(|payload| CohorteEvent::$variant(Wire { header, payload })),
                    ), )*
                    _ => None,
                }
            }

            /// The header of a wire member (`unknown` included); `None` for derived members.
            pub(crate) fn header(&self) -> Option<&EventHeader> {
                match self {
                    $( CohorteEvent::$variant(w) => Some(&w.header), )*
                    CohorteEvent::Unknown(u) => Some(&u.header),
                    _ => None,
                }
            }

            /// The log `type`: the Cohorte type verbatim (an `unknown`'s own `cohorteType`).
            pub(crate) fn log_type(&self) -> Option<&str> {
                match self {
                    $( CohorteEvent::$variant(_) => Some($name), )*
                    CohorteEvent::Unknown(u) => Some(&u.cohorte_type),
                    _ => None,
                }
            }
        }
    };
}

catalogue! {
    PipelineStarted = "pipeline.started" => PipelineStarted,
    PipelineCompleted = "pipeline.completed" => PipelineCompleted,
    PipelineFailed = "pipeline.failed" => PipelineFailed,
    RunStateChanged = "run.state.changed" => RunStateChanged,
    RunPaused = "run.paused" => RunPaused,
    RunResumed = "run.resumed" => RunResumed,
    RunCancelled = "run.cancelled" => RunCancelled,
    RunHostAttached = "run.host.attached" => RunHostAttached,
    RunHostDetached = "run.host.detached" => RunHostDetached,
    PhaseStarted = "phase.started" => PhaseStarted,
    PhaseCompleted = "phase.completed" => PhaseCompleted,
    CheckStarted = "check.started" => CheckStarted,
    CheckCompleted = "check.completed" => CheckResult,
    Error = "error" => ErrorPayload,
    CheckpointCreated = "checkpoint.created" => CheckpointCreated,
    AgentDeclared = "agent.declared" => AgentDeclared,
    AgentSpawned = "agent.spawned" => AgentSpawned,
    AgentStarted = "agent.started" => AgentOnly,
    AgentStateChanged = "agent.state.changed" => AgentStateChanged,
    AgentCompleted = "agent.completed" => AgentCompleted,
    AgentFailed = "agent.failed" => AgentFailed,
    AgentTurnStarted = "agent.turn.started" => TurnStarted,
    AgentTurnCompleted = "agent.turn.completed" => TurnCompleted,
    AgentMessageStarted = "agent.message.started" => MessageStarted,
    AgentMessageDelta = "agent.message.delta" => MessageDelta,
    AgentMessageCompleted = "agent.message.completed" => MessageCompleted,
    AgentMessageAccepted = "agent.message.accepted" => MessageAccepted,
    RuntimeWarning = "runtime.warning" => RuntimeWarning,
    ModelRequested = "model.requested" => ModelRequested,
    ModelResponded = "model.responded" => ModelResponded,
    ContextBuilt = "context.built" => ContextBuilt,
    EscalationApplied = "escalation.applied" => EscalationApplied,
    ToolRequested = "tool.requested" => ToolRequested,
    ToolDenied = "tool.denied" => ToolDenied,
    ToolRejected = "tool.rejected" => ToolRejected,
    ToolStarted = "tool.started" => ToolStarted,
    ToolProgress = "tool.progress" => ToolProgress,
    ToolCompleted = "tool.completed" => ToolCompleted,
    FileRead = "file.read" => FileRead,
    FileWritten = "file.written" => FileWritten,
    FileChanged = "file.changed" => FileChanged,
    ReviewStarted = "review.started" => ReviewStarted,
    ReviewFinding = "review.finding" => ReviewFinding,
    ReviewCompleted = "review.completed" => ReviewCompleted,
    ReviewApproved = "review.approved" => ReviewApproved,
    ApprovalRequested = "approval.requested" => ApprovalRequest,
    ApprovalResolved = "approval.resolved" => ApprovalResolved,
    BudgetUpdated = "budget.updated" => BudgetUpdated,
    BudgetExceeded = "budget.exceeded" => BudgetExceeded,
    QuotaUpdated = "quota.updated" => QuotaUpdated,
    AuthRequired = "auth.required" => AuthRequired,
    RetryScheduled = "retry.scheduled" => RetryScheduled,
    CommandAccepted = "command.accepted" => CommandAccepted,
    CommandCompleted = "command.completed" => CommandCompleted,
    CommandRejected = "command.rejected" => CommandRejected,
    GitWorktreeCreated = "git.worktree.created" => WorktreeCreated,
    GitWorktreeProvisioned = "git.worktree.provisioned" => WorktreeProvisioned,
    GitWorktreeQuarantined = "git.worktree.quarantined" => WorktreeQuarantined,
    GitWorktreeRemoved = "git.worktree.removed" => WorktreeRemoved,
    GitCommitCreated = "git.commit.created" => CommitCreated,
    GitMergeCompleted = "git.merge.completed" => MergeCompleted,
    GitMergeConflicted = "git.merge.conflicted" => MergeConflicted,
    RepoChangeDetected = "repo.change.detected" => RepoChangeDetected,
    LockAcquired = "lock.acquired" => Lock,
    LockReleased = "lock.released" => Lock,
    LockStolen = "lock.stolen" => Lock,
    Snapshot = "snapshot" => SnapshotPayload,
    Heartbeat = "heartbeat" => HeartbeatPayload,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cohorte::testutil;

    /// The contract's COHORTE_WIRE_EVENT_TYPES, read from the contract file
    /// itself so the Rust list cannot drift from it silently.
    fn contract_catalogue() -> Vec<String> {
        let src = include_str!("../../../contract/cohorte-events.ts");
        let start = src
            .find("export const COHORTE_WIRE_EVENT_TYPES = [")
            .unwrap();
        let end = start + src[start..].find("] as const;").unwrap();
        src[start..end]
            .lines()
            .skip(1)
            .filter_map(|l| {
                let l = l.trim();
                l.strip_prefix('\'')
                    .and_then(|l| l.split('\'').next())
                    .map(str::to_string)
            })
            .collect()
    }

    #[test]
    fn the_catalogue_is_the_contracts_68_types_in_order() {
        let contract = contract_catalogue();
        assert_eq!(contract.len(), 68);
        assert_eq!(WIRE_EVENT_TYPES.len(), 68);
        assert_eq!(
            WIRE_EVENT_TYPES
                .iter()
                .map(|s| s.to_string())
                .collect::<Vec<_>>(),
            contract
        );
    }

    /// Serde round-trip of EVERY wire member (built from the 68-envelope
    /// fixture), `unknown`, and the six derived members.
    #[test]
    fn every_event_member_round_trips_through_serde() {
        let mut events = testutil::all_wire_events();
        assert_eq!(events.len(), 68);
        events.push(CohorteEvent::Unknown(UnknownEvent {
            header: testutil::header(9, 0),
            cohorte_type: "foo.bar".into(),
            malformed: false,
        }));
        events.extend(testutil::derived_events());
        for ev in events {
            let json = serde_json::to_value(&ev).unwrap();
            let ty = json["type"].as_str().unwrap().to_string();
            if ev.header().is_some() {
                assert!(json.get("runId").is_some(), "{ty}: header not flattened");
                assert!(json.get("projectRoot").is_some(), "{ty}");
            }
            let back: CohorteEvent = serde_json::from_value(json)
                .unwrap_or_else(|e| panic!("{ty} did not deserialize: {e}"));
            assert_eq!(back, ev, "{ty} changed across a round-trip");
        }
    }

    #[test]
    fn the_unknown_member_carries_its_cohorte_type() {
        let ev = CohorteEvent::Unknown(UnknownEvent {
            header: testutil::header(1, 0),
            cohorte_type: "foo.bar".into(),
            malformed: true,
        });
        let json = serde_json::to_value(&ev).unwrap();
        assert_eq!(json["type"], "unknown");
        assert_eq!(json["cohorteType"], "foo.bar");
        assert_eq!(json["malformed"], true);
        assert_eq!(ev.log_type(), Some("foo.bar"));
    }

    #[test]
    fn derived_members_use_the_francois_type_strings() {
        let types: Vec<String> = testutil::derived_events()
            .iter()
            .map(|e| {
                serde_json::to_value(e).unwrap()["type"]
                    .as_str()
                    .unwrap()
                    .to_string()
            })
            .collect();
        assert_eq!(
            types,
            vec![
                "francois.detection.changed",
                "francois.run.updated",
                "francois.run.removed",
                "francois.gate.opened",
                "francois.gate.resolved",
                "francois.watch.status",
            ]
        );
    }

    #[test]
    fn watch_status_error_code_uses_the_union_spelling() {
        let ev = CohorteEvent::WatchStatus(WatchStatus {
            project_root: "/p".into(),
            healthy: false,
            error: Some(WatchError {
                code: ErrorCode::CohorteTimeout,
                message: "m".into(),
            }),
            next_poll_in_ms: 6000,
        });
        let json = serde_json::to_value(&ev).unwrap();
        assert_eq!(json["error"]["code"], "COHORTE_TIMEOUT");
        assert_eq!(json["nextPollInMs"], 6000);
    }
}
