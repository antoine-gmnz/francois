use super::*;
use serde_json::json;

#[test]
fn missing_native_account_keeps_saved_identity_and_anchor_across_repeated_load_save() {
    let known_accounts = HashSet::from(["default".to_string()]);
    let mut records = vec![
        json!({"id":"claude", "name":"Saved Claude", "cwd":"/repo", "agentRuntime":"claude-code", "protocol":"anthropic", "accountId":"removed-claude", "claudeSessionId":"opaque-claude-thread", "responseMode":"default", "responseModeSent":"default"}),
        json!({"id":"codex", "name":"Saved Codex", "cwd":"/repo", "agentRuntime":"codex", "protocol":"openai", "accountId":"removed-codex", "claudeSessionId":"opaque-codex-thread", "responseMode":"default", "responseModeSent":"default"}),
    ];
    for _ in 0..2 {
        let engine = Engine::default();
        load_session_records(&engine, records, &HashSet::new(), &known_accounts);
        for (id, account, runtime, anchor) in [
            (
                "claude",
                "removed-claude",
                AgentRuntime::ClaudeCode,
                "opaque-claude-thread",
            ),
            (
                "codex",
                "removed-codex",
                AgentRuntime::Codex,
                "opaque-codex-thread",
            ),
        ] {
            engine
                .with_session(id, |s| {
                    assert_eq!(s.account_id, account);
                    assert_eq!(s.agent_runtime, runtime);
                    assert_eq!(s.claude_session_id.as_deref(), Some(anchor));
                    assert_eq!(s.response_mode_sent, Some(ResponseMode::Default));
                    assert!(s.runtime_owner.is_none());
                    assert!(s.running_context.is_none());
                    assert!(s.current.is_none());
                    assert_eq!(s.next_generation, 0);
                    assert_eq!(s.settings_revision, 0);
                })
                .unwrap();
        }
        records = persisted_session_records(&engine);
    }
}

#[test]
fn absent_legacy_account_still_migrates_to_builtin_default() {
    let engine = Engine::default();
    load_session_records(
        &engine,
        vec![json!({"id":"legacy", "name":"Old", "cwd":"/repo", "claudeSessionId":"old-thread"})],
        &HashSet::new(),
        &HashSet::new(),
    );
    engine
        .with_session("legacy", |s| {
            assert_eq!(s.account_id, "default");
            assert_eq!(s.agent_runtime, AgentRuntime::ClaudeCode);
            assert_eq!(s.claude_session_id.as_deref(), Some("old-thread"));
        })
        .unwrap();
}

#[test]
fn unusable_native_account_fields_keep_documented_absent_normalization() {
    for runtime in ["claude-code", "codex"] {
        for account in [
            None,
            Some(json!("")),
            Some(json!("   ")),
            Some(Value::Null),
            Some(json!(42)),
        ] {
            let mut record = json!({"id":"native", "name":"Saved", "cwd":"/repo", "agentRuntime":runtime, "claudeSessionId":"opaque-anchor"});
            if let Some(account) = account {
                record["accountId"] = account;
            }
            let engine = Engine::default();
            load_session_records(&engine, vec![record], &HashSet::new(), &HashSet::new());
            engine
                .with_session("native", |s| {
                    assert_eq!(s.account_id, "default");
                    assert_eq!(s.claude_session_id.as_deref(), Some("opaque-anchor"));
                })
                .unwrap();
        }
    }
}

#[test]
fn explicit_native_account_references_are_not_trimmed_or_replaced() {
    for account in ["default", "existing", " removed-with-spaces "] {
        let engine = Engine::default();
        let record = json!({"id":"native", "name":"Saved", "cwd":"/repo", "agentRuntime":"codex", "protocol":"openai", "accountId":account, "claudeSessionId":"opaque-anchor"});
        let known = HashSet::from(["default".into(), "existing".into()]);
        load_session_records(&engine, vec![record], &HashSet::new(), &known);
        assert_eq!(
            engine
                .with_session("native", |s| s.account_id.clone())
                .as_deref(),
            Some(account)
        );
        assert_eq!(persisted_session_records(&engine)[0]["accountId"], account);
    }
}

#[test]
fn surviving_legacy_runtimes_keep_their_existing_account_resolution() {
    let engine = Engine::default();
    let records = ["grok", "francois"].map(|runtime| json!({"id":runtime, "name":runtime, "cwd":"/repo", "agentRuntime":runtime, "protocol":"openai", "accountId":"removed"}));
    load_session_records(&engine, records.into(), &HashSet::new(), &HashSet::new());
    for id in ["grok", "francois"] {
        assert_eq!(
            engine.with_session(id, |s| s.account_id.clone()).as_deref(),
            Some("default")
        );
    }
}
