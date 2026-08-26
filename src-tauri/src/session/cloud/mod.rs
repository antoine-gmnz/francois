//! cloud-sessions (specs/cloud-sessions.md) — Francois ADOPTS a Claude Code on
//! the web (cloud) session.
//!
//! The user pastes the session's `claude.ai/code` URL (or picks it from the
//! FR-2 list), chooses where it lands on disk, and Francois drives
//! `claude --teleport <cloudId> --session-id <uuid>` in a PTY it owns. Teleport
//! fetches the cloud event log, checks out the branch, then hands the messages
//! to the NORMAL local REPL — so what comes out is an ordinary local session and
//! every later turn resumes over the usual `claude --resume` pipeline. There is
//! no cloud-specific turn path anywhere in this codebase.
//!
//! Adoption is a ONE-WAY pull: afterwards the cloud copy no longer receives the
//! user's work (spec §7 #8). Nothing here keeps a link back to claude.ai — the
//! only trace is `SessionMeta.cloud` (`CloudProvenance`), which exists so the
//! `cloud` chip can say where the thread came from.
//!
//! This file owns the shared data model (the contract shapes, the in-flight
//! registry, the event channel); the children own one concern each:
//!  * `auth.rs`   — FR-1: the claude.ai access token on disk, and its expiry.
//!  * `api.rs`    — FR-2/FR-3: the two REST calls, the ref normalizer, and the
//!                  ONE pure `CloudSession` mapping function.
//!  * `detect.rs` — FR-6/FR-8: transcript discovery and the PTY dialog matcher.
//!  * `landing.rs`— FR-4/FR-11: where an adoption lands on disk, and the
//!                  teardown that removes exactly what this run created.
//!  * `adopt.rs`  — FR-5..FR-12: the PTY, the phase machine, and the session the
//!                  whole thing exists to create.
//!
//! Wording note (spec §7 #4): teleport rides the same infrastructure as Remote
//! Control, so the CLI's own errors may say "Remote Control session expired".
//! Those are mapped to the CLOUD_* codes and re-worded — the phrase "Remote
//! Control" must never reach this feature's UI. It is a different object.

use super::*;

use crate::ipc::AppError;
use portable_pty::{ChildKiller, MasterPty};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

mod adopt;
mod api;
mod auth;
mod detect;
mod landing;

pub use adopt::*;
pub use api::*;
pub(crate) use auth::*;
pub(crate) use detect::*;
pub use landing::*;

/// francois:cloud:event → the physical Tauri channel (§5).
const EVENT_CHANNEL_CLOUD: &str = "francois://cloud/event";

/// FR-9: spawn → `ready` budget. Teleport fetches a whole cloud event log, then
/// checks out a branch (possibly fetching it first), then boots a full
/// interactive REPL — so this is generous on purpose.
pub const ADOPT_DEADLINE: Duration = Duration::from_secs(180);
/// How often the adoption loop re-reads its two signals (PTY verdict, transcript).
pub const ADOPT_POLL: Duration = Duration::from_millis(250);
/// FR-2: both REST calls are bounded — a hung endpoint must never wedge a command.
pub const CLOUD_HTTP_TIMEOUT_SECS: u64 = 10;

// ---------- contract shapes (contract/cloud-sessions.ts, mirrored by hand) ----------

/// contract `CloudSession`. Every field but `id` is nullable and every null is
/// HONEST: the list endpoint is a convenience, not a contract (spec §7 #3), so an
/// absent field serializes as `null` and is NEVER synthesized. These are
/// `Option` WITHOUT `skip_serializing_if` on purpose — the TS type is
/// `string | null`, not `string | undefined`.
#[derive(Serialize, Clone, PartialEq, Debug, Default)]
pub struct CloudSession {
    pub(crate) id: String,
    pub(crate) title: Option<String>,
    pub(crate) repo: Option<String>,
    pub(crate) branch: Option<String>,
    #[serde(rename = "updatedAt")]
    pub(crate) updated_at: Option<u64>,
}

/// contract `CloudListData`. `degraded: true` ⇒ `sessions` is `[]` (FR-2).
#[derive(Serialize, Clone, PartialEq, Debug)]
pub struct CloudListData {
    pub(crate) sessions: Vec<CloudSession>,
    pub(crate) degraded: bool,
}

