import { afterEach, describe, expect, it } from 'vitest';
import type { VsxLanguage } from '../../../contract/code-editor-vsx';
import { languageFor, setContributedLanguages } from './language';

describe('languageFor (FR-7/FR-10)', () => {
  it('maps the extension to a Monaco language id and its display name', () => {
    expect(languageFor('src/app.tsx')).toEqual({ id: 'typescript', name: 'TypeScript React' });
    expect(languageFor('a.ts')).toEqual({ id: 'typescript', name: 'TypeScript' });
    expect(languageFor('a.json')).toEqual({ id: 'json', name: 'JSON' });
    expect(languageFor('src-tauri/src/main.rs')).toEqual({ id: 'rust', name: 'Rust' });
  });
  it('is case-insensitive and knows a few extension-less names', () => {
    expect(languageFor('README.MD').id).toBe('markdown');
    expect(languageFor('docker/Dockerfile').id).toBe('dockerfile');
  });
  it('falls back to plain text', () => {
    expect(languageFor('LICENSE')).toEqual({ id: 'plaintext', name: 'Plain Text' });
    expect(languageFor('a.unknownext')).toEqual({ id: 'plaintext', name: 'Plain Text' });
  });
});

describe('languageFor with contributed languages (code-editor-vsx FR-8)', () => {
  const contributed = (id: string, more: Partial<VsxLanguage> = {}): VsxLanguage => ({
    extensionId: 'pub.ext',
    id,
    aliases: [],
    extensions: [],
    filenames: [],
    filenamePatterns: [],
    firstLine: null,
    configuration: null,
    ...more,
  });
  afterEach(() => setContributedLanguages([]));

  it('consults contributed languages after the built-ins', () => {
    setContributedLanguages([contributed('ts-alt', { extensions: ['.ts'] }), contributed('nix', { aliases: ['Nix'], extensions: ['.nix'] })]);
    expect(languageFor('a.ts').id).toBe('typescript');
    expect(languageFor('flake.nix')).toEqual({ id: 'nix', name: 'Nix' });
  });
  it('names a contributed language by its id when it has no alias', () => {
    setContributedLanguages([contributed('justfile', { filenames: ['justfile'] })]);
    expect(languageFor('justfile')).toEqual({ id: 'justfile', name: 'justfile' });
  });
  it('lets a contribution take over a built-in that is only an approximation (TOML as INI, Makefile)', () => {
    expect(languageFor('Cargo.toml').id).toBe('ini');
    setContributedLanguages([contributed('toml', { aliases: ['TOML'], extensions: ['.toml'] }), contributed('makefile', { filenames: ['Makefile'] })]);
    expect(languageFor('Cargo.toml')).toEqual({ id: 'toml', name: 'TOML' });
    expect(languageFor('Makefile').id).toBe('makefile');
  });
  it('falls back to plain text once the contribution is gone', () => {
    setContributedLanguages([contributed('nix', { extensions: ['.nix'] })]);
    setContributedLanguages([]);
    expect(languageFor('a.nix').id).toBe('plaintext');
  });
});
