use super::*;

// ---------------------------------------------------------- FR-4: active_branch

fn entry(id: &str, parent: Option<&str>, role: &str, text: &str) -> NativeEntry {
    NativeEntry {
        id: id.into(),
        parent_id: parent.map(String::from),
        role: role.into(),
        text: text.into(),
    }
}

#[test]
fn active_branch_walks_from_leaf_to_root_in_chronological_order() {
    let entries = vec![
        entry("e1", None, "user", "hi"),
        entry("e2", Some("e1"), "assistant", "hello"),
        entry("e3", Some("e2"), "user", "again"),
    ];
    let branch = active_branch(&entries, "e3");
    assert_eq!(
        branch.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(),
        vec!["e1", "e2", "e3"]
    );
}

/// FR-4: "without showing abandoned branches as the current conversation".
#[test]
fn active_branch_excludes_a_sibling_branch_not_reachable_from_the_leaf() {
    let entries = vec![
        entry("e1", None, "user", "hi"),
        entry("e2a", Some("e1"), "assistant", "abandoned reply"),
        entry("e2b", Some("e1"), "assistant", "kept reply"),
        entry("e3", Some("e2b"), "user", "continue"),
    ];
    let branch = active_branch(&entries, "e3");
    let ids: Vec<&str> = branch.iter().map(|e| e.id.as_str()).collect();
    assert_eq!(ids, vec!["e1", "e2b", "e3"]);
    assert!(!ids.contains(&"e2a"), "abandoned branch must not leak in");
}

/// FR-4: pre-compaction messages on the surviving ancestry are preserved
/// — a compaction entry is just another node in the chain.
#[test]
fn active_branch_preserves_pre_compaction_messages_still_on_the_ancestry() {
    let entries = vec![
        entry("e1", None, "user", "long history begins"),
        entry("e2", Some("e1"), "assistant", "long reply"),
        entry("summary", Some("e2"), "assistant", "[compacted summary]"),
        entry("e3", Some("summary"), "user", "continue after compaction"),
    ];
    let branch = active_branch(&entries, "e3");
    let ids: Vec<&str> = branch.iter().map(|e| e.id.as_str()).collect();
    assert_eq!(ids, vec!["e1", "e2", "summary", "e3"]);
}

#[test]
fn active_branch_stops_at_a_cycle_instead_of_looping_forever() {
    let entries = vec![
        entry("a", Some("b"), "user", "x"),
        entry("b", Some("a"), "assistant", "y"),
    ];
    let branch = active_branch(&entries, "a");
    assert!(branch.len() <= 2, "must terminate, not loop");
}

#[test]
fn active_branch_on_an_unknown_leaf_is_empty() {
    let entries = vec![entry("e1", None, "user", "hi")];
    assert!(active_branch(&entries, "nope").is_empty());
}

// ---------------------------------------------------------- FR-5: reconcile_block_ids

#[test]
fn a_previously_seen_entry_keeps_its_stable_block_id_across_a_rebuild() {
    let entries = vec![entry("e1", None, "user", "hi")];
    let mut previous = HashMap::new();
    previous.insert("e1".to_string(), "stable-block-1".to_string());
    let (rebuilt, _) = reconcile_block_ids(&entries, &previous, &[]);
    assert_eq!(rebuilt[0].block_id, "stable-block-1");
}

/// FR-5: "Keep duplicate identical user messages as distinct entries" —
/// two entries with byte-identical text but different ids never merge.
#[test]
fn duplicate_identical_text_entries_get_distinct_fresh_block_ids() {
    let entries = vec![
        entry("e1", None, "user", "same text"),
        entry("e2", Some("e1"), "user", "same text"),
    ];
    let (rebuilt, _) = reconcile_block_ids(&entries, &HashMap::new(), &[]);
    assert_ne!(rebuilt[0].block_id, rebuilt[1].block_id);
    assert_eq!(rebuilt[0].text, rebuilt[1].text);
}

