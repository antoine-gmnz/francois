// Connection tests for the Pi dispatcher — split out of dispatcher.rs to keep it
// under the ~1000-line cap; included via `#[path]` from there.

use super::*;
use std::net::{TcpListener, TcpStream};

/// The "fake child" the spec's acceptance criteria ask for: a loopback
/// TCP pair stands in for the process's stdin/stdout, so these tests
/// exercise the REAL reader thread, REAL `mpsc` timeouts, and the REAL
/// `RuntimeSessionControl` implementation with no external `pi` binary
/// and no AppHandle.
fn test_pipe_pair() -> (TcpStream, TcpStream) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let client = TcpStream::connect(addr).unwrap();
    let (server, _) = listener.accept().unwrap();
    client.set_nodelay(true).ok();
    server.set_nodelay(true).ok();
    (client, server)
}

#[derive(Default)]
struct Recording {
    run_states: Mutex<Vec<RuntimeRunState>>,
    failures: Mutex<Vec<(ErrorCode, String)>>,
    transcripts: Mutex<Vec<RuntimeEventPayload>>,
    /// LOW (review round 3): previously a no-op — nothing distinguished
    /// healthy transcript traffic from `ProtocolEngine`'s own "unknown event
    /// kind ignored" diagnostic, so a regression there had no test that
    /// could have caught it.
    diagnostics: Mutex<Vec<String>>,
}
impl EventPublisher for Recording {
    fn run_state(&self, s: RuntimeRunState) {
        self.run_states.lock().unwrap().push(s);
    }
    fn failure(&self, code: ErrorCode, reason: &str, _ctx: DiagnosticContext) {
        self.failures
            .lock()
            .unwrap()
            .push((code, reason.to_string()));
    }
    fn diagnostic(&self, message: &str, _ctx: DiagnosticContext) {
        self.diagnostics.lock().unwrap().push(message.to_string());
    }
    fn transcript(&self, event: RuntimeEventPayload) {
        self.transcripts.lock().unwrap().push(event);
    }
}

/// `dispatcher_end` is what `PiConnection` writes to/reads from;
/// `fake_child_end` is driven directly by the test, standing in for the
/// Pi process on the other side of the pipe.
fn handle_over(dispatcher_end: TcpStream, kill_flag: Arc<Mutex<bool>>) -> ProcessHandle {
    let stdout = dispatcher_end.try_clone().unwrap();
    // A short read timeout makes a killed fake child's socket-shutdown
    // observable on the READER's next poll rather than depending on an
    // in-flight blocking `read()` being interrupted by a shutdown on a
    // different cloned handle, which is not reliable cross-platform —
    // see `spawn_reader`'s WouldBlock/TimedOut handling.
    stdout
        .set_read_timeout(Some(Duration::from_millis(50)))
        .unwrap();
    // A real `kill_tree` on a real child closes ITS end of the pipe,
    // which is what unblocks the dispatcher's blocking `read()` — a fake
    // `kill` that only flips a flag would leave the reader thread (and
    // so `shutdown()`'s `join()`) hanging forever whenever the fake
    // child is still "alive" (i.e. `fake_child` not yet dropped) at
    // shutdown time. `TcpStream::shutdown` affects the whole socket, not
    // just this one cloned handle, so it is the honest stand-in here.
    let socket = dispatcher_end.try_clone().unwrap();
    ProcessHandle {
        stdin: Box::new(dispatcher_end),
        stdout: Box::new(stdout),
        wait_timeout: Box::new({
            let kill_flag = kill_flag.clone();
            move |_| *kill_flag.lock().unwrap()
        }),
        kill: Box::new(move || {
            *kill_flag.lock().unwrap() = true;
            let _ = socket.shutdown(std::net::Shutdown::Both);
        }),
        stderr_ring: Arc::new(Mutex::new(Vec::new())),
    }
}

