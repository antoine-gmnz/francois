// workflow-details — the body of a `workflow:{id}` main tab (spec FR-15..FR-19,
// FR-25; design brief §2a–2e). Two columns: a 312px rail holding the run header
// and the agent list, and the remaining width for the selected agent's
// transcript, the script source, or an ask that is blocking the run.
//
// Three things are deliberately NOT redesigned here (the brief's own rules):
// the transcript renders through the SESSION tab's block renderer
// (`AgentBlockRow`), the approval/question cards are the existing components
// keyed by the same `blockId`, and the agent rows wear pane [3]'s card metrics.
// Everything on screen is derived in workflow-detail.ts — nothing is stored.

import { useEffect, useRef, useState } from 'react';
import { formatElapsed } from '../../../contract/conversation-view';
import type { ConversationBlock } from '../../../contract/conversation-view';
import type { WorkflowRun } from '../../../contract/common';
import type { WorkflowAgentInfo, WorkflowPendingAsk } from '../../../contract/workflow-details';
import { workflowsScript } from '../../lib/api';
import { Chip } from '../../ui/Chip';
import { StatusDot } from '../../ui/StatusDot';
import { AgentBlockRow } from '../agents/AgentView';
import { isAtBottom } from '../agents/agent-trail';
import Block from '../conversation/Block';
import { useWorkflowAgentTranscript } from './useWorkflowAgentTranscript';
import { useWorkflowAskCards } from './useWorkflowAskCards';
import { useWorkflowDetail } from './useWorkflowDetail';
import {
  CLOSED_SCRIPT,
  INFERRED_NOTE,
  NO_ACTIVITY_LABEL,
  NO_AGENTS_LABEL,
  RESULT_LABEL,
  SCRIPT_TOGGLE_LABEL,
  SCRIPT_TRUNCATED_LABEL,
  SELECT_AGENT_LABEL,
  agentActivityKey,
  agentCountLabel,
  agentElapsedMs,
  agentStatusColor,
  askOwnerLabel,
  asksForAgent,
  earlierBlocksNotice,
  findAgent,
  formatTokens,
  openScriptRequest,
  prettyResult,
  receiveScript,
  rightColumnMode,
  runWindow,
  sumTokens,
  waitingBannerLabel,
  type WorkflowScriptState,
  type WorkflowTranscriptState,
} from './workflow-detail';
import { PHASES_NOTE } from './workflow-run';
import WorkflowAgentRow from './WorkflowAgentRow';
import './workflow-detail.css';

const runStatusColor: Record<string, string> = {
  running: 'var(--accent-2)',
  done: 'var(--success)',
  error: 'var(--error)',
};

