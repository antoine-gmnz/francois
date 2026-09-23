//! FR-27 — the sanitiser (Cohorte DESIGN §2.3.6), applied to every
//! agent-controlled or free-text string that crosses IPC, plus the two other
//! small boundary checks everything here leans on: id validation before an id
//! reaches an argv (FR-27/FR-104) and RFC3339 → epoch ms (FR-14).

use serde_json::Value;
use unicode_normalization::UnicodeNormalization;

/// Field caps (FR-27). Summary/title count characters (Cohorte's own
/// `maxLength` is code points); the KiB caps count UTF-8 bytes.
pub(crate) const SUMMARY_CHARS: usize = 200;
pub(crate) const TITLE_CHARS: usize = 160;
pub(crate) const PREVIEW_BYTES: usize = 4 * 1024;
pub(crate) const MESSAGE_BYTES: usize = 2 * 1024;
pub(crate) const DELTA_BYTES: usize = 8 * 1024;
/// Everything without a named cap — ids, paths, labels — is bounded too.
const DEFAULT_BYTES: usize = 4 * 1024;

fn is_bidi(c: char) -> bool {
    crate::ipc::is_bidi_control(c)
}

/// Strip ANSI escape sequences (CSI `ESC [ … final`, OSC `ESC ] … BEL|ST`,
/// two-char `ESC x`, and the 8-bit CSI U+009B), C0 (except `\n` when
/// `keep_newlines`), DEL, C1 and bidi overrides; then collapse to NFC.
pub(crate) fn strip(s: &str, keep_newlines: bool) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\u{1b}' => match chars.peek().copied() {
                Some('[') => {
                    chars.next();
                    for n in chars.by_ref() {
                        if ('@'..='~').contains(&n) {
                            break;
                        }
                    }
                }
                Some(']') => {
                    chars.next();
                    while let Some(n) = chars.next() {
                        if n == '\u{7}' {
                            break;
                        }
                        if n == '\u{1b}' {
                            if chars.peek() == Some(&'\\') {
                                chars.next();
                            }
                            break;
                        }
                    }
                }
                Some(_) => {
                    chars.next();
                }
                None => {}
            },
            '\u{9b}' => {
                for n in chars.by_ref() {
                    if ('@'..='~').contains(&n) {
                        break;
                    }
                }
            }
            '\n' if keep_newlines => out.push('\n'),
            c if (c as u32) < 0x20 || ('\u{7f}'..='\u{9f}').contains(&c) || is_bidi(c) => {}
            c => out.push(c),
        }
    }
    out.nfc().collect()
}

/// Cap at `max` characters; `true` when something was cut.
pub(crate) fn cap_chars(s: String, max: usize) -> (String, bool) {
    match s.char_indices().nth(max) {
        Some((idx, _)) => (s[..idx].to_string(), true),
        None => (s, false),
    }
}

