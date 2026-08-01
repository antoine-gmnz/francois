// self-update store slice (§6): the LAST UpdateCheck the core reported, the
// modal's open flag, and the in-flight flag the apply click sets. Nothing here
// is persisted and nothing is derived — the status-bar chip's state, the
// primary action and the running-session guard are all computed at render from
// this slice plus the existing `sessions` slice (features/update/update.ts).
//
// `updateError` is the one field beyond the spec's three: the palette's manual
// check has to be able to REPORT a failed check (FR-9, §7), and the modal that
// shows it is opened after the call resolves — so the outcome cannot live in
// the modal's own local state. It also carries an UPDATE_BLOCKED /
// UPDATE_APPLY_FAILED reason back from a click (FR-12/FR-18).

import type { StateCreator } from 'zustand';
import type { AppError } from '../../contract/common';
import type { UpdateCheck } from '../../contract/self-update';
import type { AppState } from './store';

export interface UpdateSlice {
  /** The last check, replaced wholesale (FR-19). Null until one succeeds. */
  update: UpdateCheck | null;
  setUpdate: (check: UpdateCheck) => void;
  updateModalOpen: boolean;
  setUpdateModalOpen: (open: boolean) => void;
  /** True from the `Update and restart` click until the window goes (FR-16). */
  updateBusy: boolean;
  setUpdateBusy: (busy: boolean) => void;
  /** A failed manual check, or a refused apply. Never set by the launch check (FR-7). */
  updateError: AppError | null;
  setUpdateError: (error: AppError | null) => void;
}

export const createUpdateSlice: StateCreator<AppState, [], [], UpdateSlice> = (set) => ({
  update: null,
  setUpdate: (update) => set({ update }),
  updateModalOpen: false,
  setUpdateModalOpen: (updateModalOpen) => set({ updateModalOpen }),
  updateBusy: false,
  setUpdateBusy: (updateBusy) => set({ updateBusy }),
  updateError: null,
  setUpdateError: (updateError) => set({ updateError }),
});
