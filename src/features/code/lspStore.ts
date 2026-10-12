// code-editor-lsp FR-12/FR-14/FR-15/FR-16: the language servers as the Code tab sees
// them — one status per (root key, language), work-done progress, the diagnostics of
// files that have no Monaco model (the Problems panel shows them too), the trust
// prompts dismissed for this run, and the starts in flight. App-run only.
//
// Two Code roots on one directory share a server (spec §7): the core reports it under
// one EditorRoot, so a status/progress event is mirrored onto every loaded root whose
// `rootUri` matches, and diagnostics land on every root whose directory holds the file.

import { create } from 'zustand';
import type { EditorRoot } from '../../../contract/code-editor';
import type { LspEvent, LspLanguage, LspServerStatus } from '../../../contract/code-editor-lsp';
import { lspStart, lspStatus, lspStop, lspTrust } from '../../lib/api';
import { rootKey } from './editor-root';
import { relPathOf, toMarkerData, type LspDiagnostic } from './lsp-convert';
import type { LspProgress } from './lsp-status';
import { toProblem, type Problem } from './problems';

export const lspKey = (rk: string, language: LspLanguage) => `${rk}|${language}`;

export interface OrphanDiagnostics {
  language: LspLanguage;
  /** The raw LSP diagnostics — handed to the model as markers if it opens. */
  diagnostics: unknown[];
  problems: Problem[];
}

export interface LspStoreState {
  statusByKey: Record<string, LspServerStatus>;
  /** Roots whose `lsp_status` landed this run. */
  loadedByRootKey: Record<string, true>;
  /** Live work-done tokens per lspKey. */
  progressByKey: Record<string, Record<string, LspProgress>>;
  /** FR-12: diagnostics of files without a model, per root key → path. */
  orphansByRootKey: Record<string, Record<string, OrphanDiagnostics>>;
  /** FR-15: "Not now" (or a revoke) for the app run. */
  dismissedByRootKey: Record<string, true>;
  /** FR-16: an lsp_start in flight. */
  pendingByKey: Record<string, true>;
}

export interface LspStoreActions {
  loadStatuses: (root: EditorRoot, opts?: { force?: boolean }) => Promise<void>;
  setStatuses: (rk: string, statuses: LspServerStatus[]) => void;
  applyEvent: (e: LspEvent) => void;
  dropOrphan: (rk: string, path: string) => void;
  dismissTrust: (rk: string) => void;
  trust: (root: EditorRoot, trusted: boolean) => Promise<boolean>;
  start: (root: EditorRoot, language: LspLanguage) => Promise<void>;
  restart: (root: EditorRoot, language: LspLanguage) => Promise<void>;
}

export function initialLspState(): LspStoreState {
  return { statusByKey: {}, loadedByRootKey: {}, progressByKey: {}, orphansByRootKey: {}, dismissedByRootKey: {}, pendingByKey: {} };
}

const NO_PROGRESS: LspProgress[] = [];

export function progressOf(s: Pick<LspStoreState, 'progressByKey'>, rk: string, language: LspLanguage): LspProgress[] {
  const map = s.progressByKey[lspKey(rk, language)];
  return map ? Object.values(map) : NO_PROGRESS;
}

/** Every loaded root key sharing the server of (rootUri, language). */
function sameServer(s: LspStoreState, rootUri: string, language: LspLanguage): string[] {
  const out: string[] = [];
  for (const st of Object.values(s.statusByKey)) if (st.language === language && st.rootUri === rootUri) out.push(rootKey(st.root));
  return out;
}

/** FR-12 / §7: the (root key, path) pairs a diagnostics event is about — none for a file outside every root. */
export function diagnosticTargets(s: Pick<LspStoreState, 'statusByKey'>, e: Extract<LspEvent, { type: 'lsp.diagnostics' }>): Array<{ rootKey: string; path: string }> {
  const out: Array<{ rootKey: string; path: string }> = [];
  for (const st of Object.values(s.statusByKey)) {
    if (st.language !== e.language) continue;
    const path = relPathOf(st.rootUri, e.uri);
    if (path !== null) out.push({ rootKey: rootKey(st.root), path });
  }
  return out;
}

const noUri = () => null;

function without<T>(map: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _gone, ...rest } = map;
  void _gone;
  return rest;
}

