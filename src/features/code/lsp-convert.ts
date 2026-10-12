// code-editor-lsp FR-9/FR-12: pure LSP 3.17 ↔ Monaco converters. No monaco import at
// runtime — Monaco's enums are mirrored as numbers (stable in monaco.d.ts) and every
// `Uri` comes from a caller-supplied mapper, so all of this runs under vitest.
//
// Positions: LSP is 0-based line + UTF-16 character; Monaco is 1-based line + column
// (also UTF-16 units) — so both convert by ±1.

import type * as Monaco from 'monaco-editor';
import type { LspLanguage } from '../../../contract/code-editor-lsp';

type IRange = Monaco.IRange;
type ToUri = (fileUri: string) => Monaco.Uri | null;

// ---------- the LSP shapes this module reads (a structural subset of 3.17) ----------

export interface LspPosition {
  line: number;
  character: number;
}
export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}
export interface LspTextEdit {
  range: LspRange;
  newText: string;
}
export interface LspInsertReplaceEdit {
  newText: string;
  insert: LspRange;
  replace: LspRange;
}
export interface LspMarkupContent {
  kind: 'plaintext' | 'markdown';
  value: string;
}
export type LspMarkedString = string | { language: string; value: string };
export type LspHoverContents = LspMarkupContent | LspMarkedString | LspMarkedString[];

export interface LspCompletionItem {
  label: string;
  labelDetails?: { detail?: string; description?: string };
  kind?: number;
  tags?: number[];
  detail?: string;
  documentation?: string | LspMarkupContent;
  deprecated?: boolean;
  preselect?: boolean;
  sortText?: string;
  filterText?: string;
  insertText?: string;
  insertTextFormat?: number;
  textEdit?: LspTextEdit | LspInsertReplaceEdit;
  textEditText?: string;
  additionalTextEdits?: LspTextEdit[];
  commitCharacters?: string[];
  data?: unknown;
}
export interface LspItemDefaults {
  commitCharacters?: string[];
  editRange?: LspRange | { insert: LspRange; replace: LspRange };
  insertTextFormat?: number;
  data?: unknown;
}
export interface LspCompletionList {
  isIncomplete: boolean;
  itemDefaults?: LspItemDefaults;
  items: LspCompletionItem[];
}

export interface LspLocation {
  uri: string;
  range: LspRange;
}
export interface LspLocationLink {
  originSelectionRange?: LspRange;
  targetUri: string;
  targetRange: LspRange;
  targetSelectionRange: LspRange;
}

export interface LspDocumentSymbol {
  name: string;
  detail?: string;
  kind: number;
  tags?: number[];
  deprecated?: boolean;
  range: LspRange;
  selectionRange: LspRange;
  children?: LspDocumentSymbol[];
}
export interface LspSymbolInformation {
  name: string;
  kind: number;
  tags?: number[];
  location: LspLocation;
  containerName?: string;
}

export interface LspDiagnostic {
  range: LspRange;
  severity?: number;
  code?: number | string;
  source?: string;
  message: string;
  tags?: number[];
  relatedInformation?: Array<{ location: LspLocation; message: string }>;
}

export interface LspWorkspaceEdit {
  changes?: Record<string, LspTextEdit[]>;
  documentChanges?: Array<{ textDocument?: { uri: string; version: number | null }; edits?: LspTextEdit[]; kind?: string }>;
}

export interface LspCodeAction {
  title: string;
  kind?: string;
  diagnostics?: LspDiagnostic[];
  isPreferred?: boolean;
  disabled?: { reason: string };
  edit?: LspWorkspaceEdit;
  command?: unknown;
  data?: unknown;
}

// ---------- positions, ranges, uris, languages ----------

export const toLspPosition = (p: { lineNumber: number; column: number }): LspPosition => ({ line: p.lineNumber - 1, character: p.column - 1 });

export const toMonacoRange = (r: LspRange): IRange => ({
  startLineNumber: r.start.line + 1,
  startColumn: r.start.character + 1,
  endLineNumber: r.end.line + 1,
  endColumn: r.end.character + 1,
});

export const toLspRange = (r: IRange): LspRange => ({
  start: { line: r.startLineNumber - 1, character: r.startColumn - 1 },
  end: { line: r.endLineNumber - 1, character: r.endColumn - 1 },
});

