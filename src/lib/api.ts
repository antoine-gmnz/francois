// Typed wrappers over the Tauri session commands + the session event stream.
// Each command resolves a Result<T> (never rejects) per the contract.

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { demoInvoke, demoListen } from '../demo/demo';
import type { AccountId, Result, SessionMeta, ModelInfo, SessionEvent, SessionId, AgentInfo, AgentStep, McpServerInfo, SkillInfo, SlashCommandInfo, ProjectId, WorkflowRun, WorkflowRunId } from '../../contract/common';
import type {
  WorkflowAgentTranscript,
  WorkflowDetail,
  WorkflowDetailEvent,
  WorkflowScript,
} from '../../contract/workflow-details';
import type {
  AccountAddPayload,
  AccountAddResponse,
  AccountEvent,
  AccountListResponse,
  AccountLoginAck,
  AccountLoginCancelPayload,
  AccountLoginResizePayload,
  AccountLoginWritePayload,
  AccountRemoveResponse,
  AccountRenameResponse,
  AccountSetDefaultResponse,
} from '../../contract/multi-account';
import type {
  ProjectAwareSessionCreateRequest,
  ProjectCreateRequest,
  ProjectMeta,
  ProjectStandards,
  ProjectUpdateRequest,
  StandardsRead,
} from '../../contract/projects';
import type { PermissionDecision, PermissionRule, PermissionTier } from '../../contract/permission-guardrails';
import type { NewSessionRequest, PickDirectoryData } from '../../contract/sessions-sidebar';
import type { SessionCreateInput } from '../../contract/session-engine';
import type { WorktreeProbeData, WorktreeProbeRequest, WorktreeStatusData } from '../../contract/session-worktree';
import type { SessionRenameRequest, SessionRenameResponse } from '../../contract/session-rename';
import type {
  Attachment,
  ClearAttachmentsResult,
  ClearScope,
  CommitAttachmentsResult,
  PickAttachmentsResponse,
} from '../../contract/session-attachments';
import type { ConversationBlock } from '../../contract/conversation-view';
import type { AgentEvent, AgentTranscript } from '../../contract/agent-tab';
import type { McpApprovalState, McpDecision, McpServerDetail, McpRegistryEntry, McpAttachRequest } from '../../contract/mcp-panel';
import type { ShellEvent } from '../../contract/shell-terminal';
import type { SkillsEvent } from '../../contract/skills-panel';
import type { DiffSummary, FileDiff, CommitResult, DiffEvent } from '../../contract/diff-view';
import type { AppEvent, UsageRefreshAck, UsageSnapshot } from '../../contract/usage-bar';
import type { RemoteControlEvent, RemoteControlStatus } from '../../contract/remote-control';
import type { ApplyUpdateResult, CheckUpdateResult } from '../../contract/self-update';

// Exported so other invoke sites (e.g. ShellTerminal.tsx, which redefines this
// byte-identically) can share the one wrapper instead of redeclaring it.
// __FRANCOIS_DEMO__ is a compile-time literal (vite.config.ts), so the demo
// branch — and all of src/demo/ — vanishes from a normal build. It must be
// tested inline like this rather than through an imported const; see demo.ts.
export function ipc<T>(cmd: string, args?: object): Promise<T> {
  if (__FRANCOIS_DEMO__) return demoInvoke<T>(cmd, args);
  return invoke<T>(cmd, args as Record<string, unknown> | undefined);
}

/**
 * One subscription helper for every core→frontend stream, so the demo backend
 * has a single seam to intercept. Unwraps Tauri's event envelope; the demo bus
 * hands the payload over directly.
 */
function stream<T>(channel: string, cb: (payload: T) => void): Promise<UnlistenFn> {
  if (__FRANCOIS_DEMO__) return demoListen<T>(channel, cb);
  return listen<T>(channel, (e) => cb(e.payload));
}

// francois:app:setWindowTheme — repaint the native caption bar to match the theme.
export const appSetWindowTheme = (theme: 'light' | 'dark') =>
  ipc<Result<null>>('app_set_window_theme', { theme });

