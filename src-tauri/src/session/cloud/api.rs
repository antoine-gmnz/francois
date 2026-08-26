//! FR-2 / FR-3 — the two REST calls, the ref normalizer, and the ONE pure
//! function that turns an API entry into a `CloudSession`.
//!
//! **The list is a convenience, not a contract** (spec §7 #3). The exact
//! response field names — and any required header beyond `Authorization` (the
//! CLI also sends `X-Trusted-Device-Token` on some paths) — were NOT verified
//! live. That is why:
//!
//!  * every mapping decision lives in `map_cloud_session` / `parse_cloud_list`,
//!    two small pure functions with their own tests, so a correction after one
//!    authenticated call is a one-line change rather than a refactor; and
//!  * FR-2's degrade-to-empty rule covers every other outcome: any non-200,
//!    timeout, parse failure or unexpected shape resolves `ok:true` with
//!    `degraded:true` and an empty list. A wrong guess costs the list, never the
//!    feature — the paste path (FR-3) is authoritative and never touches this.
//!
//! The ONLY failures that surface as errors are the ones the user can act on:
//! the FR-1 auth states, plus the two the API names explicitly (an untrusted
//! device, and an org policy with `allow_remote_sessions` off), which the
//! contract lists for `cloud_list` precisely because they are actionable.

use super::*;
use crate::ipc::{AppError, ErrorCode};

use crate::ipc::{err, ok, IpcResult};

const API_BASE: &str = "https://api.anthropic.com";
/// FR-2's page size — one call, no pagination: the modal shows a picker, not an
/// archive, and the paste path covers anything older.
const LIST_LIMIT: u32 = 100;
/// Sent alongside `Authorization`. Unverified (spec §7 #3) but harmless: the API
/// ignores headers it does not use, and omitting a required one degrades to the
/// empty list rather than failing the feature.
const ANTHROPIC_VERSION: &str = "2023-06-01";

/// `pub(crate)` because `detect.rs` returns the SAME words for the same two
/// refusals when teleport announces them in the PTY rather than the API — one
/// failure must not read as two different problems depending on where it was met.
pub const DEVICE_UNTRUSTED_MSG: &str =
    "This device is not enrolled for cloud sessions. Run `/login` in Claude Code on this \
     machine to enrol it, then try again.";
pub const POLICY_DENIED_MSG: &str =
    "Your organization has turned cloud sessions off (allow_remote_sessions). \
     An administrator has to enable them.";
const BAD_REF_MSG: &str =
    "That is not a Claude Code on the web session. Paste a claude.ai/code link, or the \
     session id it ends with.";

// ---------- FR-3: the ref normalizer (pure) ----------

