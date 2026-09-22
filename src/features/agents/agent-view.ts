// Pure helpers for the subagent drill-in (AgentView.tsx) — Figma "Graphite &
// Signal" 17 · Subagent drill-in (138:6593, light 142:14663).

import type { AgentStatus } from '../../../contract/common';
import { formatElapsed } from '../../../contract/conversation-view';
import type { StateKind } from '../../ui/state-kind';

/** The header's state chip: glyph kind, tone modifier and its words. */
export interface AgentStateChip {
  kind: StateKind;
  label: string;
}

const CHIP: Record<AgentStatus, { kind: StateKind; word: string }> = {
  running: { kind: 'running', word: 'Running' },
  idle: { kind: 'idle', word: 'Idle' },
  done: { kind: 'done', word: 'Done' },
  error: { kind: 'failed', word: 'Failed' },
};

/** "Running · 02:32" — the state word and the agent's own elapsed time. */
export function agentStateChip(status: AgentStatus, elapsedMs: number): AgentStateChip {
  const { kind, word } = CHIP[status] ?? CHIP.idle;
  return { kind, label: `${word} · ${formatElapsed(elapsedMs)}` };
}

/** The task card's wall-clock stamp — when the subagent was dispatched, `HH:MM`. */
export function taskClock(startedAt: number): string {
  const d = new Date(startedAt);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The dashed "no input" strip where a composer would be. */
export function noInputLine(agentName: string, sessionName: string | null): string {
  return sessionName
    ? `Subagents take no input — ${agentName} reports back to ${sessionName} when done.`
    : `Subagents take no input — ${agentName} reports back to its session when done.`;
}

/** What a keydown needs to say for `Esc` to leave the drill-in. */
export interface BackEscapeInput {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  defaultPrevented: boolean;
  /** The focus is in a text field, a terminal or an open dialog — Esc is theirs. */
  focusOwnsEscape: boolean;
}

/**
 * `Esc to go back`: a bare Escape nobody else has claimed. A modal, the
 * palette, a popover or a text field consumes its own Escape first (they call
 * preventDefault, or own the focus), so leaving the drill-in is only ever the
 * fallback meaning of the key.
 */
export function isBackEscape(e: BackEscapeInput): boolean {
  if (e.key !== 'Escape') return false;
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return false;
  return !e.defaultPrevented && !e.focusOwnsEscape;
}