const trimSlash = (s: string) => s.replace(/\/+$/, '');

/** The `file://` uri of `path` (root-relative, `/`-separated) under the status's `rootUri`. */
export function fileUriFor(rootUri: string, path: string): string {
  return `${trimSlash(rootUri)}/${path.split('/').map(encodeURIComponent).join('/')}`;
}

function decode(uri: string): string {
  try {
    return decodeURIComponent(uri);
  } catch {
    return uri;
  }
}

const DRIVE = /^file:\/\/\/([A-Za-z]):/;

/**
 * The root-relative path behind a server `file://` uri, or null when it is not inside
 * `rootUri`. Servers spell the same file differently (`c%3A`, lower-case drive), so both
 * sides are decoded first; a drive-letter (Windows) root compares case-insensitively.
 */
export function relPathOf(rootUri: string, uri: string): string | null {
  const root = `${trimSlash(decode(rootUri))}/`;
  const target = decode(uri);
  const caseless = DRIVE.test(root);
  const head = target.slice(0, root.length);
  if (caseless ? head.toLowerCase() !== root.toLowerCase() : head !== root) return null;
  const rest = target.slice(root.length);
  return rest ? rest : null;
}

/** The server language behind a Monaco language id (TS covers JS). */
export function lspLanguageOf(monacoId: string): LspLanguage | null {
  if (monacoId === 'typescript' || monacoId === 'javascript') return 'typescript';
  if (monacoId === 'rust' || monacoId === 'python' || monacoId === 'go') return monacoId;
  return null;
}

/** The LSP `languageId` of a file, for didOpen. */
export function lspLanguageIdFor(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  if (ext === 'tsx') return 'typescriptreact';
  if (ext === 'jsx') return 'javascriptreact';
  if (ext === 'ts' || ext === 'mts' || ext === 'cts') return 'typescript';
  if (ext === 'js' || ext === 'mjs' || ext === 'cjs') return 'javascript';
  if (ext === 'rs') return 'rust';
  if (ext === 'py') return 'python';
  if (ext === 'go') return 'go';
  return 'plaintext';
}

// ---------- markdown ----------

const escapeMarkdown = (s: string) => s.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');

function markedString(m: LspMarkedString): Monaco.IMarkdownString | null {
  if (typeof m === 'string') return m ? { value: m } : null;
  return { value: `\`\`\`${m.language}\n${m.value}\n\`\`\`` };
}

export function toMarkdown(c: LspHoverContents | null | undefined): Monaco.IMarkdownString[] {
  if (c === null || c === undefined) return [];
  if (Array.isArray(c)) return c.map(markedString).filter((m): m is Monaco.IMarkdownString => m !== null);
  if (typeof c === 'object' && 'kind' in c) {
    if (!c.value) return [];
    return [{ value: c.kind === 'markdown' ? c.value : escapeMarkdown(c.value) }];
  }
  const one = markedString(c);
  return one ? [one] : [];
}

function documentation(d: string | LspMarkupContent | undefined): string | Monaco.IMarkdownString | undefined {
  if (d === undefined) return undefined;
  if (typeof d === 'string') return d;
  return d.kind === 'markdown' ? { value: d.value } : d.value;
}

// ---------- completion ----------

// LSP CompletionItemKind (1-based) → Monaco CompletionItemKind.
const COMPLETION_KIND: Record<number, number> = {
  1: 18, // Text
  2: 0, // Method
  3: 1, // Function
  4: 2, // Constructor
  5: 3, // Field
  6: 4, // Variable
  7: 5, // Class
  8: 7, // Interface
  9: 8, // Module
  10: 9, // Property
  11: 12, // Unit
  12: 13, // Value
  13: 15, // Enum
  14: 17, // Keyword
  15: 28, // Snippet
  16: 19, // Color
  17: 20, // File
  18: 21, // Reference
  19: 23, // Folder
  20: 16, // EnumMember
  21: 14, // Constant
  22: 6, // Struct
  23: 10, // Event
  24: 11, // Operator
  25: 24, // TypeParameter
};
const MONACO_TEXT_KIND = 18;
const INSERT_AS_SNIPPET = 4;
const SNIPPET_FORMAT = 2;
const DEPRECATED_TAG = 1;

type CompletionRange = Monaco.languages.CompletionItem['range'];

