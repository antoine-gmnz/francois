//! model catalog, live discovery, and the session_models command (§5.1).

use super::*;

use crate::ipc::{ok, IpcResult};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Manager};

// ---------- model catalog (§5.1) ----------
//
// `id` is passed verbatim to `claude --model <id>`. We use the CLI's tier
// aliases (sonnet/opus/haiku), which resolve to the latest available model of
// each tier — robust across releases and account tiers. (Made-up full IDs like
// `claude-opus-4` are rejected by the CLI.)

pub fn catalog() -> Vec<ModelInfo> {
    vec![
        model("sonnet", "Sonnet"),
        model("opus", "Opus"),
        model("haiku", "Haiku"),
    ]
}

/// What to SHOW when the catalog does not (yet) know a model's window. It is a
/// display placeholder, never a ceiling — see `loaded_context`.
pub const DEFAULT_CONTEXT_LIMIT: u64 = 200_000;

pub fn context_limit(model_id: &str) -> u64 {
    resolve_context_tokens(model_id).unwrap_or(DEFAULT_CONTEXT_LIMIT)
}

/// The `(limit, used)` a session adopts for a model whose window is `known` (or
/// not). Pure so the load-time rule is testable without an `AppHandle`.
///
/// THE RULE: a window is a ceiling only when it is REAL. `context_limit` hands
/// back the 200K placeholder for a model the catalog has not been fetched for
/// yet, and clamping against that placeholder destroyed the figure permanently —
/// the next persist wrote the clamped 200000 back over the true count, so an
/// Opus 5 session that had used 340K reloaded as "200K/200K, full".
pub fn loaded_context(known: Option<u64>, persisted_used: u64) -> (u64, u64) {
    match known {
        Some(limit) => (limit, persisted_used.min(limit)),
        None => (DEFAULT_CONTEXT_LIMIT, persisted_used),
    }
}

/// Context window for a model id. Matches the exact id first, then resolves CLI
/// aliases and bare family words (`opus`, `sonnet`, …) to the newest cached model
/// of that family — so a session created with the `opus` alias still reports the
/// current Opus context window (e.g. 1M) rather than the 200K default.
pub fn resolve_context_tokens(model_id: &str) -> Option<u64> {
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

pub fn fmt_tokens(n: u64) -> String {
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
pub fn tier_rank(id: &str) -> u8 {
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

pub static MODEL_CACHE: OnceLock<Mutex<Vec<ModelInfo>>> = OnceLock::new();
pub fn model_cache() -> &'static Mutex<Vec<ModelInfo>> {
    MODEL_CACHE.get_or_init(|| Mutex::new(Vec::new()))
}

pub fn read_oauth_token() -> Option<String> {
    parse_access_token(&read_credentials_json()?)
}

/// The `claudeAiOauth` JSON blob, wherever the CLI put it: a plaintext file on
/// Linux/Windows, or (macOS) the login Keychain — `claude` stores credentials
/// there instead and never creates the file, so a file-only read always came
/// up empty on a Mac.
fn read_credentials_json() -> Option<String> {
    let path = dirs::home_dir()?.join(".claude").join(".credentials.json");
    if let Ok(bytes) = std::fs::read(path) {
        return String::from_utf8(bytes).ok();
    }
    keychain_credentials_json()
}

#[cfg(target_os = "macos")]
fn keychain_credentials_json() -> Option<String> {
    let out = crate::process_util::spawn("security")
        .args([
            "find-generic-password",
            "-s",
            "Claude Code-credentials",
            "-w",
        ])
        .output()
        .ok()?;
    out.status.success().then_some(())?;
    String::from_utf8(out.stdout).ok()
}
#[cfg(not(target_os = "macos"))]
fn keychain_credentials_json() -> Option<String> {
    None
}

fn parse_access_token(json: &str) -> Option<String> {
    let v: Value = serde_json::from_str(json).ok()?;
    v.get("claudeAiOauth")?
        .get("accessToken")?
        .as_str()
        .map(String::from)
}

pub fn fetch_live_models() -> Option<Vec<ModelInfo>> {
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
                    default_effort: None,
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

/// What the cache should hold after one refresh attempt — `refresh_models`'s only
/// judgment call, kept pure so it can be tested without a network.
///
/// A FAILED fetch must never downgrade a warm cache. The static catalog carries no
/// `context_tokens` at all, so overwriting live entries with it silently collapses
/// every session's window to the 200K default (`context_limit`'s `unwrap_or`) for
/// the rest of the run — and the frontend prefetches `session_models` from three
/// places at bootstrap, all racing `warm_model_cache`, so a single transient
/// failure among them was enough. Fall back only when nothing is known yet, so the
/// model picker is never empty.
pub fn refreshed_cache(fetched: Option<Vec<ModelInfo>>, cached: &[ModelInfo]) -> Vec<ModelInfo> {
    match fetched {
        Some(live) => live,
        None if cached.is_empty() => catalog(),
        None => cached.to_vec(),
    }
}

// ---------- the on-disk catalog mirror ----------
//
// The live windows are the ONLY place the app learns that (say) Opus 5 holds 1M
// rather than the 200K placeholder, and they arrive over the network — which
// means a launch has none of them until a fetch lands, and a launch that is
// offline (or whose OAuth token went stale between Claude Code runs) never gets
// them at all. Mirroring the last successful fetch to disk makes the windows
// survive the process: the second launch on a machine starts warm.

pub fn models_json_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("models.json"))
}

/// Same temp+rename discipline as `sessions.json`: a crash mid-write must not
/// leave a torn mirror that then fails to parse on every subsequent launch.
fn save_model_cache(app: &AppHandle, models: &[ModelInfo]) {
    let Some(path) = models_json_path(app) else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let Ok(bytes) = serde_json::to_vec(models) else {
        return;
    };
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, &bytes).is_ok() && std::fs::rename(&tmp, &path).is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
}

