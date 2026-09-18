// Shared Result<T> envelope (matches contract/common.ts `Result` / `AppError`).
// Every Tauri command in Francois RESOLVES one of these — it never rejects
// across the bridge, so the frontend always gets `{ ok, ... }`.

use serde::ser::SerializeStruct;
use serde::{Serialize, Serializer};
use serde_json::Value;

/// Sanitised runtime failure metadata. Provider payloads and credentials never
/// cross this boundary; correlation ids are optional and core-minted.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct RuntimeFailure {
    origin: String,
    code: String,
    message: String,
    retryable: bool,
    #[serde(rename = "requestId", skip_serializing_if = "Option::is_none")]
    request_id: Option<String>,
    #[serde(rename = "toolCallId", skip_serializing_if = "Option::is_none")]
    tool_call_id: Option<String>,
}

// `Debug`/`PartialEq` so a domain that carries an AppError INSIDE an event
// payload (extensions' `ext.stream.error`) can derive them on the union.
#[derive(Clone, Debug, PartialEq)]
pub struct AppError {
    pub code: String,
    pub message: String,
    pub detail: Option<Box<Value>>,
    pub runtime_failure: Option<Box<RuntimeFailure>>,
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let is_runtime = self.runtime_failure.is_some();
        let mut state = serializer.serialize_struct(
            "AppError",
            2 + usize::from(self.detail.is_some()) + usize::from(is_runtime),
        )?;
        state.serialize_field("code", &self.code)?;
        state.serialize_field("message", &self.message)?;
        if let Some(detail) = &self.detail {
            state.serialize_field("detail", detail)?;
        }
        if let Some(failure) = &self.runtime_failure {
            state.serialize_field("runtimeFailure", failure)?;
        }
        state.end()
    }
}

