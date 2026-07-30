import { useEffect, useRef, useState } from 'react';
import type { AgentInfo, AgentStep, AppError, SessionEvent } from '../../../contract/common';
import { formatElapsed } from '../../../contract/conversation-view';
import { agentsActivity, agentsDispatch, agentsKill, agentsList, onSessionEvent } from '../../lib/api';
import {
  ASYNC_MARKER,
  COLLAPSED_TRAIL,
  STEP_GLYPH,
  STEP_GLYPH_COLOR,
  TRAIL_EMPTY_LABEL,
  TRAIL_MAX_HEIGHT_PX,
  type TrailState,
  activitySuffix,
  agentIdToDropForTrailError,
  collapseTrail,
  earlierStepsNotice,
  isAtBottom,
  receiveTrailActivity,
  routeSessionEventToTrail,
  showAsyncMarker,
  stepMetaColor,
  stepToolPrefix,
  toggleTrail,
} from './agent-trail';
import { setPaletteAgents } from '../palette/paletteData';
import { useStore } from '../../lib/store';
import { HintBar } from '../../ui/HintBar';
import { Modal, ModalHeader } from '../../ui/Modal';
import { PanelHeader } from '../../ui/PanelHeader';
import { StatusDot } from '../../ui/StatusDot';
import './agents.css';

const statusColor: Record<string, string> = {
  running: 'var(--accent-2)',
  idle: 'var(--text-muted)',
  done: 'var(--success)',
  error: 'var(--error)',
};

const rank = (status: string) => (status === 'running' ? 0 : status === 'idle' ? 1 : 2);

function ordered(map: Map<string, AgentInfo>): AgentInfo[] {
  return Array.from(map.values())
    .map((agent, i) => ({ agent, i }))
    .sort((left, right) => rank(left.agent.status) - rank(right.agent.status) || left.i - right.i)
    .map(({ agent }) => agent);
}

