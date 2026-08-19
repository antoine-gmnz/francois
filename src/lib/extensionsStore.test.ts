// extensions store slice — the tab set (FR-8/FR-13/FR-16) and the live log-tail
// streams (FR-42/FR-43/FR-44/FR-45). Driven through the composed store, like
// layoutStore.test.ts, so the cross-slice writes (mainTab) are covered too.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtensionInfo } from '../../contract/extensions';

const closeStreamCalls: Array<{ streamId: string }> = [];

vi.mock('./api', () => ({
  extensionsCloseStream: (req: { streamId: string }) => {
    closeStreamCalls.push(req);
    return Promise.resolve({ ok: true, data: null });
  },
}));

async function freshStore() {
  vi.resetModules();
  closeStreamCalls.length = 0;
  const mod = await import('./store');
  return mod.useStore;
}

function ext(over: Partial<ExtensionInfo> = {}): ExtensionInfo {
  return {
    id: 'docker',
    label: 'docker',
    enabled: true,
    consent: { state: 'granted' },
    detected: true,
    undetectedReason: null,
    minVersionLabel: null,
    source: {
      dir: '/home/u/.francois/extensions/docker',
      manifestSha256: 'sha-docker',
      declaredCommands: [['docker', 'ps']],
    },
    predicate: { kind: 'commandSucceeds', argv: ['docker', 'info'] },
    panels: [],
    manifestError: null,
    ...over,
  };
}

let useStore: Awaited<ReturnType<typeof freshStore>>;

beforeEach(async () => {
  useStore = await freshStore();
});

describe('the open extension tabs', () => {
  it('marks an opened extension sticky and activates its tab (FR-9)', () => {
    useStore.getState().openExtTab('docker');
    expect(useStore.getState().mainTab).toBe('ext:docker');
    expect(useStore.getState().extStickyIds).toEqual(['docker']);
  });

  it('closing drops the sticky mark and falls back to SESSION (FR-16)', () => {
    useStore.getState().openExtTab('docker');
    useStore.getState().closeExtTab('docker');
    expect(useStore.getState().extStickyIds).toEqual([]);
    expect(useStore.getState().mainTab).toBe('session');
  });

  it('closing a tab with a live stream closes it on the core (FR-16)', () => {
    useStore.getState().openExtTab('docker');
    useStore.getState().startExtStream('docker:logs', '/repo', 's-1', 'web_1');
    useStore.getState().attachExtStream('docker:logs', 's1');
    useStore.getState().closeExtTab('docker');
    expect(useStore.getState().extStreams['docker:logs']).toBeUndefined();
    expect(closeStreamCalls).toEqual([{ streamId: 's1' }]);
  });

  it('closing a tab whose stream open call is still in flight closes nothing on the core (FR-16)', () => {
    useStore.getState().openExtTab('docker');
    useStore.getState().startExtStream('docker:logs', '/repo', 's-1', 'web_1');
    useStore.getState().closeExtTab('docker');
    expect(closeStreamCalls).toEqual([]);
  });

  it('closing a NON-active extension tab leaves the active tab alone', () => {
    useStore.getState().openExtTab('docker');
    useStore.getState().setMainTab('diff');
    useStore.getState().closeExtTab('docker');
    expect(useStore.getState().mainTab).toBe('diff');
  });

  it('disabling an extension closes its tab, drops its sticky mark and its stream (FR-8)', () => {
    useStore.getState().openExtTab('docker');
    useStore.getState().startExtStream('docker:logs', '/repo', 's-1', 'web_1');
    useStore.getState().attachExtStream('docker:logs', 's1');
    useStore.getState().setExtensions([ext({ enabled: false })]);
    expect(useStore.getState().mainTab).toBe('session');
    expect(useStore.getState().extStickyIds).toEqual([]);
    expect(useStore.getState().extStreams['docker:logs']).toBeUndefined();
    expect(closeStreamCalls).toEqual([{ streamId: 's1' }]);
  });

  it('survives a session change, unlike an agent/workflow tab (FR-12)', () => {
    useStore.getState().openExtTab('docker');
    useStore.getState().setActiveSessionId('s-1');
    expect(useStore.getState().mainTab).toBe('ext:docker');
    useStore.getState().setActiveSessionId('s-2');
    expect(useStore.getState().mainTab).toBe('ext:docker');
    expect(useStore.getState().extStickyIds).toEqual(['docker']);
  });

  it('an undetected-but-enabled extension keeps its open tab (FR-13)', () => {
    useStore.getState().openExtTab('docker');
    useStore.getState().setExtensions([ext({ detected: false })]);
    expect(useStore.getState().mainTab).toBe('ext:docker');
    expect(useStore.getState().extStickyIds).toEqual(['docker']);
  });
});

