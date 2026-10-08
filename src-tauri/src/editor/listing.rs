// editor/listing.rs — code-editor: the explorer's data (FR-4/FR-5) — the file
// list (`git ls-files`, or a .gitignore-honouring walk outside a repo), the
// current branch and the porcelain status per changed path. One repo probe per
// call; every git spawn goes through `diff::git_routed` (process_util + WSL).

use super::files::has_git_component;
use super::{GitChange, EDITOR_FILES_CAP};
use crate::diff::{git_routed, is_git_repo, GitHost};
use std::collections::BTreeMap;
use std::path::Path;

pub(super) struct Listing {
    pub paths: Vec<String>,
    pub truncated: bool,
    pub branch: Option<String>,
    pub changes: BTreeMap<String, GitChange>,
}

pub(super) fn list(root: &str) -> Listing {
    let host = GitHost::of(root);
    let repo = is_git_repo(&host, root);
    let mut paths = repo
        .then(|| git_files(&host, root))
        .flatten()
        .unwrap_or_else(|| walk_files(root));
    paths.sort();
    paths.dedup();
    let truncated = paths.len() > EDITOR_FILES_CAP;
    paths.truncate(EDITOR_FILES_CAP);
    let (branch, changes) = if repo {
        (git_branch(&host, root), git_changes(&host, root))
    } else {
        (None, BTreeMap::new())
    };
    Listing {
        paths,
        truncated,
        branch,
        changes,
    }
}

/// Trimmed stdout of a successful git run; None on spawn failure, non-zero exit or empty output.
fn git_line(host: &GitHost, root: &str, args: &[&str]) -> Option<String> {
    let out = git_routed(host, root, args).ok()?;
    if out.code != 0 {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!s.is_empty()).then_some(s)
}

/// FR-5: `git rev-parse --abbrev-ref HEAD`; the short sha when detached; the
/// unborn branch's name in a repo with no commit yet.
fn git_branch(host: &GitHost, root: &str) -> Option<String> {
    match git_line(host, root, &["rev-parse", "--abbrev-ref", "HEAD"]) {
        Some(b) if b != "HEAD" => Some(b),
        Some(_) => git_line(host, root, &["rev-parse", "--short", "HEAD"]),
        None => git_line(host, root, &["symbolic-ref", "--short", "-q", "HEAD"]),
    }
}

/// FR-5: changed paths under the root, from `git status --porcelain=v1 -z`.
/// Porcelain paths are repo-relative, so a root below the repo top strips its prefix.
fn git_changes(host: &GitHost, root: &str) -> BTreeMap<String, GitChange> {
    let prefix = git_line(host, root, &["rev-parse", "--show-prefix"]).unwrap_or_default();
    let args = [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--",
        ".",
    ];
    match git_routed(host, root, &args) {
        Ok(out) if out.code == 0 => parse_porcelain(&out.stdout, &prefix),
        _ => BTreeMap::new(),
    }
}

/// `XY path\0` entries; renames/copies carry their source as the next entry.
/// Untracked, added, renamed and copied read `A`; deletions are skipped (the file
/// is not in the tree); anything else reads `M`.
fn parse_porcelain(raw: &[u8], prefix: &str) -> BTreeMap<String, GitChange> {
    let text = String::from_utf8_lossy(raw);
    let mut entries = text.split('\0');
    let mut out = BTreeMap::new();
    while let Some(entry) = entries.next() {
        let (Some(xy), Some(path)) = (entry.get(..2), entry.get(3..)) else {
            continue;
        };
        let (x, y) = (xy.as_bytes()[0], xy.as_bytes()[1]);
        if matches!(x, b'R' | b'C') {
            entries.next();
        }
        if x == b'D' || y == b'D' || x == b'!' {
            continue;
        }
        let change = if matches!(x, b'?' | b'A' | b'R' | b'C') || y == b'A' {
            GitChange::A
        } else {
            GitChange::M
        };
        let Some(rel) = path.strip_prefix(prefix) else {
            continue;
        };
        if rel.is_empty() || has_git_component(Path::new(rel)) {
            continue;
        }
        out.insert(rel.to_string(), change);
    }
    out
}

fn git_files(host: &GitHost, root: &str) -> Option<Vec<String>> {
    let out = git_routed(
        host,
        root,
        &[
            "ls-files",
            "-z",
            "--cached",
            "--others",
            "--exclude-standard",
        ],
    )
    .ok()?;
    if out.code != 0 {
        return None;
    }
    let native = *host == GitHost::Native;
    Some(
        String::from_utf8_lossy(&out.stdout)
            .split('\0')
            .filter(|p| !p.is_empty())
            .filter(|p| !has_git_component(Path::new(p)))
            // `--cached` still lists tracked files deleted from the working tree.
            .filter(|p| !native || Path::new(root).join(p).is_file())
            .map(str::to_string)
            .collect(),
    )
}

