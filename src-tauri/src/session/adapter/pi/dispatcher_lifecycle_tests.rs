// Lifecycle tests for the Pi dispatcher: what happens when a connection ENDS
// — an EOF, a dispatch-side failure, a stalled write, `shutdown()` — plus the
// concurrency the round trip is allowed. Split out of dispatcher_tests.rs
// (which keeps the wire-level tests) for the ~1000-line cap; the fake child
// itself is shared, in `dispatcher_testutil.rs`.

use super::testutil::*;
use super::*;
use std::sync::atomic::{AtomicBool, Ordering};

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

/// HIGH (review round 4 follow-up): the READER's own terminal paths must reap
/// the child too. A read error is not an EOF — the pipe broke, which says
/// nothing about whether the process is still running — so a connection that
/// ends this way used to leave a live child behind: the same leak the
/// dispatch-side finding was about.
#[test]
fn a_read_error_retires_the_connection_and_reaps_the_child() {
    let (dispatcher_end, mut fake_child) = test_pipe_pair();
    let kill_flag = Arc::new(Mutex::new(false));
    let fault = Arc::new(AtomicBool::new(false));
    let kills = Arc::new(Mutex::new(0u32));
    let handle = handle_with(
        dispatcher_end,
        kill_flag.clone(),
        FakeChildOpts {
            stdout_fault: Some(fault.clone()),
            kills: Some(kills.clone()),
            ..Default::default()
        },
    );
    let publisher = Arc::new(Recording::default());
    let publisher_for_connect = publisher.clone();
    let connect =
        std::thread::spawn(move || PiConnection::connect_with(publisher_for_connect, handle));
    let req = read_line(&mut fake_child);
    write_line(&mut fake_child, &resp(&extract_id(&req), "get_state", true));
    let conn = connect.join().unwrap().unwrap();

    // The child's pipe resets while the child itself keeps running.
    fault.store(true, Ordering::SeqCst);

    wait_until(|| *kill_flag.lock().unwrap());
    assert_eq!(*kills.lock().unwrap(), 1, "reaped exactly once");
    wait_until(|| {
        conn.reader
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|reader| reader.is_finished())
    });
    assert_eq!(publisher.failures.lock().unwrap().len(), 1);
}

/// The idempotence half: a child that already exited is never killed, and a
/// `shutdown()` after the reader has already retired the connection publishes
/// no second terminal outcome and runs no second reap.
#[test]
fn an_eof_from_an_already_exited_child_neither_re_kills_nor_re_publishes() {
    let (dispatcher_end, mut fake_child) = test_pipe_pair();
    // `wait_timeout` reports "already exited" from the start.
    let kills = Arc::new(Mutex::new(0u32));
    let handle = handle_with(
        dispatcher_end,
        Arc::new(Mutex::new(true)),
        FakeChildOpts {
            kills: Some(kills.clone()),
            ..Default::default()
        },
    );
    let publisher = Arc::new(Recording::default());
    let publisher_for_connect = publisher.clone();
    let connect =
        std::thread::spawn(move || PiConnection::connect_with(publisher_for_connect, handle));
    let req = read_line(&mut fake_child);
    write_line(&mut fake_child, &resp(&extract_id(&req), "get_state", true));
    let conn = connect.join().unwrap().unwrap();

    drop(fake_child); // EOF on the dispatcher's stdout
    wait_until(|| conn.engine.lock().unwrap().is_failed());
    wait_until(|| {
        conn.reader
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|reader| reader.is_finished())
    });
    assert_eq!(*kills.lock().unwrap(), 0, "an exited child is not killed");
    assert_eq!(publisher.failures.lock().unwrap().len(), 1);

    conn.shutdown().unwrap();
    assert_eq!(*kills.lock().unwrap(), 0, "…and still not on shutdown");
    assert_eq!(
        publisher.failures.lock().unwrap().len(),
        1,
        "the terminal outcome is published exactly once"
    );
}

/// HIGH (review round 4): a dispatch-side failure is terminal for the WHOLE
/// connection, so it must RETIRE it — the reader thread exits and the child
/// is reaped — rather than leaving a live reader feeding a session that has
/// already failed, with the child never terminated.
#[test]
fn a_dispatch_side_failure_retires_the_connection_and_reaps_the_child() {
    let (dispatcher_end, mut fake_child) = test_pipe_pair();
    let kill_flag = Arc::new(Mutex::new(false));
    let handle = handle_over(dispatcher_end, kill_flag.clone());
    let publisher = Arc::new(Recording::default());
    let publisher_for_connect = publisher.clone();
    // Only the verb deadline is shortened: the handshake still needs room for
    // this test's own round trip.
    let deadlines = Deadlines {
        init: Duration::from_secs(2),
        read_only: Duration::from_millis(100),
        prompt: Duration::from_millis(100),
        compaction: Duration::from_millis(100),
    };
    let connect = std::thread::spawn(move || {
        PiConnection::connect_with_deadlines(publisher_for_connect, handle, deadlines)
    });
    let req = read_line(&mut fake_child);
    write_line(&mut fake_child, &resp(&extract_id(&req), "get_state", true));
    let conn = connect.join().unwrap().unwrap();

    // The command reaches the wire and the child never answers it — "timeout
    // after acceptance is ambiguous, not permission to replay", so the whole
    // connection fails rather than just this verb.
    let err = conn.cancel().unwrap_err();
    assert_eq!(err.code, ErrorCode::RuntimeTimeout);

    wait_until(|| *kill_flag.lock().unwrap());
    wait_until(|| {
        conn.reader
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|reader| reader.is_finished())
    });
}

