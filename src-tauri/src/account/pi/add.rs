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

/// FR-1: `runtime` must be a known runtime available on THIS platform, and
/// `distro` is required iff it is `wsl` — mirrors `session::valid_runtime`'s
/// create-time rule (spawn.rs) plus the platform half
/// `adapter::pi::discovery::validate` already enforces for the installation
/// probe; duplicated rather than shared because session/ already depends on
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
        // A `wsl` row off Windows would register an account whose every spawn
        // resolves `wsl.exe` — there is none — so it can only ever fail later.
        if !cfg!(windows) {
            return Err(AppError::new(
                ErrorCode::InvalidInput,
                "the WSL runtime is only available on Windows",
            ));
        }
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
/// the FR-1 duplicate check below, then NORMALIZED
/// (`project::normalize_root`) so what gets stored is the ordinary spelling of
/// that path. Windows' `canonicalize` answers in the `\\?\` verbatim form,
/// which is what would otherwise reach `accounts.json`, the account UI, a
/// child's `PI_CODING_AGENT_DIR` and every path comparison in this module —
/// `normalize_root` is the same one-way trip `project` already takes for the
/// same reason.
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
    Ok(crate::project::normalize_root(&canonical.to_string_lossy()))
}

/// FR-1 + PR #142 §5: validate and canonicalize `configDir` **in the
/// account's own environment**. For `native` this is the ordinary filesystem
/// check above. For `wsl` the directory lives INSIDE the named distro, so
/// nothing about it can be answered with `std::fs` on the Windows side:
/// `/home/u/.pi` is not even an absolute path there, which is why every WSL
/// Pi account was refused at registration. Existence, directory-ness and
/// canonicalization all run THROUGH the distro instead, and what gets stored
/// is the Linux path — the spelling `PI_CODING_AGENT_DIR` must carry into it.
pub(crate) fn canonicalize_config_dir_for(
    raw: &str,
    runtime: &str,
    distro: Option<&str>,
) -> Result<String, AppError> {
    match (runtime, distro) {
        ("wsl", Some(distro)) => {
            let linux = wsl_config_dir_input(raw, distro)?;
            canonicalize_in_distro(&linux, distro)
        }
        _ => canonicalize_config_dir(raw),
    }
}

/// The Linux path a `wsl` account's `configDir` names, from whichever of the
/// two spellings the user arrived with. Pure — the I/O half is
/// `canonicalize_in_distro`.
///
/// A Windows folder picker browsing into a distro answers with the UNC
/// spelling (`\\wsl.localhost\Ubuntu\home\u\.pi`), so that is accepted and
/// translated; a path typed in the distro's own dialect (`/home/u/.pi`) is
/// taken as-is. A UNC path naming a DIFFERENT distro is refused rather than
/// silently registered against this account's one — the directory it points
/// at would never be the directory the spawn opens.
pub(crate) fn wsl_config_dir_input(raw: &str, distro: &str) -> Result<String, AppError> {
    let raw = raw.trim();
    if let Some((named, linux)) = crate::wsl::wsl_unc_to_linux(raw) {
        if !named.eq_ignore_ascii_case(distro) {
            return Err(AppError::new(
                ErrorCode::InvalidInput,
                format!("that directory is inside the {named} distro, not {distro}"),
            ));
        }
        return Ok(linux);
    }
    if !raw.starts_with('/') || raw.contains('\\') {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            format!(
                "for the WSL runtime, configDir must be a path inside {distro} \
                 (for example /home/you/.pi)"
            ),
        ));
    }
    // Trailing separators are noise on the way to `PI_CODING_AGENT_DIR`; the
    // root itself keeps its one.
    let trimmed = raw.trim_end_matches('/');
    Ok(if trimmed.is_empty() {
        "/".to_string()
    } else {
        trimmed.to_string()
    })
}

/// The deadline the in-distro check runs under. A cold distro has to boot
/// first, so this is deliberately looser than the 5s `--version` probe —
/// but it is still a deadline: registering an account must never hang the
/// command on a wedged `wsl.exe`.
const DISTRO_PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);
const DISTRO_PROBE_OUTPUT_CAP: usize = 8 * 1024;

