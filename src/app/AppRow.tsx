// design 7a (the composite) — the APP row: the outer of the two chrome tiers.
//
// It states what the whole app is doing: the mark and wordmark, the three view
// pills, the accent `+`, and on the right the things that are true regardless of
// which session you are reading — how many sessions are parked on you, the plan
// meters, the account, ⌘K, the theme, the update chip.
//
// The tier boundary is the point: everything here is app-scoped, everything in
// SessionRow below is session-scoped. Nothing in this row is a focusable pane,
// and nothing in it animates (usage-bar FR-25) — permanent chrome that repaints
// forever is exactly what a software-composited webview cannot afford.

import { Settings } from 'lucide-react';
import { statusNeedsAttention } from '../../contract/fleet-board';
import { AccountChip } from '../features/accounts/AccountChip';
import { NotifyMutedChip } from '../features/notifications/NotifyMutedChip';
import { togglePalette } from '../features/palette/palette';
import { UpdateChip } from '../features/update/UpdateChip';
import UsageMeters from '../features/usage/UsageMeters';
import { useStore } from '../lib/store';
import { Logo } from '../ui/Logo';
import { isSessionScopedTab } from './appShell';

/** The three view pills, left to right: whole fleet → one session → its agents. */
const NAV = [
  { key: 'overview', label: 'Overview', title: 'cross-project dashboard · o' },
  { key: 'session', label: 'Sessions', title: 'the selected session · 2' },
  { key: 'agents', label: 'Agents', title: 'subagents for this session · 3' },
] as const;

export interface AppRowProps {
  appVersion: string;
}

export default function AppRow({ appVersion }: AppRowProps) {
  const sessions = useStore((s) => s.sessions);
  const mainTab = useStore((s) => s.mainTab);
  const setMainTab = useStore((s) => s.setMainTab);
  const setFocusedPane = useStore((s) => s.setFocusedPane);
  const setActiveSessionId = useStore((s) => s.setActiveSessionId);
  const setNewSessionOpen = useStore((s) => s.setNewSessionOpen);
  const setProjectsOpen = useStore((s) => s.setProjectsOpen);
  const theme = useStore((s) => s.theme);
  const toggleTheme = useStore((s) => s.toggleTheme);

  // The mock's `1 waiting`. Fleet-wide on purpose: this is the app row, and the
  // whole reason to surface the count here is that the parked session is
  // usually NOT the one on screen.
  const waiting = sessions.filter((s) => statusNeedsAttention(s.status));

  const activeNav = mainTab === 'overview' ? 'overview' : mainTab === 'agents' ? 'agents' : isSessionScopedTab(mainTab) ? 'session' : null;

  const openNav = (key: (typeof NAV)[number]['key']) => {
    setFocusedPane('main');
    setMainTab(key);
  };

  return (
    <header className="app-row">
      <Logo size={16} />
      <span className="app-row__wordmark">Francois</span>

      <nav className="app-row__nav">
        {NAV.map((item) => (
          <span
            key={item.key}
            title={item.title}
            onClick={() => openNav(item.key)}
            className={activeNav === item.key ? 'app-row__nav-item app-row__nav-item--on' : 'app-row__nav-item'}
          >
            {item.label}
          </span>
        ))}
      </nav>

      <button type="button" className="app-row__new" title="New session · n" onClick={() => setNewSessionOpen(true)}>
        +
      </button>

      <span className="app-flex-spacer" />

      {/* Clicking it selects the OLDEST-parked session — "go answer the thing
          that has been waiting longest" is the only useful reading of a count. */}
      {waiting.length > 0 && (
        <span
          className="app-row__waiting"
          title="jump to the session that has been waiting longest"
          onClick={() => {
            const oldest = waiting.reduce((a, b) => (a.lastActivityAt <= b.lastActivityAt ? a : b));
            setActiveSessionId(oldest.id);
            setFocusedPane('main');
            setMainTab('session');
          }}
        >
          <span className="app-row__waiting-dot" />
          {waiting.length} waiting
        </span>
      )}

      {/* notifications FR-19: the exception (something is silenced) leads the
          right cluster, the routine (account) follows. */}
      <NotifyMutedChip />
      <UsageMeters />
      {/* multi-account FR-33: which account the selected session runs on. */}
      <AccountChip />

      <span className="app-row__divider" />

      <span onClick={() => togglePalette()} className="app-row__key" title="Command palette">
        ⌘K
      </span>
      <span
        onClick={toggleTheme}
        className="app-row__icon"
        title={theme === 'dark' ? 'switch to light theme' : 'switch to dark theme'}
      >
        {theme === 'dark' ? '☾' : '☀'}
      </span>
      <span onClick={() => setProjectsOpen(true)} className="app-row__icon" title="Projects & standards">
        <Settings size={13} strokeWidth={1.75} />
      </span>
      {/* self-update FR-8: the version readout, plus its one accent state. */}
      <UpdateChip appVersion={appVersion} />
    </header>
  );
}