export default function WorkflowView({ runId, sessionId }: { runId: string; sessionId: string }) {
  const { run, state } = useWorkflowDetail(runId, sessionId);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [scriptOpen, setScriptOpen] = useState(false);
  const [script, setScript] = useState<WorkflowScriptState>(CLOSED_SCRIPT);
  const [clockNow, setClockNow] = useState(() => Date.now());
  const scriptReq = useRef(0);
  const scroller = useRef<HTMLDivElement>(null);
  // §2c-bis: "selecting the owning agent scrolls its card into view" — one DOM
  // node per pending ask, registered by AskCard, looked up by blockId.
  const askRefs = useRef(new Map<string, HTMLDivElement>());
  const registerAskRef = (blockId: string, el: HTMLDivElement | null) => {
    if (el) askRefs.current.set(blockId, el);
    else askRefs.current.delete(blockId);
  };

  const detail = state.detail;
  const agents = detail?.agents ?? [];
  const asks = detail?.pendingAsks ?? [];
  const selectedAgent = findAgent(agents, selectedAgentId);

  // FR-25/FR-26: the cards themselves live in the parent session's transcript —
  // this feature only correlates them by blockId, and only fetches while
  // something is actually blocking.
  const askCards = useWorkflowAskCards(sessionId, asks.length > 0);
  const { state: transcript, setAtBottom } = useWorkflowAgentTranscript(
    runId,
    selectedAgentId,
    agentActivityKey(selectedAgent),
  );

  // FR-19: the 1 Hz clock behind the header elapsed, the row elapsed and the bar
  // extents runs only while the run is running.
  const running = run?.status === 'running';
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setClockNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running]);

  // FR-18: jump to the newest block unless the user scrolled up in the column.
  const newest = transcript.blocks.length > 0 ? transcript.blocks[transcript.blocks.length - 1].blockId : '';
  useEffect(() => {
    const el = scroller.current;
    if (!el || !transcript.atBottom) return;
    el.scrollTop = el.scrollHeight;
  }, [newest, transcript.blocks.length, transcript.atBottom]);

  // FR-9: the source is fetched once per tab and kept — re-opening the toggle
  // must not blank the column while the same bytes come back.
  const loadScript = () => {
    const reqId = scriptReq.current + 1;
    scriptReq.current = reqId;
    setScript((prev) => openScriptRequest(prev, reqId));
    void workflowsScript(runId)
      .then((res) => setScript((prev) => receiveScript(prev, reqId, res)))
      .catch((err: unknown) =>
        setScript((prev) => receiveScript(prev, reqId, { ok: false, error: { code: 'INTERNAL', message: String(err) } })),
      );
  };
  const toggleScript = () => {
    const next = !scriptOpen;
    setScriptOpen(next);
    if (next && script.script === null && !script.loading) loadScript();
  };

  const mode = rightColumnMode({ scriptOpen, selectedAgentId, askCount: asks.length });
  // FR-16: ONE origin for every bar in the list — never a per-row window.
  const runSpan = runWindow(run, agents, clockNow);

  return (
    <div className="wfd-view">
      <div className="scz wfd-rail">
        <RunHeader
          run={run}
          agents={agents}
          asks={asks}
          totalTokens={detail === null ? 0 : sumTokens(detail.tokens)}
          now={clockNow}
          hasScript={detail?.hasScript ?? false}
          scriptOpen={scriptOpen}
          onToggleScript={toggleScript}
        />

        <div className="wfd-agents">
          {state.error ? (
            // FR-10 / §Notes: fail soft, visibly but quietly — one inline row.
            <div className="wfd-agents__error">{state.error.message}</div>
          ) : agents.length === 0 ? (
            <div className="wfd-agents__empty">{NO_AGENTS_LABEL}</div>
          ) : (
            agents.map((agent) => (
              <WorkflowAgentRow
                key={agent.agentId}
                agent={agent}
                run={runSpan}
                now={clockNow}
                selected={agent.agentId === selectedAgentId}
                onSelect={() => {
                  setSelectedAgentId(agent.agentId);
                  setScriptOpen(false); // clicking a row returns from the script
                  // §2c-bis: scroll the ask this agent owns into view rather
                  // than opening a second copy under the transcript.
                  const owned = asksForAgent(asks, agent.agentId);
                  if (owned.length > 0) {
                    askRefs.current.get(owned[0].blockId)?.scrollIntoView({ block: 'nearest' });
                  }
                }}
              />
            ))
          )}
        </div>
      </div>

      <div className="wfd-col">
        {/* §2c-bis: attributed asks sit above everything else so they cannot be
            scrolled past. One copy, never a second under the selected agent. */}
        {asks.length > 0 && (
          <div className="scz wfd-asks">
            {asks.map((ask) => (
              <AskCard
                key={ask.blockId}
                ask={ask}
                agents={agents}
                block={askCards.get(ask.blockId)}
                sessionId={sessionId}
                registerRef={registerAskRef}
              />
            ))}
          </div>
        )}

        {mode === 'transcript' && selectedAgent && (
          <TranscriptHeader agent={selectedAgent} now={clockNow} />
        )}

        <div
          ref={scroller}
          className="scz wfd-col__body"
          onScroll={(e) => setAtBottom(isAtBottom(e.currentTarget))}
        >
          {mode === 'script' ? (
            <ScriptSource state={script} />
          ) : mode === 'transcript' && selectedAgent ? (
            <AgentTranscript agent={selectedAgent} state={transcript} sessionId={sessionId} />
          ) : mode === 'summary' ? (
            <div className="wfd-col__empty">{SELECT_AGENT_LABEL}</div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** §2a: what the run itself says — plan on top, reality (the agent list) below. */
function RunHeader({
  run,
  agents,
  asks,
  totalTokens,
  now,
  hasScript,
  scriptOpen,
  onToggleScript,
}: {
  run: WorkflowRun | null;
  agents: WorkflowAgentInfo[];
  asks: WorkflowPendingAsk[];
  totalTokens: number;
  now: number;
  hasScript: boolean;
  scriptOpen: boolean;
  onToggleScript: () => void;
}) {
  const status = run?.status ?? 'running';
  const color = runStatusColor[status] ?? 'var(--text-muted)';
  const elapsedMs = run === null ? 0 : Math.max(0, (run.endedAt ?? now) - run.startedAt);
  const waiting = waitingBannerLabel(asks);
  return (
    <div className="wfd-run">
      <div className="wfd-run__row">
        <StatusDot color={color} size={7} pulsing={status === 'running'} />
        <span className="wfd-run__name truncate">{run?.name ?? 'workflow'}</span>
        <span className="wfd-run__status" style={{ color }}>
          {status}
        </span>
      </div>

      {run && run.description !== '' && <div className="wfd-run__description">{run.description}</div>}

      <div className="wfd-run__meta">
        <span>◷ {formatElapsed(elapsedMs)}</span>
        <span className="wfd-run__meta-sep">·</span>
        <span>{agentCountLabel(agents)}</span>
        <span className="wfd-run__meta-sep">·</span>
        <span>{formatTokens(totalTokens)} tok</span>
        <span className="wfd-run__spacer" />
        {hasScript && (
          <Chip selected={scriptOpen} onClick={onToggleScript} className="wfd-run__script-chip">
            {SCRIPT_TOGGLE_LABEL}
          </Chip>
        )}
      </div>

      {/* the one place this view raises its voice — it replaces nothing above */}
      {waiting && <div className="wfd-run__waiting">{waiting}</div>}

      {run && run.phases.length > 0 && (
        <div className="wfd-phases">
          <div className="wfd-phases__note">{PHASES_NOTE}</div>
          {run.phases.map((phase, i) => (
            <div key={`${phase.title}-${i}`} className="wfd-phase">
              <span className="wfd-phase__index">{i + 1}</span>
              <span className="wfd-phase__title truncate">{phase.title}</span>
              {phase.detail && <span className="wfd-phase__detail truncate">{phase.detail}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** §2c: who the column is reading, fixed above the scroller. */
function TranscriptHeader({ agent, now }: { agent: WorkflowAgentInfo; now: number }) {
  const color = agentStatusColor(agent.status);
  return (
    <div className="wfd-col__head">
      <div className="wfd-col__head-row">
        <StatusDot color={color} size={7} pulsing={agent.status === 'running'} />
        <span className="wfd-col__type">{agent.agentType}</span>
        {agent.model && <span className="wfd-agent__model">{agent.model}</span>}
        <span className="wfd-col__status" style={{ color }}>
          {agent.status}
        </span>
        <span className="wfd-agent__spacer" />
        <span className="wfd-col__elapsed">◷ {formatElapsed(agentElapsedMs(agent, now))}</span>
      </div>
      {agent.prompt !== '' && <div className="wfd-col__prompt truncate">{agent.prompt}</div>}
    </div>
  );
}

/** FR-17 / §2c: the agent's own conversation, then the value it returned. */
function AgentTranscript({
  agent,
  state,
  sessionId,
}: {
  agent: WorkflowAgentInfo;
  state: WorkflowTranscriptState;
  sessionId: string;
}) {
  if (state.loading) return null; // the panel loading convention: render nothing
  if (state.error) return <div className="wfd-col__error">{state.error.message}</div>;
  const earlier = earlierBlocksNotice(state.dropped);
  return (
    <>
      {earlier && <div className="wfd-col__notice">{earlier}</div>}
      {state.blocks.length === 0 && agent.result === undefined ? (
        <div className="wfd-col__empty">{NO_ACTIVITY_LABEL}</div>
      ) : (
        state.blocks.map((block) => <AgentBlockRow key={block.blockId} block={block} sessionId={sessionId} />)
      )}
      {agent.result !== undefined && (
        <div className="wfd-returned">
          <div className="wfd-returned__label">{RESULT_LABEL}</div>
          <pre className="wfd-code">{prettyResult(agent.result)}</pre>
        </div>
      )}
    </>
  );
}

/** §2d: the `.js` the harness wrote, read-only and unhighlighted. */
function ScriptSource({ state }: { state: WorkflowScriptState }) {
  if (state.error) return <div className="wfd-col__error">{state.error.message}</div>;
  if (state.script === null) return null; // in flight
  return (
    <>
      <div className="wfd-script__path">{state.script.path}</div>
      <pre className="wfd-code wfd-script__source">{state.script.source}</pre>
      {state.script.truncated && <div className="wfd-script__truncated">{SCRIPT_TRUNCATED_LABEL}</div>}
    </>
  );
}

/**
 * FR-25/FR-26: the EXISTING approval / question card, mirrored under an
 * ownership line. A blockId that is no longer pending simply has no block —
 * the card disappears rather than being left as a dead control.
 */
function AskCard({
  ask,
  agents,
  block,
  sessionId,
  registerRef,
}: {
  ask: WorkflowPendingAsk;
  agents: WorkflowAgentInfo[];
  block: ConversationBlock | undefined;
  sessionId: string;
  registerRef: (blockId: string, el: HTMLDivElement | null) => void;
}) {
  if (block === undefined) return null;
  return (
    <div className="wfd-ask" ref={(el) => registerRef(ask.blockId, el)}>
      <div className="wfd-ask__owner">
        {askOwnerLabel(ask, agents)}
        {/* Francois inferred rather than knew, and says so (§2c-bis) */}
        {ask.confidence === 'inferred' && <span className="wfd-ask__inferred">{INFERRED_NOTE}</span>}
      </div>
      <Block b={block} sessionId={sessionId} />
    </div>
  );
}
