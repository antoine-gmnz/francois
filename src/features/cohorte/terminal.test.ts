// cohorte-actions FR-20/FR-21 — terminal.ts's IPC + store sequencing.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

import type { ShellInfo } from '../../../contract/shell-terminal';
import { useStore } from '../../lib/store';
import { useToastState } from '../palette/palette';
import { useShellStore } from '../shell/shellStore';
import { openCohorteTerminal, openPlumbingTerminal, terminalShellName } from './terminal';

function shell(id: string): ShellInfo {
  return { id, owner: { kind: 'session', sessionId: 's1' }, name: 'zsh', shellName: 'zsh', cwd: '/tmp', alive: true };
}

beforeEach(() => {
  invokeMock.mockReset();
  useShellStore.setState({ shells: {}, activeShellId: {}, unread: {}, renameRequest: null });
  useToastState.setState({ visible: [], queue: [] });
  useStore.getState().setMainTab('session');
  useStore.getState().setFocusedPane('main');
});

describe('terminalShellName', () => {
  it('names the tab after the verb', () => {
    expect(terminalShellName('cohorte brainstorm --feature-id auth-retry')).toBe('cohorte brainstorm');
    expect(terminalShellName('cohorte patch ')).toBe('cohorte patch');
  });
});

describe('openCohorteTerminal', () => {
  it('creates + activates the shell, renames it, switches to SHELL, and writes the line with \\r when executed', async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'shell_create') return Promise.resolve({ ok: true, data: shell('sh1') });
      if (cmd === 'shell_rename') return Promise.resolve({ ok: true, data: { ...shell('sh1'), name: 'cohorte brainstorm' } });
      if (cmd === 'shell_write') return Promise.resolve({ ok: true, data: undefined });
      return Promise.resolve({ ok: false, error: { code: 'INTERNAL', message: 'unexpected' } });
    });

    const ok = await openCohorteTerminal('s1', 'cohorte brainstorm --feature-id a', { execute: true });

    expect(ok).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith('shell_create', { owner: { kind: 'session', sessionId: 's1' } });
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
