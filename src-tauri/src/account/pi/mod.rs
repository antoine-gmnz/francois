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
//! This module owns the shared data model — the TRUST primitives every other
//! concern in this domain reads (`effective_trust`, `reconcile_trust_drift`,
//! `find_pi_record`, `apply_trust_pi`, the in-use gates and
//! `pi_execution_preflight`). CLAUDE.md's ~1000-line file cap split every
//! other concern out into its own child: FR-1 (registering a row) into `add`,
//! FR-3 (the setup PTY) into `setup`, FR-5 (spawn-environment isolation) into
//! `env`, FR-7/9 (the provider/model refresh probe) into `refresh`, FR-6/8's
//! removal gate and undo into `remove`, and FR-4's fingerprint itself — what
//! `effective_trust` compares — into `fingerprint`, the same "one concern per
//! child" shape the rest of the crate follows.

mod add;
mod env;
mod fingerprint;
mod refresh;
mod remove;
mod setup;

pub(crate) use add::*;
pub(crate) use env::*;
pub(crate) use fingerprint::*;
pub(crate) use remove::*;
// `pub`, unlike its siblings: `refresh` declares three items genuinely `pub`
// (`PiAuthState`, `PiInstallProbe`, `PiProviderAuthObservation` — wire and
// managed-state types `main.rs`, an external crate relative to this lib, must
// be able to name; core-architecture-wave3 FR-2). A glob re-exports each item
// at the LESSER of its own visibility and the `use`'s, so a `pub(crate)` glob
// would cap those three, while this one leaves every item at exactly what
// `refresh` declared — its `pub(crate)` items stay `pub(crate)`. Do not pair a
// `pub(crate)` glob with an explicit `pub use` of the same names instead: that
// imports each name at two visibilities (rustc: `ambiguous_import_visibilities`).
pub use refresh::*;
pub(crate) use setup::*;

use super::*;
use crate::ipc::{AppError, ErrorCode};

// ---------------------------------------------------------------- FR-4: trust
// over the executable-configuration fingerprint (`fingerprint.rs`).

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

/// PR #142 §5: the spelling of a Pi row's `configDir` a WINDOWS-side reader
/// must open — the one every `compute_fingerprint` call site goes through, so
/// a fingerprint taken at add/trust time and one taken at check time can never
/// read two different spellings of the same directory.
///
/// A `wsl` row stores the path the DISTRO uses (`/home/u/.pi`, FR-1): nothing
/// on this side can open that, and `std::fs` on the raw string answers
/// "gone" — which `effective_trust` would read as drift, on every check,
/// forever. `\\wsl.localhost\<distro>\…` is the spelling that opens it, and
/// `wsl::linux_to_wsl_unc` is what builds it (it asks the distro for its own
/// FR-3 root rather than assuming a prefix).
///
/// `None` means "there is nothing readable here" — never a guess: a `wsl` row
/// with no distro, or a distro whose UNC root could not be discovered. Every
/// caller treats that exactly like an unfingerprintable directory, which is
/// FR-4's safe direction (untrusted), not a silent pass.
pub(crate) fn readable_config_dir(
    config_dir: &str,
    runtime: &str,
    distro: Option<&str>,
) -> Option<String> {
    readable_config_dir_with(config_dir, runtime, distro, |distro, path| {
        crate::wsl::linux_to_wsl_unc(Some(distro), path)
    })
}

/// The pure decision behind it, with the distro translation INJECTED — the
/// same split `process_util::login_shell_path_with` uses for its deadline:
/// `linux_to_wsl_unc` spawns `wsl.exe` (once per distro, cached), so the
/// choice of spelling is testable without one.
fn readable_config_dir_with(
    config_dir: &str,
    runtime: &str,
    distro: Option<&str>,
    translate: impl Fn(&str, &str) -> Option<String>,
) -> Option<String> {
    if runtime != "wsl" {
        // Byte-identical to the pre-fix behaviour on every OS.
        return Some(config_dir.to_string());
    }
    // Already a Windows spelling of an in-distro path — a row registered
    // through the folder picker before `canonicalize_config_dir_for`
    // normalized the stored value to the Linux one.
    if crate::wsl::is_wsl_unc_path(config_dir) {
        return Some(config_dir.to_string());
    }
    let distro = distro.map(str::trim).filter(|d| !d.is_empty())?;
    translate(distro, config_dir)
}

