// session-attachments FR-18 · fix round 8 remediation — regression coverage for
// the "Clear project attachments" palette command registration: enabled gating,
// the confirm secondary step, and the toast for both ok:true and ok:false.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

import { registerBuiltinCommands } from './paletteCommands';
import { paletteCommands, useToastState } from './palette';
import { useStore } from '../../lib/store';
import type { PaletteContext, SecondaryStep } from '../../../contract/command-palette';

function findClearCommand() {
  const cmd = paletteCommands().find((c) => c.id === 'clear-project-attachments');
  if (!cmd) throw new Error('clear-project-attachments not registered');
  return cmd;
}

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue({ ok: true, data: [] }); // covers the sessionModels() prefetch at bootstrap
  useToastState.setState({ visible: [], queue: [] });
  useStore.setState({ activeProjectId: null, sessions: [] });
  registerBuiltinCommands(); // idempotent — safe across tests
});

const ctx: PaletteContext = { activeSessionId: null, runningAgentCount: 0 };

describe('clear-project-attachments palette command', () => {
  it('is disabled with no active project and no active session', () => {
    const cmd = findClearCommand();
    expect(cmd.enabled?.(ctx)).toBe(false);
  });

  it('is enabled once a project is selected', () => {
    useStore.setState({ activeProjectId: 'p1' });
    const cmd = findClearCommand();
    expect(cmd.enabled?.(ctx)).toBe(true);
  });

  it('confirming the sweep toasts the removal report on ok:true', async () => {
    useStore.setState({ activeProjectId: 'p1' });
    invokeMock.mockResolvedValue({ ok: true, data: { removedFiles: 3, removedBytes: 2048, failed: 0 } });
    const cmd = findClearCommand();
    const step = cmd.run(ctx) as SecondaryStep;
    expect(step.items.map((i) => i.id)).toEqual(['confirm', 'cancel']);

    step.onPick('confirm');
    await Promise.resolve();
    await Promise.resolve();

    expect(invokeMock).toHaveBeenCalledWith('session_clear_attachments', { scope: { kind: 'project', projectId: 'p1' } });
    const visible = useToastState.getState().visible;
    const toast = visible[visible.length - 1];
    expect(toast?.kind).toBe('info');
    expect(toast?.message).toBe('Removed 3 files (2 KB).');
  });

  it('reports a failed sweep as an error toast on ok:false', async () => {
    useStore.setState({ activeProjectId: 'p1' });
    invokeMock.mockResolvedValue({ ok: false, error: { code: 'IO_ERROR', message: 'disk unreadable' } });
    const cmd = findClearCommand();
    const step = cmd.run(ctx) as SecondaryStep;

    step.onPick('confirm');
    await Promise.resolve();
    await Promise.resolve();

    const visible = useToastState.getState().visible;
    const toast = visible[visible.length - 1];
    expect(toast?.kind).toBe('error');
    expect(toast?.message).toBe('disk unreadable');
  });

  it('cancel picks do not call the API', async () => {
    useStore.setState({ activeProjectId: 'p1' });
    const cmd = findClearCommand();
    const step = cmd.run(ctx) as SecondaryStep;

    step.onPick('cancel');
    await Promise.resolve();

    expect(invokeMock).not.toHaveBeenCalledWith('session_clear_attachments', expect.anything());
  });
});
