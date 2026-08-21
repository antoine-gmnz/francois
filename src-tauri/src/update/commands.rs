//! The `francois:app:<verb>` command surface for self-update (§5).
//!
//! `app_check_update` runs a fresh check and stores it (FR-19); `app_apply_update`
//! re-decides FR-12 and FR-18 from live facts — the session count and the
//! provenance can both have changed since the modal rendered — then spawns the
//! helper, acks, and only THEN begins shutdown (FR-16).

use super::{
    fresh_helper_dir, npm_install_executable, npm_root_global, run_check, spawn_helper,
    write_helper, UpdateApplyAck, UpdateCheck, UpdateState, SHUTDOWN_GRACE_MS, UPDATE_COMMAND,
};
use crate::ipc::{err, err_detail, ok, IpcResult};
use crate::session::Engine;
use serde_json::json;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, State};

/// What `app_apply_update` decided, from facts read at CLICK time (FR-12/FR-18)
/// rather than from the stored check's `method`, which the modal may have been
/// showing for a while.
#[derive(Debug)]
pub(crate) enum ApplyPlan {
    /// Cleared to update: install `latest`, and relaunch `exe` if the
    /// post-install record turns out to be unreadable (FR-17).
    Go { latest: String, exe: PathBuf },
    /// FR-12: sessions are mid-turn — `UPDATE_BLOCKED`, with the count so the
    /// modal can name it.
    Blocked(usize),
    /// FR-18: `UPDATE_APPLY_FAILED`, with the reason as the user reads it.
    Failed(String),
}

/// The whole apply decision, with every input passed in so it is provable
/// without an app, a registry, or an npm on PATH.
///
/// Order is deliberate: FR-12 is decided BEFORE provenance, because a mid-turn
/// session is the thing the user can act on and must not be masked by a
/// manual-install failure.
pub(crate) fn plan_apply(
    running: usize,
    check: Option<&UpdateCheck>,
    npm_root: Option<&Path>,
    current_exe: &Path,
) -> ApplyPlan {
    if running > 0 {
        return ApplyPlan::Blocked(running);
    }
    // FR-19: apply installs what the last check found — with no check there is
    // nothing to install and nothing to name in the ack.
    let Some(check) = check else {
        return ApplyPlan::Failed(
            "Check for updates before installing one — Francois does not know what to install."
                .into(),
        );
    };
    // FR-18: npm missing from PATH is its own failure, and says so rather than
    // blaming the install method.
    let Some(root) = npm_root else {
        return ApplyPlan::Failed(format!(
            "npm could not be found on PATH, so Francois cannot run `{UPDATE_COMMAND}`."
        ));
    };
    // FR-5 re-run live: only an npm-managed copy can be updated in place.
    let Some(exe) = npm_install_executable(root, current_exe) else {
        return ApplyPlan::Failed(format!(
            "This copy of Francois was not installed through npm, so it cannot update itself. Run `{UPDATE_COMMAND}` to update it."
        ));
    };
    ApplyPlan::Go {
        latest: check.latest.clone(),
        exe,
    }
}

/// francois:app:checkUpdate — one full check, stored wholesale (FR-19).
/// FR-6: an unreachable or unreadable registry resolves `UPDATE_CHECK_FAILED`;
/// the frontend decides whether that is worth showing (FR-7 says the launch
/// check is silent).
#[tauri::command(async)]
pub fn app_check_update(state: State<'_, UpdateState>) -> IpcResult<UpdateCheck> {
    match run_check() {
        Ok(check) => {
            state.store(check.clone());
            ok(check)
        }
        Err(message) => err("UPDATE_CHECK_FAILED", message),
    }
}

/// francois:app:applyUpdate — spawn the relauncher, ack, then quit (FR-16).
///
/// §7: guarded by `UpdateState::begin_apply` — an overlapping second call
/// resolves `UPDATE_APPLY_FAILED` rather than spawning a second helper.
#[tauri::command(async)]
pub fn app_apply_update(
    app: AppHandle,
    engine: State<'_, Engine>,
    state: State<'_, UpdateState>,
) -> IpcResult<UpdateApplyAck> {
    if !state.begin_apply() {
        return err("UPDATE_APPLY_FAILED", "An update is already being applied.");
    }

    // LOCK ORDER (mod.rs): the engine is read FIRST, and its lock is released
    // before the update state is touched — nothing here ever holds both.
    let running = engine.running_count();
    let last = state.last();
    let current_exe = match std::env::current_exe() {
        Ok(p) => p,
        Err(e) => {
            state.end_apply();
            return err(
                "UPDATE_APPLY_FAILED",
                format!("Could not locate the running Francois executable: {e}"),
            );
        }
    };

    match plan_apply(
        running,
        last.as_ref(),
        npm_root_global().as_deref(),
        &current_exe,
    ) {
        ApplyPlan::Blocked(running) => {
            state.end_apply();
            err_detail(
                "UPDATE_BLOCKED",
                format!(
                    "Francois has to quit to update, and {running} session{} still running.",
                    if running == 1 { " is" } else { "s are" }
                ),
                json!({ "running": running }),
            )
        }
        ApplyPlan::Failed(message) => {
            state.end_apply();
            err("UPDATE_APPLY_FAILED", message)
        }
        ApplyPlan::Go { latest, exe } => match start_helper(&app, &latest, &exe) {
            // Deliberately NOT calling `end_apply` here: the ack means shutdown
            // is imminent (FR-16), so the claim outlives this process.
            Ok(ack) => ok(ack),
            // FR-18: the app stays open on every failure of this path.
            Err(message) => {
                state.end_apply();
                err("UPDATE_APPLY_FAILED", message)
            }
        },
    }
}