function editRange(r: LspRange | { insert: LspRange; replace: LspRange }): CompletionRange {
  return 'start' in r ? toMonacoRange(r) : { insert: toMonacoRange(r.insert), replace: toMonacoRange(r.replace) };
}

export function toCompletionItem(item: LspCompletionItem, defaultRange: IRange, defaults?: LspItemDefaults): Monaco.languages.CompletionItem {
  let range: CompletionRange = defaultRange;
  let insertText = item.insertText ?? item.label;
  if (item.textEdit) {
    insertText = item.textEdit.newText;
    range = 'range' in item.textEdit ? toMonacoRange(item.textEdit.range) : editRange(item.textEdit);
  } else if (defaults?.editRange) {
    insertText = item.textEditText ?? item.insertText ?? item.label;
    range = editRange(defaults.editRange);
  }
  const out: Monaco.languages.CompletionItem = {
    label: item.labelDetails ? { label: item.label, detail: item.labelDetails.detail, description: item.labelDetails.description } : item.label,
    kind: (COMPLETION_KIND[item.kind ?? 1] ?? MONACO_TEXT_KIND) as Monaco.languages.CompletionItemKind,
    insertText,
    range,
  };
  if ((item.insertTextFormat ?? defaults?.insertTextFormat) === SNIPPET_FORMAT) out.insertTextRules = INSERT_AS_SNIPPET as Monaco.languages.CompletionItemInsertTextRule;
  if (item.detail) out.detail = item.detail;
  const doc = documentation(item.documentation);
  if (doc !== undefined) out.documentation = doc;
  if (item.sortText !== undefined) out.sortText = item.sortText;
  if (item.filterText !== undefined) out.filterText = item.filterText;
  if (item.preselect) out.preselect = true;
  const commit = item.commitCharacters ?? defaults?.commitCharacters;
  if (commit) out.commitCharacters = commit;
  if (item.additionalTextEdits?.length) out.additionalTextEdits = toTextEdits(item.additionalTextEdits);
  if (item.deprecated || item.tags?.includes(DEPRECATED_TAG)) out.tags = [DEPRECATED_TAG as Monaco.languages.CompletionItemTag];
  return out;
}

export interface ConvertedCompletions {
  suggestions: Monaco.languages.CompletionItem[];
  incomplete: boolean;
  /** The LSP items behind `suggestions`, index for index, with the list's default `data` applied (for resolve). */
  items: LspCompletionItem[];
}

export function toCompletionList(result: LspCompletionList | LspCompletionItem[] | null | undefined, defaultRange: IRange): ConvertedCompletions {
  if (!result) return { suggestions: [], incomplete: false, items: [] };
  const list = Array.isArray(result) ? { isIncomplete: false, items: result } : result;
  const defaults = Array.isArray(result) ? undefined : result.itemDefaults;
  const items = list.items.map((i) => (i.data === undefined && defaults?.data !== undefined ? { ...i, data: defaults.data } : i));
  return { suggestions: items.map((i) => toCompletionItem(i, defaultRange, defaults)), incomplete: list.isIncomplete, items };
}

// ---------- hover, signature help ----------

export function toHover(h: { contents: LspHoverContents; range?: LspRange } | null | undefined): Monaco.languages.Hover | null {
  if (!h) return null;
  const contents = toMarkdown(h.contents);
  if (contents.length === 0) return null;
  return h.range ? { contents, range: toMonacoRange(h.range) } : { contents };
}

interface LspSignatureHelp {
  signatures: Array<{
    label: string;
    documentation?: string | LspMarkupContent;
    parameters?: Array<{ label: string | [number, number]; documentation?: string | LspMarkupContent }>;
    activeParameter?: number;
  }>;
  activeSignature?: number;
  activeParameter?: number;
}

export function toSignatureHelp(s: LspSignatureHelp | null | undefined): Monaco.languages.SignatureHelp | null {
  if (!s || s.signatures.length === 0) return null;
  return {
    signatures: s.signatures.map((sig) => ({
      label: sig.label,
      documentation: documentation(sig.documentation),
      parameters: (sig.parameters ?? []).map((p) => ({ label: p.label, documentation: documentation(p.documentation) })),
      activeParameter: sig.activeParameter,
    })),
    activeSignature: s.activeSignature ?? 0,
    activeParameter: s.activeParameter ?? 0,
  };
}

