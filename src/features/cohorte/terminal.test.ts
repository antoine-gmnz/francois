// cohorte-actions FR-20/FR-21 — terminal.ts's IPC + store sequencing.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

import type { ShellInfo } from '../../../contract/shell-terminal';
import type { ProjectMeta } from '../../../contract/projects';
import { useStore } from '../../lib/store';
import { useToastState } from '../../lib/toast';
import { useShellStore } from '../../lib/shellStore';
import { cohorteTerminalLine, openCohorteTerminal, openPlumbingTerminal, terminalShellName } from './terminal';

function shell(id: string): ShellInfo {
  return { id, owner: { kind: 'session', sessionId: 's1' }, name: 'zsh', shellName: 'zsh', cwd: '/tmp', alive: true };
}

beforeEach(() => {
  invokeMock.mockReset();
  useShellStore.setState({ shells: {}, activeShellId: {}, unread: {}, renameRequest: null });
  useToastState.setState({ visible: [], queue: [] });
  useStore.getState().setMainTab('session');
  useStore.getState().setFocusedPane('main');
  useStore.setState({ activeSessionId: 's1', extraPanes: [], focusedPaneIndex: 0 });
});

describe('terminalShellName', () => {
  it('names the tab after the verb', () => {
    expect(terminalShellName('cohorte brainstorm --feature-id auth-retry')).toBe('cohorte brainstorm');
    expect(terminalShellName('cohorte patch ')).toBe('cohorte patch');
  });
});

it('uses the configured CLI, data store and registered root in a POSIX terminal', () => {
  expect(cohorteTerminalLine('cohorte brainstorm --from-intake brief', { root: '/work root', cliExecutable: '/cli path/cohorte', cliDataDir: '/data store' }, 'zsh')).toBe("cd -- '/work root' && '/cli path/cohorte' --data-dir '/data store' brainstorm --from-intake brief");
});

it('keeps intake answers literal in both POSIX and PowerShell', () => {
  const args = ['intake', '--continue', 'brief', '--answer', "1=don't run $(rm x)"];
  expect(cohorteTerminalLine('cohorte intake', {}, 'zsh', args)).toContain("'1=don'\\''t run $(rm x)'");
  expect(cohorteTerminalLine('cohorte intake', { root: 'C:\\work dir' }, 'powershell.exe', args)).toBe("Set-Location -LiteralPath 'C:\\work dir'; if ($?) { & 'cohorte' 'intake' '--continue' 'brief' '--answer' '1=don''t run $(rm x)' }");
});

it('returns a write failure instead of reporting a command was launched', async () => {
  invokeMock.mockImplementation((command: string) => Promise.resolve(command === 'shell_write'
    ? { ok: false, error: { code: 'PTY_ERROR', message: 'terminal closed' } }
    : { ok: true, data: shell('sh1') }));
  expect(await openCohorteTerminal('s1', 'cohorte brainstorm', { execute: true })).toBe(false);
  expect(useToastState.getState().visible[0]?.message).toBe('terminal closed');
});

it('opens an initialization terminal owned by the registered project without an agent session', async () => {
  useStore.getState().setProjects([{ id: 'p1', root: '/repo', name: 'Repo', rootExists: true } as ProjectMeta]);
  invokeMock.mockResolvedValue({ ok: true, data: { ...shell('sh1'), owner: { kind: 'project', projectId: 'p1' } } });
  expect(await openCohorteTerminal(null, 'cohorte init .', { execute: true, root: '/repo' })).toBe(true);
  expect(invokeMock).toHaveBeenCalledWith('shell_create', { owner: { kind: 'project', projectId: 'p1' }, runtime: 'native' });
  expect(useStore.getState().extraPanes).toEqual([{ kind: 'shell', projectId: 'p1', shellId: 'sh1' }]);
});

