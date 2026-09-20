import type { SessionModelsInput, SessionModelsResponse } from '../../contract/session-engine';
import type { RuntimeMetricsInput, RuntimeMetricsResult, RuntimeModelsInput, RuntimeModelsResult } from '../../contract/pi-models-metrics';
// Typed wrappers over the Tauri session commands + the session event stream.
// Each command resolves a Result<T> (never rejects) per the contract.

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { demoInvoke, demoListen } from '../demo/demo';
import type { AccountId, BlockId, Result, RuntimeMessageReceipt, SessionMeta, PermissionMode, ResponseMode, RuntimeModelRef, SessionEvent, SessionId, AgentInfo, AgentStep, McpServerInfo, SkillInfo, SlashCommandInfo, ProjectId, WorkflowRun, WorkflowRunId } from '../../contract/common';
import type {
  WorkflowAgentTranscript,
  WorkflowDetail,
  WorkflowDetailEvent,
  WorkflowScript,
} from '../../contract/workflow-details';
import type {
  AccountAddEndpointPayload,
  AccountAddEndpointResponse,
  AccountAddPayload,
  AccountAddPiResponse,
  AccountAddResponse,
  AccountEvent,
  AccountAddCodexPayload,
  AccountAddCodexResponse,
  AccountAddGrokPayload,
  AccountAddGrokResponse,
  AccountCliToolsResponse,
  AccountCodexLoginPayload,
  AccountCodexLoginResponse,
  AccountGrokLoginPayload,
  AccountGrokLoginResponse,
  AccountInstallCliPayload,
  AccountInstallCliResponse,
  AccountListResponse,
  AccountLoginAck,
  AccountLoginCancelPayload,
  AccountLoginResizePayload,
  AccountLoginWritePayload,
  AccountPiRefreshResponse,
  AccountPiSetupResponse,
  AccountRemoveResponse,
  AccountRenameResponse,
  AccountSetDefaultResponse,
  AccountTestEndpointPayload,
  AccountTestEndpointResponse,
  AccountTrustPiPayload,
  AccountTrustPiResponse,
  AccountUpdateEndpointPayload,
  AccountUpdateEndpointResponse,
  PiAccountCreateInput,
  PiRefreshAuthInput,
  PiSetupInput,
} from '../../contract/multi-account';
import type {
  GroupId,
  ProjectAwareSessionCreateRequest,
  ProjectAssignGroupResponse,
  ProjectCreateGroupResponse,
  ProjectCreateRequest,
  ProjectListResponse,
  ProjectMeta,
  ProjectRemoveGroupResponse,
  ProjectRenameGroupResponse,
  ProjectStandards,
  ProjectUpdateRequest,
  StandardsRead,
} from '../../contract/projects';
import type { RepoBrief } from '../../contract/session-welcome';
import type {
  PiSessionProfile,
  ProfileCopyToPiInput,
  ProfileCreateInput,
  ProfileRemoveInput,
  ProfileUpdateInput,
  SessionProfile,
} from '../../contract/session-profiles';
import type { PermissionDecision, PermissionRule, PermissionTier } from '../../contract/permission-guardrails';
import type { NewSessionRequest, PickDirectoryData } from '../../contract/sessions-sidebar';
import type { RuntimePolicyAcknowledgeInput, SessionCreateInput } from '../../contract/session-engine';
// pi-turn-controls §5: session_submit / session_clear_queue payload types.
import type { RuntimeMessageInput, RuntimeQueueClearInput, RuntimeQueueClearOutput } from '../../contract/session-engine';
import type { WorktreeProbeData, WorktreeProbeRequest, WorktreeStatusData } from '../../contract/session-worktree';
import type { SessionRenameRequest, SessionRenameResponse } from '../../contract/session-rename';
import type { SessionUpdateSettingsRequest, SessionUpdateSettingsResponse } from '../../contract/session-settings-sheet';
import type { EditorListData, OpenInEditorRequest } from '../../contract/open-in-vscode';
import type {
  Attachment,
  ClearAttachmentsResult,
  ClearScope,
  CommitAttachmentsResult,
  PickAttachmentsResponse,
} from '../../contract/session-attachments';
import type { GetTranscriptRequest, TranscriptPage } from '../../contract/conversation-view';
import type { StepDetail, StepDetailPayload } from '../../contract/command-inspect';
import type { AgentEvent, AgentTranscript } from '../../contract/agent-tab';
import type { McpApprovalState, McpDecision, McpServerDetail, McpRegistryEntry, McpAttachRequest } from '../../contract/mcp-panel';
import type {
  ShellCreatePayload,
  ShellDisposePayload,
  ShellEnsureData,
  ShellEnsurePayload,
  ShellEvent,
  ShellId,
  ShellInfo,
  ShellOwner,
  ShellRenamePayload,
  ShellResizePayload,
  ShellRestartData,
  ShellRestartPayload,
  ShellWritePayload,
} from '../../contract/shell-terminal';
import type { SkillsEvent, SkillsRunRequest } from '../../contract/skills-panel';
import type { DiffSummary, FileDiff, CommitResult, DiffEvent } from '../../contract/diff-view';
import type { AppEvent, UsageRefreshAck, UsageSnapshot } from '../../contract/usage-bar';
import type { RemoteControlEvent, RemoteControlStatus } from '../../contract/remote-control';
import type {
  CloudAdoptData,
  CloudAdoptRequest,
  CloudEvent,
  CloudListData,
  CloudResolveData,
  CloudResolveRequest,
} from '../../contract/cloud-sessions';
import type { ApplyUpdateResult, CheckUpdateResult } from '../../contract/self-update';
import type { DndState } from '../../contract/audio-cues';
import type { RuntimeInstallProbeInput, RuntimeInstallStatus } from '../../contract/pi-runtime-distribution';
import type { RuntimeNewFromSessionInput, RuntimeReconnectInput } from '../../contract/pi-session-durability';
import type {
  CloseStreamRequest,
  CloseStreamResponse,
  ConsentRequest,
  ConsentResponse,
  DetectExtensionsRequest,
  DetectExtensionsResponse,
  ExtensionEvent,
  ListExtensionsRequest,
  ListExtensionsResponse,
  OpenStreamRequest,
  OpenStreamResponse,
  PanelRequest,
  PanelResponse,
  SetExtensionEnabledRequest,
  SetExtensionEnabledResponse,
} from '../../contract/extensions';

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

