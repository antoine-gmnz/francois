import { useEffect, useMemo, useState } from 'react';
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
import PluginPane from '../features/plugins/PluginPane';
import PluginsModal from '../features/plugins/PluginsModal';
import { startPlugins } from '../features/plugins/plugin-events';
import { usePluginsStore } from '../features/plugins/pluginsStore';
import PluginTab from '../features/plugins/PluginTab';
import {
  isTabStillVisible,
  pluginPaneHotkeys,
  pluginPanes,
  pluginTabs,
  tabTitle,
  toneColor,
  visibleStatusItems,
} from '../features/plugins/plugins';
import { pluginIdOfTab, pluginTabId } from '../../contract/plugin-system';
import UsageBar from '../features/usage/UsageBar';
import { initShellEvents, useShellState } from '../features/shell/shellStore';
import { useStore } from '../lib/store';
import { formatContextTokens, formatElapsed } from '../../contract/conversation-view';
import { displayWslCwd } from '../../contract/wsl-filesystem';
import { appSetWindowTheme, diffGetSummary, onDiffEvent, onRemoteEvent, pluginsInvokeCommand } from '../lib/api';
import { RemoteControlBadge } from '../features/remote/RemoteControlBadge';
import PaletteRoot from '../features/palette/PaletteView';
import { dismissPalette, isPaletteOpen, togglePalette } from '../features/palette/palette';
import { setPaletteDiffCount } from '../features/palette/paletteData';
import { registerBuiltinCommands } from '../features/palette/paletteCommands';

// Register the built-in palette commands once, before first paint (FR-6).
registerBuiltinCommands();

const C = {
  accent: 'var(--accent)',
  dim: 'var(--text-dim)',
  faint: 'var(--text-faint)',
  primary: 'var(--text)',
  bright: 'var(--text-bright)',
  hint: 'var(--text-hint)',
  running: 'var(--accent-2)',
  idle: 'var(--text-muted)',
  done: 'var(--success)',
  error: 'var(--error)',
};

function abbreviate(cwd: string, home: string): string {
  if (!cwd) return '';
  if (home && (cwd === home || cwd.startsWith(home + '/') || cwd.startsWith(home + '\\'))) {
    return '~' + cwd.slice(home.length);
  }
  return cwd;
}

