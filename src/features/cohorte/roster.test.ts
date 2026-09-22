import { describe, expect, it } from 'vitest';
import type { CohorteSessionLink } from '../../../contract/cohorte-integration';
import { gate, run, RUN_ID } from '../../lib/cohorte.testutil';
import { nestNodes, nestRows, planRoster } from './roster';

const link = (sessionId: string, role: 'origin' | 'step', reason: CohorteSessionLink['reason'] = role === 'origin' ? 'launched' : 'worktree'): CohorteSessionLink => ({
  sessionId,
  projectRoot: '/code/orbit',
  runId: RUN_ID,
  reason,
  role,
});
const on = { gatesInNeedsYou: true, groupSessionsUnderRun: true };
const sessions = [{ id: 'origin' }, { id: 'other' }, { id: 'step' }];

describe('planRoster (FR-85)', () => {
  const gated = run({ view: 'gate', gate: gate() });

  it('puts a gated run origin in NEEDS YOU', () => {
    const plan = planRoster(sessions, [gated], [link('origin', 'origin')], on);
    expect([...plan.gated.keys()]).toEqual(['origin']);
    expect(plan.orphanGates).toEqual([]);
  });
  it('makes a run row for a gated run with no origin in scope', () => {
    expect(planRoster([{ id: 'other' }], [gated], [link('origin', 'origin')], on).orphanGates).toHaveLength(1);
    expect(planRoster(sessions, [gated], [], on).orphanGates).toHaveLength(1);
  });
  it('changes nothing when the pref is off or no gate is pending', () => {
    const off = planRoster(sessions, [gated], [link('origin', 'origin')], { ...on, gatesInNeedsYou: false });
    expect(off.gated.size).toBe(0);
    expect(off.orphanGates).toEqual([]);
    expect(planRoster(sessions, [run()], [link('origin', 'origin')], on).gated.size).toBe(0);
  });
});

describe('nestRows (FR-86)', () => {
  const links = [link('origin', 'origin'), link('step', 'step')];

  it('moves step sessions directly after their origin, indented', () => {
    const plan = planRoster(sessions, [run()], links, on);
    const rows = nestRows(sessions, plan, () => RUN_ID);
    expect(rows.map((r) => [r.session.id, r.nested])).toEqual([
      ['origin', false],
      ['step', true],
      ['other', false],
    ]);
  });
  it('tags a step whose origin is in another group', () => {
    const plan = planRoster(sessions, [run()], links, on);
    const rows = nestRows([{ id: 'step' }], plan, () => RUN_ID);
    expect(rows).toEqual([{ session: { id: 'step' }, nested: false, runTag: 'run_7fa3c1' }]);
  });
  it('leaves rows unchanged when grouping is off', () => {
    const plan = planRoster(sessions, [run()], links, { ...on, groupSessionsUnderRun: false });
    expect(nestRows(sessions, plan, () => RUN_ID).map((r) => r.session.id)).toEqual(['origin', 'other', 'step']);
  });
});

describe('nestNodes (FR-86 over state nodes)', () => {
  it('reorders node and tier sessions and reports the marks', () => {
    const links = [link('origin', 'origin'), link('step', 'step')];
    const plan = planRoster(sessions, [run()], links, on);
    const nodes = [
      { key: 'a', sessions: [{ id: 'step' }, { id: 'origin' }] },
      { key: 'b', sessions: [{ id: 'step' }], tiers: [{ sessions: [{ id: 'step' }] }] },
    ];
    const out = nestNodes(nodes, plan, () => RUN_ID);
    expect(out.nodes[0].sessions.map((s) => s.id)).toEqual(['origin', 'step']);
    expect(out.nested.has('step')).toBe(true);
    expect(out.runTags.get('step')).toBe('run_7fa3c1');
    expect(out.nodes[1].tiers?.[0].sessions.map((s) => s.id)).toEqual(['step']);
  });
});
