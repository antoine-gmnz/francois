// diff-view core — the `diff` domain (specs/diff-view.md). Drives the system `git`
// CLI against a session's cwd to compute change summaries, per-file unified diffs,
// stage-all and commit; watches the cwd + reacts to Edit/Write tool.done to keep
// the DIFF badge / chip strip live via `francois://diff/event`.
//
// Caching: only the per-cwd (host, root, base) triple is cached (REPO_CACHE — git.exe
// spawn overhead on Windows); summaries/diffs themselves are recomputed fresh. Per-session
// git ops are serialized (FR-14). Paths are always forward-slash (git emits '/').
//
// wsl-filesystem (specs/wsl-filesystem.md) FR-5..9: every git op routes on whether
// the repo lives on a WSL UNC path (`\\wsl$\…` / `\\wsl.localhost\…`), never on the
// claude runtime — see the `GitHost`/`git_routed` note further down.

mod commands;
mod compute;
mod git;
mod parse;
mod watch;

pub(crate) use commands::*;
pub(crate) use compute::*;
pub(crate) use git::*;
pub(crate) use parse::*;
pub(crate) use watch::*;

use serde::Serialize;

/// git's well-known empty-tree object — the diff base for a repo with no commits (FR-2).
const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const NOT_A_REPO_MSG: &str = "not a git repository — initialize with `git init` in the shell";

// ---------- serialized public shapes (contract/diff-view.ts) ----------

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub(crate) enum DiffFileStatus {
    Modified,
    Added,
    Deleted,
    Untracked,
    Renamed,
}

#[derive(Serialize)]
pub(crate) struct DiffFileSummary {
    path: String,
    dir: String,
    name: String,
    additions: u64,
    deletions: u64,
    status: DiffFileStatus,
}

#[derive(Serialize)]
pub struct DiffSummary {
    files: Vec<DiffFileSummary>,
    #[serde(rename = "totalAdd")]
    total_add: u64,
    #[serde(rename = "totalDel")]
    total_del: u64,
}

#[derive(Serialize)]
pub(crate) struct DiffLine {
    kind: &'static str, // add | del | ctx (hunk headers live on DiffHunk.header)
    #[serde(rename = "oldNo", skip_serializing_if = "Option::is_none")]
    old_no: Option<u64>,
    #[serde(rename = "newNo", skip_serializing_if = "Option::is_none")]
    new_no: Option<u64>,
    text: String,
}

#[derive(Serialize)]
pub(crate) struct DiffHunk {
    header: String,
    lines: Vec<DiffLine>,
}

#[derive(Serialize)]
pub struct FileDiff {
    hunks: Vec<DiffHunk>,
    binary: bool,
}

#[derive(Serialize)]
pub struct CommitResult {
    #[serde(rename = "commitHash")]
    commit_hash: String,
}

pub(crate) struct GitOut {
    pub(crate) code: i32,
    pub(crate) stdout: Vec<u8>,
    pub(crate) stderr: String,
}
