// The app bar — redesign "Graphite & Signal", Figma "App bar" (126:158): the one
// app-level strip, laid out as a 3-column grid so the command search sits
// genuinely centered regardless of what either side weighs (the grid is this
// turn's stand-in for the mock's absolute centering — same result, no overlap
// math). Left to right:
//  · LEFT   — the mark + wordmark, then the Overview / Sessions nav;
//  · CENTER — the command search (it IS the palette's trigger);
//  · RIGHT  — the notification-mute chip, the plan-usage icon (opens a popover
//             with the meters — too many Claude Code accounts made them too
//             wide to show inline), the update control, a divider, the
//             pane-layout segments (Sessions view only) + a second divider,
//             the theme/settings tools, and the account avatar.
//
// Everything here is app-scoped; everything session-scoped lives in the session
// header (SessionHeader.tsx) above the transcript. Nothing in this bar animates
// (usage-bar FR-25) — permanent chrome that repaints forever is exactly what a
// software-composited webview cannot afford.
//
// What moved, and where it stayed reachable:
//  · the old `Agents` nav pill → the roster footer strip, `3`, and ⌘K;
//  · the `+` new-session button → the roster header `+`, the rail, and `n`;
//  · the `N waiting` chip → the Overview pill's attention badge (clicking the
//    badge still jumps to the longest-waiting session).

import { statusNeedsAttention } from '../../contract/fleet-board';
import { accountDisplayLabel, accountNeedsLogin, findAccount, usageAccountId } from '../features/accounts/accounts';
import { NotifyMutedChip } from '../features/notifications/NotifyMutedChip';
import { togglePalette } from '../features/palette/palette';
import { UpdateChip } from '../features/update/UpdateChip';
import LayoutToggle from '../features/usage/LayoutToggle';
import UsageMeters from '../features/usage/UsageMeters';
import { useWindowWidth } from '../lib/hooks/useWindowWidth';
import { focusedSessionId } from '../lib/layoutStore';
import { useStore } from '../lib/store';
import { Icon } from '../ui/Icon';
import { IconButton } from '../ui/IconButton';
import { Kbd } from '../ui/Kbd';
import { Logo } from '../ui/Logo';
import { accountInitials, activeNav } from './app-bar';
import './app-bar.css';
import { layoutDisplay, topbarTier } from './topbar';

export interface AppBarProps {
  appVersion: string;
}

export default function AppBar({ appVersion }: AppBarProps) {
  const sessions = useStore((s) => s.sessions);
  const mainTab = useStore((s) => s.mainTab);
  const setMainTab = useStore((s) => s.setMainTab);
  const setFocusedPane = useStore((s) => s.setFocusedPane);
  const setActiveSessionId = useStore((s) => s.setActiveSessionId);
  const setProjectsOpen = useStore((s) => s.setProjectsOpen);
  // Settings is open while either of its flags is up (settings/settings-nav.ts).
  const settingsOpen = useStore((s) => s.projectsOpen || s.accountsOpen);
  const toggleSettings = () => {
    if (!settingsOpen) return setProjectsOpen(true);
    setProjectsOpen(false);
    useStore.getState().setAccountsOpen(false);
  };
  const theme = useStore((s) => s.theme);
  const toggleTheme = useStore((s) => s.toggleTheme);
  const tier = topbarTier(useWindowWidth());

  // Fleet-wide on purpose: the parked session is usually NOT the one on screen.
  const waiting = sessions.filter((s) => statusNeedsAttention(s.status));
  const nav = activeNav(mainTab);

  const go = (tab: 'overview' | 'session') => {
    if (settingsOpen) toggleSettings(); // the nav leaves Settings
    setFocusedPane('main');
    setMainTab(tab);
  };

  // "Go answer the thing that has been waiting longest" — the only useful reading of a count.
  const jumpToOldestWaiting = () => {
    const oldest = waiting.reduce((a, b) => (a.lastActivityAt <= b.lastActivityAt ? a : b));
    setActiveSessionId(oldest.id);
    go('session');
  };

  return (
    <header className="app-bar">
      <div className="app-bar__left">
        <div className="app-bar__brand">
          <Logo size={20} />
          <span className="app-bar__wordmark">Francois</span>
        </div>

        <nav className="app-bar__nav" aria-label="views">
          <button
            type="button"
            className={nav === 'overview' ? 'app-bar__nav-item app-bar__nav-item--on' : 'app-bar__nav-item'}
            title="cross-project dashboard · o"
            onClick={() => go('overview')}
          >
            Overview
            {waiting.length > 0 && (
              <span
                className="app-bar__badge"
                title={`${waiting.length} waiting on you — jump to the longest-waiting`}
                onClick={(e) => {
                  e.stopPropagation();
                  jumpToOldestWaiting();
                }}
              >
                {waiting.length}
              </span>
            )}
          </button>
          <button
            type="button"
            className={nav === 'sessions' ? 'app-bar__nav-item app-bar__nav-item--on' : 'app-bar__nav-item'}
            title="the selected session · 2"
            onClick={() => go('session')}
          >
            Sessions
          </button>
        </nav>
      </div>

      <button type="button" className="app-bar__search" onClick={() => togglePalette()} title="Command palette · ⌘K">
        <Icon name="search" size={14} />
        <span className="app-bar__search-text truncate">Jump to a session, run a command…</span>
        <Kbd keys="⌘K" />
      </button>

      <div className="app-bar__right">
        <NotifyMutedChip />
        <UsageMeters />
        <UpdateChip appVersion={appVersion} />

        <span className="app-bar__divider" />

        {nav === 'sessions' && (
          <>
            {layoutDisplay(tier) === 'segments' ? <LayoutToggle divider={false} /> : <LayoutToggle variant="menu" divider={false} />}
            <span className="app-bar__divider" />
          </>
        )}

        <div className="app-bar__tools">
          <IconButton title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'} onClick={toggleTheme}>
            <Icon name={theme === 'dark' ? 'moon' : 'sun'} size={16} />
          </IconButton>
          <IconButton title="Settings" on={settingsOpen} onClick={toggleSettings}>
            <Icon name="cog" size={16} />
          </IconButton>
        </div>

        <AccountAvatar />
      </div>
    </header>
  );
}

/** The focused session's account as a 26px initials disc; opens the Accounts modal. */
function AccountAvatar() {
  const accounts = useStore((s) => s.accounts);
  const sessions = useStore((s) => s.sessions);
  const activeSessionId = useStore((s) => focusedSessionId(s));
  const setAccountsOpen = useStore((s) => s.setAccountsOpen);
  if (accounts.length === 0) return null;
  const account = findAccount(accounts, usageAccountId(accounts, sessions, activeSessionId));
  if (!account) return null;
  const label = accountDisplayLabel(account);
  const needsLogin = accountNeedsLogin(account);
  return (
    <button
      type="button"
      className={needsLogin ? 'app-bar__avatar app-bar__avatar--alert' : 'app-bar__avatar'}
      title={needsLogin ? `${label} — needs re-login · manage accounts` : `${label} · manage accounts`}
      onClick={() => setAccountsOpen(true)}
    >
      {accountInitials(label)}
    </button>
  );
}
