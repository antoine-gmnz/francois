// The Code tab's zustand store (code-editor §6): the current root, each root's tabs
// (path, version, dirty, view state…), its expanded folders, and its last
// `editor_files` result. Text lives in buffers.ts — Monaco models never enter the
// store. Lives for the app run only (FR-2: nothing is persisted in v1).

import { create } from 'zustand';
import type { EditorEvent, EditorFile, EditorFilesData, EditorRoot } from '../../../contract/code-editor';
import type { AppError, Result, SessionId } from '../../../contract/common';
import { editorClose, editorFiles, editorOpen, editorSave } from '../../lib/api';
import { joinRoot, relativeTo } from '../../lib/path';
import { isLocked, noteFlashLine, touchedBlocks } from './agent-touch';
import { bufferKey, bufferText, createBuffer, dropBuffer, dropRootBuffers, getBuffer, replaceBufferText } from './buffers';
import { closeTab, EMPTY_ROOT_TABS, openTab, touchTab, updateTab, type CodeTab, type RootTabs } from './code-tabs';
import { decideOnChange, staleVersion } from './editor-sync';
import { closeInGroup, dropPath, focusGroup, groupWith, openInGroup, singleGroup, splitGroup, type RootGroups } from './editor-groups';
import { rootKey } from './editor-root';
import { ancestorDirs } from './file-tree';
import { changedLines } from './gutter-diff';
import type { RangeLike } from './symbols';

const RECENT_CAP = 30;

export interface FilesState {
  data: EditorFilesData | null;
  error: AppError | null;
  loading: boolean;
}

/** §7: the inline tree-row hint for a file the editor refused (binary / too large). */
export interface RowHint {
  path: string;
  code: AppError['code'];
  message: string;
}

export interface DirtyTab {
  rootKey: string;
  root: EditorRoot;
  path: string;
}

/** code-editor-workspace: a range an editor group should select once it shows the file. */
export interface SelectRequest {
  rootKey: string;
  path: string;
  /** EditorGroup.id of the target group. */
  groupId: number;
  range: RangeLike;
}

export interface CodeState {
  root: EditorRoot | null;
  /** Every root a tab was ever opened under, so a save can name it again. */
  rootsByKey: Record<string, EditorRoot>;
  tabsByRootKey: Record<string, RootTabs>;
  expandedByRootKey: Record<string, string[]>;
  filesByRootKey: Record<string, FilesState>;
  selectedByRootKey: Record<string, string | null>;
  noticeByRootKey: Record<string, string | null>;
  rowHintByRootKey: Record<string, RowHint | null>;
  /** Most recently opened first — Go to file's RECENT group. */
  recentByRootKey: Record<string, string[]>;
  goToFileOpen: boolean;
  /** FR-13: the window was asked to close with dirty buffers. */
  closePrompt: boolean;
  /** code-editor-agents FR-5: the last picked target per normalised root dir. */
  lastTargetByRootDir: Record<string, SessionId>;
  /** code-editor-agents FR-8: the lines an agent's write just changed, per buffer key. */
  flashByKey: Record<string, { lines: number[]; at: number }>;
  /** code-editor-agents FR-15: a line the editor should reveal once it shows the buffer. */
  revealByKey: Record<string, number>;
  /** code-editor-workspace FR-2: each root's editor groups (absent = one group over the tab records). */
  groupsByRootKey: Record<string, RootGroups>;
  /** FR-2: view state of groups other than id 0, keyed `bufferKey#groupId` (id 0 keeps `CodeTab.viewState`). */
  viewStateByGroupKey: Record<string, unknown>;
  /** FR-3/FR-11/FR-12: the pending caret/selection move. */
  selectRequest: SelectRequest | null;
}