/// FR-5: FIFO reconciliation — a provisional (never-persisted) live block
/// left over from an interrupted turn reconciles with the FIRST new
/// entry the rebuild has never seen before, in order.
#[test]
fn leftover_new_entries_reconcile_with_provisional_blocks_in_fifo_order() {
    let entries = vec![
        entry("e1", None, "user", "first"),
        entry("e2", Some("e1"), "assistant", "second"),
        entry("e3", Some("e2"), "user", "third"),
    ];
    let mut previous = HashMap::new();
    previous.insert("e1".to_string(), "known-block".to_string());
    let provisional = vec!["provisional-a".to_string(), "provisional-b".to_string()];
    let (rebuilt, consumed) = reconcile_block_ids(&entries, &previous, &provisional);
    assert_eq!(rebuilt[0].block_id, "known-block");
    assert_eq!(rebuilt[1].block_id, "provisional-a");
    assert_eq!(rebuilt[2].block_id, "provisional-b");
    assert!(consumed.contains("provisional-a"));
    assert!(consumed.contains("provisional-b"));
}

/// A torn checkpoint (a malformed trailing persisted line) simply never
/// makes it into `previous_by_native_id` — the caller's loader already
/// skips unparsable lines (`parse_persisted_block`), so the entry it
/// belonged to is treated as never-seen and gets a fresh id here, with no
/// duplicate row and no special-cased "torn" branch needed.
#[test]
fn an_entry_missing_from_a_torn_previous_map_gets_a_fresh_id_not_a_duplicate() {
    let entries = vec![
        entry("e1", None, "user", "kept"),
        entry("e2", Some("e1"), "assistant", "torn tail, never recorded"),
    ];
    let mut previous = HashMap::new();
    previous.insert("e1".to_string(), "kept-block".to_string());
    let (rebuilt, _) = reconcile_block_ids(&entries, &previous, &[]);
    assert_eq!(rebuilt.len(), 2);
    assert_eq!(rebuilt[0].block_id, "kept-block");
    assert_ne!(rebuilt[1].block_id, "kept-block");
}

// ---------------------------------------------------------- FR-7: unconfirmed_user_block

#[test]
fn a_provisional_user_block_never_confirmed_by_any_new_entry_is_flagged() {
    let previous_user_blocks = vec![("user-block-1".to_string(), "are you there?".to_string())];
    let consumed = std::collections::HashSet::new();
    let provisional = vec!["user-block-1".to_string()];
    let (id, text) =
        unconfirmed_user_block(&previous_user_blocks, &consumed, &provisional).unwrap();
    assert_eq!(id, "user-block-1");
    assert_eq!(text, "are you there?");
}

#[test]
fn a_provisional_user_block_that_was_reconciled_is_not_flagged() {
    let previous_user_blocks = vec![("user-block-1".to_string(), "hi".to_string())];
    let mut consumed = std::collections::HashSet::new();
    consumed.insert("user-block-1".to_string());
    let provisional = vec!["user-block-1".to_string()];
    assert!(unconfirmed_user_block(&previous_user_blocks, &consumed, &provisional).is_none());
}

#[test]
fn no_provisional_blocks_at_all_flags_nothing() {
    let previous_user_blocks = vec![("user-block-1".to_string(), "hi".to_string())];
    assert!(unconfirmed_user_block(
        &previous_user_blocks,
        &std::collections::HashSet::new(),
        &[]
    )
    .is_none());
}

/// Only the LAST unconfirmed candidate is ever flagged — one notice, never a
/// growing list (the readiness gap explicitly defers the full intent-queue
/// contract to pi-turn-controls).
#[test]
fn only_the_last_unconfirmed_user_block_is_flagged() {
    let previous_user_blocks = vec![
        ("user-block-1".to_string(), "first".to_string()),
        ("user-block-2".to_string(), "second".to_string()),
    ];
    let consumed = std::collections::HashSet::new();
    let provisional = vec!["user-block-1".to_string(), "user-block-2".to_string()];
    let (id, text) =
        unconfirmed_user_block(&previous_user_blocks, &consumed, &provisional).unwrap();
    assert_eq!(id, "user-block-2");
    assert_eq!(text, "second");
}

// ---------------------------------------------------------- FR-3: validate_before_resume

