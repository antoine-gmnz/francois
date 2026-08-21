//! FR-11..FR-16: the CLAUDE.md managed block — grammar, validation, file I/O.
//!
//! Everything above the "file I/O" banner is PURE `&str` → `String`: the grammar
//! suite needs no filesystem, which is what makes the byte-preservation promise of
//! FR-13 cheap to pin down. The wrapper underneath is deliberately thin.

use super::*;

use std::path::{Path, PathBuf};

// ---------- FR-11: the grammar's constants (contract/projects.ts, verbatim) ----------

pub(crate) const STANDARDS_START: &str = "<!-- francois:standards:start -->";
pub(crate) const STANDARDS_END: &str = "<!-- francois:standards:end -->";
pub(crate) const STANDARDS_HEADING: &str = "## Coding standards";

/// FR-13 bounds (contract/projects.ts MAX_*).
const MAX_RULE_LENGTH: usize = 500;
const MAX_RULES: usize = 200;
const MAX_NOTES_LENGTH: usize = 8000;

// ---------- FR-11/FR-14: locating the block ----------

/// One line of the file: the byte range `[start, next)` INCLUDING its terminator,
/// plus the trailing-whitespace-trimmed text used for exact marker matching.
struct Line<'a> {
    start: usize,
    next: usize,
    text: &'a str,
}

fn lines_of(content: &str) -> Vec<Line<'_>> {
    let mut out = Vec::new();
    let mut off = 0usize;
    for raw in content.split_inclusive('\n') {
        out.push(Line {
            start: off,
            next: off + raw.len(),
            text: raw.trim_end(), // also strips the \r of a CRLF file
        });
        off += raw.len();
    }
    out
}