export const sessionList = () => ipc<Result<SessionMeta[]>>('session_list');
export const sessionModels = () => ipc<Result<ModelInfo[]>>('session_models');
// projects FR-19: session_create gained an optional projectId, stored verbatim —
// the frontend (NewSessionModal) resolves the project and applies its defaults.
// session-worktree: session_create also gained an optional `worktree` (spec §5),
// sourced from the canonical SessionCreateInput field rather than re-declared here.
export const sessionCreate = (
  req: NewSessionRequest & Pick<ProjectAwareSessionCreateRequest, 'projectId'> & Pick<SessionCreateInput, 'worktree'>,
) => ipc<Result<SessionMeta>>('session_create', req);
export const sessionRemove = (sessionId: SessionId) => ipc<Result<null>>('session_remove', { sessionId });
// session-rename §5: mutate a session's display name. The core validates/cleans it
// (FR-1) and emits session.meta — the frontend's single update path (FR-13).
export const sessionRename = (req: SessionRenameRequest) => ipc<SessionRenameResponse>('session_rename', req);
// session-worktree §5: probe a candidate cwd for worktree isolation (FR-1).
export const sessionWorktreeProbe = (req: WorktreeProbeRequest) =>
  ipc<Result<WorktreeProbeData>>('session_worktree_probe', req);
// session-worktree §5: dirty/unpushed check before offering removal (FR-18).
export const sessionWorktreeStatus = (sessionId: SessionId) =>
  ipc<Result<WorktreeStatusData>>('session_worktree_status', { sessionId });
// session-worktree §5: `git worktree remove` + prune; never deletes the branch (FR-20).
export const sessionWorktreeRemove = (sessionId: SessionId) =>
  ipc<Result<null>>('session_worktree_remove', { sessionId });
export const sessionPickDirectory = () => ipc<Result<PickDirectoryData>>('session_pick_directory');
export const sessionSend = (sessionId: SessionId, blockId: string, text: string) =>
  ipc<Result<{ queued: boolean; queuePosition?: number }>>('session_send', { sessionId, blockId, text });
// Kill the running turn (⌃C). No-op if the session isn't running (core FR-23).
export const sessionInterrupt = (sessionId: SessionId) =>
  ipc<Result<null>>('session_interrupt', { sessionId });
// session-attachments (§5.2). Request/response only — no event channel. Each call
// resolves a Result; a refusal (too large, folder, io) is ok:false per file, so a
// multi-file drop keeps its successes (FR-9).
export const sessionAttachFile = (sessionId: SessionId, path: string) =>
  ipc<Result<Attachment>>('session_attach_file', { sessionId, path });
export const sessionAttachClipboardImage = (sessionId: SessionId, mime: string, dataBase64: string) =>
  ipc<Result<Attachment>>('session_attach_clipboard_image', { sessionId, mime, dataBase64 });
/**
 * Opens the native multi-select dialog IN THE CORE. Successes and per-file
 * refusals travel together (FR-9); a cancel is ok:true with both arrays empty.
 */
export const sessionPickAttachments = (sessionId: SessionId) =>
  ipc<Result<PickAttachmentsResponse>>('session_pick_attachments', { sessionId });
/** FR-13: deletes the copy immediately; a copied:false origin is never touched. */
export const sessionReleaseAttachment = (sessionId: SessionId, attachmentId: string) =>
  ipc<Result<null>>('session_release_attachment', { sessionId, attachmentId });
/** FR-15: refs present in the sent text become 'sent'; the rest are released. */
export const sessionCommitAttachments = (sessionId: SessionId, text: string) =>
  ipc<Result<CommitAttachmentsResult>>('session_commit_attachments', { sessionId, text });
/** FR-18: sweeps a session's or a whole project's attachments dirs. */
export const sessionClearAttachments = (scope: ClearScope) =>
  ipc<Result<ClearAttachmentsResult>>('session_clear_attachments', { scope });

export const getTranscript = (sessionId: SessionId) =>
  ipc<Result<ConversationBlock[]>>('conversation_get_transcript', { sessionId });
export const sessionAnswerQuestion = (sessionId: SessionId, blockId: string, answers: Record<string, string>) =>
  ipc<Result<null>>('session_answer_question', { sessionId, blockId, answers });