/// FR-4: is this record CURRENTLY trusted — `trusted` alone is not enough,
/// the fingerprint recorded at the last explicit trust must still match. A
/// configuration that cannot be fingerprinted AT ALL (`None` — a gone
/// directory, a symlinked or oversized input; see `compute_fingerprint`) is
/// never trusted: an unprovable configuration reads exactly like a changed
/// one, which is the FR-4-safe direction. An in-distro directory this side
/// cannot even name (`readable_config_dir` → `None`) is the same answer.
pub(crate) fn effective_trust(record: &PiRecord, config_dir: &str) -> bool {
    let current = readable_config_dir(config_dir, &record.runtime, record.distro.as_deref())
        .and_then(|path| compute_fingerprint(&path).into_baseline());
    record.trusted
        && match (record.fingerprint.as_deref(), current) {
            (Some(recorded), Some(current)) => recorded == current,
            _ => false,
        }
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
    let record = find_pi_record(inner, id)?;
    let config_dir = record.config_dir.clone();
    // PR #142 §5: the SAME spelling `effective_trust` will read back — a
    // baseline taken through one and compared through another is a row that
    // reads as drifted the moment it is checked.
    let cfg = record
        .pi
        .as_ref()
        .expect("kind==Pi invariant (find_pi_record filtered on it)");
    let readable = readable_config_dir(&config_dir, &cfg.runtime, cfg.distro.as_deref());
    if trust_configuration && !verified {
        return Err(AppError::new(
            ErrorCode::AccountConfigUntrusted,
            "Pi configuration trust cannot be granted yet — the fingerprint inputs are unverified for this build",
        ));
    }
    // FR-4: trust is only ever granted over a fingerprint that could actually
    // be computed — a configuration we cannot prove is unchanged later must
    // not be recorded as trusted now (§6's "remains untrusted" stance).
    let fingerprint = if trust_configuration {
        match readable
            .and_then(|path| compute_fingerprint(&path).into_baseline())
        {
            Some(fp) => Some(fp),
            None => {
                return Err(AppError::new(
                    ErrorCode::AccountConfigUntrusted,
                    "this Pi configuration cannot be fingerprinted — check that the directory exists and that its configuration files are regular files under 1 MiB",
                ))
            }
        }
    } else {
        None
    };
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
        pi.fingerprint = fingerprint;
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
    use std::path::Path;

    // ---------- PR #142 §5: which spelling the fingerprint reads ----------
    //
    // `readable_config_dir` itself ends in a live `wsl.exe` probe
    // (`linux_to_wsl_unc`), so only the DECISION is tested — the translation
    // is injected. The `std::fs` read behind it stays untested: it needs a
    // real distro.

    /// A translation that answers like a discovered distro root would, and
    /// records nothing else — anything reaching it is the in-distro branch.
    fn fake_translate(distro: &str, path: &str) -> Option<String> {
        Some(format!(
            "\\\\wsl.localhost\\{distro}{}",
            path.replace('/', "\\")
        ))
    }

    #[test]
    fn a_native_row_is_read_exactly_as_stored_on_every_platform() {
        // The unchanged half: no translation is even consulted.
        assert_eq!(
            readable_config_dir_with("/pi/home", "native", None, |_, _| panic!(
                "native must never translate"
            )),
            Some("/pi/home".to_string())
        );
        assert_eq!(
            readable_config_dir_with(r"D:\pi\home", "native", None, |_, _| panic!()),
            Some(r"D:\pi\home".to_string())
        );
    }

    #[test]
    fn a_wsl_row_is_read_through_its_distros_unc_root() {
        // FR-1 stores the path the DISTRO uses; `std::fs` on that string is
        // "gone" from here, which `effective_trust` would read as drift on
        // every single check.
        assert_eq!(
            readable_config_dir_with("/home/u/.pi", "wsl", Some("Ubuntu"), fake_translate),
            Some("\\\\wsl.localhost\\Ubuntu\\home\\u\\.pi".to_string())
        );
    }

    #[test]
    fn a_wsl_row_already_stored_as_a_unc_path_is_left_alone() {
        assert_eq!(
            readable_config_dir_with(
                "\\\\wsl.localhost\\Ubuntu\\home\\u\\.pi",
                "wsl",
                Some("Ubuntu"),
                |_, _| panic!("already a Windows spelling")
            ),
            Some("\\\\wsl.localhost\\Ubuntu\\home\\u\\.pi".to_string())
        );
    }

    #[test]
    fn a_wsl_row_with_no_distro_or_no_discoverable_root_refuses_rather_than_guessing() {
        // FR-4's safe direction: no readable directory ⇒ no baseline ⇒ never
        // trusted. Guessing a prefix would fingerprint some OTHER directory.
        assert_eq!(
            readable_config_dir_with("/home/u/.pi", "wsl", None, fake_translate),
            None
        );
        assert_eq!(
            readable_config_dir_with("/home/u/.pi", "wsl", Some("   "), fake_translate),
            None
        );
        assert_eq!(
            readable_config_dir_with("/home/u/.pi", "wsl", Some("Ubuntu"), |_, _| None),
            None
        );
    }

    #[test]
    fn a_wsl_row_this_side_cannot_name_is_never_trusted() {
        // The end-to-end consequence, through the production accessor: no
        // distro ⇒ no readable path ⇒ no current fingerprint ⇒ untrusted,
        // whatever the row claims. (A `wsl` row WITH a distro needs a live
        // distro to read, which is why only this half is asserted here.)
        let record = PiRecord {
            runtime: "wsl".into(),
            distro: None,
            inherit_environment_credentials: false,
            trusted: true,
            fingerprint: Some("v2:whatever".into()),
        };
        assert!(!effective_trust(&record, "/home/u/.pi"));
    }

    // ---------- trust over the fingerprint (FR-4) ----------
    //
    // The fingerprint VALUE's own behaviour (content hashing, the refusal
    // cases, the format version) is tested in `fingerprint.rs`; what follows
    // is what the trust model does with it.

    #[test]
    fn effective_trust_requires_both_the_flag_and_a_matching_fingerprint() {
        let dir = tmp_account_dir("pi-effective-trust");
        let fp = compute_fingerprint(&dir.to_string_lossy())
            .into_baseline()
            .unwrap();
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

        // An UNPROVABLE configuration (the directory is gone) reads exactly
        // like a changed one, never like a matching one.
        std::fs::remove_dir_all(&dir).unwrap();
        assert!(!effective_trust(&trusted, &dir.to_string_lossy()));
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
    fn granting_trust_over_a_configuration_that_cannot_be_fingerprinted_is_refused() {
        // FR-4/§6: a row must never be recorded as trusted with no baseline to
        // drift from — `trusted=true, fingerprint=None` would read as
        // untrusted forever while claiming the opposite on the wire.
        let mut inner = inner_fixture(&[], "default");
        inner.records.push(pi_record_fixture("p1", "Pi", false));
        let dir = inner.records[0].config_dir.clone();
        std::fs::remove_dir_all(&dir).unwrap();
        let err = apply_trust_pi_with(&mut inner, "p1", true, true).unwrap_err();
        assert_eq!(err.code, ErrorCode::AccountConfigUntrusted);
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

    #[test]
    fn an_open_pi_setup_pty_for_the_account_marks_it_in_use() {
        let mut inner = inner_fixture(&[], "default");
        inner.records.push(pi_record_fixture("p1", "Pi", true));
        assert!(!setup_pty_open_for(&inner, "p1"));
        inner
            .pi_setups
            .insert("login-1".into(), pi_setup_handle_fixture("p1"));
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

        inner
            .pi_setups
            .insert("login-1".into(), pi_setup_handle_fixture("p1"));
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
