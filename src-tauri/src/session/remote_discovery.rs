//! remote-control (specs/remote-control.md) — pure URL-discovery helpers.
//!
//! Split out of `remote.rs` (§Code layout, ~1000-line ceiling): this file owns
//! every function that turns raw CLI output (a transcript file or the PTY stream)
//! into a decision, with none of the process/thread/registry plumbing. Everything
//! here is a plain function over owned data, so it is unit-tested directly —
//! `remote.rs` only wires these into threads and the state machine.

use serde_json::Value;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

/// Claude Code's `~/.claude/projects/<slug>` directory name for a cwd: every
/// non-ASCII-alphanumeric character becomes '-', case preserved. Verified against a
/// live projects dir — `D:\francois` → `D--francois`, and
/// `D:\francois\.claude\worktrees\feat+remote-control` →
/// `D--francois--claude-worktrees-feat-remote-control`.
pub(crate) fn project_slug(cwd: &str) -> String {
    cwd.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// The claude.ai URL AND the record's own `timestamp`, if `line` is the Remote
/// Control `bridge_status` record. The timestamp is what lets `scan_dir_for_url`
/// gate by content instead of file mtime (C3) — kept private, `parse_bridge_status`
/// below is the public single-value shape every other caller wants.
fn parse_bridge_status_with_timestamp(line: &str) -> Option<(String, String)> {
    let v: Value = serde_json::from_str(line.trim()).ok()?;
    if v.get("type")?.as_str()? != "system" || v.get("subtype")?.as_str()? != "bridge_status" {
        return None;
    }
    let url = v.get("url")?.as_str()?;
    if url.is_empty() {
        return None;
    }
    let ts = v
        .get("timestamp")
        .and_then(|t| t.as_str())
        .unwrap_or("")
        .to_string();
    Some((url.to_string(), ts))
}

/// The claude.ai URL carried by one transcript line, if that line is the Remote
/// Control `bridge_status` record.
pub(crate) fn parse_bridge_status(line: &str) -> Option<String> {
    parse_bridge_status_with_timestamp(line).map(|(url, _)| url)
}

/// First `bridge_status` URL in a transcript body.
pub(crate) fn scan_transcript(body: &str) -> Option<String> {
    body.lines().find_map(parse_bridge_status)
}

/// The session URL out of raw PTY output — the fallback source, and the only one
/// that works for the `wsl` runtime. Deliberately tolerant of ANSI/wrapping noise
/// around the URL. C6: only a TERMINATED id is accepted — there must be at least
/// one more byte after it that is not alphanumeric. A read boundary can otherwise
/// land mid-id (`…/session_01Mo4r8` with the rest in the NEXT read); accepting an
/// id that runs to the end of the buffer would publish it truncated, and FR-11
/// makes that permanent.
pub(crate) fn extract_url_from_output(chunk: &str) -> Option<String> {
    const MARK: &str = "https://claude.ai/code/session_";
    let start = chunk.find(MARK)?;
    let rest = &chunk[start + MARK.len()..];
    let id_len = rest
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric())
        .count();
    if id_len == 0 {
        return None;
    }
    // The id is pure ASCII, so char count == byte count here.
    if id_len == rest.len() {
        return None; // runs to the end of the buffer — could still be growing
    }
    let id = &rest[..id_len];
    Some(format!("{MARK}{id}"))
}

