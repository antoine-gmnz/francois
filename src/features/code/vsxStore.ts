// code-editor-vsx FR-6/FR-10: the EXTENSIONS sidebar's state — the installed list, the
// Open VSX search (debounced, offset-paged, a stale response dropped), the expanded row and
// its cached details, per-extension busy/error, the grammar warnings vsx-apply reports (§7),
// and the enabled extensions' contributions, which vsx-apply.ts applies to Monaco.

import { create } from 'zustand';
import type { AppError } from '../../../contract/common';
import type { VsxContributionCounts, VsxContributions, VsxDetails, VsxId, VsxInstalled, VsxSummary, VsxSupport } from '../../../contract/code-editor-vsx';
import { vsxContributions, vsxDetails, vsxInstall, vsxList, vsxSearch, vsxSetEnabled, vsxUninstall } from '../../lib/api';
import { setContributedLanguages } from './language';
import { plural } from './searchStore';

export const SEARCH_DEBOUNCE_MS = 300;

export type VsxBusy = 'install' | 'uninstall' | 'toggle';

export interface DetailsEntry {
  status: 'loading' | 'done' | 'error';
  data: VsxDetails | null;
  error: string | null;
}

export interface VsxState {
  installed: VsxInstalled[];
  query: string;
  results: VsxSummary[];
  total: number;
  /** `more` = a load-more page is in flight, the shown results kept. */
  searchStatus: 'idle' | 'loading' | 'more' | 'done' | 'error';
  searchError: string | null;
  expanded: VsxId | null;
  details: Record<VsxId, DetailsEntry>;
  busy: Record<VsxId, VsxBusy>;
  rowErrors: Record<VsxId, string>;
  /** §7: a contributed grammar that failed to compile, per extension. */
  warnings: Record<VsxId, string>;
  /** What the enabled extensions contribute, oldest install first; null until first loaded. */
  contributions: VsxContributions | null;
}

export interface VsxActions {
  setQuery: (query: string) => void;
  /** Page 0 of the current query, now (no debounce). */
  search: () => Promise<void>;
  loadMore: () => Promise<void>;
  /** Retry whichever step failed — the first page, or the page after the shown results. */
  retry: () => Promise<void>;
  toggleExpanded: (id: VsxId) => Promise<void>;
  loadDetails: (id: VsxId) => Promise<void>;
  install: (id: VsxId) => Promise<void>;
  uninstall: (id: VsxId) => Promise<void>;
  setEnabled: (id: VsxId, enabled: boolean) => Promise<void>;
  dismissRowError: (id: VsxId) => void;
  setWarning: (id: VsxId, warning: string | null) => void;
  /** FR-10: re-read the installed list and the contributions (local, no network). */
  reloadContributions: () => Promise<void>;
}

export function initialVsxState(): VsxState {
  return {
    installed: [],
    query: '',
    results: [],
    total: 0,
    searchStatus: 'idle',
    searchError: null,
    expanded: null,
    details: {},
    busy: {},
    rowErrors: {},
    warnings: {},
    contributions: null,
  };
}