// ---------- locations ----------

export function toLocations(result: LspLocation | Array<LspLocation | LspLocationLink> | null | undefined, toUri: ToUri): Monaco.languages.LocationLink[] {
  if (!result) return [];
  const list = Array.isArray(result) ? result : [result];
  const out: Monaco.languages.LocationLink[] = [];
  for (const l of list) {
    if ('targetUri' in l) {
      const uri = toUri(l.targetUri);
      if (!uri) continue;
      const link: Monaco.languages.LocationLink = { uri, range: toMonacoRange(l.targetRange), targetSelectionRange: toMonacoRange(l.targetSelectionRange) };
      if (l.originSelectionRange) link.originSelectionRange = toMonacoRange(l.originSelectionRange);
      out.push(link);
    } else {
      const uri = toUri(l.uri);
      if (uri) out.push({ uri, range: toMonacoRange(l.range) });
    }
  }
  return out;
}

// ---------- symbols, highlights ----------

const symbolKind = (k: number) => Math.max(0, k - 1) as Monaco.languages.SymbolKind; // LSP is 1-based
const symbolTags = (tags: number[] | undefined, deprecated?: boolean) =>
  (deprecated && !tags?.includes(1) ? [...(tags ?? []), 1] : (tags ?? [])) as Monaco.languages.SymbolTag[];

function fromDocumentSymbol(s: LspDocumentSymbol): Monaco.languages.DocumentSymbol {
  return {
    name: s.name,
    detail: s.detail ?? '',
    kind: symbolKind(s.kind),
    tags: symbolTags(s.tags, s.deprecated),
    range: toMonacoRange(s.range),
    selectionRange: toMonacoRange(s.selectionRange),
    children: (s.children ?? []).map(fromDocumentSymbol),
  };
}

const contains = (outer: IRange, inner: IRange) =>
  (outer.startLineNumber < inner.startLineNumber || (outer.startLineNumber === inner.startLineNumber && outer.startColumn <= inner.startColumn)) &&
  (outer.endLineNumber > inner.endLineNumber || (outer.endLineNumber === inner.endLineNumber && outer.endColumn >= inner.endColumn));

/** Hierarchical symbols; flat SymbolInformation is nested by range containment. */
export function toDocumentSymbols(result: Array<LspDocumentSymbol | LspSymbolInformation> | null | undefined): Monaco.languages.DocumentSymbol[] {
  if (!result || result.length === 0) return [];
  if (!('location' in result[0])) return (result as LspDocumentSymbol[]).map(fromDocumentSymbol);
  const flat = (result as LspSymbolInformation[])
    .map((s): Monaco.languages.DocumentSymbol => {
      const range = toMonacoRange(s.location.range);
      return { name: s.name, detail: '', kind: symbolKind(s.kind), tags: symbolTags(s.tags), containerName: s.containerName, range, selectionRange: range, children: [] };
    })
    .sort((a, b) => a.range.startLineNumber - b.range.startLineNumber || a.range.startColumn - b.range.startColumn);
  const roots: Monaco.languages.DocumentSymbol[] = [];
  const stack: Monaco.languages.DocumentSymbol[] = [];
  for (const s of flat) {
    while (stack.length && !contains(stack[stack.length - 1].range, s.range)) stack.pop();
    const parent = stack[stack.length - 1];
    if (parent) parent.children?.push(s);
    else roots.push(s);
    stack.push(s);
  }
  return roots;
}

export function toHighlights(result: Array<{ range: LspRange; kind?: number }> | null | undefined): Monaco.languages.DocumentHighlight[] {
  return (result ?? []).map((h) => ({ range: toMonacoRange(h.range), kind: ((h.kind ?? 1) - 1) as Monaco.languages.DocumentHighlightKind }));
}

// ---------- edits ----------

export function toTextEdits(edits: LspTextEdit[] | null | undefined): Monaco.languages.TextEdit[] {
  return (edits ?? []).map((e) => ({ range: toMonacoRange(e.range), text: e.newText }));
}

/** Text edits per file uri, in order: `documentChanges` (TextDocumentEdit only) wins over `changes`. */
function editsByUri(we: LspWorkspaceEdit): Array<[string, LspTextEdit[]]> {
  if (we.documentChanges) {
    return we.documentChanges.filter((d) => d.textDocument && d.edits).map((d) => [d.textDocument?.uri ?? '', d.edits ?? []]);
  }
  return Object.entries(we.changes ?? {});
}

