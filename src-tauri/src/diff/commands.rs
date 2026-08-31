//! the francois:diff:<verb> Tauri command surface.

use super::*;
use crate::ipc::{AppError, ErrorCode};

use tauri::{AppHandle, Manager, State};

use crate::ipc::IpcResult;
use crate::session::Engine;

// ---------- commands (francois:diff:<verb>) ----------

/// core-architecture-wave3 FR-6: `Result<String, AppError>` rather than the
/// `Result<String, IpcResult<T>>` this used to return. The old shape existed
/// only so a caller could `return e` straight out of a command body; with the
/// bodies converting through `.into()` the error type no longer has to know
/// what envelope it will end up in, and the `T` parameter disappears with it.
pub fn cwd_or_err(engine: &State<'_, Engine>, session_id: &str) -> Result<String, AppError> {
    engine
        .cwd_of(session_id)
        .ok_or_else(|| AppError::new(ErrorCode::SessionNotFound, "no such session"))
}

/// Run one git step that MUST succeed, mapping both failure modes the way every
/// call site did by hand: a non-zero exit reports git's own stderr, falling back
/// to `fallback` when git said nothing; a spawn failure reports the io error.
/// `Err` carries the message the caller passes to `err(ErrorCode::GitError, …)`.
///
/// Only for steps where exit 0 means success. Two git calls in this file
/// deliberately do NOT use it, because for them exit 0 is not success:
/// `diff --cached --quiet` (exit 0 means nothing is staged — an error, FR-11)
/// and `rev-parse HEAD` (a failure is tolerated and yields an empty hash).
fn require_git_ok(
    host: &GitHost,
    root: &str,
    args: &[&str],
    fallback: &str,
) -> Result<GitOut, AppError> {
    match git_routed(host, root, args) {
        Ok(o) if o.code == 0 => Ok(o),
        Ok(o) => Err(git_error(if o.stderr.is_empty() {
            fallback.to_string()
        } else {
            o.stderr
        })),
        Err(e) => Err(git_error(e.to_string())),
    }
}

/// core-architecture-wave3 FR-6: GIT_ERROR is what every call site above
/// stamped on these messages by hand.
fn git_error(message: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::GitError, message)
}

// All diff commands are `async` so Tauri executes them on the async runtime — a
// SYNC command runs on the MAIN thread (Tauri 2), where every git spawn and every
// git-lock wait freezes the entire app (window moves, all panes, all IPC). With
// changes present, a background recompute holds the session git lock while the
// frontend refetches → the sync command blocked the main thread on that lock for
// the full multi-spawn summary. Bodies stay synchronous; parking a runtime worker
// on a git call is fine. Engine is resolved via `app.state()` instead of a
// `State<'_, Engine>` parameter: an async command's future must be 'static, and a
// borrowed State param breaks that (E0597 in the generated handler).
#[tauri::command]
pub async fn diff_get_summary(app: AppHandle, session_id: String) -> IpcResult<DiffSummary> {
    get_summary(&app, &session_id).into()
}

fn get_summary(app: &AppHandle, session_id: &str) -> Result<DiffSummary, AppError> {
    let engine = app.state::<Engine>();
    let cwd = cwd_or_err(&engine, session_id)?;
    let lock = git_lock(session_id);
    let _g = lock.lock().unwrap();
    let summary = compute_summary(&cwd)?;
    broadcast(app, session_id, summary.files.len()); // FR-17
    Ok(summary)
}

#[tauri::command]
pub async fn diff_get_file_diff(
    app: AppHandle,
    session_id: String,
    path: String,
) -> IpcResult<FileDiff> {
    get_file_diff(&app, &session_id, &path).into()
}

fn get_file_diff(app: &AppHandle, session_id: &str, path: &str) -> Result<FileDiff, AppError> {
    let engine = app.state::<Engine>();
    let cwd = cwd_or_err(&engine, session_id)?;
    let lock = git_lock(session_id);
    let _g = lock.lock().unwrap();
    compute_file_diff(&cwd, path)
}

#[tauri::command]
pub async fn diff_stage_all(app: AppHandle, session_id: String) -> IpcResult<Option<()>> {
    stage_all(&app, &session_id).into()
}

