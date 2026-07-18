import { useEffect, useMemo, useRef, useState } from 'react';
import type { AppError, SessionMeta } from '../contract/common';
import { onSessionEvent, sessionList, sessionRemove } from './api';
import { prunePaletteSession } from './paletteData';
import { useStore } from './store';

const C = {
  running: '#d0a45c',
  idle: '#6b7079',
  done: '#7fa07a',
  error: '#c46b62',
  accent: '#c8a15a',
  dim: '#868a93',
  faint: '#565a63',
  primary: '#c4c7ce',
  bright: '#dfe2e8',
};

const statusColor: Record<string, string> = {
  running: C.running,
  idle: C.idle,
  done: C.done,
  error: C.error,
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
  const filterRef = useRef<HTMLInputElement>(null);

  const visible = useMemo(() => {
    if (sidebarFilter === null || sidebarFilter === '') return sessions;
    const q = sidebarFilter.toLowerCase();
    return sessions.filter((s) => s.name.toLowerCase().includes(q) || s.cwd.toLowerCase().includes(q));
  }, [sessions, sidebarFilter]);

  // Hydration + live event subscription (FR-1/FR-2/FR-7).
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void onSessionEvent((e) => {
      if (e.type === 'session.meta') upsertSession(e.meta);
      else if (e.type === 'session.status') patchStatus(e.sessionId, e.status);
      else if (e.type === 'session.removed') handleRemovedEvent(e.sessionId);
    }).then((u) => {
      if (cancelled) u();
      else unlisten = u;
    });

    void sessionList().then((res) => {
      if (res.ok) {
        setHydrationError(null);
        setSessions(res.data);
        const st = useStore.getState();
        if (st.activeSessionId === null && res.data[0]) setActiveSessionId(res.data[0].id);
      } else {
        setHydrationError(res.error);
      }
    });

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reassign selection when the active session disappears (§7).
  const handleRemovedEvent = (id: string) => {
    const st = useStore.getState();
    if (st.activeSessionId === id) reassignAfterRemoval(id);
    removeSessionFromCache(id);
    prunePaletteSession(id); // drop the palette's cached data for this session
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

  // Clamp keyboard cursor into range on list / selection changes (FR-11).
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

  // Keyboard handling for pane [1] and the filter input (FR-9/10/13/16/17).
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
  }, [focusedPane, visible, rowCursor, sidebarFilter, newSessionOpen, menu, setActiveSessionId, setSidebarFilter]);

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
                setHydrationError(null);
                void sessionList().then((res) => {
                  if (res.ok) setSessions(res.data);
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
            <Row
              key={s.id}
              s={s}
              home={home}
              selected={s.id === activeSessionId}
              cursor={focused && i === rowCursor}
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

function Row({
  s,
  home,
  selected,
  cursor,
  onClick,
  onContext,
}: {
  s: SessionMeta;
  home: string;
  selected: boolean;
  cursor: boolean;
  onClick: () => void;
  onContext: (x: number, y: number) => void;
}) {
  const [hover, setHover] = useState(false);
  const sc = statusColor[s.status] ?? C.idle;
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onContextMenu={(e) => {
        e.preventDefault();
        onContext(e.clientX, e.clientY);
      }}
      style={{
        display: 'flex',
        gap: 9,
        padding: '8px 9px',
        borderRadius: 4,
        cursor: 'pointer',
        background: selected ? '#20222a' : hover ? '#1b1d23' : 'transparent',
        borderLeft: `2px solid ${selected ? C.accent : 'transparent'}`,
        outline: cursor ? '1px solid #3a3d45' : 'none',
        outlineOffset: -1,
        marginBottom: 2,
      }}
    >
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          flexShrink: 0,
          marginTop: 5,
          background: sc,
          animation: s.status === 'running' ? 'pulse 1.4s ease-in-out infinite' : 'none',
        }}
      />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 12.5, color: selected ? C.bright : C.primary, fontWeight: 500 }}>{s.name}</div>
        <div
          style={{
            fontSize: 10.5,
            color: C.faint,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            marginTop: 1,
          }}
        >
          {abbreviate(s.cwd, home)}
        </div>
        <div style={{ fontSize: 10, color: sc, marginTop: 3, letterSpacing: '0.02em' }}>
          {s.status} · {s.model.label}
        </div>
      </div>
    </div>
  );
}
