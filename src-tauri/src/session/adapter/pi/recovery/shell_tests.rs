// The reconnect I/O SHELL, driven by a fake child — the sequencing
// `recovery.rs`'s module doc used to list as untested: handshake →
// `get_entries` → rebuild → the merged transcript actually on disk.
//
// `run_reconnect` itself needs an `AppHandle` (the account gate, the spawn,
// `install_runtime_connection`, `emit`) and this crate wires up no `AppHandle`
// test harness. What it does NOT need one for is the part that can lose data,
// and that part is reachable through the two seams the shell is built from:
// `fetch_and_rebuild` takes its fetch as a closure, `commit_rebuild` takes its
// two writes as closures. Both are driven here against a REAL `PiConnection`
// over a REAL socket, and a REAL transcript file in a temp dir.
//
// Every wait is BOUNDED (rule: a fake-process test must fail, never hang —
// a hung run also strands the shared cargo lock).

use super::*;
use crate::session::persistence::parse_transcript;
use crate::session::persistence::transcript_file::replace_at;
use crate::session::BlockKind;

// ---------------------------------------------------------- the fake child
//
// ONE fake child for the whole `adapter::pi` module — `dispatcher`'s own
// `mod testutil`, widened to `pub(in crate::session::adapter::pi)` for exactly
// this. This file used to carry a copy of it (as `controls.rs` did), each with
// its own hand-rolled read deadline; every wait still bounded, now in one
// place instead of three.

use super::super::dispatcher::testutil::{connected, json_of, read_line, write_line};

fn temp_transcript(tag: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "francois-pi-recovery-shell-{tag}-{}-{}",
        std::process::id(),
        crate::ids::uuid()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir.join("s1.jsonl")
}

fn record_for(cwd: &str) -> PiResumeRecord {
    PiResumeRecord::new(
        "native-1".into(),
        format!("{cwd}/native-1.jsonl"),
        "pi-acct-1".into(),
        "/home/user/.pi".into(),
        cwd.into(),
        "0.85.1".into(),
    )
}

// ---------------------------------------------------------- the shell itself

/// The whole point of the round-2 remediation, end to end over a real wire:
/// a reconnect fetches `get_entries`, merges what Pi sent with what only
/// François holds, and the file ON DISK afterwards carries BOTH — the two
/// messages Pi is the authority for, and the Tool execution row between them
/// that a rebuild used to delete.
#[test]
fn a_reconnect_writes_the_merged_transcript_to_disk() {
    let (conn, mut fake_child) = connected();
    let path = temp_transcript("merged");

    // What the session already holds: two rebuilt messages and, between them,
    // the execution row Pi's entries cannot reproduce.
    let previous = vec![
        BufBlock {
            text: "run the tests".into(),
            at: 10,
            native_entry_id: Some("e1".into()),
            ..BufBlock::new("b1", BlockKind::User)
        },
        BufBlock {
            tool: "Bash".into(),
            text: "npm test".into(),
            at: 20,
            ..BufBlock::new("tool-1", BlockKind::Tool)
        },
        BufBlock {
            text: "done".into(),
            at: 30,
            native_entry_id: Some("e2".into()),
            ..BufBlock::new("b2", BlockKind::Assistant)
        },
    ];
    replace_at(&path, &previous).unwrap();

    let conn_for_fetch = conn.clone();
    let previous_for_fetch = previous.clone();
    let fetch = std::thread::spawn(move || {
        fetch_and_rebuild(
            || conn_for_fetch.get_entries(None).map(|resp| resp.data),
            &previous_for_fetch,
        )
    });
    let req = read_line(&mut fake_child);
    assert_eq!(json_of(&req)["type"], "get_entries");
    write_line(
        &mut fake_child,
        &serde_json::json!({
            "id": json_of(&req)["id"], "command": "get_entries", "success": true,
            "data": {
                "entries": [
                    { "id": "e1", "role": "user", "text": "run the tests" },
                    { "id": "e2", "parentId": "e1", "role": "assistant", "text": "done" },
                ],
                "leafId": "e2",
            }
        })
        .to_string(),
    );
    let rebuild = fetch.join().unwrap().expect("a well-formed tree rebuilds");

    let committed = commit_rebuild(
        rebuild,
        &record_for("/repo"),
        |blocks| replace_at(&path, blocks),
        |_| panic!("the merged path appends nothing"),
    )
    .expect("the write succeeds");

    let on_disk = parse_transcript(&std::fs::read_to_string(&path).unwrap());
    assert_eq!(
        on_disk
            .iter()
            .map(|b| b.block_id.as_str())
            .collect::<Vec<_>>(),
        vec!["b1", "tool-1", "b2"],
        "the execution row between the two messages must survive the rebuild"
    );
    // ...with its `at` intact, and the tool's own fields with it.
    assert_eq!(on_disk[0].at, 10);
    assert_eq!(on_disk[1].tool, "Bash");
    assert_eq!(on_disk[1].at, 20);
    assert_eq!(committed.last_entry_id.as_deref(), Some("e2"));
    assert_eq!(committed.leaf_id.as_deref(), Some("e2"));
    assert_eq!(committed.buffer.map(|b| b.len()), Some(3));

    conn.shutdown().unwrap();
    std::fs::remove_dir_all(path.parent().unwrap()).ok();
}

