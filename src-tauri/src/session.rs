// session.rs — the Francois session engine (specs/session-engine.md).
//
// Owns the registry of Claude Code sessions, spawns `claude -p --output-format
// stream-json --include-partial-messages --verbose` per turn, parses the NDJSON
// stream, and normalizes it to the SessionEvent stream on francois://session/event.
// Backend-only; every UI feature is a client of this engine.
//
// Build notes / honest v1 deviations (flagged for spec reconciliation):
//  * Primary path only (per-turn stream-json CLI). The SDK-sidecar escape hatch
//    is not built, so `done` status is unreachable in v1 (spec FR-2 anticipates
//    this) — sessions leave the live set only via `remove` or `error`.
//  * create-time spawn check = `claude --version` (catches "not found"). A live
//    auth failure surfaces on the first `send` as a turn error (session.error),
//    matching FR-19's lazy-error path rather than failing `create`.

use crate::ipc::{err, ok, AppError, IpcResult};
use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};

const EVENT_CHANNEL: &str = "francois://session/event";
const QUEUE_CAP: usize = 20;
const DEFAULT_MODEL: &str = "sonnet";

// ---------- model catalog (§5.1) ----------
//
// `id` is passed verbatim to `claude --model <id>`. We use the CLI's tier
// aliases (sonnet/opus/haiku), which resolve to the latest available model of
// each tier — robust across releases and account tiers. (Made-up full IDs like
// `claude-opus-4` are rejected by the CLI.)

fn catalog() -> Vec<ModelInfo> {
    vec![model("sonnet", "Sonnet"), model("opus", "Opus"), model("haiku", "Haiku")]
}

fn context_limit(model_id: &str) -> u64 {
    resolve_context_tokens(model_id).unwrap_or(200_000)
}

/// Context window for a model id. Matches the exact id first, then resolves CLI
/// aliases and bare family words (`opus`, `sonnet`, …) to the newest cached model
/// of that family — so a session created with the `opus` alias still reports the
/// current Opus context window (e.g. 1M) rather than the 200K default.
fn resolve_context_tokens(model_id: &str) -> Option<u64> {
    let cache = model_cache().lock().unwrap();
    if let Some(c) = cache.iter().find(|m| m.id == model_id).and_then(|m| m.context_tokens) {
        return Some(c);
    }
    let key = model_id.to_lowercase();
    let fam = ["fable", "opus", "sonnet", "haiku"].into_iter().find(|f| key.contains(f))?;
    // The CLI alias points at the family flagship — take the largest context window in
    // the family rather than relying on cache ordering / "newest".
    cache.iter().filter(|m| m.id.to_lowercase().contains(fam)).filter_map(|m| m.context_tokens).max()
}

fn fmt_tokens(n: u64) -> String {
    if n >= 1_000_000 {
        let m = n as f64 / 1_000_000.0;
        if (m - m.round()).abs() < 0.05 {
            format!("{}M", m.round() as u64)
        } else {
            format!("{m:.1}M")
        }
    } else {
        format!("{}K", n / 1000)
    }
}

/// Order model families so versions of the same model group together, flagship
/// tiers first (spec: "sort the model versions by model").
fn tier_rank(id: &str) -> u8 {
    let l = id.to_lowercase();
    if l.contains("fable") || l.contains("mythos") {
        0
    } else if l.contains("opus") {
        1
    } else if l.contains("sonnet") {
        2
    } else if l.contains("haiku") {
        3
    } else {
        4
    }
}

// ---------- dynamic model discovery ----------
//
// The CLI has no "list models" command, but the account's live model list is
// available from the Anthropic API's GET /v1/models using the OAuth access
// token that Claude Code stores in ~/.claude/.credentials.json. This makes the
// model picker reflect exactly what the account can use right now (including
// models released after this build). Falls back to the tier aliases if the
// token/network is unavailable.

static MODEL_CACHE: OnceLock<Mutex<Vec<ModelInfo>>> = OnceLock::new();
fn model_cache() -> &'static Mutex<Vec<ModelInfo>> {
    MODEL_CACHE.get_or_init(|| Mutex::new(Vec::new()))
}

fn read_oauth_token() -> Option<String> {
    let path = dirs::home_dir()?.join(".claude").join(".credentials.json");
    let bytes = std::fs::read(path).ok()?;
    let v: Value = serde_json::from_slice(&bytes).ok()?;
    v.get("claudeAiOauth")?.get("accessToken")?.as_str().map(String::from)
}

fn fetch_live_models() -> Option<Vec<ModelInfo>> {
    let token = read_oauth_token()?;
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(std::time::Duration::from_secs(5))
        .timeout_read(std::time::Duration::from_secs(10))
        .build();
    let resp = agent
        .get("https://api.anthropic.com/v1/models?limit=100")
        .set("Authorization", &format!("Bearer {token}"))
        .set("anthropic-version", "2023-06-01")
        .call()
        .ok()?;
    let json: Value = resp.into_json().ok()?;
    let data = json.get("data")?.as_array()?;

    // (tier_rank, created_at desc, ModelInfo) for grouping by family, newest first.
    let mut rows: Vec<(u8, String, ModelInfo)> = data
        .iter()
        .filter_map(|m| {
            let id = m.get("id")?.as_str()?.to_string();
            let label = m
                .get("display_name")
                .and_then(|d| d.as_str())
                .map(|s| s.strip_prefix("Claude ").unwrap_or(s).to_string())
                .unwrap_or_else(|| id.clone());
            let created = m.get("created_at").and_then(|c| c.as_str()).unwrap_or("").to_string();
            let ctx = m.get("max_input_tokens").and_then(|v| v.as_u64());
            let out = m.get("max_tokens").and_then(|v| v.as_u64());
            let caps = m.get("capabilities");
            let cap = |key: &str| {
                caps.and_then(|c| c.get(key)).and_then(|c| c.get("supported")).and_then(|b| b.as_bool()).unwrap_or(false)
            };
            let mut parts: Vec<String> = Vec::new();
            if let Some(c) = ctx {
                parts.push(format!("{} context", fmt_tokens(c)));
            }
            if let Some(o) = out {
                parts.push(format!("{} output", fmt_tokens(o)));
            }
            if cap("image_input") {
                parts.push("vision".into());
            }
            if cap("thinking") {
                parts.push("thinking".into());
            }
            let brief = if parts.is_empty() { None } else { Some(parts.join(" \u{b7} ")) };
            let efforts: Vec<String> = caps
                .and_then(|c| c.get("effort"))
                .filter(|e| e.get("supported").and_then(|b| b.as_bool()).unwrap_or(false))
                .map(|e| {
                    ["low", "medium", "high", "xhigh", "max"]
                        .iter()
                        .filter(|lvl| e.get(**lvl).and_then(|l| l.get("supported")).and_then(|b| b.as_bool()).unwrap_or(false))
                        .map(|lvl| lvl.to_string())
                        .collect()
                })
                .unwrap_or_default();
            Some((tier_rank(&id), created, ModelInfo { id, label, brief, context_tokens: ctx, efforts }))
        })
        .collect();

    rows.sort_by(|a, b| a.0.cmp(&b.0).then(b.1.cmp(&a.1))); // family, then newest first
    let models: Vec<ModelInfo> = rows.into_iter().map(|(_, _, m)| m).collect();
    (!models.is_empty()).then_some(models)
}

/// Fetch the live list (updating the cache) or fall back to the tier aliases.
fn refresh_models() -> Vec<ModelInfo> {
    let models = fetch_live_models().unwrap_or_else(catalog);
    *model_cache().lock().unwrap() = models.clone();
    models
}

/// Warm the model cache in the background at startup (for nice model labels and
/// real context windows). Sessions loaded before the fetch completed had their
/// context limit computed against a cold cache (→ 200K default); once the live
/// windows are known, recompute and push corrected metas so the header updates.
pub fn warm_model_cache(app: AppHandle) {
    std::thread::spawn(move || {
        refresh_models();
        let updated: Vec<SessionMeta> = {
            let engine = app.state::<Engine>();
            let mut map = engine.sessions.lock().unwrap();
            map.values_mut()
                .filter_map(|s| {
                    let limit = context_limit(&s.model_id);
                    (limit != s.context_limit_tokens).then(|| {
                        s.context_limit_tokens = limit;
                        s.meta()
                    })
                })
                .collect()
        };
        for m in updated {
            emit(&app, SessionEvent::Meta { meta: m });
        }
    });
}

/// Human label for a model id: the cached display name, else a best-effort
/// humanization of the id (e.g. `claude-opus-4-8` → `Opus 4.8`).
fn label_for(id: &str) -> String {
    if let Some(m) = model_cache().lock().unwrap().iter().find(|m| m.id == id) {
        return m.label.clone();
    }
    humanize(id)
}

fn humanize(id: &str) -> String {
    let s = id.strip_prefix("claude-").unwrap_or(id);
    let parts: Vec<&str> = s.split('-').collect();
    let Some(tier) = parts.first() else { return id.to_string() };
    let mut chars = tier.chars();
    let tier_cap = chars.next().map(|c| c.to_uppercase().collect::<String>() + chars.as_str()).unwrap_or_default();
    let mut ver = Vec::new();
    for p in &parts[1..] {
        if p.len() >= 8 && p.chars().all(|c| c.is_ascii_digit()) {
            break; // date stamp like 20250929
        }
        if !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()) {
            ver.push(*p);
        } else {
            break;
        }
    }
    if ver.is_empty() {
        tier_cap
    } else {
        format!("{tier_cap} {}", ver.join("."))
    }
}

// ---------- serialized public shapes (contract/common.ts) ----------

#[derive(Serialize, Clone)]
pub struct ModelInfo {
    pub id: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub brief: Option<String>,
    #[serde(rename = "contextTokens", skip_serializing_if = "Option::is_none")]
    pub context_tokens: Option<u64>,
    /// Effort levels this model supports (subset of low/medium/high/xhigh/max).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub efforts: Vec<String>,
}

fn model(id: &str, label: &str) -> ModelInfo {
    ModelInfo { id: id.into(), label: label.into(), brief: None, context_tokens: None, efforts: Vec::new() }
}

fn valid_effort(e: &str) -> bool {
    matches!(e, "low" | "medium" | "high" | "xhigh" | "max")
}

#[derive(Serialize, Clone)]
struct SessionMeta {
    id: String,
    name: String,
    cwd: String,
    model: ModelInfo,
    status: String, // running | idle | done | error
    #[serde(rename = "contextUsedTokens")]
    context_used_tokens: u64,
    #[serde(rename = "contextLimitTokens")]
    context_limit_tokens: u64,
    #[serde(rename = "startedAt")]
    started_at: u64,
    #[serde(rename = "lastActivityAt")]
    last_activity_at: u64,
    #[serde(rename = "errorMessage", skip_serializing_if = "Option::is_none")]
    error_message: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct AgentInfo {
    id: String,
    #[serde(rename = "sessionId")]
    session_id: String,
    name: String,
    task: String,
    status: String, // running | idle | done | error
    #[serde(rename = "startedAt")]
    started_at: u64,
    #[serde(rename = "endedAt", skip_serializing_if = "Option::is_none")]
    ended_at: Option<u64>,
}

/// Tool names that dispatch a subagent. Claude Code's stock CLI uses `Task`;
/// some harnesses expose it as `Agent`. Mirrored in classifyToolStart (TS).
fn is_subagent_tool(tool: &str) -> bool {
    matches!(tool, "Task" | "Agent")
}

#[derive(Serialize, Clone)]
struct McpServerInfo {
    name: String,
    status: String, // connected | connecting | error
    #[serde(rename = "toolCount", skip_serializing_if = "Option::is_none")]
    tool_count: Option<u32>,
    #[serde(rename = "errorMessage", skip_serializing_if = "Option::is_none")]
    error_message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    scope: Option<String>, // project | local | user — set by mcp_list; None on runtime updates
}

// ---------- SessionEvent (contract/common.ts, reproduced) ----------

#[derive(Serialize, Clone)]
#[serde(tag = "type")]
enum SessionEvent {
    #[serde(rename = "session.meta")]
    Meta { meta: SessionMeta },
    #[serde(rename = "session.status")]
    Status {
        #[serde(rename = "sessionId")]
        session_id: String,
        status: String,
    },
    #[serde(rename = "session.removed")]
    Removed {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
    #[serde(rename = "message.user")]
    MessageUser {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "blockId")]
        block_id: String,
        text: String,
    },
    #[serde(rename = "assistant.delta")]
    AssistantDelta {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "blockId")]
        block_id: String,
        text: String,
    },
    #[serde(rename = "assistant.done")]
    AssistantDone {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "blockId")]
        block_id: String,
    },
    #[serde(rename = "tool.start")]
    ToolStart {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "blockId")]
        block_id: String,
        tool: String,
        summary: String,
    },
    #[serde(rename = "tool.done")]
    ToolDone {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "blockId")]
        block_id: String,
        meta: String,
    },
    #[serde(rename = "agent.update")]
    AgentUpdate { agent: AgentInfo },
    #[serde(rename = "mcp.update")]
    McpUpdate {
        #[serde(rename = "sessionId")]
        session_id: String,
        server: McpServerInfo,
    },
    #[serde(rename = "context.usage")]
    ContextUsage {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "usedTokens")]
        used_tokens: u64,
        #[serde(rename = "limitTokens")]
        limit_tokens: u64,
    },
    #[serde(rename = "session.resumeFailed")]
    ResumeFailed {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
    #[serde(rename = "session.error")]
    Error {
        #[serde(rename = "sessionId")]
        session_id: String,
        error: AppError,
    },
}