/// The I/O half: ask the distro itself whether this path is a directory, and
/// what it canonically calls it. `cd` + `pwd -P` is the in-distro equivalent
/// of `std::fs::canonicalize` (it fails for a missing path and for a file,
/// and resolves symlinks), and the path rides as `$1` rather than being
/// interpolated into the script, so nothing in it can be read as shell syntax.
///
/// Untested by design — it needs a real distro. Everything decided about its
/// INPUT (`wsl_config_dir_input`) and its OUTPUT (`parse_distro_path_output`)
/// is pure and tested; this is the thin shell between them.
fn canonicalize_in_distro(linux_path: &str, distro: &str) -> Result<String, AppError> {
    let refused = || {
        AppError::new(
            ErrorCode::InvalidInput,
            format!(
                "could not open {linux_path} in the {distro} distro — check that the distro \
                 name is right and that the directory exists inside it"
            ),
        )
    };
    let run = crate::process_util::spawn("wsl.exe")
        .args([
            "-d",
            distro,
            "--",
            "sh",
            "-c",
            "cd -- \"$1\" && pwd -P",
            "sh",
            linux_path,
        ])
        .run_bounded(DISTRO_PROBE_TIMEOUT, DISTRO_PROBE_OUTPUT_CAP);
    if run.spawn_failed || run.timed_out || !run.status.map(|s| s.success()).unwrap_or(false) {
        return Err(refused());
    }
    parse_distro_path_output(&crate::wsl::decode_wsl_output(&run.stdout)).ok_or_else(refused)
}

/// The canonical path `cd … && pwd -P` printed: the first non-blank line, and
/// only when it is an absolute Linux path. wsl.exe's own failures (an unknown
/// distro, WSL not installed) surface here as UTF-16 noise that is not one —
/// `decode_wsl_output` has already made them readable, and this rejects them.
fn parse_distro_path_output(decoded: &str) -> Option<String> {
    decoded
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .filter(|l| l.starts_with('/'))
        .map(str::to_string)
}

/// FR-1/FR-2/FR-9: where a Pi `configDir` may NOT point. Two directories the
/// user can browse to but must never hand to Pi:
///
///  * anywhere inside (or containing) Francois's own app-data directory —
///    `accounts.json`, every app-created credential dir under
///    `<app_data>/accounts/<id>`, sessions, profiles. FR-2 keeps Francois out
///    of Pi's secrets; this is the same line from the other side;
///  * another ACCOUNT's directory. For the kinds Francois creates and deletes
///    (Claude/Codex/Grok/endpoint) that means any overlap at all: `account_remove`
///    deletes such a directory recursively (FR-8), so a Pi account pointed
///    inside one silently loses its configuration when an unrelated account is
///    removed, and a Pi account pointed at a PARENT of one hands Pi another
///    vendor's credentials. For another PI row, only strict nesting is
///    refused — FR-1 explicitly blesses the same directory registered twice
///    under different runtimes/distros, and `duplicate_pi_directory` is what
///    governs that case.
///
/// Comparison is `project::root_components`: component-wise (so `D:\a\bc` is
/// not inside `D:\a\b`) and case-folded on Windows, over already-normalized
/// paths.
pub(crate) fn validate_config_dir_location(
    config_dir: &str,
    runtime: &str,
    distro: Option<&str>,
    app_data_dir: Option<&str>,
    inner: &AccountInner,
) -> Result<(), AppError> {
    let candidate = location_components(config_dir, runtime, distro);
    if app_data_dir.is_some_and(|d| overlaps(&candidate, &crate::project::root_components(d))) {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "configDir cannot be inside Francois's own application data directory — point it at the Pi directory you already use",
        ));
    }
    let clash = inner.records.iter().any(|r| {
        let existing = record_location_components(r);
        overlaps(&candidate, &existing) && !(r.kind == AccountKind::Pi && candidate == existing)
    });
    if clash {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "configDir overlaps another account's directory",
        ));
    }
    Ok(())
}

/// True when `a` and `b` name the same directory or one contains the other.
/// Zipping stops at the shorter component list, so a shared prefix IS the
/// containment test in both directions.
fn overlaps(a: &[String], b: &[String]) -> bool {
    !a.is_empty() && !b.is_empty() && a.iter().zip(b.iter()).all(|(x, y)| x == y)
}

