// remote-control store slice: sessionId -> Remote Control host state. Split out
// of the former monolithic store.ts — see store.ts for the composition root.

import type { StateCreator } from 'zustand';
import type { RemoteControlStatus } from '../../contract/remote-control';
import {
  applyRemoteResult,
  applyRemoteStatus,
  applySeedStatus,
  type RemoteMap,
} from '../features/remote/remote-control';
import type { AppState } from './store';

export interface RemoteSlice {
  // remote-control: sessionId → Remote Control host state. Sessions with no host
  // are ABSENT rather than stored as `{phase:'off'}` (remote-control FR-15), so
  // "is anything remote-controlled?" is a key count.
  remote: RemoteMap;
  mergeRemote: (status: RemoteControlStatus) => void;
  /** Fold a mount-time `remote_get` seed — fills a hole only, never overwrites a
   * live entry the event stream has since populated (remote-control H2 #1). */
  mergeRemoteSeed: (status: RemoteControlStatus) => void;
  /** Fold a `remote_start`/`remote_stop` command result, guarded against a stale
   * response racing the event stream (remote-control H2 #2). */
  mergeRemoteResult: (status: RemoteControlStatus) => void;
}

export const createRemoteSlice: StateCreator<AppState, [], [], RemoteSlice> = (set) => ({
  remote: {},
  mergeRemote: (status) => set((s) => ({ remote: applyRemoteStatus(s.remote, status) })),
  mergeRemoteSeed: (status) => set((s) => ({ remote: applySeedStatus(s.remote, status) })),
  mergeRemoteResult: (status) => set((s) => ({ remote: applyRemoteResult(s.remote, status) })),
});
