import { useEffect, useState } from 'react';
import AccountsModal from '../features/accounts/AccountsModal';
import { startAccountFeed } from '../features/accounts/accounts';
import AgentsPanel from '../features/agents/AgentsPanel';
import { agentIdFromTab } from '../features/agents/agent-tab';
import McpPanel from '../features/mcp/McpPanel';
import PaletteRoot from '../features/palette/PaletteView';
import { registerBuiltinCommands } from '../features/palette/paletteCommands';
import PermissionsModal from '../features/permissions/PermissionsModal';
import ProjectsModal from '../features/projects/ProjectsModal';
import NewSessionModal from '../features/sessions/NewSessionModal';
import RenameSessionModal from '../features/sessions/RenameSessionModal';
import Sidebar from '../features/sessions/Sidebar';
import { initShellEvents, useShellState } from '../features/shell/shellStore';
import SkillsPanel from '../features/skills/SkillsPanel';
import UsageBar from '../features/usage/UsageBar';
import WorkflowsPanel from '../features/workflows/WorkflowsPanel';
import { appSetWindowTheme, onRemoteEvent } from '../lib/api';
import { useStore } from '../lib/store';
import './app.css';
import MainPaneBody from './MainPaneBody';
import MainTabStrip from './MainTabStrip';
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
  // Per-session shell state (FR-10/13); '' resolves to the untouched default
  // ShellUiState until a session is active — never spawns a PTY on its own.
  const shell = useShellState(activeSessionId ?? '');
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
  const permissionsOpen = useStore((s) => s.permissionsOpen);
  const setPermissionsOpen = useStore((s) => s.setPermissionsOpen);
  const projectsOpen = useStore((s) => s.projectsOpen);
  const setProjectsOpen = useStore((s) => s.setProjectsOpen);
  const accountsOpen = useStore((s) => s.accountsOpen);
  const setAccountsOpen = useStore((s) => s.setAccountsOpen);
  const setAccounts = useStore((s) => s.setAccounts);
  const upsertSession = useStore((s) => s.upsertSession);
  const setActiveSessionId = useStore((s) => s.setActiveSessionId);
  // agent-tab FR-9: the dynamic per-subagent tabs, after SHELL in the strip.
  const agentTabs = useStore((s) => s.agentTabs);
  const closeAgentTab = useStore((s) => s.closeAgentTab);
  const clearAgentTabs = useStore((s) => s.clearAgentTabs);

  const active = sessions.find((session) => session.id === activeSessionId) ?? null;
  const activeAgentId = agentIdFromTab(mainTab);

  useEffect(() => {
    initShellEvents();
  }, []);

  // multi-account §6: ONE app-wide registry feed — account_list at boot, then
  // francois://account/event. Everything that shows an account (the ACCOUNT
  // field, the sidebar badge, the status-bar chip, the Accounts modal) reads
  // the store this writes, so no surface ever fetches the registry itself.
  useEffect(() => startAccountFeed(setAccounts), [setAccounts]);

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

  const diffCount = useDiffBadge(activeSessionId);

  // Elapsed clock ticks only while the active session is running (FR-6).
  useEffect(() => {
    if (!(active && active.status === 'running' && mainTab === 'session')) return;
    const id = setInterval(() => setClockNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active?.id, active?.status, mainTab]);

  useAppShortcuts({
    newSessionOpen,
    newAgentOpen,
    permissionsOpen,
    projectsOpen,
    accountsOpen,
    renameOpen: renameSessionId !== null,
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
      setMainTab('overview'); // last: wins over clearAgentTabs' own 'session' fallback
    }
  }, [activeProjectId, setMainTab, clearAgentTabs]);

  // permission-guardrails: the rules editor needs a session (the local tier is
  // its cwd). If the last session is removed while it is open the modal unmounts
  // without ever calling onClose, so `permissionsOpen` would stay true and keep
  // suppressing the single-letter globals with nothing on screen.
  useEffect(() => {
    if (permissionsOpen && !activeSessionId) setPermissionsOpen(false);
  }, [permissionsOpen, activeSessionId, setPermissionsOpen]);

  const mainFocused = focusedPane === 'main';

  // design-refresh FR-10: what the condensed status bar reads out. Both come
  // from state the shell already holds — no new store slice, no new IPC.
  const activeAgentName = (activeAgentId && agentTabs.find((t) => t.id === activeAgentId)?.name) || null;
  const runningAgents = useStore((s) => (activeSessionId ? (s.derived.get(activeSessionId)?.runningAgentCount ?? 0) : 0));

  const elapsedMs = active
    ? active.status === 'running'
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
          gridTemplateColumns: [showLeftPane ? '276px' : null, '1fr', showRightPane ? '296px' : null]
            .filter(Boolean)
            .join(' '),
        }}
      >
        <div className="app-col-left" style={{ display: showLeftPane ? undefined : 'none' }}>
          <Sidebar home={home} />
        </div>

        {/* main pane */}
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
          <MainPaneBody mainTab={mainTab} activeAgentId={activeAgentId} active={active} home={home} shell={shell} />
        </section>

        {/* right column: agents [3] + mcp [4] + skills [5] + workflows [6] —
            collapse-right-column FR-15: a collapsed card's wrapper shrinks to its
            natural header height (flex: 0 0 auto); expanded cards keep their
            1.3/0.95/1.05 ratios and share the freed space. Workflows isn't
            collapsible (out of scope for collapse-right-column). */}
        <div className="app-col-right" style={{ display: showRightPane ? undefined : 'none' }}>
          <div className={collapsedPanes.agents ? 'app-panel-agents app-panel-agents--collapsed' : 'app-panel-agents'}>
            <AgentsPanel key={activeSessionId ?? 'none'} sessionId={activeSessionId} collapsed={collapsedPanes.agents} />
          </div>
          <div className={collapsedPanes.mcp ? 'app-panel-mcp app-panel-mcp--collapsed' : 'app-panel-mcp'}>
            <McpPanel key={activeSessionId ?? 'none'} sessionId={activeSessionId} collapsed={collapsedPanes.mcp} />
          </div>
          <div className={collapsedPanes.skills ? 'app-panel-skills app-panel-skills--collapsed' : 'app-panel-skills'}>
            <SkillsPanel key={activeSessionId ?? 'none'} sessionId={activeSessionId} collapsed={collapsedPanes.skills} />
          </div>
          <div className="app-panel-workflows">
            <WorkflowsPanel key={activeSessionId ?? 'none'} sessionId={activeSessionId} />
          </div>
        </div>
      </div>

      {/* design-refresh FR-10: window chrome, not a grid pane — a full-bleed
          30px strip flush against the window edges, like the titlebar above. */}
      <StatusBar
        theme={theme}
        toggleTheme={toggleTheme}
        focusedPane={focusedPane}
        activeAgentName={activeAgentName}
        runningAgents={runningAgents}
        appVersion={appVersion}
      />

      {newSessionOpen && (
        <NewSessionModal
          onClose={() => setNewSessionOpen(false)}
          onCreated={(m) => {
            upsertSession(m);
            if (useStore.getState().newSessionOpen) setActiveSessionId(m.id);
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
      {permissionsOpen && activeSessionId && (
        <PermissionsModal sessionId={activeSessionId} onClose={() => setPermissionsOpen(false)} />
      )}

      {/* projects FR-31: the Projects modal. Unlike the permissions editor it
          needs NO session — a project is configured whether or not anything is
          running — so it is gated on `projectsOpen` alone. */}
      {projectsOpen && <ProjectsModal home={home} onClose={() => setProjectsOpen(false)} />}

      {/* multi-account FR-34: the Accounts modal. Like Projects it needs NO
          session — an account is registered whether or not anything is running. */}
      {accountsOpen && <AccountsModal onClose={() => setAccountsOpen(false)} />}

      <PaletteRoot />
    </div>
  );
}
