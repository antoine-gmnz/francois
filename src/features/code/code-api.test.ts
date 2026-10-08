// code-editor §5: the contract-typed editor_* invoke wrappers and the event channel.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EditorRoot } from '../../../contract/code-editor';

const { invokeMock, listenMock } = vi.hoisted(() => ({ invokeMock: vi.fn(), listenMock: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }));

import { editorClose, editorFiles, editorOpen, editorOpenExternal, editorSave, onEditorEvent, sessionOpenInEditor } from '../../lib/api';

const root: EditorRoot = { kind: 'project', projectId: 'p1' };

beforeEach(() => {
  invokeMock.mockReset();
  listenMock.mockClear();
});

describe('editor invoke wrappers', () => {
  it('editor_files passes { root } and resolves the Result', async () => {
    const data = { rootLabel: 'orbit', branch: 'main', paths: ['a.ts'], truncated: false, changes: {} };
    invokeMock.mockResolvedValue({ ok: true, data });
    await expect(editorFiles({ root })).resolves.toEqual({ ok: true, data });
    expect(invokeMock).toHaveBeenCalledWith('editor_files', { root });
  });

  it('editor_open passes { root, path }', async () => {
    invokeMock.mockResolvedValue({ ok: false, error: { code: 'EDITOR_BINARY', message: 'binary' } });
    await expect(editorOpen({ root, path: 'a.png' })).resolves.toMatchObject({ ok: false });
    expect(invokeMock).toHaveBeenCalledWith('editor_open', { root, path: 'a.png' });
  });

  it('editor_save carries the base version, line ending and bom', async () => {
    invokeMock.mockResolvedValue({ ok: true, data: { version: 'v2' } });
    const req = { root, path: 'a.ts', text: 'x\n', baseVersion: 'v1', lineEnding: 'crlf' as const, bom: true };
    await editorSave(req);
    expect(invokeMock).toHaveBeenCalledWith('editor_save', req);
  });

  it('editor_close and editor_open_external use their snake_case commands', async () => {
    invokeMock.mockResolvedValue({ ok: true, data: null });
    await editorClose({ root, path: 'a.ts' });
    await editorOpenExternal({ root, editorId: 'vscode', file: 'a.ts', line: 12 });
    expect(invokeMock).toHaveBeenNthCalledWith(1, 'editor_close', { root, path: 'a.ts' });
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'editor_open_external', { root, editorId: 'vscode', file: 'a.ts', line: 12 });
  });

  it('session_open_in_editor forwards the optional file/line (FR-15)', async () => {
    invokeMock.mockResolvedValue({ ok: true, data: null });
    await sessionOpenInEditor({ sessionId: 's1', editorId: 'vscode', file: 'src/a.ts', line: 3 });
    expect(invokeMock).toHaveBeenCalledWith('session_open_in_editor', { sessionId: 's1', editorId: 'vscode', file: 'src/a.ts', line: 3 });
  });
});

describe('onEditorEvent', () => {
  it('listens on francois://editor/event and unwraps the payload', async () => {
    const cb = vi.fn();
    await onEditorEvent(cb);
    expect(listenMock).toHaveBeenCalledWith('francois://editor/event', expect.any(Function));
    const handler = (listenMock.mock.calls[0] as unknown as [string, (e: { payload: unknown }) => void])[1];
    handler({ payload: { type: 'editor.deleted', root, path: 'a.ts' } });
    expect(cb).toHaveBeenCalledWith({ type: 'editor.deleted', root, path: 'a.ts' });
  });
});