fn emit(app: &AppHandle, ev: SessionEvent) {
    let _ = app.emit(EVENT_CHANNEL, ev);
}

// ---------- internal registry ----------

// In-memory transcript buffer (§6). Read by conversation-view's getTranscript
// channel; mirrors the ConversationBlock shape in contract/conversation-view.ts.
#[derive(Clone, Copy, PartialEq)]
enum BlockKind {
    User,
    Assistant,
    Tool,
    Subagent,
}

#[derive(Clone)]
struct BufBlock {
    block_id: String,
    kind: BlockKind,
    text: String,
    tool: String,
    summary: String,
    meta: Option<String>,
    streaming: bool,
}

struct TurnHandle {
    child: Arc<Mutex<Child>>,
    interrupted: Arc<AtomicBool>,
}

struct Session {
    id: String,
    name: String,
    cwd: String,
    model_id: String,
    status: String,
    context_used_tokens: u64,
    context_limit_tokens: u64,
    started_at: u64,
    last_activity_at: u64,
    error_message: Option<String>,
    effort: Option<String>, // --effort level (None = model default)
    queue: VecDeque<(String, String)>, // (client blockId, text)
    claude_session_id: Option<String>,
    current: Option<TurnHandle>,
    agents: HashMap<String, AgentInfo>,
    agent_order: Vec<String>, // first-seen order for agents_list (FR-7)
    block_buffer: Vec<BufBlock>, // §6: read by conversation-view's getTranscript
    mcp: HashMap<String, McpServerInfo>,
}

impl Session {
    fn meta(&self) -> SessionMeta {
        let label = label_for(&self.model_id);
        SessionMeta {
            id: self.id.clone(),
            name: self.name.clone(),
            cwd: self.cwd.clone(),
            model: model(&self.model_id, &label),
            status: self.status.clone(),
            context_used_tokens: self.context_used_tokens,
            context_limit_tokens: self.context_limit_tokens,
            started_at: self.started_at,
            last_activity_at: self.last_activity_at,
            error_message: self.error_message.clone(),
        }
    }

    fn buf_user(&mut self, block_id: &str, text: String) {
        self.block_buffer.push(BufBlock {
            block_id: block_id.into(),
            kind: BlockKind::User,
            text,
            tool: String::new(),
            summary: String::new(),
            meta: None,
            streaming: false,
        });
    }

    fn buf_assistant(&mut self, block_id: &str, text: String) {
        self.block_buffer.push(BufBlock {
            block_id: block_id.into(),
            kind: BlockKind::Assistant,
            text,
            tool: String::new(),
            summary: String::new(),
            meta: None,
            streaming: false,
        });
    }

    fn buf_tool(&mut self, block_id: &str, tool: String, summary: String, is_task: bool) {
        self.block_buffer.push(BufBlock {
            block_id: block_id.into(),
            kind: if is_task { BlockKind::Subagent } else { BlockKind::Tool },
            text: String::new(),
            tool,
            summary,
            meta: None,
            streaming: true,
        });
    }

    fn buf_tool_done(&mut self, block_id: &str, meta: String) {
        if let Some(b) = self.block_buffer.iter_mut().find(|b| b.block_id == block_id) {
            b.meta = Some(meta);
            b.streaming = false;
        }
    }

    fn insert_agent(&mut self, a: AgentInfo) {
        if !self.agents.contains_key(&a.id) {
            self.agent_order.push(a.id.clone());
        }
        self.agents.insert(a.id.clone(), a);
    }
}

fn tool_glyph(tool: &str) -> (&'static str, &'static str) {
    match tool {
        "Read" => ("\u{29C9}", "#868a93"),
        "Grep" | "Search" => ("\u{2315}", "#868a93"),
        "Edit" | "Write" => ("\u{270E}", "#7fa07a"),
        _ => ("\u{25CF}", "#868a93"),
    }
}

/// Serialize a buffered block to the ConversationBlock JSON shape (§5 of
/// conversation-view). Mirrors classifyToolStart in the TS contract.
fn classify_block(b: &BufBlock) -> Value {
    match b.kind {
        BlockKind::User => serde_json::json!({
            "kind": "user", "blockId": b.block_id, "isStreaming": b.streaming,
            "text": b.text, "queued": false,
        }),
        BlockKind::Assistant => {
            let (gc, bc) = if b.streaming { ("#c8a15a", "#dfe2e8") } else { ("#868a93", "#c4c7ce") };
            serde_json::json!({
                "kind": "assistant", "blockId": b.block_id, "isStreaming": b.streaming,
                "glyph": "\u{25CF}", "glyphColor": gc, "bodyColor": bc, "text": b.text,
            })
        }
        BlockKind::Tool => {
            let (glyph, gc) = tool_glyph(&b.tool);
            let mut o = serde_json::json!({
                "kind": "tool", "blockId": b.block_id, "isStreaming": b.streaming,
                "tool": b.tool, "glyph": glyph, "glyphColor": gc, "bodyColor": "#868a93",
                "summary": b.summary,
            });
            if let Some(m) = &b.meta {
                o["meta"] = Value::String(m.clone());
            }
            o
        }
        BlockKind::Subagent => {
            let mut o = serde_json::json!({
                "kind": "subagent", "blockId": b.block_id, "isStreaming": b.streaming,
                "glyph": "\u{21C9}", "glyphColor": "#c8a15a", "bodyColor": "#b9bcc4",
                "agentName": b.summary,
            });
            if let Some(m) = &b.meta {
                o["meta"] = Value::String(m.clone());
            }
            o
        }
    }
}

#[derive(Default)]
pub struct Engine {
    sessions: Mutex<HashMap<String, Session>>,
}

impl Engine {
    /// The working directory of a session (used by the `diff` domain, FR-1). None if unknown.
    pub fn cwd_of(&self, session_id: &str) -> Option<String> {
        self.sessions.lock().unwrap().get(session_id).map(|s| s.cwd.clone())
    }
}

/// Kill every in-flight turn's child process (called on app exit).
pub fn kill_all(app: &AppHandle) {
    if let Some(engine) = app.try_state::<Engine>() {
        let map = engine.sessions.lock().unwrap();
        for s in map.values() {
            if let Some(turn) = &s.current {
                turn.interrupted.store(true, Ordering::SeqCst);
                let _ = turn.child.lock().unwrap().kill();
            }
        }
    }
}

// ---------- persistence (FR-42/43) ----------

fn sessions_json_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("sessions.json"))
}

// ---------- transcript persistence (durable-sessions) ----------

/// A session id must be a uuid-charset token so it can never escape the transcripts
/// dir (no `/`, `\`, `..`). Defense-in-depth against a tampered/legacy sessions.json.
fn valid_session_id(id: &str) -> bool {
    !id.is_empty() && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

fn transcript_path(app: &AppHandle, session_id: &str) -> Option<std::path::PathBuf> {
    if !valid_session_id(session_id) {
        return None;
    }
    app.path().app_data_dir().ok().map(|d| d.join("transcripts").join(format!("{session_id}.jsonl")))
}

/// Serialize a finalized block to the on-disk PersistedBlock shape (durable-sessions §5).
fn persisted_block_json(b: &BufBlock) -> Value {
    let kind = match b.kind {
        BlockKind::User => "user",
        BlockKind::Assistant => "assistant",
        BlockKind::Tool => "tool",
        BlockKind::Subagent => "subagent",
    };
    serde_json::json!({
        "blockId": b.block_id, "kind": kind, "text": b.text,
        "tool": b.tool, "summary": b.summary, "meta": b.meta,
    })
}

/// Append one finalized block as a JSON line to the session's transcript (FR-1/2).
/// Best-effort: a write failure is ignored so it never breaks the turn (§7).
fn append_transcript(app: &AppHandle, session_id: &str, block: &BufBlock) {
    use std::io::Write as _;
    let Some(path) = transcript_path(app, session_id) else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let mut line = serde_json::to_string(&persisted_block_json(block)).unwrap_or_default();
    line.push('\n');
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = f.write_all(line.as_bytes());
    }
}

/// Parse one PersistedBlock line back into a BufBlock. Returns None for a malformed
/// or partial line so reload can skip it (FR-15).
fn parse_persisted_block(line: &str) -> Option<BufBlock> {
    let v: Value = serde_json::from_str(line).ok()?;
    let kind = match v.get("kind").and_then(|k| k.as_str())? {
        "user" => BlockKind::User,
        "assistant" => BlockKind::Assistant,
        "tool" => BlockKind::Tool,
        "subagent" => BlockKind::Subagent,
        _ => return None,
    };
    Some(BufBlock {
        block_id: v.get("blockId").and_then(|b| b.as_str())?.to_string(),
        kind,
        text: v.get("text").and_then(|t| t.as_str()).unwrap_or("").to_string(),
        tool: v.get("tool").and_then(|t| t.as_str()).unwrap_or("").to_string(),
        summary: v.get("summary").and_then(|t| t.as_str()).unwrap_or("").to_string(),
        meta: v.get("meta").and_then(|m| m.as_str()).map(String::from),
        streaming: false,
    })
}

/// Read a session's persisted transcript back into a block buffer (FR-5).
fn read_transcript(app: &AppHandle, session_id: &str) -> Vec<BufBlock> {
    let Some(path) = transcript_path(app, session_id) else { return Vec::new() };
    let Ok(content) = std::fs::read_to_string(&path) else { return Vec::new() };
    content.lines().filter_map(parse_persisted_block).collect()
}

fn persist(app: &AppHandle, engine: &Engine) {
    let map = engine.sessions.lock().unwrap();
    let list: Vec<Value> = map
        .values()
        .map(|s| {
            serde_json::json!({
                "id": s.id, "name": s.name, "cwd": s.cwd, "modelId": s.model_id, "effort": s.effort,
                "claudeSessionId": s.claude_session_id, // durable-sessions FR-3
                "lastActivityAt": s.last_activity_at,
                "contextUsedTokens": s.context_used_tokens,
            })
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
struct PersistedMeta {
    id: String,
    name: String,
    cwd: String,
    model_id: String,
    effort: Option<String>,
    claude_session_id: Option<String>,
    last_activity_at: u64,
    context_used_tokens: u64,
}

fn parse_session_record(rec: &Value, now: u64) -> Option<PersistedMeta> {
    let id = rec.get("id")?.as_str()?.to_string();
    let name = rec.get("name")?.as_str()?.to_string();
    let cwd = rec.get("cwd")?.as_str()?.to_string();
    let raw = rec.get("modelId").and_then(|v| v.as_str()).unwrap_or(DEFAULT_MODEL);
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
        effort: rec.get("effort").and_then(|v| v.as_str()).filter(|e| valid_effort(e)).map(String::from),
        claude_session_id: rec.get("claudeSessionId").and_then(|v| v.as_str()).map(String::from),
        last_activity_at: rec.get("lastActivityAt").and_then(|v| v.as_u64()).unwrap_or(now),
        context_used_tokens: rec.get("contextUsedTokens").and_then(|v| v.as_u64()).unwrap_or(0),
    })
}

pub fn load_persisted(app: &AppHandle) {
    let Some(path) = sessions_json_path(app) else { return };
    let Ok(bytes) = std::fs::read(&path) else { return };
    let Ok(list) = serde_json::from_slice::<Vec<Value>>(&bytes) else { return };
    let engine = app.state::<Engine>();
    let mut watched: Vec<(String, String)> = Vec::new();
    let mut map = engine.sessions.lock().unwrap();
    for rec in list {
        let now = now_ms();
        let Some(m) = parse_session_record(&rec, now) else { continue };
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
                status: "idle".into(),
                context_used_tokens: m.context_used_tokens,
                context_limit_tokens: limit,
                started_at: now,
                last_activity_at: m.last_activity_at,
                error_message: None,
                effort: m.effort,
                queue: VecDeque::new(),
                claude_session_id: m.claude_session_id,
                current: None,
                agents: HashMap::new(),
                agent_order: Vec::new(),
                block_buffer,
                mcp: HashMap::new(),
            },
        );
    }
    drop(map);
    // Start a diff watcher per restored session (FR-15).
    for (id, cwd) in watched {
        crate::diff::watch_session(app, &id, &cwd);
    }
}

