use super::*;
use crate::session::testutil::{test_engine_with, test_session};

fn pi_source() -> crate::session::Session {
    let mut s = test_session();
    s.agent_runtime = AgentRuntime::Pi;
    s
}

fn snapshot_of(session: crate::session::Session) -> NewFromSnapshot {
    let engine = test_engine_with(session);
    load_new_from_snapshot(&engine, "s1").expect("session present")
}

fn built(source: &NewFromSnapshot) -> crate::session::Session {
    new_session_from(
        source,
        "new-id".into(),
        "copy".into(),
        1_700_000_000_000,
        AgentRuntime::Pi,
        ProviderProtocol::Pi,
    )
}

// ---------------------------------------------------------- §5: "copies only VALIDATED … settings"

/// pi-models-metrics FR-4: `runtime_model` is the only identity Pi accepts —
/// `RuntimeConnectContext.model` is built from it and nothing else. A copy
/// created without it answered "this session has a recorded Pi conversation
/// but no recorded model identity" on its very first reconnect, i.e. it could
/// never connect at all.
#[test]
fn the_copy_carries_the_sources_exact_provider_model_pair() {
    let mut session = pi_source();
    session.runtime_model = Some(RuntimeModelRef {
        provider_id: "anthropic".into(),
        model_id: "claude-sonnet-5".into(),
    });
    let source = snapshot_of(session);
    let pair = built(&source).runtime_model.expect("the pair is copied");
    assert_eq!(pair.provider_id, "anthropic");
    assert_eq!(pair.model_id, "claude-sonnet-5");
}

/// pi-models-metrics: the source session's OWN resolved context window is
/// copied verbatim. It used to be re-derived through
/// `resolve_model_display`, which reads the Anthropic-shaped humanize/
/// context-window table — for a Pi model id that answers the Claude
/// placeholder, so the copy showed its context bar against a window its model
/// does not have.
#[test]
fn the_copy_carries_the_sources_own_context_window_rather_than_re_deriving_it() {
    let mut session = pi_source();
    session.model_id = "gpt-5-codex".into();
    session.context_limit_tokens = 400_000;
    let source = snapshot_of(session);
    assert_eq!(built(&source).context_limit_tokens, 400_000);
}

/// session-worktree FR-10: the distro follows the `cwd` this copies. Dropping
/// it left a session whose cwd only resolves inside a WSL distro claiming to
/// be native — every later `probe_installation`/connect then ran on the
/// Windows host and failed.
#[test]
fn the_copy_keeps_the_worktree_distro_that_its_cwd_needs() {
    let mut session = pi_source();
    session.cwd = "\\\\wsl$\\Ubuntu\\home\\u\\api".into();
    session.worktree_distro = Some("Ubuntu".into());
    let source = snapshot_of(session);
    let copy = built(&source);
    assert_eq!(copy.cwd, "\\\\wsl$\\Ubuntu\\home\\u\\api");
    assert_eq!(copy.worktree_distro.as_deref(), Some("Ubuntu"));
}

/// ...and the WORKTREE provenance still does not follow it: the new session
/// is not attached to whatever worktree the source's cwd happened to be, so
/// removing it must never offer to delete that worktree.
#[test]
fn the_copy_takes_no_worktree_provenance_and_no_resume_anchor() {
    let source = snapshot_of(pi_source());
    let copy = built(&source);
    assert!(copy.worktree.is_none());
    assert!(copy.pi_resume.is_none());
    assert!(copy.claude_session_id.is_none());
    assert!(copy.block_buffer.is_empty(), "no messages are ever copied");
}

/// pi-skills-capabilities: the policy is copied, the ACKNOWLEDGMENT is not —
/// a new session needs its own.
#[test]
fn the_copy_keeps_the_resource_policy_but_never_its_acknowledgment() {
    let mut session = pi_source();
    session.resource_policy = Some(crate::session::adapter::pi::RuntimeResourcePolicy {
        project_resources: crate::session::adapter::pi::ProjectResources::Allow,
        extensions: crate::session::adapter::pi::ExtensionsPolicy::Disabled,
        acknowledged_unrestricted_tools: true,
    });
    let source = snapshot_of(session);
    let policy = built(&source).resource_policy.expect("policy copied");
    assert_eq!(
        policy.project_resources,
        crate::session::adapter::pi::ProjectResources::Allow
    );
    assert!(!policy.acknowledged_unrestricted_tools);
}

/// pi-session-durability: "Create new session" copies the source's resolved
/// prompt snapshot VERBATIM, same as it copies `pi_profile_settings` — never
/// a re-resolve, and never `None`d out just because it is a new session id.
#[test]
fn load_new_from_snapshot_carries_the_launch_prompt_through_unchanged() {
    let mut session = pi_source();
    session.pi_launch_prompt = Some(crate::session::adapter::pi::PiLaunchPrompt {
        text: Some("copied verbatim".into()),
    });
    let source = snapshot_of(session);
    assert_eq!(
        source.pi_launch_prompt.as_ref().unwrap().text.as_deref(),
        Some("copied verbatim")
    );
    assert_eq!(
        built(&source).pi_launch_prompt.unwrap().text.as_deref(),
        Some("copied verbatim")
    );
}

// ---------------------------------------------------------- §5: the cwd is VALIDATED

fn temp_dir(tag: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "francois-pi-new-from-{tag}-{}-{}",
        std::process::id(),
        crate::ids::uuid()
    ))
}

/// §5: "copies only VALIDATED cwd/project/account/profile/model settings".
/// The source's cwd may have been deleted or unmounted since — which is very
/// often exactly WHY its Pi conversation stopped resuming. A copy pointed at
/// a directory that is no longer there is a session that can never spawn.
#[test]
fn a_source_whose_cwd_is_gone_refuses_instead_of_copying_it() {
    let mut session = pi_source();
    session.cwd = temp_dir("gone").to_string_lossy().into_owned();
    let source = snapshot_of(session);
    let err = validated_cwd(&source).expect_err("a missing cwd must refuse");
    assert_eq!(err.code, ErrorCode::InvalidInput);
}

/// The control: a cwd that IS there passes, so the check refuses only what it
/// has reason to.
#[test]
fn a_source_whose_cwd_still_exists_passes_validation() {
    let dir = temp_dir("present");
    std::fs::create_dir_all(&dir).unwrap();
    let mut session = pi_source();
    session.cwd = dir.to_string_lossy().into_owned();
    let source = snapshot_of(session);
    assert!(validated_cwd(&source).is_ok());
    std::fs::remove_dir_all(&dir).ok();
}

// ---------------------------------------------------------- session-rename FR-1: the derived name

#[test]
fn the_derived_name_is_the_source_plus_a_copy_suffix_within_the_cap() {
    assert_eq!(derive_new_from_name("api"), "api (copy)");
    let long = "x".repeat(80);
    assert_eq!(derive_new_from_name(&long).chars().count(), 80);
}
