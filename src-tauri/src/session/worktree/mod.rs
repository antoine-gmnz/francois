//! the session-worktree domain (specs/session-worktree.md): "isolate in
//! worktree" session creation, the probe/status/remove commands, and the pure
//! FR-9 path helpers. Every git invocation routes through
//! `crate::diff::git_routed` with the `GitHost` derived once from the raw
//! session cwd (FR-10), exactly like the `diff` domain. Git-shell helpers
//! (things that actually spawn `git`/`wsl.exe`) live in `git.rs` — this file
//! owns the serialized shapes, the pure FR-9 path helpers, and the command
//! handlers (quality remediation, §Conventions ~1000-line cap).

use super::*;

use crate::diff::{git_routed, is_git_repo, repo_root, GitHost};
use crate::ipc::{err, ok, IpcResult};
use serde::{Deserialize, Serialize};
use tauri::State;

mod git;
pub(crate) use git::path_exists;
use git::{
    branch_checked_out_at, branch_exists, check_ref_format, compute_status, current_branch,
    default_branch, fetch_with_timeout, in_use_path_from_stderr, norm_path, remote_name,
    worktree_list_entries,
};

const NOT_A_REPO_MSG: &str = "not a git repository — initialize with `git init` in the shell";

// ---------- serialized public shapes (contract/common.ts, contract/session-worktree.ts) ----------

/// Worktree provenance for a session created with isolation (FR-12). Mirrors
/// contract/common.ts `SessionWorktree` exactly.
#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionWorktree {
    pub(crate) branch: String,
    pub(crate) base_ref: String,
    pub(crate) path: String,
    pub(crate) source_repo_root: String,
    pub(crate) created_branch: bool,
    pub(crate) fetched: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) fetch_error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeProbeData {
    is_repo: bool,
    repo_root: Option<String>,
    default_branch: Option<String>,
    current_branch: Option<String>,
    remote: Option<String>,
    branch_exists: bool,
    branch_checked_out_at: Option<String>,
    worktree_path: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeStatusData {
    dirty: bool,
    dirty_count: u32,
    unpushed: bool,
    unpushed_count: u32,
    upstream: Option<String>,
}

/// Added to `SessionCreateInput` (contract/session-worktree.ts `WorktreeCreateOptions`).
///
/// LOW remediation: `baseRef` is a REQUIRED string in the contract (only `adopt`
/// is optional), so it carries NO `#[serde(default)]` — an omitted field must
/// fail deserialization instead of coercing to `""`, which `probe_branch`'s
/// blank check only catches on the new-branch path (the branch-exists path
/// ignores `base_ref` per FR-8 and would swallow the client's violation).
#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeCreateInput {
    pub branch: String,
    pub base_ref: String,
    #[serde(default)]
    pub adopt: bool,
}

// ---------- FR-9: pure slug + path helpers (must match contract/session-worktree.ts byte-for-byte) ----------

/// FR-9's placeholder for a branch whose slug collapses to the empty string.
/// Mirrors `WORKTREE_SLUG_FALLBACK` in contract/session-worktree.ts.
pub(crate) const WORKTREE_SLUG_FALLBACK: &str = "branch";

/// FR-9's slug: lowercase, every char outside `[a-z0-9._-]` -> `-`, runs
/// collapsed, leading/trailing trimmed, truncated to 60 chars (trailing dashes
/// trimmed again after truncation), and `WORKTREE_SLUG_FALLBACK` when nothing
/// survives (a purely non-ASCII branch such as `功能/新分支` — without the
/// placeholder the worktree would land on the parent directory itself rather
/// than a named child). Mirrors `worktreeSlug` in contract/session-worktree.ts
/// exactly — both are tested against the same table.
pub(crate) fn worktree_slug(branch: &str) -> String {
    let lower = branch.to_lowercase();
    let mut replaced = String::with_capacity(lower.len());
    for c in lower.chars() {
        if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
            replaced.push(c);
        } else {
            replaced.push('-');
        }
    }
    let mut collapsed = String::with_capacity(replaced.len());
    let mut prev_dash = false;
    for c in replaced.chars() {
        if c == '-' {
            if !prev_dash {
                collapsed.push('-');
            }
            prev_dash = true;
        } else {
            collapsed.push(c);
            prev_dash = false;
        }
    }
    let trimmed = collapsed.trim_matches('-');
    let mut truncated: String = trimmed.chars().take(60).collect();
    while truncated.ends_with('-') {
        truncated.pop();
    }
    if truncated.is_empty() {
        return WORKTREE_SLUG_FALLBACK.to_string();
    }
    truncated
}