pub(crate) fn valid_correlation(id: &str) -> bool {
    uuid::Uuid::parse_str(id).is_ok_and(|id| id.get_version_num() == 4)
}
pub(crate) const MAX_RUNTIME_MESSAGE_BYTES: usize = 1024;
pub(crate) const MAX_CAPABILITY_REASON_BYTES: usize = 512;
pub(crate) fn safe_display(text: &str, bound: usize) -> bool {
    !text.trim().is_empty()
        && text.len() <= bound
        && !text.chars().any(|c| {
            c.is_control() || matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        })
}
#[allow(dead_code)]
fn valid_error_code(code: &str) -> bool {
    matches!(
        code,
        "SESSION_NOT_FOUND"
            | "SESSION_NOT_RUNNING"
            | "SESSION_ALREADY_RUNNING"
            | "SPAWN_FAILED"
            | "INVALID_INPUT"
            | "GIT_ERROR"
            | "NOT_A_GIT_REPO"
            | "PTY_ERROR"
            | "MCP_ERROR"
            | "MCP_APPROVAL_REQUIRED"
            | "SKILL_ERROR"
            | "AGENT_NOT_FOUND"
            | "APP_NOT_RUNNING"
            | "USAGE_UNAVAILABLE"
            | "QUESTION_NOT_PENDING"
            | "PERMISSION_NOT_PENDING"
            | "SETTINGS_WRITE_FAILED"
            | "RULE_NOT_FOUND"
            | "PROJECT_NOT_FOUND"
            | "PROJECT_DUPLICATE_ROOT"
            | "PROJECT_ROOT_MISSING"
            | "STANDARDS_WRITE_FAILED"
            | "GROUP_NOT_FOUND"
            | "REMOTE_CONTROL_FAILED"
            | "WORKTREE_BRANCH_IN_USE"
            | "WORKTREE_CREATE_FAILED"
            | "WORKTREE_DIRTY"
            | "WORKTREE_NOT_FOUND"
            | "ATTACHMENT_TOO_LARGE"
            | "ATTACHMENT_IS_DIRECTORY"
            | "ATTACHMENT_NOT_FOUND"
            | "ATTACHMENT_IO_FAILED"
            | "ACCOUNT_NOT_FOUND"
            | "ACCOUNT_NOT_REMOVABLE"
            | "ACCOUNT_DUPLICATE"
            | "ACCOUNT_LOGIN_FAILED"
            | "ACCOUNT_NOT_AUTHENTICATED"
            | "ACCOUNT_ENDPOINT_UNREACHABLE"
            | "ACCOUNT_ENDPOINT_UNAUTHORIZED"
            | "ACCOUNT_KEY_WRITE_FAILED"
            | "CLI_INSTALL_UNAVAILABLE"
            | "CLI_INSTALL_FAILED"
            | "WORKFLOW_NOT_FOUND"
            | "WORKFLOW_NO_TRANSCRIPT"
            | "WORKFLOW_AGENT_NOT_FOUND"
            | "WORKFLOW_NO_SCRIPT"
            | "UPDATE_CHECK_FAILED"
            | "UPDATE_APPLY_FAILED"
            | "UPDATE_BLOCKED"
            | "EDITOR_NOT_FOUND"
            | "EDITOR_LAUNCH_FAILED"
            | "SHELL_NOT_FOUND"
            | "SHELL_LIMIT_REACHED"
            | "USAGE_LIMIT"
            | "CLOUD_AUTH_REQUIRED"
            | "CLOUD_AUTH_EXPIRED"
            | "CLOUD_DEVICE_UNTRUSTED"
            | "CLOUD_POLICY_DENIED"
            | "CLOUD_SESSION_NOT_FOUND"
            | "CLOUD_REPO_MISMATCH"
            | "CLOUD_ADOPT_STALLED"
            | "CLOUD_ADOPT_FAILED"
            | "PROVIDER_REQUEST_FAILED"
            | "PROVIDER_CONTEXT_EXCEEDED"
            | "EXT_NOT_ENABLED"
            | "EXT_NOT_DETECTED"
            | "EXT_PANEL_NOT_FOUND"
            | "EXT_PROVIDER_MISSING"
            | "EXT_PROVIDER_TIMEOUT"
            | "EXT_PROVIDER_EXIT"
            | "EXT_SCHEMA_INVALID"
            | "EXT_OUTPUT_CAPPED"
            | "EXT_PATH_OUTSIDE_ROOT"
            | "EXT_INVALID_TOKEN"
            | "EXT_STREAM_NOT_FOUND"
            | "EXT_MANIFEST_INVALID"
            | "EXT_MANIFEST_UNSUPPORTED"
            | "EXT_NOT_CONSENTED"
            | "EXT_CONSENT_STALE"
            | "PROFILE_NOT_FOUND"
            | "PROFILE_ARG_DENIED"
            | "RUNTIME_UNAVAILABLE"
            | "STEP_DETAIL_NOT_FOUND"
            | "RUNTIME_INCOMPATIBLE"
            | "RUNTIME_PROTOCOL_ERROR"
            | "RUNTIME_TIMEOUT"
            | "RUNTIME_EXITED"
            | "RUNTIME_UNSUPPORTED"
            | "PROVIDER_AUTH_FAILED"
            | "PROVIDER_UNAVAILABLE"
            | "MODEL_UNAVAILABLE"
            | "TOOL_FAILED"
            | "INTERNAL"
    )
}
#[derive(Clone, Copy)]
pub(crate) enum RuntimeErrorCode {
    NotFound,
    InvalidInput,
    Unavailable,
    Unsupported,
}
impl RuntimeErrorCode {
    fn as_str(self) -> &'static str {
        match self {
            Self::NotFound => "SESSION_NOT_FOUND",
            Self::InvalidInput => "INVALID_INPUT",
            Self::Unavailable => "RUNTIME_UNAVAILABLE",
            Self::Unsupported => "RUNTIME_UNSUPPORTED",
        }
    }
}
impl RuntimeFailure {
    /// The sanitized, already-validated display message — read back by the
    /// session engine when a `failure` runtime event settles a session onto
    /// `status::ERROR` (pi-runtime-boundary).
    pub(crate) fn message(&self) -> &str {
        &self.message
    }
    #[allow(dead_code)]
    pub fn validated(
        origin: &str,
        code: &str,
        message: &str,
        retryable: bool,
        request_id: Option<&str>,
        tool_call_id: Option<&str>,
    ) -> Result<Self, &'static str> {
        if !matches!(origin, "application" | "runtime" | "provider" | "tool") {
            return Err("invalid failure origin");
        }
        if !valid_error_code(code) || !safe_display(message, MAX_RUNTIME_MESSAGE_BYTES) {
            return Err("empty failure");
        }
        Ok(Self {
            origin: origin.into(),
            code: code.into(),
            message: message.into(),
            retryable,
            request_id: request_id
                .filter(|v| valid_correlation(v))
                .map(str::to_owned),
            tool_call_id: tool_call_id
                .filter(|v| valid_correlation(v))
                .map(str::to_owned),
        })
    }
}
impl AppError {
    pub fn with_runtime_failure(failure: RuntimeFailure) -> Self {
        Self {
            code: failure.code.clone(),
            message: failure.message.clone(),
            detail: None,
            runtime_failure: Some(Box::new(failure)),
        }
    }
    pub(crate) fn runtime(code: RuntimeErrorCode, message: &'static str) -> Self {
        // Core call sites supply static copy; normalize it so construction cannot panic.
        let message: String = message
            .chars()
            .filter(|c| {
                !c.is_control() && !matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
            })
            .scan(0usize, |n, c| {
                *n += c.len_utf8();
                (*n <= MAX_RUNTIME_MESSAGE_BYTES).then_some(c)
            })
            .collect();
        Self::with_runtime_failure(RuntimeFailure {
            origin: "runtime".into(),
            code: code.as_str().into(),
            message: if message.trim().is_empty() {
                "Runtime failure".into()
            } else {
                message
            },
            retryable: false,
            request_id: None,
            tool_call_id: None,
        })
    }
}

