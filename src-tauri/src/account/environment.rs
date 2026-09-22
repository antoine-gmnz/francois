//! Can a session running in a given environment use a given account at all?
//!
//! One question, asked before anything is spawned — by `session_create`
//! (`account_environment_check`) and again, in its pure half, by a Pi
//! reconnect (`pi_environment_mismatch`). Split out of `mod.rs` for CLAUDE.md's
//! ~1000-line file cap, as its own concern rather than a section of the shared
//! data model: it is about the pairing of an ACCOUNT with a RUNTIME, and it is
//! the only account-side rule that reads the WSL path vocabulary.
//!
//! Two rules live here, one per kind family:
//!
//!  * multi-account FR-25 — a `wsl` session reaches a Claude/Codex/Grok config
//!    dir through `WSLENV`'s `/p` translation, which only works for a
//!    drive-letter path;
//!  * pi-provider-auth FR-1/FR-6 (PR #142 §5) — a Pi account PINS its own
//!    execution environment, and its `PI_CODING_AGENT_DIR` is spelled for it.
//!    A WSL Pi account's Linux directory handed to a native session's child is
//!    a path that does not exist there, and Pi would quietly fall back to the
//!    ambient configuration; the reverse (a native account's Windows path in a
//!    distro) is the same hazard in the other direction.

use super::*;

/// FR-25: an account `configDir` a `wsl.exe` spawn can reach. Only a
/// drive-letter Windows path is (wsl.exe maps it to `/mnt/...` itself); a UNC
/// path (including a `\\wsl$\...`/`\\wsl.localhost\...` one) is not.
pub fn wsl_translatable_config_dir(path: &str) -> bool {
    !path.trim_start().starts_with("\\\\") && !path.trim_start().starts_with("//")
}

/// The gate `session_create` applies: fail at creation, NAMING the account,
/// rather than spawning a child that would silently use a different
/// configuration (or none).
pub(crate) fn account_environment_check(
    app: &AppHandle,
    account_id: &str,
    runtime: &str,
    _cwd: &str,
) -> Result<(), AppError> {
    let label = || label_of(app, account_id).unwrap_or_else(|| account_id.to_string());
    if kind_of(app, account_id) == AccountKind::Pi {
        return Err(crate::ipc::retired_pi_error());
    }
    if runtime == "wsl" {
        if let Some(dir) =
            config_dir_of(app, account_id).filter(|d| !wsl_translatable_config_dir(d))
        {
            return Err(AppError::new(
                ErrorCode::InvalidInput,
                format!(
                    "account {} keeps its Claude Code configuration at {dir}, which WSL \
                     cannot translate — use the native runtime for this account",
                    label()
                ),
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// multi-account FR-25: the predicate `session_create`'s gate applies
    /// before spawning anything. A drive-letter dir is reachable (wsl.exe maps
    /// it to /mnt/…); a UNC one is not.
    #[test]
    fn wsl_translatable_config_dir_rejects_unc_and_accepts_drive_paths() {
        assert!(wsl_translatable_config_dir("D:\\francois\\accounts\\a1"));
        assert!(!wsl_translatable_config_dir(
            "\\\\wsl$\\Ubuntu\\home\\u\\.francois"
        ));
        assert!(!wsl_translatable_config_dir(
            "\\\\server\\share\\accounts\\a1"
        ));
        assert!(!wsl_translatable_config_dir("//server/share/accounts/a1"));
    }
}
