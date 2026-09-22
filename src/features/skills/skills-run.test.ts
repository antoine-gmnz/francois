import { expect, it } from 'vitest';
import { buildSkillsRunRequest } from './skills-run';
it('sends the native skill name and arguments without retired admission fields', () => {
  expect(buildSkillsRunRequest('session', { name: 'review' }, 'src')).toEqual({ sessionId: 'session', name: 'review', args: 'src' });
});