/// FR-2's degrade-to-empty result — the ONE shape every non-actionable list
/// outcome (non-200, timeout, unparseable body, unexpected shape) resolves to.
pub fn degraded_list() -> CloudListData {
    CloudListData {
        sessions: Vec::new(),
        degraded: true,
    }
}

/// contract `CloudResolveData`.
#[derive(Serialize, Clone, PartialEq, Debug)]
pub struct CloudResolveData {
    pub(crate) session: CloudSession,
    #[serde(rename = "matchedProjectId")]
    pub(crate) matched_project_id: Option<String>,
}

/// contract `CloudAdoptData` — the LOCAL session the adoption produced.
#[derive(Serialize, Clone, PartialEq, Debug)]
pub struct CloudAdoptData {
    #[serde(rename = "sessionId")]
    pub(crate) session_id: String,
}

/// contract `CloudAdoptPhase` — tagged on `phase` (FR-7).
#[derive(Serialize, Clone, Debug)]
#[serde(tag = "phase", rename_all = "camelCase")]
pub enum CloudAdoptPhase {
    Resolving,
    Preparing,
    Teleporting,
    Hydrating,
    #[serde(rename_all = "camelCase")]
    Ready {
        session_id: String,
    },
    Failed {
        error: AppError,
    },
}

/// The phase name as `CLOUD_ADOPT_STALLED`'s `detail: { phase }` carries it
/// (FR-9) — the last phase the adoption actually reached.
pub fn phase_name(p: &CloudAdoptPhase) -> &'static str {
    match p {
        CloudAdoptPhase::Resolving => "resolving",
        CloudAdoptPhase::Preparing => "preparing",
        CloudAdoptPhase::Teleporting => "teleporting",
        CloudAdoptPhase::Hydrating => "hydrating",
        CloudAdoptPhase::Ready { .. } => "ready",
        CloudAdoptPhase::Failed { .. } => "failed",
    }
}

/// contract `CloudEvent` — `francois://cloud/event`. `ref` echoes the request's
/// ref verbatim so a listener can match its own adoption.
#[derive(Serialize, Clone)]
#[serde(tag = "type")]
enum CloudEvent {
    #[serde(rename = "cloud.adopt")]
    Adopt {
        r#ref: String,
        state: CloudAdoptPhase,
    },
}

/// contract/common.ts `CloudProvenance` — presence on `SessionMeta.cloud` is the
/// whole "this session was adopted" signal (FR-10). Deliberately minimal:
/// nothing about the cloud session itself is cached, because after adoption the
/// local session is the only live copy of the thread.
#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CloudProvenance {
    pub(crate) cloud_session_id: String,
    pub(crate) adopted_at: u64,
}

// ---------- the failure an adoption carries (FR-7's `failed{error}`) ----------

/// One adoption failure on its way to both `CloudAdoptPhase::Failed` and the
/// command's own `Result` — the two must always say the SAME thing, so they are
/// built from one value rather than assembled twice.
///
/// Lives here rather than in `adopt.rs` because two children construct it
/// (`landing.rs` for FR-4's refusals, `adopt.rs` for everything after the
/// spawn); its fields stay private, which is enough — a child can read an
/// ancestor's private fields.
#[derive(Debug)]
pub struct AdoptError {
    code: ErrorCode,
    message: String,
    detail: Option<Value>,
}

impl AdoptError {
    fn new(code: ErrorCode, message: impl Into<String>) -> AdoptError {
        AdoptError {
            code,
            message: message.into(),
            detail: None,
        }
    }

    fn detailed(code: ErrorCode, message: impl Into<String>, detail: Value) -> AdoptError {
        AdoptError {
            code,
            message: message.into(),
            detail: Some(detail),
        }
    }
}

// core-architecture-wave3 FR-6: into the one error type the IPC boundary
// speaks, `detail` included, so a command body converts with `.into()`.
impl From<AdoptError> for crate::ipc::AppError {
    fn from(e: AdoptError) -> Self {
        crate::ipc::AppError {
            code: e.code,
            message: e.message,
            detail: e.detail,
        }
    }
}

