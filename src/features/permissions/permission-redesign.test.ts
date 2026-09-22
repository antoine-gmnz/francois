// Graphite & Signal (Figma 04–08) — the approval card's pure vocabulary: the
// question the card asks, the button faces and kinds, and the one-line outcome
// a resolved ask collapses to.

import { describe, expect, it } from 'vitest';
import type { PermissionAsk, PermissionRule } from '../../../contract/permission-guardrails';
import { PERMISSION_ACTIONS, permissionActions } from '../../lib/permission-actions';
import { actionButtonKind, actionFace, outcomeLabel, outcomeStateKind, rulePreviewScope } from './permission-card';
import { askCodeSurface, askTitle } from './permission-code';

function ask(over: Partial<PermissionAsk>): PermissionAsk {
  return { toolName: 'Bash', summary: '', inputJson: '', cwd: '/repo', pattern: '', patternLabel: '', ...over };
}

const rule = (effect: PermissionRule['effect'], tier: PermissionRule['tier'] = 'local'): PermissionRule => ({
  id: `${tier}|${effect}|Bash(git push:*)`,
  pattern: 'Bash(git push:*)',
  effect,
  tier,
  enabled: true,
  label: 'git push (any arguments)',
});

describe('askTitle (Figma 04: "Allow this command?")', () => {
  it('names the kind of ask the surface set', () => {
    expect(askTitle(askCodeSurface(ask({ inputJson: '{"command":"git push"}' })), 'Bash')).toBe('Allow this command?');
    expect(
      askTitle(askCodeSurface(ask({ toolName: 'Edit', inputJson: '{"file_path":"a.ts","old_string":"a","new_string":"b"}' })), 'Edit'),
    ).toBe('Allow this edit?');
    expect(askTitle(askCodeSurface(ask({ toolName: 'WebFetch', inputJson: '{"url":"https://x.dev/a"}' })), 'WebFetch')).toBe(
      'Allow this request?',
    );
  });

  it('falls back to the tool name for anything else', () => {
    expect(askTitle(askCodeSurface(ask({ toolName: 'mcp__db__query', summary: 'select 1' })), 'mcp__db__query')).toBe(
      'Allow mcp__db__query?',
    );
    expect(askTitle(askCodeSurface(ask({ toolName: '' })), '')).toBe('Allow this tool call?');
  });
});

describe('actionFace / actionButtonKind (Figma 04 action row)', () => {
  it('spells every offered decision as its button face', () => {
    expect(PERMISSION_ACTIONS.map((a) => actionFace(a.decision))).toEqual(['Allow once', 'Always allow', 'Deny', 'Always deny']);
    expect(actionFace('cancel')).toBe('Cancel turn');
  });

  it('gives allow-once the attention fill and always-deny the ghost', () => {
    expect(PERMISSION_ACTIONS.map((a) => actionButtonKind(a.decision))).toEqual(['attention', 'secondary', 'secondary', 'ghost']);
    expect(permissionActions(['cancel']).map((a) => actionButtonKind(a.decision))).toEqual(['secondary']);
  });
});

describe('outcomeLabel / outcomeStateKind (Figma 06–08)', () => {
  it('says once vs always from whether a rule was written', () => {
    expect(outcomeLabel('allowed')).toBe('Allowed once');
    expect(outcomeLabel('allowed', rule('allow'))).toBe('Always allowed');
    expect(outcomeLabel('denied')).toBe('Denied');
    expect(outcomeLabel('denied', rule('deny'))).toBe('Always denied');
    expect(outcomeLabel('cancelled')).toBe('Cancelled');
    expect(outcomeLabel('pending')).toBe('');
  });

  it('maps the outcome onto a state glyph', () => {
    expect(outcomeStateKind('allowed')).toBe('done');
    expect(outcomeStateKind('denied')).toBe('failed');
    expect(outcomeStateKind('cancelled')).toBe('idle');
    expect(outcomeStateKind('pending')).toBe('approval');
  });
});

describe('rulePreviewScope', () => {
  it('reads the chosen tier as the sentence end', () => {
    expect(rulePreviewScope('local')).toBe('to this project');
    expect(rulePreviewScope('global')).toBe('to all projects');
  });
});