// permission-guardrails (§5.1). decide answers a parked approval card; the other
// four are the rules editor and each RETURNS THE FRESHLY RE-READ LIST (FR-18),
// so the editor never renders a stale view.
export const permissionsDecide = (
  sessionId: SessionId,
  blockId: string,
  decision: PermissionDecision,
  tier?: PermissionTier,
) => ipc<Result<null>>('permissions_decide', { sessionId, blockId, decision, tier });
export const permissionsList = (sessionId: SessionId) =>
  ipc<Result<PermissionRule[]>>('permissions_list', { sessionId });
export const permissionsSetEnabled = (sessionId: SessionId, ruleId: string, enabled: boolean) =>
  ipc<Result<PermissionRule[]>>('permissions_set_enabled', { sessionId, ruleId, enabled });
export const permissionsRemove = (sessionId: SessionId, ruleId: string) =>
  ipc<Result<PermissionRule[]>>('permissions_remove', { sessionId, ruleId });
export const permissionsSetTier = (sessionId: SessionId, ruleId: string, tier: PermissionTier) =>
  ipc<Result<PermissionRule[]>>('permissions_set_tier', { sessionId, ruleId, tier });

// projects (§5.3). Six commands, no event channel: every mutation resolves with
// the new state. getStandards/setStandards read and write the managed block in
// <root>/CLAUDE.md; setStandards resolves a FRESH RE-READ of the file (FR-16),
// never the payload it was given.
export const projectList = () => ipc<Result<ProjectMeta[]>>('project_list');
export const projectCreate = (req: ProjectCreateRequest) => ipc<Result<ProjectMeta>>('project_create', req);
export const projectUpdate = (req: ProjectUpdateRequest) => ipc<Result<ProjectMeta>>('project_update', req);
export const projectRemove = (projectId: ProjectId) => ipc<Result<null>>('project_remove', { projectId });
export const projectGetStandards = (projectId: ProjectId) =>
  ipc<Result<StandardsRead>>('project_get_standards', { projectId });
export const projectSetStandards = (projectId: ProjectId, standards: ProjectStandards) =>
  ipc<Result<StandardsRead>>('project_set_standards', { projectId, standards });

// slash-menu FR-1/4: merged per-session command registry (francois:session:listCommands)
export const sessionListCommands = (sessionId: SessionId) =>
  ipc<Result<SlashCommandInfo[]>>('session_list_commands', { sessionId });

export const sessionSwitchModel = (sessionId: SessionId, modelId: string) =>
  ipc<Result<SessionMeta>>('session_switch_model', { sessionId, modelId });
export const sessionCompact = (sessionId: SessionId) => ipc<Result<null>>('session_compact', { sessionId });
export const sessionClear = (sessionId: SessionId) => ipc<Result<null>>('session_clear', { sessionId });

export const agentsList = (sessionId: SessionId) => ipc<Result<AgentInfo[]>>('agents_list', { sessionId });
export const agentsDispatch = (sessionId: SessionId, task: string) =>
  ipc<Result<{ agentId: string }>>('agents_dispatch', { sessionId, task });
export const agentsKill = (agentId: string) => ipc<Result<null>>('agents_kill', { agentId });
// async-agents §5: the agent's activity trail (≤200 steps, FR-12 window).
export const agentsActivity = (agentId: string) =>
  ipc<Result<AgentStep[]>>('agents_activity', { agentId });
// agent-tab §5: the agent's OWN transcript (≤400 blocks, FR-5 window) + the
// count evicted past it — what the dynamic agent tab renders.
export const agentsTranscript = (agentId: string) =>
  ipc<Result<AgentTranscript>>('agents_transcript', { agentId });

// workflow-panel §5: this session's `Workflow` runs, in first-seen order. The
// panel is read-only — a run is dispatched by the assistant during a turn, so
// there is no create/stop verb to wrap here.
export const workflowsList = (sessionId: SessionId) =>
  ipc<Result<WorkflowRun[]>>('workflows_list', { sessionId });

