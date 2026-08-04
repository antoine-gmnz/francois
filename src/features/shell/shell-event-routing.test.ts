// multiple-shells FR-14: the global francois://shell/event listener
// (initShellEvents) — routes shell.data/shell.exit into the store, marking a
// shell unread only when it is not the DISPLAYED one (wrong chip, non-SHELL
// tab, or non-active session), and only on the false → true transition.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShellEvent } from '../../../contract/shell-terminal';

const { listenMock } = vi.hoisted(() => ({ listenMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }));

describe('initShellEvents (FR-14)', () => {
  let shellHandler: ((e: { payload: ShellEvent }) => void) | undefined;
  let shellStore: typeof import('./shellStore');
  let appStore: typeof import('../../lib/store');

  beforeEach(async () => {
    vi.resetModules();
    shellHandler = undefined;
    listenMock.mockReset().mockImplementation((channel: string, cb: (e: { payload: unknown }) => void) => {
      if (channel === 'francois://shell/event') shellHandler = cb as (e: { payload: ShellEvent }) => void;
      return Promise.resolve(vi.fn());
    });
    appStore = await import('../../lib/store');
    shellStore = await import('./shellStore');
    appStore.useStore.setState({ mainTab: 'session', activeSessionId: null });
    shellStore.useShellStore.setState({ shells: {}, activeShellId: {}, unread: {}, renameRequest: null });
  });

  function seedShell(sessionId: string, shellId: string) {
    shellStore.useShellStore.getState().setShells(sessionId, [
      { id: shellId, sessionId, name: 'zsh 1', shellName: 'zsh', cwd: '/tmp', alive: true },
    ]);
  }

  it('is idempotent — a second call registers the listener only once', async () => {
    shellStore.initShellEvents();
    shellStore.initShellEvents();
    expect(listenMock.mock.calls.filter((c) => c[0] === 'francois://shell/event')).toHaveLength(1);
  });

  it('marks a shell unread on shell.data when its session is not the active one', () => {
    shellStore.initShellEvents();
    seedShell('s1', 'sh1');
    appStore.useStore.setState({ mainTab: 'shell', activeSessionId: 's2' });
    shellHandler?.({ payload: { type: 'shell.data', shellId: 'sh1', sessionId: 's1', data: 'hi' } });
    expect(shellStore.useShellStore.getState().unread.sh1).toBe(true);
  });

  it('marks a shell unread on shell.data when the main tab is not SHELL', () => {
    shellStore.initShellEvents();
    seedShell('s1', 'sh1');
    appStore.useStore.setState({ mainTab: 'session', activeSessionId: 's1' });
    shellHandler?.({ payload: { type: 'shell.data', shellId: 'sh1', sessionId: 's1', data: 'hi' } });
    expect(shellStore.useShellStore.getState().unread.sh1).toBe(true);
  });

  it('marks a shell unread on shell.data when it is not the session-active chip', () => {
    shellStore.initShellEvents();
    shellStore.useShellStore.getState().setShells('s1', [
      { id: 'sh1', sessionId: 's1', name: 'zsh 1', shellName: 'zsh', cwd: '/tmp', alive: true },
      { id: 'sh2', sessionId: 's1', name: 'zsh 2', shellName: 'zsh', cwd: '/tmp', alive: true },
    ]);
    shellStore.useShellStore.getState().setActiveShellId('s1', 'sh2');
    appStore.useStore.setState({ mainTab: 'shell', activeSessionId: 's1' });
    shellHandler?.({ payload: { type: 'shell.data', shellId: 'sh1', sessionId: 's1', data: 'hi' } });
    expect(shellStore.useShellStore.getState().unread.sh1).toBe(true);
    expect(shellStore.useShellStore.getState().unread.sh2).toBeUndefined();
  });

  it('does not mark the displayed shell unread on its own shell.data', () => {
    shellStore.initShellEvents();
    seedShell('s1', 'sh1');
    shellStore.useShellStore.getState().setActiveShellId('s1', 'sh1');
    appStore.useStore.setState({ mainTab: 'shell', activeSessionId: 's1' });
    shellHandler?.({ payload: { type: 'shell.data', shellId: 'sh1', sessionId: 's1', data: 'hi' } });
    expect(shellStore.useShellStore.getState().unread.sh1).toBeUndefined();
  });

  it('shell.exit updates alive/exitCode and marks unread when not displayed', () => {
    shellStore.initShellEvents();
    seedShell('s1', 'sh1');
    appStore.useStore.setState({ mainTab: 'session', activeSessionId: 's1' });
    shellHandler?.({ payload: { type: 'shell.exit', shellId: 'sh1', sessionId: 's1', exitCode: 3 } });
    const shell = shellStore.useShellStore.getState().shells.s1[0];
    expect(shell.alive).toBe(false);
    expect(shell.exitCode).toBe(3);
    expect(shellStore.useShellStore.getState().unread.sh1).toBe(true);
  });

  it('shell.exit on the displayed shell updates status without marking unread', () => {
    shellStore.initShellEvents();
    seedShell('s1', 'sh1');
    shellStore.useShellStore.getState().setActiveShellId('s1', 'sh1');
    appStore.useStore.setState({ mainTab: 'shell', activeSessionId: 's1' });
    shellHandler?.({ payload: { type: 'shell.exit', shellId: 'sh1', sessionId: 's1', exitCode: 0 } });
    expect(shellStore.useShellStore.getState().shells.s1[0].alive).toBe(false);
    expect(shellStore.useShellStore.getState().unread.sh1).toBeUndefined();
  });
});
