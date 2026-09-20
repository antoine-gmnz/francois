//! session/admission/sidecar.rs — pi-turn-controls FR-9: the atomic app-data
//! sidecar (crash/restart draft recovery). Split out of the former
//! single-file `admission.rs` purely for CLAUDE.md's ~1000-line file cap; no
//! behaviour changed by the split.

use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

use super::*;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
struct DraftRecord {
    #[serde(rename = "clientMessageId")]
    client_message_id: String,
    text: String,
    delivery: DeliveryMode,
    #[serde(rename = "attachmentIds")]
    attachment_ids: Vec<String>,
    #[serde(rename = "createdAt")]
    created_at: u64,
    /// Persisted verbatim (contract clarification, lead post-freeze): a
    /// recoverable terminal state (`cancelled`/`delivery-unknown`/`rejected`)
    /// reloads as itself; only `admitting`/`queued` (genuinely unconfirmed at
    /// crash time) are reclassified on load — see `hydrate_from_drafts`.
    state: AdmissionState,
}

/// `<app_data>/queue/<sessionId>.json` — a sibling of `transcripts/`. Pending
/// text is private session data (FR-9): never logged, never folded into any
/// other sidecar.
pub(crate) fn admission_sidecar_path(app: &AppHandle, session_id: &str) -> Option<PathBuf> {
    if !super::super::valid_session_id(session_id) {
        return None;
    }
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("queue").join(format!("{session_id}.json")))
}

/// Atomic whole-file snapshot (temp + rename, `fs_util::unique_temp_path`) —
/// unlike the transcript's append-only sidecar, this ledger is small (capped
/// at 20 entries) and mutates in place, so a snapshot is the natural shape.
/// Best-effort: a write failure never breaks the calling turn.
fn write_sidecar_file(path: &Path, drafts: &[DraftRecord]) {
    if drafts.is_empty() {
        let _ = std::fs::remove_file(path);
        return;
    }
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let Ok(bytes) = serde_json::to_vec(drafts) else {
        return;
    };
    let tmp = crate::fs_util::unique_temp_path(path, "json");
    if std::fs::write(&tmp, &bytes).is_ok() && std::fs::rename(&tmp, path).is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
}

/// Snapshot `engine`'s CURRENT ledger for `session_id` and write it atomically
/// — the one call site every mutation (`admit_and_deliver`, the Stop
/// sequence, `session_unqueue`/`session_clear_queue`) reaches for rather than
/// juggling a borrowed `&AdmissionLedger` across the lock.
pub(crate) fn write_admission_sidecar(app: &AppHandle, engine: &Engine, session_id: &str) {
    let Some(path) = admission_sidecar_path(app, session_id) else {
        return;
    };
    let drafts = engine.with_admissions(session_id, |l| l.draft_records());
    write_sidecar_file(&path, &drafts);
}

fn read_sidecar_file(path: &Path) -> Vec<DraftRecord> {
    let Ok(bytes) = std::fs::read(path) else {
        return Vec::new();
    };
    serde_json::from_slice(&bytes).unwrap_or_default()
}

/// FR-9: load whatever drafts survived a crash/restart for one session — a
/// draft still `admitting`/`queued` comes back `delivery-unknown`, ready for
/// an explicit Resend, never auto-submitted; an already-recoverable draft
/// (`cancelled`/`delivery-unknown`/`rejected`) keeps its exact state.
pub(crate) fn load_admission_sidecar(app: &AppHandle, session_id: &str) -> AdmissionLedger {
    let Some(path) = admission_sidecar_path(app, session_id) else {
        return AdmissionLedger::default();
    };
    AdmissionLedger::hydrate_from_drafts(read_sidecar_file(&path))
}

pub(crate) fn remove_admission_sidecar(app: &AppHandle, session_id: &str) {
    if let Some(path) = admission_sidecar_path(app, session_id) {
        let _ = std::fs::remove_file(&path);
    }
}

impl AdmissionLedger {
    /// FR-9: rebuild after a crash/restart from the sidecar's drafts. A draft
    /// still `admitting`/`queued` at crash time becomes `delivery-unknown`
    /// (we cannot know whether Pi ever saw it) and is NEVER auto-submitted;
    /// a draft already a recoverable terminal state (`cancelled`/
    /// `delivery-unknown`/`rejected`) keeps that exact state — its outcome
    /// was already known before the crash.
    fn hydrate_from_drafts(drafts: Vec<DraftRecord>) -> Self {
        let mut ledger = Self::default();
        for d in drafts {
            let seq = ledger.next_seq;
            ledger.next_seq += 1;
            let state = match d.state {
                AdmissionState::Admitting | AdmissionState::Queued => {
                    AdmissionState::DeliveryUnknown
                }
                recoverable => recoverable,
            };
            ledger.entries.push(Entry {
                client_message_id: d.client_message_id,
                text: d.text,
                delivery: d.delivery,
                attachment_ids: d.attachment_ids,
                state,
                created_at: d.created_at,
                seq,
            });
        }
        ledger
    }

    /// FR-9: the sidecar's whole content — every entry still on record (same
    /// set `snapshot_pending` shows; a `consumed` entry is never in
    /// `self.entries`), so the retained recoverable drafts survive a restart
    /// exactly like the truly-pending ones do.
    fn draft_records(&self) -> Vec<DraftRecord> {
        self.entries
            .iter()
            .map(|e| DraftRecord {
                client_message_id: e.client_message_id.clone(),
                text: e.text.clone(),
                delivery: e.delivery,
                attachment_ids: e.attachment_ids.clone(),
                created_at: e.created_at,
                state: e.state,
            })
            .collect()
    }
}

