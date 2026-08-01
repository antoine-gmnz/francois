// contract/workflow-details.ts — workflow-details (dynamic main tab: a workflow
// run's agents, timeline and transcripts).
// Authored from specs/workflow-details.md §5. Imports shared vocabulary from
// common.ts and the block vocabulary from agent-tab.ts; never redefines either.
//
// Physical Tauri binding:
//   `francois:workflows:detail` → command `workflows_detail`
//   `francois:workflows:agent`  → command `workflows_agent`
//   `francois:workflows:script` → command `workflows_script`
//   `francois:workflows:event`  → Tauri event `francois://workflows/event`

import type { BlockId, Result, SessionId, WorkflowRunId } from './common';
import type { AgentBlock } from './agent-tab';

// ---------- the run's agents ----------

export type WorkflowAgentId = string; // the harness's `a…` id

/**
 * Three-valued from disk (`done`/`running`/`stopped` — the journal has no
 * failure event, so a dead agent is a `started` with no `result`), plus a
 * fourth, `waiting`, imposed by FR-22 when a pending ask is attributed to the
 * agent. `waiting` overrides `running` only.
 */
export type WorkflowAgentStatus = 'running' | 'done' | 'stopped' | 'waiting';

export interface WorkflowTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

export interface WorkflowAgentInfo {
  agentId: WorkflowAgentId;
  agentType: string; // 'workflow-subagent' when unspecialised
  model?: string;
  status: WorkflowAgentStatus;
  startedAt: number; // epoch ms, first transcript line
  lastAt?: number; // absent while running
  prompt: string; // <= 200 chars, may be ''
  tokens: WorkflowTokens;
  result?: string; // stringified return value, <= 2000 chars
}

// ---------- asks raised inside a run (FR-20..FR-25) ----------

/** Correlation only — the card's payload stays where it already lives. */
export interface WorkflowPendingAsk {
  blockId: BlockId; // the key the existing card is stored under
  kind: 'permission' | 'question';
  agentId?: WorkflowAgentId; // absent unless ladder rung 2 matched
  toolName?: string; // permission asks only, for the row label
  confidence: 'exact' | 'inferred'; // 'inferred' => ladder rung 3
}

// ---------- francois:workflows:detail ----------

export interface WorkflowDetailRequest {
  runId: WorkflowRunId;
}

export interface WorkflowDetail {
  id: WorkflowRunId;
  sessionId: SessionId;
  transcriptDir: string;
  hasScript: boolean;
  agents: WorkflowAgentInfo[];
  tokens: WorkflowTokens; // run total
  pendingAsks: WorkflowPendingAsk[]; // [] when nothing is blocking
}

export type WorkflowDetailResponse = Result<WorkflowDetail>;
// invoke('workflows_detail', req: WorkflowDetailRequest): Promise<WorkflowDetailResponse>
// Errors: WORKFLOW_NOT_FOUND, WORKFLOW_NO_TRANSCRIPT

// ---------- francois:workflows:agent ----------

export interface WorkflowAgentRequest {
  runId: WorkflowRunId;
  agentId: WorkflowAgentId;
}

export interface WorkflowAgentTranscript {
  blocks: AgentBlock[];
  dropped: number;
}

export type WorkflowAgentResponse = Result<WorkflowAgentTranscript>;
// invoke('workflows_agent', req: WorkflowAgentRequest): Promise<WorkflowAgentResponse>
// Errors: WORKFLOW_NOT_FOUND, WORKFLOW_AGENT_NOT_FOUND

// ---------- francois:workflows:script ----------

export interface WorkflowScriptRequest {
  runId: WorkflowRunId;
}

export interface WorkflowScript {
  path: string;
  source: string;
  truncated: boolean;
}

export type WorkflowScriptResponse = Result<WorkflowScript>;
// invoke('workflows_script', req: WorkflowScriptRequest): Promise<WorkflowScriptResponse>
// Errors: WORKFLOW_NOT_FOUND, WORKFLOW_NO_SCRIPT

// ---------- francois:workflows:event ----------

export type WorkflowDetailEvent = {
  type: 'workflow.detail';
  sessionId: SessionId;
  detail: WorkflowDetail;
};

// ---------- consumed ----------
// francois:session:event → SessionEvent; this feature reacts to
//   { type: 'workflow.update'; run: WorkflowRun } — the panel's own event, which
//   keeps the tab header's run status and elapsed clock live (FR-14).

export type { Result, SessionId, WorkflowRunId };
