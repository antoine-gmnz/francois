// contract/error-code.ts — the ErrorCode vocabulary, split out of common.ts (which re-exports
// it) so the shared-vocabulary file stays under the 1000-line cap. Same rules as common.ts:
// feature contracts never redefine it; a feature adds its codes HERE, one per line, with a
// comment naming the feature. src-tauri/build.rs parses this union for the Rust parity test.

export type ErrorCode =
  | 'SESSION_NOT_FOUND'
  | 'SESSION_NOT_RUNNING'
  | 'SESSION_ALREADY_RUNNING'
  | 'SPAWN_FAILED'
  | 'MODEL_CATALOG_UNAVAILABLE' // codex-model-catalog: detail is ModelCatalogFailureDetail
  | 'INVALID_INPUT'
  | 'GIT_ERROR'
  | 'NOT_A_GIT_REPO'
  | 'PTY_ERROR'
  | 'MCP_ERROR'
  | 'MCP_APPROVAL_REQUIRED' // mcp-panel: an interactive spawn (remote-control) would park on the consent/trust dialog (detail: McpApprovalState)
  | 'SKILL_ERROR'
  | 'AGENT_NOT_FOUND'
  | 'APP_NOT_RUNNING' // CLI companion: no app instance to talk to
  | 'USAGE_UNAVAILABLE' // usage bar: the CLI ran but returned no parseable meters
  | 'QUESTION_NOT_PENDING' // session-questions: answer arrived for a question that is not pending
  | 'PERMISSION_NOT_PENDING' // permission-guardrails: decision arrived for an ask that is not pending
  | 'SETTINGS_WRITE_FAILED' // permission-guardrails: settings.json could not be read-merged-written
  | 'RULE_NOT_FOUND' // permission-guardrails: editor mutation addressed an unknown rule id
  | 'PROJECT_NOT_FOUND' // projects: a projectId that is not in the registry
  | 'PROJECT_DUPLICATE_ROOT' // projects: another project already owns that normalized root
  | 'PROJECT_ROOT_MISSING' // projects: the project's root no longer exists on disk
  | 'STANDARDS_WRITE_FAILED' // projects: CLAUDE.md could not be read-merged-written
  | 'GROUP_NOT_FOUND' // project-groups: a groupId that is not in the registry
  | 'REMOTE_CONTROL_FAILED' // remote-control: the host process died, or published no URL before the deadline
  | 'WORKTREE_BRANCH_IN_USE' // session-worktree: the branch is already checked out at another path (detail: { path })
  | 'WORKTREE_CREATE_FAILED' // session-worktree: prune/add failed; the core reversed what it did (FR-11)
  | 'WORKTREE_DIRTY' // session-worktree: removal refused: uncommitted changes or unpushed commits (FR-19)
  | 'WORKTREE_NOT_FOUND' // session-worktree: no worktree registered at that path
  | 'ATTACHMENT_TOO_LARGE' // session-attachments FR-8: over the 10 MiB cap (detail: { bytes, cap })
  | 'ATTACHMENT_IS_DIRECTORY' // session-attachments FR-8: folders are refused, not walked
  | 'ATTACHMENT_NOT_FOUND' // session-attachments: release addressed an unknown attachment id
  | 'ATTACHMENT_IO_FAILED' // session-attachments: copy/write/delete failed (detail: { path })
  | 'ACCOUNT_NOT_FOUND' // multi-account: an accountId that is not in the registry
  | 'ACCOUNT_NOT_REMOVABLE' // multi-account: attempted removal of the built-in 'default' account
  | 'ACCOUNT_DUPLICATE' // multi-account: login identity matches an already-registered account (FR-14)
  | 'ACCOUNT_LOGIN_FAILED' // multi-account: login timed out or the PTY exited without an identity (FR-15)
  | 'ACCOUNT_NOT_AUTHENTICATED' // multi-account: a turn's account has no credentials on disk (FR-22)
  | 'ACCOUNT_ENDPOINT_UNREACHABLE' // multi-provider-endpoint: the base URL did not answer a usable /models
  | 'ACCOUNT_ENDPOINT_UNAUTHORIZED' // multi-provider-endpoint: the endpoint rejected the key (401/403)
  | 'ACCOUNT_KEY_WRITE_FAILED' // multi-provider-endpoint: the key file could not be written or removed
  | 'ACCOUNT_IN_USE' // pi-provider-auth: trust/remove refused while a session or setup PTY holds the account
  | 'ACCOUNT_CONFIG_UNTRUSTED' // pi-provider-auth: a Pi account's configDir was never explicitly trusted
  | 'ACCOUNT_CONFIG_CHANGED' // pi-provider-auth FR-4: the trusted executable-config fingerprint no longer matches
  | 'CLI_INSTALL_UNAVAILABLE' // multi-account: npm is not on PATH, so no vendor CLI can be installed from here
  | 'CLI_INSTALL_FAILED' // multi-account: `npm i -g <package>` exited non-zero (detail: { code, tail })
  | 'WORKFLOW_NOT_FOUND' // workflow-details: runId matches no run this session has seen
  | 'WORKFLOW_NO_TRANSCRIPT' // workflow-details FR-2/FR-7: the run has no usable transcriptDir
  | 'WORKFLOW_AGENT_NOT_FOUND' // workflow-details FR-8: agentId matches no agent the scan has seen
  | 'WORKFLOW_NO_SCRIPT' // workflow-details FR-9: the run has no readable scriptPath
  | 'UPDATE_CHECK_FAILED' // self-update: the npm registry was unreachable or unparseable (FR-6)
  | 'UPDATE_APPLY_FAILED' // self-update: npm/temp dir/spawn failed, or method is 'manual' (FR-18)
  | 'UPDATE_BLOCKED' // self-update: sessions are running (detail: { running: number }) (FR-12)
  | 'LSP_NOT_INSTALLED' // code-editor-lsp FR-2: no server binary for the language (detail: { installHint })
  | 'LSP_UNTRUSTED' // code-editor-lsp FR-4: the root was never allowed to run language servers
  | 'LSP_NOT_RUNNING' // code-editor-lsp: request/notify for a server that is not starting/ready
  | 'LSP_METHOD_NOT_ALLOWED' // code-editor-lsp FR-3: method outside the allowlists (detail: { method })
  | 'LSP_REQUEST_FAILED' // code-editor-lsp: JSON-RPC error, timeout or cancel (detail: { code, message })
  | 'EDITOR_NOT_FOUND' // open-in-vscode: the requested editorId is not installed (detail: { editorId })
  | 'EDITOR_LAUNCH_FAILED' // open-in-vscode: the launcher could not be spawned (detail: { path })
  | 'EDITOR_OUTSIDE_ROOT' // code-editor: path escapes the root (incl. via symlink) or targets .git/
  | 'EDITOR_FILE_NOT_FOUND' // code-editor: no such file under the root
  | 'EDITOR_BINARY' // code-editor FR-8: NUL in the first 8 KiB, or not valid UTF-8
  | 'EDITOR_TOO_LARGE' // code-editor FR-8: over 10 MiB (detail: { size })
  | 'EDITOR_STALE' // code-editor FR-11: baseVersion != disk (detail: { version })
  | 'EDITOR_WRITE_FAILED' // code-editor FR-11: atomic write failed (detail: { reason })
  | 'SHELL_NOT_FOUND' // multiple-shells: no entry for that ShellId (unknown, disposed, or another session's)
  | 'SHELL_LIMIT_REACHED' // multiple-shells: shell_create at the 6-shell-per-session cap (FR-2)
  | 'STEP_DETAIL_NOT_FOUND' // command-inspect FR-11: no record for that blockId (never captured, or swept)
  // session-engine: the turn died on the plan's usage limit (or an API rate
  // limit). Carried by `session.error` and NOT terminal — the core sends the
  // session back to `idle` because the window resets on its own clock and emits
  // nothing when it does. Consumers must surface it as a transient notice, never
  // as a dead session.
  | 'USAGE_LIMIT'
  | 'CLOUD_AUTH_REQUIRED' // cloud-sessions FR-1: no claude.ai token; API-key auth is not sufficient (`no_access_token`)
  | 'CLOUD_AUTH_EXPIRED' // cloud-sessions FR-1: token past `expiresAt`, or the API said so; run a turn or `/login`
  | 'CLOUD_DEVICE_UNTRUSTED' // cloud-sessions: `untrusted_device`; enrol the device with `/login`
  | 'CLOUD_POLICY_DENIED' // cloud-sessions: the org's `allow_remote_sessions` policy is off
  | 'CLOUD_SESSION_NOT_FOUND' // cloud-sessions: unknown/invalid cloud session id
  | 'CLOUD_REPO_MISMATCH' // cloud-sessions FR-8: teleport's mismatch/not_in_repo/host_unverified (detail: { sessionRepo, currentRepo })
  | 'CLOUD_ADOPT_STALLED' // cloud-sessions FR-8/FR-9: a blocking dialog or the deadline (detail: { phase, logPath? })
  | 'CLOUD_ADOPT_FAILED' // cloud-sessions FR-6: the PTY exited without a usable local session (detail: { logPath? })
  | 'PROVIDER_REQUEST_FAILED' // multi-provider-openai: the endpoint errored, or the tool loop hit its cap
  | 'PROVIDER_CONTEXT_EXCEEDED' // multi-provider-openai: the next request would exceed the model's window
  | 'EXT_NOT_ENABLED' // extensions FR-7: the extension is toggled off; nothing was spawned
  | 'EXT_NOT_DETECTED' // extension-install FR-1: the extension's predicate does not hold for that root; when raised because no home directory could be resolved (fleet-scoped panels), detail: { command } per FR-49
  | 'EXT_PANEL_NOT_FOUND' // extension-install FR-12: a panelId that is not in the manifest-derived registry
  | 'EXT_PROVIDER_MISSING' // extensions FR-24: the binary could not be spawned (detail: { argv0, command })
  | 'EXT_PROVIDER_TIMEOUT' // extensions FR-21: killed at 10s (detail: { timeoutMs, command })
  | 'EXT_PROVIDER_EXIT' // extensions FR-24: non-zero exit (detail: { code, stderr, command })
  | 'EXT_SCHEMA_INVALID' // extensions FR-25: stdout did not validate; nothing was rendered
  | 'EXT_OUTPUT_CAPPED' // extensions FR-22: killed past 4 MiB (detail: { capBytes, command })
  | 'EXT_PATH_OUTSIDE_ROOT' // extensions FR-39: a log-tail file source escaped its declared root
  | 'EXT_INVALID_TOKEN' // extensions FR-38: the token slot failed its charset/length rule
  | 'EXT_STREAM_NOT_FOUND' // extensions: closeStream addressed an unknown or already-ended stream
  | 'EXT_MANIFEST_INVALID' // extension-install FR-6: schema failure; detail: { pointer, expected, manifestPath }
  | 'EXT_MANIFEST_UNSUPPORTED' // extension-install FR-5: unknown `manifest` version; detail: { found, supported }
  | 'EXT_NOT_CONSENTED' // extension-install FR-17: enable/spawn refused before consent
  | 'EXT_CONSENT_STALE' // extension-install FR-18: the manifest changed under the dialog
  | 'GH_UNAVAILABLE' | 'GH_FAILED' | 'GH_LOG_NOT_READY' | 'GH_LOG_GONE' | 'GH_LOG_TOO_LARGE' // github-page: gh missing/unauthenticated/not GitHub (detail: { status }) · gh exited non-zero (detail: { code, stderr }) · github-ci-logs: job not completed · log 404/410 (retention) · log > 32 MiB (detail: { capBytes })
  | 'COHORTE_NOT_DETECTED' | 'COHORTE_CLI_MISSING' | 'COHORTE_CLI_INCOMPATIBLE' | 'COHORTE_TIMEOUT' | 'COHORTE_OUTPUT_CAPPED' | 'COHORTE_OUTPUT_INVALID' | 'COHORTE_COMMAND_FAILED' | 'COHORTE_REJECTED' | 'COHORTE_RUN_NOT_FOUND' | 'COHORTE_GATE_NOT_PENDING' // cohorte-integration (detail shapes: CohorteErrorCode in contract/cohorte-integration.ts)
  | 'PROFILE_NOT_FOUND' // session-profiles: a profileId that is not in the registry
  | 'PROFILE_ARG_DENIED' // session-profiles: extraArgs carried a denied flag (detail: { flag, reason })
  | 'RUNTIME_UNAVAILABLE' | 'RUNTIME_INCOMPATIBLE'
  | 'RUNTIME_PROTOCOL_ERROR'
  | 'RUNTIME_TIMEOUT'
  | 'RUNTIME_EXITED'
  | 'RUNTIME_UNSUPPORTED'
  | 'PROVIDER_AUTH_FAILED'
  | 'PROVIDER_UNAVAILABLE'
  | 'MODEL_UNAVAILABLE'
  | 'TOOL_FAILED'
  | 'SESSION_BUSY' // pi-session-durability: reconnect/newFrom refused while a turn or another recovery is in flight
  | 'RUNTIME_SESSION_MISSING' // pi-session-durability FR-3: the recorded native conversation file is gone
  | 'RUNTIME_SESSION_CORRUPT' // pi-session-durability FR-3: the native file/identity failed validation or its parent chain is broken
  | 'RUNTIME_ACCOUNT_MISSING' // pi-session-durability FR-3: the pinned account was removed; never falls back to a default
  | 'QUEUE_FULL' // pi-turn-controls FR-4: the session already holds 20 pending intents (detail: { cap })
  | 'RUNTIME_POLICY_REQUIRED' // pi-skills-capabilities FR-5: first submit refused until the session's unrestricted-tools acknowledgment is recorded
  | 'PROFILE_RUNTIME_MISMATCH' // pi-migration-rollout: a legacy profile selected for a Pi account, or Pi settings for another runtime
  | 'VSX_UNREACHABLE' // code-editor-vsx: the Open VSX registry did not answer usably (detail: { status? })
  | 'VSX_NOT_FOUND' // code-editor-vsx: no such extension/version on the registry, or not installed
  | 'VSX_INVALID_PACKAGE' // code-editor-vsx FR-4: checksum mismatch, bad zip, zip-slip, over a size cap (detail: { reason })
  | 'VSX_UNSUPPORTED' // code-editor-vsx FR-3: the extension has no declarative contribution Francois can load
  | 'INTERNAL';
