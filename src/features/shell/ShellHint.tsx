// Figma "Shell hint" (136:6100): the rail under the terminal. One sentence on
// what this shell is (and that the agent cannot see it), then the keycaps the
// footer always carried — ⌃C interrupt, ⌃L clear. An exited shell says so here,
// since its tab no longer carries a status dot.

import { Kbd } from '../../ui/Kbd';
import { shellHintText } from './shell';
import './shell.css';

export interface ShellHintProps {
  /** The session runs in a dedicated git worktree. */
  inWorktree: boolean;
  /** The displayed shell's process is alive (null while none is displayed). */
  alive: boolean | null;
}

export default function ShellHint({ inWorktree, alive }: ShellHintProps): JSX.Element {
  return (
    <div className="shell-hint">
      {alive === false && <span className="shell-hint__exited">Shell exited</span>}
      <span className="shell-hint__text truncate">{shellHintText(inWorktree)}</span>
      <span className="shell-hint__key">
        <Kbd keys="⌃C" /> interrupt
      </span>
      <span className="shell-hint__key">
        <Kbd keys="⌃L" /> clear
      </span>
    </div>
  );
}
