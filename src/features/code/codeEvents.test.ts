// code-editor-lsp FR-16: the lsp event feed — subscribed once, every event into the
// store, diagnostics also into the Monaco bridge's sink.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LspEvent } from '../../../contract/code-editor-lsp';

const api = vi.hoisted(() => ({
  onEditorEvent: vi.fn(() => Promise.resolve(() => {})),
  onLspEvent: vi.fn((_cb: (e: unknown) => void) => Promise.resolve(() => {})),
  lspStatus: vi.fn(),
  lspTrust: vi.fn(),
  lspStart: vi.fn(),
  lspStop: vi.fn(),
}));
vi.mock('../../lib/api', () => api);

import { PROJECT_ROOT } from './code.testutil';
import { handleLspEvent, initLspEvents, setLspDiagnosticsSink } from './codeEvents';
import { initialLspState, lspKey, useLspStore } from './lspStore';

const status = {
  root: PROJECT_ROOT,
  language: 'rust' as const,
  state: 'ready' as const,
  server: 'rust-analyzer',
  version: null,
  program: '/bin/ra',
  installHint: null,
  error: null,
  rootUri: 'file:///w',
};

beforeEach(() => {
  useLspStore.setState(initialLspState());
  setLspDiagnosticsSink(null);
});

describe('lsp events', () => {
  it('subscribes once', () => {
    initLspEvents();
    initLspEvents();
    expect(api.onLspEvent).toHaveBeenCalledTimes(1);
  });

  it('applies events to the store and forwards diagnostics to the sink', () => {
    const sink = vi.fn();
    setLspDiagnosticsSink(sink);
    handleLspEvent({ type: 'lsp.status', status });
    expect(useLspStore.getState().statusByKey[lspKey('project:p1', 'rust')].state).toBe('ready');
    expect(sink).not.toHaveBeenCalled();
    const diags: LspEvent = { type: 'lsp.diagnostics', root: PROJECT_ROOT, language: 'rust', uri: 'file:///w/src/main.rs', version: 2, diagnostics: [] };
    handleLspEvent(diags);
    expect(sink).toHaveBeenCalledWith(diags);
  });
});
