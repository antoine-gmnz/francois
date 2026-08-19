// ---------- Registry test suite (unbound-panes remediation: split out of
// mod.rs to keep it under the ~1000-line soft cap; see `#[path]` include in
// mod.rs). Uses `super::testutil::*` — the fixture stays in mod.rs. ----------

use super::testutil::*;
use super::*;
use serde_json::json;

// ---------- test owner helpers ----------

fn sess(id: &str) -> ShellOwner {
    ShellOwner::Session {
        session_id: id.to_string(),
    }
}

fn proj(id: &str) -> ShellOwner {
    ShellOwner::Project {
        project_id: id.to_string(),
    }
}

// ---------- pure helpers ----------

#[test]
fn smallest_unused_ordinal_fills_gaps_before_extending() {
    assert_eq!(smallest_unused_ordinal([]), 1);
    assert_eq!(smallest_unused_ordinal([1, 2, 3]), 4);
    assert_eq!(smallest_unused_ordinal([1, 3]), 2); // the FR-3 example
    assert_eq!(smallest_unused_ordinal([2, 3]), 1);
}

#[test]
fn normalize_rename_trims_and_caps_at_40_chars() {
    match normalize_rename("  build  ") {
        RenameOutcome::Custom(n) => assert_eq!(n, "build"),
        RenameOutcome::Reset => panic!("expected Custom"),
    }
    let long = "x".repeat(50);
    match normalize_rename(&long) {
        RenameOutcome::Custom(n) => assert_eq!(n.chars().count(), 40),
        RenameOutcome::Reset => panic!("expected Custom"),
    }
}

#[test]
fn normalize_rename_empty_or_whitespace_resets() {
    assert!(matches!(normalize_rename(""), RenameOutcome::Reset));
    assert!(matches!(normalize_rename("   "), RenameOutcome::Reset));
}

// ---------- serde shapes (contract/shell-terminal.ts) ----------

#[test]
fn shell_owner_serializes_both_variants_to_the_contract_shape() {
    let session_owner = serde_json::to_value(sess("s1")).unwrap();
    assert_eq!(
        session_owner,
        json!({ "kind": "session", "sessionId": "s1" })
    );
    let project_owner = serde_json::to_value(proj("p1")).unwrap();
    assert_eq!(
        project_owner,
        json!({ "kind": "project", "projectId": "p1" })
    );
}

#[test]
fn shell_owner_round_trips_through_serde_both_variants() {
    let session_owner = sess("s1");
    let v = serde_json::to_value(&session_owner).unwrap();
    let back: ShellOwner = serde_json::from_value(v).unwrap();
    assert_eq!(back, session_owner);

    let project_owner = proj("p1");
    let v = serde_json::to_value(&project_owner).unwrap();
    let back: ShellOwner = serde_json::from_value(v).unwrap();
    assert_eq!(back, project_owner);
}

#[test]
fn shell_data_event_serializes_to_contract_shape_for_both_owner_kinds() {
    let ev = serde_json::to_value(ShellEvent::Data {
        shell_id: "sh1".into(),
        owner: sess("s1"),
        data: "hello".into(),
    })
    .unwrap();
    assert_eq!(
        ev,
        json!({ "type": "shell.data", "shellId": "sh1", "owner": { "kind": "session", "sessionId": "s1" }, "data": "hello" })
    );

    let ev = serde_json::to_value(ShellEvent::Data {
        shell_id: "sh1".into(),
        owner: proj("p1"),
        data: "hello".into(),
    })
    .unwrap();
    assert_eq!(
        ev,
        json!({ "type": "shell.data", "shellId": "sh1", "owner": { "kind": "project", "projectId": "p1" }, "data": "hello" })
    );
}

