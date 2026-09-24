//! github-ci-logs: `github_get_step_log` — sanitizing a raw Actions job log,
//! classifying GitHub's `##[kind]` workflow-command markers, segmenting by
//! step (each timestamped line goes to the step with the greatest
//! `startedAt <= timestamp`), capping to the last 5,000 lines, and caching
//! the last 8 parsed job logs (LRU, keyed by `owner/name#jobId`) so opening
//! sibling steps of the same job never re-downloads.

use super::actions::do_get_job;
use super::gh::{require_gh, run_routed_bounded};
use super::{
    parse_rfc3339_ms, remote_owner_name_host, resolve_scope, LogLine, LogLineKind, StepLog,
};
use crate::diff::GitHost;
use crate::ipc::{AppError, ErrorCode};
use regex::Regex;
use serde_json::json;
use std::collections::VecDeque;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

const LOG_TIMEOUT: Duration = Duration::from_secs(30);
const LOG_CAP_BYTES: usize = 32 * 1024 * 1024;
const LINES_CAP: usize = 5_000;
const CACHE_CAP: usize = 8;

// ---------- sanitize ----------

static ANSI_RE: OnceLock<Regex> = OnceLock::new();

/// CSI (`\x1b[...<letter>`), OSC (`\x1b]...BEL|ST`) and single-char escapes.
fn ansi_re() -> &'static Regex {
    ANSI_RE.get_or_init(|| {
        Regex::new(r"\x1b(\[[0-9;?]*[a-zA-Z]|\][^\x07\x1b]*(\x07|\x1b\\)|[@-_])").unwrap()
    })
}

/// Strips ANSI/VT escapes and C0 controls (tab kept), truncates at 2,000
/// chars with `…` (decision 2026-08-04 security).
pub(crate) fn sanitize_text(raw: &str) -> String {
    let no_ansi = ansi_re().replace_all(raw, "");
    let mut out: String = no_ansi
        .chars()
        .filter(|c| *c == '\t' || (*c >= ' ' && *c != '\u{7f}'))
        .collect();
    if out.chars().count() > 2000 {
        out = out.chars().take(2000).collect::<String>();
        out.push('…');
    }
    out
}

/// Splits a leading RFC3339 timestamp token off a raw log line, returning
/// (epoch seconds floored, remainder). No parseable leading timestamp ->
/// `(None, line)` — the whole line is content.
fn split_timestamp(line: &str) -> (Option<i64>, &str) {
    if let Some(sp) = line.find(' ') {
        let (ts_part, rest) = line.split_at(sp);
        if let Some(ms) = parse_rfc3339_ms(ts_part) {
            return (Some(ms.div_euclid(1000)), &rest[1..]);
        }
    }
    (None, line)
}

pub(crate) struct RawLine {
    /// epoch seconds, floored — `None` when the line carries no timestamp
    /// (follows the previous line's step, per the core segmentation rule).
    pub(crate) ts: Option<i64>,
    pub(crate) text: String,
}

/// Raw job log text -> one `RawLine` per non-empty line, sanitized and with
/// its leading timestamp stripped and parsed.
pub(crate) fn parse_raw_lines(raw: &str) -> Vec<RawLine> {
    raw.split('\n')
        .map(|l| l.trim_end_matches('\r'))
        .filter(|l| !l.is_empty())
        .map(|l| {
            let (ts, rest) = split_timestamp(l);
            RawLine {
                ts,
                text: sanitize_text(rest),
            }
        })
        .collect()
}

// ---------- kind classification ----------

/// `##[kind]` markers -> `LogLineKind` (marker stripped from the text);
/// a bare `::error…` workflow-command annotation (not converted to a
/// `##[error]` marker by the runner) is also classified `Error`, text kept
/// as-is.
pub(crate) fn classify_kind(content: &str) -> (LogLineKind, String) {
    for (prefix, kind) in [
        ("##[error]", LogLineKind::Error),
        ("##[warning]", LogLineKind::Warning),
        ("##[notice]", LogLineKind::Notice),
        ("##[debug]", LogLineKind::Debug),
        ("##[command]", LogLineKind::Command),
        ("##[group]", LogLineKind::GroupStart),
    ] {
        if let Some(rest) = content.strip_prefix(prefix) {
            return (kind, rest.to_string());
        }
    }
    if content.starts_with("##[endgroup]") {
        return (LogLineKind::GroupEnd, String::new());
    }
    if content.starts_with("::error") {
        return (LogLineKind::Error, content.to_string());
    }
    (LogLineKind::Plain, content.to_string())
}

