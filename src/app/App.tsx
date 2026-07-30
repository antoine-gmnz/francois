import { useEffect, useState } from 'react';
import AgentsPanel from '../features/agents/AgentsPanel';
import { agentIdFromTab } from '../features/agents/agent-tab';
import McpPanel from '../features/mcp/McpPanel';
import PaletteRoot from '../features/palette/PaletteView';
import { registerBuiltinCommands } from '../features/palette/paletteCommands';
import PermissionsModal from '../features/permissions/PermissionsModal';
import ProjectsModal from '../features/projects/ProjectsModal';
import NewSessionModal from '../features/sessions/NewSessionModal';
import Sidebar from '../features/sessions/Sidebar';
import { initShellEvents, useShellState } from '../features/shell/shellStore';
import SkillsPanel from '../features/skills/SkillsPanel';
import UsageBar from '../features/usage/UsageBar';
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
  const toggleLeftPane = useStore((s) => s.toggleLeftPane);
  const toggleRightPane = useStore((s) => s.toggleRightPane);
  const newSessionOpen = useStore((s) => s.newSessionOpen);
  const setNewSessionOpen = useStore((s) => s.setNewSessionOpen);
  const newAgentOpen = useStore((s) => s.newAgentOpen);
  const setNewAgentOpen = useStore((s) => s.setNewAgentOpen);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const permissionsOpen = useStore((s) => s.permissionsOpen);
  const setPermissionsOpen = useStore((s) => s.setPermissionsOpen);
  const projectsOpen = useStore((s) => s.projectsOpen);
  const setProjectsOpen = useStore((s) => s.setProjectsOpen);
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

  const elapsedMs = active
    ? active.status === 'running'
      ? clockNow - active.startedAt
      : Math.max(0, active.lastActivityAt - active.startedAt)
    : 0;

  return (
    <div className="app-root">
      {/* usage bar: app-scoped plan limits, always mounted, fixed 28px, directly
          under the (same-colored) native caption — usage-bar FR-1/FR-2/§8 */}
      <UsageBar />
      {/* grid: sidebar + main + agents (native OS title bar provides window chrome) */}
      <div
        className="app-grid"
        style={{
          // columns adapt to the [ / ] toggles; hidden columns keep their panes
          // MOUNTED (display:none) — Sidebar owns the session-cache subscriptions.
          gridTemplateColumns: [showLeftPane ? '264px' : null, '1fr', showRightPane ? '336px' : null]
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
          style={{ borderColor: mainFocused ? 'var(--accent)' : 'var(--border)' }}
        >
          <MainTabStrip
            mainTab={mainTab}
            setMainTab={setMainTab}
            diffCount={diffCount}
            agentTabs={agentTabs}
            closeAgentTab={closeAgentTab}
            active={active}
            elapsedMs={elapsedMs}
          />
          <MainPaneBody mainTab={mainTab} activeAgentId={activeAgentId} active={active} home={home} shell={shell} />
        </section>

        {/* right column: agents [3] + mcp [4] + skills [5] */}
        <div className="app-col-right" style={{ display: showRightPane ? undefined : 'none' }}>
          <div className="app-panel-agents">
            <AgentsPanel key={activeSessionId ?? 'none'} sessionId={activeSessionId} />
          </div>
          <div className="app-panel-mcp">
            <McpPanel key={activeSessionId ?? 'none'} sessionId={activeSessionId} />
          </div>
          <div className="app-panel-skills">
            <SkillsPanel key={activeSessionId ?? 'none'} sessionId={activeSessionId} />
          </div>
        </div>

        <StatusBar
          showLeftPane={showLeftPane}
          showRightPane={showRightPane}
          toggleLeftPane={toggleLeftPane}
          toggleRightPane={toggleRightPane}
          theme={theme}
          toggleTheme={toggleTheme}
          focusedPane={focusedPane}
          appVersion={appVersion}
        />
      </div>

      {newSessionOpen && (
        <NewSessionModal
          onClose={() => setNewSessionOpen(false)}
          onCreated={(m) => {
            upsertSession(m);
            if (useStore.getState().newSessionOpen) setActiveSessionId(m.id);
          }}
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

      <PaletteRoot />
    </div>
  );
}
