// multiple-shells FR-22 — the four "Shell: …" palette commands: gating on an
// active session, and that only "Shell: new" switches the main tab (the
// others act on the session's SHELL state directly, per the spec's wording).

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

import { registerBuiltinCommands } from './paletteCommands';
import { paletteCommands } from './palette';
import { useStore } from '../../lib/store';
import { useShellStore } from '../shell/shellStore';
import type { PaletteContext } from '../../../contract/command-palette';
import type { ShellInfo } from '../../../contract/shell-terminal';

function shell(id: string): ShellInfo {
  return { id, sessionId: 's1', name: `zsh ${id}`, shellName: 'zsh', cwd: '/tmp', alive: true };
}

function findCommand(id: string) {
  const cmd = paletteCommands().find((c) => c.id === id);
  if (!cmd) throw new Error(`${id} not registered`);
  return cmd;
}

const activeCtx: PaletteContext = { activeSessionId: 's1', runningAgentCount: 0 };
const noSessionCtx: PaletteContext = { activeSessionId: null, runningAgentCount: 0 };

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue({ ok: true, data: [] }); // covers the sessionModels() prefetch at bootstrap
  useStore.setState({ mainTab: 'session', focusedPane: 'sidebar' });
  useShellStore.setState({ shells: {}, activeShellId: {}, unread: {}, renameRequest: null });
  registerBuiltinCommands(); // idempotent — safe across tests
});

describe('Shell: new/close/next/rename gating', () => {
  it('all four are disabled with no active session', () => {
    for (const id of ['shell-new', 'shell-close', 'shell-next', 'shell-rename']) {
      expect(findCommand(id).enabled?.(noSessionCtx)).toBe(false);
    }
  });

  it('all four are enabled with an active session', () => {
    for (const id of ['shell-new', 'shell-close', 'shell-next', 'shell-rename']) {
      expect(findCommand(id).enabled?.(activeCtx)).toBe(true);
    }
  });
});

describe('Shell: new', () => {
  it('switches focus + main tab to SHELL, then creates a shell (FR-22)', async () => {
    invokeMock.mockResolvedValue({ ok: true, data: shell('a') });
    findCommand('shell-new').run(activeCtx);
    expect(useStore.getState().focusedPane).toBe('main');
    expect(useStore.getState().mainTab).toBe('shell');
    await Promise.resolve();
    await Promise.resolve();
    expect(invokeMock).toHaveBeenCalledWith('shell_create', { sessionId: 's1' });
  });
});

describe('Shell: close', () => {
  it('disposes the displayed shell WITHOUT switching the main tab', async () => {
    invokeMock.mockResolvedValue({ ok: true, data: null });
    useShellStore.getState().setShells('s1', [shell('a')]);
    useShellStore.getState().setActiveShellId('s1', 'a');

    findCommand('shell-close').run(activeCtx);
    await Promise.resolve();
    await Promise.resolve();

    expect(invokeMock).toHaveBeenCalledWith('shell_dispose', { shellId: 'a' });
    expect(useStore.getState().mainTab).toBe('session'); // untouched
  });
});

describe('Shell: next', () => {
  it('cycles the active chip without any IPC call', () => {
    useShellStore.getState().setShells('s1', [shell('a'), shell('b')]);
    useShellStore.getState().setActiveShellId('s1', 'a');

    findCommand('shell-next').run(activeCtx);

    expect(useShellStore.getState().activeShellId.s1).toBe('b');
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe('Shell: rename', () => {
  it('flags the displayed chip for inline rename (no free-text SecondaryStep)', () => {
    useShellStore.getState().setShells('s1', [shell('a')]);
    useShellStore.getState().setActiveShellId('s1', 'a');

    const result = findCommand('shell-rename').run(activeCtx);

    expect(result).toBeUndefined(); // closes the palette like every other direct-action command
    expect(useShellStore.getState().renameRequest).toBe('a');
  });
});
