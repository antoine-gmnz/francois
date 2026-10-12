// code-editor-workspace FR-12/FR-13: the SEARCH sidebar's state — query, toggles,
// include glob, the last `editor_search` result, and Replace All. A search runs
// SEARCH_DEBOUNCE_MS after the last change; a response older than the newest request
// is dropped. One search per app run, reset when the Code tab's root changes.

import { create } from 'zustand';
import type { EditorRoot } from '../../../contract/code-editor';
import type {
  EditorReplaceFileTarget,
  EditorSearchData,
  EditorSearchFile,
  EditorSearchMatch,
  EditorSearchOptions,
} from '../../../contract/code-editor-workspace';
import { editorReplace, editorSearch } from '../../lib/api';
import type { CodeTab } from './code-tabs';
import { rootKey } from './editor-root';
import type { RangeLike } from './symbols';

export const SEARCH_DEBOUNCE_MS = 300;

export interface SearchState {
  rootKey: string | null;
  query: string;
  replacement: string;
  include: string;
  options: EditorSearchOptions;
  preserveCase: boolean;
  status: 'idle' | 'loading' | 'done' | 'error';
  error: string | null;
  result: EditorSearchData | null;
  /** Result files folded shut. */
  collapsed: string[];
  /** The last Replace All's outcome. */
  notice: string | null;
}

export interface SearchActions {
  syncRoot: (root: EditorRoot) => void;
  setQuery: (root: EditorRoot, query: string) => void;
  setInclude: (root: EditorRoot, include: string) => void;
  toggleOption: (root: EditorRoot, option: keyof EditorSearchOptions) => void;
  setReplacement: (replacement: string) => void;
  togglePreserveCase: () => void;
  toggleCollapsed: (path: string) => void;
  setNotice: (notice: string | null) => void;
  /** Search now (no debounce). */
  run: (root: EditorRoot) => Promise<void>;
  replaceAll: (root: EditorRoot, tabs: readonly CodeTab[]) => Promise<void>;
}

export function initialSearchState(): SearchState {
  return {
    rootKey: null,
    query: '',
    replacement: '',
    include: '',
    options: { matchCase: false, wholeWord: false, regex: false },
    preserveCase: false,
    status: 'idle',
    error: null,
    result: null,
    collapsed: [],
    notice: null,
  };
}

export interface ReplacePlan {
  targets: EditorReplaceFileTarget[];
  /** Result files left out because their buffer has unsaved edits. */
  dirty: string[];
  /** Matches across `targets`. */
  matches: number;
}

/** FR-13: every result file without a dirty buffer; open clean tabs send their version. */
export function replacePlan(files: readonly EditorSearchFile[], tabs: readonly CodeTab[]): ReplacePlan {
  const byPath = new Map(tabs.map((t) => [t.path, t]));
  const plan: ReplacePlan = { targets: [], dirty: [], matches: 0 };
  for (const f of files) {
    const t = byPath.get(f.path);
    if (t?.dirty) {
      plan.dirty.push(f.path);
      continue;
    }
    plan.targets.push(t ? { path: f.path, baseVersion: t.version } : { path: f.path });
    plan.matches += f.matches.length;
  }
  return plan;
}

/** The match's range in the file: its column plus the bolded preview span's length. */
export function matchRange(m: EditorSearchMatch): RangeLike {
  return { startLineNumber: m.line, startColumn: m.column, endLineNumber: m.line, endColumn: m.column + (m.previewEnd - m.previewStart) };
}

export const plural = (n: number, word: string) => `${n} ${n === 1 ? word : `${word}${word.endsWith('ch') ? 'es' : 's'}`}`;

let seq = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

export const useSearchStore = create<SearchState & SearchActions>((set, get) => {
  const schedule = (root: EditorRoot) => {
    clearTimeout(timer);
    timer = setTimeout(() => void get().run(root), SEARCH_DEBOUNCE_MS);
  };

  return {
    ...initialSearchState(),

    syncRoot: (root) => {
      const rk = rootKey(root);
      if (get().rootKey === rk) return;
      clearTimeout(timer);
      seq++;
      set({ ...initialSearchState(), rootKey: rk });
    },

    setQuery: (root, query) => {
      set({ query });
      schedule(root);
    },

    setInclude: (root, include) => {
      set({ include });
      schedule(root);
    },

    toggleOption: (root, option) => {
      set((s) => ({ options: { ...s.options, [option]: !s.options[option] } }));
      schedule(root);
    },

    setReplacement: (replacement) => set({ replacement }),
    togglePreserveCase: () => set((s) => ({ preserveCase: !s.preserveCase })),
    toggleCollapsed: (path) =>
      set((s) => ({ collapsed: s.collapsed.includes(path) ? s.collapsed.filter((p) => p !== path) : [...s.collapsed, path] })),
    setNotice: (notice) => set({ notice }),

    run: async (root) => {
      clearTimeout(timer);
      const mine = ++seq;
      const { query, options, include } = get();
      if (query.trim() === '') {
        set({ status: 'idle', error: null, result: null });
        return;
      }
      set({ status: 'loading', rootKey: rootKey(root) });
      const res = await editorSearch({ root, query, options, include }).catch(
        (e: unknown) => ({ ok: false, error: { code: 'INTERNAL', message: String(e) } }) as const,
      );
      if (mine !== seq) return; // a newer search owns the sidebar now
      if (res.ok) set({ status: 'done', error: null, result: res.data });
      else set({ status: 'error', error: res.error.message, result: null });
    },

    replaceAll: async (root, tabs) => {
      const { result, query, options, replacement, preserveCase } = get();
      if (!result) return;
      const plan = replacePlan(result.files, tabs);
      const parts: string[] = [];
      if (plan.targets.length > 0) {
        const res = await editorReplace({ root, query, options, replacement, preserveCase, files: plan.targets }).catch(
          (e: unknown) => ({ ok: false, error: { code: 'INTERNAL', message: String(e) } }) as const,
        );
        if (!res.ok) {
          set({ notice: `Replace failed: ${res.error.message}` });
          return;
        }
        const count = res.data.written.reduce((n, w) => n + w.replacements, 0);
        parts.push(`Replaced ${plural(count, 'match')} in ${plural(res.data.written.length, 'file')}.`);
        const stale = res.data.skipped.filter((x) => x.reason === 'stale').length;
        const other = res.data.skipped.length - stale;
        if (stale > 0) parts.push(`${plural(stale, 'file')} changed on disk and ${stale === 1 ? 'was' : 'were'} skipped.`);
        if (other > 0) parts.push(`${plural(other, 'file')} could not be written.`);
      }
      if (plan.dirty.length > 0) parts.push(`Skipped ${plural(plan.dirty.length, 'file')} with unsaved edits: ${plan.dirty.join(', ')}`);
      set({ notice: parts.join(' ') });
      await get().run(root);
    },
  };
});
