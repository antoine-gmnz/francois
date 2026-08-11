import { useEffect, useMemo, useRef, useState } from 'react';
import { filterSessionsByProject } from '../../../contract/projects';
import type { EditorId } from '../../../contract/open-in-vscode';
import { sessionOpenInEditor, sessionRemove, sessionWorktreeRemove, sessionWorktreeStatus } from '../../lib/api';
import { AdoptCloudButton } from '../cloud-sessions/AdoptCloudButton';
import { prunePaletteSession } from '../palette/paletteData';
import { showToast } from '../palette/palette';
import { visibleSessions } from '../projects/projects';
import { abbreviate } from '../../lib/path';
import { useStore } from '../../lib/store';
import { getEditorList } from './editors';
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
  // cloud-sessions FR-14: the adopt modal owns ↑/↓ while it is up.
  const adoptCloudOpen = useStore((s) => s.adoptCloudOpen);
  // session-rename FR-8: the rename modal owns the keyboard while it is up.
  const renameOpen = useStore((s) => s.renameSessionId !== null);
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
  // split-session: the roster shows both paned sessions (FR-15) and assigns a
  // pick to the FOCUSED side (FR-8).
  const splitSessionId = useStore((s) => s.splitSessionId);
  const focusedSide = useStore((s) => s.focusedSide);
  const openInRightPane = useStore((s) => s.openInRightPane);

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
    // split-session FR-8: a pick lands in the FOCUSED pane. Assigning it to the
    // side that already holds the other pane's session swaps them — both store
    // actions handle that themselves, so this only has to route.
    if (splitSessionId !== null && focusedSide === 'right') openInRightPane(id);
    else setActiveSessionId(id);
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
    adoptCloudOpen,
    projectsOpen,
    menuOpen: !!menu,
    renameOpen,
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

  // session-worktree FR-17: kicks off the dirty/unpushed probe when the confirm
  // step opens for a session that has a worktree.
  const startWorktreeCheck = (sessionId: string) => {
    setMenu((m) => (m ? { ...m, worktreeChecking: true } : m));
    void sessionWorktreeStatus(sessionId).then((res) => {
      setMenu((m) => {
        if (!m || m.sessionId !== sessionId) return m; // menu moved on
        if (res.ok) return { ...m, worktreeChecking: false, worktreeStatus: res.data };
        if (res.error.code === 'WORKTREE_NOT_FOUND') return { ...m, worktreeChecking: false, worktreeGone: true };
        // FR-20: a git-side status-check failure (e.g. GIT_ERROR/INTERNAL) must not
        // block removing the session — keep the normal confirm UI, just disable the
        // worktree-removal checkbox.
        return { ...m, worktreeChecking: false, worktreeStatusFailed: true };
      });
    });
  };

  // FR-20: session_worktree_remove runs first (it needs the session's worktree
  // metadata), but session_remove always follows regardless of its outcome — a
  // failed directory removal surfaces as a toast, never blocks removing the
  // session from Francois.
  const doRemove = async (sessionId: string, removeWorktree: boolean) => {
    if (removeWorktree) {
      const wtRes = await sessionWorktreeRemove(sessionId);
      if (!wtRes.ok) showToast(wtRes.error.message, 'error');
    }
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

  // open-in-vscode FR-11: a spawn, not a mutation (FR-12) — no store update, no
  // event to wait for. Success closes the menu; failure reuses the existing
  // error state.
  const doOpenInEditor = async (sessionId: string, editorId: EditorId) => {
    const res = await sessionOpenInEditor({ sessionId, editorId });
    if (res.ok) {
      setMenu(null);
    } else {
      setMenu((m) => (m && m.sessionId === sessionId ? { ...m, error: res.error } : m));
    }
  };

  // Copy path: acknowledge in place (the item flips to "✓ Path copied") rather
  // than with a toast — the menu is still on screen, so the feedback belongs on
  // the thing that was clicked. A failure DOES toast, since the menu shows the
  // path truncated and there is nothing to fall back to by hand.
  const copyTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (copyTimeout.current) clearTimeout(copyTimeout.current); }, []);
  const copyPath = (sessionId: string, path: string) => {
    void navigator.clipboard
      ?.writeText(path)
      .then(() => {
        setMenu((m) => (m && m.sessionId === sessionId ? { ...m, copied: true } : m));
        if (copyTimeout.current) clearTimeout(copyTimeout.current);
        copyTimeout.current = setTimeout(() => {
          setMenu((m) => (m && m.sessionId === sessionId ? { ...m, copied: false } : m));
        }, 1200);
      })
      .catch(() => showToast('Could not copy the path to the clipboard.', 'error'));
  };

  const focused = focusedPane === 'sidebar';

  return (
    // split-session §8: the roster narrows 276 → 238px in split, so its cards go
    // one notch denser to keep the same information on a shorter line.
    <section
      onClick={() => setFocusedPane('sidebar')}
      className={
        [focused ? 'sidebar sidebar--focused' : 'sidebar', splitSessionId !== null ? 'sidebar--dense' : null]
          .filter(Boolean)
          .join(' ')
      }
    >
      {/* header */}
      <div className="sidebar__header">
        <span className={focused ? 'sidebar__title sidebar__title--focused' : 'sidebar__title'}>SESSIONS</span>
        {/* projects FR-27: the count is post-filter — project scope AND '/' query. */}
        <span className="sidebar__count">{visible.length} · [1]</span>
      </div>

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
        splitSessionId={splitSessionId}
        focusedSide={focusedSide}
        onSelect={(id) => {
          selectSession(id);
          setFocusedPane('sidebar');
        }}
        onContext={(sessionId, x, y) => {
          setMenu({ sessionId, x, y, confirming: false, error: null, editors: [] });
          // open-in-vscode FR-10: fetched on menu open, memoized in editors.ts —
          // while unresolved the group stays absent (no spinner, no skeleton).
          void getEditorList().then((editors) => {
            setMenu((m) => (m && m.sessionId === sessionId ? { ...m, editors } : m));
          });
        }}
      />

      {/* footer — design-refresh FR-6: a real full-width button, per the mock,
          instead of the bare clickable line it used to be. cloud-sessions FR-14
          adds its adopt action BESIDE it, compact, so the primary keeps its
          width at the split roster's 238px. */}
      <div className="sidebar__footer">
        <div className="sidebar__footer-row">
          <button type="button" onClick={() => useStore.getState().setNewSessionOpen(true)} className="sidebar__new">
            <span className="sidebar__new-plus">+</span>New session
            <span className="sidebar__footer-hint">n</span>
          </button>
          <AdoptCloudButton />
        </div>
      </div>

      {/* context menu */}
      {menu && (
        <SessionContextMenu
          menu={menu}
          sessionName={sessions.find((session) => session.id === menu.sessionId)?.name ?? '?'}
          sessionPath={abbreviate(sessions.find((session) => session.id === menu.sessionId)?.cwd ?? '', home)}
          worktree={sessions.find((session) => session.id === menu.sessionId)?.worktree ?? null}
          containerRef={menuRef}
          // split-session FR-11: hidden for the session already in the LEFT
          // pane, and whenever `▯▯` itself would be disabled (All-projects
          // scope, or fewer than two sessions in scope).
          onOpenInRightPane={
            activeProjectId !== null && menu.sessionId !== activeSessionId && inProject.length >= 2
              ? (sessionId) => {
                  setMenu(null);
                  openInRightPane(sessionId);
                }
              : undefined
          }
          onStartConfirm={() => {
            const target = sessions.find((session) => session.id === menu.sessionId);
            setMenu({ ...menu, confirming: true });
            // session-worktree FR-17: probe dirty/unpushed only once the confirm
            // step is actually open, and only for a session that has a worktree.
            if (target?.worktree) startWorktreeCheck(menu.sessionId);
          }}
          onRename={() => {
            // session-rename FR-12: the menu closes, the modal (rendered by the
            // shell, since ⌘K opens the same one) takes over.
            setMenu(null);
            useStore.getState().setRenameSessionId(menu.sessionId);
          }}
          onCopyPath={() => {
            // The RAW cwd, not the `~`-abbreviated one the header renders — what
            // gets pasted has to be a path a shell can actually cd into.
            const cwd = sessions.find((session) => session.id === menu.sessionId)?.cwd;
            if (cwd) copyPath(menu.sessionId, cwd);
          }}
          onCancel={() => setMenu(null)}
          onToggleRemoveWorktree={() => setMenu((m) => (m ? { ...m, removeWorktree: !m.removeWorktree } : m))}
          onRemove={(removeWorktree) => void doRemove(menu.sessionId, removeWorktree)}
          onOpenInEditor={(editorId) => void doOpenInEditor(menu.sessionId, editorId)}
        />
      )}
    </section>
  );
}
