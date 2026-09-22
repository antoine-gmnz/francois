import { describe, expect, it } from 'vitest';
import type { CohorteDetection, CohorteRun } from '../../../contract/cohorte-integration';
import { detection, phase, run, step } from '../../lib/cohorte.testutil';
import {
  computeLinks,
  detectionFor,
  linkForSession,
  normalisePath,
  originSessionId,
  runMatchesRef,
  sessionAtPath,
  stepSessionIds,
  type LinkSession,
} from './linkage';

const ROOT = '/code/orbit';
const detections = (extra: Record<string, CohorteDetection> = {}): Record<string, CohorteDetection> => ({
  [ROOT]: detection(),
  '/code/orbit/services/api': detection({ startDir: '/code/orbit/services/api' }),
  '/code/orbit-auth': detection({ startDir: '/code/orbit-auth', foundVia: 'git-common-dir' }),
  ...extra,
});

const A = 'run_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const B = 'run_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function links(sessions: LinkSession[], runs: CohorteRun[], explicit: Record<string, string[]> = {}, ci = false, dets = detections()) {
  return computeLinks({ sessions, runs, detections: dets, explicitLinks: explicit, caseInsensitive: ci });
}

describe('computeLinks — the four rules (AC-21)', () => {
  it('1 launched: an explicit ref (full id or 10-char prefix) links as origin', () => {
    const s = { id: 's1', cwd: '/code/orbit/services/api' };
    expect(links([s], [run({ runId: A })], { s1: [A.slice(0, 10)] })[0]).toMatchObject({ runId: A, reason: 'launched', role: 'origin' });
    expect(links([s], [run({ runId: A })], { s1: ['run_aaa'] })).toEqual([]);
  });

  it('2 worktree: the cwd equals a run worktree path or a step worktree path', () => {
    const s = { id: 's1', cwd: '/code/orbit-auth' };
    const byWorktree = run({ worktrees: [{ slot: 'a', path: '/code/orbit-auth', branch: 'x', removed: true }] });
    expect(links([s], [byWorktree])[0]).toMatchObject({ reason: 'worktree', role: 'step' });
    const byStep = run({ phases: [phase('BUILD', { steps: [step({ worktree: { path: '/code/orbit-auth/' } })] })] });
    expect(links([s], [byStep])[0]).toMatchObject({ reason: 'worktree' });
  });

  it('3 branch: the session worktree branch equals the integration branch or a worktree branch', () => {
    const s = { id: 's1', cwd: '/code/orbit-auth', worktree: { branch: 'cohorte/auth-retry' } as LinkSession['worktree'] };
    expect(links([s], [run()])[0]).toMatchObject({ reason: 'branch', role: 'step' });
    const s2 = { ...s, worktree: { branch: 'agent/impl' } as LinkSession['worktree'] };
    expect(links([s2], [run({ worktrees: [{ slot: 'a', path: '/elsewhere', branch: 'agent/impl', removed: false }] })])[0].reason).toBe('branch');
  });

  it('4 base-branch: the root checkout on the run base branch, only while the run is live', () => {
    const s = { id: 's1', cwd: ROOT };
    expect(links([s], [run()])[0]).toMatchObject({ reason: 'base-branch', role: 'origin' });
    expect(links([s], [run({ state: 'COMPLETED' })])).toEqual([]);
    expect(links([s], [run({ git: { baseBranch: 'develop' } })])).toEqual([]);
    const inWorktree = { ...s, worktree: { branch: 'main' } as LinkSession['worktree'] };
    expect(links([inWorktree], [run({ git: { baseBranch: 'main' } })])).toEqual([]);
  });

  it('never links across Cohorte roots, nor for an undetected cwd', () => {
    expect(links([{ id: 's1', cwd: ROOT }], [run({ projectRoot: '/code/other' })])).toEqual([]);
    expect(links([{ id: 's1', cwd: '/nowhere' }], [run()], { s1: [run().runId] })).toEqual([]);
    const dets = detections({ [ROOT]: detection({ state: 'cli-missing' }) });
    expect(links([{ id: 's1', cwd: ROOT }], [run()], {}, false, dets)).toEqual([]);
  });
});