fn read_line(child: &mut TcpStream) -> String {
    let mut byte = [0u8; 1];
    let mut line = Vec::new();
    loop {
        let n = child.read(&mut byte).unwrap();
        assert!(
            n > 0,
            "the dispatcher's peer closed before a full line arrived"
        );
        if byte[0] == b'\n' {
            break;
        }
        line.push(byte[0]);
    }
    String::from_utf8(line).unwrap()
}

fn write_line(child: &mut TcpStream, line: &str) {
    child.write_all(line.as_bytes()).unwrap();
    child.write_all(b"\n").unwrap();
}

fn extract_id(line: &str) -> String {
    serde_json::from_str::<serde_json::Value>(line).unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string()
}

fn resp(id: &str, command: &str, success: bool) -> String {
    serde_json::json!({ "id": id, "command": command, "success": success }).to_string()
}

#[test]
fn a_fake_child_completes_the_handshake_and_two_prompts_on_one_connection() {
    let (dispatcher_end, mut fake_child) = test_pipe_pair();
    let handle = handle_over(dispatcher_end, Arc::new(Mutex::new(false)));
    let publisher = Arc::new(Recording::default());
    let publisher_for_connect = publisher.clone();
    let connect =
        std::thread::spawn(move || PiConnection::connect_with(publisher_for_connect, handle));

    let req = read_line(&mut fake_child);
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&req).unwrap()["type"],
        "get_state"
    );
    write_line(&mut fake_child, &resp(&extract_id(&req), "get_state", true));

    let conn = connect.join().unwrap().unwrap();
    assert_eq!(conn.engine.lock().unwrap().state(), RuntimeRunState::Idle);

    // FR acceptance: "Two prompts use one child."
    for _ in 0..2 {
        let conn2 = conn.clone();
        let submit = std::thread::spawn(move || {
            conn2.submit(RuntimeSubmission {
                text: "hi".into(),
                attachments: Vec::new(),
            })
        });
        let req = read_line(&mut fake_child);
        let v: serde_json::Value = serde_json::from_str(&req).unwrap();
        assert_eq!(v["type"], "prompt");
        write_line(
            &mut fake_child,
            &resp(v["id"].as_str().unwrap(), "prompt", true),
        );
        submit.join().unwrap().unwrap();
        write_line(&mut fake_child, r#"{"type":"agent_settled"}"#);
        wait_until(|| conn.engine.lock().unwrap().state() == RuntimeRunState::Idle);
    }

    conn.shutdown().unwrap();
    assert!(publisher
        .run_states
        .lock()
        .unwrap()
        .contains(&RuntimeRunState::Running));
}

/// pi-session-durability FR-1/FR-3: the handshake's reported `sessionFile`
/// (and `runtimeId`) survive into `handshake_info()` — what `recovery::
/// run_reconnect` cross-checks a resumed connection's identity against.
#[test]
fn handshake_info_captures_the_reported_session_file_and_runtime_id() {
    let (dispatcher_end, mut fake_child) = test_pipe_pair();
    let handle = handle_over(dispatcher_end, Arc::new(Mutex::new(false)));
    let publisher = Arc::new(Recording::default());
    let publisher_for_connect = publisher.clone();
    let connect =
        std::thread::spawn(move || PiConnection::connect_with(publisher_for_connect, handle));
    let req = read_line(&mut fake_child);
    write_line(
        &mut fake_child,
        &serde_json::json!({
            "id": extract_id(&req), "command": "get_state", "success": true,
            "data": { "runtimeId": "rt-1", "sessionFile": "/data/runtimes/pi/sessions/s1/native-1.jsonl" }
        })
        .to_string(),
    );
    let conn = connect.join().unwrap().unwrap();
    let info = conn.handshake_info();
    assert_eq!(info.runtime_id.as_deref(), Some("rt-1"));
    assert_eq!(
        info.session_file.as_deref(),
        Some("/data/runtimes/pi/sessions/s1/native-1.jsonl")
    );
    conn.shutdown().unwrap();
}