// audio-cues FR-14/FR-20 — OS Do Not Disturb probe. Never rejects on a domain
// failure per FR-15; the frontend TTL cache (sound.ts) treats a transport
// error the same as `Ok`.
export const appDndState = () => ipc<Result<DndState>>('app_dnd_state');

export const sessionList = () => ipc<Result<SessionMeta[]>>('session_list');
// Account-scoped discovery; core owns cache freshness and validation.
export const sessionModels = (input: SessionModelsInput = {}) =>
  ipc<SessionModelsResponse>('session_models', input);
// pi-models-metrics §5: the Pi-only model catalog — a short-lived no-session RPC
// probe under the same launch policy as a session, cached by the core for 60s
// keyed by account/config fingerprint/environment (FR-1/FR-2). `refresh: true`
// bypasses that cache; a failed refresh keeps the previous catalogue, `stale: true`.
export const runtimeModels = (input: RuntimeModelsInput) =>
  ipc<RuntimeModelsResult>('runtime_models', input);
// pi-models-metrics §5: session-scoped usage. Without `refresh` this returns the
// stored (possibly stale-after-restart) value; the core also reads it on its own
// after every settled run and after compaction, rate-limited to 1/s either way (FR-7).
export const sessionMetrics = (input: RuntimeMetricsInput) =>
  ipc<RuntimeMetricsResult>('session_metrics', input);
