// code-editor-lsp FR-9 — the Monaco providers backed by the language servers, registered
// once per Monaco language id. Every provider answers only for a Code-tab model whose
// root has a `ready` server (lsp-bridge.ts `readyDoc`) and returns nothing otherwise,
// so Monaco's built-ins (TS/JS) keep working until a server is up.
//
// Trigger characters are static: the contract does not carry the server capabilities,
// so they follow what each server advertises by default.

import type * as Monaco from 'monaco-editor';
import type { LspLanguage } from '../../../contract/code-editor-lsp';
import { diagnosticsOf, ensureEditModels, ensurePreviewModels, modelUriMapper, readyDoc, request, type ReadyDoc } from './lsp-bridge';
import {
  toCodeActions,
  toCompletionItem,
  toCompletionList,
  toDocumentSymbols,
  toHighlights,
  toHover,
  toLocations,
  toLspPosition,
  toLspRange,
  toRenameLocation,
  toSignatureHelp,
  toTextEdits,
  toWorkspaceEdit,
  workspaceEditUris,
  type LspCodeAction,
  type LspCompletionItem,
  type LspRange,
  type LspWorkspaceEdit,
} from './lsp-convert';
import { getBuffer, bufferKey } from './buffers';
import { parseModelUriPath } from './problems';

type MonacoApi = typeof Monaco;
type Pos = Monaco.Position;
type Token = Monaco.CancellationToken;

const MONACO_IDS: Record<LspLanguage, string[]> = {
  typescript: ['typescript', 'javascript'],
  rust: ['rust'],
  python: ['python'],
  go: ['go'],
};

const COMPLETION_TRIGGERS: Record<LspLanguage, string[]> = {
  typescript: ['.', '"', "'", '`', '/', '@', '<', '#'],
  rust: ['.', ':', "'"],
  python: ['.', '[', '"', "'"],
  go: ['.'],
};

const at = (doc: ReadyDoc, position: Pos) => ({ textDocument: { uri: doc.uri }, position: toLspPosition(position) });

/** The model under `uri` is a Code tab (not a preview) — edits to it can be saved. */
function isTabModel(m: MonacoApi, uri: Monaco.Uri): boolean {
  const parsed = parseModelUriPath(uri.path);
  return uri.scheme === 'inmemory' && !!parsed && !!getBuffer(bufferKey(parsed.rootKey, parsed.path)) && !!m.editor.getModel(uri);
}

/** A WorkspaceEdit Monaco can apply: every target opened as a tab first (FR-13). */
async function applicableEdit(doc: ReadyDoc, we: LspWorkspaceEdit): Promise<Monaco.languages.WorkspaceEdit> {
  const toUri = modelUriMapper(doc);
  const uris = workspaceEditUris(we)
    .map(toUri)
    .filter((u): u is Monaco.Uri => u !== null);
  const ready = await ensureEditModels(uris);
  const edit = toWorkspaceEdit(we, toUri);
  return { edits: edit.edits.filter((e) => 'resource' in e && ready.has(e.resource.toString())) };
}

async function locations(doc: ReadyDoc, method: 'textDocument/definition' | 'textDocument/typeDefinition' | 'textDocument/implementation', position: Pos, token: Token) {
  const r = await request(doc, method, at(doc, position), token);
  if (!r) return undefined;
  const links = toLocations(r.data as Parameters<typeof toLocations>[0], modelUriMapper(doc));
  await ensurePreviewModels(links.map((l) => l.uri));
  return links;
}

const overlaps = (a: LspRange, b: LspRange) =>
  !(a.end.line < b.start.line || (a.end.line === b.start.line && a.end.character < b.start.character) || b.end.line < a.start.line || (b.end.line === a.start.line && b.end.character < a.start.character));