fn path_sep(p: &str) -> char {
    if p.contains('\\') && !p.contains('/') {
        '\\'
    } else {
        '/'
    }
}

/// Splits `p` into (dirname, basename) using the separator FR-9's preview
/// infers from `p` itself — mirrors `previewWorktreePath`'s split.
fn split_dir_base(p: &str) -> (String, String) {
    let sep = path_sep(p);
    let trimmed = p.strip_suffix(sep).unwrap_or(p);
    match trimmed.rfind(['/', '\\']) {
        Some(i) => (trimmed[..i].to_string(), trimmed[i + 1..].to_string()),
        None => (trimmed.to_string(), trimmed.to_string()),
    }
}

/// FR-9's target directory (before the exists-suffix loop):
/// `<dirname(repoRoot)>/.francois-worktrees/<basename(repoRoot)>/<slug>`.
fn worktree_target(repo_root: &str, branch: &str) -> (String, char) {
    let (dirname, basename) = split_dir_base(repo_root);
    let sep = path_sep(repo_root);
    let slug = worktree_slug(branch);
    (
        [dirname, ".francois-worktrees".to_string(), basename, slug].join(&sep.to_string()),
        sep,
    )
}

/// FR-9: append `-2`, `-3`, … until `exists` reports free. Pure — the exists
/// probe is injected so the suffix search itself is unit-testable without a
/// filesystem/wsl.exe round trip.
pub(crate) fn suffix_until_free(base: &str, exists: impl Fn(&str) -> bool) -> String {
    if !exists(base) {
        return base.to_string();
    }
    for i in 2.. {
        let candidate = format!("{base}-{i}");
        if !exists(&candidate) {
            return candidate;
        }
    }
    unreachable!()
}

/// session-worktree FR-10: the stored-on-`Session` form of a `GitHost` — `None`
/// for `Native`, `Some(distro)` for `Wsl(distro)`. The inverse of
/// `host_from_distro`, used to snapshot the host resolved once at creation so
/// later git-routing / turn-spawn call sites never re-derive it from `cwd`.
pub(crate) fn host_distro(host: &GitHost) -> Option<String> {
    match host {
        GitHost::Native => None,
        GitHost::Wsl(distro) => Some(distro.clone()),
    }
}

/// The inverse of `host_distro`: reconstructs the `GitHost` a session was
/// created under from its stored `worktree_distro`, rather than re-deriving it
/// from `cwd`/`worktree.path` — which, once `cwd` is a bare Linux path (no
/// `\\wsl$\<distro>\…` prefix), `GitHost::of` can no longer recognize as `Wsl`.
pub(crate) fn host_from_distro(distro: &Option<String>) -> GitHost {
    match distro {
        Some(d) => GitHost::Wsl(d.clone()),
        None => GitHost::Native,
    }
}

/// Resolves the `GitHost` to route a `session:create` cwd through, accounting
/// for the ONE case where the cwd itself is a bare Linux path with no
/// `\\wsl$\<distro>\…` prefix for `GitHost::of` to key on: the FR-5 "already
/// checked out" recovery flow, whose `cwd` is `probe.branchCheckedOutAt` —
/// itself read back from `git worktree list --porcelain`'s own (Linux-dialect)
/// stdout when the source repo lives in WSL. `adopt` is the only `session:create`
/// path that can ever receive such a cwd (a freshly typed/picked cwd is always
/// in the host-native form), so route it at the WSL default distro — the same
/// fallback `wsl::wsl_distro_name` uses for a non-UNC cwd — rather than
/// misclassifying it as `Native` and failing every existence/git check against
/// a Windows path that was never valid.
pub(crate) fn adopt_host(cwd: &str, adopt: bool) -> GitHost {
    if adopt && !std::path::Path::new(cwd).is_absolute() && !crate::wsl::is_wsl_unc_path(cwd) {
        if let Some(distro) = crate::wsl::wsl_distro_name(cwd) {
            return GitHost::Wsl(distro);
        }
    }
    GitHost::of(cwd)
}

