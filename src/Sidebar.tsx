import { useEffect, useMemo, useRef, useState } from 'react';
import type { AppError, SessionMeta, SessionStatus } from '../contract/common';
import { STATUS_COLOR, STATUS_LABEL, countRunning, formatRelativeTime, statusPulses, type SessionDerived } from '../contract/fleet-board';
import { formatContextTokens } from '../contract/conversation-view';
import { displayWslCwd } from '../contract/wsl-filesystem';
import { diffGetSummary, onDiffEvent, onSessionEvent, sessionList, sessionRemove } from './api';
import { prunePaletteSession } from './paletteData';
import { useStore } from './store';

// pane [1] — the fleet board (Mission Control). Evolves the sessions-sidebar row
// list into rich per-session status cards, aggregated from existing channels
// (specs/fleet-board.md). Preserves every sessions-sidebar behaviour.

const C = {
  accent: '#c8a15a',
  dim: '#868a93',
  faint: '#565a63',
  primary: '#c4c7ce',
  bright: '#dfe2e8',
  meta: '#a9adb6',
  error: '#c46b62',
};

function abbreviate(cwd: string, home: string): string {
  if (home && (cwd === home || cwd.startsWith(home + '/') || cwd.startsWith(home + '\\'))) {
    return '~' + cwd.slice(home.length);
  }
  return cwd;
}

interface MenuState {
  sessionId: string;
  x: number;
  y: number;
  confirming: boolean;
  error: AppError | null;
}

