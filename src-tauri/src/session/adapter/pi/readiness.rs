//! session/adapter/pi/readiness.rs — pi-migration-rollout FR-8: the
//! single-source production-readiness decision for Pi session creation.
//!
//! Before this module, nothing in `session_create` refused a Pi account up
//! front: the account-trust and installation checks it eventually reaches
//! (`crate::account::pi_execution_preflight_for`, buried inside
//! `adapter::pi::models::resolve_and_validate_pair`) exist for a DIFFERENT
//! reason (resolving a model pair) and answer a misleading question — "trust
//! this Pi configuration before listing available models" reads as
//! something the user could fix, when in this build trust can never
//! actually be granted (`account::pi::FINGERPRINT_INPUTS_VERIFIED` is a
//! permanent `false` — see that const's own doc) and the installation check
//! never certifies a real digest either (see `discovery.rs`'s module doc:
//! a version match reports `Provenance::Unverified`, never `Certified`).
//! `evaluate` below turns that emergent, accidental closure into an
//! explicit, tested, single-source decision with an honest reason, called
//! ONCE from `session_create`'s Pi branch before any of that machinery runs.
//!
//! **Reduction of FR-8's ten acceptance checks + OS/environment
//! certification** to two locally-observable facts: this build cannot
//! produce a real protocol capture or a real OS certification pass no
//! matter what is installed on the machine that happens to run it, so
//! "production availability" reduces here to the checked-in facts that
//! WOULD reflect it once it exists — `ProfileRegistry.writable` (FR-6) and
//! `RuntimeInstallStatus.provenance == Certified` (never constructed by any
//! code path in this build today). The third input the task frames this
//! gate around — account trust — is folded in by calling
//! `pi_execution_preflight_for` FIRST (`check`, below): reusing the existing
//! authoritative trust decision rather than re-deriving it keeps this a
//! single source of truth instead of a second, possibly-diverging one.
//!
//! **Leaving this closed is deliberate, not a gap to fill.** Real certified
//! Pi + OS platform certification cannot happen inside this build — general
//! availability is a human decision, made by replacing
//! `discovery::evaluate_version`'s digest-less match with a verified one
//! (which is what would ever let `Provenance::Certified` exist at all).
//! Until then this function refuses every Pi session creation, and that is
//! the intended behaviour, not a bug to work around.

use crate::ipc::{AppError, ErrorCode};
use crate::session::adapter::pi::discovery::{InstallState, Provenance, RuntimeInstallStatus};
use tauri::{AppHandle, Manager};

/// Which of the two observable facts this build could not confirm — kept as
/// data (not a formatted string alone) so a test asserts on the CAUSE, not
/// merely that some message happened to match.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PiReadinessGap {
    MigrationUnwritable,
    NotCertified,
}

impl PiReadinessGap {
    pub(crate) fn message(self) -> &'static str {
        match self {
            PiReadinessGap::MigrationUnwritable => {
                "the profile registry could not be migrated, so Pi session creation is disabled until it is resolved"
            }
            PiReadinessGap::NotCertified => {
                "Pi session creation is not yet available in this build — production readiness (a certified installation and platform certification) has not been completed"
            }
        }
    }
}

/// FR-6/FR-8: the pure decision — a failed registry migration blocks Pi
/// creation outright (checked first: it is this session's OWN unrelated
/// precondition, not a property of Pi at all), and otherwise the installed
/// Pi must be BOTH `Ready` and carry `Provenance::Certified`. `Ready` alone
/// is not enough: `discovery::evaluate_version` reports `Ready` for any
/// exact package-version match, which an ordinary user could satisfy simply
/// by installing the pinned npm package — `Certified` is the fact that
/// stays unreachable until a real artifact digest is captured and verified
/// (see this module's own doc).
pub(crate) fn evaluate(
    migration_writable: bool,
    install: &RuntimeInstallStatus,
) -> Result<(), PiReadinessGap> {
    if !migration_writable {
        return Err(PiReadinessGap::MigrationUnwritable);
    }
    if install.state != InstallState::Ready || install.provenance != Provenance::Certified {
        return Err(PiReadinessGap::NotCertified);
    }
    Ok(())
}

fn gap_to_app_error(gap: PiReadinessGap) -> AppError {
    AppError::new(ErrorCode::RuntimeUnavailable, gap.message())
}

/// The `AppHandle`-touching glue `session_create` calls: account trust (via
/// the existing, authoritative `pi_execution_preflight_for` — its own
/// `ACCOUNT_CONFIG_UNTRUSTED`/`ACCOUNT_CONFIG_CHANGED` errors propagate
/// verbatim, never downgraded to this gate's generic reason), then the two
/// facts `evaluate` decides over.
pub(crate) fn check(app: &AppHandle, account_id: &str) -> Result<(), AppError> {
    let (_config_dir, runtime, distro, _inherit) =
        crate::account::pi_execution_preflight_for(app, account_id, "creating a session")?;
    let migration_writable = app
        .try_state::<crate::profiles::ProfileRegistry>()
        .map(|s| crate::profiles::is_writable(&s))
        .unwrap_or(false);
    let install = super::discovery::probe_installation(&runtime, distro.as_deref(), false)?;
    evaluate(migration_writable, &install).map_err(gap_to_app_error)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn install(state: InstallState, provenance: Provenance) -> RuntimeInstallStatus {
        RuntimeInstallStatus {
            state,
            executable_path: Some("/bin/pi".into()),
            detected_version: Some("0.85.1".into()),
            node_version: None,
            supported_versions: Vec::new(),
            provenance,
            checked_at: 0,
            install_command: String::new(),
            error: None,
        }
    }

    #[test]
    fn an_unwritable_migration_blocks_regardless_of_installation() {
        let gap = evaluate(false, &install(InstallState::Ready, Provenance::Certified))
            .expect_err("must refuse");
        assert_eq!(gap, PiReadinessGap::MigrationUnwritable);
    }

    #[test]
    fn a_ready_but_unverified_install_is_not_enough() {
        // The exact reachable state today: `evaluate_version` can only ever
        // report `Unverified` for a matching package version.
        let gap = evaluate(true, &install(InstallState::Ready, Provenance::Unverified))
            .expect_err("unverified provenance never satisfies FR-8");
        assert_eq!(gap, PiReadinessGap::NotCertified);
    }

    #[test]
    fn a_missing_or_incompatible_install_is_not_certified_either() {
        assert_eq!(
            evaluate(true, &install(InstallState::Missing, Provenance::Unknown)).unwrap_err(),
            PiReadinessGap::NotCertified
        );
        assert_eq!(
            evaluate(
                true,
                &install(InstallState::Incompatible, Provenance::Unknown)
            )
            .unwrap_err(),
            PiReadinessGap::NotCertified
        );
    }

    #[test]
    fn a_certified_ready_install_with_a_writable_migration_passes() {
        assert!(evaluate(true, &install(InstallState::Ready, Provenance::Certified)).is_ok());
    }

    #[test]
    fn each_gap_carries_a_distinct_plain_english_reason() {
        assert_ne!(
            PiReadinessGap::MigrationUnwritable.message(),
            PiReadinessGap::NotCertified.message()
        );
        let err = gap_to_app_error(PiReadinessGap::NotCertified);
        assert_eq!(err.code, ErrorCode::RuntimeUnavailable);
        assert!(err.message.contains("not yet available"));
    }
}
