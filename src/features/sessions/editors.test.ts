// open-in-vscode (specs/open-in-vscode.md) — frontend unit tests.
// Covers the contract-typed session_editor_list / session_open_in_editor invoke
// wrappers (§5) and the FR-10 module-scoped memoized promise (editors.ts).

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EditorInfo } from '../../../contract/open-in-vscode';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

import { sessionEditorList, sessionOpenInEditor } from '../../lib/api';
import { getEditorList, resetEditorListCache } from './editors';

const VSCODE: EditorInfo = { id: 'vscode', label: 'VS Code', path: '/usr/bin/code' };
const CURSOR: EditorInfo = { id: 'cursor', label: 'Cursor', path: '/usr/bin/cursor' };

describe('sessionEditorList wrapper (§5)', () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('invokes session_editor_list with no payload and resolves the Result', async () => {
    invokeMock.mockResolvedValue({ ok: true, data: { editors: [VSCODE] } });
    await expect(sessionEditorList()).resolves.toEqual({ ok: true, data: { editors: [VSCODE] } });
    expect(invokeMock).toHaveBeenCalledWith('session_editor_list', undefined);
  });
});

describe('sessionOpenInEditor wrapper (§5)', () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('invokes session_open_in_editor with { sessionId, editorId } and resolves the Result', async () => {
    invokeMock.mockResolvedValue({ ok: true, data: null });
    await expect(sessionOpenInEditor({ sessionId: 's1', editorId: 'vscode' })).resolves.toEqual({ ok: true, data: null });
    expect(invokeMock).toHaveBeenCalledWith('session_open_in_editor', { sessionId: 's1', editorId: 'vscode' });
  });

  it('surfaces an ok:false rather than rejecting', async () => {
    invokeMock.mockResolvedValue({ ok: false, error: { code: 'EDITOR_NOT_FOUND', message: 'not found' } });
    const res = await sessionOpenInEditor({ sessionId: 's1', editorId: 'cursor' });
    expect(res.ok).toBe(false);
  });
});

describe('getEditorList (FR-10 — memoized, one in-flight promise, shared)', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    resetEditorListCache();
  });

  it('fetches once and returns the editors on success', async () => {
    invokeMock.mockResolvedValue({ ok: true, data: { editors: [VSCODE, CURSOR] } });
    await expect(getEditorList()).resolves.toEqual([VSCODE, CURSOR]);
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it('shares one in-flight promise across concurrent callers instead of double-fetching', async () => {
    let resolveInvoke: (v: unknown) => void = () => {};
    invokeMock.mockReturnValue(new Promise((resolve) => (resolveInvoke = resolve)));
    const p1 = getEditorList();
    const p2 = getEditorList();
    expect(invokeMock).toHaveBeenCalledTimes(1);
    resolveInvoke({ ok: true, data: { editors: [VSCODE] } });
    await expect(p1).resolves.toEqual([VSCODE]);
    await expect(p2).resolves.toEqual([VSCODE]);
  });

  it('caches a non-empty (successful) result for the app run — a later call does not re-fetch', async () => {
    invokeMock.mockResolvedValue({ ok: true, data: { editors: [VSCODE] } });
    await getEditorList();
    invokeMock.mockClear();
    await expect(getEditorList()).resolves.toEqual([VSCODE]);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('does NOT cache an empty result — mirrors core FR-3, so a later install is picked up on the next open', async () => {
    invokeMock.mockResolvedValue({ ok: true, data: { editors: [] } });
    await expect(getEditorList()).resolves.toEqual([]);
    invokeMock.mockResolvedValue({ ok: true, data: { editors: [VSCODE] } });
    await expect(getEditorList()).resolves.toEqual([VSCODE]);
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it('treats an ok:false response as an empty (uncached) list rather than throwing', async () => {
    invokeMock.mockResolvedValue({ ok: false, error: { code: 'INTERNAL', message: 'boom' } });
    await expect(getEditorList()).resolves.toEqual([]);
    invokeMock.mockResolvedValue({ ok: true, data: { editors: [VSCODE] } });
    await expect(getEditorList()).resolves.toEqual([VSCODE]);
  });
});
