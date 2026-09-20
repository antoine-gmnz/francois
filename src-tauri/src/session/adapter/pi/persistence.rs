//! session/adapter/pi/persistence.rs — pi-session-durability §5/§6: the
//! core-private `PiResumeRecord` (never IPC — the native file path stays
//! core-private per the contract file's own doc) and the "owned" native
//! session directory it is validated against.
//!
//! `PiResumeRecord` is nested under the matching session record in
//! `sessions.json` (`session/persistence.rs`'s `pi` key) — there is no
//! separate file for it, so it rides the SAME atomic temp+rename write that
//! file already performs for the rest of the session record (FR-6: "existing
//! fs helpers"). Written by `adapter::pi::recovery` after a successful
//! connection and BEFORE any first prompt (FR-2).

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// FR-5: this adapter's own decoder version for the native entry shape
/// (`recovery::NativeEntry`) — bumped only when that assumption changes, so a
/// record written by an older build can be told apart from one this build
/// just wrote. Distinct from `schemaVersion` (the CONTRACT shape's own
/// version, pinned at 1 by the frozen contract).
pub(crate) const PROJECTION_DECODER_VERSION: u32 = 1;

/// spec §5: "Core-only persisted shape (not IPC)". Field order/names mirror
/// `contract/pi-session-durability.ts` exactly; `schemaVersion` is always `1`
/// per the frozen contract (there is only one shape yet).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub(crate) struct PiResumeRecord {
    #[serde(rename = "schemaVersion")]
    pub(crate) schema_version: u32,
    #[serde(rename = "nativeSessionId")]
    pub(crate) native_session_id: String,
    #[serde(rename = "nativeSessionFile")]
    pub(crate) native_session_file: String,
    #[serde(rename = "accountId")]
    pub(crate) account_id: String,
    #[serde(rename = "configDir")]
    pub(crate) config_dir: String,
    pub(crate) cwd: String,
    #[serde(rename = "piVersion")]
    pub(crate) pi_version: String,
    #[serde(rename = "lastEntryId")]
    pub(crate) last_entry_id: Option<String>,
    #[serde(rename = "leafId")]
    pub(crate) leaf_id: Option<String>,
    #[serde(rename = "projectionVersion")]
    pub(crate) projection_version: u32,
}

impl PiResumeRecord {
    /// FR-1: built once, right after a successful `get_state` handshake
    /// validated the returned identity — never before, never from a caller's
    /// guess at what Pi will report.
    ///
    /// KNOWN GAP (this feature's handoff): no production call site exists
    /// yet — `session_create` does not connect a Pi session's FIRST child
    /// (that wiring belongs to whichever feature makes Pi selectable at
    /// creation, e.g. pi-turn-controls). `#[allow(dead_code)]` reflects that
    /// honestly rather than hiding it; clears the moment that caller lands.
    #[allow(dead_code)]
    pub(crate) fn new(
        native_session_id: String,
        native_session_file: String,
        account_id: String,
        config_dir: String,
        cwd: String,
        pi_version: String,
    ) -> Self {
        Self {
            schema_version: 1,
            native_session_id,
            native_session_file,
            account_id,
            config_dir,
            cwd,
            pi_version,
            last_entry_id: None,
            leaf_id: None,
            projection_version: PROJECTION_DECODER_VERSION,
        }
    }
}

/// FR-1: `<app_data>/runtimes/pi/sessions/<francoisSessionId>/` — the root a
/// session's native Pi conversation is validated against (FR-3). Pure over an
/// already-resolved `app_data` directory so it is testable with a temp dir —
/// `native_session_dir` below is the `AppHandle`-resolving convenience the
/// production call sites use.
pub(crate) fn native_session_root(app_data: &Path, session_id: &str) -> Option<PathBuf> {
    if !crate::session::valid_session_id(session_id) {
        return None;
    }
    Some(
        app_data
            .join("runtimes")
            .join("pi")
            .join("sessions")
            .join(session_id),
    )
}

pub(crate) fn native_session_dir(app: &AppHandle, session_id: &str) -> Option<PathBuf> {
    let app_data = app.path().app_data_dir().ok()?;
    native_session_root(&app_data, session_id)
}

