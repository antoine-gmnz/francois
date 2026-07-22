// session.rs — the Francois session engine (specs/session-engine.md).
//
// Owns the registry of Claude Code sessions, spawns `claude -p --output-format
// stream-json --input-format stream-json --permission-prompt-tool stdio
// --include-partial-messages --verbose` per turn (the turn text rides stdin as an
// NDJSON user line — session-questions), parses the NDJSON stream, and normalizes
// it to the SessionEvent stream on francois://session/event.
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
// usage-bar §6: the /usage meter grammar + stream-json answer extraction now live
// in usage.rs so the usage bar and this card path share ONE grammar. Behavior here
// is unchanged — these are the same functions, imported instead of defined.
use crate::usage::{parse_meter_line, probe_answer, synthetic_text, UsageMeter};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};

const EVENT_CHANNEL: &str = "francois://session/event";
const QUEUE_CAP: usize = 20;
const DEFAULT_MODEL: &str = "sonnet";
/// interactive-commands FR-10: a /usage//cost probe is killed after this long.
/// Reused by the app-scoped usage-bar probe (usage.rs, usage-bar FR-8).
pub(crate) const PROBE_TIMEOUT_SECS: u64 = 30;

// ---------- model catalog (§5.1) ----------
//
// `id` is passed verbatim to `claude --model <id>`. We use the CLI's tier
// aliases (sonnet/opus/haiku), which resolve to the latest available model of
// each tier — robust across releases and account tiers. (Made-up full IDs like
// `claude-opus-4` are rejected by the CLI.)

fn catalog() -> Vec<ModelInfo> {
    vec![
        model("sonnet", "Sonnet"),
        model("opus", "Opus"),
        model("haiku", "Haiku"),
    ]
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
    if let Some(c) = cache
        .iter()
        .find(|m| m.id == model_id)
        .and_then(|m| m.context_tokens)
    {
        return Some(c);
    }
    let key = model_id.to_lowercase();
    let fam = ["fable", "opus", "sonnet", "haiku"]
        .into_iter()
        .find(|f| key.contains(f))?;
    // The CLI alias points at the family flagship — take the largest context window in
    // the family rather than relying on cache ordering / "newest".
    cache
        .iter()
        .filter(|m| m.id.to_lowercase().contains(fam))
        .filter_map(|m| m.context_tokens)
        .max()
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
    v.get("claudeAiOauth")?
        .get("accessToken")?
        .as_str()
        .map(String::from)
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
            let created = m
                .get("created_at")
                .and_then(|c| c.as_str())
                .unwrap_or("")
                .to_string();
            let ctx = m.get("max_input_tokens").and_then(|v| v.as_u64());
            let out = m.get("max_tokens").and_then(|v| v.as_u64());
            let caps = m.get("capabilities");
            let cap = |key: &str| {
                caps.and_then(|c| c.get(key))
                    .and_then(|c| c.get("supported"))
                    .and_then(|b| b.as_bool())
                    .unwrap_or(false)
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
            let brief = if parts.is_empty() {
                None
            } else {
                Some(parts.join(" \u{b7} "))
            };
            let efforts: Vec<String> = caps
                .and_then(|c| c.get("effort"))
                .filter(|e| {
                    e.get("supported")
                        .and_then(|b| b.as_bool())
                        .unwrap_or(false)
                })
                .map(|e| {
                    ["low", "medium", "high", "xhigh", "max"]
                        .iter()
                        .filter(|lvl| {
                            e.get(**lvl)
                                .and_then(|l| l.get("supported"))
                                .and_then(|b| b.as_bool())
                                .unwrap_or(false)
                        })
                        .map(|lvl| lvl.to_string())
                        .collect()
                })
                .unwrap_or_default();
            Some((
                tier_rank(&id),
                created,
                ModelInfo {
                    id,
                    label,
                    brief,
                    context_tokens: ctx,
                    efforts,
                },
            ))
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
    let Some(tier) = parts.first() else {
        return id.to_string();
    };
    let mut chars = tier.chars();
    let tier_cap = chars
        .next()
        .map(|c| c.to_uppercase().collect::<String>() + chars.as_str())
        .unwrap_or_default();
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
    ModelInfo {
        id: id.into(),
        label: label.into(),
        brief: None,
        context_tokens: None,
        efforts: Vec::new(),
    }
}

fn valid_effort(e: &str) -> bool {
    matches!(e, "low" | "medium" | "high" | "xhigh" | "max")
}

/// contract/common.ts PermissionMode. The CLI's `auto`/`dontAsk` are deliberately
/// excluded (auto aborts headless -p runs on classifier blocks; dontAsk needs a
/// paired allowedTools list).
fn valid_permission_mode(m: &str) -> bool {
    matches!(m, "default" | "plan" | "acceptEdits" | "bypassPermissions")
}

/// contract/common.ts ClaudeRuntime. 'wsl' is only accepted on Windows (create-time check).
fn valid_runtime(r: &str) -> bool {
    matches!(r, "native" | "wsl")
}

/// `--permission-mode` args for a turn. 'default' adds NOTHING — the turn inherits
/// the user's ~/.claude settings (permissions.defaultMode / allow rules), exactly
/// the pre-feature behavior. The flag does not persist across --resume, so every
/// invocation passes it explicitly.
fn permission_args(mode: &str) -> Vec<String> {
    match mode {
        "plan" | "acceptEdits" | "bypassPermissions" => {
            vec!["--permission-mode".into(), mode.into()]
        }
        _ => Vec::new(),
    }
}

/// (program, argv) launching `claude <claude_args>` under a session's runtime.
/// wsl: `wsl.exe --cd <dir> -- claude …`. Drive-letter cwds pass through verbatim
/// (wsl.exe maps them to /mnt/… itself — verified live), but a WSL UNC cwd MUST be
/// pre-translated to its Linux path: `--cd '\\wsl.localhost\…'` fails with
/// Wsl/E_INVALIDARG (verified live; wsl-filesystem FR-2/FR-11 rationale).
/// native: plain `claude …`; the caller sets current_dir.
fn claude_invocation(runtime: &str, cwd: &str, claude_args: Vec<String>) -> (String, Vec<String>) {
    if runtime == "wsl" {
        let cd = crate::wsl::wsl_unc_to_linux(cwd)
            .map(|(_, p)| p)
            .unwrap_or_else(|| cwd.to_string());
        let mut argv = vec![
            "--cd".to_string(),
            cd,
            "--".to_string(),
            "claude".to_string(),
        ];
        argv.extend(claude_args);
        ("wsl.exe".into(), argv)
    } else {
        ("claude".into(), claude_args)
    }
}

#[cfg(windows)]
pub(crate) fn no_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW — no console flash (esp. wsl.exe)
}
#[cfg(not(windows))]
pub(crate) fn no_window(_cmd: &mut Command) {}

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
    #[serde(rename = "permissionMode")]
    permission_mode: String,
    runtime: String,
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

// ---------- interactive-commands card shapes (contract/common.ts, reproduced) ----------
//
// The CommandCard union + UsageMeter/HelpEntry vocabulary are canonical in
// contract/common.ts; the intercept set / help entries / grammar are canonical in
// contract/interactive-commands.ts. Mirrored here by hand (specs/interactive-commands.md §5).

// `UsageMeter` (contract UsageMeter) is defined in usage.rs and imported above —
// the /usage card and the usage bar must serialize the identical shape.

/// contract HelpEntry — one /help card row.
#[derive(Serialize, Clone)]
struct HelpEntry {
    command: &'static str,
    description: &'static str,
}

/// contract CommandCard — the tagged payload of command.output.
#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum CommandCard {
    /// /usage & /cost, parsed (FR-9). meters non-empty; tail preformatted.
    Usage {
        command: String,
        meters: Vec<UsageMeter>,
        tail: String,
    },
    /// /context (FR-19). The three parse fields serialize as JSON null when the
    /// tokens line didn't match (contract: `number | null` — never omitted).
    Context {
        #[serde(rename = "percentUsed")]
        percent_used: Option<u64>,
        #[serde(rename = "usedLabel")]
        used_label: Option<String>,
        #[serde(rename = "limitLabel")]
        limit_label: Option<String>,
        body: String,
    },
    /// /model bare (FR-12). currentId is a snapshot; the live marker derives from SessionMeta.
    Model {
        models: Vec<ModelInfo>,
        #[serde(rename = "currentId")]
        current_id: String,
    },
    /// /status (FR-14).
    Status { meta: SessionMeta },
    /// /help (FR-15).
    Help { entries: Vec<HelpEntry> },
    /// Dim one-liner: unknown/unavailable command, probe failure, model switch ack.
    Notice { text: String },
    /// Generic CLI-local output that fits no richer card.
    Text { command: String, text: String },
}

// ---------- session questions (specs/session-questions.md) ----------
//
// The stdio control channel: every session turn runs with `--input-format
// stream-json --permission-prompt-tool stdio`, so the CLI emits `control_request`
// lines instead of silently stripping AskUserQuestion from the toolset. Only
// AskUserQuestion parks a turn (FR-6); every other permission ask is denied
// instantly (FR-8) and unknown subtypes get an error response (FR-9), so the CLI
// can never park on something Francois does not render.

/// Mirrors QuestionOption in contract/common.ts. Lenient on missing fields (FR-7).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
struct QuestionOption {
    #[serde(default)]
    label: String,
    #[serde(default)]
    description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    preview: Option<String>,
}

/// Mirrors SessionQuestion in contract/common.ts. multiSelect defaults to false
/// when absent (FR-7); everything renders verbatim.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
struct SessionQuestion {
    #[serde(default)]
    question: String,
    #[serde(default)]
    header: String,
    #[serde(default)]
    options: Vec<QuestionOption>,
    #[serde(rename = "multiSelect", default)]
    multi_select: bool,
}

/// FR-8: the deny message for any non-AskUserQuestion permission ask.
const PERMISSION_DENY_MSG: &str = "Francois declined: interactive permission prompts are not supported yet — adjust the session's permission mode.";

/// A parked AskUserQuestion awaiting its answer, keyed by blockId in the turn's
/// pending map (§6). `input` is the VERBATIM tool input — the allow response must
/// echo it unmodified plus the answers map (FR-11/FR-12).
struct PendingQuestion {
    request_id: String,
    input: Value,
}

/// FR-7: parse the AskUserQuestion input leniently. None ⇔ no non-empty
/// `questions` array (or unparseable entries) → auto-deny, no card.
fn parse_questions(input: &Value) -> Option<Vec<SessionQuestion>> {
    let arr = input.get("questions")?.as_array()?;
    if arr.is_empty() {
        return None;
    }
    arr.iter()
        .map(|q| serde_json::from_value(q.clone()).ok())
        .collect()
}

/// §5.5 allow response: `updatedInput` = verbatim original input + the answers map.
fn allow_response(request_id: &str, input: &Value, answers: &Value) -> Value {
    let mut updated = input.clone();
    if let Some(obj) = updated.as_object_mut() {
        obj.insert("answers".into(), answers.clone());
    }
    serde_json::json!({ "type": "control_response", "response": {
        "subtype": "success", "request_id": request_id,
        "response": { "behavior": "allow", "updatedInput": updated } } })
}

/// §5.5 deny response (FR-7 malformed / FR-8 other tools / FR-13 best-effort).
fn deny_response(request_id: &str, message: &str) -> Value {
    serde_json::json!({ "type": "control_response", "response": {
        "subtype": "success", "request_id": request_id,
        "response": { "behavior": "deny", "message": message } } })
}

/// §5.5 error response for unsupported control_request subtypes (FR-9).
fn error_response(request_id: &str) -> Value {
    serde_json::json!({ "type": "control_response", "response": {
        "subtype": "error", "request_id": request_id, "error": "unsupported control request" } })
}

/// What to do with an inbound `control_request` line. Pure; unit-tested.
enum ControlDecision {
    /// AskUserQuestion with well-formed input: park it (FR-6).
    Ask {
        request_id: String,
        input: Value,
        questions: Vec<SessionQuestion>,
    },
    /// Answer immediately with this control_response payload (FR-7/8/9).
    Respond(Value),
}

fn decide_control_request(v: &Value) -> ControlDecision {
    let request_id = v
        .get("request_id")
        .and_then(|r| r.as_str())
        .unwrap_or("")
        .to_string();
    let req = v.get("request");
    let subtype = req
        .and_then(|r| r.get("subtype"))
        .and_then(|s| s.as_str())
        .unwrap_or("");
    if subtype != "can_use_tool" {
        return ControlDecision::Respond(error_response(&request_id));
    }
    let tool = req
        .and_then(|r| r.get("tool_name"))
        .and_then(|t| t.as_str())
        .unwrap_or("");
    if tool != "AskUserQuestion" {
        return ControlDecision::Respond(deny_response(&request_id, PERMISSION_DENY_MSG));
    }
    let input = req
        .and_then(|r| r.get("input"))
        .cloned()
        .unwrap_or(Value::Null);
    match parse_questions(&input) {
        Some(questions) => ControlDecision::Ask {
            request_id,
            input,
            questions,
        },
        None => ControlDecision::Respond(deny_response(
            &request_id,
            "malformed AskUserQuestion input",
        )),
    }
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
    #[serde(rename = "command.started")]
    CommandStarted {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "blockId")]
        block_id: String,
        command: String,
    },
    #[serde(rename = "command.output")]
    CommandOutput {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "blockId")]
        block_id: String,
        card: Value,
    },
    #[serde(rename = "question.asked")]
    QuestionAsked {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "blockId")]
        block_id: String,
        questions: Vec<SessionQuestion>,
    },
    #[serde(rename = "question.resolved")]
    QuestionResolved {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "blockId")]
        block_id: String,
        state: String, // "answered" | "cancelled"
        /// Present iff answered — omitted (never null) otherwise (§9).
        #[serde(skip_serializing_if = "Option::is_none")]
        answers: Option<Value>,
    },
    #[serde(rename = "session.commands")]
    Commands {
        #[serde(rename = "sessionId")]
        session_id: String,
        commands: Vec<SlashCommandInfo>,
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
    Command,  // interactive-commands: a slash-command response card
    Question, // session-questions: an AskUserQuestion card
}

#[derive(Clone)]
struct BufBlock {
    block_id: String,
    kind: BlockKind,
    text: String,
    // Field reuse per kind (precedent: the subagent name lives in `summary`):
    // `tool` holds the tool name for Tool blocks and the command token for Command blocks.
    tool: String,
    summary: String,
    meta: Option<String>,
    /// interactive-commands: serialized CommandCard (Command kind; None while pending).
    card: Option<Value>,
    streaming: bool,
}

struct TurnHandle {
    child: Arc<Mutex<Child>>,
    interrupted: Arc<AtomicBool>,
    /// session-questions FR-2: the turn's stdin writer. Lives for the whole turn;
    /// None once the turn ends (closing it is what lets the CLI exit). ALL writes
    /// go through this mutex — never while holding Engine.sessions (a blocking
    /// pipe write must not stall every command).
    stdin: Arc<Mutex<Option<ChildStdin>>>,
    /// session-questions FR-6: blockId → parked AskUserQuestion. Removing an entry
    /// CLAIMS it — that atomic claim is what makes resolution exactly-once (FR-13).
    pending_questions: Arc<Mutex<HashMap<String, PendingQuestion>>>,
}

/// The single in-flight /usage-/cost side-spawn of a session (interactive-commands
/// FR-11). The child slot is filled once spawned; killed on session remove & app exit.
struct ProbeHandle {
    block_id: String,
    child: Arc<Mutex<Option<Child>>>,
}

