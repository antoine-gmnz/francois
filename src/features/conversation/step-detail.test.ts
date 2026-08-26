import { describe, expect, it } from 'vitest';
import type { StepDetail, StepOutput } from '../../../contract/command-inspect';
import {
  formatStepClock,
  formatStepDuration,
  splitOutputLines,
  stepHeaderGroups,
  stepOutcome,
  stepOutputFooter,
  stepOutputTotals,
  stepRuntimeLabel,
  visibleStepOutputLines,
} from './step-detail';

const STARTED_AT = new Date(2026, 0, 1, 12, 6, 41).getTime();

function baseDetail(overrides: Partial<StepDetail> = {}): StepDetail {
  return {
    blockId: 'block-1',
    tool: 'Bash',
    cwd: '/repo',
    runtime: 'native',
    startedAt: STARTED_AT,
    endedAt: STARTED_AT + 4200,
    isError: false,
    body: { kind: 'command', command: { command: 'npm test' }, output: emptyOutput() },
    ...overrides,
  };
}

function emptyOutput(overrides: Partial<StepOutput> = {}): StepOutput {
  return { text: '', totalLines: 0, totalBytes: 0, droppedLines: 0, ...overrides };
}

describe('formatStepClock', () => {
  it('renders zero-padded HH:MM:SS local time', () => {
    const d = new Date();
    d.setHours(9, 6, 1, 0);
    expect(formatStepClock(d.getTime())).toBe('09:06:01');
  });
});

describe('formatStepDuration', () => {
  it('renders one decimal of seconds under a minute', () => {
    expect(formatStepDuration(4200)).toBe('4.2s');
    expect(formatStepDuration(0)).toBe('0.0s');
    expect(formatStepDuration(999)).toBe('1.0s');
  });

  it('drops a zero seconds remainder at or above a minute', () => {
    expect(formatStepDuration(120_000)).toBe('2m');
    expect(formatStepDuration(112_000)).toBe('1m 52s');
  });

  it('drops a zero minutes remainder at or above an hour', () => {
    expect(formatStepDuration(3_600_000)).toBe('1h');
    expect(formatStepDuration(3_600_000 + 60_000)).toBe('1h 1m');
  });

  it('clamps a negative span to zero', () => {
    expect(formatStepDuration(-500)).toBe('0.0s');
  });
});

describe('stepRuntimeLabel', () => {
  it('is null on native', () => {
    expect(stepRuntimeLabel('native')).toBeNull();
  });

  it('includes the distro when present on wsl', () => {
    expect(stepRuntimeLabel('wsl', 'Ubuntu-22.04')).toBe('wsl · Ubuntu-22.04');
  });

  it('is bare "wsl" when the distro could not be derived', () => {
    expect(stepRuntimeLabel('wsl')).toBe('wsl');
  });
});

describe('stepOutcome', () => {
  it('prefers exit N when an exit code is known', () => {
    expect(stepOutcome({ isError: true, exitCode: 1 })).toBe('exit 1');
    expect(stepOutcome({ isError: false, exitCode: 0 })).toBe('exit 0');
  });

  it('falls back to "failed" when errored without a code', () => {
    expect(stepOutcome({ isError: true })).toBe('failed');
  });

  it('is null on a clean success', () => {
    expect(stepOutcome({ isError: false })).toBeNull();
  });
});

describe('stepHeaderGroups', () => {
  it('splits every present field into the left/right groups, in order, tool tinted `tool` and outcome tinted `outcome`', () => {
    const detail = baseDetail({ runtime: 'wsl', distro: 'Ubuntu-22.04', isError: true });
    expect(stepHeaderGroups(detail)).toEqual({
      left: [
        { text: 'bash', tone: 'tool' },
        { text: '/repo', tone: 'plain' },
        { text: 'wsl · Ubuntu-22.04', tone: 'plain' },
      ],
      right: [
        { text: '12:06:41', tone: 'plain' },
        { text: '4.2s', tone: 'plain' },
        { text: 'failed', tone: 'outcome' },
      ],
    });
  });

  it('lowercases the tool name', () => {
    expect(stepHeaderGroups(baseDetail({ tool: 'Edit' })).left[0]).toEqual({ text: 'edit', tone: 'tool' });
  });

  it('omits runtime on native', () => {
    const detail = baseDetail({ runtime: 'native' });
    expect(stepHeaderGroups(detail).left).toEqual([
      { text: 'bash', tone: 'tool' },
      { text: '/repo', tone: 'plain' },
    ]);
  });

  it('omits duration when endedAt is absent', () => {
    const detail = baseDetail({ endedAt: undefined });
    expect(stepHeaderGroups(detail).right).toEqual([{ text: '12:06:41', tone: 'plain' }]);
  });

  it('omits outcome on a clean success', () => {
    const detail = baseDetail({ isError: false, exitCode: undefined });
    expect(stepHeaderGroups(detail).right).toEqual([
      { text: '12:06:41', tone: 'plain' },
      { text: '4.2s', tone: 'plain' },
    ]);
  });
});