/// The components a containment/duplicate comparison runs over.
///
/// PR #142 §5: a `wsl` Pi row's `configDir` is a path inside a DISTRO, so the
/// distro leads its component list — `/home/u/.pi` in Ubuntu neither equals
/// nor contains the same path in Debian, and neither of them can overlap a
/// Windows path at all. Anything else compares exactly as it did, through
/// `project::root_components` (case-folded on Windows, verbatim-prefix aware).
///
/// Deliberately NOT the `\\wsl.localhost\<distro>\…` spelling — that one is
/// for a path a Windows API must OPEN (`wsl::linux_to_wsl_unc`). Its
/// backslashes only split into components ON Windows, so a comparison built
/// on it would quietly stop detecting nesting everywhere else.
fn location_components(config_dir: &str, runtime: &str, distro: Option<&str>) -> Vec<String> {
    let ("wsl", Some(distro)) = (runtime, distro) else {
        return crate::project::root_components(config_dir);
    };
    // A UNC spelling names the same in-distro directory; compare what the
    // distro itself calls it, so the two spellings never read as two places.
    let linux = crate::wsl::wsl_unc_to_linux(config_dir)
        .map_or_else(|| config_dir.to_string(), |(_, linux)| linux);
    let mut out = vec![format!("wsl:{}", distro.to_lowercase())];
    out.extend(
        linux
            .split('/')
            .filter(|s| !s.is_empty())
            .map(str::to_string),
    );
    out
}

/// The same, for a row already in the registry: a Pi row carries its own
/// runtime/distro, every other kind is an ordinary path on this machine.
fn record_location_components(record: &AccountRecord) -> Vec<String> {
    match record.pi.as_ref() {
        Some(pi) => location_components(&record.config_dir, &pi.runtime, pi.distro.as_deref()),
        None => crate::project::root_components(&record.config_dir),
    }
}

