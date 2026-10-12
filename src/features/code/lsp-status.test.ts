// code-editor-lsp FR-14/FR-15/FR-16: the status pill, the trust prompt and start-on-show decisions.

import { describe, expect, it } from 'vitest';
import type { LspServerStatus } from '../../../contract/code-editor-lsp';
import { PROJECT_ROOT } from './code.testutil';
import { lspLanguageForPath, pillView, serverLabel, showAction } from './lsp-status';

const status = (p: Partial<LspServerStatus> = {}): LspServerStatus => ({
  root: PROJECT_ROOT,
  language: 'typescript',
  state: 'ready',
  server: 'typescript-language-server',
  version: 'TypeScript 5.6',
  program: 'C:/work/orbit-api/node_modules/.bin/typescript-language-server',
  installHint: null,
  error: null,
  rootUri: 'file:///C:/work/orbit-api',
  ...p,
});

describe('lspLanguageForPath', () => {
  it('maps files onto the four server languages', () => {
    expect(lspLanguageForPath('src/a.tsx')).toBe('typescript');
    expect(lspLanguageForPath('a.cjs')).toBe('typescript');
    expect(lspLanguageForPath('src/main.rs')).toBe('rust');
    expect(lspLanguageForPath('app.py')).toBe('python');
    expect(lspLanguageForPath('main.go')).toBe('go');
    expect(lspLanguageForPath('README.md')).toBeNull();
  });
});

describe('serverLabel', () => {
  it('reads "TypeScript 5.6" for TS, "<server> <version>" otherwise', () => {
    expect(serverLabel(status())).toBe('TypeScript 5.6');
    expect(serverLabel(status({ version: '4.3.3 (TypeScript 5.6.2)' }))).toBe('TypeScript 5.6.2');
    expect(serverLabel(status({ version: '4.3.3' }))).toBe('typescript-language-server 4.3.3');
    expect(serverLabel(status({ language: 'rust', server: 'rust-analyzer', version: '2026-09-29' }))).toBe('rust-analyzer 2026-09-29');
    expect(serverLabel(status({ language: 'go', server: 'gopls', version: null }))).toBe('gopls');
  });
});

describe('pillView', () => {
  it('is null when no server applies (unknown or untrusted)', () => {
    expect(pillView(undefined, [])).toBeNull();
    expect(pillView(status({ state: 'untrusted' }), [])).toBeNull();
  });

  it('reads ready with a green dot', () => {
    expect(pillView(status(), [])).toMatchObject({ text: 'TypeScript 5.6 · ready', tone: 'ready', action: null });
  });

  it('pulses while starting or indexing, naming the progress', () => {
    expect(pillView(status({ state: 'starting' }), [])).toMatchObject({ text: 'TypeScript 5.6 · starting', tone: 'busy' });
    const rust = status({ language: 'rust', server: 'rust-analyzer', version: '2026-09-29' });
    expect(pillView(rust, [{ title: 'Indexing', message: '12/40', percentage: 30 }])).toMatchObject({ text: 'rust-analyzer 2026-09-29 · Indexing 30%', tone: 'busy' });
    expect(pillView(rust, [{ title: null, message: 'Loading', percentage: null }])?.text).toBe('rust-analyzer 2026-09-29 · Loading');
  });

  it('reads stopped, not installed (copies the hint) and crashed (restarts)', () => {
    expect(pillView(status({ state: 'stopped' }), [])).toMatchObject({ text: 'TypeScript 5.6 · stopped', tone: 'idle', action: null });
    expect(pillView(status({ state: 'stopped', error: 'spawn failed' }), [])).toMatchObject({ tone: 'idle', action: 'restart' });
    const missing = pillView(status({ state: 'missing', program: null, version: null, installHint: 'npm i -g typescript-language-server typescript' }), []);
    expect(missing).toMatchObject({ text: 'typescript-language-server · not installed', tone: 'missing', action: 'install' });
    expect(missing?.title).toContain('npm i -g typescript-language-server typescript');
    const crashed = pillView(status({ state: 'crashed', error: 'thread main panicked' }), []);
    expect(crashed).toMatchObject({ text: 'TypeScript 5.6 · crashed', tone: 'crashed', action: 'restart' });
  });

  it('puts the program and the last error in the tooltip', () => {
    const title = pillView(status({ error: 'tsserver exited' }), [])?.title ?? '';
    expect(title).toContain('node_modules/.bin/typescript-language-server');
    expect(title).toContain('tsserver exited');
  });
});

describe('showAction', () => {
  it('starts a stopped server once, prompts for an untrusted root unless dismissed, else nothing', () => {
    expect(showAction(status({ state: 'stopped' }), { dismissed: false, pending: false })).toBe('start');
    expect(showAction(status({ state: 'stopped' }), { dismissed: false, pending: true })).toBe('none');
    expect(showAction(status({ state: 'stopped', error: 'spawn failed' }), { dismissed: false, pending: false })).toBe('none');
    expect(showAction(status({ state: 'untrusted' }), { dismissed: false, pending: false })).toBe('prompt');
    expect(showAction(status({ state: 'untrusted' }), { dismissed: true, pending: false })).toBe('none');
    for (const state of ['missing', 'starting', 'ready', 'crashed'] as const) expect(showAction(status({ state }), { dismissed: false, pending: false })).toBe('none');
    expect(showAction(undefined, { dismissed: false, pending: false })).toBe('none');
  });
});
