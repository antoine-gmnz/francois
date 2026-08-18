//! filesystem plumbing shared by the crate's atomic writers.
//!
//! What is shared here is ONLY the unique temp-path generation. The two atomic
//! writers themselves — `permissions::settings::write_json_atomic` and
//! `project::standards::write_text_atomic` — deliberately stay separate, because
//! the part that looks duplicated is the part that genuinely differs:
//!
//! * settings.json can carry secrets under `env`, so its temp file is created
//!   0600 by default and the target's mode is carried over on BOTH unix and
//!   Windows (a read-only settings.json stays read-only), and the write is
//!   `sync_all`'d before the rename.
//! * CLAUDE.md is a git-tracked document in the user's repo, and standards.rs
//!   explicitly does NOT copy the target's attributes on Windows — doing so
//!   would make a read-only target's temp file undeletable, breaking the
//!   remove-on-failure cleanup that FR-15 requires.
//!
//! Collapsing them would mean either leaking settings.json's permissions or
//! breaking standards.rs's cleanup. The shared skeleton below is the part that
//! can be unified without choosing between those.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

/// Monotonic counter making each temp filename unique within the process. The
/// name used to be a constant per target, so two concurrent writers to the same
/// file (a decide racing the editor modal, or two sessions sharing a cwd) could
/// interleave and clobber each other's temp file.
///
/// NOTE: this prevents temp-file collision only. It does NOT serialize the
/// read-modify-write itself — callers that need that hold their own lock (e.g.
/// `STANDARDS_LOCK` in `write_standards`).
static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// A sibling temp path for `path`, unique per process and per call:
/// `<path>.<ext>.<pid>.<seq>.tmp`. Same directory as the target, so the
/// subsequent rename stays on one filesystem and is therefore atomic.
///
/// `ext` is the target's own extension (`"json"`, `"md"`) — kept in the temp
/// name so a leaked temp file is still recognizable as what it came from.
pub(crate) fn unique_temp_path(path: &Path, ext: &str) -> PathBuf {
    let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    path.with_extension(format!("{ext}.{}.{seq}.tmp", std::process::id()))
}

// ---------- multi-provider-endpoint FR-2: the user-only key file ----------
//
// The one primitive both platforms share for a file that must never be
// readable by anyone but the current user: `<configDir>/endpoint-key` (the
// endpoint account's API key, account/endpoint.rs). Unlike
// `permissions::settings::write_private` (which carries over an EXISTING
// target's mode/ACL because settings.json is user-editable and may already
// have been loosened), this primitive always forces the restrictive mode —
// there is no scenario where a looser key file is intentional.

/// Write `bytes` to `path` (creating parent directories as needed) with
/// permissions restricted to the current user only: `0600` on unix, an ACL
/// granting the current user Full Control on Windows with inheritance from the
/// parent directory explicitly stripped — a key file must not inherit a looser
/// ACL from `<app_data>/accounts/<id>/`.
///
/// "Restricted" means the unix `0600` boundary on both platforms: no other
/// UNPRIVILEGED account can read the key. On Windows the machine's own
/// `SYSTEM` and `Administrators` may still appear in the ACL, which is not a
/// leak — see `BROAD_SIDS`.
pub(crate) fn write_user_only_file(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    write_user_only_file_platform(path, bytes)
}

#[cfg(unix)]
fn write_user_only_file_platform(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write as _;
    use std::os::unix::fs::{OpenOptionsExt as _, PermissionsExt as _};
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?;
    f.write_all(bytes)?;
    // `.mode()` only governs permissions at CREATION — a key being REPLACED
    // (account_update_endpoint) opens an already-existing file, whose mode is
    // untouched by `OpenOptions`, so it is set explicitly here too.
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    f.sync_all()
}

