// agent-tab — the body of a dynamic agent tab: one subagent's own conversation
// (specs/agent-tab.md FR-16..FR-21, §8). Renders through the SESSION tab's Block
// component, so an agent's tab reads exactly like a session's transcript.

import { useEffect, useRef, useState } from 'react';
import type { AgentInfo, SessionEvent } from '../../../contract/common';
import type { AgentBlock } from '../../../contract/agent-tab';
import type { ConversationBlock } from '../../../contract/conversation-view';
import { formatElapsed } from '../../../contract/conversation-view';
import { agentsList, agentsTranscript, onAgentEvent, onSessionEvent } from '../../lib/api';
import Block from '../conversation/Block';
import { TRANSCRIPT_TEXT_SELECT_STYLE } from '../conversation/conversation-blocks';
import { ASYNC_MARKER, STEP_GLYPH, STEP_GLYPH_COLOR, TRAIL_EMPTY_LABEL, isAtBottom, showAsyncMarker } from './agent-trail';
import {
  CLOSED_TRANSCRIPT,
  earlierBlocksNotice,
  openTranscript,
  receiveAgentTranscript,
  routeAgentEventToTranscript,
  type TranscriptState,
} from './agent-tab';
import { StatusDot } from '../../ui/StatusDot';
import './agents.css';

const statusColor: Record<string, string> = {
  running: 'var(--accent-2)',
  idle: 'var(--text-muted)',
  done: 'var(--success)',
  error: 'var(--error)',
};

export default function AgentView({ agentId, sessionId }: { agentId: string; sessionId: string }) {
  const [agent, setAgent] = useState<AgentInfo | null>(null);
  const [state, setState] = useState<TranscriptState>(CLOSED_TRANSCRIPT);
  const [clockNow, setClockNow] = useState(() => Date.now());
  const scroller = useRef<HTMLDivElement>(null);

  // FR-19: the header's own view of the agent — seeded from agents_list and kept
  // live by agent.update. Held here rather than read from pane [3] so the tab
  // does not depend on that panel being mounted.
  useEffect(() => {
    setAgent(null);
    let mounted = true;
    let unlisten: (() => void) | undefined;
    void onSessionEvent((e: SessionEvent) => {
      if (e.type === 'agent.update' && e.agent.id === agentId) setAgent(e.agent);
    }).then((unsub) => (mounted ? (unlisten = unsub) : unsub()));
    void agentsList(sessionId).then((res) => {
      if (!mounted || !res.ok) return;
      // A buffered agent.update already won — never overwrite it with the snapshot.
      setAgent((prev) => prev ?? res.data.find((agent) => agent.id === agentId) ?? null);
    });
    return () => {
      mounted = false;
      if (unlisten) unlisten();
    };
  }, [agentId, sessionId]);

  // FR-16/FR-17: hydrate the transcript, then apply agent.block live. Events that
  // arrive while the request is in flight are buffered and folded in after it.
  useEffect(() => {
    let mounted = true;
    let unlisten: (() => void) | undefined;
    const next = openTranscript(state, agentId);
    const reqId = next.reqId;
    setState(next);
    void onAgentEvent((e) => {
      setState((prev) => routeAgentEventToTranscript(prev, e));
    }).then((unsub) => (mounted ? (unlisten = unsub) : unsub()));
    // `ipc()` REJECTS on a transport failure instead of resolving a Result, so
    // funnel that through the same path or `loading` sticks true forever.
    void agentsTranscript(agentId)
      .then((res) => {
        if (mounted) setState((prev) => receiveAgentTranscript(prev, reqId, res));
      })
      .catch((err: unknown) => {
        if (mounted) {
          setState((prev) =>
            receiveAgentTranscript(prev, reqId, {
              ok: false,
              error: { code: 'INTERNAL', message: String(err) },
            }),
          );
        }
      });
    return () => {
      mounted = false;
      if (unlisten) unlisten();
    };
  }, [agentId]);

  // The elapsed clock ticks only while the agent runs (async-agents FR-7).
  const running = agent?.status === 'running';
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setClockNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running]);

  // FR-18: jump to the newest block unless the user scrolled up inside the body.
  const newest = state.blocks.length > 0 ? state.blocks[state.blocks.length - 1].blockId : '';
  useEffect(() => {
    const el = scroller.current;
    if (!el || !state.atBottom) return;
    el.scrollTop = el.scrollHeight;
  }, [newest, state.blocks.length, state.atBottom]);

  const sc = statusColor[agent?.status ?? 'idle'] ?? 'var(--text-muted)';
  const elapsedMs = agent ? Math.max(0, (agent.endedAt ?? clockNow) - agent.startedAt) : 0;
  const earlier = earlierBlocksNotice(state.dropped);

  return (
    <div className="agent-view">
      {/* header (§8): who this tab is, and whether it is still working */}
      <div className="agent-view-header">
        <div className="agent-inline-row">
          <StatusDot color={sc} pulsing={running} />
          <span className="agent-view-name">{agent?.name ?? 'agent'}</span>
          {agent && showAsyncMarker(agent) && <span className="agent-async-badge">{ASYNC_MARKER}</span>}
          {agent && (
            <span className="agent-view-status-text" style={{ color: sc }}>
              {agent.status}
            </span>
          )}
          <span className="agent-view-spacer" />
          <span className="agent-view-elapsed">◷ {formatElapsed(elapsedMs)}</span>
        </div>
        {agent?.task && <div className="agent-view-task truncate">{agent.task}</div>}
      </div>

      {/* body: the subagent's own transcript */}
      <div
        ref={scroller}
        className="scz agent-view-body"
        onScroll={(e) => {
          const at = isAtBottom(e.currentTarget);
          setState((prev) => (prev.atBottom === at ? prev : { ...prev, atBottom: at }));
        }}
        // mac-text-selection FR-1: the .agent-view-body rule already sets
        // `user-select: text`; WKWebView needs the -webkit- prefixed form too,
        // which this adds on top of the class — see TRANSCRIPT_TEXT_SELECT_STYLE.
        style={TRANSCRIPT_TEXT_SELECT_STYLE}
      >
        {state.loading ? null : state.error ? ( // FR-16: nothing while in flight
          <div className="agent-view-error">{state.error.message}</div>
        ) : state.blocks.length === 0 ? (
          <div className="agent-view-empty">{TRAIL_EMPTY_LABEL}</div>
        ) : (
          <>
            {earlier && <div className="agent-view-notice">{earlier}</div>}
            {state.blocks.map((block) => (
              <AgentBlockRow key={block.blockId} block={block} sessionId={sessionId} />
            ))}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * §8: engine notices render as a dim `·` row (the trail's notice vocabulary);
 * everything else is a real ConversationBlock and goes through the SESSION tab's
 * renderer untouched.
 *
 * Exported for workflow-details, whose transcript column renders the SAME
 * `AgentBlock` vocabulary (its design brief's rule 1: "the transcript column is
 * the SESSION tab's block rendering, unchanged") — one renderer, so the two
 * cannot drift.
 */
export function AgentBlockRow({ block, sessionId }: { block: AgentBlock; sessionId: string }) {
  if (block.kind === 'notice') {
    return (
      <div className="agent-block-notice-row">
        <span className="agent-block-notice-glyph" style={{ color: STEP_GLYPH_COLOR.notice }}>
          {STEP_GLYPH.notice}
        </span>
        <span className="agent-block-notice-text">{block.text}</span>
      </div>
    );
  }
  return <Block b={block as ConversationBlock} sessionId={sessionId} />;
}
