import { useEffect, useMemo, useRef, useState } from 'react';
import { filterSessionsByProject } from '../../../contract/projects';
import { sessionRemove } from '../../lib/api';
import { prunePaletteSession } from '../palette/paletteData';
import ProjectSwitcher from '../projects/ProjectSwitcher';
import { visibleSessions } from '../projects/projects';
import { useStore } from '../../lib/store';
import { FilterInput } from './FilterInput';
import { SessionContextMenu, type MenuState } from './SessionContextMenu';
import { SessionListBody } from './SessionListBody';
import { useRowCursorClamp } from './useRowCursorClamp';
import { useSessionFleetSync } from './useSessionFleetSync';
import { useSidebarKeyboard } from './useSidebarKeyboard';
import './sidebar.css';

// pane [1] — the fleet board (Mission Control). Evolves the sessions-sidebar row
// list into rich per-session status cards, aggregated from existing channels
// (specs/fleet-board.md). Preserves every sessions-sidebar behaviour.

export default function Sidebar({ home }: { home: string }) {
  const sessions = useStore((s) => s.sessions);
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
  // agents (FR-4). Written by useSessionFleetSync (this pane owns the only
  // session/diff event subscription) but HELD IN THE STORE — the OVERVIEW
  // dashboard reads the same numbers and a second subscription would double
  // every diff seed.
  const derived = useStore((s) => s.derived);

  const [menu, setMenu] = useState<MenuState | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
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

  // Hydration + live session/diff event subscription (FR-2/3/5/6/7, overview feed).
  const fleet = useSessionFleetSync();

  // Clamp keyboard cursor into range on list / selection changes (FR-18), reset
  // to 0 on project-scope change (projects FR-28).
  const [rowCursor, setRowCursor] = useRowCursorClamp(visible, activeSessionId, activeProjectId);

  // overview: picking a session while the dashboard is up means "drill into this
  // one", so the main pane leaves OVERVIEW. Any OTHER tab is left alone — moving
  // between sessions while reviewing diffs must not kick you out of DIFF.
  const selectSession = (id: string) => {
    setActiveSessionId(id);
    if (useStore.getState().mainTab === 'overview') setMainTab('session');
  };

  // Keyboard handling for pane [1] and the filter input (FR-16/17/20).
  useSidebarKeyboard({
    focusedPane,
    visible,
    rowCursor,
    setRowCursor,
    sidebarFilter,
    setSidebarFilter,
    filterRef,
    newSessionOpen,
    projectsOpen,
    menuOpen: !!menu,
    selectSession,
    setFocusedPane,
  });

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
      if (st.activeSessionId === sessionId) fleet.reassignAfterRemoval(sessionId);
      removeSessionFromCache(sessionId);
      fleet.dropDerived(sessionId); // FR-7
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
      {/* <ProjectSwitcher home={home} /> */}

      {/* filter */}
      {sidebarFilter !== null && <FilterInput value={sidebarFilter} onChange={setSidebarFilter} inputRef={filterRef} />}

      {/* list */}
      <SessionListBody
        hydrationError={fleet.hydrationError}
        onRetry={fleet.retryHydration}
        sessionCount={sessions.length}
        activeProjectId={activeProjectId}
        inProjectCount={inProject.length}
        activeProject={activeProject}
        visible={visible}
        home={home}
        activeSessionId={activeSessionId}
        focused={focused}
        rowCursor={rowCursor}
        derived={derived}
        onSelect={(id) => {
          selectSession(id);
          setFocusedPane('sidebar');
        }}
        onContext={(sessionId, x, y) => setMenu({ sessionId, x, y, confirming: false, error: null })}
      />

      {/* footer — design-refresh FR-6: a real full-width button, per the mock,
          instead of the bare clickable line it used to be. */}
      <div className="sidebar__footer">
        <button type="button" onClick={() => useStore.getState().setNewSessionOpen(true)} className="sidebar__new">
          <span className="sidebar__new-plus">+</span>New session
          <span className="sidebar__footer-hint">n</span>
        </button>
      </div>

      {/* context menu */}
      {menu && (
        <SessionContextMenu
          menu={menu}
          sessionName={sessions.find((session) => session.id === menu.sessionId)?.name ?? '?'}
          containerRef={menuRef}
          onStartConfirm={() => setMenu({ ...menu, confirming: true })}
          onCancel={() => setMenu(null)}
          onRemove={() => void doRemove(menu.sessionId)}
        />
      )}
    </section>
  );
}
