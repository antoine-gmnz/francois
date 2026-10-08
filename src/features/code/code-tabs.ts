// Editor tabs for ONE root (code-editor FR-6) — pure state transitions the store
// wraps (adapted from the parked c21a3e6). Text never lives here: the Monaco models
// are held outside the store (buffers.ts), so these records stay small.

import { EDITOR_MAX_TABS, type FileVersion, type LineEnding, type ReadOnlyReason } from '../../../contract/code-editor';

export interface CodeTab {
  path: string;
  /** The disk version the buffer is based on (save sends it as `baseVersion`). */
  version: FileVersion;
  dirty: boolean;
  /** Monaco's saved view state (cursor + scroll), opaque here. FR-2: survives leaving the tab. */
  viewState: unknown;
  lineEnding: LineEnding;
  bom: boolean;
  trailingNewline: boolean;
  readOnly: boolean;
  readOnlyReason?: ReadOnlyReason;
  headText: string | null;
  /** FR-12: set while the disk moved under a dirty buffer — the "Changed on disk" bar. */
  conflict: { version: FileVersion } | null;
  /** FR-12: the file vanished from disk; the buffer is kept, ⌘S recreates it. */
  deleted: boolean;
}

export interface RootTabs {
  tabs: CodeTab[];
  active?: string;
  /** Most recently used first. */
  mru: string[];
}

export const EMPTY_ROOT_TABS: RootTabs = { tabs: [], active: undefined, mru: [] };

export type OpenTabResult = { ok: true; state: RootTabs; evicted?: string } | { ok: false; reason: 'all-dirty' };

const front = (mru: string[], path: string) => [path, ...mru.filter((p) => p !== path)];

/** FR-6: open (or focus) a tab; the 13th evicts the LRU clean tab, or is refused when all are dirty. */
export function openTab(state: RootTabs, incoming: CodeTab): OpenTabResult {
  if (state.tabs.some((t) => t.path === incoming.path)) {
    return { ok: true, state: touchTab(state, incoming.path) };
  }
  let tabs = state.tabs;
  let mru = state.mru;
  let evicted: string | undefined;
  if (tabs.length >= EDITOR_MAX_TABS) {
    // The oldest clean tab: scan the mru from its tail (least recently used first).
    evicted = [...mru].reverse().find((p) => tabs.some((t) => t.path === p && !t.dirty));
    if (!evicted) return { ok: false, reason: 'all-dirty' };
    tabs = tabs.filter((t) => t.path !== evicted);
    mru = mru.filter((p) => p !== evicted);
  }
  return { ok: true, evicted, state: { tabs: [...tabs, incoming], active: incoming.path, mru: front(mru, incoming.path) } };
}

/** Make an open tab the active one. */
export function touchTab(state: RootTabs, path: string): RootTabs {
  if (!state.tabs.some((t) => t.path === path)) return state;
  return { ...state, active: path, mru: front(state.mru, path) };
}

export function closeTab(state: RootTabs, path: string): RootTabs {
  const tabs = state.tabs.filter((t) => t.path !== path);
  const mru = state.mru.filter((p) => p !== path);
  const active = state.active === path ? (mru[0] ?? tabs[tabs.length - 1]?.path) : state.active;
  return { tabs, mru, active };
}

export function updateTab(state: RootTabs, path: string, patch: Partial<CodeTab>): RootTabs {
  if (!state.tabs.some((t) => t.path === path)) return state;
  return { ...state, tabs: state.tabs.map((t) => (t.path === path ? { ...t, ...patch } : t)) };
}

/** The basename, plus the parent dir when two open basenames collide. */
export function tabLabels(tabs: readonly CodeTab[]): Record<string, string> {
  const base = (p: string) => p.slice(p.lastIndexOf('/') + 1);
  const counts = new Map<string, number>();
  for (const t of tabs) counts.set(base(t.path), (counts.get(base(t.path)) ?? 0) + 1);
  const out: Record<string, string> = {};
  for (const t of tabs) {
    out[t.path] = (counts.get(base(t.path)) ?? 0) < 2 ? base(t.path) : t.path.split('/').slice(-2).join('/');
  }
  return out;
}
