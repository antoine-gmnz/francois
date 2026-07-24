// permission-guardrails §9 — rules editor logic (FR-26..FR-28).

import { describe, expect, it } from 'vitest';
import type { Result } from '../contract/common';
import type { PermissionEffect, PermissionRule, PermissionTier } from '../contract/permission-guardrails';
import {
  applyMutation,
  effectGlyph,
  effectLabel,
  emptyText,
  EMPTY_RULES_TEXT,
  filterRules,
  groupRules,
  moveLabel,
  otherTier,
} from './permissions-editor';

const r = (
  pattern: string,
  label: string,
  effect: PermissionEffect = 'allow',
  tier: PermissionTier = 'local',
  enabled = true,
): PermissionRule => ({ id: `${tier}|${effect}|${pattern}`, pattern, effect, tier, enabled, label });

const RULES: PermissionRule[] = [
  r('Bash(rm:*)', 'rm (any arguments)', 'deny'),
  r('Bash(git push:*)', 'git push (any arguments)', 'ask'),
  r('Bash(npm test:*)', 'npm test (any arguments)'),
  r('WebSearch', 'any WebSearch call', 'allow', 'global'),
];

describe('effect vocabulary (§8.12/8.13)', () => {
  it('maps each effect to its glyph and section label', () => {
    expect(effectGlyph('allow')).toBe('✓');
    expect(effectGlyph('deny')).toBe('⊘');
    expect(effectGlyph('ask')).toBe('?');
    expect(effectLabel('deny')).toBe('DENY');
  });

  it('names the tier a row can move to', () => {
    expect(otherTier('local')).toBe('global');
    expect(otherTier('global')).toBe('local');
    expect(moveLabel('local')).toBe('→ global');
    expect(moveLabel('global')).toBe('→ project');
  });
});

describe('filterRules (FR-28)', () => {
  it('matches the human label AND the raw pattern, case-insensitively', () => {
    expect(filterRules(RULES, 'npm').map((x) => x.pattern)).toEqual(['Bash(npm test:*)']);
    expect(filterRules(RULES, 'ANY ARGUMENTS')).toHaveLength(3); // label side
    expect(filterRules(RULES, 'websearch').map((x) => x.pattern)).toEqual(['WebSearch']); // pattern side
  });

  it('passes everything through for an empty or whitespace query', () => {
    expect(filterRules(RULES, '')).toHaveLength(4);
    expect(filterRules(RULES, '   ')).toHaveLength(4);
  });

  it('returns nothing when nothing matches', () => {
    expect(filterRules(RULES, 'zzz')).toEqual([]);
  });
});

describe('groupRules (FR-27, §8.13)', () => {
  it('groups deny → ask → allow, preserving the core order inside a group', () => {
    const groups = groupRules(RULES);
    expect(groups.map((g) => g.effect)).toEqual(['deny', 'ask', 'allow']);
    expect(groups[2]!.rules.map((x) => x.pattern)).toEqual(['Bash(npm test:*)', 'WebSearch']);
  });

  it('drops empty effect groups', () => {
    const groups = groupRules([r('X', 'x', 'allow')]);
    expect(groups.map((g) => g.effect)).toEqual(['allow']);
  });

  it('never re-sorts what the core already ordered (FR-17 is the authority)', () => {
    // Two allow rules given global-before-local: the group keeps that order.
    const given = [r('A', 'a', 'allow', 'global'), r('B', 'b', 'allow', 'local')];
    expect(groupRules(given)[0]!.rules.map((x) => x.pattern)).toEqual(['A', 'B']);
  });
});

describe('emptyText (FR-28)', () => {
  it('distinguishes "no rules at all" from "the filter matched nothing"', () => {
    expect(emptyText(0, 0, '')).toBe(EMPTY_RULES_TEXT);
    expect(emptyText(4, 0, ' git ')).toBe('no rule matches “git”');
    expect(emptyText(4, 2, 'git')).toBeNull();
  });
});

describe('applyMutation (FR-18/FR-28)', () => {
  const harness = (call: () => Promise<Result<PermissionRule[]>>) => {
    const state = { rules: [] as PermissionRule[], error: null as string | null, busy: false };
    return {
      state,
      run: () =>
        applyMutation({
          call,
          setRules: (rules) => {
            state.rules = rules;
          },
          setError: (m) => {
            state.error = m;
          },
          setBusy: (v) => {
            state.busy = v;
          },
        }),
    };
  };

  it('adopts the freshly re-read list the core returns and clears any stale error', async () => {
    const h = harness(async () => ({ ok: true, data: RULES }));
    h.state.error = 'stale';
    await h.run();
    expect(h.state.rules).toHaveLength(4);
    expect(h.state.error).toBeNull();
    expect(h.state.busy).toBe(false);
  });

  it('surfaces ok:false inline and keeps the previously rendered list', async () => {
    const h = harness(async () => ({
      ok: false,
      error: { code: 'RULE_NOT_FOUND', message: 'that rule no longer exists' },
    }));
    h.state.rules = RULES;
    await h.run();
    expect(h.state.error).toBe('that rule no longer exists');
    expect(h.state.rules).toHaveLength(4);
    expect(h.state.busy).toBe(false);
  });

  it('never throws on a transport rejection and always clears busy', async () => {
    const h = harness(() => Promise.reject(new Error('bridge down')));
    await expect(h.run()).resolves.toBeUndefined();
    expect(h.state.error).toBe('bridge down');
    expect(h.state.busy).toBe(false);
  });
});