describe('the consent dialog (extension-install FR-16)', () => {
  it('opens against one extension id and closes back to null', () => {
    expect(useStore.getState().extConsentDialogId).toBeNull();
    useStore.getState().openExtConsentDialog('k8s');
    expect(useStore.getState().extConsentDialogId).toBe('k8s');
    useStore.getState().closeExtConsentDialog();
    expect(useStore.getState().extConsentDialogId).toBeNull();
  });
});

describe('log-tail streams', () => {
  it('records the target before the core mints a streamId (FR-38/FR-42)', () => {
    useStore.getState().startExtStream('docker:logs', '/repo', 's-1', 'web_1');
    const s = useStore.getState().extStreams['docker:logs'];
    expect(s.token).toBe('web_1');
    expect(s.root).toBe('/repo');
    expect(s.streamId).toBeNull();
    expect(s.starting).toBe(true);
  });

  it('appends chunks for the stream it owns and drops every other (FR-44)', () => {
    useStore.getState().startExtStream('docker:logs', '/repo', 's-1', 'web_1');
    useStore.getState().attachExtStream('docker:logs', 's1');
    useStore.getState().appendExtStream('s1', ['a', 'b']);
    useStore.getState().appendExtStream('s0', ['ghost']);
    expect(useStore.getState().extStreams['docker:logs'].log.lines).toEqual(['a', 'b']);
  });

  it('keeps the buffer when the process exits and records the code (FR-45)', () => {
    useStore.getState().startExtStream('docker:logs', '/repo', 's-1', 'web_1');
    useStore.getState().attachExtStream('docker:logs', 's1');
    useStore.getState().appendExtStream('s1', ['a']);
    useStore.getState().endExtStream('s1', 1);
    const s = useStore.getState().extStreams['docker:logs'];
    expect(s.log.lines).toEqual(['a']);
    expect(s.exitCode).toBe(1);
    expect(s.streamId).toBeNull();
  });

  it('records a stream error against the owning panel', () => {
    useStore.getState().startExtStream('docker:logs', '/repo', 's-1', 'web_1');
    useStore.getState().attachExtStream('docker:logs', 's1');
    useStore.getState().failExtStream('s1', { code: 'EXT_PATH_OUTSIDE_ROOT', message: 'nope' });
    expect(useStore.getState().extStreams['docker:logs'].error?.code).toBe('EXT_PATH_OUTSIDE_ROOT');
  });

  it('records a refused open against the panel, with no streamId to key on', () => {
    useStore.getState().startExtStream('cohorte:loop-log', '/repo', 's-1', 'extensions');
    useStore.getState().failExtStreamPanel('cohorte:loop-log', { code: 'EXT_PATH_OUTSIDE_ROOT', message: 'nope' });
    const s = useStore.getState().extStreams['cohorte:loop-log'];
    expect(s.error?.code).toBe('EXT_PATH_OUTSIDE_ROOT');
    expect(s.starting).toBe(false);
  });

  it('restarts from an EMPTY buffer when the target changes (FR-42/FR-43)', () => {
    useStore.getState().startExtStream('docker:logs', '/repo', 's-1', 'web_1');
    useStore.getState().attachExtStream('docker:logs', 's1');
    useStore.getState().appendExtStream('s1', ['a']);
    useStore.getState().startExtStream('docker:logs', '/repo', 's-1', 'web_2');
    const s = useStore.getState().extStreams['docker:logs'];
    expect(s.log.lines).toEqual([]);
    expect(s.token).toBe('web_2');
    // a late chunk from the previous stream can never land in the new buffer
    useStore.getState().appendExtStream('s1', ['late']);
    expect(useStore.getState().extStreams['docker:logs'].log.lines).toEqual([]);
  });

  it('drops a panel stream outright (tab close / root change)', () => {
    useStore.getState().startExtStream('docker:logs', '/repo', 's-1', 'web_1');
    useStore.getState().dropExtStream('docker:logs');
    expect(useStore.getState().extStreams['docker:logs']).toBeUndefined();
  });

  it('closes a project-scoped stream on the core immediately when the active session changes (FR-12)', () => {
    useStore.getState().setActiveSessionId('s-1');
    useStore.getState().startExtStream('docker:logs', '/repo', 's-1', 'web_1');
    useStore.getState().attachExtStream('docker:logs', 's1');
    useStore.getState().setActiveSessionId('s-2');
    // Gone synchronously — not left for FR-43's 10 s grace timer, which is a
    // LogTailSection-owned concern for the tab going inactive, not this.
    expect(useStore.getState().extStreams['docker:logs']).toBeUndefined();
    expect(closeStreamCalls).toEqual([{ streamId: 's1' }]);
  });

  it('re-selecting the ALREADY active session leaves its project-scoped streams alone', () => {
    useStore.getState().setActiveSessionId('s-1');
    useStore.getState().startExtStream('docker:logs', '/repo', 's-1', 'web_1');
    useStore.getState().attachExtStream('docker:logs', 's1');
    useStore.getState().setActiveSessionId('s-1');
    expect(useStore.getState().extStreams['docker:logs']).toBeDefined();
    expect(closeStreamCalls).toEqual([]);
  });

  it('a fleet-scoped stream (sessionId null) survives a session change', () => {
    useStore.getState().startExtStream('cohorte:loop-log', null, null, null);
    useStore.getState().attachExtStream('cohorte:loop-log', 's1');
    useStore.getState().setActiveSessionId('s-1');
    useStore.getState().setActiveSessionId('s-2');
    expect(useStore.getState().extStreams['cohorte:loop-log']).toBeDefined();
    expect(closeStreamCalls).toEqual([]);
  });

  it('restarts from an EMPTY buffer on a session change even when the root and token are unchanged (FR-12)', () => {
    // Two sessions sharing a root is exactly the case `root` alone cannot tell
    // apart from a no-op — this is what actually drives the re-scope.
    useStore.getState().startExtStream('docker:logs', '/repo', 's-1', 'web_1');
    useStore.getState().attachExtStream('docker:logs', 's1');
    useStore.getState().appendExtStream('s1', ['a']);
    useStore.getState().startExtStream('docker:logs', '/repo', 's-2', 'web_1');
    const s = useStore.getState().extStreams['docker:logs'];
    expect(s.log.lines).toEqual([]);
    expect(s.sessionId).toBe('s-2');
    expect(s.streamId).toBeNull();
    // a late chunk from the previous session's stream can never land in the new buffer
    useStore.getState().appendExtStream('s1', ['late']);
    expect(useStore.getState().extStreams['docker:logs'].log.lines).toEqual([]);
  });
});

