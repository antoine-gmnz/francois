// diff core — the `diff` domain (specs/diff-view.md, reworked by specs/diff-review.md).
// Drives the system `git` CLI against a session's cwd (or a selected commit ref) to
// compute change summaries, per-file unified diffs, the branch's commit list, and
// commit/amend; watches the cwd + reacts to Edit/Write tool.done to keep the DIFF
// badge live via `francois://diff/event`.
//
// Caching: only the per-cwd (host, root, base) triple is cached (REPO_CACHE — git.exe
// spawn overhead on Windows); summaries/diffs themselves are recomputed fresh. Per-session
// git ops are serialized (FR-14). Paths are always forward-slash (git emits '/').
//
// wsl-filesystem (specs/wsl-filesystem.md) FR-5..9: every git op routes on whether
// the repo lives on a WSL UNC path (`\\wsl$\…` / `\\wsl.localhost\…`), never on the
// claude runtime — see the `GitHost`/`git_routed` note further down.
//
// diff-review FR-43: `stageAll`/`git add -A` is gone for good — `diff_commit` always
// takes an explicit path list (or amends the message alone). commits.rs owns the new
// branch/base-branch resolution and the COMMITS block (FR-13..17); compute.rs threads
// an optional commit ref + context through the existing summary/file-diff computation
// (FR-15, FR-26).

mod commands;
mod commits;
mod compute;
mod git;
mod parse;
mod watch;

pub(crate) use commands::*;
pub(crate) use commits::*;
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

#[derive(Serialize, Debug)]
pub(crate) struct DiffFileSummary {
    path: String,
    dir: String,
    name: String,
    additions: u64,
    deletions: u64,
    status: DiffFileStatus,
}

#[derive(Serialize, Debug)]
pub struct DiffSummary {
    files: Vec<DiffFileSummary>,
    #[serde(rename = "totalAdd")]
    total_add: u64,
    #[serde(rename = "totalDel")]
    total_del: u64,
    /// Current branch, `None` when detached (FR-4).
    branch: Option<String>,
    /// Short HEAD hash, for the detached label (FR-4).
    #[serde(rename = "headShort")]
    head_short: Option<String>,
    /// The default branch we count ahead of, `None` if there is none (FR-13).
    #[serde(rename = "baseBranch")]
    base_branch: Option<String>,
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

/// One commit ahead of the branch's base (FR-13).
#[derive(Serialize, Clone, Debug, PartialEq)]
pub(crate) struct DiffCommitSummary {
    hash: String,
    #[serde(rename = "shortHash")]
    short_hash: String,
    subject: String,
    /// Remainder of the message, `""` when none — feeds the amend pre-fill (FR-38).
    body: String,
    #[serde(rename = "authoredAt")]
    authored_at: i64,
    /// True for exactly one row, the first.
    #[serde(rename = "isHead")]
    is_head: bool,
    /// Reachable from any remote-tracking ref (FR-39).
    pushed: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct DiffCommitList {
    commits: Vec<DiffCommitSummary>,
    #[serde(rename = "baseBranch")]
    base_branch: Option<String>,
    /// True when the branch is >50 ahead.
    truncated: bool,
}

pub(crate) struct GitOut {
    pub(crate) code: i32,
    pub(crate) stdout: Vec<u8>,
    pub(crate) stderr: String,
}