/// FR-1: "same directory/environment cannot be registered twice" — the
/// triple is (canonical configDir, runtime, distro), so the SAME directory
/// referenced once natively and once through WSL is two independently pinned
/// rows (FR-1/9), and so is the SAME directory under two different WSL
/// distros — `distro` is part of "environment" too, not just `runtime`.
/// Registering the identical triple again is refused.
///
/// The directory half compares COMPONENTS rather than the string: rows
/// registered before `canonicalize_config_dir` normalized its answer carry the
/// Windows `\\?\` verbatim spelling, and a duplicate check sensitive to the
/// SPELLING of a path would let the same directory in twice — as would a `wsl`
/// row stored once as `/home/u/.pi` and once as its UNC spelling.
pub(crate) fn duplicate_pi_directory(
    inner: &AccountInner,
    config_dir: &str,
    runtime: &str,
    distro: Option<&str>,
) -> bool {
    let candidate = location_components(config_dir, runtime, distro);
    !candidate.is_empty()
        && inner.records.iter().any(|r| {
            r.kind == AccountKind::Pi
                && r.pi.as_ref().is_some_and(|p| {
                    p.runtime == runtime
                        && p.distro.as_deref() == distro
                        && location_components(&r.config_dir, &p.runtime, p.distro.as_deref())
                            == candidate
                })
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
    // FR-4: a configuration that cannot be fingerprinted at all (see
    // `compute_fingerprint`) still SAVES the row — it just saves it untrusted,
    // never trusted with no baseline to later drift from. PR #142 §5: through
    // `readable_config_dir`, so a `wsl` row's baseline is taken over the same
    // spelling `effective_trust` reads back (an in-distro path this side
    // cannot name yields no baseline, hence no trust).
    let grant = trust_configuration && verified;
    let fingerprint = if grant {
        readable_config_dir(&config_dir, &runtime, distro.as_deref())
            .and_then(|path| compute_fingerprint(&path).into_baseline())
    } else {
        None
    };
    let grant = grant && fingerprint.is_some();
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
        #[cfg(windows)]
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
    fn the_wsl_runtime_is_only_accepted_on_windows() {
        // Off Windows there is no `wsl.exe` to resolve, so such a row could
        // only ever fail at spawn time — refuse it at registration instead.
        let out = validate_pi_runtime("wsl", Some("Ubuntu"));
        if cfg!(windows) {
            assert_eq!(out.unwrap(), Some("Ubuntu".to_string()));
        } else {
            assert_eq!(out.unwrap_err().code, ErrorCode::InvalidInput);
        }
    }

    #[test]
    fn a_stored_config_dir_is_the_normalized_spelling_never_the_verbatim_one() {
        // Windows' `canonicalize` answers `\\?\D:\…`; that spelling must not
        // reach accounts.json, the UI, or PI_CODING_AGENT_DIR.
        let dir = tmp_account_dir("pi-configdir-normalized");
        let stored = canonicalize_config_dir(&dir.to_string_lossy()).unwrap();
        assert!(!stored.starts_with(r"\\?\"), "{stored}");
        assert_eq!(stored, crate::project::normalize_root(&stored));
        assert!(Path::new(&stored).is_dir(), "{stored}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_config_dir_inside_francois_own_app_data_is_refused() {
        let app_data = tmp_account_dir("pi-appdata");
        let inside = app_data.join("accounts").join("a1");
        std::fs::create_dir_all(&inside).unwrap();
        let inner = inner_fixture(&[], "default");
        let app_data_s = app_data.to_string_lossy().into_owned();
        assert_eq!(
            validate_config_dir_location(
                &inside.to_string_lossy(),
                "native",
                None,
                Some(&app_data_s),
                &inner
            )
            .unwrap_err()
            .code,
            ErrorCode::InvalidInput
        );
        // The app-data directory ITSELF, and a parent of it, are refused too.
        assert!(validate_config_dir_location(
            &app_data_s,
            "native",
            None,
            Some(&app_data_s),
            &inner
        )
        .is_err());
        assert!(validate_config_dir_location(
            &app_data.parent().unwrap().to_string_lossy(),
            "native",
            None,
            Some(&app_data_s),
            &inner
        )
        .is_err());
        // A sibling directory that merely shares a name PREFIX is fine.
        let sibling = format!("{app_data_s}-elsewhere");
        assert!(
            validate_config_dir_location(&sibling, "native", None, Some(&app_data_s), &inner)
                .is_ok()
        );
        std::fs::remove_dir_all(&app_data).ok();
    }

    #[test]
    fn a_config_dir_overlapping_another_accounts_directory_is_refused_both_ways() {
        let mut inner = inner_fixture(&[], "default");
        inner.records.push(record_fixture("a1", "work")); // claude, /tmp/accounts/a1
        let other = inner.records[0].config_dir.clone();
        for candidate in [
            other.clone(),
            format!("{other}/nested"),
            "/tmp/accounts".to_string(),
        ] {
            assert_eq!(
                validate_config_dir_location(&candidate, "native", None, None, &inner)
                    .unwrap_err()
                    .code,
                ErrorCode::InvalidInput,
                "{candidate}"
            );
        }
        assert!(
            validate_config_dir_location("/tmp/accounts-pi", "native", None, None, &inner).is_ok()
        );
    }

    #[test]
    fn the_same_directory_as_another_pi_account_stays_allowed_but_nesting_does_not() {
        // FR-1: the same directory under a different runtime/distro is an
        // independently pinned row — `duplicate_pi_directory` governs it, not
        // this check. Nesting inside it is still refused.
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
        assert!(validate_config_dir_location("/pi/home", "native", None, None, &inner).is_ok());
        assert!(
            validate_config_dir_location("/pi/home/nested", "native", None, None, &inner).is_err()
        );
        assert!(validate_config_dir_location("/pi", "native", None, None, &inner).is_err());
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

    #[cfg(windows)]
    #[test]
    fn a_directory_stored_in_the_older_verbatim_spelling_is_still_a_duplicate() {
        // Rows registered before `canonicalize_config_dir` normalized its
        // answer carry `\\?\D:\…`; the same directory must not get in twice
        // just because it is now spelled the ordinary way.
        let mut inner = inner_fixture(&[], "default");
        apply_add_pi(
            &mut inner,
            "p1".into(),
            "Home".into(),
            r"\\?\D:\pi\home".into(),
            "native".into(),
            None,
            false,
            false,
        );
        assert!(duplicate_pi_directory(
            &inner,
            r"D:\pi\home",
            "native",
            None
        ));
        assert!(duplicate_pi_directory(
            &inner,
            r"d:\PI\Home",
            "native",
            None
        ));
        assert!(!duplicate_pi_directory(
            &inner,
            r"D:\pi\home2",
            "native",
            None
        ));
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
            record.fingerprint,
            compute_fingerprint(&dir.to_string_lossy()).into_baseline()
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn adding_a_directory_that_cannot_be_fingerprinted_saves_the_row_untrusted() {
        // FR-4: the add itself never fails on this (the row is still worth
        // keeping), but trust needs a baseline — and there is none.
        let mut inner = inner_fixture(&[], "default");
        let dir = tmp_account_dir("pi-add-unfingerprintable");
        std::fs::remove_dir_all(&dir).unwrap();
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
        assert!(!record.trusted);
        assert_eq!(record.fingerprint, None);
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

    // ---------- PR #142 §5: a configDir that lives INSIDE the distro ----------

    #[test]
    fn a_wsl_config_dir_is_the_distros_own_path_in_either_spelling() {
        // The finding: `/home/u/.pi` is not an absolute path on Windows, so
        // `canonicalize_config_dir` refused every WSL account outright. It is
        // an absolute path where it matters — inside the distro.
        assert_eq!(
            wsl_config_dir_input("/home/u/.pi", "Ubuntu").unwrap(),
            "/home/u/.pi"
        );
        // A Windows folder picker browsing into the distro answers with the
        // UNC spelling; it names the same directory.
        assert_eq!(
            wsl_config_dir_input("\\\\wsl.localhost\\Ubuntu\\home\\u\\.pi", "Ubuntu").unwrap(),
            "/home/u/.pi"
        );
        assert_eq!(
            wsl_config_dir_input("//wsl$/ubuntu/home/u/.pi", "Ubuntu").unwrap(),
            "/home/u/.pi"
        );
        // Trailing separators are noise on the way to PI_CODING_AGENT_DIR.
        assert_eq!(
            wsl_config_dir_input("  /home/u/.pi/  ", "Ubuntu").unwrap(),
            "/home/u/.pi"
        );
    }

    #[test]
    fn a_wsl_config_dir_naming_another_distro_or_the_windows_side_is_refused() {
        // Registering an Ubuntu path against a Debian account would pin a
        // directory the spawn never opens.
        let err =
            wsl_config_dir_input("\\\\wsl.localhost\\Ubuntu\\home\\u\\.pi", "Debian").unwrap_err();
        assert_eq!(err.code, ErrorCode::InvalidInput);
        assert!(err.message.contains("Ubuntu"), "{}", err.message);
        for raw in ["D:\\pi\\home", "relative/path", "", "C:/pi"] {
            assert_eq!(
                wsl_config_dir_input(raw, "Ubuntu").unwrap_err().code,
                ErrorCode::InvalidInput,
                "{raw}"
            );
        }
    }

    #[test]
    fn the_distro_canonical_path_is_read_off_the_first_absolute_line() {
        assert_eq!(
            parse_distro_path_output("/home/u/.pi\n").as_deref(),
            Some("/home/u/.pi")
        );
        // wsl.exe's own failures are not paths, whatever they decode to.
        assert_eq!(
            parse_distro_path_output("There is no distribution with the supplied name."),
            None
        );
        assert_eq!(parse_distro_path_output(""), None);
        assert_eq!(parse_distro_path_output("  \n  "), None);
    }

    #[test]
    fn the_same_in_distro_path_in_two_distros_is_two_independent_directories() {
        // The containment check compares distro-first, so Ubuntu's
        // `/home/u/.pi` neither equals nor contains Debian's.
        let mut inner = inner_fixture(&[], "default");
        apply_add_pi(
            &mut inner,
            "p1".into(),
            "Ubuntu Pi".into(),
            "/home/u/.pi".into(),
            "wsl".into(),
            Some("Ubuntu".into()),
            false,
            false,
        );
        assert!(
            validate_config_dir_location("/home/u/.pi", "wsl", Some("Debian"), None, &inner)
                .is_ok()
        );
        assert!(validate_config_dir_location(
            "/home/u/.pi/nested",
            "wsl",
            Some("Debian"),
            None,
            &inner
        )
        .is_ok());
        // …while the SAME distro still refuses nesting, and still allows the
        // identical directory (FR-1's one blessed overlap).
        assert!(
            validate_config_dir_location("/home/u/.pi", "wsl", Some("Ubuntu"), None, &inner)
                .is_ok()
        );
        assert!(validate_config_dir_location(
            "/home/u/.pi/nested",
            "wsl",
            Some("Ubuntu"),
            None,
            &inner
        )
        .is_err());
        assert!(
            validate_config_dir_location("/home/u", "wsl", Some("Ubuntu"), None, &inner).is_err()
        );
        // A Windows path can never overlap an in-distro one.
        assert!(validate_config_dir_location(
            "D:\\pi\\home",
            "native",
            None,
            Some("D:\\appdata"),
            &inner
        )
        .is_ok());
    }

    #[test]
    fn an_in_distro_directory_registered_in_either_spelling_is_one_row() {
        // FR-1's duplicate check compares the DIRECTORY, not the string: the
        // UNC spelling and the Linux one are the same place in the same distro.
        let mut inner = inner_fixture(&[], "default");
        apply_add_pi(
            &mut inner,
            "p1".into(),
            "Ubuntu Pi".into(),
            "/home/u/.pi".into(),
            "wsl".into(),
            Some("Ubuntu".into()),
            false,
            false,
        );
        assert!(duplicate_pi_directory(
            &inner,
            "\\\\wsl.localhost\\Ubuntu\\home\\u\\.pi",
            "wsl",
            Some("Ubuntu")
        ));
        assert!(!duplicate_pi_directory(
            &inner,
            "/home/u/.pi",
            "wsl",
            Some("Debian")
        ));
        assert!(!duplicate_pi_directory(
            &inner,
            "/home/u/.pi-other",
            "wsl",
            Some("Ubuntu")
        ));
    }
}
