import { describe, expect, it } from 'vitest';
import { resolveEffectiveChoice, resolveKeyDelivery } from './delivery-mode';

describe('resolveEffectiveChoice (FR-1)', () => {
  it('keeps the persisted choice when it is still available', () => {
    expect(resolveEffectiveChoice('steer', true, true)).toBe('steer');
    expect(resolveEffectiveChoice('followUp', true, true)).toBe('followUp');
  });

  it('falls back to followUp when the persisted steer choice becomes unavailable', () => {
    expect(resolveEffectiveChoice('steer', false, true)).toBe('followUp');
  });

  it('falls back to steer when the persisted followUp choice becomes unavailable', () => {
    expect(resolveEffectiveChoice('followUp', true, false)).toBe('steer');
  });

  it('is null when neither mode is available', () => {
    expect(resolveEffectiveChoice('steer', false, false)).toBeNull();
    expect(resolveEffectiveChoice('followUp', false, false)).toBeNull();
  });
});

describe('resolveKeyDelivery (FR-1/§3)', () => {
  it('Alt+Enter is always followUp, idle or busy', () => {
    expect(resolveKeyDelivery('idle', true, null)).toBe('followUp');
    expect(resolveKeyDelivery('running', true, 'steer')).toBe('followUp');
  });

  it('plain Enter sends normal while idle, regardless of the toggle', () => {
    expect(resolveKeyDelivery('idle', false, 'steer')).toBe('normal');
    expect(resolveKeyDelivery('idle', false, null)).toBe('normal');
  });

  it('plain Enter follows the effective choice while busy', () => {
    expect(resolveKeyDelivery('running', false, 'steer')).toBe('steer');
    expect(resolveKeyDelivery('awaiting_approval', false, 'followUp')).toBe('followUp');
  });

  it('plain Enter has nothing to send while busy with no available mode', () => {
    expect(resolveKeyDelivery('running', false, null)).toBeNull();
  });
});
