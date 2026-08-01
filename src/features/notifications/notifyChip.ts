// notifications FR-19 — pure derivation for the status-bar "muted" chip: what
// it reads is `enabled` alone (no counts, no session names — design brief
// "Data shown"). Split out from the component so the rule is unit-testable
// with no DOM.

import type { NotifyClass } from '../../../contract/notifications';
import { NOTIFY_CLASS_LABEL } from '../../../contract/notifications';

const CLASSES: readonly NotifyClass[] = ['attention', 'turnDone'];

function mutedClasses(enabled: Record<NotifyClass, boolean>): NotifyClass[] {
  return CLASSES.filter((c) => !enabled[c]);
}

/** FR-19: `null` ⇒ render nothing (both classes on, the default state). */
export function mutedChipLabel(enabled: Record<NotifyClass, boolean>): string | null {
  const off = mutedClasses(enabled);
  if (off.length === 0) return null;
  return off.length === 2 ? 'muted (all)' : 'muted';
}

/** FR-19: native `title` naming exactly what is silenced. '' when nothing is. */
export function mutedChipTitle(enabled: Record<NotifyClass, boolean>): string {
  const off = mutedClasses(enabled);
  if (off.length === 0) return '';
  if (off.length === 2) return 'all notifications are off';
  return `${NOTIFY_CLASS_LABEL[off[0]]} notifications are off`;
}
