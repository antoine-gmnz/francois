import { useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { homeDir } from '@tauri-apps/api/path';
import { getName, getVersion } from '@tauri-apps/api/app';
import ShellTerminal from '../features/shell/ShellTerminal';
import Sidebar from '../features/sessions/Sidebar';
import NewSessionModal from '../features/sessions/NewSessionModal';
import PermissionsModal from '../features/permissions/PermissionsModal';
import ProjectsModal from '../features/projects/ProjectsModal';
import ConversationView from '../features/conversation/ConversationView';
import OverviewView from '../features/overview/OverviewView';
import DiffView from '../features/diff/DiffView';
import AgentsPanel from '../features/agents/AgentsPanel';
import AgentView from '../features/agents/AgentView';
import { agentIdFromTab, agentTabId, agentTabLabel, type AgentTabRef } from '../features/agents/agent-tab';
import McpPanel from '../features/mcp/McpPanel';
import SkillsPanel from '../features/skills/SkillsPanel';
import UsageBar from '../features/usage/UsageBar';
import { initShellEvents, useShellState } from '../features/shell/shellStore';
import { useStore } from '../lib/store';
import { abbreviate } from '../lib/path';
import { formatContextTokens, formatElapsed } from '../../contract/conversation-view';
import { displayWslCwd } from '../../contract/wsl-filesystem';
import { appSetWindowTheme, diffGetSummary, onDiffEvent, onRemoteEvent } from '../lib/api';
import { RemoteControlBadge } from '../features/remote/RemoteControlBadge';
import PaletteRoot from '../features/palette/PaletteView';
import { dismissPalette, isPaletteOpen, togglePalette } from '../features/palette/palette';
import { setPaletteDiffCount } from '../features/palette/paletteData';
import { registerBuiltinCommands } from '../features/palette/paletteCommands';
import { EmptyPane } from '../ui/EmptyPane';
import { StatusDot } from '../ui/StatusDot';
import { BadgePill } from '../ui/BadgePill';
import './app.css';

// Register the built-in palette commands once, before first paint (FR-6).
registerBuiltinCommands();

// Shell footer path (spec §8): WSL cwds render as '<distro>:/path'; when the
// shell name already names that distro (FR-12), drop the redundant prefix so
// the footer doesn't repeat it — '● Ubuntu · /home/u/api', not '· Ubuntu:/…'.
function shellFooterPath(cwd: string, shellName: string, home: string): string {
  const wsl = displayWslCwd(cwd);
  if (!wsl) return abbreviate(cwd, home);
  const prefix = `${shellName}:`;
  return wsl.startsWith(prefix) ? wsl.slice(prefix.length) : wsl;
}

// Main tab-strip label (OVERVIEW/SESSION/DIFF/SHELL): the `app-tab--on`
// modifier recolors to the accent when it is the active main tab.
function tabClassName(active: boolean): string {
  return active ? 'app-tab app-tab--on' : 'app-tab';
}

export default function App() {
  const [home, setHome] = useState('');
  const [clockNow, setClockNow] = useState(() => Date.now());
  const [diffCount, setDiffCount] = useState(0);
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
    void homeDir()
      .then((h) => setHome(h.replace(/[\\/]$/, '')))
      .catch(() => {});
  }, []);

  // Keep the native window title in sync with the active session, "<session> — <app>"
  // (document-first, so the taskbar and alt-tab show the session, not a constant
  // prefix). The app name comes from the bundle so the dev channel stays "Francois Dev".
  const [appName, setAppName] = useState('Francois');
  // Status-bar version — read from the bundle (tauri.conf.json), never hardcoded, so a
  // release bumps it on its own. Empty until it resolves, so no stale number ever flashes.
  const [appVersion, setAppVersion] = useState('');
  useEffect(() => {
    void getName()
      .then(setAppName)
      .catch(() => {});
    void getVersion()
      .then(setAppVersion)
      .catch(() => {});
  }, []);
  useEffect(() => {
    void getCurrentWindow()
      .setTitle(active ? `${active.name} — ${appName}` : appName)
      .catch(() => {});
  }, [active?.name, appName]);

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

  // DIFF-tab badge: fileCount for the active session, seeded by getSummary and
  // kept current by diff.changed events (diff-view FR-18).
  useEffect(() => {
    setDiffCount(0);
    setPaletteDiffCount(0); // keep the palette's view-diff hint at 0 with no active session (FR-21/§7)
    if (!activeSessionId) return;
    const mounted = { current: true };
    let unlisten: (() => void) | undefined;
    void diffGetSummary(activeSessionId).then((res) => {
      if (mounted.current && res.ok) {
        setDiffCount(res.data.files.length);
        setPaletteDiffCount(res.data.files.length);
      }
    });
    void onDiffEvent((e) => {
      if (e.type === 'diff.changed' && e.sessionId === activeSessionId && mounted.current) {
        setDiffCount(e.fileCount);
        setPaletteDiffCount(e.fileCount);
      }
    }).then((unsub) => {
      if (!mounted.current) unsub();
      else unlisten = unsub;
    });
    return () => {
      mounted.current = false;
      if (unlisten) unlisten();
    };
  }, [activeSessionId]);

  // Elapsed clock ticks only while the active session is running (FR-6).
  useEffect(() => {
    if (!(active && active.status === 'running' && mainTab === 'session')) return;
    const id = setInterval(() => setClockNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active?.id, active?.status, mainTab]);

  // app-shell owns ⌘K/Ctrl+K (togglePalette) and Escape-while-open (dismiss) via a
  // single capture-phase listener so they fire from any focus, including the terminal
  // (command-palette FR-1/FR-3). No competing listener lives in command-palette.
  useEffect(() => {
    const onKeyCapture = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        e.stopPropagation();
        togglePalette();
      } else if (e.key === 'Escape' && isPaletteOpen()) {
        e.preventDefault();
        e.stopPropagation();
        dismissPalette();
      }
    };
    window.addEventListener('keydown', onKeyCapture, true);
    return () => window.removeEventListener('keydown', onKeyCapture, true);
  }, []);

  // Minimal app-shell global keys: n (new session), 1/2 (pane focus), t (shell tab).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const activeEl = document.activeElement as HTMLElement | null;
      const inInput = !!activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.tagName === 'SELECT');
      const inTerminal = !!activeEl && activeEl.closest('.xterm') !== null;
      // permission-guardrails FR-29 / projects FR-37: an open editor suppresses the
      // single-letter globals too, exactly like the other modals.
      if (newSessionOpen || newAgentOpen || permissionsOpen || projectsOpen || inInput || inTerminal) return;
      if (e.key === 'n' || e.key === 'N') {
        e.preventDefault();
        setNewSessionOpen(true);
      } else if (e.key === 'a' || e.key === 'A') {
        if (useStore.getState().activeSessionId) {
          e.preventDefault();
          setFocusedPane('agents');
          setNewAgentOpen(true);
        }
      } else if (e.key === '1') {
        setFocusedPane('sidebar');
      } else if (e.key === '2') {
        setFocusedPane('main');
      } else if (e.key === '3') {
        setFocusedPane('agents');
      } else if (e.key === '4') {
        setFocusedPane('mcp');
      } else if (e.key === '5') {
        setFocusedPane('skills');
      } else if (e.key === 'd' || e.key === 'D') {
        // toggle diff↔session, identical to command-palette's view-diff.run (FR-23/FR-29)
        setFocusedPane('main');
        setMainTab(useStore.getState().mainTab === 'diff' ? 'session' : 'diff');
      } else if (e.key === 't' || e.key === 'T') {
        setFocusedPane('main');
        setMainTab(useStore.getState().mainTab === 'shell' ? 'session' : 'shell');
      } else if (e.key === 'o' || e.key === 'O') {
        // overview: same toggle grammar as d/t — press again to fall back to the
        // conversation you came from.
        setFocusedPane('main');
        setMainTab(useStore.getState().mainTab === 'overview' ? 'session' : 'overview');
      } else if (e.key === 'w' || e.key === 'W') {
        // agent-tab FR-15: close the active agent tab (SESSION takes over). A
        // no-op on the built-in tabs — nothing else in the strip is closable.
        const st = useStore.getState();
        const agentId = agentIdFromTab(st.mainTab);
        if (agentId !== null) {
          e.preventDefault();
          st.closeAgentTab(agentId);
        }
      } else if (e.key === '[') {
        useStore.getState().toggleLeftPane();
      } else if (e.key === ']') {
        useStore.getState().toggleRightPane();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [newSessionOpen, newAgentOpen, permissionsOpen, projectsOpen, setNewSessionOpen, setNewAgentOpen, setFocusedPane, setMainTab]);

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
          {/* tab strip + meta cluster */}
          <div className="app-tabstrip">
            {/* §8: the strip scrolls horizontally past overflow rather than
                clipping or squeezing tabs; it shrinks before the right-aligned
                session meta cluster does. */}
            <div className="app-tabstrip-left scz">
              {/* overview: the cross-project dashboard. First in the strip because
                  it is the zoomed-OUT view — the tabs read left-to-right from the
                  whole fleet down to one session's files. */}
              <span onClick={() => setMainTab('overview')} className={tabClassName(mainTab === 'overview')}>
                OVERVIEW
              </span>
              <span onClick={() => setMainTab('session')} className={tabClassName(mainTab === 'session')}>
                SESSION
              </span>
              <span onClick={() => setMainTab('diff')} className={`${tabClassName(mainTab === 'diff')} app-tab--diff`}>
                DIFF
                {diffCount > 0 && <BadgePill>{diffCount}</BadgePill>}
              </span>
              <span onClick={() => setMainTab('shell')} className={tabClassName(mainTab === 'shell')}>
                SHELL
              </span>
              {/* agent-tab FR-9/FR-12: one tab per clicked subagent, in open
                  order. Lower-case and un-tracked on purpose — an agent name is
                  content, not a chrome label. */}
              {agentTabs.map((t) => (
                <AgentTabChip
                  key={t.id}
                  tab={t}
                  active={mainTab === agentTabId(t.id)}
                  onOpen={() => setMainTab(agentTabId(t.id) as typeof mainTab)}
                  onClose={() => closeAgentTab(t.id)}
                />
              ))}
            </div>
            {mainTab === 'session' && active && (
              <div className="app-meta-cluster">
                <span>{active.model.label}</span>
                {active.permissionMode !== 'default' && (
                  <span
                    title={`permission mode: ${active.permissionMode}`}
                    className={active.permissionMode === 'bypassPermissions' ? 'app-text-error' : 'app-text-faint'}
                  >
                    {active.permissionMode === 'acceptEdits' ? 'edits-ok' : active.permissionMode === 'bypassPermissions' ? 'bypass' : 'plan'}
                  </span>
                )}
                {active.runtime === 'wsl' && <span className="app-text-faint">wsl</span>}
                {/* remote-control: host this session on claude.ai/code + mobile */}
                <RemoteControlBadge key={active.id} sessionId={active.id} />
                <span>
                  <span className="app-text-faint">ctx </span>
                  <span className="app-text-bright">{formatContextTokens(active.contextUsedTokens)}</span>
                  <span className="app-text-faint">/{formatContextTokens(active.contextLimitTokens)}</span>
                </span>
                <span className="app-text-faint">{formatElapsed(elapsedMs)}</span>
              </div>
            )}
          </div>

          {/* body */}
          {mainTab === 'overview' ? (
            <OverviewView home={home} />
          ) : mainTab === 'session' ? (
            active ? (
              <ConversationView key={active.id} sessionId={active.id} />
            ) : (
              <EmptyPane>
                select a session, or press <span className="app-inline-key">n</span> to start one
              </EmptyPane>
            )
          ) : mainTab === 'diff' ? (
            active ? (
              <DiffView key={active.id} sessionId={active.id} />
            ) : (
              <EmptyPane>select a session to review its changes</EmptyPane>
            )
          ) : activeAgentId !== null ? (
            // agent-tab: one subagent's own conversation. Keyed by agent so
            // switching tabs remounts rather than leaking the previous state.
            // The session is always present here (FR-14 closes agent tabs when it
            // changes) — the fallback only guards a dangling id.
            active ? (
              <AgentView key={activeAgentId} agentId={activeAgentId} sessionId={active.id} />
            ) : (
              <EmptyPane>select a session</EmptyPane>
            )
          ) : active ? (
            <div className="app-shell-view">
              <div className="app-shell-terminal-wrap">
                <ShellTerminal key={active.id} sessionId={active.id} />
              </div>
              <div className="app-shell-footer">
                <StatusDot color={shell.alive ? 'var(--success)' : 'var(--error)'} size={7} />
                <span>
                  {shell.shellName || 'shell'}
                  {shell.cwd && (
                    <>
                      {' '}
                      <span className="app-text-faint">·</span> {shellFooterPath(shell.cwd, shell.shellName, home)}
                    </>
                  )}
                </span>
                <span className="app-flex-spacer" />
                <span>
                  <span className="app-text-hint">⌃C</span> interrupt
                </span>
                <span>
                  <span className="app-text-hint">⌃L</span> clear
                </span>
              </div>
            </div>
          ) : (
            <EmptyPane>select a session to open its shell</EmptyPane>
          )}
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

        {/* status bar */}
        <div className="app-status-bar">
          <span className="app-text-dim">
            <span className="app-text-accent">1-5</span> switch pane
          </span>
          <span>
            <span className="app-text-hint">↑↓</span> nav
          </span>
          <span>
            <span className="app-text-hint">⏎</span> send
          </span>
          <span>
            <span className="app-text-accent">o</span> overview
          </span>
          <span>
            <span className="app-text-accent">d</span> diff
          </span>
          <span>
            <span className="app-text-accent">t</span> shell
          </span>
          <span onClick={toggleLeftPane} className="app-clickable" title="toggle sessions column">
            <span className="app-text-accent">[</span>{' '}
            <span className={showLeftPane ? 'app-pane-label' : 'app-pane-label app-pane-label--off'}>sessions</span>
          </span>
          <span onClick={toggleRightPane} className="app-clickable" title="toggle side panels">
            <span className="app-text-accent">]</span>{' '}
            <span className={showRightPane ? 'app-pane-label' : 'app-pane-label app-pane-label--off'}>panels</span>
          </span>
          <span>
            <span className="app-text-accent">n</span> new session
          </span>
          <span onClick={() => togglePalette()} className="app-clickable">
            <span className="app-text-accent">⌘K</span> commands
          </span>
          <span className="app-flex-spacer" />
          <span
            onClick={toggleTheme}
            className="app-clickable app-text-dim"
            title={theme === 'dark' ? 'switch to light theme' : 'switch to dark theme'}
          >
            <span className="app-text-accent">{theme === 'dark' ? '☾' : '☀'}</span> {theme}
          </span>
          <span>
            focus: <span className="app-text-accent">{focusedPane}</span>
          </span>
          <span className="app-text-faint">francois{appVersion && ` ${appVersion}`}</span>
        </div>
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

