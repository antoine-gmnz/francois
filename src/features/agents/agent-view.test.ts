import { describe, expect, it } from 'vitest';
import { agentStateChip, isBackEscape, noInputLine, taskClock } from './agent-view';

describe('agentStateChip', () => {
  it('reads the state word and the elapsed clock', () => {
    expect(agentStateChip('running', 152_000)).toEqual({ kind: 'running', label: 'Running · 02:32' });
  });

  it('maps every settled status onto its glyph', () => {
    expect(agentStateChip('done', 48_000)).toEqual({ kind: 'done', label: 'Done · 00:48' });
    expect(agentStateChip('error', 72_000)).toEqual({ kind: 'failed', label: 'Failed · 01:12' });
    expect(agentStateChip('idle', 0)).toEqual({ kind: 'idle', label: 'Idle · 00:00' });
  });
});

describe('taskClock', () => {
  it('stamps the local wall-clock time of the dispatch', () => {
    expect(taskClock(new Date(2026, 8, 22, 10, 44, 30).getTime())).toBe('10:44');
    expect(taskClock(new Date(2026, 8, 22, 9, 5).getTime())).toBe('09:05');
  });
});

describe('noInputLine', () => {
  it('names the parent session it reports back to', () => {
    expect(noInputLine('test-writer', 'orbit-api')).toBe(
      'Subagents take no input — test-writer reports back to orbit-api when done.',
    );
  });

  it('never invents a session name it does not have', () => {
    expect(noInputLine('test-writer', null)).toBe(
      'Subagents take no input — test-writer reports back to its session when done.',
    );
  });
});

describe('isBackEscape', () => {
  const base = {
    key: 'Escape',
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    defaultPrevented: false,
    focusOwnsEscape: false,
  };

  it('goes back on a bare, unclaimed Escape', () => {
    expect(isBackEscape(base)).toBe(true);
  });

  it('ignores other keys and modified Escapes', () => {
    expect(isBackEscape({ ...base, key: 'Enter' })).toBe(false);
    expect(isBackEscape({ ...base, shiftKey: true })).toBe(false);
    expect(isBackEscape({ ...base, metaKey: true })).toBe(false);
  });

  it('leaves an Escape someone else claimed alone', () => {
    expect(isBackEscape({ ...base, defaultPrevented: true })).toBe(false);
    expect(isBackEscape({ ...base, focusOwnsEscape: true })).toBe(false);
  });
});
