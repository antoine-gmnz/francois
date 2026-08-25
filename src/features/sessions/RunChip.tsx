// session-settings-sheet FR-20 — the run chip loses its popover: clicking it now
// opens the session settings sheet in edit mode (the single place model, effort,
// permission mode and response mode are picked, alongside every other run
// setting). This is now a thin, stateless readout — `run-chip.ts`'s
// parts/effort/bypass helpers still do the presentation work, unchanged.

import type { SessionMeta } from '../../../contract/common';
import { useStore } from '../../lib/store';
import { runChipParts } from './run-chip';
import './run-chip.css';

export interface RunChipProps {
  session: SessionMeta;
  /** Also run when the chip opens the sheet — e.g. TopbarOverflow closing its own panel. */
  onOpen?: () => void;
}

export default function RunChip({ session, onOpen }: RunChipProps) {
  const parts = runChipParts(session);

  const open = () => {
    useStore.getState().setSessionSettingsId(session.id);
    onOpen?.();
  };

  return (
    <div className="run-chip">
      <span
        role="button"
        tabIndex={0}
        title={`${parts.model} · ${parts.mode}${parts.response ? ` · ${parts.response}` : ''} — click for session settings`}
        onClick={open}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            open();
          }
        }}
        className="run-chip__chip"
      >
        <span className="run-chip__model">{parts.model}</span>
        {parts.effort && <span className="run-chip__effort-tag">{parts.effort}</span>}
        <span className={parts.danger ? 'run-chip__mode run-chip__mode--danger' : 'run-chip__mode'}>{parts.mode}</span>
        {/* response-mode FR-15: last in the cluster, and only when it is not
            'default' — the common case leaves the row exactly as wide as it was. */}
        {parts.response && <span className="run-chip__response">{parts.response}</span>}
      </span>
    </div>
  );
}
