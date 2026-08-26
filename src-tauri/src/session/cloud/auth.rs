//! FR-1 — the claude.ai access token, read but NEVER refreshed.
//!
//! Francois reads `claudeAiOauth.accessToken` + `expiresAt` out of
//! `<configDir>/.credentials.json`, where `<configDir>` is the adopting
//! account's `CLAUDE_CONFIG_DIR` (multi-account) and otherwise the global
//! `~/.claude`. On macOS the CLI may keep the same JSON in the login keychain
//! instead of on disk, so an absent file falls back to that item.
//!
//! Refreshing is the CLI's job, deliberately: a second writer racing the CLI on
//! a rotating OAuth token is how you lose a login. Francois only ever reads, and
//! reports the two states the user can act on — no token at all
//! (`CLOUD_AUTH_REQUIRED`) and a token past its expiry (`CLOUD_AUTH_EXPIRED`).

use super::*;
use crate::ipc::{AppError, ErrorCode};

use std::path::PathBuf;

/// The keychain item the CLI writes on macOS.
#[cfg(target_os = "macos")]
const KEYCHAIN_SERVICE: &str = "Claude Code-credentials";

pub const AUTH_REQUIRED_MSG: &str =
    "Cloud sessions need a claude.ai login — API key auth is not sufficient. \
     Run `claude` in a terminal and sign in with /login.";
pub const AUTH_EXPIRED_MSG: &str =
    "Your claude.ai login has expired. Run a turn in Claude Code, or `/login`, to refresh it.";
const THIRD_PARTY_MSG: &str =
    "Cloud sessions need a claude.ai login. This account is configured against a \
     non-Anthropic endpoint (Bedrock/Vertex/Foundry or a custom ANTHROPIC_BASE_URL).";

/// FR-1: `<configDir>/.credentials.json`, else the global `~/.claude` one.
/// `None` only when there is no config dir AND no home directory to fall back to.
pub fn credentials_path(config_dir: Option<&str>) -> Option<PathBuf> {
    match config_dir.map(str::trim).filter(|d| !d.is_empty()) {
        Some(dir) => Some(PathBuf::from(dir).join(".credentials.json")),
        None => dirs::home_dir().map(|h| h.join(".claude").join(".credentials.json")),
    }
}

/// The `(accessToken, expiresAt)` a credentials document carries. `None` when it
/// has no claude.ai OAuth block at all — which is exactly the API-key /
/// setup-token / Bedrock case (spec §7 #5): those write no `claudeAiOauth`.
pub fn parse_credentials(doc: &Value) -> Option<(String, Option<u64>)> {
    let oauth = doc.get("claudeAiOauth")?;
    let token = oauth.get("accessToken")?.as_str()?.trim().to_string();
    if token.is_empty() {
        return None;
    }
    let expires_at = oauth
        .get("expiresAt")
        .and_then(|v| v.as_u64())
        .map(normalize_epoch_ms);
    Some((token, expires_at))
}

/// FR-1's verdict, pure over what was parsed: no token ⇒ `CLOUD_AUTH_REQUIRED`,
/// an `expiresAt` at/before now ⇒ `CLOUD_AUTH_EXPIRED`. Both are ACTIONABLE,
/// which is why they are the only cloud failures that ever resolve as errors
/// rather than degrading (FR-2).
pub fn token_state(parsed: Option<(String, Option<u64>)>, now: u64) -> Result<String, AppError> {
    let Some((token, expires_at)) = parsed else {
        return Err(AppError::new(
            ErrorCode::CloudAuthRequired,
            AUTH_REQUIRED_MSG,
        ));
    };
    if expires_at.is_some_and(|exp| exp <= now) {
        return Err(AppError::new(ErrorCode::CloudAuthExpired, AUTH_EXPIRED_MSG));
    }
    Ok(token)
}

