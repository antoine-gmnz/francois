import { useEffect, useRef, useState } from 'react';
import type { AgentInfo, AgentStep, AppError, SessionEvent } from '../contract/common';
import { formatElapsed } from '../contract/conversation-view';
import { agentsActivity, agentsDispatch, agentsKill, agentsList, onSessionEvent } from './api';
import {
  ASYNC_MARKER,
  COLLAPSED_TRAIL,
  STEP_GLYPH,
  STEP_GLYPH_COLOR,
  TRAIL_EMPTY_LABEL,
  TRAIL_MAX_HEIGHT_PX,
  type TrailState,
  activitySuffix,
  collapseTrail,
  dropsCardOnTrailError,
  earlierStepsNotice,
  isAtBottom,
  receiveTrailActivity,
  receiveTrailStep,
  showAsyncMarker,
  stepMetaColor,
  stepToolPrefix,
  toggleTrail,
} from './agent-trail';
import { setPaletteAgents } from './paletteData';
import { useStore } from './store';

const C = {
  running: 'var(--accent-2)',
  idle: 'var(--text-muted)',
  done: 'var(--success)',
  error: 'var(--error)',
  accent: 'var(--accent)',
  dim: 'var(--text-dim)',
  faint: 'var(--text-faint)',
  primary: 'var(--text)',
  bright: 'var(--text-strong)',
};

const statusColor: Record<string, string> = {
  running: C.running,
  idle: C.idle,
  done: C.done,
  error: C.error,
};

const rank = (s: string) => (s === 'running' ? 0 : s === 'idle' ? 1 : 2);

function ordered(map: Map<string, AgentInfo>): AgentInfo[] {
  return Array.from(map.values())
    .map((a, i) => ({ a, i }))
    .sort((x, y) => rank(x.a.status) - rank(y.a.status) || x.i - y.i)
    .map(({ a }) => a);
}

