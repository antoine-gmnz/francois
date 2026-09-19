//! `pi` accounts (pi-provider-auth, specs/pi-provider-auth.md): a REFERENCE to
//! an existing, user-owned `PI_CODING_AGENT_DIR` — not a Francois-owned config
//! dir Francois creates, populates and later deletes like every other kind
//! (see `AccountKind::Pi`'s doc in mod.rs). Registering IS pointing at a
//! directory (FR-1); trusting it to execute is a distinct, explicit step
//! (FR-4) because that directory's provider configuration can contain
//! executable credential helpers Francois must not run without consent.
//!
//! Structurally unlike codex.rs/grok.rs in the one way that matters: those
//! kinds own an APP-CREATED directory a vendor CLI later fills in, so
//! `account_remove` deletes it (credentials included). A Pi account's
//! directory is the user's own — `account_remove` never deletes it (FR-8),
//! and `sanitize_config_dirs` (registry.rs) never rewrites it to an
//! app-owned path.
//!
//! FR-3's "reuse the login PTY infrastructure" means the raw PTY
//! spawn/passthrough machinery (`LoginHandle`, `write_login`/`resize_login`/
//! `cancel_login` in login.rs) — NOT the Claude-specific identity poll/
//! registration in `settle_success`. Pi setup PTYs live in their own
//! `AccountInner.pi_setups` map (mod.rs) rather than the single Claude
//! `login` slot, because `piSetup`'s contract error list carries no "a login
//! is already in progress" code — an unrelated Claude login and a Pi setup
//! must not collide.
//!
//! This module owns the shared data model — the fingerprint/trust primitives
//! every other concern in this domain reads (`compute_fingerprint`,
//! `effective_trust`, `reconcile_trust_drift`, `find_pi_record`,
//! `apply_trust_pi`, the in-use gates and `pi_execution_preflight`).
//! CLAUDE.md's ~1000-line file cap split every other concern out into its own
//! child: FR-1 (registering a row) into `add`, FR-3 (the setup PTY) into
//! `setup`, FR-5 (spawn-environment isolation) into `env`, and FR-7/9 (the
//! provider/model refresh probe) into `refresh` — the same "one concern per
//! child" shape the rest of the crate follows.

mod add;
mod env;
mod refresh;
mod setup;

pub(crate) use add::*;
pub(crate) use env::*;
pub(crate) use refresh::*;
pub(crate) use setup::*;

// `account::mod.rs` re-exports these three genuinely `pub` (an external-crate
// wire type, core-architecture-wave3 FR-2 — see its own comment on the same
// re-export) — a glob (`pub(crate) use refresh::*` above) caps what it
// re-exports at `pub(crate)`, so that outer `pub use` needs its own explicit,
// fully-`pub` path through this module too, not just through `refresh`
// itself.
pub use refresh::{PiAuthState, PiInstallProbe, PiProviderAuthObservation};

use super::*;
use crate::ipc::{AppError, ErrorCode};

use std::path::Path;

// ---------------------------------------------------------------- FR-4: the
// executable-configuration fingerprint.

/// pi-provider-auth §6/FR-4: the top-level files inside a Pi `configDir` that
/// can carry EXECUTABLE configuration — a custom/local provider naming a
/// command Pi runs to resolve a credential (`specs/research/
/// pi-integration-audit.md`'s "Models"/"Provider authentication" rows).
/// `auth.json` is deliberately EXCLUDED: Pi's own OAuth refresh rewrites it on
/// an ordinary token refresh, and FR-4 requires that a refresh ALONE never
/// invalidates consent.
///
/// The audit ran no live Pi install/capture, so these exact filenames are not
/// independently confirmed — see the feature handoff for this limit and what
/// would replace it (a captured fixture naming the certified release's real
/// executable-config surface, recorded in the Pi adapter's manifest per §6).
const CONFIG_FINGERPRINT_FILES: &[&str] = &["config.json", "models.json", "providers.json"];

