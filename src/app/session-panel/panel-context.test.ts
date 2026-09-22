import { describe, expect, it } from 'vitest';
import type { SessionMeta } from '../../../contract/common';
import { panelContext } from './panel-context';

const session = (used: number, limit: number) =>
  ({ agentRuntime: 'claude-code', contextUsedTokens: used, contextLimitTokens: limit }) as unknown as SessionMeta;

describe('panelContext', () => {
  it('reads "used / window" with the fill fraction', () => {
    const ctx = panelContext(session(134_000, 1_000_000));
    expect(ctx?.fraction).toBeCloseTo(0.134, 5);
    expect(ctx?.figure).toMatch(/^134K? \/ 1(\.0)?M$/);
  });

  it('is null when there is no window to measure against', () => {
    expect(panelContext(session(5_000, 0))).toBeNull();
  });
});
