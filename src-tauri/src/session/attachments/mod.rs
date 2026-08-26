//! session-attachments (specs/session-attachments.md).
//!
//! Attaching = (1) get the bytes to a path the session can read, (2) hand the
//! frontend a `refPath` it inserts as `@<refPath>`. Claude Code's own `Read` tool
//! does the reading, so nothing multimodal ever touches the stdio stream and
//! permission-guardrails keeps seeing every read.
//!
//! This `mod.rs` owns the shared data model — `Attachment`, the two result
//! shapes, the `ClearScope` request enum and the error envelope — plus the
//! mutations over `Session`/`Engine` that the whole domain shares. The children
//! own one concern each:
//!   * `paths`       — FR-1..FR-7 path & name arithmetic (pure).
//!   * `ingest`      — the ONE pipeline every gesture (drop, paste, picker) funnels into.
//!   * `retention`   — FR-13/FR-15..FR-18: release, commit, sweep, purge.
//!   * `asset_scope` — FR-12: what the webview may read for a thumbnail.
//!   * `commands`    — the six `session_*` Tauri commands (lock → IO → lock → persist).

mod asset_scope;
mod commands;
mod ingest;
mod paths;
mod retention;

pub(crate) use asset_scope::*;
pub use commands::*;
pub(crate) use ingest::*;
pub(crate) use paths::*;
pub use retention::*;

#[cfg(test)]
mod testutil;

use super::{Engine, Session};
use crate::ipc::ErrorCode;
use serde::{Deserialize, Serialize};
use serde_json::Value;

// ---------- contract types (contract/session-attachments.ts, mirrored) ----------

/// One staged or sent ref. `kind` is the contract's `AttachmentKind`
/// (`image`|`file`) and `state` its `AttachmentState` (`staged`|`sent`), carried
/// as strings for the same reason `SessionMeta.status` is: the wire shape is a TS
/// string union and the core never branches on more than equality.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub(crate) id: String,
    pub(crate) session_id: String,
    pub(crate) kind: String,
    /// Absolute source path the bytes came from; ABSENT (never null) for
    /// clipboard images — same omit-not-null convention as `SessionMeta.projectId`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) origin_path: Option<String>,
    pub(crate) stored_path: String,
    pub(crate) ref_path: String,
    pub(crate) name: String,
    pub(crate) bytes: u64,
    pub(crate) copied: bool,
    pub(crate) state: String,
    pub(crate) created_at: u64,
}

impl Attachment {
    pub fn is_staged(&self) -> bool {
        self.state == "staged"
    }
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CommitAttachmentsResult {
    /// attachment ids now in state 'sent'
    pub(crate) sent: Vec<String>,
    /// attachment ids dropped, copies deleted
    pub(crate) released: Vec<String>,
}

/// contract `AttachFailure` — one entry a multi-file ingestion refused. The copy
/// names the FILE, not the path, so `name` is the basename; `error` is the very
/// same `AppError` a call-level refusal carries, so the frontend renders both
/// identically.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AttachFailure {
    pub(crate) name: String,
    pub(crate) error: crate::ipc::AppError,
}

/// contract `PickAttachmentsResponse` (FR-9). Successes and refusals travel
/// TOGETHER: a per-file refusal is never a call-level error, and a silently
/// dropped file would be indistinguishable from one the user never picked. A
/// cancelled dialog is this shape with both arrays empty.
#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct PickAttachmentsResponse {
    pub(crate) attached: Vec<Attachment>,
    pub(crate) failed: Vec<AttachFailure>,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClearAttachmentsResult {
    pub(crate) removed_files: u32,
    pub(crate) removed_bytes: u64,
    /// files that could not be deleted (locked, permissions)
    pub(crate) failed: u32,
}

impl ClearAttachmentsResult {
    pub fn merge(&mut self, other: ClearAttachmentsResult) {
        self.removed_files += other.removed_files;
        self.removed_bytes += other.removed_bytes;
        self.failed += other.failed;
    }
}

/// contract `ClearScope` — an internally tagged union on `kind`.
#[derive(Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ClearScope {
    Session {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
    Project {
        #[serde(rename = "projectId")]
        project_id: String,
    },
}

