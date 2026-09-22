import { expect, it } from 'vitest';
import { permissionActions, writesRule } from './permission-card';
it('honors actual native offered choices and labels cancel as ending the turn', () => {
  const actions = permissionActions(['allowOnce', 'cancel']);
  expect(actions.map(a => a.decision)).toEqual(['allowOnce', 'cancel']);
  expect(actions[1].label).toBe('Cancel turn');
  expect(writesRule('cancel')).toBe(false);
  expect(permissionActions([])).toEqual([]);
});
it('retains the original four Claude choices when the optional field is absent', () => {
  expect(permissionActions().map(a => a.decision)).toEqual(['allowOnce', 'allowAlways', 'denyOnce', 'denyAlways']);
});