fn compute_worktree_path(host: &GitHost, repo_root: &str, branch: &str) -> String {
    let (base, _sep) = worktree_target(repo_root, branch);
    suffix_until_free(&base, |p| path_exists(host, p))
}

// ---------- FR-6/FR-8/FR-11/FR-12: the creation/adopt flow (called from session_create) ----------

/// The branch state as it is RIGHT NOW, re-read before each git mutation:
/// `Ok(true)` when the branch exists locally and is free, `Ok(false)` when it
/// does not exist yet (and `base_ref` can create it).
///
/// FR-5/§7: the branch may be created, deleted, or checked out in another
/// worktree at any moment, so this is called both before the prune and again
/// after the (up to 20s) fetch — a race that opens inside the fetch window must
/// still surface `WORKTREE_BRANCH_IN_USE` (whose message carries the holding
/// path for the recovery offer), never an opaque create failure.
fn probe_branch(
    host: &GitHost,
    source_repo_root: &str,
    branch: &str,
    base_ref: &str,
) -> Result<bool, (String, String)> {
    if let Some(path) = branch_checked_out_at(host, source_repo_root, branch) {
        return Err(("WORKTREE_BRANCH_IN_USE".into(), path));
    }
    let exists = branch_exists(host, source_repo_root, branch);
    // LOW remediation: a blank `base_ref` would pass straight to `git worktree
    // add -b <branch> <path> ""`, producing an opaque git error. Only meaningful
    // for a NEW branch — an existing branch ignores `base_ref` entirely (FR-8).
    if !exists && base_ref.trim().is_empty() {
        return Err(("INVALID_INPUT".into(), "base ref is empty".into()));
    }
    Ok(exists)
}

