// multiple-shells — shellActions.ts: the IPC + store sequencing shared by the
// strip's mouse handlers, the keyboard carve-outs, and the palette commands.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

import type { ShellInfo } from '../../../contract/shell-terminal';
import { useToastState } from '../palette/palette';
import {
  closeDisplayedShell,
  closeShell,
  cycleShell,
  dispatchShellShortcut,
  newShell,
  renameShell,
  requestActiveShellRename,
} from './shellActions';
import { useShellStore } from './shellStore';

function shell(id: string, patch: Partial<ShellInfo> = {}): ShellInfo {
  return { id, owner: { kind: 'session', sessionId: 's1' }, name: `zsh ${id}`, shellName: 'zsh', cwd: '/tmp', alive: true, ...patch };
}

beforeEach(() => {
  invokeMock.mockReset();
  useShellStore.setState({ shells: {}, activeShellId: {}, unread: {}, renameRequest: null });
  useToastState.setState({ visible: [], queue: [] });
});

describe('newShell', () => {
  it('creates, activates and clears the unread mark on the new shell (flow 2)', async () => {
    invokeMock.mockResolvedValue({ ok: true, data: shell('b') });
    useShellStore.getState().setShells('s1', [shell('a')]);
    useShellStore.getState().markUnread('b');

    await newShell('s1');

    expect(invokeMock).toHaveBeenCalledWith('shell_create', { owner: { kind: 'session', sessionId: 's1' } });
    expect(useShellStore.getState().shells.s1.map((s) => s.id)).toEqual(['a', 'b']);
    expect(useShellStore.getState().activeShellId.s1).toBe('b');
    expect(useShellStore.getState().unread.b).toBeUndefined();
  });

  it('is a no-op at the 6-shell cap — no IPC call (FR-2/FR-19)', async () => {
    useShellStore.getState().setShells(
      's1',
      Array.from({ length: 6 }, (_, i) => shell(String(i))),
    );
    await newShell('s1');
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('toasts SHELL_LIMIT_REACHED-style refusals as a transient error, no chip added (§7)', async () => {
    invokeMock.mockResolvedValue({ ok: false, error: { code: 'SHELL_LIMIT_REACHED', message: '6 shells maximum' } });
    useShellStore.getState().setShells('s1', [shell('a')]);
    await newShell('s1');
    expect(useShellStore.getState().shells.s1.map((s) => s.id)).toEqual(['a']);
    expect(useToastState.getState().visible[0]?.message).toBe('6 shells maximum');
  });

  it('toasts on an IPC-layer rejection instead of leaving it unhandled', async () => {
    invokeMock.mockRejectedValue(new Error('bridge down'));
    useShellStore.getState().setShells('s1', [shell('a')]);
    await expect(newShell('s1')).resolves.toBeUndefined();
    expect(useToastState.getState().visible[0]?.message).toContain('bridge down');
  });
});

describe('closeShell', () => {
  it('closing the DISPLAYED shell activates the right neighbor (§7)', async () => {
    invokeMock.mockResolvedValue({ ok: true, data: null });
    useShellStore.getState().setShells('s1', [shell('a'), shell('b'), shell('c')]);
    useShellStore.getState().setActiveShellId('s1', 'a');

    await closeShell('s1', 'a');

    expect(invokeMock).toHaveBeenCalledWith('shell_dispose', { shellId: 'a' });
    expect(useShellStore.getState().shells.s1.map((s) => s.id)).toEqual(['b', 'c']);
    expect(useShellStore.getState().activeShellId.s1).toBe('b');
  });

  it('closing the last remaining shell leaves the empty state (FR-23)', async () => {
    invokeMock.mockResolvedValue({ ok: true, data: null });
    useShellStore.getState().setShells('s1', [shell('a')]);
    useShellStore.getState().setActiveShellId('s1', 'a');

    await closeShell('s1', 'a');

    expect(useShellStore.getState().shells.s1).toEqual([]);
    expect(useShellStore.getState().activeShellId.s1).toBeUndefined();
  });

  it('closing a BACKGROUND (non-displayed) shell leaves the active chip untouched', async () => {
    invokeMock.mockResolvedValue({ ok: true, data: null });
    useShellStore.getState().setShells('s1', [shell('a'), shell('b')]);
    useShellStore.getState().setActiveShellId('s1', 'b');

    await closeShell('s1', 'a');

    expect(useShellStore.getState().shells.s1.map((s) => s.id)).toEqual(['b']);
    expect(useShellStore.getState().activeShellId.s1).toBe('b');
  });
});

describe('closeDisplayedShell (⌘W)', () => {
  it('is a no-op with zero shells (§7)', () => {
    closeDisplayedShell('s1');
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('disposes the active shell', async () => {
    invokeMock.mockResolvedValue({ ok: true, data: null });
    useShellStore.getState().setShells('s1', [shell('a')]);
    useShellStore.getState().setActiveShellId('s1', 'a');
    closeDisplayedShell('s1');
    await Promise.resolve();
    await Promise.resolve();
    expect(invokeMock).toHaveBeenCalledWith('shell_dispose', { shellId: 'a' });
  });
});

describe('cycleShell (⌃⇥/⌃⇧⇥)', () => {
  it('moves to the next/previous chip and clears its unread mark', () => {
    useShellStore.getState().setShells('s1', [shell('a'), shell('b'), shell('c')]);
    useShellStore.getState().setActiveShellId('s1', 'a');
    useShellStore.getState().markUnread('b');

    cycleShell('s1', 1);
    expect(useShellStore.getState().activeShellId.s1).toBe('b');
    expect(useShellStore.getState().unread.b).toBeUndefined();

    cycleShell('s1', -1);
    expect(useShellStore.getState().activeShellId.s1).toBe('a');
  });

  it('is a no-op with fewer than 2 shells', () => {
    useShellStore.getState().setShells('s1', [shell('a')]);
    useShellStore.getState().setActiveShellId('s1', 'a');
    cycleShell('s1', 1);
    expect(useShellStore.getState().activeShellId.s1).toBe('a');
  });
});

describe('renameShell', () => {
  it('refreshes the store from the core response, never a local guess (FR-18)', async () => {
    invokeMock.mockResolvedValue({ ok: true, data: shell('a', { name: 'build' }) });
    useShellStore.getState().setShells('s1', [shell('a')]);

    await renameShell('s1', 'a', 'build');

    expect(invokeMock).toHaveBeenCalledWith('shell_rename', { shellId: 'a', name: 'build' });
    expect(useShellStore.getState().shells.s1[0].name).toBe('build');
  });

  it('toasts on refusal', async () => {
    invokeMock.mockResolvedValue({ ok: false, error: { code: 'SHELL_NOT_FOUND', message: 'gone' } });
    await renameShell('s1', 'a', 'build');
    expect(useToastState.getState().visible[0]?.message).toBe('gone');
  });

  it('toasts on an IPC-layer rejection instead of leaving it unhandled', async () => {
    invokeMock.mockRejectedValue(new Error('bridge down'));
    await expect(renameShell('s1', 'a', 'build')).resolves.toBeUndefined();
    expect(useToastState.getState().visible[0]?.message).toContain('bridge down');
  });
});

describe('dispatchShellShortcut', () => {
  it('routes each combo to its action', async () => {
    invokeMock.mockResolvedValue({ ok: true, data: shell('b') });
    useShellStore.getState().setShells('s1', [shell('a')]);

    dispatchShellShortcut('new', 's1');
    await Promise.resolve();
    await Promise.resolve();
    expect(invokeMock).toHaveBeenCalledWith('shell_create', { owner: { kind: 'session', sessionId: 's1' } });

    useShellStore.getState().setActiveShellId('s1', 'a');
    dispatchShellShortcut('close', 's1');
    await Promise.resolve();
    expect(invokeMock).toHaveBeenCalledWith('shell_dispose', { shellId: 'a' });
  });

  it('next/prev cycle without any IPC call', () => {
    useShellStore.getState().setShells('s1', [shell('a'), shell('b')]);
    useShellStore.getState().setActiveShellId('s1', 'a');
    invokeMock.mockClear();

    dispatchShellShortcut('next', 's1');
    expect(useShellStore.getState().activeShellId.s1).toBe('b');
    expect(invokeMock).not.toHaveBeenCalled();

    dispatchShellShortcut('prev', 's1');
    expect(useShellStore.getState().activeShellId.s1).toBe('a');
  });
});

describe('requestActiveShellRename (palette "Shell: rename")', () => {
  it('flags the displayed shell for inline rename', () => {
    useShellStore.getState().setShells('s1', [shell('a')]);
    useShellStore.getState().setActiveShellId('s1', 'a');
    requestActiveShellRename('s1');
    expect(useShellStore.getState().renameRequest).toBe('a');
  });

  it('is a no-op with zero shells', () => {
    requestActiveShellRename('s1');
    expect(useShellStore.getState().renameRequest).toBe(null);
  });
});
