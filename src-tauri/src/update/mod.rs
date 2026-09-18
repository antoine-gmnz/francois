// update/ — the `app` domain's self-update (specs/self-update.md).
//
// Francois ships a release on every push to `main`; a running install has no way
// to know. This module compares its own version against what the npm registry
// serves (`app_check_update`) and, when asked, hands the actual install to
// `npm i -g francois@latest` through a detached helper that waits for the app to
// quit, updates, and relaunches it (`app_apply_update`).
//
// Delegating to npm is deliberate (spec §1): packaging/npm/install.js already
// downloads the right portable archive, verifies its sha256, unpacks it and
// re-registers the Start Menu entry / ~/Applications bundle / .desktop file, and
// CI exercises that whole path on every publish.
//
// `mod.rs` owns the shared data model (`UpdateCheck`, `UpdateApplyAck`,
// `UpdateState`) and the constants; children own one concern each:
//  * version.rs    — the numeric-triple comparison (FR-4).
//  * provenance.rs — is this copy npm-managed? (FR-5).
//  * check.rs      — the two HTTP calls and the assembled UpdateCheck (FR-2/3/6).
//  * helper.rs     — the generated relauncher and its detached spawn (FR-13..FR-17).
//  * commands.rs   — the francois:app:<verb> command surface.
//
// LOCK ORDER: `UpdateState` is a LEAF, like `usage::UsageState` — nothing here
// ever holds it while touching `session::Engine.sessions`. FR-12's running-session
// count is read from the engine BEFORE the update state is locked.

mod check;
mod commands;
mod helper;
mod provenance;
mod version;

pub(crate) use check::*;
pub use commands::*;
pub(crate) use helper::*;
pub(crate) use provenance::*;
pub(crate) use version::*;

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

/// The npm package this app is published as.
pub const PACKAGE: &str = "francois";
/// `owner/repo` the release notes are read from (FR-3).
pub const REPO: &str = "antoine-gmnz/francois";
/// FR-2: the npm registry — not GitHub — is the source of truth for the version,
/// because it is exactly what `npm i -g francois@latest` will install.
pub const REGISTRY_LATEST_URL: &str = "https://registry.npmjs.org/francois/latest";
/// The verbatim command a manual install runs, and what the helper runs (FR-11/FR-14).
pub const UPDATE_COMMAND: &str = "npm i -g francois@latest";
/// FR-6: both HTTP calls.
pub const HTTP_TIMEOUT_SECS: u64 = 10;
/// contract `UpdateMethod`.
pub const METHOD_NPM: &str = "npm";
pub const METHOD_MANUAL: &str = "manual";
/// FR-14: the helper gives up if the app has not exited this long after launch.
pub const EXIT_WAIT_SECS: u64 = 120;
/// FR-16: how long after the ack reaches the webview the core waits before exiting.
pub const SHUTDOWN_GRACE_MS: u64 = 400;

// ---------- contract shapes (contract/self-update.ts, mirrored) ----------

/// Mirrors `UpdateCheck`. `notes` is OMITTED (never null) when the best-effort
/// GitHub fetch failed — the contract types it optional (FR-3).
#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct UpdateCheck {
    /// FR-1: the running build, from CARGO_PKG_VERSION.
    pub current: String,
    /// FR-2: newest version on the npm registry.
    pub latest: String,
    /// FR-4: `latest` > `current` as a numeric triple.
    #[serde(rename = "updateAvailable")]
    pub update_available: bool,
    /// contract UpdateMethod: "npm" | "manual".
    pub method: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    /// Always present, even when `notes` is not.
    #[serde(rename = "notesUrl")]
    pub notes_url: String,
    pub command: String,
    #[serde(rename = "checkedAt")]
    pub checked_at: u64,
}

/// Mirrors `UpdateApplyAck` — resolved BEFORE the core begins shutdown (FR-16).
#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct UpdateApplyAck {
    #[serde(rename = "helperPid")]
    pub helper_pid: u32,
    pub latest: String,
    /// FR-15: absolute path to the helper's update.log, so a failed update is diagnosable.
    #[serde(rename = "logPath")]
    pub log_path: String,
}

/// §6 / FR-19: the last check, held in memory and replaced wholesale. Nothing
/// about update state is persisted to disk.
#[derive(Default)]
pub struct UpdateState {
    last: Mutex<Option<UpdateCheck>>,
    /// §7: guards `app_apply_update` against two overlapping calls each spawning
    /// their own helper — only one apply may be in flight at a time.
    applying: AtomicBool,
}

