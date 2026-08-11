//! sessions.json + per-session transcript persistence (FR-42/43).

use super::*;

use serde_json::Value;
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

// ---------- persistence (FR-42/43) ----------

pub(crate) fn sessions_json_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("sessions.json"))
}

// ---------- transcript persistence (durable-sessions) ----------

/// A session id must be a uuid-charset token so it can never escape the transcripts
/// dir (no `/`, `\`, `..`). Defense-in-depth against a tampered/legacy sessions.json.
pub(crate) fn valid_session_id(id: &str) -> bool {
    !id.is_empty() && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

pub(crate) fn transcript_path(app: &AppHandle, session_id: &str) -> Option<std::path::PathBuf> {
    if !valid_session_id(session_id) {
        return None;
    }
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("transcripts").join(format!("{session_id}.jsonl")))
}

/// Serialize a finalized block to the on-disk PersistedBlock shape (durable-sessions §5).
pub(crate) fn persisted_block_json(b: &BufBlock) -> Value {
    let kind = match b.kind {
        BlockKind::User => "user",
        BlockKind::Assistant => "assistant",
        BlockKind::Tool => "tool",
        BlockKind::Subagent => "subagent",
        // agent-tab FR-6: notice blocks only ever live in a per-agent transcript,
        // which is in-memory and never persisted — this arm is exhaustiveness only.
        BlockKind::Notice => "notice",
        BlockKind::Command => {
            // interactive-commands FR-24: finalized command blocks persist the card as JSON.
            return serde_json::json!({
                "blockId": b.block_id, "kind": "command", "command": b.tool, "card": b.card,
            });
        }
        BlockKind::Question => {
            // session-questions FR-6/FR-13: persisted at ask (pending) and again at
            // resolution — reload upserts by blockId (parse_transcript).
            let card = b.card.clone().unwrap_or_else(|| serde_json::json!({}));
            let mut o = serde_json::json!({
                "blockId": b.block_id, "kind": "question",
                "questions": card.get("questions").cloned().unwrap_or_else(|| Value::Array(Vec::new())),
                "state": card.get("state").cloned().unwrap_or_else(|| Value::String("pending".into())),
            });
            if let Some(a) = card.get("answers") {
                o["answers"] = a.clone();
            }
            return o;
        }
        BlockKind::Permission => {
            // permission-guardrails FR-2/FR-8: persisted at ask (pending) and
            // again at resolution — reload upserts by blockId (parse_transcript).
            let card = b.card.clone().unwrap_or_else(|| serde_json::json!({}));
            let mut o = serde_json::json!({
                "blockId": b.block_id, "kind": "permission",
                "ask": card.get("ask").cloned().unwrap_or_else(|| serde_json::json!({})),
                "state": card.get("state").cloned().unwrap_or_else(|| Value::String("pending".into())),
            });
            if let Some(r) = card.get("rule") {
                o["rule"] = r.clone();
            }
            return o;
        }
    };
    serde_json::json!({
        "blockId": b.block_id, "kind": kind, "text": b.text,
        "tool": b.tool, "summary": b.summary, "meta": b.meta,
    })
}

/// Append one finalized block as a JSON line to the session's transcript (FR-1/2).
/// Best-effort: a write failure is ignored so it never breaks the turn (§7).
pub(crate) fn append_transcript(app: &AppHandle, session_id: &str, block: &BufBlock) {
    use std::io::Write as _;
    let Some(path) = transcript_path(app, session_id) else {
        return;
    };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let mut line = serde_json::to_string(&persisted_block_json(block)).unwrap_or_default();
    line.push('\n');
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let _ = f.write_all(line.as_bytes());
    }
}

/// /clear: remove the session's persisted transcript so a reload starts empty.
/// Best-effort — a missing file or remove error is ignored.
pub(crate) fn clear_transcript(app: &AppHandle, session_id: &str) {
    if let Some(path) = transcript_path(app, session_id) {
        let _ = std::fs::remove_file(&path);
    }
}

/// Parse one PersistedBlock line back into a BufBlock. Returns None for a malformed
/// or partial line so reload can skip it (FR-15).
pub(crate) fn parse_persisted_block(line: &str) -> Option<BufBlock> {
    let v: Value = serde_json::from_str(line).ok()?;
    let kind = match v.get("kind").and_then(|k| k.as_str())? {
        "user" => BlockKind::User,
        "assistant" => BlockKind::Assistant,
        "tool" => BlockKind::Tool,
        "subagent" => BlockKind::Subagent,
        "command" => {
            // A persisted command block always carries its card (FR-24 — pending blocks
            // are never persisted); treat a card-less line as malformed and skip it.
            let block_id = v.get("blockId").and_then(|b| b.as_str())?.to_string();
            let card = v.get("card").filter(|c| !c.is_null())?.clone();
            return Some(BufBlock {
                tool: v
                    .get("command")
                    .and_then(|c| c.as_str())
                    .unwrap_or("")
                    .to_string(),
                card: Some(card),
                ..BufBlock::new(&block_id, BlockKind::Command)
            });
        }
        "question" => {
            // session-questions §6: pending entries are memory-only, so a line still
            // "pending" on disk can only be read back after a hard kill — and a dead
            // process has no answerable questions. Normalize it to cancelled.
            let block_id = v.get("blockId").and_then(|b| b.as_str())?.to_string();
            let questions = v
                .get("questions")
                .cloned()
                .unwrap_or_else(|| Value::Array(Vec::new()));
            let state = match v.get("state").and_then(|s| s.as_str()) {
                Some("answered") => "answered",
                _ => "cancelled",
            };
            let mut card = serde_json::json!({ "questions": questions, "state": state });
            if let Some(a) = v.get("answers").filter(|a| !a.is_null()) {
                card["answers"] = a.clone();
            }
            return Some(BufBlock {
                card: Some(card),
                ..BufBlock::new(&block_id, BlockKind::Question)
            });
        }
        "permission" => {
            // permission-guardrails FR-25: same rule as questions — pending
            // entries are memory-only, so a line still "pending" on disk can only
            // be read back after a hard kill, and a dead process has no
            // answerable asks. Normalize it to cancelled.
            let block_id = v.get("blockId").and_then(|b| b.as_str())?.to_string();
            let ask = v
                .get("ask")
                .cloned()
                .unwrap_or_else(|| serde_json::json!({}));
            let state = match v.get("state").and_then(|s| s.as_str()) {
                Some(s @ ("allowed" | "denied")) => s,
                _ => "cancelled",
            };
            let mut card = serde_json::json!({ "ask": ask, "state": state });
            if let Some(r) = v.get("rule").filter(|r| !r.is_null()) {
                card["rule"] = r.clone();
            }
            return Some(BufBlock {
                card: Some(card),
                ..BufBlock::new(&block_id, BlockKind::Permission)
            });
        }
        _ => return None,
    };
    let block_id = v.get("blockId").and_then(|b| b.as_str())?.to_string();
    Some(BufBlock {
        text: v
            .get("text")
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .to_string(),
        tool: v
            .get("tool")
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .to_string(),
        summary: v
            .get("summary")
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .to_string(),
        meta: v.get("meta").and_then(|m| m.as_str()).map(String::from),
        ..BufBlock::new(&block_id, kind)
    })
}

