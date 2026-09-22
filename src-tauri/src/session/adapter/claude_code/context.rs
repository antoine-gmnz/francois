use serde_json::Value;
/// Input-side tokens of ONE API request: every token the model had to read
/// (fresh prompt + freshly cached + cache hits). `cache_creation_input_tokens`
/// counts too — those tokens are in the request, they were merely written to
/// the cache on the way in.
fn input_side(usage: &Value) -> u64 {
    let g = |k: &str| usage.get(k).and_then(|v| v.as_u64()).unwrap_or(0);
    g("input_tokens") + g("cache_creation_input_tokens") + g("cache_read_input_tokens")
}

fn output_side(usage: &Value) -> u64 {
    usage
        .get("output_tokens")
        .and_then(|v| v.as_u64())
        .unwrap_or(0)
}

/// Context size of ONE API request = what it read + what it produced.
pub fn compute_used(usage: &Value) -> u64 {
    input_side(usage) + output_side(usage)
}

/// Tracks how full the context window is over a turn.
///
/// The context after a turn is the size of the turn's **last** API request, not
/// the sum over its requests. A turn makes one request per tool round-trip and
/// each one re-reads the whole conversation, so summing them (which is exactly
/// what the CLI's terminal `result.usage` reports — a cost aggregate, subagent
/// requests included) drifts far past the window: a 20-round turn at 100K of
/// cache reads "uses" 2M of a 200K window. So: take the per-request usage the
/// stream carries and let the newest one win.
#[derive(Default)]
pub struct ContextTracker {
    /// Input side of the request currently streaming, from its `message_start`.
    input: u64,
    /// Newest complete per-request figure — the context as of now.
    pending: Option<u64>,
}

impl ContextTracker {
    /// Feed the inner `event` object of one parent-turn `stream_event` line.
    /// Subagent lines are routed away before this (async-agents FR-8), which is
    /// what keeps a subagent's own window out of the parent's figure.
    pub fn observe_stream_event(&mut self, ev: &Value) {
        match ev.get("type").and_then(|t| t.as_str()).unwrap_or("") {
            // Opens a request: carries the full input side, output still ~0.
            "message_start" => {
                if let Some(u) = ev.get("message").and_then(|m| m.get("usage")) {
                    self.input = input_side(u);
                }
            }
            // Closes it: carries the final output count for that message, and on
            // newer API versions the input side again — prefer it when present,
            // fall back to what `message_start` recorded.
            "message_delta" => {
                if let Some(u) = ev.get("usage") {
                    let input = match input_side(u) {
                        0 => self.input,
                        n => n,
                    };
                    self.pending = Some(input + output_side(u));
                }
            }
            _ => {}
        }
    }

    /// The terminal `result.usage`. It is a turn-wide aggregate, so it is only
    /// trustworthy when the turn streamed no message at all (one request, or
    /// none) — otherwise it would undo everything the stream told us.
    pub(crate) fn observe_result(&mut self, usage: &Value) {
        if self.pending.is_none() {
            self.pending = Some(compute_used(usage));
        }
    }

    /// The figure to report, clamped to the window: a context can never hold
    /// more than it can hold, so a larger number is noise, not information.
    pub(crate) fn finish(&self, limit: u64) -> Option<u64> {
        self.pending
            .map(|u| if limit > 0 { u.min(limit) } else { u })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn compute_used_sums_every_input_side_bucket_plus_output() {
        let u =
            json!({ "input_tokens": 10, "cache_read_input_tokens": 21213, "output_tokens": 47 });
        assert_eq!(compute_used(&u), 21270);
        // cache CREATION tokens are in the request too — they were merely written
        // to the cache on the way in, so they count toward the context.
        let u = json!({ "input_tokens": 10, "cache_creation_input_tokens": 1000,
            "cache_read_input_tokens": 21213, "output_tokens": 47 });
        assert_eq!(compute_used(&u), 22270);
    }

    fn delta(usage: serde_json::Value) -> Value {
        json!({ "type": "message_delta", "usage": usage })
    }

    #[test]
    fn context_tracker_reports_the_last_request_not_the_turn_total() {
        // THE BUG: a turn is many API requests and each re-reads the whole
        // conversation. Summing them blows past the window; the newest one wins.
        let mut t = ContextTracker::default();
        for cache_read in [90_000, 120_000, 150_000] {
            t.observe_stream_event(&json!({
                "type": "message_start",
                "message": { "usage": { "input_tokens": 4, "cache_read_input_tokens": cache_read } }
            }));
            t.observe_stream_event(&delta(json!({ "output_tokens": 1_000 })));
        }
        assert_eq!(t.finish(200_000), Some(151_004));
    }

    #[test]
    fn context_tracker_ignores_the_result_aggregate_once_the_stream_spoke() {
        let mut t = ContextTracker::default();
        t.observe_stream_event(&json!({
            "type": "message_start",
            "message": { "usage": { "input_tokens": 10, "cache_read_input_tokens": 40_000 } }
        }));
        t.observe_stream_event(&delta(json!({ "output_tokens": 500 })));
        // the CLI's terminal usage is a cost aggregate over every request of the
        // turn (subagents included) — it must not overwrite the real figure.
        t.observe_result(
            &json!({ "input_tokens": 200, "cache_read_input_tokens": 3_400_000,
            "output_tokens": 12_000 }),
        );
        assert_eq!(t.finish(200_000), Some(40_510));
    }

    #[test]
    fn context_tracker_falls_back_to_result_when_nothing_streamed() {
        let mut t = ContextTracker::default();
        assert_eq!(t.finish(200_000), None); // nothing seen → no event at all
        t.observe_result(&json!({ "input_tokens": 100, "output_tokens": 20 }));
        assert_eq!(t.finish(200_000), Some(120));
    }

    #[test]
    fn context_tracker_prefers_a_delta_that_carries_its_own_input_side() {
        // newer API versions repeat the input buckets on message_delta
        let mut t = ContextTracker::default();
        t.observe_stream_event(&json!({
            "type": "message_start",
            "message": { "usage": { "input_tokens": 1, "cache_read_input_tokens": 10 } }
        }));
        t.observe_stream_event(&delta(
            json!({ "input_tokens": 5, "cache_read_input_tokens": 70_000, "output_tokens": 900 }),
        ));
        assert_eq!(t.finish(1_000_000), Some(70_905));
    }

    #[test]
    fn context_tracker_clamps_to_the_window() {
        let mut t = ContextTracker::default();
        t.observe_result(&json!({ "input_tokens": 5_000_000, "output_tokens": 1 }));
        assert_eq!(t.finish(200_000), Some(200_000));
        assert_eq!(t.finish(0), Some(5_000_001)); // unknown window → no clamp
    }
}
