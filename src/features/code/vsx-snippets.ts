// code-editor-vsx FR-9: contributed snippet files (JSONC; `prefix` and `body` a string or
// an array, optional `description`) → Monaco snippet completion items. vsx-apply.ts
// registers one provider per language; Monaco merges it with the LSP / built-in ones
// (same language selector, so the same provider group).

import type * as Monaco from 'monaco-editor';
import { parseJsonc } from './vsx-languages';

export interface SnippetDef {
  prefix: string;
  name: string;
  body: string;
  description: string | null;
}

// Monaco's CompletionItemKind.Snippet and CompletionItemInsertTextRule.InsertAsSnippet,
// literal so this module stays free of the Monaco runtime.
export const SNIPPET_KIND = 28 as Monaco.languages.CompletionItemKind;
export const SNIPPET_INSERT_RULE = 4 as Monaco.languages.CompletionItemInsertTextRule;

const lines = (v: unknown): string | null => {
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v.join('\n');
  return null;
};

/** A snippets file → one definition per prefix; malformed files and entries are skipped. */
export function parseSnippets(content: string): SnippetDef[] {
  let raw: unknown;
  try {
    raw = parseJsonc(content);
  } catch {
    return [];
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return [];
  const out: SnippetDef[] = [];
  for (const [name, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const body = lines(e.body);
    const prefixes = typeof e.prefix === 'string' ? [e.prefix] : Array.isArray(e.prefix) ? e.prefix.filter((p): p is string => typeof p === 'string') : [];
    if (body === null) continue;
    const description = lines(e.description);
    for (const prefix of prefixes) if (prefix) out.push({ prefix, name, body, description });
  }
  return out;
}

export function snippetSuggestions(defs: readonly SnippetDef[], range: Monaco.IRange): Monaco.languages.CompletionItem[] {
  return defs.map((d) => ({
    label: { label: d.prefix, description: d.name },
    kind: SNIPPET_KIND,
    insertText: d.body,
    insertTextRules: SNIPPET_INSERT_RULE,
    detail: d.description ?? d.name,
    documentation: { value: '```\n' + d.body + '\n```' },
    range,
    sortText: d.prefix,
  }));
}

/** The completion provider for one language's snippets. */
export function snippetProvider(defs: readonly SnippetDef[]): Monaco.languages.CompletionItemProvider {
  return {
    provideCompletionItems(model, position) {
      const word = model.getWordUntilPosition(position);
      const range = { startLineNumber: position.lineNumber, startColumn: word.startColumn, endLineNumber: position.lineNumber, endColumn: word.endColumn };
      return { suggestions: snippetSuggestions(defs, range) };
    },
  };
}