describe('computeLinks — precedence and tie-breaks', () => {
  it('prefers the strongest rule', () => {
    const s = { id: 's1', cwd: ROOT };
    const base = run({ runId: A, startedAt: 9 });
    const launched = run({ runId: B, startedAt: 1, state: 'COMPLETED' });
    expect(links([s], [base, launched], { s1: [B] })[0]).toMatchObject({ runId: B, reason: 'launched' });
  });

  it('then a non-terminal run, then the latest start', () => {
    const s = { id: 's1', cwd: '/code/orbit-auth' };
    const wt = [{ slot: 'a', path: '/code/orbit-auth', branch: 'x', removed: false }];
    const done = run({ runId: A, worktrees: wt, state: 'COMPLETED', startedAt: 100 });
    const live = run({ runId: B, worktrees: wt, state: 'BUILD', startedAt: 1 });
    expect(links([s], [done, live])[0].runId).toBe(B);
    const older = run({ runId: A, worktrees: wt, startedAt: 1 });
    const newer = run({ runId: B, worktrees: wt, startedAt: 2 });
    expect(links([s], [older, newer])[0].runId).toBe(B);
  });

  it('links a session to at most one run, while a run may link many sessions', () => {
    const wt = [{ slot: 'a', path: '/code/orbit-auth', branch: 'x', removed: false }];
    const r = run({ runId: A, worktrees: wt });
    const out = links([{ id: 's1', cwd: ROOT }, { id: 's2', cwd: '/code/orbit-auth' }], [r, run({ runId: B })]);
    expect(out.filter((l) => l.sessionId === 's1')).toHaveLength(1);
    expect(out.map((l) => l.sessionId)).toEqual(['s1', 's2']);
  });

  it('normalises Windows paths (case and separators)', () => {
    const dets = { 'C:\\Code\\Orbit': detection({ startDir: 'C:\\Code\\Orbit', root: 'C:\\Code\\Orbit' }) };
    const r = run({ projectRoot: 'c:/code/orbit', worktrees: [{ slot: 'a', path: 'C:/Code/Orbit-Auth', branch: 'x', removed: false }] });
    const d2 = { ...dets, 'c:\\code\\orbit-auth': detection({ startDir: 'c:\\code\\orbit-auth', root: 'C:\\Code\\Orbit' }) };
    expect(links([{ id: 's1', cwd: 'c:\\code\\orbit-auth\\' }], [r], {}, true, d2)[0]?.reason).toBe('worktree');
    expect(links([{ id: 's1', cwd: 'c:\\code\\orbit-auth\\' }], [r], {}, false, d2)).toEqual([]);
  });
});

describe('origin and step sessions', () => {
  const wt = [{ slot: 'a', path: '/code/orbit-auth', branch: 'x', removed: false }];
  const r = run({ runId: A, worktrees: wt });

  it('the origin is the best origin link, else the first step link', () => {
    const out = links([{ id: 'step', cwd: '/code/orbit-auth' }, { id: 'base', cwd: ROOT }, { id: 'launch', cwd: '/code/orbit/services/api' }], [r], {
      launch: [A],
    });
    expect(originSessionId(out, A)).toBe('launch');
    expect(stepSessionIds(out, A)).toEqual(['step']);
    const onlyStep = links([{ id: 'step', cwd: '/code/orbit-auth' }], [r]);
    expect(originSessionId(onlyStep, A)).toBe('step');
    expect(stepSessionIds(onlyStep, A)).toEqual([]);
    expect(originSessionId([], A)).toBeNull();
    expect(linkForSession(out, 'base')?.reason).toBe('base-branch');
  });
});

describe('helpers', () => {
  it('normalisePath / runMatchesRef / detectionFor / sessionAtPath', () => {
    expect(normalisePath('C:\\A\\B\\', true)).toBe('c:/a/b');
    expect(normalisePath('/', false)).toBe('/');
    expect(runMatchesRef(A, A)).toBe(true);
    expect(runMatchesRef(A, 'run_aaaaaa')).toBe(true);
    expect(runMatchesRef(A, 'run_aa')).toBe(false);
    expect(detectionFor(detections(), '/code/orbit/', false)?.startDir).toBe('/code/orbit');
    expect(sessionAtPath([{ id: 'x', cwd: '/a/b' }], '/a/b/', false)?.id).toBe('x');
    expect(sessionAtPath([{ id: 'x', cwd: '/a/b' }], undefined, false)).toBeNull();
  });
});
