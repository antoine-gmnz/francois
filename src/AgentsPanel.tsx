import { useEffect, useRef, useState } from 'react';
import type { AgentInfo, AppError, SessionEvent } from '../contract/common';
import { formatElapsed } from '../contract/conversation-view';
import { agentsDispatch, agentsKill, agentsList, onSessionEvent } from './api';
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
  const [expandedId, setExpandedId] = useState<string | null>(null);
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
    setExpandedId(null);
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
          setExpandedId(null);
        }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        const i = Math.max(cur < 0 ? 0 : cur - 1, 0);
        if (list[i]) {
          setSelectedId(list[i].id);
          setExpandedId(null);
        }
      } else if (e.key === 'Enter') {
        if (selectedId) {
          e.preventDefault();
          setExpandedId((x) => (x === selectedId ? null : selectedId));
        }
      } else if (e.key === 'x' || e.key === 'X') {
        const a = agents.get(selectedId ?? '');
        if (a && a.status === 'running' && !pendingKill.has(a.id)) void doKill(a.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focused, newAgentOpen, list, selectedId, agents, pendingKill]);

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
              expanded={a.id === expandedId}
              hover={a.id === hoverId}
              pending={pendingKill.has(a.id)}
              onClick={() => {
                setSelectedId(a.id);
                setExpandedId(null);
                setFocusedPane('agents');
              }}
              onHover={(h) => setHoverId(h ? a.id : null)}
              onKill={() => void doKill(a.id)}
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
  expanded,
  hover,
  pending,
  onClick,
  onHover,
  onKill,
}: {
  a: AgentInfo;
  now: number;
  selected: boolean;
  expanded: boolean;
  hover: boolean;
  pending: boolean;
  onClick: () => void;
  onHover: (h: boolean) => void;
  onKill: () => void;
}) {
  const sc = statusColor[a.status] ?? C.idle;
  const elapsedMs = Math.max(0, (a.endedAt ?? now) - a.startedAt);
  const showKill = a.status === 'running' && hover && !pending;
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
        <span style={{ color: a.status === 'running' ? sc : C.faint }}>{a.status === 'running' ? '◷' : '·'}</span>
        <span>{formatElapsed(elapsedMs)}</span>
        {a.status === 'running' && <span style={{ color: 'var(--text-disabled)' }}>elapsed</span>}
      </div>
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
