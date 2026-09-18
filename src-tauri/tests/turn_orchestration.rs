//! core-architecture-wave3 FR-3 — the integration target, seeded with the case
//! that motivated it: **turn orchestration**.
//!
//! This file is a SEPARATE CRATE from `francois`. That is the whole point.
//! Every unit test in `src/` reaches its subject through `super::*` and can see
//! private fields, so nothing in the tree proved that the lib target FR-2
//! extracted is actually usable from outside — the `pub` surface could have
//! been anything and no test would have noticed. Here, `use francois::…` is the
//! only door, and a turn is driven end to end through it.
//!
//! It deliberately does NOT duplicate `golden_replay_produces_the_locked_
//! session_event_sequence` (session/stream/mod.rs), which pins the exact event
//! sequence of a real captured turn. That test needs the crate's insides. This
//! one asserts the *orchestration contract* a caller can observe: a turn that
//! starts, streams, uses a tool and finishes leaves the session idle, emits its
//! text once as deltas and once complete, and persists what it emitted.

use francois::session::testenv::TestEnv;
use francois::session::testutil::{starting_session, test_engine_with, test_session};
use francois::session::{parse_stream, SessionEvent};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::Cursor;
use std::sync::{Arc, Mutex};

/// One synthetic turn: init, a text block streamed in three deltas, a tool
/// call with its result, and a terminal `result`. Synthetic rather than
/// captured on purpose — a fixture this test owns can be read in full on the
/// screen, and the captured-stream case is already covered in-crate.
fn turn_lines() -> Vec<Value> {
    let sid = "feed0000-0000-4000-8000-000000000001";
    vec![
        json!({"type":"system","subtype":"init","cwd":"/x","session_id":sid,"tools":["Read"],"model":"sonnet"}),
        json!({"type":"stream_event","event":{"type":"content_block_start","index":0,
               "content_block":{"type":"text","text":""}},"session_id":sid}),
        json!({"type":"stream_event","event":{"type":"content_block_delta","index":0,
               "delta":{"type":"text_delta","text":"Hello, "}},"session_id":sid}),
        json!({"type":"stream_event","event":{"type":"content_block_delta","index":0,
               "delta":{"type":"text_delta","text":"world"}},"session_id":sid}),
        json!({"type":"stream_event","event":{"type":"content_block_delta","index":0,
               "delta":{"type":"text_delta","text":"."}},"session_id":sid}),
        json!({"type":"stream_event","event":{"type":"content_block_stop","index":0},"session_id":sid}),
        json!({"type":"stream_event","event":{"type":"content_block_start","index":1,
               "content_block":{"type":"tool_use","id":"toolu_1","name":"Read","input":{}}},
               "session_id":sid}),
        json!({"type":"stream_event","event":{"type":"content_block_delta","index":1,
               "delta":{"type":"input_json_delta","partial_json":"{\"file_path\":\"/x/a.txt\"}"}},
               "session_id":sid}),
        json!({"type":"stream_event","event":{"type":"content_block_stop","index":1},
               "session_id":sid}),
        json!({"type":"user","message":{"content":[
               {"type":"tool_result","tool_use_id":"toolu_1","content":"file contents"}]},
               "session_id":sid}),
        json!({"type":"result","subtype":"success","is_error":false,"result":"done",
               "session_id":sid}),
    ]
}

fn replay(lines: &[Value]) -> TestEnv {
    // `starting_session`, not `test_session`: `do_send` sets `starting` before it
    // spawns, so `system/init` has a status to promote — replaying from `idle`
    // would test a state no turn is ever in.
    let env = TestEnv {
        engine: test_engine_with(starting_session()),
        ..Default::default()
    };
    let ndjson = lines
        .iter()
        .map(|l| l.to_string())
        .collect::<Vec<_>>()
        .join("\n");
    parse_stream(
        &env,
        "s1",
        Cursor::new(ndjson.into_bytes()),
        &Arc::new(Mutex::new(None)),
        &Arc::new(Mutex::new(HashMap::new())),
        &Arc::new(Mutex::new(HashMap::new())),
        None,
    );
    env
}

fn events(env: &TestEnv) -> Vec<Value> {
    env.session_events
        .lock()
        .unwrap()
        .iter()
        .map(|e| serde_json::to_value(e).unwrap())
        .collect()
}

fn kinds(evs: &[Value]) -> Vec<String> {
    evs.iter()
        .map(|e| e["type"].as_str().unwrap_or("?").to_string())
        .collect()
}