/// PTY output as plain words: every escape sequence becomes a single space and
/// whitespace runs collapse. The TUI positions each word with its own cursor-forward
/// code, so `New\x1b[1CMCP\x1b[1Cserver` is only greppable after this.
///
/// M1: CSI sequences are terminated on a final byte in `0x40..=0x7E` (ECMA-48),
/// not just letters+`~` — `\x1b[3@` (ICH, used by the TUI) ends on `@` (0x40),
/// which the narrower check missed, eating the real text that followed. OSC and
/// the other string-typed sequences (DCS/APC/PM/SOS: `ESC P`/`_`/`^`/`X`) are
/// consumed to their terminator the same way; `ESC (`/`ESC )` (character-set
/// designators) are exactly 3 bytes and consumed as such, rather than the 2-byte
/// fallback leaking the designator byte as text.
pub(crate) fn normalize_pty(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            match chars.peek().copied() {
                Some('[') => {
                    chars.next();
                    while let Some(&n) = chars.peek() {
                        chars.next();
                        if ('\u{40}'..='\u{7e}').contains(&n) {
                            break;
                        }
                    }
                }
                Some(']') | Some('P') | Some('_') | Some('^') | Some('X') => {
                    // OSC / DCS / APC / PM / SOS — string-typed, terminated by ST
                    // (ESC \) or BEL. A bare ESC encountered while scanning is
                    // treated as the terminator too, which is enough to not
                    // swallow real text after a well-formed sequence.
                    chars.next();
                    while let Some(&n) = chars.peek() {
                        chars.next();
                        if n == '\u{7}' || n == '\u{1b}' {
                            break;
                        }
                    }
                }
                Some('(') | Some(')') => {
                    // Character-set designator: ESC ( X / ESC ) X — exactly 3 bytes.
                    chars.next();
                    chars.next();
                }
                _ => {
                    chars.next();
                }
            }
            out.push(' ');
        } else if c.is_control() {
            out.push(' ');
        } else {
            out.push(c);
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// An interactive host can stall forever on a consent/trust dialog instead of
/// registering Remote Control — verified live: a first run in a directory with an
/// unapproved `.mcp.json` server parks on "New MCP server found in this project".
/// Print mode (turn.rs) never hits this because it auto-skips those dialogs, so this
/// failure mode is unique to the Remote Control host. Detect it and say what to do,
/// rather than letting the user watch a two-minute timeout.
///
/// Francois deliberately does NOT auto-answer: these are the user's trust decisions.
///
/// M4: the MCP match additionally requires "Use this MCP server" (the captured
/// dialog's numbered choice) in the SAME normalized window — the bare phrase "New
/// MCP server found" is plausible in ordinary conversation text too (this very repo
/// discusses it), so a `--resume`'s replay of prior transcript could otherwise
/// self-trigger a bogus kill. `feed`'s frame-scoping (screen-clear resets the
/// carry) is the primary defence; this corroboration is defence in depth. The
/// workspace-trust dialog has no live-captured second phrase, so it deliberately
/// relies on frame-scoping alone — do not invent an unverified corroborator here.
pub(crate) fn blocking_prompt(normalized: &str) -> Option<&'static str> {
    const MCP: &str = "New MCP server found";
    const MCP_CONFIRM: &str = "Use this MCP server";
    const TRUST: &str = "Do you trust the files in this folder";
    if normalized.contains(MCP) && normalized.contains(MCP_CONFIRM) {
        return Some(
            "the Remote Control host is waiting for MCP server approval in this folder — \
             run `claude` there once and approve it, then retry",
        );
    }
    if normalized.contains(TRUST) {
        return Some(
            "the Remote Control host is waiting for the workspace trust prompt in this folder — \
             run `claude` there once and accept it, then retry",
        );
    }
    None
}

/// What the reader thread should do after `feed` folds a new chunk of PTY output
/// into the carry buffer.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ReaderAction {
    Url(String),
    Blocked(&'static str),
}

