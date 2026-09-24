import { describe, expect, it } from 'vitest';
import type { CheckJob, CheckRun, JobStep, LogLine, StepLog } from '../../../contract/github-page';
import {
  canOpenStep,
  checkCountLine,
  checkKey,
  checkRowOrder,
  currentStep,
  failureExcerpt,
  firstFailedStep,
  foldGroups,
  nextPollDelayMs,
  pollingActive,
  rerunTargets,
} from './ci-logs';

function check(overrides: Partial<CheckRun> = {}): CheckRun {
  return { name: 'unit tests', state: 'passed', ...overrides };
}

function step(overrides: Partial<JobStep> = {}): JobStep {
  return { number: 1, name: 'Run tests', state: 'passed', ...overrides };
}

function job(overrides: Partial<CheckJob> = {}): CheckJob {
  return {
    jobId: 1,
    runId: 10,
    runAttempt: 1,
    name: 'test (ubuntu)',
    state: 'passed',
    completed: true,
    steps: [],
    htmlUrl: 'https://github.com/acme/orbit/actions/runs/10/job/1',
    ...overrides,
  };
}

function line(n: number, overrides: Partial<LogLine> = {}): LogLine {
  return { n, text: `line ${n}`, kind: 'plain', ...overrides };
}

describe('checkCountLine', () => {
  it('joins non-zero terms in the fixed order, dropping zero ones', () => {
    expect(
      checkCountLine([check({ state: 'passed' }), check({ state: 'passed' }), check({ state: 'passed' }), check({ state: 'failed' }), check({ state: 'pending' })]),
    ).toBe('3 passed · 1 failed · 1 running');
  });

  it('is empty for an empty list', () => {
    expect(checkCountLine([])).toBe('');
  });

  it('includes skipped last', () => {
    expect(checkCountLine([check({ state: 'skipped' }), check({ state: 'passed' })])).toBe('1 passed · 1 skipped');
  });
});

describe('checkRowOrder', () => {
  it('orders failed -> pending -> passed -> skipped, then by name', () => {
    const checks = [
      check({ name: 'z-skip', state: 'skipped' }),
      check({ name: 'b-passed', state: 'passed' }),
      check({ name: 'a-passed', state: 'passed' }),
      check({ name: 'c-pending', state: 'pending' }),
      check({ name: 'd-failed', state: 'failed' }),
    ];
    expect(checkRowOrder(checks).map((c) => c.name)).toEqual(['d-failed', 'c-pending', 'a-passed', 'b-passed', 'z-skip']);
  });

  it('does not mutate the input array', () => {
    const checks = [check({ name: 'b' }), check({ name: 'a' })];
    const sorted = checkRowOrder(checks);
    expect(sorted).not.toBe(checks);
    expect(checks.map((c) => c.name)).toEqual(['b', 'a']);
  });
});

describe('checkKey', () => {
  it('keys an Actions job by jobId, everything else by name', () => {
    expect(checkKey({ jobId: 42, name: 'lint' })).toBe('job:42');
    expect(checkKey({ name: 'lint' })).toBe('name:lint');
  });
});

describe('currentStep', () => {
  it('prefers the first running step', () => {
    const j = job({ steps: [step({ number: 1, state: 'passed' }), step({ number: 2, state: 'running' }), step({ number: 3, state: 'queued' })] });
    expect(currentStep(j)?.number).toBe(2);
  });

  it('falls back to the first queued step', () => {
    const j = job({ steps: [step({ number: 1, state: 'passed' }), step({ number: 2, state: 'queued' })] });
    expect(currentStep(j)?.number).toBe(2);
  });

  it('is undefined with nothing running or queued', () => {
    expect(currentStep(job({ steps: [step({ state: 'passed' })] }))).toBeUndefined();
  });
});

describe('firstFailedStep', () => {
  it('finds the first failed step', () => {
    const j = job({ steps: [step({ number: 1, state: 'passed' }), step({ number: 2, state: 'failed' })] });
    expect(firstFailedStep(j)?.number).toBe(2);
  });
});

describe('canOpenStep', () => {
  it('is false while the job is not completed', () => {
    expect(canOpenStep(job({ completed: false }), step({ state: 'passed' }))).toBe(false);
  });

  it('is false for skipped or queued steps', () => {
    expect(canOpenStep(job({ completed: true }), step({ state: 'skipped' }))).toBe(false);
    expect(canOpenStep(job({ completed: true }), step({ state: 'queued' }))).toBe(false);
  });

  it('is true for a finished step of a completed job', () => {
    expect(canOpenStep(job({ completed: true }), step({ state: 'failed' }))).toBe(true);
  });
});

