import { useEffect, useMemo, useRef, useState } from 'react';
import type { AppError, SessionMeta, SessionStatus } from '../../../contract/common';
import { STATUS_COLOR, STATUS_LABEL, countRunning, formatRelativeTime, statusPulses, type SessionDerived } from '../../../contract/fleet-board';
import { formatContextTokens } from '../../../contract/conversation-view';
import { displayWslCwd } from '../../../contract/wsl-filesystem';
import { filterSessionsByProject } from '../../../contract/projects';
import { statusTransitionKind, type ActivityKind } from '../../../contract/overview';
import { diffGetSummary, onDiffEvent, onSessionEvent, sessionList, sessionRemove } from '../../lib/api';
import { prunePaletteSession } from '../palette/paletteData';
import ProjectSwitcher from '../projects/ProjectSwitcher';
import { filteredEmptyLabel, visibleSessions } from '../projects/projects';
import { useStore } from '../../lib/store';

// pane [1] — the fleet board (Mission Control). Evolves the sessions-sidebar row
// list into rich per-session status cards, aggregated from existing channels
// (specs/fleet-board.md). Preserves every sessions-sidebar behaviour.

const C = {
  accent: 'var(--accent)',
  dim: 'var(--text-dim)',
  faint: 'var(--text-faint)',
  primary: 'var(--text)',
  bright: 'var(--text-bright)',
  meta: 'var(--text-hint)',
  error: 'var(--error)',
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
  const patchError = useStore((s) => s.patchError);
  const patchUsage = useStore((s) => s.patchUsage);
  const removeSessionFromCache = useStore((s) => s.removeSession);
  const activeSessionId = useStore((s) => s.activeSessionId);
  const setActiveSessionId = useStore((s) => s.setActiveSessionId);
  const sidebarFilter = useStore((s) => s.sidebarFilter);
  const setSidebarFilter = useStore((s) => s.setSidebarFilter);
  const focusedPane = useStore((s) => s.focusedPane);
  const setFocusedPane = useStore((s) => s.setFocusedPane);
  const newSessionOpen = useStore((s) => s.newSessionOpen);
  // projects FR-27: the board's project scope (null = All projects).
  const activeProjectId = useStore((s) => s.activeProjectId);
  const projects = useStore((s) => s.projects);
  const projectsOpen = useStore((s) => s.projectsOpen);
  const setMainTab = useStore((s) => s.setMainTab);
  // Per-session derived figures NOT on SessionMeta: diff file count + running
  // agents (FR-4). Written here (this pane owns the only session/diff event
  // subscription) but HELD IN THE STORE — the OVERVIEW dashboard reads the same
  // numbers and a second subscription would double every diff seed.
  const derived = useStore((s) => s.derived);
  const mergeDerived = useStore((s) => s.mergeDerived);
  const dropDerivedFromCache = useStore((s) => s.dropDerived);
  // overview: the cross-project activity feed is fed from this same subscription.
  const recordActivity = useStore((s) => s.recordActivity);

  const [hydrationError, setHydrationError] = useState<AppError | null>(null);
  const [rowCursor, setRowCursor] = useState(0);
  const [menu, setMenu] = useState<MenuState | null>(null);
  // Backing store for runningAgentCount: sessionId → (agentId → status) (FR-5).
  const agentStatusRef = useRef<Map<string, Map<string, SessionStatus>>>(new Map());
  const seededRef = useRef<Set<string>>(new Set()); // sessions whose diff badge was seeded once (FR-6)
  // overview: ids this run has already accounted for in the activity feed. The
  // session CACHE cannot answer "is this new?" — App's onCreated upserts a
  // modal-created session before its session.meta event lands, and hydration
  // fills the cache with sessions that started long ago. This set is seeded
  // silently by hydration and written only here.
  const startedRef = useRef<Set<string>>(new Set());
  const [, setTick] = useState(0); // forces relative-time re-render (FR-25)
  const filterRef = useRef<HTMLInputElement>(null);

  // projects FR-27: the project filter applies BEFORE the '/' name/path filter —
  // the two compose by AND, and the pane header count reflects both. The
  // composition itself lives in visibleSessions() so it can be unit-tested.
  const inProject = useMemo(
    () => filterSessionsByProject(sessions, activeProjectId),
    [sessions, activeProjectId],
  );

  const visible = useMemo(
    () => visibleSessions(sessions, activeProjectId, sidebarFilter),
    [sessions, activeProjectId, sidebarFilter],
  );

  const activeProject = projects.find((p) => p.id === activeProjectId) ?? null;

  // Merge a partial into a session's derived entry (FR-4). The store drops late
  // resolutions for a session no longer in the cache, so a removed session can't
  // leak an entry back in (FR-7).
  const updateDerived = (id: string, partial: Partial<SessionDerived>) => {
    mergeDerived(id, partial);
  };
  const dropDerived = (id: string) => {
    agentStatusRef.current.delete(id);
    seededRef.current.delete(id);
    startedRef.current.delete(id);
    dropDerivedFromCache(id);
  };
  // overview: picking a session while the dashboard is up means "drill into this
  // one", so the main pane leaves OVERVIEW. Any OTHER tab is left alone — moving
  // between sessions while reviewing diffs must not kick you out of DIFF.
  const selectSession = (id: string) => {
    setActiveSessionId(id);
    if (useStore.getState().mainTab === 'overview') setMainTab('session');
  };

  // overview: one feed entry. The session's name and project are captured HERE,
  // at record time, so a later rename or removal never rewrites history.
  const logActivity = (s: SessionMeta, kind: ActivityKind, detail: string) => {
    recordActivity({
      at: Date.now(),
      kind,
      sessionId: s.id,
      sessionName: s.name,
      projectId: s.projectId,
      detail,
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
    for (const s of data) {
      seedDiff(s.id);
      startedRef.current.add(s.id); // restored, not started — no feed entry (overview FR-28)
    }
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
        // overview: the FIRST meta this run has seen for an id is a new session.
        // Hydration pre-seeds startedRef, so restored sessions stay silent.
        if (!startedRef.current.has(e.meta.id)) {
          startedRef.current.add(e.meta.id);
          logActivity(e.meta, 'session.started', '');
        }
      } else if (e.type === 'session.status') {
        // overview: read the OLD status before patching, so the feed can tell a
        // finished turn from a session that merely settled.
        const prev = useStore.getState().sessions.find((x) => x.id === e.sessionId);
        patchStatus(e.sessionId, e.status);
        const kind = statusTransitionKind(prev?.status, e.status);
        if (kind && prev) {
          logActivity(prev, kind, kind === 'session.error' ? (prev.errorMessage ?? '') : '');
        }
      } else if (e.type === 'session.error') {
        // overview FR-28/FR-17: the engine emits session.error and THEN
        // session.status, and never a fresh session.meta — so this is the only
        // place the failure message can be captured. Without it the activity feed
        // logs an empty detail and NEEDS ATTENTION shows the generic "session
        // failed" fallback for every live error, which defeats the point of
        // naming the failure. Landing before the status event, this is already in
        // the cache when the transition below reads `prev`.
        patchError(e.sessionId, e.error.message);
      } else if (e.type === 'context.usage') {
        patchUsage(e.sessionId, e.usedTokens, e.limitTokens); // keeps the ctx figure live (FR-3)
      } else if (e.type === 'agent.update') {
        const a = e.agent;
        const owner = useStore.getState().sessions.find((x) => x.id === a.sessionId);
        if (!owner) return; // drop post-removal (FR-7)
        let m = agentStatusRef.current.get(a.sessionId);
        if (!m) {
          m = new Map();
          agentStatusRef.current.set(a.sessionId, m);
        }
        const prevStatus = m.get(a.id);
        m.set(a.id, a.status);
        updateDerived(a.sessionId, { runningAgentCount: countRunning(m) }); // FR-5
        // overview: an agent SETTLING is feed-worthy; its intermediate updates
        // (every step re-emits) are not — hence the transition guard.
        if (prevStatus !== a.status) {
          if (a.status === 'done') logActivity(owner, 'agent.finished', a.name);
          else if (a.status === 'error') logActivity(owner, 'agent.failed', a.name);
        }
      } else if (e.type === 'session.removed') {
        const gone = useStore.getState().sessions.find((x) => x.id === e.sessionId);
        if (gone) logActivity(gone, 'session.removed', '');
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

  // projects FR-28: switching project resets the keyboard cursor to index 0 of
  // the newly visible list — and NOTHING else. activeSessionId is untouched, so
  // the active session stays active and stays rendered in the main pane even
  // when the filter hides its card (§7 case 17). Declared after the clamp effect
  // so this wins on a project change.
  useEffect(() => {
    setRowCursor(0);
  }, [activeProjectId]);

  // Keyboard handling for pane [1] and the filter input (FR-16/17/20).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (newSessionOpen || projectsOpen || menu) return;
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
            selectSession(visible[rowCursor].id);
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
  }, [focusedPane, visible, rowCursor, sidebarFilter, newSessionOpen, projectsOpen, menu, setActiveSessionId, setSidebarFilter, setFocusedPane]);

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
        background: 'var(--bg-deep)',
        border: `1px solid ${focused ? C.accent : 'var(--border)'}`,
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
          borderBottom: '1px solid var(--border)',
          flexShrink: 0,
        }}
      >
        <span style={{ fontSize: 11, letterSpacing: '0.14em', color: focused ? C.accent : C.dim, fontWeight: 700 }}>
          SESSIONS
        </span>
        {/* projects FR-27: the count is post-filter — project scope AND '/' query. */}
        <span style={{ fontSize: 10, color: C.faint }}>{visible.length} · [1]</span>
      </div>

      {/* projects FR-25: the switcher strip, above the cards */}
      <ProjectSwitcher home={home} />

      {/* filter */}
      {sidebarFilter !== null && (
        <div style={{ padding: '6px 8px', borderBottom: '1px solid var(--bg-elevated)', flexShrink: 0 }}>
          <input
            ref={filterRef}
            value={sidebarFilter}
            placeholder="filter…"
            onChange={(e) => setSidebarFilter(e.target.value)}
            style={{
              width: '100%',
              background: 'var(--bg-panel)',
              border: '1px solid var(--border-2)',
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
        ) : activeProjectId !== null && inProject.length === 0 ? (
          // projects FR-29: a project is active and owns no session — distinct
          // from the global "no sessions yet" state.
          //
          // Keyed on the ID, not on the resolved object: `projects` is empty until
          // the switcher's project_list lands (and stays empty forever if it fails),
          // so keying on `activeProject` showed the '/'-filter message "no matches ·
          // esc to clear" on first paint with no filter typed. filteredEmptyLabel
          // degrades to a generic line for a null project.
          <Centered>
            {filteredEmptyLabel(activeProject)}
            <div style={{ fontSize: 10, marginTop: 5 }}>press n to start one</div>
          </Centered>
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
                selectSession(s.id);
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
          borderTop: '1px solid var(--border)',
          fontSize: 10.5,
          color: C.faint,
          flexShrink: 0,
          cursor: 'pointer',
        }}
      >
        + new session <span style={{ color: 'var(--text-disabled)' }}>[n]</span>
      </div>

      {/* context menu */}
      {menu && (
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'fixed',
            left: menu.x,
            top: menu.y,
            background: 'var(--bg-panel)',
            border: '1px solid var(--border-2)',
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
              onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-hover)')}
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
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'var(--text-faint)',
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
        background: selected ? 'var(--bg-raised)' : hover ? 'var(--bg-elevated)' : 'transparent',
        outline: cursor ? '1px solid var(--text-disabled)' : 'none',
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
            <span style={{ background: 'var(--bg-hover)', color: C.meta, fontSize: 9, fontWeight: 500, letterSpacing: 0, padding: '1px 5px', borderRadius: 8 }}>{fileCount}</span>
          </span>
        )}
        {agents > 0 && <span style={{ color: C.accent }}>⇉ {agents}</span>}
      </div>
    </div>
  );
}