export default function AgentsPanel({ sessionId }: { sessionId: string | null }) {
  const focusedPane = useStore((s) => s.focusedPane);
  const setFocusedPane = useStore((s) => s.setFocusedPane);
  const newAgentOpen = useStore((s) => s.newAgentOpen);
  const setNewAgentOpen = useStore((s) => s.setNewAgentOpen);
  const openAgentTab = useStore((s) => s.openAgentTab);
  const syncAgentTab = useStore((s) => s.syncAgentTab);

  const [agents, setAgents] = useState<Map<string, AgentInfo>>(new Map());
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<AppError | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // The expanded card + its activity trail (async-agents FR-19..FR-22).
  const [trail, setTrail] = useState<TrailState>(COLLAPSED_TRAIL);
  const [pendingKill, setPendingKill] = useState<Set<string>>(new Set());
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [clockNow, setClockNow] = useState(() => Date.now());

  const focused = focusedPane === 'agents';
  const list = ordered(agents);
  const hasRunning = list.some((agent) => agent.status === 'running');

  // Publish this session's agents to the palette cache (backs kill-agent + runningAgentCount, FR-23).
  useEffect(() => {
    if (sessionId) setPaletteAgents(sessionId, ordered(agents));
  }, [sessionId, agents]);

  // Tick the elapsed timer once a second while any agent is running.
  useEffect(() => {
    if (!hasRunning) return;
    const id = setInterval(() => setClockNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [hasRunning]);

  // Hydration + live agent.update (FR-1/2/3). Keyed by sessionId in App → fresh per session (FR-4).
  useEffect(() => {
    setAgents(new Map());
    setSelectedId(null);
    setTrail(collapseTrail); // FR-23: trails go with the agent map
    setPendingKill(new Set());
    setListError(null);
    if (!sessionId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    let mounted = true;
    let unlisten: (() => void) | undefined;
    let hydrated = false;
    const buffer: AgentInfo[] = [];

    const applyAgent = (agent: AgentInfo) => {
      // agent-tab: keep an open tab's label + status dot live. A no-op when this
      // agent has no tab, and this panel is already the ONE agent.update
      // subscriber for the active session — no second subscription.
      syncAgentTab({ id: agent.id, name: agent.name, status: agent.status });
      setAgents((prev) => {
        const next = new Map(prev);
        next.set(agent.id, agent); // set on existing key preserves position (FR-7)
        return next;
      });
      setPendingKill((prev) => {
        if (!prev.has(agent.id)) return prev;
        const next = new Set(prev);
        next.delete(agent.id);
        return next;
      });
    };

    void onSessionEvent((e: SessionEvent) => {
      if (e.type === 'agent.step') {
        // async-agents FR-20/FR-22: only the expanded card consumes steps.
        setTrail((t) => routeSessionEventToTrail(t, sessionId, e));
        return;
      }
      if (e.type !== 'agent.update') return;
      if (e.agent.sessionId !== sessionId) return; // FR-3
      if (!hydrated) buffer.push(e.agent);
      else applyAgent(e.agent);
    }).then((unsub) => {
      if (!mounted) unsub();
      else unlisten = unsub;
    });

    void agentsList(sessionId).then((res) => {
      if (!mounted) return;
      setLoading(false);
      if (res.ok) {
        // Seed only ids not already present from a buffered event (FR-2).
        setAgents((prev) => {
          const next = new Map(prev);
          for (const agent of res.data) if (!next.has(agent.id)) next.set(agent.id, agent);
          return next;
        });
        for (const agent of buffer) applyAgent(agent);
        buffer.length = 0;
        hydrated = true;
      } else {
        setListError(res.error);
      }
    });

    return () => {
      mounted = false;
      if (unlisten) unlisten();
    };
  }, [sessionId]);

  const doKill = async (agentId: string) => {
    if (pendingKill.has(agentId)) return;
    setPendingKill((prev) => new Set(prev).add(agentId));
    const res = await agentsKill(agentId);
    if (!res.ok) {
      setPendingKill((prev) => {
        const n = new Set(prev);
        n.delete(agentId);
        return n;
      });
      if (res.error.code === 'AGENT_NOT_FOUND') {
        setAgents((prev) => {
          const n = new Map(prev);
          n.delete(agentId);
          return n;
        });
      }
    }
    // success: pendingKill cleared on the next agent.update for this id (FR-20)
  };

  // async-agents FR-19: hydrate the expanded card's trail. A stale response (the
  // card was collapsed or re-expanded meanwhile) is dropped by its reqId. `ipc()`
  // rejects (rather than resolving a Result) on transport-level failures — funnel
  // that through the same Result path so `trail.loading` never sticks forever.
  const loadTrail = async (agentId: string, reqId: number) => {
    try {
      const res = await agentsActivity(agentId);
      setTrail((prev) => receiveTrailActivity(prev, reqId, res));
    } catch (err) {
      setTrail((prev) =>
        receiveTrailActivity(prev, reqId, { ok: false, error: { code: 'INTERNAL', message: String(err) } }),
      );
    }
  };

  // async-agents §7: AGENT_NOT_FOUND drops the card, but one render pass AFTER
  // the trail's error row has painted — setTrail (above) and this setAgents must
  // NOT land in the same React batch, or the card unmounts before the "expanded,
  // trail errored" row (§8) is ever visible.
  useEffect(() => {
    const dropId = agentIdToDropForTrailError(trail);
    if (!dropId) return;
    setAgents((prev) => {
      if (!prev.has(dropId)) return prev;
      const n = new Map(prev);
      n.delete(dropId);
      return n;
    });
  }, [trail]);

  // FR-19/FR-22: ⏎ (or the same card again) toggles; expanding re-issues the fetch.
  const toggleExpand = (agentId: string) => {
    const next = toggleTrail(trail, agentId);
    setTrail(next);
    if (next.agentId !== null) void loadTrail(next.agentId, next.reqId);
  };

  // Keyboard for pane [3] (FR-12/13/19).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (newAgentOpen || !focused) return;
      const activeEl = document.activeElement as HTMLElement | null;
      if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA')) return;
      const cur = list.findIndex((agent) => agent.id === selectedId);
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        const i = Math.min(cur < 0 ? 0 : cur + 1, list.length - 1);
        if (list[i]) {
          setSelectedId(list[i].id);
          setTrail(collapseTrail);
        }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        const i = Math.max(cur < 0 ? 0 : cur - 1, 0);
        if (list[i]) {
          setSelectedId(list[i].id);
          setTrail(collapseTrail);
        }
      } else if (e.key === 'Enter') {
        if (selectedId) {
          e.preventDefault();
          toggleExpand(selectedId);
        }
      } else if (e.key === 'x' || e.key === 'X') {
        const agent = agents.get(selectedId ?? '');
        if (agent && agent.status === 'running' && !pendingKill.has(agent.id)) void doKill(agent.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focused, newAgentOpen, list, selectedId, agents, pendingKill, trail]);

  return (
    <section
      onClick={() => setFocusedPane('agents')}
      className={focused ? 'agents-panel agents-panel--focused' : 'agents-panel'}
    >
      <PanelHeader title="AGENTS" count={agents.size} paneKey={3} focused={focused} />

      <div className="scz agents-body">
        {listError ? (
          <div className="agents-error-text">{listError.message}</div>
        ) : loading ? null : list.length === 0 ? (
          <div className="agents-empty">
            no agents yet · press <span className="agents-empty-key">a</span>
          </div>
        ) : (
          list.map((agent) => (
            <Card
              key={agent.id}
              agent={agent}
              now={clockNow}
              selected={agent.id === selectedId}
              trail={agent.id === trail.agentId ? trail : null}
              hover={agent.id === hoverId}
              pending={pendingKill.has(agent.id)}
              onClick={(e) => {
                if (agent.id !== trail.agentId) setTrail(collapseTrail); // FR-13: selection collapses
                setSelectedId(agent.id);
                // agent-tab FR-10: a CLICK also opens (or re-activates) this
                // agent's main-pane tab and hands it focus — you clicked to read
                // it. stopPropagation keeps the section's own handler from
                // immediately pulling focus back to pane [3]. The keyboard path
                // (↑/↓ + ⏎, the in-place trail) is deliberately unchanged.
                e.stopPropagation();
                openAgentTab({ id: agent.id, name: agent.name, status: agent.status });
                setFocusedPane('main');
              }}
              onHover={(hovering) => setHoverId(hovering ? agent.id : null)}
              onKill={() => void doKill(agent.id)}
              onAtBottom={(v) => setTrail((t) => (t.atBottom === v ? t : { ...t, atBottom: v }))}
            />
          ))
        )}
      </div>

      {newAgentOpen && sessionId && (
        <NewAgentModal sessionId={sessionId} onClose={() => setNewAgentOpen(false)} />
      )}
    </section>
  );
}

function Card({
  agent,
  now,
  selected,
  trail,
  hover,
  pending,
  onClick,
  onHover,
  onKill,
  onAtBottom,
}: {
  agent: AgentInfo;
  now: number;
  selected: boolean;
  /** The expanded card's trail state, or null when this card is collapsed. */
  trail: TrailState | null;
  hover: boolean;
  pending: boolean;
  onClick: (e: React.MouseEvent) => void;
  onHover: (hovering: boolean) => void;
  onKill: () => void;
  onAtBottom: (v: boolean) => void;
}) {
  const sc = statusColor[agent.status] ?? 'var(--text-muted)';
  const elapsedMs = Math.max(0, (agent.endedAt ?? now) - agent.startedAt);
  const showKill = agent.status === 'running' && hover && !pending;
  const expanded = trail !== null;
  const activity = activitySuffix(agent); // FR-17: rendered for every status
  const cardClass = ['agent-card', selected && 'agent-card--selected', pending && 'agent-card--pending']
    .filter(Boolean)
    .join(' ');
  return (
    <div onClick={onClick} onMouseEnter={() => onHover(true)} onMouseLeave={() => onHover(false)} className={cardClass}>
      <div className="agent-inline-row">
        <StatusDot color={sc} pulsing={agent.status === 'running'} />
        <span className="agent-card__name truncate">{agent.name}</span>
        {showAsyncMarker(agent) && <span className="agent-async-badge agent-async-badge--shrink">{ASYNC_MARKER}</span>}
        {showKill ? (
          <span
            onClick={(e) => {
              e.stopPropagation();
              onKill();
            }}
            title="kill agent"
            className="agent-kill-action agent-card__kill"
          >
            ✕
          </span>
        ) : (
          <span className="agent-card__status" style={{ color: sc }}>
            {agent.status}
          </span>
        )}
      </div>
      <div className={expanded ? 'agent-card__task' : 'agent-card__task truncate'}>{agent.task}</div>
      <div className="agent-card__meta">
        <span className="agent-card__meta-shrink" style={{ color: agent.status === 'running' ? sc : 'var(--text-faint)' }}>
          {agent.status === 'running' ? '◷' : '·'}
        </span>
        <span className="agent-card__meta-shrink">{formatElapsed(elapsedMs)}</span>
        {agent.status === 'running' && <span className="agent-card__meta-label">elapsed</span>}
        {activity !== null && (
          <>
            <span className="agent-card__meta-label">·</span>
            <span className="agent-card__activity truncate">{activity}</span>
          </>
        )}
      </div>
      {trail && <Trail state={trail} stepCount={agent.stepCount} onAtBottom={onAtBottom} />}
    </div>
  );
}

/** The expanded card's activity trail (FR-19..FR-21, §8). */
function Trail({
  state,
  stepCount,
  onAtBottom,
}: {
  state: TrailState;
  stepCount: number;
  onAtBottom: (v: boolean) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const steps = state.steps;
  const newest = steps.length > 0 ? steps[steps.length - 1].seq : 0;

  // FR-21: jump to the newest step unless the user scrolled up inside the trail.
  useEffect(() => {
    const el = ref.current;
    if (!el || !state.atBottom) return;
    el.scrollTop = el.scrollHeight;
  }, [newest, steps.length, state.atBottom]);

  if (state.loading) return null; // FR-19: nothing while the request is in flight

  const earlier = earlierStepsNotice(stepCount, steps.length);
  return (
    <div
      ref={ref}
      className="scz agent-trail"
      onScroll={(e) => onAtBottom(isAtBottom(e.currentTarget))}
      style={{ maxHeight: TRAIL_MAX_HEIGHT_PX }}
    >
      {state.error ? (
        <div className="agent-trail-error-text">{state.error.message}</div>
      ) : steps.length === 0 ? (
        <div className="agent-trail-notice">{TRAIL_EMPTY_LABEL}</div>
      ) : (
        <>
          {earlier && <div className="agent-trail-earlier">{earlier}</div>}
          {steps.map((s) => (
            <StepRow key={s.seq} step={s} />
          ))}
        </>
      )}
    </div>
  );
}

function StepRow({ step }: { step: AgentStep }) {
  const prefix = stepToolPrefix(step);
  return (
    <div className="agent-step-row">
      <span className="agent-step-glyph" style={{ color: STEP_GLYPH_COLOR[step.kind] }}>
        {STEP_GLYPH[step.kind]}
      </span>
      <span className="agent-step-label truncate">
        {prefix !== null && <span className="agent-step-prefix">{prefix} </span>}
        {step.label}
      </span>
      {step.kind === 'tool' && step.meta !== undefined && (
        <span className="agent-step-meta" style={{ color: stepMetaColor(step.meta) }}>
          {step.meta}
        </span>
      )}
    </div>
  );
}

function NewAgentModal({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const [task, setTask] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = async () => {
    if (submitting) return;
    if (task.trim() === '') {
      setError({ code: 'INVALID_INPUT', message: 'describe the task first' });
      return;
    }
    setSubmitting(true);
    setError(null);
    const res = await agentsDispatch(sessionId, task.trim());
    setSubmitting(false);
    if (res.ok) onClose();
    else setError(res.error);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        void submit();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  return (
    // NewAgentModal keeps its own Escape/Enter keydown handler above (Enter
    // dispatches), so closeOnEscape stays off here to avoid double-handling —
    // see REFACTOR-CONVENTIONS.md's Modal note. closeOnBackdropClick mirrors
    // the previous unconditional `onClick={onClose}` on the backdrop.
    <Modal onClose={onClose} width={420} align="top" closeOnBackdropClick closeOnEscape={false}>
      <ModalHeader>
        <div className="agent-modal-title-row">
          <span className="agent-modal-arrow">›</span>
          <input
            ref={inputRef}
            value={task}
            disabled={submitting}
            placeholder="describe the subagent's task…"
            onChange={(e) => setTask(e.target.value)}
            className="agent-modal-input"
            style={{ opacity: submitting ? 0.7 : 1 }}
          />
          <span className="agent-modal-hint">esc</span>
        </div>
      </ModalHeader>
      {error && <div className="agent-modal-error">{error.message}</div>}
      <HintBar
        items={[
          { key: '⏎', label: 'dispatch' },
          { key: 'esc', label: 'cancel' },
        ]}
      />
    </Modal>
  );
}