struct IgnoreRule {
    pattern: String,
    dir_only: bool,
    anchored: bool,
}

/// Root `.gitignore` only — enough for a non-repo fallback (nested files and
/// negations are not honoured; see handoff TODO).
fn load_ignore(root: &Path) -> Vec<IgnoreRule> {
    let Ok(text) = std::fs::read_to_string(root.join(".gitignore")) else {
        return Vec::new();
    };
    text.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#') && !l.starts_with('!'))
        .map(|l| {
            let dir_only = l.ends_with('/');
            let l = l.trim_end_matches('/');
            let anchored = l.contains('/');
            IgnoreRule {
                pattern: l.trim_start_matches('/').to_string(),
                dir_only,
                anchored,
            }
        })
        .collect()
}

/// `*`/`?` stay inside a path segment; `**` crosses `/`.
fn glob(p: &[u8], s: &[u8]) -> bool {
    match p.first() {
        None => s.is_empty(),
        Some(b'*') if p.get(1) == Some(&b'*') => {
            let rest = &p[2..];
            let rest = rest.strip_prefix(b"/").unwrap_or(rest);
            (0..=s.len()).any(|i| glob(rest, &s[i..]))
        }
        Some(b'*') => (0..=s.len())
            .take_while(|&i| i == 0 || s[i - 1] != b'/')
            .any(|i| glob(&p[1..], &s[i..])),
        Some(b'?') => s.first().is_some_and(|&c| c != b'/') && glob(&p[1..], &s[1..]),
        Some(&c) => s.first() == Some(&c) && glob(&p[1..], &s[1..]),
    }
}

fn ignored(rules: &[IgnoreRule], rel: &str, is_dir: bool) -> bool {
    let name = rel.rsplit('/').next().unwrap_or(rel);
    rules.iter().any(|r| {
        (!r.dir_only || is_dir)
            && if r.anchored {
                glob(r.pattern.as_bytes(), rel.as_bytes())
            } else {
                glob(r.pattern.as_bytes(), name.as_bytes())
            }
    })
}