impl ProbeHandle {
    fn kill(&self) {
        if let Some(c) = self.child.lock().unwrap().as_mut() {
            let _ = c.kill();
        }
    }
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
    effort: Option<String>,            // --effort level (None = model default)
    permission_mode: String, // contract PermissionMode; "default" = inherit ~/.claude settings
    runtime: String,         // contract ClaudeRuntime; "native" | "wsl"
    queue: VecDeque<(String, String)>, // (client blockId, text)
    claude_session_id: Option<String>,
    current: Option<TurnHandle>,
    pending_probe: Option<ProbeHandle>, // interactive-commands FR-11: single in-flight side-spawn
    agents: HashMap<String, AgentInfo>,
    agent_order: Vec<String>,    // first-seen order for agents_list (FR-7)
    block_buffer: Vec<BufBlock>, // §6: read by conversation-view's getTranscript
    mcp: HashMap<String, McpServerInfo>,
    // slash-menu FR-2: the CLI's slash_commands captured from the latest
    // stream-json init (bare names, init order). In-memory only — never
    // persisted; a fresh app relearns it on the next turn (spec §6).
    cli_commands: Vec<String>,
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
            permission_mode: self.permission_mode.clone(),
            runtime: self.runtime.clone(),
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
            card: None,
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
            card: None,
            streaming: false,
        });
    }

    fn buf_tool(&mut self, block_id: &str, tool: String, summary: String, is_task: bool) {
        self.block_buffer.push(BufBlock {
            block_id: block_id.into(),
            kind: if is_task {
                BlockKind::Subagent
            } else {
                BlockKind::Tool
            },
            text: String::new(),
            tool,
            summary,
            meta: None,
            card: None,
            streaming: true,
        });
    }

    /// interactive-commands FR-6: append a pending command block (loading card).
    fn buf_command_pending(&mut self, block_id: &str, command: &str) {
        self.block_buffer.push(BufBlock {
            block_id: block_id.into(),
            kind: BlockKind::Command,
            text: String::new(),
            tool: command.into(),
            summary: String::new(),
            meta: None,
            card: None,
            streaming: true,
        });
    }

    /// interactive-commands FR-9/20: finalize the pending command block in place, or
    /// append a finalized one when the flow had no command.started (instant cards).
    fn buf_command_output(&mut self, block_id: &str, command: &str, card: Value) {
        if let Some(b) = self
            .block_buffer
            .iter_mut()
            .find(|b| b.block_id == block_id)
        {
            b.card = Some(card);
            b.streaming = false;
        } else {
            self.block_buffer.push(BufBlock {
                block_id: block_id.into(),
                kind: BlockKind::Command,
                text: String::new(),
                tool: command.into(),
                summary: String::new(),
                meta: None,
                card: Some(card),
                streaming: false,
            });
        }
    }

    /// session-questions FR-6: append a pending question block. `card` reuse: for
    /// Question blocks it holds `{ questions, state, answers? }`.
    fn buf_question(&mut self, block_id: &str, questions: Value) {
        self.block_buffer.push(BufBlock {
            block_id: block_id.into(),
            kind: BlockKind::Question,
            text: String::new(),
            tool: String::new(),
            summary: String::new(),
            meta: None,
            card: Some(serde_json::json!({ "questions": questions, "state": "pending" })),
            streaming: true,
        });
    }

    /// session-questions FR-11/FR-13: flip a question block to its resolved state
    /// in place. Returns the updated block (for persistence) or None if unknown.
    fn buf_question_resolve(
        &mut self,
        block_id: &str,
        state: &str,
        answers: Option<&Value>,
    ) -> Option<BufBlock> {
        let b = self
            .block_buffer
            .iter_mut()
            .find(|b| b.block_id == block_id && b.kind == BlockKind::Question)?;
        if let Some(card) = b.card.as_mut() {
            card["state"] = Value::String(state.into());
            if let Some(a) = answers {
                card["answers"] = a.clone();
            }
        }
        b.streaming = false;
        Some(b.clone())
    }

    /// interactive-commands FR-11: reserve the single in-flight probe slot.
    /// Returns the (still empty) child slot, or None if a probe is already pending.
    fn reserve_probe(&mut self, block_id: &str) -> Option<Arc<Mutex<Option<Child>>>> {
        if self.pending_probe.is_some() {
            return None;
        }
        let child = Arc::new(Mutex::new(None));
        self.pending_probe = Some(ProbeHandle {
            block_id: block_id.into(),
            child: child.clone(),
        });
        Some(child)
    }

    fn buf_tool_done(&mut self, block_id: &str, meta: String) {
        if let Some(b) = self
            .block_buffer
            .iter_mut()
            .find(|b| b.block_id == block_id)
        {
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
            let (gc, bc) = if b.streaming {
                ("#c8a15a", "#dfe2e8")
            } else {
                ("#868a93", "#c4c7ce")
            };
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
        BlockKind::Command => {
            // CommandConversationBlock (contract/interactive-commands.ts): `card` absent while pending.
            let mut o = serde_json::json!({
                "kind": "command", "blockId": b.block_id, "isStreaming": b.streaming,
                "command": b.tool,
            });
            if let Some(c) = &b.card {
                o["card"] = c.clone();
            }
            o
        }
        BlockKind::Question => {
            // QuestionConversationBlock (contract/session-questions.ts): isStreaming
            // ⇔ pending (FR-15); `answers` present iff answered, never null.
            let card = b.card.clone().unwrap_or_else(|| serde_json::json!({}));
            let mut o = serde_json::json!({
                "kind": "question", "blockId": b.block_id, "isStreaming": b.streaming,
                "questions": card.get("questions").cloned().unwrap_or_else(|| Value::Array(Vec::new())),
                "state": card.get("state").cloned().unwrap_or_else(|| Value::String("pending".into())),
            });
            if let Some(a) = card.get("answers") {
                o["answers"] = a.clone();
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
        self.sessions
            .lock()
            .unwrap()
            .get(session_id)
            .map(|s| s.cwd.clone())
    }

    /// The claude runtime ("native" | "wsl") of a session — used by the `shell`
    /// domain's per-session spawn matrix (wsl-filesystem FR-10/FR-11). None if unknown.
    pub fn runtime_of(&self, session_id: &str) -> Option<String> {
        self.sessions
            .lock()
            .unwrap()
            .get(session_id)
            .map(|s| s.runtime.clone())
    }
}

/// Kill every in-flight turn's child process (called on app exit).
pub fn kill_all(app: &AppHandle) {
    let Some(engine) = app.try_state::<Engine>() else {
        return;
    };
    // session-questions FR-13 (app-exit teardown, §7#5): drain every parked
    // question BEFORE killing its child, so the cancelled state is persisted
    // synchronously here — the reader threads may never get to run again. The
    // drain is the exactly-once claim; a reader that does run finds nothing.
    let mut orphaned: Vec<(String, String)> = Vec::new(); // (session_id, block_id)
    {
        let map = engine.sessions.lock().unwrap();
        for s in map.values() {
            if let Some(turn) = &s.current {
                turn.interrupted.store(true, Ordering::SeqCst);
                {
                    let mut p = turn.pending_questions.lock().unwrap();
                    for (bid, _) in p.drain() {
                        orphaned.push((s.id.clone(), bid));
                    }
                }
                let _ = turn.child.lock().unwrap().kill();
            }
            if let Some(p) = &s.pending_probe {
                p.kill(); // interactive-commands: probes die with the app
            }
        }
    }
    for (sid, bid) in orphaned {
        resolve_question(app, &sid, &bid, "cancelled", None);
    }
}

// ---------- persistence (FR-42/43) ----------

fn sessions_json_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("sessions.json"))
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
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("transcripts").join(format!("{session_id}.jsonl")))
}

/// Serialize a finalized block to the on-disk PersistedBlock shape (durable-sessions §5).
fn persisted_block_json(b: &BufBlock) -> Value {
    let kind = match b.kind {
        BlockKind::User => "user",
        BlockKind::Assistant => "assistant",
        BlockKind::Tool => "tool",
        BlockKind::Subagent => "subagent",
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

/// Parse one PersistedBlock line back into a BufBlock. Returns None for a malformed
/// or partial line so reload can skip it (FR-15).
fn parse_persisted_block(line: &str) -> Option<BufBlock> {
    let v: Value = serde_json::from_str(line).ok()?;
    let kind = match v.get("kind").and_then(|k| k.as_str())? {
        "user" => BlockKind::User,
        "assistant" => BlockKind::Assistant,
        "tool" => BlockKind::Tool,
        "subagent" => BlockKind::Subagent,
        "command" => {
            // A persisted command block always carries its card (FR-24 — pending blocks
            // are never persisted); treat a card-less line as malformed and skip it.
            let card = v.get("card").filter(|c| !c.is_null())?.clone();
            return Some(BufBlock {
                block_id: v.get("blockId").and_then(|b| b.as_str())?.to_string(),
                kind: BlockKind::Command,
                text: String::new(),
                tool: v
                    .get("command")
                    .and_then(|c| c.as_str())
                    .unwrap_or("")
                    .to_string(),
                summary: String::new(),
                meta: None,
                card: Some(card),
                streaming: false,
            });
        }
        "question" => {
            // session-questions §6: pending entries are memory-only, so a line still
            // "pending" on disk can only be read back after a hard kill — and a dead
            // process has no answerable questions. Normalize it to cancelled.
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
                block_id: v.get("blockId").and_then(|b| b.as_str())?.to_string(),
                kind: BlockKind::Question,
                text: String::new(),
                tool: String::new(),
                summary: String::new(),
                meta: None,
                card: Some(card),
                streaming: false,
            });
        }
        _ => return None,
    };
    Some(BufBlock {
        block_id: v.get("blockId").and_then(|b| b.as_str())?.to_string(),
        kind,
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
        card: None,
        streaming: false,
    })
}