// ---------- helpers ----------

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn basename(path: &str) -> String {
    std::path::Path::new(path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(path)
        .to_string()
}

// ---------- commands ----------

#[tauri::command]
pub fn session_models() -> IpcResult<Vec<ModelInfo>> {
    ok(refresh_models())
}

// ---------- agents-panel commands (spec §5) ----------
//
// v1 note: `dispatch` mints a tracked agent in the registry and emits
// agent.update so the panel shows it live; wiring a dispatched agent to real
// Claude Code subagent execution (a crafted Task turn) is a session-engine
// enhancement the panel spec explicitly boxes as out of its scope. Real
// subagents Claude spawns via the Task tool during a turn still appear through
// the normal content_block_start(Task) path. `kill` marks the agent errored and
// emits agent.update; it cannot halt an in-turn Claude subagent in v1.

#[tauri::command]
pub fn agents_list(engine: State<'_, Engine>, session_id: String) -> IpcResult<Vec<AgentInfo>> {
    let map = engine.sessions.lock().unwrap();
    match map.get(&session_id) {
        None => err("SESSION_NOT_FOUND", "no such session"),
        Some(s) => ok(s.agent_order.iter().filter_map(|id| s.agents.get(id).cloned()).collect()),
    }
}

#[derive(Serialize)]
pub struct DispatchOutput {
    #[serde(rename = "agentId")]
    agent_id: String,
}

#[tauri::command]
pub fn agents_dispatch(app: AppHandle, engine: State<'_, Engine>, session_id: String, task: String) -> IpcResult<DispatchOutput> {
    let task = task.trim().to_string();
    if task.is_empty() {
        return err("INVALID_INPUT", "task is empty");
    }
    let agent_id = uuid();
    let agent = {
        let mut map = engine.sessions.lock().unwrap();
        let Some(s) = map.get_mut(&session_id) else {
            return err("SESSION_NOT_FOUND", "no such session");
        };
        if s.status == "done" || s.status == "error" {
            return err("SESSION_NOT_RUNNING", "session has ended");
        }
        let name: String = task.chars().take(24).collect();
        let agent = AgentInfo {
            id: agent_id.clone(),
            session_id: session_id.clone(),
            name,
            task: task.clone(),
            status: "running".into(),
            started_at: now_ms(),
            ended_at: None,
        };
        s.insert_agent(agent.clone());
        agent
    };
    emit(&app, SessionEvent::AgentUpdate { agent });
    ok(DispatchOutput { agent_id })
}

#[tauri::command]
pub fn agents_kill(app: AppHandle, engine: State<'_, Engine>, agent_id: String) -> IpcResult<Option<()>> {
    let agent = {
        let mut map = engine.sessions.lock().unwrap();
        let mut found = None;
        for s in map.values_mut() {
            if let Some(a) = s.agents.get_mut(&agent_id) {
                a.status = "error".into();
                a.ended_at = Some(now_ms());
                found = Some(a.clone());
                break;
            }
        }
        found
    };
    match agent {
        None => err("AGENT_NOT_FOUND", "no such agent"),
        Some(a) => {
            emit(&app, SessionEvent::AgentUpdate { agent: a });
            ok(None)
        }
    }
}

// ---------- mcp-panel commands (spec §5) ----------
//
// v1 note: Claude Code connects MCP servers when it runs a turn in the project
// cwd (reported via system.init → mcp.update). `attach`/`detach` write the
// project-scope `.mcp.json`; `reconnect` re-flags `connecting`. The real
// connection state resolves on the session's next turn. The panel shows
// project-scope servers merged with the last runtime status.

fn mcp_json_path(cwd: &str) -> std::path::PathBuf {
    std::path::Path::new(cwd).join(".mcp.json")
}

fn read_mcp_json(cwd: &str) -> Value {
    std::fs::read(mcp_json_path(cwd))
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .unwrap_or_else(|| serde_json::json!({}))
}

/// Read `.mcp.json` for a WRITE path: absent → `{}`, valid object → it, present-but-
/// unparseable → Err so attach/detach never clobber a malformed file (parity with
/// skills_install's settings.json guard).
fn read_mcp_json_for_write(cwd: &str) -> Result<Value, String> {
    match std::fs::read(mcp_json_path(cwd)) {
        Ok(bytes) => match serde_json::from_slice::<Value>(&bytes) {
            Ok(v) if v.is_object() => Ok(v),
            _ => Err("refusing to overwrite .mcp.json — it is not valid JSON".into()),
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(serde_json::json!({})),
        Err(e) => Err(format!("could not read .mcp.json: {e}")),
    }
}

/// Read `~/.claude.json` (the CLI's user store; holds user-scope `mcpServers` and
/// per-project `projects[path].mcpServers` = local scope). `{}` if missing/unreadable.
fn read_claude_json() -> Value {
    dirs::home_dir()
        .map(|h| h.join(".claude.json"))
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .unwrap_or_else(|| serde_json::json!({}))
}

/// Normalize a path for matching `~/.claude.json` `projects` keys (forward slashes,
/// no trailing separator). Case is preserved — CLI keys are stored verbatim.
fn norm_path(p: &str) -> String {
    p.replace('\\', "/").trim_end_matches('/').to_string()
}

/// The `mcpServers` object from a `~/.claude.json` node, as name→config pairs.
fn mcp_servers_of(node: Option<&Value>) -> Vec<(String, Value)> {
    node.and_then(|n| n.get("mcpServers"))
        .and_then(|m| m.as_object())
        .map(|o| o.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
        .unwrap_or_default()
}

/// Compare two paths after normalization — case-insensitively on Windows, where the
/// filesystem is case-insensitive so `~/.claude.json` keys may differ in case (e.g.
/// drive letter) from a session's cwd.
fn path_eq(a: &str, b: &str) -> bool {
    #[cfg(windows)]
    {
        norm_path(a).eq_ignore_ascii_case(&norm_path(b))
    }
    #[cfg(not(windows))]
    {
        norm_path(a) == norm_path(b)
    }
}

/// Look up the local-scope project node in `~/.claude.json` for a cwd, matching
/// on normalized path (CLI stores keys with forward slashes on Windows).
fn project_node<'a>(cj: &'a Value, cwd: &str) -> Option<&'a Value> {
    cj.get("projects")?.as_object()?.iter().find_map(|(k, v)| path_eq(k, cwd).then_some(v))
}

fn write_mcp_json(cwd: &str, v: &Value) -> std::io::Result<()> {
    std::fs::write(mcp_json_path(cwd), serde_json::to_vec_pretty(v).unwrap_or_default())
}

fn transport_of(cfg: &Value) -> &'static str {
    let t = cfg.get("type").and_then(|t| t.as_str()).unwrap_or("");
    if t == "http" || t == "sse" || cfg.get("url").is_some() {
        "http"
    } else {
        "stdio"
    }
}