// workflow-details §5: what the run's DIRECTORY says — its agents, their spans
// and tokens, and any ask attributed to the run. `detail` also starts the core's
// filesystem watch (FR-6), so the live stream below follows from this one call.
export const workflowsDetail = (runId: WorkflowRunId) =>
  ipc<Result<WorkflowDetail>>('workflows_detail', { runId });
/** FR-8: one agent's own transcript, in the agent-tab block vocabulary. */
export const workflowsAgent = (runId: WorkflowRunId, agentId: string) =>
  ipc<Result<WorkflowAgentTranscript>>('workflows_agent', { runId, agentId });
/** FR-9: the script the harness wrote to disk, capped at 200 KB. */
export const workflowsScript = (runId: WorkflowRunId) =>
  ipc<Result<WorkflowScript>>('workflows_script', { runId });

/** Subscribe to francois://workflows/event (workflow.detail, FR-6/FR-23). */
export function onWorkflowEvent(cb: (e: WorkflowDetailEvent) => void): Promise<UnlistenFn> {
  return stream<WorkflowDetailEvent>('francois://workflows/event', cb);
}

/** Subscribe to francois://agents/event (agent.block, agent-tab FR-8). */
export function onAgentEvent(cb: (e: AgentEvent) => void): Promise<UnlistenFn> {
  return stream<AgentEvent>('francois://agents/event', cb);
}

export const mcpList = (sessionId: SessionId) => ipc<Result<McpServerInfo[]>>('mcp_list', { sessionId });
export const mcpDetail = (sessionId: SessionId, name: string) => ipc<Result<McpServerDetail>>('mcp_detail', { sessionId, name });
export const mcpReconnect = (sessionId: SessionId, name: string) => ipc<Result<null>>('mcp_reconnect', { sessionId, name });
export const mcpDetach = (sessionId: SessionId, name: string) => ipc<Result<null>>('mcp_detach', { sessionId, name });
export const mcpRegistry = () => ipc<Result<McpRegistryEntry[]>>('mcp_registry');
export const mcpAttach = (sessionId: SessionId, entry: McpAttachRequest) =>
  ipc<Result<null>>('mcp_attach', { sessionId, entry });
export const mcpApprovals = (sessionId: SessionId) => ipc<Result<McpApprovalState>>('mcp_approvals', { sessionId });
export const mcpDecide = (sessionId: SessionId, decision: McpDecision) =>
  ipc<Result<McpApprovalState>>('mcp_decide', { sessionId, ...decision });

export const skillsList = (sessionId: SessionId) => ipc<Result<SkillInfo[]>>('skills_list', { sessionId });
export const skillsInstall = (sessionId: SessionId, name: string) => ipc<Result<null>>('skills_install', { sessionId, name });
export const skillsRun = (sessionId: SessionId, name: string, args?: string) =>
  ipc<Result<null>>('skills_run', { sessionId, name, args });

/** Subscribe to francois://skills/event (skills.changed). */
export function onSkillsEvent(cb: (e: SkillsEvent) => void): Promise<UnlistenFn> {
  return stream<SkillsEvent>('francois://skills/event', cb);
}

export const diffGetSummary = (sessionId: SessionId) => ipc<Result<DiffSummary>>('diff_get_summary', { sessionId });
export const diffGetFileDiff = (sessionId: SessionId, path: string) =>
  ipc<Result<FileDiff>>('diff_get_file_diff', { sessionId, path });
export const diffStageAll = (sessionId: SessionId) => ipc<Result<null>>('diff_stage_all', { sessionId });
export const diffCommit = (sessionId: SessionId, message: string, paths: string[] = []) =>
  ipc<Result<CommitResult>>('diff_commit', { sessionId, message, paths });

/** Subscribe to francois://diff/event (diff.changed). */
export function onDiffEvent(cb: (e: DiffEvent) => void): Promise<UnlistenFn> {
  return stream<DiffEvent>('francois://diff/event', cb);
}

