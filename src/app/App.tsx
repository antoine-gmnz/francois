import { Fragment, useEffect, useMemo, useState } from 'react';
import AccountsModal from '../features/accounts/AccountsModal';
import { startAccountFeed } from '../features/accounts/accounts';
import AgentsPanel from '../features/agents/AgentsPanel';
import { agentIdFromTab } from '../features/agents/agent-tab';
import McpPanel from '../features/mcp/McpPanel';
import { initNotifications } from '../features/notifications/notifications';
import PaletteRoot from '../features/palette/PaletteView';
import { registerBuiltinCommands } from '../features/palette/paletteCommands';
import PermissionsModal from '../features/permissions/PermissionsModal';
import ProjectsModal from '../features/projects/ProjectsModal';
import NewSessionModal from '../features/sessions/NewSessionModal';
import RenameSessionModal from '../features/sessions/RenameSessionModal';
import Sidebar from '../features/sessions/Sidebar';
import { initShellEvents } from '../features/shell/shellStore';
import SkillsPanel from '../features/skills/SkillsPanel';
import UpdateModal from '../features/update/UpdateModal';
import { checkUpdateOnLaunch } from '../features/update/update';
import UsageBar from '../features/usage/UsageBar';
import WorkflowsPanel from '../features/workflows/WorkflowsPanel';
import { isBusyStatus } from '../../contract/fleet-board';
import { filterSessionsByProject } from '../../contract/projects';
import { appSetWindowTheme, onRemoteEvent } from '../lib/api';
import { focusedSessionId, layoutRegime, paneCount, paneSessionIdAt, paneTabAt } from '../lib/layoutStore';
import { useStore } from '../lib/store';
import './app.css';
import { dividerGridArea, paneGridArea, shellColumns } from './appShell';
import MainPaneBody from './MainPaneBody';
import MainTabStrip from './MainTabStrip';
import RightRail from './RightRail';
import SessionRail from './SessionRail';
import SplitDivider from './SplitDivider';
import SplitPane from './SplitPane';
import StatusBar from './StatusBar';
import { useAppIdentity } from './useAppIdentity';
import { useAppShortcuts } from './useAppShortcuts';
import { useDiffBadge } from './useDiffBadge';

// Register the built-in palette commands once, before first paint (FR-6).
registerBuiltinCommands();

