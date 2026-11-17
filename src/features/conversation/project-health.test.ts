import { beforeEach, describe, expect, it, vi } from 'vitest';
const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
import type { ClaudeProjectHealth } from '../../../contract/claude-project-health';
import { sessionProjectHealth, sessionTrustFolder } from '../../lib/api';
import {
  allowRulesPhrase,
  cachedProjectHealth,
  dismissGuardBanner,
  dismissTrustBanner,
  guardBannerVisible,
  isGuardBannerDismissed,
  isTrustBannerDismissed,
  probeProjectHealth,
  resetProjectHealthCache,
  trustBannerVisible,
  trustFolder,
} from './project-health';

function health(over: { trusted?: boolean; allowRuleCount?: number; interpreterMissing?: string | null } = {}): ClaudeProjectHealth {
  return {
    trust: { trusted: over.trusted ?? false, key: '/repo', allowRuleCount: over.allowRuleCount ?? 3 },
    guard: { registered: true, interpreterMissing: over.interpreterMissing ?? null },
  };
}

beforeEach(() => {
  invokeMock.mockReset();
  resetProjectHealthCache();
});

describe('api wrappers', () => {
  it('probes through session_project_health with the session id', async () => {
    invokeMock.mockResolvedValue({ ok: true, data: health() });
    await expect(sessionProjectHealth('s1')).resolves.toEqual({ ok: true, data: health() });
    expect(invokeMock).toHaveBeenCalledWith('session_project_health', { sessionId: 's1' });
  });

  it('trusts through session_trust_folder with the session id', async () => {
    invokeMock.mockResolvedValue({ ok: true, data: health({ trusted: true }) });
    await sessionTrustFolder('s1');
    expect(invokeMock).toHaveBeenCalledWith('session_trust_folder', { sessionId: 's1' });
  });
});

describe('trustBannerVisible', () => {
  it('shows for an untrusted folder with allow rules', () => {
    expect(trustBannerVisible(health(), false)).toBe(true);
  });
  it('hides once trusted, with no rules, when dismissed, or before a probe', () => {
    expect(trustBannerVisible(health({ trusted: true }), false)).toBe(false);
    expect(trustBannerVisible(health({ allowRuleCount: 0 }), false)).toBe(false);
    expect(trustBannerVisible(health(), true)).toBe(false);
    expect(trustBannerVisible(null, false)).toBe(false);
  });
});

describe('guardBannerVisible', () => {
  it('shows only while the interpreter is missing and not dismissed', () => {
    expect(guardBannerVisible(health({ interpreterMissing: 'python3' }), false)).toBe(true);
    expect(guardBannerVisible(health({ interpreterMissing: 'python3' }), true)).toBe(false);
    expect(guardBannerVisible(health(), false)).toBe(false);
    expect(guardBannerVisible(undefined, false)).toBe(false);
  });
  it('is independent of trust', () => {
    expect(guardBannerVisible(health({ trusted: true, allowRuleCount: 0, interpreterMissing: 'python3' }), false)).toBe(true);
  });
});

describe('allowRulesPhrase', () => {
  it('pluralises', () => {
    expect(allowRulesPhrase(1)).toBe('1 permissions.allow rule');
    expect(allowRulesPhrase(4)).toBe('4 permissions.allow rules');
  });
});

describe('dismissal', () => {
  it('trust dismissal never throws without localStorage (node env)', () => {
    expect(() => dismissTrustBanner('s1')).not.toThrow();
    expect(isTrustBannerDismissed('s1')).toBe(false);
  });
  it('guard dismissal is per session, in memory', () => {
    dismissGuardBanner('s1');
    expect(isGuardBannerDismissed('s1')).toBe(true);
    expect(isGuardBannerDismissed('s2')).toBe(false);
  });
});

describe('probe cache', () => {
  it('caches a successful probe per session', async () => {
    invokeMock.mockResolvedValue({ ok: true, data: health() });
    await expect(probeProjectHealth('s1')).resolves.toEqual(health());
    expect(cachedProjectHealth('s1')).toEqual(health());
    expect(cachedProjectHealth('s2')).toBeNull();
  });
  it('keeps the cached value when a probe fails or answers null', async () => {
    invokeMock.mockResolvedValueOnce({ ok: true, data: health() });
    await probeProjectHealth('s1');
    invokeMock.mockResolvedValueOnce({ ok: false, error: { code: 'SESSION_NOT_FOUND', message: 'gone' } });
    await expect(probeProjectHealth('s1')).resolves.toEqual(health());
    invokeMock.mockResolvedValueOnce({ ok: true, data: null });
    await expect(probeProjectHealth('s1')).resolves.toEqual(health());
  });
  it('the trust action writes its returned health into the cache', async () => {
    invokeMock.mockResolvedValue({ ok: true, data: health({ trusted: true }) });
    await expect(trustFolder('s1')).resolves.toBeNull();
    expect(cachedProjectHealth('s1')?.trust.trusted).toBe(true);
  });
  it('the trust action surfaces the error message', async () => {
    invokeMock.mockResolvedValue({ ok: false, error: { code: 'SETTINGS_WRITE_FAILED', message: 'bad json' } });
    await expect(trustFolder('s1')).resolves.toBe('bad json');
    expect(cachedProjectHealth('s1')).toBeNull();
  });
});
