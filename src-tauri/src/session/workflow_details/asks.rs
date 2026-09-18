//! FR-20..FR-24: which run (and which agent) a parked ask belongs to, and the
//! bookkeeping of the attributed set.
//!
//! Attribution is ADDITIVE (FR-21): the ask itself stays in the turn's pending
//! maps, its SESSION card is still emitted, and it is still resolved by the
//! existing commands under the existing exactly-once claim. Nothing here can
//! lose an ask, double-answer one, or leave the CLI parked.

use super::*;

// ---------- FR-20: the workflow attribution ladder ----------

/// Which run (and possibly which agent) a parked ask belongs to.
#[derive(Clone, PartialEq, Debug)]
pub struct AskAttribution {
    pub(crate) run_id: String,
    pub(crate) agent_id: Option<String>,
    pub(crate) confidence: String, // exact | inferred
}

/// The first of `keys` found on the control request — checked on the request
/// object, then the envelope, then the tool input.
fn request_field(v: &Value, keys: &[&str]) -> Option<String> {
    let request = v.get("request");
    request
        .and_then(|r| json_str(r, keys))
        .or_else(|| json_str(v, keys))
        .or_else(|| {
            request
                .and_then(|r| r.get("input"))
                .and_then(|i| json_str(i, keys))
        })
}

/// FR-20: most specific rung first, first match wins.
///   1. `parent_tool_use_id` = a `Workflow` dispatch this session minted → that run
///   2. an `agent_id`/`agentId` the run scan has seen → that run AND that agent
///   3. exactly one running workflow and NO running background subagent → inferred
///   4. nothing → not a workflow ask; this feature leaves it entirely alone
///
/// `seen` is runId → the agentIds FR-3's scan has observed for it.
pub fn attribute_ask(
    s: &Session,
    v: &Value,
    seen: &HashMap<String, Vec<String>>,
) -> Option<AskAttribution> {
    // rung 1 — the dispatch's own tool_use_id names the RUN, never an agent.
    if let Some(ptuid) = request_field(v, &["parent_tool_use_id", "parentToolUseId"]) {
        if let Some(run_id) = s.workflow_by_tool.get(&ptuid) {
            return Some(AskAttribution {
                run_id: run_id.clone(),
                agent_id: None,
                confidence: "exact".into(),
            });
        }
    }
    // rung 2 — an agent id the scan has already seen.
    if let Some(agent_id) = request_field(v, &["agent_id", "agentId"]) {
        let mut run_ids: Vec<&String> = seen.keys().collect();
        run_ids.sort(); // deterministic when (impossibly) two runs saw one id
        for run_id in run_ids {
            if seen[run_id].iter().any(|a| a == &agent_id) {
                return Some(AskAttribution {
                    run_id: run_id.clone(),
                    agent_id: Some(agent_id),
                    confidence: "exact".into(),
                });
            }
        }
    }
    // rung 3 — sole candidate, and only when no ordinary background subagent
    // could have raised it instead. Marked `inferred` rather than hidden.
    let running: Vec<&WorkflowRun> = s
        .workflow_order
        .iter()
        .filter_map(|id| s.workflows.get(id))
        .filter(|w| w.status == "running")
        .collect();
    let background_running = s
        .agents
        .values()
        .any(|a| a.background && a.status == "running");
    if running.len() == 1 && !background_running {
        return Some(AskAttribution {
            run_id: running[0].id.clone(),
            agent_id: None,
            confidence: "inferred".into(),
        });
    }
    None
}

// ---------- FR-22/FR-24: the attributed set (pure over the registry) ----------

/// FR-22: record an attributed ask against its run. Returns the run's new ask
/// count (FR-24); `None` when that `blockId` was ALREADY attributed — attribution
/// is idempotent, so a re-offered ask can never be double-counted.
pub fn push_ask(
    asks: &mut HashMap<String, Vec<WorkflowPendingAsk>>,
    run_id: &str,
    ask: WorkflowPendingAsk,
) -> Option<u32> {
    if asks
        .values()
        .any(|v| v.iter().any(|a| a.block_id == ask.block_id))
    {
        return None;
    }
    let list = asks.entry(run_id.to_string()).or_default();
    list.push(ask);
    Some(list.len() as u32)
}

/// FR-22/FR-26: the ask keyed by `block_id` is gone — resolved, cancelled or
/// orphaned. Returns `(runId, how many that run has left)`; `None` when it was
/// never attributed, which is the ordinary case for a non-workflow ask.
pub fn drop_ask(
    asks: &mut HashMap<String, Vec<WorkflowPendingAsk>>,
    block_id: &str,
) -> Option<(String, u32)> {
    let run_id = asks
        .iter()
        .find(|(_, v)| v.iter().any(|a| a.block_id == block_id))
        .map(|(id, _)| id.clone())?;
    let list = asks.get_mut(&run_id)?;
    list.retain(|a| a.block_id != block_id);
    let remaining = list.len() as u32;
    if remaining == 0 {
        asks.remove(&run_id);
    }
    Some((run_id, remaining))
}

