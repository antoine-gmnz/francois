use super::*;

// FR-4/FR-5/FR-7's projection tests live with the code they cover, in
// `recovery/projection_tests.rs`.

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

/// LOW (round-2 review): the three paths this module compares — the pinned
/// `config_dir`, the session's `cwd` and the conversation file Pi reports
/// back — were compared as RAW strings. Each arrives from a different
/// producer than the one that recorded it, so a trailing separator, a `./`
/// segment or (on Windows) a different case made a perfectly healthy session
/// refuse to resume as "moved" / "no longer available".
#[test]
fn a_differently_spelled_but_identical_cwd_and_config_dir_still_validate() {
    let dir = temp_dir("spelling");
    let file = write_native_file(&dir, "native-1");
    let record = base_record(&file);
    for (cwd, config_dir) in [
        ("/repo/", "/home/user/.pi/"),
        ("/repo/./", "/home/user/./.pi"),
        ("/repo/sub/..", "/home/user/.pi/sub/.."),
    ] {
        let account = AccountSnapshot {
            is_pi: true,
            config_dir: Some(config_dir.into()),
        };
        assert!(
            validate_before_resume(&record, cwd, &account, &dir).is_ok(),
            "{cwd} / {config_dir} names the same location as the record"
        );
    }
    std::fs::remove_dir_all(&dir).ok();
}

/// Windows spells the same directory in either case; every other platform
/// does not, and must keep saying so.
#[test]
fn case_only_differences_follow_the_platforms_own_rule() {
    let dir = temp_dir("case");
    let file = write_native_file(&dir, "native-1");
    let record = base_record(&file);
    let account = AccountSnapshot {
        is_pi: true,
        config_dir: Some("/home/user/.pi".into()),
    };
    let same = validate_before_resume(&record, "/REPO", &account, &dir).is_ok();
    assert_eq!(same, cfg!(windows), "case folding must follow the platform");
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

/// DEFECT 2 / FR-8: the backup's failure used to be discarded (`let _ =`),
/// and `super::connect` then launched the NEWER Pi with `--resume` against
/// the unbacked file — which Pi migrates IN PLACE, and which is the only
/// copy. A backup that could not be taken must refuse, and the spawn behind
/// it must never run.
#[test]
fn a_failed_backup_refuses_and_the_spawn_never_runs() {
    // A path under a directory that was never created: the copy cannot work.
    let missing = temp_dir("backup-unwritable").join("never-written.jsonl");
    let mut spawned = false;
    let err = backup_then_spawn(true, &missing, "0.85.1", || {
        spawned = true;
        Ok(())
    })
    .unwrap_err();
    assert_eq!(err.code, ErrorCode::Internal);
    assert!(
        !spawned,
        "Pi must never be launched against a conversation file that was not backed up"
    );
}

/// FR-8's ordering, asserted from INSIDE the spawn: whatever runs after this
/// step already has its backup on disk.
#[test]
fn the_backup_is_already_on_disk_when_the_spawn_runs() {
    let dir = temp_dir("backup-before-spawn");
    let file = write_native_file(&dir, "native-1");
    let backup = backup_path(&file, "0.85.1");
    let seen_by_spawn = backup_then_spawn(true, &file, "0.85.1", || Ok(backup.exists())).unwrap();
    assert!(seen_by_spawn, "the backup must precede the spawn");
    std::fs::remove_dir_all(&dir).ok();
}

/// No version change ⇒ no backup to take, and the spawn proceeds untouched.
#[test]
fn an_unchanged_version_spawns_without_writing_a_backup() {
    let dir = temp_dir("backup-skipped");
    let file = write_native_file(&dir, "native-1");
    assert!(backup_then_spawn(false, &file, "0.85.1", || Ok(true)).unwrap());
    assert!(!backup_path(&file, "0.85.1").exists());
    std::fs::remove_dir_all(&dir).ok();
}

/// DEFECT 3 / FR-8: an undetectable installation used to persist its version
/// as `""`. `version_transition` compares `""` fail-open forever after, so
/// that one write permanently disables the downgrade guard for the session.
/// An unknown version never overwrites a known one.
#[test]
fn an_undetectable_version_keeps_the_recorded_one() {
    for detected in [None, Some(""), Some("   ")] {
        assert_eq!(
            recorded_version("0.85.1", detected),
            "0.85.1",
            "an undetectable version ({detected:?}) must not erase the recorded one"
        );
    }
}

#[test]
fn a_detected_version_replaces_the_recorded_one() {
    assert_eq!(recorded_version("0.85.1", Some("0.86.0")), "0.86.0");
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

// `session_new_from`'s own tests live with the code they cover, in
// `recovery/new_from_tests.rs`.

// ---------------------------------------------------------- LOW: the SESSION_BUSY claim is a guard

/// LOW (round-2 review): `release_recovery` used to be a statement AFTER the
/// call, so a panic anywhere in the reconnect/new-from body skipped it. The
/// session then stayed `recovery_busy` forever — every later reconnect AND
/// every "Create new session" answered `SESSION_BUSY`, and the banner's Retry
/// button could not clear it short of restarting the app. A guard cannot be
/// skipped: unwinding runs `Drop`.
#[test]
fn a_panic_under_the_recovery_claim_still_releases_it() {
    use crate::session::testutil::{test_engine_with, test_session};

    let engine = test_engine_with(test_session());
    let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _claim = claim_recovery(&engine, "s1").expect("the claim is free");
        panic!("a reconnect step blew up");
    }));
    assert!(panicked.is_err(), "the fixture must actually panic");
    assert!(
        claim_recovery(&engine, "s1").is_some(),
        "the claim must be free again after a panicking run"
    );
}

/// The claim is exclusive while it is held, and free again once dropped —
/// which is what makes the `SESSION_BUSY` answer above meaningful.
#[test]
fn the_recovery_claim_is_exclusive_while_held_and_free_once_dropped() {
    use crate::session::testutil::{test_engine_with, test_session};

    let engine = test_engine_with(test_session());
    let claim = claim_recovery(&engine, "s1").expect("the first claim wins");
    assert!(
        claim_recovery(&engine, "s1").is_none(),
        "a second recovery must be refused while the first holds the claim"
    );
    drop(claim);
    assert!(claim_recovery(&engine, "s1").is_some());
}

/// A claim on a session that does not exist is never granted — the caller
/// must not "release" a flag it never set on some other record.
#[test]
fn no_claim_is_granted_for_an_unknown_session() {
    use crate::session::testutil::{test_engine_with, test_session};

    let engine = test_engine_with(test_session());
    assert!(claim_recovery(&engine, "nope").is_none());
}
