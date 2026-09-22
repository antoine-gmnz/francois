import { describe, expect, it } from 'vitest';
import type { SessionStatus } from '../../contract/common';
import { sessionStateLabel, stateKindForStatus, STATE_KINDS } from './state-kind';

const ALL: SessionStatus[] = ['starting', 'running', 'awaiting_approval', 'awaiting_input', 'idle', 'done', 'error'];

describe('stateKindForStatus', () => {
  it('maps every session status onto a Figma State kind', () => {
    expect(stateKindForStatus('starting')).toBe('running');
    expect(stateKindForStatus('running')).toBe('running');
    expect(stateKindForStatus('awaiting_approval')).toBe('approval');
    expect(stateKindForStatus('awaiting_input')).toBe('question');
    expect(stateKindForStatus('idle')).toBe('idle');
    expect(stateKindForStatus('done')).toBe('done');
    expect(stateKindForStatus('error')).toBe('failed');
  });

  it('only ever returns a known kind', () => {
    for (const s of ALL) expect(STATE_KINDS).toContain(stateKindForStatus(s));
  });
});

describe('sessionStateLabel', () => {
  it('is a sentence-case word per status', () => {
    expect(sessionStateLabel('starting')).toBe('Starting');
    expect(sessionStateLabel('running')).toBe('Running');
    expect(sessionStateLabel('awaiting_approval')).toBe('Needs approval');
    expect(sessionStateLabel('awaiting_input')).toBe('Question');
    expect(sessionStateLabel('idle')).toBe('Idle');
    expect(sessionStateLabel('done')).toBe('Done');
    expect(sessionStateLabel('error')).toBe('Failed');
  });
});