// projects FR-19: session_create gained an optional projectId, stored verbatim —
// the frontend (NewSessionModal) resolves the project and applies its defaults.
// session-worktree: session_create also gained an optional `worktree` (spec §5),
// sourced from the canonical SessionCreateInput field rather than re-declared here.
// session-profiles FR-15: session_create also gained systemPrompt/extraArgs/profileId —
// the frontend sends the RESOLVED (post-edit) values plus the profile id, and the core
// snapshots the profile's name from the registry itself.
// response-mode FR-17: and an optional responseMode — omitted for 'default', which
// IS the absence of an instruction rather than an instruction to be normal.
// pi-skills-capabilities §5: and an optional resourcePolicy — REQUIRED by the
// core for a Pi account (INVALID_INPUT otherwise); the New Session form only
// ever sends it for a Pi account (PiPolicyField).
// pi-models-metrics FR-4: `modelId` widened to optional here — a Pi account
// sends `runtimeModel` (SessionCreateInput's own field) INSTEAD, never both;
// `NewSessionRequest.modelId` stays required for every other caller of that
// shared shape.
export const sessionCreate = (
  req: Omit<NewSessionRequest, 'modelId'> & { modelId?: string } &
    Pick<ProjectAwareSessionCreateRequest, 'projectId'> &
    Pick<SessionCreateInput, 'worktree' | 'systemPrompt' | 'extraArgs' | 'profileId' | 'responseMode' | 'resourcePolicy' | 'piProfile' | 'runtimeModel'>,
) => ipc<Result<SessionMeta>>('session_create', req);
export const sessionRemove = (sessionId: SessionId) => ipc<Result<null>>('session_remove', { sessionId });
// session-rename §5: mutate a session's display name. The core validates/cleans it
// (FR-1) and emits session.meta — the frontend's single update path (FR-13).
export const sessionRename = (req: SessionRenameRequest) => ipc<SessionRenameResponse>('session_rename', req);
// session-settings-sheet §5: one atomic patch of changed keys — validate all →
// write all → persist once → emit ONE session.meta (FR-2). The frontend's
// single update path is that event, same as every switch verb; this Result is
// read only to surface a failure (or the no-op-success meta on an empty patch).
export const sessionUpdateSettings = (req: SessionUpdateSettingsRequest) =>
  ipc<SessionUpdateSettingsResponse>('session_update_settings', req);
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
// transcript-perf FR-17/19: retract a still-queued prompt before the turn
// drains it. `removed: false` means the turn already drained it (or it was
// never queued) — the caller leaves the composer alone.
export const sessionUnqueue = (sessionId: SessionId, blockId: string) =>
  ipc<Result<{ removed: boolean }>>('session_unqueue', { sessionId, blockId });
// pi-turn-controls §5: the explicit-delivery send — Pi callers use this;
// session_send (above) stays valid for the existing runtimes. Both route
// through ONE per-session admissions owner in the core, never two independent
// queues. Acceptance creates/updates a pending ledger entry (published as
// `queue.changed`); the transcript block is created only by the eventual
// `message.user` runtime event.
export const sessionSubmit = (req: RuntimeMessageInput) => ipc<Result<RuntimeMessageReceipt>>('session_submit', req);
// pi-turn-controls §5/FR-5/FR-6: drains every entry Pi has not yet consumed,
// returned with state 'cancelled' and its text intact — the same internal
// step Stop/session_interrupt runs before it aborts.
export const sessionClearQueue = (sessionId: SessionId) =>
  ipc<Result<RuntimeQueueClearOutput>>('session_clear_queue', { sessionId } satisfies RuntimeQueueClearInput);
// Kill the running turn (⌃C). No-op if the session isn't running (core FR-23).
// pi-turn-controls FR-6/FR-7, for a Pi session: resolves only AFTER the stop
// is confirmed (admission closed → clear_queue → abort → settled).
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

// open-in-vscode (§5). App-scoped detection (FR-1) + a fire-and-forget launch
// (FR-8/12: no session mutation, no event, no disk write — observable only as a
// running process).
export const sessionEditorList = () => ipc<Result<EditorListData>>('session_editor_list');
export const sessionOpenInEditor = (req: OpenInEditorRequest) =>
  ipc<Result<null>>('session_open_in_editor', req);

// transcript-scale FR-5/FR-9: `before`/`limit` page backwards; omitted ⇒ the
// live tail the core holds in memory. `limit` is clamped by the core to
// 1..=500 (default 200) — never an INVALID_INPUT.
export const getTranscript = (sessionId: SessionId, page?: { before?: BlockId; limit?: number }) =>
  ipc<Result<TranscriptPage>>('conversation_get_transcript', { sessionId, ...page } satisfies GetTranscriptRequest);
