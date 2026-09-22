use super::*;

pub(crate) fn persist_anchor(
    app: &AppHandle,
    engine: &Engine,
    id: &str,
    anchor: &str,
) -> Result<(), AppError> {
    let path = sessions_json_path(app).ok_or_else(write_error)?;
    persist_anchor_at(engine, id, anchor, &path)
}
/// The same atomic anchor commit against an explicit `sessions.json` path, so
/// a product-path test drives the real writer without an `AppHandle`.
pub(crate) fn persist_anchor_at(
    engine: &Engine,
    id: &str,
    anchor: &str,
    path: &std::path::Path,
) -> Result<(), AppError> {
    commit_anchor(engine, id, anchor, |bytes| {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        sessions_file::write_atomic(path, bytes)
    })
}
/// Quit/reopen for continuity tests: the real quarantine reader and record
/// loader over a `sessions.json` a previous process wrote, into a fresh Engine.
#[cfg(test)]
pub(crate) fn reopen(path: &std::path::Path, known_accounts: &[&str]) -> Engine {
    let (records, diagnostic) = sessions_file::read_or_set_aside(path, now_ms());
    assert!(diagnostic.is_none(), "sessions.json was quarantined");
    let engine = Engine::default();
    let known_accounts = known_accounts.iter().map(|id| id.to_string()).collect();
    load_session_records(&engine, records, &HashSet::new(), &known_accounts);
    engine
}
/// Write the engine's records exactly as `persist` does (the app quitting).
#[cfg(test)]
pub(crate) fn save(engine: &Engine, path: &std::path::Path) {
    let bytes = serde_json::to_vec_pretty(&persisted_session_records(engine)).unwrap();
    sessions_file::write_atomic(path, &bytes).unwrap();
}
fn write_error() -> AppError {
    AppError::new(ErrorCode::SettingsWriteFailed,"The native session reference could not be saved. Check available disk space and retry explicitly.")
}
fn commit_anchor(
    engine: &Engine,
    id: &str,
    anchor: &str,
    write: impl FnOnce(&[u8]) -> std::io::Result<()>,
) -> Result<(), AppError> {
    let _writer = PERSIST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    engine.ensure_available(id)?;
    let mut records = persisted_session_records(engine);
    let record = records
        .iter_mut()
        .find(|record| record.get("id").and_then(Value::as_str) == Some(id))
        .ok_or_else(|| AppError::new(ErrorCode::SessionNotFound, "no such session"))?;
    let changed = record.get("claudeSessionId").and_then(Value::as_str) != Some(anchor);
    record["claudeSessionId"] = Value::String(anchor.into());
    if changed {
        record.as_object_mut().unwrap().remove("responseModeSent");
    }
    let bytes = serde_json::to_vec_pretty(&records).map_err(|_| write_error())?;
    write(&bytes).map_err(|_| write_error())?;
    // No reader or competing writer can observe an anchor as committed before
    // the atomic file publication succeeds. The caller holds its scope gate.
    engine.with_session_mut(id, |session| {
        session.claude_session_id = Some(anchor.into());
        if changed {
            session.response_mode_sent = None;
        }
    });
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::testutil::{test_engine_with, test_session};
    #[test]
    fn failed_anchor_commit_keeps_original_file_and_in_memory_identity() {
        let mut session = test_session();
        session.claude_session_id = Some("original".into());
        session.response_mode_sent = Some(ResponseMode::Concise);
        let engine = test_engine_with(session);
        let dir = std::env::temp_dir().join(format!("francois-anchor-{}", uuid()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("sessions.json");
        std::fs::write(&path, b"original file").unwrap();
        let error = commit_anchor(&engine, "s1", "new", |_| {
            Err(std::io::Error::other("injected failure"))
        })
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::SettingsWriteFailed);
        assert_eq!(std::fs::read(&path).unwrap(), b"original file");
        assert_eq!(
            engine
                .with_session("s1", |s| s.claude_session_id.clone())
                .flatten()
                .as_deref(),
            Some("original")
        );
        assert_eq!(
            engine
                .with_session("s1", |s| s.response_mode_sent)
                .flatten(),
            Some(ResponseMode::Concise)
        );
        commit_anchor(&engine, "s1", "new", |bytes| {
            sessions_file::write_atomic(&path, bytes)
        })
        .unwrap();
        let records: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(records[0]["claudeSessionId"], "new");
        assert!(records[0].get("responseModeSent").is_none());
        assert_eq!(
            engine
                .with_session("s1", |s| s.claude_session_id.clone())
                .flatten()
                .as_deref(),
            Some("new")
        );
        assert_eq!(
            engine
                .with_session("s1", |s| s.response_mode_sent)
                .flatten(),
            None
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
