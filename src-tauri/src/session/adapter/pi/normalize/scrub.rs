//! session/adapter/pi/normalize/scrub.rs — pi-transcript-events FR-4 + §6:
//! bounding and sanitizing the tool input/output previews before they reach
//! either IPC or persistence. "Known secret-pattern filtering is best effort,
//! not a confidentiality guarantee" (§6), so this is about the shapes most
//! likely to appear verbatim in a Bash/Write tool's raw text — not a proof.
//!
//! MED (review round 7): both jobs used to be done the expensive way round.
//! `bound_preview` scrubbed its WHOLE input (up to a 32 MiB wire record, five
//! regexes over all of it) and only then cut it to 64 KiB, and every
//! `toolcall_delta` re-scrubbed the whole accumulated input again — quadratic
//! in the number of deltas. Both now work on a BOUNDED window:
//!   * the preview scans `PREVIEW_BYTES + SCRUB_OVERLAP_BYTES` and cuts after,
//!     so a secret straddling the cut is still matched whole and redacted
//!     before anything is thrown away;
//!   * a delta rescans only the tail of what is already accumulated plus the
//!     new chunk, so a secret split across two deltas is still matched, and
//!     the cost per delta no longer grows with the accumulated size.
//! The residual, deliberate limit: a secret longer than the overlap window
//! and split across it may survive as a fragment. §6's "best effort" covers
//! exactly that trade.

use std::borrow::Cow;
use std::sync::OnceLock;

/// FR-4: sanitized generic tool input/output previews are cut at this bound,
/// each independently, with `truncated=true` set on the cut side.
pub(crate) const PREVIEW_BYTES: usize = 64 * 1024;

/// How much beyond the preview (and behind a delta) is scanned for secrets.
/// A generous multiple of any real key/header length, so the straddling case
/// is covered, while staying a constant cost per event.
const SCRUB_OVERLAP_BYTES: usize = 4 * 1024;

/// §6 (review round 2 HIGH): compiled once, covering the shapes most likely
/// to appear verbatim in a Bash/Write tool's raw input or output (a pasted
/// API key, a `.env` assignment, a captured `Authorization` header).
static SECRET_PATTERNS: OnceLock<Vec<regex::Regex>> = OnceLock::new();

fn secret_patterns() -> &'static [regex::Regex] {
    SECRET_PATTERNS
        .get_or_init(|| {
            let sources = [
                // OpenAI/Anthropic-style secret keys: sk-…, sk-ant-api03-…
                r"sk-[A-Za-z0-9_-]{16,}",
                // GitHub tokens: ghp_/gho_/ghu_/ghs_/ghr_
                r"gh[pousr]_[A-Za-z0-9]{20,}",
                // AWS access key IDs
                r"AKIA[0-9A-Z]{16}",
                // Authorization: Bearer <token>
                r"(?i)bearer\s+[A-Za-z0-9\-_.~+/]{8,}=*",
                // .env / CLI-flag style assignments naming a secret
                r#"(?i)(?:api[_-]?key|secret|token|password)\s*[:=]\s*['"]?[A-Za-z0-9\-_./+=]{8,}['"]?"#,
            ];
            sources
                .iter()
                .filter_map(|src| regex::Regex::new(src).ok())
                .collect()
        })
        .as_slice()
}

/// §6: best-effort redaction of known secret shapes, applied before a tool
/// input/output preview is stored on `ToolState` (and so before it reaches
/// either the IPC envelope or persistence).
pub(super) fn scrub_secrets(text: &str) -> Cow<'_, str> {
    let mut current = Cow::Borrowed(text);
    for pattern in secret_patterns() {
        if pattern.is_match(&current) {
            current = Cow::Owned(pattern.replace_all(&current, "[redacted]").into_owned());
        }
    }
    current
}

/// The largest byte index `<= max` that is a char boundary of `s` (its length
/// when it already fits).
fn cut_at(s: &str, max: usize) -> usize {
    if s.len() <= max {
        return s.len();
    }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    end
}

/// The smallest byte index that keeps at most `max` trailing bytes of `s` and
/// is a char boundary (0 when `s` is already shorter).
fn tail_from(s: &str, max: usize) -> usize {
    if s.len() <= max {
        return 0;
    }
    let mut start = s.len() - max;
    while start < s.len() && !s.is_char_boundary(start) {
        start += 1;
    }
    start
}

/// FR-4: one sanitized, bounded preview and whether anything was cut.
pub(super) fn bound_preview(text: &str) -> (String, bool) {
    let window_end = cut_at(text, PREVIEW_BYTES.saturating_add(SCRUB_OVERLAP_BYTES));
    let scrubbed = scrub_secrets(&text[..window_end]);
    // Redaction can lengthen as well as shorten (a short `Bearer x…` becomes
    // `[redacted]`), so the cut is re-checked against the SCRUBBED text.
    if window_end == text.len() && scrubbed.len() <= PREVIEW_BYTES {
        return (scrubbed.into_owned(), false);
    }
    let end = cut_at(&scrubbed, PREVIEW_BYTES);
    (scrubbed[..end].to_string(), true)
}