export function workspaceEditUris(we: LspWorkspaceEdit | null | undefined): string[] {
  return we ? [...new Set(editsByUri(we).map(([uri]) => uri))] : [];
}

export function toWorkspaceEdit(we: LspWorkspaceEdit | null | undefined, toUri: ToUri): { edits: Monaco.languages.IWorkspaceTextEdit[] } {
  const edits: Monaco.languages.IWorkspaceTextEdit[] = [];
  if (!we) return { edits };
  for (const [fileUri, list] of editsByUri(we)) {
    const resource = toUri(fileUri);
    if (!resource) continue;
    for (const e of list) edits.push({ resource, textEdit: { range: toMonacoRange(e.range), text: e.newText }, versionId: undefined });
  }
  return { edits };
}

// ---------- code actions ----------

export interface ConvertedAction {
  action: Monaco.languages.CodeAction;
  lsp: LspCodeAction;
}

/** v1 keeps actions that carry an edit or can be resolved into one; bare `Command`s and command-only actions are skipped. */
export function toCodeActions(result: unknown[] | null | undefined, language: LspLanguage, toUri: ToUri): ConvertedAction[] {
  const out: ConvertedAction[] = [];
  for (const raw of result ?? []) {
    const a = raw as LspCodeAction;
    if (typeof a.command === 'string') continue; // a Command, not a CodeAction
    if (!a.edit && a.data === undefined) continue;
    const action: Monaco.languages.CodeAction = { title: a.title };
    if (a.kind) action.kind = a.kind;
    if (a.isPreferred) action.isPreferred = true;
    if (a.disabled) action.disabled = a.disabled.reason;
    if (a.diagnostics) action.diagnostics = a.diagnostics.map((d) => toMarkerData(d, language, toUri));
    if (a.edit) action.edit = toWorkspaceEdit(a.edit, toUri);
    out.push({ action, lsp: a });
  }
  return out;
}

// ---------- rename ----------

type RenameAnswer = Monaco.languages.RenameLocation & Monaco.languages.Rejection;

/** prepareRename's answer: a Range, `{ range, placeholder }`, `{ defaultBehavior }`, or null (refused). */
export function toRenameLocation(
  result: LspRange | { range: LspRange; placeholder: string } | { defaultBehavior: boolean } | null | undefined,
  wordAt: () => Monaco.languages.RenameLocation | null,
  textIn: (range: IRange) => string,
): RenameAnswer {
  const refused: RenameAnswer = { range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }, text: '', rejectReason: "This element can't be renamed." };
  if (!result) return refused;
  if ('defaultBehavior' in result) return wordAt() ?? refused;
  if ('placeholder' in result) return { range: toMonacoRange(result.range), text: result.placeholder };
  const range = toMonacoRange(result);
  return { range, text: textIn(range) };
}

// ---------- diagnostics ----------

// LSP DiagnosticSeverity Error 1 · Warning 2 · Information 3 · Hint 4 → Monaco 8 · 4 · 2 · 1.
const SEVERITY: Record<number, number> = { 1: 8, 2: 4, 3: 2, 4: 1 };

/** FR-12: a diagnostic as Monaco marker data — TS codes read `ts(2345)`, others `<source>(<code>)`. */
export function toMarkerData(d: LspDiagnostic, language: LspLanguage, toUri: ToUri): Monaco.editor.IMarkerData {
  const out: Monaco.editor.IMarkerData = {
    severity: (SEVERITY[d.severity ?? 1] ?? 8) as Monaco.MarkerSeverity,
    message: d.message,
    ...toMonacoRange(d.range),
  };
  const source = language === 'typescript' ? 'ts' : d.source;
  if (source) out.source = source;
  if (d.code !== undefined && d.code !== null && d.code !== '') out.code = String(d.code);
  if (d.tags?.length) out.tags = d.tags as Monaco.MarkerTag[];
  const related: Monaco.editor.IRelatedInformation[] = [];
  for (const r of d.relatedInformation ?? []) {
    const resource = toUri(r.location.uri);
    if (resource) related.push({ resource, message: r.message, ...toMonacoRange(r.location.range) });
  }
  if (related.length) out.relatedInformation = related;
  return out;
}
