import { describe, expect, it } from 'vitest';
import { COHORTE_WIRE_EVENT_TYPES } from '../../contract/cohorte-events';
import { appendLog, COHORTE_LOG_CAP, isUnrecognisedType, logEntryFromEvent, logTone, wireSeverity } from './cohorte-log';
import { wire } from './cohorte.testutil';

describe('logEntryFromEvent', () => {
  it('yields one row per catalogue type, keyed by the Cohorte type verbatim', () => {
    for (const type of COHORTE_WIRE_EVENT_TYPES) {
      const payload: Record<string, object> = { 'agent.message.completed': { preview: '' }, 'agent.message.delta': { delta: '' } };
      const entry = logEntryFromEvent(wire(type, payload[type] ?? {}));
      expect(entry.type).toBe(type);
      expect(entry.runId).toBeTruthy();
    }
  });

  it('keeps an unknown event under its own cohorteType', () => {
    const entry = logEntryFromEvent(wire('unknown'));
    expect(entry.type).toBe('foo.bar');
    expect(isUnrecognisedType(entry.type)).toBe(true);
    expect(isUnrecognisedType('pipeline.started')).toBe(false);
  });

  it('shows a completed message preview and a coalesced delta as +N chars', () => {
    expect(logEntryFromEvent(wire('agent.message.completed', { preview: '\nDone with auth.\nmore' })).summary).toBe('Done with auth.');
    expect(logEntryFromEvent(wire('agent.message.delta', { delta: 'abcdef', coalesced: 3 })).summary).toBe('+6 chars');
  });

  it('carries the agent id and the phase state from the header', () => {
    const e = wire('agent.started', {}, {
      agent: { agentId: 'agt_9', role: 'implementer', incarnation: 1, attempt: 1 },
      phase: { phaseRunId: 'phr_1', state: 'BUILD', iteration: 1 },
    });
    expect(logEntryFromEvent(e)).toMatchObject({ agentId: 'agt_9', phase: 'BUILD' });
  });
});

describe('wireSeverity (§5.1 tints)', () => {
  it('always warns for the warning family', () => {
    for (const t of ['runtime.warning', 'escalation.applied', 'tool.denied', 'budget.exceeded', 'retry.scheduled', 'lock.stolen']) {
      expect(wireSeverity(wire(t))).toBe('warning');
    }
  });
  it('always errors for the error family', () => {
    for (const t of ['command.rejected', 'git.worktree.quarantined', 'git.merge.conflicted', 'repo.change.detected']) {
      expect(wireSeverity(wire(t))).toBe('error');
    }
  });
  it('reads the payload where the tint depends on it', () => {
    expect(wireSeverity(wire('check.completed', { status: 'failed' }))).toBe('error');
    expect(wireSeverity(wire('check.completed', { status: 'passed' }))).toBe('info');
    expect(wireSeverity(wire('tool.completed', { isError: false, timedOut: true }))).toBe('error');
    expect(wireSeverity(wire('tool.completed', { isError: false, timedOut: false }))).toBe('info');
    expect(wireSeverity(wire('model.responded', { status: 'error' }))).toBe('error');
    expect(wireSeverity(wire('agent.failed', { willRetry: true }))).toBe('warning');
    expect(wireSeverity(wire('agent.failed', { willRetry: false }))).toBe('error');
    expect(wireSeverity(wire('error', { fatal: true }))).toBe('error');
  });
  it('falls back to the header severity', () => {
    expect(wireSeverity(wire('pipeline.started', {}, { severity: 'success' }))).toBe('success');
  });
});

describe('logTone', () => {
  it('tints only warning and error', () => {
    expect(logTone({ severity: 'error' })).toBe('error');
    expect(logTone({ severity: 'warning' })).toBe('warning');
    expect(logTone({ severity: 'success' })).toBe('normal');
    expect(logTone({ severity: 'progress' })).toBe('normal');
  });
});

describe('appendLog', () => {
  const row = (sequence: number, sub = 0) => logEntryFromEvent(wire('pipeline.started', {}, { sequence, sub }));

  it('appends in (sequence, sub) order and drops rows already held', () => {
    let log = appendLog([], row(1));
    log = appendLog(log, row(2));
    log = appendLog(log, row(2, 1));
    const same = appendLog(log, row(2));
    expect(same).toBe(log);
    expect(appendLog(log, row(1, 3))).toBe(log);
    expect(log.map((r) => [r.sequence, r.sub])).toEqual([[1, 0], [2, 0], [2, 1]]);
  });

  it('caps the buffer, oldest out first', () => {
    let log: ReturnType<typeof appendLog> = [];
    for (let i = 1; i <= COHORTE_LOG_CAP + 5; i++) log = appendLog(log, row(i));
    expect(log).toHaveLength(COHORTE_LOG_CAP);
    expect(log[0].sequence).toBe(6);
  });
});
