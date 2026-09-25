import { describe, expect, it } from 'vitest';
import {
  cohorteBrainstormDisplay,
  cohorteCommandLines,
  cohorteIntakeDisplay,
  cohortePlumbingLine,
  cohorteSpecDisplay,
  cohorteStartDisplay,
} from './command-display';

describe('cohorteIntakeDisplay', () => {
  it('renders a text source verbatim under the abbreviation cap', () => {
    expect(cohorteIntakeDisplay({ root: '/r', title: 'Fix the thing', source: { kind: 'text', text: 'short brief' } })).toBe(
      'cohorte intake --text "short brief" --title "Fix the thing"',
    );
  });

  it('abbreviates a --text value over 60 chars to <text, N lines>', () => {
    const text = Array.from({ length: 3 }, () => 'x'.repeat(25)).join('\n'); // 77 chars, 3 lines
    expect(cohorteIntakeDisplay({ root: '/r', title: 'Big', source: { kind: 'text', text } })).toBe(
      'cohorte intake --text "<text, 3 lines>" --title Big',
    );
  });

  it('never abbreviates file/url values', () => {
    const longPath = '/very/long/path/'.repeat(6) + 'file.md';
    expect(cohorteIntakeDisplay({ root: '/r', title: 'T', source: { kind: 'file', path: longPath } })).toBe(
      `cohorte intake --file ${longPath} --title T`,
    );
  });

  it('quotes an arg containing whitespace or quotes, and escapes embedded quotes', () => {
    expect(cohorteIntakeDisplay({ root: '/r', title: 'Say "hi"', source: { kind: 'url', url: 'https://x.test/a' } })).toBe(
      'cohorte intake --url https://x.test/a --title "Say \\"hi\\""',
    );
  });

  it('never includes --data-dir or --json', () => {
    const display = cohorteIntakeDisplay({ root: '/r', title: 'T', source: { kind: 'url', url: 'https://x.test' } });
    expect(display).not.toContain('--data-dir');
    expect(display).not.toContain('--json');
  });
});

describe('other display lines', () => {
  it('brainstorm: feature-id flag or bare (new idea)', () => {
    expect(cohorteBrainstormDisplay('auth-retry')).toBe('cohorte brainstorm --feature-id auth-retry');
    expect(cohorteBrainstormDisplay(null)).toBe('cohorte brainstorm');
  });

  it('spec: positional feature id', () => {
    expect(cohorteSpecDisplay('auth-retry')).toBe('cohorte spec auth-retry');
  });

  it('start: positional feature id (display only — the call is cohorte_v3_start)', () => {
    expect(cohorteStartDisplay('auth-retry')).toBe('cohorte start auth-retry');
  });

  it('plumbing verbs end with a trailing space, never executed', () => {
    expect(cohortePlumbingLine('patch')).toBe('cohorte patch ');
    expect(cohortePlumbingLine('fleet')).toBe('cohorte fleet ');
    expect(cohortePlumbingLine('audit')).toBe('cohorte audit ');
    expect(cohortePlumbingLine('retro')).toBe('cohorte retro ');
  });
});

describe('cohorteCommandLines (frame 36 command block)', () => {
  it('breaks before each flag with a shell continuation', () => {
    expect(cohorteCommandLines('cohorte intake --text "a b" --title "Webhook retries"')).toEqual([
      'cohorte intake \\',
      '    --text "a b" \\',
      '    --title "Webhook retries"',
    ]);
  });

  it('never breaks inside a quoted value', () => {
    expect(cohorteCommandLines('cohorte intake --title "use --force here"')).toEqual([
      'cohorte intake \\',
      '    --title "use --force here"',
    ]);
  });

  it('keeps a flagless command on one line', () => {
    expect(cohorteCommandLines('cohorte spec auth-retry')).toEqual(['cohorte spec auth-retry']);
  });
});