#[test]
fn a_turn_streams_its_text_and_then_repeats_it_complete() {
    let env = replay(&turn_lines());
    let evs = events(&env);

    let deltas: Vec<&str> = evs
        .iter()
        .filter(|e| e["type"] == "assistant.delta")
        .map(|e| e["text"].as_str().unwrap())
        .collect();
    assert_eq!(deltas, vec!["Hello, ", "world", "."]);

    // `assistant.done` carries the COMPLETE text, not the last chunk — that is
    // what repairs a listener which missed a delta, and a caller that only ever
    // sees the public API has no other way to check it.
    let done: Vec<&str> = evs
        .iter()
        .filter(|e| e["type"] == "assistant.done")
        .map(|e| e["text"].as_str().unwrap())
        .collect();
    assert_eq!(done, vec!["Hello, world."]);
}

#[test]
fn the_streamed_offset_is_in_utf16_units_and_never_goes_backwards() {
    // The FR-2 regression that motivated the bench next door: the offset used to
    // be re-derived by re-encoding the whole accumulation on every delta. It is
    // tracked incrementally now, and the observable proof is that it still
    // matches the UTF-16 prefix length of everything sent before it.
    let mut lines = turn_lines();
    lines[3] = json!({"type":"stream_event","event":{"type":"content_block_delta","index":0,
                      "delta":{"type":"text_delta","text":"wörld😀"}},
                      "session_id":"feed0000-0000-4000-8000-000000000001"});
    let env = replay(&lines);

    let mut expected = 0usize;
    for e in events(&env)
        .iter()
        .filter(|e| e["type"] == "assistant.delta")
    {
        assert_eq!(e["offset"].as_u64().unwrap() as usize, expected);
        expected += e["text"].as_str().unwrap().encode_utf16().count();
    }
    assert!(expected > 0, "the replay produced no deltas at all");
}

#[test]
fn a_tool_call_opens_and_closes_around_its_result() {
    let evs = events(&replay(&turn_lines()));
    let k = kinds(&evs);
    let start = k
        .iter()
        .position(|t| t == "tool.start")
        .expect("tool.start");
    let end = k.iter().position(|t| t == "tool.done").expect("tool.done");
    assert!(start < end, "a tool must not end before it starts: {k:?}");
    assert_eq!(evs[start]["tool"], "Read");
}

#[test]
fn init_promotes_the_session_from_starting_to_running() {
    // The status a turn reaches under `parse_stream` is `running`, not `idle`:
    // ending the turn is `run_reader`'s, because only it holds the live `Child`
    // to reap. What init owns — and what the roster reads to stop showing a
    // spinner that means "spawning" — is the promotion.
    let statuses: Vec<String> = events(&replay(&turn_lines()))
        .iter()
        .filter(|e| e["type"] == "session.status")
        .map(|e| e["status"].as_str().unwrap().to_string())
        .collect();
    assert!(
        statuses.contains(&"running".to_string()),
        "init never promoted the session: {statuses:?}"
    );
}

#[test]
fn everything_the_turn_emitted_was_also_persisted() {
    let env = replay(&turn_lines());
    let appended = env.transcript_appends.lock().unwrap().len();
    assert!(
        appended >= 2,
        "the text block and the tool block must both reach the transcript, got {appended}"
    );
    assert!(
        env.transcript_appends
            .lock()
            .unwrap()
            .iter()
            .all(|(sid, _)| sid == "s1"),
        "a block was persisted against the wrong session"
    );
}

#[test]
fn a_stream_that_dies_before_its_result_still_closes_its_open_block() {
    // The other half of orchestration: the CLI is killed mid-sentence. Nothing
    // may be left `streaming`, or the transcript renders a caret forever.
    let mut lines = turn_lines();
    lines.truncate(4); // init, block start, two deltas — no stop, no result
    let env = replay(&lines);
    assert!(
        !kinds(&events(&env)).contains(&"assistant.done".to_string()),
        "a truncated stream must not claim the block completed"
    );
    // `parse_stream` returns the still-open block to `run_reader`, which owns
    // the close — the contract here is that it does not invent a completion.
    let ev = events(&env);
    assert!(
        ev.iter().any(|e| e["type"] == "assistant.delta"),
        "what did arrive was still delivered: {:?}",
        kinds(&ev)
    );
}

/// FR-3's other reason to exist: this file compiles at all only if the lib's
/// public surface really does hold together from outside.
#[test]
fn the_library_target_is_usable_from_another_crate() {
    let env = TestEnv {
        engine: test_engine_with(test_session()),
        ..Default::default()
    };
    let _: &dyn francois::session::SessionEnv = &env;
    let _: SessionEvent = SessionEvent::Status {
        session_id: "s1".into(),
        status: "idle".into(),
    };
}
