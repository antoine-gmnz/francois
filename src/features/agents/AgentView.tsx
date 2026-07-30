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

const C = {
  running: 'var(--accent-2)',
  idle: 'var(--text-muted)',
  done: 'var(--success)',
  error: 'var(--error)',
  faint: 'var(--text-faint)',
  dim: 'var(--text-dim)',
};

const statusColor: Record<string, string> = {
  running: C.running,
  idle: C.idle,
  done: C.done,
  error: C.error,
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
    }).then((u) => (mounted ? (unlisten = u) : u()));
    void agentsList(sessionId).then((res) => {
      if (!mounted || !res.ok) return;
      // A buffered agent.update already won — never overwrite it with the snapshot.
      setAgent((prev) => prev ?? res.data.find((a) => a.id === agentId) ?? null);
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
    }).then((u) => (mounted ? (unlisten = u) : u()));
    // `ipc()` REJECTS on a transport failure instead of resolving a Result, so
    // funnel that through the same path or `loading` sticks true forever.
    void agentsTranscript(agentId)
      .then((res) => {
        if (mounted) setState((prev) => receiveAgentTranscript(prev, reqId, res));
      })
      .catch((e: unknown) => {
        if (mounted) {
          setState((prev) =>
            receiveAgentTranscript(prev, reqId, {
              ok: false,
              error: { code: 'INTERNAL', message: String(e) },
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

  const sc = statusColor[agent?.status ?? 'idle'] ?? C.idle;
  const elapsedMs = agent ? Math.max(0, (agent.endedAt ?? clockNow) - agent.startedAt) : 0;
  const earlier = earlierBlocksNotice(state.dropped);

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {/* header (§8): who this tab is, and whether it is still working */}
      <div style={{ padding: '9px 14px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              flexShrink: 0,
              background: sc,
              animation: running ? 'pulse 1.4s ease-in-out infinite' : 'none',
            }}
          />
          <span style={{ fontSize: 12.5, color: 'var(--text-strong)', fontWeight: 500 }}>{agent?.name ?? 'agent'}</span>
          {agent && showAsyncMarker(agent) && (
            <span
              style={{
                fontSize: 9,
                letterSpacing: '0.08em',
                color: C.faint,
                padding: '1px 5px',
                borderRadius: 8,
                background: 'var(--bg-raised)',
              }}
            >
              {ASYNC_MARKER}
            </span>
          )}
          {agent && <span style={{ fontSize: 10, color: sc }}>{agent.status}</span>}
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 10.5, color: C.faint }}>◷ {formatElapsed(elapsedMs)}</span>
        </div>
        {agent?.task && (
          <div
            style={{
              fontSize: 11,
              color: 'var(--text-muted)',
              marginTop: 4,
              marginLeft: 16,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {agent.task}
          </div>
        )}
      </div>

      {/* body: the subagent's own transcript */}
      <div
        ref={scroller}
        className="scz"
        onScroll={(e) => {
          const at = isAtBottom(e.currentTarget);
          setState((prev) => (prev.atBottom === at ? prev : { ...prev, atBottom: at }));
        }}
        style={{
          flex: 1,
          minHeight: 0,
          overflow: 'auto',
          padding: '16px 18px',
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
          // The transcript is CONTENT — copying out of it must work (the app root
          // disables selection for chrome). mac-text-selection FR-1: WKWebView needs
          // the -webkit- prefixed form too — see TRANSCRIPT_TEXT_SELECT_STYLE.
          ...TRANSCRIPT_TEXT_SELECT_STYLE,
          cursor: 'auto',
        }}
      >
        {state.loading ? null : state.error ? ( // FR-16: nothing while in flight
          <div style={{ fontSize: 11, color: C.error }}>{state.error.message}</div>
        ) : state.blocks.length === 0 ? (
          <div style={{ fontSize: 12, color: C.faint }}>{TRAIL_EMPTY_LABEL}</div>
        ) : (
          <>
            {earlier && <div style={{ fontSize: 10, color: 'var(--text-disabled)' }}>{earlier}</div>}
            {state.blocks.map((b) => (
              <AgentBlockRow key={b.blockId} block={b} sessionId={sessionId} />
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
 */
function AgentBlockRow({ block, sessionId }: { block: AgentBlock; sessionId: string }) {
  if (block.kind === 'notice') {
    return (
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, fontSize: 10.5 }}>
        <span style={{ width: 16, flexShrink: 0, textAlign: 'center', color: STEP_GLYPH_COLOR.notice }}>
          {STEP_GLYPH.notice}
        </span>
        <span style={{ color: 'var(--text-disabled)' }}>{block.text}</span>
      </div>
    );
  }
  return <Block b={block as ConversationBlock} sessionId={sessionId} />;
}
