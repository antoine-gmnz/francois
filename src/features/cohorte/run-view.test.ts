import { describe, expect, it } from 'vitest';
import type { CohorteRunView } from '../../../contract/cohorte-integration';
import { gate, phase, request, run, RUN_ID, step } from '../../lib/cohorte.testutil';
import {
  authHint,
  donePhaseCount,
  formatClock,
  formatDuration,
  headerStateChip,
  hostDead,
  orderedSteps,
  panelSummary,
  phaseBarTone,
  phaseMeta,
  policyLine,
  runControls,
  runtimeLine,
  runViewChip,
  shortDigest,
  shortRunId,
  statusGlyph,
  stepDurationMs,
  stepStateLabel,
} from './run-view';

const PHASES = [
  phase('SPEC', { status: 'completed', durationMs: 72_000 }),
  phase('BUILD', { status: 'running', startedAt: 10_000 }),
  phase('REVIEW', { status: 'pending' }),
  phase('FIX'),
  phase('SHIP'),
];

describe('shortRunId', () => {
  it('is run_ + 6 hex', () => expect(shortRunId(RUN_ID)).toBe('run_7fa3c1'));
});

describe('headerStateChip (FR-60)', () => {
  it('replaces the status pill only for a gate', () => {
    expect(headerStateChip({ view: 'gate' })).toMatchObject({ label: 'Gate · needs your verdict', tone: 'attention', replacesStatus: true });
    expect(headerStateChip({ view: 'paused' })).toMatchObject({ label: 'Run paused', tone: 'neutral', replacesStatus: false });
    expect(headerStateChip({ view: 'auth' })?.label).toBe('Cohorte needs login');
    expect(headerStateChip({ view: 'quota' })?.label).toBe('Cohorte quota reached');
    expect(headerStateChip({ view: 'failed' })).toMatchObject({ label: 'Run failed', tone: 'danger' });
    expect(headerStateChip({ view: 'blocked' })).toMatchObject({ label: 'Run blocked', tone: 'danger' });
    for (const view of ['running', 'completed', 'cancelled', 'idle', 'waiting'] as const) expect(headerStateChip({ view })).toBeNull();
  });
});

describe('runViewChip (FR-71)', () => {
  it('reads running as Running · <verb>, completed as Shipped/Completed', () => {
    expect(runViewChip({ view: 'running', currentPhase: 'BUILD' }).label).toBe('Running · Building');
    expect(runViewChip({ view: 'completed', stop: { reason: 'review-clean', detail: '', resumable: false } }).label).toBe('Shipped');
    expect(runViewChip({ view: 'completed', stop: { reason: 'iteration-limit', detail: '', resumable: false } }).label).toBe('Completed');
    expect(runViewChip({ view: 'gate' }).label).toBe('Gate · needs your verdict');
    expect(runViewChip({ view: 'cancelled' }).label).toBe('Cancelled');
  });
});

describe('panelSummary for every CohorteRunView (FR-67, AC-23)', () => {
  const cases: [CohorteRunView, Parameters<typeof run>[0], string][] = [
    ['gate', { gate: gate() }, 'Waiting at the review verdict gate'],
    ['running', { phases: PHASES, currentPhase: 'BUILD' }, 'Building · phase 2 of 5'],
    ['paused', {}, 'Paused'],
    ['auth', {}, 'Needs login'],
    ['quota', {}, 'Quota reached'],
    ['failed', { stop: { reason: 'agent-dead', detail: '', resumable: true } }, 'Failed · agent-dead'],
    ['blocked', {}, 'Blocked'],
    ['completed', {}, 'Shipped'],
    ['cancelled', {}, 'Cancelled'],
    ['waiting', {}, 'Waiting for approval'],
    ['idle', {}, 'Idle'],
  ];
  it.each(cases)('%s', (view, over, text) => {
    expect(panelSummary(run({ ...over, view })).text).toBe(text);
  });
  it('drops the phase index when the current phase is unknown', () => {
    expect(panelSummary(run({ view: 'running', currentPhase: 'TEST', phases: PHASES })).text).toBe('Testing');
  });
});