describe('stepOutputTotals', () => {
  it('states lines and formatted bytes', () => {
    expect(stepOutputTotals(emptyOutput({ totalLines: 214, totalBytes: 8100 }))).toBe('output · 214 lines · 8 KB');
  });

  it('appends the stderr chip only when the runtime separated the streams and it is non-zero', () => {
    expect(stepOutputTotals(emptyOutput({ totalLines: 1, totalBytes: 10, stderrLines: 12 }))).toBe(
      'output · 1 lines · 10 B · 12 on stderr',
    );
    expect(stepOutputTotals(emptyOutput({ totalLines: 1, totalBytes: 10, stderrLines: 0 }))).toBe('output · 1 lines · 10 B');
    expect(stepOutputTotals(emptyOutput({ totalLines: 1, totalBytes: 10 }))).toBe('output · 1 lines · 10 B');
  });
});

describe('splitOutputLines', () => {
  it('is empty for an empty string', () => {
    expect(splitOutputLines('')).toEqual([]);
  });

  it('splits on newlines', () => {
    expect(splitOutputLines('a\nb\nc')).toEqual(['a', 'b', 'c']);
  });
});

describe('visibleStepOutputLines', () => {
  const many = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');

  it('returns everything when at or under the tail cap', () => {
    const output = emptyOutput({ text: 'a\nb\nc' });
    expect(visibleStepOutputLines(output, false)).toEqual(['a', 'b', 'c']);
  });

  it('folds to the last 15 lines when over the cap and not shown all', () => {
    const output = emptyOutput({ text: many });
    const visible = visibleStepOutputLines(output, false);
    expect(visible).toHaveLength(15);
    expect(visible[0]).toBe('line 5');
    expect(visible[visible.length - 1]).toBe('line 19');
  });

  it('reveals everything once showAll is true', () => {
    const output = emptyOutput({ text: many });
    expect(visibleStepOutputLines(output, true)).toHaveLength(20);
  });
});

describe('stepOutputFooter', () => {
  const many = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');

  it('is null when nothing is folded and nothing was dropped', () => {
    expect(stepOutputFooter(emptyOutput({ text: 'a\nb' }), false)).toBeNull();
  });

  it('reads "folded" with a show-all link while more of the slice is hidden', () => {
    expect(stepOutputFooter(emptyOutput({ text: many }), false)).toEqual({ kind: 'folded', count: 5, showAllLink: true });
  });

  it('disappears once show all has revealed the whole slice (no drop)', () => {
    expect(stepOutputFooter(emptyOutput({ text: many }), true)).toBeNull();
  });

  it('reads "dropped at capture" whenever droppedLines > 0, regardless of local fold state', () => {
    expect(stepOutputFooter(emptyOutput({ text: 'a\nb', droppedLines: 27 }), false)).toEqual({
      kind: 'dropped',
      count: 27,
      showAllLink: false,
    });
  });

  it('keeps the dropped message after show all, but drops the now-pointless show-all link', () => {
    expect(stepOutputFooter(emptyOutput({ text: many, droppedLines: 27 }), true)).toEqual({
      kind: 'dropped',
      count: 27,
      showAllLink: false,
    });
  });

  it('still offers show all alongside the dropped message when local folding also applies', () => {
    expect(stepOutputFooter(emptyOutput({ text: many, droppedLines: 27 }), false)).toEqual({
      kind: 'dropped',
      count: 27,
      showAllLink: true,
    });
  });
});