// command-inspect FR-11: resolves one settled step's record by (sessionId, blockId). Never rides
// an event — pulled lazily on first open (FR-13), and memoized by the caller for the session's life.
export const stepDetail = (sessionId: SessionId, blockId: BlockId) =>
  ipc<Result<StepDetail>>('conversation_step_detail', { sessionId, blockId } satisfies StepDetailPayload);
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
// project-groups §5: project_list's response shape changed from ProjectMeta[]
// to { projects, groups } (ProjectRegistrySnapshot) — every caller updated.
export const projectList = () => ipc<ProjectListResponse>('project_list');
export const projectCreate = (req: ProjectCreateRequest) => ipc<Result<ProjectMeta>>('project_create', req);
export const projectUpdate = (req: ProjectUpdateRequest) => ipc<Result<ProjectMeta>>('project_update', req);
export const projectRemove = (projectId: ProjectId) => ipc<Result<null>>('project_remove', { projectId });
export const projectGetStandards = (projectId: ProjectId) =>
  ipc<Result<StandardsRead>>('project_get_standards', { projectId });
export const projectSetStandards = (projectId: ProjectId, standards: ProjectStandards) =>
  ipc<Result<StandardsRead>>('project_set_standards', { projectId, standards });
// session-welcome: the SESSION header's repo facts. Read-only, keyed by session
// because the core owns the cwd (and the git routing that follows from it).
export const projectRepoBrief = (sessionId: SessionId) =>
  ipc<Result<RepoBrief>>('project_repo_brief', { sessionId });

// project-groups (§5). Four commands, no event channel: every mutation
// resolves with the new state, same pattern as the rest of the project domain.
export const projectCreateGroup = (name: string) =>
  ipc<ProjectCreateGroupResponse>('project_create_group', { name });
export const projectRenameGroup = (groupId: GroupId, name: string) =>
  ipc<ProjectRenameGroupResponse>('project_rename_group', { groupId, name });
export const projectRemoveGroup = (groupId: GroupId) =>
  ipc<ProjectRemoveGroupResponse>('project_remove_group', { groupId });
export const projectAssignGroup = (projectId: ProjectId, groupId: GroupId | null) =>
  ipc<ProjectAssignGroupResponse>('project_assign_group', { projectId, groupId });

// session-profiles (§5.2). Four commands, no event channel: every mutation is
// initiated by this frontend and resolves with the new state (spec §5 preamble).
// pi-migration-rollout §5: create/update now take the SessionProfile union
// (ProfileCreateInput/ProfileUpdateInput), and a fifth command — copyToPi —
// spins a reviewed Pi copy off a legacy profile (FR-4) without touching it.
export const profilesList = () => ipc<Result<SessionProfile[]>>('profiles_list');
export const profilesCreate = (req: ProfileCreateInput) => ipc<Result<SessionProfile>>('profiles_create', req);
export const profilesUpdate = (req: ProfileUpdateInput) => ipc<Result<SessionProfile>>('profiles_update', req);
export const profilesRemove = (req: ProfileRemoveInput) => ipc<Result<null>>('profiles_remove', req);
export const profilesCopyToPi = (req: ProfileCopyToPiInput) =>
  ipc<Result<PiSessionProfile>>('profiles_copy_to_pi', req);

// slash-menu FR-1/4: merged per-session command registry (francois:session:listCommands)
export const sessionListCommands = (sessionId: SessionId) =>
  ipc<Result<SlashCommandInfo[]>>('session_list_commands', { sessionId });

export const sessionSwitchModel = (sessionId: SessionId, modelId: string) =>
  ipc<Result<SessionMeta>>('session_switch_model', { sessionId, modelId });
