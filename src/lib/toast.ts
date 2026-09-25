// The app-wide toast queue (command-palette FR-24/FR-25). Lives in lib, not in
// features/palette, because every feature raises toasts — importing it from
// the palette's folder was a cross-feature import. palette.ts re-exports it
// for its existing callers.

import { create } from 'zustand';
import type { ToastKind } from '../../contract/command-palette';

export interface Toast {
  id: string;
  message: string;
  kind: ToastKind;
  createdAt: number;
}

interface ToastState {
  visible: Toast[];
  queue: Toast[];
  push: (t: Toast) => void;
  dismiss: (id: string) => void;
}

const MAX_VISIBLE = 3;
const TOAST_MS = 4000;
let toastSeq = 0;
const timers = new Map<string, ReturnType<typeof setTimeout>>();

const useToastState = create<ToastState>((set) => ({
  visible: [],
  queue: [],
  push: (t) =>
    set((s) => (s.visible.length < MAX_VISIBLE ? { visible: [...s.visible, t] } : { queue: [...s.queue, t] })),
  dismiss: (id) => {
    const timer = timers.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.delete(id);
    }
    set((s) => {
      const visible = s.visible.filter((t) => t.id !== id);
      const queue = s.queue.slice();
      while (visible.length < MAX_VISIBLE && queue.length > 0) {
        const next = queue.shift()!;
        visible.push(next);
        scheduleDismiss(next.id);
      }
      return { visible, queue };
    });
  },
}));

export { useToastState };

function scheduleDismiss(id: string): void {
  timers.set(
    id,
    setTimeout(() => useToastState.getState().dismiss(id), TOAST_MS),
  );
}

/** FR-24: enqueue an app-wide toast; auto-dismiss after 4s (FR-25). */
export function showToast(message: string, kind: ToastKind): void {
  toastSeq += 1;
  const toast: Toast = { id: `t${toastSeq}`, message, kind, createdAt: Date.now() };
  const before = useToastState.getState().visible.length;
  useToastState.getState().push(toast);
  if (before < MAX_VISIBLE) scheduleDismiss(toast.id); // only schedule if it went visible now
}

