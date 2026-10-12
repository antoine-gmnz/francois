// code-editor-workspace FR-6: the two Monaco internals monaco-setup reaches past the
// public API for — the standalone service registry and the storage service id — so the
// suggest widget's details pane can start expanded. Monaco ships no types for them.

declare module 'monaco-editor/editor/standalone/browser/standaloneServices.js' {
  export const StandaloneServices: { get<T>(id: unknown): T };
}

declare module 'monaco-editor/platform/storage/common/storage.js' {
  export const IStorageService: unknown;
}

// code-editor-vsx FR-10: the tokenization registry, so disposing a contributed TextMate
// tokenizer can put back the Monarch one it replaced (Monaco's factory only builds once).
declare module 'monaco-editor/editor/common/languages.js' {
  export const TokenizationRegistry: {
    get(languageId: string): unknown;
    register(languageId: string, support: unknown): { dispose(): void };
  };
}