/// pi-session-durability FR-4: `get_entries` round-trips over the SAME
/// dispatch machinery as `prompt`/`interrupt` — a fake child answers with a
/// `data` payload and the caller gets it back verbatim, with no run-state
/// change (unlike `prompt`, this is read-only).
#[test]
fn get_entries_round_trips_the_response_data_with_no_run_state_change() {
    let (dispatcher_end, mut fake_child) = test_pipe_pair();
    let handle = handle_over(dispatcher_end, Arc::new(Mutex::new(false)));
    let publisher = Arc::new(Recording::default());
    let publisher_for_connect = publisher.clone();
    let connect =
        std::thread::spawn(move || PiConnection::connect_with(publisher_for_connect, handle));
    let req = read_line(&mut fake_child);
    write_line(&mut fake_child, &resp(&extract_id(&req), "get_state", true));
    let conn = connect.join().unwrap().unwrap();

    let conn2 = conn.clone();
    let fetch = std::thread::spawn(move || conn2.get_entries(Some("entry-3".into())));
    let req = read_line(&mut fake_child);
    let v: serde_json::Value = serde_json::from_str(&req).unwrap();
    assert_eq!(v["type"], "get_entries");
    assert_eq!(v["cursor"], "entry-3");
    write_line(
        &mut fake_child,
        &serde_json::json!({
            "id": v["id"], "command": "get_entries", "success": true,
            "data": { "entries": [{"id": "e1", "role": "user", "text": "hi"}], "leafId": "e1" }
        })
        .to_string(),
    );
    let resp = fetch.join().unwrap().unwrap();
    assert_eq!(resp.data.unwrap()["leafId"], "e1");
    assert_eq!(conn.engine.lock().unwrap().state(), RuntimeRunState::Idle);
    conn.shutdown().unwrap();
}

#[test]
fn eof_after_the_handshake_fails_the_connection_once_and_refuses_further_submits() {
    let (dispatcher_end, mut fake_child) = test_pipe_pair();
    let handle = handle_over(dispatcher_end, Arc::new(Mutex::new(false)));
    let publisher = Arc::new(Recording::default());
    let publisher_for_connect = publisher.clone();
    let connect =
        std::thread::spawn(move || PiConnection::connect_with(publisher_for_connect, handle));
    let req = read_line(&mut fake_child);
    write_line(&mut fake_child, &resp(&extract_id(&req), "get_state", true));
    let conn = connect.join().unwrap().unwrap();

    drop(fake_child); // EOF on the dispatcher's stdout
    wait_until(|| conn.engine.lock().unwrap().is_failed());

    assert!(conn
        .submit(RuntimeSubmission {
            text: "x".into(),
            attachments: Vec::new(),
        })
        .is_err());
    assert_eq!(publisher.failures.lock().unwrap().len(), 1); // exactly once
}

/// pi-transcript-events FR-1/FR-6: a transcript-shaped line off the wire
/// reaches `TranscriptReducer` and comes back out through the SAME
/// publisher `run_state`/`failure` use — not lost to `ProtocolEngine`'s
/// own "unknown event kind" classification of the same line.
#[test]
fn a_transcript_event_line_is_normalized_and_published() {
    let (dispatcher_end, mut fake_child) = test_pipe_pair();
    let handle = handle_over(dispatcher_end, Arc::new(Mutex::new(false)));
    let publisher = Arc::new(Recording::default());
    let publisher_for_connect = publisher.clone();
    let connect =
        std::thread::spawn(move || PiConnection::connect_with(publisher_for_connect, handle));
    let req = read_line(&mut fake_child);
    write_line(&mut fake_child, &resp(&extract_id(&req), "get_state", true));
    let conn = connect.join().unwrap().unwrap();

    write_line(
        &mut fake_child,
        r#"{"type":"message_start","role":"user","messageId":"m1","text":"hi"}"#,
    );
    wait_until(|| !publisher.transcripts.lock().unwrap().is_empty());
    match &publisher.transcripts.lock().unwrap()[0] {
        RuntimeEventPayload::MessageUser { text, .. } => assert_eq!(text, "hi"),
        other => panic!("expected message.user, got {other:?}"),
    }
    conn.shutdown().unwrap();
}

