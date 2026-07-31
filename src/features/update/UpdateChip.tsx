// self-update FR-8 — the status-bar version readout. Two states and nothing
// else: today's dim, inert version string, or an accent `↑ <latest>` button
// that opens the update modal. A failed or not-yet-returned check is
// indistinguishable from "no update" on purpose (FR-7).
//
// Ambient by design: it never animates, never pulses and never takes focus —
// the release cadence means it will be present most of the time.

import { useStore } from '../../lib/store';
import { updateChipView } from './update';
import './update.css';

export function UpdateChip({ appVersion }: { appVersion: string }): JSX.Element {
  const update = useStore((s) => s.update);
  const setUpdateModalOpen = useStore((s) => s.setUpdateModalOpen);
  const view = updateChipView(update, appVersion);

  // Idle renders exactly as it did before this feature existed.
  if (!view.available) return <span className="app-key">{view.label}</span>;

  return (
    <button type="button" className="upd-chip" title={view.title} onClick={() => setUpdateModalOpen(true)}>
      {view.label}
    </button>
  );
}
