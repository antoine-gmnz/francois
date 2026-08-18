// notifications FR-19 / audio-cues FR-13 — the status-bar "muted" chip: the
// only new persistent element, and absent in the default (all three channels
// on) state. Design brief §1: right cluster of .app-status-bar, before
// AccountChip. No acid — the chip stays --text-faint (2026-08-17 `ui`
// decision).

import type { MutedChannel } from '../../../contract/audio-cues';
import { openPalette } from '../palette/palette';
import { useNotificationsStore } from '../../lib/notificationsStore';
import { mutedChipLabel, mutedChipTitle } from './notifyChip';
import './notifications.css';

export function NotifyMutedChip(): JSX.Element | null {
  const enabled = useNotificationsStore((s) => s.enabled);
  const soundEnabled = useNotificationsStore((s) => s.soundEnabled);
  const off: MutedChannel[] = [
    ...(enabled.attention ? [] : (['attention'] as const)),
    ...(enabled.turnDone ? [] : (['turnDone'] as const)),
    ...(soundEnabled ? [] : (['sound'] as const)),
  ];
  const label = mutedChipLabel(off);
  if (label === null) return null;

  return (
    <button type="button" className="notify-muted-chip" onClick={() => openPalette()} title={mutedChipTitle(off)}>
      <span className="notify-muted-chip__glyph">◇</span>
      <span className="notify-muted-chip__label">{label}</span>
    </button>
  );
}