/// FR-24: mirror the count onto the `WorkflowRun` itself, so the pane [6] card
/// can say `waiting on you` without subscribing to the detail stream. ABSENT
/// (never `0`) when nothing is blocking. Returns the run to emit, or `None` when
/// nothing changed.
pub fn set_pending_asks(s: &mut Session, run_id: &str, n: u32) -> Option<WorkflowRun> {
    let run = s.workflows.get_mut(run_id)?;
    let next = (n > 0).then_some(n);
    if run.pending_asks == next {
        return None;
    }
    run.pending_asks = next;
    Some(run.clone())
}

#[cfg(test)]
mod tests {
    use super::testutil::ask;
    use super::*;
    use crate::session::testutil::*;
    use serde_json::json;

    // ---------- FR-20: the attribution ladder ----------

    fn ask_request(extra: Value) -> Value {
        let mut request = json!({
            "subtype": "can_use_tool", "tool_name": "Bash",
            "input": { "command": "npm test" }
        });
        if let (Some(o), Some(e)) = (request.as_object_mut(), extra.as_object()) {
            for (k, v) in e {
                o.insert(k.clone(), v.clone());
            }
        }
        json!({ "type": "control_request", "request_id": "r1", "request": request })
    }

    /// The REAL wire shape: `parent_tool_use_id`/`agent_id` sit at the TOP LEVEL
    /// of the control_request line, sibling to `type`/`request_id`/`request` —
    /// never nested inside `request`. This mirrors the established convention
    /// every other stream-json line follows (`agents.rs`'s own
    /// `parent_tool_use_id`, exercised on a `control_request` at
    /// `agents.rs:815-823`), and is the shape `request_field`'s second
    /// `.or_else` rung exists to reach.
    fn top_level_ask_request(extra: Value) -> Value {
        let mut v = json!({
            "type": "control_request", "request_id": "r1",
            "request": {
                "subtype": "can_use_tool", "tool_name": "Bash",
                "input": { "command": "npm test" }
            }
        });
        if let (Some(o), Some(e)) = (v.as_object_mut(), extra.as_object()) {
            for (k, val) in e {
                o.insert(k.clone(), val.clone());
            }
        }
        v
    }

    fn ladder_session() -> Session {
        let mut s = test_session();
        mint_workflow(&mut s, "s1", "run-1", "toolu_w", 1_000);
        s
    }

    fn seen(run: &str, agents: &[&str]) -> HashMap<String, Vec<String>> {
        let mut m = HashMap::new();
        m.insert(
            run.to_string(),
            agents.iter().map(|a| a.to_string()).collect(),
        );
        m
    }

    #[test]
    fn rung_1_matches_the_dispatch_tool_use_id() {
        let s = ladder_session();
        let a = attribute_ask(
            &s,
            &ask_request(json!({ "parent_tool_use_id": "toolu_w" })),
            &seen("run-1", &["a1"]),
        )
        .expect("rung 1");
        assert_eq!(a.run_id, "run-1");
        assert_eq!(a.agent_id, None); // the dispatch id names the RUN, not an agent
        assert_eq!(a.confidence, "exact");
        // An unknown parent id does not match rung 1. Asserted on a session with
        // TWO running runs so the sole-candidate rung (3) cannot answer for it —
        // on a one-run session an unmatched id legitimately falls through to
        // `inferred`, which is the ladder working, not rung 1 matching.
        let mut two = ladder_session();
        mint_workflow(&mut two, "s1", "run-2", "toolu_x", 2_000);
        let other = attribute_ask(
            &two,
            &ask_request(json!({ "parent_tool_use_id": "toolu_zz" })),
            &HashMap::new(),
        );
        assert!(other.is_none());
        // …and the SECOND run's dispatch id resolves to the second run.
        assert_eq!(
            attribute_ask(
                &two,
                &ask_request(json!({ "parent_tool_use_id": "toolu_x" })),
                &HashMap::new(),
            )
            .expect("rung 1")
            .run_id,
            "run-2"
        );
    }

    #[test]
    fn rung_1_matches_a_top_level_parent_tool_use_id_the_real_wire_shape() {
        // The nested-in-`request` check is only the leniency rung; production
        // control_request lines carry the correlation field at the top level
        // (`top_level_ask_request`'s doc comment), which is what this proves.
        let s = ladder_session();
        let a = attribute_ask(
            &s,
            &top_level_ask_request(json!({ "parent_tool_use_id": "toolu_w" })),
            &seen("run-1", &["a1"]),
        )
        .expect("rung 1 via the top-level field");
        assert_eq!(a.run_id, "run-1");
        assert_eq!(a.agent_id, None);
        assert_eq!(a.confidence, "exact");
    }

