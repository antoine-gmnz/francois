//! Stream signals that are neither transcript nor control: the per-run cost on
//! a `result` line (audit C2), the CLI's retry / compaction progress lines
//! (audit C4), and the diagnostics trace for line kinds this parser does not
//! know (audit R2).

use crate::session::application::RuntimeEvent;
use crate::session::events::ModelUsageMetrics;
use serde_json::Value;
use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

/// Top-level `type`s the reader dispatches on (`parse_frames`' match).
const HANDLED_TYPES: &[&str] = &[
    "system",
    "stream_event",
    "user",
    "assistant",
    "result",
    "control_request",
    "control_cancel_request",
];

/// Top-level `type`s that are KNOWN and deliberately ignored — so they are not
/// reported as unknown. Derived from the captured fixtures (`fixtures/*.ndjson`)
/// plus the CLI's heartbeat; `every_line_kind_in_the_captured_fixtures_is_known`
/// fails when a new capture brings a kind that is in neither list.
/// - `keep_alive`: heartbeat, no content (FR-4).
/// - `rate_limit_event`, `control_response`: seen in the captures, not used by
///   the turn parser.
const IGNORED_TYPES: &[&str] = &["keep_alive", "rate_limit_event", "control_response"];

/// `system` subtypes with a handler: `init` (lines.rs), `background_tasks_changed`
/// (lines.rs), `task_started`/`task_notification` (agent_tasks.rs), and the two
/// C4 progress lines below.
const HANDLED_SYSTEM_SUBTYPES: &[&str] = &[
    "init",
    "background_tasks_changed",
    "task_started",
    "task_notification",
    "api_retry",
    "compact_boundary",
];

/// `system` subtypes KNOWN and deliberately ignored — every one seen in the
/// captured fixtures that no handler reads.
const IGNORED_SYSTEM_SUBTYPES: &[&str] = &[
    "status",
    "thinking_tokens",
    "hook_started",
    "hook_response",
    "task_progress",
    "task_updated",
];

/// A reported name is CLI-supplied text: cap it and keep it to a safe charset
/// before it reaches a log line.
pub(crate) const MAX_KIND_LEN: usize = 64;

/// Also used by the Codex / Grok translators (audit R2) for their own method
/// and event names, which is why `/` survives (`item/started`).
pub(crate) fn sanitise(raw: &str) -> String {
    raw.chars()
        .take(MAX_KIND_LEN)
        .map(|c| {
            if c.is_ascii_alphanumeric() || "_-./".contains(c) {
                c
            } else {
                '?'
            }
        })
        .collect()
}

/// audit R2: the name of a line kind this parser neither handles nor
/// deliberately ignores — `<type>`, or `system/<subtype>`. Never the payload.
pub(crate) fn unrecognised_kind(v: &Value) -> Option<String> {
    let line_type = v.get("type").and_then(Value::as_str).unwrap_or("");
    if line_type == "system" {
        let subtype = v.get("subtype").and_then(Value::as_str).unwrap_or("");
        let known = HANDLED_SYSTEM_SUBTYPES.contains(&subtype)
            || IGNORED_SYSTEM_SUBTYPES.contains(&subtype);
        return (!known).then(|| format!("system/{}", sanitise(subtype)));
    }
    let known = HANDLED_TYPES.contains(&line_type) || IGNORED_TYPES.contains(&line_type);
    (!known).then(|| sanitise(line_type))
}

/// The dedupe set is bounded: names are capped, but how many DISTINCT names
/// arrive is the CLI's choice. Past the cap nothing new is recorded or logged.
pub(crate) const MAX_SEEN_KINDS: usize = 256;

/// Whether `kind` is new to `seen` (and records it). Poison-tolerant: this
/// runs on the stream reader thread, and a diagnostics set must never be the
/// thing that panics it.
pub(crate) fn first_sighting(seen: &Mutex<HashSet<String>>, kind: &str) -> bool {
    let mut seen = seen.lock().unwrap_or_else(|p| p.into_inner());
    seen.len() < MAX_SEEN_KINDS && seen.insert(kind.to_string())
}

