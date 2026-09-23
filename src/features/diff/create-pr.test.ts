import { describe, expect, it } from 'vitest';
import { CREATE_PR_PROMPT, createPrAvailability } from './create-pr';

describe('createPrAvailability', () => {
  it('is available on an idle session', () => {
    expect(createPrAvailability({ status: 'idle', agentRuntime: 'claude-code' })).toEqual({ available: true });
  });

  it.each(['starting', 'running', 'awaiting_approval', 'awaiting_input'] as const)('waits for the turn while %s', (status) => {
    const res = createPrAvailability({ status, agentRuntime: 'claude-code' });
    expect(res.available).toBe(false);
    expect(res.reason).toMatch(/turn/i);
  });

  it('refuses a retired session', () => {
    expect(createPrAvailability({ status: 'idle', agentRuntime: 'pi' }).available).toBe(false);
  });

  it('refuses when no session is selected', () => {
    expect(createPrAvailability(null).available).toBe(false);
  });
});

describe('CREATE_PR_PROMPT', () => {
  it('asks the agent to commit, push and open the PR', () => {
    expect(CREATE_PR_PROMPT).toMatch(/commit/i);
    expect(CREATE_PR_PROMPT).toMatch(/push/i);
    expect(CREATE_PR_PROMPT).toMatch(/gh pr create/);
  });
});
