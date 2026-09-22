import { describe, expect, it } from 'vitest';
import type { SessionMeta } from '../../../contract/common';
import { sessionCapability } from '../../lib/runtimeCapability';
import { remoteControlActions } from './remote-control';
describe('Remote Control capability gates', () => {
  it.each([undefined, { available: false, reason: 'Remote disabled.' }])('blocks start and approval-start for %j', snapshot => {
    const meta = { agentRuntime: 'pi', effectiveCapabilities: snapshot ? { remoteControl: snapshot } : undefined } as SessionMeta;
    const capability = sessionCapability(meta, 'remoteControl');
    expect(remoteControlActions(capability, { phase: 'off' })).toEqual({ canStart: false, canOpen: false, reason: 'Pi is unavailable in this version. Saved history is read-only.' });
    expect(remoteControlActions(capability, { phase: 'active', name: 'host', url: 'https://example.com', startedAt: 1 }).canOpen).toBe(true);
  });
});