fn temp_dir(tag: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "francois-pi-recovery-{tag}-{}-{}",
        std::process::id(),
        crate::ids::uuid()
    ))
}

fn write_native_file(dir: &Path, session_id: &str) -> std::path::PathBuf {
    std::fs::create_dir_all(dir).unwrap();
    let path = dir.join("native-1.jsonl");
    std::fs::write(
        &path,
        format!("{{\"sessionId\":\"{session_id}\"}}\n{{\"id\":\"e1\"}}\n"),
    )
    .unwrap();
    path
}

fn base_record(native_file: &Path) -> PiResumeRecord {
    PiResumeRecord::new(
        "native-1".into(),
        native_file.to_string_lossy().into_owned(),
        "pi-acct-1".into(),
        "/home/user/.pi".into(),
        "/repo".into(),
        "0.85.1".into(),
    )
}

#[test]
fn a_valid_record_passes_every_check() {
    let dir = temp_dir("ok");
    let file = write_native_file(&dir, "native-1");
    let record = base_record(&file);
    let account = AccountSnapshot {
        is_pi: true,
        config_dir: Some("/home/user/.pi".into()),
    };
    assert!(validate_before_resume(&record, "/repo", &account, &dir).is_ok());
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn a_removed_or_reconfigured_account_fails_account_missing() {
    let dir = temp_dir("acct");
    let file = write_native_file(&dir, "native-1");
    let record = base_record(&file);
    for account in [
        AccountSnapshot {
            is_pi: false,
            config_dir: Some("/home/user/.pi".into()),
        },
        AccountSnapshot {
            is_pi: true,
            config_dir: None,
        },
        AccountSnapshot {
            is_pi: true,
            config_dir: Some("/somewhere/else".into()),
        },
    ] {
        let err = validate_before_resume(&record, "/repo", &account, &dir).unwrap_err();
        assert_eq!(err.code, ErrorCode::RuntimeAccountMissing);
    }
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn a_moved_cwd_fails_session_corrupt_without_touching_the_file_check() {
    let dir = temp_dir("cwd");
    let file = write_native_file(&dir, "native-1");
    let record = base_record(&file);
    let account = AccountSnapshot {
        is_pi: true,
        config_dir: Some("/home/user/.pi".into()),
    };
    let err = validate_before_resume(&record, "/repo-moved", &account, &dir).unwrap_err();
    assert_eq!(err.code, ErrorCode::RuntimeSessionCorrupt);
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn a_missing_native_file_fails_session_missing() {
    let dir = temp_dir("missing");
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("gone.jsonl");
    let record = base_record(&file);
    let account = AccountSnapshot {
        is_pi: true,
        config_dir: Some("/home/user/.pi".into()),
    };
    let err = validate_before_resume(&record, "/repo", &account, &dir).unwrap_err();
    assert_eq!(err.code, ErrorCode::RuntimeSessionMissing);
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn a_file_relocated_outside_its_owned_root_fails_session_corrupt() {
    let dir = temp_dir("owned");
    let outside = temp_dir("outside");
    let file = write_native_file(&outside, "native-1");
    let record = base_record(&file);
    std::fs::create_dir_all(&dir).unwrap();
    let account = AccountSnapshot {
        is_pi: true,
        config_dir: Some("/home/user/.pi".into()),
    };
    let err = validate_before_resume(&record, "/repo", &account, &dir).unwrap_err();
    assert_eq!(err.code, ErrorCode::RuntimeSessionCorrupt);
    std::fs::remove_dir_all(&dir).ok();
    std::fs::remove_dir_all(&outside).ok();
}

#[test]
fn a_native_file_whose_header_names_a_different_session_fails_corrupt() {
    let dir = temp_dir("identity");
    let file = write_native_file(&dir, "some-other-native-id");
    let record = base_record(&file);
    let account = AccountSnapshot {
        is_pi: true,
        config_dir: Some("/home/user/.pi".into()),
    };
    let err = validate_before_resume(&record, "/repo", &account, &dir).unwrap_err();
    assert_eq!(err.code, ErrorCode::RuntimeSessionCorrupt);
    std::fs::remove_dir_all(&dir).ok();
}

// ---------------------------------------------------------- HIGH remediation: gate_then_validate order

fn ok_gate(config_dir: &str) -> Result<(String, String, Option<String>, bool), AppError> {
    Ok((config_dir.to_string(), "native".to_string(), None, false))
}

/// pi-provider-auth FR-4's gate must refuse BEFORE FR-3's own validation
/// ever runs — proven by handing `gate_then_validate` a record/cwd pair that
/// would ALSO fail FR-3 (a moved cwd) alongside a failing gate: the reported
/// error is the GATE's own code, never FR-3's `RUNTIME_SESSION_CORRUPT`.
#[test]
fn an_untrusted_account_gate_refuses_before_fr3_validation_ever_runs() {
    let dir = temp_dir("gate-untrusted");
    let file = write_native_file(&dir, "native-1");
    let record = base_record(&file);
    let gate = Err(AppError::new(
        ErrorCode::AccountConfigUntrusted,
        "trust this Pi configuration before reconnecting this session",
    ));
    let err = gate_then_validate(gate, &record, "/repo-moved", &dir).unwrap_err();
    assert_eq!(err.code, ErrorCode::AccountConfigUntrusted);
    std::fs::remove_dir_all(&dir).ok();
}

/// Same proof, for a DRIFTED (previously trusted, now changed) account.
#[test]
fn a_drifted_account_gate_refuses_before_fr3_validation_ever_runs() {
    let dir = temp_dir("gate-drifted");
    let file = write_native_file(&dir, "native-1");
    let record = base_record(&file);
    let gate = Err(AppError::new(
        ErrorCode::AccountConfigChanged,
        "this Pi configuration changed since it was trusted — trust it again before reconnecting this session",
    ));
    let err = gate_then_validate(gate, &record, "/repo-moved", &dir).unwrap_err();
    assert_eq!(err.code, ErrorCode::AccountConfigChanged);
    std::fs::remove_dir_all(&dir).ok();
}

/// A passing gate is additive, never a replacement: FR-3's own checks still
/// run (and still catch a genuine mismatch) once the gate itself clears.
#[test]
fn a_passing_gate_still_runs_fr3_validation_afterward() {
    let dir = temp_dir("gate-ok");
    let file = write_native_file(&dir, "native-1");
    let record = base_record(&file);
    let err =
        gate_then_validate(ok_gate("/home/user/.pi"), &record, "/repo-moved", &dir).unwrap_err();
    assert_eq!(err.code, ErrorCode::RuntimeSessionCorrupt);
    assert!(gate_then_validate(ok_gate("/home/user/.pi"), &record, "/repo", &dir).is_ok());
    std::fs::remove_dir_all(&dir).ok();
}

// ---------------------------------------------------------- FR-8: version_transition

#[test]
fn an_identical_version_needs_no_backup() {
    assert!(!version_transition("0.85.1", "0.85.1").unwrap());
}

#[test]
fn a_newer_installed_version_takes_a_backup() {
    assert!(version_transition("0.85.1", "0.86.0").unwrap());
}

#[test]
fn an_older_installed_version_refuses_as_incompatible() {
    let err = version_transition("0.86.0", "0.85.1").unwrap_err();
    assert_eq!(err.code, ErrorCode::RuntimeIncompatible);
}

#[test]
fn unparsable_versions_fail_open_with_a_backup() {
    assert!(version_transition("dev-build", "0.86.0").unwrap());
}

#[test]
fn backup_path_is_versioned_and_a_sibling_of_the_native_file() {
    let native = Path::new("/data/runtimes/pi/sessions/s1/native-1.jsonl");
    let backup = backup_path(native, "0.85.1");
    assert_eq!(backup.parent(), native.parent());
    assert!(backup
        .file_name()
        .unwrap()
        .to_str()
        .unwrap()
        .contains("v0.85.1"));
}

#[test]
fn backup_native_file_copies_once_and_never_overwrites_an_existing_backup() {
    let dir = temp_dir("backup");
    let file = write_native_file(&dir, "native-1");
    backup_native_file(&file, "0.85.1").unwrap();
    let backup = backup_path(&file, "0.85.1");
    assert!(backup.exists());
    std::fs::write(&file, "changed content\n").unwrap();
    backup_native_file(&file, "0.85.1").unwrap();
    // Idempotent: the SAME version's backup is never re-copied.
    assert_ne!(
        std::fs::read(&backup).unwrap(),
        b"changed content\n".to_vec()
    );
    std::fs::remove_dir_all(&dir).ok();
}

// ---------------------------------------------------------- pi-skills-capabilities: reconnect

/// pi-skills-capabilities §6/FR-9: "Resource policy is snapshotted/persisted
/// with session" and "the effective policy stays pinned until reconnect,
/// which revalidates it" — `load_reconnect_snapshot` is the read half of
/// that: the session's OWN pinned policy (acknowledgment included) survives
/// into the snapshot `run_reconnect` copies verbatim onto the
/// `RuntimeConnectContext` it hands `adapter::pi::connect`. A reconnect
/// (unlike `new_from_session`) never resets the acknowledgment — an already
/// -acknowledged session must not re-block on the very next send.
#[test]
fn load_reconnect_snapshot_carries_the_resource_policy_through_unchanged() {
    use crate::session::testutil::{test_engine_with, test_session};

    for (project_resources, acknowledged) in [
        (crate::session::adapter::pi::ProjectResources::Ignore, true),
        (crate::session::adapter::pi::ProjectResources::Allow, false),
    ] {
        let mut session = test_session();
        session.agent_runtime = AgentRuntime::Pi;
        session.resource_policy = Some(crate::session::adapter::pi::RuntimeResourcePolicy {
            project_resources,
            extensions: crate::session::adapter::pi::ExtensionsPolicy::Disabled,
            acknowledged_unrestricted_tools: acknowledged,
        });
        let engine = test_engine_with(session);
        let snapshot = load_reconnect_snapshot(&engine, "s1").expect("session present");
        let policy = snapshot.resource_policy.expect("policy present");
        assert_eq!(policy.project_resources, project_resources);
        assert_eq!(policy.acknowledged_unrestricted_tools, acknowledged);
    }
}

/// pi-skills-capabilities: a session with no policy at all (every non-Pi
/// session) carries `None` through the snapshot rather than inventing one.
#[test]
fn load_reconnect_snapshot_carries_no_policy_when_the_session_has_none() {
    use crate::session::testutil::{test_engine_with, test_session};

    let engine = test_engine_with(test_session());
    let snapshot = load_reconnect_snapshot(&engine, "s1").expect("session present");
    assert!(snapshot.resource_policy.is_none());
}

// ---------------------------------------------------------- pi-migration-rollout FR-3: read-once fix

fn pi_settings_with_instructions(paths: Vec<String>) -> crate::profiles::PiProfileSettings {
    crate::profiles::PiProfileSettings {
        system_prompt_mode: crate::profiles::PiSystemPromptMode::Default,
        system_prompt: None,
        instruction_paths: paths,
        skill_paths: Vec::new(),
        tools: Vec::new(),
        project_resources: crate::profiles::PiProjectResources::Ignore,
    }
}

/// pi-migration-rollout FR-3 (read-once fix, backward compatibility): an
/// already-resolved snapshot wins VERBATIM — even when `settings` no longer
/// matches it at all (an instruction path that would now fail to resolve).
/// This is the whole guarantee: once resolved, a snapshot is never
/// re-derived, so no later reconnect can ever re-read the instruction files.
#[test]
fn an_already_resolved_prompt_is_reused_verbatim_even_if_settings_would_now_fail() {
    let missing = std::env::temp_dir().join("francois-recovery-already-resolved.md");
    let settings = pi_settings_with_instructions(vec![missing.to_string_lossy().to_string()]);
    let existing = crate::session::adapter::pi::PiLaunchPrompt {
        text: Some("resolved before the file went missing".into()),
    };
    let resolved = resolve_or_reuse_launch_prompt(&settings, Some(&existing)).unwrap();
    assert_eq!(resolved, existing);
}

/// pi-migration-rollout FR-3 (read-once fix, backward compatibility): a
/// session persisted before this fix (`existing: None`) resolves lazily,
/// exactly once, from its stored settings.
#[test]
fn an_unresolved_prompt_is_resolved_once_from_settings() {
    let dir = std::env::temp_dir().join(format!(
        "francois-recovery-lazy-resolve-{}",
        crate::ids::uuid()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("AGENTS.md");
    std::fs::write(&path, "backward-compat instructions").unwrap();
    let settings = pi_settings_with_instructions(vec![path.to_string_lossy().to_string()]);

    let resolved = resolve_or_reuse_launch_prompt(&settings, None).unwrap();
    assert_eq!(
        resolved.text.as_deref(),
        Some("backward-compat instructions")
    );
    std::fs::remove_dir_all(&dir).ok();
}

/// pi-migration-rollout FR-3 (read-once fix, backward compatibility): a
/// pre-fix record whose instruction file is ALSO gone by the time it first
/// reconnects under this build fails that one lazy resolve — the same
/// `INVALID_INPUT` the same file would have produced at creation.
#[test]
fn an_unresolved_prompt_with_a_missing_instruction_file_fails_to_resolve() {
    let missing =
        std::env::temp_dir().join("francois-recovery-lazy-resolve-missing-instruction.md");
    let settings = pi_settings_with_instructions(vec![missing.to_string_lossy().to_string()]);
    let err = resolve_or_reuse_launch_prompt(&settings, None).expect_err("missing file");
    assert!(matches!(
        err,
        crate::profiles::ProfileError::InvalidInput(_)
    ));
}

/// pi-migration-rollout FR-3 (read-once fix): `load_reconnect_snapshot`
/// carries the session's OWN resolved prompt through unchanged, same
/// discipline as `pi_profile_settings`/`resource_policy` above.
#[test]
fn load_reconnect_snapshot_carries_the_launch_prompt_through_unchanged() {
    use crate::session::testutil::{test_engine_with, test_session};

    let mut session = test_session();
    session.agent_runtime = AgentRuntime::Pi;
    session.pi_profile_settings = Some(pi_settings_with_instructions(Vec::new()));
    session.pi_launch_prompt = Some(crate::session::adapter::pi::PiLaunchPrompt {
        text: Some("already resolved".into()),
    });
    let engine = test_engine_with(session);
    let snapshot = load_reconnect_snapshot(&engine, "s1").expect("session present");
    assert_eq!(
        snapshot.pi_launch_prompt.unwrap().text.as_deref(),
        Some("already resolved")
    );
}

/// pi-migration-rollout FR-3 (read-once fix): a pre-fix record — `piProfile`
/// present, no snapshot yet — carries that gap through the snapshot as
/// `None`, exactly the shape `effective_launch_prompt` resolves lazily.
#[test]
fn load_reconnect_snapshot_carries_no_launch_prompt_when_unresolved_yet() {
    use crate::session::testutil::{test_engine_with, test_session};

    let mut session = test_session();
    session.agent_runtime = AgentRuntime::Pi;
    session.pi_profile_settings = Some(pi_settings_with_instructions(Vec::new()));
    let engine = test_engine_with(session);
    let snapshot = load_reconnect_snapshot(&engine, "s1").expect("session present");
    assert!(snapshot.pi_launch_prompt.is_none());
}

/// pi-session-durability: "Create new session" copies the source's resolved
/// snapshot VERBATIM, same as it copies `pi_profile_settings` — never a
/// re-resolve, and never `None`d out just because it is a new session id.
#[test]
fn load_new_from_snapshot_carries_the_launch_prompt_through_unchanged() {
    use crate::session::testutil::{test_engine_with, test_session};

    let mut session = test_session();
    session.agent_runtime = AgentRuntime::Pi;
    session.pi_profile_settings = Some(pi_settings_with_instructions(Vec::new()));
    session.pi_launch_prompt = Some(crate::session::adapter::pi::PiLaunchPrompt {
        text: Some("copied verbatim".into()),
    });
    let engine = test_engine_with(session);
    let snapshot = load_new_from_snapshot(&engine, "s1").expect("session present");
    assert_eq!(
        snapshot.pi_launch_prompt.unwrap().text.as_deref(),
        Some("copied verbatim")
    );
}