// Shell footer path (spec §8): WSL cwds render as '<distro>:/path'; when the
// shell name already names that distro (FR-12), drop the redundant prefix so
// the footer doesn't repeat it — '● Ubuntu · /home/u/api', not '· Ubuntu:/…'.
function shellFooterPath(cwd: string, shellName: string, home: string): string {
  const wsl = displayWslCwd(cwd);
  if (!wsl) return abbreviate(cwd, home);
  const prefix = `${shellName}:`;
  return wsl.startsWith(prefix) ? wsl.slice(prefix.length) : wsl;
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
  // plugin-system FR-76: the visible set is a function of the registry AND the
  // sidebar's project filter, so switching the filter adds/removes panes,
  // hotkeys and status items in one re-render.
  const installedPlugins = usePluginsStore((s) => s.plugins);
  const pluginStatusItems = usePluginsStore((s) => s.statusItems);
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
  // FR-46/FR-47: visible panes in registry order; the first four get 6–9.
  const visiblePluginPanes = useMemo(
    () => pluginPanes(installedPlugins, activeProjectId),
    [installedPlugins, activeProjectId],
  );
  const pluginHotkeys = useMemo(() => pluginPaneHotkeys(visiblePluginPanes), [visiblePluginPanes]);
  // FR-81: tabs follow the same enablement + registry order as panes.
  const visiblePluginTabs = useMemo(
    () => pluginTabs(installedPlugins, activeProjectId),
    [installedPlugins, activeProjectId],
  );
  // FR-49: at most three, right-aligned, in registry order.
  const pluginBarItems = useMemo(
    () => visibleStatusItems(installedPlugins, activeProjectId, pluginStatusItems),
    [installedPlugins, activeProjectId, pluginStatusItems],
  );
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

  const active = sessions.find((s) => s.id === activeSessionId) ?? null;
  const activeAgentId = agentIdFromTab(mainTab);

  useEffect(() => {
    initShellEvents();
    // plugin-system FR-69/FR-80: subscribe to the registry stream and load it
    // once. The registry is app-scoped, not session-scoped, so this runs once
    // for the app's lifetime rather than per session.
    let stopPlugins: (() => void) | null = null;
    void startPlugins().then((stop) => {
      stopPlugins = stop;
    });
    void homeDir()
      .then((h) => setHome(h.replace(/[\\/]$/, '')))
      .catch(() => {});
    return () => stopPlugins?.();
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
    }).then((u) => {
      if (!live) u();
      else unlisten = u;
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
    }).then((u) => {
      if (!mounted.current) u();
      else unlisten = u;
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
      const ae = document.activeElement as HTMLElement | null;
      const inInput = !!ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT');
      const inTerminal = !!ae && ae.closest('.xterm') !== null;
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
      } else if (e.key >= '6' && e.key <= '9') {
        // FR-47: 6–9 target the 1st–4th VISIBLE plugin panes. A key with no
        // corresponding pane is a no-op, never a focus change to nothing.
        const pane = visiblePluginPanes[Number(e.key) - 6];
        if (pane) setFocusedPane(`plugin:${pane.manifest.id}`);
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

  // FR-81: a plugin tab can vanish under the user — the plugin is disabled,
  // uninstalled, or scoped out by the project filter. Without this the main
  // pane would render nothing at all, with no tab selected to get back from.
  useEffect(() => {
    if (!isTabStillVisible(mainTab, visiblePluginTabs)) setMainTab('session');
  }, [mainTab, visiblePluginTabs, setMainTab]);

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

  const tabStyle = (on: boolean): React.CSSProperties => ({
    fontSize: 11,
    letterSpacing: '0.14em',
    fontWeight: 700,
    cursor: 'pointer',
    padding: '2px 0',
    color: on ? C.accent : C.dim,
    borderBottom: `2px solid ${on ? C.accent : 'transparent'}`,
  });

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--bg-app)' }}>
      {/* usage bar: app-scoped plan limits, always mounted, fixed 28px, directly
          under the (same-colored) native caption — usage-bar FR-1/FR-2/§8 */}
      <UsageBar />
      {/* grid: sidebar + main + agents (native OS title bar provides window chrome) */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: 'grid',
          // columns adapt to the [ / ] toggles; hidden columns keep their panes
          // MOUNTED (display:none) — Sidebar owns the session-cache subscriptions.
          gridTemplateColumns: [showLeftPane ? '264px' : null, '1fr', showRightPane ? '336px' : null]
            .filter(Boolean)
            .join(' '),
          gridTemplateRows: '1fr 32px',
          gap: 10,
          padding: 10,
        }}
      >
        <div style={{ gridRow: 1, minHeight: 0, display: showLeftPane ? undefined : 'none' }}>
          <Sidebar home={home} />
        </div>

        {/* main pane */}
        <section
          onClick={() => setFocusedPane('main')}
          style={{
            gridRow: 1,
            display: 'flex',
            flexDirection: 'column',
            background: 'var(--bg-deep)',
            border: `1px solid ${mainFocused ? C.accent : 'var(--border)'}`,
            borderRadius: 5,
            overflow: 'hidden',
            minHeight: 0,
          }}
        >
          {/* tab strip + meta cluster */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '9px 14px',
              borderBottom: '1px solid var(--border)',
              flexShrink: 0,
            }}
          >
            {/* §8: the strip scrolls horizontally past overflow rather than
                clipping or squeezing tabs; it shrinks before the right-aligned
                session meta cluster does. */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 16,
                overflowX: 'auto',
                flexShrink: 1,
                minWidth: 0,
              }}
              className="scz"
            >
              {/* overview: the cross-project dashboard. First in the strip because
                  it is the zoomed-OUT view — the tabs read left-to-right from the
                  whole fleet down to one session's files. */}
              <span onClick={() => setMainTab('overview')} style={tabStyle(mainTab === 'overview')}>
                OVERVIEW
              </span>
              <span onClick={() => setMainTab('session')} style={tabStyle(mainTab === 'session')}>
                SESSION
              </span>
              <span onClick={() => setMainTab('diff')} style={{ ...tabStyle(mainTab === 'diff'), display: 'flex', alignItems: 'center', gap: 6 }}>
                DIFF
                {diffCount > 0 && (
                  <span style={{ background: 'var(--bg-hover)', color: 'var(--text-hint)', fontSize: 9, padding: '1px 5px', borderRadius: 8, fontWeight: 500, letterSpacing: 0 }}>
                    {diffCount}
                  </span>
                )}
              </span>
              <span onClick={() => setMainTab('shell')} style={tabStyle(mainTab === 'shell')}>
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
              {/* FR-81: plugin tabs APPEND after the static spine, in registry
                  order. The title is the plugin's only say in the strip — it is
                  uppercased and truncated like a pane title, and rendered as a
                  text child, never as an attribute. */}
              {visiblePluginTabs.map((p) => {
                const id = pluginTabId(p.manifest.id);
                return (
                  <span key={id} onClick={() => setMainTab(id)} style={tabStyle(mainTab === id)}>
                    {tabTitle(p.manifest.contributes.tab?.title ?? p.manifest.name)}
                  </span>
                );
              })}
            </div>
            {mainTab === 'session' && active && (
              <div style={{ display: 'flex', gap: 14, fontSize: 10.5, color: C.dim, alignItems: 'center' }}>
                <span>{active.model.label}</span>
                {active.permissionMode !== 'default' && (
                  <span
                    title={`permission mode: ${active.permissionMode}`}
                    style={{ color: active.permissionMode === 'bypassPermissions' ? C.error : C.faint }}
                  >
                    {active.permissionMode === 'acceptEdits' ? 'edits-ok' : active.permissionMode === 'bypassPermissions' ? 'bypass' : 'plan'}
                  </span>
                )}
                {active.runtime === 'wsl' && <span style={{ color: C.faint }}>wsl</span>}
                {/* remote-control: host this session on claude.ai/code + mobile */}
                <RemoteControlBadge key={active.id} sessionId={active.id} />
                <span>
                  <span style={{ color: C.faint }}>ctx </span>
                  <span style={{ color: C.bright }}>{formatContextTokens(active.contextUsedTokens)}</span>
                  <span style={{ color: C.faint }}>/{formatContextTokens(active.contextLimitTokens)}</span>
                </span>
                <span style={{ color: C.faint }}>{formatElapsed(elapsedMs)}</span>
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
              <div
                style={{
                  flex: 1,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 12.5,
                  color: C.faint,
                }}
              >
                select a session, or press <span style={{ color: C.accent, margin: '0 4px' }}>n</span> to start one
              </div>
            )
          ) : mainTab === 'diff' ? (
            active ? (
              <DiffView key={active.id} sessionId={active.id} />
            ) : (
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12.5, color: C.faint }}>
                select a session to review its changes
              </div>
            )
          ) : activeAgentId !== null ? (
            // agent-tab: one subagent's own conversation. Keyed by agent so
            // switching tabs remounts rather than leaking the previous state.
            // The session is always present here (FR-14 closes agent tabs when it
            // changes) — the fallback only guards a dangling id.
            active ? (
              <AgentView key={activeAgentId} agentId={activeAgentId} sessionId={active.id} />
            ) : (
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12.5, color: C.faint }}>
                select a session
              </div>
            )
          ) : pluginIdOfTab(mainTab) ? (
            // FR-81. `visiblePluginTabs.find` rather than a lookup by id alone:
            // the tab must not render for a plugin the current project filter
            // hides, and the guard below already sends focus back if so.
            (() => {
              const p = visiblePluginTabs.find((x) => x.manifest.id === pluginIdOfTab(mainTab));
              return p ? (
                <PluginTab
                  key={p.manifest.id}
                  plugin={p}
                  projectId={activeProjectId}
                  sessionId={activeSessionId}
                />
              ) : null;
            })()
          ) : active ? (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, background: 'var(--bg-app)' }}>
              <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
                <ShellTerminal key={active.id} sessionId={active.id} />
              </div>
              <div
                style={{
                  padding: '10px 14px',
                  borderTop: '1px solid var(--border)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 14,
                  fontSize: 11,
                  color: 'var(--text-muted)',
                  background: 'var(--bg-app)',
                  flexShrink: 0,
                }}
              >
                <span
                  style={{ width: 7, height: 7, borderRadius: '50%', background: shell.alive ? C.done : C.error, display: 'block', flexShrink: 0 }}
                />
                <span>
                  {shell.shellName || 'shell'}
                  {shell.cwd && (
                    <>
                      {' '}
                      <span style={{ color: C.faint }}>·</span> {shellFooterPath(shell.cwd, shell.shellName, home)}
                    </>
                  )}
                </span>
                <span style={{ flex: 1 }} />
                <span>
                  <span style={{ color: C.hint }}>⌃C</span> interrupt
                </span>
                <span>
                  <span style={{ color: C.hint }}>⌃L</span> clear
                </span>
              </div>
            </div>
          ) : (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12.5, color: C.faint }}>
              select a session to open its shell
            </div>
          )}
        </section>

        {/* right column: agents [3] + mcp [4] + skills [5] */}
        <div style={{ gridRow: 1, minHeight: 0, display: showRightPane ? 'flex' : 'none', flexDirection: 'column', gap: 10 }}>
          <div style={{ flex: 1.3, minHeight: 0 }}>
            <AgentsPanel key={activeSessionId ?? 'none'} sessionId={activeSessionId} />
          </div>
          <div style={{ flex: 0.95, minHeight: 0 }}>
            <McpPanel key={activeSessionId ?? 'none'} sessionId={activeSessionId} />
          </div>
          <div style={{ flex: 1.05, minHeight: 0 }}>
            <SkillsPanel key={activeSessionId ?? 'none'} sessionId={activeSessionId} />
          </div>
          {/* FR-46: plugin panes append BELOW skills, in registry order. */}
          {visiblePluginPanes.map((p) => (
            <div key={p.manifest.id} style={{ flex: 1, minHeight: 0 }}>
              <PluginPane
                plugin={p}
                hotkey={pluginHotkeys[`plugin:${p.manifest.id}`] ?? null}
                projectId={activeProjectId}
                sessionId={activeSessionId}
              />
            </div>
          ))}
        </div>

        {/* status bar */}
        <div
          style={{
            gridColumn: '1 / -1',
            gridRow: 2,
            display: 'flex',
            alignItems: 'center',
            gap: 16,
            padding: '0 12px',
            background: 'var(--bg-deep)',
            border: '1px solid var(--border)',
            borderRadius: 5,
            fontSize: 10.5,
            color: 'var(--text-muted)',
          }}
        >
          <span style={{ color: C.dim }}>
            <span style={{ color: C.accent }}>1-5</span> switch pane
          </span>
          <span>
            <span style={{ color: C.hint }}>↑↓</span> nav
          </span>
          <span>
            <span style={{ color: C.hint }}>⏎</span> send
          </span>
          <span>
            <span style={{ color: C.accent }}>o</span> overview
          </span>
          <span>
            <span style={{ color: C.accent }}>d</span> diff
          </span>
          <span>
            <span style={{ color: C.accent }}>t</span> shell
          </span>
          <span onClick={toggleLeftPane} style={{ cursor: 'pointer' }} title="toggle sessions column">
            <span style={{ color: C.accent }}>[</span> <span style={{ opacity: showLeftPane ? 1 : 0.5 }}>sessions</span>
          </span>
          <span onClick={toggleRightPane} style={{ cursor: 'pointer' }} title="toggle side panels">
            <span style={{ color: C.accent }}>]</span> <span style={{ opacity: showRightPane ? 1 : 0.5 }}>panels</span>
          </span>
          <span>
            <span style={{ color: C.accent }}>n</span> new session
          </span>
          <span onClick={() => togglePalette()} style={{ cursor: 'pointer' }}>
            <span style={{ color: C.accent }}>⌘K</span> commands
          </span>
          <span style={{ flex: 1 }} />
          <span
            onClick={toggleTheme}
            style={{ cursor: 'pointer', color: C.dim }}
            title={theme === 'dark' ? 'switch to light theme' : 'switch to dark theme'}
          >
            <span style={{ color: C.accent }}>{theme === 'dark' ? '☾' : '☀'}</span> {theme}
          </span>
          <span>
            focus: <span style={{ color: C.accent }}>{focusedPane}</span>
          </span>
          {/* plugin-system FR-49: plugin status items, right-aligned, LEFT of
              the version string, in registry order. `visibleStatusItems` already
              caps them at three and drops the rest silently. Tone is the only
              thing the plugin decides; every size and space here is ours. */}
          {pluginBarItems.map(({ pluginId, item }) => (
            <span
              key={pluginId}
              role={item.commandId ? 'button' : undefined}
              onClick={() => {
                if (item.commandId) {
                  void pluginsInvokeCommand({
                    pluginId,
                    commandId: item.commandId,
                    projectId: activeProjectId,
                    sessionId: activeSessionId,
                  });
                }
              }}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                fontSize: 10.5,
                letterSpacing: '0.02em',
                color: item.tone ? toneColor(item.tone) : C.dim,
                cursor: item.commandId ? 'pointer' : 'default',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                maxWidth: 180,
              }}
            >
              {item.badge && (
                <span
                  style={{
                    fontSize: 9.5,
                    padding: '0 5px',
                    border: '1px solid var(--border-2)',
                    borderRadius: 3,
                  }}
                >
                  {item.badge}
                </span>
              )}
              {item.text}
            </span>
          ))}
          <span style={{ color: C.faint }}>francois{appVersion && ` ${appVersion}`}</span>
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
      {/* FR-51: opened by the `Manage plugins` palette command. Owns its own
          visibility, so nothing here has to track it. */}
      <PluginsModal />

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
  const sc =
    tab.status === 'running'
      ? C.running
      : tab.status === 'done'
        ? C.done
        : tab.status === 'error'
          ? C.error
          : C.idle;
  return (
    <span
      onClick={onOpen}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={tab.name}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 11,
        fontWeight: 500,
        cursor: 'pointer',
        padding: '2px 0',
        color: active ? C.accent : C.dim,
        borderBottom: `2px solid ${active ? C.accent : 'transparent'}`,
        maxWidth: 160,
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          flexShrink: 0,
          background: sc,
          animation: tab.status === 'running' ? 'pulse 1.4s ease-in-out infinite' : 'none',
        }}
      />
      <span style={{ color: C.running, flexShrink: 0 }}>⇉</span>
      <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {agentTabLabel(tab.name)}
      </span>
      {hover && (
        <span
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          title="close tab"
          style={{ fontSize: 10, color: C.faint, flexShrink: 0 }}
          onMouseEnter={(e) => (e.currentTarget.style.color = C.error)}
          onMouseLeave={(e) => (e.currentTarget.style.color = C.faint)}
        >
          ✕
        </span>
      )}
    </span>
  );
}