/// Seed the cache from the mirror. `main.rs` runs this SYNCHRONOUSLY and BEFORE
/// `load_persisted`, which is the whole point: a session must resolve its real
/// window at the moment it loads, not a second later. Reading a small local file
/// on the setup thread is cheap; the fetch it replaces was not.
pub fn load_model_cache(app: &AppHandle) {
    let Some(path) = models_json_path(app) else {
        return;
    };
    let Ok(bytes) = std::fs::read(path) else {
        return;
    };
    let Ok(models) = serde_json::from_slice::<Vec<ModelInfo>>(&bytes) else {
        return;
    };
    if models.is_empty() {
        return;
    }
    *model_cache().lock().unwrap() = models;
}

/// Adopt a successful fetch: cache it, mirror it, and heal every live session's
/// window. Every path that reaches the network funnels through here so that ANY
/// successful fetch reconciles — not only the startup warm-up, which gives up
/// after five tries and left a run that started offline pinned at 200K forever.
fn adopt_live(app: &AppHandle, live: Vec<ModelInfo>) {
    // The cache lock is released before `reconcile_context_limits`, which takes
    // `Engine.sessions` and re-reads the cache under it.
    *model_cache().lock().unwrap() = live.clone();
    save_model_cache(app, &live);
    reconcile_context_limits(app);
}

/// Fetch the live list (updating the cache) or keep what we already know. With
/// an `app` in hand a live fetch also mirrors + reconciles (`adopt_live`).
pub fn refresh_models_for(app: Option<&AppHandle>) -> Vec<ModelInfo> {
    let fetched = fetch_live_models(); // network first — never under the cache lock
    if let (Some(live), Some(app)) = (&fetched, app) {
        adopt_live(app, live.clone());
        return live.clone();
    }
    let mut cache = model_cache().lock().unwrap();
    let next = refreshed_cache(fetched, &cache);
    *cache = next.clone();
    next
}

