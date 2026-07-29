// contract/agent-tab.ts — agent-tab (dynamic main-pane tab per subagent).
// Authored from specs/agent-tab.md §5. Imports shared vocabulary from common.ts
// and the block vocabulary from conversation-view.ts; never redefines either.
//
// Physical Tauri binding:
//   `francois:agents:transcript` → command `agents_transcript`
//   `francois:agents:event`      → Tauri event `francois://agents/event`

import type { AgentId, BlockId, Result, SessionId } from './common';
import type {
  AssistantConversationBlock,
  SubagentConversationBlock,
  ToolConversationBlock,
} from './conversation-view';

// ---------- the agent transcript ----------

/**
 * A lifecycle marker minted by the engine (dispatch / completion / kill / turn
 * end) — the block-level twin of an `AgentStep` of kind `notice` (async-agents
 * FR-12). Never streams: it is appended already final.
 */
export interface AgentNoticeBlock {
  kind: 'notice';
  blockId: BlockId;
  isStreaming: false;
  text: string;
}

/**
 * One block of a subagent's own conversation. Deliberately the SAME shapes the
 * SESSION tab renders (conversation-view §5) plus the notice marker, so the tab
 * body reuses that renderer rather than growing a second one. `user` blocks
 * cannot occur — a subagent has no user turns — and `command`/`question`/
 * `permission` blocks belong to the parent session's control channel.
 */
export type AgentBlock =
  | AssistantConversationBlock
  | ToolConversationBlock
  | SubagentConversationBlock // a subagent dispatching its own subagent (one level deep)
  | AgentNoticeBlock;

// ---------- francois:agents:transcript ----------

export interface AgentsTranscriptRequest {
  agentId: AgentId;
}

export interface AgentTranscript {
  /** Ordered oldest → newest, windowed to the core's per-agent cap. */
  blocks: AgentBlock[];
  /** Blocks evicted past the cap — 0 when the window holds everything. */
  dropped: number;
}

export type AgentsTranscriptResponse = Result<AgentTranscript>;
// invoke('agents_transcript', req: AgentsTranscriptRequest): Promise<AgentsTranscriptResponse>

// ---------- francois:agents:event ----------

/**
 * The `agents` domain event stream. Separate from `francois:session:event`
 * because `AgentBlock` builds on conversation-view's block types while
 * `contract/common.ts` (which owns SessionEvent) is deliberately import-free.
 *
 * `agent.block` is emitted both when a block is appended and when an existing
 * block is re-emitted with its `meta` filled — consumers upsert by `blockId`.
 */
export type AgentEvent = {
  type: 'agent.block';
  sessionId: SessionId;
  agentId: AgentId;
  block: AgentBlock;
};

// ---------- consumed ----------
// francois:session:event → SessionEvent; this feature reacts to
//   { type: 'agent.update'; agent }  — the tab's header (name, status, elapsed)

export type { Result };