/**
 * agent-tab FR-12 / §8: one agent tab in the strip — status dot, `⇉`, the
 * truncated agent name, and a `✕` that appears on hover. Not upper-cased or
 * letter-spaced like the built-in tabs: this is content, not chrome.
 */
function AgentTabChip({
  tab,
  active,
  onOpen,
  onClose,
}: {
  tab: AgentTabRef;
  active: boolean;
  onOpen: () => void;
  onClose: () => void;
}) {
  const [hover, setHover] = useState(false);
  const statusColor =
    tab.status === 'running'
      ? 'var(--accent-2)'
      : tab.status === 'done'
        ? 'var(--success)'
        : tab.status === 'error'
          ? 'var(--error)'
          : 'var(--text-muted)';
  return (
    <span
      onClick={onOpen}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={tab.name}
      className={active ? 'app-tab-chip app-tab-chip--active' : 'app-tab-chip'}
    >
      <StatusDot color={statusColor} size={6} pulsing={tab.status === 'running'} />
      <span className="app-tab-chip-glyph">⇉</span>
      <span className="truncate">{agentTabLabel(tab.name)}</span>
      {hover && (
        <span
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          title="close tab"
          className="app-tab-chip-close"
        >
          ✕
        </span>
      )}
    </span>
  );
}