#[test]
fn shell_exit_event_serializes_to_contract_shape_for_both_owner_kinds() {
    let ev = serde_json::to_value(ShellEvent::Exit {
        shell_id: "sh1".into(),
        owner: sess("s1"),
        exit_code: 2,
    })
    .unwrap();
    assert_eq!(
        ev,
        json!({ "type": "shell.exit", "shellId": "sh1", "owner": { "kind": "session", "sessionId": "s1" }, "exitCode": 2 })
    );

    let ev = serde_json::to_value(ShellEvent::Exit {
        shell_id: "sh1".into(),
        owner: proj("p1"),
        exit_code: 2,
    })
    .unwrap();
    assert_eq!(
        ev,
        json!({ "type": "shell.exit", "shellId": "sh1", "owner": { "kind": "project", "projectId": "p1" }, "exitCode": 2 })
    );
}

#[test]
fn shell_ensure_data_serializes_to_contract_shape() {
    let data = ShellEnsureData {
        shell_id: "sh1".into(),
        shells: vec![],
        cols: 80,
        rows: 24,
        scrollback_replay: "hi".into(),
        exit_code: Some(2),
    };
    let v = serde_json::to_value(&data).unwrap();
    assert_eq!(
        v,
        json!({
            "shellId": "sh1",
            "shells": [],
            "cols": 80,
            "rows": 24,
            "scrollbackReplay": "hi",
            "exitCode": 2
        })
    );
}

#[test]
fn shell_ensure_data_omits_exit_code_when_none() {
    let data = ShellEnsureData {
        shell_id: "sh1".into(),
        shells: vec![],
        cols: 80,
        rows: 24,
        scrollback_replay: String::new(),
        exit_code: None,
    };
    let v = serde_json::to_value(&data).unwrap();
    assert!(v.get("exitCode").is_none());
}

#[test]
fn shell_restart_data_serializes_to_contract_shape() {
    let data = ShellRestartData {
        cols: 120,
        rows: 40,
    };
    let v = serde_json::to_value(&data).unwrap();
    assert_eq!(v, json!({ "cols": 120, "rows": 40 }));
}

#[test]
fn shell_info_omits_exit_code_while_alive() {
    let reg = Registry::default();
    let (pty, shared) = spawn_test_pty("sh", "/tmp");
    let info = reg.insert("sh1".into(), sess("s1"), pty, shared);
    let v = serde_json::to_value(&info).unwrap();
    assert_eq!(v["id"], "sh1");
    assert_eq!(v["owner"], json!({ "kind": "session", "sessionId": "s1" }));
    assert_eq!(v["name"], "sh 1");
    assert_eq!(v["shellName"], "sh");
    assert_eq!(v["alive"], true);
    assert!(v.get("exitCode").is_none());
}

#[test]
fn shell_info_carries_a_project_owner() {
    let reg = Registry::default();
    let (pty, shared) = spawn_test_pty("sh", "/tmp");
    let info = reg.insert("sh1".into(), proj("acme-api"), pty, shared);
    let v = serde_json::to_value(&info).unwrap();
    assert_eq!(
        v["owner"],
        json!({ "kind": "project", "projectId": "acme-api" })
    );
}

// ---------- registry behaviour ----------

#[test]
fn insert_orders_by_creation_and_names_by_smallest_unused_ordinal() {
    let reg = Registry::default();
    let (p1, s1) = spawn_test_pty("zsh", "/tmp");
    let (p2, s2) = spawn_test_pty("zsh", "/tmp");
    let (p3, s3) = spawn_test_pty("zsh", "/tmp");
    reg.insert("a".into(), sess("sess"), p1, s1);
    reg.insert("b".into(), sess("sess"), p2, s2);
    reg.insert("c".into(), sess("sess"), p3, s3);

    let shells = reg.shells_of_owner(&sess("sess"));
    assert_eq!(
        shells.iter().map(|s| s.id.clone()).collect::<Vec<_>>(),
        vec!["a", "b", "c"]
    );
    assert_eq!(
        shells.iter().map(|s| s.name.clone()).collect::<Vec<_>>(),
        vec!["zsh 1", "zsh 2", "zsh 3"]
    );

    // FR-3: disposing the middle one and creating a new one reuses ordinal 2,
    // not 4 — and the new shell lands last in creation order (FR-1), not in
    // the freed slot's old position.
    assert!(reg.dispose("b"));
    let (p4, s4) = spawn_test_pty("zsh", "/tmp");
    reg.insert("d".into(), sess("sess"), p4, s4);
    let shells = reg.shells_of_owner(&sess("sess"));
    assert_eq!(
        shells.iter().map(|s| s.id.clone()).collect::<Vec<_>>(),
        vec!["a", "c", "d"]
    );
    assert_eq!(
        shells.iter().map(|s| s.name.clone()).collect::<Vec<_>>(),
        vec!["zsh 1", "zsh 3", "zsh 2"]
    );
}