impl From<CloudBlock> for AdoptError {
    fn from(b: CloudBlock) -> AdoptError {
        AdoptError {
            code: b.code,
            message: b.message,
            detail: b.detail,
        }
    }
}

// ---------- the in-flight registry (§6) ----------

/// A worktree THIS adoption created, kept so FR-11 can remove exactly what this
/// run made — never one that already existed.
pub struct CreatedWorktree {
    pub(crate) host: crate::diff::GitHost,
    pub(crate) repo_root: String,
    pub(crate) path: String,
    pub(crate) branch: String,
    pub(crate) created_branch: bool,
}

impl CreatedWorktree {
    /// FR-11: best-effort reversal, reusing session-worktree's own reversal (so
    /// the "remove the tree, delete the branch only if we created it" rule lives
    /// in exactly one place).
    pub fn reverse(&self) {
        reverse_create(
            &self.host,
            &self.repo_root,
            &self.path,
            &self.branch,
            self.created_branch,
        );
    }
}

pub struct CloudAdoptEntry {
    killer: Box<dyn ChildKiller + Send + Sync>,
    phase: Arc<Mutex<CloudAdoptPhase>>,
    /// Held so the master side stays open for the lifetime of the child.
    _master: Option<Box<dyn MasterPty + Send>>,
}

impl CloudAdoptEntry {
    fn kill(mut self) {
        let _ = self.killer.kill();
    }
}

/// §6: `ref → { killer, phase, … }`. Keyed by the request's ref VERBATIM, which
/// is what makes §7 #9 (a second `cloud_adopt` for a ref already in flight does
/// not spawn a second PTY) a one-line lookup.
#[derive(Default)]
pub struct CloudAdoptRegistry(Mutex<HashMap<String, CloudAdoptEntry>>);

impl CloudAdoptRegistry {
    /// Reserve the slot for `key`. `false` ⇒ an adoption of that ref is already
    /// in flight and the caller must not spawn anything.
    pub fn reserve(&self, key: &str, phase: Arc<Mutex<CloudAdoptPhase>>) -> bool {
        let mut map = self.0.lock().unwrap();
        if map.contains_key(key) {
            return false;
        }
        map.insert(
            key.to_string(),
            CloudAdoptEntry {
                // A reservation has no child yet; `attach` swaps in the real one.
                killer: Box::new(NoChild),
                phase,
                _master: None,
            },
        );
        true
    }

    /// Hand the freshly spawned PTY to the reservation, so a teardown from any
    /// path (failure, cancel, app exit) can reach the child.
    pub(crate) fn attach(
        &self,
        key: &str,
        killer: Box<dyn ChildKiller + Send + Sync>,
        master: Box<dyn MasterPty + Send>,
    ) {
        if let Some(entry) = self.0.lock().unwrap().get_mut(key) {
            entry.killer = killer;
            entry._master = Some(master);
        }
    }

    pub(crate) fn take(&self, key: &str) -> Option<CloudAdoptEntry> {
        self.0.lock().unwrap().remove(key)
    }

    /// §7 #9: the phase an in-flight adoption of `key` has reached.
    pub(crate) fn phase_of(&self, key: &str) -> Option<CloudAdoptPhase> {
        self.0
            .lock()
            .unwrap()
            .get(key)
            .map(|e| e.phase.lock().unwrap().clone())
    }
}

/// A `ChildKiller` for the window between reserving the registry slot and
/// actually spawning — killing it is a no-op rather than a special case at every
/// teardown site.
#[derive(Debug)]
struct NoChild;

impl ChildKiller for NoChild {
    fn kill(&mut self) -> std::io::Result<()> {
        Ok(())
    }
    fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
        Box::new(NoChild)
    }
}

/// FR-11: no adoption PTY outlives the app. These are real interactive `claude`
/// processes; leaking one leaves a teleport half-done with nobody reading its
/// master (an unread master eventually blocks the child anyway).
pub fn kill_all_cloud_adoptions(app: &AppHandle) {
    use tauri::Manager;
    let Some(reg) = app.try_state::<CloudAdoptRegistry>() else {
        return;
    };
    let drained: Vec<CloudAdoptEntry> = reg.0.lock().unwrap().drain().map(|(_, e)| e).collect();
    for entry in drained {
        entry.kill();
    }
}

// ---------- emission (FR-7) ----------