/// §6, verbatim: "If they cannot be enumerated reliably, configuration
/// remains untrusted for MVP." `CONFIG_FINGERPRINT_FILES` above is
/// self-admittedly a guess (no live Pi install/capture backs it) — so this
/// build may never actually GRANT trust, no matter what the caller asks for.
/// `apply_add_pi`/`apply_trust_pi` gate every trust-setting write behind this
/// flag rather than behind `trust_configuration` alone, so a guessed file
/// list can never be mistaken for a confirmed one. Flip to `true` in the SAME
/// commit that replaces `CONFIG_FINGERPRINT_FILES` with a fixture captured
/// from a certified Pi release and recorded in its manifest (§6) — the
/// trust-granting mechanics themselves need no further change; they are
/// already exercised with this flag forced `true` in `pi.rs`'s own tests.
const FINGERPRINT_INPUTS_VERIFIED: bool = false;

/// A deterministic fingerprint of `CONFIG_FINGERPRINT_FILES`' (existence,
/// size, mtime) inside `config_dir`. Two directories with the same content
/// hash the same; a changed/added/removed candidate file changes the hash.
/// Never reads file CONTENTS (only metadata) — cheap enough to run on every
/// trust-gated call, and it never needs to open a file it has not been
/// consented to touch.
pub(crate) fn compute_fingerprint(config_dir: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    for name in CONFIG_FINGERPRINT_FILES {
        let path = Path::new(config_dir).join(name);
        match std::fs::metadata(&path) {
            Ok(meta) => {
                name.hash(&mut hasher);
                true.hash(&mut hasher);
                meta.len().hash(&mut hasher);
                if let Ok(modified) = meta.modified() {
                    if let Ok(dur) = modified.duration_since(std::time::UNIX_EPOCH) {
                        dur.as_secs().hash(&mut hasher);
                    }
                }
            }
            Err(_) => {
                name.hash(&mut hasher);
                false.hash(&mut hasher);
            }
        }
    }
    format!("{:016x}", hasher.finish())
}

/// FR-4: is this record CURRENTLY trusted — `trusted` alone is not enough,
/// the fingerprint recorded at the last explicit trust must still match.
pub(crate) fn effective_trust(record: &PiRecord, config_dir: &str) -> bool {
    record.trusted
        && record
            .fingerprint
            .as_deref()
            .is_some_and(|fp| fp == compute_fingerprint(config_dir))
}

/// FR-4: a trust that has DRIFTED — the row still SAYS trusted, but the
/// current fingerprint no longer matches what was confirmed. Detected lazily
/// (piSetup/piRefresh preflight) and flipped to untrusted the moment it is:
/// "changed executable configuration requires reconfirmation" is a standing
/// invariant, not a one-time check at add time. Returns `true` iff drift was
/// found (and reconciled) — the caller persists when it is.
pub(crate) fn reconcile_trust_drift(inner: &mut AccountInner, id: &str) -> bool {
    let Some(record) = inner.records.iter_mut().find(|r| r.id == id) else {
        return false;
    };
    let config_dir = record.config_dir.clone();
    let Some(pi) = record.pi.as_mut() else {
        return false;
    };
    if !pi.trusted {
        return false;
    }
    if effective_trust(pi, &config_dir) {
        false
    } else {
        pi.trusted = false;
        pi.fingerprint = None;
        true
    }
}

// ---------------------------------------------------------------- FR-4: trust

pub(crate) fn find_pi_record<'a>(
    inner: &'a AccountInner,
    id: &str,
) -> Result<&'a AccountRecord, AppError> {
    inner
        .records
        .iter()
        .find(|r| r.id == id)
        .filter(|r| r.kind == AccountKind::Pi)
        .ok_or_else(|| AppError::new(ErrorCode::AccountNotFound, NOT_FOUND_MSG))
}

/// FR-4: (re)compute the fingerprint and record `trustConfiguration`. Revoking
/// trust (`false`) clears the stored fingerprint too — an untrusted row has no
/// meaningful baseline to drift from. Granting trust (`true`) is refused with
/// `ACCOUNT_CONFIG_UNTRUSTED` while `FINGERPRINT_INPUTS_VERIFIED` is `false`
/// (§6) — see that const's doc comment; revoking stays available either way.
pub(crate) fn apply_trust_pi(
    inner: &mut AccountInner,
    id: &str,
    trust_configuration: bool,
) -> Result<(), AppError> {
    apply_trust_pi_with(inner, id, trust_configuration, FINGERPRINT_INPUTS_VERIFIED)
}