fn stage_all(app: &AppHandle, session_id: &str) -> Result<Option<()>, AppError> {
    let engine = app.state::<Engine>();
    let cwd = cwd_or_err(&engine, session_id)?;
    let host = GitHost::of(&cwd); // wsl-filesystem FR-9: same routing as every other git op
    if !is_git_repo(&host, &cwd) {
        return Err(AppError::new(ErrorCode::NotAGitRepo, NOT_A_REPO_MSG));
    }
    let lock = git_lock(session_id);
    let _g = lock.lock().unwrap();
    let root = repo_root(&host, &cwd);
    require_git_ok(&host, &root, &["add", "-A"], "git add failed")?;
    Ok(None) // succeeds even with nothing to stage (FR-10)
}

/// Pure: the `git commit` argv for `message` + selected `paths`. With no paths we
/// commit whatever is already in the index (legacy stage-all flow). With paths we
/// pin the commit to exactly those files — `git commit -m <msg> -- <paths…>` — so
/// anything else already staged is left in the index, not committed.
pub fn commit_args<'a>(message: &'a str, paths: &'a [String]) -> Vec<&'a str> {
    let mut args = vec!["commit", "-m", message];
    if !paths.is_empty() {
        args.push("--");
        args.extend(paths.iter().map(|p| p.as_str()));
    }
    args
}

#[tauri::command]
pub async fn diff_commit(
    app: AppHandle,
    session_id: String,
    message: String,
    paths: Vec<String>,
) -> IpcResult<CommitResult> {
    commit(&app, &session_id, &message, &paths).into()
}

fn commit(
    app: &AppHandle,
    session_id: &str,
    message: &str,
    paths: &[String],
) -> Result<CommitResult, AppError> {
    let engine = app.state::<Engine>();
    let cwd = cwd_or_err(&engine, session_id)?;
    if message.trim().is_empty() {
        // defense in depth (FR-24)
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "commit message is empty",
        ));
    }
    let host = GitHost::of(&cwd); // wsl-filesystem FR-9: same routing as every other git op
    if !is_git_repo(&host, &cwd) {
        return Err(AppError::new(ErrorCode::NotAGitRepo, NOT_A_REPO_MSG));
    }
    let lock = git_lock(session_id);
    let _g = lock.lock().unwrap();
    let root = repo_root(&host, &cwd);

    let message = message.trim();
    if paths.is_empty() {
        // Legacy flow: commit the current index. Guard nothing-staged (FR-11) —
        // `git diff --cached --quiet` exits 0 when the index is empty.
        match git_routed(&host, &root, &["diff", "--cached", "--quiet"]) {
            Ok(o) if o.code == 0 => {
                return Err(git_error("nothing staged to commit — stage changes first"))
            }
            Ok(_) => {}
            Err(e) => return Err(git_error(e.to_string())),
        }
    } else {
        // Selected-files flow: stage exactly the chosen paths first so untracked
        // files and deletions are picked up (`git add -- <paths>`), then the
        // path-scoped commit below records only them. `git add` succeeds with a
        // no-op when a path has nothing to stage.
        let mut add = vec!["add", "--"];
        add.extend(paths.iter().map(|p| p.as_str()));
        require_git_ok(&host, &root, &add, "git add failed")?;
    }

    // FR-9: commit identity/hooks are the distro's own git config for WSL repos
    // (documented, not managed — spec §4). With paths, git itself errors if none of
    // the selected files have anything to commit.
    require_git_ok(
        &host,
        &root,
        &commit_args(message, paths),
        "git commit failed",
    )?;
    Ok(match git_routed(&host, &root, &["rev-parse", "HEAD"]) {
        Ok(o) if o.code == 0 => CommitResult {
            commit_hash: String::from_utf8_lossy(&o.stdout).trim().to_string(),
        },
        _ => CommitResult {
            commit_hash: String::new(),
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commit_args_no_paths_commits_the_index() {
        // Empty selection → legacy flow: commit whatever is staged, no pathspec.
        assert_eq!(commit_args("msg", &[]), vec!["commit", "-m", "msg"]);
    }

    #[test]
    fn commit_args_pins_the_commit_to_selected_paths() {
        // Selected files → path-scoped commit so other staged changes are left alone.
        let paths = vec!["src/a.ts".to_string(), "b.rs".to_string()];
        assert_eq!(
            commit_args("msg", &paths),
            vec!["commit", "-m", "msg", "--", "src/a.ts", "b.rs"]
        );
    }
}