/// Where the managed block sits, or why the file cannot be written (FR-14).
#[derive(Debug, PartialEq)]
pub(crate) enum BlockSpan {
    Absent,
    /// Byte range covering the START line through the END line inclusive (with the
    /// END line's terminator) — everything outside it is preserved verbatim.
    Found {
        start: usize,
        end: usize,
    },
    /// The file's markers do not pair up. The core REFUSES to write (FR-14): the
    /// span it would replace is undefined, and guessing risks eating hand-written
    /// content. Reads degrade to "no block" instead (contract §getStandards).
    Malformed(&'static str),
}

const UNTERMINATED: &str = "has a francois:standards:start marker with no matching end";
const ORPHAN_END: &str = "has a francois:standards:end marker with no matching start";
const DUPLICATE_START: &str = "has more than one francois:standards:start marker";

pub(crate) fn scan_block(content: &str) -> BlockSpan {
    let lines = lines_of(content);
    let index_of = |marker: &str| -> Vec<usize> {
        lines
            .iter()
            .enumerate()
            .filter(|(_, l)| l.text == marker)
            .map(|(i, _)| i)
            .collect()
    };
    let starts = index_of(STANDARDS_START);
    let ends = index_of(STANDARDS_END);

    if starts.len() > 1 {
        return BlockSpan::Malformed(DUPLICATE_START);
    }
    let Some(&s) = starts.first() else {
        return if ends.is_empty() {
            BlockSpan::Absent
        } else {
            BlockSpan::Malformed(ORPHAN_END)
        };
    };
    // Exactly one START. Anything but exactly one END *after* it leaves at least
    // one marker unpaired.
    if ends.len() > 1 || matches!(ends.first(), Some(&e) if e < s) {
        return BlockSpan::Malformed(ORPHAN_END);
    }
    match ends.first() {
        None => BlockSpan::Malformed(UNTERMINATED),
        Some(&e) => BlockSpan::Found {
            start: lines[s].start,
            end: lines[e].next,
        },
    }
}

// ---------- FR-12: parse ----------

/// One rule line: `^- (.+)$`, the capture trimmed. Anything else is ignored
/// (§7 #9 — hand-written content inside the block is lost on the next write).
fn rule_of_line(line: &str) -> Option<String> {
    let rest = line.strip_prefix("- ")?.trim();
    (!rest.is_empty()).then(|| rest.to_string())
}

/// FR-12. Returns the parsed standards and whether the block was present at all.
/// A malformed file (FR-14) parses as ABSENT rather than failing: the editor must
/// still open so the user can see the project and fix the file by hand.
pub(crate) fn parse_standards(content: &str) -> (ProjectStandards, bool) {
    let BlockSpan::Found { start, end } = scan_block(content) else {
        return (ProjectStandards::default(), false);
    };
    // `.lines()` handles both \n and \r\n; the first and last entries are the
    // marker lines themselves.
    let mut body: Vec<&str> = content[start..end].lines().collect();
    if !body.is_empty() {
        body.remove(0);
    }
    if !body.is_empty() {
        body.pop();
    }
    // The heading is rendered, not authored — drop it before reading notes.
    if let Some(pos) = body.iter().position(|l| !l.trim().is_empty()) {
        if body[pos].trim_end() == STANDARDS_HEADING {
            body.remove(pos);
        }
    }
    let split = body
        .iter()
        .position(|l| l.starts_with("- "))
        .unwrap_or(body.len());
    let (notes_lines, rule_lines) = body.split_at(split);
    (
        ProjectStandards {
            notes: notes_lines.join("\n").trim().to_string(),
            rules: rule_lines.iter().filter_map(|l| rule_of_line(l)).collect(),
        },
        true,
    )
}

// ---------- FR-11: render ----------

/// The block, `\n`-terminated lines, WITHOUT a trailing newline after the END
/// marker — composition decides what follows it.
pub(crate) fn render_block(s: &ProjectStandards) -> String {
    let mut out = String::new();
    out.push_str(STANDARDS_START);
    out.push('\n');
    out.push_str(STANDARDS_HEADING);
    out.push('\n');
    let notes = s.notes.trim();
    if !notes.is_empty() {
        for line in notes.lines() {
            out.push_str(line.trim_end());
            out.push('\n');
        }
        out.push('\n'); // the one blank line separating notes from the bullets
    }
    for rule in &s.rules {
        out.push_str("- ");
        out.push_str(rule.trim());
        out.push('\n');
    }
    out.push_str(STANDARDS_END);
    out
}

// ---------- FR-13: validation (runs BEFORE any file is opened) ----------

fn carries_marker(text: &str) -> bool {
    text.contains(STANDARDS_START) || text.contains(STANDARDS_END)
}

/// FR-13. `Err` ⇒ `INVALID_INPUT`, with a message naming the offending constraint.
pub(crate) fn validate_standards(s: &ProjectStandards) -> Result<(), String> {
    if s.notes.chars().count() > MAX_NOTES_LENGTH {
        return Err(format!(
            "notes must be at most {MAX_NOTES_LENGTH} characters"
        ));
    }
    if carries_marker(&s.notes) {
        return Err("notes must not contain the francois standards markers".into());
    }
    // The block grammar (FR-11/FR-12) gives `- ` and the heading structural meaning:
    // parse_standards ends the notes at the FIRST `- ` line and strips a leading
    // heading. Notes containing either would come back reshuffled into rules on the
    // very next read (FR-16 re-reads from disk, so the user would watch it happen).
    // Reject instead of silently reinterpreting.
    for line in s.notes.lines() {
        let line = line.trim_end();
        if line.trim_start().starts_with("- ") {
            return Err(
                "notes must not contain a '- ' bullet line — add it as a rule instead".into(),
            );
        }
        if line.trim() == STANDARDS_HEADING {
            return Err(format!(
                "notes must not contain the line '{STANDARDS_HEADING}'"
            ));
        }
    }
    if s.rules.len() > MAX_RULES {
        return Err(format!("at most {MAX_RULES} rules are allowed"));
    }
    for rule in &s.rules {
        if rule.contains('\n') || rule.contains('\r') {
            return Err("a rule must be a single line".into());
        }
        let trimmed = rule.trim();
        if trimmed.is_empty() {
            return Err("a rule must not be empty".into());
        }
        if trimmed.chars().count() > MAX_RULE_LENGTH {
            return Err(format!(
                "a rule must be at most {MAX_RULE_LENGTH} characters"
            ));
        }
        // A rule carrying a marker could CLOSE the block and take over the rest of
        // the file on the next write (§7 #10) — the one validation that is a
        // security property rather than a bound.
        if carries_marker(rule) {
            return Err("a rule must not contain the francois standards markers".into());
        }
    }
    Ok(())
}

// ---------- FR-13: the write, as a pure string transform ----------

/// Drop `s`'s leading blank LINES without touching the indentation of the first
/// line that carries content.
fn without_leading_blank_lines(s: &str) -> &str {
    let mut rest = s;
    while let Some(i) = rest.find('\n') {
        if rest[..i].trim().is_empty() {
            rest = &rest[i + 1..];
        } else {
            return rest;
        }
    }
    if rest.trim().is_empty() {
        ""
    } else {
        rest
    }
}

/// Drop `s`'s trailing blank lines, including the final newline.
fn without_trailing_blank_lines(s: &str) -> &str {
    let mut rest = s;
    while let Some(i) = rest.rfind('\n') {
        if rest[i + 1..].trim().is_empty() {
            rest = &rest[..i];
        } else {
            return rest;
        }
    }
    if rest.trim().is_empty() {
        ""
    } else {
        rest
    }
}

/// FR-13, pure. `content` is `None` when CLAUDE.md does not exist.
/// `Ok(None)` ⇒ nothing needs writing (and in particular the file is NOT created).
/// `Err` ⇒ the markers are malformed → `STANDARDS_WRITE_FAILED` (FR-14).
pub(crate) fn apply_standards(
    content: Option<&str>,
    s: &ProjectStandards,
) -> Result<Option<String>, &'static str> {
    let empty = s.rules.is_empty() && s.notes.trim().is_empty();
    let Some(existing) = content else {
        // §7 #5/#6: create with only the block, or do nothing at all.
        return Ok((!empty).then(|| format!("{}\n", render_block(s))));
    };
    let span = match scan_block(existing) {
        BlockSpan::Malformed(why) => return Err(why),
        other => other,
    };
    match (span, empty) {
        // Remove the block, collapsing the whitespace it leaves to ONE blank line.
        (BlockSpan::Found { start, end }, true) => {
            let before = without_trailing_blank_lines(&existing[..start]);
            let after = without_leading_blank_lines(&existing[end..]);
            Ok(Some(match (before.is_empty(), after.is_empty()) {
                (true, true) => String::new(),
                (true, false) => after.to_string(),
                (false, true) => format!("{before}\n"),
                (false, false) => format!("{before}\n\n{after}"),
            }))
        }
        // No block and nothing to write — never create, never touch.
        (_, true) => Ok(None),
        // Replace ONLY the span; every other byte survives verbatim.
        (BlockSpan::Found { start, end }, false) => Ok(Some(format!(
            "{}{}\n{}",
            &existing[..start],
            render_block(s),
            &existing[end..]
        ))),
        // Append, separated from the prior content by exactly one blank line.
        (_, false) => {
            let base = without_trailing_blank_lines(existing);
            let block = render_block(s);
            Ok(Some(if base.is_empty() {
                format!("{block}\n")
            } else {
                format!("{base}\n\n{block}\n")
            }))
        }
    }
}