/// Production side of `StreamEnvironment::unrecognised`: one line in
/// `<app_data>/stream.log` per (runtime, kind), once per process.
pub(crate) fn log_unrecognised_once(runtime: &str, kind: &str) {
    static SEEN: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    let key = format!("{runtime}:{kind}");
    if first_sighting(SEEN.get_or_init(Default::default), &key) {
        crate::diagnostics::append_app_log(
            "stream.log",
            &format!("{runtime}: unrecognised stream line kind `{kind}` (ignored)"),
        );
    }
}

/// audit C2: the thread cost a `result` line reports.
///
/// Measured (CLI 2.1.331, haiku): `total_cost_usd` is the THREAD's running
/// total, carried across processes. In one held-open process two results read
/// 0.0079283 → 0.0120036; across `--resume` processes on one thread they read
/// 0.0003985 → 0.00447464 → 0.00490107 → 0.00532826, the last two with near
/// identical usage — a running total, not the run's own cost. So the figure
/// REPLACES the session's cost (projection), never adds to it.
/// Missing / non-numeric / negative / non-finite ⇒ nothing.
pub(crate) fn thread_cost_total(v: &Value) -> Option<f64> {
    v.get("total_cost_usd")
        .and_then(Value::as_f64)
        .filter(|t| t.is_finite() && *t >= 0.0)
}

/// audit C4: `system` `api_retry` / `compact_boundary` → runtime progress.
/// Field names read off the CLI 2.1.332 bundle's emitters: `api_retry` carries
/// `attempt`, `max_retries`, `retry_delay_ms`, `error_status` (HTTP status or
/// null) and `error` (a category: `rate_limit`, `overloaded`, `server_error`,
/// …); `compact_boundary` carries `compact_metadata.{trigger: manual|auto,
/// pre_tokens, post_tokens?}`. No capture holds either line yet, so every
/// field stays optional.
pub(crate) fn parse_system_progress(v: &Value) -> Option<RuntimeEvent> {
    let u32_at = |key: &str| {
        v.get(key)
            .and_then(Value::as_u64)
            .and_then(|n| u32::try_from(n).ok())
    };
    match v.get("subtype").and_then(Value::as_str)? {
        "api_retry" => Some(RuntimeEvent::Retry {
            // emitted when a retry is SCHEDULED: the CLI is now waiting out the delay
            state: "waiting".into(),
            attempt: u32_at("attempt").unwrap_or(1),
            delay_ms: v.get("retry_delay_ms").and_then(Value::as_u64),
            max_retries: u32_at("max_retries").filter(|n| *n > 0),
            error_status: v
                .get("error_status")
                .and_then(Value::as_u64)
                .and_then(|n| u16::try_from(n).ok()),
            error: v
                .get("error")
                .and_then(Value::as_str)
                .filter(|e| !e.is_empty())
                .map(sanitise),
        }),
        // emitted once the compaction is done (it marks the boundary)
        "compact_boundary" => Some(RuntimeEvent::Compaction {
            state: "completed".into(),
            automatic: v
                .pointer("/compact_metadata/trigger")
                .and_then(Value::as_str)
                == Some("auto"),
            message: None,
            pre_tokens: v
                .pointer("/compact_metadata/pre_tokens")
                .and_then(Value::as_u64),
            boundary_id: v
                .get("uuid")
                .and_then(Value::as_str)
                .filter(|u| !u.is_empty())
                .map(sanitise),
        }),
        _ => None,
    }
}

/// Past this many models a `modelUsage` map is truncated — the CLI decides how
/// many keys arrive, and each one becomes a persisted row.
pub(crate) const MAX_USAGE_MODELS: usize = 16;