/// Windows has no `0600` — the equivalent is an ACL with a single explicit
/// grant. `icacls` (present on every supported Windows version) is used
/// rather than the raw `SetNamedSecurityInfoW` Win32 API: this crate has no
/// existing ACL-manipulation code to extend, and hand-rolling the security
/// descriptor plumbing for one sidecar file is a much larger surface than
/// shelling out to the tool built for exactly this.
#[cfg(windows)]
fn write_user_only_file_platform(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    // Write to a sibling temp file and restrict ITS acl BEFORE the file ever
    // lands at `path`, then rename it into place. Restricting `path` in place
    // (write then `icacls`) would leave a window — and, worse, a permanent
    // state if `icacls` itself fails — where a file at the final, expected
    // path sits under the parent directory's INHERITED (looser) ACL instead
    // of the restricted one. Renaming atomically means `path` only ever goes
    // from "doesn't exist" / "previous restricted contents" straight to
    // "new restricted contents" — never through an unrestricted state, and a
    // failure anywhere in this sequence leaves the ORIGINAL `path` (if any)
    // untouched rather than a half-restricted key file behind.
    let tmp = unique_temp_path(path, "key");
    std::fs::write(&tmp, bytes)?;
    if let Err(e) = restrict_to_current_user_only(&tmp) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    std::fs::rename(&tmp, path)
}

/// The broad principals that must never hold a grant on a key file, named by
/// SID rather than by name because `icacls` prints and accepts LOCALIZED names
/// (`BUILTIN\Users` is `BUILTIN\Utilisateurs` on a French Windows) while SIDs
/// are invariant everywhere.
///
/// `SYSTEM` (`S-1-5-18`) and `Administrators` (`S-1-5-32-544`) are deliberately
/// NOT here. An administrator can take ownership of any file and read it
/// regardless of the DACL, so removing their ACE buys no confidentiality — it
/// only breaks backup, AV and indexing. The boundary this file actually
/// enforces is the same one `0600` enforces on unix: no OTHER unprivileged
/// account can read the key.
#[cfg(windows)]
const BROAD_SIDS: [&str; 3] = [
    "*S-1-1-0",      // Everyone
    "*S-1-5-11",     // Authenticated Users
    "*S-1-5-32-545", // BUILTIN\Users
];

#[cfg(windows)]
fn restrict_to_current_user_only(path: &Path) -> std::io::Result<()> {
    let user = std::env::var("USERNAME")
        .map_err(|_| std::io::Error::other("could not resolve the current Windows user"))?;
    let spec = match std::env::var("USERDOMAIN") {
        Ok(domain) if !domain.trim().is_empty() => format!("{domain}\\{user}"),
        _ => user,
    };
    // Two invocations rather than one, so the sequence is OURS rather than
    // icacls's internal option ordering: strip + grant, then prune.
    //
    // /inheritance:r strips whatever the parent directory would otherwise hand
    // down; /grant:r <spec>:F REPLACES (not adds to) that user's explicit
    // permissions with Full control.
    icacls(path, &["/inheritance:r", "/grant:r", &format!("{spec}:F")])?;
    // ...but NEITHER of those touches an EXPLICIT ACE belonging to a third
    // principal: `/inheritance:r` removes only INHERITED entries, and
    // `/grant:r` replaces only the named user's own. A parent directory that
    // hands its children explicit (not inherited) ACEs therefore leaves them
    // standing on the key file — observed on Windows CI runners, where a
    // process holding an admin token creates files carrying explicit
    // SYSTEM/Administrators entries instead of inherited ones. Harmless for
    // those two (see BROAD_SIDS), a real leak for `Users`/`Everyone`, so the
    // broad principals are pruned by SID explicitly.
    let mut prune = vec!["/remove:g"];
    prune.extend(BROAD_SIDS);
    icacls(path, &prune)
}

