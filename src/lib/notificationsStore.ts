// notifications FR-17: the two independent per-class toggles (attention /
// turn-done), persisted to localStorage with the layoutStore.ts guarded
// read/write pattern (a restricted storage environment degrades silently).
// audio-cues FR-11 amends this store with the third, master `soundEnabled`
// toggle — same persistence pattern, own key, default on.
//
// A standalone zustand store — like palette.ts's usePaletteState — rather
// than a slice merged into the composition-root `useStore`: only the palette
// hints, the muted chip, and the firing modules (via getState()) read it, and
// the spec pins the name `useNotificationsStore` (`src/lib/notificationsStore.ts`).

import { create } from 'zustand';
import { SOUND_ENABLED_KEY } from '../../contract/audio-cues';
import type { NotifyClass } from '../../contract/notifications';
import { NOTIFY_ENABLED_KEYS } from '../../contract/notifications';

function loadEnabled(cls: NotifyClass): boolean {
  try {
    return localStorage.getItem(NOTIFY_ENABLED_KEYS[cls]) !== '0'; // absent/malformed ⇒ on
  } catch {
    return true;
  }
}

function persistEnabled(cls: NotifyClass, on: boolean): void {
  try {
    localStorage.setItem(NOTIFY_ENABLED_KEYS[cls], on ? '1' : '0');
  } catch {
    /* ignore — in-memory toggle still works for the session */
  }
}

function loadSoundEnabled(): boolean {
  try {
    return localStorage.getItem(SOUND_ENABLED_KEY) !== '0'; // absent/malformed/unreadable ⇒ on
  } catch {
    return true;
  }
}

function persistSoundEnabled(on: boolean): void {
  try {
    localStorage.setItem(SOUND_ENABLED_KEY, on ? '1' : '0');
  } catch {
    /* ignore — in-memory toggle still works for the session */
  }
}

export interface NotificationsState {
  enabled: Record<NotifyClass, boolean>;
  setNotifyEnabled: (cls: NotifyClass, on: boolean) => void;
  soundEnabled: boolean;
  setSoundEnabled: (on: boolean) => void;
}

export const useNotificationsStore = create<NotificationsState>((set) => ({
  enabled: {
    attention: loadEnabled('attention'),
    turnDone: loadEnabled('turnDone'),
  },
  setNotifyEnabled: (cls, on) => {
    persistEnabled(cls, on);
    set((s) => ({ enabled: { ...s.enabled, [cls]: on } }));
  },
  soundEnabled: loadSoundEnabled(),
  setSoundEnabled: (on) => {
    persistSoundEnabled(on);
    set({ soundEnabled: on });
  },
}));
