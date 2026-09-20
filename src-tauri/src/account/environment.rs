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
    cwd: &str,
) -> Result<(), AppError> {
    let label = || label_of(app, account_id).unwrap_or_else(|| account_id.to_string());
    if kind_of(app, account_id) == AccountKind::Pi {
        let (pinned_runtime, pinned_distro) = pi_environment_of(app, account_id)
            .ok_or_else(|| AppError::new(ErrorCode::AccountNotFound, NOT_FOUND_MSG))?;
        // The session's distro is only KNOWN here when its cwd names one; a
        // drive-letter cwd lands in the default distro, which nothing can
        // resolve without a probe — so that case is accepted rather than
        // guessed at (`probe_installation` resolves Pi in the same place).
        let session_distro = crate::wsl::wsl_unc_to_linux(cwd).map(|(d, _)| d);
        return pi_environment_mismatch(
            &pinned_runtime,
            pinned_distro.as_deref(),
            runtime,
            session_distro.as_deref(),
        )
        .map_or(Ok(()), |reason| {
            Err(AppError::new(
                ErrorCode::InvalidInput,
                format!("account {} {reason}", label()),
            ))
        });
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

/// A Pi row's PINNED execution environment (`pi.runtime`, `pi.distro`);
/// `None` for every other kind and for an unknown id.
pub(crate) fn pi_environment_of(
    app: &AppHandle,
    account_id: &str,
) -> Option<(String, Option<String>)> {
    let state = app.try_state::<AccountState>()?;
    let inner = state.0.lock().ok()?;
    let record = inner.records.iter().find(|r| r.id == account_id)?;
    let pi = record.pi.as_ref()?;
    Some((pi.runtime.clone(), pi.distro.clone()))
}

/// The pure half, shared with the reconnect path (`adapter::pi::recovery`):
/// does a session's execution environment match the one a Pi account is
/// pinned to? `Some(reason)` is the tail of a user-facing sentence that
/// already names the account.
///
/// The runtimes must agree outright. The distro is only compared when the
/// session's is KNOWN (`session_distro`: its worktree's, or the one its WSL
/// UNC cwd names) — an unknown one means the default distro, and refusing a
/// session because nothing named a distro would block the ordinary case.
/// Names are compared case-insensitively, the way `wsl.exe -d` treats them.
pub(crate) fn pi_environment_mismatch(
    pinned_runtime: &str,
    pinned_distro: Option<&str>,
    runtime: &str,
    session_distro: Option<&str>,
) -> Option<String> {
    if pinned_runtime != runtime {
        return Some(format!(
            "is pinned to the {pinned_runtime} runtime — create this session with that runtime, \
             or register the directory again for {runtime}"
        ));
    }
    let (Some(pinned), Some(session)) = (pinned_distro, session_distro) else {
        return None;
    };
    (!pinned.eq_ignore_ascii_case(session)).then(|| {
        format!(
            "is pinned to the {pinned} distro, but this session runs in {session} — \
             its Pi configuration does not exist there"
        )
    })
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

    /// PR #142 §5: a Pi account pins its execution environment, and its
    /// `PI_CODING_AGENT_DIR` is spelled for it — a WSL account's Linux
    /// directory handed to a native session's child is a path that does not
    /// exist there, and Pi falls back to the ambient configuration.
    #[test]
    fn a_pi_account_refuses_a_session_running_in_another_runtime() {
        let native = pi_environment_mismatch("native", None, "wsl", Some("Ubuntu"));
        assert!(native.is_some_and(|r| r.contains("native")), "native → wsl");
        let wsl = pi_environment_mismatch("wsl", Some("Ubuntu"), "native", None);
        assert!(wsl.is_some_and(|r| r.contains("wsl")), "wsl → native");
        // The matching cases stay silent.
        assert!(pi_environment_mismatch("native", None, "native", None).is_none());
        assert!(pi_environment_mismatch("wsl", Some("Ubuntu"), "wsl", Some("Ubuntu")).is_none());
    }

    #[test]
    fn a_pi_account_refuses_a_different_distro_but_never_guesses_an_unknown_one() {
        let other = pi_environment_mismatch("wsl", Some("Ubuntu"), "wsl", Some("Debian"));
        assert!(other.is_some_and(|r| r.contains("Ubuntu") && r.contains("Debian")));
        // `wsl.exe -d` is case-insensitive about distro names, so this is the
        // SAME environment, not a mismatch.
        assert!(pi_environment_mismatch("wsl", Some("Ubuntu"), "wsl", Some("ubuntu")).is_none());
        // Unknown (a drive-letter cwd, no worktree distro) ⇒ the default
        // distro, which nothing can resolve without a probe: accepted rather
        // than refused, or every ordinary WSL session would be blocked.
        assert!(pi_environment_mismatch("wsl", Some("Ubuntu"), "wsl", None).is_none());
        // And a row with no distro at all pins only the runtime.
        assert!(pi_environment_mismatch("wsl", None, "wsl", Some("Debian")).is_none());
    }
}