/// audit C2: a `result` line's `modelUsage` map → one entry per model, sorted
/// by name so the persisted vector (and the golden file) is deterministic.
///
/// Semantics (the CLI 2.1.332 SDK schema's own description of `modelUsage`):
/// per-model totals sharing `total_cost_usd`'s lifecycle — cumulative across
/// turns, a resumed session continues from the totals its transcript saved,
/// `/clear` resets them, and a crash/startup-error result may carry zeroes. So
/// the projection replaces each model's entry under the same max guard as the
/// cost; in the capture the single model's `costUSD` equals `total_cost_usd`.
/// Absent / not an object / empty ⇒ nothing.
pub(crate) fn thread_model_usage(v: &Value) -> Option<Vec<ModelUsageMetrics>> {
    let map = v.get("modelUsage")?.as_object()?;
    let count = |entry: &Value, key: &str| entry.get(key).and_then(Value::as_u64);
    let mut models: Vec<ModelUsageMetrics> = map
        .iter()
        .filter(|(name, entry)| !name.is_empty() && entry.is_object())
        .map(|(name, entry)| ModelUsageMetrics {
            model: sanitise(name),
            input_tokens: count(entry, "inputTokens"),
            output_tokens: count(entry, "outputTokens"),
            cache_read_tokens: count(entry, "cacheReadInputTokens"),
            cache_write_tokens: count(entry, "cacheCreationInputTokens"),
            cost_usd: entry
                .get("costUSD")
                .and_then(Value::as_f64)
                .filter(|c| c.is_finite() && *c >= 0.0),
            context_window: count(entry, "contextWindow").filter(|w| *w > 0),
        })
        .collect();
    models.sort_by(|a, b| a.model.cmp(&b.model));
    models.truncate(MAX_USAGE_MODELS);
    (!models.is_empty()).then_some(models)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc::AppError;
    use crate::session::application::RuntimeEvent;
    use crate::session::stream::{StreamEnvironment, StreamSettings};
    use serde_json::{json, Value};
    use std::collections::{HashMap, HashSet};
    use std::sync::atomic::AtomicBool;
    use std::sync::{Arc, Mutex};

    /// A test double that captures what the parser publishes and what it
    /// reports as unrecognised — no engine, no filesystem, no global state.
    #[derive(Default)]
    struct Recorder {
        events: Mutex<Vec<RuntimeEvent>>,
        unrecognised: Mutex<Vec<String>>,
    }
    impl StreamEnvironment for Recorder {
        fn settings(&self, _: &str) -> StreamSettings {
            StreamSettings::default()
        }
        fn publish(&self, event: RuntimeEvent) {
            self.events.lock().unwrap().push(event);
        }
        fn unrecognised(&self, kind: &str) {
            self.unrecognised.lock().unwrap().push(kind.into());
        }
    }

    fn replay(lines: &[Value]) -> Recorder {
        let env = Recorder::default();
        let mut frames = lines.iter().map(Value::to_string);
        super::super::parse_frames(
            &env,
            "s1",
            || Ok::<_, AppError>(frames.next()),
            &Arc::new(Mutex::new(None)),
            &Arc::new(Mutex::new(HashMap::new())),
            &Arc::new(Mutex::new(HashMap::new())),
            &Arc::new(AtomicBool::new(false)),
            None,
        );
        env
    }

    fn costs(env: &Recorder) -> Vec<f64> {
        env.events
            .lock()
            .unwrap()
            .iter()
            .filter_map(|e| match e {
                RuntimeEvent::CostReported { thread_total_usd } => Some(*thread_total_usd),
                _ => None,
            })
            .collect()
    }

    // ---------- R2: unknown line kinds ----------

    #[test]
    fn an_unknown_top_level_type_and_system_subtype_are_reported_by_name_only() {
        let env = replay(&[
            json!({ "type": "brand_new_event", "secret": "user text" }),
            json!({ "type": "system", "subtype": "brand_new_subtype", "prompt": "user text" }),
        ]);
        assert_eq!(
            *env.unrecognised.lock().unwrap(),
            vec![
                "brand_new_event".to_string(),
                "system/brand_new_subtype".into()
            ]
        );
    }

    #[test]
    fn every_line_kind_in_the_captured_fixtures_is_known() {
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/src/session/stream/fixtures");
        let mut unknown = Vec::new();
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().and_then(|e| e.to_str()) != Some("ndjson") {
                continue;
            }
            for line in std::fs::read_to_string(&path).unwrap().lines() {
                if let Ok(v) = serde_json::from_str::<Value>(line) {
                    unknown.extend(unrecognised_kind(&v));
                }
            }
        }
        assert_eq!(unknown, Vec::<String>::new());
    }

    #[test]
    fn the_deliberately_ignored_kinds_and_c4_subtypes_are_not_unknown() {
        for v in [
            json!({ "type": "keep_alive" }),
            json!({ "type": "rate_limit_event" }),
            json!({ "type": "control_response" }),
            json!({ "type": "system", "subtype": "status" }),
            json!({ "type": "system", "subtype": "api_retry" }),
            json!({ "type": "system", "subtype": "compact_boundary" }),
            json!({ "type": "system", "subtype": "background_tasks_changed" }),
        ] {
            assert_eq!(unrecognised_kind(&v), None, "{v}");
        }
    }

    #[test]
    fn a_reported_name_is_sanitised_and_capped() {
        let v = json!({ "type": format!("bad\nname {}", "x".repeat(200)) });
        let name = unrecognised_kind(&v).unwrap();
        assert!(name.len() <= MAX_KIND_LEN);
        assert!(name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "_-./?".contains(c)));
    }

    #[test]
    fn a_kind_is_logged_once_per_set() {
        let seen = Mutex::new(HashSet::new());
        assert!(first_sighting(&seen, "x"));
        assert!(!first_sighting(&seen, "x"));
        assert!(first_sighting(&seen, "y"));
    }

    // ---------- C2: cost ----------

    #[test]
    fn a_result_lines_total_cost_is_reported_as_the_thread_total() {
        let env = replay(&[json!({ "type": "result", "subtype": "success",
            "total_cost_usd": 0.1269474, "result": "ok" })]);
        assert_eq!(costs(&env), vec![0.1269474]);
    }

    #[test]
    fn a_held_open_process_reports_each_cumulative_total_as_is() {
        let env = replay(&[
            json!({ "type": "result", "subtype": "success", "total_cost_usd": 0.0079283 }),
            json!({ "type": "result", "subtype": "success", "total_cost_usd": 0.0120036 }),
        ]);
        assert_eq!(costs(&env), vec![0.0079283, 0.0120036]);
    }

    #[test]
    fn a_result_without_a_usable_cost_reports_nothing() {
        let env = replay(&[
            json!({ "type": "result", "subtype": "success" }),
            json!({ "type": "result", "subtype": "success", "total_cost_usd": -1.0 }),
            json!({ "type": "result", "subtype": "success", "total_cost_usd": "0.3" }),
        ]);
        assert_eq!(costs(&env), Vec::<f64>::new());
    }

    // ---------- C4: retry / compaction ----------
    // Synthetic lines: the shapes come from the Claude Code / Agent SDK docs
    // (`SDKAPIRetryMessage`, `SDKCompactBoundaryMessage`), not from a capture.

    #[test]
    fn api_retry_maps_to_a_waiting_retry_event() {
        let env = replay(&[json!({ "type": "system", "subtype": "api_retry",
            "attempt": 2, "max_retries": 10, "retry_delay_ms": 1500, "error": "overloaded" })]);
        let events = env.events.lock().unwrap();
        assert!(
            events.iter().any(|e| matches!(e,
            RuntimeEvent::Retry { state, attempt: 2, delay_ms: Some(1500), max_retries: Some(10), .. } if state == "waiting"))
        );
    }

    #[test]
    fn api_retry_with_no_fields_still_maps_with_defaults() {
        let event = parse_system_progress(&json!({ "type": "system", "subtype": "api_retry" }));
        assert!(matches!(
            event,
            Some(RuntimeEvent::Retry {
                attempt: 1,
                delay_ms: None,
                ..
            })
        ));
    }

    #[test]
    fn compact_boundary_maps_to_a_completed_compaction() {
        let auto = parse_system_progress(&json!({ "type": "system", "subtype": "compact_boundary",
            "compact_metadata": { "trigger": "auto", "pre_tokens": 150000 } }));
        assert!(matches!(auto,
            Some(RuntimeEvent::Compaction { ref state, automatic: true, message: None, pre_tokens: Some(150000), boundary_id: None }) if state == "completed"));
        let manual =
            parse_system_progress(&json!({ "type": "system", "subtype": "compact_boundary" }));
        assert!(matches!(
            manual,
            Some(RuntimeEvent::Compaction {
                automatic: false,
                ..
            })
        ));
    }
    #[test]
    fn api_retry_carries_the_cli_error_status_and_category() {
        let event = parse_system_progress(&json!({ "type": "system", "subtype": "api_retry",
            "attempt": 3, "max_retries": 10, "retry_delay_ms": 4000,
            "error_status": 429, "error": "rate_limit" }));
        let Some(RuntimeEvent::Retry {
            attempt,
            max_retries,
            error_status,
            error,
            ..
        }) = event
        else {
            panic!("api_retry did not map to a retry");
        };
        assert_eq!(
            (attempt, max_retries, error_status, error.as_deref()),
            (3, Some(10), Some(429), Some("rate_limit"))
        );
        // `error_status: null` (a connection error) is simply absent
        let event = parse_system_progress(&json!({ "type": "system", "subtype": "api_retry",
            "attempt": 1, "error_status": null, "error": "unknown" }));
        assert!(matches!(
            event,
            Some(RuntimeEvent::Retry {
                error_status: None,
                max_retries: None,
                ..
            })
        ));
    }

    // ---------- C2: modelUsage ----------

    fn fixture_result_line() -> Value {
        let text = include_str!("fixtures/turn.ndjson");
        let line = text
            .lines()
            .rev()
            .find(|l| l.contains("\"type\":\"result\""))
            .unwrap();
        serde_json::from_str(line).unwrap()
    }

    #[test]
    fn the_captured_result_lines_model_usage_maps_per_model() {
        let models = thread_model_usage(&fixture_result_line()).unwrap();
        assert_eq!(
            models,
            vec![ModelUsageMetrics {
                model: "claude-sonnet-5".into(),
                input_tokens: Some(14),
                output_tokens: Some(1005),
                cache_read_tokens: Some(246_808),
                cache_write_tokens: Some(6298),
                cost_usd: Some(0.1269474),
                context_window: Some(1_000_000),
            }]
        );
    }

    #[test]
    fn model_usage_is_sorted_capped_and_tolerates_bad_entries() {
        let mut map = serde_json::Map::new();
        for i in (0..20).rev() {
            map.insert(
                format!("m{i:02}"),
                json!({ "inputTokens": i, "costUSD": -1.0 }),
            );
        }
        map.insert("broken".into(), json!("not an object"));
        let models = thread_model_usage(&json!({ "type": "result", "modelUsage": map })).unwrap();
        assert_eq!(models.len(), MAX_USAGE_MODELS);
        assert_eq!(models[0].model, "m00");
        assert_eq!(models[0].cost_usd, None); // a negative cost is unknown, not zero
        assert_eq!(thread_model_usage(&json!({ "type": "result" })), None);
        assert_eq!(
            thread_model_usage(&json!({ "type": "result", "modelUsage": {} })),
            None
        );
    }

    #[test]
    fn a_result_line_publishes_its_model_usage() {
        let env = replay(&[fixture_result_line()]);
        let events = env.events.lock().unwrap();
        assert!(events.iter().any(|e| matches!(e,
            RuntimeEvent::ModelUsageReported { models } if models.len() == 1)));
    }
}
