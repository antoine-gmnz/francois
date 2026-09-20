import { describe, expect, it } from 'vitest';
import type { SessionStatus } from '../../../contract/common';
import { buildSkillsRunRequest, piSkillDelivery } from './skills-run';

describe('piSkillDelivery (pi-skills-capabilities §5)', () => {
  it('picks normal while idle/done/error — a settled session', () => {
    const settled: SessionStatus[] = ['idle', 'done', 'error'];
    for (const status of settled) {
      expect(piSkillDelivery(status)).toBe('normal');
    }
  });

  it('picks followUp while a turn is in flight, mirroring isBusyStatus', () => {
    const busy: SessionStatus[] = ['starting', 'running', 'awaiting_approval', 'awaiting_input'];
    for (const status of busy) {
      expect(piSkillDelivery(status)).toBe('followUp');
    }
  });
});

describe('buildSkillsRunRequest (pr-142 §6, frontend half)', () => {
  const pi = { clientMessageId: 'cid-1', delivery: 'normal' as const };

  it('sends the LISTED entry\'s own invocation, never rebuilt from name', () => {
    const req = buildSkillsRunRequest('s1', { name: 'deploy', invocation: '/skill:deploy' }, undefined, pi);
    expect(req).toEqual({
      sessionId: 's1',
      name: 'deploy',
      invocation: '/skill:deploy',
      args: undefined,
      clientMessageId: 'cid-1',
      delivery: 'normal',
    });
  });

  it('omits invocation for a non-Pi entry — nothing else changes for it', () => {
    const req = buildSkillsRunRequest('s1', { name: 'pdf-reader' }, undefined, pi);
    expect(req.invocation).toBeUndefined();
  });

  it('two listed entries sharing a derived name produce different requests', () => {
    const skillCmd = { name: 'deploy', invocation: '/skill:deploy' };
    const userCmd = { name: 'deploy', invocation: '/deploy' };
    const reqA = buildSkillsRunRequest('s1', skillCmd, undefined, pi);
    const reqB = buildSkillsRunRequest('s1', userCmd, undefined, pi);
    expect(reqA).not.toEqual(reqB);
    expect(reqA.invocation).toBe('/skill:deploy');
    expect(reqB.invocation).toBe('/deploy');
  });

  it('passes args through untouched', () => {
    const req = buildSkillsRunRequest('s1', { name: 'deploy', invocation: '/skill:deploy' }, '--prod', pi);
    expect(req.args).toBe('--prod');
  });
});