/// Fold persisted lines into blocks, upserting by blockId: the LAST line wins, at
/// the FIRST occurrence's position. Question resolutions re-append their block
/// (session-questions FR-15); everything else appends exactly once.
pub(crate) fn parse_transcript(content: &str) -> Vec<BufBlock> {
    let mut out: Vec<BufBlock> = Vec::new();
    for b in content.lines().filter_map(parse_persisted_block) {
        match out.iter_mut().find(|e| e.block_id == b.block_id) {
            Some(slot) => *slot = b,
            None => out.push(b),
        }
    }
    out
}

/// Read a session's persisted transcript back into a block buffer (FR-5).
pub(crate) fn read_transcript(app: &AppHandle, session_id: &str) -> Vec<BufBlock> {
    let Some(path) = transcript_path(app, session_id) else {
        return Vec::new();
    };
    let Ok(content) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    parse_transcript(&content)
}

pub(crate) fn persist(app: &AppHandle, engine: &Engine) {
    // One writer at a time: persist() is called from commands (async runtime) AND
    // from run_reader threads, and every caller writes the SAME sessions.json.tmp
    // before the atomic rename — two concurrent writers could rename a torn file.
    static PERSIST_LOCK: Mutex<()> = Mutex::new(());
    let _w = PERSIST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let map = engine.sessions.lock().unwrap();
    let list: Vec<Value> = map
        .values()
        .map(|s| {
            let mut rec = serde_json::json!({
                "id": s.id, "name": s.name, "cwd": s.cwd, "modelId": s.model_id, "effort": s.effort,
                "permissionMode": s.permission_mode, "runtime": s.runtime,
                "allowGit": s.allow_git,
                "claudeSessionId": s.claude_session_id, // durable-sessions FR-3
                "lastActivityAt": s.last_activity_at,
                "contextUsedTokens": s.context_used_tokens,
                // multi-account FR-19: always written (unlike projectId) — a
                // session always has an account, and 'default' is a real value.
                "accountId": s.account_id,
            });
            // projects FR-18: write projectId ONLY when linked. An unlinked session
            // must omit the key entirely rather than emit null, so a record written
            // here stays byte-compatible with a pre-projects build's reader.
            if let Some(pid) = &s.project_id {
                rec["projectId"] = Value::String(pid.clone());
            }
            // session-worktree FR-12: written only when present, same omit-not-null
            // convention as projectId (a pre-feature reader must see no key).
            if let Some(wt) = &s.worktree {
                rec["worktree"] = serde_json::to_value(wt).unwrap_or(Value::Null);
            }
            // session-worktree FR-10: the `GitHost` distro this session's cwd was
            // resolved under, written as a sibling key (never inside the contract
            // `worktree` object) so it survives a restart — without it, a reloaded
            // WSL worktree session's bare Linux-path cwd has no distro to route
            // git/turn-spawn calls to.
            if let Some(distro) = &s.worktree_distro {
                rec["worktreeDistro"] = Value::String(distro.clone());
            }
            // session-attachments §6: the staged/sent refs ride along with the
            // session record — that is what makes FR-17's start-up sweep
            // crash-proof. Same omit-not-null convention: a session that never
            // attached anything writes no key at all.
            if !s.attachments.is_empty() {
                rec["attachments"] = serde_json::to_value(&s.attachments).unwrap_or(Value::Null);
            }
            // cloud-sessions FR-10/§6: the ONLY thing this feature persists.
            // Same omit-not-null convention — a session that was never adopted
            // writes no key at all.
            if let Some(c) = &s.cloud {
                rec["cloud"] = serde_json::to_value(c).unwrap_or(Value::Null);
            }
            rec
        })
        .collect();
    if let Some(path) = sessions_json_path(app) {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        // Atomic write (temp + rename) so a crash mid-write can't torn sessions.json —
        // it now holds every session's claudeSessionId resume anchor (FR-10).
        let bytes = serde_json::to_vec_pretty(&list).unwrap_or_default();
        let tmp = path.with_extension("json.tmp");
        if std::fs::write(&tmp, &bytes).is_ok() {
            if std::fs::rename(&tmp, &path).is_err() {
                let _ = std::fs::remove_file(&tmp);
            }
        }
    }
}

/// Scalar fields parsed from a persisted session record. Backward-compatible:
/// records from before durable-sessions lack claudeSessionId/lastActivityAt/
/// contextUsedTokens → None / `now` / 0 (FR-3/4). Transcript is loaded separately.
pub(crate) struct PersistedMeta {
    id: String,
    name: String,
    cwd: String,
    model_id: String,
    effort: Option<String>,
    permission_mode: String, // "default" when absent (pre-feature records)
    runtime: String,         // "native" when absent, or when "wsl" off-Windows
    allow_git: bool,         // false when absent (pre-feature records)
    /// projects FR-18: None when absent (every pre-projects record). Whether the
    /// id still RESOLVES is decided at load, not here — parsing stays pure.
    project_id: Option<String>,
    /// session-worktree FR-12: None on every pre-feature record.
    worktree: Option<SessionWorktree>,
    /// session-worktree FR-10: the sibling `worktreeDistro` key (see `persist`).
    /// None on every pre-feature record and every native-host worktree.
    worktree_distro: Option<String>,
    /// multi-account FR-19: None on every pre-multi-account record. Whether the
    /// id still RESOLVES is decided at load (FR-10), not here — parsing stays pure.
    account_id: Option<String>,
    claude_session_id: Option<String>,
    last_activity_at: u64,
    context_used_tokens: u64,
    /// session-attachments §6: empty on every pre-feature record. Parsed
    /// per-element and best-effort — one malformed entry is skipped rather than
    /// costing the session its whole record.
    attachments: Vec<Attachment>,
    /// cloud-sessions FR-10: None on every pre-feature record, and on every
    /// session that was not adopted. A malformed value loads as "not adopted"
    /// rather than costing the session its whole record — the chip is the only
    /// thing that depends on it.
    cloud: Option<CloudProvenance>,
}

