//! FR-2 / FR-3 / FR-6 — the two HTTP calls and the assembled `UpdateCheck`.
//!
//! The npm registry is authoritative for the version; GitHub is consulted only
//! for the release body, best-effort, and can never fail the check.

use super::{
    detect_install, is_newer, UpdateCheck, HTTP_TIMEOUT_SECS, REGISTRY_LATEST_URL, REPO,
    UPDATE_COMMAND,
};
use crate::ipc::{AppError, ErrorCode};
use serde_json::Value;
use std::time::Duration;

/// core-architecture-wave3 FR-6: UPDATE_CHECK_FAILED is the one code
/// `app_check_update` stamped on everything this module could fail with —
/// raised at the failure instead, so `run_check` returns the same
/// `Result<T, AppError>` as the rest of the core.
fn check_failed(message: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::UpdateCheckFailed, message)
}

/// FR-1: the same value release.yml's `version` job writes into Cargo.toml, so it
/// always names the build actually running.
pub fn current_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// The human release page for a version. Always populated, whether or not the
/// body was fetched (FR-3).
pub fn notes_url(latest: &str) -> String {
    format!("https://github.com/{REPO}/releases/tag/v{latest}")
}

/// FR-3: the releases API endpoint the body is read from.
pub fn release_api_url(latest: &str) -> String {
    format!("https://api.github.com/repos/{REPO}/releases/tags/v{latest}")
}

/// FR-6: both calls are bounded — a hung registry cannot wedge the command.
fn http_agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(HTTP_TIMEOUT_SECS))
        .timeout_read(Duration::from_secs(HTTP_TIMEOUT_SECS))
        .build()
}

pub fn parse_registry_version(body: &Value) -> Option<String> {
    Some(body.get("version")?.as_str()?.to_string())
}

/// FR-3: `.body` off the release, trimmed. An empty body is ABSENT rather than an
/// empty notes block — the modal shows `Release notes unavailable` either way.
pub fn parse_release_notes(body: &Value) -> Option<String> {
    let text = body.get("body")?.as_str()?.trim();
    (!text.is_empty()).then(|| text.to_string())
}

/// FR-2: the newest version `npm i -g francois@latest` would install. The `Err`
/// message is what `UPDATE_CHECK_FAILED` carries (FR-6).
fn fetch_latest_version() -> Result<String, AppError> {
    let resp = http_agent()
        .get(REGISTRY_LATEST_URL)
        .set("User-Agent", &format!("francois/{}", current_version()))
        .call()
        .map_err(|e| check_failed(registry_call_error(e)))?;
    let json: Value = resp
        .into_json()
        .map_err(|e| check_failed(format!("Could not read the npm registry response: {e}")))?;
    parse_registry_version(&json)
        .ok_or_else(|| check_failed("The npm registry returned no version for francois."))
}

/// FR-6: `ureq::Error::Status` (the registry answered, just not with 2xx) reads
/// very differently from `ureq::Error::Transport` (the registry was never
/// reached at all) — the `UPDATE_CHECK_FAILED` message a user sees should say
/// which one happened rather than blaming reachability for both.
pub fn registry_call_error(e: ureq::Error) -> String {
    match e {
        ureq::Error::Status(code, _) => {
            format!("The npm registry responded with an error (HTTP {code}).")
        }
        ureq::Error::Transport(t) => format!("Could not reach the npm registry: {t}"),
    }
}

/// FR-3: best-effort. A non-200, a timeout, or an unparseable body leaves `notes`
/// absent and MUST NOT fail the check — hence `Option`, never `Result`.
/// Unauthenticated (60 req/h), which the launch+manual cadence never approaches.
fn fetch_release_notes(latest: &str) -> Option<String> {
    let resp = http_agent()
        .get(&release_api_url(latest))
        // GitHub refuses API requests without a User-Agent.
        .set("User-Agent", &format!("francois/{}", current_version()))
        .set("Accept", "application/vnd.github+json")
        .call()
        .ok()?;
    parse_release_notes(&resp.into_json::<Value>().ok()?)
}

/// Everything the check reports besides the two fetches — kept separate so the
/// assembly is proven without the network. `Err` when `latest` is unparseable
/// (FR-4: never `updateAvailable: false`).
pub fn check_from_parts(
    current: &str,
    latest: &str,
    method: &str,
    notes: Option<String>,
    checked_at: u64,
) -> Result<UpdateCheck, AppError> {
    let update_available = is_newer(latest, current).ok_or_else(|| {
        check_failed(format!(
            "The npm registry returned an unreadable version: {latest}"
        ))
    })?;
    Ok(UpdateCheck {
        current: current.to_string(),
        latest: latest.to_string(),
        update_available,
        method: method.to_string(),
        notes,
        notes_url: notes_url(latest),
        command: UPDATE_COMMAND.to_string(),
        checked_at,
    })
}

