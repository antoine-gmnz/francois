// code-editor FR-7 / §8: the Monaco theme, generated from the Graphite CSS tokens
// at runtime and re-applied whenever `data-theme` flips. Pure — `read` resolves a
// custom property — so the token mapping is unit-testable without Monaco or a DOM.
// The returned shape is Monaco's IStandaloneThemeData.

export interface ThemeRule {
  token: string;
  foreground?: string;
  fontStyle?: string;
}

export interface GraphiteTheme {
  base: 'vs' | 'vs-dark';
  inherit: boolean;
  rules: ThemeRule[];
  colors: Record<string, string>;
}

const CHROME: Record<string, string> = {
  'editor.background': '--bg-terminal',
  'editor.foreground': '--text-primary',
  'editorLineNumber.foreground': '--text-line-number',
  'editorLineNumber.activeForeground': '--text-primary',
  'editor.lineHighlightBorder': '--bg-raised',
  'editor.selectionBackground': '--bg-selected',
  'editorCursor.foreground': '--text-primary',
  'editorGutter.background': '--bg-terminal',
  'minimap.background': '--bg-terminal',
  'minimapSlider.background': '--bg-raised',
  'minimapSlider.hoverBackground': '--bg-selected',
  'scrollbarSlider.background': '--bg-raised',
  'scrollbarSlider.hoverBackground': '--bg-selected',
};

const SYNTAX: Array<[string, string, string?]> = [
  ['keyword', '--hue-purple-soft'],
  ['string', '--hue-teal'],
  ['number', '--hue-clay'],
  ['type', '--hue-blue'],
  ['type.identifier', '--hue-blue'],
  ['function', '--hue-blue'],
  ['comment', '--text-faint', 'italic'],
  ['delimiter', '--text-muted'],
  ['delimiter.bracket', '--text-muted'],
];

export function buildGraphiteTheme(read: (name: string) => string, theme: 'dark' | 'light'): GraphiteTheme {
  const hex = (name: string) => read(name).trim();
  const colors: Record<string, string> = {};
  for (const [key, token] of Object.entries(CHROME)) {
    const v = hex(token);
    if (v) colors[key] = v;
  }
  const rules = SYNTAX.map(([token, name, fontStyle]) => {
    const v = hex(name);
    return { token, foreground: v ? v.replace(/^#/, '') : undefined, ...(fontStyle ? { fontStyle } : {}) };
  });
  return { base: theme === 'light' ? 'vs' : 'vs-dark', inherit: true, rules, colors };
}
