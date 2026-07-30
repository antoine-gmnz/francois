import { useEffect, useMemo, useRef, useState } from 'react';
import type { AppError, SessionMeta, SessionStatus } from '../../../contract/common';
import { STATUS_COLOR, STATUS_LABEL, countRunning, formatRelativeTime, statusPulses, type SessionDerived } from '../../../contract/fleet-board';
import { formatContextTokens } from '../../../contract/conversation-view';
import { displayWslCwd } from '../../../contract/wsl-filesystem';
import { filterSessionsByProject } from '../../../contract/projects';
import { statusTransitionKind, type ActivityKind } from '../../../contract/overview';
import { diffGetSummary, onDiffEvent, onSessionEvent, sessionList, sessionRemove } from '../../lib/api';
import { abbreviate } from '../../lib/path';
import { prunePaletteSession } from '../palette/paletteData';
import ProjectSwitcher from '../projects/ProjectSwitcher';
import { filteredEmptyLabel, visibleSessions } from '../projects/projects';
import { useStore } from '../../lib/store';
import { BadgePill } from '../../ui/BadgePill';
import { EmptyPane } from '../../ui/EmptyPane';
import { StatusDot } from '../../ui/StatusDot';
import './sidebar.css';

// pane [1] — the fleet board (Mission Control). Evolves the sessions-sidebar row
// list into rich per-session status cards, aggregated from existing channels
// (specs/fleet-board.md). Preserves every sessions-sidebar behaviour.

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
  const logActivity = (session: SessionMeta, kind: ActivityKind, detail: string) => {
    recordActivity({
      at: Date.now(),
      kind,
      sessionId: session.id,
      sessionName: session.name,
      projectId: session.projectId,
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
    for (const session of data) {
      seedDiff(session.id);
      startedRef.current.add(session.id); // restored, not started — no feed entry (overview FR-28)
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
        const prev = useStore.getState().sessions.find((session) => session.id === e.sessionId);
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
        const agent = e.agent;
        const owner = useStore.getState().sessions.find((session) => session.id === agent.sessionId);
        if (!owner) return; // drop post-removal (FR-7)
        let m = agentStatusRef.current.get(agent.sessionId);
        if (!m) {
          m = new Map();
          agentStatusRef.current.set(agent.sessionId, m);
        }
        const prevStatus = m.get(agent.id);
        m.set(agent.id, agent.status);
        updateDerived(agent.sessionId, { runningAgentCount: countRunning(m) }); // FR-5
        // overview: an agent SETTLING is feed-worthy; its intermediate updates
        // (every step re-emits) are not — hence the transition guard.
        if (prevStatus !== agent.status) {
          if (agent.status === 'done') logActivity(owner, 'agent.finished', agent.name);
          else if (agent.status === 'error') logActivity(owner, 'agent.failed', agent.name);
        }
      } else if (e.type === 'session.removed') {
        const gone = useStore.getState().sessions.find((session) => session.id === e.sessionId);
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
    const idx = list.findIndex((session) => session.id === id);
    const remaining = list.filter((session) => session.id !== id);
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
      const activeIdx = visible.findIndex((session) => session.id === activeSessionId);
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
      const activeEl = document.activeElement as HTMLElement | null;
      const inFilter = activeEl === filterRef.current;
      const inOtherInput = !!activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA') && !inFilter;
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
    <section onClick={() => setFocusedPane('sidebar')} className={focused ? 'sidebar sidebar--focused' : 'sidebar'}>
      {/* header */}
      <div className="sidebar__header">
        <span className={focused ? 'sidebar__title sidebar__title--focused' : 'sidebar__title'}>SESSIONS</span>
        {/* projects FR-27: the count is post-filter — project scope AND '/' query. */}
        <span className="sidebar__count">{visible.length} · [1]</span>
      </div>

      {/* projects FR-25: the switcher strip, above the cards */}
      <ProjectSwitcher home={home} />

      {/* filter */}
      {sidebarFilter !== null && (
        <div className="filter-input">
          <input
            ref={filterRef}
            className="filter-input__field"
            value={sidebarFilter}
            placeholder="filter…"
            onChange={(e) => setSidebarFilter(e.target.value)}
          />
        </div>
      )}

      {/* list */}
      <div className="scz sidebar-list">
        {hydrationError ? (
          <div className="sidebar-error">
            failed to load sessions
            <div
              onClick={() => {
                void sessionList().then((res) => {
                  if (res.ok) applyHydration(res.data);
                  else setHydrationError(res.error);
                });
              }}
              className="sidebar-error__retry"
            >
              retry
            </div>
          </div>
        ) : sessions.length === 0 ? (
          <EmptyPane className="sidebar-empty">no sessions yet · press n</EmptyPane>
        ) : activeProjectId !== null && inProject.length === 0 ? (
          // projects FR-29: a project is active and owns no session — distinct
          // from the global "no sessions yet" state.
          //
          // Keyed on the ID, not on the resolved object: `projects` is empty until
          // the switcher's project_list lands (and stays empty forever if it fails),
          // so keying on `activeProject` showed the '/'-filter message "no matches ·
          // esc to clear" on first paint with no filter typed. filteredEmptyLabel
          // degrades to a generic line for a null project.
          <EmptyPane className="sidebar-empty">
            {filteredEmptyLabel(activeProject)}
            <div className="sidebar-empty__hint">press n to start one</div>
          </EmptyPane>
        ) : visible.length === 0 ? (
          <EmptyPane className="sidebar-empty">no matches · esc to clear</EmptyPane>
        ) : (
          visible.map((session, i) => (
            <SessionCard
              key={session.id}
              session={session}
              home={home}
              selected={session.id === activeSessionId}
              cursor={focused && i === rowCursor}
              derived={derived.get(session.id)}
              onClick={() => {
                selectSession(session.id);
                setFocusedPane('sidebar');
              }}
              onContext={(x, y) => setMenu({ sessionId: session.id, x, y, confirming: false, error: null })}
            />
          ))
        )}
      </div>

      {/* footer */}
      <div onClick={() => useStore.getState().setNewSessionOpen(true)} className="sidebar__footer">
        + new session <span className="sidebar__footer-hint">[n]</span>
      </div>

      {/* context menu */}
      {menu && (
        <div onClick={(e) => e.stopPropagation()} className="context-menu" style={{ left: menu.x, top: menu.y }}>
          {menu.error ? (
            <div className="context-menu__error">{menu.error.message}</div>
          ) : !menu.confirming ? (
            <div className="context-menu__item" onClick={() => setMenu({ ...menu, confirming: true })}>
              Remove session
            </div>
          ) : (
            <div className="context-menu__body">
              <div className="context-menu__confirm-text">
                remove '{sessions.find((session) => session.id === menu.sessionId)?.name ?? '?'}'?
              </div>
              <div className="context-menu__actions">
                <span onClick={() => setMenu(null)} className="context-menu__action">
                  Cancel
                </span>
                <span onClick={() => void doRemove(menu.sessionId)} className="context-menu__action context-menu__action--danger">
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

function ContextFigure({ used, limit }: { used: number; limit: number }) {
  if (limit <= 0) {
    if (used <= 0) return <span className="sidebar-card__faint">—</span>;
    return <span className="sidebar-card__meta">{formatContextTokens(used)}</span>;
  }
  return (
    <>
      <span className="sidebar-card__meta">{formatContextTokens(used)}</span>
      <span className="sidebar-card__faint">/{formatContextTokens(limit)}</span>
    </>
  );
}

function SessionCard({
  session,
  home,
  selected,
  cursor,
  derived,
  onClick,
  onContext,
}: {
  session: SessionMeta;
  home: string;
  selected: boolean;
  cursor: boolean;
  derived: SessionDerived | undefined;
  onClick: () => void;
  onContext: (x: number, y: number) => void;
}) {
  const [hover, setHover] = useState(false);
  const statusColor = STATUS_COLOR[session.status] ?? 'var(--text-dim)';
  const label = STATUS_LABEL[session.status] ?? session.status;
  const fileCount = derived?.fileCount ?? null;
  const agents = derived?.runningAgentCount ?? 0;

  const classNames = ['sidebar-card'];
  if (selected) classNames.push('sidebar-card--selected');
  else if (hover) classNames.push('sidebar-card--hovered');
  if (cursor) classNames.push('sidebar-card--cursor');

  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onContextMenu={(e) => {
        e.preventDefault();
        onContext(e.clientX, e.clientY);
      }}
      title={session.status === 'error' ? session.errorMessage : undefined}
      className={classNames.join(' ')}
    >
      {/* Row 1 — header: dot + name + relative time */}
      <div className="sidebar-card__row1">
        <StatusDot color={statusColor} pulsing={statusPulses(session.status)} />
        <span className={selected ? 'sidebar-card__name sidebar-card__name--selected truncate' : 'sidebar-card__name truncate'}>
          {session.name}
        </span>
        <span className="sidebar-card__time">{formatRelativeTime(session.lastActivityAt)}</span>
      </div>

      {/* Row 2 — cwd */}
      <div className="sidebar-card__cwd">{displayWslCwd(session.cwd) ?? abbreviate(session.cwd, home)}</div>

      {/* Row 3 — status line */}
      <div className="sidebar-card__status" style={{ color: statusColor }}>
        {label} · {session.model.label}
      </div>

      {/* Row 4 — meta: context + diff badge + agent count */}
      <div className="sidebar-card__meta-row">
        <span>
          <span className="sidebar-card__faint">ctx </span>
          <ContextFigure used={session.contextUsedTokens} limit={session.contextLimitTokens} />
        </span>
        {fileCount != null && fileCount > 0 && (
          <span className="sidebar-card__files">
            <span className="sidebar-card__faint">≡</span>
            <BadgePill>{fileCount}</BadgePill>
          </span>
        )}
        {agents > 0 && <span className="sidebar-card__agents">⇉ {agents}</span>}
      </div>
    </div>
  );
}