fn command_of(cfg: &Value) -> String {
    let cmd = cfg.get("command").and_then(|c| c.as_str()).unwrap_or("");
    let args: Vec<String> = cfg
        .get("args")
        .and_then(|a| a.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();
    if args.is_empty() {
        cmd.to_string()
    } else {
        format!("{} {}", cmd, args.join(" "))
    }
}

fn connecting_info(name: &str) -> McpServerInfo {
    McpServerInfo { name: name.to_string(), status: "connecting".into(), tool_count: None, error_message: None, scope: None }
}

/// v1 curated registry (static; no network). Mirrors McpRegistryEntry.
fn registry() -> Vec<Value> {
    use serde_json::json;
    vec![
        json!({ "name": "filesystem", "description": "Local filesystem access", "transport": "stdio",
                "commandTemplate": "npx -y @modelcontextprotocol/server-filesystem {path}",
                "params": [{ "key": "path", "label": "Root directory", "required": true }] }),
        json!({ "name": "github", "description": "GitHub repos, issues, PRs", "transport": "stdio",
                "commandTemplate": "npx -y @modelcontextprotocol/server-github",
                "params": [{ "key": "GITHUB_PERSONAL_ACCESS_TOKEN", "label": "GitHub token", "required": true, "secret": true }] }),
        json!({ "name": "postgres", "description": "Query a Postgres database", "transport": "stdio",
                "commandTemplate": "npx -y @modelcontextprotocol/server-postgres {connectionString}",
                "params": [{ "key": "connectionString", "label": "Connection string", "required": true }] }),
        json!({ "name": "fetch", "description": "Fetch and read web pages", "transport": "stdio",
                "commandTemplate": "uvx mcp-server-fetch", "params": [] }),
        json!({ "name": "sqlite", "description": "Query a SQLite database file", "transport": "stdio",
                "commandTemplate": "uvx mcp-server-sqlite --db-path {dbPath}",
                "params": [{ "key": "dbPath", "label": "Database file path", "required": true }] }),
    ]
}

#[tauri::command]
pub fn mcp_registry() -> IpcResult<Vec<Value>> {
    ok(registry())
}

/// All MCP servers visible to a cwd, in the same precedence the CLI uses:
/// local (project node in ~/.claude.json) > project (.mcp.json) > user
/// (~/.claude.json top-level). Returns (name, scope) with each name appearing once.
fn merged_mcp_scopes(cwd: &str) -> Vec<(String, String)> {
    let cj = read_claude_json();
    let sources: [(&str, Vec<(String, Value)>); 3] = [
        ("local", mcp_servers_of(project_node(&cj, cwd))),
        ("project", mcp_servers_of(Some(&read_mcp_json(cwd)))),
        ("user", mcp_servers_of(Some(&cj))),
    ];
    let mut out: Vec<(String, String)> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for (scope, servers) in sources {
        for (name, _) in servers {
            if seen.insert(name.clone()) {
                out.push((name, scope.to_string()));
            }
        }
    }
    out
}

/// Find a server's raw config + scope across all scopes (local > project > user).
fn find_mcp_config(cwd: &str, name: &str) -> Option<(Value, String)> {
    let cj = read_claude_json();
    if let Some(v) = project_node(&cj, cwd).and_then(|n| n.get("mcpServers")).and_then(|m| m.get(name)) {
        return Some((v.clone(), "local".into()));
    }
    if let Some(v) = read_mcp_json(cwd).get("mcpServers").and_then(|m| m.get(name)) {
        return Some((v.clone(), "project".into()));
    }
    if let Some(v) = cj.get("mcpServers").and_then(|m| m.get(name)) {
        return Some((v.clone(), "user".into()));
    }
    None
}

#[tauri::command]
pub fn mcp_list(engine: State<'_, Engine>, session_id: String) -> IpcResult<Vec<Value>> {
    let (cwd, runtime) = {
        let map = engine.sessions.lock().unwrap();
        let Some(s) = map.get(&session_id) else {
            return err("SESSION_NOT_FOUND", "no such session");
        };
        (s.cwd.clone(), s.mcp.clone())
    };
    let mut out: Vec<Value> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for (name, scope) in merged_mcp_scopes(&cwd) {
        seen.insert(name.clone());
        let mut info = runtime.get(&name).cloned().unwrap_or_else(|| connecting_info(&name));
        info.scope = Some(scope);
        out.push(serde_json::to_value(info).unwrap());
    }
    // runtime-reported servers not present in any config (rare — e.g. resolved from an init frame).
    for (name, info) in &runtime {
        if !seen.contains(name) {
            out.push(serde_json::to_value(info.clone()).unwrap());
        }
    }
    ok(out)
}

#[tauri::command]
pub fn mcp_detail(engine: State<'_, Engine>, session_id: String, name: String) -> IpcResult<Value> {
    let (cwd, runtime) = {
        let map = engine.sessions.lock().unwrap();
        let Some(s) = map.get(&session_id) else {
            return err("SESSION_NOT_FOUND", "no such session");
        };
        (s.cwd.clone(), s.mcp.get(&name).cloned())
    };
    let Some((entry, scope)) = find_mcp_config(&cwd, &name) else {
        return err("MCP_ERROR", format!("'{name}' is not configured for this session"));
    };
    let transport = transport_of(&entry);
    let mut info = runtime.unwrap_or_else(|| connecting_info(&name));
    info.scope = Some(scope);
    let mut o = serde_json::to_value(&info).unwrap();
    o["transport"] = Value::String(transport.into());
    if transport == "stdio" {
        o["command"] = Value::String(command_of(&entry));
    } else {
        o["url"] = Value::String(entry.get("url").and_then(|u| u.as_str()).unwrap_or("").into());
    }
    ok(o)
}

#[tauri::command]
pub fn mcp_reconnect(app: AppHandle, engine: State<'_, Engine>, session_id: String, name: String) -> IpcResult<Option<()>> {
    let info = {
        let mut map = engine.sessions.lock().unwrap();
        let Some(s) = map.get_mut(&session_id) else {
            return err("SESSION_NOT_FOUND", "no such session");
        };
        let info = connecting_info(&name);
        s.mcp.insert(name.clone(), info.clone());
        info
    };
    emit(&app, SessionEvent::McpUpdate { session_id, server: info });
    ok(None)
}

#[tauri::command]
pub fn mcp_detach(engine: State<'_, Engine>, session_id: String, name: String) -> IpcResult<Option<()>> {
    let cwd = {
        let map = engine.sessions.lock().unwrap();
        let Some(s) = map.get(&session_id) else {
            return err("SESSION_NOT_FOUND", "no such session");
        };
        s.cwd.clone()
    };
    // Only project-scope servers live in this project's .mcp.json. Refuse to silently
    // edit the user's global ~/.claude.json for local/user-scope servers.
    if let Some((_, scope)) = find_mcp_config(&cwd, &name) {
        if scope != "project" {
            return err("MCP_ERROR", format!("'{name}' is {scope}-scoped (managed globally) — remove it with `claude mcp remove {name}`"));
        }
    }
    {
        let mut map = engine.sessions.lock().unwrap();
        if let Some(s) = map.get_mut(&session_id) {
            s.mcp.remove(&name);
        }
    }
    let mut cfg = match read_mcp_json_for_write(&cwd) {
        Ok(v) => v,
        Err(e) => return err("MCP_ERROR", e),
    };
    if let Some(servers) = cfg.get_mut("mcpServers").and_then(|m| m.as_object_mut()) {
        servers.remove(&name);
    }
    if let Err(e) = write_mcp_json(&cwd, &cfg) {
        return err("MCP_ERROR", format!("could not write .mcp.json: {e}"));
    }
    ok(None)
}

#[tauri::command]
pub fn mcp_attach(app: AppHandle, engine: State<'_, Engine>, session_id: String, entry: Value) -> IpcResult<Option<()>> {
    let name = entry.get("name").and_then(|n| n.as_str()).unwrap_or("").trim().to_string();
    if name.is_empty() {
        return err("INVALID_INPUT", "server name is required");
    }
    let transport = entry.get("transport").and_then(|t| t.as_str()).unwrap_or("stdio");
    let cwd = {
        let map = engine.sessions.lock().unwrap();
        let Some(s) = map.get(&session_id) else {
            return err("SESSION_NOT_FOUND", "no such session");
        };
        s.cwd.clone()
    };

    let mut cfg = match read_mcp_json_for_write(&cwd) {
        Ok(v) => v,
        Err(e) => return err("MCP_ERROR", e),
    };
    let servers = cfg
        .as_object_mut()
        .unwrap()
        .entry("mcpServers")
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut();
    let Some(servers) = servers else {
        return err("MCP_ERROR", "malformed .mcp.json (mcpServers is not an object)");
    };
    if servers.contains_key(&name) {
        return err("INVALID_INPUT", format!("'{name}' already exists in this project's .mcp.json"));
    }

    let secret = entry.get("secretParams").and_then(|s| s.as_object());
    let server = if transport == "http" {
        let url = entry.get("url").and_then(|u| u.as_str()).unwrap_or("").trim();
        if url.is_empty() {
            return err("INVALID_INPUT", "url is required for an http server");
        }
        let mut o = serde_json::json!({ "type": "http", "url": url });
        if let Some(sec) = secret {
            if !sec.is_empty() {
                o["headers"] = Value::Object(sec.clone());
            }
        }
        o
    } else {
        let cmdline = entry.get("command").and_then(|c| c.as_str()).unwrap_or("").trim();
        if cmdline.is_empty() {
            return err("INVALID_INPUT", "command is required for a stdio server");
        }
        let mut parts = cmdline.split_whitespace();
        let cmd = parts.next().unwrap_or("");
        let args: Vec<&str> = parts.collect();
        let mut o = serde_json::json!({ "command": cmd, "args": args });
        if let Some(sec) = secret {
            if !sec.is_empty() {
                o["env"] = Value::Object(sec.clone());
            }
        }
        o
    };

    servers.insert(name.clone(), server);
    if let Err(e) = write_mcp_json(&cwd, &cfg) {
        return err("MCP_ERROR", format!("could not write .mcp.json: {e}"));
    }

    let info = connecting_info(&name);
    {
        let mut map = engine.sessions.lock().unwrap();
        if let Some(s) = map.get_mut(&session_id) {
            s.mcp.insert(name.clone(), info.clone());
        }
    }
    emit(&app, SessionEvent::McpUpdate { session_id, server: info });
    ok(None)
}

// ---------- skills-panel commands (spec §5) ----------
//
// Discovery mirrors what Claude Code actually loads for a cwd:
//   installed (✦) = SKILL.md skills + slash-command *.md files, from project
//     (<cwd>/.claude/…), user (~/.claude/…), and every *enabled* plugin.
//   available (◇) = SKILL.md skills from marketplace plugins that are NOT enabled.
// "Install" enables the owning plugin in ~/.claude/settings.json (global, reversible),
// which is how Claude Code turns a plugin skill on. Effects apply on the next turn.
// No fs watcher: the panel refetches on install + session switch (FR-7 own flows).

#[derive(Serialize)]
pub struct SkillInfo {
    name: String,
    description: String,
    installed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    scope: Option<String>, // project | user | plugin
    #[serde(skip_serializing_if = "Option::is_none")]
    kind: Option<String>, // skill | command
    #[serde(rename = "pluginId", skip_serializing_if = "Option::is_none")]
    plugin_id: Option<String>, // '<plugin>@<marketplace>' — enabling target for available entries
}

fn commands_dir(base: &std::path::Path) -> std::path::PathBuf {
    base.join(".claude").join("commands")
}

/// Root that holds installed marketplaces: ~/.claude/plugins/marketplaces.
fn marketplaces_root() -> Option<std::path::PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude").join("plugins").join("marketplaces"))
}

/// Enabled plugin ids ("<plugin>@<marketplace>") from ~/.claude/settings.json.
fn enabled_plugin_ids() -> std::collections::HashSet<String> {
    let mut set = std::collections::HashSet::new();
    let Some(home) = dirs::home_dir() else { return set };
    let cfg = std::fs::read(home.join(".claude").join("settings.json"))
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok());
    if let Some(obj) = cfg.as_ref().and_then(|c| c.get("enabledPlugins")).and_then(|e| e.as_object()) {
        for (k, v) in obj {
            if v.as_bool().unwrap_or(false) {
                set.insert(k.clone());
            }
        }
    }
    set
}

/// Every plugin present on disk as ("<plugin>@<marketplace>", plugin_dir), scanning
/// both plugins/ and external_plugins/ under each installed marketplace.
fn all_plugins() -> Vec<(String, std::path::PathBuf)> {
    let mut out = Vec::new();
    let Some(root) = marketplaces_root() else { return out };
    let Ok(mkts) = std::fs::read_dir(&root) else { return out };
    for mkt in mkts.flatten() {
        if !mkt.path().is_dir() {
            continue;
        }
        let Some(mkt_name) = mkt.file_name().to_str().map(String::from) else { continue };
        for sub in ["plugins", "external_plugins"] {
            let Ok(plugins) = std::fs::read_dir(mkt.path().join(sub)) else { continue };
            for p in plugins.flatten() {
                if !p.path().is_dir() {
                    continue;
                }
                if let Some(pname) = p.file_name().to_str() {
                    out.push((format!("{pname}@{mkt_name}"), p.path()));
                }
            }
        }
    }
    // Deterministic order so an available skill exposed by two plugins always resolves
    // to the same enable target (read_dir order is OS-dependent).
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

/// Scan a dir of `*.md` slash-command files → (name = file stem, description).
fn scan_commands(dir: &std::path::Path) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else { return out };
    for e in entries.flatten() {
        let path = e.path();
        if !path.is_file() || path.extension().and_then(|x| x.to_str()) != Some("md") {
            continue;
        }
        if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
            out.push((stem.to_string(), parse_skill_description(&path)));
        }
    }
    out
}

fn skill_entry(name: String, description: String, installed: bool, scope: &str, kind: &str, plugin_id: Option<String>) -> SkillInfo {
    SkillInfo { name, description, installed, scope: Some(scope.into()), kind: Some(kind.into()), plugin_id }
}

/// Full skills+commands list for a cwd (FR-3/4): installed (project ∪ user ∪ enabled
/// plugins, alpha) then available (non-enabled plugin skills, alpha). Project wins over
/// user wins over plugin on a name collision; skill wins over command within a scope.
fn discover_skills(cwd: &str) -> Vec<SkillInfo> {
    let mut installed: std::collections::BTreeMap<String, SkillInfo> = std::collections::BTreeMap::new();
    let enabled = enabled_plugin_ids();

    // insert lowest → highest precedence; each later insert overwrites the earlier.
    for (pid, dir) in all_plugins() {
        if !enabled.contains(&pid) {
            continue;
        }
        for (n, d) in scan_commands(&dir.join("commands")) {
            installed.insert(n.clone(), skill_entry(n, d, true, "plugin", "command", Some(pid.clone())));
        }
        for (n, d) in scan_skills(&dir.join("skills")) {
            installed.insert(n.clone(), skill_entry(n, d, true, "plugin", "skill", Some(pid.clone())));
        }
    }
    if let Some(home) = dirs::home_dir() {
        for (n, d) in scan_commands(&commands_dir(&home)) {
            installed.insert(n.clone(), skill_entry(n, d, true, "user", "command", None));
        }
        for (n, d) in scan_skills(&skills_dir(&home)) {
            installed.insert(n.clone(), skill_entry(n, d, true, "user", "skill", None));
        }
    }
    let proj = std::path::Path::new(cwd);
    for (n, d) in scan_commands(&commands_dir(proj)) {
        installed.insert(n.clone(), skill_entry(n, d, true, "project", "command", None));
    }
    for (n, d) in scan_skills(&skills_dir(proj)) {
        installed.insert(n.clone(), skill_entry(n, d, true, "project", "skill", None));
    }

    // available = SKILL.md skills from plugins that are NOT enabled, excluding installed names.
    let mut available: std::collections::BTreeMap<String, SkillInfo> = std::collections::BTreeMap::new();
    for (pid, dir) in all_plugins() {
        if enabled.contains(&pid) {
            continue;
        }
        for (n, d) in scan_skills(&dir.join("skills")) {
            if installed.contains_key(&n) || available.contains_key(&n) {
                continue;
            }
            available.insert(n.clone(), skill_entry(n, d, false, "plugin", "skill", Some(pid.clone())));
        }
    }

    let mut out: Vec<SkillInfo> = installed.into_values().collect();
    out.extend(available.into_values());
    out
}

fn skills_dir(base: &std::path::Path) -> std::path::PathBuf {
    base.join(".claude").join("skills")
}

fn parse_skill_description(skill_md: &std::path::Path) -> String {
    std::fs::read_to_string(skill_md).map(|c| parse_skill_description_str(&c)).unwrap_or_default()
}

/// Parse the `description:` from a SKILL.md frontmatter, first sentence, ≤100 chars (FR-4).
fn parse_skill_description_str(content: &str) -> String {
    let trimmed = content.trim_start();
    if !trimmed.starts_with("---") {
        return String::new();
    }
    // frontmatter is between the first two `---` fences
    let after = &trimmed[3..];
    let Some(end) = after.find("\n---") else { return String::new() };
    let fm = &after[..end];
    let mut raw = String::new();
    for line in fm.lines() {
        if let Some(rest) = line.trim_start().strip_prefix("description:") {
            raw = rest.trim().trim_matches(['"', '\'']).to_string();
            break;
        }
    }
    if raw.is_empty() {
        return String::new();
    }
    // first sentence: up to a . ! ? followed by whitespace or end
    let bytes = raw.as_bytes();
    let mut cut = raw.len();
    for (i, &b) in bytes.iter().enumerate() {
        if (b == b'.' || b == b'!' || b == b'?') && (i + 1 >= bytes.len() || bytes[i + 1].is_ascii_whitespace()) {
            cut = i;
            break;
        }
    }
    let first = raw[..cut].trim().to_string();
    if first.chars().count() > 100 {
        format!("{}…", first.chars().take(100).collect::<String>())
    } else {
        first
    }
}

/// Scan a skills dir for immediate subdirs containing SKILL.md → (name, description).
fn scan_skills(dir: &std::path::Path) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else { return out };
    for e in entries.flatten() {
        let path = e.path();
        if !path.is_dir() {
            continue;
        }
        let skill_md = path.join("SKILL.md");
        if !skill_md.is_file() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else { continue };
        out.push((name.to_string(), parse_skill_description(&skill_md)));
    }
    out
}