fn walk_files(root: &str) -> Vec<String> {
    fn go(dir: &Path, rel: &str, rules: &[IgnoreRule], out: &mut Vec<String>) {
        let Ok(rd) = std::fs::read_dir(dir) else {
            return;
        };
        let mut entries: Vec<_> = rd.flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        for e in entries {
            if out.len() > EDITOR_FILES_CAP {
                return;
            }
            let name = e.file_name().to_string_lossy().into_owned();
            if name == ".git" {
                continue;
            }
            let child = if rel.is_empty() {
                name
            } else {
                format!("{rel}/{name}")
            };
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_dir() {
                if !ignored(rules, &child, true) {
                    go(&e.path(), &child, rules, out);
                }
            } else if (ft.is_file() || (ft.is_symlink() && e.path().is_file()))
                && !ignored(rules, &child, false)
            {
                out.push(child);
            }
        }
    }
    let mut out = Vec::new();
    let rules = load_ignore(Path::new(root));
    go(Path::new(root), "", &rules, &mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::editor::testutil::{git, TempDir};

    fn root(d: &TempDir) -> String {
        d.path().to_string_lossy().into_owned()
    }

    #[test]
    fn list_in_a_repo_is_tracked_plus_untracked_minus_ignored_sorted() {
        let d = TempDir::new();
        git(d.path(), &["init", "-q"]);
        std::fs::write(d.path().join(".gitignore"), "ignored.txt\n").unwrap();
        std::fs::create_dir_all(d.path().join("src")).unwrap();
        std::fs::write(d.path().join("src/b.ts"), "").unwrap();
        std::fs::write(d.path().join("a.ts"), "").unwrap();
        std::fs::write(d.path().join("ignored.txt"), "").unwrap();
        std::fs::write(d.path().join("gone.ts"), "").unwrap();
        git(d.path(), &["add", "gone.ts"]);
        std::fs::remove_file(d.path().join("gone.ts")).unwrap();
        let data = list(&root(&d));
        assert_eq!(data.paths, vec![".gitignore", "a.ts", "src/b.ts"]);
        assert!(!data.truncated);
    }

    #[test]
    fn list_outside_a_repo_walks_honouring_gitignore_and_skips_dot_git() {
        let d = TempDir::new();
        std::fs::write(
            d.path().join(".gitignore"),
            "node_modules/\n*.log\n/build\n",
        )
        .unwrap();
        for dir in ["node_modules/x", "src/deep", "build", ".git"] {
            std::fs::create_dir_all(d.path().join(dir)).unwrap();
        }
        for f in [
            "node_modules/x/i.js",
            "src/deep/z.rs",
            "src/a.rs",
            "src/debug.log",
            "build/out.js",
            ".git/HEAD",
            "top.rs",
        ] {
            std::fs::write(d.path().join(f), "").unwrap();
        }
        let data = list(&root(&d));
        assert_eq!(
            data.paths,
            vec![".gitignore", "src/a.rs", "src/deep/z.rs", "top.rs"]
        );
    }

    #[test]
    fn list_caps_at_the_files_cap_and_flags_truncation() {
        let d = TempDir::new();
        for i in 0..(EDITOR_FILES_CAP + 5) {
            std::fs::write(d.path().join(format!("f{i:05}.txt")), "").unwrap();
        }
        let data = list(&root(&d));
        assert_eq!(data.paths.len(), EDITOR_FILES_CAP);
        assert!(data.truncated);
    }

    #[test]
    fn glob_matcher_basics() {
        assert!(glob(b"*.log", b"a.log"));
        assert!(!glob(b"*.log", b"d/a.log"));
        assert!(glob(b"**/x", b"a/b/x"));
        assert!(glob(b"a?c", b"abc"));
    }

    #[test]
    fn porcelain_maps_untracked_added_renamed_to_a_and_skips_deletions() {
        let raw = b" M src/a.ts\0?? new.txt\0A  added.rs\0R  moved.rs\0old.rs\0 D gone.rs\0D  staged-gone.rs\0MM both.rs\0 A intent.rs\0";
        let m = parse_porcelain(raw, "");
        let want: BTreeMap<String, GitChange> = [
            ("src/a.ts", GitChange::M),
            ("new.txt", GitChange::A),
            ("added.rs", GitChange::A),
            ("moved.rs", GitChange::A),
            ("both.rs", GitChange::M),
            ("intent.rs", GitChange::A),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v))
        .collect();
        assert_eq!(m, want);
    }

    #[test]
    fn porcelain_strips_the_subdirectory_prefix() {
        let m = parse_porcelain(b" M pkg/a.ts\0?? other/b.ts\0", "pkg/");
        assert_eq!(m.len(), 1);
        assert_eq!(m.get("a.ts"), Some(&GitChange::M));
    }

    #[test]
    fn list_reports_branch_and_changes_in_a_repo() {
        let d = TempDir::new();
        git(d.path(), &["init", "-q", "-b", "main"]);
        std::fs::write(d.path().join("t.txt"), "one").unwrap();
        std::fs::write(d.path().join("keep.txt"), "k").unwrap();
        git(d.path(), &["add", "."]);
        git(d.path(), &["commit", "-q", "-m", "init"]);
        std::fs::write(d.path().join("t.txt"), "two").unwrap();
        std::fs::create_dir_all(d.path().join("dir")).unwrap();
        std::fs::write(d.path().join("dir/u.txt"), "u").unwrap();
        let l = list(&root(&d));
        assert_eq!(l.branch.as_deref(), Some("main"));
        assert_eq!(l.changes.get("t.txt"), Some(&GitChange::M));
        assert_eq!(l.changes.get("dir/u.txt"), Some(&GitChange::A));
        assert_eq!(l.changes.len(), 2);
        git(d.path(), &["checkout", "-q", "--detach"]);
        let sha = git_line(
            &GitHost::Native,
            &root(&d),
            &["rev-parse", "--short", "HEAD"],
        );
        assert!(sha.is_some());
        assert_eq!(list(&root(&d)).branch, sha);
    }

    #[test]
    fn list_in_an_unborn_repo_names_the_branch() {
        let d = TempDir::new();
        git(d.path(), &["init", "-q", "-b", "trunk"]);
        std::fs::write(d.path().join("a.txt"), "").unwrap();
        let l = list(&root(&d));
        assert_eq!(l.branch.as_deref(), Some("trunk"));
        assert_eq!(l.changes.get("a.txt"), Some(&GitChange::A));
    }

    #[test]
    fn list_in_a_repo_subdirectory_is_relative_to_the_root() {
        let d = TempDir::new();
        git(d.path(), &["init", "-q"]);
        std::fs::create_dir_all(d.path().join("pkg")).unwrap();
        std::fs::write(d.path().join("pkg/a.ts"), "").unwrap();
        std::fs::write(d.path().join("top.ts"), "").unwrap();
        let sub = d.path().join("pkg").to_string_lossy().into_owned();
        let l = list(&sub);
        assert_eq!(l.paths, vec!["a.ts"]);
        assert_eq!(l.changes.keys().collect::<Vec<_>>(), vec!["a.ts"]);
    }

    #[test]
    fn list_outside_a_repo_has_no_branch_and_no_changes() {
        let d = TempDir::new();
        std::fs::write(d.path().join("a.txt"), "").unwrap();
        let l = list(&root(&d));
        assert_eq!(l.branch, None);
        assert!(l.changes.is_empty());
    }
}
