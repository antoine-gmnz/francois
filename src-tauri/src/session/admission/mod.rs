//! session/admission/ — pi-turn-controls (specs/pi-turn-controls.md FR-1..
//! FR-5, FR-9): the per-session admissions ledger.
//!
//! Split by concern per CLAUDE.md's ~1000-line file cap (this used to be one
//! ~1230-line `admission.rs`) — same "one concern per child" shape the rest
//! of this domain follows. This `mod.rs` owns the shared data model:
//! `DeliveryMode`/`AdmissionState`/`RuntimeMessageReceipt`/`RuntimeQueueEntry`
//! (the contract mirrors), `Entry`/`AdmissionLedger` (the ledger's own
//! shape), and declares the three children, each owning one concern plus its
//! own `#[cfg(test)] mod tests`:
//!   - `ledger` — the admit/consume/clear/unqueue state machine, i.e.
//!     `AdmissionLedger`'s own behavioural methods;
//!   - `sidecar` — the atomic app-data persistence (FR-9): `DraftRecord`,
//!     read/write/remove, `hydrate_from_drafts`/`draft_records`, and the
//!     `Engine` hydrate/drop glue;
//!   - `deliver` — `admit_and_deliver` (the ONE internal admission entry
//!     point) and `publish_queue_changed`; see the POLICY GATE marker inside.
//! No behaviour changed by this split — every item kept its name and
//! visibility; only the file it lives in moved. Every
//! `crate::session::admission::<name>` path already used elsewhere
//! (submit.rs, turn.rs, lifecycle.rs, controls.rs, persistence.rs, events.rs)
//! keeps resolving unchanged, via the named re-exports below (this repo has
//! no barrel files, so nothing is re-exported wholesale).
//!
//! CONTRACT CLARIFICATION (lead, post-freeze — conformed to here): the
//! composer's queue strip (`queue.changed.entries`, and this ledger's own
//! `snapshot_pending`) is the FULL unresolved ledger — `admitting`/`queued`
//! PLUS the recoverable terminal states (`cancelled`/`delivery-unknown`/
//! `rejected`), which stay listed with their text intact until the user
//! removes them (`unqueue` — Discard — or a fresh `admit` reusing the id —
//! Resend). Only `consumed` drops an entry from the ledger, the instant it
//! settles (its transcript block replaces it). `session_unqueue`, for a Pi
//! session, removes any entry Pi does NOT own — a still-local `admitting`
//! intent, or any of the three recoverable terminal states; a Pi-accepted
//! `queued` entry still answers `RUNTIME_UNSUPPORTED` (FR-5: never
//! clear-and-re-enqueue a live queue, which can duplicate consumed work). The
//! sidecar persists this same full set (FR-9), and a reload preserves an
//! already-recoverable state exactly — only a draft still `admitting`/
//! `queued` at crash time is reclassified `delivery-unknown`.
//!
//! PROVISIONAL (readiness gap, flagged in this feature's handoff — the spec
//! names this ambiguity explicitly): the exact wire shape for "steer"/
//! "follow-up" delivery is uncertified. This module's narrowest defensible
//! reading is that every admitted entry rides the SAME `prompt` RPC
//! `RuntimeSessionControl::submit` already sends (no wire-level "delivery"
//! hint is invented, and `wire::PiCommandBody::Prompt`'s shape is untouched)
//! — the delivery mode is François's OWN ledger classification, used for
//! validation and the composer's queue strip, never sent to Pi. Dispatch is
//! attempted synchronously, the instant an entry is admitted, which collapses
//! `AdmissionState::Admitting` into a near-instantaneous window in practice.
//! A different, equally defensible reading would hold a queued entry locally
//! until its own turn under a stricter one-at-a-time send policy; flagged
//! here for reconciliation once a certified capture exists.

use crate::ipc::{AppError, ErrorCode};
use serde::{Deserialize, Serialize};

use super::Engine;

mod deliver;
mod ledger;
mod sidecar;

pub(crate) use deliver::{admit_and_deliver, publish_queue_changed};
pub(crate) use sidecar::{remove_admission_sidecar, write_admission_sidecar};

/// FR-4: at most this many pending (not yet consumed/settled) intents per session.
pub(crate) const MAX_PENDING: usize = 20;
/// FR-4: at most this many UTF-8 bytes of message text.
pub(crate) const MAX_TEXT_BYTES: usize = 1024 * 1024;
/// FR-4: the 32 MiB encoded-frame cap, estimated pre-dispatch in `admit_and_deliver`.
pub(crate) const MAX_FRAME_BYTES: u64 = 32 * 1024 * 1024;

// ---------------------------------------------------------------- contract mirrors

/// Mirrors contract/common.ts `DeliveryMode`.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DeliveryMode {
    Normal,
    Steer,
    FollowUp,
}

/// Mirrors contract/common.ts `RuntimeMessageReceipt.state`.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum AdmissionState {
    Admitting,
    Queued,
    Consumed,
    Cancelled,
    DeliveryUnknown,
    Rejected,
}

/// Mirrors contract/common.ts `RuntimeMessageReceipt`.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct RuntimeMessageReceipt {
    #[serde(rename = "clientMessageId")]
    pub(crate) client_message_id: String,
    pub(crate) state: AdmissionState,
    pub(crate) delivery: DeliveryMode,
    #[serde(rename = "queuePosition", skip_serializing_if = "Option::is_none")]
    pub(crate) queue_position: Option<u32>,
}