#[tauri::command]
pub fn skills_list(engine: State<'_, Engine>, session_id: String) -> IpcResult<Vec<SkillInfo>> {
    let cwd = {
        let map = engine.sessions.lock().unwrap();
        let Some(s) = map.get(&session_id) else {
            return err("SESSION_NOT_FOUND", "no such session");
        };
        s.cwd.clone()
    };
    ok(discover_skills(&cwd))
}

/// Enable a plugin (by an available skill's owning plugin) in ~/.claude/settings.json.
/// This is the real "install" for a plugin skill; it applies to every Claude Code
/// session on the next turn. Idempotent.
#[tauri::command]
pub fn skills_install(app: AppHandle, engine: State<'_, Engine>, session_id: String, name: String) -> IpcResult<Option<()>> {
    let cwd = {
        let map = engine.sessions.lock().unwrap();
        let Some(s) = map.get(&session_id) else {
            return err("SESSION_NOT_FOUND", "no such session");
        };
        s.cwd.clone()
    };
    let Some(target) = discover_skills(&cwd).into_iter().find(|s| s.name == name && !s.installed) else {
        return err("SKILL_ERROR", format!("'{name}' is not an available plugin skill"));
    };
    let Some(pid) = target.plugin_id else {
        return err("SKILL_ERROR", format!("'{name}' has no plugin to enable"));
    };
    let Some(home) = dirs::home_dir() else {
        return err("SKILL_ERROR", "could not resolve home directory");
    };
    let path = home.join(".claude").join("settings.json");
    // Parse the existing settings. Absent → start fresh; present-but-unparseable →
    // ABORT (never clobber the user's whole global config on a parse failure).
    let mut cfg = match std::fs::read(&path) {
        Ok(bytes) => match serde_json::from_slice::<Value>(&bytes) {
            Ok(v) if v.is_object() => v,
            _ => return err("SKILL_ERROR", "~/.claude/settings.json is not valid JSON — refusing to modify it"),
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => serde_json::json!({}),
        Err(e) => return err("SKILL_ERROR", format!("could not read settings.json: {e}")),
    };
    let ep = cfg
        .as_object_mut()
        .unwrap()
        .entry("enabledPlugins")
        .or_insert_with(|| serde_json::json!({}));
    let Some(ep) = ep.as_object_mut() else {
        return err("SKILL_ERROR", "malformed settings.json (enabledPlugins is not an object)");
    };
    if ep.get(&pid).and_then(|v| v.as_bool()) == Some(true) {
        return ok(None); // already enabled — idempotent
    }
    ep.insert(pid, Value::Bool(true));
    // Atomic write (temp + rename) so a crash mid-write can't truncate settings.json.
    let bytes = serde_json::to_vec_pretty(&cfg).unwrap_or_default();
    let tmp = path.with_extension("json.francois-tmp");
    if let Err(e) = std::fs::write(&tmp, &bytes) {
        return err("SKILL_ERROR", format!("could not write settings.json: {e}"));
    }
    if let Err(e) = std::fs::rename(&tmp, &path) {
        let _ = std::fs::remove_file(&tmp);
        return err("SKILL_ERROR", format!("could not replace settings.json: {e}"));
    }
    let _ = app.emit("francois://skills/event", serde_json::json!({ "type": "skills.changed", "sessionId": session_id }));
    ok(None)
}

#[tauri::command]
pub fn skills_run(app: AppHandle, engine: State<'_, Engine>, session_id: String, name: String, args: Option<String>) -> IpcResult<Option<()>> {
    let cwd = {
        let map = engine.sessions.lock().unwrap();
        let Some(s) = map.get(&session_id) else {
            return err("SESSION_NOT_FOUND", "no such session");
        };
        s.cwd.clone()
    };
    if !discover_skills(&cwd).iter().any(|s| s.installed && s.name == name) {
        return err("INVALID_INPUT", format!("'{name}' is not installed"));
    }
    let text = match args {
        Some(a) if !a.trim().is_empty() => format!("/{} {}", name, a.trim()),
        _ => format!("/{name}"),
    };
    match do_send(&app, &session_id, text, uuid()) {
        IpcResult::Ok { .. } => ok(None),
        IpcResult::Err { error, .. } => IpcResult::Err { ok: false, error },
    }
}

/// francois:conversation:getTranscript — owned by conversation-view (spec §5).
/// Returns the session's in-memory transcript buffer as ConversationBlock[].
#[tauri::command]
pub fn conversation_get_transcript(engine: State<'_, Engine>, session_id: String) -> IpcResult<Vec<Value>> {
    let map = engine.sessions.lock().unwrap();
    match map.get(&session_id) {
        None => err("SESSION_NOT_FOUND", "no such session"),
        Some(s) => ok(s.block_buffer.iter().map(classify_block).collect()),
    }
}

/// francois:session:pickDirectory — owned by sessions-sidebar (spec §5).
/// Opens the native OS directory dialog. `data: null` = user cancelled.
#[tauri::command]
pub fn session_pick_directory(app: AppHandle) -> IpcResult<Option<Value>> {
    use tauri_plugin_dialog::DialogExt;
    match app.dialog().file().blocking_pick_folder() {
        Some(fp) => match fp.as_path().map(|p| p.to_string_lossy().to_string()) {
            Some(path) => ok(Some(serde_json::json!({ "path": path }))),
            None => ok(None),
        },
        None => ok(None),
    }
}

#[tauri::command]
pub fn session_list(app: AppHandle, engine: State<'_, Engine>) -> IpcResult<Vec<Value>> {
    // FR-12: re-emit one session.meta per entry (registry order) before resolving.
    let metas: Vec<SessionMeta> = {
        let map = engine.sessions.lock().unwrap();
        map.values().map(|s| s.meta()).collect()
    };
    for m in &metas {
        emit(&app, SessionEvent::Meta { meta: m.clone() });
    }
    ok(metas.into_iter().map(|m| serde_json::to_value(m).unwrap()).collect())
}

#[tauri::command]
pub fn session_create(
    app: AppHandle,
    engine: State<'_, Engine>,
    cwd: String,
    name: Option<String>,
    model_id: Option<String>,
    effort: Option<String>,
) -> IpcResult<Value> {
    // FR-7: cwd must exist and be a directory.
    let meta = std::fs::metadata(&cwd);
    match meta {
        Ok(m) if m.is_dir() => {}
        _ => return err("INVALID_INPUT", "working directory does not exist or is not a directory"),
    }
    // Model is chosen from the live list (session_models); accept any non-empty
    // id and let the CLI reject a truly invalid one at turn time. Being
    // permissive here is what keeps newly released models usable without a
    // redeploy.
    let model_id = model_id.filter(|m| !m.trim().is_empty()).unwrap_or_else(|| DEFAULT_MODEL.to_string());
    // FR-9: eager spawn check — verify the claude binary runs.
    match Command::new("claude").arg("--version").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status() {
        Ok(s) if s.success() => {}
        Ok(_) => return err("SPAWN_FAILED", "Claude Code CLI exited with an error. Run `claude` once in a terminal to authenticate."),
        Err(_) => return err("SPAWN_FAILED", "Claude Code CLI not found. Install it and ensure `claude` is on PATH."),
    }

    let effort = effort.filter(|e| valid_effort(e));
    let now = now_ms();
    let id = uuid();
    let name = name.unwrap_or_else(|| basename(&cwd));
    let session = Session {
        id: id.clone(),
        name,
        cwd: cwd.clone(),
        model_id: model_id.clone(),
        status: "idle".into(),
        context_used_tokens: 0,
        context_limit_tokens: context_limit(&model_id),
        started_at: now,
        last_activity_at: now,
        error_message: None,
        effort,
        queue: VecDeque::new(),
        claude_session_id: None,
        current: None,
        agents: HashMap::new(),
        agent_order: Vec::new(),
        block_buffer: Vec::new(),
        mcp: HashMap::new(),
    };
    let meta = session.meta();
    engine.sessions.lock().unwrap().insert(id.clone(), session);
    persist(&app, &engine);
    emit(&app, SessionEvent::Meta { meta: meta.clone() });
    crate::diff::watch_session(&app, &id, &cwd); // FR-15: watch the session's cwd
    ok(serde_json::to_value(meta).unwrap())
}

#[tauri::command]
pub fn session_remove(app: AppHandle, engine: State<'_, Engine>, session_id: String) -> IpcResult<Option<()>> {
    let removed = {
        let mut map = engine.sessions.lock().unwrap();
        map.remove(&session_id)
    };
    match removed {
        None => err("SESSION_NOT_FOUND", "no such session"),
        Some(session) => {
            if let Some(turn) = session.current {
                turn.interrupted.store(true, Ordering::SeqCst);
                let _ = turn.child.lock().unwrap().kill();
            }
            persist(&app, &engine);
            if let Some(path) = transcript_path(&app, &session_id) {
                let _ = std::fs::remove_file(path); // durable-sessions FR-11 (best-effort)
            }
            crate::diff::unwatch_session(&session_id); // FR-15: dispose the watcher
            emit(&app, SessionEvent::Removed { session_id });
            ok(None)
        }
    }
}

#[tauri::command]
pub fn session_switch_model(
    app: AppHandle,
    engine: State<'_, Engine>,
    session_id: String,
    model_id: String,
) -> IpcResult<Value> {
    if model_id.trim().is_empty() {
        return err("INVALID_INPUT", "model is empty");
    }
    let meta = {
        let mut map = engine.sessions.lock().unwrap();
        let Some(s) = map.get_mut(&session_id) else {
            return err("SESSION_NOT_FOUND", "no such session");
        };
        if s.status == "done" || s.status == "error" {
            return err("SESSION_NOT_RUNNING", "session has ended");
        }
        s.model_id = model_id.clone();
        s.context_limit_tokens = context_limit(&model_id);
        s.meta()
    };
    persist(&app, &engine);
    emit(&app, SessionEvent::Meta { meta: meta.clone() });
    ok(serde_json::to_value(meta).unwrap())
}

#[tauri::command]
pub fn session_interrupt(engine: State<'_, Engine>, session_id: String) -> IpcResult<Option<()>> {
    let mut map = engine.sessions.lock().unwrap();
    let Some(s) = map.get_mut(&session_id) else {
        return err("SESSION_NOT_FOUND", "no such session");
    };
    if s.status != "running" {
        return ok(None); // FR-23 no-op
    }
    if let Some(turn) = &s.current {
        turn.interrupted.store(true, Ordering::SeqCst);
        let _ = turn.child.lock().unwrap().kill();
    }
    // The turn's reader thread observes the kill, closes the open block, and
    // routes completion (drain queue or go idle) — FR-24.
    ok(None)
}

#[derive(Serialize)]
pub struct SendOutput {
    queued: bool,
    #[serde(rename = "queuePosition", skip_serializing_if = "Option::is_none")]
    queue_position: Option<usize>,
}

/// Shared send logic (used by session_send and skills_run): queue if a turn is
/// running, else start a new turn. Assumes `text` is already non-empty.
fn do_send(app: &AppHandle, session_id: &str, text: String, block_id: String) -> IpcResult<SendOutput> {
    let engine = app.state::<Engine>();
    let mut map = engine.sessions.lock().unwrap();
    let Some(s) = map.get_mut(session_id) else {
        return err("SESSION_NOT_FOUND", "no such session");
    };
    match s.status.as_str() {
        "done" | "error" => return err("SESSION_NOT_RUNNING", "session has ended; create a new one"),
        "running" => {
            if s.queue.len() >= QUEUE_CAP {
                return err("INVALID_INPUT", "send queue is full (20 pending)");
            }
            s.queue.push_back((block_id, text));
            let pos = s.queue.len();
            return ok(SendOutput { queued: true, queue_position: Some(pos) });
        }
        _ => {} // idle → start a turn
    }
    s.status = "running".into();
    s.last_activity_at = now_ms();
    drop(map);
    emit(app, SessionEvent::Status { session_id: session_id.into(), status: "running".into() });
    begin_turn(app, session_id, block_id, text, TurnMode::Normal);
    ok(SendOutput { queued: false, queue_position: None })
}

#[tauri::command]
pub fn session_send(app: AppHandle, session_id: String, text: String, block_id: Option<String>) -> IpcResult<SendOutput> {
    if text.trim().is_empty() {
        return err("INVALID_INPUT", "message is empty");
    }
    // The client generates the blockId so its optimistic block matches the
    // eventual message.user event (conversation-view FR-15/FR-21).
    do_send(&app, &session_id, text, block_id.unwrap_or_else(uuid))
}

#[tauri::command]
pub fn session_compact(app: AppHandle, engine: State<'_, Engine>, session_id: String) -> IpcResult<Option<()>> {
    // Snapshot cwd/model/resume/effort; enforce status.
    let (cwd, model_id, resume, effort) = {
        let mut map = engine.sessions.lock().unwrap();
        let Some(s) = map.get_mut(&session_id) else {
            return err("SESSION_NOT_FOUND", "no such session");
        };
        match s.status.as_str() {
            "done" | "error" => return err("SESSION_NOT_RUNNING", "session has ended"),
            "running" => return err("SESSION_ALREADY_RUNNING", "a turn is already running"),
            _ => {}
        }
        s.status = "running".into();
        (s.cwd.clone(), s.model_id.clone(), s.claude_session_id.clone(), s.effort.clone())
    };
    emit(&app, SessionEvent::Status { session_id: session_id.clone(), status: "running".into() });

    // Run a synchronous compaction turn ("/compact"), reading only its final
    // usage — FR-28. No transcript events are surfaced.
    let limit = context_limit(&model_id);
    let mut used: Option<u64> = None;
    if let Ok(child) = spawn_claude(&cwd, &model_id, resume.as_deref(), "/compact", effort.as_deref()) {
        if let Some(out) = child_stdout_lines(child) {
            for line in out {
                if let Ok(v) = serde_json::from_str::<Value>(&line) {
                    if v.get("type").and_then(|t| t.as_str()) == Some("result") {
                        if let Some(u) = v.get("usage") {
                            used = Some(compute_used(u));
                        }
                    }
                }
            }
        }
    }
    {
        let mut map = engine.sessions.lock().unwrap();
        if let Some(s) = map.get_mut(&session_id) {
            if let Some(u) = used {
                s.context_used_tokens = u;
            }
            s.status = "idle".into();
        }
    }
    if let Some(u) = used {
        emit(&app, SessionEvent::ContextUsage { session_id: session_id.clone(), used_tokens: u, limit_tokens: limit });
    }
    emit(&app, SessionEvent::Status { session_id, status: "idle".into() });
    ok(None)
}

// ---------- turn execution ----------

#[derive(Clone, Copy, PartialEq)]
enum TurnMode {
    Normal,
    #[allow(dead_code)]
    Compact,
    /// Re-run of a turn whose `--resume` was rejected: skip re-buffering the user
    /// message; the caller has already cleared claude_session_id so it runs fresh (FR-9).
    ResumeRetry,
}

fn spawn_claude(cwd: &str, model_id: &str, resume: Option<&str>, text: &str, effort: Option<&str>) -> std::io::Result<Child> {
    let mut cmd = Command::new("claude");
    cmd.arg("-p")
        .arg(text)
        .arg("--output-format")
        .arg("stream-json")
        .arg("--include-partial-messages")
        .arg("--verbose")
        .arg("--model")
        .arg(model_id);
    if let Some(e) = effort {
        cmd.arg("--effort").arg(e);
    }
    if let Some(r) = resume {
        cmd.arg("--resume").arg(r);
    }
    cmd.current_dir(cwd).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    cmd.spawn()
}

fn child_stdout_lines(mut child: Child) -> Option<Vec<String>> {
    let stdout = child.stdout.take()?;
    let reader = BufReader::new(stdout);
    let mut lines = Vec::new();
    for line in reader.lines() {
        match line {
            Ok(l) => lines.push(l),
            Err(_) => break,
        }
    }
    let _ = child.wait();
    Some(lines)
}

fn compute_used(usage: &Value) -> u64 {
    let g = |k: &str| usage.get(k).and_then(|v| v.as_u64()).unwrap_or(0);
    g("input_tokens") + g("cache_read_input_tokens") + g("output_tokens")
}

/// Emit message.user, then spawn the turn's claude child + reader thread.
/// Detects a rejected `--resume`: the turn used resume but exited before starting a
/// thread (no system/init, no result) and wasn't interrupted (FR-8). The retry runs
/// with resume forced off, so it can never re-trigger this — at most one retry.
fn is_resume_fail(resume_used: bool, got_init: bool, got_result: bool, was_interrupted: bool) -> bool {
    resume_used && !got_init && !got_result && !was_interrupted
}

fn begin_turn(app: &AppHandle, session_id: &str, block_id: String, text: String, mode: TurnMode) {
    let (cwd, model_id, resume, effort) = {
        let engine = app.state::<Engine>();
        let mut map = engine.sessions.lock().unwrap();
        let Some(s) = map.get_mut(session_id) else { return };
        // ResumeRetry forces resume off regardless of the stored id, so a still-good id
        // is never dropped preemptively — a fresh init overwrites it only on success.
        let resume = if mode == TurnMode::ResumeRetry { None } else { s.claude_session_id.clone() };
        (s.cwd.clone(), s.model_id.clone(), resume, s.effort.clone())
    };

    let resume_used = resume.is_some();

    if mode == TurnMode::Normal {
        let block = {
            let engine = app.state::<Engine>();
            let mut map = engine.sessions.lock().unwrap();
            match map.get_mut(session_id) {
                Some(s) => {
                    s.buf_user(&block_id, text.clone());
                    s.last_activity_at = now_ms();
                    s.block_buffer.last().cloned()
                }
                None => None,
            }
        };
        if let Some(b) = &block {
            append_transcript(app, session_id, b); // durable-sessions FR-2
        }
        emit(app, SessionEvent::MessageUser { session_id: session_id.into(), block_id: block_id.clone(), text: text.clone() });
    }

    let child = match spawn_claude(&cwd, &model_id, resume.as_deref(), &text, effort.as_deref()) {
        Ok(c) => c,
        Err(e) => {
            fail_session(app, session_id, "SPAWN_FAILED", &format!("could not start claude: {e}"));
            return;
        }
    };
    let child = Arc::new(Mutex::new(child));
    let interrupted = Arc::new(AtomicBool::new(false));
    {
        let engine = app.state::<Engine>();
        let mut map = engine.sessions.lock().unwrap();
        if let Some(s) = map.get_mut(session_id) {
            s.current = Some(TurnHandle { child: child.clone(), interrupted: interrupted.clone() });
        }
    }

    let app2 = app.clone();
    let sid = session_id.to_string();
    // block_id/text carried into the reader so a resume-fail can re-run this turn fresh (FR-9).
    std::thread::spawn(move || {
        run_reader(app2, sid, child, interrupted, model_id, resume_used, block_id, text);
    });
}

/// Per-turn state while parsing the NDJSON stream.
struct ToolRec {
    block_id: String,
    tool: String,
    input: Value,
    is_task: bool,
}

#[allow(clippy::too_many_arguments)]
fn run_reader(
    app: AppHandle,
    session_id: String,
    child: Arc<Mutex<Child>>,
    interrupted: Arc<AtomicBool>,
    model_id: String,
    resume_used: bool,
    block_id: String,
    text: String,
) {
    // Take stdout out of the shared child so we can read without holding its lock.
    let stdout = { child.lock().unwrap().stdout.take() };
    let Some(stdout) = stdout else {
        finish_turn(&app, &session_id, false, None);
        return;
    };
    let reader = BufReader::new(stdout);

    // index -> (blockId, kind, input_accum)   kind: 0=text 1=tool
    let mut blocks: HashMap<u64, (String, u8, String)> = HashMap::new();
    let mut tools: HashMap<String, ToolRec> = HashMap::new(); // tool_use_id -> rec
    let mut text_accum: HashMap<String, String> = HashMap::new(); // blockId -> text
    let mut open_block: Option<(String, u8)> = None;
    let mut pending_used: Option<u64> = None;
    let mut got_result = false;
    let mut got_init = false; // did the stream start (system/init)? — resume-fail detection (FR-8)
    let mut result_error: Option<String> = None;

    let cwd = {
        let engine = app.state::<Engine>();
        let map = engine.sessions.lock().unwrap();
        map.get(&session_id).map(|s| s.cwd.clone()).unwrap_or_default()
    };

    for line in reader.lines() {
        let Ok(line) = line else { break };
        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
        let ty = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
        match ty {
            "system" => {
                if v.get("subtype").and_then(|s| s.as_str()) == Some("init") {
                    got_init = true;
                    if let Some(sid) = v.get("session_id").and_then(|s| s.as_str()) {
                        {
                            let engine = app.state::<Engine>();
                            let mut map = engine.sessions.lock().unwrap();
                            if let Some(s) = map.get_mut(&session_id) {
                                s.claude_session_id = Some(sid.to_string());
                            }
                        }
                        // persist the (possibly new) thread id so --resume survives a restart (FR-7)
                        let engine = app.state::<Engine>();
                        persist(&app, &engine);
                    }
                    emit_mcp_from_init(&app, &session_id, &v);
                }
            }
            "stream_event" => {
                if let Some(ev) = v.get("event") {
                    handle_stream_event(
                        &app, &session_id, &cwd, ev, &mut blocks, &mut tools, &mut text_accum,
                        &mut open_block, &mut pending_used,
                    );
                }
            }
            "user" => {
                handle_tool_results(&app, &session_id, &v, &mut tools, &mut open_block);
            }
            "result" => {
                got_result = true;
                if v.get("is_error").and_then(|b| b.as_bool()) == Some(true)
                    || v.get("subtype").and_then(|s| s.as_str()).map(|s| s != "success").unwrap_or(false)
                {
                    result_error = Some(
                        v.get("result").and_then(|r| r.as_str()).unwrap_or("the turn ended with an error").to_string(),
                    );
                }
                if let Some(u) = v.get("usage") {
                    pending_used = Some(compute_used(u));
                }
            }
            _ => {}
        }
    }

    let _ = child.lock().unwrap().wait();
    let was_interrupted = interrupted.load(Ordering::SeqCst);

    // Resume-fail (FR-8/9): Claude rejected the stale --resume id before starting a
    // thread. Tell the UI and transparently re-run the same message on a fresh thread
    // (ResumeRetry forces resume off → this can fire at most once). The stored id is
    // left in place — a fresh init overwrites it on success; a transient failure keeps it.
    if is_resume_fail(resume_used, got_init, got_result, was_interrupted) {
        emit(&app, SessionEvent::ResumeFailed { session_id: session_id.clone() });
        begin_turn(&app, &session_id, block_id, text, TurnMode::ResumeRetry);
        return;
    }

    // Close any block left open (interrupt or crash) — FR-24/FR-34.
    if let Some((bid, kind)) = open_block.take() {
        if kind == 0 {
            emit(&app, SessionEvent::AssistantDone { session_id: session_id.clone(), block_id: bid });
        } else {
            emit(&app, SessionEvent::ToolDone { session_id: session_id.clone(), block_id: bid, meta: "interrupted".into() });
        }
    }

    let limit = context_limit(&model_id);
    if got_result && result_error.is_none() {
        if let Some(u) = pending_used {
            update_used(&app, &session_id, u);
            emit(&app, SessionEvent::ContextUsage { session_id: session_id.clone(), used_tokens: u, limit_tokens: limit });
        }
        finish_turn(&app, &session_id, false, None);
    } else if was_interrupted {
        if let Some(u) = pending_used {
            update_used(&app, &session_id, u);
            emit(&app, SessionEvent::ContextUsage { session_id: session_id.clone(), used_tokens: u, limit_tokens: limit });
        }
        finish_turn(&app, &session_id, false, None);
    } else {
        let msg = result_error.unwrap_or_else(|| "the Claude Code process ended unexpectedly".to_string());
        finish_turn(&app, &session_id, true, Some(msg));
    }
}

/// Route turn completion (FR-20): drain the queue or go idle; or mark error.
fn finish_turn(app: &AppHandle, session_id: &str, errored: bool, error_msg: Option<String>) {
    let engine = app.state::<Engine>();
    let next: Option<(String, String)> = {
        let mut map = engine.sessions.lock().unwrap();
        let Some(s) = map.get_mut(session_id) else { return };
        s.current = None;
        if errored {
            s.status = "error".into();
            s.error_message = error_msg.clone();
            // Any running agents become errored (FR-40).
            let running: Vec<String> =
                s.agents.iter().filter(|(_, a)| a.status == "running").map(|(k, _)| k.clone()).collect();
            for k in &running {
                if let Some(a) = s.agents.get_mut(k) {
                    a.status = "error".into();
                    a.ended_at = Some(now_ms());
                }
            }
            s.queue.clear();
            None
        } else if let Some(entry) = s.queue.pop_front() {
            Some(entry)
        } else {
            s.status = "idle".into();
            None
        }
    };

    // Persist updated usage/activity/thread-id at turn boundary (durable-sessions FR-3).
    persist(app, &engine);

    if errored {
        let msg = error_msg.unwrap_or_else(|| "session error".into());
        // Final agent.update for any agents just errored.
        let agents: Vec<AgentInfo> = {
            let map = engine.sessions.lock().unwrap();
            map.get(session_id).map(|s| s.agents.values().filter(|a| a.status == "error").cloned().collect()).unwrap_or_default()
        };
        for a in agents {
            emit(app, SessionEvent::AgentUpdate { agent: a });
        }
        emit(app, SessionEvent::Error { session_id: session_id.into(), error: AppError { code: "INTERNAL".into(), message: msg } });
        emit(app, SessionEvent::Status { session_id: session_id.into(), status: "error".into() });
        return;
    }

    match next {
        Some((block_id, text)) => begin_turn(app, session_id, block_id, text, TurnMode::Normal), // no idle blip (FR-20)
        None => emit(app, SessionEvent::Status { session_id: session_id.into(), status: "idle".into() }),
    }
}

fn fail_session(app: &AppHandle, session_id: &str, code: &str, msg: &str) {
    {
        let engine = app.state::<Engine>();
        let mut map = engine.sessions.lock().unwrap();
        if let Some(s) = map.get_mut(session_id) {
            s.status = "error".into();
            s.error_message = Some(msg.to_string());
            s.current = None;
            s.queue.clear();
        }
    }
    emit(app, SessionEvent::Error { session_id: session_id.into(), error: AppError { code: code.into(), message: msg.into() } });
    emit(app, SessionEvent::Status { session_id: session_id.into(), status: "error".into() });
}

fn update_used(app: &AppHandle, session_id: &str, used: u64) {
    let engine = app.state::<Engine>();
    let mut map = engine.sessions.lock().unwrap();
    if let Some(s) = map.get_mut(session_id) {
        s.context_used_tokens = used;
        s.last_activity_at = now_ms();
    }
}

fn emit_mcp_from_init(app: &AppHandle, session_id: &str, init: &Value) {
    let tools: Vec<String> = init
        .get("tools")
        .and_then(|t| t.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let Some(servers) = init.get("mcp_servers").and_then(|s| s.as_array()) else { return };
    for srv in servers {
        let name = srv.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string();
        if name.is_empty() {
            continue;
        }
        let raw_status = srv.get("status").and_then(|s| s.as_str()).unwrap_or("connected");
        let status = match raw_status {
            "connected" | "ready" => "connected",
            "failed" | "error" => "error",
            _ => "connecting",
        };
        let prefix = format!("mcp__{name}__");
        let count = tools.iter().filter(|t| t.starts_with(&prefix)).count() as u32;
        let info = McpServerInfo {
            name: name.clone(),
            status: status.into(),
            tool_count: if status == "connected" { Some(count) } else { None },
            error_message: if status == "error" {
                Some(srv.get("error").and_then(|e| e.as_str()).unwrap_or("connection failed").to_string())
            } else {
                None
            },
            scope: None,
        };
        {
            let engine = app.state::<Engine>();
            let mut map = engine.sessions.lock().unwrap();
            if let Some(s) = map.get_mut(session_id) {
                s.mcp.insert(name.clone(), info.clone());
            }
        }
        emit(app, SessionEvent::McpUpdate { session_id: session_id.into(), server: info });
    }
}

#[allow(clippy::too_many_arguments)]
fn handle_stream_event(
    app: &AppHandle,
    session_id: &str,
    cwd: &str,
    ev: &Value,
    blocks: &mut HashMap<u64, (String, u8, String)>,
    tools: &mut HashMap<String, ToolRec>,
    text_accum: &mut HashMap<String, String>,
    open_block: &mut Option<(String, u8)>,
    _pending_used: &mut Option<u64>,
) {
    let et = ev.get("type").and_then(|t| t.as_str()).unwrap_or("");
    match et {
        "content_block_start" => {
            let idx = ev.get("index").and_then(|i| i.as_u64()).unwrap_or(0);
            let cb = ev.get("content_block").cloned().unwrap_or(Value::Null);
            let cbt = cb.get("type").and_then(|t| t.as_str()).unwrap_or("");
            match cbt {
                "text" => {
                    let bid = uuid();
                    blocks.insert(idx, (bid.clone(), 0, String::new()));
                    text_accum.insert(bid, String::new());
                }
                "tool_use" => {
                    let bid = uuid();
                    let tool = cb.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string();
                    let tuid = cb.get("id").and_then(|i| i.as_str()).unwrap_or("").to_string();
                    let start_input = cb.get("input").cloned().unwrap_or(Value::Object(Default::default()));
                    blocks.insert(idx, (bid.clone(), 1, String::new()));
                    let is_task = is_subagent_tool(&tool);
                    tools.insert(tuid.clone(), ToolRec { block_id: bid.clone(), tool: tool.clone(), input: start_input, is_task });
                    // stash tuid in the block accum slot's kind — track via separate map:
                    blocks.get_mut(&idx).map(|b| b.2 = tuid.clone());
                    if is_task {
                        // Mint a subagent record (FR-37).
                        let agent_id = uuid();
                        let desc = tools
                            .get(&tuid)
                            .map(|r| {
                                r.input.get("description").and_then(|d| d.as_str()).unwrap_or("subagent").to_string()
                            })
                            .unwrap_or_else(|| "subagent".into());
                        let name = tools
                            .get(&tuid)
                            .and_then(|r| r.input.get("subagent_type").and_then(|d| d.as_str()).map(String::from))
                            .unwrap_or_else(|| desc.clone());
                        let agent = AgentInfo {
                            id: agent_id.clone(),
                            session_id: session_id.into(),
                            name,
                            task: desc,
                            status: "running".into(),
                            started_at: now_ms(),
                            ended_at: None,
                        };
                        {
                            let engine = app.state::<Engine>();
                            let mut map = engine.sessions.lock().unwrap();
                            if let Some(s) = map.get_mut(session_id) {
                                s.insert_agent(agent.clone());
                            }
                        }
                        // record agent_id against the tool for completion
                        if let Some(rec) = tools.get_mut(&tuid) {
                            rec.input["__agentId"] = Value::String(agent_id.clone());
                        }
                        emit(app, SessionEvent::AgentUpdate { agent });
                    }
                }
                _ => {} // thinking etc. — ignored
            }
        }
        "content_block_delta" => {
            let idx = ev.get("index").and_then(|i| i.as_u64()).unwrap_or(0);
            let delta = ev.get("delta").cloned().unwrap_or(Value::Null);
            let dt = delta.get("type").and_then(|t| t.as_str()).unwrap_or("");
            match dt {
                "text_delta" => {
                    if let Some((bid, kind, _)) = blocks.get(&idx).cloned() {
                        if kind == 0 {
                            let text = delta.get("text").and_then(|t| t.as_str()).unwrap_or("").to_string();
                            text_accum.entry(bid.clone()).or_default().push_str(&text);
                            *open_block = Some((bid.clone(), 0));
                            emit(app, SessionEvent::AssistantDelta { session_id: session_id.into(), block_id: bid, text });
                        }
                    }
                }
                "input_json_delta" => {
                    if let Some(b) = blocks.get_mut(&idx) {
                        // b.2 currently holds the tool_use_id; accumulate partial json into the ToolRec instead.
                        let tuid = b.2.clone();
                        let partial = delta.get("partial_json").and_then(|t| t.as_str()).unwrap_or("");
                        if let Some(rec) = tools.get_mut(&tuid) {
                            let acc = rec.input.get("__acc").and_then(|a| a.as_str()).unwrap_or("").to_string();
                            rec.input["__acc"] = Value::String(acc + partial);
                        }
                    }
                }
                _ => {} // thinking_delta / signature_delta — ignored
            }
        }
        "content_block_stop" => {
            let idx = ev.get("index").and_then(|i| i.as_u64()).unwrap_or(0);
            if let Some((bid, kind, slot)) = blocks.get(&idx).cloned() {
                if kind == 0 {
                    let text = text_accum.get(&bid).cloned().unwrap_or_default();
                    let block = {
                        let engine = app.state::<Engine>();
                        let mut map = engine.sessions.lock().unwrap();
                        match map.get_mut(session_id) {
                            Some(s) => {
                                s.buf_assistant(&bid, text);
                                s.block_buffer.last().cloned()
                            }
                            None => None,
                        }
                    };
                    if let Some(b) = &block {
                        append_transcript(app, session_id, b); // durable-sessions FR-2
                    }
                    *open_block = None;
                    emit(app, SessionEvent::AssistantDone { session_id: session_id.into(), block_id: bid });
                } else {
                    // tool: finalize input (accumulated json overrides start input), derive summary, emit tool.start
                    let tuid = slot;
                    if let Some(rec) = tools.get_mut(&tuid) {
                        if let Some(acc) = rec.input.get("__acc").and_then(|a| a.as_str()) {
                            if !acc.is_empty() {
                                if let Ok(parsed) = serde_json::from_str::<Value>(acc) {
                                    // preserve __agentId if present
                                    let agent_id = rec.input.get("__agentId").cloned();
                                    rec.input = parsed;
                                    if let Some(aid) = agent_id {
                                        rec.input["__agentId"] = aid;
                                    }
                                }
                            }
                        }
                        let summary = tool_summary(&rec.tool, &rec.input, cwd);
                        {
                            let engine = app.state::<Engine>();
                            let mut map = engine.sessions.lock().unwrap();
                            if let Some(s) = map.get_mut(session_id) {
                                s.buf_tool(&bid, rec.tool.clone(), summary.clone(), rec.is_task);
                            }
                        }
                        *open_block = Some((bid.clone(), 1));
                        emit(app, SessionEvent::ToolStart { session_id: session_id.into(), block_id: bid, tool: rec.tool.clone(), summary });
                    }
                }
            }
        }
        "message_delta" => {
            if let Some(u) = ev.get("usage") {
                *_pending_used = Some(compute_used(u));
            }
        }
        _ => {}
    }
}

fn handle_tool_results(
    app: &AppHandle,
    session_id: &str,
    v: &Value,
    tools: &mut HashMap<String, ToolRec>,
    open_block: &mut Option<(String, u8)>,
) {
    let content = v.get("message").and_then(|m| m.get("content")).and_then(|c| c.as_array());
    let Some(content) = content else { return };
    for item in content {
        if item.get("type").and_then(|t| t.as_str()) != Some("tool_result") {
            continue;
        }
        let tuid = item.get("tool_use_id").and_then(|t| t.as_str()).unwrap_or("").to_string();
        let is_error = item.get("is_error").and_then(|b| b.as_bool()).unwrap_or(false);
        let result_text = extract_result_text(item.get("content"));
        let Some(rec) = tools.get(&tuid) else { continue };
        let block_id = rec.block_id.clone();
        let meta = if is_error { "error".to_string() } else { tool_meta(&rec.tool, &rec.input, &result_text) };

        // Task completion → agent done (FR-39).
        if rec.is_task {
            if let Some(aid) = rec.input.get("__agentId").and_then(|a| a.as_str()) {
                let excerpt = result_text.lines().next().unwrap_or("done").chars().take(80).collect::<String>();
                let agent = {
                    let engine = app.state::<Engine>();
                    let mut map = engine.sessions.lock().unwrap();
                    map.get_mut(session_id).and_then(|s| {
                        s.agents.get_mut(aid).map(|a| {
                            a.status = "done".into();
                            a.ended_at = Some(now_ms());
                            a.task = if excerpt.is_empty() { a.task.clone() } else { excerpt.clone() };
                            a.clone()
                        })
                    })
                };
                if let Some(a) = agent {
                    emit(app, SessionEvent::AgentUpdate { agent: a });
                }
            }
        }

        let done_block = {
            let engine = app.state::<Engine>();
            let mut map = engine.sessions.lock().unwrap();
            match map.get_mut(session_id) {
                Some(s) => {
                    s.buf_tool_done(&block_id, meta.clone());
                    s.block_buffer.iter().find(|b| b.block_id == block_id).cloned()
                }
                None => None,
            }
        };
        if let Some(b) = &done_block {
            append_transcript(app, session_id, b); // durable-sessions FR-2
        }
        if matches!(open_block, Some((b, _)) if *b == block_id) {
            *open_block = None;
        }
        // FR-16: a file-mutating tool finished → recompute the diff summary now.
        if rec.tool == "Edit" || rec.tool == "Write" {
            if let Some(cwd) = app.state::<Engine>().cwd_of(session_id) {
                crate::diff::on_tool_done(app, session_id, &cwd);
            }
        }
        emit(app, SessionEvent::ToolDone { session_id: session_id.into(), block_id, meta });
    }
}

fn extract_result_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(arr)) => arr
            .iter()
            .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

// ---------- tool summary / meta derivation (§5.4) ----------

fn rel_path(path: &str, cwd: &str) -> String {
    if !cwd.is_empty() {
        if let Some(stripped) = path.strip_prefix(cwd) {
            let s = stripped.trim_start_matches(['/', '\\']);
            if !s.is_empty() {
                return s.to_string();
            }
        }
    }
    path.to_string()
}

fn truncate(s: &str, n: usize) -> String {
    let collapsed: String = s.chars().map(|c| if c == '\n' || c == '\r' { ' ' } else { c }).collect();
    if collapsed.chars().count() > n {
        collapsed.chars().take(n).collect()
    } else {
        collapsed
    }
}

fn str_field<'a>(input: &'a Value, key: &str) -> Option<&'a str> {
    input.get(key).and_then(|v| v.as_str())
}