pub fn emit_adopt(app: &AppHandle, r#ref: &str, state: &CloudAdoptPhase) {
    let _ = app.emit(
        EVENT_CHANNEL_CLOUD,
        CloudEvent::Adopt {
            r#ref: r#ref.to_string(),
            state: state.clone(),
        },
    );
}

/// FR-7: the single place a phase transition happens — write it into the shared
/// registry slot AND emit it, so a `cloud_adopt` that arrives for the same ref
/// mid-flight reports the same phase the frontend last saw. A silent adoption is
/// a bug report, so every transition goes through here.
pub struct AdoptProgress {
    app: AppHandle,
    r#ref: String,
    phase: Arc<Mutex<CloudAdoptPhase>>,
}

impl AdoptProgress {
    pub fn new(app: AppHandle, r#ref: String, phase: Arc<Mutex<CloudAdoptPhase>>) -> Self {
        AdoptProgress { app, r#ref, phase }
    }

    pub(crate) fn set(&self, next: CloudAdoptPhase) {
        *self.phase.lock().unwrap() = next.clone();
        emit_adopt(&self.app, &self.r#ref, &next);
    }

    pub(crate) fn current(&self) -> CloudAdoptPhase {
        self.phase.lock().unwrap().clone()
    }

    /// The shared slot itself, for the PTY reader thread: it needs the phase the
    /// adoption is in at the instant it matches a dialog (FR-8), which is what
    /// `CLOUD_ADOPT_STALLED`'s `detail: { phase }` reports.
    pub(crate) fn slot(&self) -> Arc<Mutex<CloudAdoptPhase>> {
        self.phase.clone()
    }
}

// ---------- shared numeric helper ----------

/// The API's timestamps are not specified (spec §7 #3), so a value that can only
/// be seconds is read as seconds: 1e11 milliseconds is 1973 and 1e11 seconds is
/// the year 5138, so the boundary is unambiguous for every date this app can
/// meet. Contract timestamps are epoch MILLISECONDS (§Conventions).
pub fn normalize_epoch_ms(raw: u64) -> u64 {
    if raw < 100_000_000_000 {
        raw.saturating_mul(1000)
    } else {
        raw
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc::ErrorCode;
    use serde_json::json;

    #[test]
    fn cloud_session_serializes_nulls_rather_than_omitting_them() {
        // The contract type is `string | null`, not `string | undefined`: a row
        // that omits `title` would read as "not loaded yet" in the frontend
        // rather than "the API returned none".
        let bare = CloudSession {
            id: "session_01AB".into(),
            ..Default::default()
        };
        assert_eq!(
            serde_json::to_value(&bare).unwrap(),
            json!({
                "id": "session_01AB",
                "title": null,
                "repo": null,
                "branch": null,
                "updatedAt": null
            })
        );

        let full = CloudSession {
            id: "cse_9".into(),
            title: Some("Fix the flaky test".into()),
            repo: Some("acme/api".into()),
            branch: Some("fix/flake".into()),
            updated_at: Some(1_784_573_689_516),
        };
        assert_eq!(
            serde_json::to_value(&full).unwrap(),
            json!({
                "id": "cse_9",
                "title": "Fix the flaky test",
                "repo": "acme/api",
                "branch": "fix/flake",
                "updatedAt": 1_784_573_689_516u64
            })
        );
    }

    #[test]
    fn list_and_resolve_data_serialize_as_the_contract_shapes() {
        assert_eq!(
            serde_json::to_value(degraded_list()).unwrap(),
            json!({ "sessions": [], "degraded": true })
        );
        assert_eq!(
            serde_json::to_value(CloudResolveData {
                session: CloudSession {
                    id: "session_01AB".into(),
                    ..Default::default()
                },
                matched_project_id: Some("p1".into()),
            })
            .unwrap()["matchedProjectId"],
            json!("p1")
        );
        assert_eq!(
            serde_json::to_value(CloudAdoptData {
                session_id: "s1".into()
            })
            .unwrap(),
            json!({ "sessionId": "s1" })
        );
    }

    #[test]
    fn adopt_phase_serializes_as_the_phase_tagged_union() {
        for (phase, expected) in [
            (CloudAdoptPhase::Resolving, json!({ "phase": "resolving" })),
            (CloudAdoptPhase::Preparing, json!({ "phase": "preparing" })),
            (
                CloudAdoptPhase::Teleporting,
                json!({ "phase": "teleporting" }),
            ),
            (CloudAdoptPhase::Hydrating, json!({ "phase": "hydrating" })),
        ] {
            assert_eq!(serde_json::to_value(phase).unwrap(), expected);
        }
        assert_eq!(
            serde_json::to_value(CloudAdoptPhase::Ready {
                session_id: "s1".into()
            })
            .unwrap(),
            json!({ "phase": "ready", "sessionId": "s1" })
        );
        assert_eq!(
            serde_json::to_value(CloudAdoptPhase::Failed {
                error: AppError {
                    code: ErrorCode::CloudAdoptStalled,
                    message: "took too long".into(),
                    detail: Some(json!({ "phase": "teleporting" })),
                }
            })
            .unwrap(),
            json!({
                "phase": "failed",
                "error": {
                    "code": "CLOUD_ADOPT_STALLED",
                    "message": "took too long",
                    "detail": { "phase": "teleporting" }
                }
            })
        );
    }

    #[test]
    fn cloud_event_carries_the_ref_verbatim() {
        let ev = serde_json::to_value(CloudEvent::Adopt {
            r#ref: "https://claude.ai/code/session_01AB?from=phone".into(),
            state: CloudAdoptPhase::Resolving,
        })
        .unwrap();
        assert_eq!(
            ev,
            json!({
                "type": "cloud.adopt",
                "ref": "https://claude.ai/code/session_01AB?from=phone",
                "state": { "phase": "resolving" }
            })
        );
    }

    #[test]
    fn cloud_provenance_round_trips_through_the_persisted_shape() {
        let p = CloudProvenance {
            cloud_session_id: "session_01AB".into(),
            adopted_at: 1_784_573_689_516,
        };
        let json = serde_json::to_value(&p).unwrap();
        assert_eq!(
            json,
            json!({ "cloudSessionId": "session_01AB", "adoptedAt": 1_784_573_689_516u64 })
        );
        assert_eq!(serde_json::from_value::<CloudProvenance>(json).unwrap(), p);
    }

    #[test]
    fn phase_name_reports_the_phase_reached() {
        assert_eq!(phase_name(&CloudAdoptPhase::Resolving), "resolving");
        assert_eq!(phase_name(&CloudAdoptPhase::Teleporting), "teleporting");
        assert_eq!(phase_name(&CloudAdoptPhase::Hydrating), "hydrating");
        assert_eq!(
            phase_name(&CloudAdoptPhase::Ready {
                session_id: "s".into()
            }),
            "ready"
        );
    }

    #[test]
    fn the_registry_admits_one_adoption_per_ref() {
        // §7 #9: a second cloud_adopt for a ref already in flight must not be
        // able to spawn a second PTY — the reservation is what enforces it.
        let reg = CloudAdoptRegistry::default();
        let phase = Arc::new(Mutex::new(CloudAdoptPhase::Resolving));
        assert!(reg.reserve("session_01AB", phase.clone()));
        assert!(!reg.reserve("session_01AB", phase.clone()));
        assert_eq!(
            reg.phase_of("session_01AB").map(|p| phase_name(&p)),
            Some("resolving")
        );

        // The phase the caller reports is the LIVE one, not a snapshot.
        *phase.lock().unwrap() = CloudAdoptPhase::Teleporting;
        assert_eq!(
            reg.phase_of("session_01AB").map(|p| phase_name(&p)),
            Some("teleporting")
        );

        // Taking the slot releases the ref for a retry (FR-15's one-click retry).
        assert!(reg.take("session_01AB").is_some());
        assert!(reg.phase_of("session_01AB").is_none());
        assert!(reg.reserve("session_01AB", phase));
    }

    #[test]
    fn epoch_normalization_reads_seconds_as_seconds() {
        // spec §7 #3: the endpoint's timestamp unit was never verified live.
        assert_eq!(normalize_epoch_ms(1_784_573_689), 1_784_573_689_000);
        assert_eq!(normalize_epoch_ms(1_784_573_689_516), 1_784_573_689_516);
        assert_eq!(normalize_epoch_ms(0), 0);
    }
}