/// Append `chunk` to `carry` and decide what the reader should do. Owns every
/// piece of carry bookkeeping so the decision logic is unit-testable on its own:
/// the trailing-window trim (C1), the URL match (C6), the blocked-prompt match,
/// and frame-scoping (M4) — a screen clear means everything before it belongs to a
/// stale frame (e.g. `--resume`'s replay of prior history), so the carry is reset
/// before the new chunk is appended, and only the CURRENT frame is ever matched.
pub(crate) fn feed(carry: &mut String, chunk: &str) -> Option<ReaderAction> {
    if chunk.contains("\u{1b}[2J") || chunk.contains("\u{1b}[3J") {
        carry.clear();
    }
    carry.push_str(chunk);

    // C1: the URL can straddle two reads, so we keep a trailing window rather than
    // clearing outright — but this buffer is full of multi-byte box-drawing glyphs
    // (and `U+FFFD` from lossy decoding), so the cut MUST land on a UTF-8 char
    // boundary. Slicing mid-character panics, which used to kill this thread on
    // the ordinary path (the TUI paints well past 16 KB before RC registers) —
    // nobody left to drain the master, and the child hangs alive forever.
    if carry.len() > 16_384 {
        let mut cut = carry.len() - 4_096;
        while !carry.is_char_boundary(cut) {
            cut += 1;
        }
        *carry = carry[cut..].to_string();
    }

    if let Some(url) = extract_url_from_output(carry) {
        carry.clear();
        return Some(ReaderAction::Url(url));
    }
    if let Some(why) = blocking_prompt(&normalize_pty(carry)) {
        return Some(ReaderAction::Blocked(why));
    }
    None
}

/// Read the bytes appended to `path` since `from`, returning any URL found plus the
/// new offset. A file shorter than `from` (replaced/truncated) is rescanned whole.
/// M3: seeks instead of reading the whole file every tick — the poller ticks every
/// 250ms for up to 120s, and re-reading a multi-MB resumed transcript that often
/// would be gigabytes of I/O per host start.
pub(crate) fn tail_for_url(path: &Path, from: u64) -> (Option<String>, u64) {
    let Ok(mut file) = std::fs::File::open(path) else {
        return (None, from);
    };
    let Ok(meta) = file.metadata() else {
        return (None, from);
    };
    let len = meta.len();
    let start = if len < from { 0 } else { from };
    if file.seek(SeekFrom::Start(start)).is_err() {
        return (None, from);
    }
    let mut bytes = Vec::new();
    if file.read_to_end(&mut bytes).is_err() {
        return (None, from);
    }
    let body = String::from_utf8_lossy(&bytes);
    (scan_transcript(&body), len)
}

/// Howard Hinnant's "days from civil" algorithm (public domain,
/// http://howardhinnant.github.io/date_algorithms.html), inverted: days-since-epoch
/// → proleptic-Gregorian (year, month, day). Pure integer math, no external crate.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365; // [0, 399]
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}

/// Format epoch milliseconds as the exact RFC3339 shape the CLI writes into
/// `bridge_status.timestamp` (`YYYY-MM-DDTHH:MM:SS.mmmZ`), so it can be compared
/// LEXICOGRAPHICALLY against that field (C3): both are fixed-width, zero-padded
/// UTC strings, so string comparison IS chronological comparison. This avoids
/// parsing the record's timestamp back into a number (and, deliberately, a
/// `chrono` dependency — not part of this project).
pub(crate) fn epoch_ms_to_rfc3339(epoch_ms: u64) -> String {
    let ms = epoch_ms % 1000;
    let secs_total = (epoch_ms / 1000) as i64;
    let days = secs_total.div_euclid(86_400);
    let secs_of_day = secs_total.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    let hh = secs_of_day / 3600;
    let mm = (secs_of_day % 3600) / 60;
    let ss = secs_of_day % 60;
    format!("{y:04}-{m:02}-{d:02}T{hh:02}:{mm:02}:{ss:02}.{ms:03}Z")
}

/// Fallback for a `--resume` whose thread the CLI had pruned: it forks a FRESH
/// session id, so the URL lands in a transcript we did not predict. Three C3
/// fixes over the original file-mtime gate:
///  1. `expected` is excluded — it is already offset-tailed by the caller
///     (`tail_for_url`), so a hit there is fresh by construction; and it is
///     USELESS to gate by mtime in particular, since this very run keeps
///     rewriting it, so it always looks "fresh" regardless of content age.
///  2. Every other file is gated by the `bridge_status` record's OWN `timestamp`
///     (`>= since_ms`), not file mtime — mtime cannot tell a decade-old record
///     from a live one once any write touches the file this run.
///  3. Returns the LAST matching record rather than the first, as defence in
///     depth should more than one ever land in a single file.
pub(crate) fn scan_dir_for_url(dir: &Path, expected: &Path, since_ms: u64) -> Option<String> {
    let since = epoch_ms_to_rfc3339(since_ms);
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "jsonl"))
        .filter(|p| p != expected)
        .collect();
    files.sort();

    let mut last = None;
    for p in files {
        let Ok(body) = std::fs::read_to_string(&p) else {
            continue;
        };
        for line in body.lines() {
            if let Some((url, ts)) = parse_bridge_status_with_timestamp(line) {
                if ts.as_str() >= since.as_str() {
                    last = Some(url);
                }
            }
        }
    }
    last
}

