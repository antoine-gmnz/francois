// editor/search.rs — code-editor-workspace FR-14/FR-15: project-wide search
// and replace-all over the files `editor_files` lists.
//
// Search reads DISK (never buffers), one line at a time with the `regex`
// crate; replace re-reads each target and writes it back through files.rs's
// atomic writer, so line ending, BOM and trailing newline survive exactly as
// they do for editor_save. The include filter reuses listing.rs's glob.

use super::files::{self, Resolved};
use super::listing;
use super::{EDITOR_BINARY_SNIFF_BYTES, EDITOR_OPEN_CAP_BYTES};
use crate::ipc::{AppError, ErrorCode};
use regex::{Captures, Regex};
use serde::{Deserialize, Serialize};
use std::path::Path;

type Res<T> = Result<T, AppError>;

// ---------- model (mirrors contract/code-editor-workspace.ts EXACTLY) ----------

pub(crate) const EDITOR_SEARCH_MAX_MATCHES: usize = 2_000;
pub(crate) const EDITOR_SEARCH_MAX_FILES: usize = 500;
pub(crate) const EDITOR_SEARCH_PREVIEW_CHARS: usize = 200;
pub(crate) const EDITOR_SEARCH_QUERY_MAX: usize = 1_000;

/// Characters of context kept before the match when a preview is clipped.
const PREVIEW_LEAD_CHARS: usize = 40;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct EditorSearchOptions {
    pub match_case: bool,
    pub whole_word: bool,
    pub regex: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EditorSearchMatch {
    pub line: u32,
    pub column: u32,
    pub preview: String,
    pub preview_start: u32,
    pub preview_end: u32,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct EditorSearchFile {
    pub path: String,
    pub matches: Vec<EditorSearchMatch>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EditorSearchData {
    pub files: Vec<EditorSearchFile>,
    pub match_count: u32,
    pub truncated: bool,
}

#[derive(Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EditorReplaceFileTarget {
    pub path: String,
    #[serde(default)]
    pub base_version: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct EditorReplaceWritten {
    pub path: String,
    pub version: String,
    pub replacements: u32,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SkipReason {
    Stale,
    NotFound,
    Binary,
    OutsideRoot,
    WriteFailed,
    NoMatch,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct EditorReplaceSkipped {
    pub path: String,
    pub reason: SkipReason,
}

#[derive(Serialize, Clone, Debug, PartialEq, Default)]
pub struct EditorReplaceData {
    pub written: Vec<EditorReplaceWritten>,
    pub skipped: Vec<EditorReplaceSkipped>,
}

/// editor_replace's non-file inputs.
pub(crate) struct ReplaceSpec<'a> {
    pub query: &'a str,
    pub options: EditorSearchOptions,
    pub replacement: &'a str,
    pub preserve_case: bool,
}

// ---------- the matcher ----------

fn internal(msg: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::Internal, msg)
}

/// literal -> escaped; wholeWord -> `\b(?:…)\b`; !matchCase -> `(?i)`.
pub(crate) fn build_regex(query: &str, opts: EditorSearchOptions) -> Res<Regex> {
    if query.is_empty() {
        return Err(internal("The search query is empty"));
    }
    if query.chars().count() > EDITOR_SEARCH_QUERY_MAX {
        return Err(internal(format!(
            "The search query is too long (over {EDITOR_SEARCH_QUERY_MAX} characters)"
        )));
    }
    let mut pattern = if opts.regex {
        query.to_string()
    } else {
        regex::escape(query)
    };
    if opts.whole_word {
        pattern = format!(r"\b(?:{pattern})\b");
    }
    if !opts.match_case {
        pattern = format!("(?i){pattern}");
    }
    Regex::new(&pattern).map_err(|e| internal(format!("Invalid regular expression: {e}")))
}

fn utf16_len(s: &str) -> u32 {
    s.encode_utf16().count() as u32
}

/// The FR-14 preview of one match: leading whitespace trimmed (never past the
/// match start), clipped to EDITOR_SEARCH_PREVIEW_CHARS characters including
/// the '…' on a clipped side. Returns (preview, previewStart, previewEnd) in UTF-16.
fn preview(line: &str, start: usize, end: usize) -> (String, u32, u32) {
    let indent = line.len() - line.trim_start().len();
    let cut = indent.min(start);
    let body = &line[cut..];
    let chars: Vec<(usize, char)> = body.char_indices().collect();
    let len = chars.len();
    let char_at = |byte: usize| chars.partition_point(|&(b, _)| b < byte);
    let (ms, me) = (char_at(start - cut), char_at(end - cut));
    let n = EDITOR_SEARCH_PREVIEW_CHARS;
    let (from, to, left, right) = if len <= n {
        (0, len, false, false)
    } else {
        let from = ms.saturating_sub(PREVIEW_LEAD_CHARS).min(len - (n - 1));
        let left = from > 0;
        let budget = n - usize::from(left);
        if len - from > budget {
            (from, from + budget - 1, left, true)
        } else {
            (from, len, left, false)
        }
    };
    let byte = |i: usize| chars.get(i).map_or(body.len(), |&(b, _)| b);
    let slice = |a: usize, b: usize| &body[byte(a)..byte(b)];
    let mut out = String::new();
    if left {
        out.push('…');
    }
    let pre_start = utf16_len(&out) + utf16_len(slice(from, ms.max(from)));
    let pre_end = pre_start + utf16_len(slice(ms.max(from), me.min(to).max(from)));
    out.push_str(slice(from, to));
    if right {
        out.push('…');
    }
    (out, pre_start, pre_end)
}

/// Every match in `text`, line by line, stopping after `limit`. The bool is
/// `true` when more matches existed past the limit.
fn text_matches(re: &Regex, text: &str, limit: usize) -> (Vec<EditorSearchMatch>, bool) {
    let mut out = Vec::new();
    for (i, line) in text.lines().enumerate() {
        for m in re.find_iter(line) {
            if out.len() == limit {
                return (out, true);
            }
            let (preview, preview_start, preview_end) = preview(line, m.start(), m.end());
            out.push(EditorSearchMatch {
                line: i as u32 + 1,
                column: utf16_len(&line[..m.start()]) + 1,
                preview,
                preview_start,
                preview_end,
            });
        }
    }
    (out, false)
}

// ---------- include globs ----------

/// FR-14 "files to include": comma-separated; empty = every file. A pattern
/// without glob characters names a file or folder (`services` = `services/**`);
/// a trailing `/` means the folder's contents; a pattern without `/` (`*.ts`)
/// matches the basename at any depth, like a .gitignore entry.
pub(crate) struct Include(Vec<String>);

impl Include {
    pub(crate) fn parse(raw: &str) -> Self {
        Include(
            raw.split(',')
                .map(|p| p.trim().replace('\\', "/"))
                .map(|p| p.trim_start_matches("./").to_string())
                .filter(|p| !p.is_empty())
                .collect(),
        )
    }

    pub(crate) fn matches(&self, rel: &str) -> bool {
        self.0.is_empty() || self.0.iter().any(|p| pattern_matches(p, rel))
    }
}

fn pattern_matches(pattern: &str, rel: &str) -> bool {
    if !pattern.contains(['*', '?']) {
        let p = pattern.trim_matches('/');
        return rel == p || rel.strip_prefix(p).is_some_and(|r| r.starts_with('/'));
    }
    let pattern = match pattern.strip_suffix('/') {
        Some(dir) => format!("{dir}/**"),
        None => pattern.to_string(),
    };
    let pattern = pattern.trim_start_matches('/');
    if pattern.contains('/') {
        return listing::glob(pattern.as_bytes(), rel.as_bytes());
    }
    let name = rel.rsplit('/').next().unwrap_or(rel);
    listing::glob(pattern.as_bytes(), name.as_bytes())
}

// ---------- FR-14: search ----------

/// UTF-8 text of a searchable file (BOM stripped); None when missing, over
/// EDITOR_OPEN_CAP_BYTES, binary (NUL in the sniff window) or not UTF-8.
fn read_text(abs: &Path) -> Option<String> {
    let meta = std::fs::metadata(abs).ok()?;
    if !meta.is_file() || meta.len() > EDITOR_OPEN_CAP_BYTES {
        return None;
    }
    let bytes = std::fs::read(abs).ok()?;
    if bytes[..bytes.len().min(EDITOR_BINARY_SNIFF_BYTES)].contains(&0) {
        return None;
    }
    let body = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(&bytes);
    String::from_utf8(body.to_vec()).ok()
}

pub(crate) fn search(
    dir: &str,
    query: &str,
    options: EditorSearchOptions,
    include: &str,
) -> Res<EditorSearchData> {
    let re = build_regex(query, options)?;
    if !Path::new(dir).is_dir() {
        return Err(internal("the root directory no longer exists"));
    }
    let include = Include::parse(include);
    let (paths, listing_truncated) = listing::paths(dir);
    let mut data = EditorSearchData {
        files: Vec::new(),
        match_count: 0,
        truncated: listing_truncated,
    };
    for rel in paths.iter().filter(|p| include.matches(p)) {
        let Some(text) = read_text(&Path::new(dir).join(rel)) else {
            continue;
        };
        let left = EDITOR_SEARCH_MAX_MATCHES - data.match_count as usize;
        let (matches, more) = text_matches(&re, &text, left);
        if matches.is_empty() {
            if more {
                data.truncated = true;
                break;
            }
            continue;
        }
        if data.files.len() == EDITOR_SEARCH_MAX_FILES {
            data.truncated = true;
            break;
        }
        data.match_count += matches.len() as u32;
        data.files.push(EditorSearchFile {
            path: rel.clone(),
            matches,
        });
        if more {
            data.truncated = true;
            break;
        }
    }
    Ok(data)
}

// ---------- FR-15: replace ----------

/// "AB": an all-upper match gets an upper-cased replacement, a capitalised one
/// a capitalised replacement, otherwise the replacement as typed.
fn apply_case(matched: &str, replacement: String) -> String {
    let has_letters = matched.chars().any(char::is_alphabetic);
    if !has_letters {
        return replacement;
    }
    if !matched.chars().any(char::is_lowercase) && matched.chars().count() > 1 {
        return replacement.to_uppercase();
    }
    let first_upper = matched
        .chars()
        .find(|c| c.is_alphabetic())
        .is_some_and(char::is_uppercase);
    if first_upper {
        let mut cs = replacement.chars();
        return match cs.next() {
            Some(c) => c.to_uppercase().chain(cs).collect(),
            None => replacement,
        };
    }
    replacement
}

/// Replace every per-line match in LF text; returns the new text and the count.
fn replace_text(re: &Regex, text: &str, spec: &ReplaceSpec<'_>) -> (String, u32) {
    let mut count = 0u32;
    let lines: Vec<String> = text
        .split('\n')
        .map(|line| {
            re.replace_all(line, |caps: &Captures| {
                count += 1;
                let mut rep = String::new();
                if spec.options.regex {
                    caps.expand(spec.replacement, &mut rep);
                } else {
                    rep.push_str(spec.replacement);
                }
                if spec.preserve_case {
                    rep = apply_case(&caps[0], rep);
                }
                rep
            })
            .into_owned()
        })
        .collect();
    (lines.join("\n"), count)
}

fn skip_reason(e: &AppError) -> SkipReason {
    match e.code {
        ErrorCode::EditorOutsideRoot => SkipReason::OutsideRoot,
        ErrorCode::EditorStale => SkipReason::Stale,
        ErrorCode::EditorWriteFailed => SkipReason::WriteFailed,
        ErrorCode::EditorBinary | ErrorCode::EditorTooLarge => SkipReason::Binary,
        _ => SkipReason::NotFound,
    }
}

fn replace_one(
    dir: &str,
    re: &Regex,
    spec: &ReplaceSpec<'_>,
    target: &EditorReplaceFileTarget,
) -> Result<EditorReplaceWritten, SkipReason> {
    let Resolved { abs, rel } = files::resolve(dir, &target.path).map_err(|e| skip_reason(&e))?;
    let loaded = files::load(&abs).map_err(|e| skip_reason(&e))?;
    if target
        .base_version
        .as_deref()
        .is_some_and(|v| v != loaded.version)
    {
        return Err(SkipReason::Stale);
    }
    let (text, replacements) = replace_text(re, &loaded.text, spec);
    if replacements == 0 {
        return Err(SkipReason::NoMatch);
    }
    let version = files::save_file(&abs, &text, &loaded.version, loaded.line_ending, loaded.bom)
        .map_err(|e| skip_reason(&e))?;
    Ok(EditorReplaceWritten {
        path: rel,
        version,
        replacements,
    })
}

pub(crate) fn replace(
    dir: &str,
    spec: &ReplaceSpec<'_>,
    targets: &[EditorReplaceFileTarget],
) -> Res<EditorReplaceData> {
    let re = build_regex(spec.query, spec.options)?;
    let mut data = EditorReplaceData::default();
    for t in targets {
        match replace_one(dir, &re, spec, t) {
            Ok(w) => data.written.push(w),
            Err(reason) => data.skipped.push(EditorReplaceSkipped {
                path: t.path.clone(),
                reason,
            }),
        }
    }
    Ok(data)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::editor::testutil::{git, TempDir};
    use serde_json::json;

    const LIT: EditorSearchOptions = EditorSearchOptions {
        match_case: false,
        whole_word: false,
        regex: false,
    };
    const RX: EditorSearchOptions = EditorSearchOptions {
        match_case: false,
        whole_word: false,
        regex: true,
    };

    fn root(d: &TempDir) -> String {
        d.path().to_string_lossy().into_owned()
    }

    fn write(d: &TempDir, rel: &str, bytes: &[u8]) {
        let p = d.path().join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, bytes).unwrap();
    }

    fn read(d: &TempDir, rel: &str) -> String {
        std::fs::read_to_string(d.path().join(rel)).unwrap()
    }

    fn cols(re: &Regex, text: &str) -> Vec<(u32, u32)> {
        text_matches(re, text, usize::MAX)
            .0
            .iter()
            .map(|m| (m.line, m.column))
            .collect()
    }

    // ---- serde ----

    #[test]
    fn options_and_targets_deserialize_from_the_contract_shape() {
        let o: EditorSearchOptions =
            serde_json::from_value(json!({"matchCase": true, "wholeWord": false, "regex": true}))
                .unwrap();
        assert_eq!(
            o,
            EditorSearchOptions {
                match_case: true,
                whole_word: false,
                regex: true
            }
        );
        assert_eq!(serde_json::to_value(o).unwrap()["matchCase"], json!(true));
        let ts: Vec<EditorReplaceFileTarget> =
            serde_json::from_value(json!([{"path": "a"}, {"path": "b", "baseVersion": "1:2:3"}]))
                .unwrap();
        assert_eq!(ts[0].base_version, None);
        assert_eq!(ts[1].base_version.as_deref(), Some("1:2:3"));
    }

    #[test]
    fn data_serializes_to_the_contract_shape() {
        let d = EditorSearchData {
            files: vec![EditorSearchFile {
                path: "a.ts".into(),
                matches: vec![EditorSearchMatch {
                    line: 1,
                    column: 2,
                    preview: "x".into(),
                    preview_start: 0,
                    preview_end: 1,
                }],
            }],
            match_count: 1,
            truncated: false,
        };
        assert_eq!(
            serde_json::to_value(&d).unwrap(),
            json!({"files": [{"path": "a.ts", "matches": [{"line": 1, "column": 2,
                "preview": "x", "previewStart": 0, "previewEnd": 1}]}],
                "matchCount": 1, "truncated": false})
        );
        let r = EditorReplaceData {
            written: vec![EditorReplaceWritten {
                path: "a".into(),
                version: "v".into(),
                replacements: 2,
            }],
            skipped: vec![
                EditorReplaceSkipped {
                    path: "b".into(),
                    reason: SkipReason::OutsideRoot,
                },
                EditorReplaceSkipped {
                    path: "c".into(),
                    reason: SkipReason::NoMatch,
                },
            ],
        };
        assert_eq!(
            serde_json::to_value(&r).unwrap(),
            json!({"written": [{"path": "a", "version": "v", "replacements": 2}],
                "skipped": [{"path": "b", "reason": "outside-root"},
                            {"path": "c", "reason": "no-match"}]})
        );
    }

    // ---- matcher ----

    #[test]
    fn literal_query_escapes_regex_metacharacters() {
        let re = build_regex("a.b(", LIT).unwrap();
        assert_eq!(cols(&re, "axb(\na.b("), vec![(2, 1)]);
    }

    #[test]
    fn regex_mode_uses_the_pattern() {
        let re = build_regex(r"fo+\d", RX).unwrap();
        assert_eq!(cols(&re, "x foo1 fo2 f3"), vec![(1, 3), (1, 8)]);
    }

    #[test]
    fn case_is_ignored_unless_match_case() {
        let re = build_regex("Foo", LIT).unwrap();
        assert_eq!(cols(&re, "foo FOO Foo").len(), 3);
        let o = EditorSearchOptions {
            match_case: true,
            ..LIT
        };
        let re = build_regex("Foo", o).unwrap();
        assert_eq!(cols(&re, "foo FOO Foo"), vec![(1, 9)]);
    }

    #[test]
    fn whole_word_requires_word_boundaries() {
        let o = EditorSearchOptions {
            whole_word: true,
            ..LIT
        };
        let re = build_regex("cat", o).unwrap();
        assert_eq!(cols(&re, "cat concat cats (cat)"), vec![(1, 1), (1, 18)]);
        let o = EditorSearchOptions {
            whole_word: true,
            ..RX
        };
        let re = build_regex("a|b", o).unwrap();
        assert_eq!(cols(&re, "ab a b").len(), 2);
    }

    #[test]
    fn columns_are_one_based_utf16() {
        // U+1F600 is two UTF-16 units; 'é' is one.
        let re = build_regex("x", LIT).unwrap();
        assert_eq!(cols(&re, "\u{1F600}éx"), vec![(1, 4)]);
        let m = &text_matches(&re, "\u{1F600}éx", 10).0[0];
        assert_eq!((m.preview_start, m.preview_end), (3, 4));
    }

    #[test]
    fn crlf_lines_do_not_leak_carriage_returns() {
        let re = build_regex(r"b$", RX).unwrap();
        assert_eq!(cols(&re, "ab\r\ncb\r\n"), vec![(1, 2), (2, 2)]);
    }

    #[test]
    fn bad_regex_empty_and_long_queries_are_internal_errors() {
        let e = build_regex("(", RX).unwrap_err();
        assert_eq!(e.code, ErrorCode::Internal);
        assert!(e.message.starts_with("Invalid regular expression: "));
        assert_eq!(build_regex("", LIT).unwrap_err().code, ErrorCode::Internal);
        let long = "a".repeat(EDITOR_SEARCH_QUERY_MAX + 1);
        let e = build_regex(&long, LIT).unwrap_err();
        assert_eq!(e.code, ErrorCode::Internal);
        assert!(e.message.contains("too long"));
        assert!(build_regex(&"a".repeat(EDITOR_SEARCH_QUERY_MAX), LIT).is_ok());
    }

    // ---- preview ----

    #[test]
    fn preview_trims_leading_whitespace_and_offsets_the_match() {
        assert_eq!(preview("    let x = 1;", 8, 9), ("let x = 1;".into(), 4, 5));
        // A match inside the indent keeps the indent from its start.
        assert_eq!(preview("    x", 2, 5), ("  x".into(), 0, 3));
    }

    fn bolded(p: &str, s: u32, e: u32) -> String {
        let u: Vec<u16> = p.encode_utf16().collect();
        String::from_utf16(&u[s as usize..e as usize]).unwrap()
    }

    #[test]
    fn preview_clips_long_lines_around_the_match_with_ellipses() {
        let line = format!("{}NEEDLE{}", "a".repeat(300), "b".repeat(300));
        let (p, s, e) = preview(&line, 300, 306);
        assert_eq!(p.chars().count(), EDITOR_SEARCH_PREVIEW_CHARS);
        assert!(p.starts_with('…') && p.ends_with('…'));
        assert_eq!(bolded(&p, s, e), "NEEDLE");

        // Match near the start: only the right side is clipped.
        let line = format!("NEEDLE{}", "b".repeat(300));
        let (p, s, e) = preview(&line, 0, 6);
        assert!(!p.starts_with('…') && p.ends_with('…'));
        assert_eq!((s, e), (0, 6));
        assert_eq!(p.chars().count(), EDITOR_SEARCH_PREVIEW_CHARS);

        // Match at the end: only the left side is clipped.
        let line = format!("{}NEEDLE", "a".repeat(300));
        let (p, s, e) = preview(&line, 300, 306);
        assert!(p.starts_with('…') && !p.ends_with('…'));
        assert_eq!(p.chars().count(), EDITOR_SEARCH_PREVIEW_CHARS);
        assert_eq!(bolded(&p, s, e), "NEEDLE");
    }

    #[test]
    fn preview_clamps_a_match_longer_than_the_window() {
        let line = "z".repeat(500);
        let (p, s, e) = preview(&line, 0, 500);
        assert_eq!(s, 0);
        assert_eq!(e as usize, EDITOR_SEARCH_PREVIEW_CHARS - 1);
        assert!(p.ends_with('…'));
    }

    // ---- include ----

    #[test]
    fn include_globs() {
        assert!(Include::parse("  ").matches("any/thing.rs"));

        let i = Include::parse("services/**");
        assert!(i.matches("services/a/b.ts"));
        assert!(!i.matches("src/services/a.ts"));

        let i = Include::parse("*.ts");
        assert!(i.matches("a.ts"));
        assert!(i.matches("deep/er/a.ts"));
        assert!(!i.matches("a.tsx"));

        let i = Include::parse("services");
        assert!(i.matches("services/x.rs"));
        assert!(!i.matches("services2/x.rs"));
        assert!(Include::parse("services/").matches("services/x.rs"));
        assert!(Include::parse("README.md").matches("README.md"));

        let i = Include::parse("services/** , *.md,src/?.rs");
        assert!(i.matches("services/a.rs"));
        assert!(i.matches("docs/x.md"));
        assert!(i.matches("src/a.rs"));
        assert!(!i.matches("src/ab.rs"));
        assert!(!i.matches("lib/a.rs"));

        assert!(Include::parse(".\\src\\**").matches("src/a/b.c"));
    }

    // ---- search over disk ----

    #[test]
    fn search_walks_the_listing_skipping_binary_large_and_ignored_files() {
        let d = TempDir::new();
        git(d.path(), &["init", "-q"]);
        write(&d, ".gitignore", b"ignored.txt\n");
        write(&d, "b.txt", b"needle\n  another needle here\n");
        write(&d, "a/x.txt", b"\xEF\xBB\xBFneedle first\r\n");
        write(&d, "ignored.txt", b"needle\n");
        write(&d, "bin.dat", b"needle\0\0");
        write(&d, "latin1.txt", b"needle \xE9\n");
        write(&d, "none.txt", b"hay\n");
        let data = search(&root(&d), "NEEDLE", LIT, "").unwrap();
        let paths: Vec<_> = data.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, vec!["a/x.txt", "b.txt"]);
        assert_eq!(data.match_count, 3);
        assert!(!data.truncated);
        // The BOM is not a column.
        assert_eq!(data.files[0].matches[0].column, 1);
        let m = &data.files[1].matches[1];
        assert_eq!((m.line, m.column), (2, 11));
        assert_eq!(m.preview, "another needle here");
        assert_eq!((m.preview_start, m.preview_end), (8, 14));

        let only = search(&root(&d), "needle", LIT, "a").unwrap();
        assert_eq!(only.files.len(), 1);
    }

    #[test]
    fn search_outside_a_repo_uses_the_walk() {
        let d = TempDir::new();
        write(&d, "src/a.rs", b"fn main() {}\n");
        let data = search(&root(&d), "main", LIT, "*.rs").unwrap();
        assert_eq!(data.files[0].path, "src/a.rs");
    }

    #[test]
    fn search_stops_at_the_match_cap() {
        let d = TempDir::new();
        write(&d, "a.txt", "x\n".repeat(1_500).as_bytes());
        write(&d, "b.txt", "x\n".repeat(1_500).as_bytes());
        write(&d, "c.txt", b"x\n");
        let data = search(&root(&d), "x", LIT, "").unwrap();
        assert_eq!(data.match_count as usize, EDITOR_SEARCH_MAX_MATCHES);
        assert_eq!(data.files.len(), 2);
        assert_eq!(data.files[1].matches.len(), 500);
        assert!(data.truncated);
    }

    #[test]
    fn search_exactly_at_the_match_cap_with_nothing_after_is_not_truncated() {
        let d = TempDir::new();
        write(
            &d,
            "a.txt",
            "x\n".repeat(EDITOR_SEARCH_MAX_MATCHES).as_bytes(),
        );
        write(&d, "b.txt", b"y\n");
        let data = search(&root(&d), "x", LIT, "").unwrap();
        assert_eq!(data.match_count as usize, EDITOR_SEARCH_MAX_MATCHES);
        assert!(!data.truncated);
    }

    #[test]
    fn search_stops_at_the_file_cap() {
        let d = TempDir::new();
        for i in 0..(EDITOR_SEARCH_MAX_FILES + 3) {
            write(&d, &format!("f{i:04}.txt"), b"x\n");
        }
        let data = search(&root(&d), "x", LIT, "").unwrap();
        assert_eq!(data.files.len(), EDITOR_SEARCH_MAX_FILES);
        assert!(data.truncated);
    }

    #[test]
    fn search_reports_a_bad_regex() {
        let d = TempDir::new();
        let e = search(&root(&d), "[", RX, "").unwrap_err();
        assert!(e.message.starts_with("Invalid regular expression"));
    }

    // ---- replace ----

    fn spec<'a>(query: &'a str, replacement: &'a str, o: EditorSearchOptions) -> ReplaceSpec<'a> {
        ReplaceSpec {
            query,
            options: o,
            replacement,
            preserve_case: false,
        }
    }

    fn target(path: &str) -> EditorReplaceFileTarget {
        EditorReplaceFileTarget {
            path: path.into(),
            base_version: None,
        }
    }

    #[test]
    fn replace_preserves_crlf_bom_and_trailing_newline() {
        let d = TempDir::new();
        write(&d, "a.txt", b"\xEF\xBB\xBFfoo one\r\nfoo two\r\n");
        let r = replace(&root(&d), &spec("foo", "bar", LIT), &[target("a.txt")]).unwrap();
        assert_eq!(r.written.len(), 1);
        assert_eq!(r.written[0].replacements, 2);
        let bytes = std::fs::read(d.path().join("a.txt")).unwrap();
        assert_eq!(bytes, b"\xEF\xBB\xBFbar one\r\nbar two\r\n");
        assert_eq!(
            Some(r.written[0].version.clone()),
            files::version_of(&d.path().join("a.txt"))
        );

        write(&d, "b.txt", b"foo");
        replace(&root(&d), &spec("foo", "bar", LIT), &[target("b.txt")]).unwrap();
        assert_eq!(read(&d, "b.txt"), "bar");
    }

    #[test]
    fn dollar_groups_expand_only_in_regex_mode() {
        let d = TempDir::new();
        write(&d, "a.txt", b"key=val\n");
        let s = spec(r"(?P<k>\w+)=(\w+)", "$2:${k}", RX);
        replace(&root(&d), &s, &[target("a.txt")]).unwrap();
        assert_eq!(read(&d, "a.txt"), "val:key\n");

        write(&d, "b.txt", b"key=val\n");
        replace(&root(&d), &spec("key", "$1${x}", LIT), &[target("b.txt")]).unwrap();
        assert_eq!(read(&d, "b.txt"), "$1${x}=val\n");
    }

    #[test]
    fn replace_matches_per_line_only() {
        let d = TempDir::new();
        write(&d, "a.txt", b"a\nb\n");
        let r = replace(&root(&d), &spec(r"a\s*b", "X", RX), &[target("a.txt")]).unwrap();
        assert_eq!(r.skipped[0].reason, SkipReason::NoMatch);
        assert_eq!(read(&d, "a.txt"), "a\nb\n");
    }

    #[test]
    fn preserve_case_follows_the_match() {
        assert_eq!(apply_case("FOO", "bar".into()), "BAR");
        assert_eq!(apply_case("Foo", "bar".into()), "Bar");
        assert_eq!(apply_case("foo", "bAr".into()), "bAr");
        assert_eq!(apply_case("F", "bar".into()), "Bar");
        assert_eq!(apply_case("123", "bar".into()), "bar");
        let d = TempDir::new();
        write(&d, "a.txt", b"foo Foo FOO\n");
        let mut s = spec("foo", "bar", LIT);
        s.preserve_case = true;
        replace(&root(&d), &s, &[target("a.txt")]).unwrap();
        assert_eq!(read(&d, "a.txt"), "bar Bar BAR\n");
    }

    #[test]
    fn replace_skips_stale_missing_binary_outside_and_unmatched_files() {
        let d = TempDir::new();
        write(&d, "a.txt", b"foo\n");
        write(&d, "bin.dat", b"foo\0");
        write(&d, "none.txt", b"bar\n");
        let stale = EditorReplaceFileTarget {
            path: "a.txt".into(),
            base_version: Some("0:0:0".into()),
        };
        let targets = [
            stale,
            target("missing.txt"),
            target("bin.dat"),
            target("../escape.txt"),
            target("none.txt"),
        ];
        let r = replace(&root(&d), &spec("foo", "x", LIT), &targets).unwrap();
        assert!(r.written.is_empty());
        let reasons: Vec<_> = r.skipped.iter().map(|s| s.reason).collect();
        assert_eq!(
            reasons,
            vec![
                SkipReason::Stale,
                SkipReason::NotFound,
                SkipReason::Binary,
                SkipReason::OutsideRoot,
                SkipReason::NoMatch
            ]
        );
        assert_eq!(r.skipped[3].path, "../escape.txt");
        assert_eq!(read(&d, "a.txt"), "foo\n");

        let fresh = EditorReplaceFileTarget {
            path: "a.txt".into(),
            base_version: files::version_of(&d.path().join("a.txt")),
        };
        let r = replace(&root(&d), &spec("foo", "x", LIT), &[fresh]).unwrap();
        assert_eq!(r.written[0].path, "a.txt");
        assert_eq!(read(&d, "a.txt"), "x\n");
    }

    #[test]
    fn replace_with_a_bad_regex_is_an_internal_error() {
        let d = TempDir::new();
        let e = replace(&root(&d), &spec("(", "x", RX), &[]).unwrap_err();
        assert_eq!(e.code, ErrorCode::Internal);
    }
}
