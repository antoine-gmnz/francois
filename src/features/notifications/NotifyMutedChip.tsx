// notifications FR-19 — the status-bar "muted" chip: the only new persistent
// element, and absent in the default (both classes on) state. Design brief
// §1: right cluster of .app-status-bar, before AccountChip.

import { openPalette } from '../palette/palette';
import { useNotificationsStore } from '../../lib/notificationsStore';
import { mutedChipLabel, mutedChipTitle } from './notifyChip';
import './notifications.css';

export function NotifyMutedChip(): JSX.Element | null {
  const enabled = useNotificationsStore((s) => s.enabled);
  const label = mutedChipLabel(enabled);
  if (label === null) return null;

  return (
    <button type="button" className="notify-muted-chip" onClick={() => openPalette()} title={mutedChipTitle(enabled)}>
      <span className="notify-muted-chip__glyph">◇</span>
      <span className="notify-muted-chip__label">{label}</span>
    </button>
  );
}