export default function AgentsPanel({ sessionId }: { sessionId: string | null }) {
  const focusedPane = useStore((s) => s.focusedPane);
  const setFocusedPane = useStore((s) => s.setFocusedPane);
  const newAgentOpen = useStore((s) => s.newAgentOpen);
  const setNewAgentOpen = useStore((s) => s.setNewAgentOpen);

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
  const hasRunning = list.some((a) => a.status === 'running');

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

    const applyAgent = (a: AgentInfo) => {
      setAgents((prev) => {
        const next = new Map(prev);
        next.set(a.id, a); // set on existing key preserves position (FR-7)
        return next;
      });
      setPendingKill((prev) => {
        if (!prev.has(a.id)) return prev;
        const next = new Set(prev);
        next.delete(a.id);
        return next;
      });
    };

    void onSessionEvent((e: SessionEvent) => {
      if (e.type === 'agent.step') {
        // async-agents FR-20/FR-22: only the expanded card consumes steps.
        if (e.sessionId !== sessionId) return;
        setTrail((t) => receiveTrailStep(t, e.agentId, e.step));
        return;
      }
      if (e.type !== 'agent.update') return;
      if (e.agent.sessionId !== sessionId) return; // FR-3
      if (!hydrated) buffer.push(e.agent);
      else applyAgent(e.agent);
    }).then((u) => {
      if (!mounted) u();
      else unlisten = u;
    });

    void agentsList(sessionId).then((res) => {
      if (!mounted) return;
      setLoading(false);
      if (res.ok) {
        // Seed only ids not already present from a buffered event (FR-2).
        setAgents((prev) => {
          const next = new Map(prev);
          for (const a of res.data) if (!next.has(a.id)) next.set(a.id, a);
          return next;
        });
        for (const a of buffer) applyAgent(a);
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
  // card was collapsed or re-expanded meanwhile) is dropped by its reqId.
  const loadTrail = async (agentId: string, reqId: number) => {
    const res = await agentsActivity(agentId);
    setTrail((prev) => receiveTrailActivity(prev, reqId, res));
    if (!res.ok && dropsCardOnTrailError(res.error)) {
      setAgents((prev) => {
        if (!prev.has(agentId)) return prev;
        const n = new Map(prev);
        n.delete(agentId);
        return n;
      });
    }
  };

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
      const ae = document.activeElement as HTMLElement | null;
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return;
      const cur = list.findIndex((a) => a.id === selectedId);
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
        const a = agents.get(selectedId ?? '');
        if (a && a.status === 'running' && !pendingKill.has(a.id)) void doKill(a.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focused, newAgentOpen, list, selectedId, agents, pendingKill, trail]);

  return (
    <section
      onClick={() => setFocusedPane('agents')}
      style={{
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--bg-deep)',
        border: `1px solid ${focused ? C.accent : 'var(--border)'}`,
        borderRadius: 5,
        overflow: 'hidden',
        minHeight: 0,
        height: '100%',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '9px 12px',
          borderBottom: '1px solid var(--border)',
          flexShrink: 0,
        }}
      >
        <span style={{ fontSize: 11, letterSpacing: '0.14em', color: focused ? C.accent : C.dim, fontWeight: 700 }}>
          AGENTS
        </span>
        <span style={{ fontSize: 10, color: C.faint }}>{agents.size} · [3]</span>
      </div>

      <div className="scz" style={{ flex: 1, overflow: 'auto', padding: 8 }}>
        {listError ? (
          <div style={{ padding: '12px 4px', fontSize: 11, color: C.error }}>{listError.message}</div>
        ) : loading ? null : list.length === 0 ? (
          <div style={{ padding: '24px 12px', fontSize: 11, color: C.faint }}>
            no agents yet · press <span style={{ color: 'var(--text-hint)' }}>a</span>
          </div>
        ) : (
          list.map((a) => (
            <Card
              key={a.id}
              a={a}
              now={clockNow}
              selected={a.id === selectedId}
              trail={a.id === trail.agentId ? trail : null}
              hover={a.id === hoverId}
              pending={pendingKill.has(a.id)}
              onClick={() => {
                if (a.id !== trail.agentId) setTrail(collapseTrail); // FR-13: selection collapses
                setSelectedId(a.id);
                setFocusedPane('agents');
              }}
              onHover={(h) => setHoverId(h ? a.id : null)}
              onKill={() => void doKill(a.id)}
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
  a,
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
  a: AgentInfo;
  now: number;
  selected: boolean;
  /** The expanded card's trail state, or null when this card is collapsed. */
  trail: TrailState | null;
  hover: boolean;
  pending: boolean;
  onClick: () => void;
  onHover: (h: boolean) => void;
  onKill: () => void;
  onAtBottom: (v: boolean) => void;
}) {
  const sc = statusColor[a.status] ?? C.idle;
  const elapsedMs = Math.max(0, (a.endedAt ?? now) - a.startedAt);
  const showKill = a.status === 'running' && hover && !pending;
  const expanded = trail !== null;
  const activity = activitySuffix(a); // FR-17: rendered for every status
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      style={{
        padding: 9,
        borderRadius: 4,
        marginBottom: 4,
        background: selected ? 'var(--bg-raised)' : 'var(--bg-panel)',
        borderLeft: `2px solid ${selected ? C.accent : 'transparent'}`,
        opacity: pending ? 0.55 : 1,
        cursor: 'pointer',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            flexShrink: 0,
            background: sc,
            animation: a.status === 'running' ? 'pulse 1.4s ease-in-out infinite' : 'none',
          }}
        />
        <span style={{ fontSize: 12, color: C.primary, fontWeight: 500, flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {a.name}
        </span>
        {showAsyncMarker(a) && (
          <span
            style={{
              fontSize: 9,
              letterSpacing: '0.08em',
              color: C.faint,
              padding: '1px 5px',
              borderRadius: 8,
              background: 'var(--bg-raised)',
              flexShrink: 0,
            }}
          >
            {ASYNC_MARKER}
          </span>
        )}
        {showKill ? (
          <span
            onClick={(e) => {
              e.stopPropagation();
              onKill();
            }}
            title="kill agent"
            style={{ fontSize: 10, color: C.dim, cursor: 'pointer' }}
            onMouseEnter={(e) => (e.currentTarget.style.color = C.error)}
            onMouseLeave={(e) => (e.currentTarget.style.color = C.dim)}
          >
            ✕
          </span>
        ) : (
          <span style={{ fontSize: 10, color: sc }}>{a.status}</span>
        )}
      </div>
      <div
        style={{
          fontSize: 10.5,
          color: 'var(--text-muted)',
          margin: '5px 0 4px 16px',
          ...(expanded
            ? { whiteSpace: 'normal' as const }
            : { whiteSpace: 'nowrap' as const, overflow: 'hidden', textOverflow: 'ellipsis' }),
        }}
      >
        {a.task}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 16, fontSize: 10, color: C.faint }}>
        <span style={{ flexShrink: 0, color: a.status === 'running' ? sc : C.faint }}>
          {a.status === 'running' ? '◷' : '·'}
        </span>
        <span style={{ flexShrink: 0 }}>{formatElapsed(elapsedMs)}</span>
        {a.status === 'running' && <span style={{ flexShrink: 0, color: 'var(--text-disabled)' }}>elapsed</span>}
        {activity !== null && (
          <>
            <span style={{ flexShrink: 0, color: 'var(--text-disabled)' }}>·</span>
            <span
              style={{
                flex: 1,
                minWidth: 0,
                color: 'var(--text-muted)',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {activity}
            </span>
          </>
        )}
      </div>
      {trail && <Trail state={trail} stepCount={a.stepCount} onAtBottom={onAtBottom} />}
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
      className="scz"
      onScroll={(e) => onAtBottom(isAtBottom(e.currentTarget))}
      onWheel={(e) => e.stopPropagation()} // scrolling the trail never reaches the pane
      style={{
        marginLeft: 16,
        marginTop: 6,
        borderTop: '1px solid var(--border)',
        paddingTop: 6,
        maxHeight: TRAIL_MAX_HEIGHT_PX,
        overflowY: 'auto',
        overscrollBehavior: 'contain',
      }}
    >
      {state.error ? (
        <div style={{ fontSize: 10, color: C.error, padding: '4px 0' }}>{state.error.message}</div>
      ) : steps.length === 0 ? (
        <div style={{ fontSize: 10, color: 'var(--text-disabled)', padding: '4px 0' }}>{TRAIL_EMPTY_LABEL}</div>
      ) : (
        <>
          {earlier && (
            <div style={{ fontSize: 10, color: 'var(--text-disabled)', padding: '2px 0 4px' }}>{earlier}</div>
          )}
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
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 7, padding: '2px 0', fontSize: 10 }}>
      <span style={{ width: 10, flexShrink: 0, textAlign: 'center', color: STEP_GLYPH_COLOR[step.kind] }}>
        {STEP_GLYPH[step.kind]}
      </span>
      <span
        style={{
          flex: 1,
          minWidth: 0,
          color: 'var(--text-muted)',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {prefix !== null && <span style={{ color: C.dim }}>{prefix} </span>}
        {step.label}
      </span>
      {step.kind === 'tool' && step.meta !== undefined && (
        <span style={{ fontSize: 9.5, color: stepMetaColor(step.meta), flexShrink: 0 }}>{step.meta}</span>
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
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(6,7,9,0.62)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: 118,
        zIndex: 20,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 420,
          background: 'var(--bg-panel)',
          border: '1px solid var(--bg-hover-2)',
          borderRadius: 8,
          overflow: 'hidden',
          boxShadow: '0 30px 80px -20px rgba(0,0,0,0.85)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '14px 16px', borderBottom: '1px solid var(--border)' }}>
          <span style={{ color: C.accent, fontSize: 15 }}>›</span>
          <input
            ref={inputRef}
            value={task}
            disabled={submitting}
            placeholder="describe the subagent's task…"
            onChange={(e) => setTask(e.target.value)}
            style={{
              flex: 1,
              border: 'none',
              outline: 'none',
              background: 'transparent',
              color: C.bright,
              fontSize: 14,
              fontFamily: 'inherit',
              opacity: submitting ? 0.7 : 1,
            }}
          />
          <span style={{ fontSize: 10, color: C.faint }}>esc</span>
        </div>
        {error && <div style={{ padding: '0 16px 10px', fontSize: 10.5, color: C.error }}>{error.message}</div>}
        <div style={{ display: 'flex', gap: 16, padding: '9px 16px', borderTop: '1px solid var(--border)', fontSize: 10, color: C.faint }}>
          <span>
            <span style={{ color: C.dim }}>⏎</span> dispatch
          </span>
          <span>
            <span style={{ color: C.dim }}>esc</span> cancel
          </span>
        </div>
      </div>
    </div>
  );
}
