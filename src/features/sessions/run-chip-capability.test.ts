import { describe, expect, it } from 'vitest';
import type { SessionMeta } from '../../../contract/common';
import { settingCapability } from './session-settings';
const session = { agentRuntime: 'claude-code', effectiveCapabilities: { modelSwitching: { available: false, reason: 'Model is locked.' }, permissions: { available: false, reason: 'Git is locked.' } } } as SessionMeta;
describe('settings capability enforcement', () => {
  it('guards model and effort with the live capability', () => {
    expect(settingCapability(session, 'modelId')).toEqual({ available: false, reason: 'Model is locked.' });
    expect(settingCapability(session, 'effort').available).toBe(false);
  });
  it('guards git without hiding editable names or response settings', () => {
    expect(settingCapability(session, 'allowGit').available).toBe(false);
    expect(settingCapability(session, 'name').available).toBe(true);
    expect(settingCapability(session, 'responseMode').available).toBe(true);
  });
  it('retains legacy sandbox selection but disables Pi sandbox selection', () => {
    expect(settingCapability(session, 'permissionMode').available).toBe(true);
    expect(settingCapability({ ...session, agentRuntime: 'pi' }, 'permissionMode').available).toBe(false);
  });
});