// ---------- rework-top-bar (design 11a): the pin set ----------

describe('the pinned extensions', () => {
  it('starts empty and toggles on and off', () => {
    expect(useStore.getState().extPinnedIds).toEqual([]);
    useStore.getState().toggleExtPin('docker');
    expect(useStore.getState().extPinnedIds).toEqual(['docker']);
    useStore.getState().toggleExtPin('docker');
    expect(useStore.getState().extPinnedIds).toEqual([]);
  });

  it('keeps the order things were pinned in — that IS the bar order', () => {
    useStore.getState().toggleExtPin('cohorte');
    useStore.getState().toggleExtPin('docker');
    expect(useStore.getState().extPinnedIds).toEqual(['cohorte', 'docker']);
  });

  it('drops the pin when the extension is switched off (11a: one switch removes both)', () => {
    useStore.getState().toggleExtPin('docker');
    useStore.getState().setExtensions([ext({ id: 'docker', enabled: false })]);
    expect(useStore.getState().extPinnedIds).toEqual([]);
  });

  it('leaves the pins of extensions that stayed enabled alone', () => {
    useStore.getState().toggleExtPin('docker');
    useStore.getState().toggleExtPin('cohorte');
    useStore.getState().setExtensions([ext({ id: 'docker' }), ext({ id: 'cohorte', enabled: false })]);
    expect(useStore.getState().extPinnedIds).toEqual(['docker']);
  });
});