/// Resolves a `worktree` request against the given (source) `cwd` into the
/// SESSION's actual working directory + its `SessionWorktree` provenance.
/// `adopt` performs NO git mutation (FR-5/FR-12); otherwise runs prune -> fetch
/// (best-effort) -> add (FR-6), reversing what it did on failure (FR-11).
pub(crate) fn resolve_worktree(
    cwd: &str,
    opts: &WorktreeCreateInput,
) -> Result<(String, SessionWorktree, Option<String>), (String, String)> {
    let host = adopt_host(cwd, opts.adopt);

    if opts.adopt {
        if !is_git_repo(&host, cwd) {
            return Err(("NOT_A_GIT_REPO".into(), NOT_A_REPO_MSG.into()));
        }
        let entries = worktree_list_entries(&host, cwd);
        let source_root = entries
            .first()
            .map(|e| e.path.clone())
            .unwrap_or_else(|| repo_root(&host, cwd));
        // MEDIUM remediation: no matching `git worktree list` entry (or a match
        // with no branch checked out — a detached HEAD) means there is nothing
        // real to adopt at `cwd` — error rather than fabricate provenance from
        // `opts.branch`/`repo_root`, which the caller never asked to be trusted.
        let Some(target) = entries
            .iter()
            .find(|e| norm_path(&e.path) == norm_path(cwd))
        else {
            return Err((
                "INVALID_INPUT".into(),
                "no worktree is registered at that path".into(),
            ));
        };
        let Some(branch) = target.branch.clone() else {
            return Err((
                "INVALID_INPUT".into(),
                "that worktree has no branch checked out".into(),
            ));
        };
        let sw = SessionWorktree {
            branch,
            base_ref: opts.base_ref.clone(),
            path: cwd.to_string(),
            source_repo_root: source_root,
            created_branch: false,
            fetched: false,
            fetch_error: None,
        };
        return Ok((cwd.to_string(), sw, host_distro(&host)));
    }

    if !is_git_repo(&host, cwd) {
        return Err(("NOT_A_GIT_REPO".into(), NOT_A_REPO_MSG.into()));
    }
    let branch = opts.branch.trim();
    if branch.is_empty() {
        return Err(("INVALID_INPUT".into(), "branch is empty".into()));
    }
    check_ref_format(&host, cwd, branch).map_err(|m| ("INVALID_INPUT".to_string(), m))?;
    // security: `check-ref-format --branch` does NOT reject a leading `-` (it is
    // a syntactically legal ref character) — but `branch` is passed as the LAST
    // positional argument to `git worktree add <path> <branch>` / `git branch -D
    // <branch>` below, so a value like `--force` would be parsed by git as an
    // option rather than a branch name. Reject it explicitly, the same class of
    // fix as `base_ref` just below.
    if branch.starts_with('-') {
        return Err((
            "INVALID_INPUT".into(),
            "branch must not start with '-'".into(),
        ));
    }
    // security: `opts.base_ref` is passed as a positional revision to `git
    // worktree add -b <branch> <path> <baseRef>` below — a value starting with
    // `-` would be parsed by git as an option rather than a revision. Reject it
    // the same way an invalid `branch` is rejected above.
    if opts.base_ref.starts_with('-') {
        return Err((
            "INVALID_INPUT".into(),
            "base ref must not start with '-'".into(),
        ));
    }
    let source_repo_root = repo_root(&host, cwd);

    // FR-6: prune stale admin entries first.
    match git_routed(&host, &source_repo_root, &["worktree", "prune"]) {
        Ok(o) if o.code == 0 => {}
        Ok(o) => {
            return Err((
                "WORKTREE_CREATE_FAILED".into(),
                if o.stderr.is_empty() {
                    "git worktree prune failed".into()
                } else {
                    o.stderr
                },
            ))
        }
        Err(e) => return Err(("WORKTREE_CREATE_FAILED".into(), e.to_string())),
    }

    // FR-5/§7, first window: refuse straight away if the branch is already held
    // elsewhere — no point spending the fetch budget on a create that cannot
    // succeed. The result is re-derived after the fetch, so it is dropped here.
    probe_branch(&host, &source_repo_root, branch, &opts.base_ref)?;

    // FR-7: best-effort fetch.
    // CRITICAL remediation: `remote_name` reflects back whatever section name
    // appears in a (possibly attacker-controlled, e.g. an adopted/hostile
    // repo's) `.git/config` — a remote literally named `--upload-pack=...`
    // would be parsed by `git fetch` as an option rather than a remote. Treat
    // a leading `-` as "no usable remote" rather than passing it through, the
    // same class of fix as `branch`/`base_ref` above.
    let remote = remote_name(&host, &source_repo_root).filter(|r| !r.starts_with('-'));
    let (fetched, fetch_error) = match &remote {
        None => (false, None),
        Some(r) => match fetch_with_timeout(&host, &source_repo_root, r) {
            Ok(()) => (true, None),
            Err(e) => (false, Some(e)),
        },
    };

    // MEDIUM remediation: probe the branch AGAIN, now that the fetch is done.
    // The fetch above may have blocked for up to `FETCH_TIMEOUT` (20s), and the
    // §7 race — the branch getting checked out in another worktree between our
    // probe and the create — is far likelier to open during that window than in
    // the microseconds before it. Without this second probe such a race lands on
    // git's own refusal and reports the generic WORKTREE_CREATE_FAILED instead
    // of the FR-5 WORKTREE_BRANCH_IN_USE recovery offer (+ `detail: { path }`).
    // Re-derives `exists` too: the branch may equally have been created or
    // deleted while we fetched, which flips FR-8's add form.
    let exists = probe_branch(&host, &source_repo_root, branch, &opts.base_ref)?;

    let worktree_path = compute_worktree_path(&host, &source_repo_root, branch);

    // FR-8: `-b <branch> <path> <baseRef>` for a new branch, `<path> <branch>`
    // (baseRef ignored) for an existing one.
    let add_result = if exists {
        git_routed(
            &host,
            &source_repo_root,
            &["worktree", "add", &worktree_path, branch],
        )
    } else {
        git_routed(
            &host,
            &source_repo_root,
            &[
                "worktree",
                "add",
                "-b",
                branch,
                &worktree_path,
                &opts.base_ref,
            ],
        )
    };
    match add_result {
        Ok(o) if o.code == 0 => {}
        Ok(o) => {
            // The §7 race can never be fully closed by probing — it can also open
            // between `probe_branch` and this very call. git's own refusal names
            // the holding worktree, so remap it to the FR-5 recovery offer rather
            // than an opaque failure. git refuses before creating anything here,
            // and the branch belongs to somebody else, so the reversal must never
            // delete a branch (`created_branch: false`).
            if let Some(path) = in_use_path_from_stderr(&o.stderr) {
                reverse_create(&host, &source_repo_root, &worktree_path, branch, false);
                return Err(("WORKTREE_BRANCH_IN_USE".into(), path));
            }
            reverse_create(&host, &source_repo_root, &worktree_path, branch, !exists);
            return Err((
                "WORKTREE_CREATE_FAILED".into(),
                if o.stderr.is_empty() {
                    "git worktree add failed".into()
                } else {
                    o.stderr
                },
            ));
        }
        Err(e) => {
            reverse_create(&host, &source_repo_root, &worktree_path, branch, !exists);
            return Err(("WORKTREE_CREATE_FAILED".into(), e.to_string()));
        }
    }

    seed_worktree_consent(&source_repo_root, &worktree_path);

    Ok((
        worktree_path.clone(),
        SessionWorktree {
            branch: branch.to_string(),
            base_ref: opts.base_ref.clone(),
            path: worktree_path,
            source_repo_root,
            created_branch: !exists,
            fetched,
            fetch_error,
        },
        host_distro(&host),
    ))
}

