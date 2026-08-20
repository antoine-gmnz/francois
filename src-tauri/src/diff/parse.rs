//! pure parsers for porcelain/numstat/unified-diff output.

use super::*;

use std::collections::HashMap;

// ---------- parsers (pure — unit tested) ----------

pub(crate) fn num(s: &str) -> u64 {
    if s == "-" {
        0
    } else {
        s.trim().parse().unwrap_or(0)
    }
}

pub(crate) fn split_path(p: &str) -> (String, String) {
    match p.rfind('/') {
        Some(i) => (p[..i].to_string(), p[i + 1..].to_string()),
        None => (String::new(), p.to_string()),
    }
}

pub(crate) fn map_status(xy: &str) -> DiffFileStatus {
    if xy == "??" {
        return DiffFileStatus::Untracked;
    }
    // identity status wins: added > renamed > deleted > modified (FR-3).
    if xy.contains('A') {
        DiffFileStatus::Added
    } else if xy.starts_with('R') {
        DiffFileStatus::Renamed
    } else if xy.contains('D') {
        DiffFileStatus::Deleted
    } else {
        DiffFileStatus::Modified
    }
}

/// Parse `git status --porcelain=v1 -z` into (xy, path). Each record is
/// `XY<space>PATH\0`; a rename/copy (`R`/`C`) is followed by an extra NUL field
/// carrying the origin path (the new path comes first — we keep it, discard origin).
pub(crate) fn parse_porcelain_z(data: &[u8]) -> Vec<(String, String)> {
    let s = String::from_utf8_lossy(data);
    let tokens: Vec<&str> = s.split('\0').collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < tokens.len() {
        let tok = tokens[i];
        i += 1;
        if tok.len() < 3 {
            continue; // trailing empty / malformed
        }
        let xy = tok[..2].to_string();
        let path = tok[3..].to_string(); // skip 2-char code + 1 space
        if xy.starts_with('R') || xy.starts_with('C') {
            i += 1; // consume + discard the origin-path field
        }
        out.push((xy, path));
    }
    out
}

/// Parse `git diff -z --numstat` into path -> (additions, deletions). Normal record
/// is `add\tdel\tpath\0`; a rename is `add\tdel\t\0oldpath\0newpath\0` (empty path
/// field signals rename; the new path is the second field). Binary is `-\t-`.
pub(crate) fn parse_numstat_z(data: &[u8]) -> HashMap<String, (u64, u64)> {
    let s = String::from_utf8_lossy(data);
    let tokens: Vec<&str> = s.split('\0').collect();
    let mut map = HashMap::new();
    let mut i = 0;
    while i < tokens.len() {
        let tok = tokens[i];
        i += 1;
        if tok.is_empty() {
            continue;
        }
        let mut parts = tok.splitn(3, '\t');
        let add = parts.next().unwrap_or("");
        let del = parts.next().unwrap_or("");
        let rest = parts.next().unwrap_or("");
        if del.is_empty() {
            continue; // not a numstat header — skip defensively
        }
        let counts = (num(add), num(del));
        let path = if rest.is_empty() {
            // rename: next two tokens are old, new
            i += 1; // old (discard)
            let new = tokens.get(i).copied().unwrap_or("");
            i += 1;
            new.to_string()
        } else {
            rest.to_string()
        };
        if !path.is_empty() {
            map.insert(path, counts);
        }
    }
    map
}

/// diff-review FR-15: single-letter status from `git diff --name-status`, as
/// opposed to `map_status`'s two-char porcelain code. `R`/`C` (rename/copy,
/// with a trailing similarity number e.g. `R100`) map to Renamed; everything
/// else that isn't `A`/`D` is Modified (covers `M`, `T`, `U`).
pub(crate) fn map_name_status(code: &str) -> DiffFileStatus {
    match code.chars().next() {
        Some('A') => DiffFileStatus::Added,
        Some('D') => DiffFileStatus::Deleted,
        Some('R') | Some('C') => DiffFileStatus::Renamed,
        _ => DiffFileStatus::Modified,
    }
}