/// A cloud session id: `session_…` or `cse_…`, then the id charset. Deliberately
/// strict — this value becomes an argv element (`claude --teleport <id>`), so
/// anything that could be read as a flag or a path must never get through.
pub fn valid_cloud_id(candidate: &str) -> bool {
    let Some(rest) = candidate
        .strip_prefix("session_")
        .or_else(|| candidate.strip_prefix("cse_"))
    else {
        return false;
    };
    !rest.is_empty()
        && rest
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// FR-3: a bare `session_…`/`cse_…` id, or a `claude.ai/code/<id>` URL with or
/// without scheme, trailing slash or query string. Anything else ⇒ `None`
/// (INVALID_INPUT at the call site).
///
/// A path-shaped ref must name `claude.ai/code/` explicitly: accepting the last
/// segment of ANY url would let `evil.example/session_x` through, and this value
/// is handed to the CLI.
pub fn normalize_cloud_ref(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let after_scheme = match trimmed.find("://") {
        Some(i) => &trimmed[i + 3..],
        None => trimmed,
    };
    let path = after_scheme
        .split(['?', '#'])
        .next()
        .unwrap_or(after_scheme)
        .trim_end_matches('/');
    let candidate = if path.contains('/') {
        const MARK: &str = "claude.ai/code/";
        let at = path.to_lowercase().find(MARK)?;
        path[at + MARK.len()..]
            .split('/')
            .find(|seg| !seg.is_empty())?
    } else {
        path
    };
    valid_cloud_id(candidate).then(|| candidate.to_string())
}

// ---------- the response mapping (pure — spec §7 #3's one place to correct) ----------

fn first_str<'a>(v: &'a Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter()
        .find_map(|k| v.get(*k).and_then(|x| x.as_str()))
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

/// `git@github.com:acme/api.git` | `https://github.com/acme/api` | `acme/api`
/// → `acme/api`. `None` when nothing owner/name-shaped survives, so a bare host
/// or a single word is reported as "no repo" rather than as half a slug.
pub fn remote_slug(raw: &str) -> Option<String> {
    let mut s = raw.trim();
    if s.is_empty() {
        return None;
    }
    if let Some(i) = s.find("://") {
        s = &s[i + 3..];
    }
    if let Some(i) = s.find('@') {
        s = &s[i + 1..]; // strip `git@`-style userinfo
    }
    // scp-style `host:owner/name` — the colon is just another separator here.
    let flattened = s.replace(':', "/");
    let flattened = flattened.trim_end_matches('/');
    let flattened = flattened.strip_suffix(".git").unwrap_or(flattened);
    let parts: Vec<&str> = flattened.split('/').filter(|p| !p.is_empty()).collect();
    if parts.len() < 2 {
        return None;
    }
    Some(format!(
        "{}/{}",
        parts[parts.len() - 2],
        parts[parts.len() - 1]
    ))
}

/// FR-3: does a checkout's `origin` URL name the same repository the cloud
/// session does? Host-agnostic and case-insensitive — a fork under a different
/// owner deliberately does NOT match (spec §7 #6: "a checkout of the *same*
/// repository — not a fork").
pub fn repo_matches(remote_url: &str, repo: &str) -> bool {
    match (remote_slug(remote_url), remote_slug(repo)) {
        (Some(a), Some(b)) => a.eq_ignore_ascii_case(&b),
        _ => false,
    }
}

/// Epoch milliseconds out of whatever the endpoint carries: a number (in ms or
/// seconds — see `normalize_epoch_ms`) or an RFC3339 timestamp string.
pub fn parse_epoch_ms(v: &Value) -> Option<u64> {
    if let Some(n) = v.as_u64() {
        return Some(normalize_epoch_ms(n));
    }
    if let Some(f) = v.as_f64() {
        if f > 0.0 {
            return Some(normalize_epoch_ms(f as u64));
        }
    }
    v.as_str().and_then(rfc3339_to_epoch_ms)
}

/// Howard Hinnant's "days from civil" (public domain,
/// http://howardhinnant.github.io/date_algorithms.html) — the forward direction
/// of the algorithm `remote_discovery::civil_from_days` inverts. Pure integer
/// math, so this file needs no date crate.
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400; // [0, 399]
    let mp = if m > 2 { m - 3 } else { m + 9 } as i64; // [0, 11]
    let doy = (153 * mp + 2) / 5 + d as i64 - 1; // [0, 365]
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// `2026-08-11T09:15:04.512Z` → epoch ms. Tolerates a missing fractional part, a
/// space separator, and a missing zone (read as UTC — the API is UTC and a
/// wrong-by-hours "last activity" is strictly better than no row at all). A
/// numeric offset is applied when present.
pub fn rfc3339_to_epoch_ms(raw: &str) -> Option<u64> {
    let s = raw.trim();
    let bytes = s.as_bytes();
    if bytes.len() < 19 {
        return None;
    }
    let num = |from: usize, to: usize| s.get(from..to)?.parse::<i64>().ok();
    let year = num(0, 4)?;
    let month = num(5, 7)? as u32;
    let day = num(8, 10)? as u32;
    let hour = num(11, 13)?;
    let minute = num(14, 16)?;
    let second = num(17, 19)?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let rest = &s[19..];
    let millis = rest
        .strip_prefix('.')
        .map(|frac| {
            let digits: String = frac.chars().take_while(|c| c.is_ascii_digit()).collect();
            let mut padded = format!("{digits:0<3}");
            padded.truncate(3);
            padded.parse::<i64>().unwrap_or(0)
        })
        .unwrap_or(0);
    let zone = rest.trim_start_matches(|c: char| c.is_ascii_digit() || c == '.');
    let offset_minutes = match zone.chars().next() {
        Some('+') | Some('-') => {
            let sign = if zone.starts_with('-') { -1 } else { 1 };
            let hh = zone.get(1..3)?.parse::<i64>().ok()?;
            let mm = zone
                .get(4..6)
                .or_else(|| zone.get(3..5))
                .and_then(|m| m.parse::<i64>().ok())
                .unwrap_or(0);
            sign * (hh * 60 + mm)
        }
        _ => 0,
    };
    let days = days_from_civil(year, month, day);
    let total = days * 86_400_000 + (hour * 3600 + minute * 60 + second) * 1000 + millis
        - offset_minutes * 60_000;
    u64::try_from(total).ok()
}

fn map_repo(v: &Value) -> Option<String> {
    // A flat string field — the shape the docs describe.
    if let Some(s) = first_str(
        v,
        &[
            "repo",
            "repository",
            "full_name",
            "fullName",
            "git_repo",
            "gitRepo",
            "repo_url",
            "repositoryUrl",
            "remote_url",
            "git_url",
        ],
    ) {
        return remote_slug(s);
    }
    // …or a nested object, which is how most git-aware APIs model it.
    for key in ["repo", "repository", "git", "gitRepository"] {
        let Some(obj) = v.get(key).filter(|o| o.is_object()) else {
            continue;
        };
        if let Some(full) = first_str(
            obj,
            &[
                "full_name",
                "fullName",
                "slug",
                "name_with_owner",
                "nameWithOwner",
            ],
        ) {
            return remote_slug(full);
        }
        if let (Some(owner), Some(name)) = (
            first_str(obj, &["owner", "org", "organization"]),
            first_str(obj, &["name", "repo"]),
        ) {
            return Some(format!("{owner}/{name}"));
        }
        if let Some(url) = first_str(obj, &["url", "remote_url", "html_url", "clone_url"]) {
            return remote_slug(url);
        }
    }
    None
}

/// **The** mapping (spec §7 #3 / §1.6): one API entry → one `CloudSession`.
///
/// `None` when the entry carries no usable id, which is the only field adoption
/// truly needs. Every other field is best-effort and NEVER synthesized: a row
/// that invents a title or a branch is worse than a row that shows neither.
/// The key aliases are an informed guess at an endpoint that was not verified
/// live — correcting them is an edit to the arrays below and nothing else.
pub fn map_cloud_session(v: &Value) -> Option<CloudSession> {
    let id = first_str(v, &["id", "session_id", "sessionId", "uuid"])?;
    Some(CloudSession {
        id: id.to_string(),
        title: first_str(v, &["title", "name", "summary", "description"]).map(str::to_string),
        repo: map_repo(v),
        branch: first_str(
            v,
            &["branch", "git_branch", "gitBranch", "branch_name", "ref"],
        )
        .map(str::to_string),
        updated_at: [
            "updated_at",
            "updatedAt",
            "last_activity_at",
            "lastActivityAt",
            "modified_at",
            "created_at",
            "createdAt",
        ]
        .iter()
        .find_map(|k| v.get(*k).and_then(parse_epoch_ms)),
    })
}

/// FR-2: the list out of a response body. `None` means "a shape this build does
/// not understand" — the caller degrades. A body whose array is non-empty but
/// yields no mappable entry counts as unrecognized too: reporting an empty list
/// there would claim the user has no cloud sessions, which is a lie.
pub fn parse_cloud_list(body: &Value) -> Option<Vec<CloudSession>> {
    let entries = ["data", "sessions", "results", "items"]
        .iter()
        .find_map(|k| body.get(*k).and_then(|v| v.as_array()))
        .or_else(|| body.as_array())?;
    let mapped: Vec<CloudSession> = entries.iter().filter_map(map_cloud_session).collect();
    if mapped.is_empty() && !entries.is_empty() {
        return None;
    }
    Some(mapped)
}

/// spec §7 #4: teleport rides Remote Control's infrastructure, so the API's own
/// wording may talk about Remote Control. Map the reasons the user can act on to
/// their CLOUD_* codes; `None` means "not actionable" and the caller degrades
/// (FR-2) rather than inventing an error out of a shape it did not recognize.
pub fn classify_api_error(status: u16, body: &str) -> Option<(ErrorCode, &'static str)> {
    let b = body.to_lowercase();
    if b.contains("untrusted_device") || b.contains("trusted device") {
        return Some((ErrorCode::CloudDeviceUntrusted, DEVICE_UNTRUSTED_MSG));
    }
    if b.contains("allow_remote_sessions") || (status == 403 && b.contains("policy")) {
        return Some((ErrorCode::CloudPolicyDenied, POLICY_DENIED_MSG));
    }
    if b.contains("no_access_token") {
        return Some((ErrorCode::CloudAuthRequired, AUTH_REQUIRED_MSG));
    }
    if status == 401
        || b.contains("token_expired")
        || b.contains("has expired")
        || b.contains("authentication_error")
    {
        return Some((ErrorCode::CloudAuthExpired, AUTH_EXPIRED_MSG));
    }
    None
}

// ---------- the HTTP calls ----------

/// What one bounded GET produced. `Degraded` is FR-2's catch-all: it carries no
/// reason on purpose, because there is nothing the user could do with it.
///
/// `NotFound` is kept apart from it for one reason only: the contract documents
/// `CLOUD_SESSION_NOT_FOUND` for `cloud_resolve` and `cloud_adopt`, and on the
/// SINGLE-session endpoint a 404 is the answer to a question this app asked ("is
/// this the id?"). On the list endpoint the same status means the route moved, so
/// `list_result` folds it straight back into FR-2's degrade.
pub enum CloudFetch {
    Body(Value),
    Actionable(ErrorCode, &'static str),
    NotFound,
    Degraded,
}

/// The verdict of one non-200, pure so the split above is testable without HTTP.
/// An actionable BODY wins over the status: a policy refusal served as a 404 is
/// still a policy refusal.
pub fn classify_status(status: u16, body: &str) -> CloudFetch {
    match classify_api_error(status, body) {
        Some((code, message)) => CloudFetch::Actionable(code, message),
        None if status == 404 => CloudFetch::NotFound,
        None => CloudFetch::Degraded,
    }
}

fn http_agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(CLOUD_HTTP_TIMEOUT_SECS))
        .timeout_read(Duration::from_secs(CLOUD_HTTP_TIMEOUT_SECS))
        .build()
}

