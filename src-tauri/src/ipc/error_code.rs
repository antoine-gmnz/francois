// core-architecture-wave3 FR-4: THE error-code vocabulary, one variant per
// member of the `ErrorCode` union in `contract/common.ts`. Before this existed
// `AppError.code` was a `String` agreeing with an 82-member TS union by hand,
// across a language boundary, with no compiler, no test and no lint — a typo
// shipped, and a code added on one side only was invisible until a `switch` in
// the frontend silently fell through.
//
// This is the CHECKED side of the mirror. `build.rs` parses the union out of
// `contract/common.ts` into `CONTRACT_ERROR_CODES`, and the parity test below
// asserts the two are the same set (FR-5). The contract is read-only input: if
// the test fails, the fix belongs here, NEVER in `contract/common.ts`.
//
// Serialization is `SCREAMING_SNAKE_CASE` over the PascalCase variant, which
// round-trips the union's spelling exactly (`NotAGitRepo` → `NOT_A_GIT_REPO`,
// `McpError` → `MCP_ERROR`). `as_str` restates that mapping for the callers
// that need a `&str` without going through serde; a test pins the two together
// so they cannot drift.

use serde::Serialize;

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    SessionNotFound,
    SessionNotRunning,
    SessionAlreadyRunning,
    SpawnFailed,
    InvalidInput,
    GitError,
    NotAGitRepo,
    PtyError,
    McpError,
    /// mcp-panel: an interactive spawn (remote-control) would park on the consent/trust dialog (detail: McpApprovalState)
    McpApprovalRequired,
    SkillError,
    AgentNotFound,
    /// CLI companion: no app instance to talk to
    AppNotRunning,
    /// usage bar: the CLI ran but returned no parseable meters
    UsageUnavailable,
    /// session-questions: answer arrived for a question that is not pending
    QuestionNotPending,
    /// permission-guardrails: decision arrived for an ask that is not pending
    PermissionNotPending,
    /// permission-guardrails: settings.json could not be read-merged-written
    SettingsWriteFailed,
    /// permission-guardrails: editor mutation addressed an unknown rule id
    RuleNotFound,
    /// projects: a projectId that is not in the registry
    ProjectNotFound,
    /// projects: another project already owns that normalized root
    ProjectDuplicateRoot,
    /// projects: the project's root no longer exists on disk
    ProjectRootMissing,
    /// projects: CLAUDE.md could not be read-merged-written
    StandardsWriteFailed,
    /// project-groups: a groupId that is not in the registry
    GroupNotFound,
    /// remote-control: the host process died, or published no URL before the deadline
    RemoteControlFailed,
    /// session-worktree: the branch is already checked out at another path (detail: { path })
    WorktreeBranchInUse,
    /// session-worktree: prune/add failed; the core reversed what it did (FR-11)
    WorktreeCreateFailed,
    /// session-worktree: removal refused: uncommitted changes or unpushed commits (FR-19)
    WorktreeDirty,
    /// session-worktree: no worktree registered at that path
    WorktreeNotFound,
    /// session-attachments FR-8: over the 10 MiB cap (detail: { bytes, cap })
    AttachmentTooLarge,
    /// session-attachments FR-8: folders are refused, not walked
    AttachmentIsDirectory,
    /// session-attachments: release addressed an unknown attachment id
    AttachmentNotFound,
    /// session-attachments: copy/write/delete failed (detail: { path })
    AttachmentIoFailed,
    /// multi-account: an accountId that is not in the registry
    AccountNotFound,
    /// multi-account: attempted removal of the built-in 'default' account
    AccountNotRemovable,
    /// multi-account: login identity matches an already-registered account (FR-14)
    AccountDuplicate,
    /// multi-account: login timed out or the PTY exited without an identity (FR-15)
    AccountLoginFailed,
    /// multi-account: a turn's account has no credentials on disk (FR-22)
    AccountNotAuthenticated,
    /// multi-provider-endpoint: the base URL did not answer a usable /models
    AccountEndpointUnreachable,
    /// multi-provider-endpoint: the endpoint rejected the key (401/403)
    AccountEndpointUnauthorized,
    /// multi-provider-endpoint: the key file could not be written or removed
    AccountKeyWriteFailed,
    /// multi-account: npm is not on PATH, so no vendor CLI can be installed from here
    CliInstallUnavailable,
    /// multi-account: `npm i -g <package>` exited non-zero (detail: { code, tail })
    CliInstallFailed,
    /// workflow-details: runId matches no run this session has seen
    WorkflowNotFound,
    /// workflow-details FR-2/FR-7: the run has no usable transcriptDir
    WorkflowNoTranscript,
    /// workflow-details FR-8: agentId matches no agent the scan has seen
    WorkflowAgentNotFound,
    /// workflow-details FR-9: the run has no readable scriptPath
    WorkflowNoScript,
    /// self-update: the npm registry was unreachable or unparseable (FR-6)
    UpdateCheckFailed,
    /// self-update: npm/temp dir/spawn failed, or method is 'manual' (FR-18)
    UpdateApplyFailed,
    /// self-update: sessions are running (detail: { running: number }) (FR-12)
    UpdateBlocked,
    /// open-in-vscode: the requested editorId is not installed (detail: { editorId })
    EditorNotFound,
    /// open-in-vscode: the launcher could not be spawned (detail: { path })
    EditorLaunchFailed,
    /// multiple-shells: no entry for that ShellId (unknown, disposed, or another session's)
    ShellNotFound,
    /// multiple-shells: shell_create at the 6-shell-per-session cap (FR-2)
    ShellLimitReached,
    /// session-engine: the turn died on the plan's usage limit (or an API rate
    /// limit). Carried by `session.error` and NOT terminal — the core sends the
    /// session back to `idle` because the window resets on its own clock and emits
    /// nothing when it does. Consumers must surface it as a transient notice, never
    /// as a dead session.
    UsageLimit,
    /// cloud-sessions FR-1: no claude.ai token; API-key auth is not sufficient (`no_access_token`)
    CloudAuthRequired,
    /// cloud-sessions FR-1: token past `expiresAt`, or the API said so; run a turn or `/login`
    CloudAuthExpired,
    /// cloud-sessions: `untrusted_device`; enrol the device with `/login`
    CloudDeviceUntrusted,
    /// cloud-sessions: the org's `allow_remote_sessions` policy is off
    CloudPolicyDenied,
    /// cloud-sessions: unknown/invalid cloud session id
    CloudSessionNotFound,
    /// cloud-sessions FR-8: teleport's mismatch/not_in_repo/host_unverified (detail: { sessionRepo, currentRepo })
    CloudRepoMismatch,
    /// cloud-sessions FR-8/FR-9: a blocking dialog or the deadline (detail: { phase, logPath? })
    CloudAdoptStalled,
    /// cloud-sessions FR-6: the PTY exited without a usable local session (detail: { logPath? })
    CloudAdoptFailed,
    /// multi-provider-openai: the endpoint errored, or the tool loop hit its cap
    ProviderRequestFailed,
    /// multi-provider-openai: the next request would exceed the model's window
    ProviderContextExceeded,
    /// extensions FR-7: the extension is toggled off; nothing was spawned
    ExtNotEnabled,
    /// extension-install FR-1: the extension's predicate does not hold for that root; when raised because no home directory could be resolved (fleet-scoped panels), detail: { command } per FR-49
    ExtNotDetected,
    /// extension-install FR-12: a panelId that is not in the manifest-derived registry
    ExtPanelNotFound,
    /// extensions FR-24: the binary could not be spawned (detail: { argv0, command })
    ExtProviderMissing,
    /// extensions FR-21: killed at 10s (detail: { timeoutMs, command })
    ExtProviderTimeout,
    /// extensions FR-24: non-zero exit (detail: { code, stderr, command })
    ExtProviderExit,
    /// extensions FR-25: stdout did not validate; nothing was rendered
    ExtSchemaInvalid,
    /// extensions FR-22: killed past 4 MiB (detail: { capBytes, command })
    ExtOutputCapped,
    /// extensions FR-39: a log-tail file source escaped its declared root
    ExtPathOutsideRoot,
    /// extensions FR-38: the token slot failed its charset/length rule
    ExtInvalidToken,
    /// extensions: closeStream addressed an unknown or already-ended stream
    ExtStreamNotFound,
    /// extension-install FR-6: schema failure; detail: { pointer, expected, manifestPath }
    ExtManifestInvalid,
    /// extension-install FR-5: unknown `manifest` version; detail: { found, supported }
    ExtManifestUnsupported,
    /// extension-install FR-17: enable/spawn refused before consent
    ExtNotConsented,
    /// extension-install FR-18: the manifest changed under the dialog
    ExtConsentStale,
    /// session-profiles: a profileId that is not in the registry
    ProfileNotFound,
    /// session-profiles: extraArgs carried a denied flag (detail: { flag, reason })
    ProfileArgDenied,
    Internal,
}

