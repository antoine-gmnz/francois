// The built-in Cohorte integration was retired (specs/_decisions.md, 2026-11-17).
// Older builds persisted Cohorte-shaped window state; loading it must fall back
// to the defaults rather than strand a pane, a panel tab or a Settings page on a
// surface that no longer exists. The francois-plugin-cohorte EXTENSION is a
// separate, still-supported thing (`ext:cohorte` tabs, a pinned `cohorte` id) and
// is deliberately not covered here.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runtimeCapabilities } from '../../contract/multi-provider-seam';
import { mainPaneBranch } from '../app/appShell';
import { resolveSection } from '../app/session-panel/resolve-section';
import { isProjectPage, resolveSettingsPage, type SettingsPage } from '../app/settings/settings-nav';
import type { MainTab } from './agentTabStore';
import { clampToPaneTab, parseSplitState, SPLIT_STORAGE_KEY } from './layoutStore';
import { parseSessionPanelTab, SESSION_PANEL_TABS } from './sessionPanelStore';

const STALE_PREFS = {
  'francois.cohorte.showPanelTab': '1',
  'francois.cohorte.gatesInNeedsYou': '1',
  'francois.cohorte.groupSessionsUnderRun': '1',
  'francois.cohorte.notifyOnGate': '1',
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('stale Cohorte window state falls back to the defaults', () => {
  it('a persisted `cohorte` session-panel tab loads as Changes', () => {
    expect(SESSION_PANEL_TABS).not.toContain('cohorte');
    expect(parseSessionPanelTab('cohorte')).toBe('changes');
    const sections = SESSION_PANEL_TABS.map((id) => ({ id }));
    expect(resolveSection(sections, 'cohorte')?.id).toBe('changes');
  });

  it('a persisted split pane on a `cohorte:<runId>` tab loads on SESSION', () => {
    const raw = JSON.stringify({ extraPanes: [{ kind: 'session', sessionId: 's1', tab: 'cohorte:run_x' }], focusedPaneIndex: 1 });
    expect(parseSplitState(raw).extraPanes).toEqual([{ kind: 'session', sessionId: 's1', tab: 'session' }]);
    const stale = 'cohorte:run_x' as MainTab;
    expect(clampToPaneTab(stale)).toBe('session');
    expect(mainPaneBranch(stale)).not.toBe('cohorte');
  });

  it('a lingering `cohorte` Settings page resolves to General', () => {
    const stale = 'cohorte' as SettingsPage;
    const projects = { projectsOpen: true, accountsOpen: false };
    expect(isProjectPage(stale)).toBe(false);
    expect(resolveSettingsPage(projects, projects, stale)).toBe('general');
  });

  it('boots the store on defaults from an older build’s storage, Cohorte prefs ignored', async () => {
    const stored: Record<string, string> = {
      ...STALE_PREFS,
      'francois.sessionPanelTab': 'cohorte',
      [SPLIT_STORAGE_KEY]: JSON.stringify({ extraPanes: [{ sessionId: 's1', tab: 'cohorte:run_x' }], focusedPaneIndex: 0 }),
    };
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => (k in stored ? stored[k] : null),
      setItem: (k: string, v: string) => {
        stored[k] = v;
      },
      removeItem: (k: string) => {
        delete stored[k];
      },
    });
    const { useStore } = await import('./store');
    const s = useStore.getState();
    expect(s.sessionPanelTab).toBe('changes');
    expect(s.extraPanes).toEqual([{ kind: 'session', sessionId: 's1', tab: 'session' }]);
    expect(s.mainTab.startsWith('cohorte:')).toBe(false);
    expect(Object.keys(s).filter((k) => /cohorte/i.test(k))).toEqual([]);
  });
});

describe('no Cohorte surface survives', () => {
  it('exports no Cohorte IPC wrapper or event listener', async () => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} });
    const api = await import('./api');
    expect(Object.keys(api).filter((name) => /cohorte/i.test(name))).toEqual([]);
  });

  it('no runtime capability points at the Cohorte integration', () => {
    for (const runtime of ['claude-code', 'francois', 'codex', 'grok', 'pi'] as const) {
      for (const cap of Object.values(runtimeCapabilities(runtime))) expect(cap.reason ?? '').not.toMatch(/cohorte/i);
    }
  });
});
