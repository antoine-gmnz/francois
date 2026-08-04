// permission-guardrails §9 — approval card logic (FR-20..FR-23).

import { describe, expect, it, vi } from 'vitest';
import type { Result } from '../../../contract/common';
import type { ConversationBlock } from '../../../contract/conversation-view';
import type { PermissionAsk, PermissionDecision, PermissionRule } from '../../../contract/permission-guardrails';
import { composerPlaceholder } from '../questions/question-card';
import {
  askSignature,
  cardClass,
  hasDetail,
  hasPendingPermissionBlock,
  PERMISSION_ACTIONS,
  relativeAge,
  ruleSentence,
  stateNote,
  submitDecision,
  tierChip,
  tierControlDimmed,
  tierLabel,
  writesRule,
  writtenRuleSentence,
} from './permission-card';

const ask: PermissionAsk = {
  toolName: 'Bash',
  summary: 'npm test',
  inputJson: '{\n  "command": "npm test"\n}',
  cwd: '/repo',
  pattern: 'Bash(npm test:*)',
  patternLabel: 'npm test (any arguments)',
};

const rule: PermissionRule = {
  id: 'local|allow|Bash(npm test:*)',
  pattern: 'Bash(npm test:*)',
  effect: 'allow',
  tier: 'local',
  enabled: true,
  label: 'npm test (any arguments)',
};

const permBlock = (state: 'pending' | 'allowed' | 'denied' | 'cancelled'): ConversationBlock => ({
  kind: 'permission',
  blockId: 'p1',
  isStreaming: state === 'pending',
  ask,
  state,
});

const ok: Result<null> = { ok: true, data: null };
const fail: Result<null> = { ok: false, error: { code: 'SETTINGS_WRITE_FAILED', message: 'could not write x' } };

describe('tier vocabulary (FR-20, §8.12)', () => {
  it('defaults read as "this project" and promote to "all projects"', () => {
    expect(tierLabel('local')).toBe('this project');
    expect(tierLabel('global')).toBe('all projects');
    expect(tierChip('local')).toBe('project');
    expect(tierChip('global')).toBe('global');
  });
});

describe('actions (§8.7, FR-6)', () => {
  it('offers exactly the four spec actions, allows before denials', () => {
    expect(PERMISSION_ACTIONS.map((a) => a.decision)).toEqual([
      'allowOnce',
      'allowAlways',
      'denyOnce',
      'denyAlways',
    ]);
    expect(PERMISSION_ACTIONS.map((a) => a.short)).toEqual(['Allow', 'Always', 'Deny', 'Never']);
    // The short face is what the button shows; the long label is its title, so
    // "Never" is never left to guesswork.
    expect(PERMISSION_ACTIONS.map((a) => a.label)).toEqual([
      'allow once',
      'always allow',
      'deny once',
      'always deny',
    ]);
  });

  it('gives every action a distinct variant, so no two buttons share a style', () => {
    expect(PERMISSION_ACTIONS.map((a) => a.variant)).toEqual(['allow', 'always', 'deny', 'never']);
  });

  it('only the *Always decisions write a rule (tier is inert for the others)', () => {
    expect(writesRule('allowAlways')).toBe(true);
    expect(writesRule('denyAlways')).toBe(true);
    expect(writesRule('allowOnce')).toBe(false);
    expect(writesRule('denyOnce')).toBe(false);
  });

  it('dims the tier control while a *Once action is hovered, not otherwise', () => {
    expect(tierControlDimmed(null)).toBe(false);
    expect(tierControlDimmed('allowAlways')).toBe(false);
    expect(tierControlDimmed('denyAlways')).toBe(false);
    expect(tierControlDimmed('allowOnce')).toBe(true);
    expect(tierControlDimmed('denyOnce')).toBe(true);
  });

  it('every action maps to a decision the core accepts', () => {
    // Pins the card's action row against the contract's PermissionDecision union
    // — the one thing the untestable DOM wiring could silently get wrong.
    const CORE_DECISIONS: PermissionDecision[] = ['allowOnce', 'denyOnce', 'allowAlways', 'denyAlways'];
    for (const a of PERMISSION_ACTIONS) expect(CORE_DECISIONS).toContain(a.decision);
    expect(new Set(PERMISSION_ACTIONS.map((a) => a.decision)).size).toBe(PERMISSION_ACTIONS.length);
    // `allow` drives the row color; it must agree with the decision it sends.
    for (const a of PERMISSION_ACTIONS) expect(a.allow).toBe(a.decision.startsWith('allow'));
  });
});