impl ErrorCode {
    /// Every variant, in contract order. Used by the parity test, and by any
    /// caller that needs to enumerate the vocabulary.
    pub const ALL: &'static [ErrorCode] = &[
        ErrorCode::SessionNotFound,
        ErrorCode::SessionNotRunning,
        ErrorCode::SessionAlreadyRunning,
        ErrorCode::SpawnFailed,
        ErrorCode::InvalidInput,
        ErrorCode::GitError,
        ErrorCode::NotAGitRepo,
        ErrorCode::PtyError,
        ErrorCode::McpError,
        ErrorCode::McpApprovalRequired,
        ErrorCode::SkillError,
        ErrorCode::AgentNotFound,
        ErrorCode::AppNotRunning,
        ErrorCode::UsageUnavailable,
        ErrorCode::QuestionNotPending,
        ErrorCode::PermissionNotPending,
        ErrorCode::SettingsWriteFailed,
        ErrorCode::RuleNotFound,
        ErrorCode::ProjectNotFound,
        ErrorCode::ProjectDuplicateRoot,
        ErrorCode::ProjectRootMissing,
        ErrorCode::StandardsWriteFailed,
        ErrorCode::GroupNotFound,
        ErrorCode::RemoteControlFailed,
        ErrorCode::WorktreeBranchInUse,
        ErrorCode::WorktreeCreateFailed,
        ErrorCode::WorktreeDirty,
        ErrorCode::WorktreeNotFound,
        ErrorCode::AttachmentTooLarge,
        ErrorCode::AttachmentIsDirectory,
        ErrorCode::AttachmentNotFound,
        ErrorCode::AttachmentIoFailed,
        ErrorCode::AccountNotFound,
        ErrorCode::AccountNotRemovable,
        ErrorCode::AccountDuplicate,
        ErrorCode::AccountLoginFailed,
        ErrorCode::AccountNotAuthenticated,
        ErrorCode::AccountEndpointUnreachable,
        ErrorCode::AccountEndpointUnauthorized,
        ErrorCode::AccountKeyWriteFailed,
        ErrorCode::CliInstallUnavailable,
        ErrorCode::CliInstallFailed,
        ErrorCode::WorkflowNotFound,
        ErrorCode::WorkflowNoTranscript,
        ErrorCode::WorkflowAgentNotFound,
        ErrorCode::WorkflowNoScript,
        ErrorCode::UpdateCheckFailed,
        ErrorCode::UpdateApplyFailed,
        ErrorCode::UpdateBlocked,
        ErrorCode::EditorNotFound,
        ErrorCode::EditorLaunchFailed,
        ErrorCode::ShellNotFound,
        ErrorCode::ShellLimitReached,
        ErrorCode::UsageLimit,
        ErrorCode::CloudAuthRequired,
        ErrorCode::CloudAuthExpired,
        ErrorCode::CloudDeviceUntrusted,
        ErrorCode::CloudPolicyDenied,
        ErrorCode::CloudSessionNotFound,
        ErrorCode::CloudRepoMismatch,
        ErrorCode::CloudAdoptStalled,
        ErrorCode::CloudAdoptFailed,
        ErrorCode::ProviderRequestFailed,
        ErrorCode::ProviderContextExceeded,
        ErrorCode::ExtNotEnabled,
        ErrorCode::ExtNotDetected,
        ErrorCode::ExtPanelNotFound,
        ErrorCode::ExtProviderMissing,
        ErrorCode::ExtProviderTimeout,
        ErrorCode::ExtProviderExit,
        ErrorCode::ExtSchemaInvalid,
        ErrorCode::ExtOutputCapped,
        ErrorCode::ExtPathOutsideRoot,
        ErrorCode::ExtInvalidToken,
        ErrorCode::ExtStreamNotFound,
        ErrorCode::ExtManifestInvalid,
        ErrorCode::ExtManifestUnsupported,
        ErrorCode::ExtNotConsented,
        ErrorCode::ExtConsentStale,
        ErrorCode::ProfileNotFound,
        ErrorCode::ProfileArgDenied,
        ErrorCode::Internal,
    ];

    /// The wire spelling — identical to what `Serialize` produces (pinned by
    /// `as_str_matches_serde` below).
    pub fn as_str(self) -> &'static str {
        match self {
            ErrorCode::SessionNotFound => "SESSION_NOT_FOUND",
            ErrorCode::SessionNotRunning => "SESSION_NOT_RUNNING",
            ErrorCode::SessionAlreadyRunning => "SESSION_ALREADY_RUNNING",
            ErrorCode::SpawnFailed => "SPAWN_FAILED",
            ErrorCode::InvalidInput => "INVALID_INPUT",
            ErrorCode::GitError => "GIT_ERROR",
            ErrorCode::NotAGitRepo => "NOT_A_GIT_REPO",
            ErrorCode::PtyError => "PTY_ERROR",
            ErrorCode::McpError => "MCP_ERROR",
            ErrorCode::McpApprovalRequired => "MCP_APPROVAL_REQUIRED",
            ErrorCode::SkillError => "SKILL_ERROR",
            ErrorCode::AgentNotFound => "AGENT_NOT_FOUND",
            ErrorCode::AppNotRunning => "APP_NOT_RUNNING",
            ErrorCode::UsageUnavailable => "USAGE_UNAVAILABLE",
            ErrorCode::QuestionNotPending => "QUESTION_NOT_PENDING",
            ErrorCode::PermissionNotPending => "PERMISSION_NOT_PENDING",
            ErrorCode::SettingsWriteFailed => "SETTINGS_WRITE_FAILED",
            ErrorCode::RuleNotFound => "RULE_NOT_FOUND",
            ErrorCode::ProjectNotFound => "PROJECT_NOT_FOUND",
            ErrorCode::ProjectDuplicateRoot => "PROJECT_DUPLICATE_ROOT",
            ErrorCode::ProjectRootMissing => "PROJECT_ROOT_MISSING",
            ErrorCode::StandardsWriteFailed => "STANDARDS_WRITE_FAILED",
            ErrorCode::GroupNotFound => "GROUP_NOT_FOUND",
            ErrorCode::RemoteControlFailed => "REMOTE_CONTROL_FAILED",
            ErrorCode::WorktreeBranchInUse => "WORKTREE_BRANCH_IN_USE",
            ErrorCode::WorktreeCreateFailed => "WORKTREE_CREATE_FAILED",
            ErrorCode::WorktreeDirty => "WORKTREE_DIRTY",
            ErrorCode::WorktreeNotFound => "WORKTREE_NOT_FOUND",
            ErrorCode::AttachmentTooLarge => "ATTACHMENT_TOO_LARGE",
            ErrorCode::AttachmentIsDirectory => "ATTACHMENT_IS_DIRECTORY",
            ErrorCode::AttachmentNotFound => "ATTACHMENT_NOT_FOUND",
            ErrorCode::AttachmentIoFailed => "ATTACHMENT_IO_FAILED",
            ErrorCode::AccountNotFound => "ACCOUNT_NOT_FOUND",
            ErrorCode::AccountNotRemovable => "ACCOUNT_NOT_REMOVABLE",
            ErrorCode::AccountDuplicate => "ACCOUNT_DUPLICATE",
            ErrorCode::AccountLoginFailed => "ACCOUNT_LOGIN_FAILED",
            ErrorCode::AccountNotAuthenticated => "ACCOUNT_NOT_AUTHENTICATED",
            ErrorCode::AccountEndpointUnreachable => "ACCOUNT_ENDPOINT_UNREACHABLE",
            ErrorCode::AccountEndpointUnauthorized => "ACCOUNT_ENDPOINT_UNAUTHORIZED",
            ErrorCode::AccountKeyWriteFailed => "ACCOUNT_KEY_WRITE_FAILED",
            ErrorCode::CliInstallUnavailable => "CLI_INSTALL_UNAVAILABLE",
            ErrorCode::CliInstallFailed => "CLI_INSTALL_FAILED",
            ErrorCode::WorkflowNotFound => "WORKFLOW_NOT_FOUND",
            ErrorCode::WorkflowNoTranscript => "WORKFLOW_NO_TRANSCRIPT",
            ErrorCode::WorkflowAgentNotFound => "WORKFLOW_AGENT_NOT_FOUND",
            ErrorCode::WorkflowNoScript => "WORKFLOW_NO_SCRIPT",
            ErrorCode::UpdateCheckFailed => "UPDATE_CHECK_FAILED",
            ErrorCode::UpdateApplyFailed => "UPDATE_APPLY_FAILED",
            ErrorCode::UpdateBlocked => "UPDATE_BLOCKED",
            ErrorCode::EditorNotFound => "EDITOR_NOT_FOUND",
            ErrorCode::EditorLaunchFailed => "EDITOR_LAUNCH_FAILED",
            ErrorCode::ShellNotFound => "SHELL_NOT_FOUND",
            ErrorCode::ShellLimitReached => "SHELL_LIMIT_REACHED",
            ErrorCode::UsageLimit => "USAGE_LIMIT",
            ErrorCode::CloudAuthRequired => "CLOUD_AUTH_REQUIRED",
            ErrorCode::CloudAuthExpired => "CLOUD_AUTH_EXPIRED",
            ErrorCode::CloudDeviceUntrusted => "CLOUD_DEVICE_UNTRUSTED",
            ErrorCode::CloudPolicyDenied => "CLOUD_POLICY_DENIED",
            ErrorCode::CloudSessionNotFound => "CLOUD_SESSION_NOT_FOUND",
            ErrorCode::CloudRepoMismatch => "CLOUD_REPO_MISMATCH",
            ErrorCode::CloudAdoptStalled => "CLOUD_ADOPT_STALLED",
            ErrorCode::CloudAdoptFailed => "CLOUD_ADOPT_FAILED",
            ErrorCode::ProviderRequestFailed => "PROVIDER_REQUEST_FAILED",
            ErrorCode::ProviderContextExceeded => "PROVIDER_CONTEXT_EXCEEDED",
            ErrorCode::ExtNotEnabled => "EXT_NOT_ENABLED",
            ErrorCode::ExtNotDetected => "EXT_NOT_DETECTED",
            ErrorCode::ExtPanelNotFound => "EXT_PANEL_NOT_FOUND",
            ErrorCode::ExtProviderMissing => "EXT_PROVIDER_MISSING",
            ErrorCode::ExtProviderTimeout => "EXT_PROVIDER_TIMEOUT",
            ErrorCode::ExtProviderExit => "EXT_PROVIDER_EXIT",
            ErrorCode::ExtSchemaInvalid => "EXT_SCHEMA_INVALID",
            ErrorCode::ExtOutputCapped => "EXT_OUTPUT_CAPPED",
            ErrorCode::ExtPathOutsideRoot => "EXT_PATH_OUTSIDE_ROOT",
            ErrorCode::ExtInvalidToken => "EXT_INVALID_TOKEN",
            ErrorCode::ExtStreamNotFound => "EXT_STREAM_NOT_FOUND",
            ErrorCode::ExtManifestInvalid => "EXT_MANIFEST_INVALID",
            ErrorCode::ExtManifestUnsupported => "EXT_MANIFEST_UNSUPPORTED",
            ErrorCode::ExtNotConsented => "EXT_NOT_CONSENTED",
            ErrorCode::ExtConsentStale => "EXT_CONSENT_STALE",
            ErrorCode::ProfileNotFound => "PROFILE_NOT_FOUND",
            ErrorCode::ProfileArgDenied => "PROFILE_ARG_DENIED",
            ErrorCode::Internal => "INTERNAL",
        }
    }
}

