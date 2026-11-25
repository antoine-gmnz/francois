use super::*;
use crate::session::testutil::{test_engine_with, test_session, FakeTurnControl};
use serde_json::json;
use std::sync::atomic::{AtomicUsize, Ordering};

const RESUMED: &str = include_str!("../stream/fixtures/context-usage-resumed.ndjson");
const FRESH: &str = include_str!("../stream/fixtures/context-usage-fresh.ndjson");
const FAKE: &str = include_str!("../adapter/claude_code/fixtures/fake-claude.cjs");
const RESUMED_PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/src/session/stream/fixtures/context-usage-resumed.ndjson"
);

fn answer_of(fixture: &str) -> Value {
    let v: Value = serde_json::from_str(fixture.lines().next().unwrap()).unwrap();
    v["response"]["response"].clone()
}

fn breakdown() -> ContextBreakdown {
    parse_context_usage(&answer_of(RESUMED)).unwrap()
}

fn fp(epoch: u64) -> Fingerprint {
    Fingerprint {
        turn_epoch: epoch,
        model_id: "sonnet".into(),
        thread: None,
    }
}

fn measured(epoch: u64) -> Measured {
    Measured {
        breakdown: breakdown(),
        measured_at: 1_000,
        fingerprint: fp(epoch),
    }
}

// ---------- FR-8 parser ----------

#[test]
fn parses_the_resumed_fixture() {
    let b = breakdown();
    assert_eq!(b.model, "claude-fable-5-2");
    assert_eq!(b.total_tokens, 93_544);
    assert_eq!(b.max_tokens, 1_000_000);
    assert_eq!(b.percentage, 9.0);
    assert_eq!(b.categories.len(), 12);
    assert_eq!(
        b.categories[0],
        ContextCategory {
            id: Some("system_prompt".into()),
            name: "System prompt".into(),
            tokens: 4071,
            kind: ContextRowKind::Used,
        }
    );
    let kinds: Vec<_> = b.categories.iter().map(|c| c.kind).collect();
    assert_eq!(
        kinds
            .iter()
            .filter(|k| **k == ContextRowKind::Deferred)
            .count(),
        2
    );
    assert_eq!(kinds.last(), Some(&ContextRowKind::Free));
    assert_eq!(b.mcp_tools.len(), 6);
    assert_eq!(b.mcp_tools[0].server_name, "cartograph");
    assert_eq!(b.mcp_tools[0].is_loaded, Some(false));
    assert_eq!(b.memory_files.len(), 3);
    assert_eq!(b.memory_files[0].kind, "Project");
    assert_eq!(b.agents.len(), 3);
    assert_eq!(b.agents[0].source, "plugin");
    let raw = answer_of(RESUMED);
    assert_eq!(
        b.skills.len(),
        raw["skills"]["skillFrontmatter"].as_array().unwrap().len()
    );
    assert_eq!(b.auto_compact_threshold, Some(967_000));
}

#[test]
fn parses_the_fresh_fixture() {
    let b = parse_context_usage(&answer_of(FRESH)).unwrap();
    assert_eq!(b.model, "claude-sonnet-5-5");
    assert_eq!(b.total_tokens, 21_664);
    assert_eq!(b.categories.len(), 7);
    assert!(b.mcp_tools.is_empty());
    assert!(b.memory_files.is_empty());
}

#[test]
fn a_drifted_payload_parses_leniently() {
    let b = parse_context_usage(&json!({
        "maxTokens": 200_000,
        "categories": [
            { "name": "Messages", "tokens": 1500, "kind": "used" },
            { "id": "x", "name": "Future", "tokens": 9, "kind": "sparkles" },
            { "id": "y", "name": "No kind", "tokens": 9 },
            { "id": "old_deferred", "name": "Old deferred", "tokens": 7, "isDeferred": true },
            { "id": "free_space", "name": "Free", "tokens": 198_500.0, "kind": "free" },
        ],
        "isAutoCompactEnabled": false,
        "autoCompactThreshold": 180_000,
        "mcpTools": [{ "name": "t", "serverName": "s", "tokens": 3 }, "junk"],
    }))
    .unwrap();
    assert_eq!(b.categories.len(), 3);
    assert_eq!(b.categories[0].id, None);
    assert_eq!(b.categories[1].kind, ContextRowKind::Deferred);
    assert_eq!(b.categories[2].tokens, 198_500);
    assert_eq!(b.total_tokens, 1500, "missing total = sum of used rows");
    assert_eq!(b.percentage, 1.0);
    assert_eq!(b.model, "");
    assert_eq!(
        b.auto_compact_threshold, None,
        "disabled autocompact → null"
    );
    assert_eq!(b.mcp_tools.len(), 1);
    assert_eq!(b.mcp_tools[0].is_loaded, None);
    assert!(b.memory_files.is_empty() && b.agents.is_empty() && b.skills.is_empty());
}

