// plugin-system — the frontend state slice (spec §6). Deliberately free of any
// Tauri import so it stays a pure, node-testable store: the IPC wiring lives in
// ./plugin-events, which only ever calls the actions below.
//
// Every registry mutation arrives as a `plugin.registry` full snapshot (FR-80),
// so this store never patches the list item by item — it replaces it and prunes
// the per-plugin caches of anything that is gone (FR-74).

import { create } from 'zustand';
import type {
  InstalledPlugin,
  PanelSpec,
  PluginEvent,
  PluginInstallPhase,
  PluginInstallPreview,
  PluginSurface,
  PluginUpdateInfo,
  StatusItemSpec,
} from '../../../contract/plugin-system';
import { clampSelection, failureKey } from './plugins';

export interface InstallProgress {
  stagingId: string;
  phase: PluginInstallPhase;
  message?: string;
}

interface PluginsState {
  // ---------- registry (FR-80) ----------
  plugins: InstalledPlugin[];
  /** true once the first plugins_list / plugin.registry landed. */
  loaded: boolean;

  // ---------- per-surface render state (FR-71/FR-72) ----------
  /** pluginId → the last core-validated panel spec, or null (handler returned nothing). */
  renderCache: Record<string, PanelSpec | null>;
  /** pluginId → the panel's current error message (FR-73), or null. */
  panelError: Record<string, string | null>;
  /** pluginId → the last status item, or null. */
  statusItems: Record<string, StatusItemSpec | null>;
  /** pluginId → the FR-40 list selection index. */
  selection: Record<string, number>;
  /** pluginId → an invocation is in flight (FR-50 disables its palette rows). */
  busy: Record<string, boolean>;
  /** failureKey → consecutive failures, as counted by the CORE (FR-73). */
  failures: Record<string, number>;
  /** failureKey → a revision the surfaces watch to re-render on plugin.invalidated. */
  invalidation: Record<string, number>;

  // ---------- modal state (§6) ----------
  modalOpen: boolean;
  selectedPluginId: string | null;
  installSpec: string;
  installProgress: InstallProgress | null;
  preview: PluginInstallPreview | null;
  /** pluginId → the last plugins_check_update result. */
  updateInfo: Record<string, PluginUpdateInfo>;

  // ---------- actions ----------
  setPlugins: (plugins: InstalledPlugin[]) => void;
  applyPluginEvent: (e: PluginEvent) => void;
  setPanelSpec: (pluginId: string, spec: PanelSpec | null) => void;
  setPanelError: (pluginId: string, message: string | null) => void;
  setStatusItem: (pluginId: string, item: StatusItemSpec | null) => void;
  setSelection: (pluginId: string, index: number) => void;
  setBusy: (pluginId: string, busy: boolean) => void;
  resetFailures: (pluginId: string, surface: PluginSurface) => void;
  openModal: (pluginId?: string | null) => void;
  closeModal: () => void;
  selectPlugin: (pluginId: string | null) => void;
  setInstallSpec: (spec: string) => void;
  setPreview: (preview: PluginInstallPreview | null) => void;
  setInstallProgress: (p: InstallProgress | null) => void;
  setUpdateInfo: (pluginId: string, info: PluginUpdateInfo | null) => void;
  reset: () => void;
}

const EMPTY = {
  plugins: [] as InstalledPlugin[],
  loaded: false,
  renderCache: {} as Record<string, PanelSpec | null>,
  panelError: {} as Record<string, string | null>,
  statusItems: {} as Record<string, StatusItemSpec | null>,
  selection: {} as Record<string, number>,
  busy: {} as Record<string, boolean>,
  failures: {} as Record<string, number>,
  invalidation: {} as Record<string, number>,
  modalOpen: false,
  selectedPluginId: null as string | null,
  installSpec: '',
  installProgress: null as InstallProgress | null,
  preview: null as PluginInstallPreview | null,
  updateInfo: {} as Record<string, PluginUpdateInfo>,
};

/** Drop every entry whose key names a plugin that is no longer installed. */
function pruneById<T>(map: Record<string, T>, live: Set<string>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [id, v] of Object.entries(map)) if (live.has(id)) out[id] = v;
  return out;
}

/** Same, for the `<pluginId>:<surface>` keyed maps. */
function pruneByCompositeKey<T>(map: Record<string, T>, live: Set<string>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [key, v] of Object.entries(map)) {
    if (live.has(key.slice(0, key.lastIndexOf(':')))) out[key] = v;
  }
  return out;
}