#[cfg(windows)]
fn icacls(path: &Path, args: &[&str]) -> std::io::Result<()> {
    let output = std::process::Command::new("icacls")
        .arg(path)
        .args(args)
        .output()?;
    if !output.status.success() {
        return Err(std::io::Error::other(format!(
            "icacls {} could not restrict {}: {}",
            args.join(" "),
            path.display(),
            String::from_utf8_lossy(&output.stderr)
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn temp_path_is_a_sibling_of_the_target() {
        let target = Path::new("/tmp/some/dir/settings.json");
        let tmp = unique_temp_path(target, "json");
        assert_eq!(tmp.parent(), target.parent());
    }

    #[test]
    fn temp_path_is_unique_per_call() {
        let target = Path::new("CLAUDE.md");
        let first = unique_temp_path(target, "md");
        let second = unique_temp_path(target, "md");
        assert_ne!(first, second, "two writers must not share a temp path");
    }

    #[test]
    fn temp_path_keeps_the_extension_and_ends_in_tmp() {
        let tmp = unique_temp_path(Path::new("x/CLAUDE.md"), "md");
        let name = tmp.file_name().unwrap().to_string_lossy().to_string();
        assert!(name.starts_with("CLAUDE.md."), "{name}");
        assert!(name.ends_with(".tmp"), "{name}");
    }

    // ---------- multi-provider-endpoint FR-2 ----------

    fn tmp_path(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "francois-fs-util-{tag}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    #[test]
    fn write_user_only_file_creates_parent_dirs_and_holds_exactly_the_bytes() {
        let dir = tmp_path("parents");
        let path = dir.join("nested").join("endpoint-key");
        write_user_only_file(&path, b"sk-test-123").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"sk-test-123");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn write_user_only_file_overwrites_an_existing_file_in_place() {
        let dir = tmp_path("overwrite");
        let path = dir.join("endpoint-key");
        write_user_only_file(&path, b"first-key").unwrap();
        write_user_only_file(&path, b"second-key").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"second-key");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn write_user_only_file_is_0600_on_unix() {
        use std::os::unix::fs::PermissionsExt as _;
        let dir = tmp_path("unix-mode");
        let path = dir.join("endpoint-key");
        write_user_only_file(&path, b"sk-test").unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The file's DACL in SDDL form — the ground truth for these assertions,
    /// because SDDL names principals by SID and by INVARIANT two-letter alias
    /// (`BU` = BUILTIN\Users, `WD` = Everyone, `AU` = Authenticated Users,
    /// `SY` = SYSTEM, `BA` = Administrators) whereas `icacls`' human report
    /// prints LOCALIZED names — `BUILTIN\Utilisateurs`, `AUTORITE NT\Système`
    /// on a French Windows. An English-name assertion would silently pass on a
    /// localized machine, which is the class of machine-dependence that broke
    /// this test in the first place.
    ///
    /// Read through `icacls /save` — the same tool the implementation already
    /// requires — rather than PowerShell's `Get-Acl`, which returned EMPTY
    /// stdout on a Windows CI runner and turned this helper into the failure
    /// instead of the check. `icacls /findsid` is deliberately NOT used
    /// either: it fails to match well-known SIDs (verified — a file explicitly
    /// granted `BU` is not found), so an assertion built on it can never fail.
    ///
    /// `/save` writes `<relative path>` and `<sddl>` on alternating lines, as
    /// UTF-16 — hence the manual decode.
    #[cfg(windows)]
    fn dacl_sddl(path: &Path) -> String {
        let dir = path.parent().expect("a parent directory");
        let save = tmp_path("sddl-save");
        let out = std::process::Command::new("icacls")
            .arg(dir)
            .arg("/save")
            .arg(&save)
            .arg("/t")
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "icacls /save failed for {dir:?}: {}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        let bytes = std::fs::read(&save).expect("the saved ACL file");
        std::fs::remove_file(&save).ok();
        let utf16: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        let text = String::from_utf16_lossy(&utf16);
        // The entry for our file is the line NAMING it, followed by its SDDL.
        let name = path.file_name().unwrap().to_string_lossy().to_string();
        let lines: Vec<&str> = text.lines().map(|l| l.trim_end_matches('\r')).collect();
        let idx = lines
            .iter()
            .position(|l| l.trim_start_matches('\u{feff}').ends_with(&name))
            .unwrap_or_else(|| panic!("no /save entry for {name} in:\n{text}"));
        let sddl = lines
            .get(idx + 1)
            .unwrap_or_else(|| panic!("no SDDL after the entry for {name} in:\n{text}"))
            .to_string();
        assert!(
            sddl.contains("D:"),
            "expected a DACL for {name}, got {sddl:?} in:\n{text}"
        );
        sddl
    }

    /// Every ACE in `sddl`'s DACL as `(flags, trustee)`. SDDL ACE layout is
    /// `(type;flags;rights;object_guid;inherit_guid;trustee)`.
    #[cfg(windows)]
    fn dacl_aces(sddl: &str) -> Vec<(String, String)> {
        let dacl = sddl.split("D:").nth(1).expect("a DACL");
        dacl.split('(')
            .skip(1)
            .filter_map(|ace| ace.split(')').next())
            .filter_map(|ace| {
                let f: Vec<&str> = ace.split(';').collect();
                (f.len() >= 6).then(|| (f[1].to_string(), f[5].to_string()))
            })
            .collect()
    }

    /// The broad principals as SDDL trustees, matching `BROAD_SIDS`. Both the
    /// alias and the raw SID are rejected, since SDDL emits whichever it likes.
    #[cfg(windows)]
    const BROAD_TRUSTEES: [&str; 6] = ["BU", "WD", "AU", "S-1-5-32-545", "S-1-1-0", "S-1-5-11"];

    /// The ACL this file must land with, asserted as the properties that
    /// actually matter rather than as an ACE count.
    ///
    /// An earlier version of this test demanded EXACTLY one ACE. That holds on
    /// an ordinary user profile, where the parent hands its children INHERITED
    /// entries that `/inheritance:r` then wipes — but not on a Windows CI
    /// runner, where a process holding an admin token creates files carrying
    /// EXPLICIT `SYSTEM`/`Administrators` entries that no amount of inheritance
    /// stripping removes. The count was therefore an artifact of the machine,
    /// not the guarantee; those two principals are not a leak (see
    /// `BROAD_SIDS`) and the code now prunes the ones that are.
    #[cfg(windows)]
    #[test]
    fn write_user_only_file_restricts_the_acl_on_windows() {
        let dir = tmp_path("win-acl");
        let path = dir.join("endpoint-key");
        write_user_only_file(&path, b"sk-test").unwrap();

        let sddl = dacl_sddl(&path);
        let aces = dacl_aces(&sddl);

        // 1. The DACL is PROTECTED — `/inheritance:r` landed, so a looser
        //    parent ACL cannot flow into the key file. This is the FR-2
        //    requirement and is invariant across machines.
        let dacl_flags = sddl.split("D:").nth(1).unwrap();
        let dacl_flags = &dacl_flags[..dacl_flags.find('(').unwrap_or(0)];
        assert!(
            dacl_flags.contains('P'),
            "expected a protected (inheritance-stripped) DACL, got D:{dacl_flags} in {sddl}"
        );
        // 2. and no ACE survived as inherited.
        assert!(
            !aces.iter().any(|(flags, _)| flags.contains("ID")),
            "expected no inherited ACE, got {aces:?}"
        );
        // 3. No broad principal holds a grant — the actual confidentiality
        //    boundary. SYSTEM/Administrators may remain; see BROAD_SIDS.
        for (_, trustee) in &aces {
            assert!(
                !BROAD_TRUSTEES.contains(&trustee.as_str()),
                "a broad principal ({trustee}) holds a grant on the key file: {sddl}"
            );
        }
        // 4. The current user can still read its own key.
        assert!(!aces.is_empty(), "expected at least one ACE: {sddl}");
        let report = std::process::Command::new("icacls")
            .arg(&path)
            .output()
            .unwrap();
        let report = String::from_utf8_lossy(&report.stdout);
        let user = std::env::var("USERNAME").unwrap();
        assert!(
            report.contains(&user),
            "expected the current user in the ACL report:\n{report}"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The regression test for the CI failure this pair of changes fixes:
    /// `/inheritance:r` removes only INHERITED entries and `/grant:r` replaces
    /// only the named user's own, so an EXPLICIT ACE belonging to a third
    /// principal survives both. Granting `BU` explicitly up front reproduces
    /// exactly the shape a Windows runner produced on its own, and pins that
    /// `restrict_to_current_user_only` now prunes it.
    #[cfg(windows)]
    #[test]
    fn restrict_prunes_an_explicit_broad_grant_inheritance_stripping_would_leave() {
        let dir = tmp_path("win-acl-broad");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("endpoint-key");
        std::fs::write(&path, b"sk-test").unwrap();

        // Explicit, not inherited — the case /inheritance:r cannot reach.
        let granted = std::process::Command::new("icacls")
            .arg(&path)
            .args(["/grant", "*S-1-5-32-545:R"])
            .output()
            .unwrap();
        assert!(granted.status.success(), "could not seed the broad grant");
        assert!(
            dacl_aces(&dacl_sddl(&path))
                .iter()
                .any(|(_, t)| t == "BU" || t == "S-1-5-32-545"),
            "the fixture must actually start with a broad grant, or this test proves nothing"
        );

        restrict_to_current_user_only(&path).unwrap();

        for (_, trustee) in dacl_aces(&dacl_sddl(&path)) {
            assert!(
                !BROAD_TRUSTEES.contains(&trustee.as_str()),
                "the broad grant survived: {}",
                dacl_sddl(&path)
            );
        }
        std::fs::remove_dir_all(&dir).ok();
    }
}

// ---------- extension-install FR-1: ~/.francois ----------

/// `$HOME/.francois` (`%USERPROFILE%\.francois` on Windows) — the one fixed
/// location `cli-companion` and `extension-install` both anchor to. PURE path
/// resolution only — nothing is created here, so a test can call this freely
/// without touching the real machine's home directory. `ensure_dir_0700` is
/// the (separate, explicit) side-effecting half.
pub(crate) fn francois_home_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".francois"))
}

/// `~/.francois/extensions` — the one directory `extension-install` FR-1 reads
/// manifests from, and nowhere else.
pub(crate) fn extensions_dir() -> Option<PathBuf> {
    francois_home_dir().map(|h| h.join("extensions"))
}

/// Create `dir` (and its ancestors) if missing, at mode `0700` on unix. A
/// pre-existing directory is left as-is — never re-chmod'd, so a user who
/// loosened it on purpose is not fought.
pub(crate) fn ensure_dir_0700(dir: &Path) -> std::io::Result<()> {
    if dir.exists() {
        return Ok(());
    }
    std::fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

#[cfg(test)]
mod francois_home_tests {
    use super::*;

    #[test]
    fn francois_home_dir_is_a_dot_francois_child_of_home() {
        let home = francois_home_dir().expect("a home directory must resolve in CI");
        assert!(home.ends_with(".francois"));
    }

    #[test]
    fn extensions_dir_is_a_child_of_the_francois_home() {
        let dir = extensions_dir().expect("a home directory must resolve in CI");
        assert!(dir.ends_with("extensions"));
        assert_eq!(dir.parent(), francois_home_dir().as_deref());
    }

    // FR-1: "no manifest is read from any other location — not a repo, not
    // ~/.claude, not a Claude Code plugin, not an env-var override." Prove the
    // negative directly: `extensions_dir()` reads no env var at all (besides
    // whatever `dirs::home_dir()` itself consults internally to find $HOME) —
    // setting a battery of plausible override variables must not move the
    // result away from `<home>/.francois/extensions`.
    #[test]
    fn extensions_dir_ignores_every_env_var_override() {
        let before = extensions_dir();

        let candidates = [
            "CLAUDE_CONFIG_DIR",
            "CLAUDE_HOME",
            "CLAUDE_PROJECT_DIR",
            "FRANCOIS_HOME",
            "FRANCOIS_EXTENSIONS_DIR",
            "FRANCOIS_CONFIG_DIR",
            "XDG_CONFIG_HOME",
        ];
        for name in candidates {
            std::env::set_var(name, "/tmp/should-never-be-consulted");
        }

        let after = extensions_dir();

        for name in candidates {
            std::env::remove_var(name);
        }

        assert_eq!(
            before, after,
            "extensions_dir() must be unaffected by CLAUDE_*/FRANCOIS_*/XDG_* env vars"
        );
        // And it must land under the real home, not under any of the bogus
        // override values above.
        if let Some(dir) = after {
            assert!(
                !dir.starts_with("/tmp/should-never-be-consulted"),
                "{dir:?}"
            );
        }
    }

    // The directory is created on first use, and mode 0700 on unix — nothing
    // under it is group- or world-readable by default.
    #[cfg(unix)]
    #[test]
    fn ensure_dir_0700_creates_and_chmods_a_missing_directory() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!(
            "francois-fsutil-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        assert!(!dir.exists());
        ensure_dir_0700(&dir).unwrap();
        assert!(dir.exists());
        let mode = std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o700, "{mode:o}");
        // Idempotent — a second call on an existing dir does not error.
        ensure_dir_0700(&dir).unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