/// spec §7 #5: eligibility mirrors Remote Control — Bedrock/Vertex/Foundry and a
/// non-Anthropic `ANTHROPIC_BASE_URL` are rejected up front. API keys and
/// `setup-token`/`CLAUDE_CODE_OAUTH_TOKEN` need no check here: they write no
/// `claudeAiOauth` block, so `token_state` already reports them as
/// `CLOUD_AUTH_REQUIRED`.
///
/// Pure over an injected environment lookup, so the rule is testable without
/// mutating a global every other test in the binary can see.
pub fn eligibility_block(env: &dyn Fn(&str) -> Option<String>) -> Option<AppError> {
    let truthy = |key: &str| {
        env(key)
            .map(|v| matches!(v.trim().to_lowercase().as_str(), "1" | "true"))
            .unwrap_or(false)
    };
    if truthy("CLAUDE_CODE_USE_BEDROCK")
        || truthy("CLAUDE_CODE_USE_VERTEX")
        || truthy("CLAUDE_CODE_USE_FOUNDRY")
    {
        return Some(AppError::new(ErrorCode::CloudAuthRequired, THIRD_PARTY_MSG));
    }
    let base = env("ANTHROPIC_BASE_URL").unwrap_or_default();
    let base = base.trim().to_lowercase();
    if !base.is_empty() && !base.contains("api.anthropic.com") {
        return Some(AppError::new(ErrorCode::CloudAuthRequired, THIRD_PARTY_MSG));
    }
    None
}

fn read_credentials_file(path: &std::path::Path) -> Option<(String, Option<u64>)> {
    let bytes = std::fs::read(path).ok()?;
    let doc: Value = serde_json::from_slice(&bytes).ok()?;
    parse_credentials(&doc)
}