#[test]
fn cap_is_per_owner_at_six() {
    let reg = Registry::default();
    for i in 0..6 {
        let (p, s) = spawn_test_pty("zsh", "/tmp");
        reg.insert(format!("s{i}"), sess("sess"), p, s);
    }
    assert!(reg.at_cap(&sess("sess")));
    assert_eq!(reg.count_of_owner(&sess("sess")), 6);
    // A different session is unaffected (per-owner cap, FR-2).
    assert!(!reg.at_cap(&sess("other")));
    // A project owner has its own independent cap too (unbound-panes §5) —
    // even a project sharing the session's string id is a different owner.
    assert!(!reg.at_cap(&proj("sess")));
}

#[test]
fn cap_is_independent_for_a_project_owner() {
    let reg = Registry::default();
    for i in 0..6 {
        let (p, s) = spawn_test_pty("zsh", "/tmp");
        reg.insert(format!("p{i}"), proj("acme-api"), p, s);
    }
    assert!(reg.at_cap(&proj("acme-api")));
    assert_eq!(reg.count_of_owner(&proj("acme-api")), 6);
    assert!(!reg.at_cap(&proj("other-repo")));
}

#[test]
fn rename_sets_a_custom_name_and_frees_its_ordinal() {
    let reg = Registry::default();
    let (p1, s1) = spawn_test_pty("zsh", "/tmp");
    let (p2, s2) = spawn_test_pty("zsh", "/tmp");
    reg.insert("a".into(), sess("sess"), p1, s1);
    reg.insert("b".into(), sess("sess"), p2, s2);

    let renamed = reg.rename("b", "  build  ").unwrap();
    assert_eq!(renamed.name, "build");

    // "b"'s ordinal (2) is now free — a new shell claims it, not 3.
    let (p3, s3) = spawn_test_pty("zsh", "/tmp");
    let info = reg.insert("c".into(), sess("sess"), p3, s3);
    assert_eq!(info.name, "zsh 2");
}

#[test]
fn rename_to_empty_resets_to_the_auto_name() {
    let reg = Registry::default();
    let (p1, s1) = spawn_test_pty("zsh", "/tmp");
    reg.insert("a".into(), sess("sess"), p1, s1);
    let renamed = reg.rename("a", "custom").unwrap();
    assert_eq!(renamed.name, "custom");
    let reset = reg.rename("a", "   ").unwrap();
    assert_eq!(reset.name, "zsh 1");
}

#[test]
fn rename_unknown_shell_returns_none() {
    let reg = Registry::default();
    assert!(reg.rename("nope", "x").is_none());
}

#[test]
fn restart_keeps_id_name_and_position_and_clears_the_ring() {
    let reg = Registry::default();
    let (p1, s1) = spawn_test_pty("zsh", "/tmp");
    let (p2, s2) = spawn_test_pty("zsh", "/tmp");
    reg.insert("a".into(), sess("sess"), p1, s1.clone());
    reg.insert("b".into(), sess("sess"), p2, s2);
    reg.rename("a", "keep-me").unwrap();
    s1.lock().unwrap().ring.push("stale output");

    let (fresh_pty, fresh_shared) = spawn_test_pty("zsh", "/tmp");
    let size = reg.restart("a", fresh_pty, fresh_shared).unwrap();
    assert_eq!(size, (80, 24));

    let shells = reg.shells_of_owner(&sess("sess"));
    assert_eq!(
        shells.iter().map(|s| s.id.clone()).collect::<Vec<_>>(),
        vec!["a", "b"]
    ); // same position
    assert_eq!(shells[0].name, "keep-me"); // same name
    assert_eq!(reg.replay("a").unwrap().0, ""); // fresh ring
}

