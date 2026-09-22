// Pure helpers for a split / grid pane's header (SplitPane.tsx) — Figma
// "Graphite & Signal" 13 · Split / Two panes (137:6133) and 14 · Grid / Four
// panes (137:6338).

import type { SessionStatus } from '../../contract/common';
import type { PaneTab } from '../lib/layoutStore';

/** What the pane header reads after the session name. */
export interface PaneStatusText {
  /** `clock` ⇒ render the live elapsed figure instead of a word. */
  kind: 'clock' | 'word';
  /** The word (empty for `clock`). */
  text: string;
  /** The token family the text takes. */
  tone: 'running' | 'attention' | 'success' | 'danger' | 'faint';
}

/**
 * A running pane shows its clock (`04:12`, in the running tone); every other
 * state a short lower-case word — `needs approval`, `finished` … — so a glance
 * across four panes reads what each one wants without opening it.
 */
export function paneStatusText(status: SessionStatus): PaneStatusText {
  switch (status) {
    case 'starting':
    case 'running':
      return { kind: 'clock', text: '', tone: 'running' };
    case 'awaiting_approval':
      return { kind: 'word', text: 'needs approval', tone: 'attention' };
    case 'awaiting_input':
      return { kind: 'word', text: 'has a question', tone: 'attention' };
    case 'done':
      return { kind: 'word', text: 'finished', tone: 'success' };
    case 'error':
      return { kind: 'word', text: 'failed', tone: 'danger' };
    default:
      return { kind: 'word', text: 'idle', tone: 'faint' };
  }
}

/** The three built-in pane tabs, as the design names them. */
export const PANE_TABS: readonly { id: PaneTab; label: string }[] = [
  { id: 'session', label: 'Conversation' },
  { id: 'diff', label: 'Changes' },
  { id: 'shell', label: 'Terminal' },
];