#[test]
fn rejects_a_report_with_no_window_or_no_categories() {
    for bad in [
        json!({ "categories": [] }),
        json!({ "maxTokens": 0, "categories": [] }),
        json!({ "maxTokens": 1000 }),
    ] {
        let e = parse_context_usage(&bad).unwrap_err();
        assert_eq!(e.code, ErrorCode::ContextBreakdownUnavailable);
        assert_eq!(e.message, UNEXPECTED);
    }
}

// ---------- FR-5/FR-6 wire ----------

#[test]
fn only_our_control_response_is_matched() {
    let line = RESUMED.lines().next().unwrap();
    assert!(matches!(match_reply(line, "ctx-1"), Some(Ok(_))));
    assert!(match_reply(line, "other").is_none());
    assert!(match_reply(r#"{"type":"system","subtype":"hook_response"}"#, "ctx-1").is_none());
    assert!(match_reply("not json", "ctx-1").is_none());
    let refused = r#"{"type":"control_response","response":{"subtype":"error","request_id":"r","error":"Unsupported"}}"#;
    let e = match_reply(refused, "r").unwrap().unwrap_err();
    assert_eq!(e.code, ErrorCode::ContextBreakdownUnavailable);
    assert_eq!(e.message, REFUSED);
}

#[test]
fn the_request_line_and_argv_follow_fr5() {
    let v: Value = serde_json::from_str(&request_line("abc")).unwrap();
    assert_eq!(
        v,
        json!({"type":"control_request","request_id":"abc","request":{"subtype":"get_context_usage"}})
    );
    let fresh = probe_args("opus", None);
    assert_eq!(
        fresh,
        [
            "-p",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--verbose",
            "--model",
            "opus"
        ]
    );
    let resumed = probe_args("opus", Some("t-1"));
    assert_eq!(&resumed[8..], ["--resume", "t-1"]);
    assert!(!resumed.iter().any(|a| a.contains("permission")));
}

// ---------- FR-10 serde ----------

#[test]
fn the_response_round_trips_in_contract_shape() {
    let r = ContextBreakdownResponse {
        breakdown: Some(ContextBreakdown {
            auto_compact_threshold: None,
            ..breakdown()
        }),
        measured_at: Some(42),
        stale: true,
    };
    let v = serde_json::to_value(&r).unwrap();
    assert_eq!(v["measuredAt"], 42);
    assert_eq!(v["breakdown"]["autoCompactThreshold"], Value::Null);
    assert!(v["breakdown"].get("totalTokens").is_some());
    assert_eq!(v["breakdown"]["memoryFiles"][0]["type"], "Project");
    assert_eq!(v["breakdown"]["mcpTools"][0]["serverName"], "cartograph");
    assert_eq!(v["breakdown"]["mcpTools"][0]["isLoaded"], false);
    assert_eq!(
        v["breakdown"]["agents"][0]["agentType"],
        "cockroachdb:cockroachdb-dba"
    );
    assert_eq!(v["breakdown"]["categories"][4]["kind"], "deferred");
    let back: ContextBreakdownResponse = serde_json::from_value(v).unwrap();
    assert_eq!(back, r);

    let empty = serde_json::to_value(ContextBreakdownResponse {
        breakdown: None,
        measured_at: None,
        stale: true,
    })
    .unwrap();
    assert_eq!(
        empty,
        json!({ "breakdown": null, "measuredAt": null, "stale": true })
    );
    let row = serde_json::to_value(ContextCategory {
        id: None,
        name: "n".into(),
        tokens: 1,
        kind: ContextRowKind::Buffer,
    })
    .unwrap();
    assert_eq!(
        row,
        json!({ "id": null, "name": "n", "tokens": 1, "kind": "buffer" })
    );
}

// ---------- FR-3/FR-4/FR-9 decisions ----------

#[test]
fn a_live_turn_never_probes() {
    let none = plan(true, true, None, &fp(0));
    assert_eq!(
        none,
        Plan::Answer(ContextBreakdownResponse {
            breakdown: None,
            measured_at: None,
            stale: true
        })
    );
    let Plan::Answer(cached) = plan(true, false, Some(&measured(0)), &fp(0)) else {
        panic!("a live turn must answer from the cache");
    };
    assert!(cached.stale);
    assert_eq!(cached.measured_at, Some(1_000));
}

#[test]
fn a_fresh_cache_is_reused_unless_forced() {
    let Plan::Answer(r) = plan(false, false, Some(&measured(3)), &fp(3)) else {
        panic!("fresh cache must be reused");
    };
    assert!(!r.stale);
    assert_eq!(plan(false, true, Some(&measured(3)), &fp(3)), Plan::Probe);
    assert_eq!(plan(false, false, None, &fp(3)), Plan::Probe);
}

#[test]
fn a_turn_end_a_model_change_or_a_new_thread_makes_the_cache_stale() {
    let cache = measured(3);
    let mut model = fp(3);
    model.model_id = "opus".into();
    let mut thread = fp(3);
    thread.thread = Some("t".into());
    for now in [fp(4), model, thread] {
        assert_eq!(plan(false, false, Some(&cache), &now), Plan::Probe);
        assert!(response_of(Some(&cache), &now, false).stale);
    }
}

// ---------- FR-1/FR-2/FR-3 over the engine ----------

fn no_spawn(_: &ProbeTarget) -> ProbeSpawn {
    panic!("this call must not spawn a probe");
}

#[test]
fn unknown_session_and_non_claude_runtime_are_refused() {
    let engine = test_engine_with(test_session());
    let e = breakdown_in_engine(&engine, "nope", false, PROBE_TIMEOUT, no_spawn).unwrap_err();
    assert_eq!(e.code, ErrorCode::SessionNotFound);

    let mut s = test_session();
    s.agent_runtime = AgentRuntime::Codex;
    let engine = test_engine_with(s);
    let e = breakdown_in_engine(&engine, "s1", true, PROBE_TIMEOUT, no_spawn).unwrap_err();
    assert_eq!(e.code, ErrorCode::ContextBreakdownUnavailable);
    assert_eq!(e.message, NOT_CLAUDE);
}

#[test]
fn a_live_session_returns_the_cache_stale_without_probing() {
    for status in ["starting", "running", "awaiting_approval", "awaiting_input"] {
        let mut s = test_session();
        s.status = status.into();
        s.context.cache = Some(measured(0));
        let engine = test_engine_with(s);
        let r = breakdown_in_engine(&engine, "s1", true, PROBE_TIMEOUT, no_spawn).unwrap();
        assert!(r.stale, "{status}");
        assert_eq!(r.breakdown, Some(breakdown()));
    }
}

#[test]
fn a_settled_session_whose_child_holds_stdin_is_live() {
    let mut s = test_session();
    s.status = "idle".into();
    s.current = Some(FakeTurnControl::new(0, 0));
    let engine = test_engine_with(s);
    let r = breakdown_in_engine(&engine, "s1", false, PROBE_TIMEOUT, no_spawn).unwrap();
    assert_eq!(r.breakdown, None);
    assert!(r.stale);
}

// ---------- FR-5..FR-7 against the fake CLI (FR-11) ----------

struct Fake {
    record: std::path::PathBuf,
    spawns: AtomicUsize,
}

impl Fake {
    fn new() -> Self {
        Fake {
            record: std::env::temp_dir()
                .join(format!("fake-claude-ctx-{}.ndjson", super::super::uuid())),
            spawns: AtomicUsize::new(0),
        }
    }
    /// The production argv, run by node through the fixture script.
    fn spawn(&self, scenario: &str, t: &ProbeTarget) -> ProbeSpawn {
        self.spawns.fetch_add(1, Ordering::SeqCst);
        let mut argv = vec![
            "-e".to_string(),
            FAKE.to_string(),
            scenario.to_string(),
            self.record.to_string_lossy().into_owned(),
        ];
        argv.extend(probe_args(&t.model_id, t.resume.as_deref()));
        ProbeSpawn {
            program: "node".into(),
            argv,
            env: Vec::new(),
            cwd: Some(std::env::temp_dir().to_string_lossy().into_owned()),
        }
    }
    fn argv(&self) -> Vec<String> {
        let first = std::fs::read_to_string(&self.record).unwrap();
        let v: Value = serde_json::from_str(first.lines().next().unwrap()).unwrap();
        serde_json::from_value(v["argv"].clone()).unwrap()
    }
}

impl Drop for Fake {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.record);
    }
}

