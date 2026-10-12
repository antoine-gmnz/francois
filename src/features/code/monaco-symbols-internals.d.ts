// code-editor-workspace FR-5/FR-11: the language-features service id monaco-symbols.ts
// reads document symbol providers from (Monaco exposes registration, not lookup).
// Monaco ships no types for it.

declare module 'monaco-editor/editor/common/services/languageFeatures.js' {
  export const ILanguageFeaturesService: unknown;
}