impl Engine {
    /// FR-9: called once, from session load — seed the in-memory ledger from
    /// whatever the crash sidecar still holds, so `snapshot_pending` and a
    /// subsequent `queue.changed` see the recovered drafts immediately.
    pub(crate) fn hydrate_admissions(&self, app: &AppHandle, session_id: &str) {
        let ledger = load_admission_sidecar(app, session_id);
        if ledger.entries.is_empty() {
            return;
        }
        let mut map = self.admissions.lock().unwrap_or_else(|p| p.into_inner());
        map.insert(session_id.to_string(), ledger);
    }

    pub(crate) fn drop_admissions(&self, session_id: &str) {
        self.admissions
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(session_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids() -> Vec<String> {
        Vec::new()
    }

    #[test]
    fn hydrate_from_drafts_reclassifies_unconfirmed_entries_as_delivery_unknown() {
        let drafts = vec![DraftRecord {
            client_message_id: "c1".into(),
            text: "unsent draft".into(),
            delivery: DeliveryMode::Normal,
            attachment_ids: Vec::new(),
            created_at: 42,
            state: AdmissionState::Admitting,
        }];
        let l = AdmissionLedger::hydrate_from_drafts(drafts);
        let pending = l.snapshot_pending();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].receipt.state, AdmissionState::DeliveryUnknown);
        assert_eq!(pending[0].text, "unsent draft");
        assert_eq!(pending[0].created_at, 42);
    }

    /// Contract clarification (lead, post-freeze): a draft that was ALREADY a
    /// recoverable terminal state before the crash reloads with that EXACT
    /// state — its outcome was already known, so a restart must not blur a
    /// confident `cancelled`/`rejected` back into `delivery-unknown`.
    #[test]
    fn hydrate_from_drafts_preserves_an_already_recoverable_terminal_state() {
        let drafts = vec![
            DraftRecord {
                client_message_id: "c1".into(),
                text: "was cancelled".into(),
                delivery: DeliveryMode::Steer,
                attachment_ids: Vec::new(),
                created_at: 1,
                state: AdmissionState::Cancelled,
            },
            DraftRecord {
                client_message_id: "c2".into(),
                text: "was rejected".into(),
                delivery: DeliveryMode::Normal,
                attachment_ids: Vec::new(),
                created_at: 2,
                state: AdmissionState::Rejected,
            },
        ];
        let l = AdmissionLedger::hydrate_from_drafts(drafts);
        let pending = l.snapshot_pending();
        assert_eq!(pending[0].receipt.state, AdmissionState::Cancelled);
        assert_eq!(pending[1].receipt.state, AdmissionState::Rejected);
    }

    #[test]
    fn draft_records_round_trip_through_json_with_contract_field_names() {
        let mut l = AdmissionLedger::default();
        l.admit(
            "c1",
            "hello",
            DeliveryMode::FollowUp,
            &["a1".to_string()],
            7,
        )
        .unwrap();
        let drafts = l.draft_records();
        let v = serde_json::to_value(&drafts).unwrap();
        assert_eq!(v[0]["clientMessageId"], "c1");
        assert_eq!(v[0]["delivery"], "followUp");
        assert_eq!(v[0]["attachmentIds"][0], "a1");
        assert_eq!(v[0]["createdAt"], 7);
        assert_eq!(v[0]["state"], "admitting");
        let back: Vec<DraftRecord> = serde_json::from_value(v).unwrap();
        assert_eq!(back, drafts);
    }

    /// The exact behaviour the coordinator's clarification asks for at the
    /// ledger level: a Stop's cancelled entries persist into the sidecar
    /// alongside genuinely-pending ones, and survive a reload with their
    /// state intact.
    #[test]
    fn draft_records_include_cancelled_entries_and_a_reload_keeps_them_cancelled() {
        let mut l = AdmissionLedger::default();
        l.admit("c1", "will be stopped", DeliveryMode::Normal, &ids(), 0)
            .unwrap();
        l.mark_dispatch_result("c1", DispatchOutcome::Accepted);
        l.clear();
        let drafts = l.draft_records();
        assert_eq!(drafts.len(), 1);
        assert_eq!(drafts[0].state, AdmissionState::Cancelled);

        let reloaded = AdmissionLedger::hydrate_from_drafts(drafts);
        let pending = reloaded.snapshot_pending();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].receipt.state, AdmissionState::Cancelled);
        assert_eq!(pending[0].text, "will be stopped");
    }

    #[test]
    fn sidecar_write_then_read_round_trips_and_an_empty_ledger_removes_the_file() {
        let dir = std::env::temp_dir().join(format!(
            "francois-admission-sidecar-{}-{}",
            std::process::id(),
            crate::ids::uuid()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("s1.json");

        let mut l = AdmissionLedger::default();
        l.admit("c1", "draft", DeliveryMode::Steer, &ids(), 3)
            .unwrap();
        write_sidecar_file(&path, &l.draft_records());
        assert!(path.exists());
        let read_back = read_sidecar_file(&path);
        assert_eq!(read_back.len(), 1);
        assert_eq!(read_back[0].client_message_id, "c1");

        write_sidecar_file(&path, &[]);
        assert!(
            !path.exists(),
            "an empty draft list removes the sidecar file"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_corrupt_sidecar_reads_back_as_no_drafts_rather_than_failing() {
        let dir = std::env::temp_dir().join(format!(
            "francois-admission-sidecar-corrupt-{}-{}",
            std::process::id(),
            crate::ids::uuid()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("s1.json");
        std::fs::write(&path, b"not json").unwrap();
        assert!(read_sidecar_file(&path).is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }
}