/// pi-transcript-events FR-1 (review round 3): a representative batch of
/// every FR-1 transcript event kind must produce zero diagnostics and zero
/// failures — the live, `PiConnection`-level counterpart of `protocol.rs`'s
/// `fr1_transcript_events_produce_no_diagnostic_or_error`. A trailing
/// `interrupt` round trip forces the reader thread past every earlier line
/// (same single TCP stream ⇒ strict ordering) before this asserts, so there
/// is no race against the reader's own processing.
#[test]
fn fr1_transcript_traffic_produces_no_diagnostics_or_failures() {
    let (dispatcher_end, mut fake_child) = test_pipe_pair();
    let handle = handle_over(dispatcher_end, Arc::new(Mutex::new(false)));
    let publisher = Arc::new(Recording::default());
    let publisher_for_connect = publisher.clone();
    let connect =
        std::thread::spawn(move || PiConnection::connect_with(publisher_for_connect, handle));
    let req = read_line(&mut fake_child);
    write_line(&mut fake_child, &resp(&extract_id(&req), "get_state", true));
    let conn = connect.join().unwrap().unwrap();

    for line in [
        r#"{"type":"message_start","role":"user","messageId":"m1","text":"hi"}"#,
        r#"{"type":"message_start","role":"assistant","messageId":"m2"}"#,
        r#"{"type":"content_delta","messageId":"m2","contentIndex":0,"delta":{"type":"text","text":"hi"}}"#,
        r#"{"type":"text_end","messageId":"m2","contentIndex":0}"#,
        r#"{"type":"message_end","messageId":"m2","role":"assistant","content":[{"type":"text","text":"hi"}]}"#,
        r#"{"type":"toolcall_start","toolCallId":"t1","name":"Read"}"#,
        r#"{"type":"toolcall_delta","toolCallId":"t1","inputDelta":"{}"}"#,
        r#"{"type":"toolcall_end","toolCallId":"t1","input":"{}"}"#,
        r#"{"type":"tool_execution_start","toolCallId":"t1"}"#,
        r#"{"type":"tool_execution_update","toolCallId":"t1","progress":"…"}"#,
        r#"{"type":"tool_execution_end","toolCallId":"t1","isError":false,"output":"ok"}"#,
        r#"{"type":"compaction_start"}"#,
        r#"{"type":"compaction_end"}"#,
        r#"{"type":"retry","reason":"rate limited"}"#,
        r#"{"type":"queue_update","queued":1}"#,
    ] {
        write_line(&mut fake_child, line);
    }

    let conn2 = conn.clone();
    let cancel = std::thread::spawn(move || conn2.cancel());
    let req = read_line(&mut fake_child);
    let v: serde_json::Value = serde_json::from_str(&req).unwrap();
    assert_eq!(v["type"], "interrupt");
    write_line(
        &mut fake_child,
        &resp(v["id"].as_str().unwrap(), "interrupt", true),
    );
    cancel.join().unwrap().unwrap();

    assert!(
        publisher.diagnostics.lock().unwrap().is_empty(),
        "FR-1 transcript traffic must not produce any diagnostic: {:?}",
        publisher.diagnostics.lock().unwrap()
    );
    assert!(publisher.failures.lock().unwrap().is_empty());
    conn.shutdown().unwrap();
}