/// Fold persisted lines into blocks, upserting by blockId: the LAST line wins, at
/// the FIRST occurrence's position. Question resolutions re-append their block
/// (session-questions FR-15); everything else appends exactly once.
fn parse_transcript(content: &str) -> Vec<BufBlock> {
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
fn read_transcript(app: &AppHandle, session_id: &str) -> Vec<BufBlock> {
    let Some(path) = transcript_path(app, session_id) else {
        return Vec::new();
    };
    let Ok(content) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    parse_transcript(&content)
}

fn persist(app: &AppHandle, engine: &Engine) {
    // One writer at a time: persist() is called from commands (async runtime) AND
    // from run_reader threads, and every caller writes the SAME sessions.json.tmp
    // before the atomic rename — two concurrent writers could rename a torn file.
    static PERSIST_LOCK: Mutex<()> = Mutex::new(());
    let _w = PERSIST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let map = engine.sessions.lock().unwrap();
    let list: Vec<Value> = map
        .values()
        .map(|s| {
            serde_json::json!({
                "id": s.id, "name": s.name, "cwd": s.cwd, "modelId": s.model_id, "effort": s.effort,
                "permissionMode": s.permission_mode, "runtime": s.runtime,
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
    permission_mode: String, // "default" when absent (pre-feature records)
    runtime: String,         // "native" when absent, or when "wsl" off-Windows
    claude_session_id: Option<String>,
    last_activity_at: u64,
    context_used_tokens: u64,
}

fn parse_session_record(rec: &Value, now: u64) -> Option<PersistedMeta> {
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
    })
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
                status: "idle".into(),
                context_used_tokens: m.context_used_tokens,
                context_limit_tokens: limit,
                started_at: now,
                last_activity_at: m.last_activity_at,
                error_message: None,
                effort: m.effort,
                permission_mode: m.permission_mode,
                runtime: m.runtime,
                queue: VecDeque::new(),
                claude_session_id: m.claude_session_id,
                current: None,
                pending_probe: None,
                agents: HashMap::new(),
                agent_order: Vec::new(),
                block_buffer,
                mcp: HashMap::new(),
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

// ---------- helpers ----------

pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
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

#[tauri::command(async)]
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

#[tauri::command(async)]
pub fn agents_list(engine: State<'_, Engine>, session_id: String) -> IpcResult<Vec<AgentInfo>> {
    let map = engine.sessions.lock().unwrap();
    match map.get(&session_id) {
        None => err("SESSION_NOT_FOUND", "no such session"),
        Some(s) => ok(s
            .agent_order
            .iter()
            .filter_map(|id| s.agents.get(id).cloned())
            .collect()),
    }
}

#[derive(Serialize)]
pub struct DispatchOutput {
    #[serde(rename = "agentId")]
    agent_id: String,
}

#[tauri::command(async)]
pub fn agents_dispatch(
    app: AppHandle,
    engine: State<'_, Engine>,
    session_id: String,
    task: String,
) -> IpcResult<DispatchOutput> {
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

#[tauri::command(async)]
pub fn agents_kill(
    app: AppHandle,
    engine: State<'_, Engine>,
    agent_id: String,
) -> IpcResult<Option<()>> {
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
    cj.get("projects")?
        .as_object()?
        .iter()
        .find_map(|(k, v)| path_eq(k, cwd).then_some(v))
}

fn write_mcp_json(cwd: &str, v: &Value) -> std::io::Result<()> {
    std::fs::write(
        mcp_json_path(cwd),
        serde_json::to_vec_pretty(v).unwrap_or_default(),
    )
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
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    if args.is_empty() {
        cmd.to_string()
    } else {
        format!("{} {}", cmd, args.join(" "))
    }
}

fn connecting_info(name: &str) -> McpServerInfo {
    McpServerInfo {
        name: name.to_string(),
        status: "connecting".into(),
        tool_count: None,
        error_message: None,
        scope: None,
    }
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

#[tauri::command(async)]
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
    if let Some(v) = project_node(&cj, cwd)
        .and_then(|n| n.get("mcpServers"))
        .and_then(|m| m.get(name))
    {
        return Some((v.clone(), "local".into()));
    }
    if let Some(v) = read_mcp_json(cwd)
        .get("mcpServers")
        .and_then(|m| m.get(name))
    {
        return Some((v.clone(), "project".into()));
    }
    if let Some(v) = cj.get("mcpServers").and_then(|m| m.get(name)) {
        return Some((v.clone(), "user".into()));
    }
    None
}

#[tauri::command(async)]
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
        let mut info = runtime
            .get(&name)
            .cloned()
            .unwrap_or_else(|| connecting_info(&name));
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

#[tauri::command(async)]
pub fn mcp_detail(engine: State<'_, Engine>, session_id: String, name: String) -> IpcResult<Value> {
    let (cwd, runtime) = {
        let map = engine.sessions.lock().unwrap();
        let Some(s) = map.get(&session_id) else {
            return err("SESSION_NOT_FOUND", "no such session");
        };
        (s.cwd.clone(), s.mcp.get(&name).cloned())
    };
    let Some((entry, scope)) = find_mcp_config(&cwd, &name) else {
        return err(
            "MCP_ERROR",
            format!("'{name}' is not configured for this session"),
        );
    };
    let transport = transport_of(&entry);
    let mut info = runtime.unwrap_or_else(|| connecting_info(&name));
    info.scope = Some(scope);
    let mut o = serde_json::to_value(&info).unwrap();
    o["transport"] = Value::String(transport.into());
    if transport == "stdio" {
        o["command"] = Value::String(command_of(&entry));
    } else {
        o["url"] = Value::String(
            entry
                .get("url")
                .and_then(|u| u.as_str())
                .unwrap_or("")
                .into(),
        );
    }
    ok(o)
}

#[tauri::command(async)]
pub fn mcp_reconnect(
    app: AppHandle,
    engine: State<'_, Engine>,
    session_id: String,
    name: String,
) -> IpcResult<Option<()>> {
    let info = {
        let mut map = engine.sessions.lock().unwrap();
        let Some(s) = map.get_mut(&session_id) else {
            return err("SESSION_NOT_FOUND", "no such session");
        };
        let info = connecting_info(&name);
        s.mcp.insert(name.clone(), info.clone());
        info
    };
    emit(
        &app,
        SessionEvent::McpUpdate {
            session_id,
            server: info,
        },
    );
    ok(None)
}

#[tauri::command(async)]
pub fn mcp_detach(
    engine: State<'_, Engine>,
    session_id: String,
    name: String,
) -> IpcResult<Option<()>> {
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

#[tauri::command(async)]
pub fn mcp_attach(
    app: AppHandle,
    engine: State<'_, Engine>,
    session_id: String,
    entry: Value,
) -> IpcResult<Option<()>> {
    let name = entry
        .get("name")
        .and_then(|n| n.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if name.is_empty() {
        return err("INVALID_INPUT", "server name is required");
    }
    let transport = entry
        .get("transport")
        .and_then(|t| t.as_str())
        .unwrap_or("stdio");
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
        return err(
            "MCP_ERROR",
            "malformed .mcp.json (mcpServers is not an object)",
        );
    };
    if servers.contains_key(&name) {
        return err(
            "INVALID_INPUT",
            format!("'{name}' already exists in this project's .mcp.json"),
        );
    }

    let secret = entry.get("secretParams").and_then(|s| s.as_object());
    let server = if transport == "http" {
        let url = entry
            .get("url")
            .and_then(|u| u.as_str())
            .unwrap_or("")
            .trim();
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
        let cmdline = entry
            .get("command")
            .and_then(|c| c.as_str())
            .unwrap_or("")
            .trim();
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
    emit(
        &app,
        SessionEvent::McpUpdate {
            session_id,
            server: info,
        },
    );
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
    let Some(home) = dirs::home_dir() else {
        return set;
    };
    let cfg = std::fs::read(home.join(".claude").join("settings.json"))
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok());
    if let Some(obj) = cfg
        .as_ref()
        .and_then(|c| c.get("enabledPlugins"))
        .and_then(|e| e.as_object())
    {
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
    let Some(root) = marketplaces_root() else {
        return out;
    };
    let Ok(mkts) = std::fs::read_dir(&root) else {
        return out;
    };
    for mkt in mkts.flatten() {
        if !mkt.path().is_dir() {
            continue;
        }
        let Some(mkt_name) = mkt.file_name().to_str().map(String::from) else {
            continue;
        };
        for sub in ["plugins", "external_plugins"] {
            let Ok(plugins) = std::fs::read_dir(mkt.path().join(sub)) else {
                continue;
            };
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
    let Ok(entries) = std::fs::read_dir(dir) else {
        return out;
    };
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

fn skill_entry(
    name: String,
    description: String,
    installed: bool,
    scope: &str,
    kind: &str,
    plugin_id: Option<String>,
) -> SkillInfo {
    SkillInfo {
        name,
        description,
        installed,
        scope: Some(scope.into()),
        kind: Some(kind.into()),
        plugin_id,
    }
}

/// Full skills+commands list for a cwd (FR-3/4): installed (project ∪ user ∪ enabled
/// plugins, alpha) then available (non-enabled plugin skills, alpha). Project wins over
/// user wins over plugin on a name collision; skill wins over command within a scope.
fn discover_skills(cwd: &str) -> Vec<SkillInfo> {
    let mut installed: std::collections::BTreeMap<String, SkillInfo> =
        std::collections::BTreeMap::new();
    let enabled = enabled_plugin_ids();

    // insert lowest → highest precedence; each later insert overwrites the earlier.
    for (pid, dir) in all_plugins() {
        if !enabled.contains(&pid) {
            continue;
        }
        for (n, d) in scan_commands(&dir.join("commands")) {
            installed.insert(
                n.clone(),
                skill_entry(n, d, true, "plugin", "command", Some(pid.clone())),
            );
        }
        for (n, d) in scan_skills(&dir.join("skills")) {
            installed.insert(
                n.clone(),
                skill_entry(n, d, true, "plugin", "skill", Some(pid.clone())),
            );
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
        installed.insert(
            n.clone(),
            skill_entry(n, d, true, "project", "command", None),
        );
    }
    for (n, d) in scan_skills(&skills_dir(proj)) {
        installed.insert(n.clone(), skill_entry(n, d, true, "project", "skill", None));
    }

    // available = SKILL.md skills from plugins that are NOT enabled, excluding installed names.
    let mut available: std::collections::BTreeMap<String, SkillInfo> =
        std::collections::BTreeMap::new();
    for (pid, dir) in all_plugins() {
        if enabled.contains(&pid) {
            continue;
        }
        for (n, d) in scan_skills(&dir.join("skills")) {
            if installed.contains_key(&n) || available.contains_key(&n) {
                continue;
            }
            available.insert(
                n.clone(),
                skill_entry(n, d, false, "plugin", "skill", Some(pid.clone())),
            );
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
    std::fs::read_to_string(skill_md)
        .map(|c| parse_skill_description_str(&c))
        .unwrap_or_default()
}

/// Parse the `description:` from a SKILL.md frontmatter, first sentence, ≤100 chars (FR-4).
fn parse_skill_description_str(content: &str) -> String {
    let trimmed = content.trim_start();
    if !trimmed.starts_with("---") {
        return String::new();
    }
    // frontmatter is between the first two `---` fences
    let after = &trimmed[3..];
    let Some(end) = after.find("\n---") else {
        return String::new();
    };
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
        if (b == b'.' || b == b'!' || b == b'?')
            && (i + 1 >= bytes.len() || bytes[i + 1].is_ascii_whitespace())
        {
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
    let Ok(entries) = std::fs::read_dir(dir) else {
        return out;
    };
    for e in entries.flatten() {
        let path = e.path();
        if !path.is_dir() {
            continue;
        }
        let skill_md = path.join("SKILL.md");
        if !skill_md.is_file() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        out.push((name.to_string(), parse_skill_description(&skill_md)));
    }
    out
}

#[tauri::command(async)]
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
#[tauri::command(async)]
pub fn skills_install(
    app: AppHandle,
    engine: State<'_, Engine>,
    session_id: String,
    name: String,
) -> IpcResult<Option<()>> {
    let cwd = {
        let map = engine.sessions.lock().unwrap();
        let Some(s) = map.get(&session_id) else {
            return err("SESSION_NOT_FOUND", "no such session");
        };
        s.cwd.clone()
    };
    let Some(target) = discover_skills(&cwd)
        .into_iter()
        .find(|s| s.name == name && !s.installed)
    else {
        return err(
            "SKILL_ERROR",
            format!("'{name}' is not an available plugin skill"),
        );
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
            _ => {
                return err(
                    "SKILL_ERROR",
                    "~/.claude/settings.json is not valid JSON — refusing to modify it",
                )
            }
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
        return err(
            "SKILL_ERROR",
            "malformed settings.json (enabledPlugins is not an object)",
        );
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
        return err(
            "SKILL_ERROR",
            format!("could not replace settings.json: {e}"),
        );
    }
    let _ = app.emit(
        "francois://skills/event",
        serde_json::json!({ "type": "skills.changed", "sessionId": session_id }),
    );
    ok(None)
}

#[tauri::command(async)]
pub fn skills_run(
    app: AppHandle,
    engine: State<'_, Engine>,
    session_id: String,
    name: String,
    args: Option<String>,
) -> IpcResult<Option<()>> {
    let cwd = {
        let map = engine.sessions.lock().unwrap();
        let Some(s) = map.get(&session_id) else {
            return err("SESSION_NOT_FOUND", "no such session");
        };
        s.cwd.clone()
    };
    if !discover_skills(&cwd)
        .iter()
        .any(|s| s.installed && s.name == name)
    {
        return err("INVALID_INPUT", format!("'{name}' is not installed"));
    }
    let text = match args {
        Some(a) if !a.trim().is_empty() => format!("/{} {}", name, a.trim()),
        _ => format!("/{name}"),
    };
    // interactive-commands §2 non-goal: skills pass through byte-for-byte — a
    // skill named usage/cost/model/status/help must still run as a real turn.
    match do_send(&app, &session_id, text, uuid(), SendSource::Skill) {
        IpcResult::Ok { .. } => ok(None),
        IpcResult::Err { error, .. } => IpcResult::Err { ok: false, error },
    }
}

// ---------- slash menu (specs/slash-menu.md) ----------
//
// One merged per-session command registry (FR-1): builtins (help_entries,
// verbatim) > installed skills/commands (discover_skills) > the CLI's own
// slash_commands captured from the stream-json init event (FR-2). Dedup by
// name, first source wins; order per FR-3. Served by session_list_commands
// and pushed as one session.commands event whenever an init CHANGES the
// captured cli set.

/// Mirrors SlashCommandInfo in contract/common.ts.
#[derive(Serialize, Clone)]
pub struct SlashCommandInfo {
    name: String,         // without the leading '/'; rendering adds it
    description: String,  // "" when the source provides none (cli)
    source: &'static str, // "builtin" | "skill" | "cli" (contract SlashCommandSource)
    /// skill entries only: the SkillInfo scope (project | user | plugin).
    #[serde(skip_serializing_if = "Option::is_none")]
    scope: Option<String>,
}

/// FR-1/FR-3 merge, pure: builtins first (help order), then installed skills
/// (discovery order; both kinds — skills and command files are all invoked as
/// /<name>), then cli names (init order). First occurrence of a name wins.
fn merge_commands(
    builtins: &[HelpEntry],
    skills: &[SkillInfo],
    cli: &[String],
) -> Vec<SlashCommandInfo> {
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut out = Vec::new();
    for h in builtins {
        if seen.insert(h.command.to_string()) {
            out.push(SlashCommandInfo {
                name: h.command.to_string(),
                description: h.description.to_string(),
                source: "builtin",
                scope: None,
            });
        }
    }
    for s in skills {
        if !s.installed {
            continue; // spec §2 non-goal: only what is runnable now
        }
        if seen.insert(s.name.clone()) {
            out.push(SlashCommandInfo {
                name: s.name.clone(),
                description: s.description.clone(),
                source: "skill",
                scope: s.scope.clone(),
            });
        }
    }
    for name in cli {
        if seen.insert(name.clone()) {
            out.push(SlashCommandInfo {
                name: name.clone(),
                description: String::new(),
                source: "cli",
                scope: None,
            });
        }
    }
    out
}

/// FR-2: an init event's slash_commands, normalized to bare names (a leading
/// '/' is stripped — FR-3 stores without it; non-strings skipped). None when
/// the array is absent (→ no change to the capture).
fn parse_init_slash_commands(v: &Value) -> Option<Vec<String>> {
    let arr = v.get("slash_commands")?.as_array()?;
    Some(
        arr.iter()
            .filter_map(|x| x.as_str())
            .map(|s| s.strip_prefix('/').unwrap_or(s).to_string())
            .collect(),
    )
}

/// FR-2 change detection: replace the in-memory capture; true iff it differed
/// (→ the caller emits one session.commands with the merged registry).
fn capture_cli_commands(session: &mut Session, names: Vec<String>) -> bool {
    if session.cli_commands == names {
        return false;
    }
    session.cli_commands = names;
    true
}

/// francois:session:listCommands (slash-menu FR-1/FR-4): the merged registry.
/// Snapshot under the lock, then scan the disk with it dropped — never holds
/// Engine.sessions across fs work, never touches a running turn.
#[tauri::command(async)]
pub fn session_list_commands(
    engine: State<'_, Engine>,
    session_id: String,
) -> IpcResult<Vec<SlashCommandInfo>> {
    let (cwd, cli) = {
        let map = engine.sessions.lock().unwrap();
        let Some(s) = map.get(&session_id) else {
            return err("SESSION_NOT_FOUND", "no such session");
        };
        (s.cwd.clone(), s.cli_commands.clone())
    };
    ok(merge_commands(
        &help_entries(),
        &discover_skills(&cwd),
        &cli,
    ))
}

/// francois:conversation:getTranscript — owned by conversation-view (spec §5).
/// Returns the session's in-memory transcript buffer as ConversationBlock[].
#[tauri::command(async)]
pub fn conversation_get_transcript(
    engine: State<'_, Engine>,
    session_id: String,
) -> IpcResult<Vec<Value>> {
    let map = engine.sessions.lock().unwrap();
    match map.get(&session_id) {
        None => err("SESSION_NOT_FOUND", "no such session"),
        Some(s) => ok(s.block_buffer.iter().map(classify_block).collect()),
    }
}

/// francois:session:pickDirectory — owned by sessions-sidebar (spec §5).
/// Opens the native OS directory dialog. `data: null` = user cancelled.
#[tauri::command(async)]
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

#[tauri::command(async)]
pub fn session_list(app: AppHandle, engine: State<'_, Engine>) -> IpcResult<Vec<Value>> {
    // FR-12: re-emit one session.meta per entry (registry order) before resolving.
    let metas: Vec<SessionMeta> = {
        let map = engine.sessions.lock().unwrap();
        map.values().map(|s| s.meta()).collect()
    };
    for m in &metas {
        emit(&app, SessionEvent::Meta { meta: m.clone() });
    }
    ok(metas
        .into_iter()
        .map(|m| serde_json::to_value(m).unwrap())
        .collect())
}

#[tauri::command(async)]
pub fn session_create(
    app: AppHandle,
    engine: State<'_, Engine>,
    cwd: String,
    name: Option<String>,
    model_id: Option<String>,
    effort: Option<String>,
    permission_mode: Option<String>,
    runtime: Option<String>,
) -> IpcResult<Value> {
    // FR-7: cwd must exist and be a directory.
    let meta = std::fs::metadata(&cwd);
    match meta {
        Ok(m) if m.is_dir() => {}
        _ => {
            return err(
                "INVALID_INPUT",
                "working directory does not exist or is not a directory",
            )
        }
    }
    // Model is chosen from the live list (session_models); accept any non-empty
    // id and let the CLI reject a truly invalid one at turn time. Being
    // permissive here is what keeps newly released models usable without a
    // redeploy.
    let model_id = model_id
        .filter(|m| !m.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_MODEL.to_string());
    let permission_mode = permission_mode.unwrap_or_else(|| "default".to_string());
    if !valid_permission_mode(&permission_mode) {
        return err("INVALID_INPUT", "unknown permission mode");
    }
    let runtime = runtime.unwrap_or_else(|| "native".to_string());
    if !valid_runtime(&runtime) {
        return err("INVALID_INPUT", "unknown runtime");
    }
    if runtime == "wsl" && !cfg!(windows) {
        return err(
            "INVALID_INPUT",
            "the WSL runtime is only available on Windows",
        );
    }
    // FR-9: eager spawn check — verify the claude binary runs under the session's runtime.
    let (probe, probe_args) = claude_invocation(&runtime, &cwd, vec!["--version".to_string()]);
    let mut probe_cmd = Command::new(&probe);
    probe_cmd
        .args(&probe_args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    no_window(&mut probe_cmd);
    match probe_cmd.status() {
        Ok(s) if s.success() => {}
        Ok(_) if runtime == "wsl" => {
            return err("SPAWN_FAILED", "Claude Code CLI failed inside WSL. Run `claude` once in your WSL distro to install and authenticate it.")
        }
        Ok(_) => return err("SPAWN_FAILED", "Claude Code CLI exited with an error. Run `claude` once in a terminal to authenticate."),
        Err(_) if runtime == "wsl" => return err("SPAWN_FAILED", "WSL not found. Install it (wsl --install) or use the native runtime."),
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
        permission_mode,
        runtime,
        queue: VecDeque::new(),
        claude_session_id: None,
        current: None,
        pending_probe: None,
        agents: HashMap::new(),
        agent_order: Vec::new(),
        block_buffer: Vec::new(),
        mcp: HashMap::new(),
        cli_commands: Vec::new(),
    };
    let meta = session.meta();
    engine.sessions.lock().unwrap().insert(id.clone(), session);
    persist(&app, &engine);
    emit(&app, SessionEvent::Meta { meta: meta.clone() });
    crate::diff::watch_session(&app, &id, &cwd); // FR-15: watch the session's cwd
    ok(serde_json::to_value(meta).unwrap())
}

#[tauri::command(async)]
pub fn session_remove(
    app: AppHandle,
    engine: State<'_, Engine>,
    session_id: String,
) -> IpcResult<Option<()>> {
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
            if let Some(p) = &session.pending_probe {
                p.kill(); // interactive-commands: the probe dies with the session (§7)
            }
            persist(&app, &engine);
            if let Some(path) = transcript_path(&app, &session_id) {
                let _ = std::fs::remove_file(path); // durable-sessions FR-11 (best-effort)
            }
            crate::diff::unwatch_session(&session_id); // FR-15: dispose the watcher
            crate::dispose_session_shell(&app, &session_id); // wsl-filesystem FR-13: dispose the shell
            emit(&app, SessionEvent::Removed { session_id });
            ok(None)
        }
    }
}

#[tauri::command(async)]
pub fn session_switch_model(
    app: AppHandle,
    engine: State<'_, Engine>,
    session_id: String,
    model_id: String,
) -> IpcResult<Value> {
    if model_id.trim().is_empty() {
        return err("INVALID_INPUT", "model is empty");
    }
    {
        let map = engine.sessions.lock().unwrap();
        let Some(s) = map.get(&session_id) else {
            return err("SESSION_NOT_FOUND", "no such session");
        };
        if s.status == "done" || s.status == "error" {
            return err("SESSION_NOT_RUNNING", "session has ended");
        }
    }
    match apply_model_switch(&app, &session_id, &model_id) {
        Some(meta) => ok(serde_json::to_value(meta).unwrap()),
        None => err("SESSION_NOT_FOUND", "no such session"),
    }
}

/// Shared switch semantics (francois:session:switchModel and `/model <arg>` —
/// interactive-commands FR-13): update the model + context limit, persist, emit
/// session.meta. The in-flight turn is unaffected. None if the session is gone.
fn apply_model_switch(app: &AppHandle, session_id: &str, model_id: &str) -> Option<SessionMeta> {
    let engine = app.state::<Engine>();
    let meta = {
        let mut map = engine.sessions.lock().unwrap();
        let s = map.get_mut(session_id)?;
        s.model_id = model_id.to_string();
        s.context_limit_tokens = context_limit(model_id);
        s.meta()
    };
    persist(app, &engine);
    emit(app, SessionEvent::Meta { meta: meta.clone() });
    Some(meta)
}

#[tauri::command(async)]
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
    // routes completion (drain queue or go idle) — FR-24. A pending question is
    // cancelled by the same reader-thread teardown (session-questions FR-13).
    ok(None)
}

/// francois:session:answerQuestion (session-questions FR-11/FR-12, §5.4).
/// Writes the §5.5 allow control_response (verbatim input + answers) to the
/// parked turn's stdin, then resolves the block as answered. Never resolves `ok`
/// unless the response reached the child's stdin.
#[tauri::command(async)]
pub fn session_answer_question(
    app: AppHandle,
    engine: State<'_, Engine>,
    session_id: String,
    block_id: String,
    answers: HashMap<String, String>,
) -> IpcResult<Option<()>> {
    if answers.is_empty() {
        return err("INVALID_INPUT", "answers is empty");
    }
    // Snapshot the turn's shared handles, then RELEASE the sessions lock — the
    // stdin write below can block and must never stall every other command.
    let handles = {
        let map = engine.sessions.lock().unwrap();
        match map.get(&session_id) {
            None => return err("SESSION_NOT_FOUND", "no such session"),
            Some(s) => s
                .current
                .as_ref()
                .map(|t| (t.stdin.clone(), t.pending_questions.clone())),
        }
    };
    let Some((stdin, pending)) = handles else {
        // No turn in flight ⇒ nothing can be pending (turn over).
        return err("QUESTION_NOT_PENDING", "that question is no longer pending");
    };
    // Claim the entry — removal is the exactly-once guarantee (FR-13): a concurrent
    // cancel / turn-end that got there first already resolved this question.
    let claimed = {
        let mut p = pending.lock().unwrap();
        p.remove(&block_id)
    };
    let Some(q) = claimed else {
        return err("QUESTION_NOT_PENDING", "that question is no longer pending");
    };
    let answers_value = serde_json::to_value(&answers).unwrap_or_else(|_| serde_json::json!({}));
    let payload = allow_response(&q.request_id, &q.input, &answers_value);
    if !write_control_line(&stdin, &payload) {
        // §5.4: the child died between park and answer — FR-13 cancels the
        // question, and the caller learns it is no longer pending.
        resolve_question(&app, &session_id, &block_id, "cancelled", None);
        return err("QUESTION_NOT_PENDING", "that question is no longer pending");
    }
    resolve_question(
        &app,
        &session_id,
        &block_id,
        "answered",
        Some(&answers_value),
    );
    ok(None)
}

#[derive(Serialize)]
pub struct SendOutput {
    queued: bool,
    #[serde(rename = "queuePosition", skip_serializing_if = "Option::is_none")]
    queue_position: Option<usize>,
}

/// Where a send originated — controls the interactive-commands intercept branch.
#[derive(Clone, Copy, PartialEq)]
enum SendSource {
    /// Typed input (francois:session:send): slash commands in the intercept set
    /// are answered locally (interactive-commands FR-2).
    Typed,
    /// francois:skills:run: custom skills pass through byte-for-byte
    /// (interactive-commands §2 non-goal) — never intercepted, always a real turn.
    Skill,
}

/// The intercept decision for a send (interactive-commands FR-1/2), honoring the
/// skills passthrough. Pure; unit-tested.
fn send_intercept(text: &str, source: SendSource) -> Option<(String, Option<String>)> {
    match source {
        SendSource::Typed => intercepted_command(text),
        SendSource::Skill => None,
    }
}

/// Shared send logic (used by session_send and skills_run): queue if a turn is
/// running, else start a new turn. Assumes `text` is already non-empty.
fn do_send(
    app: &AppHandle,
    session_id: &str,
    text: String,
    block_id: String,
    source: SendSource,
) -> IpcResult<SendOutput> {
    let engine = app.state::<Engine>();
    let mut map = engine.sessions.lock().unwrap();
    let Some(s) = map.get_mut(session_id) else {
        return err("SESSION_NOT_FOUND", "no such session");
    };
    if s.status == "done" || s.status == "error" {
        return err("SESSION_NOT_RUNNING", "session has ended; create a new one");
    }
    // interactive-commands FR-1/2: an intercepted slash command never enqueues, never
    // changes SessionStatus, and works identically whether running or idle. It sits
    // BEFORE the running→enqueue branch so it bypasses the FIFO queue.
    if let Some((command, arg)) = send_intercept(&text, source) {
        // FR-4: user echo first — buffer + persist the user block, then message.user
        // with the request's blockId, then the per-command flow.
        s.buf_user(&block_id, text.clone());
        s.last_activity_at = now_ms();
        let user_block = s.block_buffer.last().cloned();
        drop(map);
        if let Some(b) = &user_block {
            append_transcript(app, session_id, b);
        }
        emit(
            app,
            SessionEvent::MessageUser {
                session_id: session_id.into(),
                block_id,
                text,
            },
        );
        run_intercepted_command(app, session_id, &command, arg.as_deref());
        return ok(SendOutput {
            queued: false,
            queue_position: None,
        }); // FR-3
    }
    match s.status.as_str() {
        "running" => {
            if s.queue.len() >= QUEUE_CAP {
                return err("INVALID_INPUT", "send queue is full (20 pending)");
            }
            s.queue.push_back((block_id, text));
            let pos = s.queue.len();
            return ok(SendOutput {
                queued: true,
                queue_position: Some(pos),
            });
        }
        _ => {} // idle → start a turn
    }
    s.status = "running".into();
    s.last_activity_at = now_ms();
    drop(map);
    emit(
        app,
        SessionEvent::Status {
            session_id: session_id.into(),
            status: "running".into(),
        },
    );
    begin_turn(app, session_id, block_id, text, TurnMode::Normal);
    ok(SendOutput {
        queued: false,
        queue_position: None,
    })
}

#[tauri::command(async)]
pub fn session_send(
    app: AppHandle,
    session_id: String,
    text: String,
    block_id: Option<String>,
) -> IpcResult<SendOutput> {
    if text.trim().is_empty() {
        return err("INVALID_INPUT", "message is empty");
    }
    // The client generates the blockId so its optimistic block matches the
    // eventual message.user event (conversation-view FR-15/FR-21).
    do_send(
        &app,
        &session_id,
        text,
        block_id.unwrap_or_else(uuid),
        SendSource::Typed,
    )
}

#[tauri::command(async)]
pub fn session_compact(
    app: AppHandle,
    engine: State<'_, Engine>,
    session_id: String,
) -> IpcResult<Option<()>> {
    // Snapshot cwd/model/resume/effort; enforce status.
    let (cwd, model_id, resume, effort, permission_mode, runtime) = {
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
        (
            s.cwd.clone(),
            s.model_id.clone(),
            s.claude_session_id.clone(),
            s.effort.clone(),
            s.permission_mode.clone(),
            s.runtime.clone(),
        )
    };
    emit(
        &app,
        SessionEvent::Status {
            session_id: session_id.clone(),
            status: "running".into(),
        },
    );

    // Run a synchronous compaction turn ("/compact"), reading only its final
    // usage — FR-28. No transcript events are surfaced.
    let limit = context_limit(&model_id);
    let mut used: Option<u64> = None;
    if let Ok(mut child) = spawn_claude(
        &cwd,
        &model_id,
        resume.as_deref(),
        "/compact",
        effort.as_deref(),
        &permission_mode,
        &runtime,
    ) {
        // session-questions FR-5: /compact rides the stdin path like any turn, but a
        // compaction can never park on a question — close the pipe right away; the
        // EOF is what lets the CLI exit after its result (stream-json input mode).
        drop(child.stdin.take());
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
    crate::usage::note_turn_ended(&app); // usage-bar FR-13: a /compact turn ended too
    if let Some(u) = used {
        emit(
            &app,
            SessionEvent::ContextUsage {
                session_id: session_id.clone(),
                used_tokens: u,
                limit_tokens: limit,
            },
        );
    }
    emit(
        &app,
        SessionEvent::Status {
            session_id,
            status: "idle".into(),
        },
    );
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

/// The claude argv for a session turn. session-questions FR-1: `-p` with NO
/// positional prompt (the turn text rides stdin), plus the stdio control channel
/// (`--input-format stream-json --permission-prompt-tool stdio`). Pure; unit-tested.
fn turn_args(
    model_id: &str,
    resume: Option<&str>,
    effort: Option<&str>,
    permission_mode: &str,
) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "-p".into(),
        "--output-format".into(),
        "stream-json".into(),
        "--input-format".into(),
        "stream-json".into(),
        "--permission-prompt-tool".into(),
        "stdio".into(),
        "--include-partial-messages".into(),
        "--verbose".into(),
        "--model".into(),
        model_id.into(),
    ];
    args.extend(permission_args(permission_mode)); // per-invocation; --resume does not carry it
    if let Some(e) = effort {
        args.extend(["--effort".into(), e.into()]);
    }
    if let Some(r) = resume {
        args.extend(["--resume".into(), r.into()]);
    }
    args
}

/// The §5.5 NDJSON user line carrying a turn's text over stdin (FR-1).
fn user_line(text: &str) -> String {
    let mut line = serde_json::json!({
        "type": "user",
        "message": { "role": "user", "content": [{ "type": "text", "text": text }] }
    })
    .to_string();
    line.push('\n');
    line
}

fn spawn_claude(
    cwd: &str,
    model_id: &str,
    resume: Option<&str>,
    text: &str,
    effort: Option<&str>,
    permission_mode: &str,
    runtime: &str,
) -> std::io::Result<Child> {
    let args = turn_args(model_id, resume, effort, permission_mode);
    let (program, argv) = claude_invocation(runtime, cwd, args);
    let mut cmd = Command::new(program);
    cmd.args(argv);
    if runtime != "wsl" {
        cmd.current_dir(cwd); // wsl turns get their cwd via `--cd` inside the distro
    }
    no_window(&mut cmd);
    // session-questions FR-1: stdin is piped — the turn text goes down it as one
    // NDJSON user line, and the stdio control channel (question answers /
    // permission denies) rides the same pipe for the rest of the turn.
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = cmd.spawn()?;
    let wrote = {
        use std::io::Write as _;
        match child.stdin.as_mut() {
            Some(w) => w
                .write_all(user_line(text).as_bytes())
                .and_then(|_| w.flush()),
            None => Ok(()),
        }
    };
    if let Err(e) = wrote {
        // The child died before reading its prompt — surface it as a spawn failure.
        let _ = child.kill();
        return Err(e);
    }
    Ok(child)
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
fn is_resume_fail(
    resume_used: bool,
    got_init: bool,
    got_result: bool,
    was_interrupted: bool,
) -> bool {
    resume_used && !got_init && !got_result && !was_interrupted
}

fn begin_turn(app: &AppHandle, session_id: &str, block_id: String, text: String, mode: TurnMode) {
    let (cwd, model_id, resume, effort, permission_mode, runtime) = {
        let engine = app.state::<Engine>();
        let mut map = engine.sessions.lock().unwrap();
        let Some(s) = map.get_mut(session_id) else {
            return;
        };
        // ResumeRetry forces resume off regardless of the stored id, so a still-good id
        // is never dropped preemptively — a fresh init overwrites it only on success.
        let resume = if mode == TurnMode::ResumeRetry {
            None
        } else {
            s.claude_session_id.clone()
        };
        (
            s.cwd.clone(),
            s.model_id.clone(),
            resume,
            s.effort.clone(),
            s.permission_mode.clone(),
            s.runtime.clone(),
        )
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
        emit(
            app,
            SessionEvent::MessageUser {
                session_id: session_id.into(),
                block_id: block_id.clone(),
                text: text.clone(),
            },
        );
    }

    let mut child = match spawn_claude(
        &cwd,
        &model_id,
        resume.as_deref(),
        &text,
        effort.as_deref(),
        &permission_mode,
        &runtime,
    ) {
        Ok(c) => c,
        Err(e) => {
            fail_session(
                app,
                session_id,
                "SPAWN_FAILED",
                &format!("could not start claude: {e}"),
            );
            return;
        }
    };
    // session-questions FR-2: the stdin writer joins the turn state for the whole
    // turn — the reader thread (denies) and session_answer_question (answers)
    // share it; it closes only when the turn ends.
    let stdin = Arc::new(Mutex::new(child.stdin.take()));
    let pending_questions: Arc<Mutex<HashMap<String, PendingQuestion>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let child = Arc::new(Mutex::new(child));
    let interrupted = Arc::new(AtomicBool::new(false));
    {
        let engine = app.state::<Engine>();
        let mut map = engine.sessions.lock().unwrap();
        if let Some(s) = map.get_mut(session_id) {
            s.current = Some(TurnHandle {
                child: child.clone(),
                interrupted: interrupted.clone(),
                stdin: stdin.clone(),
                pending_questions: pending_questions.clone(),
            });
        }
    }

    let app2 = app.clone();
    let sid = session_id.to_string();
    // block_id/text carried into the reader so a resume-fail can re-run this turn fresh (FR-9).
    std::thread::spawn(move || {
        run_reader(
            app2,
            sid,
            child,
            interrupted,
            stdin,
            pending_questions,
            model_id,
            resume_used,
            block_id,
            text,
        );
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
    stdin: Arc<Mutex<Option<ChildStdin>>>,
    pending_questions: Arc<Mutex<HashMap<String, PendingQuestion>>>,
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
    // interactive-commands: the turn's parsed command token (FR-17), whether a
    // synthetic message was carded (FR-16), and the result string (FR-18 fallback).
    let turn_cmd: Option<String> = parse_command(&text).map(|(c, _)| c);
    let mut saw_synthetic = false;
    let mut result_text: Option<String> = None;

    let cwd = {
        let engine = app.state::<Engine>();
        let map = engine.sessions.lock().unwrap();
        map.get(&session_id)
            .map(|s| s.cwd.clone())
            .unwrap_or_default()
    };

    for line in reader.lines() {
        let Ok(line) = line else { break };
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
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
                    // slash-menu FR-2: capture the CLI's own slash_commands; on a
                    // CHANGE emit one session.commands carrying the merged
                    // registry. Absent array → no change, identical set → silent.
                    if let Some(names) = parse_init_slash_commands(&v) {
                        let changed = {
                            let engine = app.state::<Engine>();
                            let mut map = engine.sessions.lock().unwrap();
                            map.get_mut(&session_id)
                                .is_some_and(|s| capture_cli_commands(s, names.clone()))
                        };
                        if changed {
                            // Engine.sessions dropped — the skills disk scan must
                            // never run under it (lock rules).
                            let commands =
                                merge_commands(&help_entries(), &discover_skills(&cwd), &names);
                            emit(
                                &app,
                                SessionEvent::Commands {
                                    session_id: session_id.clone(),
                                    commands,
                                },
                            );
                        }
                    }
                }
            }
            "stream_event" => {
                if let Some(ev) = v.get("event") {
                    handle_stream_event(
                        &app,
                        &session_id,
                        &cwd,
                        ev,
                        &mut blocks,
                        &mut tools,
                        &mut text_accum,
                        &mut open_block,
                        &mut pending_used,
                    );
                }
            }
            "user" => {
                handle_tool_results(&app, &session_id, &v, &mut tools, &mut open_block);
            }
            "assistant" => {
                // interactive-commands FR-16: a synthetic (CLI-local) assistant message
                // becomes its own command card — no assistant.delta/done for it. Real
                // top-level assistant echoes stay ignored (stream_events carry them).
                if let Some(answer) = synthetic_text(&v) {
                    saw_synthetic = true;
                    let card = classify_local_answer(turn_cmd.as_deref(), &answer);
                    finalize_command_block(
                        &app,
                        &session_id,
                        &uuid(),
                        turn_cmd.as_deref().unwrap_or(""),
                        &card,
                    );
                }
            }
            "result" => {
                got_result = true;
                if v.get("is_error").and_then(|b| b.as_bool()) == Some(true)
                    || v.get("subtype")
                        .and_then(|s| s.as_str())
                        .map(|s| s != "success")
                        .unwrap_or(false)
                {
                    result_error = Some(
                        v.get("result")
                            .and_then(|r| r.as_str())
                            .unwrap_or("the turn ended with an error")
                            .to_string(),
                    );
                }
                if let Some(r) = v.get("result").and_then(|r| r.as_str()) {
                    result_text = Some(r.to_string()); // interactive-commands FR-18
                }
                if let Some(u) = v.get("usage") {
                    pending_used = Some(compute_used(u));
                }
                // session-questions FR-2: the result ends the turn — dropping the
                // stdin writer is what lets the CLI exit (stream-json input mode
                // waits for EOF otherwise). No question can be pending past its
                // result: a parked request blocks it.
                *stdin.lock().unwrap() = None;
            }
            "control_request" => {
                // session-questions FR-6..FR-9 (stdio control channel).
                handle_control_request(&app, &session_id, &v, &stdin, &pending_questions);
            }
            "control_cancel_request" => {
                // session-questions FR-10: the CLI withdrew a parked request (e.g. a
                // user-configured auto-continue). Unmatched ids are ignored.
                if let Some(rid) = v.get("request_id").and_then(|r| r.as_str()) {
                    let claimed = {
                        let mut p = pending_questions.lock().unwrap();
                        let key = p
                            .iter()
                            .find(|(_, q)| q.request_id == rid)
                            .map(|(k, _)| k.clone());
                        key.and_then(|k| p.remove(&k).map(|q| (k, q)))
                    };
                    if let Some((bid, q)) = claimed {
                        // FR-13: best-effort deny for the (live) child, then cancel.
                        let _ = write_control_line(
                            &stdin,
                            &deny_response(&q.request_id, "question cancelled"),
                        );
                        resolve_question(&app, &session_id, &bid, "cancelled", None);
                    }
                }
            }
            _ => {} // keep_alive & any unrecognized top-level type stay ignored (FR-4)
        }
    }

    // session-questions FR-2: stdout is gone (result, child death, or interrupt) —
    // drop the stdin writer before wait() so the CLI can never linger on an open pipe.
    *stdin.lock().unwrap() = None;
    let _ = child.lock().unwrap().wait();
    let was_interrupted = interrupted.load(Ordering::SeqCst);

    // session-questions FR-13: any question still parked when the turn dies resolves
    // as cancelled, exactly once — this drain is the claim; kill_all's own drain and
    // an in-flight answer can never double-resolve. No control_response: child is gone.
    let orphaned: Vec<String> = {
        let mut p = pending_questions.lock().unwrap();
        p.drain().map(|(k, _)| k).collect()
    };
    for bid in orphaned {
        resolve_question(&app, &session_id, &bid, "cancelled", None);
    }

    // Resume-fail (FR-8/9): Claude rejected the stale --resume id before starting a
    // thread. Tell the UI and transparently re-run the same message on a fresh thread
    // (ResumeRetry forces resume off → this can fire at most once). The stored id is
    // left in place — a fresh init overwrites it on success; a transient failure keeps it.
    if is_resume_fail(resume_used, got_init, got_result, was_interrupted) {
        emit(
            &app,
            SessionEvent::ResumeFailed {
                session_id: session_id.clone(),
            },
        );
        begin_turn(&app, &session_id, block_id, text, TurnMode::ResumeRetry);
        return;
    }

    // Close any block left open (interrupt or crash) — FR-24/FR-34.
    if let Some((bid, kind)) = open_block.take() {
        if kind == 0 {
            emit(
                &app,
                SessionEvent::AssistantDone {
                    session_id: session_id.clone(),
                    block_id: bid,
                },
            );
        } else {
            emit(
                &app,
                SessionEvent::ToolDone {
                    session_id: session_id.clone(),
                    block_id: bid,
                    meta: "interrupted".into(),
                },
            );
        }
    }

    let limit = context_limit(&model_id);
    if got_result && result_error.is_none() {
        // interactive-commands FR-18 defensive fallback: a success turn with zero
        // assistant/tool blocks and no synthetic seen put its local answer only in
        // the result string — card it so no slash command ever dies silently.
        if command_fallback_fires(
            true,
            saw_synthetic,
            !blocks.is_empty(),
            result_text.as_deref(),
        ) {
            let answer = result_text.clone().unwrap_or_default();
            let card = classify_local_answer(turn_cmd.as_deref(), &answer);
            finalize_command_block(
                &app,
                &session_id,
                &uuid(),
                turn_cmd.as_deref().unwrap_or(""),
                &card,
            );
        }
        if let Some(u) = pending_used {
            update_used(&app, &session_id, u);
            emit(
                &app,
                SessionEvent::ContextUsage {
                    session_id: session_id.clone(),
                    used_tokens: u,
                    limit_tokens: limit,
                },
            );
        }
        finish_turn(&app, &session_id, false, None);
    } else if was_interrupted {
        if let Some(u) = pending_used {
            update_used(&app, &session_id, u);
            emit(
                &app,
                SessionEvent::ContextUsage {
                    session_id: session_id.clone(),
                    used_tokens: u,
                    limit_tokens: limit,
                },
            );
        }
        finish_turn(&app, &session_id, false, None);
    } else {
        let msg = result_error
            .unwrap_or_else(|| "the Claude Code process ended unexpectedly".to_string());
        finish_turn(&app, &session_id, true, Some(msg));
    }
}

/// Serialize + write one NDJSON control line to the turn's stdin. Every stdin
/// write goes through the handle's own mutex (reader-thread denies vs.
/// command-thread answers) and is NEVER made while holding Engine.sessions.
/// false ⇔ the pipe is gone (turn over / child dead).
fn write_control_line(stdin: &Arc<Mutex<Option<ChildStdin>>>, payload: &Value) -> bool {
    use std::io::Write as _;
    let mut line = payload.to_string();
    line.push('\n');
    let mut guard = stdin.lock().unwrap();
    match guard.as_mut() {
        Some(w) => w.write_all(line.as_bytes()).and_then(|_| w.flush()).is_ok(),
        None => false,
    }
}

/// Apply a `control_request` line (session-questions FR-6..FR-9): park an
/// AskUserQuestion as a pending entry + question block + question.asked event, or
/// answer everything else on the spot.
fn handle_control_request(
    app: &AppHandle,
    session_id: &str,
    v: &Value,
    stdin: &Arc<Mutex<Option<ChildStdin>>>,
    pending: &Arc<Mutex<HashMap<String, PendingQuestion>>>,
) {
    match decide_control_request(v) {
        ControlDecision::Respond(payload) => {
            let _ = write_control_line(stdin, &payload); // FR-7/8/9: no event, no card
        }
        ControlDecision::Ask {
            request_id,
            input,
            questions,
        } => {
            let question_block_id = uuid();
            pending.lock().unwrap().insert(
                question_block_id.clone(),
                PendingQuestion { request_id, input },
            );
            let questions_value =
                serde_json::to_value(&questions).unwrap_or_else(|_| Value::Array(Vec::new()));
            let block = {
                let engine = app.state::<Engine>();
                let mut map = engine.sessions.lock().unwrap();
                match map.get_mut(session_id) {
                    Some(s) => {
                        s.buf_question(&question_block_id, questions_value);
                        s.block_buffer.last().cloned()
                    }
                    None => None,
                }
            };
            if let Some(b) = &block {
                append_transcript(app, session_id, b); // FR-6: persisted while pending
            }
            emit(
                app,
                SessionEvent::QuestionAsked {
                    session_id: session_id.into(),
                    block_id: question_block_id,
                    questions,
                },
            );
        }
    }
}

/// session-questions FR-11/FR-13: flip a question block to its resolved state,
/// persist it, and emit exactly one question.resolved. Callers must have CLAIMED
/// the pending entry first (removed it from the turn's map) — that removal is
/// what makes resolution exactly-once.
fn resolve_question(
    app: &AppHandle,
    session_id: &str,
    block_id: &str,
    state: &str,
    answers: Option<&Value>,
) {
    let block = {
        let engine = app.state::<Engine>();
        let mut map = engine.sessions.lock().unwrap();
        map.get_mut(session_id)
            .and_then(|s| s.buf_question_resolve(block_id, state, answers))
    };
    if let Some(b) = &block {
        append_transcript(app, session_id, b);
    }
    emit(
        app,
        SessionEvent::QuestionResolved {
            session_id: session_id.into(),
            block_id: block_id.into(),
            state: state.into(),
            answers: answers.cloned(),
        },
    );
}

/// Route turn completion (FR-20): drain the queue or go idle; or mark error.
fn finish_turn(app: &AppHandle, session_id: &str, errored: bool, error_msg: Option<String>) {
    let engine = app.state::<Engine>();
    let next: Option<(String, String)> = {
        let mut map = engine.sessions.lock().unwrap();
        let Some(s) = map.get_mut(session_id) else {
            return;
        };
        s.current = None;
        if errored {
            s.status = "error".into();
            s.error_message = error_msg.clone();
            // Any running agents become errored (FR-40).
            let running: Vec<String> = s
                .agents
                .iter()
                .filter(|(_, a)| a.status == "running")
                .map(|(k, _)| k.clone())
                .collect();
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

    // usage-bar FR-13: this session just left `running` (idle or error), so plan
    // usage moved — schedule the debounced app-scoped probe. Called with NO engine
    // lock held; usage state is a leaf that never reaches back into the engine.
    if errored || next.is_none() {
        crate::usage::note_turn_ended(app);
    }

    if errored {
        let msg = error_msg.unwrap_or_else(|| "session error".into());
        // Final agent.update for any agents just errored.
        let agents: Vec<AgentInfo> = {
            let map = engine.sessions.lock().unwrap();
            map.get(session_id)
                .map(|s| {
                    s.agents
                        .values()
                        .filter(|a| a.status == "error")
                        .cloned()
                        .collect()
                })
                .unwrap_or_default()
        };
        for a in agents {
            emit(app, SessionEvent::AgentUpdate { agent: a });
        }
        emit(
            app,
            SessionEvent::Error {
                session_id: session_id.into(),
                error: AppError {
                    code: "INTERNAL".into(),
                    message: msg,
                },
            },
        );
        emit(
            app,
            SessionEvent::Status {
                session_id: session_id.into(),
                status: "error".into(),
            },
        );
        return;
    }

    match next {
        Some((block_id, text)) => begin_turn(app, session_id, block_id, text, TurnMode::Normal), // no idle blip (FR-20)
        None => emit(
            app,
            SessionEvent::Status {
                session_id: session_id.into(),
                status: "idle".into(),
            },
        ),
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
    crate::usage::note_turn_ended(app); // usage-bar FR-13: running → error
    emit(
        app,
        SessionEvent::Error {
            session_id: session_id.into(),
            error: AppError {
                code: code.into(),
                message: msg.into(),
            },
        },
    );
    emit(
        app,
        SessionEvent::Status {
            session_id: session_id.into(),
            status: "error".into(),
        },
    );
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
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    let Some(servers) = init.get("mcp_servers").and_then(|s| s.as_array()) else {
        return;
    };
    for srv in servers {
        let name = srv
            .get("name")
            .and_then(|n| n.as_str())
            .unwrap_or("")
            .to_string();
        if name.is_empty() {
            continue;
        }
        let raw_status = srv
            .get("status")
            .and_then(|s| s.as_str())
            .unwrap_or("connected");
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
            tool_count: if status == "connected" {
                Some(count)
            } else {
                None
            },
            error_message: if status == "error" {
                Some(
                    srv.get("error")
                        .and_then(|e| e.as_str())
                        .unwrap_or("connection failed")
                        .to_string(),
                )
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
        emit(
            app,
            SessionEvent::McpUpdate {
                session_id: session_id.into(),
                server: info,
            },
        );
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
                    let tool = cb
                        .get("name")
                        .and_then(|n| n.as_str())
                        .unwrap_or("")
                        .to_string();
                    let tuid = cb
                        .get("id")
                        .and_then(|i| i.as_str())
                        .unwrap_or("")
                        .to_string();
                    let start_input = cb
                        .get("input")
                        .cloned()
                        .unwrap_or(Value::Object(Default::default()));
                    blocks.insert(idx, (bid.clone(), 1, String::new()));
                    let is_task = is_subagent_tool(&tool);
                    tools.insert(
                        tuid.clone(),
                        ToolRec {
                            block_id: bid.clone(),
                            tool: tool.clone(),
                            input: start_input,
                            is_task,
                        },
                    );
                    // stash tuid in the block accum slot's kind — track via separate map:
                    blocks.get_mut(&idx).map(|b| b.2 = tuid.clone());
                    if is_task {
                        // Mint a subagent record (FR-37).
                        let agent_id = uuid();
                        let desc = tools
                            .get(&tuid)
                            .map(|r| {
                                r.input
                                    .get("description")
                                    .and_then(|d| d.as_str())
                                    .unwrap_or("subagent")
                                    .to_string()
                            })
                            .unwrap_or_else(|| "subagent".into());
                        let name = tools
                            .get(&tuid)
                            .and_then(|r| {
                                r.input
                                    .get("subagent_type")
                                    .and_then(|d| d.as_str())
                                    .map(String::from)
                            })
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
                            let text = delta
                                .get("text")
                                .and_then(|t| t.as_str())
                                .unwrap_or("")
                                .to_string();
                            text_accum.entry(bid.clone()).or_default().push_str(&text);
                            *open_block = Some((bid.clone(), 0));
                            emit(
                                app,
                                SessionEvent::AssistantDelta {
                                    session_id: session_id.into(),
                                    block_id: bid,
                                    text,
                                },
                            );
                        }
                    }
                }
                "input_json_delta" => {
                    if let Some(b) = blocks.get_mut(&idx) {
                        // b.2 currently holds the tool_use_id; accumulate partial json into the ToolRec instead.
                        let tuid = b.2.clone();
                        let partial = delta
                            .get("partial_json")
                            .and_then(|t| t.as_str())
                            .unwrap_or("");
                        if let Some(rec) = tools.get_mut(&tuid) {
                            let acc = rec
                                .input
                                .get("__acc")
                                .and_then(|a| a.as_str())
                                .unwrap_or("")
                                .to_string();
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
                    emit(
                        app,
                        SessionEvent::AssistantDone {
                            session_id: session_id.into(),
                            block_id: bid,
                        },
                    );
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
                        emit(
                            app,
                            SessionEvent::ToolStart {
                                session_id: session_id.into(),
                                block_id: bid,
                                tool: rec.tool.clone(),
                                summary,
                            },
                        );
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
    let content = v
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_array());
    let Some(content) = content else { return };
    for item in content {
        if item.get("type").and_then(|t| t.as_str()) != Some("tool_result") {
            continue;
        }
        let tuid = item
            .get("tool_use_id")
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .to_string();
        let is_error = item
            .get("is_error")
            .and_then(|b| b.as_bool())
            .unwrap_or(false);
        let result_text = extract_result_text(item.get("content"));
        let Some(rec) = tools.get(&tuid) else {
            continue;
        };
        let block_id = rec.block_id.clone();
        let meta = if is_error {
            "error".to_string()
        } else {
            tool_meta(&rec.tool, &rec.input, &result_text)
        };

        // Task completion → agent done (FR-39).
        if rec.is_task {
            if let Some(aid) = rec.input.get("__agentId").and_then(|a| a.as_str()) {
                let excerpt = result_text
                    .lines()
                    .next()
                    .unwrap_or("done")
                    .chars()
                    .take(80)
                    .collect::<String>();
                let agent = {
                    let engine = app.state::<Engine>();
                    let mut map = engine.sessions.lock().unwrap();
                    map.get_mut(session_id).and_then(|s| {
                        s.agents.get_mut(aid).map(|a| {
                            a.status = "done".into();
                            a.ended_at = Some(now_ms());
                            a.task = if excerpt.is_empty() {
                                a.task.clone()
                            } else {
                                excerpt.clone()
                            };
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
                    s.block_buffer
                        .iter()
                        .find(|b| b.block_id == block_id)
                        .cloned()
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
        emit(
            app,
            SessionEvent::ToolDone {
                session_id: session_id.into(),
                block_id,
                meta,
            },
        );
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
    let collapsed: String = s
        .chars()
        .map(|c| if c == '\n' || c == '\r' { ' ' } else { c })
        .collect();
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
        "Read" | "Edit" | "MultiEdit" | "Write" => str_field(input, "file_path")
            .map(|p| rel_path(p, cwd))
            .unwrap_or_default(),
        "Grep" => truncate(str_field(input, "pattern").unwrap_or(""), 60),
        "Glob" => str_field(input, "pattern").unwrap_or("").to_string(),
        "Bash" => truncate(str_field(input, "command").unwrap_or(""), 60),
        "Task" | "Agent" => str_field(input, "subagent_type")
            .or_else(|| str_field(input, "description"))
            .unwrap_or("subagent")
            .to_string(),
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
    while trail < (old_lines.len() - lead)
        && trail < (new_lines.len() - lead)
        && old_lines[old_lines.len() - 1 - trail] == new_lines[new_lines.len() - 1 - trail]
    {
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
        "Write" => format!(
            "{} lines",
            line_count(str_field(input, "content").unwrap_or(""))
        ),
        "Bash" => {
            if result.trim().is_empty() {
                "done".into()
            } else {
                format!("{} lines", line_count(result))
            }
        }
        "Task" | "Agent" => {
            let first = result
                .lines()
                .next()
                .unwrap_or("")
                .chars()
                .take(80)
                .collect::<String>();
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

// ---------- interactive commands (specs/interactive-commands.md) ----------
//
// Grammar, intercept set, and help entries mirror contract/interactive-commands.ts
// (parseCommand / INTERCEPTED_COMMANDS / HELP_ENTRIES) exactly; the parse rules
// mirror spec §5 (probed against claude 2.1.217, 2026-07-22).

/// FR-2 intercept set — mirrors INTERCEPTED_COMMANDS. These never spawn a turn.
const INTERCEPTED_COMMANDS: [&str; 5] = ["usage", "cost", "model", "status", "help"];

/// /help card contents — mirrors HELP_ENTRIES (FR-15), in display order.
fn help_entries() -> Vec<HelpEntry> {
    vec![
        HelpEntry {
            command: "usage",
            description: "plan usage limits (session + weekly)",
        },
        HelpEntry {
            command: "cost",
            description: "alias of /usage",
        },
        HelpEntry {
            command: "context",
            description: "context window breakdown (runs on the session thread)",
        },
        HelpEntry {
            command: "model",
            description: "show or switch the session model",
        },
        HelpEntry {
            command: "status",
            description: "session snapshot (cwd, model, runtime, context)",
        },
        HelpEntry {
            command: "help",
            description: "this list",
        },
    ]
}

/// FR-1 grammar — mirrors parseCommand: the trimmed text is a command iff it is a
/// single line matching `^/([A-Za-z][A-Za-z0-9_-]*)(\s+\S.*)?$`. Returns
/// (token lowercased, arg trimmed). None → normal passthrough turn.
fn parse_command(text: &str) -> Option<(String, Option<String>)> {
    let t = text.trim();
    if t.contains('\n') {
        return None;
    }
    let rest = t.strip_prefix('/')?;
    let bytes = rest.as_bytes();
    if bytes.is_empty() || !bytes[0].is_ascii_alphabetic() {
        return None;
    }
    let mut end = 1;
    while end < bytes.len()
        && (bytes[end].is_ascii_alphanumeric() || bytes[end] == b'_' || bytes[end] == b'-')
    {
        end += 1;
    }
    let token = rest[..end].to_lowercase();
    let after = &rest[end..];
    if after.is_empty() {
        return Some((token, None));
    }
    // the char right after the token must be whitespace (`\s+\S.*`), else no match
    if !after.chars().next().is_some_and(|c| c.is_whitespace()) {
        return None;
    }
    let arg = after.trim();
    if arg.is_empty() {
        return None; // unreachable for trimmed input; defensive
    }
    Some((token, Some(arg.to_string())))
}

/// FR-2: parse + filter to the intercept set. None → normal passthrough turn.
fn intercepted_command(text: &str) -> Option<(String, Option<String>)> {
    parse_command(text).filter(|(c, _)| INTERCEPTED_COMMANDS.contains(&c.as_str()))
}

/// FR-9: parse a /usage//cost answer. ≥1 meter → usage card (meters + tail: the
/// non-meter lines, blank runs collapsed to one, trimmed); else a raw text card.
fn usage_card(command: &str, answer: &str) -> CommandCard {
    let mut meters: Vec<UsageMeter> = Vec::new();
    let mut tail_lines: Vec<&str> = Vec::new();
    for line in answer.lines() {
        match parse_meter_line(line) {
            Some(m) => meters.push(m),
            None => tail_lines.push(line),
        }
    }
    if meters.is_empty() {
        // format drifted — never an error, just the raw answer (FR-9, §7)
        return CommandCard::Text {
            command: command.to_string(),
            text: answer.to_string(),
        };
    }
    let mut collapsed: Vec<&str> = Vec::new();
    for l in tail_lines {
        if l.trim().is_empty()
            && collapsed
                .last()
                .map(|p| p.trim().is_empty())
                .unwrap_or(true)
        {
            continue; // collapse blank-line runs (and drop leading blanks)
        }
        collapsed.push(l);
    }
    let tail = collapsed.join("\n").trim().to_string();
    CommandCard::Usage {
        command: command.to_string(),
        meters,
        tail,
    }
}

/// FR-19: first match of `\*\*Tokens:\*\*\s*(\S+)\s*/\s*(\S+)\s*\((\d+)%\)` →
/// (usedLabel, limitLabel, percentUsed). None on drift → body-only context card.
fn parse_context_tokens(text: &str) -> Option<(String, String, u64)> {
    let mut search = text;
    while let Some(pos) = search.find("**Tokens:**") {
        let after = &search[pos + 11..];
        if let Some(hit) = parse_context_tokens_tail(after) {
            return Some(hit);
        }
        search = after;
    }
    None
}

fn parse_context_tokens_tail(after: &str) -> Option<(String, String, u64)> {
    let s = after.trim_start();
    let slash = s.find('/')?;
    let used = s[..slash].trim_end();
    if used.is_empty() || used.chars().any(|c| c.is_whitespace()) {
        return None;
    }
    let rest = s[slash + 1..].trim_start();
    let paren = rest.find('(')?;
    let limit = rest[..paren].trim_end();
    if limit.is_empty() || limit.chars().any(|c| c.is_whitespace()) {
        return None;
    }
    let tail = &rest[paren + 1..];
    let digits_end = tail
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(tail.len());
    if digits_end == 0 || !tail[digits_end..].starts_with("%)") {
        return None;
    }
    Some((
        used.to_string(),
        limit.to_string(),
        tail[..digits_end].parse().ok()?,
    ))
}

/// FR-19 body normalization: remove `**` bold markers; strip leading `#`-runs
/// (plus one space) from heading lines; table pipes kept verbatim.
fn normalize_context_body(text: &str) -> String {
    text.lines()
        .map(|line| {
            let line = line.replace("**", "");
            if let Some(stripped) = line.strip_prefix('#') {
                let rest = stripped.trim_start_matches('#');
                rest.strip_prefix(' ').unwrap_or(rest).to_string()
            } else {
                line
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// FR-19: build the /context card from the synthetic answer.
fn context_card(answer: &str) -> CommandCard {
    let body = normalize_context_body(answer);
    match parse_context_tokens(answer) {
        Some((used, limit, pct)) => CommandCard::Context {
            percent_used: Some(pct),
            used_label: Some(used),
            limit_label: Some(limit),
            body,
        },
        None => CommandCard::Context {
            percent_used: None,
            used_label: None,
            limit_label: None,
            body,
        },
    }
}

// `synthetic_text` (FR-16 detection) and `probe_answer` (FR-8 answer extraction)
// moved to usage.rs and are imported above — same functions, same behavior.

/// FR-9/10 probe verdict (pure; unit-tested). A fully-parsed answer always wins —
/// even when the 30s watchdog fired while the final bytes were being read — so
/// `timed_out` is consulted only in the no-parsed-answer arm.
fn probe_card(command: &str, lines: &[String], timed_out: bool) -> CommandCard {
    match probe_answer(lines) {
        Some(answer) if !answer.is_empty() => usage_card(command, &answer),
        _ if timed_out => CommandCard::Notice { text: "couldn't fetch usage \u{2014} timed out".into() },
        _ => CommandCard::Notice {
            text: "couldn't fetch usage \u{2014} the Claude Code CLI returned no answer. Run `claude` once in a terminal to authenticate.".into(),
        },
    }
}

/// FR-17: classify a CLI-local answer into a card, in order: (a) context turn →
/// context card; (b) unknown/unavailable → notice verbatim; (c) text card.
fn classify_local_answer(turn_command: Option<&str>, answer: &str) -> CommandCard {
    if turn_command == Some("context") {
        return context_card(answer);
    }
    if answer.starts_with("Unknown command: ")
        || answer.contains("isn't available in this environment")
    {
        return CommandCard::Notice {
            text: answer.to_string(),
        };
    }
    CommandCard::Text {
        command: turn_command.unwrap_or("").to_string(),
        text: answer.to_string(),
    }
}

/// FR-18 predicate: fire the defensive fallback? (turn succeeded, no synthetic
/// message seen, zero assistant/tool blocks, non-empty result string).
fn command_fallback_fires(
    success: bool,
    saw_synthetic: bool,
    saw_blocks: bool,
    result_text: Option<&str>,
) -> bool {
    success && !saw_synthetic && !saw_blocks && result_text.map(|r| !r.is_empty()).unwrap_or(false)
}

/// FR-13: resolve a /model argument against the catalog — exact id match first,
/// else case-insensitive label match.
fn resolve_model_arg<'a>(models: &'a [ModelInfo], arg: &str) -> Option<&'a ModelInfo> {
    models
        .iter()
        .find(|m| m.id == arg)
        .or_else(|| models.iter().find(|m| m.label.eq_ignore_ascii_case(arg)))
}

/// FR-12: the current catalog snapshot for the /model card — same source as
/// francois:session:models (the warmed cache). FR-12/13 require instant: a cold
/// cache serves the tier-alias fallback immediately and kicks a background
/// refresh — never a synchronous fetch on the intercepted-send path.
fn model_catalog_snapshot() -> Vec<ModelInfo> {
    let cached = model_cache().lock().unwrap().clone();
    let (models, needs_refresh) = snapshot_from_cache(cached);
    if needs_refresh {
        std::thread::spawn(|| {
            refresh_models();
        });
    }
    models
}

/// Pure snapshot decision (unit-tested): a warm cache is served as-is; a cold
/// cache yields the tier-alias catalog plus a background-refresh request.
fn snapshot_from_cache(cached: Vec<ModelInfo>) -> (Vec<ModelInfo>, bool) {
    if cached.is_empty() {
        (catalog(), true)
    } else {
        (cached, false)
    }
}

/// Upsert + persist a finalized command block and emit its command.output
/// (FR-9/10/12–18, FR-24). No-op if the session is gone (session-engine FR-14).
fn finalize_command_block(
    app: &AppHandle,
    session_id: &str,
    block_id: &str,
    command: &str,
    card: &CommandCard,
) {
    let card_json = serde_json::to_value(card).unwrap_or(Value::Null);
    let engine = app.state::<Engine>();
    let block = {
        let mut map = engine.sessions.lock().unwrap();
        let Some(s) = map.get_mut(session_id) else {
            return;
        };
        s.buf_command_output(block_id, command, card_json.clone());
        s.last_activity_at = now_ms();
        s.block_buffer
            .iter()
            .find(|b| b.block_id == block_id)
            .cloned()
    };
    if let Some(b) = &block {
        append_transcript(app, session_id, b);
    }
    emit(
        app,
        SessionEvent::CommandOutput {
            session_id: session_id.into(),
            block_id: block_id.into(),
            card: card_json,
        },
    );
}

/// Per-command flow for an intercepted command (FR-5..FR-15). The user block is
/// already buffered and message.user emitted (FR-4).
fn run_intercepted_command(app: &AppHandle, session_id: &str, command: &str, arg: Option<&str>) {
    match command {
        // FR-5: a present arg is ignored for usage/cost/status/help.
        "usage" | "cost" => start_usage_probe(app, session_id, command),
        "model" => run_model_command(app, session_id, arg),
        "status" => {
            // FR-14: instant snapshot card
            let meta = {
                let engine = app.state::<Engine>();
                let map = engine.sessions.lock().unwrap();
                map.get(session_id).map(|s| s.meta())
            };
            if let Some(meta) = meta {
                finalize_command_block(
                    app,
                    session_id,
                    &uuid(),
                    "status",
                    &CommandCard::Status { meta },
                );
            }
        }
        "help" => {
            finalize_command_block(
                app,
                session_id,
                &uuid(),
                "help",
                &CommandCard::Help {
                    entries: help_entries(),
                },
            );
        }
        _ => {}
    }
}

/// /model — bare: catalog card (FR-12); with an argument: resolve + switch or an
/// unknown-model notice (FR-13). Instant either way; no status change.
fn run_model_command(app: &AppHandle, session_id: &str, arg: Option<&str>) {
    let models = model_catalog_snapshot();
    let Some(arg) = arg else {
        let current_id = {
            let engine = app.state::<Engine>();
            let map = engine.sessions.lock().unwrap();
            let Some(s) = map.get(session_id) else { return };
            s.model_id.clone()
        };
        finalize_command_block(
            app,
            session_id,
            &uuid(),
            "model",
            &CommandCard::Model { models, current_id },
        );
        return;
    };
    match resolve_model_arg(&models, arg) {
        Some(m) => {
            let (id, label) = (m.id.clone(), m.label.clone());
            if apply_model_switch(app, session_id, &id).is_some() {
                finalize_command_block(
                    app,
                    session_id,
                    &uuid(),
                    "model",
                    &CommandCard::Notice {
                        text: format!("model \u{2192} {label}"),
                    },
                );
            }
        }
        None => {
            let ids: Vec<&str> = models.iter().map(|m| m.id.as_str()).collect();
            finalize_command_block(
                app,
                session_id,
                &uuid(),
                "model",
                &CommandCard::Notice {
                    text: format!(
                        "unknown model: {arg} \u{2014} available: {}",
                        ids.join(", ")
                    ),
                },
            );
        }
    }
}

/// FR-6/7/11: begin the /usage//cost detached side-spawn — reserve the single probe
/// slot, emit command.started + a pending block, then probe on a detached thread.
/// Invisible to the turn lifecycle: status, queue, claude_session_id and
/// contextUsedTokens are never touched.
fn start_usage_probe(app: &AppHandle, session_id: &str, command: &str) {
    let engine = app.state::<Engine>();
    let block_id = uuid();
    let (cwd, model_id, runtime, slot) = {
        let mut map = engine.sessions.lock().unwrap();
        let Some(s) = map.get_mut(session_id) else {
            return;
        };
        let Some(slot) = s.reserve_probe(&block_id) else {
            // FR-11: one in-flight probe per session → instant notice on a fresh block.
            drop(map);
            finalize_command_block(
                app,
                session_id,
                &uuid(),
                command,
                &CommandCard::Notice {
                    text: "a usage check is already running".into(),
                },
            );
            return;
        };
        s.buf_command_pending(&block_id, command);
        s.last_activity_at = now_ms();
        (s.cwd.clone(), s.model_id.clone(), s.runtime.clone(), slot)
    };
    emit(
        app,
        SessionEvent::CommandStarted {
            session_id: session_id.into(),
            block_id: block_id.clone(),
            command: command.into(),
        },
    );
    let app = app.clone();
    let sid = session_id.to_string();
    let command = command.to_string();
    std::thread::spawn(move || {
        run_probe(app, sid, block_id, command, cwd, model_id, runtime, slot)
    });
}

/// FR-7/8/9/10: the detached probe body. Same invocation machinery as turns
/// (session runtime incl. WSL + session cwd); NO --resume, no permission flags.
#[allow(clippy::too_many_arguments)]
fn run_probe(
    app: AppHandle,
    session_id: String,
    block_id: String,
    command: String,
    cwd: String,
    model_id: String,
    runtime: String,
    slot: Arc<Mutex<Option<Child>>>,
) {
    let args: Vec<String> = vec![
        "-p".into(),
        format!("/{command}"),
        "--output-format".into(),
        "stream-json".into(),
        "--verbose".into(),
        "--model".into(),
        model_id,
    ];
    let (program, argv) = claude_invocation(&runtime, &cwd, args);
    let mut cmd = Command::new(program);
    cmd.args(argv);
    if runtime != "wsl" {
        cmd.current_dir(&cwd); // wsl probes get their cwd via `--cd` inside the distro
    }
    no_window(&mut cmd);
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(_) => {
            // FR-10 with session-engine FR-45's actionable wording where determinable.
            let text = if runtime == "wsl" {
                "couldn't fetch usage \u{2014} WSL not found. Install it (wsl --install) or use the native runtime."
            } else {
                "couldn't fetch usage \u{2014} Claude Code CLI not found. Install it and ensure `claude` is on PATH."
            };
            finish_probe(
                &app,
                &session_id,
                &block_id,
                &command,
                CommandCard::Notice { text: text.into() },
            );
            return;
        }
    };
    let stdout = child.stdout.take();
    *slot.lock().unwrap() = Some(child);

    // If the session was removed between reserve and spawn, its remove-path kill
    // found an empty slot — kill the child ourselves and vanish (§7, FR-14).
    let still_wanted = {
        let engine = app.state::<Engine>();
        let map = engine.sessions.lock().unwrap();
        map.get(&session_id)
            .and_then(|s| s.pending_probe.as_ref())
            .map(|p| p.block_id == block_id)
            .unwrap_or(false)
    };
    if !still_wanted {
        if let Some(mut c) = slot.lock().unwrap().take() {
            let _ = c.kill();
            let _ = c.wait();
        }
        return;
    }

    // FR-10: 30s watchdog → kill. `done` stops the watchdog after a normal finish.
    let done = Arc::new(AtomicBool::new(false));
    let timed_out = Arc::new(AtomicBool::new(false));
    {
        let (slot, done, timed_out) = (slot.clone(), done.clone(), timed_out.clone());
        std::thread::spawn(move || {
            for _ in 0..(PROBE_TIMEOUT_SECS * 10) {
                std::thread::sleep(std::time::Duration::from_millis(100));
                if done.load(Ordering::SeqCst) {
                    return;
                }
            }
            timed_out.store(true, Ordering::SeqCst);
            if let Some(c) = slot.lock().unwrap().as_mut() {
                let _ = c.kill();
            }
        });
    }

    let mut lines: Vec<String> = Vec::new();
    if let Some(out) = stdout {
        for line in BufReader::new(out).lines() {
            match line {
                Ok(l) => lines.push(l),
                Err(_) => break,
            }
        }
    }
    if let Some(mut c) = slot.lock().unwrap().take() {
        let _ = c.wait();
    }
    done.store(true, Ordering::SeqCst);

    // Remediation R1: prefer a fully-parsed answer over the timeout notice —
    // an answer read just before the 30s kill must not be discarded (probe_card).
    let card = probe_card(&command, &lines, timed_out.load(Ordering::SeqCst));
    finish_probe(&app, &session_id, &block_id, &command, card);
}

/// Release the probe slot and finalize its pending block (FR-9/10 — a pending
/// command block is never left open). If the session was removed mid-probe,
/// nothing is emitted (session-engine FR-14).
fn finish_probe(
    app: &AppHandle,
    session_id: &str,
    block_id: &str,
    command: &str,
    card: CommandCard,
) {
    {
        let engine = app.state::<Engine>();
        let mut map = engine.sessions.lock().unwrap();
        let Some(s) = map.get_mut(session_id) else {
            return;
        };
        match &s.pending_probe {
            Some(p) if p.block_id == block_id => s.pending_probe = None,
            _ => return, // superseded or cancelled — never finalize another probe's block
        }
    }
    finalize_command_block(app, session_id, block_id, command, &card);
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
            text: String::new(),
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
    }

    #[test]
    fn permission_args_only_for_explicit_modes() {
        assert!(permission_args("default").is_empty()); // inherit ~/.claude settings — no flag
        assert!(permission_args("garbage").is_empty());
        assert_eq!(permission_args("plan"), vec!["--permission-mode", "plan"]);
        assert_eq!(
            permission_args("acceptEdits"),
            vec!["--permission-mode", "acceptEdits"]
        );
        assert_eq!(
            permission_args("bypassPermissions"),
            vec!["--permission-mode", "bypassPermissions"]
        );
    }

    #[test]
    fn claude_invocation_wraps_wsl() {
        let (prog, args) = claude_invocation("native", "D:\\repo", vec!["-p".into(), "hi".into()]);
        assert_eq!(prog, "claude");
        assert_eq!(args, vec!["-p", "hi"]);
        // wsl + drive cwd: wsl.exe maps it to /mnt/… itself — passed verbatim
        let (prog, args) = claude_invocation("wsl", "D:\\repo", vec!["--version".into()]);
        assert_eq!(prog, "wsl.exe");
        assert_eq!(args, vec!["--cd", "D:\\repo", "--", "claude", "--version"]);
        // wsl + WSL UNC cwd: MUST pre-translate (`--cd \\wsl…` = Wsl/E_INVALIDARG live)
        let (prog, args) = claude_invocation(
            "wsl",
            "\\\\wsl.localhost\\Ubuntu\\home\\u\\api",
            vec!["-p".into(), "hi".into()],
        );
        assert_eq!(prog, "wsl.exe");
        assert_eq!(
            args,
            vec!["--cd", "/home/u/api", "--", "claude", "-p", "hi"]
        );
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
        assert_eq!(
            tool_meta("Write", &json!({ "content": "a\nb" }), ""),
            "2 lines"
        );
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
        let u =
            json!({ "input_tokens": 10, "cache_read_input_tokens": 21213, "output_tokens": 47 });
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
                ModelInfo {
                    id: "claude-opus-4-8".into(),
                    label: "Opus 4.8".into(),
                    brief: None,
                    context_tokens: Some(1_000_000),
                    efforts: vec![],
                },
                ModelInfo {
                    id: "claude-opus-4-5-20251101".into(),
                    label: "Opus 4.5".into(),
                    brief: None,
                    context_tokens: Some(200_000),
                    efforts: vec![],
                },
                ModelInfo {
                    id: "claude-haiku-4-5".into(),
                    label: "Haiku 4.5".into(),
                    brief: None,
                    context_tokens: Some(200_000),
                    efforts: vec![],
                },
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

    // ---------- interactive-commands (specs/interactive-commands.md) ----------

    fn test_session() -> Session {
        Session {
            id: "s1".into(),
            name: "n".into(),
            cwd: "/x".into(),
            model_id: "sonnet".into(),
            status: "idle".into(),
            context_used_tokens: 0,
            context_limit_tokens: 200_000,
            started_at: 0,
            last_activity_at: 0,
            error_message: None,
            effort: None,
            permission_mode: "default".into(),
            runtime: "native".into(),
            queue: VecDeque::new(),
            claude_session_id: None,
            current: None,
            pending_probe: None,
            agents: HashMap::new(),
            agent_order: Vec::new(),
            block_buffer: Vec::new(),
            mcp: HashMap::new(),
            cli_commands: Vec::new(),
        }
    }

    #[test]
    fn command_grammar_parses_and_lowercases() {
        // FR-1: single-line `/token [arg]`, token lowercased, arg trimmed
        assert_eq!(parse_command("/usage"), Some(("usage".into(), None)));
        assert_eq!(parse_command("  /USAGE  "), Some(("usage".into(), None)));
        assert_eq!(
            parse_command("/model opus"),
            Some(("model".into(), Some("opus".into())))
        );
        // arg keeps its case and interior spacing; ends trimmed
        assert_eq!(
            parse_command("/model  Opus 4.5 "),
            Some(("model".into(), Some("Opus 4.5".into())))
        );
        assert_eq!(
            parse_command("/spec-x_2 arg"),
            Some(("spec-x_2".into(), Some("arg".into())))
        );
    }

    #[test]
    fn command_grammar_rejects_non_commands() {
        assert_eq!(parse_command("hello"), None);
        assert_eq!(parse_command("/"), None);
        assert_eq!(parse_command("/9lives"), None); // token must start with a letter
        assert_eq!(parse_command("/foo!bar"), None); // arg must be whitespace-separated
        assert_eq!(parse_command("/usage\nmore"), None); // multiline is never a command (FR-1)
        assert_eq!(parse_command("  /usage\nmore  "), None);
    }

    #[test]
    fn intercept_set_matches_contract() {
        // FR-2: exactly usage/cost/model/status/help are intercepted
        for c in [
            "/usage",
            "/cost",
            "/model",
            "/status",
            "/help",
            "/USAGE",
            "/usage extra words",
        ] {
            assert!(
                intercepted_command(c).is_some(),
                "{c} should be intercepted"
            );
        }
        // passthrough: /context, /compact, custom skills, unknowns, multiline, plain text
        for c in [
            "/context",
            "/compact",
            "/spec something",
            "/frobnicate",
            "/usage\nx",
            "usage",
        ] {
            assert!(intercepted_command(c).is_none(), "{c} must pass through");
        }
    }

    // The meter-grammar tests (`meter_line_*`), the answer-extraction tests
    // (`probe_answer_*`) and `synthetic_detection_requires_synthetic_model` moved
    // to usage.rs with their functions (usage-bar §6) — unchanged.

    #[test]
    fn usage_card_parses_meters_and_tail() {
        let answer = "Current session: 14% used \u{b7} resets Jul 22, 5:29pm (Europe/Paris)\nCurrent week (all models): 34% used \u{b7} resets Jul 25, 11:00am (Europe/Paris)\n\n\nWhat's contributing:\n\u{2022} lots of turns";
        let CommandCard::Usage {
            command,
            meters,
            tail,
        } = usage_card("usage", answer)
        else {
            panic!("expected a usage card");
        };
        assert_eq!(command, "usage");
        assert_eq!(meters.len(), 2);
        assert_eq!(meters[1].label, "Current week (all models)");
        // tail = answer minus meter lines, blank runs collapsed, trimmed (§5)
        assert_eq!(tail, "What's contributing:\n\u{2022} lots of turns");
    }

    #[test]
    fn usage_tail_collapses_blank_runs() {
        let answer = "Current session: 1% used \u{b7} resets soon\ntop\n\n\n\nbottom";
        let CommandCard::Usage { tail, .. } = usage_card("cost", answer) else {
            panic!("expected a usage card");
        };
        assert_eq!(tail, "top\n\nbottom");
    }

    #[test]
    fn usage_card_drift_falls_back_to_text() {
        // FR-9: no meter matches → raw text card, never an error
        let CommandCard::Text { command, text } = usage_card("usage", "totally new format") else {
            panic!("expected a text card");
        };
        assert_eq!(command, "usage");
        assert_eq!(text, "totally new format");
    }

    #[test]
    fn context_tokens_parses_and_drifts() {
        assert_eq!(
            parse_context_tokens("## Context\n**Tokens:** 26.4k / 200k (13%)\nmore"),
            Some(("26.4k".into(), "200k".into(), 13))
        );
        assert_eq!(
            parse_context_tokens("**Tokens:** 26.4k/200k (13%)"),
            Some(("26.4k".into(), "200k".into(), 13))
        );
        // drift → None (FR-19 body-only fallback)
        assert!(parse_context_tokens("Tokens: 26.4k / 200k (13%)").is_none());
        assert!(parse_context_tokens("**Tokens:** 26.4k of 200k (13%)").is_none());
        assert!(parse_context_tokens("").is_none());
    }

    #[test]
    fn context_card_normalizes_body() {
        let answer = "## Context Usage\n**Tokens:** 26.4k / 200k (13%)\n| Category | Tokens |\n|---|---|\n**System prompt** stays";
        let CommandCard::Context {
            percent_used,
            used_label,
            limit_label,
            body,
        } = context_card(answer)
        else {
            panic!("expected a context card");
        };
        assert_eq!(percent_used, Some(13));
        assert_eq!(used_label.as_deref(), Some("26.4k"));
        assert_eq!(limit_label.as_deref(), Some("200k"));
        // `**` removed, heading '#'-run + one space stripped, table pipes verbatim (FR-19)
        assert_eq!(body, "Context Usage\nTokens: 26.4k / 200k (13%)\n| Category | Tokens |\n|---|---|\nSystem prompt stays");
    }

    #[test]
    fn context_card_without_tokens_line_is_body_only() {
        let CommandCard::Context {
            percent_used,
            used_label,
            limit_label,
            body,
        } = context_card("just text")
        else {
            panic!("expected a context card");
        };
        assert!(percent_used.is_none() && used_label.is_none() && limit_label.is_none());
        assert_eq!(body, "just text");
    }

    fn ndjson(lines: &[Value]) -> Vec<String> {
        lines
            .iter()
            .map(|v| serde_json::to_string(v).unwrap())
            .collect()
    }

    #[test]
    fn skill_sends_are_never_intercepted() {
        // Remediation R1 / spec §2 non-goal: a skill named like an intercepted
        // command passes through byte-for-byte; typed input keeps intercepting.
        for t in ["/usage", "/cost", "/model opus", "/status", "/help"] {
            assert!(
                send_intercept(t, SendSource::Skill).is_none(),
                "{t} from skills_run must pass through"
            );
            assert!(
                send_intercept(t, SendSource::Typed).is_some(),
                "{t} typed must intercept"
            );
        }
        // non-intercepted text is passthrough from both sources
        assert!(send_intercept("/spec something", SendSource::Typed).is_none());
        assert!(send_intercept("/spec something", SendSource::Skill).is_none());
    }

    #[test]
    fn model_snapshot_cold_cache_serves_catalog_instantly() {
        // Remediation R1 / FR-12-13: cold cache → tier-alias fallback served
        // immediately (background refresh requested), never a synchronous fetch.
        let (models, needs_refresh) = snapshot_from_cache(Vec::new());
        assert!(needs_refresh);
        assert_eq!(
            models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            ["sonnet", "opus", "haiku"]
        );
        // warm cache is served as-is, no refresh kicked
        let (models, needs_refresh) =
            snapshot_from_cache(vec![model("claude-opus-4-8", "Opus 4.8")]);
        assert!(!needs_refresh);
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "claude-opus-4-8");
    }

    #[test]
    fn probe_card_prefers_parsed_answer_over_timeout() {
        // Remediation R1 / FR-10 watchdog-finish race: an answer fully read just
        // before the 30s kill wins; timed_out only matters with no parsed answer.
        let lines = ndjson(&[
            json!({ "type": "assistant", "message": { "model": "<synthetic>",
            "content": [{ "type": "text", "text": "Current session: 14% used \u{b7} resets soon" }] } }),
        ]);
        assert!(matches!(
            probe_card("usage", &lines, true),
            CommandCard::Usage { .. }
        ));
        assert!(matches!(
            probe_card("usage", &lines, false),
            CommandCard::Usage { .. }
        ));
        // no parsed answer + timed out → timeout notice
        let CommandCard::Notice { text } = probe_card("usage", &[], true) else {
            panic!("expected a notice")
        };
        assert!(text.contains("timed out"));
        // no parsed answer, no timeout → no-answer notice
        let CommandCard::Notice { text } = probe_card("usage", &[], false) else {
            panic!("expected a notice")
        };
        assert!(text.contains("no answer"));
    }

    #[test]
    fn classify_local_answer_follows_fr17_order() {
        // (a) context turn → context card
        assert!(matches!(
            classify_local_answer(Some("context"), "**Tokens:** 1k / 2k (50%)"),
            CommandCard::Context { .. }
        ));
        // (b) unknown / unavailable → notice, verbatim
        let CommandCard::Notice { text } =
            classify_local_answer(Some("frobnicate"), "Unknown command: /frobnicate")
        else {
            panic!("expected a notice card");
        };
        assert_eq!(text, "Unknown command: /frobnicate");
        assert!(matches!(
            classify_local_answer(
                Some("status"),
                "/status isn't available in this environment."
            ),
            CommandCard::Notice { .. }
        ));
        // (c) otherwise → text card with the turn's command token (or '')
        let CommandCard::Text { command, text } =
            classify_local_answer(Some("foo"), "some local output")
        else {
            panic!("expected a text card");
        };
        assert_eq!(
            (command.as_str(), text.as_str()),
            ("foo", "some local output")
        );
        let CommandCard::Text { command, .. } = classify_local_answer(None, "output") else {
            panic!("expected a text card");
        };
        assert_eq!(command, "");
    }

    #[test]
    fn fr18_fallback_truth_table() {
        assert!(command_fallback_fires(
            true,
            false,
            false,
            Some("Unknown command: /x")
        ));
        assert!(!command_fallback_fires(false, false, false, Some("x"))); // turn not a success
        assert!(!command_fallback_fires(true, true, false, Some("x"))); // synthetic already carded
        assert!(!command_fallback_fires(true, false, true, Some("x"))); // real blocks streamed
        assert!(!command_fallback_fires(true, false, false, Some(""))); // empty result
        assert!(!command_fallback_fires(true, false, false, None));
    }

    #[test]
    fn command_event_members_serialize_to_contract_shape() {
        let started = serde_json::to_value(SessionEvent::CommandStarted {
            session_id: "s1".into(),
            block_id: "b1".into(),
            command: "usage".into(),
        })
        .unwrap();
        assert_eq!(
            started,
            json!({ "type": "command.started", "sessionId": "s1", "blockId": "b1", "command": "usage" })
        );
        let card = serde_json::to_value(CommandCard::Notice {
            text: "a usage check is already running".into(),
        })
        .unwrap();
        let output = serde_json::to_value(SessionEvent::CommandOutput {
            session_id: "s1".into(),
            block_id: "b2".into(),
            card,
        })
        .unwrap();
        assert_eq!(
            output,
            json!({ "type": "command.output", "sessionId": "s1", "blockId": "b2",
            "card": { "kind": "notice", "text": "a usage check is already running" } })
        );
    }

    #[test]
    fn command_card_kinds_serialize_to_contract_shape() {
        let usage = serde_json::to_value(CommandCard::Usage {
            command: "cost".into(),
            meters: vec![UsageMeter {
                label: "Current session".into(),
                percent_used: 14,
                resets_at: "Jul 22, 5:29pm (Europe/Paris)".into(),
            }],
            tail: "tail".into(),
        })
        .unwrap();
        assert_eq!(
            usage,
            json!({ "kind": "usage", "command": "cost", "tail": "tail",
            "meters": [{ "label": "Current session", "percentUsed": 14, "resetsAt": "Jul 22, 5:29pm (Europe/Paris)" }] })
        );

        // context nulls serialize as JSON null (contract: number | null), never omitted
        let ctx = serde_json::to_value(CommandCard::Context {
            percent_used: None,
            used_label: None,
            limit_label: None,
            body: "b".into(),
        })
        .unwrap();
        assert_eq!(
            ctx,
            json!({ "kind": "context", "percentUsed": null, "usedLabel": null, "limitLabel": null, "body": "b" })
        );

        let model_card = serde_json::to_value(CommandCard::Model {
            models: vec![model("opus", "Opus")],
            current_id: "opus".into(),
        })
        .unwrap();
        assert_eq!(
            model_card,
            json!({ "kind": "model", "currentId": "opus", "models": [{ "id": "opus", "label": "Opus" }] })
        );

        let help = serde_json::to_value(CommandCard::Help {
            entries: help_entries(),
        })
        .unwrap();
        assert_eq!(help["kind"], "help");
        assert_eq!(help["entries"].as_array().unwrap().len(), 6);
        assert_eq!(
            help["entries"][0],
            json!({ "command": "usage", "description": "plan usage limits (session + weekly)" })
        );

        let text = serde_json::to_value(CommandCard::Text {
            command: "".into(),
            text: "raw".into(),
        })
        .unwrap();
        assert_eq!(
            text,
            json!({ "kind": "text", "command": "", "text": "raw" })
        );

        let status = serde_json::to_value(CommandCard::Status {
            meta: test_session().meta(),
        })
        .unwrap();
        assert_eq!(status["kind"], "status");
        assert_eq!(status["meta"]["permissionMode"], "default");
        assert_eq!(status["meta"]["contextLimitTokens"], 200_000);
    }

    #[test]
    fn classify_block_maps_pending_and_finalized_command() {
        let mut s = test_session();
        s.buf_command_pending("c1", "usage");
        let pending = classify_block(&s.block_buffer[0]);
        assert_eq!(
            pending,
            json!({ "kind": "command", "blockId": "c1", "isStreaming": true, "command": "usage" })
        );

        s.buf_command_output("c1", "usage", json!({ "kind": "notice", "text": "n" }));
        assert_eq!(s.block_buffer.len(), 1); // upsert, not append (FR-20 semantics)
        let done = classify_block(&s.block_buffer[0]);
        assert_eq!(
            done,
            json!({ "kind": "command", "blockId": "c1", "isStreaming": false, "command": "usage",
            "card": { "kind": "notice", "text": "n" } })
        );
    }

    #[test]
    fn command_output_without_started_inserts_block() {
        // the FR-11/FR-13 instant-notice cases arrive without a command.started
        let mut s = test_session();
        s.buf_command_output(
            "c9",
            "model",
            json!({ "kind": "notice", "text": "model \u{2192} Opus" }),
        );
        assert_eq!(s.block_buffer.len(), 1);
        assert!(!s.block_buffer[0].streaming);
        assert_eq!(s.block_buffer[0].tool, "model");
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
    fn probe_guard_is_single_flight_per_session() {
        let mut s = test_session();
        assert!(s.reserve_probe("b1").is_some());
        assert!(s.reserve_probe("b2").is_none()); // FR-11: at most one in-flight probe
        s.pending_probe = None; // probe finalized
        assert!(s.reserve_probe("b3").is_some());
    }

    #[test]
    fn model_arg_resolution_id_then_label_case_insensitive() {
        let models = vec![
            model("claude-opus-4-8", "Opus 4.8"),
            model("sonnet", "Sonnet"),
        ];
        // exact id
        assert_eq!(
            resolve_model_arg(&models, "claude-opus-4-8").unwrap().label,
            "Opus 4.8"
        );
        // label, case-insensitive (FR-13)
        assert_eq!(
            resolve_model_arg(&models, "opus 4.8").unwrap().id,
            "claude-opus-4-8"
        );
        assert_eq!(resolve_model_arg(&models, "SONNET").unwrap().id, "sonnet");
        // id match wins over a label collision
        let tricky = vec![model("sonnet", "Opus"), model("opus", "Opus")];
        assert_eq!(resolve_model_arg(&tricky, "opus").unwrap().id, "opus");
        // unknown
        assert!(resolve_model_arg(&models, "gpt-5").is_none());
    }

    // ---------- session-questions (specs/session-questions.md) ----------

    #[test]
    fn turn_args_enable_stdio_control_channel_without_positional_prompt() {
        // FR-1: -p with NO positional prompt, plus the two new flags; every
        // pre-existing flag intact; permission-mode/effort/resume still appended.
        let args = turn_args("sonnet", Some("thread-1"), Some("high"), "plan");
        assert_eq!(args[0], "-p");
        assert!(
            args[1].starts_with("--"),
            "no positional prompt after -p: {args:?}"
        );
        let has_pair = |a: &str, b: &str| args.windows(2).any(|w| w[0] == a && w[1] == b);
        assert!(has_pair("--output-format", "stream-json"));
        assert!(has_pair("--input-format", "stream-json"));
        assert!(has_pair("--permission-prompt-tool", "stdio"));
        assert!(args.iter().any(|a| a == "--include-partial-messages"));
        assert!(args.iter().any(|a| a == "--verbose"));
        assert!(has_pair("--model", "sonnet"));
        assert!(has_pair("--permission-mode", "plan"));
        assert!(has_pair("--effort", "high"));
        assert!(has_pair("--resume", "thread-1"));
    }

    #[test]
    fn user_line_matches_wire_shape() {
        // §5.5: the turn text rides stdin as ONE NDJSON user line.
        let line = user_line("fix the bug");
        assert!(line.ends_with('\n'));
        let v: Value = serde_json::from_str(line.trim_end()).unwrap();
        assert_eq!(
            v,
            json!({ "type": "user", "message": { "role": "user",
                "content": [{ "type": "text", "text": "fix the bug" }] } })
        );
    }

    /// The §5.5 question-arrival fixture, verbatim.
    fn ask_fixture() -> Value {
        json!({
            "type": "control_request",
            "request_id": "req-1",
            "request": {
                "subtype": "can_use_tool",
                "tool_name": "AskUserQuestion",
                "display_name": "AskUserQuestion",
                "input": { "questions": [{
                    "question": "Which color do you prefer?",
                    "header": "Color",
                    "options": [
                        { "label": "Red", "description": "The color red" },
                        { "label": "Blue", "description": "The color blue" }
                    ],
                    "multiSelect": false
                }] },
                "tool_use_id": "toolu_1"
            }
        })
    }

    #[test]
    fn control_request_ask_user_question_parks_with_verbatim_questions() {
        // FR-6/FR-7: AskUserQuestion parks — request_id + verbatim input kept for
        // the eventual allow response, questions parsed verbatim for the card.
        let ControlDecision::Ask {
            request_id,
            input,
            questions,
        } = decide_control_request(&ask_fixture())
        else {
            panic!("expected Ask");
        };
        assert_eq!(request_id, "req-1");
        assert_eq!(input, ask_fixture()["request"]["input"]); // verbatim (FR-11)
        assert_eq!(questions.len(), 1);
        assert_eq!(questions[0].question, "Which color do you prefer?");
        assert_eq!(questions[0].header, "Color");
        assert!(!questions[0].multi_select);
        assert_eq!(questions[0].options[1].label, "Blue");
        assert_eq!(questions[0].options[1].description, "The color blue");
        assert_eq!(questions[0].options[1].preview, None);
    }

    #[test]
    fn control_request_parsing_is_lenient_on_optional_fields() {
        // FR-7: multiSelect defaults to false when absent; preview passes through.
        let v = json!({ "type": "control_request", "request_id": "r", "request": {
            "subtype": "can_use_tool", "tool_name": "AskUserQuestion",
            "input": { "questions": [{ "question": "Q", "header": "H",
                "options": [{ "label": "A", "description": "d", "preview": "p" }] }] } } });
        let ControlDecision::Ask { questions, .. } = decide_control_request(&v) else {
            panic!("expected Ask");
        };
        assert!(!questions[0].multi_select);
        assert_eq!(questions[0].options[0].preview.as_deref(), Some("p"));
    }

    #[test]
    fn control_request_other_tool_denies_instantly() {
        // FR-8: any other tool → deny control_response, §5.5 shape, exact message.
        let v = json!({ "type": "control_request", "request_id": "req-9", "request": {
            "subtype": "can_use_tool", "tool_name": "Bash", "input": { "command": "rm -rf /" } } });
        let ControlDecision::Respond(payload) = decide_control_request(&v) else {
            panic!("expected Respond");
        };
        assert_eq!(
            payload,
            json!({ "type": "control_response", "response": {
                "subtype": "success", "request_id": "req-9", "response": { "behavior": "deny",
                "message": "Francois declined: interactive permission prompts are not supported yet — adjust the session's permission mode." } } })
        );
    }

    #[test]
    fn control_request_unknown_subtype_gets_error_response() {
        // FR-9: never let the CLI park on something we don't render.
        let v = json!({ "type": "control_request", "request_id": "req-2",
            "request": { "subtype": "hook_callback" } });
        let ControlDecision::Respond(payload) = decide_control_request(&v) else {
            panic!("expected Respond");
        };
        assert_eq!(
            payload,
            json!({ "type": "control_response", "response": {
                "subtype": "error", "request_id": "req-2", "error": "unsupported control request" } })
        );
    }

    #[test]
    fn control_request_malformed_questions_denies() {
        // FR-7: an input with no non-empty questions array is auto-denied, no card.
        for input in [
            json!({}),
            json!({ "questions": [] }),
            json!({ "questions": "x" }),
        ] {
            let v = json!({ "type": "control_request", "request_id": "r", "request": {
                "subtype": "can_use_tool", "tool_name": "AskUserQuestion", "input": input } });
            let ControlDecision::Respond(payload) = decide_control_request(&v) else {
                panic!("expected Respond");
            };
            assert_eq!(payload["response"]["response"]["behavior"], "deny");
            assert_eq!(
                payload["response"]["response"]["message"],
                "malformed AskUserQuestion input"
            );
        }
    }

    #[test]
    fn allow_response_merges_verbatim_input_with_answers() {
        // FR-11/FR-12 + §5.5: updatedInput = verbatim original input + answers map.
        let input = ask_fixture()["request"]["input"].clone();
        let answers = json!({ "Which color do you prefer?": "Blue" });
        let payload = allow_response("req-1", &input, &answers);
        let mut expected_input = input.clone();
        expected_input["answers"] = answers.clone();
        assert_eq!(
            payload,
            json!({ "type": "control_response", "response": {
                "subtype": "success", "request_id": "req-1",
                "response": { "behavior": "allow", "updatedInput": expected_input } } })
        );
    }

    #[test]
    fn question_event_members_serialize_to_contract_shape() {
        let questions = vec![SessionQuestion {
            question: "Q".into(),
            header: "H".into(),
            options: vec![QuestionOption {
                label: "A".into(),
                description: "d".into(),
                preview: None,
            }],
            multi_select: true,
        }];
        let asked = serde_json::to_value(SessionEvent::QuestionAsked {
            session_id: "s1".into(),
            block_id: "q1".into(),
            questions,
        })
        .unwrap();
        assert_eq!(
            asked,
            json!({ "type": "question.asked", "sessionId": "s1", "blockId": "q1",
                "questions": [{ "question": "Q", "header": "H", "multiSelect": true,
                    "options": [{ "label": "A", "description": "d" }] }] })
        );

        // cancelled: absent answers is OMITTED, never null (§9)
        let cancelled = serde_json::to_value(SessionEvent::QuestionResolved {
            session_id: "s1".into(),
            block_id: "q1".into(),
            state: "cancelled".into(),
            answers: None,
        })
        .unwrap();
        assert_eq!(
            cancelled,
            json!({ "type": "question.resolved", "sessionId": "s1",
                "blockId": "q1", "state": "cancelled" })
        );

        let answered = serde_json::to_value(SessionEvent::QuestionResolved {
            session_id: "s1".into(),
            block_id: "q1".into(),
            state: "answered".into(),
            answers: Some(json!({ "Q": "A" })),
        })
        .unwrap();
        assert_eq!(
            answered,
            json!({ "type": "question.resolved", "sessionId": "s1",
                "blockId": "q1", "state": "answered", "answers": { "Q": "A" } })
        );
    }

    #[test]
    fn question_block_lifecycle_pending_answered() {
        // FR-6/FR-15: pending block streams; resolution updates IN PLACE; the
        // answers key exists only once answered.
        let mut s = test_session();
        let qs = json!([{ "question": "Q", "header": "H", "options": [], "multiSelect": false }]);
        s.buf_question("q1", qs.clone());
        let pending = classify_block(&s.block_buffer[0]);
        assert_eq!(
            pending,
            json!({ "kind": "question", "blockId": "q1", "isStreaming": true,
                "questions": qs, "state": "pending" })
        );

        let answers = json!({ "Q": "A" });
        let resolved = s
            .buf_question_resolve("q1", "answered", Some(&answers))
            .expect("resolve");
        assert_eq!(s.block_buffer.len(), 1); // upsert, not append
        assert!(!resolved.streaming);
        let done = classify_block(&s.block_buffer[0]);
        assert_eq!(
            done,
            json!({ "kind": "question", "blockId": "q1", "isStreaming": false,
                "questions": qs, "state": "answered", "answers": { "Q": "A" } })
        );
        // unknown blockId resolves nothing (FR-13 exactly-once claims handle the rest)
        assert!(s.buf_question_resolve("nope", "cancelled", None).is_none());
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

    // ---------- slash-menu (specs/slash-menu.md) ----------

    #[test]
    fn merge_commands_builtins_first_verbatim() {
        // §9: builtins come from help_entries() verbatim (name + description),
        // source "builtin", no scope — before any turn (no skills, no cli).
        let merged = merge_commands(&help_entries(), &[], &[]);
        let builtins = help_entries();
        assert_eq!(merged.len(), builtins.len());
        for (m, h) in merged.iter().zip(builtins.iter()) {
            assert_eq!(m.name, h.command);
            assert_eq!(m.description, h.description);
            assert_eq!(m.source, "builtin");
            assert_eq!(m.scope, None);
        }
    }

    #[test]
    fn merge_commands_dedup_precedence_and_fr3_order() {
        // FR-1/FR-3: builtin > skill > cli on a name collision; order = builtins
        // (help order), then installed skills (discovery order), then cli (init
        // order); installed:false skills are excluded; cli description is "".
        let skills = vec![
            skill_entry(
                "usage".into(),
                "skill usage".into(),
                true,
                "project",
                "skill",
                None,
            ),
            skill_entry(
                "deploy".into(),
                "ship it".into(),
                true,
                "user",
                "command",
                None,
            ),
            skill_entry(
                "hidden".into(),
                "not enabled".into(),
                false,
                "plugin",
                "skill",
                None,
            ),
        ];
        let cli = vec![
            "usage".to_string(),
            "deploy".to_string(),
            "compact".to_string(),
        ];
        let merged = merge_commands(&help_entries(), &skills, &cli);

        let mut expected: Vec<String> = help_entries()
            .iter()
            .map(|h| h.command.to_string())
            .collect();
        expected.push("deploy".into());
        expected.push("compact".into());
        let names: Vec<String> = merged.iter().map(|c| c.name.clone()).collect();
        assert_eq!(names, expected);

        let usage = merged.iter().find(|c| c.name == "usage").unwrap();
        assert_eq!(usage.source, "builtin"); // edge #4: builtin wins over skill+cli
        let deploy = merged.iter().find(|c| c.name == "deploy").unwrap();
        assert_eq!(deploy.source, "skill"); // skill wins over cli
        assert_eq!(deploy.description, "ship it");
        assert_eq!(deploy.scope.as_deref(), Some("user"));
        let compact = merged.iter().find(|c| c.name == "compact").unwrap();
        assert_eq!(compact.source, "cli");
        assert_eq!(compact.description, ""); // '' when the source provides none
        assert_eq!(compact.scope, None);
        assert!(!merged.iter().any(|c| c.name == "hidden")); // installed:false excluded
    }

    #[test]
    fn init_slash_commands_parse_and_change_detection() {
        // FR-2: absent array → None (no change); present → bare names (a leading
        // '/' is stripped, non-strings skipped — FR-3 stores without the slash).
        let no_arr = json!({ "type": "system", "subtype": "init", "session_id": "abc" });
        assert_eq!(parse_init_slash_commands(&no_arr), None);
        let with = json!({ "slash_commands": ["compact", "/clear", 7] });
        assert_eq!(
            parse_init_slash_commands(&with),
            Some(vec!["compact".to_string(), "clear".to_string()])
        );

        // capture: first init changes (→ one session.commands), an identical
        // second init does not (§9 acceptance / edge #5), a different set does.
        let mut s = test_session();
        assert!(capture_cli_commands(
            &mut s,
            vec!["compact".into(), "clear".into()]
        ));
        assert_eq!(
            s.cli_commands,
            vec!["compact".to_string(), "clear".to_string()]
        );
        assert!(!capture_cli_commands(
            &mut s,
            vec!["compact".into(), "clear".into()]
        ));
        assert!(capture_cli_commands(&mut s, vec!["compact".into()]));
        assert_eq!(s.cli_commands, vec!["compact".to_string()]);
    }

    #[test]
    fn session_commands_event_serializes_to_contract_shape() {
        // §5.3: { type: 'session.commands', sessionId, commands } with
        // SlashCommandInfo camelCase; `scope` omitted (not null) when absent.
        let ev = SessionEvent::Commands {
            session_id: "s1".into(),
            commands: vec![
                SlashCommandInfo {
                    name: "usage".into(),
                    description: "plan usage limits (session + weekly)".into(),
                    source: "builtin",
                    scope: None,
                },
                SlashCommandInfo {
                    name: "deploy".into(),
                    description: "ship it".into(),
                    source: "skill",
                    scope: Some("project".into()),
                },
                SlashCommandInfo {
                    name: "compact".into(),
                    description: String::new(),
                    source: "cli",
                    scope: None,
                },
            ],
        };
        let v = serde_json::to_value(&ev).unwrap();
        assert_eq!(v["type"], "session.commands");
        assert_eq!(v["sessionId"], "s1");
        let cmds = v["commands"].as_array().unwrap();
        assert_eq!(cmds.len(), 3);
        assert_eq!(cmds[0]["name"], "usage");
        assert_eq!(
            cmds[0]["description"],
            "plan usage limits (session + weekly)"
        );
        assert_eq!(cmds[0]["source"], "builtin");
        assert!(cmds[0].get("scope").is_none()); // omitted when absent
        assert_eq!(cmds[1]["source"], "skill");
        assert_eq!(cmds[1]["scope"], "project");
        assert_eq!(cmds[2]["source"], "cli");
        assert_eq!(cmds[2]["description"], ""); // always present, empty for cli
    }
}