/// Parse `git diff --name-status -z` into (status, path). With `-z`, EVERY
/// separator becomes NUL — including the one between the status letter and
/// the path — so a plain record is `STATUS\0PATH\0`, and a rename/copy
/// (`R100`/`C100`) is `STATUS\0OLDPATH\0NEWPATH\0`; the new path is the
/// following token, mirroring `parse_porcelain_z`'s handling of that shape.
pub(crate) fn parse_name_status_z(data: &[u8]) -> Vec<(String, String)> {
    let s = String::from_utf8_lossy(data);
    let tokens: Vec<&str> = s.split('\0').collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < tokens.len() {
        let status = tokens[i];
        i += 1;
        if status.is_empty() {
            continue; // trailing empty token
        }
        let Some(path) = tokens.get(i) else { break };
        i += 1;
        if status.starts_with('R') || status.starts_with('C') {
            let Some(new_path) = tokens.get(i) else {
                break;
            };
            i += 1;
            out.push((status.to_string(), new_path.to_string()));
        } else {
            out.push((status.to_string(), path.to_string()));
        }
    }
    out
}

/// diff-review §5: field separator `\x1f`, record separator `\x1e` for
/// `git log --format=%H%x1f%h%x1f%at%x1f%s%x1f%b%x1e`. Records with fewer than
/// 4 fields (a malformed/partial trailing record) are dropped defensively.
pub(crate) fn parse_commit_log(text: &str) -> Vec<(String, String, i64, String, String)> {
    text.split('\u{1e}')
        .filter(|rec| !rec.trim_matches('\n').is_empty())
        .filter_map(|rec| {
            let rec = rec.trim_start_matches('\n'); // record sep is followed by log's own '\n'
            let mut parts = rec.splitn(5, '\u{1f}');
            let hash = parts.next()?.to_string();
            let short = parts.next()?.to_string();
            let at: i64 = parts.next()?.trim().parse().ok()?;
            let subject = parts.next()?.to_string();
            let body = parts
                .next()
                .unwrap_or("")
                .trim_end_matches('\n')
                .to_string();
            Some((hash, short, at, subject, body))
        })
        .collect()
}

/// diff-review §5 `DiffGetFileDiffRequest.context`: clamp to `[0, 10000]`,
/// default 3 when absent. Pure.
pub(crate) fn clamp_context(context: Option<i64>) -> u32 {
    context.unwrap_or(3).clamp(0, 10000) as u32
}

pub(crate) fn parse_hunk_header(line: &str) -> (u64, u64) {
    // Only read the `-a,b +c,d` between the first and second `@@`; git appends
    // function-context text after the closing `@@` that can contain `+`/`-` tokens.
    let (mut old, mut new) = (0u64, 0u64);
    let (mut in_range, mut got_old, mut got_new) = (false, false, false);
    for tok in line.split(' ') {
        if tok == "@@" {
            if in_range {
                break; // closing @@ — ignore trailing context
            }
            in_range = true;
            continue;
        }
        if !in_range {
            continue;
        }
        if let (false, Some(r)) = (got_old, tok.strip_prefix('-')) {
            old = r.split(',').next().unwrap_or("0").parse().unwrap_or(0);
            got_old = true;
        } else if let (false, Some(r)) = (got_new, tok.strip_prefix('+')) {
            new = r.split(',').next().unwrap_or("0").parse().unwrap_or(0);
            got_new = true;
        }
    }
    (old, new)
}