/// Carry the source checkout's MCP consent (`.claude/settings.local.json`
/// consent keys — see mcp_approval's `seed_settings_consent`) into a freshly
/// created worktree, which starts without the gitignored file and would
/// otherwise re-ask about every server the user already decided on. Best-effort
/// end to end: an unreadable source or target, or a failed write, must never
/// fail the worktree creation it rides on — the worktree is fully usable
/// without the seed, just noisier.
fn seed_worktree_consent(source_repo_root: &str, worktree_path: &str) {
    use crate::permissions::{local_settings_path, read_json_object, write_json_atomic};
    let Ok(source) = read_json_object(&local_settings_path(source_repo_root)) else {
        return;
    };
    let target_path = local_settings_path(worktree_path);
    let Ok(mut target) = read_json_object(&target_path) else {
        return;
    };
    if crate::session::mcp_approval::seed_settings_consent(&source, &mut target) {
        if let Err(e) = write_json_atomic(&target_path, &target) {
            eprintln!("session-worktree: consent seed failed: {e}");
        }
    }
}

/// FR-11: best-effort reversal of a failed `worktree add` — `git worktree
/// remove --force` on the path it tried to create, and (only when THIS call
/// would have created the branch) `git branch -D` on it. Failures are logged,
/// never surfaced (a reversal failure must not shadow the original error).
fn reverse_create(host: &GitHost, repo_root: &str, path: &str, branch: &str, created_branch: bool) {
    if let Err(e) = git_routed(host, repo_root, &["worktree", "remove", "--force", path]) {
        eprintln!("session-worktree: reversal `worktree remove --force` failed: {e}");
    }
    if created_branch {
        if let Err(e) = git_routed(host, repo_root, &["branch", "-D", branch]) {
            eprintln!("session-worktree: reversal `branch -D` failed: {e}");
        }
    }
}

// ---------- commands (francois:session:<verb>) ----------

