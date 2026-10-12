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
  // Sliders sit ON TOP of the minimap / text, so they must be translucent: an opaque
  // surface token here paints a solid block over the minimap.
  'minimapSlider.background': '--line-subtle',
  'minimapSlider.hoverBackground': '--line-default',
  'minimapSlider.activeBackground': '--line-strong',
  'scrollbarSlider.background': '--line-default',
  'scrollbarSlider.hoverBackground': '--line-strong',
  'scrollbarSlider.activeBackground': '--line-strong',
};

// code-editor-workspace FR-6/FR-8/FR-10: the floating widgets — one `--bg-popover` card
// family (Figma 53/54/55). monaco-widgets.css adds what a colour id cannot say (radius, fonts, layout).
const WIDGETS: Record<string, string> = {
  'widget.border': '--line-default',
  'editorWidget.background': '--bg-popover',
  'editorWidget.foreground': '--text-primary',
  'editorWidget.border': '--line-default',
  // FR-6 completion
  'editorSuggestWidget.background': '--bg-popover',
  'editorSuggestWidget.border': '--line-default',
  'editorSuggestWidget.foreground': '--text-secondary',
  'editorSuggestWidget.selectedBackground': '--bg-selected',
  'editorSuggestWidget.selectedForeground': '--text-primary',
  'editorSuggestWidget.selectedIconForeground': '--hue-blue',
  'editorSuggestWidget.highlightForeground': '--text-primary',
  'editorSuggestWidget.focusHighlightForeground': '--text-primary',
  'editorSuggestWidgetStatus.foreground': '--text-faint',
  // FR-8 diagnostics + hover + quick fix
  'editorError.foreground': '--state-danger',
  'editorWarning.foreground': '--warn',
  'editorInfo.foreground': '--state-info',
  'editorHoverWidget.background': '--bg-popover',
  'editorHoverWidget.foreground': '--text-secondary',
  'editorHoverWidget.border': '--line-default',
  'editorHoverWidget.statusBarBackground': '--bg-popover',
  'editorHoverWidget.highlightForeground': '--text-primary',
  'editorLightBulb.foreground': '--text-secondary',
  'editorLightBulbAutoFix.foreground': '--text-secondary',
  'editorActionList.background': '--bg-popover',
  'editorActionList.foreground': '--text-secondary',
  'editorActionList.focusBackground': '--bg-selected',
  'editorActionList.focusForeground': '--text-primary',
  'textLink.foreground': '--state-info',
  'textLink.activeForeground': '--state-info',
  'textCodeBlock.background': '--bg-input',
  'textPreformat.foreground': '--text-primary',
  // The right-click menu (monaco-widgets.css also pins these on its container).
  'menu.background': '--bg-popover',
  'menu.foreground': '--text-secondary',
  'menu.border': '--line-default',
  'menu.separatorBackground': '--line-subtle',
  'menu.selectionBackground': '--bg-selected',
  'menu.selectionForeground': '--text-primary',
  'list.hoverBackground': '--bg-selected',
  'list.hoverForeground': '--text-primary',
  // FR-10 find & replace
  'input.background': '--bg-input',
  'input.foreground': '--text-primary',
  'input.border': '--line-subtle',
  'input.placeholderForeground': '--text-faint',
  'inputOption.activeBackground': '--bg-selected',
  'inputOption.activeBorder': '--line-default',
  'inputOption.activeForeground': '--text-primary',
  'editor.findMatchBackground': '--tint-info',
  'editor.findMatchBorder': '--state-info',
  'editor.findMatchHighlightBackground': '--line-default',
  'editor.findRangeHighlightBackground': '--tint-info',
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
  // code-editor-vsx FR-7: TextMate scopes from contributed grammars, onto the same tokens.
  // Monaco matches a rule by dotted prefix, so `string` already covers `string.quoted.*`.
  ['constant.numeric', '--hue-clay'],
  ['constant.language', '--hue-clay'],
  ['constant.character', '--hue-clay'],
  ['keyword.control', '--hue-purple-soft'],
  ['keyword.operator', '--text-muted'],
  ['storage', '--hue-purple-soft'],
  ['entity.name.function', '--hue-blue'],
  ['support.function', '--hue-blue'],
  ['entity.name.type', '--hue-blue'],
  ['entity.name.class', '--hue-blue'],
  ['entity.name.namespace', '--hue-blue'],
  ['support.type', '--hue-blue'],
  ['support.class', '--hue-blue'],
  ['entity.name.tag', '--hue-blue'],
  ['entity.other.attribute-name', '--hue-clay'],
  ['variable', '--text-primary'],
  ['punctuation', '--text-muted'],
  ['punctuation.definition.string', '--hue-teal'],
  ['punctuation.definition.comment', '--text-faint', 'italic'],
  ['meta.tag', '--text-muted'],
  ['markup.heading', '--hue-blue'],
  ['markup.bold', '--text-primary', 'bold'],
  ['markup.italic', '--text-primary', 'italic'],
  ['markup.inline.raw', '--hue-teal'],
  ['invalid', '--state-danger'],
];

export function buildGraphiteTheme(read: (name: string) => string, theme: 'dark' | 'light'): GraphiteTheme {
  const hex = (name: string) => read(name).trim();
  const colors: Record<string, string> = {};
  for (const [key, token] of Object.entries({ ...CHROME, ...WIDGETS })) {
    const v = hex(token);
    if (v) colors[key] = v;
  }
  const rules = SYNTAX.map(([token, name, fontStyle]) => {
    const v = hex(name);
    return { token, foreground: v ? v.replace(/^#/, '') : undefined, ...(fontStyle ? { fontStyle } : {}) };
  });
  return { base: theme === 'light' ? 'vs' : 'vs-dark', inherit: true, rules, colors };
}
