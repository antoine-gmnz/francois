//! the francois:diff:<verb> Tauri command surface.

use super::*;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::ipc::{err, ok, IpcResult};
use crate::session::Engine;

// ---------- commands (francois:diff:<verb>) ----------

pub(crate) fn cwd_or_err<T: Serialize>(
    engine: &State<'_, Engine>,
    session_id: &str,
) -> Result<String, IpcResult<T>> {
    engine
        .cwd_of(session_id)
        .ok_or_else(|| err("SESSION_NOT_FOUND", "no such session"))
}

/// Run one git step that MUST succeed, mapping both failure modes the way every
/// call site did by hand: a non-zero exit reports git's own stderr, falling back
/// to `fallback` when git said nothing; a spawn failure reports the io error.
/// `Err` carries the message the caller passes to `err("GIT_ERROR", …)`.
fn require_git_ok(
    host: &GitHost,
    root: &str,
    args: &[&str],
    fallback: &str,
) -> Result<GitOut, String> {
    match git_routed(host, root, args) {
        Ok(o) if o.code == 0 => Ok(o),
        Ok(o) => Err(if o.stderr.is_empty() {
            fallback.to_string()
        } else {
            o.stderr
        }),
        Err(e) => Err(e.to_string()),
    }
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
pub async fn diff_get_summary(
    app: AppHandle,
    session_id: String,
    commit: Option<String>,
) -> IpcResult<DiffSummary> {
    let engine = app.state::<Engine>();
    let cwd = match cwd_or_err(&engine, &session_id) {
        Ok(c) => c,
        Err(e) => return e,
    };
    let lock = git_lock(&session_id);
    let _g = lock.lock().unwrap();
    match compute_summary(&cwd, commit.as_deref()) {
        Ok(s) => {
            broadcast(&app, &session_id, s.files.len()); // FR-17 (diff-view)
            ok(s)
        }
        Err((code, msg)) => err(&code, msg),
    }
}

#[tauri::command]
pub async fn diff_get_file_diff(
    app: AppHandle,
    session_id: String,
    path: String,
    commit: Option<String>,
    context: Option<i64>,
) -> IpcResult<FileDiff> {
    let engine = app.state::<Engine>();
    let cwd = match cwd_or_err(&engine, &session_id) {
        Ok(c) => c,
        Err(e) => return e,
    };
    let lock = git_lock(&session_id);
    let _g = lock.lock().unwrap();
    match compute_file_diff(&cwd, &path, commit.as_deref(), clamp_context(context)) {
        Ok(d) => ok(d),
        Err((code, msg)) => err(&code, msg),
    }
}

/// francois:diff:listCommits (diff-review FR-13..17).
#[tauri::command]
pub async fn diff_list_commits(app: AppHandle, session_id: String) -> IpcResult<DiffCommitList> {
    let engine = app.state::<Engine>();
    let cwd = match cwd_or_err(&engine, &session_id) {
        Ok(c) => c,
        Err(e) => return e,
    };
    let host = GitHost::of(&cwd); // wsl-filesystem FR-9: same routing as every other git op
    if !is_git_repo(&host, &cwd) {
        return err("NOT_A_GIT_REPO", NOT_A_REPO_MSG);
    }
    let lock = git_lock(&session_id);
    let _g = lock.lock().unwrap();
    let root = repo_root(&host, &cwd);
    match list_commits(&host, &root) {
        Ok(l) => ok(l),
        Err((code, msg)) => err(&code, msg),
    }
}

/// Pure: the `git commit` argv for `message` + optional `body` + selected
/// `paths` + `amend` (diff-review §5). `amend` adds `--amend`; `body` adds a
/// second `-m` when non-empty; `paths` adds the trailing pathspec only when
/// non-empty — empty paths + amend amends the message alone.
pub(crate) fn commit_args<'a>(
    message: &'a str,
    body: Option<&'a str>,
    paths: &'a [String],
    amend: bool,
) -> Vec<&'a str> {
    let mut args = vec!["commit"];
    if amend {
        args.push("--amend");
    }
    args.push("-m");
    args.push(message);
    if let Some(b) = body {
        if !b.is_empty() {
            args.push("-m");
            args.push(b);
        }
    }
    if !paths.is_empty() {
        args.push("--");
        args.extend(paths.iter().map(|p| p.as_str()));
    }
    args
}

