// The state glyph for work François only watches — a subagent or a workflow run
// opened as a tab. Running is an Orbit (Figma "33 · Loaders", 176:17299: "someone
// else is busy"); every settled state is the ordinary StateIcon. The session's
// own running state stays StateIcon's spinner — never this.

import { Orbit } from './Loaders';
import { StateIcon } from './StateIcon';
import type { StateKind } from './state-kind';

function settledKind(status: string): StateKind {
  if (status === 'done') return 'done';
  if (status === 'error') return 'failed';
  return 'idle';
}

export function WatchedStateIcon({ status, size, name }: { status: string; size: number; name?: string }): JSX.Element {
  if (status === 'running') return <Orbit size={14} label={name ? `${name} running` : 'running'} />;
  return <StateIcon kind={settledKind(status)} size={size} />;
}
