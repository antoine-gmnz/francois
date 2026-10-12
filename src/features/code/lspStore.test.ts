// code-editor-lsp FR-12/FR-14/FR-15/FR-16: the language-server store.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LspEvent, LspServerStatus } from '../../../contract/code-editor-lsp';
import type { EditorRoot } from '../../../contract/code-editor';
import { PROJECT_ROOT, SESSION_ROOT } from './code.testutil';

const api = vi.hoisted(() => ({
  lspStatus: vi.fn(),
  lspTrust: vi.fn(),
  lspStart: vi.fn(),
  lspStop: vi.fn(),
}));
vi.mock('../../lib/api', () => api);

import { diagnosticTargets, initialLspState, lspKey, progressOf, useLspStore } from './lspStore';

const ROOT_URI = 'file:///C:/work/orbit-api';
const PK = 'project:p1';
const SK = 'session:s1';

const status = (p: Partial<LspServerStatus> = {}): LspServerStatus => ({
  root: PROJECT_ROOT,
  language: 'typescript',
  state: 'ready',
  server: 'typescript-language-server',
  version: 'TypeScript 5.6',
  program: '/bin/tls',
  installHint: null,
  error: null,
  rootUri: ROOT_URI,
  ...p,
});
const ok = <T>(data: T) => ({ ok: true as const, data });
const st = () => useLspStore.getState();

beforeEach(() => {
  useLspStore.setState(initialLspState());
  Object.values(api).forEach((f) => f.mockReset());
});

describe('statuses', () => {
  it('loads a root once per run and keys them by root + language', async () => {
    api.lspStatus.mockResolvedValue(ok([status(), status({ language: 'rust', state: 'missing', installHint: 'rustup component add rust-analyzer' })]));
    await st().loadStatuses(PROJECT_ROOT);
    expect(api.lspStatus).toHaveBeenCalledWith({ root: PROJECT_ROOT });
    expect(st().statusByKey[lspKey(PK, 'rust')].state).toBe('missing');
    expect(st().loadedByRootKey[PK]).toBe(true);
    await st().loadStatuses(PROJECT_ROOT);
    expect(api.lspStatus).toHaveBeenCalledTimes(1);
    await st().loadStatuses(PROJECT_ROOT, { force: true });
    expect(api.lspStatus).toHaveBeenCalledTimes(2);
  });

  it('a failed probe leaves the root unloaded so it can be retried', async () => {
    api.lspStatus.mockResolvedValue({ ok: false, error: { code: 'INTERNAL', message: 'x' } });
    await st().loadStatuses(PROJECT_ROOT);
    expect(st().loadedByRootKey[PK]).toBeUndefined();
    api.lspStatus.mockRejectedValue(new Error('no core'));
    await expect(st().loadStatuses(PROJECT_ROOT)).resolves.toBeUndefined();
  });

  it('applies lsp.status, mirroring it onto other roots on the same directory', () => {
    st().setStatuses(PK, [status({ state: 'stopped' })]);
    st().setStatuses(SK, [status({ root: SESSION_ROOT, state: 'stopped' })]);
    st().applyEvent({ type: 'lsp.status', status: status({ state: 'starting' }) });
    expect(st().statusByKey[lspKey(PK, 'typescript')].state).toBe('starting');
    expect(st().statusByKey[lspKey(SK, 'typescript')]).toMatchObject({ state: 'starting', root: SESSION_ROOT });
  });
});

describe('progress', () => {
  const progress = (p: Partial<Extract<LspEvent, { type: 'lsp.progress' }>> = {}): LspEvent => ({
    type: 'lsp.progress',
    root: PROJECT_ROOT,
    language: 'rust',
    token: 't1',
    title: 'Indexing',
    message: null,
    percentage: 10,
    done: false,
    ...p,
  });

  it('tracks work-done tokens until they end', () => {
    st().setStatuses(PK, [status({ language: 'rust', state: 'ready' })]);
    st().applyEvent(progress());
    st().applyEvent(progress({ percentage: 55 }));
    expect(progressOf(st(), PK, 'rust')).toEqual([{ title: 'Indexing', message: null, percentage: 55 }]);
    st().applyEvent(progress({ done: true }));
    expect(progressOf(st(), PK, 'rust')).toEqual([]);
  });

  it('drops progress when the server leaves starting/ready', () => {
    st().setStatuses(PK, [status({ language: 'rust' })]);
    st().applyEvent(progress());
    st().applyEvent({ type: 'lsp.status', status: status({ language: 'rust', state: 'crashed' }) });
    expect(progressOf(st(), PK, 'rust')).toEqual([]);
  });
});

