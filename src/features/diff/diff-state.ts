// diff-review §6: the DIFF tab's per-session, in-memory-only UI state, as a pure
// reducer — everything here is frontend-only and never persisted (§2 non-goals).
// A plain useReducer wraps this (useDiffState.ts); kept pure and separate so the
// state machine is unit-testable without React.

export const WORKTREE_REF = 'worktree';

export interface DiffDraft {
  subject: string;
  body: string;
  amend: boolean;
}

export interface DiffUiState {
  /** Checked paths (FR-7/FR-20 — one set, two affordances). */
  inCommit: Set<string>;
  /** The working-tree file paths as of the last summary (drives FR-1 seeding / the
   *  "path entered/left the summary" edge cases in §7). */
  knownPaths: Set<string>;
  /** Read paths, keyed by ref: WORKTREE_REF or a viewed commit's hash (FR-31). */
  read: Map<string, Set<string>>;
  /** Body-collapsed file paths (FR-21/FR-23). */
  collapsed: Set<string>;
  /** Folded rail directory keys (FR-10). */
  folded: Set<string>;
  railMode: 'tree' | 'flat';
  filter: string;
  cursorKey: string | null;
  /** null = working tree; otherwise the full hash of the commit being viewed (FR-15). */
  viewingCommit: string | null;
  /** FR §7 "commit selected + working tree changes": set on an external diff.changed
   *  while viewing a commit; cleared on return. */
  workingTreeChanged: boolean;
  /** Per-file `context` override (FR-26). */
  expandedContext: Map<string, number>;
  draft: DiffDraft;
  commitOpen: boolean;
  commitsExpanded: boolean;
}

export function initDiffUiState(): DiffUiState {
  return {
    inCommit: new Set(),
    knownPaths: new Set(),
    read: new Map(),
    collapsed: new Set(),
    folded: new Set(),
    railMode: 'tree',
    filter: '',
    cursorKey: null,
    viewingCommit: null,
    workingTreeChanged: false,
    expandedContext: new Map(),
    draft: { subject: '', body: '', amend: false },
    commitOpen: false,
    commitsExpanded: false,
  };
}

export type DiffUiAction =
  | { type: 'syncFiles'; paths: string[] }
  | { type: 'toggleInCommit'; path: string }
  | { type: 'setInCommit'; paths: string[]; checked: boolean }
  | { type: 'toggleRead'; path: string; ref: string }
  | { type: 'markRead'; paths: string[]; ref: string }
  | { type: 'collapseRead'; ref: string }
  | { type: 'toggleCollapse'; path: string }
  | { type: 'ensureCollapsed'; paths: string[] }
  | { type: 'toggleFold'; key: string }
  | { type: 'setFilter'; value: string }
  | { type: 'setRailMode'; mode: 'tree' | 'flat' }
  | { type: 'setCursor'; key: string | null }
  | { type: 'viewCommit'; hash: string }
  | { type: 'backToWorktree' }
  | { type: 'flagWorkingTreeChanged' }
  | { type: 'setContext'; path: string; context: number }
  | { type: 'setDraft'; patch: Partial<DiffDraft> }
  | { type: 'setAmend'; amend: boolean; headSubject: string; headBody: string }
  | { type: 'openCommit' }
  | { type: 'closeCommit' }
  | { type: 'toggleCommitsExpanded' }
  | { type: 'commitSucceeded'; paths: string[] };