/// One full check (FR-2, FR-3, FR-4, FR-5, FR-6). Blocking — the commands that
/// call it are `#[tauri::command(async)]`, so this runs off the main thread.
pub fn run_check() -> Result<UpdateCheck, AppError> {
    let latest = fetch_latest_version()?;
    let (method, _) = detect_install();
    // FR-3: the notes fetch happens AFTER the version is known and can only
    // subtract from the result, never fail it.
    let notes = fetch_release_notes(&latest);
    check_from_parts(current_version(), &latest, method, notes, now_ms())
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::super::*;
    use serde_json::json;
    use std::time::Duration;

    // FR-1: the version the build actually carries.
    #[test]
    fn current_version_is_the_cargo_package_version() {
        assert_eq!(current_version(), env!("CARGO_PKG_VERSION"));
    }

    // FR-3: `notesUrl` is the human release page, always populated.
    #[test]
    fn notes_url_points_at_the_tag_release_page() {
        assert_eq!(
            notes_url("0.16.0"),
            "https://github.com/antoine-gmnz/francois/releases/tag/v0.16.0"
        );
    }

    // FR-3: the body comes from the tag endpoint of the releases API.
    #[test]
    fn release_api_url_points_at_the_tag_endpoint() {
        assert_eq!(
            release_api_url("0.16.0"),
            "https://api.github.com/repos/antoine-gmnz/francois/releases/tags/v0.16.0"
        );
    }

    // FR-2: `.version` off `registry.npmjs.org/francois/latest`.
    #[test]
    fn registry_version_is_read_from_the_version_field() {
        assert_eq!(
            parse_registry_version(&json!({ "name": "francois", "version": "0.16.0" })),
            Some("0.16.0".into())
        );
    }

    #[test]
    fn a_registry_body_without_a_version_does_not_parse() {
        assert_eq!(parse_registry_version(&json!({ "name": "francois" })), None);
        assert_eq!(parse_registry_version(&json!({ "version": 16 })), None);
        assert_eq!(parse_registry_version(&json!("0.16.0")), None);
    }

    // FR-3: `.body` off the release, trimmed; an empty or missing body is absent
    // rather than an empty notes block.
    #[test]
    fn release_notes_are_read_from_the_body_field() {
        assert_eq!(
            parse_release_notes(&json!({ "body": "### Fixes\n- a thing\n" })),
            Some("### Fixes\n- a thing".into())
        );
        assert_eq!(parse_release_notes(&json!({ "body": "   " })), None);
        assert_eq!(parse_release_notes(&json!({ "body": null })), None);
        assert_eq!(parse_release_notes(&json!({})), None);
    }

    // FR-2/FR-4: everything the check reports besides the two fetches, so the
    // assembly is proven without the network.
    #[test]
    fn assembles_an_available_update() {
        let check =
            check_from_parts("0.15.8", "0.16.0", METHOD_NPM, Some("notes".into()), 42).unwrap();
        assert!(check.update_available);
        assert_eq!(check.command, "npm i -g francois@latest");
        assert_eq!(
            check.notes_url,
            "https://github.com/antoine-gmnz/francois/releases/tag/v0.16.0"
        );
        assert_eq!(check.notes.as_deref(), Some("notes"));
        assert_eq!(check.checked_at, 42);
        assert_eq!(check.method, "npm");
    }

    #[test]
    fn assembles_an_up_to_date_check() {
        let check = check_from_parts("0.16.0", "0.16.0", METHOD_MANUAL, None, 42).unwrap();
        assert!(!check.update_available);
        assert!(check.notes.is_none());
        // §7: an unavailable notes fetch still leaves the link.
        assert!(check.notes_url.ends_with("/v0.16.0"));
    }

    // FR-4: an unparseable `latest` is a check FAILURE, never `updateAvailable: false`.
    #[test]
    fn an_unparseable_latest_fails_the_check() {
        assert!(check_from_parts("0.15.8", "not-a-version", METHOD_NPM, None, 42).is_err());
        assert!(check_from_parts("0.15.8", "0.16.0", METHOD_NPM, None, 42).is_ok());
    }

    // FR-6: both calls are bounded, so a hung registry cannot wedge the command.
    #[test]
    fn the_http_timeout_is_ten_seconds() {
        assert_eq!(HTTP_TIMEOUT_SECS, 10);
    }

    // FR-6: a non-2xx response is phrased as the registry answering with an
    // error, not as the registry being unreachable.
    #[test]
    fn a_status_error_is_phrased_as_a_registry_error_response() {
        let err = ureq::Error::Status(404, ureq_response_for_test());
        let message = registry_call_error(err);
        assert!(message.contains("HTTP 404"), "{message}");
        assert!(!message.contains("reach"), "{message}");
    }

    // FR-6: a transport-level failure (DNS, connect, timeout) is phrased as
    // unreachable, distinct from an answered-but-erroring registry.
    #[test]
    fn a_transport_error_is_phrased_as_unreachable() {
        let result = ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_millis(50))
            .build()
            .get("http://127.0.0.1:1/")
            .call();
        let err = result.expect_err("connecting to port 1 must fail");
        assert!(matches!(err, ureq::Error::Transport(_)));
        let message = registry_call_error(err);
        assert!(message.contains("Could not reach"), "{message}");
    }

    fn ureq_response_for_test() -> ureq::Response {
        ureq::Response::new(404, "Not Found", "").unwrap()
    }
}
