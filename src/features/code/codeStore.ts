// The Code tab's zustand store (code-editor §6): the current root, each root's tabs
// (path, version, dirty, view state…), its expanded folders, and its last
// `editor_files` result. Text lives in buffers.ts — Monaco models never enter the
// store. Lives for the app run only (FR-2: nothing is persisted in v1).

import { create } from 'zustand';
import type { EditorEvent, EditorFile, EditorFilesData, EditorRoot } from '../../../contract/code-editor';
import type { AppError, Result } from '../../../contract/common';
import { editorClose, editorFiles, editorOpen, editorSave } from '../../lib/api';
import { bufferKey, bufferText, createBuffer, dropBuffer, dropRootBuffers, getBuffer, replaceBufferText } from './buffers';
import { closeTab, EMPTY_ROOT_TABS, openTab, touchTab, updateTab, type CodeTab, type RootTabs } from './code-tabs';
import { decideOnChange, staleVersion } from './editor-sync';
import { rootKey } from './editor-root';
import { ancestorDirs } from './file-tree';

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
}

export interface CodeActions {
  setRoot: (root: EditorRoot | null) => void;
  refreshFiles: (root?: EditorRoot) => Promise<void>;
  toggleDir: (path: string) => void;
  select: (path: string | null) => void;
  openFile: (path: string) => Promise<Result<null>>;
  activate: (path: string) => void;
  closeTab: (rootKey: string, path: string) => Promise<void>;
  setDirty: (rootKey: string, path: string, dirty: boolean) => void;
  saveViewState: (rootKey: string, path: string, viewState: unknown) => void;
  save: (rootKey: string, path: string) => Promise<Result<null>>;
  saveAll: () => Promise<boolean>;
  applyEvent: (e: EditorEvent) => Promise<void>;
  reload: (rootKey: string, path: string) => Promise<Result<null>>;
  keepMine: (rootKey: string, path: string) => void;
  dropRoot: (rootKey: string) => void;
  setGoToFileOpen: (open: boolean) => void;
  setClosePrompt: (open: boolean) => void;
  setNotice: (rootKey: string, notice: string | null) => void;
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
  };
}

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
  const current = () => {
    const root = get().root;
    return root ? { root, rk: rootKey(root) } : null;
  };
  const noteRecent = (rk: string, path: string) =>
    set((s) => ({
      recentByRootKey: { ...s.recentByRootKey, [rk]: [path, ...(s.recentByRootKey[rk] ?? []).filter((p) => p !== path)].slice(0, RECENT_CAP) },
    }));
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

    openFile: async (path) => {
      const cur = current();
      if (!cur) return { ok: false, error: { code: 'INVALID_INPUT', message: 'No root selected.' } };
      const { root, rk } = cur;
      set((s) => ({ rowHintByRootKey: { ...s.rowHintByRootKey, [rk]: null } }));
      if (tabOf(rk, path)) {
        putTabs(rk, touchTab(tabsOf(rk), path));
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
      if (opened.evicted) {
        dropBuffer(bufferKey(rk, opened.evicted));
        quietClose(root, opened.evicted);
      }
      putTabs(rk, opened.state);
      set((s) => ({ noticeByRootKey: { ...s.noticeByRootKey, [rk]: null }, rootsByKey: { ...s.rootsByKey, [rk]: root } }));
      noteRecent(rk, f.path);
      reveal(rk, f.path);
      return OK_NULL;
    },

    activate: (path) => {
      const cur = current();
      if (cur) putTabs(cur.rk, touchTab(tabsOf(cur.rk), path));
    },

    closeTab: async (rk, path) => {
      const root = get().rootsByKey[rk];
      dropBuffer(bufferKey(rk, path));
      putTabs(rk, closeTab(tabsOf(rk), path));
      if (root) await editorClose({ root, path }).catch(() => {});
    },

    setDirty: (rk, path, dirty) => {
      if (tabOf(rk, path)?.dirty !== dirty) patch(rk, path, { dirty });
    },

    saveViewState: (rk, path, viewState) => {
      if (tabOf(rk, path)) patch(rk, path, { viewState });
    },

    save: async (rk, path) => {
      const root = get().rootsByKey[rk];
      const tab = tabOf(rk, path);
      const key = bufferKey(rk, path);
      const text = bufferText(key);
      if (!root || !tab || text === null || tab.readOnly) return OK_NULL;
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
      const buf = getBuffer(key);
      if (buf) buf.baseline = res.data.text;
      replaceBufferText(key, res.data.text, false);
      patch(rk, path, { ...diskFacts(res.data), dirty: false, conflict: null });
    },

    reload: async (rk, path) => {
      const root = get().rootsByKey[rk];
      if (!root) return OK_NULL;
      const res = await editorOpen({ root, path });
      if (!res.ok) return res;
      const key = bufferKey(rk, path);
      const buf = getBuffer(key);
      if (buf) buf.baseline = res.data.text;
      // Mine stays reachable through undo.
      replaceBufferText(key, res.data.text, true);
      patch(rk, path, { ...diskFacts(res.data), dirty: false, conflict: null });
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
      }));
    },

    setGoToFileOpen: (open) => set({ goToFileOpen: open }),
    setClosePrompt: (open) => set({ closePrompt: open }),
    setNotice: (rk, notice) => set((s) => ({ noticeByRootKey: { ...s.noticeByRootKey, [rk]: notice } })),
  };
});