fn cloud_get(url: &str, token: &str) -> CloudFetch {
    let result = http_agent()
        .get(url)
        .set("Authorization", &format!("Bearer {token}"))
        .set("anthropic-version", ANTHROPIC_VERSION)
        .set("Accept", "application/json")
        .set(
            "User-Agent",
            &format!("francois/{}", env!("CARGO_PKG_VERSION")),
        )
        .call();
    match result {
        Ok(resp) => match resp.into_json::<Value>() {
            Ok(body) => CloudFetch::Body(body),
            Err(_) => CloudFetch::Degraded,
        },
        Err(ureq::Error::Status(code, resp)) => {
            let body = resp.into_string().unwrap_or_default();
            classify_status(code, &body)
        }
        Err(ureq::Error::Transport(_)) => CloudFetch::Degraded,
    }
}

/// FR-2: what one LIST fetch resolves to. Everything but an actionable refusal
/// degrades — a 404 included, because on a collection endpoint it means the route
/// moved and "you have no cloud sessions" would be a lie the user acts on.
pub fn list_result(fetch: CloudFetch) -> Result<CloudListData, AppError> {
    match fetch {
        CloudFetch::Body(body) => Ok(parse_cloud_list(&body)
            .map(|sessions| CloudListData {
                sessions,
                degraded: false,
            })
            .unwrap_or_else(degraded_list)),
        CloudFetch::Actionable(code, message) => Err(AppError::new(code, message)),
        CloudFetch::NotFound | CloudFetch::Degraded => Ok(degraded_list()),
    }
}

