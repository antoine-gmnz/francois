//! summary and per-file diff computation.

use super::*;

use std::path::Path;

use crate::wsl;

// ---------- summary + file diff ----------

/// wsl-filesystem FR-7: for a Native repo, read straight off the local filesystem
/// (unchanged). For a Wsl repo, `root` is a Linux path (FR-6) that Windows can't
/// open directly — translate `<root>/<path>` to its `\\wsl.localhost\...` UNC form
/// (FR-3) and keep the SAME in-process read (no per-file git/wsl spawn on the
/// happy path — the whole point of the round-3 perf fix this preserves). If the
/// FR-3 root couldn't be discovered, fall back to a per-file `wsl.exe` numstat
/// spawn (§7 — correct, slower, WSL-only).
pub(crate) fn untracked_counts(host: &GitHost, root: &str, path: &str) -> (u64, u64) {
    match host {
        GitHost::Native => untracked_counts_in_process(&Path::new(root).join(path)),
        GitHost::Wsl(distro) => {
            match wsl::linux_to_wsl_unc(Some(distro), &format!("{root}/{path}")) {
                Some(unc) => untracked_counts_in_process(Path::new(&unc)),
                None => untracked_counts_wsl_fallback(distro, root, path), // FR-3 root unavailable (§7)
            }
        }
    }
}

/// Additions = full line count, deletions = 0 (FR-5) — computed IN-PROCESS. This used
/// to spawn `git diff --no-index --numstat` per untracked file, making every summary
/// cost O(untracked) git.exe spawns (~100ms each on Windows): a repo with a dozen new
/// files paid over a second per recompute. Semantics match numstat: binary (NUL in the
/// first 8 KiB) counts 0/0; a final line without a trailing newline still counts;
/// empty/unreadable → 0/0.
pub(crate) fn untracked_counts_in_process(file: &Path) -> (u64, u64) {
    use std::io::Read;
    let Ok(f) = std::fs::File::open(file) else {
        return (0, 0);
    };
    let mut reader = std::io::BufReader::with_capacity(64 * 1024, f);
    let mut buf = [0u8; 64 * 1024];
    let (mut lines, mut last, mut first) = (0u64, b'\n', true);
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                if first {
                    if buf[..n.min(8192)].contains(&0) {
                        return (0, 0); // binary → numstat reports `-` → 0
                    }
                    first = false;
                }
                lines += buf[..n].iter().filter(|&&b| b == b'\n').count() as u64;
                last = buf[n - 1];
            }
            Err(_) => return (0, 0),
        }
    }
    if last != b'\n' {
        lines += 1; // unterminated final line still counts (git semantics)
    }
    (lines, 0)
}

