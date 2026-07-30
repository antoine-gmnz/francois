import { describe, expect, it } from 'vitest';
import { statusDotClassName } from './StatusDot';

describe('statusDotClassName', () => {
  it('is just the base class when idle and unadorned', () => {
    expect(statusDotClassName(false)).toBe('status-dot');
  });

  it('adds the pulsing modifier when pulsing', () => {
    expect(statusDotClassName(true)).toBe('status-dot status-dot--pulsing');
  });

  it('appends an extra className last, after any modifier', () => {
    expect(statusDotClassName(true, 'agent-tab-dot')).toBe('status-dot status-dot--pulsing agent-tab-dot');
    expect(statusDotClassName(false, 'agent-tab-dot')).toBe('status-dot agent-tab-dot');
  });
});
