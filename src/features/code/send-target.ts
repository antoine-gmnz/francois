// code-editor-agents FR-5 — which session a chip made in the editor goes to. Exactly
// one live session on the editor's root is the target, silently; zero or several
// open the picker (same-root first). A remembered pick is pre-highlighted, never
// applied. Nothing is sent anywhere — a chip only lands in a composer.

import type { SessionId, SessionMeta } from '../../../contract/common';
import { isTerminalStatus } from '../../../contract/fleet-board';
import { pathKey } from '../../lib/path';
import { sessionIsRetired } from '../../lib/runtimeCapability';

export type TargetSession = Pick<SessionMeta, 'id' | 'name' | 'cwd' | 'status' | 'agentRuntime'>;

export type TargetResolution =
  | { kind: 'direct'; sessionId: SessionId }
  | { kind: 'pick'; sameRoot: SessionId[]; others: SessionId[]; highlight: SessionId }
  | { kind: 'none' };

/** Live = not archived (`done`), not errored, not a retired runtime — a composer that can send. */
export function isLiveTarget(s: TargetSession): boolean {
  return !isTerminalStatus(s.status) && !sessionIsRetired(s);
}

export function resolveTarget(sessions: readonly TargetSession[], rootDir: string, remembered?: SessionId | null): TargetResolution {
  const live = sessions.filter(isLiveTarget);
  if (live.length === 0) return { kind: 'none' };
  const root = pathKey(rootDir);
  const sameRoot = live.filter((s) => pathKey(s.cwd) === root).map((s) => s.id);
  if (sameRoot.length === 1) return { kind: 'direct', sessionId: sameRoot[0] };
  const others = live.filter((s) => !sameRoot.includes(s.id)).map((s) => s.id);
  const all = [...sameRoot, ...others];
  const highlight = remembered && all.includes(remembered) ? remembered : all[0];
  return { kind: 'pick', sameRoot, others, highlight };
}

/** The picker's rows in display (and ↑/↓) order. */
export function pickerItems(r: Extract<TargetResolution, { kind: 'pick' }>): SessionId[] {
  return [...r.sameRoot, ...r.others];
}