/// macOS: the CLI may keep the credentials document in the login keychain rather
/// than on disk. Read-only, and only reached when the file is absent.
#[cfg(target_os = "macos")]
fn keychain_credentials() -> Option<(String, Option<u64>)> {
    let out = crate::process_util::spawn("security")
        .args(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let doc: Value = serde_json::from_str(text.trim()).ok()?;
    parse_credentials(&doc)
}

#[cfg(not(target_os = "macos"))]
fn keychain_credentials() -> Option<(String, Option<u64>)> {
    None
}

/// FR-1 end to end: the token an adoption/list/resolve for this account must
/// present, or the actionable reason it cannot.
pub fn cloud_access_token(config_dir: Option<&str>) -> Result<String, AppError> {
    if let Some(blocked) = eligibility_block(&|k| std::env::var(k).ok()) {
        return Err(blocked);
    }
    let parsed = credentials_path(config_dir)
        .and_then(|p| read_credentials_file(&p))
        .or_else(keychain_credentials);
    token_state(parsed, now_ms())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The shape the CLI writes (verified against a live `~/.claude/.credentials.json`
    /// layout): the OAuth block is nested under `claudeAiOauth`.
    fn credentials(token: &str, expires_at: u64) -> Value {
        json!({
            "claudeAiOauth": {
                "accessToken": token,
                "refreshToken": "sk-ant-ort01-refresh",
                "expiresAt": expires_at,
                "scopes": ["user:inference", "user:profile"],
                "subscriptionType": "max"
            }
        })
    }

    #[test]
    fn credentials_are_read_from_the_claude_ai_oauth_block() {
        let parsed = parse_credentials(&credentials("sk-ant-oat01-abc", 1_784_573_689_516));
        assert_eq!(
            parsed,
            Some(("sk-ant-oat01-abc".to_string(), Some(1_784_573_689_516)))
        );
    }

    #[test]
    fn a_document_with_no_claude_ai_oauth_block_yields_nothing() {
        // spec §7 #5: an API-key / setup-token / Bedrock configuration writes no
        // claudeAiOauth block, which is precisely why "no token" is the right
        // reading of it rather than a separate code.
        assert_eq!(parse_credentials(&json!({})), None);
        assert_eq!(
            parse_credentials(&json!({ "apiKey": "sk-ant-api03-xyz" })),
            None
        );
        assert_eq!(
            parse_credentials(&json!({ "claudeAiOauth": { "refreshToken": "r" } })),
            None
        );
        assert_eq!(
            parse_credentials(&json!({ "claudeAiOauth": { "accessToken": "   " } })),
            None
        );
    }

    #[test]
    fn an_expires_at_in_seconds_is_read_as_seconds() {
        // The CLI writes milliseconds today; a build that switched to seconds
        // would otherwise read as "expired in 1970" and lock the user out.
        let parsed = parse_credentials(&credentials("t", 1_784_573_689)).unwrap();
        assert_eq!(parsed.1, Some(1_784_573_689_000));
    }

    #[test]
    fn a_missing_token_is_auth_required() {
        let AppError { code, message, .. } = token_state(None, 1_000).unwrap_err();
        assert_eq!(code, ErrorCode::CloudAuthRequired);
        assert!(
            message.contains("API key auth is not sufficient"),
            "the message must say WHY a working API key is not enough: {message}"
        );
    }

    #[test]
    fn a_token_past_its_expiry_is_auth_expired() {
        let AppError { code, message, .. } =
            token_state(Some(("t".into(), Some(1_000))), 1_001).unwrap_err();
        assert_eq!(code, ErrorCode::CloudAuthExpired);
        assert!(message.contains("/login"), "actionable: {message}");
        // Exactly at the expiry instant is expired too — the API would refuse it.
        assert!(token_state(Some(("t".into(), Some(1_000))), 1_000).is_err());
    }

    #[test]
    fn a_live_token_resolves_and_a_token_without_an_expiry_is_trusted() {
        assert_eq!(
            token_state(Some(("tok".into(), Some(2_000))), 1_000).unwrap(),
            "tok"
        );
        // No expiresAt at all: Francois never mints or refreshes, so the only
        // honest reading is "let the API decide" rather than a synthetic expiry.
        assert_eq!(
            token_state(Some(("tok".into(), None)), u64::MAX).unwrap(),
            "tok"
        );
    }

    #[test]
    fn credentials_path_prefers_the_accounts_config_dir() {
        assert_eq!(
            credentials_path(Some("D:\\francois\\accounts\\a1")),
            Some(PathBuf::from("D:\\francois\\accounts\\a1").join(".credentials.json"))
        );
        // A blank configDir is the built-in `default` account — fall through to
        // the global ~/.claude rather than reading `/.credentials.json`.
        let global = credentials_path(Some("   "));
        assert_eq!(global, credentials_path(None));
        if let Some(p) = global {
            assert!(p.ends_with(".credentials.json"));
            assert!(p.to_string_lossy().contains(".claude"));
        }
    }

    #[test]
    fn third_party_endpoints_are_refused_before_any_token_is_read() {
        // spec §7 #5: Bedrock/Vertex/Foundry and a non-Anthropic base URL are all
        // ineligible for cloud sessions, whatever is on disk.
        let bedrock = |k: &str| (k == "CLAUDE_CODE_USE_BEDROCK").then(|| "1".to_string());
        assert_eq!(
            eligibility_block(&bedrock).map(|e| e.code),
            Some(ErrorCode::CloudAuthRequired)
        );
        let vertex = |k: &str| (k == "CLAUDE_CODE_USE_VERTEX").then(|| "true".to_string());
        assert!(eligibility_block(&vertex).is_some());
        let proxy =
            |k: &str| (k == "ANTHROPIC_BASE_URL").then(|| "https://llm.corp.internal".to_string());
        assert!(eligibility_block(&proxy).is_some());
    }

    #[test]
    fn the_ordinary_environment_is_eligible() {
        assert_eq!(eligibility_block(&|_| None), None);
        // An explicitly-set but Anthropic base URL is the normal case, not a proxy.
        let anthropic =
            |k: &str| (k == "ANTHROPIC_BASE_URL").then(|| "https://api.anthropic.com".to_string());
        assert_eq!(eligibility_block(&anthropic), None);
        // "0"/"false" are not opt-ins.
        let off = |k: &str| (k == "CLAUDE_CODE_USE_BEDROCK").then(|| "0".to_string());
        assert_eq!(eligibility_block(&off), None);
    }
}