export const usePluginsStore = create<PluginsState>((set) => ({
  ...EMPTY,

  // FR-74/FR-80: the snapshot IS the registry. Anything it dropped loses its
  // pane, status item, selection, failure counter and cached spec with it.
  setPlugins: (plugins) =>
    set((s) => {
      const live = new Set(plugins.map((p) => p.manifest.id));
      return {
        plugins,
        loaded: true,
        renderCache: pruneById(s.renderCache, live),
        panelError: pruneById(s.panelError, live),
        statusItems: pruneById(s.statusItems, live),
        selection: pruneById(s.selection, live),
        busy: pruneById(s.busy, live),
        failures: pruneByCompositeKey(s.failures, live),
        invalidation: pruneByCompositeKey(s.invalidation, live),
        updateInfo: pruneById(s.updateInfo, live),
        selectedPluginId: s.selectedPluginId && live.has(s.selectedPluginId) ? s.selectedPluginId : null,
      };
    }),

  applyPluginEvent: (e) =>
    set((s) => {
      switch (e.type) {
        case 'plugin.registry': {
          // Reuse setPlugins' pruning without duplicating it.
          const live = new Set(e.plugins.map((p) => p.manifest.id));
          return {
            plugins: e.plugins,
            loaded: true,
            renderCache: pruneById(s.renderCache, live),
            panelError: pruneById(s.panelError, live),
            statusItems: pruneById(s.statusItems, live),
            selection: pruneById(s.selection, live),
            busy: pruneById(s.busy, live),
            failures: pruneByCompositeKey(s.failures, live),
            invalidation: pruneByCompositeKey(s.invalidation, live),
            updateInfo: pruneById(s.updateInfo, live),
            selectedPluginId: s.selectedPluginId && live.has(s.selectedPluginId) ? s.selectedPluginId : null,
          };
        }
        case 'plugin.invalidated': {
          // FR-71: carries no spec — bumping the revision is what makes the
          // mounted surface call plugins:render again.
          const key = failureKey(e.pluginId, e.surface);
          return { invalidation: { ...s.invalidation, [key]: (s.invalidation[key] ?? 0) + 1 } };
        }
        case 'plugin.error': {
          // FR-73: `consecutive` is the core's post-increment count and is
          // authoritative — the frontend never counts failures itself.
          const key = failureKey(e.pluginId, e.error.surface);
          const next: Partial<PluginsState> = {
            failures: { ...s.failures, [key]: e.consecutive },
          };
          if (e.error.surface === 'panel') {
            next.panelError = { ...s.panelError, [e.pluginId]: e.error.message };
          }
          return next;
        }
        case 'plugin.install.progress':
          return {
            installProgress: { stagingId: e.stagingId, phase: e.phase, message: e.message },
          };
      }
    }),

  // A successful render is a successful invocation → the counter resets (FR-73).
  setPanelSpec: (pluginId, spec) =>
    set((s) => ({
      renderCache: { ...s.renderCache, [pluginId]: spec },
      panelError: { ...s.panelError, [pluginId]: null },
      failures: { ...s.failures, [failureKey(pluginId, 'panel')]: 0 },
    })),

  setPanelError: (pluginId, message) =>
    set((s) => ({ panelError: { ...s.panelError, [pluginId]: message } })),

  setStatusItem: (pluginId, item) =>
    set((s) => ({
      statusItems: { ...s.statusItems, [pluginId]: item },
      failures: { ...s.failures, [failureKey(pluginId, 'statusBar')]: 0 },
    })),

  setSelection: (pluginId, index) =>
    set((s) => ({ selection: { ...s.selection, [pluginId]: Math.max(0, index) } })),

  setBusy: (pluginId, busy) => set((s) => ({ busy: { ...s.busy, [pluginId]: busy } })),

  resetFailures: (pluginId, surface) =>
    set((s) => ({ failures: { ...s.failures, [failureKey(pluginId, surface)]: 0 } })),

  openModal: (pluginId) =>
    set((s) => ({
      modalOpen: true,
      selectedPluginId: pluginId !== undefined && pluginId !== null ? pluginId : s.selectedPluginId,
    })),

  // Closing throws away the transient install flow: a staged tree the user
  // walked away from is swept by the core after STAGING_TTL_MS (FR-5, edge 9).
  closeModal: () =>
    set({ modalOpen: false, preview: null, installProgress: null, installSpec: '' }),

  selectPlugin: (selectedPluginId) => set({ selectedPluginId, preview: null }),
  setInstallSpec: (installSpec) => set({ installSpec }),
  setPreview: (preview) => set({ preview }),
  setInstallProgress: (installProgress) => set({ installProgress }),
  setUpdateInfo: (pluginId, info) =>
    set((s) => {
      const updateInfo = { ...s.updateInfo };
      if (info === null) delete updateInfo[pluginId];
      else updateInfo[pluginId] = info;
      return { updateInfo };
    }),

  reset: () => set({ ...EMPTY }),
}));

/** The FR-40 selection for a plugin, clamped to the list it is addressing. */
export function selectionFor(pluginId: string, length: number): number {
  return clampSelection(length, usePluginsStore.getState().selection[pluginId] ?? 0);
}