// pi-models-metrics FR-5: the Pi twin of sessionSwitchModel above — an EXACT
// provider/model pair rather than a bare id (the amended SessionSwitchModelInput
// takes exactly one of the two). Kept as its own wrapper, not an overload, so
// every existing `sessionSwitchModel(sessionId, modelId)` call site is untouched.
// Accepted only when the session is settled with no dispatch/compaction pending
// (else SESSION_BUSY); a failure preserves the previous selection. Same single
// update path as its sibling: the accompanying session.meta / model.changed
// events, never this Result, which is read only to surface a failure inline.
export const sessionSwitchRuntimeModel = (sessionId: SessionId, runtimeModel: RuntimeModelRef) =>
  ipc<Result<SessionMeta>>('session_switch_model', { sessionId, runtimeModel });
// session-permission-mode FR-1: the twin of sessionSwitchModel above — sets
// SessionMeta.permissionMode for the session's NEXT turn (FR-6: a running
// turn is unaffected). The frontend's only update path is the session.meta
// event that accompanies this Result (FR-12); the Result itself is used only
// to surface a failure (FR-13).
export const sessionSwitchPermissionMode = (sessionId: SessionId, mode: PermissionMode) =>
  ipc<Result<SessionMeta>>('session_switch_permission_mode', { sessionId, mode });
// rework-top-bar (design 11c): the third member of the switch family — the effort
// level lives INSIDE the model row of the run chip's panel, because effort is a
// property of the model rather than a setting beside it. `null` clears it and hands
// the model back its own default. Same update path as its two siblings: the
// accompanying session.meta event, never the Result.
export const sessionSwitchEffort = (sessionId: SessionId, effort: string | null) =>
  ipc<Result<SessionMeta>>('session_switch_effort', { sessionId, effort });
// response-mode FR-2: the fourth member of the switch family — HOW the model is
// told to write, from the next turn on (FR-4: a running turn is unaffected). The
// `mode` is re-validated by the core, so this wrapper's narrowing is a convenience
// and never the check (FR-3). Same single update path as its siblings: the
// accompanying session.meta event, never this Result (FR-18) — which is read only
// to surface a failure inline.
export const sessionSwitchResponseMode = (sessionId: SessionId, mode: ResponseMode) =>
  ipc<Result<SessionMeta>>('session_switch_response_mode', { sessionId, mode });
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
// pi-skills-capabilities §5 / pr-142 §6: `invocation`/`delivery` REQUIRED for a
// Pi session, ignored by every other runtime — every caller builds the whole
// request with skills-run.ts's buildSkillsRunRequest (which carries the LISTED
// entry's own `invocation`, never the derived `name` alone), so it's safe to
// send them unconditionally rather than branching on agentRuntime.
export const skillsRun = (request: SkillsRunRequest) => ipc<Result<null>>('skills_run', request);

// pi-skills-capabilities FR-5 (LEAD ADDITION, session-engine §5): records the
// per-SESSION unrestricted-tools acknowledgment after creation — idempotent,
// changes nothing else. The frontend's only update path is the accompanying
// session.meta event; this Result is read only to surface a failure inline.
export const sessionAcknowledgePolicy = (sessionId: SessionId) =>
  ipc<Result<SessionMeta>>('session_acknowledge_policy', { sessionId } satisfies RuntimePolicyAcknowledgeInput);

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
// multi-provider-endpoint (§5). Endpoint accounts add/update resolve the same
// FRESH re-read list every other mutation does; test is stateless (FR-9) and
// never touches the registry, so it carries no such list.
export const accountAddEndpoint = (payload: AccountAddEndpointPayload) =>
  ipc<AccountAddEndpointResponse>('account_add_endpoint', payload);
export const accountUpdateEndpoint = (payload: AccountUpdateEndpointPayload) =>
  ipc<AccountUpdateEndpointResponse>('account_update_endpoint', payload);
export const accountTestEndpoint = (payload: AccountTestEndpointPayload) =>
  ipc<AccountTestEndpointResponse>('account_test_endpoint', payload);
// multi-provider-codex (§5). `addCodex` resolves the same fresh list every other
// mutation does; `codexLogin` resolves as soon as the browser round-trip starts
// and the row's `signedIn` arrives later on account.list.
export const accountAddCodex = (payload: AccountAddCodexPayload) =>
  ipc<AccountAddCodexResponse>('account_add_codex', payload);