impl std::fmt::Display for ErrorCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::ErrorCode;
    use std::collections::BTreeSet;

    // core-architecture-wave3 FR-5: the generated side, parsed out of
    // `contract/common.ts` by build.rs on every build.
    include!(concat!(env!("OUT_DIR"), "/contract_error_codes.rs"));

    #[test]
    fn as_str_matches_serde() {
        for code in ErrorCode::ALL {
            let serialized = serde_json::to_value(code).expect("serialize ErrorCode");
            assert_eq!(
                serialized.as_str(),
                Some(code.as_str()),
                "as_str and Serialize disagree for {code:?}"
            );
        }
    }

    #[test]
    fn every_variant_is_listed_in_all() {
        // `ALL` is hand-maintained, so a variant added without touching it
        // would silently escape the parity test below. Distinct wire names is
        // the cheap proxy for "no duplicates, none missing" — combined with
        // the parity test's exact-set assertion, a forgotten entry fails.
        let unique: BTreeSet<&str> = ErrorCode::ALL.iter().map(|c| c.as_str()).collect();
        assert_eq!(
            unique.len(),
            ErrorCode::ALL.len(),
            "duplicate entry in ErrorCode::ALL"
        );
    }

    /// FR-5: the Rust enum and the TS union must be the SAME SET. This test is
    /// the thing that fails when a variant is added on one side only.
    #[test]
    fn rust_enum_matches_the_contract_union() {
        let rust: BTreeSet<&str> = ErrorCode::ALL.iter().map(|c| c.as_str()).collect();
        let contract: BTreeSet<&str> = CONTRACT_ERROR_CODES.iter().copied().collect();

        let missing_in_rust: Vec<&&str> = contract.difference(&rust).collect();
        let missing_in_contract: Vec<&&str> = rust.difference(&contract).collect();

        assert!(
            missing_in_rust.is_empty(),
            "contract/common.ts declares codes the Rust enum does not: {missing_in_rust:?} — \
             add the variant to ErrorCode (never delete it from the contract)"
        );
        assert!(
            missing_in_contract.is_empty(),
            "the Rust enum declares codes contract/common.ts does not: {missing_in_contract:?} — \
             the contract is read-only input; remove the variant or land the union change in its \
             own feature first"
        );
    }
}