/// FR-13/FR-15/FR-16: write the helper, spawn it detached, and schedule the
/// shutdown that lets the ack land in the webview first.
fn start_helper(app: &AppHandle, latest: &str, exe: &Path) -> Result<UpdateApplyAck, String> {
    let dir = fresh_helper_dir()
        .map_err(|e| format!("Could not create a directory for the update helper: {e}"))?;
    let files = match write_helper(&dir, std::process::id(), exe) {
        Ok(files) => files,
        Err(e) => {
            std::fs::remove_dir_all(&dir).ok();
            return Err(format!("Could not write the update helper: {e}"));
        }
    };
    let helper_pid = match spawn_helper(&files) {
        Ok(pid) => pid,
        Err(e) => {
            // Nothing is running out of it, so the directory goes with the failure.
            std::fs::remove_dir_all(&dir).ok();
            return Err(e);
        }
    };

    // FR-16: the ack is returned by this call; the exit happens a moment later,
    // on its own thread, so the promise resolves before the window goes.
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(SHUTDOWN_GRACE_MS));
        handle.exit(0);
    });

    Ok(UpdateApplyAck {
        helper_pid,
        latest: latest.to_string(),
        log_path: files.log.to_string_lossy().into_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::super::*;
    use std::path::{Path, PathBuf};

    fn tmp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "francois-apply-{tag}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A fake `npm root -g` naming `exe` as the installed executable.
    fn npm_tree(tag: &str) -> (PathBuf, PathBuf) {
        let root = tmp_root(tag);
        let vendor = root.join("francois").join("vendor");
        std::fs::create_dir_all(&vendor).unwrap();
        let exe = vendor.join("francois.exe");
        std::fs::write(&exe, b"binary").unwrap();
        std::fs::write(
            vendor.join("install.json"),
            format!(
                r#"{{"executable": "{}"}}"#,
                exe.to_string_lossy().replace('\\', "\\\\")
            ),
        )
        .unwrap();
        (root, exe)
    }

    // FR-12: refused while ANY session is running — and the count rides along so
    // the modal can name it. This is the check that actually holds; the frontend's
    // disabled button is only the first line.
    #[test]
    fn running_sessions_block_the_update() {
        let (root, exe) = npm_tree("blocked");
        let check = check_fixture("0.15.8", "0.16.0", METHOD_NPM);
        match plan_apply(2, Some(&check), Some(&root), &exe) {
            ApplyPlan::Blocked(running) => assert_eq!(running, 2),
            other => panic!("expected Blocked, got {other:?}"),
        }
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn an_idle_npm_install_is_cleared_to_update() {
        let (root, exe) = npm_tree("go");
        let check = check_fixture("0.15.8", "0.16.0", METHOD_NPM);
        match plan_apply(0, Some(&check), Some(&root), &exe) {
            ApplyPlan::Go { latest, .. } => assert_eq!(latest, "0.16.0"),
            other => panic!("expected Go, got {other:?}"),
        }
        std::fs::remove_dir_all(&root).ok();
    }

    // FR-18: calling applyUpdate on a manual install resolves UPDATE_APPLY_FAILED.
    #[test]
    fn a_manual_install_cannot_be_applied() {
        let (root, _) = npm_tree("manual");
        let stray_root = tmp_root("stray");
        let stray = stray_root.join("francois.exe");
        std::fs::write(&stray, b"binary").unwrap();
        let check = check_fixture("0.15.8", "0.16.0", METHOD_MANUAL);
        assert!(matches!(
            plan_apply(0, Some(&check), Some(&root), &stray),
            ApplyPlan::Failed(_)
        ));
        std::fs::remove_dir_all(&root).ok();
        std::fs::remove_dir_all(&stray_root).ok();
    }

    // FR-18: npm missing from PATH ⇒ `npm root -g` gives nothing ⇒ failure, and
    // the message says so rather than blaming the install method.
    #[test]
    fn a_missing_npm_fails_the_apply() {
        let check = check_fixture("0.15.8", "0.16.0", METHOD_NPM);
        match plan_apply(0, Some(&check), None, Path::new("/usr/local/bin/francois")) {
            ApplyPlan::Failed(msg) => assert!(msg.contains("npm"), "{msg}"),
            other => panic!("expected Failed, got {other:?}"),
        }
    }

    // FR-19 / §7: apply echoes `latest` from the last check — with no check there
    // is nothing to install and nothing to name.
    #[test]
    fn apply_without_a_prior_check_fails() {
        let (root, exe) = npm_tree("nocheck");
        assert!(matches!(
            plan_apply(0, None, Some(&root), &exe),
            ApplyPlan::Failed(_)
        ));
        std::fs::remove_dir_all(&root).ok();
    }

    // FR-12 is decided BEFORE provenance: a mid-turn session is the thing the user
    // can act on, so it must not be masked by a manual-install failure.
    #[test]
    fn the_running_guard_wins_over_provenance() {
        let check = check_fixture("0.15.8", "0.16.0", METHOD_MANUAL);
        assert!(matches!(
            plan_apply(1, Some(&check), None, Path::new("/usr/local/bin/francois")),
            ApplyPlan::Blocked(1)
        ));
    }

    // FR-16: the ack reaches the webview before the window goes.
    // A compile-time-constant assertion is the POINT here: the test pins an
    // invariant of the constant, so clippy's "this is always true" is the pass.
    #[test]
    #[allow(clippy::assertions_on_constants)]
    fn the_shutdown_grace_is_non_zero() {
        assert!(SHUTDOWN_GRACE_MS > 0);
    }
}