export default function App() {
  const [clockNow, setClockNow] = useState(() => Date.now());
  const sessions = useStore((s) => s.sessions);
  const activeSessionId = useStore((s) => s.activeSessionId);
  const focusedPane = useStore((s) => s.focusedPane);
  const setFocusedPane = useStore((s) => s.setFocusedPane);
  const mainTab = useStore((s) => s.mainTab);
  const setMainTab = useStore((s) => s.setMainTab);
  const theme = useStore((s) => s.theme);
  const toggleTheme = useStore((s) => s.toggleTheme);
  const showLeftPane = useStore((s) => s.showLeftPane);
  const showRightPane = useStore((s) => s.showRightPane);
  const collapsedPanes = useStore((s) => s.collapsedPanes);
  // Tab strip: the session meta cluster folds so a long agent-tab run isn't clipped.
  const showSessionMeta = useStore((s) => s.showSessionMeta);
  const toggleSessionMeta = useStore((s) => s.toggleSessionMeta);
  const newSessionOpen = useStore((s) => s.newSessionOpen);
  const setNewSessionOpen = useStore((s) => s.setNewSessionOpen);
  const newAgentOpen = useStore((s) => s.newAgentOpen);
  const setNewAgentOpen = useStore((s) => s.setNewAgentOpen);
  // session-rename FR-12/FR-14: opened from the sidebar context menu AND the palette.
  const renameSessionId = useStore((s) => s.renameSessionId);
  const setRenameSessionId = useStore((s) => s.setRenameSessionId);
  const activeProjectId = useStore((s) => s.activeProjectId);
  // projects FR-39: a switch into an empty project auto-opens the new-session
  // modal — these two settle what cancelling vs. creating does to the scope.
  const rollbackProjectSwitch = useStore((s) => s.rollbackProjectSwitch);
  const clearProjectSwitchRollback = useStore((s) => s.clearProjectSwitchRollback);
  const permissionsOpen = useStore((s) => s.permissionsOpen);
  const setPermissionsOpen = useStore((s) => s.setPermissionsOpen);
  const projectsOpen = useStore((s) => s.projectsOpen);
  const setProjectsOpen = useStore((s) => s.setProjectsOpen);
  const accountsOpen = useStore((s) => s.accountsOpen);
  const setAccountsOpen = useStore((s) => s.setAccountsOpen);
  const updateModalOpen = useStore((s) => s.updateModalOpen);
  const setUpdateModalOpen = useStore((s) => s.setUpdateModalOpen);
  const setAccounts = useStore((s) => s.setAccounts);
  const upsertSession = useStore((s) => s.upsertSession);
  const setActiveSessionId = useStore((s) => s.setActiveSessionId);
  // agent-tab FR-9: the dynamic per-subagent tabs, after SHELL in the strip.
  const agentTabs = useStore((s) => s.agentTabs);
  const closeAgentTab = useStore((s) => s.closeAgentTab);
  const clearAgentTabs = useStore((s) => s.clearAgentTabs);
  // split-by-4: panes 1..3. `activeSessionId`/`mainTab` are PANE 0's, unchanged —
  // so nothing below this line remounts when focus moves.
  const extraPanes = useStore((s) => s.extraPanes);
  const focusedPaneIndex = useStore((s) => s.focusedPaneIndex);
  const setPaneTab = useStore((s) => s.setPaneTab);
  const setFocusedPaneIndex = useStore((s) => s.setFocusedPaneIndex);
  const assignToFocusedPane = useStore((s) => s.assignToFocusedPane);
  // How the panes share the cell, dragged from the dividers between them: the
  // columns everywhere, the rows in the 2×2 regimes.
  const splitRatio = useStore((s) => s.splitRatio);
  const splitRowRatio = useStore((s) => s.splitRowRatio);
  const unsplit = useStore((s) => s.unsplit);
  const closePane = useStore((s) => s.closePane);
  const panes = paneCount({ extraPanes });
  const regime = layoutRegime(panes);
  const split = regime !== 'single';
  // The three shell tracks + which side is folded to its rail.
  const columns = shellColumns(regime, showLeftPane, showRightPane);
  // FR-13: the session every pane-scoped consumer reads. Equals activeSessionId
  // whenever not split, so each of them is behaviour-identical outside split.
  const paneSessionId = focusedSessionId({ activeSessionId, mainTab, extraPanes, focusedPaneIndex });

  const active = sessions.find((session) => session.id === activeSessionId) ?? null;
  const activeAgentId = agentIdFromTab(mainTab);
  // split-by-4 §8: the status bar's `· <m> sessions open` — the same project
  // scope the roster and the layout toggle count in.
  const inScopeCount = useMemo(
    () => filterSessionsByProject(sessions, activeProjectId).length,
    [sessions, activeProjectId],
  );

  useEffect(() => {
    initShellEvents();
    // notifications FR-5: one app-wide subscription to francois://session/event
    // (idempotent — a second mount effect never double-registers).
    initNotifications();
  }, []);

  // multi-account §6: ONE app-wide registry feed — account_list at boot, then
  // francois://account/event. Everything that shows an account (the ACCOUNT
  // field, the sidebar badge, the status-bar chip, the Accounts modal) reads
  // the store this writes, so no surface ever fetches the registry itself.
  useEffect(() => startAccountFeed(setAccounts), [setAccounts]);

  // self-update FR-7: ONE check when the shell mounts, and it is SILENT on
  // failure — a launch-time network blip must not shout. The helper itself is
  // idempotent per app run, so StrictMode's double mount still checks once.
  useEffect(() => {
    void checkUpdateOnLaunch();
  }, []);

  const { home, appVersion } = useAppIdentity(active?.name);

  // Keep the native caption bar painted to match --bg-app for the active theme
  // (white in light, dark otherwise). Runs on mount and every toggle; no-op off Windows.
  useEffect(() => {
    void appSetWindowTheme(theme).catch(() => {});
  }, [theme]);

  // remote-control: ONE app-wide subscription, not per-session — a host keeps
  // running for a session the user has navigated away from, and `starting` →
  // `active` (the URL landing) must be recorded whichever session is on screen.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let live = true;
    void onRemoteEvent((e) => {
      if (e.type === 'remote.status') {
        useStore.getState().mergeRemote({ sessionId: e.sessionId, state: e.state });
      }
    }).then((unsub) => {
      if (!live) unsub();
      else unlisten = unsub;
    });
    return () => {
      live = false;
      if (unlisten) unlisten();
    };
  }, []);

  // The single-pane strip's DIFF badge — and the palette's view-diff hint, which
  // this hook also feeds, hence the FOCUSED session (FR-7). Equal to
  // activeSessionId outside split, where MainTabStrip is the only reader.
  const diffCount = useDiffBadge(paneSessionId);

  // Elapsed clock ticks while the active session's turn is in flight (FR-6) —
  // isBusyStatus, so it keeps counting while the turn sits on an approval. That
  // wait is part of the turn's wall clock, and freezing it there would read as
  // the turn having finished.
  useEffect(() => {
    // split-session: the elapsed readout lives in MainTabStrip, which the split
    // layout does not render — no reason to tick a clock nothing shows.
    if (split || !(active && isBusyStatus(active.status) && mainTab === 'session')) return;
    const id = setInterval(() => setClockNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active?.id, active?.status, mainTab, split]);

  useAppShortcuts({
    newSessionOpen,
    newAgentOpen,
    permissionsOpen,
    projectsOpen,
    accountsOpen,
    renameOpen: renameSessionId !== null,
    updateModalOpen,
    setNewSessionOpen,
    setNewAgentOpen,
    setFocusedPane,
    setMainTab,
  });

  // overview: widening the board's scope back to "All projects" is a zoom-OUT —
  // there is no longer one project in view, so the main pane goes back to the
  // dashboard instead of whichever session was last selected. Scoping DOWN to a
  // project leaves the tab alone (you may well be mid-conversation), and clicking
  // any session card leaves OVERVIEW again (Sidebar.selectSession). This also
  // covers §7 case 16 — the active project being removed falls back to All.
  useEffect(() => {
    if (activeProjectId === null) {
      // agent-tab FR-14: widening back to All projects closes every agent tab —
      // their agentIds are scoped to whichever session was active, and none of
      // that is still in view once the board zooms out.
      clearAgentTabs();
      // split-session FR-14: and it leaves split — OVERVIEW is a single-pane
      // view, and `▯▯` is disabled at All-projects scope anyway (FR-9).
      unsplit();
      setMainTab('overview'); // last: wins over clearAgentTabs'/unsplit's own fallbacks
    }
  }, [activeProjectId, setMainTab, clearAgentTabs, unsplit]);

  // permission-guardrails: the rules editor needs a session (the local tier is
  // its cwd). If the last session is removed while it is open the modal unmounts
  // without ever calling onClose, so `permissionsOpen` would stay true and keep
  // suppressing the single-letter globals with nothing on screen.
  useEffect(() => {
    if (permissionsOpen && !paneSessionId) setPermissionsOpen(false);
  }, [permissionsOpen, paneSessionId, setPermissionsOpen]);

  const mainFocused = focusedPane === 'main';

  // design-refresh FR-10: what the condensed status bar reads out. Both come
  // from state the shell already holds — no new store slice, no new IPC.
  const activeAgentName = (activeAgentId && agentTabs.find((t) => t.id === activeAgentId)?.name) || null;
  const runningAgents = useStore((s) => (paneSessionId ? (s.derived.get(paneSessionId)?.runningAgentCount ?? 0) : 0));

  const elapsedMs = active
    ? isBusyStatus(active.status)
      ? clockNow - active.startedAt
      : Math.max(0, active.lastActivityAt - active.startedAt)
    : 0;

  return (
    <div className="app-root">
      {/* usage bar / titlebar: app-scoped plan limits + brand cluster, always
          mounted, fixed height, directly under the (same-colored) native
          caption — usage-bar FR-1/FR-2/§8, design-refresh FR-4 */}
      <UsageBar home={home} />
      {/* grid: sidebar + main + agents (native OS title bar provides window chrome) */}
      <div
        className="app-grid"
        style={{
          // columns adapt to the [ / ] toggles; hidden columns keep their panes
          // MOUNTED (display:none) — Sidebar owns the session-cache subscriptions.
          // design-refresh: the mock's `276px | 1fr | 296px` shell columns.
          // split-session FR-2: split pays ~340px for the second pane by
          // narrowing the roster to 238px. Neither column ever disappears —
          // folded is the 46px rail, in every regime (shellColumns).
          gridTemplateColumns: columns.template,
        }}
      >
        {/* The folded roster — split-by-4 FR-6's 46px tile rail, now the fold
            for EVERY regime rather than the grid alone. Rendered BEFORE the
            column so it takes the first track: a `display:none` element
            generates no grid item. */}
        {columns.leftRail && (
          <SessionRail
            onSelect={(id) => {
              if (focusedPaneIndex > 0) assignToFocusedPane(id);
              else setActiveSessionId(id);
            }}
          />
        )}
        <div className="app-col-left" style={{ display: showLeftPane ? undefined : 'none' }}>
          <Sidebar home={home} />
        </div>

        {/* main pane — split-by-4 FR-1/FR-2: one section per pane, in a 1fr row
            at two panes and a 2×2 grid above; otherwise exactly what it renders
            today. Every split regime is resizable: the panes share the cell in
            the ratios their dividers were last dragged to (50/50 by default),
            and each gutter track IS a handle — hence gap: 0 on the modifiers.
            The 2×2 also splits its rows, so it carries a second handle. */}
        {split ? (
          <div
            className={regime === 'grid' ? `app-split-grid app-split-grid--${panes}` : 'app-split-grid app-split-grid--2'}
            style={{
              gridTemplateColumns: `${splitRatio}fr var(--space-12) ${1 - splitRatio}fr`,
              ...(regime === 'grid'
                ? { gridTemplateRows: `${splitRowRatio}fr var(--space-12) ${1 - splitRowRatio}fr` }
                : null),
            }}
          >
            {/* The row handle first, so the column handle — which spans the full
                height at four panes — wins the cell where the two cross. */}
            {regime === 'grid' && <SplitDivider axis="y" area={dividerGridArea('y', panes)} />}
            {Array.from({ length: panes }, (_, i) => (
              <Fragment key={i}>
                {/* Placed explicitly above two panes; at two, DOM order
                    (pane, handle, pane) fills the three tracks by itself. */}
                {i === 1 && <SplitDivider axis="x" area={dividerGridArea('x', panes)} />}
                <SplitPane
                  index={i}
                  area={paneGridArea(i, panes)}
                  sessionId={paneSessionIdAt({ activeSessionId, mainTab, extraPanes }, i)}
                  tab={paneTabAt({ activeSessionId, mainTab, extraPanes }, i)}
                  focused={focusedPaneIndex === i}
                  dense={regime === 'grid'}
                  home={home}
                  onFocus={() => setFocusedPaneIndex(i)}
                  onTab={(t) => setPaneTab(i, t)}
                  // FR-9: a grid pane shows its transcript, so promoting it opens
                  // on SESSION — its remembered DIFF/SHELL tab was never on screen
                  // there, and inheriting it would read as a tab the user never
                  // picked. Review diff is the deliberate way to land on DIFF.
                  onPromote={() => unsplit(i, regime === 'grid' ? 'session' : undefined)}
                  onClose={() => closePane(i)}
                  onReviewDiff={() => unsplit(i, 'diff')}
                />
              </Fragment>
            ))}
          </div>
        ) : (
          <section
            onClick={() => setFocusedPane('main')}
            className="app-main-section"
            style={{ borderColor: mainFocused ? 'var(--border-focus)' : 'var(--border-2)' }}
          >
            <MainTabStrip
              mainTab={mainTab}
              setMainTab={setMainTab}
              diffCount={diffCount}
              agentTabs={agentTabs}
              closeAgentTab={closeAgentTab}
              active={active}
              elapsedMs={elapsedMs}
              showSessionMeta={showSessionMeta}
              toggleSessionMeta={toggleSessionMeta}
            />
            <MainPaneBody mainTab={mainTab} activeAgentId={activeAgentId} active={active} home={home} />
          </section>
        )}

        {/* right column: agents [3] + mcp [4] + skills [5] + workflows [6] —
            collapse-right-column FR-15: a collapsed card's wrapper shrinks to its
            natural header height (flex: 0 0 auto); expanded cards keep their
            1.3/0.95/1.05 ratios and share the freed space. Workflows isn't
            collapsible (out of scope for collapse-right-column). */}
        <div className="app-col-right" style={{ display: showRightPane ? undefined : 'none' }}>
          <div className={collapsedPanes.agents ? 'app-panel-agents app-panel-agents--collapsed' : 'app-panel-agents'}>
            <AgentsPanel key={paneSessionId ?? 'none'} sessionId={paneSessionId} collapsed={collapsedPanes.agents} />
          </div>
          <div className={collapsedPanes.mcp ? 'app-panel-mcp app-panel-mcp--collapsed' : 'app-panel-mcp'}>
            <McpPanel key={paneSessionId ?? 'none'} sessionId={paneSessionId} collapsed={collapsedPanes.mcp} />
          </div>
          <div className={collapsedPanes.skills ? 'app-panel-skills app-panel-skills--collapsed' : 'app-panel-skills'}>
            <SkillsPanel key={paneSessionId ?? 'none'} sessionId={paneSessionId} collapsed={collapsedPanes.skills} />
          </div>
          <div className="app-panel-workflows">
            <WorkflowsPanel key={paneSessionId ?? 'none'} sessionId={paneSessionId} />
          </div>
        </div>

        {/* split-session FR-2: the folded right column. Rendered INSTEAD of the
            column's 296px track (the column itself stays mounted above, hidden),
            so [3]–[6] keep their subscriptions and `]` unfolds them again. Like
            the roster rail, this is now the fold in EVERY regime — the grid used
            to drop the column outright, which left `]` toggling nothing visible. */}
        {columns.rightRail && <RightRail />}
      </div>

      {/* design-refresh FR-10: window chrome, not a grid pane — a full-bleed
          30px strip flush against the window edges, like the titlebar above. */}
      <StatusBar
        theme={theme}
        toggleTheme={toggleTheme}
        focusedPane={focusedPane}
        activeAgentName={activeAgentName}
        runningAgents={runningAgents}
        paneCount={panes}
        sessionCount={inScopeCount}
        appVersion={appVersion}
      />

      {/* projects FR-39: this modal is also what a switch into an EMPTY project
          opens, so cancelling it has to undo that switch. Both handlers are
          no-ops for every other way the modal is opened (`n`, the palette, the
          sidebar button) — nothing is pending then. `onCreated` runs BEFORE the
          modal's own `onClose`, so clearing there is what makes the rollback
          below stand down once a session actually exists. */}
      {newSessionOpen && (
        <NewSessionModal
          onClose={() => {
            setNewSessionOpen(false);
            rollbackProjectSwitch();
          }}
          onCreated={(m) => {
            upsertSession(m);
            // Unconditional, and BEFORE the guard below: standing the rollback
            // down is owed to the session having been created, not to the modal
            // still being open.
            clearProjectSwitchRollback();
            if (!useStore.getState().newSessionOpen) return;
            // split-by-4 FR-19: a new session lands in the FOCUSED pane, like
            // every other "assign a session" path (roster click/⏎, the rail, the
            // palette) — creating one from pane 3 must not silently replace
            // pane 0's session.
            if (focusedPaneIndex > 0) assignToFocusedPane(m.id);
            else setActiveSessionId(m.id);
          }}
        />
      )}

      {/* session-rename FR-8: the rename modal, keyed to the session so a second
          open always restarts from that session's current name. Rendered here
          because both entry points (row context menu, ⌘K) open the same one. */}
      {/* Gated on the id alone, never on the session still existing: a session
          removed while the modal is up must stay renameable-looking until the
          commit answers SESSION_NOT_FOUND (§7), not vanish under the cursor. */}
      {renameSessionId !== null && (
        <RenameSessionModal
          key={renameSessionId}
          sessionId={renameSessionId}
          currentName={sessions.find((s) => s.id === renameSessionId)?.name ?? ''}
          onClose={() => setRenameSessionId(null)}
        />
      )}

      {/* permission-guardrails FR-26: the rules editor. Needs a session (the
          local tier is its cwd), so it closes itself if the session goes away. */}
      {permissionsOpen && paneSessionId && (
        <PermissionsModal sessionId={paneSessionId} onClose={() => setPermissionsOpen(false)} />
      )}

      {/* projects FR-31: the Projects modal. Unlike the permissions editor it
          needs NO session — a project is configured whether or not anything is
          running — so it is gated on `projectsOpen` alone. */}
      {projectsOpen && <ProjectsModal home={home} onClose={() => setProjectsOpen(false)} />}

      {/* multi-account FR-34: the Accounts modal. Like Projects it needs NO
          session — an account is registered whether or not anything is running. */}
      {accountsOpen && <AccountsModal onClose={() => setAccountsOpen(false)} />}

      {/* self-update FR-10: opened by the status-bar chip and by the palette's
          `Check for updates`. Needs no session — it is about the app itself. */}
      {updateModalOpen && <UpdateModal onClose={() => setUpdateModalOpen(false)} />}

      <PaletteRoot />
    </div>
  );
}
