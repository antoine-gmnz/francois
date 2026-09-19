//! pi-provider-auth FR-1: registering a Pi account — validating the label,
//! the runtime/distro pair and `configDir`, refusing a duplicate
//! (configDir, runtime, distro) triple, and appending the row. Split out of
//! `pi/mod.rs` purely for CLAUDE.md's ~1000-line file cap;
//! `pi_commands.rs`'s `account_add_pi` is this child's only caller.

use super::*;
use crate::ipc::{AppError, ErrorCode};

use std::path::Path;

const MAX_LABEL_LEN: usize = 60;

/// FR-1: a label trimmed to 1..60 chars (the contract's own bound — tighter
/// than every other kind's plain non-empty check).
pub(crate) fn validate_pi_label(raw: &str) -> Result<String, AppError> {
    let label =
        super::validate_label(raw).map_err(|msg| AppError::new(ErrorCode::InvalidInput, msg))?;
    if label.chars().count() > MAX_LABEL_LEN {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "an account label cannot exceed 60 characters",
        ));
    }
    Ok(label)
}

/// FR-1: `runtime` must be a known runtime, and `distro` is required iff it is
/// `wsl` — mirrors `session::valid_runtime`'s create-time rule (spawn.rs);
/// duplicated rather than shared because session/ already depends on
/// account/, and naming it here would close a module cycle. Returns the
/// normalized `distro` (`None` for native).
pub(crate) fn validate_pi_runtime(
    runtime: &str,
    distro: Option<&str>,
) -> Result<Option<String>, AppError> {
    if !matches!(runtime, "native" | "wsl") {
        return Err(AppError::new(ErrorCode::InvalidInput, "unknown runtime"));
    }
    if runtime == "wsl" {
        match distro.map(str::trim).filter(|d| !d.is_empty()) {
            Some(d) => Ok(Some(d.to_string())),
            None => Err(AppError::new(
                ErrorCode::InvalidInput,
                "distro is required for the wsl runtime",
            )),
        }
    } else if distro.is_some() {
        Err(AppError::new(
            ErrorCode::InvalidInput,
            "distro is only valid for the wsl runtime",
        ))
    } else {
        Ok(None)
    }
}

/// FR-1: `configDir` must be an absolute, existing directory — canonicalized
/// here so a `..`/symlink-relative variant of the same directory cannot dodge
/// the FR-1 duplicate check below.
pub(crate) fn canonicalize_config_dir(raw: &str) -> Result<String, AppError> {
    let path = Path::new(raw);
    if !path.is_absolute() {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "configDir must be an absolute path",
        ));
    }
    let canonical = std::fs::canonicalize(path)
        .map_err(|_| AppError::new(ErrorCode::InvalidInput, "configDir does not exist"))?;
    if !canonical.is_dir() {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "configDir is not a directory",
        ));
    }
    Ok(canonical.to_string_lossy().into_owned())
}

/// FR-1: "same directory/environment cannot be registered twice" — the
/// triple is (canonical configDir, runtime, distro), so the SAME directory
/// referenced once natively and once through WSL is two independently pinned
/// rows (FR-1/9), and so is the SAME directory under two different WSL
/// distros — `distro` is part of "environment" too, not just `runtime`.
/// Registering the identical triple again is refused.
pub(crate) fn duplicate_pi_directory(
    inner: &AccountInner,
    config_dir: &str,
    runtime: &str,
    distro: Option<&str>,
) -> bool {
    inner.records.iter().any(|r| {
        r.kind == AccountKind::Pi
            && r.config_dir == config_dir
            && r.pi
                .as_ref()
                .is_some_and(|p| p.runtime == runtime && p.distro.as_deref() == distro)
    })
}

/// FR-1: append a freshly-registered Pi row. The caller has already validated
/// every field; this only touches the in-memory registry, mirroring
/// `apply_add_codex`/`apply_add_grok`. `trust_configuration=false` still
/// saves the row (FR-4: "false saves the account with trusted=false, not a
/// rejected call") — and so does `trust_configuration=true` while
/// `FINGERPRINT_INPUTS_VERIFIED` is `false` (§6): the row saves either way,
/// it just never comes back `trusted`.
#[allow(clippy::too_many_arguments)]
pub(crate) fn apply_add_pi(
    inner: &mut AccountInner,
    id: String,
    label: String,
    config_dir: String,
    runtime: String,
    distro: Option<String>,
    inherit_environment_credentials: bool,
    trust_configuration: bool,
) -> Account {
    apply_add_pi_with(
        inner,
        id,
        label,
        config_dir,
        runtime,
        distro,
        inherit_environment_credentials,
        trust_configuration,
        FINGERPRINT_INPUTS_VERIFIED,
    )
}