/// pi-transcript-events FR-7: baseline capabilities mark `images`
/// unavailable for every Pi connection in this MVP — `submit` must refuse
/// a prompt referencing an image attachment BEFORE writing anything to
/// the wire, rather than sending it and letting the model choke on it.
#[test]
fn submit_rejects_an_image_attachment_before_writing_to_the_wire_when_unsupported() {
    let (dispatcher_end, mut fake_child) = test_pipe_pair();
    let handle = handle_over(dispatcher_end, Arc::new(Mutex::new(false)));
    let publisher = Arc::new(Recording::default());
    let publisher_for_connect = publisher.clone();
    let connect =
        std::thread::spawn(move || PiConnection::connect_with(publisher_for_connect, handle));
    let req = read_line(&mut fake_child);
    write_line(&mut fake_child, &resp(&extract_id(&req), "get_state", true));
    let conn = connect.join().unwrap().unwrap();

    let attachment = crate::session::attachments::Attachment {
        id: "a1".into(),
        session_id: "s1".into(),
        kind: "image".into(),
        origin_path: None,
        stored_path: "/does/not/matter.png".into(),
        ref_path: ".francois/attachments/a3f9c1e2/shot.png".into(),
        name: "shot.png".into(),
        bytes: 1,
        copied: true,
        state: "sent".into(),
        created_at: 0,
    };
    let err = conn
        .submit(RuntimeSubmission {
            text: "look at @.francois/attachments/a3f9c1e2/shot.png".into(),
            attachments: vec![attachment],
        })
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::RuntimeUnsupported);

    // Nothing reached the wire: the fake child's socket has no pending
    // bytes to read within a short bound.
    fake_child
        .set_read_timeout(Some(Duration::from_millis(50)))
        .unwrap();
    let mut buf = [0u8; 1];
    assert!(matches!(
        fake_child.read(&mut buf),
        Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut)
    ));
    conn.shutdown().unwrap();
}

/// pi-skills-capabilities FR-3: `skills`/`resumableSessions` are available
/// the instant a connection exists; the seven FR-3-named-false keys each
/// carry their OWN reason (never the generic placeholder).
#[test]
fn baseline_capabilities_match_fr3_after_a_bare_handshake_with_no_model() {
    let (dispatcher_end, mut fake_child) = test_pipe_pair();
    let handle = handle_over(dispatcher_end, Arc::new(Mutex::new(false)));
    let connect = std::thread::spawn(move || {
        PiConnection::connect_with(Arc::new(Recording::default()), handle)
    });
    let req = read_line(&mut fake_child);
    write_line(&mut fake_child, &resp(&extract_id(&req), "get_state", true));
    let conn = connect.join().unwrap().unwrap();

    let caps = conn.capabilities();
    // Every key present, every reason within bounds, every available/reason
    // pairing valid — the same gate `install_runtime_connection` applies
    // before a connection is ever installed onto a session.
    assert!(crate::session::adapter::validate_capabilities(&caps).is_ok());
    for available_key in [
        "skills",
        "resumableSessions",
        "steering",
        "followUps",
        "compaction",
        "modelSwitching",
        "contextMetrics",
        "costMetrics",
    ] {
        let state = caps.get(available_key).unwrap();
        assert!(state.available, "{available_key} must be available");
        assert!(state.reason.is_none());
    }
    let mut reasons = std::collections::HashSet::new();
    for unavailable_key in [
        "skillsInstall",
        "mcp",
        "subagents",
        "workflows",
        "permissions",
        "remoteControl",
        "usageBar",
    ] {
        let state = caps.get(unavailable_key).unwrap();
        assert!(!state.available, "{unavailable_key} must be unavailable");
        let reason = state
            .reason
            .clone()
            .expect("every false key carries a reason");
        assert_ne!(
            reason, "not yet supported for Pi sessions",
            "{unavailable_key} must have its own reason"
        );
        assert!(
            reasons.insert(reason),
            "{unavailable_key} must not repeat another key's reason"
        );
    }
    conn.shutdown().unwrap();
}

