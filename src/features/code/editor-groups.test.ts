// code-editor-workspace FR-2: the editor groups of one root — pure transitions.

import { describe, expect, it } from 'vitest';
import { closeInGroup, dropPath, focusGroup, groupWith, MAX_GROUPS, openInGroup, singleGroup, splitGroup, type RootGroups } from './editor-groups';

const one = (paths: string[], active: string | null = paths[0] ?? null, id = 0): RootGroups => ({ groups: [{ id, paths, active }], focused: 0 });
const two = (a: string[], b: string[], focused = 0): RootGroups => ({
  groups: [
    { id: 0, paths: a, active: a[0] ?? null },
    { id: 1, paths: b, active: b[0] ?? null },
  ],
  focused,
});

describe('singleGroup', () => {
  it('derives one group from the root tab records', () => {
    expect(singleGroup(['a.ts', 'b.ts'], 'b.ts')).toEqual(one(['a.ts', 'b.ts'], 'b.ts'));
    expect(singleGroup([], undefined)).toEqual(one([], null));
  });
});

describe('openInGroup', () => {
  it('appends to the target group, activates it and focuses the group', () => {
    expect(openInGroup(one(['a.ts']), 0, 'b.ts')).toEqual(one(['a.ts', 'b.ts'], 'b.ts'));
  });

  it('only activates a path the group already holds', () => {
    expect(openInGroup(one(['a.ts', 'b.ts'], 'b.ts'), 0, 'a.ts').groups[0]).toEqual({ id: 0, paths: ['a.ts', 'b.ts'], active: 'a.ts' });
  });

  it('index past the last group creates the second group', () => {
    expect(openInGroup(one(['a.ts']), 1, 'a.ts')).toEqual(two(['a.ts'], ['a.ts'], 1));
  });

  it('never creates a third group', () => {
    expect(MAX_GROUPS).toBe(2);
    const next = openInGroup(two(['a.ts'], ['b.ts']), 2, 'c.ts');
    expect(next.groups).toHaveLength(2);
    expect(next.groups[1]).toEqual({ id: 1, paths: ['b.ts', 'c.ts'], active: 'c.ts' });
    expect(next.focused).toBe(1);
  });
});

describe('splitGroup', () => {
  it('opens the focused group active file in a new group to the right', () => {
    expect(splitGroup(one(['a.ts', 'b.ts'], 'b.ts'))).toEqual({
      groups: [
        { id: 0, paths: ['a.ts', 'b.ts'], active: 'b.ts' },
        { id: 1, paths: ['b.ts'], active: 'b.ts' },
      ],
      focused: 1,
    });
  });

  it('already split: opens it in the other group', () => {
    const next = splitGroup(two(['a.ts'], ['b.ts'], 1));
    expect(next.groups[0]).toEqual({ id: 0, paths: ['a.ts', 'b.ts'], active: 'b.ts' });
    expect(next.focused).toBe(0);
  });

  it('is a no-op with nothing active', () => {
    const g = one([]);
    expect(splitGroup(g)).toBe(g);
  });
});

describe('closeInGroup', () => {
  it('removes the path and activates its neighbour', () => {
    const r = closeInGroup(one(['a.ts', 'b.ts', 'c.ts'], 'b.ts'), 0, 'b.ts');
    expect(r.state.groups[0]).toEqual({ id: 0, paths: ['a.ts', 'c.ts'], active: 'c.ts' });
    expect(r.orphaned).toBe(true);
  });

  it('closing the last tab of a group removes the group', () => {
    const r = closeInGroup(two(['a.ts'], ['b.ts'], 1), 1, 'b.ts');
    expect(r.state).toEqual(one(['a.ts']));
    expect(r.removedGroup).toBe(1);
  });

  it('closing the last tab of the only group keeps an empty group', () => {
    expect(closeInGroup(one(['a.ts']), 0, 'a.ts').state).toEqual(one([], null));
  });

  it('a path still open in the other group is not orphaned', () => {
    const r = closeInGroup(two(['a.ts', 'b.ts'], ['a.ts']), 0, 'a.ts');
    expect(r.orphaned).toBe(false);
    expect(r.state.groups[0]).toEqual({ id: 0, paths: ['b.ts'], active: 'b.ts' });
  });

  it('removing the left group shifts the right one to index 0, keeping its id', () => {
    const r = closeInGroup(two(['a.ts'], ['b.ts'], 0), 0, 'a.ts');
    expect(r.state).toEqual(one(['b.ts'], 'b.ts', 1));
    expect(r.removedGroup).toBe(0);
  });
});

describe('dropPath / focusGroup / groupWith', () => {
  it('dropPath removes a path from every group and collapses empty groups', () => {
    expect(dropPath(two(['a.ts', 'b.ts'], ['b.ts'], 1), 'b.ts')).toEqual(one(['a.ts']));
  });

  it('a new group takes an id no live group holds', () => {
    const left = closeInGroup(two(['a.ts'], ['b.ts'], 0), 0, 'a.ts').state;
    expect(splitGroup(left).groups.map((g) => g.id)).toEqual([1, 2]);
  });

  it('focusGroup clamps to existing groups', () => {
    expect(focusGroup(two(['a.ts'], ['b.ts']), 1).focused).toBe(1);
    expect(focusGroup(one(['a.ts']), 1).focused).toBe(0);
  });

  it('groupWith prefers the focused group', () => {
    expect(groupWith(two(['a.ts'], ['a.ts'], 1), 'a.ts')).toBe(1);
    expect(groupWith(two(['a.ts'], ['b.ts'], 1), 'a.ts')).toBe(0);
    expect(groupWith(one(['a.ts']), 'z.ts')).toBe(-1);
  });
});