pub fn refresh_models() -> Vec<ModelInfo> {
    refresh_models_for(None)
}

/// Warm the model cache in the background at startup (for nice model labels and
/// real context windows). Sessions loaded before the fetch completed had their
/// context limit computed against a cold cache (→ 200K default); once the live
/// windows are known, recompute and push corrected metas so the header updates.
///
/// Retries: a launch that beats the network (or catches the OAuth token mid-refresh)
/// used to pin every session at 200K for the whole run with nothing to retry it —
/// and a turn ending against that wrong window clamps `contextUsedTokens` to 200000
/// and persists it. Back off until the live windows are known, then reconcile.
pub fn warm_model_cache(app: AppHandle) {
    std::thread::spawn(move || {
        for delay in [0u64, 5, 15, 60, 300] {
            if delay > 0 {
                std::thread::sleep(std::time::Duration::from_secs(delay));
            }
            let Some(live) = fetch_live_models() else {
                // Keep the picker populated while we retry, but never clobber a
                // cache that already knows the real windows — including the ones
                // `load_model_cache` just restored from the disk mirror.
                let mut cache = model_cache().lock().unwrap();
                if cache.is_empty() {
                    *cache = catalog();
                }
                continue;
            };
            adopt_live(&app, live);
            return;
        }
    });
}

/// display-openai-model-name FR-10: generalized to every runtime and to the
/// label as well — this is what makes FR-9's degraded fallback (a pre-FR-1
/// record, or a runtime whose own catalog probe failed at creation) self-heal
/// once the runtime's catalog is reachable, without paying for a probe on the
/// load path (FR-8). Resolves each DISTINCT `(account_id, model_id)` pair live
/// in the map via FR-3 — one adapter call per pair, not per session (§7 edge
/// case: "two sessions, same account, same model") — and emits + persists a
/// corrected `session.meta` for each session whose label or limit moved.
fn reconcile_context_limits(app: &AppHandle) {
    let engine = app.state::<Engine>();
    let pairs: Vec<(String, String)> = {
        let map = engine.sessions.lock().unwrap_or_else(|p| p.into_inner());
        let mut seen: HashSet<(String, String)> = HashSet::new();
        for s in map.values() {
            seen.insert((s.account_id.clone(), s.model_id.clone()));
        }
        seen.into_iter().collect()
    };
    let resolved: HashMap<(String, String), (String, u64)> = pairs
        .into_iter()
        .map(|(account_id, model_id)| {
            let display = resolve_model_display(app, &account_id, &model_id);
            ((account_id, model_id), display)
        })
        .collect();
    let updated: Vec<SessionMeta> = {
        let mut map = engine.sessions.lock().unwrap_or_else(|p| p.into_inner());
        map.values_mut()
            .filter_map(|s| {
                let key = (s.account_id.clone(), s.model_id.clone());
                let (label, limit) = resolved.get(&key)?;
                let moved = *label != s.model_label || *limit != s.context_limit_tokens;
                moved.then(|| {
                    s.model_label = label.clone();
                    s.context_limit_tokens = *limit;
                    s.meta(app)
                })
            })
            .collect()
    };
    if !updated.is_empty() {
        persist(app, &engine);
    }
    for m in updated {
        emit(app, SessionEvent::Meta { meta: m });
    }
}

/// display-openai-model-name FR-5: is `id` shaped like an Anthropic model id —
/// a `claude-*` id, or one of the CLI's tier aliases. `humanize` and
/// `resolve_context_tokens` are Anthropic-only tools; this is the gate that
/// keeps them off every other runtime's ids (`gpt-4o`, `gpt-5.1-codex`,
/// `o3-mini`, `grok-4`, …) — the whole fix for `humanize("gpt-4o") == "Gpt"`.
pub fn is_anthropic_shaped(id: &str) -> bool {
    id.starts_with("claude-") || matches!(id, "opus" | "sonnet" | "haiku" | "fable")
}