fn ok_scenario() -> String {
    format!("context:{RESUMED_PATH}")
}

#[test]
fn a_probe_fills_the_cache_and_a_fresh_cache_answers_without_spawning() {
    let fake = Fake::new();
    let mut s = test_session();
    s.status = "idle".into();
    s.claude_session_id = Some("thread-1".into());
    let engine = test_engine_with(s);
    let scenario = ok_scenario();
    let r = breakdown_in_engine(&engine, "s1", false, PROBE_TIMEOUT, |t| {
        fake.spawn(&scenario, t)
    })
    .unwrap();
    assert!(!r.stale);
    assert_eq!(r.breakdown, Some(breakdown()));
    assert!(r.measured_at.is_some());
    let argv = fake.argv();
    assert_eq!(&argv[argv.len() - 2..], ["--resume", "thread-1"]);

    // FR-4: fresh → no probe.
    let again = breakdown_in_engine(&engine, "s1", false, PROBE_TIMEOUT, no_spawn).unwrap();
    assert_eq!(again, r);

    // A turn ends → stale until re-measured (FR-9), and refresh:false re-probes.
    engine.with_session_mut("s1", |s| s.context.note_turn_ended());
    engine.with_session_mut("s1", |s| s.status = "running".into());
    let live = breakdown_in_engine(&engine, "s1", false, PROBE_TIMEOUT, no_spawn).unwrap();
    assert!(live.stale);
    engine.with_session_mut("s1", |s| s.status = "idle".into());
    breakdown_in_engine(&engine, "s1", false, PROBE_TIMEOUT, |t| {
        fake.spawn(&scenario, t)
    })
    .unwrap();
    assert_eq!(fake.spawns.load(Ordering::SeqCst), 2);
    // The probe touched none of the turn's state (FR-7).
    engine.with_session("s1", |s| {
        assert_eq!(s.claude_session_id.as_deref(), Some("thread-1"));
        assert_eq!(s.status, "idle");
        assert!(s.context.flight.is_none());
    });
}