/// §7 fallback when the FR-3 UNC root is unavailable: one `git --no-index --numstat`
/// spawn per untracked file, routed into the distro (correct, slower — the
/// pre-round-3 shape, WSL-only; native repos always take the in-process path above).
pub(crate) fn untracked_counts_wsl_fallback(distro: &str, root: &str, path: &str) -> (u64, u64) {
    let Ok(out) = git_routed(
        &GitHost::Wsl(distro.to_string()),
        root,
        &["diff", "--no-index", "--numstat", "--", "/dev/null", path],
    ) else {
        return (0, 0);
    };
    // `--no-index` exits 1 on a real diff (success); only >=2 is a genuine failure.
    if out.code >= 2 {
        return (0, 0);
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let Some(line) = text.lines().next() else {
        return (0, 0);
    };
    let mut parts = line.splitn(3, '\t');
    (
        num(parts.next().unwrap_or("")),
        num(parts.next().unwrap_or("")),
    )
}

/// The working-tree file list — the pre-diff-review `compute_summary` body,
/// unchanged in behavior, factored out so `compute_summary` can also serve a
/// commit ref (FR-15).
fn worktree_files(host: &GitHost, root: &str, base: &str) -> Result<Vec<DiffFileSummary>, GitErr> {
    let st = git_routed(
        host,
        root,
        &[
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
            "--renames",
        ],
    )
    .map_err(|e| ("GIT_ERROR".to_string(), e.to_string()))?;
    if st.code != 0 {
        return Err((
            "GIT_ERROR".into(),
            if st.stderr.is_empty() {
                "git status failed".into()
            } else {
                st.stderr
            },
        ));
    }
    let numstat = git_routed(host, root, &["diff", base, "-M", "-z", "--numstat"])
        .map_err(|e| ("GIT_ERROR".to_string(), e.to_string()))?;
    let counts = parse_numstat_z(&numstat.stdout);

    let mut files: Vec<DiffFileSummary> = parse_porcelain_z(&st.stdout)
        .into_iter()
        .map(|(xy, path)| {
            let status = map_status(&xy);
            let (additions, deletions) = if status == DiffFileStatus::Untracked {
                untracked_counts(host, root, &path)
            } else {
                counts.get(&path).copied().unwrap_or((0, 0))
            };
            let (dir, name) = split_path(&path);
            DiffFileSummary {
                path,
                dir,
                name,
                additions,
                deletions,
                status,
            }
        })
        .collect();
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(files)
}

/// FR-15: the file list for `commit` vs its first parent (or `EMPTY_TREE` for
/// a root commit) — no working-tree status probe, since a commit's own diff
/// carries no "untracked" concept.
fn commit_files(host: &GitHost, root: &str, hash: &str) -> Result<Vec<DiffFileSummary>, GitErr> {
    let parent = commit_parent(host, root, hash);
    let name_status = git_routed(
        host,
        root,
        &["diff", "--name-status", "-z", "-M", &parent, hash],
    )
    .map_err(|e| ("GIT_ERROR".to_string(), e.to_string()))?;
    if name_status.code != 0 {
        return Err((
            "GIT_ERROR".into(),
            if name_status.stderr.is_empty() {
                "git diff failed".into()
            } else {
                name_status.stderr
            },
        ));
    }
    let numstat = git_routed(
        host,
        root,
        &["diff", "--numstat", "-z", "-M", &parent, hash],
    )
    .map_err(|e| ("GIT_ERROR".to_string(), e.to_string()))?;
    let counts = parse_numstat_z(&numstat.stdout);

    let mut files: Vec<DiffFileSummary> = parse_name_status_z(&name_status.stdout)
        .into_iter()
        .map(|(code, path)| {
            let status = map_name_status(&code);
            let (additions, deletions) = counts.get(&path).copied().unwrap_or((0, 0));
            let (dir, name) = split_path(&path);
            DiffFileSummary {
                path,
                dir,
                name,
                additions,
                deletions,
                status,
            }
        })
        .collect();
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(files)
}

/// FR-4/FR-13/FR-15: the summary for the working tree, or — when `commit` is
/// set — for that commit vs its first parent, read-only. Branch/base info is
/// attached regardless, since it describes the repo, not the selected ref.
pub(crate) fn compute_summary(cwd: &str, commit: Option<&str>) -> Result<DiffSummary, GitErr> {
    // Cached host + root + base (run everything from the worktree top so paths
    // agree; wsl-filesystem FR-5 routes every call below on `host`).
    let Some((host, root, base)) = repo_info(cwd) else {
        return Err(("NOT_A_GIT_REPO".into(), NOT_A_REPO_MSG.into()));
    };
    let (branch, head_short) = branch_and_head(&host, &root);
    let base_branch = resolve_base_branch(&host, &root);

    let files = match commit {
        Some(commit_ref) => {
            let hash = resolve_commit(&host, &root, commit_ref)?;
            commit_files(&host, &root, &hash)?
        }
        None => worktree_files(&host, &root, &base)?,
    };
    let total_add = files.iter().map(|f| f.additions).sum();
    let total_del = files.iter().map(|f| f.deletions).sum();
    Ok(DiffSummary {
        files,
        total_add,
        total_del,
        branch,
        head_short,
        base_branch,
    })
}

/// FR-15/FR-26: the diff for one file — working tree (`commit: None`) or a
/// selected commit vs its first parent — at `context` lines of surrounding
/// context (clamped by the caller via `clamp_context`).
pub(crate) fn compute_file_diff(
    cwd: &str,
    path: &str,
    commit: Option<&str>,
    context: u32,
) -> Result<FileDiff, GitErr> {
    let Some((host, root, base)) = repo_info(cwd) else {
        return Err(("NOT_A_GIT_REPO".into(), NOT_A_REPO_MSG.into()));
    };
    let ctx_flag = format!("-U{context}");

    if let Some(commit_ref) = commit {
        let hash = resolve_commit(&host, &root, commit_ref)?;
        let parent = commit_parent(&host, &root, &hash);
        let out = git_routed(
            &host,
            &root,
            &["diff", &parent, &hash, "-M", &ctx_flag, "--", path],
        )
        .map_err(|e| ("GIT_ERROR".to_string(), e.to_string()))?;
        if out.code != 0 {
            return Err((
                "GIT_ERROR".into(),
                if out.stderr.is_empty() {
                    "git diff failed".into()
                } else {
                    out.stderr
                },
            ));
        }
        return Ok(diff_output_to_file_diff(&out.stdout));
    }

    // Targeted status for just this path — avoids re-running the whole summary (which
    // costs a full `git status` + numstat + a diff per untracked file). Big win on a
    // large repo where every chip click otherwise re-scans everything.
    let st = git_routed(
        &host,
        &root,
        &[
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
            "--",
            path,
        ],
    )
    .map_err(|e| ("GIT_ERROR".to_string(), e.to_string()))?;
    if st.code != 0 {
        return Err((
            "GIT_ERROR".into(),
            if st.stderr.is_empty() {
                "git status failed".into()
            } else {
                st.stderr
            },
        ));
    }
    // A path with no porcelain entry is not a currently-changed file → stale selection.
    let Some((xy, _)) = parse_porcelain_z(&st.stdout)
        .into_iter()
        .find(|(_, p)| p == path)
    else {
        return Err((
            "INVALID_INPUT".into(),
            format!("'{path}' is not in the current changes"),
        ));
    };
    let status = map_status(&xy);
    let out = if status == DiffFileStatus::Untracked {
        git_routed(
            &host,
            &root,
            &["diff", "--no-index", &ctx_flag, "--", "/dev/null", path],
        )
    } else {
        git_routed(&host, &root, &["diff", &base, "-M", &ctx_flag, "--", path])
    }
    .map_err(|e| ("GIT_ERROR".to_string(), e.to_string()))?;

    // `--no-index` exit 1 = "files differ" (success); only >=2 is a real failure (FR-8).
    let failed = if status == DiffFileStatus::Untracked {
        out.code >= 2
    } else {
        out.code != 0
    };
    if failed {
        return Err((
            "GIT_ERROR".into(),
            if out.stderr.is_empty() {
                "git diff failed".into()
            } else {
                out.stderr
            },
        ));
    }
    Ok(diff_output_to_file_diff(&out.stdout))
}

fn diff_output_to_file_diff(stdout: &[u8]) -> FileDiff {
    let text = String::from_utf8_lossy(stdout);
    if text
        .lines()
        .any(|l| l.starts_with("Binary files") && l.contains("differ"))
    {
        return FileDiff {
            hunks: Vec::new(),
            binary: true,
        };
    }
    FileDiff {
        hunks: parse_unified_diff(&text),
        binary: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn untracked_counts_native_reads_in_process() {
        let dir = std::env::temp_dir().join("francois-untracked-counts-test");
        std::fs::create_dir_all(&dir).unwrap();
        let root = dir.to_string_lossy().to_string();
        std::fs::write(dir.join("two.txt"), "one\ntwo\n").unwrap();
        assert_eq!(untracked_counts(&GitHost::Native, &root, "two.txt"), (2, 0));
        // final line without trailing newline still counts (git numstat semantics)
        std::fs::write(dir.join("noeol.txt"), "one\ntwo").unwrap();
        assert_eq!(
            untracked_counts(&GitHost::Native, &root, "noeol.txt"),
            (2, 0)
        );
        std::fs::write(dir.join("empty.txt"), "").unwrap();
        assert_eq!(
            untracked_counts(&GitHost::Native, &root, "empty.txt"),
            (0, 0)
        );
        // NUL in the first 8 KiB → binary → 0/0, like numstat's `-`
        std::fs::write(dir.join("bin.dat"), b"ab\0cd\n\n").unwrap();
        assert_eq!(untracked_counts(&GitHost::Native, &root, "bin.dat"), (0, 0));
        // unreadable/missing → 0/0 (best-effort, matches the old spawn-failure path)
        assert_eq!(
            untracked_counts(&GitHost::Native, &root, "missing.txt"),
            (0, 0)
        );
    }

    // ---- diff-review: commit-ref summary/diff (FR-15) ----

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
            "francois-diff-compute-{name}-{}",
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
    fn compute_summary_for_a_commit_is_readonly_and_carries_branch_info() {
        let dir = init_repo("summary-commit");
        std::fs::write(dir.join("a.txt"), "one\n").unwrap();
        git(&dir, &["add", "-A"]);
        git(&dir, &["commit", "-qm", "root"]);
        std::fs::write(dir.join("a.txt"), "one\ntwo\n").unwrap();
        std::fs::write(dir.join("b.txt"), "new\n").unwrap();
        git(&dir, &["add", "-A"]);
        git(&dir, &["commit", "-qm", "second"]);

        let cwd = dir.to_string_lossy().to_string();
        let head = {
            let host = GitHost::Native;
            String::from_utf8_lossy(
                &git_routed(&host, &cwd, &["rev-parse", "HEAD"])
                    .unwrap()
                    .stdout,
            )
            .trim()
            .to_string()
        };

        let summary = compute_summary(&cwd, Some(&head)).unwrap();
        assert_eq!(summary.branch.as_deref(), Some("main"));
        assert_eq!(summary.files.len(), 2);
        let names: Vec<&str> = summary.files.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, vec!["a.txt", "b.txt"]);
        assert_eq!(summary.files[1].status, DiffFileStatus::Added);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn compute_summary_rejects_an_unresolvable_commit_ref() {
        let dir = init_repo("summary-bad-ref");
        std::fs::write(dir.join("a.txt"), "one\n").unwrap();
        git(&dir, &["add", "-A"]);
        git(&dir, &["commit", "-qm", "root"]);

        let cwd = dir.to_string_lossy().to_string();
        let err = compute_summary(&cwd, Some("not-a-ref")).unwrap_err();
        assert_eq!(err.0, "DIFF_COMMIT_NOT_FOUND");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn compute_file_diff_for_a_commit_diffs_against_its_parent() {
        let dir = init_repo("file-diff-commit");
        std::fs::write(dir.join("a.txt"), "one\n").unwrap();
        git(&dir, &["add", "-A"]);
        git(&dir, &["commit", "-qm", "root"]);
        std::fs::write(dir.join("a.txt"), "one\ntwo\n").unwrap();
        git(&dir, &["add", "-A"]);
        git(&dir, &["commit", "-qm", "second"]);

        let cwd = dir.to_string_lossy().to_string();
        let head = String::from_utf8_lossy(
            &git_routed(&GitHost::Native, &cwd, &["rev-parse", "HEAD"])
                .unwrap()
                .stdout,
        )
        .trim()
        .to_string();

        let diff = compute_file_diff(&cwd, "a.txt", Some(&head), 3).unwrap();
        assert!(!diff.binary);
        assert_eq!(diff.hunks.len(), 1);
        assert!(diff.hunks[0]
            .lines
            .iter()
            .any(|l| l.kind == "add" && l.text == "two"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn compute_file_diff_context_flag_widens_surrounding_lines() {
        let dir = init_repo("context");
        let lines: String = (1..=20).map(|n| format!("line{n}\n")).collect();
        std::fs::write(dir.join("a.txt"), &lines).unwrap();
        git(&dir, &["add", "-A"]);
        git(&dir, &["commit", "-qm", "root"]);
        let changed = lines.replacen("line10\n", "CHANGED\n", 1);
        std::fs::write(dir.join("a.txt"), &changed).unwrap();

        let cwd = dir.to_string_lossy().to_string();
        let narrow = compute_file_diff(&cwd, "a.txt", None, 1).unwrap();
        let wide = compute_file_diff(&cwd, "a.txt", None, 8).unwrap();
        assert!(wide.hunks[0].lines.len() > narrow.hunks[0].lines.len());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