// ---------- error envelope ----------

/// A refusal from the ingestion pipeline, carrying the contract's `ErrorCode`
/// and (for FR-8's cap and every IO failure) the `detail` payload the frontend
/// renders. Turned into an `IpcResult` by `commands.rs` — the pipeline itself
/// stays free of Tauri types so it is testable against a temp dir.
#[derive(Clone, Debug, PartialEq)]
pub struct AttachError {
    pub(crate) code: ErrorCode,
    pub(crate) message: String,
    pub(crate) detail: Option<Value>,
}

// core-architecture-wave3 FR-6: the pipeline stays free of Tauri types, but
// the conversion into the one error type the IPC boundary speaks belongs here
// rather than in a hand-written mapper in commands.rs - `detail` (FR-8's cap
// payload) rides along instead of being re-split at every call site.
impl From<AttachError> for crate::ipc::AppError {
    fn from(e: AttachError) -> Self {
        crate::ipc::AppError {
            code: e.code,
            message: e.message,
            detail: e.detail,
        }
    }
}

impl AttachError {
    pub fn invalid(message: impl Into<String>) -> AttachError {
        AttachError {
            code: ErrorCode::InvalidInput,
            message: message.into(),
            detail: None,
        }
    }

    /// FR-8: folders are refused, not walked.
    pub(crate) fn is_directory() -> AttachError {
        AttachError {
            code: ErrorCode::AttachmentIsDirectory,
            message: "folders can't be attached — attach the files instead".into(),
            detail: None,
        }
    }

    /// FR-8: over the 10 MiB cap. `detail: { bytes, cap }`.
    pub(crate) fn too_large(bytes: u64) -> AttachError {
        AttachError {
            code: ErrorCode::AttachmentTooLarge,
            message: "that file is over the 10 MB attachment limit".into(),
            detail: Some(serde_json::json!({ "bytes": bytes, "cap": ATTACHMENT_MAX_BYTES })),
        }
    }

    /// A copy/write/delete failure. `detail: { path }`.
    pub(crate) fn io(path: &std::path::Path, message: impl Into<String>) -> AttachError {
        AttachError {
            code: ErrorCode::AttachmentIoFailed,
            message: message.into(),
            detail: Some(serde_json::json!({ "path": path.to_string_lossy() })),
        }
    }

    pub(crate) fn not_found() -> AttachError {
        AttachError {
            code: ErrorCode::AttachmentNotFound,
            message: "no such attachment".into(),
            detail: None,
        }
    }

    /// The wire shape of this refusal — what `AttachFailure.error` carries and
    /// what `commands::refuse` puts in the envelope, so the two are the same
    /// object by construction.
    pub(crate) fn to_app_error(&self) -> crate::ipc::AppError {
        crate::ipc::AppError {
            code: self.code,
            message: self.message.clone(),
            detail: self.detail.clone(),
        }
    }
}

// ---------- model mutations ----------

impl Session {
    /// Stage a freshly ingested ref.
    pub fn stage_attachment(&mut self, attachment: Attachment) {
        self.attachments.push(attachment);
    }

    /// FR-13: claim a STAGED attachment for release. Removing the record IS the
    /// claim, so a double `×` can never delete twice (and never reports two
    /// successes).
    ///
    /// The `is_staged` filter is the same invariant `commit_attachments` states
    /// four lines below and `partition_commit` enforces: a `sent` record belongs
    /// to the transcript and Claude may re-read it, so its bytes are never
    /// deleted. Release is the other door into that deletion, and the core owes
    /// the guarantee itself — the frontend only ever offering `×` on staged
    /// chips is a UI rule, not an enforcement. An unmatched claim is the caller's
    /// `ATTACHMENT_NOT_FOUND`.
    pub(crate) fn take_attachment(&mut self, attachment_id: &str) -> Option<Attachment> {
        let i = self
            .attachments
            .iter()
            .position(|a| a.id == attachment_id && a.is_staged())?;
        Some(self.attachments.remove(i))
    }