#[test]
fn restart_unknown_shell_returns_none() {
    let reg = Registry::default();
    let (pty, shared) = spawn_test_pty("zsh", "/tmp");
    assert!(reg.restart("nope", pty, shared).is_none());
}

#[test]
fn restart_marks_the_outgoing_shared_disposed() {
    // Same as dispose()/dispose_session()/kill_all(): the old reader
    // thread checks `disposed` before emitting `shell.exit` — restart
    // must flip it on the outgoing `Shared` or that thread's terminal
    // emit races the fresh PTY's own events.
    let reg = Registry::default();
    let (p1, s1) = spawn_test_pty("zsh", "/tmp");
    reg.insert("a".into(), sess("sess"), p1, s1.clone());
    assert!(!s1.lock().unwrap().disposed);

    let (fresh_pty, fresh_shared) = spawn_test_pty("zsh", "/tmp");
    reg.restart("a", fresh_pty, fresh_shared).unwrap();

    assert!(s1.lock().unwrap().disposed);
}

#[test]
fn ensure_first_serializes_concurrent_create_if_none_calls() {
    // multiple-shells FR-5: N concurrent `shell_ensure({owner})` calls
    // against an owner with no shells yet must spawn exactly one shell —
    // the rest attach to what the winner created.
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Barrier;

    const CALLERS: usize = 8;
    let reg = Arc::new(Registry::default());
    let spawn_count = Arc::new(AtomicUsize::new(0));
    let barrier = Arc::new(Barrier::new(CALLERS));

    let handles: Vec<_> = (0..CALLERS)
        .map(|_| {
            let reg = reg.clone();
            let spawn_count = spawn_count.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                reg.ensure_first(&sess("sess"), || {
                    spawn_count.fetch_add(1, Ordering::SeqCst);
                    let (pty, shared) = spawn_test_pty("zsh", "/tmp");
                    Ok(("only".to_string(), pty, shared))
                })
            })
        })
        .collect();

    let ids: Vec<String> = handles
        .into_iter()
        .map(|h| h.join().unwrap().unwrap())
        .collect();

    assert_eq!(spawn_count.load(Ordering::SeqCst), 1);
    assert!(ids.iter().all(|id| id == "only"));
    assert_eq!(reg.count_of_owner(&sess("sess")), 1);
}

#[test]
fn ensure_first_attaches_immediately_when_a_shell_already_exists() {
    let reg = Registry::default();
    let (p1, s1) = spawn_test_pty("zsh", "/tmp");
    reg.insert("a".into(), sess("sess"), p1, s1);

    let id = reg
        .ensure_first(&sess("sess"), || {
            panic!("must not spawn when a shell already exists")
        })
        .unwrap();
    assert_eq!(id, "a");
}

#[test]
fn dispose_removes_the_entry_and_leaves_others_untouched() {
    let reg = Registry::default();
    let (p1, s1) = spawn_test_pty("zsh", "/tmp");
    let (p2, s2) = spawn_test_pty("zsh", "/tmp");
    reg.insert("a".into(), sess("sess"), p1, s1);
    reg.insert("b".into(), sess("sess"), p2, s2);

    assert!(reg.dispose("a"));
    assert!(!reg.dispose("a")); // already gone
    assert_eq!(reg.count_of_owner(&sess("sess")), 1);
    assert_eq!(reg.first_of_owner(&sess("sess")), Some("b".to_string()));
}