/// pi-skills-capabilities FR-3: `images` follows the model the handshake
/// actually reported — a connection whose `get_state` names a model with
/// `input: ["text","image"]` must report `images` available.
#[test]
fn images_capability_follows_the_handshake_reported_model_input() {
    let (dispatcher_end, mut fake_child) = test_pipe_pair();
    let handle = handle_over(dispatcher_end, Arc::new(Mutex::new(false)));
    let connect = std::thread::spawn(move || {
        PiConnection::connect_with(Arc::new(Recording::default()), handle)
    });
    let req = read_line(&mut fake_child);
    write_line(
        &mut fake_child,
        &serde_json::json!({
            "id": extract_id(&req), "command": "get_state", "success": true,
            "data": {
                "model": {
                    "ref": { "providerId": "anthropic", "modelId": "claude-sonnet-5" },
                    "displayName": "Sonnet 5",
                    "input": ["text", "image"],
                    "contextWindow": 200_000,
                    "maxOutputTokens": 8_192,
                    "reasoning": true,
                    "authState": "verified",
                    "availability": "available",
                }
            }
        })
        .to_string(),
    );
    let conn = connect.join().unwrap().unwrap();
    let caps = conn.capabilities();
    let images = caps.get("images").unwrap();
    assert!(images.available);
    assert!(images.reason.is_none());
    conn.shutdown().unwrap();
}

/// pi-skills-capabilities FR-1: `list_commands` dispatches `get_commands`
/// and maps the response through `adapter::pi::resources`'s ONE mapping
/// function.
#[test]
fn list_commands_dispatches_get_commands_and_maps_the_response() {
    let (dispatcher_end, mut fake_child) = test_pipe_pair();
    let handle = handle_over(dispatcher_end, Arc::new(Mutex::new(false)));
    let connect = std::thread::spawn(move || {
        PiConnection::connect_with(Arc::new(Recording::default()), handle)
    });
    let req = read_line(&mut fake_child);
    write_line(&mut fake_child, &resp(&extract_id(&req), "get_state", true));
    let conn = connect.join().unwrap().unwrap();

    let conn2 = conn.clone();
    let call = std::thread::spawn(move || conn2.list_commands());
    let req = read_line(&mut fake_child);
    let v: serde_json::Value = serde_json::from_str(&req).unwrap();
    assert_eq!(v["type"], "get_commands");
    write_line(
        &mut fake_child,
        &serde_json::json!({
            "id": v["id"], "command": "get_commands", "success": true,
            "data": { "commands": [
                { "invocation": "/skill:review", "description": "review a diff", "source": "skill", "loaded": true }
            ] }
        })
        .to_string(),
    );
    let commands = call.join().unwrap().unwrap();
    assert_eq!(commands.len(), 1);
    assert_eq!(commands[0].invocation, "/skill:review");
    assert!(commands[0].loaded);
    conn.shutdown().unwrap();
}

