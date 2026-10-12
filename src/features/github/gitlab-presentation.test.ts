import { expect, it } from 'vitest';
import { checkRollupChip, checkRollupHeadline } from './pulls';
import { commitChecksChip, commitChecksIcon } from './commits';
import { pullMarkerTitle } from '../sessions/roster-pulls';
import type { PullSummary } from '../../../contract/github-page';

it('does not show skipped or cancelled CI as a passed rollup or commit', () => {
  const rollup = { total: 2, passed: 1, failed: 0, pending: 0 };
  expect(checkRollupChip(rollup)?.label).not.toContain('passed');
  expect(checkRollupHeadline(rollup)?.label).not.toContain('passed');
  const runs = [{ name: 'cancelled', state: 'skipped' as const, summary: 'cancelled' }];
  expect(commitChecksChip(runs)?.label).not.toContain('passed');
  expect(commitChecksIcon(runs)).toBeNull();
});

it('uses MR vocabulary on private GitLab roster markers', () => {
  const pull = { number: 4, title: 'Fix', state: 'draft', url: 'https://private.test/group/nested/r/-/merge_requests/4' } as PullSummary;
  expect(pullMarkerTitle(pull)).toBe('Draft MR #4 · Fix');
});
