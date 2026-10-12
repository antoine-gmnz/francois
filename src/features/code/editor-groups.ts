// code-editor-workspace FR-2: the editor groups of ONE root — which open paths each
// group shows, its active tab, and the focused group. Pure transitions the store
// wraps. The tab records (dirty, version, view state…) stay in code-tabs.ts, one per
// path: a path open in both groups is one buffer, one model, one dirty state.

export const MAX_GROUPS = 2;

export interface EditorGroup {
  /** Stable while the group lives (React key, view-state key) — survives the left group closing. */
  id: number;
  /** This group's tab strip, in order. */
  paths: string[];
  active: string | null;
}

export interface RootGroups {
  /** One or two groups, left to right. */
  groups: EditorGroup[];
  /** The target of ⌘S / ⌘W / ⌘P and quick open. */
  focused: number;
}

export function singleGroup(paths: readonly string[], active: string | undefined): RootGroups {
  return { groups: [{ id: 0, paths: [...paths], active: active ?? paths[0] ?? null }], focused: 0 };
}

/** Open (or activate) `path` in group `index`; an index past the last group creates one (≤ MAX_GROUPS). */
export function openInGroup(state: RootGroups, index: number, path: string): RootGroups {
  const at = Math.min(index, state.groups.length, MAX_GROUPS - 1);
  const groups = [...state.groups];
  const g = groups[at] ?? { id: Math.max(-1, ...groups.map((x) => x.id)) + 1, paths: [], active: null };
  groups[at] = { id: g.id, paths: g.paths.includes(path) ? g.paths : [...g.paths, path], active: path };
  return { groups, focused: at };
}

/** ⌘\ / the split button: show the focused group's active file in the other group. */
export function splitGroup(state: RootGroups): RootGroups {
  const active = state.groups[state.focused]?.active;
  if (!active) return state;
  const other = state.groups.length < MAX_GROUPS ? state.groups.length : state.focused === 0 ? 1 : 0;
  return openInGroup(state, other, active);
}

export interface CloseResult {
  state: RootGroups;
  /** No group shows the path any more — its tab record (and buffer) can go. */
  orphaned: boolean;
  /** The index of a group that emptied and was removed, else null. */
  removedGroup: number | null;
}

export function closeInGroup(state: RootGroups, index: number, path: string): CloseResult {
  const g = state.groups[index];
  if (!g || !g.paths.includes(path)) return { state, orphaned: false, removedGroup: null };
  const at = g.paths.indexOf(path);
  const paths = g.paths.filter((p) => p !== path);
  const active = g.active === path ? (paths[at] ?? paths[at - 1] ?? null) : g.active;
  let groups = state.groups.map((x, i) => (i === index ? { id: x.id, paths, active } : x));
  let focused = state.focused;
  let removedGroup: number | null = null;
  if (paths.length === 0 && groups.length > 1) {
    groups = groups.filter((_, i) => i !== index);
    removedGroup = index;
    focused = 0;
  }
  const orphaned = !groups.some((x) => x.paths.includes(path));
  return { state: { groups, focused: Math.min(focused, groups.length - 1) }, orphaned, removedGroup };
}

/** A tab record went away (eviction, close, prompt): drop the path everywhere. */
export function dropPath(state: RootGroups, path: string): RootGroups {
  let next = state;
  for (let i = next.groups.length - 1; i >= 0; i--) next = closeInGroup(next, i, path).state;
  return next;
}

export function focusGroup(state: RootGroups, index: number): RootGroups {
  const focused = Math.max(0, Math.min(index, state.groups.length - 1));
  return focused === state.focused ? state : { ...state, focused };
}

/** The group showing `path` — the focused one first; -1 when none does. */
export function groupWith(state: RootGroups, path: string): number {
  if (state.groups[state.focused]?.paths.includes(path)) return state.focused;
  return state.groups.findIndex((g) => g.paths.includes(path));
}
