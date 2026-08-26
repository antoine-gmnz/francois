//! summary and per-file diff computation.

use super::*;
use crate::ipc::{AppError, ErrorCode};

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
pub fn untracked_counts(host: &GitHost, root: &str, path: &str) -> (u64, u64) {
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
pub fn untracked_counts_in_process(file: &Path) -> (u64, u64) {
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
pub fn untracked_counts_wsl_fallback(distro: &str, root: &str, path: &str) -> (u64, u64) {
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

pub fn compute_summary(cwd: &str) -> Result<DiffSummary, GitErr> {
    // Cached host + root + base (run everything from the worktree top so paths
    // agree; wsl-filesystem FR-5 routes every call below on `host`).
    let Some((host, root, base)) = repo_info(cwd) else {
        return Err(AppError::new(ErrorCode::NotAGitRepo, NOT_A_REPO_MSG));
    };
    let st = git_routed(
        &host,
        &root,
        &[
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
            "--renames",
        ],
    )
    .map_err(|e| AppError::new(ErrorCode::GitError, e.to_string()))?;
    if st.code != 0 {
        return Err(AppError::new(
            ErrorCode::GitError,
            if st.stderr.is_empty() {
                "git status failed".to_string()
            } else {
                st.stderr
            },
        ));
    }
    let numstat = git_routed(&host, &root, &["diff", &base, "-M", "-z", "--numstat"])
        .map_err(|e| AppError::new(ErrorCode::GitError, e.to_string()))?;
    let counts = parse_numstat_z(&numstat.stdout);

    let mut files: Vec<DiffFileSummary> = parse_porcelain_z(&st.stdout)
        .into_iter()
        .map(|(xy, path)| {
            let status = map_status(&xy);
            let (additions, deletions) = if status == DiffFileStatus::Untracked {
                untracked_counts(&host, &root, &path)
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
    let total_add = files.iter().map(|f| f.additions).sum();
    let total_del = files.iter().map(|f| f.deletions).sum();
    Ok(DiffSummary {
        files,
        total_add,
        total_del,
    })
}

pub fn compute_file_diff(cwd: &str, path: &str) -> Result<FileDiff, GitErr> {
    let Some((host, root, base)) = repo_info(cwd) else {
        return Err(AppError::new(ErrorCode::NotAGitRepo, NOT_A_REPO_MSG));
    };
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
    .map_err(|e| AppError::new(ErrorCode::GitError, e.to_string()))?;
    if st.code != 0 {
        return Err(AppError::new(
            ErrorCode::GitError,
            if st.stderr.is_empty() {
                "git status failed".to_string()
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
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            format!("'{path}' is not in the current changes"),
        ));
    };
    let status = map_status(&xy);
    let out = if status == DiffFileStatus::Untracked {
        git_routed(
            &host,
            &root,
            &["diff", "--no-index", "--", "/dev/null", path],
        )
    } else {
        git_routed(&host, &root, &["diff", &base, "-M", "--", path])
    }
    .map_err(|e| AppError::new(ErrorCode::GitError, e.to_string()))?;

    // `--no-index` exit 1 = "files differ" (success); only >=2 is a real failure (FR-8).
    let failed = if status == DiffFileStatus::Untracked {
        out.code >= 2
    } else {
        out.code != 0
    };
    if failed {
        return Err(AppError::new(
            ErrorCode::GitError,
            if out.stderr.is_empty() {
                "git diff failed".to_string()
            } else {
                out.stderr
            },
        ));
    }
    let text = String::from_utf8_lossy(&out.stdout);
    if text
        .lines()
        .any(|l| l.starts_with("Binary files") && l.contains("differ"))
    {
        return Ok(FileDiff {
            hunks: Vec::new(),
            binary: true,
        });
    }
    Ok(FileDiff {
        hunks: parse_unified_diff(&text),
        binary: false,
    })
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
}
