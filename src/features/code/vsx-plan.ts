// code-editor-vsx FR-10: the pure half of live reload — the contributions grouped per
// language id, a signature per language, and the diff between what is applied to Monaco
// and what should be. vsx-apply.ts acts on the diff.

import type { VsxContributions, VsxGrammar, VsxLanguage } from '../../../contract/code-editor-vsx';

export interface LanguagePlan {
  id: string;
  /** The last contributed registration (null: only snippets target this — a built-in). */
  language: VsxLanguage | null;
  /** Raw language-configuration texts, merged left to right (§7). */
  configurations: string[];
  /** The tokenizer: the last grammar for the language (§7, the most recent install). */
  grammar: VsxGrammar | null;
  /** Raw snippet-file texts. */
  snippets: string[];
}

/** Contributions are ordered oldest install first (vsxStore.orderContributions). */
export function planContributions(c: VsxContributions): Map<string, LanguagePlan> {
  const plans = new Map<string, LanguagePlan>();
  const plan = (id: string) => {
    let p = plans.get(id);
    if (!p) plans.set(id, (p = { id, language: null, configurations: [], grammar: null, snippets: [] }));
    return p;
  };
  for (const l of c.languages) {
    const p = plan(l.id);
    p.language = l;
    if (l.configuration !== null) p.configurations.push(l.configuration);
  }
  for (const g of c.grammars) if (g.language) plan(g.language).grammar = g;
  for (const s of c.snippets) plan(s.language).snippets.push(s.content);
  return plans;
}

/** FNV-1a over the JSON text, plus its length — a cheap content signature. */
export function hashOf(value: unknown): string {
  const text = JSON.stringify(value);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${(h >>> 0).toString(16)}:${text.length}`;
}

/** One signature per language. Every grammar shares one registry (embedded scopes and
 *  injections cross extensions), so a grammar-carrying language also signs all grammars. */
export function signatures(c: VsxContributions): Map<string, string> {
  const grammars = hashOf(c.grammars);
  const out = new Map<string, string>();
  for (const [id, p] of planContributions(c)) out.set(id, hashOf([p, p.grammar ? grammars : '']));
  return out;
}

export function diffApplied(applied: ReadonlyMap<string, string>, next: ReadonlyMap<string, string>): { dispose: string[]; apply: string[] } {
  return {
    dispose: [...applied].filter(([id, sig]) => next.get(id) !== sig).map(([id]) => id),
    apply: [...next].filter(([id, sig]) => applied.get(id) !== sig).map(([id]) => id),
  };
}
