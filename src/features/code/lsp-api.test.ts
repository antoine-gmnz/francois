// code-editor-lsp §5: the contract-typed lsp_* invoke wrappers and the event channel.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EditorRoot } from '../../../contract/code-editor';

const { invokeMock, listenMock } = vi.hoisted(() => ({ invokeMock: vi.fn(), listenMock: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }));

import { lspCancel, lspNotify, lspRequest, lspStart, lspStatus, lspStop, lspTrust, onLspEvent } from '../../lib/api';

const root: EditorRoot = { kind: 'project', projectId: 'p1' };

beforeEach(() => {
  invokeMock.mockReset();
  listenMock.mockClear();
});

describe('lsp invoke wrappers', () => {
  it('lsp_status and lsp_trust pass their request and resolve the Result', async () => {
    invokeMock.mockResolvedValue({ ok: true, data: [] });
    await expect(lspStatus({ root })).resolves.toEqual({ ok: true, data: [] });
    await lspTrust({ root, trusted: true });
    expect(invokeMock).toHaveBeenNthCalledWith(1, 'lsp_status', { root });
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'lsp_trust', { root, trusted: true });
  });

  it('lsp_start and lsp_stop name the language', async () => {
    invokeMock.mockResolvedValue({ ok: false, error: { code: 'LSP_NOT_INSTALLED', message: 'missing', detail: { installHint: 'x' } } });
    await expect(lspStart({ root, language: 'rust' })).resolves.toMatchObject({ ok: false, error: { code: 'LSP_NOT_INSTALLED' } });
    await lspStop({ root, language: 'rust' });
    expect(invokeMock).toHaveBeenNthCalledWith(1, 'lsp_start', { root, language: 'rust' });
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'lsp_stop', { root, language: 'rust' });
  });

  it('lsp_request carries method, raw params and the optional requestId; lsp_cancel names it', async () => {
    invokeMock.mockResolvedValue({ ok: true, data: null });
    const params = { textDocument: { uri: 'file:///a.ts' }, position: { line: 0, character: 1 } };
    await lspRequest({ root, language: 'typescript', method: 'textDocument/hover', params, requestId: 'r1' });
    await lspCancel({ root, language: 'typescript', requestId: 'r1' });
    expect(invokeMock).toHaveBeenNthCalledWith(1, 'lsp_request', { root, language: 'typescript', method: 'textDocument/hover', params, requestId: 'r1' });
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'lsp_cancel', { root, language: 'typescript', requestId: 'r1' });
  });

  it('lsp_notify forwards a notification', async () => {
    invokeMock.mockResolvedValue({ ok: true, data: null });
    const params = { textDocument: { uri: 'file:///a.ts' } };
    await lspNotify({ root, language: 'go', method: 'textDocument/didSave', params });
    expect(invokeMock).toHaveBeenCalledWith('lsp_notify', { root, language: 'go', method: 'textDocument/didSave', params });
  });
});

describe('onLspEvent', () => {
  it('listens on francois://lsp/event and unwraps the payload', async () => {
    const cb = vi.fn();
    await onLspEvent(cb);
    expect(listenMock).toHaveBeenCalledWith('francois://lsp/event', expect.any(Function));
    const handler = (listenMock.mock.calls[0] as unknown as [string, (e: { payload: unknown }) => void])[1];
    const e = { type: 'lsp.progress', root, language: 'rust', token: 't', title: 'Indexing', message: null, percentage: 40, done: false };
    handler({ payload: e });
    expect(cb).toHaveBeenCalledWith(e);
  });
});
