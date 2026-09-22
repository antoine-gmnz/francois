// Figma "State" (125:7904): the seven session-state glyphs, and how a contract
// SessionStatus maps onto them. Pure — StateIcon renders the glyph, this decides
// which one. Approval and Question share the attention colour (a session blocked
// on you); Running is the only animated one.

import type { SessionStatus } from '../../contract/common';

export const STATE_KINDS = ['running', 'approval', 'question', 'done', 'failed', 'idle', 'pending'] as const;
export type StateKind = (typeof STATE_KINDS)[number];

const KIND: Record<SessionStatus, StateKind> = {
  starting: 'running',
  running: 'running',
  awaiting_approval: 'approval',
  awaiting_input: 'question',
  idle: 'idle',
  done: 'done',
  error: 'failed',
};

export function stateKindForStatus(status: SessionStatus): StateKind {
  return KIND[status] ?? 'idle';
}

const LABEL: Record<SessionStatus, string> = {
  starting: 'Starting',
  running: 'Running',
  awaiting_approval: 'Needs approval',
  awaiting_input: 'Question',
  idle: 'Idle',
  done: 'Done',
  error: 'Failed',
};

/** The word a state chip reads (the session header's "Running · 04:12"). */
export function sessionStateLabel(status: SessionStatus): string {
  return LABEL[status] ?? status;
}
