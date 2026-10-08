import { describe, expect, it } from 'vitest';
import { languageFor } from './language';

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