pub(crate) fn parse_session_record(rec: &Value, now: u64) -> Option<PersistedMeta> {
    let id = rec.get("id")?.as_str()?.to_string();
    let name = rec.get("name")?.as_str()?.to_string();
    let cwd = rec.get("cwd")?.as_str()?.to_string();
    let raw = rec
        .get("modelId")
        .and_then(|v| v.as_str())
        .unwrap_or(DEFAULT_MODEL);
    // Heal the two made-up ids from an earlier build; keep real ids verbatim.
    let model_id = match raw {
        "" => DEFAULT_MODEL,
        "claude-opus-4" => "opus",
        "claude-haiku-4" => "haiku",
        other => other,
    }
    .to_string();
    Some(PersistedMeta {
        id,
        name,
        cwd,
        model_id,
        effort: rec
            .get("effort")
            .and_then(|v| v.as_str())
            .filter(|e| valid_effort(e))
            .map(String::from),
        permission_mode: rec
            .get("permissionMode")
            .and_then(|v| v.as_str())
            .filter(|m| valid_permission_mode(m))
            .unwrap_or("default")
            .to_string(),
        // A sessions.json copied to a non-Windows machine degrades wsl → native.
        runtime: rec
            .get("runtime")
            .and_then(|v| v.as_str())
            .filter(|r| valid_runtime(r) && (cfg!(windows) || *r != "wsl"))
            .unwrap_or("native")
            .to_string(),
        allow_git: rec
            .get("allowGit")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        // projects FR-18: a blank string is treated as absent so a hand-edited
        // sessions.json can't mint an unlinkable id.
        project_id: rec
            .get("projectId")
            .and_then(|v| v.as_str())
            .filter(|s| !s.trim().is_empty())
            .map(String::from),
        // session-worktree FR-12: best-effort round trip — a malformed/legacy
        // record simply loads as unlinked-from-a-worktree rather than failing
        // the whole session.
        worktree: rec
            .get("worktree")
            .filter(|v| !v.is_null())
            .and_then(|v| serde_json::from_value(v.clone()).ok()),
        worktree_distro: rec
            .get("worktreeDistro")
            .and_then(|v| v.as_str())
            .filter(|s| !s.trim().is_empty())
            .map(String::from),
        // multi-account FR-19: a blank string is treated as absent so a
        // hand-edited sessions.json can't bind a session to an unusable id.
        account_id: rec
            .get("accountId")
            .and_then(|v| v.as_str())
            .filter(|s| !s.trim().is_empty())
            .map(String::from),
        claude_session_id: rec
            .get("claudeSessionId")
            .and_then(|v| v.as_str())
            .map(String::from),
        last_activity_at: rec
            .get("lastActivityAt")
            .and_then(|v| v.as_u64())
            .unwrap_or(now),
        context_used_tokens: rec
            .get("contextUsedTokens")
            .and_then(|v| v.as_u64())
            .unwrap_or(0),
        attachments: rec
            .get("attachments")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|a| serde_json::from_value::<Attachment>(a.clone()).ok())
                    .collect()
            })
            .unwrap_or_default(),
        cloud: rec
            .get("cloud")
            .filter(|v| !v.is_null())
            .and_then(|v| serde_json::from_value(v.clone()).ok()),
    })
}

/// projects FR-9: the removal side-effect on sessions. Clears `project_id` on every
/// session that referenced the now-gone project, persists the pruned sessions.json,
/// and emits one `session.meta` per affected session so the board and the main pane
/// repaint. The sessions themselves keep running — they are merely unlinked (§7 #15),
/// and NOTHING under the project's root is touched.
///
/// Called with the registry lock already released, so the engine lock is taken
/// alone — the two are never held at once.
/// projects FR-18: does a persisted `projectId` still resolve?
///
/// Extracted from `load_persisted` so the rule is testable — inline it needed an
/// `AppHandle`, which made the central promise of FR-18 ("a persisted projectId
/// pointing at a removed project is dropped on load", §9) unverifiable.
///
/// `None` in ⇒ `None` out (the pre-projects records). A link to a project the
/// registry no longer knows is dropped, and the pruned value is written back by the
/// next `persist` (§7 #14).
pub(crate) fn resolve_link(persisted: Option<String>, known: &HashSet<String>) -> Option<String> {
    persisted.filter(|id| known.contains(id))
}

/// multi-account FR-10: the same pruning discipline for `accountId`, except the
/// field is REQUIRED — an absent or no-longer-resolving value loads as the
/// built-in `default` account rather than as "unlinked".
pub(crate) fn resolve_account(persisted: Option<String>, known: &HashSet<String>) -> String {
    persisted
        .filter(|id| known.contains(id))
        .unwrap_or_else(|| crate::account::DEFAULT_ACCOUNT_ID.to_string())
}

/// multi-account FR-9: the removal side-effect on sessions. Repoints every
/// session bound to the now-gone account onto `default`, persists the pruned
/// sessions.json and emits one `session.meta` per affected session. Returns
/// their ids — `AccountRemoveData.reassignedSessions`.
///
/// Called from the account command layer with the account lock already
/// released, so the engine lock is taken alone (multi-account §6 LOCK ORDER).
pub fn reassign_account_sessions(app: &AppHandle, account_id: &str) -> Vec<String> {
    let engine = app.state::<Engine>();
    let changed = engine.clear_account(account_id);
    if changed.is_empty() {
        return Vec::new();
    }
    persist(app, &engine);
    let ids: Vec<String> = changed.iter().map(|m| m.id.clone()).collect();
    for meta in changed {
        emit(app, SessionEvent::Meta { meta });
    }
    ids
}

