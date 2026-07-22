// Typed wrappers over the Tauri session commands + the session event stream.
// Each command resolves a Result<T> (never rejects) per the contract.

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { Result, SessionMeta, ModelInfo, SessionEvent, SessionId, AgentInfo, McpServerInfo, SkillInfo, SlashCommandInfo } from '../contract/common';
import type { NewSessionRequest, PickDirectoryData } from '../contract/sessions-sidebar';
import type { ConversationBlock } from '../contract/conversation-view';
import type { McpServerDetail, McpRegistryEntry, McpAttachRequest } from '../contract/mcp-panel';
import type { SkillsEvent } from '../contract/skills-panel';
import type { DiffSummary, FileDiff, CommitResult, DiffEvent } from '../contract/diff-view';
import type { AppEvent, UsageRefreshAck, UsageSnapshot } from '../contract/usage-bar';

function ipc<T>(cmd: string, args?: object): Promise<T> {
  return invoke<T>(cmd, args as Record<string, unknown> | undefined);
}

export const sessionList = () => ipc<Result<SessionMeta[]>>('session_list');
export const sessionModels = () => ipc<Result<ModelInfo[]>>('session_models');
export const sessionCreate = (req: NewSessionRequest) => ipc<Result<SessionMeta>>('session_create', req);
export const sessionRemove = (sessionId: SessionId) => ipc<Result<null>>('session_remove', { sessionId });
export const sessionPickDirectory = () => ipc<Result<PickDirectoryData>>('session_pick_directory');
export const sessionSend = (sessionId: SessionId, blockId: string, text: string) =>
  ipc<Result<{ queued: boolean; queuePosition?: number }>>('session_send', { sessionId, blockId, text });
export const getTranscript = (sessionId: SessionId) =>
  ipc<Result<ConversationBlock[]>>('conversation_get_transcript', { sessionId });
export const sessionAnswerQuestion = (sessionId: SessionId, blockId: string, answers: Record<string, string>) =>
  ipc<Result<null>>('session_answer_question', { sessionId, blockId, answers });
// slash-menu FR-1/4: merged per-session command registry (francois:session:listCommands)
export const sessionListCommands = (sessionId: SessionId) =>
  ipc<Result<SlashCommandInfo[]>>('session_list_commands', { sessionId });

export const sessionSwitchModel = (sessionId: SessionId, modelId: string) =>
  ipc<Result<SessionMeta>>('session_switch_model', { sessionId, modelId });
export const sessionCompact = (sessionId: SessionId) => ipc<Result<null>>('session_compact', { sessionId });

export const agentsList = (sessionId: SessionId) => ipc<Result<AgentInfo[]>>('agents_list', { sessionId });
export const agentsDispatch = (sessionId: SessionId, task: string) =>
  ipc<Result<{ agentId: string }>>('agents_dispatch', { sessionId, task });
export const agentsKill = (agentId: string) => ipc<Result<null>>('agents_kill', { agentId });

export const mcpList = (sessionId: SessionId) => ipc<Result<McpServerInfo[]>>('mcp_list', { sessionId });
export const mcpDetail = (sessionId: SessionId, name: string) => ipc<Result<McpServerDetail>>('mcp_detail', { sessionId, name });
export const mcpReconnect = (sessionId: SessionId, name: string) => ipc<Result<null>>('mcp_reconnect', { sessionId, name });
export const mcpDetach = (sessionId: SessionId, name: string) => ipc<Result<null>>('mcp_detach', { sessionId, name });
export const mcpRegistry = () => ipc<Result<McpRegistryEntry[]>>('mcp_registry');
export const mcpAttach = (sessionId: SessionId, entry: McpAttachRequest) =>
  ipc<Result<null>>('mcp_attach', { sessionId, entry });

export const skillsList = (sessionId: SessionId) => ipc<Result<SkillInfo[]>>('skills_list', { sessionId });
export const skillsInstall = (sessionId: SessionId, name: string) => ipc<Result<null>>('skills_install', { sessionId, name });
export const skillsRun = (sessionId: SessionId, name: string, args?: string) =>
  ipc<Result<null>>('skills_run', { sessionId, name, args });

/** Subscribe to francois://skills/event (skills.changed). */
export function onSkillsEvent(cb: (e: SkillsEvent) => void): Promise<UnlistenFn> {
  return listen<SkillsEvent>('francois://skills/event', (e) => cb(e.payload));
}

export const diffGetSummary = (sessionId: SessionId) => ipc<Result<DiffSummary>>('diff_get_summary', { sessionId });
export const diffGetFileDiff = (sessionId: SessionId, path: string) =>
  ipc<Result<FileDiff>>('diff_get_file_diff', { sessionId, path });
export const diffStageAll = (sessionId: SessionId) => ipc<Result<null>>('diff_stage_all', { sessionId });
export const diffCommit = (sessionId: SessionId, message: string) =>
  ipc<Result<CommitResult>>('diff_commit', { sessionId, message });

/** Subscribe to francois://diff/event (diff.changed). */
export function onDiffEvent(cb: (e: DiffEvent) => void): Promise<UnlistenFn> {
  return listen<DiffEvent>('francois://diff/event', (e) => cb(e.payload));
}

// usage-bar (app domain, app-scoped plan limits). getUsage NEVER triggers a probe
// (FR-22); refreshUsage only acks — the result always arrives as a usage.state event.
export const appGetUsage = () => ipc<Result<UsageSnapshot>>('app_get_usage');
export const appRefreshUsage = () => ipc<Result<UsageRefreshAck>>('app_refresh_usage');

/** Subscribe to francois://app/event (usage.state, extensible tagged union). */
export function onAppEvent(cb: (e: AppEvent) => void): Promise<UnlistenFn> {
  return listen<AppEvent>('francois://app/event', (e) => cb(e.payload));
}

/** Subscribe to the core→frontend session event stream. */
export function onSessionEvent(cb: (e: SessionEvent) => void): Promise<UnlistenFn> {
  return listen<SessionEvent>('francois://session/event', (e) => cb(e.payload));
}