/// §7: "corrupt parent chains fail with readable cached history". A payload
/// the rebuild cannot place must leave the file exactly as it was — the
/// invariant `recovery.rs`'s doc names as the one thing holding this
/// sequencing together, now asserted against a real fake child.
#[test]
fn a_refused_payload_leaves_the_transcript_on_disk_untouched() {
    let (conn, mut fake_child) = connected();
    let path = temp_transcript("refused");
    let previous = vec![BufBlock {
        text: "run the tests".into(),
        at: 10,
        native_entry_id: Some("e1".into()),
        ..BufBlock::new("b1", BlockKind::User)
    }];
    replace_at(&path, &previous).unwrap();
    let before = std::fs::read_to_string(&path).unwrap();

    let conn_for_fetch = conn.clone();
    let previous_for_fetch = previous.clone();
    let fetch = std::thread::spawn(move || {
        fetch_and_rebuild(
            || conn_for_fetch.get_entries(None).map(|resp| resp.data),
            &previous_for_fetch,
        )
    });
    let req = read_line(&mut fake_child);
    // A leaf Pi names but did not send — a truncated reply, not an empty
    // conversation.
    write_line(
        &mut fake_child,
        &serde_json::json!({
            "id": json_of(&req)["id"], "command": "get_entries", "success": true,
            "data": { "entries": [], "leafId": "e-missing" }
        })
        .to_string(),
    );
    let err = match fetch.join().unwrap() {
        Ok(_) => panic!("an unplaceable payload must be refused"),
        Err(e) => e,
    };

    assert_eq!(err.code, ErrorCode::RuntimeSessionCorrupt);
    assert_eq!(
        std::fs::read_to_string(&path).unwrap(),
        before,
        "a refused rebuild must never reach the transcript file"
    );
    conn.shutdown().unwrap();
    std::fs::remove_dir_all(path.parent().unwrap()).ok();
}

/// A reply this build's provisional decoder cannot read at all is a protocol
/// error, never an empty conversation — the parse and its refusal live WITH
/// the fetch, so this is the same one step.
#[test]
fn a_malformed_get_entries_payload_is_a_protocol_error() {
    let (conn, mut fake_child) = connected();
    let conn_for_fetch = conn.clone();
    let fetch = std::thread::spawn(move || {
        fetch_and_rebuild(
            || conn_for_fetch.get_entries(None).map(|resp| resp.data),
            &[],
        )
    });
    let req = read_line(&mut fake_child);
    write_line(
        &mut fake_child,
        &serde_json::json!({
            "id": json_of(&req)["id"], "command": "get_entries", "success": true,
            "data": { "nodes": [], "head": "e1" }
        })
        .to_string(),
    );
    let err = match fetch.join().unwrap() {
        Ok(_) => panic!("a reply spelled with different keys must be refused"),
        Err(e) => e,
    };
    assert_eq!(err.code, ErrorCode::RuntimeProtocolError);
    conn.shutdown().unwrap();
}

// ---------------------------------------------------------- commit_rebuild's ordering

/// A transcript that could not be written must fail the reconnect rather than
/// letting the session adopt a buffer no file backs — the anchors would then
/// point past what a restart can read.
#[test]
fn a_failed_transcript_write_fails_the_commit_and_keeps_the_old_anchors() {
    let record = record_for("/repo");
    // `CommittedRebuild` holds `BufBlock`s, which are deliberately not
    // `Debug` — so the refusal is unwrapped by hand.
    let err = match commit_rebuild(
        Rebuild::Merged {
            blocks: vec![BufBlock::new("b1", BlockKind::User)],
            last_entry_id: Some("e2".into()),
            leaf_id: Some("e2".into()),
        },
        &record,
        |_| Err(std::io::Error::other("disk full")),
        |_| panic!("nothing is appended on the merged path"),
    ) {
        Ok(_) => panic!("a failed write must fail the reconnect"),
        Err(e) => e,
    };
    assert_eq!(err.code, ErrorCode::Internal);
    assert!(err.message.contains("disk full"), "{}", err.message);
}

/// Remediation rule 4 on the keep-local path: ONE appended line, nothing
/// rewritten, and the record's existing anchors left exactly as they were.
#[test]
fn keep_local_appends_the_notice_and_rewrites_nothing() {
    let record = PiResumeRecord {
        last_entry_id: Some("e7".into()),
        leaf_id: Some("e7".into()),
        ..record_for("/repo")
    };
    let appended = std::cell::RefCell::new(Vec::new());
    let committed = commit_rebuild(
        Rebuild::KeepLocal {
            append: Some(BufBlock {
                text: "Delivery of the last message is unknown — it was not re-sent.".into(),
                tone: Some("warning".into()),
                ..BufBlock::new("notice-1", BlockKind::Notice)
            }),
        },
        &record,
        |_| panic!("the keep-local path must never REPLACE the transcript"),
        |block| appended.borrow_mut().push(block.block_id.clone()),
    )
    .unwrap();

    assert_eq!(appended.into_inner(), vec!["notice-1".to_string()]);
    assert!(committed.buffer.is_none(), "nothing is rebuilt");
    assert_eq!(
        committed.appended.map(|b| b.block_id),
        Some("notice-1".into())
    );
    assert_eq!(committed.last_entry_id.as_deref(), Some("e7"));
    assert_eq!(committed.leaf_id.as_deref(), Some("e7"));
    assert!(!committed.truncated);
}

/// ...and with nothing to append, the keep-local path writes NOTHING at all.
#[test]
fn keep_local_with_no_notice_writes_nothing() {
    let committed = commit_rebuild(
        Rebuild::KeepLocal { append: None },
        &record_for("/repo"),
        |_| panic!("the keep-local path must never REPLACE the transcript"),
        |_| panic!("there is nothing to append"),
    )
    .unwrap();
    assert!(committed.buffer.is_none());
    assert!(committed.appended.is_none());
}