/// francois:session:worktreeProbe (FR-1/FR-2/FR-4/FR-5). A non-repo cwd
/// resolves `ok:true` with `isRepo:false` — never an error.
#[tauri::command(async)]
pub fn session_worktree_probe(cwd: String, branch: Option<String>) -> IpcResult<WorktreeProbeData> {
    // contract/session-worktree.ts documents INVALID_INPUT as covering "cwd not
    // absolute / not a directory" — a relative native path (e.g. "..\\x") is
    // never rejected by `is_dir()` alone, since it resolves against whatever the
    // process cwd happens to be. A WSL UNC path (`\\wsl$\<distro>\…` /
    // `\\wsl.localhost\<distro>\…`) is absolute by construction.
    if !std::path::Path::new(&cwd).is_absolute() && !crate::wsl::is_wsl_unc_path(&cwd) {
        return err("INVALID_INPUT", "cwd must be an absolute path");
    }
    match std::fs::metadata(&cwd) {
        Ok(m) if m.is_dir() => {}
        _ => return err("INVALID_INPUT", "cwd does not exist or is not a directory"),
    }
    let host = GitHost::of(&cwd);
    if !is_git_repo(&host, &cwd) {
        return ok(WorktreeProbeData {
            is_repo: false,
            repo_root: None,
            default_branch: None,
            current_branch: None,
            remote: None,
            branch_exists: false,
            branch_checked_out_at: None,
            worktree_path: None,
        });
    }
    let repo_root_path = repo_root(&host, &cwd);
    let remote = remote_name(&host, &repo_root_path);
    let default = default_branch(&host, &repo_root_path, remote.as_deref());
    let current = current_branch(&host, &cwd);
    let (exists, checked_out_at, worktree_path) = match branch.as_deref().map(str::trim) {
        Some(b) if !b.is_empty() => {
            let exists = branch_exists(&host, &repo_root_path, b);
            let at = exists
                .then(|| branch_checked_out_at(&host, &repo_root_path, b))
                .flatten();
            (
                exists,
                at,
                Some(compute_worktree_path(&host, &repo_root_path, b)),
            )
        }
        _ => (false, None, None),
    };
    ok(WorktreeProbeData {
        is_repo: true,
        repo_root: Some(repo_root_path),
        default_branch: Some(default),
        current_branch: current,
        remote,
        branch_exists: exists,
        branch_checked_out_at: checked_out_at,
        worktree_path,
    })
}

/// francois:session:worktreeStatus (FR-18). Split from the `#[tauri::command]`
/// wrapper so the SESSION_NOT_FOUND / WORKTREE_NOT_FOUND branches are directly
/// unit-testable against a plain `Engine` (built via `testutil::test_engine_with`)
/// without a live Tauri `State`.
pub(crate) fn worktree_status_impl(
    engine: &Engine,
    session_id: &str,
) -> IpcResult<WorktreeStatusData> {
    let (path, base_ref, created_branch, distro) = {
        let map = engine.sessions.lock().unwrap();
        let Some(s) = map.get(session_id) else {
            return err("SESSION_NOT_FOUND", "no such session");
        };
        let Some(wt) = &s.worktree else {
            return err("WORKTREE_NOT_FOUND", "session has no worktree");
        };
        (
            wt.path.clone(),
            wt.base_ref.clone(),
            wt.created_branch,
            s.worktree_distro.clone(),
        )
    };
    // FR-10: reuse the host stored at creation — `GitHost::of(&path)` would
    // misclassify a WSL worktree as Native once `path` is a bare Linux path.
    let host = host_from_distro(&distro);
    if !path_exists(&host, &path) {
        return err(
            "WORKTREE_NOT_FOUND",
            "the worktree directory no longer exists",
        );
    }
    // base_ref is only reliable when THIS session created the branch off it;
    // for an adopted/existing-branch worktree it's meaningless (see
    // compute_status's fail-safe doc comment).
    let base_ref = created_branch.then_some(base_ref);
    match compute_status(&host, &path, base_ref.as_deref()) {
        Ok(data) => ok(data),
        Err((code, msg)) => err(&code, msg),
    }
}

