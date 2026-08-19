//! model catalog, live discovery, and the session_models command (§5.1).

use super::*;

use crate::ipc::{ok, IpcResult};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Manager};

// ---------- model catalog (§5.1) ----------
//
// `id` is passed verbatim to `claude --model <id>`. We use the CLI's tier
// aliases (sonnet/opus/haiku), which resolve to the latest available model of
// each tier — robust across releases and account tiers. (Made-up full IDs like
// `claude-opus-4` are rejected by the CLI.)

pub(crate) fn catalog() -> Vec<ModelInfo> {
    vec![
        model("sonnet", "Sonnet"),
        model("opus", "Opus"),
        model("haiku", "Haiku"),
    ]
}

/// What to SHOW when the catalog does not (yet) know a model's window. It is a
/// display placeholder, never a ceiling — see `loaded_context`.
pub(crate) const DEFAULT_CONTEXT_LIMIT: u64 = 200_000;

pub(crate) fn context_limit(model_id: &str) -> u64 {
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
pub(crate) fn loaded_context(known: Option<u64>, persisted_used: u64) -> (u64, u64) {
    match known {
        Some(limit) => (limit, persisted_used.min(limit)),
        None => (DEFAULT_CONTEXT_LIMIT, persisted_used),
    }
}

/// Context window for a model id. Matches the exact id first, then resolves CLI
/// aliases and bare family words (`opus`, `sonnet`, …) to the newest cached model
/// of that family — so a session created with the `opus` alias still reports the
/// current Opus context window (e.g. 1M) rather than the 200K default.
pub(crate) fn resolve_context_tokens(model_id: &str) -> Option<u64> {
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

pub(crate) fn fmt_tokens(n: u64) -> String {
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
pub(crate) fn tier_rank(id: &str) -> u8 {
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

pub(crate) static MODEL_CACHE: OnceLock<Mutex<Vec<ModelInfo>>> = OnceLock::new();
pub(crate) fn model_cache() -> &'static Mutex<Vec<ModelInfo>> {
    MODEL_CACHE.get_or_init(|| Mutex::new(Vec::new()))
}

pub(crate) fn read_oauth_token() -> Option<String> {
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
    let out = std::process::Command::new("security")
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

pub(crate) fn fetch_live_models() -> Option<Vec<ModelInfo>> {
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
pub(crate) fn refreshed_cache(
    fetched: Option<Vec<ModelInfo>>,
    cached: &[ModelInfo],
) -> Vec<ModelInfo> {
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

pub(crate) fn models_json_path(app: &AppHandle) -> Option<std::path::PathBuf> {
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
pub(crate) fn refresh_models_for(app: Option<&AppHandle>) -> Vec<ModelInfo> {
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

pub(crate) fn refresh_models() -> Vec<ModelInfo> {
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

/// Recompute every live session's context limit against the (now warm) cache and
/// emit a corrected meta for each one that moved.
fn reconcile_context_limits(app: &AppHandle) {
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
        emit(app, SessionEvent::Meta { meta: m });
    }
}

/// Human label for a model id: the cached display name, else a best-effort
/// humanization of the id (e.g. `claude-opus-4-8` → `Opus 4.8`).
pub(crate) fn label_for(id: &str) -> String {
    if let Some(m) = model_cache().lock().unwrap().iter().find(|m| m.id == id) {
        return m.label.clone();
    }
    humanize(id)
}

pub(crate) fn humanize(id: &str) -> String {
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

/// `Deserialize` is not part of the wire contract — it exists so the catalog can
/// round-trip through the on-disk mirror (`models.json`). Every field but `id`
/// and `label` is `default`ed, so a mirror written by an older build still loads.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ModelInfo {
    pub id: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub brief: Option<String>,
    #[serde(
        rename = "contextTokens",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub context_tokens: Option<u64>,
    /// Effort levels this model supports (subset of low/medium/high/xhigh/max).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub efforts: Vec<String>,
}

pub(crate) fn model(id: &str, label: &str) -> ModelInfo {
    ModelInfo {
        id: id.into(),
        label: label.into(),
        brief: None,
        context_tokens: None,
        efforts: Vec::new(),
    }
}

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
#[tauri::command(async)]
pub fn session_models(app: AppHandle, account_id: Option<String>) -> IpcResult<Vec<ModelInfo>> {
    let known = crate::account::known_ids(&app);
    let found = known_account_id(account_id.as_deref(), &known).map(|id| {
        let kind = crate::account::kind_of(&app, id);
        (AgentRuntime::from_account_kind(kind).0, id.to_string())
    });
    let (runtime, account_id) = resolve_models_target(found);
    ok(adapter_for(runtime).models(&app, &account_id))
}

/// Pure: trims `account_id` and, when it names an account the registry
/// actually knows (per `crate::account::known_ids`), hands back the trimmed
/// id — extracted so "omitted, blank, or unknown falls back to the default"
/// is covered without a `tauri::AppHandle` (`known_ids`/`kind_of` both need
/// one). `known` already contains `DEFAULT_ACCOUNT_ID`, so an explicit
/// `"default"` resolves identically to an omitted payload.
fn known_account_id<'a>(
    account_id: Option<&'a str>,
    known: &std::collections::HashSet<String>,
) -> Option<&'a str> {
    account_id
        .map(str::trim)
        .filter(|id| !id.is_empty() && known.contains(*id))
}

/// The pure half of the account-keyed `session_models`: an unresolvable
/// account (omitted `accountId`, or an id the registry no longer knows) falls
/// back to the pre-existing default, byte for byte.
fn resolve_models_target(found: Option<(AgentRuntime, String)>) -> (AgentRuntime, String) {
    found.unwrap_or((
        AgentRuntime::ClaudeCode,
        crate::account::DEFAULT_ACCOUNT_ID.to_string(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    // ---------- known_account_id (session_models FR-18/FR-21 account rekey) ----------

    fn known_set(ids: &[&str]) -> HashSet<String> {
        ids.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn no_account_id_is_unresolvable() {
        assert_eq!(
            known_account_id(None, &known_set(&["default", "acct-1"])),
            None
        );
    }

    #[test]
    fn a_blank_or_whitespace_account_id_is_unresolvable() {
        let known = known_set(&["default", "acct-1"]);
        assert_eq!(known_account_id(Some(""), &known), None);
        assert_eq!(known_account_id(Some("   "), &known), None);
    }

    #[test]
    fn an_id_the_registry_does_not_know_is_unresolvable() {
        assert_eq!(
            known_account_id(Some("removed-acct"), &known_set(&["default", "acct-1"])),
            None
        );
    }

    #[test]
    fn a_known_id_resolves_trimmed() {
        let known = known_set(&["default", "acct-1"]);
        assert_eq!(known_account_id(Some("acct-1"), &known), Some("acct-1"));
        assert_eq!(known_account_id(Some("  acct-1  "), &known), Some("acct-1"));
        assert_eq!(known_account_id(Some("default"), &known), Some("default"));
    }

    // ---------- resolve_models_target (session_models FR-18 wire fix) ----------

    #[test]
    fn no_account_falls_back_to_the_default_claude_code_catalog() {
        assert_eq!(
            resolve_models_target(None),
            (AgentRuntime::ClaudeCode, "default".to_string())
        );
    }

    #[test]
    fn a_resolved_account_routes_by_its_own_runtime_and_id() {
        assert_eq!(
            resolve_models_target(Some((AgentRuntime::Francois, "acct-1".to_string()))),
            (AgentRuntime::Francois, "acct-1".to_string())
        );
        assert_eq!(
            resolve_models_target(Some((AgentRuntime::ClaudeCode, "acct-2".to_string()))),
            (AgentRuntime::ClaudeCode, "acct-2".to_string())
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
}
