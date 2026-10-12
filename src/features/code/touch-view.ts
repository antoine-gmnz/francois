// code-editor-agents — the touched-files record joined with the live session list,
// as one reactive view the Code tab's components read (tabs, explorer, lock strip).

import { useMemo } from 'react';
import type { SessionId, SessionMeta } from '../../../contract/common';
import { useStore } from '../../lib/store';
import { selectLockHolders, useAgentTouch, type AgentTouchState, type StatusOf } from './agent-touch';

export interface TouchView {
  touch: AgentTouchState;
  statusOf: StatusOf;
  session: (id: SessionId) => SessionMeta | undefined;
}

/** The touched-files record plus the live session list, reactive. */
export function useTouchView(): TouchView {
  const touch = useAgentTouch();
  const sessions = useStore((s) => s.sessions);
  return useMemo(() => {
    const byId = new Map(sessions.map((s) => [s.id, s]));
    return { touch, statusOf: (id) => byId.get(id)?.status, session: (id) => byId.get(id) };
  }, [touch, sessions]);
}

/** FR-16: who locks `abs` (latest first) — empty when nobody does or the path is unknown. */
export function lockHoldersIn(view: TouchView, abs: string | null): SessionId[] {
  return abs ? selectLockHolders(view.touch, abs, view.statusOf) : [];
}