#[tauri::command(async)]
pub fn session_worktree_status(
    engine: State<'_, Engine>,
    session_id: String,
) -> IpcResult<WorktreeStatusData> {
    worktree_status_impl(&engine, &session_id)
}

/// FR-19's human reason for a blocked removal (also what the frontend renders
/// next to the disabled "remove the worktree" checkbox).
///
/// MEDIUM remediation: `unpushed: true` with `unpushed_count: 0` is the
/// contract's sentinel for "push status could NOT be determined" (no upstream
/// and no reliable base ref — e.g. an adopted worktree), not "zero commits
/// ahead". Formatting it as `0 commits not pushed` misrepresented the cause, so
/// that case gets its own wording. Pure; unit-tested.
///
/// LOW remediation: `compute_status` also raises that sentinel when an upstream
/// IS configured but `git rev-list <upstream>..HEAD` itself failed. The sentinel
/// shape is the contract's and stays untouched — but the wording must branch on
/// `upstream` rather than blame a missing one that is plainly there.
fn removal_block_reason(status: &WorktreeStatusData) -> String {
    let pushed_part = (status.unpushed_count > 0)
        .then(|| format!("{} commits not pushed", status.unpushed_count))
        .unwrap_or_else(|| match &status.upstream {
            Some(u) => format!("push status unknown — could not compare with {u}"),
            None => "push status unknown — no upstream configured".to_string(),
        });
    match (status.dirty, status.unpushed) {
        (true, true) => format!("{} uncommitted files, {pushed_part}", status.dirty_count),
        (true, false) => format!("{} uncommitted files", status.dirty_count),
        _ => pushed_part,
    }
}

/// francois:session:worktreeRemove (FR-19/FR-20). NEVER `--force`, NEVER
/// deletes the branch. Does not touch the session registry — that is
/// `session_remove`'s job; the frontend orchestrates both per its confirm step.
/// Split from the `#[tauri::command]` wrapper for the same testability reason
/// as `worktree_status_impl`.
pub(crate) fn worktree_remove_impl(engine: &Engine, session_id: &str) -> IpcResult<Option<()>> {
    let (path, source_repo_root, base_ref, created_branch, distro) = {
        let map = engine.sessions.lock().unwrap();
        let Some(s) = map.get(session_id) else {
            return err("SESSION_NOT_FOUND", "no such session");
        };
        let Some(wt) = &s.worktree else {
            return err("WORKTREE_NOT_FOUND", "session has no worktree");
        };
        (
            wt.path.clone(),
            wt.source_repo_root.clone(),
            wt.base_ref.clone(),
            wt.created_branch,
            s.worktree_distro.clone(),
        )
    };
    // FR-10: reuse the host stored at creation (see worktree_status_impl's note).
    let host = host_from_distro(&distro);
    if !path_exists(&host, &path) {
        return err(
            "WORKTREE_NOT_FOUND",
            "the worktree directory no longer exists",
        );
    }
    let base_ref = created_branch.then_some(base_ref);
    match compute_status(&host, &path, base_ref.as_deref()) {
        Ok(status) if status.dirty || status.unpushed => {
            return err("WORKTREE_DIRTY", removal_block_reason(&status));
        }
        Ok(_) => {}
        Err((code, msg)) => return err(&code, msg),
    }
    match git_routed(&host, &source_repo_root, &["worktree", "remove", &path]) {
        Ok(o) if o.code == 0 => {
            let _ = git_routed(&host, &source_repo_root, &["worktree", "prune"]);
            ok(None)
        }
        Ok(o) => err(
            "GIT_ERROR",
            if o.stderr.is_empty() {
                "git worktree remove failed".into()
            } else {
                o.stderr
            },
        ),
        Err(e) => err("GIT_ERROR", e.to_string()),
    }
}

#[tauri::command(async)]
pub fn session_worktree_remove(
    engine: State<'_, Engine>,
    session_id: String,
) -> IpcResult<Option<()>> {
    worktree_remove_impl(&engine, &session_id)
}

#[cfg(test)]
mod tests;