/// Append one tool-argument delta to an already-scrubbed accumulation, in
/// constant time per call. Returns true once the accumulation has hit
/// [`PREVIEW_BYTES`] and stops growing (`ToolState.input_truncated`).
pub(super) fn append_scrubbed_delta(accumulated: &mut String, delta: &str) -> bool {
    let tail_start = tail_from(accumulated, SCRUB_OVERLAP_BYTES);
    let mut window = String::with_capacity(accumulated.len() - tail_start + delta.len());
    window.push_str(&accumulated[tail_start..]);
    window.push_str(delta);
    let scrubbed = scrub_secrets(&window);
    accumulated.truncate(tail_start);
    accumulated.push_str(&scrubbed);
    if accumulated.len() > PREVIEW_BYTES {
        let end = cut_at(accumulated, PREVIEW_BYTES);
        accumulated.truncate(end);
        return true;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_short_preview_is_scrubbed_whole_and_reports_no_truncation() {
        let (preview, truncated) = bound_preview("API_KEY=abcdefghijklmnop1234 and HOST=local");
        assert!(!truncated);
        assert!(preview.contains("[redacted]"));
        assert!(preview.contains("HOST=local"));
    }

    /// MED (review round 7): the preview is cut BEFORE the scrub now, so the
    /// scan window has to overshoot the cut — otherwise a secret straddling
    /// it is only half inside the preview, matches nothing, and its first
    /// half is published verbatim.
    #[test]
    fn a_secret_straddling_the_preview_cut_is_still_redacted_never_half_published() {
        let secret = format!("sk-{}", "A".repeat(40));
        let text = format!("{}{secret} trailing", "x".repeat(PREVIEW_BYTES - 10));
        let (preview, truncated) = bound_preview(&text);
        assert!(truncated);
        assert!(
            !preview.contains("sk-AAAAAAAA"),
            "the straddling secret leaked its head into the preview"
        );
        assert!(preview.len() <= PREVIEW_BYTES);
    }

    /// The window is what keeps the cost constant: everything past it is
    /// dropped without being scanned at all, and the result is still bounded.
    #[test]
    fn an_oversize_preview_is_bounded_without_scanning_past_the_window() {
        let text = "y".repeat(8 * 1024 * 1024);
        let (preview, truncated) = bound_preview(&text);
        assert!(truncated);
        assert_eq!(preview.len(), PREVIEW_BYTES);
    }

    #[test]
    fn a_multi_byte_character_is_never_cut_in_half() {
        let text = "\u{1f600}".repeat(PREVIEW_BYTES); // 4 bytes each
        let (preview, truncated) = bound_preview(&text);
        assert!(truncated);
        assert!(preview.len() <= PREVIEW_BYTES);
        assert!(preview.ends_with('\u{1f600}'));
    }

    /// MED (review round 7): a delta rescans only a bounded tail, so the
    /// per-delta cost stops growing with the accumulated input — but a secret
    /// split ACROSS two deltas must still be caught, which is exactly what
    /// the tail is for.
    #[test]
    fn a_secret_split_across_two_deltas_is_redacted_by_the_rescanned_tail() {
        let mut acc = String::new();
        assert!(!append_scrubbed_delta(&mut acc, "export API_KEY=abcdefg"));
        // Nothing matches yet: the assignment is one character short.
        assert!(acc.contains("abcdefg"));
        assert!(!append_scrubbed_delta(&mut acc, "hijklmnop"));
        assert!(
            !acc.contains("abcdefghijklmnop"),
            "the completed secret survived the delta boundary: {acc}"
        );
        assert!(acc.contains("[redacted]"));
    }

    #[test]
    fn appending_deltas_preserves_everything_outside_the_rescanned_tail_byte_for_byte() {
        let mut acc = String::new();
        let head = "head-".repeat(4 * 1024); // far behind the rescan window
        append_scrubbed_delta(&mut acc, &head);
        append_scrubbed_delta(&mut acc, "tail");
        assert_eq!(acc, format!("{head}tail"));
    }

    #[test]
    fn appending_deltas_stops_at_the_preview_bound_and_reports_it() {
        let mut acc = String::new();
        let mut truncated = false;
        for _ in 0..40 {
            truncated |= append_scrubbed_delta(&mut acc, &"z".repeat(8 * 1024));
        }
        assert!(truncated);
        assert_eq!(acc.len(), PREVIEW_BYTES);
    }
}