fn tool_summary(tool: &str, input: &Value, cwd: &str) -> String {
    match tool {
        "Read" | "Edit" | "MultiEdit" | "Write" => {
            str_field(input, "file_path").map(|p| rel_path(p, cwd)).unwrap_or_default()
        }
        "Grep" => truncate(str_field(input, "pattern").unwrap_or(""), 60),
        "Glob" => str_field(input, "pattern").unwrap_or("").to_string(),
        "Bash" => truncate(str_field(input, "command").unwrap_or(""), 60),
        "Task" | "Agent" => str_field(input, "subagent_type").or_else(|| str_field(input, "description")).unwrap_or("subagent").to_string(),
        "WebFetch" => str_field(input, "url").unwrap_or("").to_string(),
        "WebSearch" => str_field(input, "query").unwrap_or("").to_string(),
        _ => {
            if let Some(obj) = input.as_object() {
                for (k, val) in obj {
                    if k.starts_with("__") {
                        continue;
                    }
                    if let Some(s) = val.as_str() {
                        return truncate(s, 60);
                    }
                }
            }
            truncate(&input.to_string(), 60)
        }
    }
}

fn line_count(s: &str) -> usize {
    if s.is_empty() {
        0
    } else {
        s.lines().count()
    }
}

fn edit_counts(old: &str, new: &str) -> (usize, usize) {
    let old_lines: Vec<&str> = old.split('\n').collect();
    let new_lines: Vec<&str> = new.split('\n').collect();
    let mut lead = 0;
    while lead < old_lines.len() && lead < new_lines.len() && old_lines[lead] == new_lines[lead] {
        lead += 1;
    }
    let mut trail = 0;
    while trail < (old_lines.len() - lead) && trail < (new_lines.len() - lead) && old_lines[old_lines.len() - 1 - trail] == new_lines[new_lines.len() - 1 - trail] {
        trail += 1;
    }
    let m = old_lines.len() - lead - trail; // removed
    let n = new_lines.len() - lead - trail; // added
    (n, m)
}

