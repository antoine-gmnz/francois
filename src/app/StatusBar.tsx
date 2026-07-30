import { togglePalette } from '../features/palette/palette';
import type { Pane, Theme } from '../lib/store';

export interface StatusBarProps {
  showLeftPane: boolean;
  showRightPane: boolean;
  toggleLeftPane: () => void;
  toggleRightPane: () => void;
  theme: Theme;
  toggleTheme: () => void;
  focusedPane: Pane;
  appVersion: string;
}

/** The app-shell's bottom status bar: key hints, pane toggles, ⌘K, theme
 * switch, focus readout, and the footer version string. */
export default function StatusBar({
  showLeftPane,
  showRightPane,
  toggleLeftPane,
  toggleRightPane,
  theme,
  toggleTheme,
  focusedPane,
  appVersion,
}: StatusBarProps) {
  return (
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
  );
}
