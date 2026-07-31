import { describe, expect, it } from 'vitest';
import type { WorkflowRun } from '../../../contract/common';
import {
  activityText,
  applyRunUpdate,
  orderedRuns,
  phaseCountLabel,
  resolveWorkflowKeyAction,
  seedRuns,
} from './workflow-run';

function run(over: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 'w1',
    sessionId: 's1',
    name: 'review-changes',
    description: 'Review changed files across dimensions',
    status: 'running',
    startedAt: 1_000,
    phases: [{ title: 'Review' }, { title: 'Verify', detail: 'adversarial' }],
    ...over,
  };
}

function mapOf(...runs: WorkflowRun[]): Map<string, WorkflowRun> {
  return new Map(runs.map((r) => [r.id, r]));
}

describe('orderedRuns', () => {
  it('floats running runs above finished ones', () => {
    const list = orderedRuns(
      mapOf(run({ id: 'a', status: 'done' }), run({ id: 'b', status: 'running' }), run({ id: 'c', status: 'error' })),
    );
    expect(list.map((r) => r.id)).toEqual(['b', 'a', 'c']);
  });

  it('keeps first-seen order within a rank', () => {
    const list = orderedRuns(mapOf(run({ id: 'a' }), run({ id: 'b' }), run({ id: 'c' })));
    expect(list.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('phaseCountLabel', () => {
  it('counts declared phases, singular and plural', () => {
    expect(phaseCountLabel(run())).toBe('2 phases');
    expect(phaseCountLabel(run({ phases: [{ title: 'Scan' }] }))).toBe('1 phase');
  });

  it('is absent when the dispatch declared none — never a fabricated 0', () => {
    expect(phaseCountLabel(run({ phases: [] }))).toBeNull();
  });
});

describe('activityText', () => {
  it('prefers the core-derived last activity', () => {
    expect(activityText(run({ lastActivity: 'running in the background' }))).toBe('running in the background');
  });

  it('falls back to dispatched while running, and to the status once finished', () => {
    expect(activityText(run())).toBe('dispatched');
    expect(activityText(run({ status: 'done', lastActivity: '' }))).toBe('done');
  });
});

describe('resolveWorkflowKeyAction', () => {
  const list = [run({ id: 'a' }), run({ id: 'b' })];

  it('ArrowDown from nothing selected lands on the first row', () => {
    expect(resolveWorkflowKeyAction('ArrowDown', { list, selectedId: null })).toEqual({ kind: 'select', id: 'a' });
  });

  it('clamps at both ends', () => {
    expect(resolveWorkflowKeyAction('ArrowDown', { list, selectedId: 'b' })).toEqual({ kind: 'select', id: 'b' });
    expect(resolveWorkflowKeyAction('ArrowUp', { list, selectedId: 'a' })).toEqual({ kind: 'select', id: 'a' });
  });

  it('Enter toggles the selected card, and is inert with no selection', () => {
    expect(resolveWorkflowKeyAction('Enter', { list, selectedId: 'b' })).toEqual({ kind: 'toggle', id: 'b' });
    expect(resolveWorkflowKeyAction('Enter', { list, selectedId: null })).toEqual({ kind: 'none' });
  });

  it('ignores every other key, and any key with an empty list', () => {
    expect(resolveWorkflowKeyAction('x', { list, selectedId: 'a' })).toEqual({ kind: 'none' });
    expect(resolveWorkflowKeyAction('ArrowDown', { list: [], selectedId: null })).toEqual({ kind: 'none' });
  });
});

describe('applyRunUpdate / seedRuns', () => {
  it('replaces a run in place, keeping its position', () => {
    const prev = mapOf(run({ id: 'a' }), run({ id: 'b' }));
    const next = applyRunUpdate(prev, run({ id: 'a', status: 'done', endedAt: 4_000 }));
    expect([...next.keys()]).toEqual(['a', 'b']);
    expect(next.get('a')?.status).toBe('done');
    expect(prev.get('a')?.status).toBe('running'); // never mutates
  });

  it('seeds only ids a pre-hydration event has not already applied', () => {
    const prev = mapOf(run({ id: 'a', status: 'done' }));
    const next = seedRuns(prev, [run({ id: 'a' }), run({ id: 'b' })]);
    expect(next.get('a')?.status).toBe('done'); // the live event wins
    expect(next.has('b')).toBe(true);
  });
});