    #[test]
    fn rung_2_matches_an_agent_id_the_scan_has_seen() {
        let s = ladder_session();
        let a = attribute_ask(
            &s,
            &ask_request(json!({ "agent_id": "a1" })),
            &seen("run-1", &["a1"]),
        )
        .expect("rung 2");
        assert_eq!(a.run_id, "run-1");
        assert_eq!(a.agent_id.as_deref(), Some("a1"));
        assert_eq!(a.confidence, "exact");
        // camelCase spelling too
        assert_eq!(
            attribute_ask(
                &s,
                &ask_request(json!({ "agentId": "a1" })),
                &seen("run-1", &["a1"])
            )
            .unwrap()
            .agent_id
            .as_deref(),
            Some("a1")
        );
        // an agent id the scan has NOT seen falls through rung 2
        let mut s2 = ladder_session();
        mint_agent(&mut s2, "bg", "explorer", "toolu_d", true);
        assert!(attribute_ask(
            &s2,
            &ask_request(json!({ "agent_id": "zz" })),
            &seen("run-1", &["a1"])
        )
        .is_none());
    }

    #[test]
    fn rung_2_matches_a_top_level_agent_id_the_real_wire_shape() {
        let s = ladder_session();
        let a = attribute_ask(
            &s,
            &top_level_ask_request(json!({ "agent_id": "a1" })),
            &seen("run-1", &["a1"]),
        )
        .expect("rung 2 via the top-level field");
        assert_eq!(a.run_id, "run-1");
        assert_eq!(a.agent_id.as_deref(), Some("a1"));
        assert_eq!(a.confidence, "exact");
    }

    #[test]
    fn rung_3_needs_exactly_one_running_workflow_and_no_running_background_agent() {
        let s = ladder_session();
        let a = attribute_ask(&s, &ask_request(json!({})), &HashMap::new()).expect("rung 3");
        assert_eq!(a.run_id, "run-1");
        assert_eq!(a.agent_id, None);
        assert_eq!(a.confidence, "inferred");

        // a running background subagent blocks the rung
        let mut with_agent = ladder_session();
        mint_agent(&mut with_agent, "bg", "explorer", "toolu_d", true);
        assert!(attribute_ask(&with_agent, &ask_request(json!({})), &HashMap::new()).is_none());

        // two running workflows block it too
        let mut two = ladder_session();
        mint_workflow(&mut two, "s1", "run-2", "toolu_x", 2_000);
        assert!(attribute_ask(&two, &ask_request(json!({})), &HashMap::new()).is_none());

        // and a session with no running workflow attributes nothing (rung 4)
        let mut done = ladder_session();
        let _ = apply_workflow_notice(&mut done, "run-1", "completed", 5_000);
        assert!(attribute_ask(&done, &ask_request(json!({})), &HashMap::new()).is_none());
    }

    // ---------- FR-22/FR-24: the attributed set ----------

    #[test]
    fn asks_are_counted_per_run_and_never_double_counted() {
        let mut asks: HashMap<String, Vec<WorkflowPendingAsk>> = HashMap::new();
        assert_eq!(push_ask(&mut asks, "run-1", ask("b1", Some("a1"))), Some(1));
        assert_eq!(push_ask(&mut asks, "run-1", ask("b2", None)), Some(2));
        // §7: two agents of one run can block at the same time
        assert_eq!(asks["run-1"].len(), 2);
        // the same blockId offered twice is idempotent — attribution is additive
        // (FR-21), so it must never inflate FR-24's count
        assert_eq!(push_ask(&mut asks, "run-1", ask("b1", Some("a1"))), None);
        assert_eq!(push_ask(&mut asks, "run-2", ask("b1", None)), None);
    }

    #[test]
    fn dropping_an_ask_reports_its_run_and_what_is_left() {
        let mut asks: HashMap<String, Vec<WorkflowPendingAsk>> = HashMap::new();
        push_ask(&mut asks, "run-1", ask("b1", Some("a1")));
        push_ask(&mut asks, "run-1", ask("b2", None));
        assert_eq!(drop_ask(&mut asks, "b1"), Some(("run-1".into(), 1)));
        assert_eq!(asks["run-1"].len(), 1);
        // the last one out takes the run's entry with it
        assert_eq!(drop_ask(&mut asks, "b2"), Some(("run-1".into(), 0)));
        assert!(!asks.contains_key("run-1"));
        // a blockId that was never attributed is a no-op (the ordinary case for
        // an ask this feature ignored at rung 4)
        assert_eq!(drop_ask(&mut asks, "b9"), None);
    }

    #[test]
    fn pending_asks_rides_on_the_run_and_is_absent_at_zero() {
        // FR-24: the pane [6] card reads `waiting on you` without subscribing to
        // the detail stream. WorkflowStatus is untouched — waiting is an overlay.
        let mut s = test_session();
        mint_workflow(&mut s, "s1", "run-1", "toolu_w", 1_000);
        let run = set_pending_asks(&mut s, "run-1", 2).expect("count changed");
        assert_eq!(run.pending_asks, Some(2));
        assert_eq!(run.status, "running");
        assert!(set_pending_asks(&mut s, "run-1", 2).is_none()); // no redundant emission
        let cleared = set_pending_asks(&mut s, "run-1", 0).expect("count changed");
        assert_eq!(cleared.pending_asks, None); // absent, never 0
        assert!(serde_json::to_value(&cleared)
            .unwrap()
            .get("pendingAsks")
            .is_none());
        assert!(set_pending_asks(&mut s, "nope", 1).is_none());
    }
}