#[test]
fn failures_are_unavailable_and_leave_the_cache_intact() {
    // Only the hang gets a short deadline: a cold `node` start on CI must not
    // turn the other two into timeouts.
    for (scenario, message, deadline) in [
        ("context-error", REFUSED, PROBE_TIMEOUT),
        ("context-exit", EXITED, PROBE_TIMEOUT),
        ("context-hang", TIMED_OUT, Duration::from_millis(1500)),
    ] {
        let fake = Fake::new();
        let mut s = test_session();
        s.status = "idle".into();
        s.context.cache = Some(measured(0));
        let engine = test_engine_with(s);
        let e = breakdown_in_engine(&engine, "s1", true, deadline, |t| fake.spawn(scenario, t))
            .unwrap_err();
        assert_eq!(e.code, ErrorCode::ContextBreakdownUnavailable, "{scenario}");
        assert_eq!(e.message, message, "{scenario}");
        engine.with_session("s1", |s| {
            assert_eq!(s.context.cache.as_ref().unwrap().measured_at, 1_000);
            assert!(s.context.flight.is_none());
        });
    }
}

#[test]
fn a_spawn_failure_is_unavailable() {
    let mut s = test_session();
    s.status = "idle".into();
    let engine = test_engine_with(s);
    let e = breakdown_in_engine(&engine, "s1", true, PROBE_TIMEOUT, |_| ProbeSpawn {
        program: "francois-no-such-binary-xyz".into(),
        argv: Vec::new(),
        env: Vec::new(),
        cwd: None,
    })
    .unwrap_err();
    assert_eq!(e.code, ErrorCode::ContextBreakdownUnavailable);
    engine.with_session("s1", |s| assert!(s.context.flight.is_none()));
}