/// The pure decision `apply_add_pi` delegates to, parameterized on
/// `verified` so the trust-granting mechanics are unit-tested with the flag
/// forced `true` (`adding_a_pi_account_with_trust_computes_and_stores_a_fingerprint`)
/// without the production entry point ever being able to grant trust off an
/// unverified file list.
#[allow(clippy::too_many_arguments)]
fn apply_add_pi_with(
    inner: &mut AccountInner,
    id: String,
    label: String,
    config_dir: String,
    runtime: String,
    distro: Option<String>,
    inherit_environment_credentials: bool,
    trust_configuration: bool,
    verified: bool,
) -> Account {
    let grant = trust_configuration && verified;
    let fingerprint = grant.then(|| compute_fingerprint(&config_dir));
    inner.records.push(AccountRecord {
        id: id.clone(),
        label,
        email: None,
        organization: None,
        config_dir,
        created_at: crate::ids::now_ms(),
        kind: AccountKind::Pi,
        endpoint: None,
        pi: Some(PiRecord {
            runtime,
            distro,
            inherit_environment_credentials,
            trusted: grant,
            fingerprint,
        }),
    });
    build_list(inner)
        .into_iter()
        .find(|a| a.id == id)
        .expect("just inserted")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::account::testutil::*;

    // ---------- FR-1: validation ----------

    #[test]
    fn a_pi_label_is_bounded_to_sixty_chars() {
        assert_eq!(validate_pi_label("  Home Pi  ").unwrap(), "Home Pi");
        assert_eq!(
            validate_pi_label("   ").unwrap_err().code,
            ErrorCode::InvalidInput
        );
        let over = "x".repeat(61);
        assert_eq!(
            validate_pi_label(&over).unwrap_err().code,
            ErrorCode::InvalidInput
        );
        assert!(validate_pi_label(&"x".repeat(60)).is_ok());
    }

    #[test]
    fn wsl_requires_a_distro_and_native_forbids_one() {
        assert_eq!(
            validate_pi_runtime("wsl", None).unwrap_err().code,
            ErrorCode::InvalidInput
        );
        assert_eq!(
            validate_pi_runtime("wsl", Some("  ")).unwrap_err().code,
            ErrorCode::InvalidInput
        );
        assert_eq!(
            validate_pi_runtime("wsl", Some("Ubuntu")).unwrap(),
            Some("Ubuntu".to_string())
        );
        assert_eq!(validate_pi_runtime("native", None).unwrap(), None);
        assert_eq!(
            validate_pi_runtime("native", Some("Ubuntu"))
                .unwrap_err()
                .code,
            ErrorCode::InvalidInput
        );
        assert_eq!(
            validate_pi_runtime("vmware", None).unwrap_err().code,
            ErrorCode::InvalidInput
        );
    }

    #[test]
    fn config_dir_must_be_absolute_and_an_existing_directory() {
        let dir = tmp_account_dir("pi-configdir");
        let canonical = canonicalize_config_dir(&dir.to_string_lossy()).unwrap();
        assert!(Path::new(&canonical).is_dir());

        assert_eq!(
            canonicalize_config_dir("relative/path").unwrap_err().code,
            ErrorCode::InvalidInput
        );
        assert_eq!(
            canonicalize_config_dir(&dir.join("does-not-exist").to_string_lossy())
                .unwrap_err()
                .code,
            ErrorCode::InvalidInput
        );
        let file = dir.join("a-file");
        std::fs::write(&file, "x").unwrap();
        assert_eq!(
            canonicalize_config_dir(&file.to_string_lossy())
                .unwrap_err()
                .code,
            ErrorCode::InvalidInput
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_same_directory_and_runtime_cannot_be_registered_twice_but_a_different_runtime_can() {
        let mut inner = inner_fixture(&[], "default");
        apply_add_pi(
            &mut inner,
            "p1".into(),
            "Home".into(),
            "/pi/home".into(),
            "native".into(),
            None,
            false,
            false,
        );
        assert!(duplicate_pi_directory(&inner, "/pi/home", "native", None));
        // FR-1: the SAME directory referenced through a different environment
        // is a DIFFERENT, independently pinned row.
        assert!(!duplicate_pi_directory(&inner, "/pi/home", "wsl", None));
        assert!(!duplicate_pi_directory(&inner, "/pi/other", "native", None));
    }

    #[test]
    fn the_same_directory_under_two_different_wsl_distros_is_not_a_duplicate() {
        // FR-1: `distro` is part of "environment" too — the same directory
        // registered under Ubuntu and under Debian are independently pinned
        // rows, same as native vs. wsl above.
        let mut inner = inner_fixture(&[], "default");
        apply_add_pi(
            &mut inner,
            "p1".into(),
            "Ubuntu".into(),
            "/pi/home".into(),
            "wsl".into(),
            Some("Ubuntu".into()),
            false,
            false,
        );
        assert!(duplicate_pi_directory(
            &inner,
            "/pi/home",
            "wsl",
            Some("Ubuntu")
        ));
        assert!(!duplicate_pi_directory(
            &inner,
            "/pi/home",
            "wsl",
            Some("Debian")
        ));
        assert!(!duplicate_pi_directory(&inner, "/pi/home", "wsl", None));
    }

    // ---------- FR-1: add ----------

    #[test]
    fn adding_a_pi_account_registers_kind_pi_with_no_endpoint_and_untrusted_by_default() {
        let mut inner = inner_fixture(&[], "default");
        let account = apply_add_pi(
            &mut inner,
            "p1".into(),
            "Home Pi".into(),
            "/pi/home".into(),
            "native".into(),
            None,
            false,
            false,
        );
        assert_eq!(account.kind, AccountKind::Pi);
        assert!(account.endpoint.is_none());
        assert!(account.signed_in.is_none());
        let pi = account.pi.expect("FR-1: present iff kind==pi");
        assert_eq!(pi.runtime, "native");
        assert!(pi.distro.is_none());
        assert!(
            !pi.trusted,
            "FR-4: trustConfiguration=false still saves the row"
        );
        assert!(!pi.inherit_environment_credentials);
        assert_eq!(inner.records[0].pi.as_ref().unwrap().fingerprint, None);
    }

    #[test]
    fn adding_a_pi_account_with_trust_never_grants_it_while_the_fingerprint_inputs_are_unverified()
    {
        // §6/CRITICAL: `CONFIG_FINGERPRINT_FILES` is an unverified guess in
        // this build, so the production entry point must never persist
        // `trusted=true` no matter what the caller asks for. This test pins
        // TODAY's `FINGERPRINT_INPUTS_VERIFIED=false` posture — flipping that
        // const is expected to break it, as a forcing function to update or
        // retire it in the same commit (the `_with(..., true)` test below
        // already covers the grant mechanics for that future).
        let mut inner = inner_fixture(&[], "default");
        let dir = tmp_account_dir("pi-add-unverified");
        apply_add_pi(
            &mut inner,
            "p1".into(),
            "Home Pi".into(),
            dir.to_string_lossy().into_owned(),
            "native".into(),
            None,
            true,
            true,
        );
        let record = inner.records[0].pi.as_ref().unwrap();
        assert!(!record.trusted);
        assert_eq!(record.fingerprint, None);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn adding_a_pi_account_with_trust_computes_and_stores_a_fingerprint_once_verified() {
        let mut inner = inner_fixture(&[], "default");
        let dir = tmp_account_dir("pi-add-trusted");
        apply_add_pi_with(
            &mut inner,
            "p1".into(),
            "Home Pi".into(),
            dir.to_string_lossy().into_owned(),
            "native".into(),
            None,
            true,
            true,
            true, // verified
        );
        let record = inner.records[0].pi.as_ref().unwrap();
        assert!(record.trusted);
        assert_eq!(
            record.fingerprint.as_deref(),
            Some(compute_fingerprint(&dir.to_string_lossy()).as_str())
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_wsl_pi_account_carries_its_distro() {
        let mut inner = inner_fixture(&[], "default");
        let account = apply_add_pi(
            &mut inner,
            "p1".into(),
            "WSL Pi".into(),
            "/mnt/c/pi".into(),
            "wsl".into(),
            Some("Ubuntu".into()),
            false,
            false,
        );
        assert_eq!(account.pi.unwrap().distro.as_deref(), Some("Ubuntu"));
    }
}
