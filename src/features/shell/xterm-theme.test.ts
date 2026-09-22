import { describe, expect, it } from 'vitest';
import { hexWithAlpha, resolveTheme, SELECTION_ALPHA, XTERM_THEME_TOKENS } from './xterm-theme';

describe('hexWithAlpha', () => {
  it('converts 6-digit hex', () => {
    expect(hexWithAlpha('#7aa2f7', 0.3)).toBe('rgba(122, 162, 247, 0.3)');
  });
  it('expands 3-digit hex', () => {
    expect(hexWithAlpha('#fff', 0.5)).toBe('rgba(255, 255, 255, 0.5)');
  });
  it('replaces an existing alpha on 8-digit hex', () => {
    expect(hexWithAlpha(' #11121540 ', 1)).toBe('rgba(17, 18, 21, 1)');
  });
  it('returns null for non-hex values', () => {
    expect(hexWithAlpha('', 1)).toBeNull();
    expect(hexWithAlpha('rgb(1,2,3)', 1)).toBeNull();
    expect(hexWithAlpha('#12345', 1)).toBeNull();
  });
});

describe('resolveTheme', () => {
  it('reads every mapped key through its token', () => {
    const theme = resolveTheme((t) => `v(${t})`);
    for (const [key, token] of Object.entries(XTERM_THEME_TOKENS)) {
      expect((theme as Record<string, string>)[key]).toBe(`v(${token})`);
    }
  });
  it('puts the terminal on its own surface token', () => {
    expect(XTERM_THEME_TOKENS.background).toBe('--bg-terminal');
    expect(XTERM_THEME_TOKENS.cursorAccent).toBe('--bg-terminal');
  });
  it('derives the selection from state-info', () => {
    const theme = resolveTheme((t) => (t === '--state-info' ? '#3a62c8' : '#000000'));
    expect(theme.selectionBackground).toBe(`rgba(58, 98, 200, ${SELECTION_ALPHA})`);
  });
  it('falls back when state-info is unresolved', () => {
    const theme = resolveTheme(() => '');
    expect(theme.selectionBackground).toMatch(/^rgba\(/);
  });
});