/// The pure decision `apply_trust_pi` delegates to — see its doc comment on
/// why `verified` is a parameter rather than reading the const directly.
fn apply_trust_pi_with(
    inner: &mut AccountInner,
    id: &str,
    trust_configuration: bool,
    verified: bool,
) -> Result<(), AppError> {
    let config_dir = find_pi_record(inner, id)?.config_dir.clone();
    if trust_configuration && !verified {
        return Err(AppError::new(
            ErrorCode::AccountConfigUntrusted,
            "Pi configuration trust cannot be granted yet — the fingerprint inputs are unverified for this build",
        ));
    }
    let record = inner
        .records
        .iter_mut()
        .find(|r| r.id == id)
        .expect("found above");
    let pi = record
        .pi
        .as_mut()
        .expect("kind==Pi invariant (find_pi_record filtered on it)");
    if trust_configuration {
        pi.trusted = true;
        pi.fingerprint = Some(compute_fingerprint(&config_dir));
    } else {
        pi.trusted = false;
        pi.fingerprint = None;
    }
    Ok(())
}

/// FR-4/FR-6/FR-8: is any session currently pinned to this account?
///
/// **LOCK ORDER — never call this while holding the account lock.**
/// `session::Session::meta()` calls `AccountKinds::kind_of`, which locks
/// `AccountState`, from INSIDE an `Engine.sessions`-locked closure
/// (`with_session`/`with_session_mut`) — so the established order everywhere
/// else in this crate is `Engine.sessions` → `AccountState`. This function
/// (via `sessions_pinned_to`) locks `Engine.sessions`; calling it with
/// `AccountState` already held would take the two locks in the OPPOSITE
/// order and risk a real deadlock. Call it BEFORE (or after) the account
/// lock's critical section, never nested inside it — see `account_trust_pi`
/// and `account_remove` for the two-phase shape this requires.
pub(crate) fn sessions_currently_use(app: &AppHandle, id: &str) -> bool {
    !super::sessions_pinned_to(app, id).is_empty()
}

/// FR-4: is a Pi setup PTY currently open for this account? Pure over
/// `AccountInner` (no cross-domain lock), so — unlike
/// `sessions_currently_use` — this IS safe to call while the account lock is
/// held.
pub(crate) fn setup_pty_open_for(inner: &AccountInner, id: &str) -> bool {
    inner.pi_setups.values().any(|h| h.account_id == id)
}

/// FR-4/FR-6: `account_trust_pi`'s in-lock gate — the account must exist and
/// have no open setup PTY. `sessions_currently_use` (the cross-domain,
/// `Engine.sessions`-locking half of the same gate) is deliberately NOT
/// folded in here: it must run with the account lock released (see that
/// function's LOCK ORDER doc), so the caller checks it separately, before
/// this one, and again just after this one persists (`account_trust_pi`'s
/// own doc covers the residual TOCTOU window between the two checks and why
/// it cannot be closed by nesting the checks instead).
pub(crate) fn trust_pi_gate(inner: &AccountInner, id: &str) -> Result<(), AppError> {
    find_pi_record(inner, id)?;
    if setup_pty_open_for(inner, id) {
        return Err(AppError::new(
            ErrorCode::AccountInUse,
            "close this account's open setup before changing its trust",
        ));
    }
    Ok(())
}