describe('foldGroups', () => {
  it('drops debug lines', () => {
    const items = foldGroups([line(1, { kind: 'debug' }), line(2)]);
    expect(items).toEqual([{ kind: 'line', line: line(2) }]);
  });

  it('folds a group span into one closed-by-default item', () => {
    const lines = [line(1, { kind: 'groupStart', text: 'Run npm test' }), line(2), line(3), line(4, { kind: 'groupEnd', text: '' })];
    const items = foldGroups(lines);
    expect(items).toEqual([
      { kind: 'group', title: 'Run npm test', startN: 1, endN: 4, lines: [line(2), line(3)], collapsedByDefault: true },
    ]);
  });

  it('opens by default the group containing firstErrorLine', () => {
    const lines = [line(1, { kind: 'groupStart', text: 'Run npm test' }), line(2, { kind: 'error' }), line(3, { kind: 'groupEnd' })];
    const items = foldGroups(lines, 2);
    expect(items).toEqual([{ kind: 'group', title: 'Run npm test', startN: 1, endN: 3, lines: [line(2, { kind: 'error' })], collapsedByDefault: false }]);
  });

  it('handles an unterminated group by closing it at the last line', () => {
    const lines = [line(1, { kind: 'groupStart', text: 'Run npm test' }), line(2), line(3)];
    const items = foldGroups(lines);
    expect(items).toEqual([{ kind: 'group', title: 'Run npm test', startN: 1, endN: 3, lines: [line(2), line(3)], collapsedByDefault: true }]);
  });

  it('ignores a stray groupEnd with no matching start', () => {
    const lines = [line(1), line(2, { kind: 'groupEnd' })];
    expect(foldGroups(lines)).toEqual([{ kind: 'line', line: line(1) }]);
  });
});

describe('failureExcerpt', () => {
  function log(overrides: Partial<StepLog> = {}): Pick<StepLog, 'lines' | 'firstErrorLine'> {
    return { lines: [], firstErrorLine: undefined, ...overrides };
  }

  it('is empty for an empty log', () => {
    expect(failureExcerpt(log())).toBe('');
  });

  it('takes the last maxLines lines when there is no firstErrorLine', () => {
    const lines = Array.from({ length: 5 }, (_, i) => line(i + 1));
    expect(failureExcerpt(log({ lines }), 3)).toBe('line 3\nline 4\nline 5');
  });

  it('ends 10 lines after firstErrorLine, capped at maxLines', () => {
    const lines = Array.from({ length: 30 }, (_, i) => line(i + 1));
    // firstErrorLine 15 -> window ends at n=25, last 5 of that window is 21..25
    expect(failureExcerpt(log({ lines, firstErrorLine: 15 }), 5)).toBe('line 21\nline 22\nline 23\nline 24\nline 25');
  });
});

describe('rerunTargets', () => {
  it('offers a runId with a failed check once every check on it is non-pending', () => {
    const checks = [check({ name: 'lint', state: 'failed', runId: 10 }), check({ name: 'unit', state: 'passed', runId: 10 })];
    expect(rerunTargets(checks)).toEqual([{ runId: 10, names: ['lint'] }]);
  });

  it('withholds a runId while any of its checks is still pending', () => {
    const checks = [check({ name: 'lint', state: 'failed', runId: 10 }), check({ name: 'unit', state: 'pending', runId: 10 })];
    expect(rerunTargets(checks)).toEqual([]);
  });

  it('ignores checks with no runId and runs with no failure', () => {
    const checks = [check({ name: 'status', state: 'failed' }), check({ name: 'lint', state: 'passed', runId: 11 })];
    expect(rerunTargets(checks)).toEqual([]);
  });
});

describe('pollingActive', () => {
  it('is true only when there is something pending and the view is visible', () => {
    expect(pollingActive(true, true)).toBe(true);
    expect(pollingActive(true, false)).toBe(false);
    expect(pollingActive(false, true)).toBe(false);
  });
});

describe('nextPollDelayMs', () => {
  it('backs off to 60s after two consecutive failures', () => {
    expect(nextPollDelayMs(10_000, 0)).toBe(10_000);
    expect(nextPollDelayMs(10_000, 1)).toBe(10_000);
    expect(nextPollDelayMs(10_000, 2)).toBe(60_000);
    expect(nextPollDelayMs(10_000, 5)).toBe(60_000);
  });
});
