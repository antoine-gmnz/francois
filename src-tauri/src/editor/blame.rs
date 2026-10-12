// editor/blame.rs — code-editor-workspace FR-16: the inline blame for one
// line, `git blame --porcelain -L n,n -- <path>` against the file as on disk.
// Every "no answer" (not a repo, untracked, line past the end, uncommitted
// line) is `None`, never an error; only path safety errors.

use super::files;
use crate::diff::{git_routed, is_git_repo, GitHost};
use crate::ipc::AppError;
use serde::Serialize;

/// Mirrors contract/code-editor-workspace.ts::EditorBlameLine.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct EditorBlameLine {
    pub author: String,
    /// Author time, epoch ms.
    pub time: i64,
    pub summary: String,
    pub sha: String,
}

/// The first entry of `git blame --porcelain` output; None for an
/// uncommitted (all-zero sha) or malformed entry.
pub(crate) fn parse_porcelain(out: &str) -> Option<EditorBlameLine> {
    let mut lines = out.lines();
    let sha = lines.next()?.split(' ').next()?.to_string();
    if sha.len() < 40
        || !sha.bytes().all(|b| b.is_ascii_hexdigit())
        || sha.bytes().all(|b| b == b'0')
    {
        return None;
    }
    let (mut author, mut time, mut summary) = (None, None, String::new());
    for l in lines.take_while(|l| !l.starts_with('\t')) {
        if let Some(v) = l.strip_prefix("author ") {
            author = Some(v.to_string());
        } else if let Some(v) = l.strip_prefix("author-time ") {
            time = v.trim().parse::<i64>().ok();
        } else if let Some(v) = l.strip_prefix("summary ") {
            summary = v.to_string();
        }
    }
    Some(EditorBlameLine {
        author: author?,
        time: time? * 1000,
        summary,
        sha,
    })
}

pub(crate) fn blame(dir: &str, path: &str, line: u32) -> Result<Option<EditorBlameLine>, AppError> {
    let resolved = files::resolve(dir, path)?;
    if line == 0 {
        return Ok(None);
    }
    let host = GitHost::of(dir);
    if !is_git_repo(&host, dir) {
        return Ok(None);
    }
    let range = format!("{line},{line}");
    let args = ["blame", "--porcelain", "-L", &range, "--", &resolved.rel];
    Ok(match git_routed(&host, dir, &args) {
        Ok(out) if out.code == 0 => parse_porcelain(&String::from_utf8_lossy(&out.stdout)),
        _ => None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::editor::testutil::{git, TempDir};
    use serde_json::json;

    const SAMPLE: &str = "\
3f786850e387550fdab836ed7e6dc881de23001b 2 2 1
author Ada Lovelace
author-mail <ada@example.com>
author-time 1700000000
author-tz +0100
committer Ada Lovelace
committer-mail <ada@example.com>
committer-time 1700000100
committer-tz +0100
summary Teach the engine to count
previous 1111111111111111111111111111111111111111 a.txt
filename a.txt
\tlet x = 1;
";

    #[test]
    fn parses_a_porcelain_entry() {
        let b = parse_porcelain(SAMPLE).unwrap();
        assert_eq!(
            b,
            EditorBlameLine {
                author: "Ada Lovelace".into(),
                time: 1_700_000_000_000,
                summary: "Teach the engine to count".into(),
                sha: "3f786850e387550fdab836ed7e6dc881de23001b".into(),
            }
        );
        assert_eq!(
            serde_json::to_value(&b).unwrap(),
            json!({"author": "Ada Lovelace", "time": 1_700_000_000_000_i64,
                   "summary": "Teach the engine to count",
                   "sha": "3f786850e387550fdab836ed7e6dc881de23001b"})
        );
    }

    #[test]
    fn an_uncommitted_line_or_garbage_is_none() {
        let zero = SAMPLE.replace("3f786850e387550fdab836ed7e6dc881de23001b", &"0".repeat(40));
        assert_eq!(parse_porcelain(&zero), None);
        assert_eq!(parse_porcelain(""), None);
        assert_eq!(parse_porcelain("fatal: no such path\n"), None);
    }

    #[test]
    fn blames_a_committed_line_in_a_temp_repo() {
        let d = TempDir::new();
        let dir = d.path().to_string_lossy().into_owned();
        git(d.path(), &["init", "-q"]);
        std::fs::write(d.path().join("a.txt"), "one\ntwo\n").unwrap();
        git(d.path(), &["add", "a.txt"]);
        git(d.path(), &["commit", "-q", "-m", "first lines"]);
        std::fs::write(d.path().join("a.txt"), "one\ntwo\nthree\n").unwrap();
        std::fs::write(d.path().join("u.txt"), "u\n").unwrap();

        let b = blame(&dir, "a.txt", 2).unwrap().unwrap();
        assert_eq!(b.author, "t");
        assert_eq!(b.summary, "first lines");
        assert_eq!(b.sha.len(), 40);
        assert!(b.time > 1_000_000_000_000);

        assert_eq!(blame(&dir, "a.txt", 3).unwrap(), None, "uncommitted line");
        assert_eq!(blame(&dir, "a.txt", 99).unwrap(), None, "past the end");
        assert_eq!(blame(&dir, "a.txt", 0).unwrap(), None);
        assert_eq!(blame(&dir, "u.txt", 1).unwrap(), None, "untracked");
        let e = blame(&dir, "../x.txt", 1).unwrap_err();
        assert_eq!(e.code, crate::ipc::ErrorCode::EditorOutsideRoot);
    }

    #[test]
    fn outside_a_repo_is_none() {
        let d = TempDir::new();
        std::fs::write(d.path().join("a.txt"), "x\n").unwrap();
        let dir = d.path().to_string_lossy().into_owned();
        assert_eq!(blame(&dir, "a.txt", 1).unwrap(), None);
    }
}
