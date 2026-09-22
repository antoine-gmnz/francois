import { describe, expect, it } from 'vitest';
import { accountInitials, activeNav } from './app-bar';

describe('accountInitials', () => {
  it('takes the first letter of the first two words', () => {
    expect(accountInitials('Antoine Gimenez')).toBe('AG');
    expect(accountInitials('work account')).toBe('WA');
  });

  it('splits on separators an email or handle uses', () => {
    expect(accountInitials('gnz.antoine@gmail.com')).toBe('GA');
    expect(accountInitials('api-default')).toBe('AD');
  });

  it('takes two letters of a single word', () => {
    expect(accountInitials('Personal')).toBe('PE');
    expect(accountInitials('x')).toBe('X');
  });

  it('degrades to a placeholder when empty', () => {
    expect(accountInitials('')).toBe('?');
    expect(accountInitials('   ')).toBe('?');
  });
});

describe('activeNav', () => {
  it('reads Overview only on the overview tab', () => {
    expect(activeNav('overview')).toBe('overview');
  });

  it('reads Sessions for everything session-scoped, dynamic tabs and panes included', () => {
    for (const tab of ['session', 'diff', 'shell', 'agents', 'mcp', 'skills', 'workflows', 'agent:x', 'workflow:y', 'ext:z'] as const) {
      expect(activeNav(tab)).toBe('sessions');
    }
  });

  it('reads GitHub only on the github tab', () => {
    expect(activeNav('github')).toBe('github');
  });
});