export const accountCodexLogin = (payload: AccountCodexLoginPayload) =>
  ipc<AccountCodexLoginResponse>('account_codex_login', payload);
// multi-provider-grok FR-20/FR-21. Same shape as the Codex pair above:
// `addGrok` resolves the fresh list, `grokLogin` resolves as soon as the
// browser round-trip starts and `signedIn` arrives later on account.list.
export const accountAddGrok = (payload: AccountAddGrokPayload) =>
  ipc<AccountAddGrokResponse>('account_add_grok', payload);
export const accountGrokLogin = (payload: AccountGrokLoginPayload) =>
  ipc<AccountGrokLoginResponse>('account_grok_login', payload);
// pi-provider-auth (§5). `addPi` registers a reference to an existing,
// user-trusted `PI_CODING_AGENT_DIR` and resolves the same fresh list every
// other mutation does; `trustPi` mirrors it. `piSetup` starts the SAME
// login-PTY infrastructure `accountAdd` already uses — its bytes and outcome
// arrive on the shared francois://account/event stream, not the response —
// and `piRefresh` runs a stateless per-account probe with no event of its own.
export const accountAddPi = (payload: PiAccountCreateInput) => ipc<AccountAddPiResponse>('account_add_pi', payload);
export const accountTrustPi = (payload: AccountTrustPiPayload) =>
  ipc<AccountTrustPiResponse>('account_trust_pi', payload);
export const accountPiSetup = (payload: PiSetupInput) => ipc<AccountPiSetupResponse>('account_pi_setup', payload);
export const accountPiRefresh = (payload: PiRefreshAuthInput) =>
  ipc<AccountPiRefreshResponse>('account_pi_refresh', payload);
// The vendor CLIs the login routes are driven by. `cliTools` re-probes PATH on
// every call (never cached — installing one in a terminal is the normal case);
// `installCli` resolves as soon as `npm i -g` is spawned, and its output plus
// its outcome arrive on the shared francois://account/event stream.
export const accountCliTools = () => ipc<AccountCliToolsResponse>('account_cli_tools');
export const accountInstallCli = (payload: AccountInstallCliPayload) =>
  ipc<AccountInstallCliResponse>('account_install_cli', payload);

// pi-session-durability (§5): explicit, read-only re-attachment to a Pi
// session's RECORDED native conversation — never a fresh-thread fallback on
// failure (FR-3). Same single update path as every other switch verb: the
// accompanying session.meta event (recovery flips to 'ready' on success, or to
// the matching non-ready state on a RUNTIME_SESSION_*/RUNTIME_ACCOUNT_MISSING/
// RUNTIME_INCOMPATIBLE failure) — this Result is read only to surface a
// failure inline.
export const sessionReconnect = (sessionId: SessionId) =>
  ipc<Result<SessionMeta>>('session_reconnect', { sessionId } satisfies RuntimeReconnectInput);
// "Create new session" from one whose native conversation cannot be resumed:
// a NEW session id, no messages, no native resume anchor — the source session
// is left untouched. `name` optional (session-rename FR-1's cleaning rule).
export const sessionNewFrom = (sessionId: SessionId, name?: string) =>
  ipc<Result<SessionMeta>>('session_new_from', { sessionId, name } satisfies RuntimeNewFromSessionInput);

// pi-runtime-distribution §5: francois:runtime:installation. Missing/incompatible/
// probe-failed are successful health responses carrying `error` on the payload
// itself — `Result.error` here is reserved for INVALID_INPUT/INTERNAL. Cached in
// the core for 60s, keyed by environment; `refresh: true` bypasses that cache.
export const runtimeInstallation = (payload: RuntimeInstallProbeInput) =>
  ipc<Result<RuntimeInstallStatus>>('runtime_installation', payload);

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

// cloud-sessions (§5). Francois ADOPTS a Claude Code on the web session — a
// one-way pull that ends as an ordinary local session. `cloud_list` is a
// convenience that degrades to `{ sessions: [], degraded: true }` rather than
// failing (FR-2), so only the auth refusals ever resolve ok:false; `cloud_adopt`
// resolves once the adoption finished — its progress arrives on the event
// channel below (FR-7), which is what the modal renders instead of a spinner.
export const cloudList = (accountId?: AccountId) =>
  ipc<Result<CloudListData>>('cloud_list', accountId ? { accountId } : undefined);