export default function Sidebar({ home }: { home: string }) {
  const sessions = useStore((s) => s.sessions);
  const setSessions = useStore((s) => s.setSessions);
  const upsertSession = useStore((s) => s.upsertSession);
  const patchStatus = useStore((s) => s.patchStatus);
  const patchUsage = useStore((s) => s.patchUsage);
  const removeSessionFromCache = useStore((s) => s.removeSession);
  const activeSessionId = useStore((s) => s.activeSessionId);
  const setActiveSessionId = useStore((s) => s.setActiveSessionId);
  const sidebarFilter = useStore((s) => s.sidebarFilter);
  const setSidebarFilter = useStore((s) => s.setSidebarFilter);
  const focusedPane = useStore((s) => s.focusedPane);
  const setFocusedPane = useStore((s) => s.setFocusedPane);
  const newSessionOpen = useStore((s) => s.newSessionOpen);

  const [hydrationError, setHydrationError] = useState<AppError | null>(null);
  const [rowCursor, setRowCursor] = useState(0);
  const [menu, setMenu] = useState<MenuState | null>(null);
  // Per-session derived figures NOT on SessionMeta: diff file count + running agents (FR-4).
  const [derived, setDerived] = useState<Map<string, SessionDerived>>(new Map());
  // Backing store for runningAgentCount: sessionId → (agentId → status) (FR-5).
  const agentStatusRef = useRef<Map<string, Map<string, SessionStatus>>>(new Map());
  const seededRef = useRef<Set<string>>(new Set()); // sessions whose diff badge was seeded once (FR-6)
  const [, setTick] = useState(0); // forces relative-time re-render (FR-25)
  const filterRef = useRef<HTMLInputElement>(null);

  const visible = useMemo(() => {
    if (sidebarFilter === null || sidebarFilter === '') return sessions;
    const q = sidebarFilter.toLowerCase();
    return sessions.filter((s) => s.name.toLowerCase().includes(q) || s.cwd.toLowerCase().includes(q));
  }, [sessions, sidebarFilter]);

  // Merge a partial into a session's derived entry (FR-4). Ignore late resolutions
  // for a session no longer in the cache so a removed session can't leak an entry (FR-7).
  const updateDerived = (id: string, partial: Partial<SessionDerived>) => {
    if (!useStore.getState().sessions.some((x) => x.id === id)) return;
    setDerived((prev) => {
      const next = new Map(prev);
      const cur = next.get(id) ?? { fileCount: null, runningAgentCount: 0 };
      next.set(id, { ...cur, ...partial });
      return next;
    });
  };
  const dropDerived = (id: string) => {
    agentStatusRef.current.delete(id);
    seededRef.current.delete(id);
    setDerived((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  };
  // Best-effort one-shot diff seed, deduped by id so it fires exactly once per session
  // regardless of cache-membership ordering (FR-6). Failure → leaves fileCount null.
  const seedDiff = (id: string) => {
    if (seededRef.current.has(id)) return;
    seededRef.current.add(id);
    void diffGetSummary(id).then((res) => {
      if (res.ok) updateDerived(id, { fileCount: res.data.files.length });
    });
  };

  // Apply a successful session_list (mount hydration + retry) identically (FR-2/6/23).
  const applyHydration = (data: SessionMeta[]) => {
    setHydrationError(null);
    setSessions(data);
    if (useStore.getState().activeSessionId === null && data[0]) setActiveSessionId(data[0].id);
    for (const s of data) seedDiff(s.id);
  };

  // Hydration + live event subscription (FR-2/FR-3/FR-5/FR-6/FR-7).
  useEffect(() => {
    let unlistenSession: (() => void) | undefined;
    let unlistenDiff: (() => void) | undefined;
    let cancelled = false;

    void onSessionEvent((e) => {
      if (e.type === 'session.meta') {
        upsertSession(e.meta);
        seedDiff(e.meta.id); // FR-6 — seedDiff dedups, so this fires once even though App upserts first
      } else if (e.type === 'session.status') {
        patchStatus(e.sessionId, e.status);
      } else if (e.type === 'context.usage') {
        patchUsage(e.sessionId, e.usedTokens, e.limitTokens); // keeps the ctx figure live (FR-3)
      } else if (e.type === 'agent.update') {
        const a = e.agent;
        if (!useStore.getState().sessions.some((x) => x.id === a.sessionId)) return; // drop post-removal (FR-7)
        let m = agentStatusRef.current.get(a.sessionId);
        if (!m) {
          m = new Map();
          agentStatusRef.current.set(a.sessionId, m);
        }
        m.set(a.id, a.status);
        updateDerived(a.sessionId, { runningAgentCount: countRunning(m) }); // FR-5
      } else if (e.type === 'session.removed') {
        handleRemovedEvent(e.sessionId);
      }
    }).then((u) => {
      if (cancelled) u();
      else unlistenSession = u;
    });

    // Per-session diff file count, matched on sessionId for ALL sessions (FR-6).
    void onDiffEvent((e) => {
      if (e.type === 'diff.changed') updateDerived(e.sessionId, { fileCount: e.fileCount });
    }).then((u) => {
      if (cancelled) u();
      else unlistenDiff = u;
    });

    void sessionList().then((res) => {
      if (cancelled) return;
      if (res.ok) applyHydration(res.data);
      else setHydrationError(res.error);
    });

    return () => {
      cancelled = true;
      if (unlistenSession) unlistenSession();
      if (unlistenDiff) unlistenDiff();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Relative-time refresh: idle cards age visibly without any event (FR-25).
  useEffect(() => {
    const id = setInterval(() => setTick((t) => (t + 1) % 1_000_000), 30_000);
    return () => clearInterval(id);
  }, []);

  // Reassign selection when the active session disappears (§7).
  const handleRemovedEvent = (id: string) => {
    const st = useStore.getState();
    if (st.activeSessionId === id) reassignAfterRemoval(id);
    removeSessionFromCache(id);
    dropDerived(id); // FR-7
    prunePaletteSession(id);
  };

  const reassignAfterRemoval = (id: string) => {
    const st = useStore.getState();
    const list = st.sessions;
    const idx = list.findIndex((s) => s.id === id);
    const remaining = list.filter((s) => s.id !== id);
    if (remaining.length === 0) {
      setActiveSessionId(null);
    } else {
      const next = remaining[Math.min(idx, remaining.length - 1)];
      setActiveSessionId(next.id);
    }
  };

  // Clamp keyboard cursor into range on list / selection changes (FR-18).
  useEffect(() => {
    if (visible.length === 0) {
      setRowCursor(0);
      return;
    }
    setRowCursor((c) => {
      if (c < visible.length && visible[c]) return c;
      const activeIdx = visible.findIndex((s) => s.id === activeSessionId);
      return activeIdx >= 0 ? activeIdx : 0;
    });
  }, [visible, activeSessionId]);

  // Keyboard handling for pane [1] and the filter input (FR-16/17/20).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (newSessionOpen || menu) return;
      const ae = document.activeElement as HTMLElement | null;
      const inFilter = ae === filterRef.current;
      const inOtherInput = !!ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA') && !inFilter;
      if (inOtherInput) return;
      if (focusedPane !== 'sidebar' && !inFilter) return;

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setRowCursor((c) => Math.min(c + 1, Math.max(0, visible.length - 1)));
          break;
        case 'ArrowUp':
          e.preventDefault();
          setRowCursor((c) => Math.max(c - 1, 0));
          break;
        case 'Enter':
          if (visible.length > 0 && visible[rowCursor]) {
            e.preventDefault();
            setActiveSessionId(visible[rowCursor].id);
            setFocusedPane('main'); // FR-17: commit AND jump into the conversation
          }
          break;
        case '/':
          if (!inFilter) {
            e.preventDefault();
            setSidebarFilter('');
            requestAnimationFrame(() => filterRef.current?.focus());
          }
          break;
        case 'Escape':
          if (inFilter) {
            e.preventDefault();
            setSidebarFilter(null);
            filterRef.current?.blur();
          }
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focusedPane, visible, rowCursor, sidebarFilter, newSessionOpen, menu, setActiveSessionId, setSidebarFilter, setFocusedPane]);

  // Close the context menu on any outside interaction.
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenu(null);
    };
    window.addEventListener('click', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  const doRemove = async (sessionId: string) => {
    const res = await sessionRemove(sessionId);
    if (res.ok) {
      const st = useStore.getState();
      if (st.activeSessionId === sessionId) reassignAfterRemoval(sessionId);
      removeSessionFromCache(sessionId);
      dropDerived(sessionId); // FR-7
      prunePaletteSession(sessionId);
      setMenu(null);
    } else {
      setMenu((m) => (m ? { ...m, error: res.error } : m));
    }
  };

  const focused = focusedPane === 'sidebar';

  return (
    <section
      onClick={() => setFocusedPane('sidebar')}
      style={{
        display: 'flex',
        flexDirection: 'column',
        background: '#16171c',
        border: `1px solid ${focused ? C.accent : '#24262d'}`,
        borderRadius: 5,
        overflow: 'hidden',
        minHeight: 0,
        height: '100%',
      }}
    >
      {/* header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '9px 12px',
          borderBottom: '1px solid #24262d',
          flexShrink: 0,
        }}
      >
        <span style={{ fontSize: 11, letterSpacing: '0.14em', color: focused ? C.accent : C.dim, fontWeight: 700 }}>
          SESSIONS
        </span>
        <span style={{ fontSize: 10, color: C.faint }}>{sessions.length} · [1]</span>
      </div>

      {/* filter */}
      {sidebarFilter !== null && (
        <div style={{ padding: '6px 8px', borderBottom: '1px solid #1d1f25', flexShrink: 0 }}>
          <input
            ref={filterRef}
            value={sidebarFilter}
            placeholder="filter…"
            onChange={(e) => setSidebarFilter(e.target.value)}
            style={{
              width: '100%',
              background: '#1a1c22',
              border: '1px solid #2a2c33',
              borderRadius: 4,
              padding: '6px 8px',
              color: C.primary,
              fontSize: 12,
              fontFamily: 'inherit',
              outline: 'none',
            }}
          />
        </div>
      )}

      {/* list */}
      <div className="scz" style={{ flex: 1, overflow: 'auto', padding: 6 }}>
        {hydrationError ? (
          <div style={{ padding: 16, textAlign: 'center', color: C.error, fontSize: 11.5 }}>
            failed to load sessions
            <div
              onClick={() => {
                void sessionList().then((res) => {
                  if (res.ok) applyHydration(res.data);
                  else setHydrationError(res.error);
                });
              }}
              style={{ color: C.accent, cursor: 'pointer', marginTop: 6 }}
            >
              retry
            </div>
          </div>
        ) : sessions.length === 0 ? (
          <Centered>no sessions yet · press n</Centered>
        ) : visible.length === 0 ? (
          <Centered>no matches · esc to clear</Centered>
        ) : (
          visible.map((s, i) => (
            <SessionCard
              key={s.id}
              s={s}
              home={home}
              selected={s.id === activeSessionId}
              cursor={focused && i === rowCursor}
              derived={derived.get(s.id)}
              onClick={() => {
                setActiveSessionId(s.id);
                setFocusedPane('sidebar');
              }}
              onContext={(x, y) => setMenu({ sessionId: s.id, x, y, confirming: false, error: null })}
            />
          ))
        )}
      </div>

      {/* footer */}
      <div
        onClick={() => useStore.getState().setNewSessionOpen(true)}
        style={{
          padding: '8px 12px',
          borderTop: '1px solid #24262d',
          fontSize: 10.5,
          color: C.faint,
          flexShrink: 0,
          cursor: 'pointer',
        }}
      >
        + new session <span style={{ color: '#3a3d45' }}>[n]</span>
      </div>

      {/* context menu */}
      {menu && (
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'fixed',
            left: menu.x,
            top: menu.y,
            background: '#1a1c22',
            border: '1px solid #2a2c33',
            borderRadius: 5,
            minWidth: 160,
            boxShadow: '0 12px 30px -10px rgba(0,0,0,0.7)',
            zIndex: 30,
            overflow: 'hidden',
          }}
        >
          {menu.error ? (
            <div style={{ padding: '8px 10px', fontSize: 11, color: C.error }}>{menu.error.message}</div>
          ) : !menu.confirming ? (
            <div
              onClick={() => setMenu({ ...menu, confirming: true })}
              style={{ padding: '8px 10px', fontSize: 12, color: C.primary, cursor: 'pointer' }}
              onMouseEnter={(e) => (e.currentTarget.style.background = '#26282f')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            >
              Remove session
            </div>
          ) : (
            <div style={{ padding: '8px 10px' }}>
              <div style={{ fontSize: 11.5, color: C.primary, marginBottom: 8 }}>
                remove '{sessions.find((s) => s.id === menu.sessionId)?.name ?? '?'}'?
              </div>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <span onClick={() => setMenu(null)} style={{ fontSize: 12, color: C.dim, cursor: 'pointer' }}>
                  Cancel
                </span>
                <span onClick={() => void doRemove(menu.sessionId)} style={{ fontSize: 12, color: C.error, cursor: 'pointer' }}>
                  Remove
                </span>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: '#565a63',
        fontSize: 11.5,
        textAlign: 'center',
        padding: 12,
      }}
    >
      {children}
    </div>
  );
}

function ContextFigure({ used, limit }: { used: number; limit: number }) {
  if (limit <= 0) {
    if (used <= 0) return <span style={{ color: C.faint }}>—</span>;
    return <span style={{ color: C.meta }}>{formatContextTokens(used)}</span>;
  }
  return (
    <>
      <span style={{ color: C.meta }}>{formatContextTokens(used)}</span>
      <span style={{ color: C.faint }}>/{formatContextTokens(limit)}</span>
    </>
  );
}

function SessionCard({
  s,
  home,
  selected,
  cursor,
  derived,
  onClick,
  onContext,
}: {
  s: SessionMeta;
  home: string;
  selected: boolean;
  cursor: boolean;
  derived: SessionDerived | undefined;
  onClick: () => void;
  onContext: (x: number, y: number) => void;
}) {
  const [hover, setHover] = useState(false);
  const sc = STATUS_COLOR[s.status] ?? C.dim;
  const label = STATUS_LABEL[s.status] ?? s.status;
  const fileCount = derived?.fileCount ?? null;
  const agents = derived?.runningAgentCount ?? 0;

  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onContextMenu={(e) => {
        e.preventDefault();
        onContext(e.clientX, e.clientY);
      }}
      title={s.status === 'error' ? s.errorMessage : undefined}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        padding: '9px 10px',
        borderRadius: 4,
        cursor: 'pointer',
        marginBottom: 3,
        background: selected ? '#20222a' : hover ? '#1b1d23' : 'transparent',
        outline: cursor ? '1px solid #3a3d45' : 'none',
        outlineOffset: -1,
      }}
    >
      {/* Row 1 — header: dot + name + relative time */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            flexShrink: 0,
            background: sc,
            animation: statusPulses(s.status) ? 'pulse 1.4s ease-in-out infinite' : 'none',
          }}
        />
        <span
          style={{ flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: selected ? C.bright : C.primary }}
        >
          {s.name}
        </span>
        <span style={{ flexShrink: 0, fontSize: 10, color: C.faint }}>{formatRelativeTime(s.lastActivityAt)}</span>
      </div>

      {/* Row 2 — cwd */}
      <div style={{ fontSize: 10.5, color: C.faint, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginLeft: 17 }}>
        {displayWslCwd(s.cwd) ?? abbreviate(s.cwd, home)}
      </div>

      {/* Row 3 — status line */}
      <div style={{ fontSize: 10, letterSpacing: '0.02em', marginLeft: 17, color: sc, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {label} · {s.model.label}
      </div>

      {/* Row 4 — meta: context + diff badge + agent count */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginLeft: 17, fontSize: 10 }}>
        <span>
          <span style={{ color: C.faint }}>ctx </span>
          <ContextFigure used={s.contextUsedTokens} limit={s.contextLimitTokens} />
        </span>
        {fileCount != null && fileCount > 0 && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
            <span style={{ color: C.faint }}>≡</span>
            <span style={{ background: '#26282f', color: C.meta, fontSize: 9, fontWeight: 500, letterSpacing: 0, padding: '1px 5px', borderRadius: 8 }}>{fileCount}</span>
          </span>
        )}
        {agents > 0 && <span style={{ color: C.accent }}>⇉ {agents}</span>}
      </div>
    </div>
  );
}