pub(crate) fn unlink_project_sessions(app: &AppHandle, project_id: &str) {
    let engine = app.state::<Engine>();
    let changed = engine.clear_project(project_id);
    if changed.is_empty() {
        return;
    }
    persist(app, &engine);
    for meta in changed {
        emit(app, SessionEvent::Meta { meta });
    }
}

pub fn load_persisted(app: &AppHandle) {
    let Some(path) = sessions_json_path(app) else {
        return;
    };
    let Ok(bytes) = std::fs::read(&path) else {
        return;
    };
    let Ok(list) = serde_json::from_slice::<Vec<Value>>(&bytes) else {
        return;
    };
    let engine = app.state::<Engine>();
    // projects FR-18: read the registry ONCE for the whole load — main.rs runs
    // project::load_projects before this, so it is already populated.
    let known = crate::project::known_ids(app);
    // multi-account FR-10: same discipline, same one-read-for-the-whole-load —
    // main.rs runs account::load_accounts before this too.
    let known_accounts = crate::account::known_ids(app);
    let mut watched: Vec<(String, String)> = Vec::new();
    let mut map = engine.sessions.lock().unwrap();
    for rec in list {
        let now = now_ms();
        let Some(m) = parse_session_record(&rec, now) else {
            continue;
        };
        let block_buffer = read_transcript(app, &m.id); // FR-5
        let limit = context_limit(&m.model_id);
        watched.push((m.id.clone(), m.cwd.clone()));
        map.insert(
            m.id.clone(),
            Session {
                id: m.id,
                name: m.name,
                cwd: m.cwd,
                model_id: m.model_id,
                // Always `idle` on load, whatever the session was when the app
                // quit: the child process is gone, so a persisted `starting` or
                // `awaiting_*` would describe a turn that no longer exists.
                status: status::IDLE.into(),
                // Clamped: a record written by a build that mistook the turn's
                // cost aggregate for the context could hold a figure larger than
                // the window itself. Reloading heals it.
                context_used_tokens: m.context_used_tokens.min(limit),
                context_limit_tokens: limit,
                started_at: now,
                last_activity_at: m.last_activity_at,
                error_message: None,
                effort: m.effort,
                permission_mode: m.permission_mode,
                runtime: m.runtime,
                allow_git: m.allow_git,
                // projects FR-18: a link whose project is gone from the registry is
                // DROPPED here — the session loads unlinked and the pruned value is
                // persisted by the next write (§7 #14).
                project_id: resolve_link(m.project_id, &known),
                worktree: m.worktree,
                worktree_distro: m.worktree_distro,
                // multi-account FR-10: an accountId that resolves to no registry
                // entry — and every pre-feature record, which has none — loads
                // as `default`; the pruned value is written by the next persist.
                account_id: resolve_account(m.account_id, &known_accounts),
                // cloud-sessions FR-10: provenance survives quit/reopen — that
                // is the whole point of persisting it (§9).
                cloud: m.cloud,
                queue: VecDeque::new(),
                claude_session_id: m.claude_session_id,
                current: None,
                pending_probe: None,
                agents: HashMap::new(),
                agent_order: Vec::new(),
                agent_by_tool: HashMap::new(),
                agent_steps: HashMap::new(),
                agent_step_seq: HashMap::new(),
                agent_inner_tools: HashMap::new(),
                agent_backend_ref: HashMap::new(),
                agent_blocks: HashMap::new(),
                agent_block_seq: HashMap::new(),
                agent_blocks_dropped: HashMap::new(),
                block_buffer,
                // session-attachments FR-17: the file of every attachment still
                // 'staged' is deleted right here, and the record dropped —
                // composer drafts do not survive a restart, so a surviving
                // staged record is by definition abandoned. Crash-proof in a way
                // a shutdown hook is not.
                attachments: sweep_staged(m.attachments),
                mcp: HashMap::new(),
                workflows: HashMap::new(),
                workflow_order: Vec::new(),
                workflow_by_tool: HashMap::new(),
                workflow_scripts: HashMap::new(),
                cli_commands: Vec::new(),
            },
        );
    }
    drop(map);
    // Start a diff watcher per restored session (FR-15).
    for (id, cwd) in watched {
        crate::diff::watch_session(app, &id, &cwd);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::testutil::*;
    use serde_json::json;

    #[test]
    fn transcript_block_roundtrips_finalized() {
        let b = BufBlock {
            block_id: "b1".into(),
            kind: BlockKind::Tool,
            text: String::new(),
            tool: "Edit".into(),
            summary: "src/x.rs".into(),
            meta: Some("+3 \u{2212}1".into()),
            card: None,
            streaming: true, // in-memory streaming flag must NOT round-trip
        };
        let line = serde_json::to_string(&persisted_block_json(&b)).unwrap();
        let back = parse_persisted_block(&line).expect("parse");
        assert_eq!(back.block_id, "b1");
        assert_eq!(back.tool, "Edit");
        assert_eq!(back.summary, "src/x.rs");
        assert_eq!(back.meta.as_deref(), Some("+3 \u{2212}1"));
        assert!(!back.streaming); // reloaded blocks are always finalized (FR-5)
        assert!(matches!(back.kind, BlockKind::Tool));
    }

    #[test]
    fn transcript_user_block_has_null_meta() {
        let b = BufBlock {
            block_id: "u1".into(),
            kind: BlockKind::User,
            text: "hi".into(),
            tool: String::new(),
            summary: String::new(),
            meta: None,
            card: None,
            streaming: false,
        };
        let line = serde_json::to_string(&persisted_block_json(&b)).unwrap();
        assert!(line.contains("\"meta\":null"));
        let back = parse_persisted_block(&line).unwrap();
        assert_eq!(back.text, "hi");
        assert!(back.meta.is_none());
        assert!(matches!(back.kind, BlockKind::User));
    }

    #[test]
    fn transcript_skips_malformed_lines() {
        assert!(parse_persisted_block("not json").is_none());
        assert!(parse_persisted_block(r#"{"kind":"user"}"#).is_none()); // missing blockId
        assert!(parse_persisted_block(r#"{"blockId":"x","kind":"bogus"}"#).is_none()); // unknown kind
        assert!(parse_persisted_block("").is_none()); // partial/empty trailing line (FR-15)
    }

    #[test]
    fn transcript_subagent_block_roundtrips() {
        let b = BufBlock {
            block_id: "s1".into(),
            kind: BlockKind::Subagent,
            text: "opus".into(), // …and the dispatch's model lives in `text`
            tool: String::new(),
            summary: "explorer".into(), // subagent name lives in `summary`
            meta: Some("done".into()),
            card: None,
            streaming: false,
        };
        let back =
            parse_persisted_block(&serde_json::to_string(&persisted_block_json(&b)).unwrap())
                .unwrap();
        assert!(matches!(back.kind, BlockKind::Subagent));
        assert_eq!(back.summary, "explorer");
        assert_eq!(back.meta.as_deref(), Some("done"));
        // a reloaded transcript still shows which model the subagent ran on
        assert_eq!(classify_block(&back)["agentModel"], "opus");
    }

    #[test]
    fn persisted_permission_and_runtime_defaults() {
        // pre-feature record → defaults
        let old = serde_json::json!({ "id": "a", "name": "n", "cwd": "/x" });
        let m = parse_session_record(&old, 5).unwrap();
        assert_eq!(m.permission_mode, "default");
        assert_eq!(m.runtime, "native");
        // valid persisted mode round-trips
        let full = serde_json::json!({ "id": "a", "name": "n", "cwd": "/x", "permissionMode": "plan", "runtime": "native" });
        assert_eq!(
            parse_session_record(&full, 5).unwrap().permission_mode,
            "plan"
        );
        // modes we don't offer (e.g. "auto") sanitize back to default
        let bad =
            serde_json::json!({ "id": "a", "name": "n", "cwd": "/x", "permissionMode": "auto" });
        assert_eq!(
            parse_session_record(&bad, 5).unwrap().permission_mode,
            "default"
        );
    }

    #[test]
    fn session_record_backward_compat_and_full() {
        // pre-durable-sessions record lacks the three new fields → safe defaults (FR-3/4)
        let old = json!({ "id": "abc", "name": "proj", "cwd": "/x", "modelId": "opus" });
        let m = parse_session_record(&old, 4242).expect("parse");
        assert_eq!((m.id.as_str(), m.model_id.as_str()), ("abc", "opus"));
        assert!(m.claude_session_id.is_none());
        assert_eq!(m.context_used_tokens, 0);
        assert_eq!(m.last_activity_at, 4242); // default `now`
                                              // full record restores all three
        let full = json!({ "id": "d", "name": "n", "cwd": "/y", "modelId": "sonnet",
            "claudeSessionId": "cs-1", "lastActivityAt": 99u64, "contextUsedTokens": 512u64 });
        let m2 = parse_session_record(&full, 0).unwrap();
        assert_eq!(m2.claude_session_id.as_deref(), Some("cs-1"));
        assert_eq!((m2.last_activity_at, m2.context_used_tokens), (99, 512));
        // healing of a legacy made-up id
        assert_eq!(
            parse_session_record(
                &json!({ "id": "z", "name": "n", "cwd": "/", "modelId": "claude-opus-4" }),
                0
            )
            .unwrap()
            .model_id,
            "opus"
        );
        // missing required field → None
        assert!(parse_session_record(&json!({ "name": "x" }), 0).is_none());
    }

    #[test]
    fn worktree_and_worktree_distro_round_trip_through_a_persisted_record() {
        // session-worktree FR-12/FR-10: `SessionWorktree` and the sibling
        // `worktreeDistro` key both round-trip through the same rec-building
        // logic `persist` uses (reproduced here, same pattern as the projectId
        // round-trip test above, to avoid needing a live AppHandle).
        let wt = SessionWorktree {
            branch: "feat/x".into(),
            base_ref: "main".into(),
            path: "/home/u/.francois-worktrees/api/feat-x".into(),
            source_repo_root: "/home/u/api".into(),
            created_branch: true,
            fetched: true,
            fetch_error: None,
        };
        let mut s = test_session();
        s.worktree = Some(wt.clone());
        s.worktree_distro = Some("Ubuntu".into());

        let mut rec = serde_json::json!({ "id": s.id, "name": s.name, "cwd": s.cwd });
        if let Some(wt) = &s.worktree {
            rec["worktree"] = serde_json::to_value(wt).unwrap();
        }
        if let Some(distro) = &s.worktree_distro {
            rec["worktreeDistro"] = Value::String(distro.clone());
        }

        let parsed = parse_session_record(&rec, 0).expect("parse");
        assert_eq!(parsed.worktree, Some(wt.clone()));
        assert_eq!(parsed.worktree_distro.as_deref(), Some("Ubuntu"));

        // A native-host worktree (no distro) omits the key entirely, same
        // omit-not-null convention as projectId — a pre-feature reader must never
        // see a null.
        let mut native_rec = serde_json::json!({ "id": "n1", "name": "n", "cwd": "/x" });
        native_rec["worktree"] = serde_json::to_value(&wt).unwrap();
        assert!(native_rec.get("worktreeDistro").is_none());
        assert_eq!(
            parse_session_record(&native_rec, 0)
                .unwrap()
                .worktree_distro,
            None
        );
    }

    #[test]
    fn attachments_round_trip_through_a_persisted_record() {
        // session-attachments §6: the Vec<Attachment> is persisted alongside the
        // session (same store as SessionMeta) — that is what makes FR-17's
        // start-up sweep survive a crash.
        let a = Attachment {
            id: "at-1".into(),
            session_id: "s1".into(),
            kind: "image".into(),
            origin_path: None,
            stored_path: "/repo/.francois/attachments/a3f9c1e2/p.png".into(),
            ref_path: ".francois/attachments/a3f9c1e2/p.png".into(),
            name: "p.png".into(),
            bytes: 3,
            copied: true,
            state: "sent".into(),
            created_at: 9,
        };
        let mut rec = json!({ "id": "s1", "name": "n", "cwd": "/x" });
        rec["attachments"] = serde_json::to_value(vec![a.clone()]).unwrap();
        assert_eq!(parse_session_record(&rec, 0).unwrap().attachments, vec![a]);

        // a pre-feature record simply has no key
        let base = json!({ "id": "s1", "name": "n", "cwd": "/x" });
        assert!(parse_session_record(&base, 0)
            .unwrap()
            .attachments
            .is_empty());

        // one malformed entry is skipped, never costing the session its record
        let mut bad = base.clone();
        bad["attachments"] = json!([{ "id": "broken" }, "nonsense"]);
        assert!(parse_session_record(&bad, 0)
            .unwrap()
            .attachments
            .is_empty());
    }

    #[test]
    fn a_session_with_no_attachments_writes_no_attachments_key() {
        // Same omit-not-null convention as projectId/worktree: a pre-feature
        // reader must see no key at all (the rec-building logic `persist` uses,
        // reproduced here as the worktree round-trip test does).
        let s = test_session();
        let mut rec = serde_json::json!({ "id": s.id });
        if !s.attachments.is_empty() {
            rec["attachments"] = serde_json::to_value(&s.attachments).unwrap();
        }
        assert!(rec.get("attachments").is_none());
    }

    #[test]
    fn valid_session_id_blocks_traversal() {
        assert!(valid_session_id("11111111-2222-3333-4444-555555555555"));
        assert!(!valid_session_id("../../etc/passwd"));
        assert!(!valid_session_id("a/b"));
        assert!(!valid_session_id("a\\b"));
        assert!(!valid_session_id(""));
    }

    #[test]
    fn persisted_command_block_roundtrips() {
        let mut s = test_session();
        s.buf_command_pending("c1", "cost");
        s.buf_command_output(
            "c1",
            "cost",
            json!({ "kind": "usage", "command": "cost", "meters": [], "tail": "" }),
        );
        let line = serde_json::to_string(&persisted_block_json(&s.block_buffer[0])).unwrap();
        let back = parse_persisted_block(&line).expect("parse");
        assert!(matches!(back.kind, BlockKind::Command));
        assert_eq!(back.tool, "cost"); // command token rides in `tool`
        assert!(!back.streaming);
        assert_eq!(
            back.card,
            Some(json!({ "kind": "usage", "command": "cost", "meters": [], "tail": "" }))
        );
    }

    #[test]
    fn persisted_command_block_requires_card() {
        // FR-24: pending blocks are never persisted → a card-less command line is malformed
        assert!(
            parse_persisted_block(r#"{"blockId":"c1","kind":"command","command":"usage"}"#)
                .is_none()
        );
        assert!(parse_persisted_block(
            r#"{"blockId":"c1","kind":"command","command":"usage","card":null}"#
        )
        .is_none());
    }

    #[test]
    fn persisted_question_block_roundtrips_cancelled() {
        let mut s = test_session();
        let qs = json!([{ "question": "Q", "header": "H", "options": [], "multiSelect": false }]);
        s.buf_question("q1", qs.clone());
        s.buf_question_resolve("q1", "cancelled", None);
        let v = persisted_block_json(&s.block_buffer[0]);
        assert_eq!(
            v,
            json!({ "blockId": "q1", "kind": "question", "questions": qs, "state": "cancelled" })
        );
        let back = parse_persisted_block(&v.to_string()).expect("parse");
        assert!(matches!(back.kind, BlockKind::Question));
        assert!(!back.streaming);
        assert_eq!(classify_block(&back)["state"], "cancelled");
    }

    #[test]
    fn persisted_pending_question_reloads_as_cancelled() {
        // §6: pending entries are memory-only — a persisted "pending" line can only
        // be read back after a hard kill, and a dead process has no answerable
        // questions, so reload normalizes it to cancelled.
        let line = r#"{"blockId":"q1","kind":"question","questions":[],"state":"pending"}"#;
        let back = parse_persisted_block(line).expect("parse");
        assert!(!back.streaming);
        assert_eq!(classify_block(&back)["state"], "cancelled");
    }

    #[test]
    fn transcript_upserts_by_block_id_on_reload() {
        // FR-15: exactly one block per blockId — the LAST line wins, at the FIRST
        // occurrence's position (the durable-sessions upsert rule).
        let content = concat!(
            r#"{"blockId":"u1","kind":"user","text":"hi","tool":"","summary":"","meta":null}"#,
            "\n",
            r#"{"blockId":"q1","kind":"question","questions":[{"question":"Q","header":"H","options":[],"multiSelect":false}],"state":"pending"}"#,
            "\n",
            r#"{"blockId":"a1","kind":"assistant","text":"ok","tool":"","summary":"","meta":null}"#,
            "\n",
            r#"{"blockId":"q1","kind":"question","questions":[{"question":"Q","header":"H","options":[],"multiSelect":false}],"state":"answered","answers":{"Q":"A"}}"#,
            "\n",
        );
        let blocks = parse_transcript(content);
        assert_eq!(blocks.len(), 3);
        assert_eq!(blocks[1].block_id, "q1"); // position of the first occurrence
        let q = classify_block(&blocks[1]);
        assert_eq!(q["state"], "answered");
        assert_eq!(q["answers"], json!({ "Q": "A" }));
    }

    #[test]
    fn permission_block_round_trips_through_the_transcript() {
        let mut s = perm_session();
        let ask = serde_json::to_value(crate::permissions::build_ask(
            "Bash",
            &json!({ "command": "ls" }),
            "/repo",
        ))
        .unwrap();
        s.buf_permission("p1", ask);
        let rule = serde_json::to_value(sample_rule()).unwrap();
        let resolved = s
            .buf_permission_resolve("p1", "denied", Some(&rule))
            .unwrap();
        let line = persisted_block_json(&resolved);
        let back = parse_persisted_block(&line.to_string()).expect("parse");
        assert!(matches!(back.kind, BlockKind::Permission));
        assert!(!back.streaming);
        let v = classify_block(&back);
        assert_eq!(v["state"], "denied");
        assert_eq!(v["ask"]["summary"], "ls");
        assert_eq!(v["rule"]["id"], "local|allow|Bash(npm test:*)");
    }

    #[test]
    fn persisted_pending_permission_reloads_as_cancelled() {
        // FR-25 / §7 #9: pending entries are memory-only, so a "pending" line on
        // disk can only come from a hard kill — a dead process has no answerable
        // asks. `allowed`/`denied` survive verbatim.
        let pending = r#"{"blockId":"p1","kind":"permission","ask":{},"state":"pending"}"#;
        let back = parse_persisted_block(pending).expect("parse");
        assert!(!back.streaming);
        assert_eq!(classify_block(&back)["state"], "cancelled");

        for state in ["allowed", "denied"] {
            let line =
                format!(r#"{{"blockId":"p1","kind":"permission","ask":{{}},"state":"{state}"}}"#);
            assert_eq!(
                classify_block(&parse_persisted_block(&line).expect("parse"))["state"],
                state
            );
        }
    }
}

#[cfg(test)]
mod project_link_tests {
    //! projects FR-9/FR-18/FR-19/FR-20 — the session-linking layer. Before this
    //! module the whole layer had zero coverage and FR-18's central rule lived
    //! inline inside `load_persisted`, where an AppHandle made it untestable.

    use super::*;
    use crate::session::testutil::*;
    use serde_json::json;

    fn known(ids: &[&str]) -> HashSet<String> {
        ids.iter().map(|s| (*s).to_string()).collect()
    }

    fn linked_session(id: &str, project_id: Option<&str>) -> Session {
        let mut s = test_session();
        s.id = id.to_string();
        s.project_id = project_id.map(String::from);
        s
    }

    // ---------- FR-18: does a persisted link still resolve? ----------

    #[test]
    fn resolve_link_keeps_a_live_project_and_drops_a_removed_one() {
        let reg = known(&["p1", "p2"]);
        assert_eq!(resolve_link(Some("p1".into()), &reg), Some("p1".into()));
        // §7 #14 / §9: "a persisted projectId pointing at a removed project is dropped"
        assert_eq!(resolve_link(Some("gone".into()), &reg), None);
        // a pre-projects record has no link at all and must stay unlinked
        assert_eq!(resolve_link(None, &reg), None);
        // an EMPTY registry drops every link rather than trusting the file
        assert_eq!(resolve_link(Some("p1".into()), &known(&[])), None);
    }

    // ---------- FR-18: the wire shape (absent, never null) ----------

    #[test]
    fn session_meta_omits_project_id_entirely_when_unlinked() {
        let v = serde_json::to_value(linked_session("s1", None).meta()).unwrap();
        assert!(
            v.get("projectId").is_none(),
            "FR-18: an unlinked session must OMIT the key, not send null: {v}"
        );
        let v = serde_json::to_value(linked_session("s1", Some("p1")).meta()).unwrap();
        assert_eq!(v["projectId"], "p1");
    }

    #[test]
    fn persisted_record_omits_project_id_when_unlinked_and_carries_it_when_linked() {
        // §9: "SessionMeta.projectId round-trips through sessions.json"
        for (project_id, expect) in [(None, None), (Some("p1"), Some("p1"))] {
            let engine = test_engine_with(linked_session("s1", project_id));
            let map = engine.sessions.lock().unwrap();
            let s = map.get("s1").unwrap();
            let mut rec = serde_json::json!({ "id": s.id });
            if let Some(pid) = &s.project_id {
                rec["projectId"] = Value::String(pid.clone());
            }
            assert_eq!(rec.get("projectId").and_then(|v| v.as_str()), expect);
        }
    }

    // ---------- FR-18: parsing a record back ----------

    #[test]
    fn parse_session_record_reads_project_id_and_treats_blank_as_unlinked() {
        let base = json!({ "id": "s1", "name": "n", "cwd": "/x" });
        let with = |v: Value| {
            let mut r = base.clone();
            r["projectId"] = v;
            parse_session_record(&r, 0).unwrap().project_id
        };
        // a pre-projects record simply has no key — §9's "loads unlinked"
        assert_eq!(parse_session_record(&base, 0).unwrap().project_id, None);
        assert_eq!(with(json!("p1")), Some("p1".to_string()));
        // a hand-edited file must not mint an unlinkable id
        assert_eq!(with(json!("")), None);
        assert_eq!(with(json!("   ")), None);
        assert_eq!(with(json!(null)), None);
        assert_eq!(with(json!(42)), None);
    }

    // ---------- FR-9: removing a project unlinks exactly its own sessions ----------

    #[test]
    fn clear_project_unlinks_only_matching_sessions_and_reports_them() {
        let engine = test_engine_with(linked_session("s1", Some("p1")));
        {
            let mut map = engine.sessions.lock().unwrap();
            map.insert("s2".into(), linked_session("s2", Some("p2")));
            map.insert("s3".into(), linked_session("s3", None));
        }

        let changed = engine.clear_project("p1");

        // exactly the p1 session is reported, already carrying the cleared value
        assert_eq!(changed.len(), 1);
        assert_eq!(changed[0].id, "s1");
        assert_eq!(changed[0].project_id, None);

        let map = engine.sessions.lock().unwrap();
        assert_eq!(map.get("s1").unwrap().project_id, None);
        // §7 #15: the other sessions keep running, untouched
        assert_eq!(map.get("s2").unwrap().project_id.as_deref(), Some("p2"));
        assert_eq!(map.get("s3").unwrap().project_id, None);
        assert_eq!(map.len(), 3, "no session is ever removed by an unlink");
    }

    // ---------- the post-insert TOCTOU decision (session_create) ----------

    #[test]
    fn toctou_outcome_keeps_a_live_link_and_clears_a_vanished_one() {
        use crate::session::commands::toctou_outcome;
        // the project survived the window: keep the link exactly as given
        assert_eq!(
            toctou_outcome(Some("p1".into()), true),
            Some("p1".to_string())
        );
        // project_remove landed between the pre-create check and the insert: unlink,
        // so the live board never carries a dangling id (it would otherwise self-heal
        // only at the next launch, via resolve_link above)
        assert_eq!(toctou_outcome(Some("p1".into()), false), None);
        // an unlinked session has nothing to lose either way
        assert_eq!(toctou_outcome(None, true), None);
        assert_eq!(toctou_outcome(None, false), None);
    }

    // ---------- multi-account FR-9/FR-10/FR-19: the account link ----------

    #[test]
    fn session_meta_always_carries_an_account_id() {
        // FR-19 / contract: `accountId` is REQUIRED on the wire — unlike
        // projectId it is never omitted, because a session always has an account.
        let v = serde_json::to_value(test_session().meta()).unwrap();
        assert_eq!(v["accountId"], "default");

        let mut s = test_session();
        s.account_id = "a1".into();
        assert_eq!(
            serde_json::to_value(s.meta()).unwrap()["accountId"],
            "a1",
            "the stored value is reported verbatim, never re-derived"
        );
    }

    #[test]
    fn account_id_round_trips_through_a_persisted_record() {
        // FR-19: "restarting the app preserves every session's account" (§9).
        let mut s = test_session();
        s.account_id = "a1".into();
        let rec = json!({ "id": s.id, "name": s.name, "cwd": s.cwd, "accountId": s.account_id });
        assert_eq!(
            parse_session_record(&rec, 0).unwrap().account_id.as_deref(),
            Some("a1")
        );
        // a pre-multi-account record simply has no key
        let old = json!({ "id": "s1", "name": "n", "cwd": "/x" });
        assert_eq!(parse_session_record(&old, 0).unwrap().account_id, None);
        // a hand-edited blank must not bind the session to an unusable id
        for blank in [json!(""), json!("   "), json!(null), json!(42)] {
            let mut r = old.clone();
            r["accountId"] = blank;
            assert_eq!(parse_session_record(&r, 0).unwrap().account_id, None);
        }
    }

    // ---------- cloud-sessions FR-10: provenance ----------

    #[test]
    fn session_meta_omits_cloud_entirely_unless_the_session_was_adopted() {
        // FR-16: presence is the WHOLE signal behind the `cloud` chip, so an
        // ordinary session must carry no key at all — a `null` would read as
        // "adopted, details unknown".
        let mut s = test_session();
        assert!(
            serde_json::to_value(s.meta())
                .unwrap()
                .get("cloud")
                .is_none(),
            "a session that was never adopted must not mention cloud"
        );
        s.cloud = Some(CloudProvenance {
            cloud_session_id: "session_01AB".into(),
            adopted_at: 1_784_573_689_516,
        });
        let meta = serde_json::to_value(s.meta()).unwrap();
        assert_eq!(meta["cloud"]["cloudSessionId"], "session_01AB");
        assert_eq!(meta["cloud"]["adoptedAt"], 1_784_573_689_516u64);
    }

    #[test]
    fn cloud_provenance_round_trips_through_a_persisted_record() {
        // §9: "survives quit/reopen with its provenance". Nothing ELSE about the
        // cloud session is stored — no cached list, no token (§6).
        let rec = json!({
            "id": "s1", "name": "n", "cwd": "/x",
            "cloud": { "cloudSessionId": "session_01AB", "adoptedAt": 1_784_573_689_516u64 }
        });
        let parsed = parse_session_record(&rec, 0).unwrap().cloud.unwrap();
        assert_eq!(parsed.cloud_session_id, "session_01AB");
        assert_eq!(parsed.adopted_at, 1_784_573_689_516);

        // Every pre-feature record, and every non-adopted session, has no key.
        let old = json!({ "id": "s1", "name": "n", "cwd": "/x" });
        assert!(parse_session_record(&old, 0).unwrap().cloud.is_none());
        // A malformed value loads as "not adopted" rather than costing the
        // session its whole record — only the chip depends on it.
        for bad in [
            json!(null),
            json!("session_01AB"),
            json!({ "adoptedAt": 1 }),
        ] {
            let mut r = old.clone();
            r["cloud"] = bad;
            assert!(parse_session_record(&r, 0).unwrap().cloud.is_none());
        }
    }

    #[test]
    fn resolve_account_falls_back_to_default_rather_than_unlinking() {
        // FR-10 / §7: an accountId that resolves to no registry entry — and every
        // pre-feature record — loads as 'default'.
        let reg = known(&["default", "a1"]);
        assert_eq!(resolve_account(Some("a1".into()), &reg), "a1");
        assert_eq!(resolve_account(Some("gone".into()), &reg), "default");
        assert_eq!(resolve_account(None, &reg), "default");
        // an empty registry still resolves the built-in id (FR-2)
        assert_eq!(resolve_account(Some("a1".into()), &known(&[])), "default");
    }

    #[test]
    fn clear_account_repoints_only_matching_sessions_and_reports_them() {
        // FR-9: the sessions keep running, merely repointed onto `default`.
        let mut bound = test_session();
        bound.id = "s1".into();
        bound.account_id = "a1".into();
        let engine = test_engine_with(bound);
        {
            let mut map = engine.sessions.lock().unwrap();
            let mut other = test_session();
            other.id = "s2".into();
            other.account_id = "a2".into();
            map.insert("s2".into(), other);
            let mut plain = test_session();
            plain.id = "s3".into();
            map.insert("s3".into(), plain);
        }

        let changed = engine.clear_account("a1");

        assert_eq!(changed.len(), 1);
        assert_eq!(changed[0].id, "s1");
        assert_eq!(changed[0].account_id, "default");

        {
            let map = engine.sessions.lock().unwrap();
            assert_eq!(map.get("s1").unwrap().account_id, "default");
            assert_eq!(map.get("s2").unwrap().account_id, "a2", "untouched");
            assert_eq!(map.get("s3").unwrap().account_id, "default");
            assert_eq!(map.len(), 3, "no session is ever removed by a repoint");
        }
        assert!(engine.clear_account("nobody").is_empty());
    }

    #[test]
    fn live_account_ids_reports_each_bound_account_once() {
        // FR-29: the background tick probes exactly these (plus the isDefault
        // account) — never an account with no sessions at all.
        let mut a = test_session();
        a.id = "s1".into();
        a.account_id = "a1".into();
        let engine = test_engine_with(a);
        {
            let mut map = engine.sessions.lock().unwrap();
            let mut b = test_session();
            b.id = "s2".into();
            b.account_id = "a1".into();
            map.insert("s2".into(), b);
        }
        assert_eq!(engine.live_account_ids(), vec!["a1".to_string()]);
    }

    #[test]
    fn clear_project_for_an_unreferenced_project_changes_nothing() {
        let engine = test_engine_with(linked_session("s1", Some("p1")));
        assert!(engine.clear_project("nobody").is_empty());
        let map = engine.sessions.lock().unwrap();
        assert_eq!(map.get("s1").unwrap().project_id.as_deref(), Some("p1"));
    }
}
