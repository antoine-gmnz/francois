//! diff-review FR-4/FR-13..17: branch/HEAD identity, the default-branch
//! resolution shared by `DiffSummary` and the COMMITS block, commit-ref
//! resolution for a read-only commit view (FR-15), and `listCommits` itself.

use super::*;

const LOG_FIELD_SEP: &str = "%x1f";
const LOG_RECORD_SEP: &str = "%x1e";

/// One trimmed line of `git <args>` output, or `None` on a non-zero exit /
/// spawn failure — mirrors `project::repo_brief`'s private helper of the same
/// shape (that one isn't `pub(crate)`, so this is the minimal reuse).
fn git_line(host: &GitHost, root: &str, args: &[&str]) -> Option<String> {
    match git_routed(host, root, args) {
        Ok(o) if o.code == 0 => Some(String::from_utf8_lossy(&o.stdout).trim().to_string()),
        _ => None,
    }
}

/// FR-4: current branch (`None` when detached) and the short HEAD hash.
pub(crate) fn branch_and_head(host: &GitHost, root: &str) -> (Option<String>, Option<String>) {
    let name = git_line(host, root, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap_or_default();
    let head_short = git_line(host, root, &["rev-parse", "--short", "HEAD"]);
    let branch = (!name.is_empty() && name != "HEAD").then_some(name);
    (branch, head_short)
}

/// FR-13: the default branch to count ahead of — whichever of `main`/`master`
/// exists, `None` when neither exists or the branch already IS the trunk
/// (reuses `project::repo_brief::pick_base`'s exact policy, so the two
/// features can never disagree about what "the trunk" means).
pub(crate) fn resolve_base_branch(host: &GitHost, root: &str) -> Option<String> {
    let branch = git_line(host, root, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap_or_default();
    let existing: Vec<String> = git_line(
        host,
        root,
        &[
            "for-each-ref",
            "--format=%(refname:short)",
            "refs/heads/main",
            "refs/heads/master",
        ],
    )
    .map(|out| out.lines().map(|l| l.trim().to_string()).collect())
    .unwrap_or_default();
    crate::project::pick_base(&branch, &existing)
}

/// FR-15: resolve `commit` (a hash from `listCommits`, re-validated regardless
/// per decision 2026-08-17 `security`) against `git rev-parse --verify
/// <ref>^{commit}`; anything else is `DIFF_COMMIT_NOT_FOUND`.
pub(crate) fn resolve_commit(host: &GitHost, root: &str, commit: &str) -> Result<String, GitErr> {
    match git_routed(
        host,
        root,
        &["rev-parse", "--verify", &format!("{commit}^{{commit}}")],
    ) {
        Ok(o) if o.code == 0 => {
            let hash = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if hash.is_empty() {
                Err(commit_not_found(commit))
            } else {
                Ok(hash)
            }
        }
        _ => Err(commit_not_found(commit)),
    }
}

fn commit_not_found(commit: &str) -> GitErr {
    (
        "DIFF_COMMIT_NOT_FOUND".to_string(),
        format!("commit '{commit}' not found"),
    )
}

/// `hash`'s first parent, or `EMPTY_TREE` for a root commit — so a commit
/// summary/diff still has something to diff against (FR-15).
pub(crate) fn commit_parent(host: &GitHost, root: &str, hash: &str) -> String {
    match git_line(host, root, &["rev-parse", "--verify", &format!("{hash}^")]) {
        Some(p) if !p.is_empty() => p,
        _ => EMPTY_TREE.to_string(),
    }
}

/// FR-39: HEAD reachable from any remote-tracking ref. Applied to every row in
/// the ahead-list (spec §5: "a commit reachable from a remote implies its
/// ancestors are") rather than probed per-commit.
fn is_head_pushed(host: &GitHost, root: &str) -> bool {
    matches!(
        git_routed(host, root, &["branch", "--remotes", "--contains", "HEAD"]),
        Ok(o) if o.code == 0 && !String::from_utf8_lossy(&o.stdout).trim().is_empty()
    )
}

/// FR-13..17: the branch's commits ahead of its base, newest first, capped at
/// 50. `baseBranch: None` (no main/master, or already on the trunk) yields the
/// empty "no base branch" state; a resolved base with nothing ahead yields the
/// empty "nothing ahead of <base>" state — both `commits: []`, distinguished by
/// `baseBranch`'s presence (FR-17).
pub(crate) fn list_commits(host: &GitHost, root: &str) -> Result<DiffCommitList, GitErr> {
    let Some(base) = resolve_base_branch(host, root) else {
        return Ok(DiffCommitList {
            commits: Vec::new(),
            base_branch: None,
            truncated: false,
        });
    };
    let fmt = format!("--format=%H{LOG_FIELD_SEP}%h{LOG_FIELD_SEP}%at{LOG_FIELD_SEP}%s{LOG_FIELD_SEP}%b{LOG_RECORD_SEP}");
    let range = format!("{base}..HEAD");
    let out = git_routed(host, root, &["log", &fmt, "-n", "51", &range])
        .map_err(|e| ("GIT_ERROR".to_string(), format!("git log failed: {e}")))?;
    if out.code != 0 {
        return Err((
            "GIT_ERROR".into(),
            if out.stderr.is_empty() {
                "git log failed".into()
            } else {
                out.stderr
            },
        ));
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut rows = parse_commit_log(&text);
    let truncated = rows.len() > 50;
    rows.truncate(50);
    let pushed = if rows.is_empty() {
        false
    } else {
        is_head_pushed(host, root)
    };
    let commits = rows
        .into_iter()
        .enumerate()
        .map(
            |(i, (hash, short_hash, at, subject, body))| DiffCommitSummary {
                hash,
                short_hash,
                subject,
                body,
                authored_at: at * 1000,
                is_head: i == 0,
                pushed,
            },
        )
        .collect();
    Ok(DiffCommitList {
        commits,
        base_branch: Some(base),
        truncated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git(dir: &std::path::Path, args: &[&str]) {
        let status = std::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .status()
            .expect("git spawn");
        assert!(status.success(), "git {args:?} failed in {dir:?}");
    }

    fn init_repo(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "francois-diff-commits-{name}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        git(&dir, &["init", "-q", "-b", "main"]);
        git(&dir, &["config", "user.email", "t@t.t"]);
        git(&dir, &["config", "user.name", "t"]);
        dir
    }

    #[test]
    fn branch_and_head_reads_a_named_branch_and_a_detached_one() {
        let dir = init_repo("branch");
        std::fs::write(dir.join("a.txt"), "one\n").unwrap();
        git(&dir, &["add", "-A"]);
        git(&dir, &["commit", "-qm", "init"]);
        git(&dir, &["checkout", "-q", "-b", "feat/x"]);

        let host = GitHost::Native;
        let root = dir.to_string_lossy().to_string();
        let (branch, head_short) = branch_and_head(&host, &root);
        assert_eq!(branch.as_deref(), Some("feat/x"));
        assert!(head_short.is_some());

        // Detach HEAD.
        let head = git_line(&host, &root, &["rev-parse", "HEAD"]).unwrap();
        git(&dir, &["checkout", "-q", &head]);
        let (branch, head_short) = branch_and_head(&host, &root);
        assert_eq!(branch, None);
        assert!(head_short.is_some());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_base_branch_finds_main_and_is_none_on_the_trunk() {
        let dir = init_repo("base");
        std::fs::write(dir.join("a.txt"), "one\n").unwrap();
        git(&dir, &["add", "-A"]);
        git(&dir, &["commit", "-qm", "init"]);

        let host = GitHost::Native;
        let root = dir.to_string_lossy().to_string();
        assert_eq!(resolve_base_branch(&host, &root), None); // standing on main

        git(&dir, &["checkout", "-q", "-b", "feat/x"]);
        assert_eq!(resolve_base_branch(&host, &root).as_deref(), Some("main"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_commit_validates_and_rejects_a_bogus_ref() {
        let dir = init_repo("resolve");
        std::fs::write(dir.join("a.txt"), "one\n").unwrap();
        git(&dir, &["add", "-A"]);
        git(&dir, &["commit", "-qm", "init"]);

        let host = GitHost::Native;
        let root = dir.to_string_lossy().to_string();
        let head = git_line(&host, &root, &["rev-parse", "HEAD"]).unwrap();
        assert_eq!(resolve_commit(&host, &root, "HEAD").unwrap(), head);
        assert_eq!(resolve_commit(&host, &root, &head[..8]).unwrap(), head);

        let err = resolve_commit(&host, &root, "not-a-ref").unwrap_err();
        assert_eq!(err.0, "DIFF_COMMIT_NOT_FOUND");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn commit_parent_is_empty_tree_for_a_root_commit() {
        let dir = init_repo("parent");
        std::fs::write(dir.join("a.txt"), "one\n").unwrap();
        git(&dir, &["add", "-A"]);
        git(&dir, &["commit", "-qm", "root"]);

        let host = GitHost::Native;
        let root = dir.to_string_lossy().to_string();
        let head = git_line(&host, &root, &["rev-parse", "HEAD"]).unwrap();
        assert_eq!(commit_parent(&host, &root, &head), EMPTY_TREE);

        std::fs::write(dir.join("b.txt"), "two\n").unwrap();
        git(&dir, &["add", "-A"]);
        git(&dir, &["commit", "-qm", "second"]);
        let second = git_line(&host, &root, &["rev-parse", "HEAD"]).unwrap();
        assert_eq!(commit_parent(&host, &root, &second), head);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn list_commits_reports_ahead_of_main_with_head_tagged() {
        let dir = init_repo("list");
        std::fs::write(dir.join("a.txt"), "one\n").unwrap();
        git(&dir, &["add", "-A"]);
        git(&dir, &["commit", "-qm", "base"]);
        git(&dir, &["checkout", "-q", "-b", "feat/x"]);
        std::fs::write(dir.join("b.txt"), "two\n").unwrap();
        git(&dir, &["add", "-A"]);
        git(&dir, &["commit", "-qm", "first\n\nbody line"]);
        std::fs::write(dir.join("c.txt"), "three\n").unwrap();
        git(&dir, &["add", "-A"]);
        git(&dir, &["commit", "-qm", "second"]);

        let host = GitHost::Native;
        let root = dir.to_string_lossy().to_string();
        let list = list_commits(&host, &root).unwrap();
        assert_eq!(list.base_branch.as_deref(), Some("main"));
        assert!(!list.truncated);
        assert_eq!(list.commits.len(), 2);
        assert_eq!(list.commits[0].subject, "second");
        assert!(list.commits[0].is_head);
        assert!(!list.commits[1].is_head);
        assert_eq!(list.commits[1].subject, "first");
        assert_eq!(list.commits[1].body, "body line");
        assert!(!list.commits[0].pushed); // never pushed to a remote

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn list_commits_empty_state_when_no_base_branch_exists() {
        let dir = init_repo("nobase");
        std::fs::write(dir.join("a.txt"), "one\n").unwrap();
        git(&dir, &["add", "-A"]);
        git(&dir, &["commit", "-qm", "init"]); // still on main, no base

        let host = GitHost::Native;
        let root = dir.to_string_lossy().to_string();
        let list = list_commits(&host, &root).unwrap();
        assert_eq!(list.base_branch, None);
        assert!(list.commits.is_empty());
        assert!(!list.truncated);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn list_commits_marks_pushed_when_head_is_reachable_from_a_remote() {
        let remote = init_repo("remote");
        std::fs::write(remote.join("a.txt"), "one\n").unwrap();
        git(&remote, &["add", "-A"]);
        git(&remote, &["commit", "-qm", "base"]);

        let clone_dir = std::env::temp_dir().join(format!(
            "francois-diff-commits-clone-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = std::fs::remove_dir_all(&clone_dir);
        git(
            &std::env::temp_dir(),
            &[
                "clone",
                "-q",
                &remote.to_string_lossy(),
                &clone_dir.to_string_lossy(),
            ],
        );
        git(&clone_dir, &["config", "user.email", "t@t.t"]);
        git(&clone_dir, &["config", "user.name", "t"]);
        git(&clone_dir, &["checkout", "-q", "-b", "feat/x"]);
        std::fs::write(clone_dir.join("b.txt"), "two\n").unwrap();
        git(&clone_dir, &["add", "-A"]);
        git(&clone_dir, &["commit", "-qm", "on the branch"]);
        git(&clone_dir, &["push", "-q", "origin", "feat/x"]);

        let host = GitHost::Native;
        let root = clone_dir.to_string_lossy().to_string();
        let list = list_commits(&host, &root).unwrap();
        assert_eq!(list.commits.len(), 1);
        assert!(list.commits[0].pushed);

        let _ = std::fs::remove_dir_all(&remote);
        let _ = std::fs::remove_dir_all(&clone_dir);
    }
}