export function installLspProviders(monaco: MonacoApi): void {
  const L = monaco.languages;
  const completionMeta = new WeakMap<Monaco.languages.CompletionItem, { doc: ReadyDoc; item: LspCompletionItem }>();
  const actionMeta = new WeakMap<Monaco.languages.CodeAction, { doc: ReadyDoc; lsp: LspCodeAction }>();

  for (const [language, ids] of Object.entries(MONACO_IDS) as Array<[LspLanguage, string[]]>) {
    for (const id of ids) {
      L.registerCompletionItemProvider(id, {
        triggerCharacters: COMPLETION_TRIGGERS[language],
        async provideCompletionItems(model, position, context, token) {
          const doc = readyDoc(model);
          if (!doc) return undefined;
          const word = model.getWordUntilPosition(position);
          const range = { startLineNumber: position.lineNumber, startColumn: word.startColumn, endLineNumber: position.lineNumber, endColumn: word.endColumn };
          // Monaco's trigger kinds are 0-based, LSP's 1-based.
          const params = { ...at(doc, position), context: { triggerKind: context.triggerKind + 1, triggerCharacter: context.triggerCharacter } };
          const r = await request(doc, 'textDocument/completion', params, token);
          if (!r) return undefined;
          const out = toCompletionList(r.data as Parameters<typeof toCompletionList>[0], range);
          out.suggestions.forEach((s, i) => completionMeta.set(s, { doc, item: out.items[i] }));
          return { suggestions: out.suggestions, incomplete: out.incomplete };
        },
        async resolveCompletionItem(item, token) {
          const meta = completionMeta.get(item);
          if (!meta) return item;
          const r = await request(meta.doc, 'completionItem/resolve', meta.item, token, { anyVersion: true });
          if (!r?.data) return item;
          const range = 'insert' in item.range ? item.range.replace : item.range;
          const more = toCompletionItem(r.data as LspCompletionItem, range);
          if (more.detail) item.detail = more.detail;
          if (more.documentation !== undefined) item.documentation = more.documentation;
          if (more.additionalTextEdits) item.additionalTextEdits = more.additionalTextEdits;
          return item;
        },
      });

      L.registerHoverProvider(id, {
        async provideHover(model, position, token) {
          const doc = readyDoc(model);
          const r = doc && (await request(doc, 'textDocument/hover', at(doc, position), token));
          return r ? (toHover(r.data as Parameters<typeof toHover>[0]) ?? undefined) : undefined;
        },
      });

      L.registerSignatureHelpProvider(id, {
        signatureHelpTriggerCharacters: ['(', ',', '<'],
        signatureHelpRetriggerCharacters: [')'],
        async provideSignatureHelp(model, position, token, context) {
          const doc = readyDoc(model);
          if (!doc) return undefined;
          const params = { ...at(doc, position), context: { triggerKind: context.triggerKind, triggerCharacter: context.triggerCharacter, isRetrigger: context.isRetrigger } };
          const r = await request(doc, 'textDocument/signatureHelp', params, token);
          const value = r ? toSignatureHelp(r.data as Parameters<typeof toSignatureHelp>[0]) : null;
          return value ? { value, dispose: () => {} } : undefined;
        },
      });

      L.registerDefinitionProvider(id, {
        provideDefinition: (model, position, token) => {
          const doc = readyDoc(model);
          return doc ? locations(doc, 'textDocument/definition', position, token) : undefined;
        },
      });
      L.registerTypeDefinitionProvider(id, {
        provideTypeDefinition: (model, position, token) => {
          const doc = readyDoc(model);
          return doc ? locations(doc, 'textDocument/typeDefinition', position, token) : undefined;
        },
      });
      L.registerImplementationProvider(id, {
        provideImplementation: (model, position, token) => {
          const doc = readyDoc(model);
          return doc ? locations(doc, 'textDocument/implementation', position, token) : undefined;
        },
      });

      L.registerReferenceProvider(id, {
        async provideReferences(model, position, context, token) {
          const doc = readyDoc(model);
          if (!doc) return undefined;
          const r = await request(doc, 'textDocument/references', { ...at(doc, position), context: { includeDeclaration: context.includeDeclaration } }, token);
          if (!r) return undefined;
          const refs = toLocations(r.data as Parameters<typeof toLocations>[0], modelUriMapper(doc)).map((l) => ({ uri: l.uri, range: l.range }));
          await ensurePreviewModels(refs.map((l) => l.uri));
          return refs;
        },
      });

      L.registerDocumentHighlightProvider(id, {
        async provideDocumentHighlights(model, position, token) {
          const doc = readyDoc(model);
          const r = doc && (await request(doc, 'textDocument/documentHighlight', at(doc, position), token));
          return r ? toHighlights(r.data as Parameters<typeof toHighlights>[0]) : undefined;
        },
      });

      L.registerDocumentSymbolProvider(id, {
        displayName: 'Language server',
        async provideDocumentSymbols(model, token) {
          const doc = readyDoc(model);
          const r = doc && (await request(doc, 'textDocument/documentSymbol', { textDocument: { uri: doc.uri } }, token));
          return r ? toDocumentSymbols(r.data as Parameters<typeof toDocumentSymbols>[0]) : undefined;
        },
      });

      L.registerCodeActionProvider(id, {
        async provideCodeActions(model, range, context, token) {
          const doc = readyDoc(model);
          if (!doc) return undefined;
          const lspRange = toLspRange(range);
          const diagnostics = diagnosticsOf(model).filter((d) => overlaps(d.range, lspRange));
          const params = { textDocument: { uri: doc.uri }, range: lspRange, context: { diagnostics, only: context.only ? [context.only] : undefined, triggerKind: context.trigger } };
          const r = await request(doc, 'textDocument/codeAction', params, token);
          if (!r) return undefined;
          const actions = toCodeActions(r.data as unknown[], doc.language, modelUriMapper(doc)).map(({ action, lsp }) => {
            // An edit touching a file with no tab is applied through resolve, which opens it first.
            if (action.edit?.edits.some((e) => 'resource' in e && !isTabModel(monaco, e.resource))) delete action.edit;
            actionMeta.set(action, { doc, lsp });
            return action;
          });
          return { actions, dispose: () => {} };
        },
        async resolveCodeAction(action) {
          const meta = actionMeta.get(action);
          if (!meta) return action;
          let we = meta.lsp.edit;
          if (!we && meta.lsp.data !== undefined) {
            const r = await request(meta.doc, 'codeAction/resolve', meta.lsp, undefined, { anyVersion: true });
            we = (r?.data as LspCodeAction | null | undefined)?.edit;
          }
          if (we) action.edit = await applicableEdit(meta.doc, we);
          return action;
        },
      });

      L.registerRenameProvider(id, {
        async provideRenameEdits(model, position, newName, token) {
          const doc = readyDoc(model);
          if (!doc) return undefined;
          const r = await request(doc, 'textDocument/rename', { ...at(doc, position), newName }, token);
          if (!r) return { edits: [], rejectReason: 'The language server could not rename this.' };
          return applicableEdit(doc, (r.data ?? {}) as LspWorkspaceEdit);
        },
        async resolveRenameLocation(model, position, token) {
          const doc = readyDoc(model);
          if (!doc) return undefined;
          const wordAt = () => {
            const w = model.getWordAtPosition(position);
            return w ? { range: { startLineNumber: position.lineNumber, startColumn: w.startColumn, endLineNumber: position.lineNumber, endColumn: w.endColumn }, text: w.word } : null;
          };
          const r = await request(doc, 'textDocument/prepareRename', at(doc, position), token);
          // No prepareRename support (or it failed): rename the word under the caret.
          if (!r) return wordAt() ?? undefined;
          return toRenameLocation(r.data as Parameters<typeof toRenameLocation>[0], wordAt, (range) => model.getValueInRange(range));
        },
      });

      L.registerDocumentFormattingEditProvider(id, {
        displayName: 'Language server',
        async provideDocumentFormattingEdits(model, options, token) {
          const doc = readyDoc(model);
          const r = doc && (await request(doc, 'textDocument/formatting', { textDocument: { uri: doc.uri }, options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces } }, token));
          return r ? toTextEdits(r.data as Parameters<typeof toTextEdits>[0]) : undefined;
        },
      });
      L.registerDocumentRangeFormattingEditProvider(id, {
        displayName: 'Language server',
        async provideDocumentRangeFormattingEdits(model, range, options, token) {
          const doc = readyDoc(model);
          const params = doc && { textDocument: { uri: doc.uri }, range: toLspRange(range), options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces } };
          const r = doc && (await request(doc, 'textDocument/rangeFormatting', params, token));
          return r ? toTextEdits(r.data as Parameters<typeof toTextEdits>[0]) : undefined;
        },
      });
    }
  }
}