/// display-openai-model-name FR-5: the id-shaped (not account-shaped) label
/// fallback — must be correct without knowing the account, because FR-14's
/// removed-account case has no account left to ask. `humanize` is reached
/// ONLY for an Anthropic-shaped id; everything else is the id verbatim.
pub fn fallback_label(id: &str) -> String {
    if let Some(m) = model_cache().lock().unwrap().iter().find(|m| m.id == id) {
        return m.label.clone();
    }
    if is_anthropic_shaped(id) {
        humanize(id)
    } else {
        id.to_string()
    }
}

/// display-openai-model-name FR-5: the id-shaped context-limit fallback,
/// mirroring `fallback_label`'s split. An Anthropic-shaped id keeps today's
/// placeholder-or-real answer (`context_limit`); every other id reads the
/// OpenAI-shaped context table (`wire::context_tokens_for`), which always
/// answers a concrete figure — no non-Anthropic id ever produces the
/// Anthropic 200K placeholder.
pub fn fallback_context(id: &str) -> u64 {
    if is_anthropic_shaped(id) {
        context_limit(id)
    } else {
        openai_context_tokens_for(id)
    }
}

/// display-openai-model-name FR-3's pure half: given an already-fetched
/// catalog, resolve `model_id`'s label + context window. `resolve_model_display`
/// is this plus the I/O catalog fetch; a call site that already holds a
/// catalog (`session_update_settings`) uses this directly to avoid fetching
/// twice.
pub fn resolve_model_display_from_catalog(catalog: &[ModelInfo], model_id: &str) -> (String, u64) {
    match catalog.iter().find(|m| m.id == model_id) {
        Some(m) => {
            let limit = m
                .context_tokens
                .unwrap_or_else(|| fallback_context(model_id));
            (m.label.clone(), limit)
        }
        None => (fallback_label(model_id), fallback_context(model_id)),
    }
}

/// display-openai-model-name FR-3: resolve a session's model label + context
/// window from its OWN runtime's catalog — the fix for the Anthropic-shaped
/// guess (`humanize`, `context_limit`) being applied to every runtime. Called
/// only at the cold moments FR-6/FR-7/FR-10 name; never from `Session::meta`
/// (FR-2), never from an event path. A miss anywhere along the way (empty
/// catalog, id absent from it, unresolvable account, failed probe) is never an
/// error (FR-4) — it falls back to FR-5's id-shaped guess.
///
/// Claude Code is a deliberate exception: its own `models()` is
/// `session_models`'s on-demand LIVE `/v1/models` fetch (`refresh_models_for`),
/// which ALSO re-triggers this very reconcile pass on success (`adopt_live`) —
/// calling it from every session_create/model-switch/reconcile would turn a
/// cache read into a network round trip on the hottest runtime, and recurse
/// straight back into itself from FR-10's pass. The cache it warms IS Claude
/// Code's own catalog, so this reads it directly instead — byte-for-byte what
/// the pre-feature `label_for`/`context_limit` gave (Goals: "no change on
/// Claude Code sessions").
pub fn resolve_model_display(app: &AppHandle, account_id: &str, model_id: &str) -> (String, u64) {
    let kind = crate::account::kind_of(app, account_id);
    let (runtime, _protocol) = AgentRuntime::from_account_kind(kind);
    if runtime == AgentRuntime::ClaudeCode {
        return (fallback_label(model_id), fallback_context(model_id));
    }
    let catalog = if runtime == AgentRuntime::Codex {
        catalog_for_account(app, Some(account_id), false)
            .map(|catalog| catalog.models)
            .unwrap_or_default()
    } else {
        adapter_for(runtime).models(app, account_id)
    };
    resolve_model_display_from_catalog(&catalog, model_id)
}

