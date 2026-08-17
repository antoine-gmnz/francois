// profiles slice — plain state wiring (no persistence to cover; profiles.json
// lives entirely in the core). Mirrors accountsStore.test.ts's shape for the
// sibling slice.

import { describe, expect, it } from 'vitest';
import { useStore } from './store';

function profile(id: string, name = id) {
  return { id, name, createdAt: 0, updatedAt: 0 };
}

describe('profiles store slice', () => {
  it('defaults to an empty registry and a closed modal', () => {
    expect(useStore.getState().profiles).toEqual([]);
    expect(useStore.getState().profilesOpen).toBe(false);
    expect(useStore.getState().pendingNewSessionProfileId).toBeNull();
  });

  it('setProfiles replaces the registry wholesale', () => {
    useStore.getState().setProfiles([profile('p1'), profile('p2')]);
    expect(useStore.getState().profiles).toHaveLength(2);
    useStore.getState().setProfiles([]);
    expect(useStore.getState().profiles).toEqual([]);
  });

  it('setProfilesOpen toggles the modal flag', () => {
    useStore.getState().setProfilesOpen(true);
    expect(useStore.getState().profilesOpen).toBe(true);
    useStore.getState().setProfilesOpen(false);
    expect(useStore.getState().profilesOpen).toBe(false);
  });

  it('setPendingNewSessionProfileId is a one-shot request slot', () => {
    useStore.getState().setPendingNewSessionProfileId('p1');
    expect(useStore.getState().pendingNewSessionProfileId).toBe('p1');
    useStore.getState().setPendingNewSessionProfileId(null);
    expect(useStore.getState().pendingNewSessionProfileId).toBeNull();
  });
});
