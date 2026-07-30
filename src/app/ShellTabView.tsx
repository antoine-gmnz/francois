import ShellTerminal from '../features/shell/ShellTerminal';
import type { ShellUiState } from '../features/shell/shellStore';
import { StatusDot } from '../ui/StatusDot';
import { shellFooterPath } from './appShell';

export interface ShellTabViewProps {
  sessionId: string;
  shell: ShellUiState;
  home: string;
}

/** The SHELL main tab's body: the PTY terminal plus its footer (alive dot,
 * shell name + cwd, interrupt/clear hints). */
export default function ShellTabView({ sessionId, shell, home }: ShellTabViewProps) {
  return (
    <div className="app-shell-view">
      <div className="app-shell-terminal-wrap">
        <ShellTerminal key={sessionId} sessionId={sessionId} />
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
  );
}
