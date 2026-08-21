// agent-tab — the body of a dynamic agent tab: one subagent's own conversation
// (specs/agent-tab.md FR-16..FR-21, §8). Renders through the SESSION tab's Block
// component, so an agent's tab reads exactly like a session's transcript.

import { useEffect, useRef, useState } from 'react';
import type { AgentInfo, SessionEvent } from '../../../contract/common';
import type { AgentBlock } from '../../../contract/agent-tab';
import type { ConversationBlock } from '../../../contract/conversation-view';
import { formatElapsed } from '../../../contract/conversation-view';
import { agentsList, agentsTranscript, onAgentEvent, sessionInterrupt } from '../../lib/api';
import { subscribeSessionEvents } from '../../lib/session-events';
import { useStore } from '../../lib/store';
import { useTimedError } from '../../lib/hooks/useTimedError';
import Block from '../conversation/Block';
import { TRANSCRIPT_TEXT_SELECT_STYLE } from '../conversation/conversation-blocks';
import { ASYNC_MARKER, STEP_GLYPH, STEP_GLYPH_COLOR, TRAIL_EMPTY_LABEL, isAtBottom, showAsyncMarker } from './agent-trail';
import {
  CLOSED_TRANSCRIPT,
  agentBannerMeta,
  agentBannerShowsStop,
  earlierBlocksNotice,
  openTranscript,
  receiveAgentTranscript,
  routeAgentEventToTranscript,
  type TranscriptState,
} from './agent-tab';
import './agents.css';

/** Stop's failure banner clears itself after this long — same window as the
    composer's send-error toast (useSessionAttachments.ts). */
const STOP_ERROR_MS = 4000;

export interface AgentViewProps {
  agentId: string;
  sessionId: string;
  /**
   * fix-agent-view FR-17: what "Back to session" does. Passed in rather than
   * calling `setMainTab('session')` here, because this view now renders in
   * either split pane — and the right pane's tab is `splitTab`, so a hardcoded
   * `setMainTab` would fling the LEFT pane back to SESSION and leave this one
   * sitting on the agent tab it was asked to leave.
   */
  onBack: () => void;
}

export default function AgentView({ agentId, sessionId, onBack }: AgentViewProps) {
  const [agent, setAgent] = useState<AgentInfo | null>(null);
  const [state, setState] = useState<TranscriptState>(CLOSED_TRANSCRIPT);
  const [clockNow, setClockNow] = useState(() => Date.now());
  const [stopping, setStopping] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const sessionName = useStore((s) => s.sessions.find((x) => x.id === sessionId)?.name ?? null);
  const { error: stopError, setError: setStopError, schedule: scheduleStopError } = useTimedError();

  // FR-19: the header's own view of the agent — seeded from agents_list and kept
  // live by agent.update. Held here rather than read from pane [3] so the tab
  // does not depend on that panel being mounted.
  useEffect(() => {
    setAgent(null);
    let mounted = true;
    let unlisten: (() => void) | undefined;
    // transcript-scale FR-21: through the one router subscription. agent.update
    // carries no top-level sessionId, so the router treats it as
    // session-agnostic (FR-19) and this filter keeps doing what it always did.
    void subscribeSessionEvents(sessionId, (e: SessionEvent) => {
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

  const elapsedMs = agent ? Math.max(0, (agent.endedAt ?? clockNow) - agent.startedAt) : 0;
  const earlier = earlierBlocksNotice(state.dropped);
  const meta = agent ? agentBannerMeta(agent.stepCount, sessionName) : null;
  const showStop = agent ? agentBannerShowsStop(agent.status) : false;

  const doStop = async () => {
    if (stopping) return;
    setStopping(true);
    const res = await sessionInterrupt(sessionId);
    setStopping(false);
    if (!res.ok) {
      setStopError(res.error.message);
      scheduleStopError(() => setStopError(null), STOP_ERROR_MS);
    }
  };

  return (
    <div className="agent-view">
      {/* banner (§8): the "you are inside a subagent" provenance banner — purple
          marks subagent provenance app-wide, per Design System v2 §Banners. */}
      <div className="agent-banner">
        <div className="agent-banner__id">
          <div className="agent-banner__row1">
            <span className="agent-banner__name">{agent?.name ?? 'agent'}</span>
            <span className="agent-banner__pill">subagent</span>
            {agent && showAsyncMarker(agent) && <span className="agent-async-badge">{ASYNC_MARKER}</span>}
          </div>
          {meta && (
            <div className="agent-banner__row2">
              {meta.sessionName && (
                <>
                  <span>
                    from <span className="agent-banner__session">{meta.sessionName}</span>
                  </span>
                  <span className="agent-banner__sep">·</span>
                </>
              )}
              <span className="agent-banner__fact">{formatElapsed(elapsedMs)}</span>
              <span className="agent-banner__sep">·</span>
              <span className="agent-banner__fact">{meta.stepsLabel}</span>
            </div>
          )}
        </div>
        <span className="agent-banner__spacer" />
        <div className="agent-banner__actions">
          <button type="button" className="agent-banner__btn" onClick={onBack}>
            Back to session
          </button>
          {showStop && (
            <button
              type="button"
              className="agent-banner__btn agent-banner__btn--danger"
              disabled={stopping}
              title="Interrupts the parent session's whole turn — not just this subagent"
              onClick={() => void doStop()}
            >
              Stop
            </button>
          )}
        </div>
      </div>
      {stopError && <div className="form-error agent-banner__error">{stopError}</div>}

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
        {/* the task card takes the same purple provenance treatment as the
            banner's pill — it is the first thing read in the body, per the mock. */}
        {agent?.task && (
          <div className="agent-task">
            <span className="agent-task__label">Task</span>
            <span className="agent-task__text">{agent.task}</span>
          </div>
        )}
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
