import { describe, expect, it } from 'vitest';
import { answeredByLine, commandErrorFeedback, hasPendingStep, rejectionToast, stepLine } from './outcome';

const cli = 'cohorte approve run_7fa3c1 apr_1';

describe('stepLine (FR-65)', () => {
  it('reads each outcome', () => {
    expect(stepLine({ cli, outcome: 'completed', exitCode: 0 })).toEqual({ text: `✓ ${cli} · completed`, tone: 'success' });
    expect(stepLine({ cli, outcome: 'pending', exitCode: 4 }).text).toBe(`… ${cli} · pending — Cohorte will apply it`);
    expect(stepLine({ cli, outcome: 'rejected', exitCode: 3, message: 'run is active' })).toEqual({
      text: `✕ ${cli} · rejected: run is active`,
      tone: 'danger',
    });
    expect(stepLine({ cli, outcome: 'skipped', exitCode: 0, message: 'Cohorte routes the findings after the denial' }).text).toBe(
      `– ${cli} · skipped: Cohorte routes the findings after the denial`,
    );
    expect(hasPendingStep([{ cli, outcome: 'pending', exitCode: 4 }])).toBe(true);
    expect(hasPendingStep([])).toBe(false);
  });
});

describe('commandErrorFeedback (FR-65/92/94)', () => {
  it('maps not-pending to a refresh and a quiet toast', () => {
    expect(commandErrorFeedback({ code: 'COHORTE_GATE_NOT_PENDING', message: 'x' })).toEqual({
      message: 'Already answered elsewhere',
      kind: 'info',
      refresh: true,
    });
  });
  it('maps a timeout to the may-still-apply warning, no retry', () => {
    expect(commandErrorFeedback({ code: 'COHORTE_TIMEOUT', message: 'x' })).toEqual({
      message: 'Cohorte did not answer in time — it may still apply the command',
      kind: 'error',
      refresh: false,
    });
  });
  it('shows a rejection message verbatim', () => {
    expect(commandErrorFeedback({ code: 'COHORTE_REJECTED', message: 'm', detail: { message: 'run is PAUSED' } }).message).toBe(
      'Cohorte refused: run is PAUSED',
    );
    expect(commandErrorFeedback({ code: 'COHORTE_REJECTED', message: 'm' }).message).toBe('Cohorte refused: m');
    expect(commandErrorFeedback({ code: 'COHORTE_COMMAND_FAILED', message: 'usage' })).toMatchObject({ message: 'usage', kind: 'error' });
  });
});

describe('rejectionToast (R-14)', () => {
  const payload = { commandId: 'cmd_1', commandType: 'approve', error: { code: 'conflict/unexpected', message: 'approval is not pending' } };
  it('toasts a rejection of a command Francois issued', () => {
    expect(rejectionToast({ payload: { ...payload, issuedByFrancois: true } })).toBe('Cohorte rejected approve: approval is not pending');
  });
  it('stays quiet for anyone else', () => {
    expect(rejectionToast({ payload: { ...payload, issuedByFrancois: false } })).toBeNull();
  });
});

describe('answeredByLine (R-15)', () => {
  const r = { actor: 'human:alice', decision: 'allow-once', at: 1_000, byThisWindow: false };
  it('names another actor and the decision for ~6 s', () => {
    expect(answeredByLine(r, 2_000)).toBe('Answered by alice · approved');
    expect(answeredByLine({ ...r, decision: 'deny', actor: undefined }, 2_000)).toBe('Answered by someone else · denied');
    expect(answeredByLine({ ...r, decision: 'unknown' }, 2_000)).toBeNull();
    expect(answeredByLine(r, 7_500)).toBeNull();
  });
  it("says nothing for this window's own answer", () => {
    expect(answeredByLine({ ...r, byThisWindow: true }, 2_000)).toBeNull();
    expect(answeredByLine(undefined, 0)).toBeNull();
  });
});
