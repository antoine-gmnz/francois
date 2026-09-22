import { describe, expect, it } from 'vitest';
import type { AgentInfo, WorkflowRun } from '../../../contract/common';
import { activityElapsed, groupActivity, stoppableIds } from './activity-section';

const agent = (id: string, status: AgentInfo['status'], startedAt: number, extra: Partial<AgentInfo> = {}): AgentInfo => ({
  id,
  sessionId: 's',
  name: id,
  task: `${id} task`,
  status,
  startedAt,
  background: false,
  stepCount: 0,
  ...extra,
});

const run = (id: string, status: WorkflowRun['status'], startedAt: number, extra: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id,
  sessionId: 's',
  name: id,
  description: '',
  status,
  startedAt,
  phases: [],
  ...extra,
});

describe('groupActivity', () => {
  it('splits live from finished across subagents and workflows', () => {
    const g = groupActivity(
      [agent('a', 'running', 30), agent('b', 'done', 1, { endedAt: 50 }), agent('c', 'idle', 10)],
      [run('w', 'running', 20), run('x', 'error', 2, { endedAt: 60 })],
    );
    expect(g.running.map((i) => i.id)).toEqual(['c', 'w', 'a']);
    expect(g.finished.map((i) => i.id)).toEqual(['x', 'b']);
  });

  it('reads the newest activity, falling back to the task', () => {
    const g = groupActivity([agent('a', 'running', 0, { lastActivity: 'Reading x.ts' }), agent('b', 'running', 1)], []);
    expect(g.running.map((i) => i.line)).toEqual(['Reading x.ts', 'b task']);
  });

  it('marks a workflow waiting on an ask, lists its phases, and opens it only with a transcript dir', () => {
    const g = groupActivity([], [
      run('w', 'running', 0, { pendingAsks: 1, phases: [{ title: 'Explore' }, { title: 'Verify' }] }),
      run('v', 'running', 1, { transcriptDir: '/tmp/wf', lastActivity: '4 findings' }),
    ]);
    expect(g.running[0]).toMatchObject({ line: 'waiting on you', phases: ['Explore', 'Verify'], openable: false, stoppable: false });
    expect(g.running[1]).toMatchObject({ line: '4 findings', openable: true });
  });

  it('stops only running subagents', () => {
    const g = groupActivity([agent('a', 'running', 0), agent('b', 'idle', 1)], [run('w', 'running', 2)]);
    expect(stoppableIds(g)).toEqual(['a']);
  });
});

describe('activityElapsed', () => {
  it('runs against now while live and freezes at the end', () => {
    expect(activityElapsed({ startedAt: 0 }, 152_000)).toBe('02:32');
    expect(activityElapsed({ startedAt: 0, endedAt: 48_000 }, 999_000)).toBe('00:48');
  });
});