/// Parse a unified diff patch into hunks (FR-9). Preamble before the first `@@`
/// (diff --git / index / +++/--- lines) is skipped; the `\ No newline` marker is dropped.
pub(crate) fn parse_unified_diff(text: &str) -> Vec<DiffHunk> {
    let mut hunks: Vec<DiffHunk> = Vec::new();
    let (mut old_no, mut new_no) = (0u64, 0u64);
    for line in text.split('\n') {
        if line.starts_with("@@") {
            let (os, ns) = parse_hunk_header(line);
            old_no = os;
            new_no = ns;
            hunks.push(DiffHunk {
                header: line.to_string(),
                lines: Vec::new(),
            });
            continue;
        }
        let Some(h) = hunks.last_mut() else { continue }; // still in preamble
        match line.as_bytes().first().copied() {
            Some(b' ') => {
                h.lines.push(DiffLine {
                    kind: "ctx",
                    old_no: Some(old_no),
                    new_no: Some(new_no),
                    text: line[1..].to_string(),
                });
                old_no += 1;
                new_no += 1;
            }
            Some(b'+') if !line.starts_with("+++") => {
                h.lines.push(DiffLine {
                    kind: "add",
                    old_no: None,
                    new_no: Some(new_no),
                    text: line[1..].to_string(),
                });
                new_no += 1;
            }
            Some(b'-') if !line.starts_with("---") => {
                h.lines.push(DiffLine {
                    kind: "del",
                    old_no: Some(old_no),
                    new_no: None,
                    text: line[1..].to_string(),
                });
                old_no += 1;
            }
            _ => {} // `\ No newline`, blank tail, or stray line — dropped
        }
    }
    hunks
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn porcelain_z_parses_rename_and_discards_origin() {
        let data = b"R  renamed.txt\0torename.txt\0 M tracked.txt\0?? bin.dat\0?? untracked.txt\0";
        let out = parse_porcelain_z(data);
        assert_eq!(
            out,
            vec![
                ("R ".to_string(), "renamed.txt".to_string()),
                (" M".to_string(), "tracked.txt".to_string()),
                ("??".to_string(), "bin.dat".to_string()),
                ("??".to_string(), "untracked.txt".to_string()),
            ]
        );
    }

    #[test]
    fn numstat_z_parses_rename_new_path() {
        let data = b"0\t0\t\0torename.txt\0renamed.txt\x002\t1\ttracked.txt\0";
        let m = parse_numstat_z(data);
        assert_eq!(m.get("renamed.txt"), Some(&(0, 0)));
        assert_eq!(m.get("tracked.txt"), Some(&(2, 1)));
        assert_eq!(m.len(), 2);
    }

    #[test]
    fn numstat_binary_is_zero() {
        let m = parse_numstat_z(b"-\t-\tbin.dat\0");
        assert_eq!(m.get("bin.dat"), Some(&(0, 0)));
    }

    #[test]
    fn status_precedence() {
        assert_eq!(map_status("??"), DiffFileStatus::Untracked);
        assert_eq!(map_status("AM"), DiffFileStatus::Added); // added wins
        assert_eq!(map_status("R "), DiffFileStatus::Renamed);
        assert_eq!(map_status("RM"), DiffFileStatus::Renamed); // rename identity wins over M
        assert_eq!(map_status(" D"), DiffFileStatus::Deleted);
        assert_eq!(map_status(" M"), DiffFileStatus::Modified);
        assert_eq!(map_status("MM"), DiffFileStatus::Modified);
    }

    #[test]
    fn split_path_repo_root_and_nested() {
        assert_eq!(
            split_path("file.rs"),
            ("".to_string(), "file.rs".to_string())
        );
        assert_eq!(
            split_path("src/auth/mw.ts"),
            ("src/auth".to_string(), "mw.ts".to_string())
        );
    }

    #[test]
    fn unified_diff_line_numbers_and_kinds() {
        let patch = "diff --git a/f b/f\nindex 000..111 100644\n--- a/f\n+++ b/f\n@@ -1,3 +1,4 @@\n line1\n-line2\n+CHANGED\n+added\n line3\n\\ No newline at end of file\n";
        let hunks = parse_unified_diff(patch);
        assert_eq!(hunks.len(), 1);
        assert_eq!(hunks[0].header, "@@ -1,3 +1,4 @@");
        let l = &hunks[0].lines;
        assert_eq!(l.len(), 5); // ctx, del, add, add, ctx  ('\ No newline' dropped)
        assert_eq!(
            (l[0].kind, l[0].old_no, l[0].new_no),
            ("ctx", Some(1), Some(1))
        );
        assert_eq!(
            (l[1].kind, l[1].old_no, l[1].new_no, l[1].text.as_str()),
            ("del", Some(2), None, "line2")
        );
        assert_eq!(
            (l[2].kind, l[2].old_no, l[2].new_no, l[2].text.as_str()),
            ("add", None, Some(2), "CHANGED")
        );
        assert_eq!((l[3].kind, l[3].new_no), ("add", Some(3)));
        assert_eq!(
            (l[4].kind, l[4].old_no, l[4].new_no),
            ("ctx", Some(3), Some(4))
        );
    }

    #[test]
    fn hunk_header_without_line_counts() {
        assert_eq!(parse_hunk_header("@@ -1 +1 @@"), (1, 1));
        assert_eq!(parse_hunk_header("@@ -10,3 +12,5 @@ fn foo()"), (10, 12));
    }

    #[test]
    fn hunk_header_ignores_context_with_plus_minus_tokens() {
        // trailing function-context containing '-'/'+' tokens must not hijack the counters (M6)
        assert_eq!(
            parse_hunk_header("@@ -10,6 +20,6 @@ def f(a - b + c):"),
            (10, 20)
        );
        assert_eq!(parse_hunk_header("@@ -1,4 +1,5 @@ - bullet + item"), (1, 1));
    }

    #[test]
    fn unified_diff_multi_hunk_resets_counters_per_hunk() {
        let patch = "@@ -1,2 +1,2 @@\n a\n-b\n+B\n@@ -50,2 +80,3 @@\n x\n+Y\n z\n";
        let hunks = parse_unified_diff(patch);
        assert_eq!(hunks.len(), 2);
        // first hunk starts at old 1 / new 1
        assert_eq!(
            (hunks[0].lines[0].old_no, hunks[0].lines[0].new_no),
            (Some(1), Some(1))
        );
        assert_eq!(
            (hunks[0].lines[1].kind, hunks[0].lines[1].old_no),
            ("del", Some(2))
        );
        // second hunk resets to old 50 / new 80
        assert_eq!(
            (
                hunks[1].lines[0].kind,
                hunks[1].lines[0].old_no,
                hunks[1].lines[0].new_no
            ),
            ("ctx", Some(50), Some(80))
        );
        assert_eq!(
            (hunks[1].lines[1].kind, hunks[1].lines[1].new_no),
            ("add", Some(81))
        );
        assert_eq!(
            (
                hunks[1].lines[2].kind,
                hunks[1].lines[2].old_no,
                hunks[1].lines[2].new_no
            ),
            ("ctx", Some(51), Some(82))
        );
    }

    #[test]
    fn num_parses_counts_and_binary_dash() {
        assert_eq!(num("0"), 0);
        assert_eq!(num("42"), 42);
        assert_eq!(num("-"), 0); // git's binary marker
        assert_eq!(num(""), 0);
    }

    // ---- diff-review: name-status / commit-log / context clamp ----

    #[test]
    fn name_status_maps_the_single_letter_code() {
        assert_eq!(map_name_status("A"), DiffFileStatus::Added);
        assert_eq!(map_name_status("D"), DiffFileStatus::Deleted);
        assert_eq!(map_name_status("R100"), DiffFileStatus::Renamed);
        assert_eq!(map_name_status("C75"), DiffFileStatus::Renamed);
        assert_eq!(map_name_status("M"), DiffFileStatus::Modified);
        assert_eq!(map_name_status("T"), DiffFileStatus::Modified);
    }

    #[test]
    fn name_status_z_parses_rename_and_plain_records() {
        // `-z` turns EVERY separator into NUL, including status<->path.
        let data = b"M\0tracked.txt\0A\0new.txt\0D\0gone.txt\0R100\0old.txt\0new.txt\0";
        let out = parse_name_status_z(data);
        assert_eq!(
            out,
            vec![
                ("M".to_string(), "tracked.txt".to_string()),
                ("A".to_string(), "new.txt".to_string()),
                ("D".to_string(), "gone.txt".to_string()),
                ("R100".to_string(), "new.txt".to_string()),
            ]
        );
    }

    #[test]
    fn commit_log_parses_hash_short_time_subject_and_body() {
        let text = "\
hash1\u{1f}h1\u{1f}1700000000\u{1f}first subject\u{1f}\u{1e}
hash2\u{1f}h2\u{1f}1700000100\u{1f}second subject\u{1f}line one\nline two\u{1e}
";
        let out = parse_commit_log(text);
        assert_eq!(out.len(), 2);
        assert_eq!(
            out[0],
            (
                "hash1".to_string(),
                "h1".to_string(),
                1_700_000_000,
                "first subject".to_string(),
                String::new(),
            )
        );
        assert_eq!(
            out[1],
            (
                "hash2".to_string(),
                "h2".to_string(),
                1_700_000_100,
                "second subject".to_string(),
                "line one\nline two".to_string(),
            )
        );
    }

    #[test]
    fn commit_log_drops_a_malformed_trailing_record() {
        assert_eq!(parse_commit_log("").len(), 0);
        assert_eq!(parse_commit_log("\n").len(), 0);
    }

    #[test]
    fn context_clamps_into_range_and_defaults_to_three() {
        assert_eq!(clamp_context(None), 3);
        assert_eq!(clamp_context(Some(0)), 0);
        assert_eq!(clamp_context(Some(-5)), 0);
        assert_eq!(clamp_context(Some(10)), 10);
        assert_eq!(clamp_context(Some(50_000)), 10_000);
    }
}