/// FR-3: is `candidate` canonically located under `root`? Both sides must
/// resolve (a symlink escape or a path that does not exist at all reads as
/// "not owned", never as "owned by default") — this is the "canonicalized
/// owned file location" check, run BEFORE the file is trusted for anything
/// else.
pub(crate) fn is_owned_path(root: &Path, candidate: &Path) -> bool {
    let (Ok(root), Ok(candidate)) = (
        std::fs::canonicalize(root),
        std::fs::canonicalize(candidate),
    ) else {
        return false;
    };
    candidate.starts_with(root)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record() -> PiResumeRecord {
        PiResumeRecord::new(
            "native-1".into(),
            "/data/runtimes/pi/sessions/s1/native-1.jsonl".into(),
            "pi-acct-1".into(),
            "/home/user/.pi".into(),
            "/repo".into(),
            "0.85.1".into(),
        )
    }

    #[test]
    fn new_record_carries_schema_version_one_and_no_cursor_yet() {
        let r = record();
        assert_eq!(r.schema_version, 1);
        assert_eq!(r.projection_version, PROJECTION_DECODER_VERSION);
        assert!(r.last_entry_id.is_none());
        assert!(r.leaf_id.is_none());
    }

    #[test]
    fn round_trips_through_json_with_contract_field_names() {
        let r = record();
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["schemaVersion"], 1);
        assert_eq!(v["nativeSessionId"], "native-1");
        assert_eq!(
            v["nativeSessionFile"],
            "/data/runtimes/pi/sessions/s1/native-1.jsonl"
        );
        assert_eq!(v["accountId"], "pi-acct-1");
        assert_eq!(v["configDir"], "/home/user/.pi");
        assert_eq!(v["cwd"], "/repo");
        assert_eq!(v["piVersion"], "0.85.1");
        assert!(v["lastEntryId"].is_null());
        assert!(v["leafId"].is_null());
        let back: PiResumeRecord = serde_json::from_value(v).unwrap();
        assert_eq!(back, r);
    }

    #[test]
    fn native_session_root_is_scoped_by_session_id_and_rejects_a_tainted_one() {
        let app_data = Path::new("/data");
        assert_eq!(
            native_session_root(app_data, "s1").unwrap(),
            Path::new("/data/runtimes/pi/sessions/s1")
        );
        assert_ne!(
            native_session_root(app_data, "s1").unwrap(),
            native_session_root(app_data, "s2").unwrap()
        );
        // valid_session_id: no path separators or traversal tokens.
        assert!(native_session_root(app_data, "../escape").is_none());
        assert!(native_session_root(app_data, "s1/../s2").is_none());
    }

    #[test]
    fn is_owned_path_accepts_a_file_under_root_and_rejects_one_outside_or_missing() {
        let dir = std::env::temp_dir().join(format!(
            "francois-pi-persistence-{}-{}",
            std::process::id(),
            crate::ids::uuid()
        ));
        let owned_root = dir.join("runtimes").join("pi").join("sessions").join("s1");
        std::fs::create_dir_all(&owned_root).unwrap();
        let owned_file = owned_root.join("native-1.jsonl");
        std::fs::write(&owned_file, "{}\n").unwrap();

        let outside_dir = dir.join("elsewhere");
        std::fs::create_dir_all(&outside_dir).unwrap();
        let outside_file = outside_dir.join("native-1.jsonl");
        std::fs::write(&outside_file, "{}\n").unwrap();

        assert!(is_owned_path(&owned_root, &owned_file));
        assert!(!is_owned_path(&owned_root, &outside_file));
        assert!(!is_owned_path(
            &owned_root,
            &owned_root.join("missing.jsonl")
        ));

        std::fs::remove_dir_all(&dir).ok();
    }

    /// FR-9: "keep native conversation files for recovery; no implicit
    /// recursive deletion of Pi data." `session_remove`
    /// (`session/commands/lifecycle.rs`) only ever unlinks the François-owned
    /// projection (`crate::session::transcript_path`, under `transcripts/`)
    /// and drops the in-memory record (so it is absent from the next
    /// `sessions.json` write) — it never names `native_session_root` at all.
    /// This pins the structural guarantee that makes that safe: the two
    /// trees are disjoint siblings under the SAME app-data root for the SAME
    /// session id, so removing one can never reach into the other, whatever
    /// order the two removals run in.
    #[test]
    fn the_native_session_root_and_the_transcript_path_are_disjoint_sibling_trees() {
        let app_data = Path::new("/data");
        let session_id = "s1";
        let native_root = native_session_root(app_data, session_id).unwrap();
        let transcript_path = app_data
            .join("transcripts")
            .join(format!("{session_id}.jsonl"));
        assert!(!transcript_path.starts_with(&native_root));
        assert!(!native_root.starts_with(transcript_path.parent().unwrap()));
        // A DIFFERENT session's native root never collides with this one's
        // transcript file, or vice versa — same "explicit file selection,
        // never a partial ID lookup" discipline FR-1 asks of the RESUME path.
        let other_native_root = native_session_root(app_data, "s2").unwrap();
        assert_ne!(native_root, other_native_root);
    }
}