// ---------- segmentation ----------

/// Assigns each line to a step number. `steps` is `(number, startedAtSecs)`;
/// need not be sorted. A line with a timestamp before every step's start (or
/// no step timings at all) falls back to the earliest step, so job-setup
/// output still lands somewhere rather than being dropped.
fn assign_steps<'a>(lines: &'a [RawLine], steps: &[(u32, i64)]) -> Vec<(u32, &'a RawLine)> {
    if steps.is_empty() {
        return lines.iter().map(|l| (0u32, l)).collect();
    }
    let mut sorted = steps.to_vec();
    sorted.sort_by_key(|(_, t)| *t);
    let mut current = sorted[0].0;
    let mut out = Vec::with_capacity(lines.len());
    for line in lines {
        if let Some(ts) = line.ts {
            if let Some(&(n, _)) = sorted.iter().rev().find(|(_, t)| *t <= ts) {
                current = n;
            }
        }
        out.push((current, line));
    }
    out
}

fn build_step_log(job_id: u64, requested_step: u32, assigned: &[(u32, &RawLine)]) -> StepLog {
    let mut lines: Vec<LogLine> = Vec::new();
    let mut first_error_line: Option<u32> = None;
    let mut n: u32 = 0;
    for (step, line) in assigned.iter().filter(|(s, _)| *s == requested_step) {
        let _ = step;
        n += 1;
        let (kind, text) = classify_kind(&line.text);
        if kind == LogLineKind::Error && first_error_line.is_none() {
            first_error_line = Some(n);
        }
        lines.push(LogLine { n, text, kind });
    }
    let total_lines = lines.len() as u32;
    let capped = if lines.len() > LINES_CAP {
        lines.split_off(lines.len() - LINES_CAP)
    } else {
        lines
    };
    let dropped_lines = total_lines - capped.len() as u32;
    StepLog {
        job_id,
        step_number: requested_step,
        lines: capped,
        total_lines,
        dropped_lines,
        first_error_line,
    }
}

/// The whole segmentation + cap + fallback pipeline (core rules,
/// specs/github-ci-logs.md §5): no step timings, or the requested segment is
/// empty while the log is not -> falls back to `stepNumber: 0`, the whole job.
pub(crate) fn compute_step_log(
    job_id: u64,
    requested_step: u32,
    lines: &[RawLine],
    steps: &[(u32, i64)],
) -> StepLog {
    if lines.is_empty() {
        return StepLog {
            job_id,
            step_number: requested_step,
            lines: Vec::new(),
            total_lines: 0,
            dropped_lines: 0,
            first_error_line: None,
        };
    }
    if steps.is_empty() {
        let whole: Vec<(u32, &RawLine)> = lines.iter().map(|l| (0u32, l)).collect();
        return build_step_log(job_id, 0, &whole);
    }
    let assigned = assign_steps(lines, steps);
    let result = build_step_log(job_id, requested_step, &assigned);
    if result.total_lines == 0 && requested_step != 0 {
        let whole: Vec<(u32, &RawLine)> = lines.iter().map(|l| (0u32, l)).collect();
        return build_step_log(job_id, 0, &whole);
    }
    result
}

// ---------- cache ----------

struct CachedJobLog {
    lines: Vec<RawLine>,
}

static LOG_CACHE: OnceLock<Mutex<VecDeque<(String, Arc<CachedJobLog>)>>> = OnceLock::new();

fn cache_get(key: &str) -> Option<Arc<CachedJobLog>> {
    let cache = LOG_CACHE.get_or_init(|| Mutex::new(VecDeque::new()));
    let mut guard = cache.lock().unwrap();
    let pos = guard.iter().position(|(k, _)| k == key)?;
    let entry = guard.remove(pos).unwrap();
    guard.push_front(entry.clone());
    Some(entry.1)
}

fn cache_put(key: String, value: Arc<CachedJobLog>) {
    let cache = LOG_CACHE.get_or_init(|| Mutex::new(VecDeque::new()));
    let mut guard = cache.lock().unwrap();
    guard.retain(|(k, _)| k != &key);
    guard.push_front((key, value));
    while guard.len() > CACHE_CAP {
        guard.pop_back();
    }
}

// ---------- I/O ----------

