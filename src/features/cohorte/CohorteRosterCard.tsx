// cohorte-integration FR-85 — a gated run in the roster's NEEDS YOU group: the
// gate kind, the question on one line, the offered actions inline (deny that
// stops the run asks for a second click) and Open → the run view. Rendered as
// the origin session's row body, or — with no origin in scope — as a run row.

import { useState } from 'react';
import type { CohorteGateActionId, CohorteRun } from '../../../contract/cohorte-integration';
import { formatRelativeTime } from '../../../contract/fleet-board';
import { useCohorteStore } from '../../lib/cohorteStore';
import { Button } from '../../ui/Button';
import { StateIcon } from '../../ui/StateIcon';
import { answerGate, openCohorteRun } from './actions';
import './cohorte.css';
import { CohorteMark } from './CohorteParts';
import { ACTION_VARIANT, compactActionLabel, gateKindLabel, gateQuestion, runSpecName } from './gate-view';
import { shortRunId } from './run-view';

export interface CohorteRosterCardProps {
  run: CohorteRun;
  /** the origin session row this card stands in for; absent for a run row */
  session?: { id: string; name: string };
  tags?: JSX.Element;
  now: number;
}

export function CohorteRosterCard({ run, session, tags, now }: CohorteRosterCardProps): JSX.Element | null {
  const busy = useCohorteStore((s) => s.busy[run.runId] ?? null);
  const [confirming, setConfirming] = useState(false);
  const gate = run.gate;
  if (!gate) return null;
  const kind = gateKindLabel(gate.request.kind).toLowerCase();

  const act = (id: CohorteGateActionId, stopsRun: boolean) => {
    if (id === 'deny' && stopsRun && !confirming) {
      setConfirming(true);
      return;
    }
    setConfirming(false);
    void answerGate(run, id, session?.id);
  };

  return (
    <>
      <div className="roster-row__head">
        {session ? <StateIcon kind="approval" /> : <CohorteMark size={13} />}
        <span className="roster-row__name truncate">{session ? session.name : runSpecName(run)}</span>
        {tags}
        {!session && <span className="cohorte-roster__id">{shortRunId(run.runId)}</span>}
        <span className="app-flex-spacer" />
        <span className="roster-row__age">{formatRelativeTime(gate.requestedAt, now)}</span>
      </div>
      <div className="cohorte-roster__kind">Cohorte gate · {kind}</div>
      <div className="cohorte-roster__question truncate" title={gateQuestion(gate, runSpecName(run))}>
        {gateQuestion(gate, runSpecName(run))}
      </div>
      <div className="roster-row__actions" onClick={(e) => e.stopPropagation()}>
        {gate.actions.map((a) => (
          <Button
            key={a.id}
            size="sm"
            variant={a.id === 'deny' && confirming ? 'danger' : ACTION_VARIANT[a.id]}
            className="roster-row__decide"
            title={a.cli.join('\n')}
            disabled={busy !== null}
            onClick={() => act(a.id, a.stopsRun)}
          >
            {a.id === 'deny' && confirming ? 'Confirm' : compactActionLabel(a)}
          </Button>
        ))}
        <Button size="sm" variant="ghost" title="open the run" onClick={() => openCohorteRun(run.runId)}>
          Open
        </Button>
      </div>
    </>
  );
}
