// cohorte-integration FR-63 — binds `gateKeyAction` to a CAPTURE-phase window
// listener while a gate card is on screen in the focused main pane, so a
// consumed 1/2/3 never reaches the app's own digit shortcuts (bubble phase).

import { useEffect, useRef } from 'react';
import type { CohorteGateActionId } from '../../../contract/cohorte-integration';
import { useCohorteStore } from '../../lib/cohorteStore';
import { useStore } from '../../lib/store';
import { isPaletteOpen } from '../palette/palette';
import { gateKeyAction, isControlTarget, isEditableTarget } from './gate-keys';

function keyboardBlocked(): boolean {
  const s = useStore.getState();
  return (
    isPaletteOpen() ||
    s.newSessionOpen ||
    s.newAgentOpen ||
    s.adoptCloudOpen ||
    s.permissionsOpen ||
    s.projectsOpen ||
    s.accountsOpen ||
    s.profilesOpen ||
    s.extensionsOpen ||
    s.updateModalOpen ||
    s.sessionSettingsId !== null ||
    s.focusedPane !== 'main'
  );
}

export interface GateKeysOptions {
  runId: string;
  /** the card is visible in the focused main pane */
  active: boolean;
  offered: readonly CohorteGateActionId[];
  denyStopsRun: boolean;
  armed: boolean;
  setArmed: (armed: boolean) => void;
  onRun: (action: CohorteGateActionId) => void;
}

export function useGateKeys(opts: GateKeysOptions): void {
  const ref = useRef(opts);
  ref.current = opts;
  useEffect(() => {
    if (!opts.active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      const o = ref.current;
      const result = gateKeyAction(e.key, {
        editable: isEditableTarget(document.activeElement as HTMLElement | null),
        blocked: keyboardBlocked(),
        busy: Boolean(useCohorteStore.getState().busy[o.runId]),
        offered: o.offered,
        denyStopsRun: o.denyStopsRun,
        confirmArmed: o.armed,
        repeat: e.repeat,
        onControl: isControlTarget(document.activeElement as HTMLElement | null),
      });
      if (result.kind === 'pass') return;
      e.preventDefault();
      e.stopPropagation();
      if (result.kind === 'arm') o.setArmed(true);
      else if (result.kind === 'disarm') o.setArmed(false);
      else if (result.kind === 'run') {
        o.setArmed(false);
        o.onRun(result.action);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [opts.active]);
}
