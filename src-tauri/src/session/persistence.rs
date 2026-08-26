//! sessions.json + per-session transcript persistence (FR-42/43).

use super::*;

use serde_json::Value;
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

// ---------- persistence (FR-42/43) ----------

pub fn sessions_json_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("sessions.json"))
}

// ---------- transcript persistence (durable-sessions) ----------

/// A session id must be a uuid-charset token so it can never escape the transcripts
/// dir (no `/`, `\`, `..`). Defense-in-depth against a tampered/legacy sessions.json.
pub fn valid_session_id(id: &str) -> bool {
    !id.is_empty() && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

pub fn transcript_path(app: &AppHandle, session_id: &str) -> Option<std::path::PathBuf> {
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
    // design 9a: `at` rides the line so a reopened session states when each turn
    // actually happened. Only the four base kinds carry it — the card kinds
    // (command/question/permission) render their own chrome and never a clock.
    serde_json::json!({
        "blockId": b.block_id, "kind": kind, "text": b.text,
        "tool": b.tool, "summary": b.summary, "meta": b.meta, "at": b.at,
    })
}

/// Append one finalized block as a JSON line to the session's transcript (FR-1/2).
/// Best-effort: a write failure is ignored so it never breaks the turn (§7).
pub fn append_transcript(app: &AppHandle, session_id: &str, block: &BufBlock) {
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
pub fn clear_transcript(app: &AppHandle, session_id: &str) {
    if let Some(path) = transcript_path(app, session_id) {
        let _ = std::fs::remove_file(&path);
    }
}

/// Parse one PersistedBlock line back into a BufBlock. Returns None for a malformed
/// or partial line so reload can skip it (FR-15).
pub fn parse_persisted_block(line: &str) -> Option<BufBlock> {
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
            // NOT `unwrap_or("cancelled")`, though clippy's `manual_unwrap_or`
            // suggests exactly that: this is a WHITELIST, not a null-check. Only
            // `allowed`/`denied` are terminal states worth replaying — any other
            // value, `pending` above all, means the app died with the card still
            // on screen, and must reload as `cancelled`. `unwrap_or` would catch
            // only an ABSENT key and let `pending` through, resurrecting a
            // permission prompt that can never be answered.
            // (Regression test: persisted_pending_permission_reloads_as_cancelled.)
            #[allow(clippy::manual_unwrap_or)]
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
        // design 9a: a line written before `at` existed reads back as 0, which
        // classify_block serializes as an ABSENT key — the reload must not
        // re-date an old turn to the moment it was read.
        at: v.get("at").and_then(|a| a.as_u64()).unwrap_or(0),
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
pub fn parse_transcript(content: &str) -> Vec<BufBlock> {
    let mut out: Vec<BufBlock> = Vec::new();
    for b in content.lines().filter_map(parse_persisted_block) {
        match out.iter_mut().find(|e| e.block_id == b.block_id) {
            Some(slot) => *slot = b,
            None => out.push(b),
        }
    }
    out
}

/// core-architecture-fixes FR-8: the tail-read window. Sized generously above
/// `TRANSCRIPT_BUFFER_CAP` (400) blocks' worth of bytes so the tail reliably
/// contains them even for large assistant-text blocks — a persisted line
/// rarely exceeds a few KB, so 4 MiB is a wide margin over 400 lines. Boot
/// cost is then bounded by this constant regardless of how large the whole
/// transcript file has grown (a file shorter than it is read whole).
const TRANSCRIPT_TAIL_BYTES: u64 = 4 * 1024 * 1024;

/// FR-8: read at most the last `k` bytes of `path`, discarding the leading
/// (necessarily partial, since we seeked mid-line) line — bounded work
/// regardless of file size. Never surfaces an error: a transcript is a
/// convenience, not a correctness input (edge case #5), so any failure here
/// degrades to "nothing read" exactly as the old whole-file read did.
fn read_tail(path: &std::path::Path, k: u64) -> String {
    use std::io::{Read, Seek, SeekFrom};
    let Ok(mut f) = std::fs::File::open(path) else {
        return String::new();
    };
    let Ok(len) = f.metadata().map(|m| m.len()) else {
        return String::new();
    };
    let start = len.saturating_sub(k);
    if start > 0 && f.seek(SeekFrom::Start(start)).is_err() {
        return String::new();
    }
    let mut buf = Vec::new();
    if f.read_to_end(&mut buf).is_err() {
        return String::new();
    }
    let text = String::from_utf8_lossy(&buf).into_owned();
    if start == 0 {
        return text; // file shorter than k: read whole, no partial leading line
    }
    // Discard the leading partial line. If the whole tail turns out to be one
    // (no newline at all — pathologically long single line), there is nothing
    // safe to parse from it; that mirrors parse_transcript's existing
    // skip-malformed-lines behaviour (FR-15) rather than inventing a new one.
    match text.find('\n') {
        Some(idx) => text[idx + 1..].to_string(),
        None => String::new(),
    }
}

/// Read a session's persisted transcript back into a block buffer (FR-5).
/// FR-8: bounded to a tail read regardless of the file's total size.
pub fn read_transcript(app: &AppHandle, session_id: &str) -> Vec<BufBlock> {
    let Some(path) = transcript_path(app, session_id) else {
        return Vec::new();
    };
    let content = read_tail(&path, TRANSCRIPT_TAIL_BYTES);
    parse_transcript(&content)
}

pub fn persist(app: &AppHandle, engine: &Engine) {
    // One writer at a time: persist() is called from commands (async runtime) AND
    // from run_reader threads, and every caller writes the SAME sessions.json.tmp
    // before the atomic rename — two concurrent writers could rename a torn file.
    static PERSIST_LOCK: Mutex<()> = Mutex::new(());
    let _w = PERSIST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    // FR-1: the `MutexGuard` on `Engine.sessions` must not be live across the
    // filesystem I/O below — it is scoped to this block, so serialization
    // (building `list`) finishes and the guard drops before `to_vec_pretty` +
    // `fs::write` + `fs::rename` run. `PERSIST_LOCK` still serialises
    // concurrent writers; that invariant is unchanged.
    let list: Vec<Value> = {
        let map = engine.sessions.lock().unwrap_or_else(|p| p.into_inner());
        map
        .values()
        .map(|s| {
            let mut rec = serde_json::json!({
                "id": s.id, "name": s.name, "cwd": s.cwd, "modelId": s.model_id, "effort": s.effort,
                "permissionMode": s.permission_mode,
                // rework-top-bar (design 11c): the `on since` line must survive a
                // restart — a bypass left on last week is exactly the case the
                // line exists for.
                "permissionModeSince": s.permission_mode_since,
                "runtime": s.runtime,
                "allowGit": s.allow_git,
                "claudeSessionId": s.claude_session_id, // durable-sessions FR-3
                "lastActivityAt": s.last_activity_at,
                "contextUsedTokens": s.context_used_tokens,
                // multi-account FR-19: always written (unlike projectId) — a
                // session always has an account, and 'default' is a real value.
                "accountId": s.account_id,
                // multi-provider-seam FR-11a: always written — every session
                // has both, derived once at creation and never re-derived.
                // The superseded `provider` key is read (see
                // `parse_session_record`), never written.
                "agentRuntime": s.agent_runtime,
                "protocol": s.protocol,
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
            // session-profiles FR-19: snapshotted at creation, resumed with
            // exactly the persisted values — never re-read from the profile.
            // Same omit-not-null convention as projectId/worktree.
            if let Some(sp) = &s.system_prompt {
                rec["systemPrompt"] = Value::String(sp.clone());
            }
            if !s.extra_args.is_empty() {
                rec["extraArgs"] = serde_json::to_value(&s.extra_args).unwrap_or(Value::Null);
            }
            if let Some(p) = &s.profile {
                rec["profile"] = serde_json::to_value(p).unwrap_or(Value::Null);
            }
            rec
        })
        .collect()
    }; // FR-1: `map`'s MutexGuard drops here — no lock held across the I/O below.
    if let Some(path) = sessions_json_path(app) {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        // Atomic write (temp + rename) so a crash mid-write can't torn sessions.json —
        // it now holds every session's claudeSessionId resume anchor (FR-10).
        let bytes = serde_json::to_vec_pretty(&list).unwrap_or_default();
        let tmp = path.with_extension("json.tmp");
        if std::fs::write(&tmp, &bytes).is_ok() && std::fs::rename(&tmp, &path).is_err() {
            let _ = std::fs::remove_file(&tmp);
        }
    }
}

/// Scalar fields parsed from a persisted session record. Backward-compatible:
/// records from before durable-sessions lack claudeSessionId/lastActivityAt/
/// contextUsedTokens → None / `now` / 0 (FR-3/4). Transcript is loaded separately.
pub struct PersistedMeta {
    id: String,
    name: String,
    cwd: String,
    model_id: String,
    effort: Option<String>,
    permission_mode: String, // "default" when absent (pre-feature records)
    /// rework-top-bar (design 11c): `None` on every pre-feature record — the load
    /// path then falls back to the session's own `lastActivityAt`, which is the
    /// closest instant we can honestly claim the mode has been in force since.
    permission_mode_since: Option<u64>,
    runtime: String, // "native" when absent, or when "wsl" off-Windows
    allow_git: bool, // false when absent (pre-feature records)
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
    /// multi-provider-seam FR-11a: both absent ⇒ `(ClaudeCode, Anthropic)`.
    /// A record carrying the superseded `provider` key maps
    /// `'claude-code'` → `(ClaudeCode, Anthropic)`,
    /// `'openai-compatible'` → `(Francois, Openai)` — see
    /// `parse_session_record`'s migration.
    agent_runtime: AgentRuntime,
    protocol: ProviderProtocol,
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
    /// session-profiles FR-19: None on every pre-feature record. A
    /// whitespace-only value normalizes to None, matching the
    /// registry's own edge case (§7).
    system_prompt: Option<String>,
    /// session-profiles FR-19: empty on every pre-feature record.
    extra_args: Vec<String>,
    /// session-profiles FR-16/FR-19: None on every pre-feature record, and
    /// on every session not created from a profile. A malformed value loads
    /// as "no profile" rather than costing the session its whole record —
    /// only the chip depends on it.
    profile: Option<SessionProfileRef>,
}

/// multi-provider-seam FR-11a (Phase B gate): the read-side migration off the
/// superseded single `provider` key onto the two axes.
///
///   - both `agentRuntime`/`protocol` present and parse ⇒ used verbatim (the
///     current write shape — see `persist`).
///   - else a legacy `provider` string is mapped: `'claude-code'` ⇒
///     `(ClaudeCode, Anthropic)`, `'openai-compatible'` ⇒ `(Francois, Openai)`.
///   - else (both absent, or an unrecognised value either way) ⇒ the default
///     pair `(ClaudeCode, Anthropic)` — every session on disk from before this
///     feature, or written by a build in between, is unaffected.
///
/// Save-side (`persist`) writes only the two new keys; the legacy key is read
/// here, never written.
fn parse_agent_runtime_and_protocol(rec: &Value) -> (AgentRuntime, ProviderProtocol) {
    let runtime = rec
        .get("agentRuntime")
        .and_then(|v| serde_json::from_value::<AgentRuntime>(v.clone()).ok());
    let protocol = rec
        .get("protocol")
        .and_then(|v| serde_json::from_value::<ProviderProtocol>(v.clone()).ok());
    if let (Some(r), Some(p)) = (runtime, protocol) {
        return (r, p);
    }
    match rec.get("provider").and_then(|v| v.as_str()) {
        Some("claude-code") => (AgentRuntime::ClaudeCode, ProviderProtocol::Anthropic),
        Some("openai-compatible") => (AgentRuntime::Francois, ProviderProtocol::Openai),
        _ => (AgentRuntime::default(), ProviderProtocol::default()),
    }
}

pub fn parse_session_record(rec: &Value, now: u64) -> Option<PersistedMeta> {
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
    // multi-provider-seam FR-11a: computed once, ahead of the literal below —
    // see `parse_agent_runtime_and_protocol`'s doc comment for the migration.
    let (agent_runtime, protocol) = parse_agent_runtime_and_protocol(rec);
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
        permission_mode_since: rec
            .get("permissionModeSince")
            .and_then(|v| v.as_u64())
            .filter(|t| *t > 0),
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
        agent_runtime,
        protocol,
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
        // session-profiles FR-19 / edge case §7: whitespace-only reads back
        // as absent, the same normalization the registry applies at save.
        system_prompt: rec
            .get("systemPrompt")
            .and_then(|v| v.as_str())
            .filter(|s| !s.trim().is_empty())
            .map(String::from),
        extra_args: rec
            .get("extraArgs")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|t| t.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default(),
        profile: rec
            .get("profile")
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
pub fn resolve_link(persisted: Option<String>, known: &HashSet<String>) -> Option<String> {
    persisted.filter(|id| known.contains(id))
}

/// multi-account FR-10: the same pruning discipline for `accountId`, except the
/// field is REQUIRED — an absent or no-longer-resolving value loads as the
/// built-in `default` account rather than as "unlinked".
pub fn resolve_account(persisted: Option<String>, known: &HashSet<String>) -> String {
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
    let changed = engine.clear_account(app, account_id);
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

pub fn unlink_project_sessions(app: &AppHandle, project_id: &str) {
    let engine = app.state::<Engine>();
    let changed = engine.clear_project(app, project_id);
    if changed.is_empty() {
        return;
    }
    persist(app, &engine);
    for meta in changed {
        emit(app, SessionEvent::Meta { meta });
    }
}

/// core-architecture-fixes FR-9: metadata only — `sessions.json` is cheap and
/// bounded, and this keeps its documented position in `.setup()` and its
/// ordering relative to projects/accounts. Every session loads with an EMPTY
/// `block_buffer`; `spawn_transcript_hydration` fills it in afterward, off
/// the main thread, so the window paints before any transcript read begins.
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
    let mut map = engine.sessions.lock().unwrap_or_else(|p| p.into_inner());
    for rec in list {
        let now = now_ms();
        let Some(m) = parse_session_record(&rec, now) else {
            continue;
        };
        // FR-9: no transcript read here — `block_buffer` starts empty and
        // `spawn_transcript_hydration` fills it in on a background thread.
        let block_buffer = Vec::new();
        let transcript_truncated = false;
        // Only a window the catalog actually KNOWS is a ceiling — see
        // `loaded_context`. `load_model_cache` runs before this, so the mirror
        // from the last run is already in hand.
        let (limit, used) =
            loaded_context(resolve_context_tokens(&m.model_id), m.context_used_tokens);
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
                // Clamped against a KNOWN window only: a record written by a
                // build that mistook the turn's cost aggregate for the context
                // could hold a figure larger than the window itself, and
                // reloading heals it — but clamping against the 200K placeholder
                // is not healing, it is destroying a number we cannot recover.
                context_used_tokens: used,
                context_limit_tokens: limit,
                started_at: now,
                last_activity_at: m.last_activity_at,
                error_message: None,
                effort: m.effort,
                permission_mode: m.permission_mode,
                permission_mode_since: m.permission_mode_since.unwrap_or(m.last_activity_at),
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
                agent_runtime: m.agent_runtime,
                protocol: m.protocol,
                // session-profiles FR-19: a resumed session spawns with ITS
                // persisted values, not the profile's current ones.
                system_prompt: m.system_prompt,
                extra_args: m.extra_args,
                profile: m.profile,
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
                transcript_truncated,
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
                // multi-provider-grok FR-27: a reload starts false again — a
                // fresh reminder after a restart is honest, not a bug.
                grok_sandbox_notice_emitted: false,
            },
        );
    }
    drop(map);
    // Start a diff watcher per restored session (FR-15).
    for (id, cwd) in watched {
        crate::diff::watch_session(app, &id, &cwd);
    }
}

/// core-architecture-fixes FR-9: hydrate every session's transcript on a
/// background thread, one session at a time, emitting `session.meta` as each
/// buffer lands. `Engine.sessions` is taken PER SESSION — never held across
/// the loop — so a live session is never blocked waiting on this thread.
///
/// Edge case #6: a session interacted with before its transcript lands must
/// not lose the buffer a live turn is building. If the session has left
/// `idle` (a turn started) by the time this reaches it, hydration for that
/// session is ABANDONED rather than merged — overwriting `block_buffer` here
/// would clobber blocks the live turn already appended.
pub fn spawn_transcript_hydration(app: AppHandle) {
    std::thread::spawn(move || {
        let engine = app.state::<Engine>();
        let ids: Vec<String> = engine
            .sessions
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .keys()
            .cloned()
            .collect();
        for id in ids {
            // The read itself needs no lock — it is a filesystem read keyed by
            // session id, same as the old inline call.
            let mut block_buffer = read_transcript(&app, &id); // FR-5/FR-8
            let transcript_truncated = trim_transcript(&mut block_buffer, TRANSCRIPT_BUFFER_CAP);

            let meta = {
                let mut map = engine.sessions.lock().unwrap_or_else(|p| p.into_inner());
                let Some(s) = map.get_mut(&id) else {
                    continue; // removed before hydration reached it
                };
                if status::is_busy(&s.status) {
                    // Edge case #6: abandon — a turn already started on this
                    // session since boot (every persisted session loads as
                    // `idle`, so leaving it means a real turn began).
                    continue;
                }
                s.block_buffer = block_buffer;
                s.transcript_truncated = transcript_truncated;
                s.meta(&app)
            };
            emit(&app, SessionEvent::Meta { meta });
        }
    });
}

/// core-architecture-fixes FR-10: the on-disk transcript retention bound —
/// matches `TRANSCRIPT_BUFFER_CAP` so a compacted file always satisfies the
/// FR-8 tail read from a cold boot (it IS the tail already). `append_transcript`
/// only ever appends, so without a disk-side counterpart to the RAM bound, the
/// file grows for the whole life of every retained session.
pub const TRANSCRIPT_COMPACT_CAP: usize = TRANSCRIPT_BUFFER_CAP;

/// Compact one session's transcript file to its last `TRANSCRIPT_COMPACT_CAP`
/// blocks. Best-effort, temp+rename: an interrupted compaction (process killed
/// mid-write) leaves the ORIGINAL file intact — `fs::rename` never partially
/// lands (edge case #7) — and any read/write failure here is silently ignored,
/// the same discipline `append_transcript`/`persist` already use. Reads and
/// re-serializes the whole file, so callers must never run this on a session
/// mid-turn (edge case #7 — the caller filters that; see
/// `compact_all_transcripts`).
pub fn compact_transcript(app: &AppHandle, session_id: &str) {
    let Some(path) = transcript_path(app, session_id) else {
        return;
    };
    compact_transcript_file(&path);
}

/// The pure file-rewrite half of `compact_transcript`, over a plain path —
/// split out so it is testable without an `AppHandle` (this crate wires up no
/// such test harness; see `session/env.rs`).
fn compact_transcript_file(path: &std::path::Path) {
    let Ok(content) = std::fs::read_to_string(path) else {
        return;
    };
    let mut blocks = parse_transcript(&content);
    if !trim_transcript(&mut blocks, TRANSCRIPT_COMPACT_CAP) {
        return; // already at or under the cap — nothing to rewrite
    }
    let mut out = String::new();
    for b in &blocks {
        out.push_str(&serde_json::to_string(&persisted_block_json(b)).unwrap_or_default());
        out.push('\n');
    }
    let tmp = path.with_extension("jsonl.tmp");
    if std::fs::write(&tmp, out.as_bytes()).is_ok() && std::fs::rename(&tmp, path).is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
}

/// FR-10: compact every session's transcript on a clean shutdown
/// (`RunEvent::Exit`, main.rs). Skips a session mid-turn (edge case #7) — its
/// transcript stays whatever `append_transcript` already wrote, uncompacted,
/// until it next quits idle.
pub fn compact_all_transcripts(app: &AppHandle) {
    let engine = app.state::<Engine>();
    let ids: Vec<String> = {
        let map = engine.sessions.lock().unwrap_or_else(|p| p.into_inner());
        map.values()
            .filter(|s| !status::is_busy(&s.status))
            .map(|s| s.id.clone())
            .collect()
    };
    for id in ids {
        compact_transcript(app, &id);
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
            at: 1_760_000_000_000,
        };
        let line = serde_json::to_string(&persisted_block_json(&b)).unwrap();
        let back = parse_persisted_block(&line).expect("parse");
        assert_eq!(back.block_id, "b1");
        assert_eq!(back.tool, "Edit");
        assert_eq!(back.summary, "src/x.rs");
        assert_eq!(back.meta.as_deref(), Some("+3 \u{2212}1"));
        assert!(!back.streaming); // reloaded blocks are always finalized (FR-5)
        assert!(matches!(back.kind, BlockKind::Tool));
        // design 9a: the append time survives the round-trip, so a reopened
        // session states when the turn happened rather than when it was read.
        assert_eq!(back.at, 1_760_000_000_000);
        assert_eq!(classify_block(&back)["at"], 1_760_000_000_000u64);
    }

    #[test]
    fn transcript_line_written_before_timestamps_reads_back_without_one() {
        // design 9a: `at` is optional in the contract precisely for these lines.
        // The reload must not re-date the turn to the moment it was read — the
        // block comes back with 0, and classify_block leaves the key out.
        let back = parse_persisted_block(
            r#"{"blockId":"b1","kind":"tool","text":"","tool":"Read","summary":"a.rs","meta":"9 lines"}"#,
        )
        .expect("parse");
        assert_eq!(back.at, 0);
        assert!(classify_block(&back).get("at").is_none());
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
            at: 1_760_000_000_000,
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
            at: 1_760_000_000_000,
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
    fn agent_runtime_and_protocol_round_trip_through_a_persisted_record() {
        // multi-provider-seam FR-11a: an explicit pair round-trips verbatim.
        let full = json!({
            "id": "abc", "name": "n", "cwd": "/x",
            "agentRuntime": "francois", "protocol": "openai",
        });
        let m = parse_session_record(&full, 0).unwrap();
        assert_eq!(m.agent_runtime, AgentRuntime::Francois);
        assert_eq!(m.protocol, ProviderProtocol::Openai);

        let claude_pair = json!({
            "id": "abc", "name": "n", "cwd": "/x",
            "agentRuntime": "claude-code", "protocol": "anthropic",
        });
        let m = parse_session_record(&claude_pair, 0).unwrap();
        assert_eq!(m.agent_runtime, AgentRuntime::ClaudeCode);
        assert_eq!(m.protocol, ProviderProtocol::Anthropic);
    }

    #[test]
    fn both_keys_absent_defaults_to_claude_code_anthropic() {
        // multi-provider-seam FR-11a Phase B gate: neither key present (every
        // session written before this feature, and before multi-provider-seam) ⇒
        // the default pair.
        let old = json!({ "id": "abc", "name": "n", "cwd": "/x" });
        let m = parse_session_record(&old, 0).unwrap();
        assert_eq!(m.agent_runtime, AgentRuntime::ClaudeCode);
        assert_eq!(m.protocol, ProviderProtocol::Anthropic);
    }

    #[test]
    fn legacy_provider_key_migrates_to_the_right_pair() {
        // multi-provider-seam FR-11a Phase B gate: a record written by the
        // pre-split build carries the single `provider` key — migrate it.
        let claude = json!({ "id": "abc", "name": "n", "cwd": "/x", "provider": "claude-code" });
        let m = parse_session_record(&claude, 0).unwrap();
        assert_eq!(m.agent_runtime, AgentRuntime::ClaudeCode);
        assert_eq!(m.protocol, ProviderProtocol::Anthropic);

        let openai =
            json!({ "id": "abc", "name": "n", "cwd": "/x", "provider": "openai-compatible" });
        let m = parse_session_record(&openai, 0).unwrap();
        assert_eq!(m.agent_runtime, AgentRuntime::Francois);
        assert_eq!(m.protocol, ProviderProtocol::Openai);

        // an unrecognised legacy value degrades to the default pair rather than
        // failing the whole record (matching the "absent" case, not a hard error).
        let bad = json!({ "id": "abc", "name": "n", "cwd": "/x", "provider": "bogus" });
        let m = parse_session_record(&bad, 0).unwrap();
        assert_eq!(m.agent_runtime, AgentRuntime::ClaudeCode);
        assert_eq!(m.protocol, ProviderProtocol::Anthropic);
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
            base_resolved: Some("refs/remotes/origin/main".into()),
            path: "/home/u/.francois-worktrees/api/feat-x".into(),
            source_repo_root: "/home/u/api".into(),
            created_branch: true,
            fetched: true,
            fetch_error: None,
            detached: None,
            adopted: None,
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
    fn worktree_detached_and_adopted_round_trip_through_a_persisted_record() {
        // attach-to-worktree §5/§6: `detached`/`adopted` persist with the session
        // like every other worktree field.
        let wt = SessionWorktree {
            branch: "1a2b3c4".into(),
            base_ref: "".into(),
            base_resolved: None,
            path: "/home/u/api-wt".into(),
            source_repo_root: "/home/u/api".into(),
            created_branch: false,
            fetched: false,
            fetch_error: None,
            detached: Some(true),
            adopted: Some(true),
        };
        let mut rec = serde_json::json!({ "id": "s1", "name": "n", "cwd": "/home/u/api-wt" });
        rec["worktree"] = serde_json::to_value(&wt).unwrap();

        let parsed = parse_session_record(&rec, 0).expect("parse");
        let parsed_wt = parsed.worktree.expect("worktree present");
        assert_eq!(parsed_wt.detached, Some(true));
        assert_eq!(parsed_wt.adopted, Some(true));
    }

    #[test]
    fn a_worktree_record_written_before_attach_to_worktree_still_loads_falsy() {
        // attach-to-worktree §6/§9 acceptance: a session persisted before this
        // feature carries no `detached`/`adopted` keys at all — they must read
        // back as `None` (falsy), never fail the whole record.
        let mut rec = serde_json::json!({ "id": "s1", "name": "n", "cwd": "/x" });
        rec["worktree"] = serde_json::json!({
            "branch": "feat/x",
            "baseRef": "main",
            "path": "/home/u/.francois-worktrees/api/feat-x",
            "sourceRepoRoot": "/home/u/api",
            "createdBranch": true,
            "fetched": true,
        });
        let parsed = parse_session_record(&rec, 0).expect("parse");
        let wt = parsed.worktree.expect("legacy worktree record still loads");
        assert_eq!(wt.detached, None);
        assert_eq!(wt.adopted, None);
    }

    #[test]
    fn a_worktree_record_written_before_base_resolved_still_loads() {
        // session-worktree FR-7b: `baseResolved` is skipped when absent, so no record
        // written before it existed carries the key. `parse_session_record` deserializes
        // with `.ok()`, so any field that failed to be optional would silently unlink the
        // session from its worktree (losing the removal guard and the FR-14 banner) rather
        // than erroring — pin that down here, as `fetchError` already relies on it too.
        let mut rec = serde_json::json!({ "id": "s1", "name": "n", "cwd": "/x" });
        rec["worktree"] = serde_json::json!({
            "branch": "feat/x",
            "baseRef": "main",
            "path": "/home/u/.francois-worktrees/api/feat-x",
            "sourceRepoRoot": "/home/u/api",
            "createdBranch": true,
            "fetched": true,
        });
        let parsed = parse_session_record(&rec, 0).expect("parse");
        let wt = parsed.worktree.expect("legacy worktree record still loads");
        assert_eq!(wt.branch, "feat/x");
        assert_eq!(wt.base_resolved, None);
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
    fn restoring_a_session_with_5000_persisted_blocks_trims_to_the_transcript_buffer_cap() {
        // transcript-scale FR-3: load_persisted is `read_transcript` (parse_transcript
        // over the file content, exercised here as a string since read_transcript
        // itself needs an AppHandle) followed by the same trim a live eviction
        // applies. Every line here is finalized (no card kind), so parse_transcript
        // reloads every block already settled (streaming: false) — nothing pins
        // eviction, exactly as a dead process leaves no answerable ask (FR-2 note).
        let mut content = String::new();
        for i in 0..5_000 {
            content.push_str(&format!(
                r#"{{"blockId":"b{i}","kind":"user","text":"m{i}","tool":"","summary":"","meta":null}}"#
            ));
            content.push('\n');
        }
        let mut blocks = parse_transcript(&content);
        assert_eq!(blocks.len(), 5_000);
        let truncated = trim_transcript(&mut blocks, TRANSCRIPT_BUFFER_CAP);
        assert!(truncated);
        assert_eq!(blocks.len(), TRANSCRIPT_BUFFER_CAP);
        // The tail survives, oldest-first: block 4600 is the first kept one
        // (5000 - 400 = 4600), block 4999 the last.
        assert_eq!(blocks[0].block_id, "b4600");
        assert_eq!(blocks.last().unwrap().block_id, "b4999");
    }

    #[test]
    fn compact_transcript_file_trims_a_file_over_the_cap_to_its_tail() {
        // FR-10: an over-cap transcript compacts to its last
        // TRANSCRIPT_COMPACT_CAP blocks, oldest-first, exactly like the
        // in-RAM trim.
        let path = std::env::temp_dir().join(format!(
            "francois-compact-test-{}.jsonl",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let mut content = String::new();
        for i in 0..(TRANSCRIPT_COMPACT_CAP + 50) {
            content.push_str(&format!(
                r#"{{"blockId":"b{i}","kind":"user","text":"m{i}","tool":"","summary":"","meta":null}}"#
            ));
            content.push('\n');
        }
        std::fs::write(&path, &content).unwrap();

        compact_transcript_file(&path);

        let after = std::fs::read_to_string(&path).unwrap();
        let blocks = parse_transcript(&after);
        assert_eq!(blocks.len(), TRANSCRIPT_COMPACT_CAP);
        assert_eq!(blocks[0].block_id, "b50");
        assert_eq!(
            blocks.last().unwrap().block_id,
            format!("b{}", TRANSCRIPT_COMPACT_CAP + 49)
        );

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn compact_transcript_file_is_a_noop_under_the_cap() {
        let path = std::env::temp_dir().join(format!(
            "francois-compact-noop-test-{}.jsonl",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let content = r#"{"blockId":"b1","kind":"user","text":"hi","tool":"","summary":"","meta":null}
"#;
        std::fs::write(&path, content).unwrap();

        compact_transcript_file(&path);

        // Untouched — a file already at/under the cap is never rewritten.
        assert_eq!(std::fs::read_to_string(&path).unwrap(), content);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn compact_transcript_file_missing_file_is_a_silent_noop() {
        let path = std::env::temp_dir().join("francois-compact-missing-test.jsonl");
        let _ = std::fs::remove_file(&path); // ensure it doesn't exist
        compact_transcript_file(&path); // must not panic
    }

    #[test]
    fn read_tail_bounds_work_regardless_of_file_size_and_yields_the_newest_blocks() {
        // FR-8 acceptance: a huge transcript loads in bounded time and yields
        // the last TRANSCRIPT_BUFFER_CAP blocks. This proves the mechanism
        // (seek near EOF, discard the leading partial line) over a multi-MB
        // fixture — large enough to exceed TRANSCRIPT_TAIL_BYTES several
        // times over without a slow test writing the full 500 MB the
        // acceptance criterion names.
        let path = std::env::temp_dir().join(format!(
            "francois-tail-read-test-{}.jsonl",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        {
            use std::io::Write;
            let mut f = std::fs::File::create(&path).unwrap();
            let filler = "x".repeat(2000);
            for i in 0..5_000 {
                writeln!(
                    f,
                    r#"{{"blockId":"b{i}","kind":"user","text":"{filler}","tool":"","summary":"","meta":null}}"#
                )
                .unwrap();
            }
        }
        let len = std::fs::metadata(&path).unwrap().len();
        assert!(
            len > TRANSCRIPT_TAIL_BYTES,
            "fixture must exceed the tail window to prove boundedness"
        );

        let tail = read_tail(&path, TRANSCRIPT_TAIL_BYTES);
        assert!(
            tail.len() as u64 <= TRANSCRIPT_TAIL_BYTES,
            "tail must never exceed the requested window"
        );
        let mut blocks = parse_transcript(&tail);
        assert_eq!(blocks.last().unwrap().block_id, "b4999");
        assert!(trim_transcript(&mut blocks, TRANSCRIPT_BUFFER_CAP));
        assert_eq!(blocks.len(), TRANSCRIPT_BUFFER_CAP);
        assert_eq!(blocks.last().unwrap().block_id, "b4999");

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn read_tail_reads_a_file_shorter_than_k_whole() {
        let path = std::env::temp_dir().join(format!(
            "francois-tail-read-small-test-{}.jsonl",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(
            &path,
            "{\"blockId\":\"b1\",\"kind\":\"user\",\"text\":\"hi\",\"tool\":\"\",\"summary\":\"\",\"meta\":null}\n",
        )
        .unwrap();
        let blocks = parse_transcript(&read_tail(&path, TRANSCRIPT_TAIL_BYTES));
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].block_id, "b1");
        let _ = std::fs::remove_file(&path);
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
        let v = serde_json::to_value(linked_session("s1", None).meta(&fake_accounts())).unwrap();
        assert!(
            v.get("projectId").is_none(),
            "FR-18: an unlinked session must OMIT the key, not send null: {v}"
        );
        let v =
            serde_json::to_value(linked_session("s1", Some("p1")).meta(&fake_accounts())).unwrap();
        assert_eq!(v["projectId"], "p1");
    }

    #[test]
    fn persisted_record_omits_project_id_when_unlinked_and_carries_it_when_linked() {
        // §9: "SessionMeta.projectId round-trips through sessions.json"
        for (project_id, expect) in [(None, None), (Some("p1"), Some("p1"))] {
            let engine = test_engine_with(linked_session("s1", project_id));
            let map = engine.sessions.lock().unwrap_or_else(|p| p.into_inner());
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
            let mut map = engine.sessions.lock().unwrap_or_else(|p| p.into_inner());
            map.insert("s2".into(), linked_session("s2", Some("p2")));
            map.insert("s3".into(), linked_session("s3", None));
        }

        let changed = engine.clear_project(&fake_accounts(), "p1");

        // exactly the p1 session is reported, already carrying the cleared value
        assert_eq!(changed.len(), 1);
        assert_eq!(changed[0].id, "s1");
        assert_eq!(changed[0].project_id, None);

        let map = engine.sessions.lock().unwrap_or_else(|p| p.into_inner());
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
        let v = serde_json::to_value(test_session().meta(&fake_accounts())).unwrap();
        assert_eq!(v["accountId"], "default");

        let mut s = test_session();
        s.account_id = "a1".into();
        assert_eq!(
            serde_json::to_value(s.meta(&fake_accounts())).unwrap()["accountId"],
            "a1",
            "the stored value is reported verbatim, never re-derived"
        );
    }

    #[test]
    fn session_meta_always_carries_agent_runtime_and_protocol() {
        // multi-provider-seam FR-11a: both are required on the wire, in the
        // contract's spellings — that half is unchanged, and it is what a
        // frontend built against today's contract depends on.
        //
        // core-architecture-wave3 FR-11 changed where the VALUES come from. They
        // used to be reported verbatim off the session record; they are derived
        // from the account's current kind now, which is why this test drives
        // them through the registry rather than through the stored fields.
        // (`the_stored_runtime_is_a_cache_and_no_longer_decides_anything`, below,
        // is the test that pins the difference.)
        use crate::account::AccountKind;
        use crate::session::testutil::FakeAccounts;

        let v = serde_json::to_value(test_session().meta(&fake_accounts())).unwrap();
        assert_eq!(v["agentRuntime"], "claude-code");
        assert_eq!(v["protocol"], "anthropic");

        let mut s = test_session();
        s.account_id = "a1".into();
        let endpoint = FakeAccounts::default().with("a1", AccountKind::OpenAiCompatible);
        let v = serde_json::to_value(s.meta(&endpoint)).unwrap();
        assert_eq!(v["agentRuntime"], "francois");
        assert_eq!(v["protocol"], "openai");
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
            serde_json::to_value(s.meta(&fake_accounts()))
                .unwrap()
                .get("cloud")
                .is_none(),
            "a session that was never adopted must not mention cloud"
        );
        s.cloud = Some(CloudProvenance {
            cloud_session_id: "session_01AB".into(),
            adopted_at: 1_784_573_689_516,
        });
        let meta = serde_json::to_value(s.meta(&fake_accounts())).unwrap();
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
            let mut map = engine.sessions.lock().unwrap_or_else(|p| p.into_inner());
            let mut other = test_session();
            other.id = "s2".into();
            other.account_id = "a2".into();
            map.insert("s2".into(), other);
            let mut plain = test_session();
            plain.id = "s3".into();
            map.insert("s3".into(), plain);
        }

        let changed = engine.clear_account(&fake_accounts(), "a1");

        assert_eq!(changed.len(), 1);
        assert_eq!(changed[0].id, "s1");
        assert_eq!(changed[0].account_id, "default");

        {
            let map = engine.sessions.lock().unwrap_or_else(|p| p.into_inner());
            assert_eq!(map.get("s1").unwrap().account_id, "default");
            assert_eq!(map.get("s2").unwrap().account_id, "a2", "untouched");
            assert_eq!(map.get("s3").unwrap().account_id, "default");
            assert_eq!(map.len(), 3, "no session is ever removed by a repoint");
        }
        assert!(engine.clear_account(&fake_accounts(), "nobody").is_empty());
    }

    #[test]
    fn clear_account_reports_claude_code_for_a_removed_grok_account() {
        // The parent wave's FR-4/FR-5 regression, kept: a session on a Grok
        // account, the account removed. What the frontend receives must say
        // ClaudeCode/Anthropic, or the roster shows a runtime whose credentials
        // are gone and the next turn spawns `grok` against a Claude config dir.
        // Flow #4 in §3.
        //
        // What CHANGED with core-architecture-wave3 FR-11 is why it holds. The
        // parent made it true by resyncing `s.agent_runtime` in this same write;
        // `meta()` derives the pair now, so `clear_account` moves the account and
        // nothing else — and the stale field below proves the derivation is real
        // rather than a resync under another name.
        let mut grok = test_session();
        grok.id = "s1".into();
        grok.account_id = "grok-1".into();
        grok.agent_runtime = AgentRuntime::Grok;
        grok.protocol = ProviderProtocol::Openai;
        let engine = test_engine_with(grok);

        let changed = engine.clear_account(&fake_accounts(), "grok-1");

        assert_eq!(changed.len(), 1);
        assert_eq!(changed[0].account_id, "default");
        assert_eq!(changed[0].agent_runtime, AgentRuntime::ClaudeCode);
        assert_eq!(changed[0].protocol, ProviderProtocol::Anthropic);
        assert_eq!(
            changed[0].agent_runtime,
            AgentRuntime::from_account_kind(crate::account::AccountKind::ClaudeCodeOauth).0
        );
    }

    #[test]
    fn the_stored_runtime_is_a_cache_and_no_longer_decides_anything() {
        // FR-11's actual claim. The stored field is left holding `Grok` on
        // purpose: it round-trips the on-disk `agentRuntime` key and nothing
        // else. If a future change starts reading it for dispatch, this test is
        // where that shows up — the meta says ClaudeCode while the field says
        // Grok, and only one of the two is allowed to be believed.
        let mut grok = test_session();
        grok.id = "s1".into();
        grok.account_id = "grok-1".into();
        grok.agent_runtime = AgentRuntime::Grok;
        grok.protocol = ProviderProtocol::Openai;
        let engine = test_engine_with(grok);

        engine.clear_account(&fake_accounts(), "grok-1");

        let map = engine.sessions.lock().unwrap_or_else(|p| p.into_inner());
        let s = map.get("s1").unwrap();
        assert_eq!(
            s.agent_runtime,
            AgentRuntime::Grok,
            "FR-11 removed the resync — the field is a stale cache by design"
        );
        assert_eq!(
            s.meta(&fake_accounts()).agent_runtime,
            AgentRuntime::ClaudeCode,
            "…and every reader that matters derives past it"
        );
    }

    #[test]
    fn meta_follows_the_accounts_current_kind_not_the_stored_field() {
        // The class, not the instance (FR-11): the same session, the same stored
        // field, two different account registries — the meta follows the
        // registry. There is no mutation anywhere in this test, which is the
        // point: nothing has to be resynced for the answer to be right.
        use crate::account::AccountKind;
        use crate::session::testutil::FakeAccounts;

        let mut s = test_session();
        s.account_id = "a1".into();
        s.agent_runtime = AgentRuntime::ClaudeCode; // deliberately wrong below

        let codex = FakeAccounts::default().with("a1", AccountKind::CodexCli);
        assert_eq!(s.meta(&codex).agent_runtime, AgentRuntime::Codex);
        assert_eq!(s.meta(&codex).protocol, ProviderProtocol::Openai);

        let endpoint = FakeAccounts::default().with("a1", AccountKind::OpenAiCompatible);
        assert_eq!(s.meta(&endpoint).agent_runtime, AgentRuntime::Francois);

        // §7 #8: an account that no longer resolves falls back to Claude Code —
        // a working state, rather than a provider whose credentials it lacks.
        assert_eq!(
            s.meta(&fake_accounts()).agent_runtime,
            AgentRuntime::ClaudeCode
        );
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
            let mut map = engine.sessions.lock().unwrap_or_else(|p| p.into_inner());
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
        assert!(engine.clear_project(&fake_accounts(), "nobody").is_empty());
        let map = engine.sessions.lock().unwrap_or_else(|p| p.into_inner());
        assert_eq!(map.get("s1").unwrap().project_id.as_deref(), Some("p1"));
    }
}