/// Mirrors contract/common.ts `RuntimeQueueEntry` (`extends RuntimeMessageReceipt`).
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct RuntimeQueueEntry {
    #[serde(flatten)]
    pub(crate) receipt: RuntimeMessageReceipt,
    pub(crate) text: String,
    #[serde(rename = "attachmentIds")]
    pub(crate) attachment_ids: Vec<String>,
    #[serde(rename = "createdAt")]
    pub(crate) created_at: u64,
}

// ---------------------------------------------------------------- the ledger's own shape

#[derive(Clone)]
struct Entry {
    client_message_id: String,
    text: String,
    delivery: DeliveryMode,
    attachment_ids: Vec<String>,
    state: AdmissionState,
    created_at: u64,
    /// Admission order — the ONLY thing consumption association trusts (FR-3).
    seq: u64,
}

impl Entry {
    fn receipt(&self, position: Option<u32>) -> RuntimeMessageReceipt {
        RuntimeMessageReceipt {
            client_message_id: self.client_message_id.clone(),
            state: self.state,
            delivery: self.delivery,
            queue_position: position,
        }
    }
}

#[derive(Debug)]
pub(crate) enum AdmitError {
    Empty,
    TooLarge,
    IdConflict,
    QueueFull,
}

impl AdmitError {
    pub(crate) fn into_app_error(self) -> AppError {
        match self {
            AdmitError::Empty => AppError::new(ErrorCode::InvalidInput, "message is empty"),
            AdmitError::TooLarge => AppError::new(
                ErrorCode::InvalidInput,
                "message text is over the 1 MiB limit",
            ),
            AdmitError::IdConflict => AppError::new(
                ErrorCode::InvalidInput,
                "clientMessageId was already used with different content",
            ),
            AdmitError::QueueFull => AppError::with_detail(
                ErrorCode::QueueFull,
                "this session already has 20 pending intents",
                serde_json::json!({ "cap": MAX_PENDING }),
            ),
        }
    }
}

/// What a dispatch attempt resolved to, from the ledger's point of view.
#[derive(Clone, Copy)]
pub(crate) enum DispatchOutcome {
    Accepted,
    /// A clean, known rejection — Pi (or the generic runtime) refused it.
    Rejected,
    /// The connection itself failed/timed out — delivery is genuinely unknown.
    Uncertain,
}

pub(crate) enum UnqueueOutcome {
    Removed,
    Unsupported,
    NotFound,
}

/// FR-1..FR-5, FR-9: one session's admissions ledger. Pure — no I/O, no
/// `AppHandle`, no session lock of its own (the caller already holds one).
/// Its behavioural methods live in the `ledger`/`sidecar` children — see this
/// file's own module doc.
#[derive(Default)]
pub(crate) struct AdmissionLedger {
    entries: Vec<Entry>,
    next_seq: u64,
    /// FR-6: "Stop closes admission" — a new submit is refused while true.
    closed: bool,
}

// ---------------------------------------------------------------- Engine glue

impl Engine {
    /// One-session-at-a-time access to its admissions ledger — same shape as
    /// `with_session`/`with_session_mut`, over the sibling `admissions` map.
    pub(crate) fn with_admissions<T>(
        &self,
        session_id: &str,
        f: impl FnOnce(&mut AdmissionLedger) -> T,
    ) -> T {
        let mut map = self.admissions.lock().unwrap_or_else(|p| p.into_inner());
        f(map.entry(session_id.to_string()).or_default())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn receipt_and_queue_entry_serialize_to_the_contract_shape() {
        let receipt = RuntimeMessageReceipt {
            client_message_id: "c1".into(),
            state: AdmissionState::Queued,
            delivery: DeliveryMode::Steer,
            queue_position: Some(2),
        };
        let v = serde_json::to_value(&receipt).unwrap();
        assert_eq!(
            v,
            serde_json::json!({
                "clientMessageId": "c1", "state": "queued", "delivery": "steer",
                "queuePosition": 2
            })
        );
        let no_position = RuntimeMessageReceipt {
            queue_position: None,
            ..receipt.clone()
        };
        assert!(serde_json::to_value(&no_position)
            .unwrap()
            .get("queuePosition")
            .is_none());

        let entry = RuntimeQueueEntry {
            receipt,
            text: "steer this".into(),
            attachment_ids: vec!["a1".into()],
            created_at: 1_000,
        };
        let v = serde_json::to_value(&entry).unwrap();
        assert_eq!(v["clientMessageId"], "c1");
        assert_eq!(v["state"], "queued");
        assert_eq!(v["text"], "steer this");
        assert_eq!(v["attachmentIds"][0], "a1");
        assert_eq!(v["createdAt"], 1_000);
    }

    #[test]
    fn delivery_mode_serializes_to_the_contract_spelling() {
        for (mode, wire) in [
            (DeliveryMode::Normal, "normal"),
            (DeliveryMode::Steer, "steer"),
            (DeliveryMode::FollowUp, "followUp"),
        ] {
            assert_eq!(serde_json::to_value(mode).unwrap(), serde_json::json!(wire));
        }
    }

    #[test]
    fn admission_state_serializes_to_the_contract_spelling() {
        for (state, wire) in [
            (AdmissionState::Admitting, "admitting"),
            (AdmissionState::Queued, "queued"),
            (AdmissionState::Consumed, "consumed"),
            (AdmissionState::Cancelled, "cancelled"),
            (AdmissionState::DeliveryUnknown, "delivery-unknown"),
            (AdmissionState::Rejected, "rejected"),
        ] {
            assert_eq!(
                serde_json::to_value(state).unwrap(),
                serde_json::json!(wire)
            );
        }
    }
}
