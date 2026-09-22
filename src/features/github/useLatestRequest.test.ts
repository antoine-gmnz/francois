import { describe, expect, it } from 'vitest';
import { createGenerationGuard } from './useLatestRequest';

describe('createGenerationGuard', () => {
  it('a single run stays current', () => {
    const guard = createGenerationGuard();
    const isCurrent = guard.begin();
    expect(isCurrent()).toBe(true);
  });

  it('a later run supersedes an earlier one', () => {
    const guard = createGenerationGuard();
    const first = guard.begin();
    const second = guard.begin();
    expect(first()).toBe(false);
    expect(second()).toBe(true);
  });

  it('invalidate() supersedes every in-flight run', () => {
    const guard = createGenerationGuard();
    const first = guard.begin();
    guard.invalidate();
    expect(first()).toBe(false);

    const second = guard.begin();
    expect(second()).toBe(true);
  });

  it('isCurrent can be checked repeatedly without side effects', () => {
    const guard = createGenerationGuard();
    const isCurrent = guard.begin();
    expect(isCurrent()).toBe(true);
    expect(isCurrent()).toBe(true);
    guard.begin();
    expect(isCurrent()).toBe(false);
    expect(isCurrent()).toBe(false);
  });
});
