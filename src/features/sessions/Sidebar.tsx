import { useEffect, useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { filterSessionsByProject } from '../../../contract/projects';
import type { EditorId } from '../../../contract/open-in-vscode';
import { sessionOpenInEditor, sessionRemove, sessionWorktreeRemove, sessionWorktreeStatus } from '../../lib/api';
import { AdoptCloudButton } from '../cloud-sessions/AdoptCloudButton';
import { prunePaletteSession } from '../palette/paletteData';
import { showToast } from '../palette/palette';
import { visibleSessions } from '../projects/projects';
import { MAX_PANES, paneCount, paneIndicesOf } from '../../lib/layoutStore';
import { abbreviate } from '../../lib/path';
import { focusedSessionId } from '../../lib/layoutStore';
import { EMPTY_PANEL_COUNTS, type CountedPane } from '../../lib/panelCountsStore';
import { isBusyStatus } from '../../../contract/fleet-board';
import { useElapsedClock } from '../../lib/hooks/useElapsedClock';
import { useStore } from '../../lib/store';
import { getEditorList } from './editors';
import { FilterInput } from './FilterInput';
import { loadCollapsedTiers, persistCollapsedTiers, withGroupTiers } from './group-tier';
import { groupKeyFor } from './roster-groups';
import {
  flattenStateGroups,
  groupSessionsByState,
  loadCollapsedStates,
  persistCollapsedStates,
} from './state-groups';
import { paneBadgeLabel } from './roster-row';
import { RosterGate } from './RosterGate';
import { SessionContextMenu, type MenuState } from './SessionContextMenu';
import { StateRosterBody } from './StateRosterBody';
import { useRowCursorClamp } from './useRowCursorClamp';
import { useSessionFleetSync } from './useSessionFleetSync';
import { useSidebarKeyboard } from './useSidebarKeyboard';
import './sidebar.css';

const ICON = { size: 13, strokeWidth: 1.75 } as const;

/**
 * design 7a: the right column is dissolved into four destinations under the
 * roster. They are NOT session cards — no status, no card surface — so the
 * roster still reads as a list of sessions with a small index beneath it.
 *
 * 12b folds the four rows onto ONE line, and the icons go with the fold: four
 * labels, four counts and four glyphs do not fit across 276px, and a label
 * clipped to "Age…" is worse than no icon at all.
 */
const PANE_ROWS: readonly { pane: CountedPane; label: string; key: number }[] = [
  { pane: 'agents', label: 'Agents', key: 3 },
  { pane: 'mcp', label: 'MCP', key: 4 },
  { pane: 'skills', label: 'Skills', key: 5 },
  { pane: 'workflows', label: 'Flows', key: 6 },
];

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
  // project-groups FR-11: the roster's second tier.
  const groupRegistry = useStore((s) => s.groups);
  const projectsOpen = useStore((s) => s.projectsOpen);
  const setMainTab = useStore((s) => s.setMainTab);
  // Per-session derived figures NOT on SessionMeta: diff file count + running
  // agents (FR-4). Written by useSessionFleetSync (this pane owns the only
  // session/diff event subscription) but HELD IN THE STORE — the OVERVIEW
  // dashboard reads the same numbers and a second subscription would double
  // every diff seed.
  const derived = useStore((s) => s.derived);
  // split-by-4: the roster badges every paned session (FR-22) and assigns a pick
  // to the FOCUSED pane (FR-19).
  const extraPanes = useStore((s) => s.extraPanes);
  const focusedPaneIndex = useStore((s) => s.focusedPaneIndex);
  const assignToFocusedPane = useStore((s) => s.assignToFocusedPane);
  const openInNewPane = useStore((s) => s.openInNewPane);
  const panes = paneCount({ extraPanes });

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

  const inScope = useMemo(
    () => visibleSessions(sessions, activeProjectId, sidebarFilter),
    [sessions, activeProjectId, sidebarFilter],
  );

  // design 12b: the roster groups by STATE and nothing else, so a blocked
  // session can never be the fourth row down behind two repos you are not
  // looking at. ARCHIVED starts collapsed (state-groups' own record).
  const stateNodes = useMemo(() => groupSessionsByState(inScope), [inScope]);
  const [collapsedStates, setCollapsedStates] = useState<ReadonlySet<string>>(loadCollapsedStates);

  // roster-group-tier: the innermost tier, nested inside every state band —
  // paint only, derived per render from the already-registered projects/groups.
  const groupedStateNodes = useMemo(
    () => withGroupTiers(stateNodes, projects, groupRegistry),
    [stateNodes, projects, groupRegistry],
  );
  const [collapsedTiers, setCollapsedTiers] = useState<ReadonlySet<string>>(loadCollapsedTiers);

  // The FLAT painted order — what the keyboard cursor indexes, so ↑/↓ always
  // walks what is actually on screen (a collapsed group's rows are not).
  const visible = useMemo(
    () => flattenStateGroups(groupedStateNodes, collapsedStates, collapsedTiers),
    [groupedStateNodes, collapsedStates, collapsedTiers],
  );

  // 12b: "project becomes a tag, only shown when more than one project is open"
  // — the repo is no longer a heading, so a row only needs to name it when there
  // is more than one to tell apart.
  const projectLabels = useMemo(() => {
    const byId = new Map<string, string>();
    for (const session of inScope) byId.set(session.id, groupKeyFor(session, projects).label);
    return byId;
  }, [inScope, projects]);
  const manyProjects = useMemo(() => new Set(projectLabels.values()).size > 1, [projectLabels]);

  // A live row's elapsed has to move on its own — nothing else re-renders the
  // roster while a turn is quietly streaming. Ticks only while something is
  // actually busy (useElapsedClock is frozen otherwise).
  const anyBusy = useMemo(() => inScope.some((s) => isBusyStatus(s.status)), [inScope]);
  const clock = useElapsedClock(anyBusy);
  // Frozen while nothing is busy, so read the wall clock at render time instead
  // — the roster still re-renders on every session event, which is exactly the
  // cadence the ages had before there was a clock at all.
  const now = anyBusy ? clock : Date.now();

  const toggleState = (key: string) => {
    setCollapsedStates((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      persistCollapsedStates(next);
      return next;
    });
  };

  const toggleTier = (key: string) => {
    setCollapsedTiers((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      persistCollapsedTiers(next);
      return next;
    });
  };

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
    // split-by-4 FR-19: a pick lands in the FOCUSED pane. Assigning a session
    // another pane already holds swaps them — both store actions handle that
    // themselves, so this only has to route.
    if (focusedPaneIndex > 0) assignToFocusedPane(id);
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

  // Both bodies open the same row menu; open-in-vscode FR-10 fetches the editor
  // list on open (memoized in editors.ts — while unresolved the group stays
  // absent, no spinner, no skeleton).
  const openRowMenu = (sessionId: string, x: number, y: number) => {
    setMenu({ sessionId, x, y, confirming: false, error: null, editors: [] });
    void getEditorList().then((editors) => {
      setMenu((m) => (m && m.sessionId === sessionId ? { ...m, editors } : m));
    });
  };

  return (
    // split-session §8: the roster narrows 276 → 238px in split, so its cards go
    // one notch denser to keep the same information on a shorter line.
    <section
      onClick={() => setFocusedPane('sidebar')}
      className={
        [focused ? 'sidebar sidebar--focused' : 'sidebar', panes > 1 ? 'sidebar--dense' : null]
          .filter(Boolean)
          .join(' ')
      }
    >
      {/* header — design 7a: title, a count pill, then the affordances the mock
          puts on the right (search, adopt, new). Sentence-case title, not the
          uppercase pane label: there is no longer a numbered pane grid to key
          it into. */}
      <div className="sidebar__header">
        <span className={focused ? 'sidebar__title sidebar__title--focused' : 'sidebar__title'}>Sessions</span>
        {/* projects FR-27: the count is post-filter — project scope AND '/' query. */}
        <span className="sidebar__count">{inScope.length}</span>
        <span className="app-flex-spacer" />
        <span
          className={sidebarFilter !== null ? 'sidebar__act sidebar__act--on' : 'sidebar__act'}
          title="filter sessions · /"
          onClick={() => {
            setSidebarFilter(sidebarFilter === null ? '' : null);
            setFocusedPane('sidebar');
          }}
        >
          <Search {...ICON} />
        </span>
        {/* cloud-sessions FR-14: the adopt action, beside "new session". Quiet
            next to the accent `+` — adopting is the rarer of the two starts. */}
        <AdoptCloudButton />
        <span
          className="sidebar__act sidebar__act--accent"
          title="new session · n"
          onClick={() => useStore.getState().setNewSessionOpen(true)}
        >
          +
        </span>
      </div>

      {/* filter */}
      {sidebarFilter !== null && <FilterInput value={sidebarFilter} onChange={setSidebarFilter} inputRef={filterRef} />}

      {/* list — one gate, two bodies (design 12b's grouping toggle). */}
      <RosterGate
        hydrationError={fleet.hydrationError}
        onRetry={fleet.retryHydration}
        sessionCount={sessions.length}
        activeProjectId={activeProjectId}
        inProjectCount={inProject.length}
        activeProject={activeProject}
        visibleCount={stateNodes.length}
      >
        <StateRosterBody
          nodes={groupedStateNodes}
          collapsed={collapsedStates}
          onToggle={toggleState}
          collapsedTiers={collapsedTiers}
          onToggleTier={toggleTier}
          home={home}
          now={now}
          cursorIndex={focused ? rowCursor : -1}
          activeSessionId={activeSessionId}
          derived={derived}
          projectLabelOf={(session) => (manyProjects ? (projectLabels.get(session.id) ?? null) : null)}
          projectDefaultModelId={(session) =>
            projects.find((p) => p.id === session.projectId)?.defaults.modelId ?? null
          }
          paneLabelOf={(session) => {
            if (panes <= 1) return null;
            const indices = paneIndicesOf({ activeSessionId, mainTab: 'session', extraPanes }, session.id);
            if (indices.length === 0) return null;
            return {
              label: indices.map((p) => paneBadgeLabel(p, panes)).join('·'),
              accent: indices.some((p) => p > 0),
              focused: indices.includes(focusedPaneIndex),
            };
          }}
          onSelect={(id) => {
            selectSession(id);
            setFocusedPane('sidebar');
          }}
          onContext={openRowMenu}
        />
      </RosterGate>

      {/* footer — the dissolved right column (design 7a), folded onto ONE line
          at 12b: four stacked rows spent ~130px of the pane on two counters that
          usually read '—'. Same four destinations, same keys, one strip. */}
      <div className="sidebar__footer">
        <PaneRows />
      </div>

      {/* context menu */}
      {menu && (
        <SessionContextMenu
          menu={menu}
          sessionName={sessions.find((session) => session.id === menu.sessionId)?.name ?? '?'}
          sessionPath={abbreviate(sessions.find((session) => session.id === menu.sessionId)?.cwd ?? '', home)}
          worktree={sessions.find((session) => session.id === menu.sessionId)?.worktree ?? null}
          containerRef={menuRef}
          // split-by-4 FR-18: hidden for a session already in a pane, at
          // All-projects scope, and once the grid is full. It needs no second
          // session in scope — the row it is on IS the session it opens.
          openInNewPaneLabel={panes === 1 ? 'Open in right pane' : 'Open in new pane'}
          onOpenInNewPane={
            // unbound-panes FR-2: the activeProjectId===null clause is deleted —
            // a full grid is the only thing left that hides this entry.
            panes < MAX_PANES &&
            paneIndicesOf({ activeSessionId, mainTab: 'session', extraPanes }, menu.sessionId).length === 0
              ? (sessionId) => {
                  setMenu(null);
                  openInNewPane(sessionId);
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

/**
 * design 7a, re-set as 12b's one-line strip: Agents / MCP / Skills / Flows.
 * Each carries its own count, published by the panel itself (panelCountsStore)
 * and scoped to the FOCUSED session — the panels stay mounted behind the main
 * pane, so the counts stay live whichever tab is open. Agents additionally goes
 * warm while subagents are actually running: the count is the roster size, so
 * the colour is what carries liveness.
 *
 * A count of zero prints NOTHING and dims the label instead of printing a dash:
 * "no skills configured" is a fact about the destination, not a figure, and the
 * strip has no room to say it twice.
 */
function PaneRows() {
  const mainTab = useStore((s) => s.mainTab);
  const setMainTab = useStore((s) => s.setMainTab);
  const setFocusedPane = useStore((s) => s.setFocusedPane);
  const sessionId = useStore((s) => focusedSessionId(s));
  const counts = useStore((s) => (sessionId ? (s.panelCounts.get(sessionId) ?? EMPTY_PANEL_COUNTS) : EMPTY_PANEL_COUNTS));
  const runningAgents = useStore((s) => (sessionId ? (s.derived.get(sessionId)?.runningAgentCount ?? 0) : 0));

  return (
    <>
      {PANE_ROWS.map((row) => {
        const live = row.pane === 'agents' && runningAgents > 0;
        return (
          <div
            key={row.pane}
            className={
              [
                'roster-pane',
                mainTab === row.pane ? 'roster-pane--on' : null,
                !live && counts[row.pane] === 0 ? 'roster-pane--empty' : null,
              ]
                .filter(Boolean)
                .join(' ')
            }
            title={
              live
                ? `${row.label} · ${runningAgents} running · ${row.key}`
                : counts[row.pane] > 0
                  ? `${row.label} · ${counts[row.pane]} · ${row.key}`
                  : `no ${row.label.toLowerCase()} here · ${row.key}`
            }
            onClick={() => {
              setFocusedPane('main');
              setMainTab(mainTab === row.pane ? 'session' : row.pane);
            }}
          >
            <span className="roster-pane__label">{row.label}</span>
            {(live || counts[row.pane] > 0) && (
              <span className={live ? 'roster-pane__count roster-pane__count--live' : 'roster-pane__count'}>
                {live ? runningAgents : counts[row.pane]}
              </span>
            )}
          </div>
        );
      })}
    </>
  );
}