export interface CodeActions {
  setRoot: (root: EditorRoot | null) => void;
  refreshFiles: (root?: EditorRoot) => Promise<void>;
  toggleDir: (path: string) => void;
  select: (path: string | null) => void;
  /** Opens in the focused group; `side` opens in the other group (creating the split). */
  openFile: (path: string, opts?: { side?: boolean }) => Promise<Result<null>>;
  /** Activates `path` in `group` (index), else in the group that shows it — the focused one first. */
  activate: (path: string, group?: number) => void;
  /** Closes the tab record everywhere (buffer + watch) — every group drops the path. */
  closeTab: (rootKey: string, path: string) => Promise<void>;
  /** FR-2: closes `path` in one group; the record goes only when no group shows it any more. */
  closeInGroup: (rootKey: string, group: number, path: string) => Promise<void>;
  focusGroup: (group: number) => void;
  /** FR-2 ⌘\: the focused group's active file in the other group. */
  splitEditor: () => void;
  /** FR-3/FR-12: open `path` in the focused group (or the other with `side`) and select `range`. */
  revealRange: (path: string, range: RangeLike, opts?: { side?: boolean }) => Promise<Result<null>>;
  /** FR-11 `:N` / `@symbol`: select `range` in the focused group's active file. */
  selectInActive: (range: RangeLike) => void;
  consumeSelect: () => void;
  viewStateOf: (rootKey: string, path: string, groupId?: number) => unknown;
  setDirty: (rootKey: string, path: string, dirty: boolean) => void;
  saveViewState: (rootKey: string, path: string, viewState: unknown, groupId?: number) => void;
  save: (rootKey: string, path: string) => Promise<Result<null>>;
  saveAll: () => Promise<boolean>;
  applyEvent: (e: EditorEvent) => Promise<void>;
  reload: (rootKey: string, path: string) => Promise<Result<null>>;
  keepMine: (rootKey: string, path: string) => void;
  dropRoot: (rootKey: string) => void;
  setGoToFileOpen: (open: boolean) => void;
  setClosePrompt: (open: boolean) => void;
  setNotice: (rootKey: string, notice: string | null) => void;
  /** The absolute, normalised path of a tab — null until the root's `editor_files` landed. */
  absPath: (rootKey: string, path: string) => string | null;
  rememberTarget: (rootDir: string, sessionId: SessionId) => void;
  setReview: (rootKey: string, path: string, on: boolean) => void;
  /** FR-15: root the editor at `root` and open `absPath` (inside `rootDir`) at `line`. */
  openAt: (root: EditorRoot, absPath: string, line: number, rootDir: string) => Promise<Result<null>>;
  consumeReveal: (key: string) => void;
}

export function initialCodeState(): CodeState {
  return {
    root: null,
    rootsByKey: {},
    tabsByRootKey: {},
    expandedByRootKey: {},
    filesByRootKey: {},
    selectedByRootKey: {},
    noticeByRootKey: {},
    rowHintByRootKey: {},
    recentByRootKey: {},
    goToFileOpen: false,
    closePrompt: false,
    lastTargetByRootDir: {},
    flashByKey: {},
    revealByKey: {},
    groupsByRootKey: {},
    viewStateByGroupKey: {},
    selectRequest: null,
  };
}

/** FR-2: a root's groups — one group over its tab records until a group transition stored them. */
export function groupsOfRoot(s: Pick<CodeState, 'groupsByRootKey' | 'tabsByRootKey'>, rk: string): RootGroups {
  const stored = s.groupsByRootKey[rk];
  if (stored) return stored;
  const tabs = s.tabsByRootKey[rk] ?? EMPTY_ROOT_TABS;
  return singleGroup(
    tabs.tabs.map((t) => t.path),
    tabs.active,
  );
}

const withoutPrefix = (map: Record<string, unknown>, prefix: string) => Object.fromEntries(Object.entries(map).filter(([k]) => !k.startsWith(prefix)));

/** FR-13 / §7: every dirty tab, across every root. */
export function allDirtyTabs(s: Pick<CodeState, 'tabsByRootKey' | 'rootsByKey'>): DirtyTab[] {
  const out: DirtyTab[] = [];
  for (const [rk, rt] of Object.entries(s.tabsByRootKey)) {
    const root = s.rootsByKey[rk];
    if (!root) continue;
    for (const t of rt.tabs) if (t.dirty) out.push({ rootKey: rk, root, path: t.path });
  }
  return out;
}