// ---------- file I/O (thin; every decision above is pure) ----------

pub(crate) fn claude_md_path(root: &str) -> PathBuf {
    Path::new(root).join("CLAUDE.md")
}

/// Temp file in the SAME directory + rename (FR-13). The temp file is removed on
/// EVERY failure path (FR-15) — including the write itself, which is the branch a
/// full disk takes (§7 #12). This temp lands inside the user's git-tracked repo, so
/// a leaked `CLAUDE.md.<pid>.<n>.tmp` would show up in their `git status`.
///
/// Kept separate from `permissions::write_json_atomic` on purpose — see the
/// module doc on `crate::fs_util` for why the two atomic writers do not merge.
fn write_text_atomic(path: &Path, content: &str) -> Result<(), String> {
    let tmp = crate::fs_util::unique_temp_path(path, "md");
    if let Err(e) = std::fs::write(&tmp, content) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("could not write {}: {e}", tmp.display()));
    }
    // Carry the target's mode over on unix so an existing CLAUDE.md keeps its
    // permissions. Deliberately NOT done on Windows: copying a read-only target's
    // attributes onto the temp file would make the cleanup below fail too.
    #[cfg(unix)]
    if let Ok(meta) = std::fs::metadata(path) {
        let _ = std::fs::set_permissions(&tmp, meta.permissions());
    }
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("could not write {}: {e}", path.display())
    })
}

/// FR-10: read `<root>/CLAUDE.md`. A missing file is NOT an error. `Err` ⇒
/// `INTERNAL` for reads (FR-15), with the OS error in the message.
pub(crate) fn read_standards(root: &str) -> Result<StandardsRead, String> {
    let path = claude_md_path(root);
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(StandardsRead {
                standards: ProjectStandards::default(),
                file_exists: false,
                block_present: false,
            })
        }
        Err(e) => return Err(format!("could not read {}: {e}", path.display())),
    };
    let (standards, block_present) = parse_standards(&content);
    Ok(StandardsRead {
        standards,
        file_exists: true,
        block_present,
    })
}