fn fetch_raw_log(
    host: &GitHost,
    root: &str,
    owner: &str,
    name: &str,
    job_id: u64,
) -> Result<String, AppError> {
    let path = format!("repos/{owner}/{name}/actions/jobs/{job_id}/logs");
    let run = run_routed_bounded(
        "gh",
        host,
        root,
        &["api", &path],
        LOG_TIMEOUT,
        LOG_CAP_BYTES,
    );
    if run.capped {
        return Err(AppError::with_detail(
            ErrorCode::GhLogTooLarge,
            "log too large to show (> 32 MiB)",
            json!({ "capBytes": LOG_CAP_BYTES }),
        ));
    }
    if run.spawn_failed || run.timed_out || run.code != 0 {
        if run.stderr.contains("HTTP 404") || run.stderr.contains("HTTP 410") {
            return Err(AppError::new(
                ErrorCode::GhLogGone,
                "GitHub no longer keeps this log",
            ));
        }
        return Err(AppError::with_detail(
            ErrorCode::GhFailed,
            if run.stderr.is_empty() {
                "gh exited with an error".to_string()
            } else {
                run.stderr.clone()
            },
            json!({ "code": run.code, "stderr": run.stderr }),
        ));
    }
    Ok(String::from_utf8_lossy(&run.stdout).into_owned())
}