describe('openCohorteTerminal', () => {
  it('requests a host-native shell even when the owning agent session runs in WSL', async () => {
    useStore.setState({ sessions: [{ id: 's1', runtime: 'wsl', cwd: '\\\\wsl.localhost\\Ubuntu\\home\\repo' }] as never });
    invokeMock.mockResolvedValue({ ok: true, data: shell('sh1') });
    expect(await openCohorteTerminal('s1', 'cohorte init .', { execute: true, root: 'C:\\repo' })).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith('shell_create', { owner: { kind: 'session', sessionId: 's1' }, runtime: 'native' });
  });

  it('opens the shell tab in the actual owning extra pane without replacing pane zero', async () => {
    useStore.setState({ activeSessionId: 'another', mainTab: 'session', extraPanes: [{ kind: 'session', sessionId: 's1', tab: 'session' }], focusedPaneIndex: 1 });
    invokeMock.mockResolvedValue({ ok: true, data: shell('sh1') });
    expect(await openCohorteTerminal('s1', 'cohorte brainstorm', { execute: true })).toBe(true);
    expect(useStore.getState().mainTab).toBe('session');
    expect(useStore.getState().extraPanes[0]).toMatchObject({ kind: 'session', sessionId: 's1', tab: 'shell' });
    expect(useStore.getState().focusedPaneIndex).toBe(1);
  });

  it('creates + activates the shell, renames it, switches to SHELL, and writes the line with \\r when executed', async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'shell_create') return Promise.resolve({ ok: true, data: shell('sh1') });
      if (cmd === 'shell_rename') return Promise.resolve({ ok: true, data: { ...shell('sh1'), name: 'cohorte brainstorm' } });
      if (cmd === 'shell_write') return Promise.resolve({ ok: true, data: undefined });
      return Promise.resolve({ ok: false, error: { code: 'INTERNAL', message: 'unexpected' } });
    });

    const ok = await openCohorteTerminal('s1', 'cohorte brainstorm --feature-id a', { execute: true });

    expect(ok).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith('shell_create', { owner: { kind: 'session', sessionId: 's1' }, runtime: 'native' });
    expect(invokeMock).toHaveBeenCalledWith('shell_write', { shellId: 'sh1', data: 'cohorte brainstorm --feature-id a\r' });
    expect(useShellStore.getState().activeShellId.s1).toBe('sh1');
    expect(useStore.getState().mainTab).toBe('shell');
  });

  it('never appends \\r when execute is false (FR-21)', async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'shell_create') return Promise.resolve({ ok: true, data: shell('sh1') });
      if (cmd === 'shell_rename') return Promise.resolve({ ok: true, data: shell('sh1') });
      if (cmd === 'shell_write') return Promise.resolve({ ok: true, data: undefined });
      return Promise.resolve({ ok: false, error: { code: 'INTERNAL', message: 'unexpected' } });
    });

    await openCohorteTerminal('s1', 'cohorte patch ', { execute: false });

    expect(invokeMock).toHaveBeenCalledWith('shell_write', { shellId: 'sh1', data: 'cohorte patch ' });
  });

  it('toasts and returns false when shell creation fails (§7)', async () => {
    invokeMock.mockResolvedValue({ ok: false, error: { code: 'INTERNAL', message: 'no pty' } });
    const ok = await openCohorteTerminal('s1', 'cohorte brainstorm', { execute: true });
    expect(ok).toBe(false);
    expect(useToastState.getState().visible[0]?.message).toBe('no pty');
    expect(useStore.getState().mainTab).not.toBe('shell');
  });

  it('toasts on an IPC-layer rejection', async () => {
    invokeMock.mockRejectedValue(new Error('bridge down'));
    const ok = await openCohorteTerminal('s1', 'cohorte brainstorm', { execute: true });
    expect(ok).toBe(false);
    expect(useToastState.getState().visible[0]?.message).toContain('bridge down');
  });
});

describe('openPlumbingTerminal (FR-21)', () => {
  it('types the verb line untyped and toasts the help hint', async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'shell_create') return Promise.resolve({ ok: true, data: shell('sh1') });
      if (cmd === 'shell_rename') return Promise.resolve({ ok: true, data: shell('sh1') });
      if (cmd === 'shell_write') return Promise.resolve({ ok: true, data: undefined });
      return Promise.resolve({ ok: false, error: { code: 'INTERNAL', message: 'unexpected' } });
    });

    openPlumbingTerminal('s1', 'patch', 'cohorte patch ');
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(invokeMock).toHaveBeenCalledWith('shell_write', { shellId: 'sh1', data: 'cohorte patch ' });
    expect(useToastState.getState().visible[0]?.message).toContain('cohorte patch --help');
  });
});
