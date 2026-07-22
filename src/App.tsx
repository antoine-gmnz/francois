import { useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { homeDir } from '@tauri-apps/api/path';
import { getName } from '@tauri-apps/api/app';
import ShellTerminal from './ShellTerminal';
import Sidebar from './Sidebar';
import NewSessionModal from './NewSessionModal';
import ConversationView from './ConversationView';
import DiffView from './DiffView';
import AgentsPanel from './AgentsPanel';
import McpPanel from './McpPanel';
import SkillsPanel from './SkillsPanel';
import UsageBar from './UsageBar';
import { initShellEvents, useShellState } from './shellStore';
import { useStore } from './store';
import { formatContextTokens, formatElapsed } from '../contract/conversation-view';
import { displayWslCwd } from '../contract/wsl-filesystem';
import { diffGetSummary, onDiffEvent } from './api';
import PaletteRoot from './PaletteView';
import { dismissPalette, isPaletteOpen, togglePalette } from './palette';
import { setPaletteDiffCount } from './paletteData';
import { registerBuiltinCommands } from './paletteCommands';

// Register the built-in palette commands once, before first paint (FR-6).
registerBuiltinCommands();

const C = {
  accent: '#c8a15a',
  dim: '#868a93',
  faint: '#565a63',
  primary: '#c4c7ce',
  bright: '#dfe2e8',
  hint: '#a9adb6',
  running: '#d0a45c',
  idle: '#6b7079',
  done: '#7fa07a',
  error: '#c46b62',
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
  const setFocusedPane = useStore((s) => s.setFocusedPane);
  const mainTab = useStore((s) => s.mainTab);
  const setMainTab = useStore((s) => s.setMainTab);
  const showLeftPane = useStore((s) => s.showLeftPane);
  const showRightPane = useStore((s) => s.showRightPane);
  const toggleLeftPane = useStore((s) => s.toggleLeftPane);
  const toggleRightPane = useStore((s) => s.toggleRightPane);
  const newSessionOpen = useStore((s) => s.newSessionOpen);
  const setNewSessionOpen = useStore((s) => s.setNewSessionOpen);
  const newAgentOpen = useStore((s) => s.newAgentOpen);
  const setNewAgentOpen = useStore((s) => s.setNewAgentOpen);
  const upsertSession = useStore((s) => s.upsertSession);
  const setActiveSessionId = useStore((s) => s.setActiveSessionId);

  const active = sessions.find((s) => s.id === activeSessionId) ?? null;

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
  useEffect(() => {
    void getName()
      .then(setAppName)
      .catch(() => {});
  }, []);
  useEffect(() => {
    void getCurrentWindow()
      .setTitle(active ? `${active.name} — ${appName}` : appName)
      .catch(() => {});
  }, [active?.name, appName]);

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
      if (newSessionOpen || newAgentOpen || inInput || inTerminal) return;
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
      } else if (e.key === '[') {
        useStore.getState().toggleLeftPane();
      } else if (e.key === ']') {
        useStore.getState().toggleRightPane();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [newSessionOpen, newAgentOpen, setNewSessionOpen, setNewAgentOpen, setFocusedPane, setMainTab]);

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
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: '#0f1015' }}>
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
            background: '#131419',
            border: `1px solid ${mainFocused ? C.accent : '#24262d'}`,
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
              borderBottom: '1px solid #24262d',
              flexShrink: 0,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
              <span onClick={() => setMainTab('session')} style={tabStyle(mainTab === 'session')}>
                SESSION
              </span>
              <span onClick={() => setMainTab('diff')} style={{ ...tabStyle(mainTab === 'diff'), display: 'flex', alignItems: 'center', gap: 6 }}>
                DIFF
                {diffCount > 0 && (
                  <span style={{ background: '#26282f', color: '#a9adb6', fontSize: 9, padding: '1px 5px', borderRadius: 8, fontWeight: 500, letterSpacing: 0 }}>
                    {diffCount}
                  </span>
                )}
              </span>
              <span onClick={() => setMainTab('shell')} style={tabStyle(mainTab === 'shell')}>
                SHELL
              </span>
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
          {mainTab === 'session' ? (
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
          ) : active ? (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, background: '#0f1015' }}>
              <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
                <ShellTerminal key={active.id} sessionId={active.id} />
              </div>
              <div
                style={{
                  padding: '10px 14px',
                  borderTop: '1px solid #24262d',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 14,
                  fontSize: 11,
                  color: '#6b7079',
                  background: '#0f1015',
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
            background: '#16171c',
            border: '1px solid #24262d',
            borderRadius: 5,
            fontSize: 10.5,
            color: '#6b7079',
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
          <span>
            focus: <span style={{ color: C.accent }}>{focusedPane}</span>
          </span>
          <span style={{ color: C.faint }}>francois 0.2.1</span>
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

      <PaletteRoot />
    </div>
  );
}