/// pi-skills-capabilities FR-6: an event whose `type` mentions "extension"
/// is never fed to the correlation engine's ordinary classification — it
/// surfaces a policy failure AND terminates the tracked child, rather than
/// being counted/ignored like any other unknown event kind.
#[test]
fn an_extension_event_surfaces_a_policy_failure_and_stops_the_child() {
    let (dispatcher_end, mut fake_child) = test_pipe_pair();
    let kill_flag = Arc::new(Mutex::new(false));
    let handle = handle_over(dispatcher_end, kill_flag.clone());
    let publisher = Arc::new(Recording::default());
    let publisher_for_connect = publisher.clone();
    let connect =
        std::thread::spawn(move || PiConnection::connect_with(publisher_for_connect, handle));
    let req = read_line(&mut fake_child);
    write_line(&mut fake_child, &resp(&extract_id(&req), "get_state", true));
    let _conn = connect.join().unwrap().unwrap();

    write_line(&mut fake_child, r#"{"type":"extension_ui_request"}"#);
    wait_until(|| *kill_flag.lock().unwrap());
    wait_until(|| {
        publisher
            .failures
            .lock()
            .unwrap()
            .iter()
            .any(|(code, _)| *code == ErrorCode::RuntimeUnsupported)
    });
}

/// pi-transcript-events FR-9: an EOF finalizes any still-open assistant
/// text as `interrupted` — never silently dropped, never `complete`.
#[test]
fn eof_finalizes_open_transcript_state_as_interrupted() {
    let (dispatcher_end, mut fake_child) = test_pipe_pair();
    let handle = handle_over(dispatcher_end, Arc::new(Mutex::new(false)));
    let publisher = Arc::new(Recording::default());
    let publisher_for_connect = publisher.clone();
    let connect =
        std::thread::spawn(move || PiConnection::connect_with(publisher_for_connect, handle));
    let req = read_line(&mut fake_child);
    write_line(&mut fake_child, &resp(&extract_id(&req), "get_state", true));
    let _conn = connect.join().unwrap().unwrap();

    write_line(
        &mut fake_child,
        r#"{"type":"content_delta","messageId":"m1","contentIndex":0,"delta":{"type":"text","text":"partial"}}"#,
    );
    wait_until(|| !publisher.transcripts.lock().unwrap().is_empty());

    drop(fake_child); // EOF on the dispatcher's stdout
    wait_until(|| {
        publisher
            .transcripts
            .lock()
            .unwrap()
            .iter()
            .any(|e| matches!(e, RuntimeEventPayload::AssistantComplete { outcome, .. } if outcome == "interrupted"))
    });
}

#[test]
fn shutdown_terminates_the_tracked_process_when_it_does_not_exit_on_its_own_and_is_idempotent() {
    let (dispatcher_end, mut fake_child) = test_pipe_pair();
    let kill_flag = Arc::new(Mutex::new(false));
    let handle = handle_over(dispatcher_end, kill_flag.clone());
    let publisher = Arc::new(Recording::default());
    let connect = std::thread::spawn(move || PiConnection::connect_with(publisher, handle));
    let req = read_line(&mut fake_child);
    write_line(&mut fake_child, &resp(&extract_id(&req), "get_state", true));
    let conn = connect.join().unwrap().unwrap();

    conn.shutdown().unwrap();
    assert!(
        *kill_flag.lock().unwrap(),
        "a process that never exits on its own must be terminated"
    );
    conn.shutdown().unwrap(); // FR-7: session_remove + app-exit may both call this
}

#[test]
fn a_handshake_that_never_answers_times_out_bounded_and_kills_the_child() {
    let (dispatcher_end, _fake_child) = test_pipe_pair(); // never responds
    let kill_flag = Arc::new(Mutex::new(false));
    let handle = handle_over(dispatcher_end, kill_flag.clone());
    let publisher = Arc::new(Recording::default());
    let deadlines = Deadlines {
        init: Duration::from_millis(100),
        read_only: Duration::from_millis(100),
        prompt: Duration::from_millis(100),
        compaction: Duration::from_millis(100),
    };
    let started = std::time::Instant::now();
    let err = PiConnection::connect_with_deadlines(publisher, handle, deadlines)
        .err()
        .unwrap();
    assert_eq!(err.code, ErrorCode::RuntimeTimeout);
    assert!(started.elapsed() < Duration::from_secs(2));
    assert!(*kill_flag.lock().unwrap());
}

/// LIVE end-to-end check of the one thing the fake-process tests above
/// cannot prove: that a REAL certified `pi` binary, spawned twice against the
/// SAME directory, reports the SAME native conversation identity on its
/// second handshake once given `--resume` — pi-session-durability's whole
/// acceptance criterion "restart and send resumes the same native ID and
/// remembered context" (FR-1–3), driven at the process boundary rather than
/// through the full session-engine/`AppHandle` layer (this crate wires up no
/// `AppHandle` test harness — see `recovery.rs`'s own module doc). No prompt
/// is ever sent, matching FR-7's "no model call ... issued by
/// session_reconnect".
///
/// `#[ignore]` because it needs a certified Pi install (`pi --version`
/// matching this build's manifest) on PATH, and a configured provider
/// account — it spawns TWO real Pi children. Run with:
///   cargo test -- --ignored real_pi_child_reports_the_same_native_identity_on_resume --nocapture
///
/// Override `FRANCOIS_PI_PROBE_CWD` to point at a directory Pi has already
/// been run in interactively (so it does not park on a first-run consent
/// dialog), `FRANCOIS_PI_PROBE_PROVIDER`/`FRANCOIS_PI_PROBE_MODEL` to match a
/// provider/model this Pi installation is actually configured for, and
/// `FRANCOIS_PI_PROBE_CONFIG_DIR` to the account directory `process::spawn`
/// should pin (pi-session-durability HIGH remediation: `spawn` now refuses a
/// context with no pinned account directory) — unset, this run gets no Pi
/// account directory at all and fails fast with that same refusal.
#[test]
#[ignore = "live: needs a certified Pi install + provider auth; spawns two real Pi children"]
fn real_pi_child_reports_the_same_native_identity_on_resume() {
    use crate::session::adapter::{RuntimeLaunchPolicy, RuntimeModelRef, RuntimeProfileSnapshot};

    let cwd = std::env::var("FRANCOIS_PI_PROBE_CWD").unwrap_or_else(|_| {
        std::env::current_dir()
            .unwrap()
            .to_string_lossy()
            .to_string()
    });
    let provider =
        std::env::var("FRANCOIS_PI_PROBE_PROVIDER").unwrap_or_else(|_| "anthropic".into());
    let model_id =
        std::env::var("FRANCOIS_PI_PROBE_MODEL").unwrap_or_else(|_| "claude-sonnet-5".into());

    let ctx = |resume: Option<String>| RuntimeConnectContext {
        session_id: crate::ids::uuid(),
        cwd: cwd.clone(),
        runtime: "native".into(),
        worktree_distro: None,
        account_id: crate::ids::uuid(),
        launch_policy: RuntimeLaunchPolicy {
            permission_mode: "default".into(),
            allow_git: false,
        },
        profile_snapshot: RuntimeProfileSnapshot {
            system_prompt: None,
            extra_args: Vec::new(),
        },
        model: RuntimeModelRef {
            provider_id: provider.clone(),
            model_id: model_id.clone(),
        },
        resume,
        config_dir: std::env::var("FRANCOIS_PI_PROBE_CONFIG_DIR").ok(),
        inherit_environment_credentials: false,
        pi_profile_settings: None,
        pi_launch_prompt: None,
        resource_policy: Some(crate::session::adapter::pi::RuntimeResourcePolicy {
            project_resources: crate::session::adapter::pi::resources::ProjectResources::Ignore,
            extensions: crate::session::adapter::pi::resources::ExtensionsPolicy::Disabled,
            acknowledged_unrestricted_tools: true,
        }),
    };

    let handle = process::spawn(&ctx(None)).expect("a certified pi must be on PATH");
    let conn = PiConnection::connect_with(Arc::new(Recording::default()), handle)
        .expect("first handshake must succeed");
    let first = conn.handshake_info();
    conn.shutdown().unwrap();
    let native_session_id = first
        .runtime_id
        .expect("a real Pi handshake must report an id to resume against");

    let handle2 = process::spawn(&ctx(Some(native_session_id.clone())))
        .expect("a second certified pi must spawn");
    let conn2 = PiConnection::connect_with(Arc::new(Recording::default()), handle2)
        .expect("resumed handshake must succeed");
    let second = conn2.handshake_info();
    conn2.shutdown().unwrap();

    assert_eq!(
        second.session_file, first.session_file,
        "a --resume handshake must report the SAME native conversation file"
    );
    assert_eq!(
        second.runtime_id,
        Some(native_session_id),
        "a --resume handshake must report the SAME native runtime id"
    );
}

fn wait_until(mut condition: impl FnMut() -> bool) {
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    while !condition() {
        assert!(
            std::time::Instant::now() < deadline,
            "condition never became true"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
}