impl UpdateState {
    /// FR-19: a new check replaces the previous one wholesale.
    pub fn store(&self, check: UpdateCheck) {
        *self.last.lock().unwrap() = Some(check);
    }

    pub(crate) fn last(&self) -> Option<UpdateCheck> {
        self.last.lock().unwrap().clone()
    }

    /// §7: atomic test-and-set. Returns `true` for the caller that wins the
    /// claim; a second overlapping call sees `false` and must resolve
    /// `UPDATE_APPLY_FAILED` rather than spawn a second helper.
    pub(crate) fn begin_apply(&self) -> bool {
        self.applying
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }

    /// Releases the claim after a failed apply, so a retry can proceed. Never
    /// called on success — the process is about to exit anyway.
    pub(crate) fn end_apply(&self) {
        self.applying.store(false, Ordering::SeqCst);
    }
}

#[cfg(test)]
pub(crate) fn check_fixture(current: &str, latest: &str, method: &str) -> UpdateCheck {
    UpdateCheck {
        current: current.into(),
        latest: latest.into(),
        update_available: is_newer(latest, current).unwrap_or(false),
        method: method.into(),
        notes: None,
        notes_url: notes_url(latest),
        command: UPDATE_COMMAND.into(),
        checked_at: 1_700_000_000_000,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // §5: the wire shape is what contract/self-update.ts declares — camelCase
    // keys, `notes` optional, everything else required.
    #[test]
    fn update_check_serializes_to_the_contract_shape() {
        let mut check = check_fixture("0.15.8", "0.16.0", METHOD_NPM);
        check.notes = Some("### Fixes\n- a thing".into());
        let v = serde_json::to_value(&check).unwrap();
        assert_eq!(
            v,
            json!({
                "current": "0.15.8",
                "latest": "0.16.0",
                "updateAvailable": true,
                "method": "npm",
                "notes": "### Fixes\n- a thing",
                "notesUrl": "https://github.com/antoine-gmnz/francois/releases/tag/v0.16.0",
                "command": "npm i -g francois@latest",
                "checkedAt": 1_700_000_000_000u64,
            })
        );
    }

    // FR-3: a failed notes fetch leaves `notes` ABSENT — never null, so the
    // frontend's `notes?: string` reads as undefined.
    #[test]
    fn update_check_omits_notes_when_absent() {
        let v = serde_json::to_value(check_fixture("0.15.8", "0.16.0", METHOD_MANUAL)).unwrap();
        assert!(v.get("notes").is_none(), "notes must be omitted, not null");
        assert_eq!(v["method"], "manual");
        assert!(v.get("notesUrl").is_some(), "notesUrl is always present");
    }

    #[test]
    fn update_check_round_trips() {
        let check = check_fixture("0.15.8", "0.15.8", METHOD_NPM);
        let back: UpdateCheck =
            serde_json::from_str(&serde_json::to_string(&check).unwrap()).unwrap();
        assert_eq!(back, check);
        assert!(!back.update_available);
    }

    #[test]
    fn update_apply_ack_serializes_to_the_contract_shape() {
        let ack = UpdateApplyAck {
            helper_pid: 4242,
            latest: "0.16.0".into(),
            log_path: "/tmp/francois-update-1/update.log".into(),
        };
        let v = serde_json::to_value(&ack).unwrap();
        assert_eq!(
            v,
            json!({
                "helperPid": 4242,
                "latest": "0.16.0",
                "logPath": "/tmp/francois-update-1/update.log",
            })
        );
        let back: UpdateApplyAck = serde_json::from_value(v).unwrap();
        assert_eq!(back, ack);
    }

    // FR-19: the state holds ONE check and a new one replaces it wholesale.
    #[test]
    fn state_replaces_the_previous_check_wholesale() {
        let state = UpdateState::default();
        assert!(state.last().is_none());
        state.store(check_fixture("0.15.8", "0.16.0", METHOD_NPM));
        state.store(check_fixture("0.15.8", "0.17.0", METHOD_NPM));
        assert_eq!(state.last().unwrap().latest, "0.17.0");
    }

    // §7: two overlapping applies must not both claim the guard — only the
    // first `begin_apply` wins; the second sees `false` until the first ends.
    #[test]
    fn begin_apply_is_an_atomic_test_and_set() {
        let state = UpdateState::default();
        assert!(state.begin_apply(), "the first caller must win the claim");
        assert!(
            !state.begin_apply(),
            "an overlapping caller must not also win it"
        );
        state.end_apply();
        assert!(
            state.begin_apply(),
            "after the claim is released a retry can win it"
        );
    }
}