describe('call signature (§8.3)', () => {
  it('reads as the call would be typed', () => {
    expect(askSignature(ask)).toBe('Bash(npm test)');
    expect(askSignature({ ...ask, toolName: 'Write', summary: 'src/app.ts' })).toBe('Write(src/app.ts)');
  });

  it('falls back to the bare tool rather than a dangling Tool()', () => {
    expect(askSignature({ ...ask, summary: '' })).toBe('Bash');
    expect(askSignature({ ...ask, toolName: '', summary: '' })).toBe('tool');
    expect(askSignature({ ...ask, toolName: '' })).toBe('tool(npm test)');
  });
});

describe('age (§8.2)', () => {
  it('steps second → minute → hour → day', () => {
    expect(relativeAge(0)).toBe('just now');
    expect(relativeAge(59_000)).toBe('just now');
    expect(relativeAge(60_000)).toBe('1m ago');
    expect(relativeAge(4 * 60_000 + 30_000)).toBe('4m ago');
    expect(relativeAge(59 * 60_000)).toBe('59m ago');
    expect(relativeAge(60 * 60_000)).toBe('1h ago');
    expect(relativeAge(23 * 3_600_000)).toBe('23h ago');
    expect(relativeAge(24 * 3_600_000)).toBe('1d ago');
    expect(relativeAge(50 * 3_600_000)).toBe('2d ago');
  });

  it('never reads as negative when the clock ticks backwards', () => {
    expect(relativeAge(-5_000)).toBe('just now');
  });
});

describe('disclosure (§8.4)', () => {
  it('always has something to reveal while pending (the would-be rule)', () => {
    expect(hasDetail({ ...ask, inputJson: '', cwd: '' }, true)).toBe(true);
  });

  it('resolved: only when the ask carried an input dump or a cwd', () => {
    expect(hasDetail(ask, false)).toBe(true);
    expect(hasDetail({ ...ask, cwd: '' }, false)).toBe(true);
    expect(hasDetail({ ...ask, inputJson: '' }, false)).toBe(true);
    expect(hasDetail({ ...ask, inputJson: '', cwd: '' }, false)).toBe(false);
  });
});

describe('rule sentences (FR-20/FR-22)', () => {
  it('shows the rule an "always" would write, tier included, before committing', () => {
    expect(ruleSentence(ask, 'local')).toBe('npm test (any arguments) · this project');
    expect(ruleSentence(ask, 'global')).toBe('npm test (any arguments) · all projects');
  });

  it('reports the rule a decision actually wrote', () => {
    expect(writtenRuleSentence(rule)).toBe('always allow — npm test (any arguments) · project');
    expect(writtenRuleSentence({ ...rule, effect: 'deny', tier: 'global' })).toBe(
      'always deny — npm test (any arguments) · global',
    );
  });
});

describe('state chrome (FR-22, §8.1)', () => {
  it('notes each resolved state and none while pending', () => {
    expect(stateNote('pending')).toBeNull();
    expect(stateNote('allowed')).toBe('— allowed');
    expect(stateNote('denied')).toBe('— denied');
    expect(stateNote('cancelled')).toBe('— cancelled');
  });

  it('classes carry the state, and in-flight only applies while pending', () => {
    expect(cardClass('pending', false)).toBe('pcard pcard--pending');
    expect(cardClass('pending', true)).toBe('pcard pcard--pending pcard--inflight');
    expect(cardClass('allowed', true)).toBe('pcard pcard--allowed');
    expect(cardClass('cancelled', false)).toBe('pcard pcard--cancelled');
  });
});