pub fn humanize(id: &str) -> String {
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

// core-architecture-wave3 FR-9: the TYPE moved to `crate::ipc::model` — it is a
// contract payload two domains build, and `account/endpoint.rs` had to name this
// module to build one. The CATALOG (everything else in this file) stays here,
// which is the split that was missing. Re-exported so the catalog's own call
// sites, and `crate::session::ModelInfo`, are unchanged.
pub use crate::ipc::{model, ModelInfo};

/// multi-provider-openai FR-18/FR-21's account-keyed wire fix: `accountId` is
/// OPTIONAL, not `sessionId` — the model picker's only mount is the New
/// Session modal (`useModelCatalog`), where there is no session yet, only the
/// account the user is about to create one on. Every pre-existing call site
/// (the palette prefetch, the project registry warm-up) keeps invoking with
/// no payload and gets EXACTLY the pre-existing behavior — the default
/// account's Claude Code catalog. A resolvable account routes through ITS OWN
/// `AgentRuntime` (derived from `AccountKind` via `from_account_kind`), which
/// is what makes an endpoint account's `models()` reachable at all — the
/// account is what `OpenAiAdapter::models` (FR-18) actually needs.
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ModelCatalog {
    pub account_id: String,
    pub agent_runtime: AgentRuntime,
    pub models: Vec<ModelInfo>,
    pub default_model_id: Option<String>,
    pub source: String,
    pub freshness: String,
    pub fetched_at: Option<u64>,
    pub warning: Option<AppError>,
}

pub(crate) use super::adapter::codex::models::valid_effort as valid_catalog_effort;

fn resolve_catalog_account<'a>(
    account_id: Option<&'a str>,
    known: &std::collections::HashSet<String>,
) -> Result<&'a str, AppError> {
    let id = account_id
        .unwrap_or(crate::account::DEFAULT_ACCOUNT_ID)
        .trim();
    if id.is_empty() {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "Account id cannot be blank.",
        ));
    }
    if !known.contains(id) {
        return Err(AppError::new(
            ErrorCode::AccountNotFound,
            "Account no longer exists.",
        ));
    }
    Ok(id)
}

pub(crate) fn catalog_for_account(
    app: &AppHandle,
    account_id: Option<&str>,
    refresh: bool,
) -> Result<ModelCatalog, AppError> {
    let id = resolve_catalog_account(account_id, &crate::account::known_ids(app))?;
    let runtime = AgentRuntime::from_account_kind(crate::account::kind_of(app, id)).0;
    if runtime == AgentRuntime::Codex {
        return super::adapter::codex::model_catalog(app, id, refresh);
    }
    let models = adapter_for(runtime).models(app, id);
    Ok(ModelCatalog {
        account_id: id.to_owned(),
        agent_runtime: runtime,
        default_model_id: models.first().map(|m| m.id.clone()),
        models,
        source: "legacy-adapter".into(),
        freshness: "unverified".into(),
        fetched_at: None,
        warning: None,
    })
}

/// Capture the complete JSON object so malformed optional values reach the
/// canonical Result envelope instead of Tauri's argument rejection path.
pub struct CatalogRequest(Value);
impl<'de, R: tauri::Runtime> tauri::ipc::CommandArg<'de, R> for CatalogRequest {
    fn from_command(
        command: tauri::ipc::CommandItem<'de, R>,
    ) -> Result<Self, tauri::ipc::InvokeError> {
        Ok(Self(match command.message.payload() {
            tauri::ipc::InvokeBody::Json(args) => args.clone(),
            tauri::ipc::InvokeBody::Raw(_) => Value::Null,
        }))
    }
}

