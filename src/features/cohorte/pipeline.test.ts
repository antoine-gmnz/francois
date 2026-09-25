import { describe, expect, it } from 'vitest';
import type { CohorteFeatureChoice } from '../../../contract/cohorte-actions';
import type { CohorteRun } from '../../../contract/cohorte-integration';
import { derivePipeline } from './pipeline';

function feature(over: Partial<CohorteFeatureChoice> & { id: string }): CohorteFeatureChoice {
  return { title: over.id, status: 'draft', kind: 'feature', updatedAt: 0, ...over };
}

function run(over: Partial<CohorteRun> & { runId: string; specId: string; view: CohorteRun['view'] }): CohorteRun {
  return {
    projectRoot: '/root',
    title: over.specId,
    profile: 'default' as never,
    state: 'RUNNING' as never,
    since: 0,
    startedAt: 0,
    iteration: { fixRounds: 0, maxFixRounds: 0, reviewRounds: 0 },
    host: { alive: true },
    git: { baseBranch: 'main' },
    phases: [],
    worktrees: [],
    gate: null,
    review: null,
    artifacts: [],
    lastSequence: 0,
    tailTruncated: false,
    refreshedAt: 0,
    ...over,
  } as CohorteRun;
}

describe('derivePipeline stages (FR-61)', () => {
  it('a run with a pending gate → stage 4, attention, Answer gate', () => {
    const f = feature({ id: 'a' });
    const r = run({ runId: 'r1', specId: 'a', view: 'gate' });
    const [card] = derivePipeline([f], [r]);
    expect(card).toMatchObject({ stage: 4, stageLabel: 'run · gate', tone: 'attention', runId: 'r1', action: { id: 'answer-gate', label: 'Answer gate', ghost: false } });
  });

  it('a running run → stage 4, running tone, Open run (not ghost)', () => {
    const f = feature({ id: 'a' });
    const r = run({ runId: 'r1', specId: 'a', view: 'running' });
    const [card] = derivePipeline([f], [r]);
    expect(card).toMatchObject({ stage: 4, stageLabel: 'run', tone: 'running', action: { id: 'open-run', ghost: false } });
  });

  it('a completed run → stage 5 shipped, success, Open run ghost', () => {
    const f = feature({ id: 'a' });
    const r = run({ runId: 'r1', specId: 'a', view: 'completed' });
    const [card] = derivePipeline([f], [r]);
    expect(card).toMatchObject({ stage: 5, stageLabel: 'shipped', tone: 'success', action: { id: 'open-run', ghost: true } });
  });

  it('a failed/cancelled/blocked run → stage 4 run · failed, danger, Open run ghost', () => {
    for (const view of ['failed', 'cancelled', 'blocked'] as const) {
      const f = feature({ id: 'a' });
      const r = run({ runId: 'r1', specId: 'a', view });
      const [card] = derivePipeline([f], [r]);
      expect(card).toMatchObject({ stage: 4, stageLabel: 'run · failed', tone: 'danger', action: { id: 'open-run', ghost: true } });
    }
  });

  it('no run, frozen/ready/approved → stage 3 frozen, Start run', () => {
    for (const status of ['frozen', 'ready', 'approved']) {
      const [card] = derivePipeline([feature({ id: 'a', status })], []);
      expect(card).toMatchObject({ stage: 3, stageLabel: 'frozen', tone: 'neutral', action: { id: 'start', label: 'Start run' } });
    }
  });

  it('no run, draft patch → stage 2 spec · draft, Write spec', () => {
    const [card] = derivePipeline([feature({ id: 'a', status: 'draft', kind: 'patch' })], []);
    expect(card).toMatchObject({ stage: 2, stageLabel: 'spec · draft', action: { id: 'write-spec', label: 'Write spec' } });
  });

  it('no run, other draft → stage 0 intake, Brainstorm', () => {
    const [card] = derivePipeline([feature({ id: 'a', status: 'draft', kind: 'feature' })], []);
    expect(card).toMatchObject({ stage: 0, stageLabel: 'intake', action: { id: 'brainstorm', label: 'Brainstorm' } });
  });

  it('no run, anything else → stage 2 + raw status', () => {
    const [card] = derivePipeline([feature({ id: 'a', status: 'questions' })], []);
    expect(card).toMatchObject({ stage: 2, stageLabel: 'questions' });
  });

  it('picks the LATEST run by startedAt when several exist for the same feature', () => {
    const f = feature({ id: 'a' });
    const old = run({ runId: 'r1', specId: 'a', view: 'failed', startedAt: 1 });
    const fresh = run({ runId: 'r2', specId: 'a', view: 'running', startedAt: 2 });
    const [card] = derivePipeline([f], [old, fresh]);
    expect(card.runId).toBe('r2');
    expect(card.stageLabel).toBe('run');
  });
});

describe('derivePipeline ordering (FR-61)', () => {
  it('orders gate, then running, then everything else by updatedAt desc, shipped last', () => {
    const gate = feature({ id: 'gate-one', updatedAt: 1 });
    const running = feature({ id: 'running-one', updatedAt: 1 });
    const oldOther = feature({ id: 'old-other', status: 'frozen', updatedAt: 10 });
    const newOther = feature({ id: 'new-other', status: 'frozen', updatedAt: 20 });
    const shipped = feature({ id: 'shipped-one', updatedAt: 1 });
    const runs = [
      run({ runId: 'g', specId: 'gate-one', view: 'gate' }),
      run({ runId: 'r', specId: 'running-one', view: 'running' }),
      run({ runId: 's', specId: 'shipped-one', view: 'completed' }),
    ];
    const cards = derivePipeline([oldOther, shipped, newOther, running, gate], runs);
    expect(cards.map((c) => c.featureId)).toEqual(['gate-one', 'running-one', 'new-other', 'old-other', 'shipped-one']);
  });
});