/// Cap at `max` UTF-8 bytes on a char boundary; `true` when something was cut.
pub(crate) fn cap_bytes(s: String, max: usize) -> (String, bool) {
    if s.len() <= max {
        return (s, false);
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    (s[..end].to_string(), true)
}

/// Keep the LAST `max` bytes (FR-22: a coalesced delta keeps its tail).
pub(crate) fn cap_bytes_tail(s: String, max: usize) -> String {
    if s.len() <= max {
        return s;
    }
    let mut start = s.len() - max;
    while !s.is_char_boundary(start) {
        start += 1;
    }
    s[start..].to_string()
}

/// A one-line display string (summary, labels, messages).
pub(crate) fn line(s: &str, max_bytes: usize) -> String {
    cap_bytes(strip(s, false), max_bytes).0
}

pub(crate) fn summary(s: &str) -> String {
    cap_chars(strip(s, false), SUMMARY_CHARS).0
}

pub(crate) fn title(s: &str) -> String {
    cap_chars(strip(s, false), TITLE_CHARS).0
}

/// Per-key caps for the generic payload pass (FR-27). Keys whose text is
/// multi-line by nature keep `\n`.
fn cap_for(key: Option<&str>) -> (usize, bool) {
    match key {
        Some("preview") | Some("text") => (PREVIEW_BYTES, true),
        Some("delta") => (DELTA_BYTES, true),
        Some("message") | Some("reason") | Some("detail") | Some("remediation")
        | Some("because") | Some("expected") | Some("actual") | Some("suggestedFix")
        | Some("summary") | Some("what") => (MESSAGE_BYTES, false),
        _ => (DEFAULT_BYTES, false),
    }
}

/// Sanitise every string of a raw JSON payload in place, key-aware.
pub(crate) fn sanitize_value(v: &mut Value, key: Option<&str>) {
    match v {
        Value::String(s) => {
            let (cap, keep) = cap_for(key);
            *s = cap_bytes(strip(s, keep), cap).0;
        }
        Value::Array(items) => {
            for item in items {
                sanitize_value(item, key);
            }
        }
        Value::Object(map) => {
            for (k, item) in map.iter_mut() {
                let k = k.clone();
                sanitize_value(item, Some(&k));
            }
        }
        _ => {}
    }
}

/// FR-27: `^[a-z]+_[A-Za-z0-9_]+$` — checked before an id reaches any argv.
pub(crate) fn valid_id(id: &str) -> bool {
    let Some((prefix, rest)) = id.split_once('_') else {
        return false;
    };
    !prefix.is_empty()
        && prefix.bytes().all(|b| b.is_ascii_lowercase())
        && !rest.is_empty()
        && rest.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

/// RFC3339 → epoch ms; anything unparseable (or before 1970) is `None` —
/// the caller leaves the field absent, never 0 (FR-14).
pub(crate) fn iso_ms(s: &str) -> Option<u64> {
    let dt = chrono::DateTime::parse_from_rfc3339(s.trim()).ok()?;
    u64::try_from(dt.timestamp_millis()).ok()
}

pub(crate) fn iso_ms_value(v: Option<&Value>) -> Option<u64> {
    v.and_then(Value::as_str).and_then(iso_ms)
}

/// `run_` + the first 6 hex — the display short id (spec §6).
pub(crate) fn short_id(run_id: &str) -> String {
    let hex = run_id.strip_prefix("run_").unwrap_or(run_id);
    format!("run_{}", hex.chars().take(6).collect::<String>())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn strips_c0_c1_del_and_bidi_controls() {
        let s = "a\u{0}b\u{7}c\u{7f}d\u{85}e\u{202e}f\u{2066}g\th";
        assert_eq!(strip(s, false), "abcdefgh");
    }

    #[test]
    fn keeps_newlines_only_when_asked() {
        assert_eq!(strip("a\nb", true), "a\nb");
        assert_eq!(strip("a\nb", false), "ab");
    }

    #[test]
    fn an_ansi_escape_is_removed_whole() {
        assert_eq!(strip("\u{1b}[31mred\u{1b}[0m text", false), "red text");
        assert_eq!(
            strip("\u{1b}]8;;http://x\u{7}link\u{1b}]8;;\u{7}", false),
            "link"
        );
        assert_eq!(strip("\u{9b}1mbold", false), "bold");
    }

    #[test]
    fn collapses_to_nfc() {
        // e + combining acute → é (U+00E9)
        assert_eq!(strip("e\u{301}", false), "\u{e9}");
    }

    #[test]
    fn caps_count_chars_or_bytes_on_boundaries() {
        let (s, cut) = cap_chars("é".repeat(300), SUMMARY_CHARS);
        assert!(cut);
        assert_eq!(s.chars().count(), 200);
        let (s, cut) = cap_bytes("é".repeat(10), 5);
        assert!(cut);
        assert_eq!(s, "éé");
        assert_eq!(cap_bytes_tail("abcdef".into(), 3), "def");
        assert_eq!(summary(&"x".repeat(250)).len(), 200);
        assert_eq!(title(&"x".repeat(250)).len(), 160);
    }

    #[test]
    fn the_generic_pass_is_key_aware() {
        let mut v = json!({
            "preview": "line1\nline2\u{1b}[1m",
            "message": "m\ne",
            "nested": [{ "delta": "d\n" }],
            "n": 3
        });
        sanitize_value(&mut v, None);
        assert_eq!(v["preview"], "line1\nline2");
        assert_eq!(v["message"], "me");
        assert_eq!(v["nested"][0]["delta"], "d\n");
        assert_eq!(v["n"], 3);
    }

    #[test]
    fn ids_are_validated() {
        assert!(valid_id("run_7fa3c1"));
        assert!(valid_id("apr_0123abcdEF_9"));
        assert!(!valid_id("run 7fa3c1"));
        assert!(!valid_id("run_7fa;rm"));
        assert!(!valid_id("Run_x"));
        assert!(!valid_id("run_"));
        assert!(!valid_id("_x"));
        assert!(!valid_id("--help"));
    }

    #[test]
    fn iso_timestamps_become_epoch_ms() {
        assert_eq!(iso_ms("2026-01-01T00:00:00.000Z"), Some(1_767_225_600_000));
        assert_eq!(iso_ms("2026-01-01T00:00:00.250Z"), Some(1_767_225_600_250));
        assert_eq!(iso_ms("yesterday"), None);
        assert_eq!(iso_ms("1960-01-01T00:00:00.000Z"), None);
    }

    #[test]
    fn short_id_is_run_plus_six_hex() {
        assert_eq!(short_id("run_7fa3c1deadbeef"), "run_7fa3c1");
    }
}
