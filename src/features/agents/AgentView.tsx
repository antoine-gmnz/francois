// agent-tab — the body of a dynamic agent tab: one subagent's own conversation
// (specs/agent-tab.md FR-16..FR-21, §8). Renders through the SESSION tab's Block
// component, so an agent's tab reads exactly like a session's transcript.
//
// Drawn to Figma "Graphite & Signal" 17 · Subagent drill-in (138:6593): a 60px
// header (back · breadcrumb `session › subagent` · name + state chip + facts ·
// Stop), the 680px reading column opening on the task card, a live "what it is
// doing now" line, and a dashed no-input strip where a composer would be.

import { useEffect, useRef, useState } from 'react';
import type { AgentInfo, SessionEvent } from '../../../contract/common';
import type { AgentBlock } from '../../../contract/agent-tab';
import type { ConversationBlock } from '../../../contract/conversation-view';
import { agentsList, agentsTranscript, onAgentEvent, sessionInterrupt } from '../../lib/api';
import { subscribeSessionEvents } from '../../lib/session-events';
import { useStore } from '../../lib/store';
import { useTimedError } from '../../lib/hooks/useTimedError';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { IconButton } from '../../ui/IconButton';
import { StateIcon } from '../../ui/StateIcon';
import Block from '../conversation/Block';
import { TRANSCRIPT_TEXT_SELECT_STYLE } from '../conversation/conversation-blocks';
import { ASYNC_MARKER, STEP_GLYPH, STEP_GLYPH_COLOR, TRAIL_EMPTY_LABEL, isAtBottom, showAsyncMarker } from './agent-trail';
import { agentStateChip, isBackEscape, noInputLine, taskClock } from './agent-view';
import {
  CLOSED_TRANSCRIPT,
  agentBannerMeta,
  agentBannerShowsStop,
  earlierBlocksNotice,
  openTranscript,
  receiveAgentTranscript,
  routeAgentEventToTranscript,
  type TranscriptState,
} from '../../lib/agent-tab';
import './agents.css';
import './agent-view.css';

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
  /**
   * `Esc to go back` is live. The single pane leaves it on; a split pane passes
   * its own focus, so one Escape never sends two panes back at once.
   */
  escapeToBack?: boolean;
}

export default function AgentView({ agentId, sessionId, onBack, escapeToBack = true }: AgentViewProps) {
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

  // `Esc to go back` — bubble phase, so a modal, the palette, a popover or a
  // text field that handles its own Escape (preventDefault / owns focus) wins.
  useEffect(() => {
    if (!escapeToBack) return;
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      // Any open modal owns Escape outright, wherever the focus happens to be.
      const focusOwnsEscape =
        document.querySelector('.modal-backdrop') !== null ||
        (!!el &&
          (el.tagName === 'INPUT' ||
            el.tagName === 'TEXTAREA' ||
            el.tagName === 'SELECT' ||
            el.isContentEditable ||
            el.closest('.xterm, [role="dialog"], [role="menu"], [role="listbox"]') !== null));
      const back = isBackEscape({
        key: e.key,
        metaKey: e.metaKey,
        ctrlKey: e.ctrlKey,
        altKey: e.altKey,
        shiftKey: e.shiftKey,
        defaultPrevented: e.defaultPrevented,
        focusOwnsEscape,
      });
      if (back) onBack();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [escapeToBack, onBack]);

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

  const chip = agent ? agentStateChip(agent.status, elapsedMs) : null;
  const name = agent?.name ?? 'agent';

  return (
    <div className="agent-view">
      <div className="agent-view__header">
        <IconButton size={30} framed title="Back to the session · Esc" onClick={onBack}>
          <Icon name="back" size={14} />
        </IconButton>
        <div className="agent-view__title">
          <div className="agent-view__crumbs">
            {sessionName && (
              <>
                <span className="agent-view__crumb-session truncate">{sessionName}</span>
                <Icon name="chevron-right" size={11} />
              </>
            )}
            <span>subagent</span>
          </div>
          <div className="agent-view__name-row">
            <span className="agent-view__name truncate" title={name}>
              {name}
            </span>
            {chip && (
              <span className={`agent-view__state agent-view__state--${chip.kind}`}>
                <StateIcon kind={chip.kind} size={11} />
                {chip.label}
              </span>
            )}
            {agent && showAsyncMarker(agent) && <span className="agent-async-badge">{ASYNC_MARKER}</span>}
            {meta && <span className="agent-view__facts">{meta.stepsLabel}</span>}
          </div>
        </div>
        <span className="agent-view__spacer" />
        {/* The only real stop is session_interrupt — it ends the parent's whole
            turn, so the label says "turn", not the mock's "subagent". */}
        {showStop && (
          <Button
            disabled={stopping}
            title="Interrupts the parent session's whole turn — not just this subagent"
            onClick={() => void doStop()}
          >
            <Icon name="stop" size={12} className="agent-view__stop-glyph" />
            Stop turn
          </Button>
        )}
      </div>
      {stopError && <div className="form-error agent-view__error">{stopError}</div>}

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
        <div className="agent-view__column">
          {/* The task card opens the column — the first thing read, per the mock. */}
          {agent?.task && (
            <div className="agent-task">
              <div className="agent-task__meta">
                <span className="agent-task__label">{sessionName ? `Task from ${sessionName}` : 'Task'}</span>
                <span className="agent-task__time">{taskClock(agent.startedAt)}</span>
              </div>
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
          {/* async-agents FR-10: the newest step's label, live while it runs. */}
          {running && agent?.lastActivity && (
            <div className="agent-view__live">
              <StateIcon kind="running" size={14} />
              <span className="truncate">{agent.lastActivity}</span>
            </div>
          )}
        </div>
      </div>

      {/* Where a composer would be: a subagent takes no input. */}
      <div className="agent-view__footer">
        <div className="agent-view__no-input">
          <Icon name="agent" size={14} />
          <span className="agent-view__no-input-text">{noInputLine(name, sessionName)}</span>
          {escapeToBack && <span className="agent-view__no-input-key">Esc to go back</span>}
        </div>
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