export const cloudResolve = (req: CloudResolveRequest) => ipc<Result<CloudResolveData>>('cloud_resolve', req);
export const cloudAdopt = (req: CloudAdoptRequest) => ipc<Result<CloudAdoptData>>('cloud_adopt', req);

/** Subscribe to francois://cloud/event (cloud.adopt). */
export function onCloudEvent(cb: (e: CloudEvent) => void): Promise<UnlistenFn> {
  return stream<CloudEvent>('francois://cloud/event', cb);
}

// multiple-shells (§5). The domain is keyed by ShellId end to end — every
// call below addresses a shell directly, never a session's "the" shell.
export const shellEnsure = (payload: ShellEnsurePayload) => ipc<Result<ShellEnsureData>>('shell_ensure', payload);
// unbound-panes FR-6: a shell's owner is a union now — `shellCreate` takes it
// directly rather than assuming a session.
export const shellCreate = (owner: ShellOwner) => ipc<Result<ShellInfo>>('shell_create', { owner } satisfies ShellCreatePayload);
export const shellRestart = (shellId: ShellId) =>
  ipc<Result<ShellRestartData>>('shell_restart', { shellId } satisfies ShellRestartPayload);
export const shellRename = (shellId: ShellId, name: string) =>
  ipc<Result<ShellInfo>>('shell_rename', { shellId, name } satisfies ShellRenamePayload);
export const shellDispose = (shellId: ShellId) =>
  ipc<Result<void>>('shell_dispose', { shellId } satisfies ShellDisposePayload);
export const shellWrite = (shellId: ShellId, data: string) =>
  ipc<Result<void>>('shell_write', { shellId, data } satisfies ShellWritePayload);
export const shellResize = (shellId: ShellId, cols: number, rows: number) =>
  ipc<Result<void>>('shell_resize', { shellId, cols, rows } satisfies ShellResizePayload);

// extensions (§5, amended by extension-install §5). Seven commands + one event
// channel. `setEnabled`, `detect` and `consent` all resolve the FULL refreshed
// list rather than an ack (FR-8/FR-57/FR-16), so the frontend never re-queries
// to learn what changed. extension-install FR-24 removed `probe`/`launch` —
// no panel mutates anything anymore.
export const extensionsList = (req: ListExtensionsRequest) =>
  ipc<ListExtensionsResponse>('extensions_list', req);
export const extensionsSetEnabled = (req: SetExtensionEnabledRequest) =>
  ipc<SetExtensionEnabledResponse>('extensions_set_enabled', req);
export const extensionsDetect = (req: DetectExtensionsRequest) =>
  ipc<DetectExtensionsResponse>('extensions_detect', req);
export const extensionsPanel = (req: PanelRequest) => ipc<PanelResponse>('extensions_panel', req);
export const extensionsOpenStream = (req: OpenStreamRequest) =>
  ipc<OpenStreamResponse>('extensions_open_stream', req);
export const extensionsCloseStream = (req: CloseStreamRequest) =>
  ipc<CloseStreamResponse>('extensions_close_stream', req);
// extension-install FR-16 — the only way `enabled` becomes true for a
// `never`/`stale` extension.
export const extensionsConsent = (req: ConsentRequest) => ipc<ConsentResponse>('extensions_consent', req);

/** Subscribe to francois://extensions/event (the log-tail stream, FR-44). */
export function onExtensionEvent(cb: (e: ExtensionEvent) => void): Promise<UnlistenFn> {
  return stream<ExtensionEvent>('francois://extensions/event', cb);
}

/** Subscribe to francois://shell/event (shell.data / shell.exit). */
export function onShellEvent(cb: (e: ShellEvent) => void): Promise<UnlistenFn> {
  return stream<ShellEvent>('francois://shell/event', cb);
}

/** Subscribe to the core→frontend session event stream. */
export function onSessionEvent(cb: (e: SessionEvent) => void): Promise<UnlistenFn> {
  return stream<SessionEvent>('francois://session/event', cb);
}