pub fn list_url() -> String {
    format!("{API_BASE}/v1/code/sessions?limit={LIST_LIMIT}")
}

pub fn session_url(cloud_id: &str) -> String {
    format!("{API_BASE}/v1/code/sessions/{cloud_id}")
}

/// What `GET /v1/code/sessions/<id>` said about ONE session. The two callers read
/// it differently on purpose — `cloud_resolve` degrades to null metadata (FR-3),
/// `cloud_adopt` refuses up front (§2's "a named, actionable failure for every
/// documented precondition") — so the verdict stays a verdict here rather than
/// being collapsed into an `Option` that loses the reason.
#[derive(Debug)]
pub enum CloudLookup {
    /// The API described the session.
    Found(CloudSession),
    /// It did not answer usefully (transport, timeout, a shape this build does
    /// not read, or a non-actionable non-200). Says nothing about the session.
    Unknown,
    /// A definitive 404 on this id — there is no such cloud session for this
    /// account (`CLOUD_SESSION_NOT_FOUND`).
    NotFound,
    /// A refusal the user can act on: an untrusted device, an org policy, or an
    /// auth state the FR-1 precheck did not already catch.
    Actionable(ErrorCode, &'static str),
}

/// Pure: one fetch of the single-session endpoint → the verdict. The id is always
/// the one the user gave — an API that answers about a DIFFERENT session is not
/// something this app can explain, and the ref is what adoption will use.
pub fn lookup_verdict(fetch: CloudFetch, cloud_id: &str) -> CloudLookup {
    match fetch {
        CloudFetch::Body(body) => match map_cloud_session(&body)
            .or_else(|| body.get("session").and_then(map_cloud_session))
        {
            Some(s) => CloudLookup::Found(CloudSession {
                id: cloud_id.to_string(),
                ..s
            }),
            None => CloudLookup::Unknown,
        },
        CloudFetch::Actionable(code, message) => CloudLookup::Actionable(code, message),
        CloudFetch::NotFound => CloudLookup::NotFound,
        CloudFetch::Degraded => CloudLookup::Unknown,
    }
}

/// FR-3/FR-4, best-effort: the cloud session's own metadata, or the reason the
/// lookup could not produce it.
pub fn lookup_cloud_session(token: &str, cloud_id: &str) -> CloudLookup {
    lookup_verdict(cloud_get(&session_url(cloud_id), token), cloud_id)
}

/// The one wording for "no such cloud session", shared by `cloud_resolve` and
/// `cloud_adopt` so the same 404 never reads as two different problems. Names the
/// id, because the usual cause is a link pasted from a different account.
pub fn session_not_found(cloud_id: &str) -> AppError {
    AppError::new(
        ErrorCode::CloudSessionNotFound,
        format!(
            "That cloud session does not exist for this account ({cloud_id}). Check the link, \
             or switch to the account that started it."
        ),
    )
}

/// FR-3: what a lookup verdict RESOLVES to. "A non-200 here resolves the ref with
/// null metadata rather than failing — adoption may still succeed, teleport does
/// its own validation": that covers the actionable refusals too, which is why an
/// untrusted device or a policy refusal never leaves `cloud_resolve` (neither code
/// is in its contract union). Only a definitive 404 fails, because there is then
/// nothing left to adopt.
pub fn resolved_session(verdict: CloudLookup, cloud_id: &str) -> Result<CloudSession, AppError> {
    match verdict {
        CloudLookup::Found(session) => Ok(session),
        CloudLookup::Unknown | CloudLookup::Actionable(..) => Ok(CloudSession {
            id: cloud_id.to_string(),
            ..Default::default()
        }),
        CloudLookup::NotFound => Err(session_not_found(cloud_id)),
    }
}

// ---------- account plumbing ----------

/// The config dir the token for this request lives in. An omitted, blank or
/// no-longer-registered `accountId` falls back to the default account rather
/// than erroring: the contract's error sets for these three commands contain no
/// account code, and a stale id degrading to the default account is strictly
/// better than an error the frontend cannot render.
pub fn cloud_account_id(app: &AppHandle, requested: Option<&str>) -> String {
    let known = crate::account::known_ids(app);
    requested
        .map(str::trim)
        .filter(|id| !id.is_empty() && known.contains(*id))
        .map(str::to_string)
        .unwrap_or_else(|| crate::account::default_account_id(app))
}

pub fn cloud_token_for(app: &AppHandle, account_id: &str) -> Result<String, AppError> {
    let config_dir = crate::account::config_dir_of(app, account_id);
    cloud_access_token(config_dir.as_deref())
}

// ---------- FR-3: matching a resolved repo to a registered project ----------

/// The project whose checkout is the SAME repository as `repo`, if any — what
/// lets the modal pre-select quietly instead of guessing (FR-14). Compares git
/// remotes, so a project directory that merely happens to be named `api` never
/// matches `acme/api`.
pub fn match_project_by_repo(app: &AppHandle, repo: &str) -> Option<String> {
    let roots = crate::project::project_roots(app);
    roots.into_iter().find_map(|(id, root)| {
        let host = crate::diff::GitHost::of(&root);
        let out = crate::diff::git_routed(&host, &root, &["remote", "get-url", "origin"]).ok()?;
        if out.code != 0 {
            return None;
        }
        let url = String::from_utf8_lossy(&out.stdout).trim().to_string();
        repo_matches(&url, repo).then_some(id)
    })
}

// ---------- commands ----------

/// francois:cloud:list → `cloud_list`. FR-2: the list degrades, never blocks.
#[tauri::command(async)]
pub fn cloud_list(app: AppHandle, account_id: Option<String>) -> IpcResult<CloudListData> {
    let account = cloud_account_id(&app, account_id.as_deref());
    let token = match cloud_token_for(&app, &account) {
        Ok(t) => t,
        Err(e) => return e.into(),
    };
    list_result(cloud_get(&list_url(), &token)).into()
}

/// francois:cloud:resolve → `cloud_resolve`. FR-3: normalize the ref, then fill
/// in `repo`/`branch` best-effort. A failed lookup resolves with null metadata
/// rather than failing — adoption may still succeed, and teleport does its own
/// validation.
#[tauri::command(async)]
pub fn cloud_resolve(
    app: AppHandle,
    r#ref: String,
    account_id: Option<String>,
) -> IpcResult<CloudResolveData> {
    let Some(cloud_id) = normalize_cloud_ref(&r#ref) else {
        return err(ErrorCode::InvalidInput, BAD_REF_MSG);
    };
    let account = cloud_account_id(&app, account_id.as_deref());
    let token = match cloud_token_for(&app, &account) {
        Ok(t) => t,
        Err(e) => return e.into(),
    };
    // FR-3: everything but a definitive 404 resolves — with null metadata when the
    // lookup could not fill it in.
    let session = match resolved_session(lookup_cloud_session(&token, &cloud_id), &cloud_id) {
        Ok(session) => session,
        Err(e) => return e.into(),
    };
    let matched_project_id = session
        .repo
        .as_deref()
        .and_then(|repo| match_project_by_repo(&app, repo));
    ok(CloudResolveData {
        session,
        matched_project_id,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ---- FR-3: the ref normalizer ----

    #[test]
    fn a_bare_session_id_normalizes_to_itself() {
        assert_eq!(
            normalize_cloud_ref("session_01Mo4r8N2qZBTbU4V647cis4").as_deref(),
            Some("session_01Mo4r8N2qZBTbU4V647cis4")
        );
        assert_eq!(
            normalize_cloud_ref("  cse_abc-123_ok  ").as_deref(),
            Some("cse_abc-123_ok")
        );
    }

    #[test]
    fn a_claude_ai_code_url_normalizes_with_or_without_scheme_slash_or_query() {
        for raw in [
            "https://claude.ai/code/session_01AB",
            "http://claude.ai/code/session_01AB",
            "claude.ai/code/session_01AB",
            "https://claude.ai/code/session_01AB/",
            "https://claude.ai/code/session_01AB?from=phone",
            "https://claude.ai/code/session_01AB#top",
            "https://www.claude.ai/code/session_01AB",
            "  https://claude.ai/code/session_01AB  ",
        ] {
            assert_eq!(
                normalize_cloud_ref(raw).as_deref(),
                Some("session_01AB"),
                "failed on {raw}"
            );
        }
    }

    #[test]
    fn anything_else_is_refused() {
        for raw in [
            "",
            "   ",
            "https://claude.ai/chat/abc",
            "https://evil.example/session_01AB", // not a claude.ai/code url
            "session_",                          // prefix with no id
            "sessionabc",
            "--teleport",           // must never be readable as a flag
            "session_01AB/../../x", // path traversal in the id charset
            "session_01 AB",
        ] {
            assert_eq!(normalize_cloud_ref(raw), None, "accepted {raw}");
        }
    }

    // ---- the mapping (spec §7 #3 — the one place a live correction lands) ----

    #[test]
    fn the_documented_entry_shape_maps_field_for_field() {
        let entry = json!({
            "id": "session_01Mo4r8",
            "title": "Fix the flaky auth test",
            "repo": "acme/api",
            "branch": "fix/flaky-auth",
            "updated_at": "2026-08-11T09:15:04.512Z"
        });
        let mapped = map_cloud_session(&entry).expect("maps");
        assert_eq!(mapped.id, "session_01Mo4r8");
        assert_eq!(mapped.title.as_deref(), Some("Fix the flaky auth test"));
        assert_eq!(mapped.repo.as_deref(), Some("acme/api"));
        assert_eq!(mapped.branch.as_deref(), Some("fix/flaky-auth"));
        assert_eq!(
            mapped.updated_at,
            rfc3339_to_epoch_ms("2026-08-11T09:15:04.512Z")
        );
    }

    #[test]
    fn absent_fields_map_to_null_and_are_never_synthesized() {
        let mapped = map_cloud_session(&json!({ "id": "cse_1" })).expect("maps");
        assert_eq!(mapped.title, None);
        assert_eq!(mapped.repo, None);
        assert_eq!(mapped.branch, None);
        assert_eq!(mapped.updated_at, None);
        // A blank string is absence, not an empty title.
        let blank = map_cloud_session(&json!({ "id": "cse_1", "title": "  " })).unwrap();
        assert_eq!(blank.title, None);
    }

    #[test]
    fn an_entry_without_a_usable_id_does_not_map() {
        assert_eq!(map_cloud_session(&json!({ "title": "no id" })), None);
        assert_eq!(map_cloud_session(&json!({ "id": "" })), None);
        assert_eq!(map_cloud_session(&json!("session_01AB")), None);
    }

    #[test]
    fn the_mapping_tolerates_the_plausible_alternate_key_spellings() {
        // The endpoint was not verified live (spec §7 #3): camelCase, an id under
        // `session_id`, and a nested repo object are all plausible, and each
        // costs the list nothing to accept.
        let mapped = map_cloud_session(&json!({
            "session_id": "session_9",
            "name": "Ship it",
            "repository": { "owner": "acme", "name": "api" },
            "gitBranch": "main",
            "lastActivityAt": 1_784_573_689_516u64
        }))
        .expect("maps");
        assert_eq!(mapped.id, "session_9");
        assert_eq!(mapped.title.as_deref(), Some("Ship it"));
        assert_eq!(mapped.repo.as_deref(), Some("acme/api"));
        assert_eq!(mapped.branch.as_deref(), Some("main"));
        assert_eq!(mapped.updated_at, Some(1_784_573_689_516));
    }

    #[test]
    fn a_repo_given_as_a_url_is_reduced_to_owner_slash_name() {
        let from_url =
            map_cloud_session(&json!({ "id": "s", "repo": "https://github.com/acme/api.git" }))
                .unwrap();
        assert_eq!(from_url.repo.as_deref(), Some("acme/api"));
        let from_ssh =
            map_cloud_session(&json!({ "id": "s", "repo": "git@github.com:acme/api.git" }))
                .unwrap();
        assert_eq!(from_ssh.repo.as_deref(), Some("acme/api"));
    }

    // ---- FR-2: the list body ----

    #[test]
    fn a_list_body_is_read_from_data_sessions_or_the_bare_array() {
        let entry = json!({ "id": "session_1" });
        for body in [
            json!({ "data": [entry.clone()] }),
            json!({ "sessions": [entry.clone()] }),
            json!({ "results": [entry.clone()] }),
            json!([entry.clone()]),
        ] {
            let parsed = parse_cloud_list(&body).expect("recognized");
            assert_eq!(parsed.len(), 1);
            assert_eq!(parsed[0].id, "session_1");
        }
    }

    #[test]
    fn an_empty_list_is_a_real_empty_list() {
        assert_eq!(parse_cloud_list(&json!({ "data": [] })), Some(Vec::new()));
        assert_eq!(parse_cloud_list(&json!([])), Some(Vec::new()));
    }

    #[test]
    fn an_unrecognized_shape_is_none_so_the_caller_degrades() {
        // FR-2: a shape this build cannot read must NOT resolve as "you have no
        // cloud sessions" — that is a lie the user would act on.
        assert_eq!(parse_cloud_list(&json!({ "error": "nope" })), None);
        assert_eq!(parse_cloud_list(&json!("a string")), None);
        assert_eq!(
            parse_cloud_list(&json!({ "data": [ { "no_id_here": 1 } ] })),
            None,
            "a non-empty array that yields nothing is an unread shape, not emptiness"
        );
    }

    // ---- error classification (§7 #4) ----

    #[test]
    fn the_actionable_api_failures_map_to_their_cloud_codes() {
        assert_eq!(
            classify_api_error(403, r#"{"error":{"type":"untrusted_device"}}"#).map(|(c, _)| c),
            Some(ErrorCode::CloudDeviceUntrusted)
        );
        assert_eq!(
            classify_api_error(
                403,
                r#"{"error":{"message":"allow_remote_sessions is disabled"}}"#
            )
            .map(|(c, _)| c),
            Some(ErrorCode::CloudPolicyDenied)
        );
        assert_eq!(
            classify_api_error(401, r#"{"error":{"type":"no_access_token"}}"#).map(|(c, _)| c),
            Some(ErrorCode::CloudAuthRequired)
        );
        // §7 #4: the CLI/API may phrase it as Remote Control — the code is ours,
        // and the message we return must never repeat that phrase.
        let (code, message) =
            classify_api_error(401, "Remote Control session expired").expect("actionable");
        assert_eq!(code, ErrorCode::CloudAuthExpired);
        assert!(
            !message.to_lowercase().contains("remote control"),
            "this feature's UI must never say Remote Control: {message}"
        );
    }

    #[test]
    fn everything_else_degrades_rather_than_erroring() {
        // FR-2: a moved endpoint, a gateway error or a rate limit costs the list,
        // never the feature.
        assert_eq!(classify_api_error(404, "Not Found"), None);
        assert_eq!(classify_api_error(500, "internal"), None);
        assert_eq!(classify_api_error(429, "slow down"), None);
        assert_eq!(classify_api_error(200, ""), None);
    }

    // ---- the non-200 verdict (FR-2 vs. the contract's CLOUD_SESSION_NOT_FOUND) ----

    #[test]
    fn a_404_is_kept_apart_from_the_other_non_200s() {
        // The contract documents CLOUD_SESSION_NOT_FOUND for resolve AND adopt, so
        // "no such session" cannot be folded into FR-2's anonymous degrade — the
        // status has to survive as far as the caller that knows what it asked for.
        assert!(matches!(
            classify_status(404, r#"{"error":{"type":"not_found_error"}}"#),
            CloudFetch::NotFound
        ));
        assert!(matches!(
            classify_status(500, "internal"),
            CloudFetch::Degraded
        ));
        assert!(matches!(
            classify_status(429, "slow down"),
            CloudFetch::Degraded
        ));
        assert!(matches!(
            classify_status(403, r#"{"error":{"type":"untrusted_device"}}"#),
            CloudFetch::Actionable(ErrorCode::CloudDeviceUntrusted, _)
        ));
        // An actionable body wins over the bare status, whatever the status is.
        assert!(matches!(
            classify_status(
                404,
                "your organization has turned allow_remote_sessions off"
            ),
            CloudFetch::Actionable(ErrorCode::CloudPolicyDenied, _)
        ));
    }

    #[test]
    fn the_list_degrades_on_a_404_because_that_endpoint_only_ever_means_moved() {
        // FR-2 is unconditional for the list: a 404 there is a moved endpoint, and
        // reporting "session not found" for a whole collection would be a lie.
        assert_eq!(list_result(CloudFetch::NotFound), Ok(degraded_list()));
        assert_eq!(list_result(CloudFetch::Degraded), Ok(degraded_list()));
        assert_eq!(
            list_result(CloudFetch::Body(json!({ "data": [{ "id": "session_1" }] }))).unwrap(),
            CloudListData {
                sessions: vec![map_cloud_session(&json!({ "id": "session_1" })).unwrap()],
                degraded: false,
            }
        );
        // An unreadable shape is emptiness only in the degraded sense.
        assert_eq!(
            list_result(CloudFetch::Body(json!({ "error": "nope" }))),
            Ok(degraded_list())
        );
        // Only the actionable refusals raise.
        assert_eq!(
            list_result(CloudFetch::Actionable(
                ErrorCode::CloudPolicyDenied,
                POLICY_DENIED_MSG
            )),
            Err(AppError::new(
                ErrorCode::CloudPolicyDenied,
                POLICY_DENIED_MSG
            ))
        );
    }

    // ---- FR-3: the single-session lookup verdict ----

    #[test]
    fn a_lookup_answer_is_reported_under_the_id_the_user_gave() {
        let found = lookup_verdict(
            CloudFetch::Body(json!({ "id": "session_OTHER", "branch": "fix/flake" })),
            "session_01AB",
        );
        match found {
            CloudLookup::Found(s) => {
                assert_eq!(
                    s.id, "session_01AB",
                    "trust the ref over an id we cannot explain"
                );
                assert_eq!(s.branch.as_deref(), Some("fix/flake"));
            }
            other => panic!("expected Found, got {other:?}"),
        }
        // A body nested under `session` is the same answer.
        assert!(matches!(
            lookup_verdict(
                CloudFetch::Body(json!({ "session": { "id": "session_01AB" } })),
                "session_01AB"
            ),
            CloudLookup::Found(_)
        ));
    }

    #[test]
    fn a_lookup_that_does_not_answer_is_unknown_rather_than_a_failure() {
        // FR-3: "a non-200 here resolves the ref with null metadata rather than
        // failing — adoption may still succeed, teleport does its own validation."
        assert!(matches!(
            lookup_verdict(CloudFetch::Degraded, "session_01AB"),
            CloudLookup::Unknown
        ));
        assert!(matches!(
            lookup_verdict(
                CloudFetch::Body(json!({ "unexpected": true })),
                "session_01AB"
            ),
            CloudLookup::Unknown
        ));
        assert!(matches!(
            lookup_verdict(CloudFetch::NotFound, "session_01AB"),
            CloudLookup::NotFound
        ));
        assert!(matches!(
            lookup_verdict(
                CloudFetch::Actionable(ErrorCode::CloudDeviceUntrusted, DEVICE_UNTRUSTED_MSG),
                "session_01AB"
            ),
            CloudLookup::Actionable(ErrorCode::CloudDeviceUntrusted, _)
        ));
    }

    #[test]
    fn resolve_keeps_null_metadata_for_every_failure_but_a_definitive_not_found() {
        // FR-3 again, and the contract's error union for cloud_resolve: the only
        // codes it may raise are INVALID_INPUT, CLOUD_SESSION_NOT_FOUND and the
        // FR-1 auth pair (raised by the token precheck, not here). A 403 device or
        // policy refusal must NOT leak out of resolve — the modal can still adopt.
        for verdict in [
            CloudLookup::Unknown,
            CloudLookup::Actionable(ErrorCode::CloudDeviceUntrusted, DEVICE_UNTRUSTED_MSG),
            CloudLookup::Actionable(ErrorCode::CloudPolicyDenied, POLICY_DENIED_MSG),
            CloudLookup::Actionable(ErrorCode::CloudAuthExpired, AUTH_EXPIRED_MSG),
        ] {
            let session = resolved_session(verdict, "session_01AB").expect("resolves");
            assert_eq!(
                session,
                CloudSession {
                    id: "session_01AB".into(),
                    ..Default::default()
                }
            );
        }
        // A definitive 404 IS the one the contract names.
        let error = resolved_session(CloudLookup::NotFound, "session_01AB").unwrap_err();
        assert_eq!(error.code, ErrorCode::CloudSessionNotFound);
        assert!(
            error.message.contains("no longer exists") || error.message.contains("does not exist"),
            "actionable: {}",
            error.message
        );
    }

    // ---- timestamps ----

    #[test]
    fn rfc3339_timestamps_parse_to_epoch_milliseconds() {
        assert_eq!(rfc3339_to_epoch_ms("1970-01-01T00:00:00.000Z"), Some(0));
        // Cross-checked against the remote-control fixture's own instant:
        // 2026-07-17 is 20,651 days after the epoch.
        let expected = (20_651i64 * 86_400_000 + ((23 * 3600 + 50 * 60 + 32) * 1000) + 944) as u64;
        assert_eq!(
            rfc3339_to_epoch_ms("2026-07-17T23:50:32.944Z"),
            Some(expected)
        );
        // No fraction, and a space separator, both round-trip to the same second.
        assert_eq!(
            rfc3339_to_epoch_ms("2026-07-17T23:50:32Z"),
            Some(expected - 944)
        );
        assert_eq!(
            rfc3339_to_epoch_ms("2026-07-17 23:50:32Z"),
            Some(expected - 944)
        );
        // A numeric offset is applied.
        assert_eq!(
            rfc3339_to_epoch_ms("2026-07-18T01:50:32.944+02:00"),
            Some(expected)
        );
    }

    #[test]
    fn unparseable_timestamps_are_absent_rather_than_zero() {
        assert_eq!(rfc3339_to_epoch_ms("yesterday"), None);
        assert_eq!(rfc3339_to_epoch_ms(""), None);
        assert_eq!(parse_epoch_ms(&json!(null)), None);
        assert_eq!(parse_epoch_ms(&json!("nope")), None);
        assert_eq!(
            parse_epoch_ms(&json!(1_784_573_689u64)),
            Some(1_784_573_689_000)
        );
    }

    // ---- repo matching (FR-3) ----

    #[test]
    fn a_checkout_of_the_same_repository_matches_across_url_forms() {
        assert!(repo_matches("git@github.com:acme/api.git", "acme/api"));
        assert!(repo_matches("https://github.com/acme/api", "acme/api"));
        assert!(repo_matches("https://github.com/acme/api.git", "ACME/API"));
        assert!(repo_matches(
            "https://gitlab.com/acme/api.git",
            "https://github.com/acme/api"
        ));
    }

    #[test]
    fn a_fork_or_a_same_named_directory_does_not_match() {
        // §7 #6: "a checkout of the *same* repository — not a fork".
        assert!(!repo_matches("git@github.com:me/api.git", "acme/api"));
        assert!(!repo_matches("D:\\code\\api", "acme/api"));
        assert!(!repo_matches("", "acme/api"));
        assert!(!repo_matches("git@github.com:acme/api.git", ""));
    }

    #[test]
    fn a_bare_word_is_not_a_repo_slug() {
        assert_eq!(remote_slug("api"), None);
        assert_eq!(remote_slug(""), None);
        assert_eq!(remote_slug("acme/api"), Some("acme/api".to_string()));
    }

    // ---- the endpoints (FR-2/FR-3) ----

    #[test]
    fn the_endpoints_are_the_documented_ones() {
        assert_eq!(
            list_url(),
            "https://api.anthropic.com/v1/code/sessions?limit=100"
        );
        assert_eq!(
            session_url("session_01AB"),
            "https://api.anthropic.com/v1/code/sessions/session_01AB"
        );
    }
}