fn session_models_request(
    request: &Value,
    resolve: impl FnOnce(Option<&str>, bool) -> Result<ModelCatalog, AppError>,
) -> IpcResult<ModelCatalog> {
    let Some(args) = request.as_object() else {
        return crate::ipc::err(ErrorCode::InvalidInput, "Expected a request object.");
    };
    let account_id = match args.get("accountId") {
        None => None,
        Some(Value::String(value)) => Some(value.as_str()),
        _ => return crate::ipc::err(ErrorCode::InvalidInput, "Account id must be a string."),
    };
    let refresh = match args.get("refresh") {
        None => false,
        Some(Value::Bool(value)) => *value,
        _ => return crate::ipc::err(ErrorCode::InvalidInput, "Refresh must be a boolean."),
    };
    match resolve(account_id, refresh) {
        Ok(catalog) => ok(catalog),
        Err(error) => crate::ipc::IpcResult::Err { ok: false, error },
    }
}

#[tauri::command(async)]
pub fn session_models(app: AppHandle, request: CatalogRequest) -> IpcResult<ModelCatalog> {
    session_models_request(&request.0, |account_id, refresh| {
        catalog_for_account(&app, account_id, refresh)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn catalog_command_returns_invalid_input_envelopes_for_raw_bad_fields() {
        for body in [
            serde_json::json!({"accountId": 42}),
            serde_json::json!({"accountId": null}),
            serde_json::json!({"accountId": []}),
            serde_json::json!({"refresh": null}),
            serde_json::json!({"refresh": "true"}),
            serde_json::json!({"refresh": 1}),
        ] {
            let response =
                session_models_request(&body, |_, _| panic!("invalid request reached discovery"));
            let json = serde_json::to_value(response).unwrap();
            assert_eq!(json["ok"], false);
            assert_eq!(json["error"]["code"], "INVALID_INPUT");
        }
        for (body, expected) in [
            (serde_json::json!({}), false),
            (serde_json::json!({"refresh": true}), true),
        ] {
            let _ = session_models_request(&body, |account, refresh| {
                assert_eq!(account, None);
                assert_eq!(refresh, expected);
                Err(AppError::new(ErrorCode::Internal, "fixture"))
            });
        }
    }

    #[test]
    fn catalog_accounts_are_explicit_and_trimmed() {
        let known = ["default".to_string(), "codex".to_string()]
            .into_iter()
            .collect();
        assert_eq!(resolve_catalog_account(None, &known).unwrap(), "default");
        assert_eq!(
            resolve_catalog_account(Some(" codex "), &known).unwrap(),
            "codex"
        );
        assert_eq!(
            resolve_catalog_account(Some(" "), &known).unwrap_err().code,
            ErrorCode::InvalidInput
        );
        assert_eq!(
            resolve_catalog_account(Some("removed"), &known)
                .unwrap_err()
                .code,
            ErrorCode::AccountNotFound
        );
    }

    #[test]
    fn catalog_fallback_contains_default() {
        assert!(catalog().iter().any(|m| m.id == DEFAULT_MODEL));
    }

    #[test]
    fn parse_access_token_reads_the_same_shape_the_file_and_keychain_both_use() {
        let json = r#"{"claudeAiOauth":{"accessToken":"sk-test-123","refreshToken":"r"}}"#;
        assert_eq!(parse_access_token(json), Some("sk-test-123".to_string()));
    }

    #[test]
    fn parse_access_token_rejects_malformed_or_unrelated_json() {
        assert_eq!(parse_access_token("not json"), None);
        assert_eq!(parse_access_token(r#"{"other":"field"}"#), None);
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
                    default_effort: None,
                    context_tokens: Some(1_000_000),
                    efforts: vec![],
                },
                ModelInfo {
                    id: "claude-opus-4-5-20251101".into(),
                    label: "Opus 4.5".into(),
                    brief: None,
                    default_effort: None,
                    context_tokens: Some(200_000),
                    efforts: vec![],
                },
                ModelInfo {
                    id: "claude-haiku-4-5".into(),
                    label: "Haiku 4.5".into(),
                    brief: None,
                    default_effort: None,
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
        // A cold cache knows NOTHING — not even an id it would match exactly.
        // `context_limit` still answers, with the placeholder, and that
        // distinction is what `loaded_context` / `ContextTracker::finish` ride on.
        model_cache().lock().unwrap().clear();
        assert_eq!(resolve_context_tokens("claude-opus-5"), None);
        assert_eq!(context_limit("claude-opus-5"), DEFAULT_CONTEXT_LIMIT);
        assert_eq!(context_limit("opus"), DEFAULT_CONTEXT_LIMIT);
    }

    #[test]
    fn a_failed_refresh_never_downgrades_a_warm_cache() {
        // THE BUG: `session_models` is prefetched three times at bootstrap and races
        // warm_model_cache. One transient failure used to write the static catalog
        // (context_tokens: None) over the live windows, and every session's limit
        // silently fell to the 200K default for the rest of the run.
        let live = vec![ModelInfo {
            id: "claude-opus-5".into(),
            label: "Opus 5".into(),
            brief: None,
            default_effort: None,
            context_tokens: Some(1_000_000),
            efforts: vec![],
        }];

        let kept = refreshed_cache(None, &live);
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].context_tokens, Some(1_000_000));

        // Cold cache + failed fetch → the tier aliases, so the picker is never empty.
        let cold = refreshed_cache(None, &[]);
        assert!(cold.iter().any(|m| m.id == DEFAULT_MODEL));

        // A live fetch always wins.
        let fresh = refreshed_cache(Some(catalog()), &live);
        assert_eq!(fresh.len(), catalog().len());
    }

    /// THE BUG: an Opus 5 session read "200K" — the placeholder — because the
    /// window is only known once the live catalog has been fetched, and the
    /// clamp then wrote that placeholder over the real used figure.
    #[test]
    fn an_unknown_window_is_a_placeholder_not_a_ceiling() {
        // 340K used against an unknown window survives intact.
        assert_eq!(
            loaded_context(None, 340_000),
            (DEFAULT_CONTEXT_LIMIT, 340_000)
        );
        // A known window IS a ceiling, both ways.
        assert_eq!(
            loaded_context(Some(1_000_000), 340_000),
            (1_000_000, 340_000)
        );
        assert_eq!(loaded_context(Some(200_000), 340_000), (200_000, 200_000));
    }

    /// The disk mirror is what makes a launch start warm — it must round-trip,
    /// and a mirror written by an older build (no `contextTokens`, no `efforts`)
    /// must still load rather than poisoning every subsequent launch.
    #[test]
    fn the_catalog_round_trips_through_the_disk_mirror() {
        let live = vec![ModelInfo {
            id: "claude-opus-5".into(),
            label: "Opus 5".into(),
            brief: Some("1M context".into()),
            default_effort: None,
            context_tokens: Some(1_000_000),
            efforts: vec!["high".into()],
        }];
        let bytes = serde_json::to_vec(&live).unwrap();
        let back: Vec<ModelInfo> = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(back[0].id, "claude-opus-5");
        assert_eq!(back[0].context_tokens, Some(1_000_000));
        assert_eq!(back[0].efforts, vec!["high".to_string()]);

        let older: Vec<ModelInfo> =
            serde_json::from_str(r#"[{"id":"claude-opus-5","label":"Opus 5"}]"#).unwrap();
        assert_eq!(older[0].context_tokens, None);
        assert!(older[0].efforts.is_empty());
    }

    #[test]
    fn humanize_model_ids() {
        assert_eq!(humanize("claude-opus-4-8"), "Opus 4.8");
        assert_eq!(humanize("claude-sonnet-4-5-20250929"), "Sonnet 4.5");
        assert_eq!(humanize("claude-fable-5"), "Fable 5");
        assert_eq!(humanize("opus"), "Opus");
    }

    // ---------- display-openai-model-name FR-5: is_anthropic_shaped ----------

    #[test]
    fn anthropic_shaped_ids_are_claude_prefixed_or_a_tier_alias() {
        assert!(is_anthropic_shaped("claude-opus-4-8"));
        assert!(is_anthropic_shaped("opus"));
        assert!(is_anthropic_shaped("sonnet"));
        assert!(is_anthropic_shaped("haiku"));
        assert!(is_anthropic_shaped("fable"));
    }

    #[test]
    fn every_other_runtimes_ids_are_not_anthropic_shaped() {
        // The acceptance criterion's exact list (FR-9 §9): humanize must never
        // be reached for any of these.
        for id in ["gpt-4o", "gpt-5.1-codex", "o3-mini", "grok-4"] {
            assert!(!is_anthropic_shaped(id), "{id} misclassified as Anthropic");
        }
    }

    // ---------- FR-5: fallback_label / fallback_context ----------

    #[test]
    fn fallback_label_prefers_an_exact_cache_hit_for_any_id_shape() {
        {
            let mut c = model_cache().lock().unwrap();
            *c = vec![model("gpt-4o", "gpt-4o (cached)")];
        }
        assert_eq!(fallback_label("gpt-4o"), "gpt-4o (cached)");
        model_cache().lock().unwrap().clear();
    }

    #[test]
    fn fallback_label_humanizes_only_anthropic_shaped_ids() {
        model_cache().lock().unwrap().clear();
        // THE BUG this feature fixes: `humanize` used to run unconditionally,
        // turning `gpt-4o` and `gpt-5.1-codex` into "Gpt" — every one of these
        // must read back verbatim instead.
        for id in ["gpt-4o", "gpt-5.1-codex", "o3-mini", "grok-4"] {
            assert_eq!(fallback_label(id), id, "humanize leaked onto {id}");
        }
        // An Anthropic-shaped miss still humanizes, unchanged.
        assert_eq!(fallback_label("claude-opus-4-8"), "Opus 4.8");
        assert_eq!(fallback_label("opus"), "Opus");
    }

    #[test]
    fn fallback_context_routes_by_id_shape() {
        model_cache().lock().unwrap().clear();
        // Anthropic-shaped, cold cache: the 200K display placeholder.
        assert_eq!(fallback_context("claude-opus-5"), DEFAULT_CONTEXT_LIMIT);
        // Non-Anthropic: the OpenAI-shaped context table, never the Anthropic
        // placeholder (FR-11).
        assert_eq!(fallback_context("gpt-5"), 400_000);
        assert_eq!(fallback_context("gpt-4o"), 128_000);
    }

    // ---------- FR-3's pure half: resolve_model_display_from_catalog ----------

    #[test]
    fn resolve_from_catalog_uses_the_matching_rows_label_and_context() {
        let catalog = vec![ModelInfo {
            context_tokens: Some(128_000),
            ..model("gpt-4o", "gpt-4o")
        }];
        let (label, limit) = resolve_model_display_from_catalog(&catalog, "gpt-4o");
        assert_eq!(label, "gpt-4o");
        assert_eq!(limit, 128_000);
    }

    #[test]
    fn resolve_from_catalog_falls_back_to_fallback_context_when_the_row_has_none() {
        // Edge case §7: "id present in the adapter catalog with no
        // context_tokens" — label is used, limit falls back per FR-5.
        model_cache().lock().unwrap().clear();
        let catalog = vec![model("gpt-4o", "gpt-4o")];
        let (label, limit) = resolve_model_display_from_catalog(&catalog, "gpt-4o");
        assert_eq!(label, "gpt-4o");
        assert_eq!(limit, 128_000); // OPENAI_CONTEXT_DEFAULT via fallback_context
    }

    #[test]
    fn resolve_from_catalog_falls_back_entirely_on_a_miss() {
        model_cache().lock().unwrap().clear();
        let catalog = vec![model("gpt-4o", "gpt-4o")];
        let (label, limit) = resolve_model_display_from_catalog(&catalog, "gpt-5.1-codex");
        assert_eq!(label, "gpt-5.1-codex"); // id verbatim, never "Gpt"
        assert_eq!(limit, 400_000); // gpt-5 prefix match
    }
}
