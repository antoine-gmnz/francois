use super::*;
use crate::session::testutil::fake_accounts;
use serde_json::json;

#[test]
fn mixed_retired_records_round_trip_without_pruning_or_duplicate_rows() {
    let engine = Engine::default();
    let raw = json!({"id":"retired", "name":"Saved", "cwd":"/missing/project", "agentRuntime":"pi", "protocol":null,
        "accountId":"missing-account", "projectId":"missing-project", "status":"running",
        "pi":{"schemaVersion":"future","nativeSessionFile":"/must/not/open","unknown":[1,2]},
        "piProfile":"malformed", "piLaunchPrompt":{"text":42}, "metrics":"malformed",
        "effectiveCapabilities":{"images":{"available":true}}, "unknown":{"nested":true}});
    let malformed = json!({"id":"incomplete", "agentRuntime":"pi", "name":42, "extra":[1]});
    let unknown = json!({"id":"future","agentRuntime":"future","cwd":"/x","name":"Next"});
    let mut input = vec![raw.clone(), malformed.clone(), unknown.clone()];
    for (id, runtime, protocol) in [
        ("claude", "claude-code", json!("anthropic")),
        ("codex", "codex", json!("openai")),
        ("grok", "grok", json!("openai")),
        ("francois", "francois", json!("openai")),
    ] {
        input
            .push(json!({"id":id,"name":id,"cwd":"/x","agentRuntime":runtime,"protocol":protocol}));
    }
    let watched = load_session_records(&engine, input, &HashSet::new(), &HashSet::new());
    assert_eq!(watched.len(), 4);
    engine
        .with_session("retired", |s| {
            assert_eq!(s.account_id, "missing-account");
            assert_eq!(s.project_id.as_deref(), Some("missing-project"));
            let meta = serde_json::to_value(s.meta(&fake_accounts())).unwrap();
            assert_eq!(meta["agentRuntime"], "pi");
            assert_eq!(meta["status"], "idle");
            assert_eq!(meta["protocol"], Value::Null);
        })
        .unwrap();
    let saved = persisted_session_records(&engine);
    assert_eq!(saved.len(), 7);
    for expected in [raw, malformed, unknown] {
        let matches: Vec<_> = saved.iter().filter(|r| r["id"] == expected["id"]).collect();
        assert_eq!(matches, vec![&expected]);
    }
    assert_eq!(
        engine.ensure_available("retired").unwrap_err().code,
        ErrorCode::RuntimeUnsupported
    );
    assert_eq!(
        engine.ensure_available("incomplete").unwrap_err().code,
        ErrorCode::RuntimeUnsupported
    );
    assert_eq!(
        engine.ensure_available("absent").unwrap_err().code,
        ErrorCode::SessionNotFound
    );
}

#[test]
fn retired_staged_attachment_survives_load_and_project_clear() {
    let dir = std::env::temp_dir().join(format!("francois-retired-{}", uuid()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("draft.txt");
    std::fs::write(&path, b"keep me").unwrap();
    let engine = Engine::default();
    let raw = json!({"id":"retired", "name":"Saved", "cwd":dir, "agentRuntime":"pi", "protocol":null,
        "accountId":"missing-account","projectId":"missing-project",
        "attachments":[{"id":"a1","sessionId":"retired","kind":"file","storedPath":path,"refPath":"draft.txt","name":"draft.txt","bytes":7,"copied":true,"state":"staged","createdAt":1}]});
    load_session_records(&engine, vec![raw.clone()], &HashSet::new(), &HashSet::new());
    assert_eq!(std::fs::read(&path).unwrap(), b"keep me");
    super::super::attachments::clear_session(&engine, "retired", &dir.to_string_lossy());
    assert_eq!(
        engine.with_session("retired", |s| s.attachments.len()),
        Some(1)
    );
    assert_eq!(std::fs::read(&path).unwrap(), b"keep me");
    assert_eq!(persisted_session_records(&engine), vec![raw]);
    std::fs::remove_dir_all(dir).unwrap();
}
