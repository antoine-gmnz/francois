import { describe, expect, it } from 'vitest';
import { buildGraphiteTheme } from './monaco-theme';

const TOKENS: Record<string, string> = {
  '--bg-terminal': ' #09090b',
  '--text-primary': '#eceae5',
  '--text-line-number': '#4a4d53',
  '--bg-raised': '#1c1f23',
  '--bg-selected': '#24272c',
  '--text-muted': '#a3a09a',
  '--text-faint': '#8a8781',
  '--hue-purple-soft': '#cbb9ec',
  '--hue-teal': '#8fbab8',
  '--hue-clay': '#cf9d86',
  '--hue-blue': '#6f9fd8',
};
const read = (name: string) => TOKENS[name] ?? '';

describe('buildGraphiteTheme (FR-7, §8)', () => {
  it('maps the Graphite tokens onto the editor chrome', () => {
    const t = buildGraphiteTheme(read, 'dark');
    expect(t.base).toBe('vs-dark');
    expect(t.inherit).toBe(true);
    expect(t.colors).toMatchObject({
      'editor.background': '#09090b',
      'editor.foreground': '#eceae5',
      'editorLineNumber.foreground': '#4a4d53',
      'editorLineNumber.activeForeground': '#eceae5',
      'editor.lineHighlightBorder': '#1c1f23',
      'minimapSlider.background': '#1c1f23',
    });
  });

  it('maps the syntax colours, without the leading #', () => {
    const rules = buildGraphiteTheme(read, 'light').rules;
    const fg = (token: string) => rules.find((r) => r.token === token)?.foreground;
    expect(fg('keyword')).toBe('cbb9ec');
    expect(fg('string')).toBe('8fbab8');
    expect(fg('number')).toBe('cf9d86');
    expect(fg('type')).toBe('6f9fd8');
    expect(fg('comment')).toBe('8a8781');
    expect(fg('delimiter')).toBe('a3a09a');
  });

  it('uses the light base in the light theme', () => {
    expect(buildGraphiteTheme(read, 'light').base).toBe('vs');
  });

  it('drops a token that is missing rather than emitting an empty colour', () => {
    const t = buildGraphiteTheme(() => '', 'dark');
    expect(t.colors).toEqual({});
    expect(t.rules.every((r) => r.foreground === undefined)).toBe(true);
  });
});
