import { describe, expect, it } from 'vitest';
import { MRU_CAP, mruAdvance, mruPrune } from './session-mru';

// The main pane holds the last few sessions' transcripts and terminals mounted
// (SessionViewHost). This is the whole eviction policy, and the two properties
// that matter are not obvious from reading it: what falls out first, and that a
// no-op really is one — the host derives this list during render, so a helper
// that returned a fresh array every time would be an infinite render loop.

describe('mruAdvance', () => {
  it('inserts an unseen session at the front', () => {
    expect(mruAdvance([], 'a', 3)).toEqual(['a']);
    expect(mruAdvance(['a'], 'b', 3)).toEqual(['b', 'a']);
    expect(mruAdvance(['b', 'a'], 'c', 3)).toEqual(['c', 'b', 'a']);
  });

  it('PROMOTES a held session rather than duplicating it', () => {
    expect(mruAdvance(['c', 'b', 'a'], 'a', 3)).toEqual(['a', 'c', 'b']);
    // …and the promoted entry appears exactly once.
    expect(mruAdvance(['c', 'b', 'a'], 'b', 3).filter((id) => id === 'b')).toHaveLength(1);
  });

  it('evicts the LEAST recently viewed session past the cap', () => {
    expect(mruAdvance(['c', 'b', 'a'], 'd', 3)).toEqual(['d', 'c', 'b']);
    // A promotion rescues an entry that was next to fall out: 'a' was last,
    // visiting it makes 'b' the eviction candidate instead.
    const rescued = mruAdvance(['c', 'b', 'a'], 'a', 3);
    expect(mruAdvance(rescued, 'd', 3)).toEqual(['d', 'a', 'c']);
  });

  it('holds the cap at any list length', () => {
    let list: readonly string[] = [];
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) list = mruAdvance(list, id, MRU_CAP);
    expect(list).toEqual(['f', 'e', 'd']);
    expect(list.length).toBe(MRU_CAP);
  });

  it('leaves the list alone when no session is selected', () => {
    // "select a session" is a state the user leaves again — the views held
    // behind it are what make that return instant.
    const list = ['b', 'a'];
    expect(mruAdvance(list, null, 3)).toBe(list);
  });

  it('is a no-op — SAME reference — when the active session is already at the front', () => {
    const list = ['a', 'b'];
    expect(mruAdvance(list, 'a', 3)).toBe(list);
    expect(mruAdvance([], null, 3)).toEqual([]);
  });

  it('drops everything at cap 0 without churning an already-empty list', () => {
    expect(mruAdvance(['a', 'b'], 'c', 0)).toEqual([]);
    const empty: readonly string[] = [];
    expect(mruAdvance(empty, 'c', 0)).toBe(empty);
  });
});

describe('mruPrune', () => {
  it('drops entries whose session no longer exists', () => {
    expect(mruPrune(['c', 'b', 'a'], ['c', 'a'])).toEqual(['c', 'a']);
    expect(mruPrune(['c', 'b', 'a'], [])).toEqual([]);
  });

  it('preserves the order of the survivors — a removal is not a visit', () => {
    expect(mruPrune(['c', 'b', 'a'], ['a', 'b', 'c'])).toEqual(['c', 'b', 'a']);
  });

  it('is a no-op — SAME reference — when every entry is still live', () => {
    const list = ['b', 'a'];
    expect(mruPrune(list, ['a', 'b', 'z'])).toBe(list);
  });

  it('composes with mruAdvance the way the host calls them', () => {
    // The host prunes the ADVANCED list, so a switch to a session that was
    // removed in the same tick cannot resurrect it.
    expect(mruPrune(mruAdvance(['b', 'a'], 'c', 3), ['a', 'b'])).toEqual(['b', 'a']);
  });
});