/** Download counts the way the Marketplace prints them: `999`, `1.5K`, `34K`, `1.2M`. */
export function formatDownloads(n: number): string {
  const short = (v: number) => (v < 10 ? String(Math.floor(v * 10) / 10) : String(Math.floor(v)));
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${short(n / 1_000)}K`;
  return `${short(n / 1_000_000)}M`;
}

/** `2 languages · 1 grammar · 3 snippet files`, zeros left out. */
export function contributionSummary(c: VsxContributionCounts): string {
  const parts: Array<[number, string]> = [
    [c.languages, 'language'],
    [c.grammars, 'grammar'],
    [c.snippets, 'snippet file'],
    [c.languageConfigurations, 'language configuration'],
  ];
  return parts
    .filter(([n]) => n > 0)
    .map(([n, word]) => plural(n, word))
    .join(' · ');
}

export function supportLabel(support: VsxSupport): string {
  if (support === 'full') return 'Full';
  if (support === 'partial') return 'Syntax & snippets only';
  return 'Needs VS Code';
}

export function vsxErrorText(error: AppError): string {
  switch (error.code) {
    case 'VSX_UNREACHABLE':
      return "Can't reach Open VSX — check your connection.";
    case 'VSX_NOT_FOUND':
      return 'Not found on Open VSX.';
    case 'VSX_INVALID_PACKAGE': {
      const d = error.detail as { reason?: unknown } | undefined;
      return typeof d?.reason === 'string' ? `The package failed verification: ${d.reason}.` : 'The package failed verification.';
    }
    case 'VSX_UNSUPPORTED':
      return 'Needs VS Code — this extension runs code and contributes nothing declarative.';
    default:
      return error.message;
  }
}

/** Every contribution list ordered by its extension's install time, oldest first (an unknown
 *  extension sorts first), so "the later wins" means "the most recent install wins" (§7). */
export function orderContributions(c: VsxContributions, installed: readonly VsxInstalled[]): VsxContributions {
  const at = new Map(installed.map((i) => [i.id, i.installedAt]));
  const sort = <T extends { extensionId: VsxId }>(list: readonly T[]) => [...list].sort((a, b) => (at.get(a.extensionId) ?? 0) - (at.get(b.extensionId) ?? 0));
  return { languages: sort(c.languages), grammars: sort(c.grammars), snippets: sort(c.snippets) };
}

const without = <T>(rec: Record<VsxId, T>, id: VsxId): Record<VsxId, T> => {
  if (!(id in rec)) return rec;
  const next = { ...rec };
  delete next[id];
  return next;
};
const byName = (a: VsxInstalled, b: VsxInstalled) => a.displayName.localeCompare(b.displayName);

let searchSeq = 0;
let debounce: ReturnType<typeof setTimeout> | null = null;

export const useVsxStore = create<VsxState & VsxActions>((set, get) => {
  /** Runs `op` with `id` marked busy; on success applies `onOk` and reloads the contributions. */
  async function mutate<T>(id: VsxId, kind: VsxBusy, op: () => Promise<{ ok: true; data: T } | { ok: false; error: AppError }>, onOk: (data: T) => Partial<VsxState>): Promise<void> {
    set((s) => ({ busy: { ...s.busy, [id]: kind }, rowErrors: without(s.rowErrors, id) }));
    const res = await op();
    if (res.ok) set((s) => ({ ...onOk(res.data), busy: without(s.busy, id) }));
    else set((s) => ({ busy: without(s.busy, id), rowErrors: { ...s.rowErrors, [id]: vsxErrorText(res.error) } }));
    if (res.ok) await get().reloadContributions();
  }

  return {
    ...initialVsxState(),

    setQuery: (query) => {
      set({ query });
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => void get().search(), SEARCH_DEBOUNCE_MS);
    },

    search: async () => {
      if (debounce) clearTimeout(debounce);
      debounce = null;
      const seq = ++searchSeq;
      set({ searchStatus: 'loading', searchError: null });
      const res = await vsxSearch({ query: get().query.trim(), offset: 0 });
      if (seq !== searchSeq) return;
      if (res.ok) set({ results: res.data.results, total: res.data.total, searchStatus: 'done' });
      else set({ results: [], total: 0, searchStatus: 'error', searchError: vsxErrorText(res.error) });
    },

    loadMore: async () => {
      const { searchStatus, results, query } = get();
      if (searchStatus === 'loading' || searchStatus === 'more') return;
      const seq = searchSeq;
      set({ searchStatus: 'more', searchError: null });
      const res = await vsxSearch({ query: query.trim(), offset: results.length });
      if (seq !== searchSeq) return;
      if (res.ok) {
        const seen = new Set(get().results.map((r) => r.id));
        set((s) => ({ results: [...s.results, ...res.data.results.filter((r) => !seen.has(r.id))], total: res.data.total, searchStatus: 'done' }));
      } else set({ searchStatus: 'error', searchError: vsxErrorText(res.error) });
    },

    retry: () => (get().results.length > 0 ? get().loadMore() : get().search()),

    toggleExpanded: async (id) => {
      if (get().expanded === id) {
        set({ expanded: null });
        return;
      }
      set({ expanded: id });
      const cached = get().details[id];
      if (!cached || cached.status === 'error') await get().loadDetails(id);
    },

    loadDetails: async (id) => {
      set((s) => ({ details: { ...s.details, [id]: { status: 'loading', data: s.details[id]?.data ?? null, error: null } } }));
      const res = await vsxDetails({ id });
      const entry: DetailsEntry = res.ok ? { status: 'done', data: res.data, error: null } : { status: 'error', data: null, error: vsxErrorText(res.error) };
      set((s) => ({ details: { ...s.details, [id]: entry } }));
    },

    install: (id) =>
      mutate(id, 'install', () => vsxInstall({ id }), (ext) => ({ installed: [...get().installed.filter((i) => i.id !== ext.id), ext].sort(byName) })),

    uninstall: (id) =>
      mutate(id, 'uninstall', () => vsxUninstall({ id }), () => ({ installed: get().installed.filter((i) => i.id !== id), warnings: without(get().warnings, id) })),

    setEnabled: (id, enabled) =>
      mutate(id, 'toggle', () => vsxSetEnabled({ id, enabled }), (ext) => ({
        installed: get().installed.map((i) => (i.id === ext.id ? ext : i)),
        warnings: ext.enabled ? get().warnings : without(get().warnings, id),
      })),

    dismissRowError: (id) => set((s) => ({ rowErrors: without(s.rowErrors, id) })),

    setWarning: (id, warning) => set((s) => ({ warnings: warning ? { ...s.warnings, [id]: warning } : without(s.warnings, id) })),

    reloadContributions: async () => {
      const [list, contributions] = await Promise.all([vsxList(), vsxContributions()]);
      const installed = list.ok ? [...list.data].sort(byName) : get().installed;
      if (!contributions.ok) {
        set({ installed });
        return;
      }
      const ordered = orderContributions(contributions.data, installed);
      setContributedLanguages(ordered.languages);
      set({ installed, contributions: ordered });
    },
  };
});
