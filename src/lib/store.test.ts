// store.ts composition root — covers the unbound-panes FR-12
// `lastFocusedSessionId` subscription's equalityFn gate: it must only
// recompute when focus/pane-shape/the active session change, not on every
// unrelated store write (fix loop round 4 finding).

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve({ ok: true, value: undefined })) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

vi.mock('./layoutStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./layoutStore')>();
  return { ...actual, clampPaneIndex: vi.fn(actual.clampPaneIndex) };
});

describe('lastFocusedSessionId subscription (unbound-panes FR-12)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('does not recompute on an unrelated store write (equalityFn gates the fresh array selector)', async () => {
    const { useStore } = await import('./store');
    const { clampPaneIndex } = await import('./layoutStore');
    const spy = vi.mocked(clampPaneIndex);
    spy.mockClear();

    // A field the selector does not read at all.
    useStore.setState({ theme: useStore.getState().theme === 'dark' ? 'light' : 'dark' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('does recompute when a selected field (activeSessionId) changes', async () => {
    const { useStore } = await import('./store');
    const { clampPaneIndex } = await import('./layoutStore');
    const spy = vi.mocked(clampPaneIndex);
    spy.mockClear();

    useStore.setState({ activeSessionId: 'some-session' });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