describe('submitDecision (FR-21)', () => {
  const harness = (res: Promise<Result<null>>, resolved = false) => {
    const calls: { decision: string; tier: string }[] = [];
    const state = { inFlight: false, error: null as string | null };
    const scheduled: (() => void)[] = [];
    return {
      calls,
      state,
      scheduled,
      run: (decision: (typeof PERMISSION_ACTIONS)[number]['decision'], tier: 'local' | 'global') =>
        submitDecision({
          decision,
          tier,
          decide: (d, t) => {
            calls.push({ decision: d, tier: t });
            return res;
          },
          setInFlight: (v) => {
            state.inFlight = v;
          },
          setError: (m) => {
            state.error = m;
          },
          isResolved: () => resolved,
          schedule: (fn) => scheduled.push(fn),
        }),
    };
  };

  it('calls decide once with the chosen decision and tier and stays in flight on success', async () => {
    const h = harness(Promise.resolve(ok));
    await h.run('allowAlways', 'global');
    expect(h.calls).toEqual([{ decision: 'allowAlways', tier: 'global' }]);
    // On success the card STAYS in flight — permission.resolved flips it (FR-21).
    expect(h.state.inFlight).toBe(true);
    expect(h.state.error).toBeNull();
  });

  it('re-enables the card and shows the failure inline for 4s', async () => {
    const h = harness(Promise.resolve(fail));
    await h.run('allowAlways', 'local');
    expect(h.state.inFlight).toBe(false);
    expect(h.state.error).toBe('could not write x');
    expect(h.scheduled).toHaveLength(1);
    h.scheduled[0]!(); // the 4s timer clears it
    expect(h.state.error).toBeNull();
  });

  it('treats a transport rejection exactly like ok:false', async () => {
    const h = harness(Promise.reject(new Error('bridge down')));
    await h.run('denyOnce', 'local');
    expect(h.state.inFlight).toBe(false);
    expect(h.state.error).toBe('bridge down');
  });

  it('leaves an already-resolved card alone when the failure loses the race (§7 #6)', async () => {
    const h = harness(Promise.resolve(fail), true);
    await h.run('allowOnce', 'local');
    expect(h.state.inFlight).toBe(true); // never re-enabled
    expect(h.state.error).toBeNull(); // never a stale error over a resolved card
    expect(h.scheduled).toHaveLength(0);
  });

  it('never alerts', async () => {
    const alert = vi.fn();
    vi.stubGlobal('alert', alert);
    const h = harness(Promise.resolve(fail));
    await h.run('denyAlways', 'local');
    expect(alert).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe('composer placeholder (FR-23)', () => {
  it('swaps while a pending approval card exists and reverts when none is', () => {
    expect(hasPendingPermissionBlock([permBlock('pending')])).toBe(true);
    expect(hasPendingPermissionBlock([permBlock('allowed'), permBlock('cancelled')])).toBe(false);
    expect(hasPendingPermissionBlock([])).toBe(false);

    expect(composerPlaceholder('running', undefined, false, true)).toBe(
      'approve or deny the request above — typed messages will queue',
    );
    expect(composerPlaceholder('running', undefined, false, false)).toBe('send a follow-up, or run a command…');
  });

  it('lets a pending question win so the two hints never fight', () => {
    expect(composerPlaceholder('running', undefined, true, true)).toBe(
      'answer the question above — typed messages will queue',
    );
  });

  it('keeps the ended/errored placeholders', () => {
    expect(composerPlaceholder('done', undefined, false, true)).toBe('session ended — press n for a new one');
    expect(composerPlaceholder('error', 'boom', false, true)).toBe('boom');
  });
});
