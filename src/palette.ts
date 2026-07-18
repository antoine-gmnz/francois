// command-palette runtime (specs/command-palette.md). Frontend-only: the command
// registry, the palette's own modal state, the toast queue, and the open/close/
// dismiss/toggle API app-shell dispatches into. No IPC channels (§2 non-goals).

import { create } from 'zustand';
import type { PaletteCommand, PaletteContext, SecondaryStep, SecondaryStepItem, ToastKind } from '../contract/command-palette';

// ---------- command registry (module-level, registration order = insertion order) ----------

const registry: PaletteCommand[] = [];

/** FR-6/FR-7: register once at a feature's bootstrap. Throws on duplicate id. */
export function registerPaletteCommand(command: PaletteCommand): void {
  if (registry.some((c) => c.id === command.id)) {
    throw new Error(`palette command '${command.id}' is already registered`);
  }
  registry.push(command);
}

/** Removes a registered command (hot-reload / tests). No-op if absent. */
export function unregisterPaletteCommand(id: string): void {
  const i = registry.findIndex((c) => c.id === id);
  if (i !== -1) registry.splice(i, 1);
}

/** The registry in registration order — read fresh on every filter pass (FR-9/FR-10). */
export function paletteCommands(): readonly PaletteCommand[] {
  return registry;
}

// ---------- filtering / ranking (FR-10) ----------

/**
 * Ordered-subsequence match position: the index in `s` where the first char of
 * `q` is greedily consumed, or -1 if `q` is not a subsequence of `s`. Both are
 * compared lowercased by the caller.
 */
export function subsequenceMatchPos(q: string, s: string): number {
  let qi = 0;
  let firstPos = -1;
  for (let i = 0; i < s.length && qi < q.length; i++) {
    if (s[i] === q[qi]) {
      if (qi === 0) firstPos = i;
      qi++;
    }
  }
  return qi === q.length ? firstPos : -1;
}

/** Filter + rank by match position asc, ties by key in code-point order (FR-10). Empty query = input order. */
export function filterRank<T>(items: readonly T[], query: string, keyOf: (t: T) => string): T[] {
  const q = query.toLowerCase();
  if (!q) return items.slice();
  const scored: { item: T; pos: number; key: string }[] = [];
  for (const item of items) {
    const key = keyOf(item);
    const pos = subsequenceMatchPos(q, key.toLowerCase());
    if (pos >= 0) scored.push({ item, pos, key });
  }
  scored.sort((a, b) => a.pos - b.pos || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return scored.map((s) => s.item);
}

// ---------- palette state (FR-5/FR-6, §6) ----------

interface PaletteState {
  open: boolean;
  mode: 'root' | 'secondary';
  query: string;
  selectedIndex: number;
  secondaryStep: SecondaryStep | null;
  secondaryParentName: string; // the originating command's name, for the breadcrumb pill (§8)
  secondaryQuery: string;
  secondarySelectedIndex: number;
  restoreFocusTo: Element | null;
  setQuery: (q: string) => void;
  setSelectedIndex: (i: number) => void;
  setSecondaryQuery: (q: string) => void;
  setSecondarySelectedIndex: (i: number) => void;
  enterSecondary: (step: SecondaryStep, parentName: string) => void;
  popToRoot: () => void; // secondary → root (FR-3/FR-15)
  _open: (restore: Element | null) => void;
  _close: () => void;
}

const ROOT_RESET = { mode: 'root' as const, secondaryStep: null, secondaryParentName: '', secondaryQuery: '', secondarySelectedIndex: 0, query: '', selectedIndex: 0 };

const usePaletteState = create<PaletteState>((set) => ({
  open: false,
  ...ROOT_RESET,
  restoreFocusTo: null,
  setQuery: (query) => set({ query, selectedIndex: 0 }), // FR-11
  setSelectedIndex: (selectedIndex) => set({ selectedIndex }),
  setSecondaryQuery: (secondaryQuery) => set({ secondaryQuery, secondarySelectedIndex: 0 }),
  setSecondarySelectedIndex: (secondarySelectedIndex) => set({ secondarySelectedIndex }),
  enterSecondary: (secondaryStep, secondaryParentName) =>
    set({ mode: 'secondary', secondaryStep, secondaryParentName, secondaryQuery: '', secondarySelectedIndex: 0 }),
  popToRoot: () => set({ ...ROOT_RESET }),
  _open: (restore) => set({ open: true, ...ROOT_RESET, restoreFocusTo: restore }),
  _close: () => set({ open: false, ...ROOT_RESET, restoreFocusTo: null }),
}));

export { usePaletteState };

// view-diff exception (FR-16): when set, the next full close focuses document.body
// instead of the pre-open element (which may be a now-hidden terminal).
let forceBodyFocus = false;
export function requestBodyFocusOnClose(): void {
  forceBodyFocus = true;
}

// ---------- open / close API (consumed by app-shell, FR-1/FR-3/FR-4) ----------

export function isPaletteOpen(): boolean {
  return usePaletteState.getState().open;
}

export function openPalette(): void {
  const st = usePaletteState.getState();
  if (st.open) return; // idempotent (FR-4)
  st._open(document.activeElement); // capture restore target (FR-2)
}

/** Always a full close, restoring focus per FR-2 (or body for the view-diff exception). */
export function closePalette(): void {
  const st = usePaletteState.getState();
  if (!st.open) return; // idempotent
  const restore = st.restoreFocusTo;
  st._close();
  const target =
    forceBodyFocus || !restore || !(restore instanceof HTMLElement) || !document.contains(restore)
      ? document.body
      : restore;
  forceBodyFocus = false;
  (target as HTMLElement).focus?.();
}

export function togglePalette(): void {
  if (isPaletteOpen()) closePalette();
  else openPalette();
}

/** app-shell's `dismiss` while the palette is open (FR-3): pop a secondary step, else full close. */
export function dismissPalette(): void {
  const st = usePaletteState.getState();
  if (!st.open) return;
  if (st.mode === 'secondary') st.popToRoot();
  else closePalette();
}

/** Live context snapshot (FR-9). runningAgentCount is supplied by the caller from the agents cache. */
export function makeContext(activeSessionId: string | null, runningAgentCount: number): PaletteContext {
  return { activeSessionId, runningAgentCount };
}

// ---------- toasts (FR-24/FR-25) ----------

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

export type { PaletteCommand, PaletteContext, SecondaryStep, SecondaryStepItem, ToastKind };