fn tool_meta(tool: &str, input: &Value, result: &str) -> String {
    match tool {
        "Read" => format!("{} lines", line_count(result)),
        "Grep" => {
            let matches = line_count(result);
            if matches == 0 {
                return "no matches".into();
            }
            let files: std::collections::HashSet<&str> = result
                .lines()
                .filter_map(|l| l.split(':').next())
                .filter(|p| !p.is_empty())
                .collect();
            if result.lines().any(|l| l.contains(':')) {
                format!("{matches} matches · {} files", files.len())
            } else {
                format!("{matches} files")
            }
        }
        "Glob" => format!("{} files", line_count(result)),
        "Edit" => {
            let old = str_field(input, "old_string").unwrap_or("");
            let new = str_field(input, "new_string").unwrap_or("");
            let (n, m) = edit_counts(old, new);
            format!("+{n} \u{2212}{m}")
        }
        "MultiEdit" => {
            let mut tn = 0;
            let mut tm = 0;
            if let Some(edits) = input.get("edits").and_then(|e| e.as_array()) {
                for e in edits {
                    let old = e.get("old_string").and_then(|v| v.as_str()).unwrap_or("");
                    let new = e.get("new_string").and_then(|v| v.as_str()).unwrap_or("");
                    let (n, m) = edit_counts(old, new);
                    tn += n;
                    tm += m;
                }
            }
            format!("+{tn} \u{2212}{tm}")
        }
        "Write" => format!("{} lines", line_count(str_field(input, "content").unwrap_or(""))),
        "Bash" => {
            if result.trim().is_empty() {
                "done".into()
            } else {
                format!("{} lines", line_count(result))
            }
        }
        "Task" | "Agent" => {
            let first = result.lines().next().unwrap_or("").chars().take(80).collect::<String>();
            if first.is_empty() {
                "done".into()
            } else {
                first
            }
        }
        "WebFetch" | "WebSearch" => "done".into(),
        _ => "done".into(),
    }
}

