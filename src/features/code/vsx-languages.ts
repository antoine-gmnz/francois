// code-editor-vsx FR-8: the pure half of contributed languages — lenient JSONC, the
// VS Code language-configuration → Monaco LanguageConfiguration conversion (string
// regexes compiled, invalid ones dropped), the §7 left-to-right merge, and the
// path → contributed language match language.ts consults after its built-ins.

import type * as Monaco from 'monaco-editor';
import type { VsxLanguage } from '../../../contract/code-editor-vsx';

type LanguageConfiguration = Monaco.languages.LanguageConfiguration;
type OnEnterRule = Monaco.languages.OnEnterRule;
type IndentAction = Monaco.languages.IndentAction;

/** JSON with comments and trailing commas (VS Code's own configuration dialect). Throws when
 *  the text is still not JSON once those are removed. */
export function parseJsonc(text: string): unknown {
  // Two string-aware passes: comments first, so a trailing comma hidden behind one shows.
  return JSON.parse(scan(scan(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text, stripComment), stripTrailingComma));
}

/** Copies `text`, string literals verbatim; outside them `step` decides what to keep and returns
 *  the index to resume at. */
function scan(text: string, step: (text: string, i: number, keep: (s: string) => void) => number): string {
  let out = '';
  const keep = (s: string) => {
    out += s;
  };
  let i = 0;
  while (i < text.length) {
    if (text[i] === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else i = step(text, i, keep);
  }
  return out;
}

function stripComment(text: string, i: number, keep: (s: string) => void): number {
  if (text[i] === '/' && text[i + 1] === '/') {
    const end = text.indexOf('\n', i);
    return end < 0 ? text.length : end;
  }
  if (text[i] === '/' && text[i + 1] === '*') {
    const end = text.indexOf('*/', i + 2);
    return end < 0 ? text.length : end + 2;
  }
  keep(text[i]);
  return i + 1;
}

function stripTrailingComma(text: string, i: number, keep: (s: string) => void): number {
  if (text[i] === ',') {
    let j = i + 1;
    while (j < text.length && /\s/.test(text[j])) j++;
    if (text[j] === '}' || text[j] === ']') return i + 1;
  }
  keep(text[i]);
  return i + 1;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === 'string';

/** A VS Code regex — a string, or `{ pattern, flags }` — compiled; undefined when invalid. */
export function compileRegex(value: unknown): RegExp | undefined {
  const pattern = isString(value) ? value : isObject(value) && isString(value.pattern) ? value.pattern : null;
  if (pattern === null) return undefined;
  const flags = isObject(value) && isString(value.flags) ? value.flags : undefined;
  try {
    return new RegExp(pattern, flags);
  } catch {
    return undefined;
  }
}

function charPair(v: unknown): [string, string] | null {
  return Array.isArray(v) && v.length === 2 && isString(v[0]) && isString(v[1]) ? [v[0], v[1]] : null;
}

function pairs(v: unknown): Array<[string, string]> | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.map(charPair).filter((p): p is [string, string] => p !== null);
}

function openClose(v: unknown): { open: string; close: string; notIn?: string[] } | null {
  const p = charPair(v);
  if (p) return { open: p[0], close: p[1] };
  if (!isObject(v) || !isString(v.open) || !isString(v.close)) return null;
  const notIn = Array.isArray(v.notIn) ? v.notIn.filter(isString) : null;
  return notIn ? { open: v.open, close: v.close, notIn } : { open: v.open, close: v.close };
}

function openCloses(v: unknown) {
  if (!Array.isArray(v)) return undefined;
  return v.map(openClose).filter((p): p is NonNullable<ReturnType<typeof openClose>> => p !== null);
}

// Monaco's IndentAction enum values (None, Indent, IndentOutdent, Outdent), kept literal so
// this module stays free of the Monaco runtime.
const INDENT_ACTIONS: Record<string, number> = { none: 0, indent: 1, indentOutdent: 2, outdent: 3 };

function onEnterRule(v: unknown): OnEnterRule | null {
  if (!isObject(v) || !isObject(v.action)) return null;
  const beforeText = compileRegex(v.beforeText);
  const indentAction = isString(v.action.indent) ? INDENT_ACTIONS[v.action.indent] : undefined;
  if (!beforeText || indentAction === undefined) return null;
  const action: OnEnterRule['action'] = { indentAction: indentAction as IndentAction };
  if (isString(v.action.appendText)) action.appendText = v.action.appendText;
  if (typeof v.action.removeText === 'number') action.removeText = v.action.removeText;
  const rule: OnEnterRule = { beforeText, action };
  const afterText = compileRegex(v.afterText);
  const previousLineText = compileRegex(v.previousLineText);
  if (afterText) rule.afterText = afterText;
  if (previousLineText) rule.previousLineText = previousLineText;
  return rule;
}

function comments(v: unknown): LanguageConfiguration['comments'] {
  if (!isObject(v)) return undefined;
  const out: NonNullable<LanguageConfiguration['comments']> = {};
  const line = isString(v.lineComment) ? v.lineComment : isObject(v.lineComment) && isString(v.lineComment.comment) ? v.lineComment.comment : null;
  if (line) out.lineComment = line;
  const block = charPair(v.blockComment);
  if (block) out.blockComment = block;
  return out;
}

/** A parsed language-configuration file → what Monaco's setLanguageConfiguration takes. */
export function toLanguageConfiguration(raw: unknown): LanguageConfiguration {
  if (!isObject(raw)) return {};
  const conf: LanguageConfiguration = {};
  const c = comments(raw.comments);
  if (c) conf.comments = c;
  const brackets = pairs(raw.brackets);
  if (brackets) conf.brackets = brackets;
  const colorized = pairs(raw.colorizedBracketPairs);
  if (colorized) conf.colorizedBracketPairs = colorized;
  const auto = openCloses(raw.autoClosingPairs);
  if (auto) conf.autoClosingPairs = auto;
  const surrounding = openCloses(raw.surroundingPairs);
  if (surrounding) conf.surroundingPairs = surrounding.map(({ open, close }) => ({ open, close }));
  const wordPattern = compileRegex(raw.wordPattern);
  if (wordPattern) conf.wordPattern = wordPattern;

  if (isObject(raw.folding)) {
    const folding: NonNullable<LanguageConfiguration['folding']> = {};
    if (typeof raw.folding.offSide === 'boolean') folding.offSide = raw.folding.offSide;
    const m = raw.folding.markers;
    const start = isObject(m) ? compileRegex(m.start) : undefined;
    const end = isObject(m) ? compileRegex(m.end) : undefined;
    if (start && end) folding.markers = { start, end };
    conf.folding = folding;
  }

  if (isObject(raw.indentationRules)) {
    const r = raw.indentationRules;
    const increaseIndentPattern = compileRegex(r.increaseIndentPattern);
    const decreaseIndentPattern = compileRegex(r.decreaseIndentPattern);
    if (increaseIndentPattern && decreaseIndentPattern) {
      const rules: NonNullable<LanguageConfiguration['indentationRules']> = { increaseIndentPattern, decreaseIndentPattern };
      const next = compileRegex(r.indentNextLinePattern);
      const unindented = compileRegex(r.unIndentedLinePattern);
      if (next) rules.indentNextLinePattern = next;
      if (unindented) rules.unIndentedLinePattern = unindented;
      conf.indentationRules = rules;
    }
  }

  if (Array.isArray(raw.onEnterRules)) conf.onEnterRules = raw.onEnterRules.map(onEnterRule).filter((r): r is OnEnterRule => r !== null);
  return conf;
}

/** §7: two extensions configuring one language merge left to right, the later winning per key. */
export function mergeConfigurations(list: readonly LanguageConfiguration[]): LanguageConfiguration {
  return Object.assign({}, ...list) as LanguageConfiguration;
}

/** A VS Code filename glob (`*`, `?`, `**`, `{a,b}`) → an anchored, case-insensitive RegExp. */
function globToRegex(glob: string): RegExp {
  let src = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      const slash = glob[i + 2] === '/';
      src += slash ? '(?:.*/)?' : '.*';
      i += slash ? 2 : 1;
    } else if (c === '*') src += '[^/]*';
    else if (c === '?') src += '[^/]';
    else if (c === '{') src += '(?:';
    else if (c === '}') src += ')';
    else if (c === ',') src += '|';
    else src += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${src}$`, 'i');
}

const globCache = new Map<string, RegExp | null>();
function globMatches(glob: string, path: string, base: string): boolean {
  let re = globCache.get(glob);
  if (re === undefined) {
    try {
      re = globToRegex(glob);
    } catch {
      re = null;
    }
    globCache.set(glob, re);
  }
  return !!re && re.test(glob.includes('/') ? path : base);
}

/** The contributed language for a root-relative `path`: an exact filename first, then a
 *  filename pattern, then the longest matching extension. The later contribution wins a tie
 *  (callers order contributions oldest install first). */
export function matchContributedLanguage(path: string, languages: readonly VsxLanguage[]): VsxLanguage | null {
  const norm = path.replace(/\\/g, '/');
  const base = norm.slice(norm.lastIndexOf('/') + 1);
  const lower = base.toLowerCase();
  let byName: VsxLanguage | null = null;
  let byPattern: VsxLanguage | null = null;
  let byExt: VsxLanguage | null = null;
  let extLen = 0;
  for (const l of languages) {
    if (l.filenames.some((f) => f.toLowerCase() === lower)) byName = l;
    if (l.filenamePatterns.some((g) => globMatches(g, norm, base))) byPattern = l;
    for (const e of l.extensions) {
      const ext = (e.startsWith('.') ? e : `.${e}`).toLowerCase();
      if (lower.endsWith(ext) && lower.length > ext.length - 1 && ext.length >= extLen) {
        byExt = l;
        extLen = ext.length;
      }
    }
  }
  return byName ?? byPattern ?? byExt;
}