/// FR-13..FR-16: read → apply → atomic write → FRESH RE-READ. `Err` ⇒
/// `STANDARDS_WRITE_FAILED`. Validation (FR-13) is the CALLER's first step — it
/// must reject before this function opens anything.
/// Serializes the whole read-modify-write. `#[tauri::command(async)]` runs handlers
/// on worker threads and FR-35 fires `project_set_standards` on EVERY individual
/// edit (rule added / renamed / reordered / dropped, notes blurred), so overlapping
/// writes are the expected traffic, not a corner case. Without this, two writers
/// both read the same CLAUDE.md, each apply their own object, and the later rename
/// silently discards the earlier edit.
///
/// One global lock rather than one per root: writes are small, rare relative to a
/// turn, and cross-project concurrency is not worth the bookkeeping.
static STANDARDS_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub(crate) fn write_standards(root: &str, s: &ProjectStandards) -> Result<StandardsRead, String> {
    // A poisoned lock still guards a consistent file — the panic that poisoned it
    // happened between a read and a rename, and the rename is atomic either way.
    let _guard = STANDARDS_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let path = claude_md_path(root);
    let existing = match std::fs::read_to_string(&path) {
        Ok(c) => Some(c),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(format!("could not read {}: {e}", path.display())),
    };
    match apply_standards(existing.as_deref(), s) {
        // FR-14: name the file and the problem; leave it exactly as it is.
        Err(why) => return Err(format!("{} {why}", path.display())),
        Ok(None) => {}
        Ok(Some(next)) => write_text_atomic(&path, &next)?,
    }
    // FR-16: the editor repaints from disk, never from what was typed.
    read_standards(root)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::testutil::*;

    fn block_of(notes: &str, rules: &[&str]) -> String {
        render_block(&standards_of(notes, rules))
    }

    // ---- FR-11: the grammar, byte for byte ----

    #[test]
    fn render_matches_the_fr11_grammar() {
        assert_eq!(
            block_of("", &["one", "two"]),
            concat!(
                "<!-- francois:standards:start -->\n",
                "## Coding standards\n",
                "- one\n",
                "- two\n",
                "<!-- francois:standards:end -->"
            )
        );
        // notes present ⇒ trimmed, then EXACTLY one blank line before the bullets
        assert_eq!(
            block_of("  keep it small\n", &["one"]),
            concat!(
                "<!-- francois:standards:start -->\n",
                "## Coding standards\n",
                "keep it small\n",
                "\n",
                "- one\n",
                "<!-- francois:standards:end -->"
            )
        );
        // no notes, no rules ⇒ just the markers and the heading (never written on
        // its own — empty standards REMOVE the block — but the grammar is total)
        assert_eq!(
            block_of("", &[]),
            concat!(
                "<!-- francois:standards:start -->\n",
                "## Coding standards\n",
                "<!-- francois:standards:end -->"
            )
        );
    }

    // ---- FR-12: parse ----

    #[test]
    fn parse_reads_notes_then_bullets_and_drops_the_heading() {
        let content = format!(
            "# repo\n\n{}\n",
            block_of("some notes\nover two lines", &["a", "b"])
        );
        let (s, present) = parse_standards(&content);
        assert!(present);
        assert_eq!(s.notes, "some notes\nover two lines");
        assert_eq!(s.rules, vec!["a".to_string(), "b".to_string()]);
    }

    #[test]
    fn parse_round_trips_through_render() {
        let original = standards_of("notes here", &["no file over 1000 lines", "tests first"]);
        let (back, present) = parse_standards(&format!("{}\n", render_block(&original)));
        assert!(present);
        assert_eq!(back, original);
    }

    #[test]
    fn parse_ignores_hand_written_junk_inside_the_block() {
        // §7 #9: anything that is not the heading, notes, or a `- ` bullet is
        // ignored on read and therefore LOST on the next write. Documented cost.
        let content = concat!(
            "<!-- francois:standards:start -->\n",
            "## Coding standards\n",
            "the notes\n",
            "\n",
            "- one\n",
            "* not a bullet we own\n",
            "-\n",
            "- \n",
            "- two\n",
            "<!-- francois:standards:end -->\n"
        );
        let (s, present) = parse_standards(content);
        assert!(present);
        assert_eq!(s.notes, "the notes");
        assert_eq!(s.rules, vec!["one".to_string(), "two".to_string()]);
    }

    #[test]
    fn parse_reports_an_absent_block_as_empty() {
        let (s, present) = parse_standards("# just a readme\n");
        assert!(!present);
        assert_eq!(s, ProjectStandards::default());
        assert!(!parse_standards("").1);
    }

    #[test]
    fn markers_match_on_a_crlf_file() {
        // Marker lines are matched after trimming TRAILING whitespace (FR-11), so a
        // CRLF CLAUDE.md — the common case on Windows — is understood.
        let content = "# repo\r\n\r\n<!-- francois:standards:start -->\r\n## Coding standards\r\n- one\r\n<!-- francois:standards:end -->\r\n";
        let (s, present) = parse_standards(content);
        assert!(present);
        assert_eq!(s.rules, vec!["one".to_string()]);
    }

    // ---- FR-14: malformed marker pairing ----

    #[test]
    fn scan_refuses_unterminated_orphaned_and_duplicated_markers() {
        assert_eq!(scan_block("# x\n"), BlockSpan::Absent);
        assert_eq!(
            scan_block(&format!("{STANDARDS_START}\n- a\n")),
            BlockSpan::Malformed(UNTERMINATED)
        );
        assert_eq!(
            scan_block(&format!("- a\n{STANDARDS_END}\n")),
            BlockSpan::Malformed(ORPHAN_END)
        );
        assert_eq!(
            scan_block(&format!(
                "{STANDARDS_START}\n{STANDARDS_START}\n{STANDARDS_END}\n"
            )),
            BlockSpan::Malformed(DUPLICATE_START)
        );
        assert_eq!(
            scan_block(&format!(
                "{STANDARDS_START}\n{STANDARDS_END}\n{STANDARDS_END}\n"
            )),
            BlockSpan::Malformed(ORPHAN_END)
        );
        // an END *before* the START is not a block either
        assert_eq!(
            scan_block(&format!("{STANDARDS_END}\n{STANDARDS_START}\n")),
            BlockSpan::Malformed(ORPHAN_END)
        );
    }

    #[test]
    fn a_malformed_file_reads_as_no_block_but_never_writes() {
        let content = format!("# repo\n{STANDARDS_START}\n- a\n");
        let (s, present) = parse_standards(&content);
        assert!(
            !present,
            "reads degrade to 'no block' (contract §getStandards)"
        );
        assert_eq!(s, ProjectStandards::default());
        assert!(apply_standards(Some(&content), &standards_of("", &["x"])).is_err());
        // …and the REMOVAL path refuses just as hard: the span is undefined.
        assert!(apply_standards(Some(&content), &standards_of("", &[])).is_err());
    }

    // ---- FR-13: write semantics ----

    #[test]
    fn replacing_the_block_preserves_every_other_byte() {
        let head = "# francois\n\nHand-written intro.\n\n";
        let tail = "\n## Afterwards\n\nMore hand-written prose.\n";
        let content = format!("{head}{}\n{tail}", block_of("", &["old"]));
        let next = apply_standards(Some(&content), &standards_of("fresh", &["new"]))
            .unwrap()
            .expect("a write is needed");
        assert!(next.starts_with(head), "prefix changed:\n{next}");
        assert!(next.ends_with(tail), "suffix changed:\n{next}");
        assert_eq!(parse_standards(&next).0, standards_of("fresh", &["new"]));
    }

    #[test]
    fn three_successive_edits_leave_the_surroundings_byte_identical() {
        let head = "# francois\n\nintro\n\n";
        let tail = "\ntrailing prose\n";
        let mut content = format!("{head}{}\n{tail}", block_of("", &["one"]));
        for rules in [&["a"][..], &["a", "b"][..], &[][..]] {
            // note: the last iteration has rules AND notes, so it never removes
            let next = apply_standards(Some(&content), &standards_of("n", rules))
                .unwrap()
                .expect("a write is needed");
            content = next;
            assert!(content.starts_with(head), "prefix changed:\n{content}");
            assert!(content.ends_with(tail), "suffix changed:\n{content}");
        }
        assert_eq!(parse_standards(&content).0, standards_of("n", &[]));
    }

    #[test]
    fn appending_uses_exactly_one_blank_line_and_keeps_the_prior_bytes() {
        let content = "# francois\n\nsome prose\n";
        let next = apply_standards(Some(content), &standards_of("", &["one"]))
            .unwrap()
            .unwrap();
        assert_eq!(
            next,
            format!("# francois\n\nsome prose\n\n{}\n", block_of("", &["one"]))
        );
        assert!(next.starts_with(content));
        // a file already ending in several blank lines collapses to exactly one
        let padded = apply_standards(Some("# francois\n\n\n\n"), &standards_of("", &["one"]))
            .unwrap()
            .unwrap();
        assert_eq!(
            padded,
            format!("# francois\n\n{}\n", block_of("", &["one"]))
        );
    }

    #[test]
    fn a_missing_file_is_created_with_only_the_block() {
        let next = apply_standards(None, &standards_of("", &["one"]))
            .unwrap()
            .unwrap();
        assert_eq!(next, format!("{}\n", block_of("", &["one"])));
        // …and an EMPTY file gets the block alone too, with no leading blank line
        let empty = apply_standards(Some(""), &standards_of("", &["one"]))
            .unwrap()
            .unwrap();
        assert_eq!(empty, format!("{}\n", block_of("", &["one"])));
    }

    #[test]
    fn empty_standards_remove_the_block_and_collapse_the_gap() {
        let content = format!(
            "# francois\n\nintro\n\n{}\n\n## After\n",
            block_of("", &["one"])
        );
        let next = apply_standards(Some(&content), &standards_of("  ", &[]))
            .unwrap()
            .expect("removal is a write");
        assert_eq!(next, "# francois\n\nintro\n\n## After\n");
        assert!(!next.contains(STANDARDS_START));
        // block at the very end → the file keeps its trailing newline
        let trailing = format!("# francois\n\n{}\n", block_of("", &["one"]));
        assert_eq!(
            apply_standards(Some(&trailing), &standards_of("", &[]))
                .unwrap()
                .unwrap(),
            "# francois\n"
        );
        // a file that was ONLY the block empties out
        let only = format!("{}\n", block_of("", &["one"]));
        assert_eq!(
            apply_standards(Some(&only), &standards_of("", &[]))
                .unwrap()
                .unwrap(),
            ""
        );
    }

    #[test]
    fn empty_standards_are_a_no_op_when_there_is_no_block() {
        // §7 #6: the file is NOT created…
        assert_eq!(apply_standards(None, &standards_of("", &[])), Ok(None));
        // …and an existing block-less file is not touched at all.
        assert_eq!(
            apply_standards(Some("# francois\n"), &standards_of("\n \t", &[])),
            Ok(None)
        );
    }

    #[test]
    fn notes_alone_keep_the_block_alive() {
        // "empty" means rules AND notes empty — notes alone are still a write.
        let next = apply_standards(None, &standards_of("just notes", &[]))
            .unwrap()
            .unwrap();
        assert_eq!(parse_standards(&next).0, standards_of("just notes", &[]));
    }

    // ---- FR-13: validation, before any file is opened ----

    #[test]
    fn validation_rejects_a_rule_carrying_a_marker() {
        // §7 #10: a rule that could close the block and take over the rest of the file.
        for bad in [STANDARDS_END, STANDARDS_START] {
            let s = standards_of("", &[&format!("be nice {bad}")]);
            assert!(validate_standards(&s).is_err(), "{bad} must be rejected");
        }
        assert!(validate_standards(&standards_of(STANDARDS_END, &[])).is_err());
    }

    #[test]
    fn validation_enforces_the_fr13_bounds() {
        assert!(validate_standards(&standards_of("", &["ok"])).is_ok());
        assert!(validate_standards(&standards_of("", &["   "])).is_err()); // empty
        assert!(validate_standards(&standards_of("", &["a\nb"])).is_err()); // §7 #11
        assert!(validate_standards(&standards_of("", &["a\rb"])).is_err());
        assert!(validate_standards(&standards_of("", &["x".repeat(500).as_str()])).is_ok());
        assert!(validate_standards(&standards_of("", &["x".repeat(501).as_str()])).is_err());
        assert!(validate_standards(&standards_of("x".repeat(8000).as_str(), &[])).is_ok());
        assert!(validate_standards(&standards_of("x".repeat(8001).as_str(), &[])).is_err());

        let many: Vec<String> = (0..201).map(|i| format!("rule {i}")).collect();
        let refs: Vec<&str> = many.iter().map(String::as_str).collect();
        assert!(validate_standards(&standards_of("", &refs)).is_err());
        assert!(validate_standards(&standards_of("", &refs[..200])).is_ok());
    }

    // ---- the file wrapper (FR-10/FR-13/FR-14/FR-16) ----

    #[test]
    fn reading_a_missing_claude_md_is_not_an_error() {
        let dir = tmp_root("read-missing");
        let root = dir.to_string_lossy().to_string();
        assert_eq!(
            read_standards(&root).unwrap(),
            StandardsRead {
                standards: ProjectStandards::default(),
                file_exists: false,
                block_present: false,
            }
        );
        assert!(
            !claude_md_path(&root).exists(),
            "a read never creates anything"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn writing_creates_reads_back_and_removes() {
        let dir = tmp_root("write-cycle");
        let root = dir.to_string_lossy().to_string();

        // create
        let read = write_standards(&root, &standards_of("notes", &["one"])).unwrap();
        assert!(read.file_exists && read.block_present);
        assert_eq!(read.standards, standards_of("notes", &["one"]));
        assert_eq!(
            read_claude_md(&dir),
            format!("{}\n", block_of("notes", &["one"]))
        );

        // FR-16: the resolved value is a fresh RE-READ, not the payload — the
        // rule is stored trimmed, exactly as the file carries it.
        let read = write_standards(&root, &standards_of("", &["  padded  "])).unwrap();
        assert_eq!(read.standards, standards_of("", &["padded"]));

        // remove
        let read = write_standards(&root, &standards_of("", &[])).unwrap();
        assert!(read.file_exists, "the file stays, only the block goes");
        assert!(!read.block_present);
        assert_eq!(read_claude_md(&dir), "");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn writing_empty_standards_never_creates_the_file() {
        // §7 #6
        let dir = tmp_root("no-create");
        let root = dir.to_string_lossy().to_string();
        let read = write_standards(&root, &standards_of("", &[])).unwrap();
        assert!(!read.file_exists);
        assert!(!claude_md_path(&root).exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_malformed_claude_md_is_refused_and_left_untouched_on_disk() {
        // §7 #7/#8 + FR-14: the message names the file, and not one byte moves.
        let dir = tmp_root("malformed");
        let root = dir.to_string_lossy().to_string();
        let original = format!("# repo\n\n{STANDARDS_START}\n- half a block\n");
        write_claude_md(&dir, &original);

        let e = write_standards(&root, &standards_of("", &["new"])).unwrap_err();
        assert!(e.contains("CLAUDE.md"), "message must name the file: {e}");
        assert!(
            e.contains("no matching end"),
            "message must name the problem: {e}"
        );
        assert_eq!(read_claude_md(&dir), original);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn hand_written_content_around_the_block_survives_a_real_write() {
        let dir = tmp_root("surroundings");
        let root = dir.to_string_lossy().to_string();
        let original = "# francois\n\nintro prose\n\n## Notes\n\nmore prose\n";
        write_claude_md(&dir, original);

        write_standards(&root, &standards_of("", &["one"])).unwrap();
        let after = read_claude_md(&dir);
        assert!(after.starts_with(original), "prefix changed:\n{after}");

        write_standards(&root, &standards_of("", &["one", "two"])).unwrap();
        let after2 = read_claude_md(&dir);
        assert!(after2.starts_with(original), "prefix changed:\n{after2}");
        assert_eq!(
            read_standards(&root).unwrap().standards,
            standards_of("", &["one", "two"])
        );
        std::fs::remove_dir_all(&dir).ok();
    }
}

#[cfg(test)]
mod remediation_tests {
    //! Gaps named by the review: the FR-15 temp-file cleanup contract, the notes
    //! reclassification guard, apply-on-CRLF, and a malformed-marker READ.

    use super::*;
    use crate::project::testutil::*;

    // ---------- notes must not be silently reclassified as rules ----------

    #[test]
    fn notes_containing_a_bullet_line_are_rejected_not_reinterpreted() {
        // parse_standards ends the notes at the FIRST `- ` line, so a markdown list
        // typed into the notes box would come back as rules on the next read (FR-16
        // re-reads from disk, so the user would watch it reshuffle).
        let s = standards_of("- prefer small files\n- test first", &[]);
        let err = validate_standards(&s).unwrap_err();
        assert!(
            err.contains("bullet"),
            "message must name the constraint: {err}"
        );

        // indented bullets count too, since parse trims the line start
        assert!(validate_standards(&standards_of("intro\n   - nested", &[])).is_err());
    }

    #[test]
    fn notes_containing_the_managed_heading_are_rejected() {
        let s = standards_of(STANDARDS_HEADING, &[]);
        assert!(validate_standards(&s).is_err());
    }

    #[test]
    fn ordinary_multi_line_notes_still_round_trip_unchanged() {
        // the guard must not over-reach: a hyphen mid-sentence is not a bullet
        let notes = "Keep modules small.\nA-B testing is fine.\n\nSecond paragraph.";
        let s = standards_of(notes, &["one", "two"]);
        validate_standards(&s).unwrap();
        let rendered = apply_standards(None, &s).unwrap().unwrap();
        let (parsed, present) = parse_standards(&rendered);
        assert!(present);
        assert_eq!(parsed.notes, notes.trim());
        assert_eq!(parsed.rules, vec!["one".to_string(), "two".to_string()]);
    }

    // ---------- CRLF on the APPLY path (parse was covered, apply was not) ----------

    #[test]
    fn replacing_a_block_in_a_crlf_file_preserves_the_surrounding_bytes() {
        let existing = format!(
            "# Notes\r\nhand written\r\n\r\n{}\r\n{}\r\n- old\r\n{}\r\ntail\r\n",
            STANDARDS_START, STANDARDS_HEADING, STANDARDS_END
        );
        let next = apply_standards(Some(&existing), &standards_of("", &["new"]))
            .unwrap()
            .unwrap();
        assert!(
            next.starts_with("# Notes\r\nhand written\r\n"),
            "prefix intact: {next:?}"
        );
        assert!(next.trim_end().ends_with("tail"), "suffix intact: {next:?}");
        assert!(next.contains("- new"));
        assert!(!next.contains("- old"));
    }

    // ---------- a malformed file READS as blockless, and only WRITES refuse ----------

    #[test]
    fn a_malformed_file_reads_as_present_but_blockless() {
        let dir = tmp_root("malformed-read");
        write_claude_md(
            &dir,
            &format!("intro\n{}\n## Coding standards\n- x\n", STANDARDS_START),
        );
        let read = read_standards(&dir.to_string_lossy()).unwrap();
        assert!(read.file_exists, "the file is there");
        assert!(!read.block_present, "an unterminated block is not a block");
        assert_eq!(read.standards, ProjectStandards::default());

        // ...and the WRITE refuses rather than guessing (FR-14)
        let err = write_standards(&dir.to_string_lossy(), &standards_of("", &["y"])).unwrap_err();
        assert!(
            err.contains("CLAUDE.md"),
            "the message names the file: {err}"
        );
        // the file is byte-identical afterwards
        assert!(read_claude_md(&dir).contains("- x"));
        std::fs::remove_dir_all(&dir).ok();
    }

    // ---------- FR-15: no temp file is ever left behind ----------

    #[test]
    fn a_successful_write_leaves_no_temp_file_in_the_repo() {
        // A leaked CLAUDE.md.<pid>.<n>.tmp lands inside the user's git-tracked repo
        // and shows up in their `git status`.
        let dir = tmp_root("no-temp");
        write_standards(&dir.to_string_lossy(), &standards_of("n", &["a", "b"])).unwrap();
        let strays: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".tmp"))
            .collect();
        assert!(strays.is_empty(), "left temp files behind: {strays:?}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn concurrent_writes_to_one_root_do_not_lose_an_edit() {
        // FR-35 fires a write on EVERY individual edit and the handlers run on
        // worker threads, so overlapping writes are the expected traffic. Without
        // STANDARDS_LOCK both readers see the same file and the later rename wins.
        let dir = tmp_root("concurrent");
        let root = dir.to_string_lossy().into_owned();
        write_standards(&root, &standards_of("", &["seed"])).unwrap();

        std::thread::scope(|scope| {
            for i in 0..8 {
                let root = root.clone();
                scope.spawn(move || {
                    let s = standards_of("", &[Box::leak(format!("rule-{i}").into_boxed_str())]);
                    write_standards(&root, &s).unwrap();
                });
            }
        });

        // Whichever writer landed last, the file must be a WELL-FORMED single block —
        // never interleaved or duplicated.
        let read = read_standards(&root).unwrap();
        assert!(read.block_present);
        assert_eq!(
            read.standards.rules.len(),
            1,
            "exactly one writer's payload survives"
        );
        let body = read_claude_md(&dir);
        assert_eq!(body.matches(STANDARDS_START).count(), 1, "one start marker");
        assert_eq!(body.matches(STANDARDS_END).count(), 1, "one end marker");
        std::fs::remove_dir_all(&dir).ok();
    }
}
