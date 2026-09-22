import { describe, expect, it, vi } from 'vitest';
import type { SessionMeta, RuntimeCapabilities } from '../../contract/common';
import { runtimeCapabilities } from '../../contract/multi-provider-seam';
import { sessionCapability } from './runtimeCapability';
import { canSetProjectDefault, settingCapability } from '../features/sessions/session-settings';
import { profileRuntimeMismatch, modelSelectionMismatch } from '../features/sessions/new-session-form';
import type { Account } from '../../contract/multi-account';
import type { SessionProfile } from '../../contract/session-profiles';

const pi = { agentRuntime: 'pi', protocol: null, projectId: 'project', effectiveCapabilities: Object.fromEntries(Object.keys(runtimeCapabilities('pi')).map(k => [k, { available: true }])) as RuntimeCapabilities } as SessionMeta;

describe('retired Pi cannot regain execution from historical metadata', () => {
  it('clamps every capability even when the saved snapshot says true', () => {
    for (const key of Object.keys(pi.effectiveCapabilities!) as (keyof RuntimeCapabilities)[]) {
      expect(sessionCapability(pi, key)).toEqual({ available: false, reason: 'Pi is unavailable in this version. Saved history is read-only.' });
    }
  });
  it('disables every setting and default propagation', () => {
    for (const key of ['name', 'modelId', 'effort', 'permissionMode', 'responseMode', 'allowGit'] as const) expect(settingCapability(pi, key).available).toBe(false);
    expect(canSetProjectDefault(pi)).toBe(false);
  });
  it('requires explicit available account and profile selections', () => {
    expect(modelSelectionMismatch({kind:'pi'} as Account, '', { providerId: 'saved', modelId: 'saved' })).toContain('unavailable');
    expect(profileRuntimeMismatch({kind:'pi'} as SessionProfile, {kind:'pi'} as Account)?.reason).toContain('unavailable');
    expect(profileRuntimeMismatch({kind:'legacy'} as SessionProfile, {kind:'claude-code-oauth'} as Account)).toBeNull();
    expect(modelSelectionMismatch({kind:'claude-code-oauth'} as Account, 'sonnet', undefined)).toBeNull();
  });
});

it('settles historical Pi metadata and rejects replay into the fleet cache', async () => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} });
  const { useStore } = await import('./store');
  const raw = { ...pi, id: 'retired', status: 'awaiting_approval', runtimeGeneration: 'old', accountId: 'missing-pi' } as SessionMeta;
  useStore.getState().setSessions([raw]);
  expect(useStore.getState().sessions[0].status).toBe('done');
  expect(raw.status).toBe('awaiting_approval');
  const before = useStore.getState().sessions;
  useStore.getState().applyRuntimeEvent({ type: 'runtime.event', sessionId: 'retired', generation: 'old', sequence: 1, at: 1, event: { kind: 'run.state', state: 'running' } });
  expect(useStore.getState().sessions).toBe(before);
  expect(useStore.getState().sessions[0].accountId).toBe('missing-pi');
});

it('does not export any retired execution or probe IPC wrapper', async () => {
  const api = await import('./api');
  for (const name of ['runtimeInstallation', 'runtimeModels', 'sessionMetrics', 'sessionSubmit', 'sessionClearQueue', 'sessionReconnect', 'sessionNewFrom', 'sessionAcknowledgePolicy', 'accountAddPi', 'accountTrustPi', 'accountPiSetup', 'accountPiRefresh', 'profilesCopyToPi', 'sessionSwitchRuntimeModel']) expect(name in api).toBe(false);
});
