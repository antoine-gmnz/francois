// contract/async-agents.ts — async subagent lifecycle + activity trail (pane [3]).
// Authored from specs/async-agents.md §5. Imports shared vocabulary from
// common.ts; never redefines it.
//
// Physical Tauri binding: `francois:agents:activity` → command `agents_activity`.
// Consumes the agent.step / agent.update members of the francois://session/event stream.

import type { SessionId, AgentId, AgentInfo, AgentStep, AgentStepKind, Result } from './common';

// francois:agents:activity
export interface AgentsActivityRequest {
  agentId: AgentId;
}
/** The agent's trail, ordered by `seq`, at most 200 entries (FR-12 window). */
export type AgentsActivityResponse = AgentStep[];
// invoke('agents_activity', req: AgentsActivityRequest): Promise<Result<AgentsActivityResponse>>
// Errors: AGENT_NOT_FOUND — agentId matches no agent in any session's registry (§5, §7).

// ---------- consumed ----------
// francois:session:event → SessionEvent; this feature reacts to
//   { type: 'agent.step'; sessionId; agentId; step }  — filtered to the expanded agent (FR-20)
//   { type: 'agent.update'; agent }                   — for background / lastActivity / stepCount

export type { SessionId, AgentId, AgentInfo, AgentStep, AgentStepKind, Result };