/// M2: `name` becomes a bare argv element after `--remote-control` — a name
/// starting with `-` would be parsed by the CLI as a flag (a name of `-p` would
/// silently reduce Remote Control to the verified no-op while Francois reports
/// success). Strip leading dashes; fall back to the (also stripped) session name,
/// then a fixed default, if that leaves nothing.
pub(crate) fn sanitize_name(name: &str, session_name: &str) -> String {
    let stripped = name.trim_start_matches('-');
    if !stripped.is_empty() {
        return stripped.to_string();
    }
    let session_stripped = session_name.trim_start_matches('-');
    if !session_stripped.is_empty() {
        return session_stripped.to_string();
    }
    "Francois".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- project_slug: verified against a live ~/.claude/projects listing ----

    #[test]
    fn project_slug_matches_claude_codes_windows_dir_names() {
        assert_eq!(project_slug("D:\\francois"), "D--francois");
        assert_eq!(
            project_slug("D:\\francois\\.claude\\worktrees\\feat+remote-control"),
            "D--francois--claude-worktrees-feat-remote-control"
        );
    }

    #[test]
    fn project_slug_preserves_case_and_collapses_nothing() {
        // `d--Weda-WD` in the live listing proves case is NOT normalized, and that
        // each separator maps to exactly one '-' (no run-collapsing).
        assert_eq!(project_slug("d:\\Weda\\WD"), "d--Weda-WD");
    }

    #[test]
    fn project_slug_maps_posix_paths_too() {
        assert_eq!(project_slug("/home/ann/src/app"), "-home-ann-src-app");
    }

    // ---- parse_bridge_status: the real record, verbatim from a live transcript ----

    const LIVE_LINE: &str = r#"{"parentUuid":"ae3bd9de","isSidechain":false,"type":"system","subtype":"bridge_status","content":"/remote-control is active · Continue here, on your phone, or at https://claude.ai/code/session_01Mo4r8N2qZBTbU4V647cis4","url":"https://claude.ai/code/session_01Mo4r8N2qZBTbU4V647cis4","isMeta":false,"timestamp":"2026-07-17T23:50:32.944Z","cwd":"D:\\francois","version":"2.1.212"}"#;

    #[test]
    fn parse_bridge_status_reads_the_live_record() {
        assert_eq!(
            parse_bridge_status(LIVE_LINE).as_deref(),
            Some("https://claude.ai/code/session_01Mo4r8N2qZBTbU4V647cis4")
        );
    }

    #[test]
    fn parse_bridge_status_ignores_other_records() {
        assert_eq!(parse_bridge_status(r#"{"type":"assistant"}"#), None);
        // A system record of a different subtype must not match.
        assert_eq!(
            parse_bridge_status(r#"{"type":"system","subtype":"init","url":"x"}"#),
            None
        );
        // Right shape, no url.
        assert_eq!(
            parse_bridge_status(r#"{"type":"system","subtype":"bridge_status"}"#),
            None
        );
        assert_eq!(
            parse_bridge_status(r#"{"type":"system","subtype":"bridge_status","url":""}"#),
            None
        );
        assert_eq!(parse_bridge_status("not json"), None);
        assert_eq!(parse_bridge_status(""), None);
    }

    #[test]
    fn scan_transcript_finds_the_record_among_other_lines() {
        let body = format!("{{\"type\":\"user\"}}\n{LIVE_LINE}\n{{\"type\":\"assistant\"}}\n");
        assert_eq!(
            scan_transcript(&body).as_deref(),
            Some("https://claude.ai/code/session_01Mo4r8N2qZBTbU4V647cis4")
        );
        assert_eq!(scan_transcript("{\"type\":\"user\"}\n"), None);
    }

    // ---- extract_url_from_output ----

    #[test]
    fn extract_url_from_output_reads_the_tui_notice() {
        let out = "\u{1b}[2m/rc active · Continue at https://claude.ai/code/session_016dcpMZVmqWp4BjQWVXkrHh\u{1b}[0m\r\n";
        assert_eq!(
            extract_url_from_output(out).as_deref(),
            Some("https://claude.ai/code/session_016dcpMZVmqWp4BjQWVXkrHh")
        );
    }

    #[test]
    fn extract_url_from_output_stops_at_punctuation_and_ansi() {
        // Trailing sentence punctuation must not be swallowed into the id.
        assert_eq!(
            extract_url_from_output("go to https://claude.ai/code/session_01AB, then").as_deref(),
            Some("https://claude.ai/code/session_01AB")
        );
        assert_eq!(
            extract_url_from_output("https://claude.ai/code/session_01AB\u{1b}[0m").as_deref(),
            Some("https://claude.ai/code/session_01AB")
        );
    }

    #[test]
    fn extract_url_from_output_ignores_unrelated_output_and_bare_marker() {
        assert_eq!(extract_url_from_output("welcome to claude code"), None);
        assert_eq!(extract_url_from_output("https://claude.ai/code/"), None);
        // Marker present but no id → not a URL yet (mid-stream split).
        assert_eq!(
            extract_url_from_output("at https://claude.ai/code/session_"),
            None
        );
    }

    #[test]
    fn extract_url_from_output_waits_when_the_id_runs_to_the_end_of_the_buffer() {
        // C6: a read boundary can land mid-id. Publishing it truncated would be
        // permanent (FR-11 is single-shot) — must wait for more input instead.
        assert_eq!(
            extract_url_from_output("continue at https://claude.ai/code/session_01Mo4r8"),
            None
        );
    }

    // ---- normalize_pty / blocking_prompt: shapes captured from a real stalled host ----

    #[test]
    fn normalize_pty_rejoins_words_split_by_cursor_codes() {
        // This is how the TUI actually renders it — each word placed with its own
        // cursor-forward code, so the phrase is NOT a contiguous substring of the raw
        // stream. Verified against a live stalled host.
        let raw = "\u{1b}[3;3H\u{1b}[1mNew\u{1b}[1CMCP\u{1b}[1Cserver\u{1b}[1Cfound\u{1b}[1Cin\u{1b}[1Cthis\u{1b}[1Cproject:\u{1b}[1Cserena\u{1b}[0m";
        assert_eq!(
            normalize_pty(raw),
            "New MCP server found in this project: serena"
        );
    }

    #[test]
    fn normalize_pty_drops_osc_and_control_bytes() {
        assert_eq!(normalize_pty("\u{1b}]0;claude\u{7}hello"), "hello");
        assert_eq!(normalize_pty("a\r\n\tb"), "a b");
        assert_eq!(normalize_pty(""), "");
    }

    #[test]
    fn normalize_pty_terminates_csi_ich_on_the_at_final_byte() {
        // M1: `\x1b[3@` is ICH (insert N blank chars) — final byte '@' (0x40), which
        // the old `is_ascii_alphabetic() || '~'` check missed, eating the text that
        // followed it into the escape scan.
        assert_eq!(
            normalize_pty("\u{1b}[3@New MCP server found"),
            "New MCP server found"
        );
    }

    #[test]
    fn normalize_pty_consumes_charset_designators_as_three_bytes() {
        // M1: the old 2-byte fallback left the designator byte as stray text.
        assert_eq!(normalize_pty("\u{1b}(Bhello"), "hello");
        assert_eq!(normalize_pty("hello\u{1b}(Bworld"), "hello world");
    }

    #[test]
    fn blocking_prompt_catches_the_mcp_consent_dialog() {
        // The full captured dialog: the phrase AND the numbered-choice corroborator
        // (M4), both split by the TUI's per-word cursor-forward codes.
        let raw = "\u{1b}[3;3HNew\u{1b}[1CMCP\u{1b}[1Cserver\u{1b}[1Cfound\u{1b}[1Cin\u{1b}[1Cthis\u{1b}[1Cproject:\u{1b}[1Cserena\u{1b}[5;3HUse\u{1b}[1Cthis\u{1b}[1CMCP\u{1b}[1Cserver?";
        let why = blocking_prompt(&normalize_pty(raw)).expect("should detect the stall");
        assert!(why.contains("MCP server approval"), "actionable: {why}");
        assert!(why.contains("`claude`"), "should say how to fix it: {why}");
    }

    #[test]
    fn blocking_prompt_ignores_a_replayed_mention_without_the_numbered_choice() {
        // M4: --resume's transcript replay can contain the literal phrase in prose
        // (this repo discusses this exact stall) — without the corroborating
        // numbered-choice text from the real dialog, it must not fire.
        let raw = "we saw \"New MCP server found\" earlier while testing this feature";
        assert_eq!(blocking_prompt(&normalize_pty(raw)), None);
    }

    #[test]
    fn blocking_prompt_catches_the_workspace_trust_dialog() {
        let raw = "Do\u{1b}[1Cyou\u{1b}[1Ctrust\u{1b}[1Cthe\u{1b}[1Cfiles\u{1b}[1Cin\u{1b}[1Cthis\u{1b}[1Cfolder?";
        assert!(blocking_prompt(&normalize_pty(raw)).is_some());
    }

    #[test]
    fn blocking_prompt_ignores_ordinary_startup_output() {
        assert_eq!(
            blocking_prompt(&normalize_pty("\u{1b}[2mwelcome to claude code")),
            None
        );
        // The success path must never read as a stall.
        assert_eq!(
            blocking_prompt(&normalize_pty(
                "/rc active · Continue at https://claude.ai/code/session_01AB"
            )),
            None
        );
        assert_eq!(blocking_prompt(""), None);
    }

    // ---- feed: the reader's decision logic ----

    #[test]
    fn feed_returns_a_url_for_a_complete_marker() {
        let mut carry = String::new();
        let action = feed(
            &mut carry,
            "continue at https://claude.ai/code/session_01AB, then",
        );
        assert_eq!(
            action,
            Some(ReaderAction::Url(
                "https://claude.ai/code/session_01AB".to_string()
            ))
        );
        assert!(carry.is_empty(), "carry is cleared once the url is found");
    }

    #[test]
    fn feed_waits_when_an_id_is_unterminated_at_the_buffer_end() {
        let mut carry = String::new();
        assert_eq!(
            feed(&mut carry, "at https://claude.ai/code/session_01Mo4r8"),
            None
        );
        assert!(
            !carry.is_empty(),
            "carry is kept so the next chunk can complete it"
        );
    }

    #[test]
    fn feed_yields_the_full_id_once_when_it_straddles_two_reads() {
        // C6 end-to-end: the id is split exactly at a read boundary.
        let mut carry = String::new();
        assert_eq!(
            feed(&mut carry, "at https://claude.ai/code/session_01Mo4r8"),
            None
        );
        assert_eq!(
            feed(&mut carry, "N2qZBTbU4V647cis4\r\n"),
            Some(ReaderAction::Url(
                "https://claude.ai/code/session_01Mo4r8N2qZBTbU4V647cis4".to_string()
            ))
        );
    }

    #[test]
    fn feed_detects_a_blocking_prompt() {
        let mut carry = String::new();
        let raw = "New\u{1b}[1CMCP\u{1b}[1Cserver\u{1b}[1Cfound Use\u{1b}[1Cthis\u{1b}[1CMCP\u{1b}[1Cserver?";
        match feed(&mut carry, raw) {
            Some(ReaderAction::Blocked(why)) => assert!(why.contains("MCP server approval")),
            other => panic!("expected a blocked action, got {other:?}"),
        }
    }

    #[test]
    fn feed_trims_a_multibyte_carry_without_panicking() {
        // C1: '─' (U+2500) is 3 bytes — real TUI box-drawing chars fill this buffer
        // with exactly this kind of run. Any length built purely from 3-byte chars
        // puts `len - 4096` two bytes INTO a character (4096 % 3 == 1): the panic
        // this guards against, on the ordinary (non-error) path.
        let mut carry: String = "─".repeat(6000); // 18_000 bytes, over the trigger
        let before = carry.len();
        assert!(before > 16_384);
        let action = feed(&mut carry, "more");
        assert_eq!(action, None);
        assert!(carry.len() < before, "the carry was actually trimmed");
        assert!(carry.ends_with("more"));
    }

    #[test]
    fn feed_frame_scopes_so_a_screen_clear_drops_stale_transcript_replay() {
        // M4 mitigation 1: a stale carry (e.g. a --resume replay containing the
        // literal MCP phrase in prose) is dropped the moment a NEW chunk carries a
        // screen-clear — only the current frame is ever matched afterwards.
        let mut carry = String::from("New MCP server found. Use this MCP server?");
        let action = feed(&mut carry, "\u{1b}[2Jwelcome back");
        assert_eq!(action, None);
        assert!(
            !carry.contains("Use this MCP server"),
            "stale text must be gone: {carry}"
        );
        assert!(carry.contains("welcome back"));
    }

    // ---- tail_for_url / scan_dir_for_url ----

    fn tmpdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("francois-rc-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn tail_for_url_only_reads_what_was_appended() {
        let dir = tmpdir("tail");
        let f = dir.join("t.jsonl");
        std::fs::write(&f, format!("{LIVE_LINE}\n")).unwrap();

        // Starting at offset 0 reads the whole (only) file and sees the record;
        // offset advances to EOF.
        let (found, off) = tail_for_url(&f, 0);
        assert!(found.is_some());
        let (again, off2) = tail_for_url(&f, off);
        assert_eq!(again, None, "already-consumed bytes must not re-match");
        assert_eq!(off2, off);

        // A newly appended record IS seen from the saved offset.
        std::fs::write(&f, format!("{LIVE_LINE}\n{LIVE_LINE}\n")).unwrap();
        assert!(tail_for_url(&f, off).0.is_some());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn tail_for_url_starting_past_the_record_does_not_see_it() {
        // C2 regression, at the pure-function level: `remote_start` now seeds its
        // transcript-poll offset from the file's length BEFORE the first poll, so
        // a `--resume` of a previously remote-controlled thread never re-reads (and
        // re-reports) the URL that was already there.
        let dir = tmpdir("past");
        let f = dir.join("t.jsonl");
        std::fs::write(&f, format!("{LIVE_LINE}\n")).unwrap();
        let eof = std::fs::metadata(&f).unwrap().len();

        let (found, off) = tail_for_url(&f, eof);
        assert_eq!(
            found, None,
            "a record already present before the seeded offset must not be seen"
        );
        assert_eq!(off, eof);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn tail_for_url_rescans_a_truncated_file_and_tolerates_a_missing_one() {
        let dir = tmpdir("trunc");
        let f = dir.join("t.jsonl");
        std::fs::write(&f, format!("{LIVE_LINE}\n")).unwrap();
        // Offset beyond EOF (file was replaced) → rescan from 0 rather than skip.
        assert!(tail_for_url(&f, 10_000).0.is_some());

        let (found, off) = tail_for_url(&dir.join("nope.jsonl"), 42);
        assert_eq!(found, None);
        assert_eq!(off, 42, "a missing file must not reset the offset");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn epoch_ms_to_rfc3339_matches_known_instants() {
        assert_eq!(epoch_ms_to_rfc3339(0), "1970-01-01T00:00:00.000Z");
        // The LIVE_LINE fixture's own timestamp, round-tripped from a millis value
        // computed independently (not by re-parsing the string): 2026-07-17 is
        // 20,651 days after the epoch (verified independently); 23:50:32.944 is
        // that many ms into the day.
        let days: i64 = 20_651;
        let ms_of_day: i64 = ((23 * 3600 + 50 * 60 + 32) * 1000) + 944;
        let epoch_ms = (days * 86_400_000 + ms_of_day) as u64;
        assert_eq!(epoch_ms_to_rfc3339(epoch_ms), "2026-07-17T23:50:32.944Z");
    }

    #[test]
    fn scan_dir_for_url_ignores_records_older_than_this_run() {
        let dir = tmpdir("since");
        let stale = dir.join("old.jsonl");
        std::fs::write(&stale, format!("{LIVE_LINE}\n")).unwrap();
        let expected = dir.join("expected.jsonl"); // does not exist — fine, just excluded

        // This is the regression that matters: a project dir accumulates
        // bridge_status records from every past remote session. Anything recorded
        // before we started must never be reported as this run's URL. LIVE_LINE's
        // own timestamp is 2026-07-17T23:50:32.944Z; one second later excludes it.
        let since_ms = {
            let days: i64 = 20_651;
            let ms_of_day: i64 = ((23 * 3600 + 50 * 60 + 33) * 1000) + 944; // +1s
            (days * 86_400_000 + ms_of_day) as u64
        };
        assert_eq!(scan_dir_for_url(&dir, &expected, since_ms), None);

        // A record from at/after the start IS picked up (the forked-thread case).
        assert!(scan_dir_for_url(&dir, &expected, 0).is_some());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn scan_dir_for_url_excludes_the_expected_path() {
        // `expected` is already offset-tailed by the caller; including it here
        // would re-serve a record from it regardless of this run's start, since
        // this very run keeps appending to (and thus "freshening") that one file.
        let dir = tmpdir("excl");
        let expected = dir.join("expected.jsonl");
        std::fs::write(&expected, format!("{LIVE_LINE}\n")).unwrap();
        assert_eq!(scan_dir_for_url(&dir, &expected, 0), None);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn scan_dir_for_url_returns_the_last_match_across_files() {
        let dir = tmpdir("last");
        let expected = dir.join("expected.jsonl");
        let a = dir.join("a.jsonl");
        let b = dir.join("b.jsonl");
        let other_url = LIVE_LINE.replace("session_01Mo4r8N2qZBTbU4V647cis4", "session_ZZZZ");
        std::fs::write(&a, format!("{LIVE_LINE}\n")).unwrap();
        std::fs::write(&b, format!("{other_url}\n")).unwrap();
        // Files are scanned in sorted path order (a, b) — the last-seen match (b)
        // must win.
        assert_eq!(
            scan_dir_for_url(&dir, &expected, 0).as_deref(),
            Some("https://claude.ai/code/session_ZZZZ")
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn scan_dir_for_url_skips_non_transcripts_and_missing_dirs() {
        let dir = tmpdir("filter");
        let expected = dir.join("expected.jsonl");
        std::fs::write(dir.join("notes.txt"), LIVE_LINE).unwrap();
        assert_eq!(scan_dir_for_url(&dir, &expected, 0), None);
        assert_eq!(scan_dir_for_url(&dir.join("absent"), &expected, 0), None);
        std::fs::remove_dir_all(&dir).ok();
    }

    // ---- sanitize_name ----

    #[test]
    fn sanitize_name_strips_leading_dashes() {
        // Stripping is enough to make the argv element safe (it can no longer be
        // parsed as a flag); the session-name fallback only kicks in once
        // stripping leaves NOTHING (see the test below).
        assert_eq!(sanitize_name("-p", "My Session"), "p");
        assert_eq!(sanitize_name("--danger", "S"), "danger");
        assert_eq!(sanitize_name("ok", "S"), "ok");
    }

    #[test]
    fn sanitize_name_falls_back_to_a_fixed_default() {
        assert_eq!(sanitize_name("-", "-"), "Francois");
        assert_eq!(sanitize_name("", ""), "Francois");
    }

    #[test]
    fn sanitize_name_argv_element_never_starts_with_a_dash() {
        for (name, session_name) in [("-p", "S"), ("---", "-x"), ("", "")] {
            assert!(!sanitize_name(name, session_name).starts_with('-'));
        }
    }
}
