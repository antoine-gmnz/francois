//! francois:project:repoBrief (contract/session-welcome.ts) — the two facts the
//! SESSION welcome header states about the repo a session runs in: its CLAUDE.md,
//! and where HEAD sits relative to the trunk.
//!
//! Read-only end to end. Every git call routes through the diff domain's
//! `git_routed`, so a WSL repo is probed inside the distro exactly like every
//! other git op (wsl-filesystem FR-5) — and, like `untracked_counts`, the
//! filesystem half translates the Linux root back to a UNC path before `std::fs`
//! ever sees it.
//!
//! Nothing here is fatal: a repo with no git, no trunk, or no CLAUDE.md yields a
//! brief with those members simply absent. The command only fails when there is
//! no such session.

use super::*;
use crate::ipc::ErrorCode;

use crate::diff::{git_routed, repo_info, GitHost};
use crate::ipc::{err, ok, IpcResult};
use crate::session::Engine;
use crate::wsl;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

// ---------- contract types (contract/session-welcome.ts, mirrored) ----------

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct ClaudeMdBrief {
    lines: u32,
    #[serde(rename = "modifiedAt")]
    modified_at: u64,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct GitBrief {
    branch: String,
    detached: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    base: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ahead: Option<u32>,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct RepoBrief {
    #[serde(skip_serializing_if = "Option::is_none")]
    root: Option<String>,
    #[serde(rename = "claudeMd", skip_serializing_if = "Option::is_none")]
    claude_md: Option<ClaudeMdBrief>,
    #[serde(skip_serializing_if = "Option::is_none")]
    git: Option<GitBrief>,
}

// ---------- pure helpers ----------

/// Physical line count. A trailing newline terminates the last line rather than
/// opening an empty one, so a 41-line file reads 41 with or without it; an empty
/// file is 0. Matches what `wc -l`-minded users expect to see next to a path.
pub fn count_lines(content: &str) -> u32 {
    if content.is_empty() {
        return 0;
    }
    let newlines = content.matches('\n').count();
    let unterminated = !content.ends_with('\n');
    (newlines + usize::from(unterminated)) as u32
}

/// The trunk to measure against: whichever of `main`/`master` the repo actually
/// has, `main` winning when it has both. Standing ON that trunk yields None — a
/// repo has one trunk, so "main, 3 commits ahead of master" would be an artifact
/// of the candidate list rather than a fact about the work.
pub fn pick_base(branch: &str, existing: &[String]) -> Option<String> {
    let trunk = ["main", "master"]
        .into_iter()
        .find(|c| existing.iter().any(|b| b == c))?;
    (trunk != branch).then(|| trunk.to_string())
}

/// `git rev-list --count` output → a number. Anything unparseable is None, so a
/// surprising git build can only cost the clause, never the whole header.
pub fn parse_count(stdout: &str) -> Option<u32> {
    stdout.trim().parse::<u32>().ok()
}

/// The host-dialect path `std::fs` must open for `<root>/CLAUDE.md`. Native is the
/// plain join; a WSL root is a Linux path, so it goes back through the UNC
/// translation first (mirrors diff::untracked_counts). None ⇔ the distro's share
/// could not be resolved.
pub fn claude_md_fs_path(host: &GitHost, root: &str) -> Option<PathBuf> {
    match host {
        GitHost::Native => Some(Path::new(root).join("CLAUDE.md")),
        GitHost::Wsl(distro) => {
            wsl::linux_to_wsl_unc(Some(distro), &format!("{root}/CLAUDE.md")).map(PathBuf::from)
        }
    }
}

// ---------- probes ----------

fn read_claude_md(path: &Path) -> Option<ClaudeMdBrief> {
    let content = std::fs::read_to_string(path).ok()?;
    let modified_at = std::fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Some(ClaudeMdBrief {
        lines: count_lines(&content),
        modified_at,
    })
}

/// One `git` line, trimmed, or None on a non-zero exit / spawn failure.
fn git_line(host: &GitHost, root: &str, args: &[&str]) -> Option<String> {
    match git_routed(host, root, args) {
        Ok(o) if o.code == 0 => Some(String::from_utf8_lossy(&o.stdout).trim().to_string()),
        _ => None,
    }
}

fn git_brief(host: &GitHost, root: &str) -> Option<GitBrief> {
    // `--abbrev-ref HEAD` prints the literal "HEAD" when detached — the one case
    // where the name is not a name, so it decides `detached` before anything else.
    let name = git_line(host, root, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    if name.is_empty() {
        return None;
    }
    if name == "HEAD" {
        let sha = git_line(host, root, &["rev-parse", "--short", "HEAD"]).unwrap_or_default();
        return Some(GitBrief {
            branch: if sha.is_empty() { name } else { sha },
            detached: true,
            base: None,
            ahead: None,
        });
    }

    // Only the two trunk refs are asked for, so an unborn/odd repo costs one cheap
    // call and the clause is dropped rather than the whole brief.
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

    let counted = pick_base(&name, &existing).and_then(|b| {
        let n = git_line(host, root, &["rev-list", "--count", &format!("{b}..HEAD")])
            .as_deref()
            .and_then(parse_count)?;
        Some((b, n))
    });
    // The two members are present together or not at all (contract/session-welcome.ts):
    // a base whose count could not be read states nothing.
    let (base, ahead) = match counted {
        Some((b, n)) => (Some(b), Some(n)),
        None => (None, None),
    };
    Some(GitBrief {
        branch: name,
        detached: false,
        base,
        ahead,
    })
}

// ---------- command ----------

/// francois:project:repoBrief. `async` for the same reason every diff command is:
/// a sync Tauri command runs on the MAIN thread, where each git spawn freezes the
/// whole window (see diff/commands.rs).
#[tauri::command]
pub async fn project_repo_brief(app: AppHandle, session_id: String) -> IpcResult<RepoBrief> {
    let cwd = match app.state::<Engine>().cwd_of(&session_id) {
        Some(cwd) => cwd,
        None => return err(ErrorCode::SessionNotFound, "no such session"),
    };

    // Outside a worktree there is no root and no git half — the CLAUDE.md probe
    // still runs, against the cwd itself, because a project without git is still
    // a project that can carry standards.
    let (host, root, git) = match repo_info(&cwd) {
        Some((host, root, _base)) => {
            let git = git_brief(&host, &root);
            (host, root, git)
        }
        None => (GitHost::of(&cwd), cwd.clone(), None),
    };

    let claude_md = claude_md_fs_path(&host, &root).and_then(|p| read_claude_md(&p));
    ok(RepoBrief {
        root: git.is_some().then(|| root.clone()),
        claude_md,
        git,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn count_lines_ignores_the_terminating_newline() {
        assert_eq!(count_lines(""), 0);
        assert_eq!(count_lines("a"), 1);
        assert_eq!(count_lines("a\n"), 1);
        assert_eq!(count_lines("a\nb"), 2);
        assert_eq!(count_lines("a\nb\n"), 2);
        // A blank final line the user actually typed IS a line.
        assert_eq!(count_lines("a\n\n"), 2);
        assert_eq!(count_lines("a\n\n\n"), 3);
    }

    #[test]
    fn count_lines_counts_crlf_and_blank_lines_once_each() {
        assert_eq!(count_lines("a\r\nb\r\n"), 2);
        assert_eq!(count_lines("\n\n\n"), 3);
    }

    #[test]
    fn pick_base_prefers_main_and_never_picks_the_current_branch() {
        let both = vec!["main".to_string(), "master".to_string()];
        assert_eq!(pick_base("feat/x", &both).as_deref(), Some("main"));
        // main wins when both exist, so standing on main states no clause —
        // never "main, N ahead of master".
        assert_eq!(pick_base("main", &both), None);
        assert_eq!(
            pick_base("feat/x", &["master".to_string()]).as_deref(),
            Some("master")
        );
        assert_eq!(pick_base("master", &["master".to_string()]), None);
        assert_eq!(pick_base("feat/x", &[]), None);
    }

    #[test]
    fn parse_count_reads_a_trimmed_number_and_refuses_anything_else() {
        assert_eq!(parse_count("4\n"), Some(4));
        assert_eq!(parse_count("  0  "), Some(0));
        assert_eq!(parse_count(""), None);
        assert_eq!(parse_count("fatal: bad revision"), None);
    }

    #[test]
    fn claude_md_fs_path_joins_natively() {
        let p = claude_md_fs_path(&GitHost::Native, "/tmp/repo").unwrap();
        assert_eq!(p, Path::new("/tmp/repo").join("CLAUDE.md"));
    }

    #[test]
    fn a_brief_omits_every_absent_member() {
        // The frontend distinguishes "no repo" from "a repo with nothing to say"
        // by key presence, so absent must never serialize as null.
        let json = serde_json::to_string(&RepoBrief::default()).unwrap();
        assert_eq!(json, "{}");
    }

    #[test]
    fn a_full_brief_serializes_under_the_contract_names() {
        let brief = RepoBrief {
            root: Some("/repo".into()),
            claude_md: Some(ClaudeMdBrief {
                lines: 41,
                modified_at: 1_700_000_000_000,
            }),
            git: Some(GitBrief {
                branch: "router-adapter".into(),
                detached: false,
                base: Some("main".into()),
                ahead: Some(4),
            }),
        };
        let v: serde_json::Value = serde_json::to_value(&brief).unwrap();
        assert_eq!(v["claudeMd"]["lines"], 41);
        assert_eq!(v["claudeMd"]["modifiedAt"], 1_700_000_000_000u64);
        assert_eq!(v["git"]["branch"], "router-adapter");
        assert_eq!(v["git"]["detached"], false);
        assert_eq!(v["git"]["base"], "main");
        assert_eq!(v["git"]["ahead"], 4);
    }

    #[test]
    fn git_brief_reads_a_real_repos_branch_claude_md_and_ahead_count() {
        fn git(dir: &Path, args: &[&str]) {
            let status = crate::process_util::spawn("git")
                .args(args)
                .current_dir(dir)
                .status()
                .expect("git");
            assert!(status.success(), "git {args:?} failed");
        }

        let tmp = std::env::temp_dir().join(format!("francois-brief-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        git(&tmp, &["init", "-q", "-b", "main"]);
        git(&tmp, &["config", "user.email", "t@t.t"]);
        git(&tmp, &["config", "user.name", "t"]);
        std::fs::write(tmp.join("CLAUDE.md"), "one\ntwo\nthree\n").unwrap();
        git(&tmp, &["add", "-A"]);
        git(&tmp, &["commit", "-qm", "base"]);
        git(&tmp, &["checkout", "-q", "-b", "feat/x"]);
        std::fs::write(tmp.join("a.txt"), "a").unwrap();
        git(&tmp, &["add", "-A"]);
        git(&tmp, &["commit", "-qm", "one"]);
        std::fs::write(tmp.join("b.txt"), "b").unwrap();
        git(&tmp, &["add", "-A"]);
        git(&tmp, &["commit", "-qm", "two"]);

        let root = tmp.to_string_lossy().to_string();
        let host = GitHost::Native;
        let brief = git_brief(&host, &root).expect("a brief");
        assert_eq!(brief.branch, "feat/x");
        assert!(!brief.detached);
        assert_eq!(brief.base.as_deref(), Some("main"));
        assert_eq!(brief.ahead, Some(2));

        let md = read_claude_md(&claude_md_fs_path(&host, &root).unwrap()).expect("CLAUDE.md");
        assert_eq!(md.lines, 3);
        assert!(md.modified_at > 0);

        // Back on the trunk: a branch level with itself states no clause.
        git(&tmp, &["checkout", "-q", "main"]);
        let on_main = git_brief(&host, &root).expect("a brief");
        assert_eq!(on_main.branch, "main");
        assert_eq!(on_main.base, None);
        assert_eq!(on_main.ahead, None);

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
