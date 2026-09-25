import { describe, expect, it } from 'vitest';
import { intakeClientError, type IntakeFields } from './intake-validate';

function fields(over: Partial<IntakeFields> = {}): IntakeFields {
  return { title: 'A title', sourceKind: 'text', text: 'a brief', path: '', url: '', ...over };
}

describe('intakeClientError (FR-10)', () => {
  it('accepts a valid text source', () => {
    expect(intakeClientError(fields())).toBeNull();
  });

  it('requires a title', () => {
    expect(intakeClientError(fields({ title: '  ' }))).toBe('Title is required');
  });

  it('caps the title at 200 chars', () => {
    expect(intakeClientError(fields({ title: 'x'.repeat(201) }))).toMatch(/200/);
  });

  it('requires text when the source is text', () => {
    expect(intakeClientError(fields({ text: '' }))).toBe('Text is required');
  });

  it('rejects text over the 24 000-char command-line cap', () => {
    expect(intakeClientError(fields({ text: 'x'.repeat(24_001) }))).toBe(
      'Text is too long for the command line — save it to a file and use File',
    );
  });

  it('accepts exactly the cap', () => {
    expect(intakeClientError(fields({ text: 'x'.repeat(24_000) }))).toBeNull();
  });

  it('requires a file path when the source is file', () => {
    expect(intakeClientError(fields({ sourceKind: 'file', path: '' }))).toBe('Choose a file');
  });

  it('accepts a file path', () => {
    expect(intakeClientError(fields({ sourceKind: 'file', path: '/tmp/brief.md' }))).toBeNull();
  });

  it('requires a URL when the source is url', () => {
    expect(intakeClientError(fields({ sourceKind: 'url', url: '' }))).toBe('URL is required');
  });

  it('rejects a URL without http(s)', () => {
    expect(intakeClientError(fields({ sourceKind: 'url', url: 'ftp://x.test' }))).toMatch(/http/);
  });

  it('rejects a URL over 2000 chars', () => {
    const url = 'https://x.test/' + 'a'.repeat(2000);
    expect(intakeClientError(fields({ sourceKind: 'url', url }))).toMatch(/2000/);
  });

  it('accepts a valid URL', () => {
    expect(intakeClientError(fields({ sourceKind: 'url', url: 'https://x.test/brief' }))).toBeNull();
  });
});