// usage-bar (app domain, app-scoped plan limits). getUsage NEVER triggers a probe
// (FR-22); refreshUsage only acks — the result always arrives as a usage.state event.
// multi-account FR-27: both take an optional accountId; omitted means the payload
// itself is omitted (undefined), which the core reads as "the isDefault account".
export const appGetUsage = (accountId?: AccountId) =>
  ipc<Result<UsageSnapshot>>('app_get_usage', accountId ? { accountId } : undefined);
export const appRefreshUsage = (accountId?: AccountId) =>
  ipc<Result<UsageRefreshAck>>('app_refresh_usage', accountId ? { accountId } : undefined);

// self-update (§5). No payload either way, and NO event channel — the frontend
// drives both calls: once at shell mount (FR-7, silent) and on demand from the
// palette (FR-9). `app_apply_update` acks BEFORE the core starts shutting down
// (FR-16), so a refusal (UPDATE_BLOCKED / UPDATE_APPLY_FAILED) always reaches
// the webview.
export const appCheckUpdate = () => ipc<CheckUpdateResult>('app_check_update');
export const appApplyUpdate = () => ipc<ApplyUpdateResult>('app_apply_update');

/** Subscribe to francois://app/event (usage.state, extensible tagged union). */
export function onAppEvent(cb: (e: AppEvent) => void): Promise<UnlistenFn> {
  return stream<AppEvent>('francois://app/event', cb);
}

// multi-account (§5). Registry mutations resolve the FRESH re-read list (like
// permission-guardrails), so the caller never re-derives it from a stale copy.
// account:add starts (or FR-17 re-runs) an in-app login PTY; its bytes/outcome
// arrive on the shared francois://account/event stream, not the response.
export const accountList = () => ipc<AccountListResponse>('account_list');
export const accountAdd = (payload: AccountAddPayload = {}) => ipc<AccountAddResponse>('account_add', payload);
export const accountLoginWrite = (payload: AccountLoginWritePayload) => ipc<AccountLoginAck>('account_login_write', payload);
export const accountLoginResize = (payload: AccountLoginResizePayload) => ipc<AccountLoginAck>('account_login_resize', payload);
export const accountLoginCancel = (payload: AccountLoginCancelPayload) => ipc<AccountLoginAck>('account_login_cancel', payload);
export const accountRename = (accountId: AccountId, label: string) =>
  ipc<AccountRenameResponse>('account_rename', { accountId, label });
export const accountSetDefault = (accountId: AccountId) =>
  ipc<AccountSetDefaultResponse>('account_set_default', { accountId });
export const accountRemove = (accountId: AccountId) => ipc<AccountRemoveResponse>('account_remove', { accountId });

/** Subscribe to francois://account/event (account.list + the login sub-stream). */
export function onAccountEvent(cb: (e: AccountEvent) => void): Promise<UnlistenFn> {
  return stream<AccountEvent>('francois://account/event', cb);
}

// remote-control: Francois HOSTS Claude Code's native Remote Control for a session
// (an interactive `claude --remote-control` in a PTY the core owns), so the same
// thread can be picked up from claude.ai/code or the Claude mobile app. `start`
// resolves `starting` — the URL arrives later as a remote.status event.
export const remoteStart = (sessionId: SessionId, name?: string) =>
  ipc<Result<RemoteControlStatus>>('remote_start', { sessionId, name });
export const remoteStop = (sessionId: SessionId) =>
  ipc<Result<RemoteControlStatus>>('remote_stop', { sessionId });
export const remoteGet = (sessionId: SessionId) =>
  ipc<Result<RemoteControlStatus>>('remote_get', { sessionId });

/** Subscribe to francois://remote/event (remote.status). */
export function onRemoteEvent(cb: (e: RemoteControlEvent) => void): Promise<UnlistenFn> {
  return stream<RemoteControlEvent>('francois://remote/event', cb);
}

/** Subscribe to francois://shell/event (shell.data / shell.exit). */
export function onShellEvent(cb: (e: ShellEvent) => void): Promise<UnlistenFn> {
  return stream<ShellEvent>('francois://shell/event', cb);
}

/** Subscribe to the core→frontend session event stream. */
export function onSessionEvent(cb: (e: SessionEvent) => void): Promise<UnlistenFn> {
  return stream<SessionEvent>('francois://session/event', cb);
}
