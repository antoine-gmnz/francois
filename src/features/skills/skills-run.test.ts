import { describe, expect, it } from 'vitest';
import type { SessionStatus } from '../../../contract/common';
import { piSkillDelivery } from './skills-run';

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
