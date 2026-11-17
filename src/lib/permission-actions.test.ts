// permission-actions — hook-diagnostics: the approval card's "why is it asking" line.

import { describe, expect, it } from 'vitest';
import type { PermissionAsk } from '../../contract/common';
import { askReasonLine } from './permission-actions';

const base: PermissionAsk = {
  toolName: 'Bash',
  summary: 'echo ASKME',
  inputJson: '{}',
  cwd: '/repo',
  pattern: 'Bash(echo:*)',
  patternLabel: 'echo (any arguments)',
};

describe('askReasonLine', () => {
  it('names a project hook and its event', () => {
    expect(
      askReasonLine({
        ...base,
        decisionReason: 'stub-gate: ASKME needs confirmation',
        decisionReasonType: 'hook',
        decisionReasonHookEvent: 'PreToolUse',
      }),
    ).toBe('Project hook (PreToolUse): stub-gate: ASKME needs confirmation');
  });

  it('still names the hook when the CLI omits the event', () => {
    expect(askReasonLine({ ...base, decisionReason: 'gate says ask', decisionReasonType: 'hook' })).toBe(
      'Project hook: gate says ask',
    );
  });

  it('shows any other reason plainly', () => {
    expect(askReasonLine({ ...base, decisionReason: 'matches an ask rule', decisionReasonType: 'rule' })).toBe(
      'matches an ask rule',
    );
    expect(askReasonLine({ ...base, decisionReason: '  untyped reason ' })).toBe('untyped reason');
  });

  it('renders nothing for an old payload or a blank reason', () => {
    expect(askReasonLine(base)).toBeNull();
    expect(askReasonLine({ ...base, decisionReason: '   ', decisionReasonType: 'hook' })).toBeNull();
    // A type with no reason says nothing worth a line.
    expect(askReasonLine({ ...base, decisionReasonType: 'hook', decisionReasonHookEvent: 'PreToolUse' })).toBeNull();
  });
});