const tabFromFile = (f: EditorFile): CodeTab => ({
  path: f.path,
  version: f.version,
  dirty: false,
  viewState: null,
  lineEnding: f.lineEnding,
  bom: f.bom,
  trailingNewline: f.trailingNewline,
  readOnly: f.readOnly,
  readOnlyReason: f.readOnlyReason,
  headText: f.headText,
  conflict: null,
  deleted: false,
  review: false,
});

const diskFacts = (f: EditorFile): Partial<CodeTab> => ({
  version: f.version,
  lineEnding: f.lineEnding,
  bom: f.bom,
  trailingNewline: f.trailingNewline,
  readOnly: f.readOnly,
  readOnlyReason: f.readOnlyReason,
  headText: f.headText,
  deleted: false,
});

const OK_NULL: Result<null> = { ok: true, data: null };

// code-editor-lsp FR-10: didSave follows every save that landed on disk.
const saveListeners = new Set<(rk: string, path: string) => void>();
export function onDidSave(fn: (rk: string, path: string) => void): () => void {
  saveListeners.add(fn);
  return () => saveListeners.delete(fn);
}
const quietClose = (root: EditorRoot, path: string) => void editorClose({ root, path }).catch(() => {});

function without<T>(map: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _gone, ...rest } = map;
  void _gone;
  return rest;
}