/// francois:diff:commit (diff-review FR-37/38/39; stageAll deleted, FR-43).
#[tauri::command]
pub async fn diff_commit(
    app: AppHandle,
    session_id: String,
    message: String,
    body: Option<String>,
    paths: Vec<String>,
    amend: bool,
) -> IpcResult<CommitResult> {
    let engine = app.state::<Engine>();
    let cwd = match cwd_or_err(&engine, &session_id) {
        Ok(c) => c,
        Err(e) => return e,
    };
    let message = message.trim().to_string();
    if message.is_empty() {
        return err("INVALID_INPUT", "commit message is empty");
    }
    if paths.is_empty() && !amend {
        return err("INVALID_INPUT", "no paths selected to commit"); // FR-43
    }
    let host = GitHost::of(&cwd); // wsl-filesystem FR-9: same routing as every other git op
    if !is_git_repo(&host, &cwd) {
        return err("NOT_A_GIT_REPO", NOT_A_REPO_MSG);
    }
    let lock = git_lock(&session_id);
    let _g = lock.lock().unwrap();
    let root = repo_root(&host, &cwd);

    if amend && diff_base(&host, &root) != "HEAD" {
        return err("DIFF_NOTHING_TO_AMEND", "no commit on this branch to amend");
        // FR-39
    }

    if !paths.is_empty() {
        // Stage exactly the chosen paths first so untracked files and deletions
        // are picked up (`git add -- <paths>`); the path-scoped commit below
        // records only them. `git add` succeeds with a no-op when a path has
        // nothing to stage.
        let mut add = vec!["add", "--"];
        add.extend(paths.iter().map(|p| p.as_str()));
        if let Err(message) = require_git_ok(&host, &root, &add, "git add failed") {
            return err("GIT_ERROR", message);
        }
    }

    let body = body.filter(|b| !b.trim().is_empty());
    let args = commit_args(&message, body.as_deref(), &paths, amend);
    if let Err(message) = require_git_ok(&host, &root, &args, "git commit failed") {
        return err("GIT_ERROR", message);
    }
    match git_routed(&host, &root, &["rev-parse", "HEAD"]) {
        Ok(o) if o.code == 0 => ok(CommitResult {
            commit_hash: String::from_utf8_lossy(&o.stdout).trim().to_string(),
        }),
        _ => ok(CommitResult {
            commit_hash: String::new(),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commit_args_plain_commit_pins_the_selected_paths() {
        let paths = vec!["src/a.ts".to_string(), "b.rs".to_string()];
        assert_eq!(
            commit_args("msg", None, &paths, false),
            vec!["commit", "-m", "msg", "--", "src/a.ts", "b.rs"]
        );
    }

    #[test]
    fn commit_args_includes_the_body_as_a_second_dash_m() {
        let paths = vec!["a.ts".to_string()];
        assert_eq!(
            commit_args("subject", Some("extended body"), &paths, false),
            vec![
                "commit",
                "-m",
                "subject",
                "-m",
                "extended body",
                "--",
                "a.ts"
            ]
        );
    }

    #[test]
    fn commit_args_amend_adds_the_flag_and_still_scopes_to_paths() {
        let paths = vec!["a.ts".to_string()];
        assert_eq!(
            commit_args("msg", None, &paths, true),
            vec!["commit", "--amend", "-m", "msg", "--", "a.ts"]
        );
    }

    #[test]
    fn commit_args_amend_with_no_paths_amends_the_message_alone() {
        assert_eq!(
            commit_args("msg", None, &[], true),
            vec!["commit", "--amend", "-m", "msg"]
        );
    }

    #[test]
    fn commit_args_empty_body_is_not_passed_as_a_second_dash_m() {
        let paths = vec!["a.ts".to_string()];
        assert_eq!(
            commit_args("msg", Some(""), &paths, false),
            vec!["commit", "-m", "msg", "--", "a.ts"]
        );
    }
}