export function diffUiReducer(state: DiffUiState, action: DiffUiAction): DiffUiState {
  switch (action.type) {
    case 'syncFiles': {
      const pathSet = new Set(action.paths);
      const added = action.paths.filter((p) => !state.knownPaths.has(p));
      const removed = [...state.knownPaths].filter((p) => !pathSet.has(p));
      if (added.length === 0 && removed.length === 0) return state;
      // FR-1 seeding: a newly-appearing path starts checked. A path that left the
      // summary drops from inCommit/collapsed/read (§7 "a path leaves the summary").
      const inCommit = new Set(state.inCommit);
      added.forEach((p) => inCommit.add(p));
      removed.forEach((p) => inCommit.delete(p));
      const collapsed = new Set(state.collapsed);
      removed.forEach((p) => collapsed.delete(p));
      // §7 "a file changes on disk after being read — it becomes unread again":
      // modeled as leaving then re-entering the summary, which this branch already
      // handles by dropping the path from `read` on removal.
      const read = new Map(state.read);
      const worktreeRead = new Set(read.get(WORKTREE_REF) ?? []);
      removed.forEach((p) => worktreeRead.delete(p));
      read.set(WORKTREE_REF, worktreeRead);
      return { ...state, inCommit, collapsed, read, knownPaths: pathSet };
    }

    case 'toggleInCommit': {
      const inCommit = new Set(state.inCommit);
      if (inCommit.has(action.path)) inCommit.delete(action.path);
      else inCommit.add(action.path);
      return { ...state, inCommit };
    }

    case 'setInCommit': {
      const inCommit = new Set(state.inCommit);
      action.paths.forEach((p) => (action.checked ? inCommit.add(p) : inCommit.delete(p)));
      return { ...state, inCommit };
    }

    case 'toggleRead': {
      const read = new Map(state.read);
      const set = new Set(read.get(action.ref) ?? []);
      if (set.has(action.path)) set.delete(action.path);
      else set.add(action.path);
      read.set(action.ref, set);
      return { ...state, read };
    }

    case 'markRead': {
      if (action.paths.length === 0) return state;
      const existing = state.read.get(action.ref) ?? new Set<string>();
      if (action.paths.every((p) => existing.has(p))) return state;
      const read = new Map(state.read);
      const set = new Set(existing);
      action.paths.forEach((p) => set.add(p));
      read.set(action.ref, set);
      return { ...state, read };
    }

    case 'collapseRead': {
      const readSet = state.read.get(action.ref);
      if (!readSet || readSet.size === 0) return state;
      const collapsed = new Set(state.collapsed);
      readSet.forEach((p) => collapsed.add(p));
      return { ...state, collapsed };
    }

    case 'toggleCollapse': {
      const collapsed = new Set(state.collapsed);
      if (collapsed.has(action.path)) collapsed.delete(action.path);
      else collapsed.add(action.path);
      return { ...state, collapsed };
    }

    case 'ensureCollapsed': {
      if (action.paths.every((p) => state.collapsed.has(p))) return state;
      const collapsed = new Set(state.collapsed);
      action.paths.forEach((p) => collapsed.add(p));
      return { ...state, collapsed };
    }

    case 'toggleFold': {
      const folded = new Set(state.folded);
      if (folded.has(action.key)) folded.delete(action.key);
      else folded.add(action.key);
      return { ...state, folded };
    }

    case 'setFilter':
      return state.filter === action.value ? state : { ...state, filter: action.value };

    case 'setRailMode':
      return state.railMode === action.mode ? state : { ...state, railMode: action.mode };

    case 'setCursor':
      return state.cursorKey === action.key ? state : { ...state, cursorKey: action.key };

    case 'viewCommit':
      return { ...state, viewingCommit: action.hash, workingTreeChanged: false };

    case 'backToWorktree':
      return state.viewingCommit === null ? state : { ...state, viewingCommit: null, workingTreeChanged: false };

    case 'flagWorkingTreeChanged':
      return state.workingTreeChanged ? state : { ...state, workingTreeChanged: true };

    case 'setContext': {
      const expandedContext = new Map(state.expandedContext);
      expandedContext.set(action.path, action.context);
      return { ...state, expandedContext };
    }

    case 'setDraft':
      return { ...state, draft: { ...state.draft, ...action.patch } };

    case 'setAmend': {
      // FR-38: pre-fill only the FIRST time it's ticked, and only if both fields are
      // still empty; unticking never clears what the user typed.
      const shouldPrefill = action.amend && state.draft.subject === '' && state.draft.body === '';
      return {
        ...state,
        draft: shouldPrefill ? { subject: action.headSubject, body: action.headBody, amend: true } : { ...state.draft, amend: action.amend },
      };
    }

    case 'openCommit':
      return state.commitOpen ? state : { ...state, commitOpen: true };

    case 'closeCommit':
      return state.commitOpen ? { ...state, commitOpen: false } : state;

    case 'toggleCommitsExpanded':
      return { ...state, commitsExpanded: !state.commitsExpanded };

    case 'commitSucceeded': {
      // FR-37: the draft clears and read state for the committed paths is dropped
      // (the paths themselves drop from inCommit/collapsed on the next syncFiles,
      // once the refreshed summary no longer lists them).
      const read = new Map(state.read);
      const set = new Set(read.get(WORKTREE_REF) ?? []);
      action.paths.forEach((p) => set.delete(p));
      read.set(WORKTREE_REF, set);
      return { ...state, read, draft: { subject: '', body: '', amend: false }, commitOpen: false };
    }

    default:
      return state;
  }
}
