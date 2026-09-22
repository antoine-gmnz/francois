import { describe, expect, it } from 'vitest';
import { commandErrorFeedback, hasPendingStep, stepLine } from './outcome';

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
    expect(commandErrorFeedback({ code: 'COHORTE_TIMEOUT', message: 'x' }).message).toBe(
      'Cohorte did not answer in time — it may still apply the command',
    );
  });
  it('shows a rejection message verbatim', () => {
    expect(commandErrorFeedback({ code: 'COHORTE_REJECTED', message: 'm', detail: { message: 'run is PAUSED' } }).message).toBe(
      'Cohorte refused: run is PAUSED',
    );
    expect(commandErrorFeedback({ code: 'COHORTE_REJECTED', message: 'm' }).message).toBe('Cohorte refused: m');
    expect(commandErrorFeedback({ code: 'COHORTE_COMMAND_FAILED', message: 'usage' })).toMatchObject({ message: 'usage', kind: 'error' });
  });
});