export const useCodeStore = create<CodeState & CodeActions>((set, get) => {
  const tabsOf = (rk: string) => get().tabsByRootKey[rk] ?? EMPTY_ROOT_TABS;
  const putTabs = (rk: string, next: RootTabs) => set((s) => ({ tabsByRootKey: { ...s.tabsByRootKey, [rk]: next } }));
  const patch = (rk: string, path: string, p: Partial<CodeTab>) => putTabs(rk, updateTab(tabsOf(rk), path, p));
  const tabOf = (rk: string, path: string) => tabsOf(rk).tabs.find((t) => t.path === path);
  const groupsOf = (rk: string) => groupsOfRoot(get(), rk);
  /** Store the groups and keep the records' `active` on the focused group's active tab. */
  const putGroups = (rk: string, g: RootGroups) => {
    set((s) => ({ groupsByRootKey: { ...s.groupsByRootKey, [rk]: g } }));
    const active = g.groups[g.focused]?.active;
    if (active && tabsOf(rk).active !== active) putTabs(rk, touchTab(tabsOf(rk), active));
  };
  const targetGroup = (g: RootGroups, side: boolean | undefined) => (!side ? g.focused : g.groups.length < 2 ? 1 : 1 - g.focused);
  const current = () => {
    const root = get().root;
    return root ? { root, rk: rootKey(root) } : null;
  };
  const noteRecent = (rk: string, path: string) =>
    set((s) => ({
      recentByRootKey: { ...s.recentByRootKey, [rk]: [path, ...(s.recentByRootKey[rk] ?? []).filter((p) => p !== path)].slice(0, RECENT_CAP) },
    }));
  const absOf = (rk: string, path: string) => {
    const dir = get().filesByRootKey[rk]?.data?.rootDir;
    return dir ? joinRoot(dir, path) : null;
  };
  /** code-editor-agents FR-8: a reload of a file some session touched this turn flashes what changed. */
  const flashIfTouched = (rk: string, path: string, before: string | null, after: string) => {
    const abs = absOf(rk, path);
    if (!abs || before === null) return;
    const blocks = touchedBlocks(abs);
    if (blocks.length === 0) return;
    const lines = changedLines(before, after);
    if (lines.length === 0) return;
    noteFlashLine(blocks, lines[0]);
    set((s) => ({ flashByKey: { ...s.flashByKey, [bufferKey(rk, path)]: { lines, at: Date.now() } } }));
  };
  const reveal = (rk: string, path: string) =>
    set((s) => {
      const open = new Set(s.expandedByRootKey[rk] ?? []);
      for (const dir of ancestorDirs(path)) open.add(dir);
      return {
        expandedByRootKey: { ...s.expandedByRootKey, [rk]: [...open] },
        selectedByRootKey: { ...s.selectedByRootKey, [rk]: path },
      };
    });

  return {
    ...initialCodeState(),

    setRoot: (root) =>
      set((s) => (root ? { root, rootsByKey: { ...s.rootsByKey, [rootKey(root)]: root } } : { root: null })),

    refreshFiles: async (root) => {
      const target = root ?? get().root;
      if (!target) return;
      const rk = rootKey(target);
      set((s) => ({
        filesByRootKey: { ...s.filesByRootKey, [rk]: { data: s.filesByRootKey[rk]?.data ?? null, error: null, loading: true } },
      }));
      const res = await editorFiles({ root: target }).catch(
        (e: unknown): Result<EditorFilesData> => ({ ok: false, error: { code: 'INTERNAL', message: String(e) } }),
      );
      set((s) => ({
        filesByRootKey: {
          ...s.filesByRootKey,
          [rk]: res.ok
            ? { data: res.data, error: null, loading: false }
            : { data: s.filesByRootKey[rk]?.data ?? null, error: res.error, loading: false },
        },
      }));
    },

    toggleDir: (path) => {
      const cur = current();
      if (!cur) return;
      set((s) => {
        const open = s.expandedByRootKey[cur.rk] ?? [];
        const next = open.includes(path) ? open.filter((p) => p !== path) : [...open, path];
        return { expandedByRootKey: { ...s.expandedByRootKey, [cur.rk]: next } };
      });
    },

    select: (path) => {
      const cur = current();
      if (cur) set((s) => ({ selectedByRootKey: { ...s.selectedByRootKey, [cur.rk]: path } }));
    },

    openFile: async (path, opts) => {
      const cur = current();
      if (!cur) return { ok: false, error: { code: 'INVALID_INPUT', message: 'No root selected.' } };
      const { root, rk } = cur;
      set((s) => ({ rowHintByRootKey: { ...s.rowHintByRootKey, [rk]: null } }));
      if (tabOf(rk, path)) {
        const g = groupsOf(rk);
        putGroups(rk, openInGroup(g, targetGroup(g, opts?.side), path));
        noteRecent(rk, path);
        reveal(rk, path);
        return OK_NULL;
      }
      const res = await editorOpen({ root, path });
      if (!res.ok) {
        if (res.error.code === 'EDITOR_BINARY' || res.error.code === 'EDITOR_TOO_LARGE') {
          const hint: RowHint = { path, code: res.error.code, message: res.error.message };
          set((s) => ({ rowHintByRootKey: { ...s.rowHintByRootKey, [rk]: hint } }));
        }
        return res;
      }
      const f = res.data;
      const opened = openTab(tabsOf(rk), tabFromFile(f));
      if (!opened.ok) {
        // The read already started a watch for it — stop it again.
        quietClose(root, f.path);
        const notice = `All ${tabsOf(rk).tabs.length} tabs have unsaved edits — save or close one first.`;
        set((s) => ({ noticeByRootKey: { ...s.noticeByRootKey, [rk]: notice } }));
        return { ok: false, error: { code: 'INTERNAL', message: notice } };
      }
      createBuffer(bufferKey(rk, f.path), f.text);
      let g = groupsOf(rk);
      if (opened.evicted) {
        dropBuffer(bufferKey(rk, opened.evicted));
        quietClose(root, opened.evicted);
        g = dropPath(g, opened.evicted);
      }
      putTabs(rk, opened.state);
      putGroups(rk, openInGroup(g, targetGroup(g, opts?.side), f.path));
      set((s) => ({ noticeByRootKey: { ...s.noticeByRootKey, [rk]: null }, rootsByKey: { ...s.rootsByKey, [rk]: root } }));
      noteRecent(rk, f.path);
      reveal(rk, f.path);
      return OK_NULL;
    },

    activate: (path, group) => {
      const cur = current();
      if (!cur) return;
      const g = groupsOf(cur.rk);
      const at = group ?? groupWith(g, path);
      if (at < 0) putTabs(cur.rk, touchTab(tabsOf(cur.rk), path));
      else putGroups(cur.rk, openInGroup(g, at, path));
    },

    closeTab: async (rk, path) => {
      const root = get().rootsByKey[rk];
      const key = bufferKey(rk, path);
      dropBuffer(key);
      const g = dropPath(groupsOf(rk), path);
      putTabs(rk, closeTab(tabsOf(rk), path));
      putGroups(rk, g);
      set((s) => ({ viewStateByGroupKey: withoutPrefix(s.viewStateByGroupKey, `${key}#`) }));
      if (root) await editorClose({ root, path }).catch(() => {});
    },

    closeInGroup: async (rk, group, path) => {
      const r = closeInGroup(groupsOf(rk), group, path);
      if (r.orphaned) return get().closeTab(rk, path);
      putGroups(rk, r.state);
    },

    focusGroup: (group) => {
      const cur = current();
      if (cur) putGroups(cur.rk, focusGroup(groupsOf(cur.rk), group));
    },

    splitEditor: () => {
      const cur = current();
      if (cur) putGroups(cur.rk, splitGroup(groupsOf(cur.rk)));
    },

    revealRange: async (path, range, opts) => {
      const res = await get().openFile(path, opts);
      const cur = current();
      if (!res.ok || !cur) return res;
      const g = groupsOf(cur.rk);
      set({ selectRequest: { rootKey: cur.rk, path, groupId: g.groups[g.focused]?.id ?? 0, range } });
      return OK_NULL;
    },

    selectInActive: (range) => {
      const cur = current();
      if (!cur) return;
      const g = groupsOf(cur.rk);
      const focused = g.groups[g.focused];
      if (focused?.active) set({ selectRequest: { rootKey: cur.rk, path: focused.active, groupId: focused.id, range } });
    },

    consumeSelect: () => set({ selectRequest: null }),

    viewStateOf: (rk, path, groupId = 0) =>
      groupId === 0 ? (tabOf(rk, path)?.viewState ?? null) : (get().viewStateByGroupKey[`${bufferKey(rk, path)}#${groupId}`] ?? null),

    setDirty: (rk, path, dirty) => {
      if (tabOf(rk, path)?.dirty !== dirty) patch(rk, path, { dirty });
    },

    saveViewState: (rk, path, viewState, groupId = 0) => {
      if (!tabOf(rk, path)) return;
      if (groupId === 0) patch(rk, path, { viewState });
      else set((s) => ({ viewStateByGroupKey: { ...s.viewStateByGroupKey, [`${bufferKey(rk, path)}#${groupId}`]: viewState } }));
    },

    save: async (rk, path) => {
      const root = get().rootsByKey[rk];
      const tab = tabOf(rk, path);
      const key = bufferKey(rk, path);
      const text = bufferText(key);
      if (!root || !tab || text === null || tab.readOnly) return OK_NULL;
      // code-editor-agents FR-18: ⌘S is off while a session is editing this file.
      const abs = absOf(rk, path);
      if (abs && isLocked(abs)) return OK_NULL;
      const res = await editorSave({ root, path, text, baseVersion: tab.version, lineEnding: tab.lineEnding, bom: tab.bom });
      if (!res.ok) {
        const stale = staleVersion(res.error);
        if (stale) patch(rk, path, { conflict: { version: stale } });
        return res;
      }
      const buf = getBuffer(key);
      if (buf) buf.baseline = text;
      // Keystrokes that landed while the write was in flight keep the tab dirty.
      patch(rk, path, { version: res.data.version, dirty: (bufferText(key) ?? text) !== text, deleted: false, conflict: null });
      for (const fn of saveListeners) fn(rk, path);
      void get().refreshFiles(root); // FR-5: the tree refreshes after a save
      return OK_NULL;
    },

    saveAll: async () => {
      let allOk = true;
      for (const d of allDirtyTabs(get())) {
        const res = await get().save(d.rootKey, d.path);
        if (!res.ok) allOk = false;
      }
      return allOk && allDirtyTabs(get()).length === 0;
    },

    applyEvent: async (e) => {
      const rk = rootKey(e.root);
      const { path } = e;
      const tab = tabOf(rk, path);
      if (!tab) return;
      if (e.type === 'editor.deleted') {
        patch(rk, path, { deleted: true });
        return;
      }
      const decision = decideOnChange(tab, e.version);
      if (decision === 'ignore') return;
      const conflict = () => patch(rk, path, { conflict: { version: e.version } });
      if (decision === 'conflict') return conflict();
      const res = await editorOpen({ root: e.root, path });
      const now = tabOf(rk, path);
      if (!res.ok || !now) return;
      // The user may have started typing while we read the disk.
      if (now.dirty) return conflict();
      const key = bufferKey(rk, path);
      const before = bufferText(key);
      const buf = getBuffer(key);
      if (buf) buf.baseline = res.data.text;
      replaceBufferText(key, res.data.text, false);
      patch(rk, path, { ...diskFacts(res.data), dirty: false, conflict: null });
      flashIfTouched(rk, path, before, res.data.text);
    },

    reload: async (rk, path) => {
      const root = get().rootsByKey[rk];
      if (!root) return OK_NULL;
      const res = await editorOpen({ root, path });
      if (!res.ok) return res;
      const key = bufferKey(rk, path);
      const before = bufferText(key);
      const buf = getBuffer(key);
      if (buf) buf.baseline = res.data.text;
      // Mine stays reachable through undo.
      replaceBufferText(key, res.data.text, true);
      patch(rk, path, { ...diskFacts(res.data), dirty: false, conflict: null });
      flashIfTouched(rk, path, before, res.data.text);
      return OK_NULL;
    },

    keepMine: (rk, path) => {
      const tab = tabOf(rk, path);
      if (tab?.conflict) patch(rk, path, { version: tab.conflict.version, conflict: null });
    },

    dropRoot: (rk) => {
      const root = get().rootsByKey[rk];
      if (root) for (const t of tabsOf(rk).tabs) quietClose(root, t.path);
      dropRootBuffers(rk);
      set((s) => ({
        root: s.root && rootKey(s.root) === rk ? null : s.root,
        rootsByKey: without(s.rootsByKey, rk),
        tabsByRootKey: without(s.tabsByRootKey, rk),
        expandedByRootKey: without(s.expandedByRootKey, rk),
        filesByRootKey: without(s.filesByRootKey, rk),
        selectedByRootKey: without(s.selectedByRootKey, rk),
        noticeByRootKey: without(s.noticeByRootKey, rk),
        rowHintByRootKey: without(s.rowHintByRootKey, rk),
        recentByRootKey: without(s.recentByRootKey, rk),
        groupsByRootKey: without(s.groupsByRootKey, rk),
        viewStateByGroupKey: withoutPrefix(s.viewStateByGroupKey, `${rk}::`),
      }));
    },

    setGoToFileOpen: (open) => set({ goToFileOpen: open }),
    setClosePrompt: (open) => set({ closePrompt: open }),
    setNotice: (rk, notice) => set((s) => ({ noticeByRootKey: { ...s.noticeByRootKey, [rk]: notice } })),

    absPath: absOf,

    rememberTarget: (rootDir, sessionId) => set((s) => ({ lastTargetByRootDir: { ...s.lastTargetByRootDir, [rootDir]: sessionId } })),

    setReview: (rk, path, on) => {
      if (tabOf(rk, path)) patch(rk, path, { review: on });
    },

    openAt: async (root, absPath, line, rootDir) => {
      const rk = rootKey(root);
      get().setRoot(root);
      const rel = relativeTo(absPath, rootDir);
      const res = await get().openFile(rel ?? absPath);
      if (!res.ok) {
        if (res.error.code === 'EDITOR_FILE_NOT_FOUND') get().setNotice(rk, `File not found: ${rel ?? absPath}`);
        else if (res.error.code === 'EDITOR_OUTSIDE_ROOT') get().setNotice(rk, `Outside this root: ${absPath}`);
        return res;
      }
      const active = tabsOf(rk).active;
      if (active) set((s) => ({ revealByKey: { ...s.revealByKey, [bufferKey(rk, active)]: line } }));
      return OK_NULL;
    },

    consumeReveal: (key) => set((s) => ({ revealByKey: without(s.revealByKey, key) })),
  };
});
