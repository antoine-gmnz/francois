import { describe, expect, it } from 'vitest';
import { buildGraphiteTheme } from './monaco-theme';

const TOKENS: Record<string, string> = {
  '--bg-terminal': ' #09090b',
  '--text-primary': '#eceae5',
  '--text-line-number': '#4a4d53',
  '--bg-raised': '#1c1f23',
  '--bg-selected': '#24272c',
  '--bg-popover': '#1a1c20',
  '--text-muted': '#a3a09a',
  '--text-faint': '#8a8781',
  '--hue-purple-soft': '#cbb9ec',
  '--hue-teal': '#8fbab8',
  '--hue-clay': '#cf9d86',
  '--hue-blue': '#6f9fd8',
  '--bg-input': '#131417',
  '--line-subtle': '#ffffff0f',
  '--line-default': '#ffffff1a',
  '--text-secondary': '#d8d5cf',
  '--state-danger': '#ef7a6e',
  '--warn': '#d4c46f',
  '--state-info': '#7aa2f7',
  '--tint-info': '#7aa2f712',
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
      // Translucent, so the slider never hides the minimap under it.
      'minimapSlider.background': '#ffffff0f',
      'scrollbarSlider.background': '#ffffff1a',
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

  it('maps TextMate scopes onto the same syntax tokens (code-editor-vsx FR-7)', () => {
    const rules = buildGraphiteTheme(read, 'dark').rules;
    const rule = (token: string) => rules.find((r) => r.token === token);
    const fg = (token: string) => rule(token)?.foreground;
    expect(fg('constant.numeric')).toBe(fg('number'));
    expect(fg('storage')).toBe(fg('keyword'));
    expect(fg('keyword.control')).toBe(fg('keyword'));
    expect(fg('entity.name.function')).toBe(fg('function'));
    expect(fg('support.function')).toBe(fg('function'));
    expect(fg('entity.name.type')).toBe(fg('type'));
    expect(fg('support.type')).toBe(fg('type'));
    expect(fg('variable')).toBe('eceae5');
    expect(fg('punctuation')).toBe(fg('delimiter'));
    expect(fg('punctuation.definition.string')).toBe(fg('string'));
    expect(fg('meta.tag')).toBe(fg('delimiter'));
    expect(fg('entity.name.tag')).toBe(fg('type'));
    expect(fg('entity.other.attribute-name')).toBe(fg('number'));
    expect(rule('punctuation.definition.comment')).toEqual(rule('comment') && { ...rule('comment'), token: 'punctuation.definition.comment' });
  });

  it('styles the suggest, hover, find and quick-fix widgets from the tokens (code-editor-workspace FR-6/FR-8/FR-10)', () => {
    const t = buildGraphiteTheme(read, 'dark');
    expect(t.colors).toMatchObject({
      'editorSuggestWidget.background': '#1a1c20',
      'editorSuggestWidget.border': '#ffffff1a',
      'editorSuggestWidget.selectedBackground': '#24272c',
      'editorSuggestWidget.highlightForeground': '#eceae5',
      'editorSuggestWidget.foreground': '#d8d5cf',
      'editorSuggestWidgetStatus.foreground': '#8a8781',
      'editorHoverWidget.background': '#1a1c20',
      'editorHoverWidget.border': '#ffffff1a',
      'editorWidget.background': '#1a1c20',
      'editorError.foreground': '#ef7a6e',
      'editorWarning.foreground': '#d4c46f',
      'editorInfo.foreground': '#7aa2f7',
      'editorLightBulb.foreground': '#d8d5cf',
      'input.background': '#131417',
      'inputOption.activeBackground': '#24272c',
      'editor.findMatchBorder': '#7aa2f7',
      'editor.findMatchBackground': '#7aa2f712',
      'editor.findMatchHighlightBackground': '#ffffff1a',
      'editorActionList.background': '#1a1c20',
      'editorActionList.focusBackground': '#24272c',
      'textCodeBlock.background': '#131417',
    });
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