    /// FR-15: reconcile the staged set against the text that was just sent.
    /// Staged refs occurring in `text` flip to `sent` (terminal — never swept);
    /// the rest are REMOVED from the record list and returned, so the caller
    /// deletes their copies outside the engine lock. Already-`sent` records are
    /// untouched: the transcript references them and Claude may re-read them.
    pub(crate) fn commit_attachments(
        &mut self,
        text: &str,
    ) -> (CommitAttachmentsResult, Vec<Attachment>) {
        let (sent, released) = partition_commit(&self.attachments, text);
        let mut dropped = Vec::new();
        self.attachments.retain(|a| {
            let out = !released.contains(&a.id);
            if !out {
                dropped.push(a.clone());
            }
            out
        });
        for a in self.attachments.iter_mut() {
            if sent.contains(&a.id) {
                a.state = "sent".into();
            }
        }
        (CommitAttachmentsResult { sent, released }, dropped)
    }

    /// FR-18: after a dir sweep, every COPIED record's file is gone. In-place
    /// (`copied: false`) records survive — their origins were never touched.
    pub(crate) fn forget_copied_attachments(&mut self) {
        self.attachments.retain(|a| !a.copied);
    }
}

impl Engine {
    /// FR-18: `(sessionId, cwd)` of every session registered under a project —
    /// the sweep is driven by the session registry, not by a filesystem crawl,
    /// which is exactly what includes sessions running in worktrees.
    pub fn sessions_of_project(&self, project_id: &str) -> Vec<(String, String)> {
        let map = self.sessions.lock().unwrap_or_else(|p| p.into_inner());
        map.values()
            .filter(|s| s.project_id.as_deref() == Some(project_id))
            .map(|s| (s.id.clone(), s.cwd.clone()))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::testutil::*;
    use super::*;
    use crate::session::testutil::{test_engine_with, test_session};
    use serde_json::json;

    #[test]
    fn attachment_serializes_to_the_contract_shape() {
        let a = Attachment {
            id: "at-1".into(),
            session_id: SID.into(),
            kind: "image".into(),
            origin_path: Some("/out/side/shot.png".into()),
            stored_path: "/repo/.francois/attachments/a3f9c1e2/shot.png".into(),
            ref_path: ".francois/attachments/a3f9c1e2/shot.png".into(),
            name: "shot.png".into(),
            bytes: 42,
            copied: true,
            state: "staged".into(),
            created_at: 1_700_000_000_000,
        };
        let v = serde_json::to_value(&a).unwrap();
        assert_eq!(v["sessionId"], SID);
        assert_eq!(v["originPath"], "/out/side/shot.png");
        assert_eq!(
            v["storedPath"],
            "/repo/.francois/attachments/a3f9c1e2/shot.png"
        );
        assert_eq!(v["refPath"], ".francois/attachments/a3f9c1e2/shot.png");
        assert_eq!(v["createdAt"], 1_700_000_000_000u64);
        assert_eq!(v["bytes"], 42);
        assert_eq!(v["copied"], true);
        assert_eq!(v["state"], "staged");
        // round-trips through the persisted form (sessions.json, §6)
        assert_eq!(serde_json::from_value::<Attachment>(v).unwrap(), a);
    }

    #[test]
    fn clipboard_attachment_omits_origin_path_entirely() {
        // Contract: `originPath?` — absent for clipboard images, never null, so a
        // pre-feature reader and the frontend's `?.` both read it identically.
        let dir = std::path::PathBuf::from("/repo/.francois/attachments/a3f9c1e2/p.png");
        let mut a = att(
            "at-1",
            ".francois/attachments/a3f9c1e2/p.png",
            &dir,
            true,
            "staged",
        );
        a.origin_path = None;
        let v = serde_json::to_value(&a).unwrap();
        assert!(v.get("originPath").is_none(), "{v}");
    }

    #[test]
    fn results_serialize_camel_case() {
        let v = serde_json::to_value(CommitAttachmentsResult {
            sent: vec!["a".into()],
            released: vec!["b".into()],
        })
        .unwrap();
        assert_eq!(v, json!({ "sent": ["a"], "released": ["b"] }));
        let v = serde_json::to_value(ClearAttachmentsResult {
            removed_files: 2,
            removed_bytes: 30,
            failed: 1,
        })
        .unwrap();
        assert_eq!(
            v,
            json!({ "removedFiles": 2, "removedBytes": 30, "failed": 1 })
        );
    }

    #[test]
    fn pick_response_carries_successes_and_refusals_together() {
        // Contract `PickAttachmentsResponse` (FR-9): one refused pick lands in
        // `failed` with the file's BASENAME and a full AppError — never as a
        // call-level error, never dropped.
        let p = std::path::PathBuf::from("/repo/.francois/attachments/a3f9c1e2/a.png");
        let response = PickAttachmentsResponse {
            attached: vec![att(
                "at-1",
                ".francois/attachments/a3f9c1e2/a.png",
                &p,
                true,
                "staged",
            )],
            failed: vec![
                AttachFailure {
                    name: "huge.bin".into(),
                    error: AttachError::too_large(99).to_app_error(),
                },
                AttachFailure {
                    name: "docs".into(),
                    error: AttachError::is_directory().to_app_error(),
                },
            ],
        };

        let v = serde_json::to_value(&response).unwrap();

        assert_eq!(v["attached"][0]["id"], "at-1");
        assert_eq!(
            v["attached"][0]["refPath"],
            ".francois/attachments/a3f9c1e2/a.png"
        );
        assert_eq!(v["failed"][0]["name"], "huge.bin");
        assert_eq!(
            v["failed"][0]["error"]["code"],
            json!(ErrorCode::AttachmentTooLarge)
        );
        assert_eq!(v["failed"][0]["error"]["detail"]["bytes"], 99);
        assert_eq!(
            v["failed"][1]["error"]["code"],
            json!(ErrorCode::AttachmentIsDirectory)
        );
        assert!(
            v["failed"][1]["error"].get("detail").is_none(),
            "a detail-less refusal omits the key, never null"
        );
        // A cancelled dialog: ok:true with BOTH arrays present and empty.
        assert_eq!(
            serde_json::to_value(PickAttachmentsResponse::default()).unwrap(),
            json!({ "attached": [], "failed": [] })
        );
    }

    #[test]
    fn clear_scope_deserializes_both_tagged_variants() {
        assert_eq!(
            serde_json::from_value::<ClearScope>(json!({ "kind": "session", "sessionId": "s1" }))
                .unwrap(),
            ClearScope::Session {
                session_id: "s1".into()
            }
        );
        assert_eq!(
            serde_json::from_value::<ClearScope>(json!({ "kind": "project", "projectId": "p1" }))
                .unwrap(),
            ClearScope::Project {
                project_id: "p1".into()
            }
        );
        assert!(serde_json::from_value::<ClearScope>(json!({ "kind": "bogus" })).is_err());
    }

    #[test]
    fn take_attachment_claims_exactly_once() {
        let mut s = test_session();
        let p = std::path::PathBuf::from("/repo/x.png");
        s.stage_attachment(att("at-1", "x.png", &p, false, "staged"));
        s.stage_attachment(att("at-2", "y.png", &p, true, "staged"));
        assert_eq!(s.take_attachment("at-1").unwrap().id, "at-1");
        assert!(
            s.take_attachment("at-1").is_none(),
            "the claim is exactly-once"
        );
        assert_eq!(s.attachments.len(), 1);
        assert!(s.take_attachment("nope").is_none());
    }

    #[test]
    fn take_attachment_never_claims_a_sent_record() {
        // FR-15's invariant enforced by the CORE, not merely by the UI's
        // derive-chips-from-staged rule: a `sent` record belongs to the
        // transcript and Claude may re-read it, so `releaseAttachment` must not
        // be able to delete its bytes. `commit_attachments` already honours this
        // (`partition_commit` skips non-staged records); `take` is the OTHER
        // door into the same deletion and has to refuse at the same line.
        let mut s = test_session();
        let p = std::path::PathBuf::from("/repo/x.png");
        s.stage_attachment(att("done", "x.png", &p, true, "sent"));
        s.stage_attachment(att("open", "y.png", &p, true, "staged"));

        assert!(
            s.take_attachment("done").is_none(),
            "a sent attachment is not releasable"
        );
        assert_eq!(
            s.attachments
                .iter()
                .map(|a| a.id.clone())
                .collect::<Vec<_>>(),
            vec!["done", "open"],
            "the refused claim leaves the record list untouched"
        );
        assert_eq!(s.take_attachment("open").unwrap().id, "open");
    }

    #[test]
    fn commit_marks_referenced_staged_sent_and_drops_the_rest() {
        // FR-15, over the session model.
        let mut s = test_session();
        let p = std::path::PathBuf::from("/repo/.francois/attachments/a3f9c1e2/a.png");
        s.stage_attachment(att("keep", "kept.png", &p, true, "staged"));
        s.stage_attachment(att("drop", "dropped.png", &p, true, "staged"));
        s.stage_attachment(att("old", "old.png", &p, true, "sent"));

        let (result, dropped) = s.commit_attachments("look at @kept.png please");

        assert_eq!(result.sent, vec!["keep".to_string()]);
        assert_eq!(result.released, vec!["drop".to_string()]);
        assert_eq!(
            dropped.iter().map(|a| a.id.clone()).collect::<Vec<_>>(),
            vec!["drop"]
        );
        let states: Vec<(String, String)> = s
            .attachments
            .iter()
            .map(|a| (a.id.clone(), a.state.clone()))
            .collect();
        assert_eq!(
            states,
            vec![
                ("keep".to_string(), "sent".to_string()),
                ("old".to_string(), "sent".to_string()) // already sent: untouched
            ]
        );
    }

    #[test]
    fn commit_against_empty_text_releases_every_staged_copy() {
        // The composer's `/clear` path commits against "" to discard a prompt
        // that was never sent: no ref can occur in empty text, so every STAGED
        // record is released and its copy deleted. `sent` records still belong
        // to the transcript and must survive.
        let mut s = test_session();
        let p = std::path::PathBuf::from("/repo/.francois/attachments/a3f9c1e2/a.png");
        s.stage_attachment(att("one", "a.png", &p, true, "staged"));
        s.stage_attachment(att("two", "b.png", &p, true, "staged"));
        s.stage_attachment(att("old", "old.png", &p, true, "sent"));

        let (result, dropped) = s.commit_attachments("");

        assert!(result.sent.is_empty(), "empty text references nothing");
        assert_eq!(result.released, vec!["one".to_string(), "two".to_string()]);
        assert_eq!(
            dropped.iter().map(|a| a.id.clone()).collect::<Vec<_>>(),
            vec!["one", "two"],
            "the caller deletes exactly these copies"
        );
        assert_eq!(
            s.attachments
                .iter()
                .map(|a| a.id.clone())
                .collect::<Vec<_>>(),
            vec!["old"],
            "an already-sent record is never swept by a /clear"
        );
    }

    #[test]
    fn forget_copied_keeps_in_place_records() {
        let mut s = test_session();
        let p = std::path::PathBuf::from("/repo/x.png");
        s.stage_attachment(att("copied", "a.png", &p, true, "staged"));
        s.stage_attachment(att("inplace", "b.png", &p, false, "staged"));
        s.forget_copied_attachments();
        assert_eq!(s.attachments.len(), 1);
        assert_eq!(s.attachments[0].id, "inplace");
    }

    #[test]
    fn sessions_of_project_selects_by_registry_link() {
        // FR-18: the sweep is driven by the session registry — a worktree session
        // (cwd anywhere on disk) is included purely because it carries the link.
        let mut a = test_session();
        a.project_id = Some("p1".into());
        let engine = test_engine_with(a);
        {
            let mut map = engine.sessions.lock().unwrap_or_else(|p| p.into_inner());
            let mut b = test_session();
            b.id = "s2".into();
            b.cwd = "/worktrees/feat-x".into();
            b.project_id = Some("p1".into());
            map.insert("s2".into(), b);
            let mut c = test_session();
            c.id = "s3".into();
            c.project_id = Some("other".into());
            map.insert("s3".into(), c);
        }
        let mut got = engine.sessions_of_project("p1");
        got.sort();
        assert_eq!(
            got,
            vec![
                ("s1".to_string(), "/x".to_string()),
                ("s2".to_string(), "/worktrees/feat-x".to_string())
            ]
        );
        assert!(engine.sessions_of_project("nobody").is_empty());
    }
}