#[derive(Serialize)]
#[serde(untagged)]
pub enum IpcResult<T: Serialize> {
    Ok { ok: bool, data: T },
    Err { ok: bool, error: AppError },
}

pub fn ok<T: Serialize>(data: T) -> IpcResult<T> {
    IpcResult::Ok { ok: true, data }
}

pub fn err<T: Serialize>(code: &str, message: impl Into<String>) -> IpcResult<T> {
    IpcResult::Err {
        ok: false,
        error: AppError {
            code: code.into(),
            message: message.into(),
            detail: None,

            runtime_failure: None,
        },
    }
}

/// session-worktree FR-11 (WORKTREE_BRANCH_IN_USE detail: `{ path }`) — an error
/// with a machine-readable `detail` payload alongside the human message.
pub fn err_detail<T: Serialize>(
    code: &str,
    message: impl Into<String>,
    detail: Value,
) -> IpcResult<T> {
    IpcResult::Err {
        ok: false,
        error: AppError {
            code: code.into(),
            message: message.into(),
            detail: Some(Box::new(detail)),

            runtime_failure: None,
        },
    }
}

#[cfg(test)]
mod runtime_tests {
    use super::*;
    #[test]
    fn validator_accepts_every_canonical_error_code() {
        let contract = include_str!("../../contract/common.ts");
        let codes = contract
            .split("export type ErrorCode =")
            .nth(1)
            .unwrap()
            .split("// ---------- sessions")
            .next()
            .unwrap();
        let mut count = 0;
        for line in codes.lines() {
            let Some(member) = line.trim().strip_prefix("| '") else {
                continue;
            };
            let code = member.split('\'').next().unwrap();
            assert!(
                RuntimeFailure::validated("runtime", code, "safe", false, None, None).is_ok(),
                "{code}"
            );
            count += 1;
        }
        assert!(count > 0);
    }
    #[test]
    fn failures_reject_unknown_codes_and_unsafe_or_oversized_display_text() {
        for (code, message) in [
            ("SECRET_CODE", "safe"),
            ("INTERNAL", "bad\ntext"),
            ("INTERNAL", "\u{202e}hidden"),
        ] {
            assert!(
                RuntimeFailure::validated("runtime", code, message, false, None, None).is_err()
            );
        }
        assert!(RuntimeFailure::validated(
            "runtime",
            "INTERNAL",
            &"\u{e9}".repeat(513),
            false,
            None,
            None
        )
        .is_err());
    }
    #[test]
    fn runtime_failure_keeps_origin_retryability_and_safe_correlation() {
        for origin in ["application", "runtime", "provider", "tool"] {
            let f = RuntimeFailure::validated(
                origin,
                "RUNTIME_EXITED",
                "stopped",
                true,
                Some("unsafe\nsecret"),
                None,
            )
            .unwrap();
            let error = AppError::with_runtime_failure(f.clone());
            let v = serde_json::to_value(error).unwrap();
            assert_eq!(v["runtimeFailure"]["origin"], origin);
            assert_eq!(v["runtimeFailure"]["retryable"], true);
            assert!(v["runtimeFailure"].get("requestId").is_none());
        }
        assert!(
            RuntimeFailure::validated("wire", "RUNTIME_EXITED", "stopped", false, None, None)
                .is_err()
        );
    }
    #[test]
    fn message_accessor_returns_the_validated_display_text() {
        let f = RuntimeFailure::validated(
            "runtime",
            "RUNTIME_EXITED",
            "the child exited",
            false,
            None,
            None,
        )
        .unwrap();
        assert_eq!(f.message(), "the child exited");
    }
}