export const useLspStore = create<LspStoreState & LspStoreActions>((set, get) => {
  const withStatus = (s: LspStoreState, rk: string, status: LspServerStatus): Partial<LspStoreState> => {
    const key = lspKey(rk, status.language);
    const live = status.state === 'starting' || status.state === 'ready';
    let orphans = s.orphansByRootKey;
    if (status.state !== 'ready' && orphans[rk]) {
      const kept = Object.fromEntries(Object.entries(orphans[rk]).filter(([, o]) => o.language !== status.language));
      orphans = { ...orphans, [rk]: kept };
    }
    return {
      statusByKey: { ...s.statusByKey, [key]: status },
      progressByKey: live ? s.progressByKey : without(s.progressByKey, key),
      orphansByRootKey: orphans,
    };
  };

  const applyStatus = (status: LspServerStatus) =>
    set((s) => {
      const keys = new Set([rootKey(status.root), ...sameServer(s, status.rootUri, status.language)]);
      let next: LspStoreState = s;
      for (const rk of keys) {
        const root = next.statusByKey[lspKey(rk, status.language)]?.root ?? status.root;
        next = { ...next, ...withStatus(next, rk, { ...status, root }) };
      }
      return next;
    });

  return {
    ...initialLspState(),

    loadStatuses: async (root, opts) => {
      const rk = rootKey(root);
      if (get().loadedByRootKey[rk] && !opts?.force) return;
      const res = await lspStatus({ root }).catch(() => null);
      if (res?.ok && Array.isArray(res.data)) get().setStatuses(rk, res.data);
    },

    setStatuses: (rk, statuses) =>
      set((s) => {
        let next: LspStoreState = { ...s, loadedByRootKey: { ...s.loadedByRootKey, [rk]: true } };
        for (const st of statuses) next = { ...next, ...withStatus(next, rk, st) };
        return next;
      }),

    applyEvent: (e) => {
      if (e.type === 'lsp.status') return applyStatus(e.status);
      if (e.type === 'lsp.progress') {
        const origin = get().statusByKey[lspKey(rootKey(e.root), e.language)];
        const keys = new Set([rootKey(e.root), ...(origin ? sameServer(get(), origin.rootUri, e.language) : [])]);
        set((s) => {
          const progressByKey = { ...s.progressByKey };
          for (const rk of keys) {
            const key = lspKey(rk, e.language);
            const tokens = { ...(progressByKey[key] ?? {}) };
            if (e.done) delete tokens[e.token];
            else tokens[e.token] = { title: e.title, message: e.message, percentage: e.percentage };
            progressByKey[key] = tokens;
          }
          return { progressByKey };
        });
        return;
      }
      const targets = diagnosticTargets(get(), e);
      if (targets.length === 0) return;
      set((s) => {
        const orphansByRootKey = { ...s.orphansByRootKey };
        for (const { rootKey: rk, path } of targets) {
          const files = { ...(orphansByRootKey[rk] ?? {}) };
          if (e.diagnostics.length === 0) delete files[path];
          else {
            const problems = e.diagnostics.map((d) => toProblem(path, toMarkerData(d as LspDiagnostic, e.language, noUri)));
            files[path] = { language: e.language, diagnostics: e.diagnostics, problems };
          }
          orphansByRootKey[rk] = files;
        }
        return { orphansByRootKey };
      });
    },

    dropOrphan: (rk, path) =>
      set((s) => (s.orphansByRootKey[rk]?.[path] ? { orphansByRootKey: { ...s.orphansByRootKey, [rk]: without(s.orphansByRootKey[rk], path) } } : s)),

    dismissTrust: (rk) => set((s) => ({ dismissedByRootKey: { ...s.dismissedByRootKey, [rk]: true } })),

    trust: async (root, trusted) => {
      const rk = rootKey(root);
      const res = await lspTrust({ root, trusted }).catch(() => null);
      if (!res?.ok || !Array.isArray(res.data)) return false;
      get().setStatuses(rk, res.data);
      // An explicit revoke is an answer too: the prompt stays away for the run.
      set((s) => ({
        dismissedByRootKey: trusted ? without(s.dismissedByRootKey, rk) : { ...s.dismissedByRootKey, [rk]: true },
        orphansByRootKey: trusted ? s.orphansByRootKey : without(s.orphansByRootKey, rk),
      }));
      return true;
    },

    start: async (root, language) => {
      const rk = rootKey(root);
      const key = lspKey(rk, language);
      if (get().pendingByKey[key]) return;
      set((s) => ({ pendingByKey: { ...s.pendingByKey, [key]: true } }));
      const res = await lspStart({ root, language }).catch(() => null);
      set((s) => ({ pendingByKey: without(s.pendingByKey, key) }));
      if (res?.ok) applyStatus(res.data);
      else await get().loadStatuses(root, { force: true });
    },

    restart: async (root, language) => {
      await lspStop({ root, language }).catch(() => null);
      await get().start(root, language);
    },
  };
});