pub(crate) fn do_get_step_log(
    cwd: &str,
    job_id: u64,
    step_number: u32,
) -> Result<StepLog, AppError> {
    if job_id == 0 {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "jobId must be positive",
        ));
    }
    let (host, root, remote_host) = resolve_scope(cwd)?;
    require_gh(&host, &root, remote_host.as_deref())?;
    let Some((owner, name, _)) = remote_owner_name_host(&host, &root) else {
        return Err(AppError::new(
            ErrorCode::GhUnavailable,
            "could not resolve the GitHub remote",
        ));
    };

    let job = do_get_job(cwd, job_id)?;
    if !job.completed {
        return Err(AppError::new(
            ErrorCode::GhLogNotReady,
            "log available when the job finishes",
        ));
    }
    if step_number != 0 && !job.steps.iter().any(|s| s.number == step_number) {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "stepNumber is not a step of this job",
        ));
    }

    let cache_key = format!("{owner}/{name}#{job_id}");
    let cached = match cache_get(&cache_key) {
        Some(c) => c,
        None => {
            let raw = fetch_raw_log(&host, &root, &owner, &name, job_id)?;
            let parsed = Arc::new(CachedJobLog {
                lines: parse_raw_lines(&raw),
            });
            cache_put(cache_key, parsed.clone());
            parsed
        }
    };

    let steps: Vec<(u32, i64)> = job
        .steps
        .iter()
        .filter_map(|s| s.started_at.map(|t| (s.number, t.div_euclid(1000))))
        .collect();
    Ok(compute_step_log(job_id, step_number, &cached.lines, &steps))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(ts: Option<i64>, text: &str) -> RawLine {
        RawLine {
            ts,
            text: text.to_string(),
        }
    }

    #[test]
    fn sanitize_strips_ansi_and_control_chars_and_keeps_tabs() {
        let s = sanitize_text("\x1b[31mred\x1b[0m\ttab\x07bell");
        assert_eq!(s, "red\ttabbell");
    }

    #[test]
    fn sanitize_truncates_at_2000_chars() {
        let long = "a".repeat(2500);
        let s = sanitize_text(&long);
        assert_eq!(s.chars().count(), 2001);
        assert!(s.ends_with('…'));
    }

    #[test]
    fn split_timestamp_parses_a_leading_rfc3339_stamp() {
        let (ts, rest) = split_timestamp("2024-03-05T12:34:56.1234567Z Run actions/checkout@v4");
        assert!(ts.is_some());
        assert_eq!(rest, "Run actions/checkout@v4");
    }

    #[test]
    fn split_timestamp_leaves_an_untimestamped_line_whole() {
        let (ts, rest) = split_timestamp("no timestamp here");
        assert_eq!(ts, None);
        assert_eq!(rest, "no timestamp here");
    }

    #[test]
    fn classify_kind_maps_workflow_command_markers() {
        assert_eq!(
            classify_kind("##[error]boom"),
            (LogLineKind::Error, "boom".to_string())
        );
        assert_eq!(
            classify_kind("##[warning]careful"),
            (LogLineKind::Warning, "careful".to_string())
        );
        assert_eq!(
            classify_kind("##[group]Run tests"),
            (LogLineKind::GroupStart, "Run tests".to_string())
        );
        assert_eq!(
            classify_kind("##[endgroup]"),
            (LogLineKind::GroupEnd, String::new())
        );
        assert_eq!(
            classify_kind("##[debug]verbose"),
            (LogLineKind::Debug, "verbose".to_string())
        );
        assert_eq!(
            classify_kind("::error file=a.ts::bad"),
            (LogLineKind::Error, "::error file=a.ts::bad".to_string())
        );
        assert_eq!(
            classify_kind("plain output"),
            (LogLineKind::Plain, "plain output".to_string())
        );
    }

    #[test]
    fn segments_lines_by_the_greatest_step_start_not_after_the_timestamp() {
        let lines = vec![
            raw(Some(100), "setup"),
            raw(Some(110), "checkout begins"),
            raw(None, "checkout continues"),
            raw(Some(200), "tests begin"),
            raw(Some(205), "tests fail"),
        ];
        let steps = vec![(1u32, 110i64), (2u32, 200i64)];
        let assigned = assign_steps(&lines, &steps);
        assert_eq!(assigned[0].0, 1); // before any step -> earliest step
        assert_eq!(assigned[1].0, 1);
        assert_eq!(assigned[2].0, 1); // untimestamped -> follows previous
        assert_eq!(assigned[3].0, 2);
        assert_eq!(assigned[4].0, 2);
    }

    #[test]
    fn compute_step_log_reports_the_first_error_line_and_totals() {
        let lines = vec![
            raw(Some(1), "plain"),
            raw(Some(1), "##[error]it broke"),
            raw(Some(1), "more output"),
        ];
        let steps = vec![(1u32, 1i64)];
        let log = compute_step_log(42, 1, &lines, &steps);
        assert_eq!(log.total_lines, 3);
        assert_eq!(log.dropped_lines, 0);
        assert_eq!(log.first_error_line, Some(2));
        assert_eq!(log.lines[1].kind, LogLineKind::Error);
        assert_eq!(log.lines[1].text, "it broke");
    }

    #[test]
    fn compute_step_log_caps_to_the_last_5000_lines_and_keeps_n_stable() {
        let lines: Vec<RawLine> = (1..=5100)
            .map(|i| raw(Some(1), &format!("line {i}")))
            .collect();
        let steps = vec![(1u32, 1i64)];
        let log = compute_step_log(1, 1, &lines, &steps);
        assert_eq!(log.total_lines, 5100);
        assert_eq!(log.dropped_lines, 100);
        assert_eq!(log.lines.len(), 5000);
        assert_eq!(log.lines[0].n, 101); // the LAST 5000 -> numbering starts at 101
        assert_eq!(log.lines.last().unwrap().n, 5100);
    }

    #[test]
    fn compute_step_log_falls_back_to_the_whole_job_when_there_are_no_step_timings() {
        let lines = vec![raw(None, "only line")];
        let log = compute_step_log(1, 3, &lines, &[]);
        assert_eq!(log.step_number, 0);
        assert_eq!(log.total_lines, 1);
    }

    #[test]
    fn compute_step_log_falls_back_when_the_requested_segment_is_empty_but_the_log_is_not() {
        let lines = vec![raw(Some(1), "setup only")];
        let steps = vec![(1u32, 1i64), (2u32, 50i64)];
        // requesting step 2, which has no lines assigned to it
        let log = compute_step_log(1, 2, &lines, &steps);
        assert_eq!(log.step_number, 0);
        assert_eq!(log.total_lines, 1);
    }

    #[test]
    fn compute_step_log_on_an_empty_log_returns_an_empty_result_without_a_fallback_loop() {
        let log = compute_step_log(1, 0, &[], &[]);
        assert_eq!(log.total_lines, 0);
        assert_eq!(log.lines.len(), 0);
    }

    #[test]
    fn cache_put_then_get_round_trips_and_evicts_past_capacity() {
        for i in 0..(CACHE_CAP + 2) {
            cache_put(
                format!("test-key-{i}"),
                Arc::new(CachedJobLog { lines: vec![] }),
            );
        }
        // the earliest keys were evicted
        assert!(cache_get("test-key-0").is_none());
        // the most recent ones are still present
        assert!(cache_get(&format!("test-key-{}", CACHE_CAP + 1)).is_some());
    }
}