// ---------- unit tests for the §5.4 derivation logic (acceptance criteria) ----------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn edit_counts_replace_one_line() {
        assert_eq!(edit_counts("a\nb\nc", "a\nX\nc"), (1, 1)); // +1 −1
    }

    #[test]
    fn transcript_block_roundtrips_finalized() {
        let b = BufBlock {
            block_id: "b1".into(),
            kind: BlockKind::Tool,
            text: String::new(),
            tool: "Edit".into(),
            summary: "src/x.rs".into(),
            meta: Some("+3 \u{2212}1".into()),
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
            text: String::new(),
            tool: String::new(),
            summary: "explorer".into(), // subagent name lives in `summary`
            meta: Some("done".into()),
            streaming: false,
        };
        let back = parse_persisted_block(&serde_json::to_string(&persisted_block_json(&b)).unwrap()).unwrap();
        assert!(matches!(back.kind, BlockKind::Subagent));
        assert_eq!(back.summary, "explorer");
        assert_eq!(back.meta.as_deref(), Some("done"));
    }

    #[test]
    fn resume_fail_predicate_truth_table() {
        // fires only for a resumed turn that never started a thread and wasn't interrupted
        assert!(is_resume_fail(true, false, false, false));
        assert!(!is_resume_fail(false, false, false, false)); // not resumed → ordinary early error
        assert!(!is_resume_fail(true, true, false, false)); // saw init → thread started
        assert!(!is_resume_fail(true, false, true, false)); // produced a result → turn ran
        assert!(!is_resume_fail(true, false, false, true)); // user interrupted → no retry
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
        assert_eq!(parse_session_record(&json!({ "id": "z", "name": "n", "cwd": "/", "modelId": "claude-opus-4" }), 0).unwrap().model_id, "opus");
        // missing required field → None
        assert!(parse_session_record(&json!({ "name": "x" }), 0).is_none());
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
    fn edit_counts_noop() {
        assert_eq!(edit_counts("a\nb", "a\nb"), (0, 0));
    }

    #[test]
    fn edit_counts_pure_insertion() {
        // insert a line between a and b: +1 −0
        assert_eq!(edit_counts("a\nb", "a\nX\nb"), (1, 0));
    }

    #[test]
    fn edit_counts_pure_deletion() {
        assert_eq!(edit_counts("a\nX\nb", "a\nb"), (0, 1));
    }

    #[test]
    fn read_meta_counts_lines() {
        assert_eq!(tool_meta("Read", &json!({}), "l1\nl2\nl3"), "3 lines");
    }

    #[test]
    fn grep_meta_content_mode() {
        let r = "src/a.ts:1:foo\nsrc/b.ts:2:foo";
        assert_eq!(tool_meta("Grep", &json!({}), r), "2 matches \u{b7} 2 files");
    }

    #[test]
    fn grep_meta_no_matches() {
        assert_eq!(tool_meta("Grep", &json!({}), ""), "no matches");
    }

    #[test]
    fn edit_meta_uses_minus_sign() {
        let input = json!({ "old_string": "a\nb\nc", "new_string": "a\nX\nc" });
        assert_eq!(tool_meta("Edit", &input, ""), "+1 \u{2212}1");
    }

    #[test]
    fn multiedit_meta_sums_edits() {
        let input = json!({ "edits": [
            { "old_string": "a\nb", "new_string": "a\nX\nb" },   // +1 -0
            { "old_string": "p\nq\nr", "new_string": "p\nr" },   // +0 -1
        ]});
        assert_eq!(tool_meta("MultiEdit", &input, ""), "+1 \u{2212}1");
    }

    #[test]
    fn write_meta_counts_input_lines() {
        assert_eq!(tool_meta("Write", &json!({ "content": "a\nb" }), ""), "2 lines");
    }

    #[test]
    fn bash_meta_empty_is_done() {
        assert_eq!(tool_meta("Bash", &json!({}), "   "), "done");
    }

    #[test]
    fn read_summary_relative_to_cwd() {
        let input = json!({ "file_path": "/proj/acme/src/x.ts" });
        assert_eq!(tool_summary("Read", &input, "/proj/acme"), "src/x.ts");
    }

    #[test]
    fn grep_summary_truncates() {
        let long = "x".repeat(80);
        let input = json!({ "pattern": long });
        assert_eq!(tool_summary("Grep", &input, "").chars().count(), 60);
    }

    #[test]
    fn task_summary_prefers_subagent_type() {
        let input = json!({ "subagent_type": "reviewer", "description": "review the diff" });
        assert_eq!(tool_summary("Task", &input, ""), "reviewer");
    }

    #[test]
    fn subagent_tool_recognizes_task_and_agent() {
        assert!(is_subagent_tool("Task"));
        assert!(is_subagent_tool("Agent")); // this harness's subagent tool name
        assert!(!is_subagent_tool("Read"));
        assert!(!is_subagent_tool("Bash"));
    }

    #[test]
    fn agent_tool_summary_uses_subagent_type() {
        let input = json!({ "subagent_type": "explorer", "description": "find files" });
        assert_eq!(tool_summary("Agent", &input, ""), "explorer");
    }

    #[test]
    fn skill_description_first_sentence() {
        let md = "---\nname: x\ndescription: Read and parse PDFs. Then do more things.\n---\n\n# x\nbody";
        assert_eq!(parse_skill_description_str(md), "Read and parse PDFs");
    }

    #[test]
    fn skill_description_quoted_and_capped() {
        let long = "a".repeat(150);
        let md = format!("---\ndescription: \"{long}\"\n---\n");
        let out = parse_skill_description_str(&md);
        assert_eq!(out.chars().count(), 101); // 100 chars + ellipsis
        assert!(out.ends_with('…'));
    }

    #[test]
    fn skill_description_missing_is_empty() {
        assert_eq!(parse_skill_description_str("# no frontmatter\nhi"), "");
        assert_eq!(parse_skill_description_str("---\nname: x\n---\n"), "");
    }

    #[test]
    fn norm_path_forward_slashes_no_trailing() {
        assert_eq!(norm_path("D:\\francois\\"), "D:/francois");
        assert_eq!(norm_path("D:/francois"), "D:/francois");
        assert_eq!(norm_path("/home/u/proj/"), "/home/u/proj");
    }

    #[test]
    fn project_node_matches_normalized_path() {
        let cj = json!({ "projects": { "D:/francois": { "mcpServers": { "x": {} } } } });
        // backslash cwd must still resolve to the forward-slash key
        let node = project_node(&cj, "D:\\francois");
        assert!(node.is_some());
        assert_eq!(mcp_servers_of(node).len(), 1);
    }

    #[test]
    fn compute_used_sums_input_cacheread_output() {
        let u = json!({ "input_tokens": 10, "cache_read_input_tokens": 21213, "output_tokens": 47 });
        assert_eq!(compute_used(&u), 21270);
    }

    #[test]
    fn catalog_fallback_contains_default() {
        assert!(catalog().iter().any(|m| m.id == DEFAULT_MODEL));
    }

    #[test]
    fn context_limit_resolves_alias_to_family_flagship() {
        // Seed the cache the way refresh_models would (family-grouped, newest first).
        {
            let mut c = model_cache().lock().unwrap();
            *c = vec![
                ModelInfo { id: "claude-opus-4-8".into(), label: "Opus 4.8".into(), brief: None, context_tokens: Some(1_000_000), efforts: vec![] },
                ModelInfo { id: "claude-opus-4-5-20251101".into(), label: "Opus 4.5".into(), brief: None, context_tokens: Some(200_000), efforts: vec![] },
                ModelInfo { id: "claude-haiku-4-5".into(), label: "Haiku 4.5".into(), brief: None, context_tokens: Some(200_000), efforts: vec![] },
            ];
        }
        // exact id
        assert_eq!(context_limit("claude-opus-4-8"), 1_000_000);
        // CLI alias resolves to the newest opus (flagship), not the 200K older one
        assert_eq!(context_limit("opus"), 1_000_000);
        assert_eq!(context_limit("haiku"), 200_000);
        // unknown family → default
        model_cache().lock().unwrap().clear();
        assert_eq!(context_limit("opus"), 200_000);
    }

    #[test]
    fn humanize_model_ids() {
        assert_eq!(humanize("claude-opus-4-8"), "Opus 4.8");
        assert_eq!(humanize("claude-sonnet-4-5-20250929"), "Sonnet 4.5");
        assert_eq!(humanize("claude-fable-5"), "Fable 5");
        assert_eq!(humanize("opus"), "Opus");
    }
}