#[test]
fn concurrent_calls_share_one_probe() {
    let fake = Fake::new();
    let mut s = test_session();
    s.status = "idle".into();
    let engine = test_engine_with(s);
    let scenario = format!("context-slow:{RESUMED_PATH}");
    let results: Vec<_> = std::thread::scope(|scope| {
        let handles: Vec<_> = (0..3)
            .map(|_| {
                scope.spawn(|| {
                    breakdown_in_engine(&engine, "s1", true, PROBE_TIMEOUT, |t| {
                        fake.spawn(&scenario, t)
                    })
                })
            })
            .collect();
        handles.into_iter().map(|h| h.join().unwrap()).collect()
    });
    assert_eq!(fake.spawns.load(Ordering::SeqCst), 1, "never two children");
    for r in &results {
        assert_eq!(r.as_ref().unwrap().breakdown, Some(breakdown()));
    }
}

#[test]
fn a_session_removed_mid_probe_discards_the_result() {
    let fake = Fake::new();
    let mut s = test_session();
    s.status = "idle".into();
    let engine = test_engine_with(s);
    let scenario = format!("context-slow:{RESUMED_PATH}");
    let e = std::thread::scope(|scope| {
        let probe = scope.spawn(|| {
            breakdown_in_engine(&engine, "s1", false, PROBE_TIMEOUT, |t| {
                fake.spawn(&scenario, t)
            })
        });
        // Wait for the flight to exist, then remove the session (as session_remove does).
        let flight = loop {
            if let Some(Some(f)) = engine.with_session("s1", |s| s.context.flight()) {
                break f;
            }
            std::thread::sleep(Duration::from_millis(5));
        };
        let removed = engine.sessions.lock().unwrap().remove("s1");
        flight.kill();
        drop(removed);
        probe.join().unwrap()
    })
    .unwrap_err();
    assert_eq!(e.code, ErrorCode::SessionNotFound);
}

// ---------- FR-4: every real turn end invalidates ----------

fn epoch(env: &crate::session::testenv::TestEnv) -> u64 {
    env.engine
        .with_session("s1", |s| s.context.turn_epoch)
        .unwrap()
}

#[test]
fn a_settled_turn_bumps_the_epoch() {
    let mut s = test_session();
    s.status = "running".into();
    s.current = Some(FakeTurnControl::new(0, 0));
    let env = crate::session::testenv::TestEnv {
        engine: test_engine_with(s),
        ..Default::default()
    };
    crate::session::settle_turn(&env, "s1", 1);
    assert_eq!(epoch(&env), 1);
}

#[test]
fn a_held_child_exiting_after_settle_bumps_the_epoch() {
    let mut s = test_session();
    s.status = "idle".into();
    s.current = Some(FakeTurnControl::new(0, 0));
    let env = crate::session::testenv::TestEnv {
        engine: test_engine_with(s),
        ..Default::default()
    };
    crate::session::runtime_bridge::project_runtime_event(
        &env,
        "s1",
        "/x",
        crate::session::application::RuntimeEvent::ConnectionClosed(AppError::new(
            ErrorCode::Internal,
            "closed",
        )),
    )
    .unwrap();
    assert_eq!(epoch(&env), 1);
}

#[test]
fn a_failed_session_bumps_the_epoch() {
    let mut s = test_session();
    crate::session::turn::apply_fail_session(&mut s, "boom", 1);
    assert_eq!(s.context.turn_epoch, 1);
}