/// FR-3/FR-7/FR-9: the shared "is this account trusted enough to execute
/// right now" decision `piSetup`/`piRefresh` both run — the only difference
/// between the two call sites is which action the returned error names.
/// Drift reconciliation (and persisting it) stays the caller's job: it needs
/// `&mut AccountInner` plus the `AppHandle` to persist, and both commands
/// already do it identically right before calling this — the caller passes
/// the outcome of THAT reconciliation in as `drifted`, so FR-4's two distinct
/// blocked states get two distinct codes: `ACCOUNT_CONFIG_CHANGED` when the
/// fingerprint just stopped matching a previously trusted one (this very
/// preflight is what flips `trusted` back to `false`, so by the time we get
/// here `effective_trust` alone can no longer tell the two apart), and
/// `ACCOUNT_CONFIG_UNTRUSTED` for a row that was never trusted at all.
pub(crate) fn pi_execution_preflight(
    inner: &AccountInner,
    id: &str,
    blocked_action: &str,
    drifted: bool,
) -> Result<(String, String, Option<String>, bool), AppError> {
    let record = find_pi_record(inner, id)?;
    let cfg = record
        .pi
        .as_ref()
        .expect("kind==Pi invariant (find_pi_record filtered on it)");
    if !effective_trust(cfg, &record.config_dir) {
        return Err(if drifted {
            AppError::new(
                ErrorCode::AccountConfigChanged,
                format!(
                    "this Pi configuration changed since it was trusted — trust it again before {blocked_action}"
                ),
            )
        } else {
            AppError::new(
                ErrorCode::AccountConfigUntrusted,
                format!("trust this Pi configuration before {blocked_action}"),
            )
        });
    }
    Ok((
        record.config_dir.clone(),
        cfg.runtime.clone(),
        cfg.distro.clone(),
        cfg.inherit_environment_credentials,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::account::testutil::*;
    use std::sync::atomic::AtomicBool;
    use std::sync::Arc;

    // ---------- fingerprint (FR-4) ----------

    #[test]
    fn an_empty_directory_fingerprints_deterministically() {
        let dir = tmp_account_dir("pi-fp-empty");
        let a = compute_fingerprint(&dir.to_string_lossy());
        let b = compute_fingerprint(&dir.to_string_lossy());
        assert_eq!(a, b);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn adding_a_candidate_config_file_changes_the_fingerprint() {
        let dir = tmp_account_dir("pi-fp-add");
        let before = compute_fingerprint(&dir.to_string_lossy());
        std::fs::write(dir.join("models.json"), "{}").unwrap();
        let after = compute_fingerprint(&dir.to_string_lossy());
        assert_ne!(before, after);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_token_refresh_in_auth_json_never_changes_the_fingerprint() {
        // FR-4: "token refresh alone does not invalidate consent" — auth.json
        // is deliberately excluded from the fingerprint inputs.
        let dir = tmp_account_dir("pi-fp-auth-refresh");
        std::fs::write(dir.join("auth.json"), r#"{"token":"a"}"#).unwrap();
        let before = compute_fingerprint(&dir.to_string_lossy());
        std::fs::write(dir.join("auth.json"), r#"{"token":"b-refreshed"}"#).unwrap();
        let after = compute_fingerprint(&dir.to_string_lossy());
        assert_eq!(before, after);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn two_directories_with_the_same_configuration_fingerprint_identically() {
        let a = tmp_account_dir("pi-fp-cross-a");
        let b = tmp_account_dir("pi-fp-cross-b");
        std::fs::write(a.join("config.json"), "same").unwrap();
        std::fs::write(b.join("config.json"), "same").unwrap();
        // Two distinct directories with byte-identical candidate files hash
        // the same — the fingerprint proves "this configuration", not "this
        // path"; cross-account isolation is `configDir` itself (FR-1/9), not
        // this value.
        assert_eq!(
            compute_fingerprint(&a.to_string_lossy()),
            compute_fingerprint(&b.to_string_lossy())
        );
        std::fs::remove_dir_all(&a).ok();
        std::fs::remove_dir_all(&b).ok();
    }

    #[test]
    fn effective_trust_requires_both_the_flag_and_a_matching_fingerprint() {
        let dir = tmp_account_dir("pi-effective-trust");
        let fp = compute_fingerprint(&dir.to_string_lossy());
        let trusted = PiRecord {
            runtime: "native".into(),
            distro: None,
            inherit_environment_credentials: false,
            trusted: true,
            fingerprint: Some(fp),
        };
        assert!(effective_trust(&trusted, &dir.to_string_lossy()));

        let mut drifted = trusted.clone();
        std::fs::write(dir.join("config.json"), "changed").unwrap();
        assert!(!effective_trust(&drifted, &dir.to_string_lossy()));

        drifted.trusted = false;
        assert!(!effective_trust(&drifted, &dir.to_string_lossy()));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn drift_is_reconciled_lazily_and_only_when_it_actually_drifted() {
        let mut inner = inner_fixture(&[], "default");
        inner.records.push(pi_record_fixture("p1", "Pi", true));
        // No drift yet — the fixture's fingerprint matches its own directory.
        assert!(!reconcile_trust_drift(&mut inner, "p1"));
        assert!(inner.records[0].pi.as_ref().unwrap().trusted);

        let dir = inner.records[0].config_dir.clone();
        std::fs::write(Path::new(&dir).join("providers.json"), "changed").unwrap();
        assert!(reconcile_trust_drift(&mut inner, "p1"));
        let pi = inner.records[0].pi.as_ref().unwrap();
        assert!(!pi.trusted, "FR-4: drift requires reconfirmation");
        assert!(pi.fingerprint.is_none());
        // Idempotent: an already-untrusted row reports no further drift.
        assert!(!reconcile_trust_drift(&mut inner, "p1"));
        std::fs::remove_dir_all(&dir).ok();
    }

    // ---------- FR-4: trust ----------

    #[test]
    fn trusting_a_pi_account_stamps_a_fingerprint_once_verified_and_revoking_clears_it() {
        let mut inner = inner_fixture(&[], "default");
        inner.records.push(pi_record_fixture("p1", "Pi", false));
        apply_trust_pi_with(&mut inner, "p1", true, true).unwrap();
        let pi = inner.records[0].pi.as_ref().unwrap();
        assert!(pi.trusted);
        assert!(pi.fingerprint.is_some());

        // Revoking is available through the PRODUCTION entry point regardless
        // of the verified flag — only granting is gated.
        apply_trust_pi(&mut inner, "p1", false).unwrap();
        let pi = inner.records[0].pi.as_ref().unwrap();
        assert!(!pi.trusted);
        assert!(pi.fingerprint.is_none());
    }

    #[test]
    fn granting_trust_through_the_production_entry_point_is_refused_while_unverified() {
        // §6/CRITICAL: no caller of the real `apply_trust_pi` can grant trust
        // off today's unverified `CONFIG_FINGERPRINT_FILES` guess. Pins
        // today's `FINGERPRINT_INPUTS_VERIFIED=false` posture the same way
        // the `apply_add_pi` sibling test above does.
        let mut inner = inner_fixture(&[], "default");
        inner.records.push(pi_record_fixture("p1", "Pi", false));
        let err = apply_trust_pi(&mut inner, "p1", true).unwrap_err();
        assert_eq!(err.code, ErrorCode::AccountConfigUntrusted);
        // Refused, not silently downgraded — the row is untouched.
        let pi = inner.records[0].pi.as_ref().unwrap();
        assert!(!pi.trusted);
        assert!(pi.fingerprint.is_none());
    }

    #[test]
    fn trusting_an_unknown_or_non_pi_account_is_account_not_found() {
        let mut inner = inner_fixture(&["a1"], "default"); // a1 is Claude, not Pi
        assert_eq!(
            apply_trust_pi(&mut inner, "a1", true).unwrap_err().code,
            ErrorCode::AccountNotFound
        );
        assert_eq!(
            apply_trust_pi(&mut inner, "nope", true).unwrap_err().code,
            ErrorCode::AccountNotFound
        );
    }

    // ---------- FR-6/FR-8: in-use gate ----------

    // Minimal fakes for the portable_pty types a live `LoginHandle` fixture
    // needs below — never spawned, never read.
    fn fake_master() -> Box<dyn portable_pty::MasterPty + Send> {
        portable_pty::native_pty_system()
            .openpty(portable_pty::PtySize {
                rows: 1,
                cols: 1,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap()
            .master
    }
    fn fake_killer() -> Box<dyn portable_pty::ChildKiller + Send + Sync> {
        #[derive(Debug)]
        struct NoopKiller;
        impl portable_pty::ChildKiller for NoopKiller {
            fn kill(&mut self) -> std::io::Result<()> {
                Ok(())
            }
            fn clone_killer(&self) -> Box<dyn portable_pty::ChildKiller + Send + Sync> {
                Box::new(NoopKiller)
            }
        }
        Box::new(NoopKiller)
    }

    #[test]
    fn an_open_pi_setup_pty_for_the_account_marks_it_in_use() {
        let mut inner = inner_fixture(&[], "default");
        inner.records.push(pi_record_fixture("p1", "Pi", true));
        assert!(!setup_pty_open_for(&inner, "p1"));
        inner.pi_setups.insert(
            "login-1".into(),
            LoginHandle {
                login_id: "login-1".into(),
                account_id: "p1".into(),
                label: None,
                config_dir: "/pi/home".into(),
                existing: true,
                writer: Box::new(std::io::sink()),
                master: fake_master(),
                killer: fake_killer(),
                settled: Arc::new(AtomicBool::new(false)),
                kind: AccountKind::Pi,
            },
        );
        assert!(setup_pty_open_for(&inner, "p1"));
        assert!(!setup_pty_open_for(&inner, "other"));
    }

    // ---------- MEDIUM (round 1): the shared in-lock command gates ----------

    #[test]
    fn trust_pi_gate_refuses_an_unknown_account_and_one_with_an_open_setup_pty() {
        let mut inner = inner_fixture(&["a1"], "default"); // a1 is Claude, not Pi
        assert_eq!(
            trust_pi_gate(&inner, "nope").unwrap_err().code,
            ErrorCode::AccountNotFound
        );
        assert_eq!(
            trust_pi_gate(&inner, "a1").unwrap_err().code,
            ErrorCode::AccountNotFound
        );

        inner.records.push(pi_record_fixture("p1", "Pi", true));
        assert!(trust_pi_gate(&inner, "p1").is_ok());

        inner.pi_setups.insert(
            "login-1".into(),
            LoginHandle {
                login_id: "login-1".into(),
                account_id: "p1".into(),
                label: None,
                config_dir: "/pi/home".into(),
                existing: true,
                writer: Box::new(std::io::sink()),
                master: fake_master(),
                killer: fake_killer(),
                settled: Arc::new(AtomicBool::new(false)),
                kind: AccountKind::Pi,
            },
        );
        assert_eq!(
            trust_pi_gate(&inner, "p1").unwrap_err().code,
            ErrorCode::AccountInUse
        );
    }

    #[test]
    fn execution_preflight_refuses_an_untrusted_account_and_names_the_blocked_action() {
        let mut inner = inner_fixture(&[], "default");
        inner.records.push(pi_record_fixture("p1", "Pi", false));
        let err = pi_execution_preflight(&inner, "p1", "refreshing it", false).unwrap_err();
        assert_eq!(err.code, ErrorCode::AccountConfigUntrusted);
        assert!(err.message.contains("refreshing it"));
    }

    #[test]
    fn execution_preflight_reports_config_changed_when_the_caller_just_reconciled_drift() {
        // FR-4: distinct code for "was trusted, drifted" vs. "never trusted" —
        // by the time we're here `reconcile_trust_drift` already flipped
        // `trusted` back to false, so the caller's own drift outcome is what
        // distinguishes the two, not anything left on the record.
        let mut inner = inner_fixture(&[], "default");
        inner.records.push(pi_record_fixture("p1", "Pi", false));
        let err = pi_execution_preflight(&inner, "p1", "running setup", true).unwrap_err();
        assert_eq!(err.code, ErrorCode::AccountConfigChanged);
        assert!(err.message.contains("running setup"));
    }

    #[test]
    fn execution_preflight_refuses_an_unknown_or_non_pi_account() {
        let inner = inner_fixture(&["a1"], "default");
        assert_eq!(
            pi_execution_preflight(&inner, "a1", "running setup", false)
                .unwrap_err()
                .code,
            ErrorCode::AccountNotFound
        );
        assert_eq!(
            pi_execution_preflight(&inner, "nope", "running setup", false)
                .unwrap_err()
                .code,
            ErrorCode::AccountNotFound
        );
    }

    #[test]
    fn execution_preflight_returns_the_pinned_fields_for_a_trusted_account() {
        let mut inner = inner_fixture(&[], "default");
        inner.records.push(pi_record_fixture("p1", "Pi", true));
        inner.records[0].pi.as_mut().unwrap().distro = Some("Ubuntu".into());
        inner.records[0]
            .pi
            .as_mut()
            .unwrap()
            .inherit_environment_credentials = true;
        let expected_dir = inner.records[0].config_dir.clone();
        let (config_dir, runtime, distro, inherit) =
            pi_execution_preflight(&inner, "p1", "running setup", false).unwrap();
        assert_eq!(config_dir, expected_dir);
        assert_eq!(runtime, "native");
        assert_eq!(distro.as_deref(), Some("Ubuntu"));
        assert!(inherit);
    }
}
