// The focused session's context readout for the session panel's footers
// ("Context ▬▬── 134K / 1M"). Reuses the roster's readout, so a Pi / retired
// session reads its metrics and an unknown window renders no meter at all.

import type { SessionMeta } from '../../../contract/common';
import { rosterContextReadout } from '../../features/sessions/roster-row';
import type { PanelContext } from './sections';

export function panelContext(session: SessionMeta): PanelContext | null {
  const readout = rosterContextReadout(session);
  return readout ? { fraction: readout.fraction, figure: `${readout.usedLabel} / ${readout.windowLabel}` } : null;
}
