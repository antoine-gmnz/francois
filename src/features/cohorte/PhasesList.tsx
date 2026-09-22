// cohorte-integration FR-68 — the panel's PHASES list (frame 25 panel): one
// block per phase, the current one raised; steps indented under it with the
// session that runs in the step's worktree (FR-30 rule 2) on the right.

import type { CohorteRun } from '../../../contract/cohorte-integration';
import { useElapsedClock } from '../../lib/hooks/useElapsedClock';
import { useStore } from '../../lib/store';
import { StateIcon } from '../../ui/StateIcon';
import './cohorte.css';
import { sessionAtPath } from './linkage';
import { donePhaseCount, isGatePhase, phaseMeta, phaseStarted, statusGlyph } from './run-view';
import { CASE_INSENSITIVE_FS } from './useCohorte';

export function PhasesList({ run }: { run: CohorteRun }): JSX.Element {
  const sessions = useStore((s) => s.sessions);
  const running = run.phases.some((p) => p.status === 'running');
  const now = useElapsedClock(running);
  return (
    <div className="cohorte-phases">
      <div className="cohorte-phases__label">
        <span>PHASES</span>
        <span className="cohorte-phases__count">
          {donePhaseCount(run.phases)} / {run.phases.length}
        </span>
      </div>
      {run.phases.map((phase) => {
        const gated = isGatePhase(run, phase);
        const meta = phaseMeta(run, phase, now, false);
        const current = phase.state === run.currentPhase || gated;
        return (
          <div key={phase.state} className={current ? 'cohorte-phase cohorte-phase--current' : 'cohorte-phase'}>
            <div className="cohorte-phase__head">
              <StateIcon kind={gated ? 'approval' : statusGlyph(phase.status)} size={13} />
              <span className={phaseStarted(phase) ? 'cohorte-phase__name' : 'cohorte-phase__name cohorte-phase__name--pending'}>
                {phase.label}
              </span>
              <span className={meta.live ? 'cohorte-phase__meta cohorte-phase__meta--live' : 'cohorte-phase__meta'}>{meta.text}</span>
            </div>
            {phase.steps.map((step) => {
              const session = sessionAtPath(sessions, step.worktree?.path, CASE_INSENSITIVE_FS);
              return (
                <div key={`${step.agentId}:${step.incarnation}`} className="cohorte-phase__step" title={step.summary ?? step.label}>
                  <StateIcon kind={statusGlyph(String(step.status))} size={11} />
                  <span
                    className={
                      step.status === 'pending' ? 'cohorte-phase__step-label cohorte-phase__step-label--pending truncate' : 'cohorte-phase__step-label truncate'
                    }
                  >
                    {step.label}
                  </span>
                  {session && <span className="cohorte-phase__step-meta truncate">{session.name}</span>}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
