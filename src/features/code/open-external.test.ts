// code-editor FR-15: Open in VS Code routes by root kind.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ sessionOpenInEditor: vi.fn(), editorOpenExternal: vi.fn() }));
vi.mock('../../lib/api', () => api);
const toast = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock('../../lib/toast', () => toast);
vi.mock('../sessions/editors', () => ({ getEditorList: vi.fn(async () => []) }));

import { openExternally } from './open-external';

const vscode = { id: 'vscode' as const, label: 'VS Code', path: '/usr/bin/code' };

beforeEach(() => {
  api.sessionOpenInEditor.mockReset().mockResolvedValue({ ok: true, data: null });
  api.editorOpenExternal.mockReset().mockResolvedValue({ ok: true, data: null });
  toast.showToast.mockReset();
});

describe('openExternally (FR-15)', () => {
  it('a session root goes through session_open_in_editor with file + line', async () => {
    await openExternally({ kind: 'session', sessionId: 's1' }, vscode, 'src/a.ts', 12);
    expect(api.sessionOpenInEditor).toHaveBeenCalledWith({ sessionId: 's1', editorId: 'vscode', file: 'src/a.ts', line: 12 });
    expect(api.editorOpenExternal).not.toHaveBeenCalled();
  });

  it('a project root goes through editor_open_external', async () => {
    const root = { kind: 'project' as const, projectId: 'p1' };
    await openExternally(root, vscode, 'src/a.ts', 3);
    expect(api.editorOpenExternal).toHaveBeenCalledWith({ root, editorId: 'vscode', file: 'src/a.ts', line: 3 });
  });

  it('omits the line when there is none, and toasts a failure', async () => {
    api.editorOpenExternal.mockResolvedValueOnce({ ok: false, error: { code: 'EDITOR_LAUNCH_FAILED', message: 'could not launch' } });
    const root = { kind: 'project' as const, projectId: 'p1' };
    await openExternally(root, vscode, 'big.bin');
    expect(api.editorOpenExternal).toHaveBeenCalledWith({ root, editorId: 'vscode', file: 'big.bin' });
    expect(toast.showToast).toHaveBeenCalledWith('could not launch', 'error');
  });
});
