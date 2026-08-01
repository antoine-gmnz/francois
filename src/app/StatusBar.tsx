import { AccountChip } from '../features/accounts/AccountChip';
import { NotifyMutedChip } from '../features/notifications/NotifyMutedChip';
import { togglePalette } from '../features/palette/palette';
import { UpdateChip } from '../features/update/UpdateChip';
import type { Pane, Theme } from '../lib/store';

export interface StatusBarProps {
  theme: Theme;
  toggleTheme: () => void;
  focusedPane: Pane;
  /** Name of the agent whose tab is open, or null on a built-in tab (FR-10). */
  activeAgentName: string | null;
  /** Subagents currently running for the active session (fleet-board FR-5). */
  runningAgents: number;
  appVersion: string;
}

/**
 * The app-shell's bottom status bar. design-refresh FR-10: condensed to ⌘K,
 * the focus readout (plus the agent-tab keyboard hints while one is open),
 * the theme toggle and the version — the old ten-hint string is gone. Every
 * hotkey it used to name still works; `1`–`5`, `[`/`]`, `o`/`d`/`t` and `n`
 * are bound in useAppShortcuts, not here.
 */
export default function StatusBar({ theme, toggleTheme, focusedPane, activeAgentName, runningAgents, appVersion }: StatusBarProps) {
  return (
    <div className="app-status-bar">
      <span onClick={() => togglePalette()} className="app-clickable app-text-dim">
        <span className="app-key app-key--accent">⌘K</span> commands
      </span>
      {activeAgentName ? (
        <>
          <span>
            focus <span className="app-text-hint">{activeAgentName}</span>
          </span>
          <span>
            <span className="app-key">⌥1-9</span> jump to tab
          </span>
          <span>
            <span className="app-key">⌘W</span> close tab
          </span>
        </>
      ) : (
        <>
          <span>
            focus <span className="app-text-hint">{focusedPane}</span>
          </span>
          {runningAgents > 0 && (
            <span>
              <span className="app-text-accent">{runningAgents}</span> {runningAgents === 1 ? 'agent' : 'agents'} running
            </span>
          )}
        </>
      )}
      <span className="app-flex-spacer" />
      {/* notifications FR-19: the muted chip, before AccountChip per the design
          brief §1 — the exception (something is silenced) leads the right
          cluster, the routine (account) follows. Renders nothing when both
          notification classes are on. */}
      <NotifyMutedChip />
      {/* multi-account FR-33: which account the selected session runs on —
          first in the right cluster, per the design brief. Renders
          unconditionally, including a single-account install's own Default
          row (see AccountChip's own doc comment). */}
      <AccountChip />
      <span
        onClick={toggleTheme}
        className="app-clickable app-text-dim"
        title={theme === 'dark' ? 'switch to light theme' : 'switch to dark theme'}
      >
        {theme === 'dark' ? '☾' : '☀'} {theme}
      </span>
      {/* self-update FR-8: the same version readout, plus one state — an accent
          `↑ <latest>` button that opens the update modal. Last in the right
          cluster, exactly where the plain <span> sat. */}
      <UpdateChip appVersion={appVersion} />
    </div>
  );
}