#[test]
fn dispose_session_kills_every_shell_of_that_session_only() {
    let reg = Registry::default();
    let (p1, s1) = spawn_test_pty("zsh", "/tmp");
    let (p2, s2) = spawn_test_pty("zsh", "/tmp");
    let (p3, s3) = spawn_test_pty("zsh", "/tmp");
    reg.insert("a".into(), sess("sess1"), p1, s1);
    reg.insert("b".into(), sess("sess1"), p2, s2);
    reg.insert("c".into(), sess("sess2"), p3, s3);

    assert_eq!(reg.dispose_session("sess1"), 2);
    assert_eq!(reg.count_of_owner(&sess("sess1")), 0);
    assert_eq!(reg.count_of_owner(&sess("sess2")), 1); // untouched
}

#[test]
fn dispose_session_leaves_project_shells_alone() {
    // unbound-panes §5: `dispose_session_shells` disposes only `kind:
    // 'session'` entries for that id — a project-owned shell, even one
    // sharing the same string as the session id, is never touched.
    let reg = Registry::default();
    let (p1, s1) = spawn_test_pty("zsh", "/tmp");
    let (p2, s2) = spawn_test_pty("zsh", "/tmp");
    reg.insert("a".into(), sess("shared-id"), p1, s1);
    reg.insert("b".into(), proj("shared-id"), p2, s2);

    assert_eq!(reg.dispose_session("shared-id"), 1);
    assert_eq!(reg.count_of_owner(&sess("shared-id")), 0);
    assert_eq!(reg.count_of_owner(&proj("shared-id")), 1); // untouched
}

#[test]
fn kill_all_drains_every_owner() {
    let reg = Registry::default();
    let (p1, s1) = spawn_test_pty("zsh", "/tmp");
    let (p2, s2) = spawn_test_pty("zsh", "/tmp");
    let (p3, s3) = spawn_test_pty("zsh", "/tmp");
    reg.insert("a".into(), sess("sess1"), p1, s1);
    reg.insert("b".into(), sess("sess2"), p2, s2);
    reg.insert("c".into(), proj("proj1"), p3, s3);
    reg.kill_all();
    assert_eq!(reg.count_of_owner(&sess("sess1")), 0);
    assert_eq!(reg.count_of_owner(&sess("sess2")), 0);
    assert_eq!(reg.count_of_owner(&proj("proj1")), 0);
}

#[test]
fn belongs_to_distinguishes_unknown_from_wrong_owner() {
    let reg = Registry::default();
    let (p1, s1) = spawn_test_pty("zsh", "/tmp");
    reg.insert("a".into(), sess("sess1"), p1, s1);
    assert_eq!(reg.belongs_to("a", &sess("sess1")), Some(true));
    assert_eq!(reg.belongs_to("a", &sess("sess2")), Some(false));
    assert_eq!(reg.belongs_to("a", &proj("sess1")), Some(false)); // different kind
    assert_eq!(reg.belongs_to("nope", &sess("sess1")), None);
}

#[test]
fn write_drops_bytes_silently_once_not_alive() {
    let reg = Registry::default();
    let (pty, shared) = spawn_test_pty("zsh", "/tmp");
    reg.insert("a".into(), sess("sess"), pty, shared.clone());
    shared.lock().unwrap().alive = false;
    assert!(matches!(reg.write("a", "x"), WriteOutcome::Dropped));
}

#[test]
fn write_unknown_shell_is_not_found() {
    let reg = Registry::default();
    assert!(matches!(reg.write("nope", "x"), WriteOutcome::NotFound));
}

#[test]
fn resize_updates_size_and_reports_unknown_shells() {
    let reg = Registry::default();
    let (pty, shared) = spawn_test_pty("zsh", "/tmp");
    reg.insert("a".into(), sess("sess"), pty, shared);
    assert!(reg.resize("a", 120, 40));
    assert_eq!(reg.size("a"), Some((120, 40)));
    assert!(!reg.resize("nope", 10, 10));
}

#[test]
fn first_of_owner_is_none_when_empty() {
    let reg = Registry::default();
    assert_eq!(reg.first_of_owner(&sess("sess")), None);
}
