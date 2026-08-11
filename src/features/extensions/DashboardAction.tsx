// FR-46..FR-48: the ONE action in the registry — cohorte's dashboard button in
// the Health section header. Three states from `extensions_probe`:
//
//   running   `Open dashboard`   (the core opens the URL)
//   stopped   `Launch dashboard` (confirm first, then the core spawns it)
//   occupied  disabled, `port 4317 is taken by something else`
//
// Both live states call the SAME command: `extensions_launch` is idempotent and
// the core owns the whole probe→spawn→re-probe→open sequence (contract), so
// this component issues one call and awaits one answer. It never spawns
// anything itself, tracks no PID, and offers no stop — that belongs in cohorte.

import { useEffect, useState } from 'react';
import type { AppError } from '../../../contract/common';
import type { PanelAction, ProbeResult } from '../../../contract/extensions';
import { extensionsLaunch, extensionsProbe } from '../../lib/api';
import { useMounted } from '../../lib/hooks/useMounted';
import { Button } from '../../ui/Button';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '../../ui/Modal';
import { causeText } from './extensions';

export default function DashboardAction({ action }: { action: PanelAction }) {
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const alive = useMounted();

  const runProbe = () => {
    void extensionsProbe()
      .then((res) => {
        if (!alive.current) return;
        if (res.ok) setProbe(res.data);
      })
      .catch(() => {});
  };

  useEffect(runProbe, []); // eslint-disable-line react-hooks/exhaustive-deps

  // FR-48: a human click, then an explicit confirmation showing the resolved
  // command verbatim. The `running` state needs no confirmation — it opens a URL.
  const launch = () => {
    setConfirming(false);
    setBusy(true);
    setError(null);
    void extensionsLaunch({ actionId: action.id })
      .then((res) => {
        if (!alive.current) return;
        setBusy(false);
        if (!res.ok) setError(res.error);
        runProbe();
      })
      .catch(() => {
        if (!alive.current) return;
        setBusy(false);
        setError({ code: 'INTERNAL', message: 'Could not reach the core' });
      });
  };

  const state = probe?.state ?? 'stopped';
  const occupied = state === 'occupied';
  const label = busy ? 'starting…' : state === 'running' ? 'Open dashboard' : action.label;

  return (
    <span className="ext-action">
      <Button
        variant="ghost"
        className="ext-action__btn"
        disabled={occupied || busy}
        onClick={() => (state === 'running' ? launch() : setConfirming(true))}
      >
        {label}
      </Button>
      {occupied && <span className="ext-action__note">port 4317 is taken by something else</span>}
      {error && <span className="ext-action__error">{causeText(error)}</span>}

      {confirming && (
        <Modal width={420} align="center" closeOnEscape closeOnBackdropClick onClose={() => setConfirming(false)}>
          <ModalHeader>Launch the cohorte dashboard</ModalHeader>
          <ModalBody>
            {/* The command string IS the point of this dialog (design brief §4). */}
            <div className="ext-confirm__command">{action.resolvedCommand}</div>
            <div className="ext-confirm__note">
              It runs detached — Francois does not track it, and closing Francois will not stop it.
            </div>
          </ModalBody>
          <ModalFooter>
            <Button onClick={() => setConfirming(false)}>Cancel</Button>
            <Button variant="primary" onClick={launch}>
              Launch
            </Button>
          </ModalFooter>
        </Modal>
      )}
    </span>
  );
}
