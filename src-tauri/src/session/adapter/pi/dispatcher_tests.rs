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