describe('diagnostics without a model (FR-12)', () => {
  const diags = (uri: string, diagnostics: unknown[], root: EditorRoot = PROJECT_ROOT): Extract<LspEvent, { type: 'lsp.diagnostics' }> => ({ type: 'lsp.diagnostics', root, language: 'typescript', uri, version: null, diagnostics });
  const d = { range: { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } }, severity: 1, code: 2345, source: 'typescript', message: 'bad arg' };

  it('targets every known root whose directory holds the file, ignoring files outside', () => {
    st().setStatuses(PK, [status()]);
    st().setStatuses(SK, [status({ root: SESSION_ROOT })]);
    expect(diagnosticTargets(st(), diags(`${ROOT_URI}/src/a.ts`, []))).toEqual([
      { rootKey: PK, path: 'src/a.ts' },
      { rootKey: SK, path: 'src/a.ts' },
    ]);
    expect(diagnosticTargets(st(), diags('file:///C:/elsewhere/a.ts', []))).toEqual([]);
  });

  it('keeps them as problems per file, clears on an empty publish and on dropOrphan', () => {
    st().setStatuses(PK, [status()]);
    st().applyEvent(diags(`${ROOT_URI}/src/a.ts`, [d]));
    const orphan = st().orphansByRootKey[PK]['src/a.ts'];
    expect(orphan.language).toBe('typescript');
    expect(orphan.diagnostics).toEqual([d]);
    expect(orphan.problems).toEqual([expect.objectContaining({ path: 'src/a.ts', severity: 'error', code: '2345', source: 'ts', line: 2, column: 3 })]);
    st().applyEvent(diags(`${ROOT_URI}/src/a.ts`, []));
    expect(st().orphansByRootKey[PK]['src/a.ts']).toBeUndefined();
    st().applyEvent(diags(`${ROOT_URI}/src/a.ts`, [d]));
    st().dropOrphan(PK, 'src/a.ts');
    expect(st().orphansByRootKey[PK]['src/a.ts']).toBeUndefined();
  });

  it('forgets a language’s diagnostics once its server is no longer ready', () => {
    st().setStatuses(PK, [status()]);
    st().applyEvent(diags(`${ROOT_URI}/src/a.ts`, [d]));
    st().applyEvent({ type: 'lsp.status', status: status({ state: 'stopped' }) });
    expect(st().orphansByRootKey[PK]).toEqual({});
  });
});

describe('trust, start, restart', () => {
  it('trust replaces the statuses and clears a dismissal; revoking clears diagnostics', async () => {
    st().dismissTrust(PK);
    api.lspTrust.mockResolvedValue(ok([status({ state: 'stopped' })]));
    await st().trust(PROJECT_ROOT, true);
    expect(api.lspTrust).toHaveBeenCalledWith({ root: PROJECT_ROOT, trusted: true });
    expect(st().statusByKey[lspKey(PK, 'typescript')].state).toBe('stopped');
    expect(st().dismissedByRootKey[PK]).toBeUndefined();
  });

  it('revoking keeps the prompt away for the run and drops the root’s diagnostics', async () => {
    st().setStatuses(PK, [status()]);
    st().applyEvent({ type: 'lsp.diagnostics', root: PROJECT_ROOT, language: 'typescript', uri: `${ROOT_URI}/a.ts`, version: null, diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: 'x' }] });
    api.lspTrust.mockResolvedValue(ok([status({ state: 'untrusted' })]));
    await expect(st().trust(PROJECT_ROOT, false)).resolves.toBe(true);
    expect(st().dismissedByRootKey[PK]).toBe(true);
    expect(st().orphansByRootKey[PK]).toBeUndefined();
    api.lspTrust.mockResolvedValue({ ok: false, error: { code: 'INTERNAL', message: 'x' } });
    await expect(st().trust(PROJECT_ROOT, true)).resolves.toBe(false);
  });

  it('dismisses the trust prompt for the run', () => {
    st().dismissTrust(PK);
    expect(st().dismissedByRootKey[PK]).toBe(true);
  });

  it('start is guarded while pending and stores the returned status', async () => {
    st().setStatuses(PK, [status({ state: 'stopped' })]);
    let resolve: (v: unknown) => void = () => {};
    api.lspStart.mockReturnValue(new Promise((r) => (resolve = r)));
    const first = st().start(PROJECT_ROOT, 'typescript');
    expect(st().pendingByKey[lspKey(PK, 'typescript')]).toBe(true);
    void st().start(PROJECT_ROOT, 'typescript');
    expect(api.lspStart).toHaveBeenCalledTimes(1);
    resolve(ok(status({ state: 'starting' })));
    await first;
    expect(st().pendingByKey[lspKey(PK, 'typescript')]).toBeUndefined();
    expect(st().statusByKey[lspKey(PK, 'typescript')].state).toBe('starting');
  });

  it('a refused start re-probes the root', async () => {
    st().setStatuses(PK, [status({ state: 'stopped' })]);
    api.lspStart.mockResolvedValue({ ok: false, error: { code: 'LSP_NOT_INSTALLED', message: 'x', detail: { installHint: 'h' } } });
    api.lspStatus.mockResolvedValue(ok([status({ state: 'missing', installHint: 'h' })]));
    await st().start(PROJECT_ROOT, 'typescript');
    expect(st().statusByKey[lspKey(PK, 'typescript')].state).toBe('missing');
  });

  it('restart stops then starts', async () => {
    st().setStatuses(PK, [status()]);
    api.lspStop.mockResolvedValue(ok(null));
    api.lspStart.mockResolvedValue(ok(status({ state: 'starting' })));
    await st().restart(PROJECT_ROOT, 'typescript');
    expect(api.lspStop).toHaveBeenCalledWith({ root: PROJECT_ROOT, language: 'typescript' });
    expect(api.lspStart).toHaveBeenCalledWith({ root: PROJECT_ROOT, language: 'typescript' });
    expect(st().statusByKey[lspKey(PK, 'typescript')].state).toBe('starting');
  });
});
