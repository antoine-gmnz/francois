// session-profiles store slice: the app-scoped profile registry cache (FR-2 —
// shared across every account), the Profiles modal's own open flag, and a
// one-shot "preselect this profile" request so the palette's "New session
// with profile…" (FR-24) can reach a New Session modal instance that does not
// exist yet — same pattern as accountsStore's accountsAutoAdd. Split out like
// every other per-concern slice — see store.ts for the composition root.

import type { StateCreator } from 'zustand';
import type { ProfileId } from '../../contract/common';
import type { SessionProfile } from '../../contract/session-profiles';
import type { AppState } from './store';

export interface ProfilesSlice {
  /** Hydrated by profiles_list at boot, refreshed after every mutation. */
  profiles: SessionProfile[];
  setProfiles: (profiles: SessionProfile[]) => void;
  profilesOpen: boolean;
  setProfilesOpen: (open: boolean) => void;
  /** Consumed once by NewSessionModal's mount effect, then cleared. */
  pendingNewSessionProfileId: ProfileId | null;
  setPendingNewSessionProfileId: (id: ProfileId | null) => void;
}

export const createProfilesSlice: StateCreator<AppState, [], [], ProfilesSlice> = (set) => ({
  profiles: [],
  setProfiles: (profiles) => set({ profiles }),
  profilesOpen: false,
  setProfilesOpen: (profilesOpen) => set({ profilesOpen }),
  pendingNewSessionProfileId: null,
  setPendingNewSessionProfileId: (pendingNewSessionProfileId) => set({ pendingNewSessionProfileId }),
});
