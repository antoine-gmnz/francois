// contract/agents-panel.ts — agents-panel (pane [3]).
// Authored from specs/agents-panel.md §5. Imports shared vocabulary from
// common.ts; never redefines it.
//
// Physical Tauri binding: `francois:agents:list|dispatch|kill` → commands
// `agents_list` / `agents_dispatch` / `agents_kill`. Consumes the agent.update
// member of the francois://session/event stream.

import type { SessionId, AgentId, AgentInfo, Result } from './common';

// francois:agents:list
export interface AgentsListRequest {
  sessionId: SessionId;
}
export type AgentsListResponse = AgentInfo[];
// invoke('agents_list', req: AgentsListRequest): Promise<Result<AgentsListResponse>>

// francois:agents:dispatch
export interface AgentsDispatchRequest {
  sessionId: SessionId;
  task: string; // non-empty after trim(); engine assigns the AgentId and initial AgentInfo
}
export interface AgentsDispatchResponse {
  agentId: AgentId;
}
// invoke('agents_dispatch', req: AgentsDispatchRequest): Promise<Result<AgentsDispatchResponse>>

// francois:agents:kill
export interface AgentsKillRequest {
  agentId: AgentId;
}
// invoke('agents_kill', req: AgentsKillRequest): Promise<Result<void>>

// ---------- consumed ----------
// francois:session:event → SessionEvent; this feature reacts only to
// { type: 'agent.update'; agent: AgentInfo } filtered to the active session.

export type { AgentInfo, Result };