/// The other half of the same finding: a line that arrives after a
/// dispatch-side failure is never normalized into the errored session. This
/// fake child reports itself as already exited, so retirement leaves the
/// socket open — which is what lets the test keep writing to it, and what
/// makes the reader's own exit depend on retirement alone rather than on a
/// closed pipe.
#[test]
fn a_retired_connection_normalizes_no_further_transcript_lines() {
    let (dispatcher_end, mut fake_child) = test_pipe_pair();
    let handle = handle_over(dispatcher_end, Arc::new(Mutex::new(true)));
    let publisher = Arc::new(Recording::default());
    let publisher_for_connect = publisher.clone();
    let deadlines = Deadlines {
        init: Duration::from_secs(2),
        read_only: Duration::from_millis(100),
        prompt: Duration::from_millis(100),
        compaction: Duration::from_millis(100),
    };
    let connect = std::thread::spawn(move || {
        PiConnection::connect_with_deadlines(publisher_for_connect, handle, deadlines)
    });
    let req = read_line(&mut fake_child);
    write_line(&mut fake_child, &resp(&extract_id(&req), "get_state", true));
    let conn = connect.join().unwrap().unwrap();

    assert_eq!(conn.cancel().unwrap_err().code, ErrorCode::RuntimeTimeout);

    write_line(
        &mut fake_child,
        r#"{"type":"message_start","role":"user","messageId":"m9","text":"after the failure"}"#,
    );
    wait_until(|| {
        conn.reader
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|reader| reader.is_finished())
    });
    assert!(
        !publisher.transcripts.lock().unwrap().iter().any(
            |e| matches!(e, RuntimeEventPayload::MessageUser { text, .. } if text == "after the failure")
        ),
        "a retired connection must not normalize anything further into its session"
    );
}

/// MED (review round 4): `shutdown()` must never queue behind a write that a
/// child has stopped draining — that is what made a stuck Pi child able to
/// stop the whole app from quitting. The kill is what unblocks the write, so
/// shutdown cannot be allowed to wait for it first.
#[test]
fn shutdown_stays_bounded_while_a_write_is_stalled_on_a_child_that_never_drains_stdin() {
    let (dispatcher_end, mut fake_child) = test_pipe_pair();
    let kill_flag = Arc::new(Mutex::new(false));
    let gate = Arc::new(StdinGate::default());
    let handle = handle_with_gate(dispatcher_end, kill_flag.clone(), gate.clone());
    let publisher = Arc::new(Recording::default());
    let connect = std::thread::spawn(move || PiConnection::connect_with(publisher, handle));
    let req = read_line(&mut fake_child);
    write_line(&mut fake_child, &resp(&extract_id(&req), "get_state", true));
    let conn = connect.join().unwrap().unwrap();

    gate.stall();
    let stalled_conn = conn.clone();
    let stalled = std::thread::spawn(move || stalled_conn.cancel());
    wait_until(|| gate.parked());

    let done = Arc::new(AtomicBool::new(false));
    let shutdown_conn = conn.clone();
    let done_flag = done.clone();
    std::thread::spawn(move || {
        let _ = shutdown_conn.shutdown();
        done_flag.store(true, Ordering::SeqCst);
    });
    wait_until(|| done.load(Ordering::SeqCst));

    assert!(
        *kill_flag.lock().unwrap(),
        "a child that never drains its stdin must be terminated, not waited on"
    );
    assert!(
        stalled.join().unwrap().is_err(),
        "the write that was parked on the dead child must fail, not succeed"
    );
}

/// §4 (review round 4): a verb must not serialise behind another verb's whole
/// round trip — only the WRITE is exclusive. Responses are correlated by
/// request id (`ProtocolEngine::send` registers one pending entry per id and
/// `on_response` routes by it), so they may also arrive in either order.
#[test]
fn a_second_verb_reaches_the_wire_while_the_first_is_still_awaiting_its_answer() {
    let (dispatcher_end, mut fake_child) = test_pipe_pair();
    let handle = handle_over(dispatcher_end, Arc::new(Mutex::new(false)));
    let publisher = Arc::new(Recording::default());
    let publisher_for_connect = publisher.clone();
    let connect =
        std::thread::spawn(move || PiConnection::connect_with(publisher_for_connect, handle));
    let req = read_line(&mut fake_child);
    write_line(&mut fake_child, &resp(&extract_id(&req), "get_state", true));
    let conn = connect.join().unwrap().unwrap();

    let first_conn = conn.clone();
    let first = std::thread::spawn(move || first_conn.get_entries(None));
    let first_req: serde_json::Value = serde_json::from_str(&read_line(&mut fake_child)).unwrap();
    assert_eq!(first_req["type"], "get_entries");

    // The first command is still outstanding (unanswered) here.
    let second_conn = conn.clone();
    let second = std::thread::spawn(move || second_conn.cancel());
    let second_req: serde_json::Value = serde_json::from_str(&read_line(&mut fake_child)).unwrap();
    assert_eq!(
        second_req["type"], "interrupt",
        "a second verb must reach the wire without waiting for the first's answer"
    );

    write_line(
        &mut fake_child,
        &resp(second_req["id"].as_str().unwrap(), "interrupt", true),
    );
    write_line(
        &mut fake_child,
        &resp(first_req["id"].as_str().unwrap(), "get_entries", true),
    );
    second.join().unwrap().unwrap();
    first.join().unwrap().unwrap();
    conn.shutdown().unwrap();
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