describe('phase meta, glyph and bar (FR-68/FR-72)', () => {
  const r = run({ phases: PHASES, view: 'running' });
  it('panel: live mm:ss while running, m:ss duration when done, — when pending', () => {
    expect(phaseMeta(r, PHASES[1], 171_000, false)).toEqual({ text: '02:41', live: true });
    expect(phaseMeta(r, PHASES[0], 0, false)).toEqual({ text: '1:12', live: false });
    expect(phaseMeta(r, PHASES[3], 0, false)).toEqual({ text: '—', live: false });
  });
  it('timeline: done / elapsed without a live clock', () => {
    expect(phaseMeta(r, PHASES[0], 0, true).text).toBe('done');
    expect(phaseMeta(r, PHASES[1], 171_000, true)).toEqual({ text: '2:41', live: false });
  });
  it('the gate phase reads waiting and takes the attention bar', () => {
    const gated = run({ phases: PHASES, view: 'gate', gate: gate({ request: request({ phase: { phaseRunId: 'p', state: 'REVIEW', iteration: 1 } }) }) });
    expect(phaseMeta(gated, PHASES[2], 0, false).text).toBe('waiting');
    expect(phaseBarTone(gated, PHASES[2])).toBe('attention');
    expect(phaseMeta(run({ phases: PHASES }), phase('X', { status: 'waiting-approval' }), 0, true).text).toBe('waiting');
  });
  it('bars and glyphs by status', () => {
    expect(phaseBarTone(r, PHASES[0])).toBe('success');
    expect(phaseBarTone(r, PHASES[1])).toBe('running');
    expect(phaseBarTone(r, phase('X', { status: 'failed' }))).toBe('danger');
    expect(phaseBarTone(r, PHASES[4])).toBe('idle');
    expect(statusGlyph('completed')).toBe('done');
    expect(statusGlyph('waiting-approval')).toBe('approval');
    expect(statusGlyph('blocked')).toBe('failed');
    expect(statusGlyph('skipped')).toBe('pending');
    expect(donePhaseCount(PHASES)).toBe(1);
  });
});

describe('steps (FR-73)', () => {
  it('words every status', () => {
    expect(['completed', 'running', 'pending', 'failed', 'waiting-approval', 'paused', 'cancelled', 'blocked', 'skipped', 'zany'].map(stepStateLabel)).toEqual([
      'Done', 'Running', 'Pending', 'Failed', 'Waiting', 'Paused', 'Cancelled', 'Blocked', 'Skipped', 'zany',
    ]);
  });
  it('orders by phase then start, and times running steps live', () => {
    const r = run({ phases: [phase('BUILD', { steps: [step({ agentId: 'b', startedAt: 5 }), step({ agentId: 'a', startedAt: 2 })] }), phase('TEST', { steps: [step({ agentId: 'c' })] })] });
    expect(orderedSteps(r).map((s) => s.agentId)).toEqual(['a', 'b', 'c']);
    expect(stepDurationMs({ status: 'running', startedAt: 1_000 }, 4_000)).toBe(3_000);
    expect(stepDurationMs({ status: 'completed', durationMs: 7 }, 0)).toBe(7);
    expect(stepDurationMs({ status: 'pending' }, 0)).toBeNull();
  });
});

describe('controls, host, footer lines', () => {
  it('offers pause or resume by view, nothing when terminal', () => {
    expect(runControls('running')).toEqual({ pause: true, resume: false, cancel: true });
    expect(runControls('paused')).toEqual({ pause: false, resume: true, cancel: true });
    expect(runControls('completed')).toEqual({ pause: false, resume: false, cancel: false });
  });
  it('flags a dead host only on a live run', () => {
    expect(hostDead({ view: 'running', host: { alive: false } })).toBe(true);
    expect(hostDead({ view: 'completed', host: { alive: false } })).toBe(false);
  });
  it('formats the runtime, digest and policy lines', () => {
    expect(runtimeLine({ runtime: { id: 'Pi', version: '1', pinDigest: 'x' } })).toBe('Pi runtime · snapshot pinned');
    expect(runtimeLine({})).toBeNull();
    expect(shortDigest('sha256:2f19c4ab')).toBe('2f19c4');
    expect(policyLine(['ship', 'push', 'secrets'])).toBe('gates on ship + push');
    expect(policyLine([])).toBeNull();
    expect(formatDuration(3_725_000)).toBe('1:02:05');
    expect(formatClock(65_000)).toBe('01:05');
  });
});

describe('authHint (R2-7)', () => {
  it("uses the event's cli, else falls back to cohorte auth login", () => {
    expect(authHint('cohorte auth login pi')).toBe('cohorte auth login pi');
    expect(authHint(undefined)).toBe('cohorte auth login');
    expect(authHint('  ')).toBe('cohorte auth login');
  });
});
