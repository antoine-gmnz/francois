// cohorte-integration FR-63 — the 1 / 2 / 3 keys of a visible gate card. The
// decision is pure (`gateKeyAction`); `useGateKeys` binds it to a capture-phase
// listener so a consumed digit never reaches the app's own 1/2/3 shortcuts.

import type { CohorteGateActionId } from '../../../contract/cohorte-integration';

export interface GateKeyState {
  /** focus is in an input, textarea, contenteditable or a terminal */
  editable: boolean;
  /** a modal or the palette owns the keyboard */
  blocked: boolean;
  /** a command for this run is in flight */
  busy: boolean;
  offered: readonly CohorteGateActionId[];
  /** the deny action also cancels the run — `3` arms a confirm first */
  denyStopsRun: boolean;
  confirmArmed: boolean;
}

export type GateKeyResult =
  | { kind: 'run'; action: CohorteGateActionId }
  | { kind: 'arm' }
  | { kind: 'disarm' }
  /** consumed, nothing happens (a digit while busy, or for an action not offered) */
  | { kind: 'swallow' }
  /** not ours — let the key through */
  | { kind: 'pass' };

const DIGITS: Record<string, CohorteGateActionId> = { '1': 'approve', '2': 'fix', '3': 'deny' };

export function gateKeyAction(key: string, s: GateKeyState): GateKeyResult {
  if (s.blocked || s.editable) return { kind: 'pass' };
  if (s.confirmArmed) {
    if (key === 'Escape') return { kind: 'disarm' };
    if (key === '3' || key === 'Enter') return s.busy ? { kind: 'swallow' } : { kind: 'run', action: 'deny' };
    if (key in DIGITS) return { kind: 'swallow' };
    return { kind: 'pass' };
  }
  const action = DIGITS[key];
  if (!action) return { kind: 'pass' };
  if (s.busy || !s.offered.includes(action)) return { kind: 'swallow' };
  if (action === 'deny' && s.denyStopsRun) return { kind: 'arm' };
  return { kind: 'run', action };
}

interface FocusLike {
  tagName: string;
  isContentEditable?: boolean;
  closest?: (selector: string) => unknown;
}

/** Whether the focused element takes typed text (FR-63's "editable element"). */
export function isEditableTarget(el: FocusLike | null | undefined): boolean {
  if (!el) return false;
  const tag = el.tagName.toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (el.isContentEditable) return true;
  return el.closest?.('.xterm') != null;
}
