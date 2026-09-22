// cohorte-integration frame 25 — what a Cohorte run adds to a session:
//   · CohorteHeaderChips (FR-60)   state chip + run chip beside the name
//   · CohorteInlineGate (FR-61)    the full gate card after the last turn
// Both speak for the run's ORIGIN session (FR-30); the run chip shows on any
// linked session.

import { openCohorteRun } from './actions';
import { CohorteRunChip, CohorteStateChip } from './CohorteParts';
import { GateCard } from './GateCard';
import { useSessionRun, type HeaderRunState } from './useCohorte';

export function CohorteHeaderChips({ header }: { header: HeaderRunState }): JSX.Element | null {
  const { run, state } = header;
  if (!run) return null;
  return (
    <>
      {state && <CohorteStateChip label={state.label} tone={state.tone} glyph={state.glyph} />}
      <CohorteRunChip runId={run.runId} title={run.title} onOpen={() => openCohorteRun(run.runId)} />
    </>
  );
}

export function CohorteInlineGate({ sessionId, keysActive }: { sessionId: string; keysActive: boolean }): JSX.Element | null {
  const { run, isOrigin } = useSessionRun(sessionId);
  if (!run || !isOrigin || !run.gate) return null;
  return (
    <div className="conv-item cohorte-inline-gate">
      <GateCard run={run} gate={run.gate} variant="full" sessionId={sessionId} keysActive={keysActive} />
    </div>
  );
}
