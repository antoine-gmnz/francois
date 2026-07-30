//! model catalog, live discovery, and the session_models command (§5.1).

use super::*;

use crate::ipc::{ok, IpcResult};
use serde::Serialize;
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

pub(crate) fn context_limit(model_id: &str) -> u64 {
    resolve_context_tokens(model_id).unwrap_or(200_000)
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

/// Fetch the live list (updating the cache) or fall back to the tier aliases.
pub(crate) fn refresh_models() -> Vec<ModelInfo> {
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

pub(crate) fn model(id: &str, label: &str) -> ModelInfo {
    ModelInfo {
        id: id.into(),
        label: label.into(),
        brief: None,
        context_tokens: None,
        efforts: Vec::new(),
    }
}

#[tauri::command(async)]
pub fn session_models() -> IpcResult<Vec<ModelInfo>> {
    ok(refresh_models())
}

#[cfg(test)]
mod tests {
    use super::*;

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
