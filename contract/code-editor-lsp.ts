// contract/code-editor-lsp.ts — code-editor-lsp feature contract (specs/code-editor-lsp.md §5).
// Binding per PIPELINE.md: francois:lsp:<verb> -> invoke('lsp_<verb>') -> Promise<Result<T>>;
// event stream francois:lsp:event -> Tauri event 'francois://lsp/event'.
// Added ErrorCode members live in contract/common.ts:
//   LSP_NOT_INSTALLED      — no server binary for the language (detail: { installHint })
//   LSP_UNTRUSTED          — the root was never allowed to run language servers (FR-4)
//   LSP_NOT_RUNNING        — request/notify for a server that is not starting/ready
//   LSP_METHOD_NOT_ALLOWED — method outside LSP_ALLOWED_REQUESTS/NOTIFICATIONS (detail: { method })
//   LSP_REQUEST_FAILED     — JSON-RPC error, timeout (-32803) or cancel (-32800) (detail: { code, message })
//
// The payloads of lsp_request / lsp_notify are raw LSP 3.17 JSON (`params` / result). URIs inside
// them are `file://` URIs as the WEBVIEW sees the filesystem (Windows: file:///C:/…, WSL roots:
// file://wsl.localhost/<distro>/…); the core rewrites them to and from the server's own view when
// the server runs inside WSL. The frontend never sees a Linux path.

import type { Result } from './common';
import type { EditorRoot } from './code-editor';

/** FR-2: the languages a server can be configured for. `typescript` covers .ts/.tsx/.js/.jsx/.mjs/.cjs. */
export type LspLanguage = 'typescript' | 'rust' | 'python' | 'go';

/** FR-5 */
export type LspState =
  | 'untrusted' // FR-4: the root was never allowed to run language servers — nothing spawned
  | 'missing' // FR-2: no server binary found — `installHint` says how to get one
  | 'stopped' // trusted + installed, not running (never started, idle-stopped, or lsp_stop)
  | 'starting' // spawned, `initialize` not answered yet
  | 'ready'
  | 'crashed'; // FR-7: exited unexpectedly more than LSP_MAX_RESTARTS times in LSP_RESTART_WINDOW_MS

export interface LspServerStatus {
  root: EditorRoot;
  language: LspLanguage;
  state: LspState;
  /** Display name, e.g. "typescript-language-server". */
  server: string;
  /** Server-reported `serverInfo.version`, or the bundled tsserver version for TS; null until known. */
  version: string | null;
  /** The resolved program (absolute path), null when `missing`/`untrusted`. Shown in the tooltip. */
  program: string | null;
  /** FR-2: a one-line install command when `missing`, e.g. "npm i -g typescript-language-server typescript". */
  installHint: string | null;
  /** The last error line (stderr tail / crash reason), null when healthy. */
  error: string | null;
  /** The `file://` URI of the root, in the webview's view (see header). */
  rootUri: string;
}

/** FR-7 limits — shared so the core and the frontend cannot drift. */
export const LSP_MAX_RESTARTS = 3;
export const LSP_RESTART_WINDOW_MS = 5 * 60_000;
export const LSP_IDLE_STOP_MS = 10 * 60_000; // no open document for this long -> stopped
export const LSP_REQUEST_TIMEOUT_MS = 10_000; // core answers LSP_REQUEST_FAILED { code: -32803 } past this
export const LSP_CHANGE_DEBOUNCE_MS = 150; // frontend didChange debounce

/** FR-3: the only methods the webview may send. Anything else -> LSP_METHOD_NOT_ALLOWED. */
export const LSP_ALLOWED_REQUESTS = [
  'textDocument/completion',
  'completionItem/resolve',
  'textDocument/hover',
  'textDocument/signatureHelp',
  'textDocument/definition',
  'textDocument/typeDefinition',
  'textDocument/implementation',
  'textDocument/references',
  'textDocument/documentHighlight',
  'textDocument/documentSymbol',
  'textDocument/codeAction',
  'codeAction/resolve',
  'textDocument/rename',
  'textDocument/prepareRename',
  'textDocument/formatting',
  'textDocument/rangeFormatting',
  'workspace/symbol',
] as const;
export type LspRequestMethod = (typeof LSP_ALLOWED_REQUESTS)[number];

export const LSP_ALLOWED_NOTIFICATIONS = [
  'textDocument/didOpen',
  'textDocument/didChange',
  'textDocument/didSave',
  'textDocument/didClose',
] as const;
export type LspNotifyMethod = (typeof LSP_ALLOWED_NOTIFICATIONS)[number];

// ---------- francois:lsp:status ----------
export interface LspStatusRequest {
  root: EditorRoot;
}
/** One entry per language in LspLanguage, in that order. Never spawns anything. */
// invoke('lsp_status', req): Promise<Result<LspServerStatus[]>>
// errors: 'PROJECT_NOT_FOUND' | 'SESSION_NOT_FOUND' | 'INTERNAL'
export type LspStatusResponse = Result<LspServerStatus[]>;

// ---------- francois:lsp:trust ----------
export interface LspTrustRequest {
  root: EditorRoot;
  /** true = allow language servers for this root directory; false = revoke (stops its servers). */
  trusted: boolean;
}
/** FR-4: persisted per absolute root directory in `~/.francois/lsp-trust.json`. Returns the new statuses. */
// invoke('lsp_trust', req): Promise<Result<LspServerStatus[]>>
// errors: 'PROJECT_NOT_FOUND' | 'SESSION_NOT_FOUND' | 'INTERNAL'
export type LspTrustResponse = Result<LspServerStatus[]>;

// ---------- francois:lsp:start ----------
export interface LspStartRequest {
  root: EditorRoot;
  language: LspLanguage;
}
/** Idempotent: an already starting/ready server is returned as is. Resolves once spawned (state
 *  'starting'); readiness arrives as an `lsp.status` event. A 'crashed' server is reset and retried. */
// invoke('lsp_start', req): Promise<Result<LspServerStatus>>
// errors: 'PROJECT_NOT_FOUND' | 'SESSION_NOT_FOUND' | 'LSP_UNTRUSTED' | 'LSP_NOT_INSTALLED' (detail: { installHint })
//       | 'INTERNAL'
export type LspStartResponse = Result<LspServerStatus>;

// ---------- francois:lsp:stop ----------
export interface LspStopRequest {
  root: EditorRoot;
  language: LspLanguage;
}
// invoke('lsp_stop', req): Promise<Result<null>> — shutdown + exit, kill after 2s. Stopping a stopped server is ok.
export type LspStopResponse = Result<null>;

// ---------- francois:lsp:request ----------
export interface LspRequestRequest {
  root: EditorRoot;
  language: LspLanguage;
  method: LspRequestMethod;
  /** Raw LSP params. */
  params: unknown;
  /** Optional, unique per call; lets lsp_cancel send `$/cancelRequest` for it (completion/hover). */
  requestId?: string;
}
/** The raw LSP result (may be null). A server-side JSON-RPC error -> LSP_REQUEST_FAILED. */
// invoke('lsp_request', req): Promise<Result<unknown>>
// errors: 'LSP_NOT_RUNNING' | 'LSP_METHOD_NOT_ALLOWED'
//       | 'LSP_REQUEST_FAILED' (detail: { code: number, message: string }) | 'PROJECT_NOT_FOUND' | 'SESSION_NOT_FOUND'
export type LspRequestResponse = Result<unknown>;

// ---------- francois:lsp:cancel ----------
export interface LspCancelRequest {
  root: EditorRoot;
  language: LspLanguage;
  /** The `requestId` passed on the LspRequestRequest to cancel. */
  requestId: string;
}
// invoke('lsp_cancel', req): Promise<Result<null>> — no-op if already answered. The cancelled lsp_request
// resolves with LSP_REQUEST_FAILED { code: -32800 }.
export type LspCancelResponse = Result<null>;

// ---------- francois:lsp:notify ----------
export interface LspNotifyRequest {
  root: EditorRoot;
  language: LspLanguage;
  method: LspNotifyMethod;
  params: unknown;
}
/** Fire-and-forget into the server's stdin, in call order. The core tracks didOpen/didClose to
 *  drive the idle stop (FR-7) and to re-open every open document after a restart. */
// invoke('lsp_notify', req): Promise<Result<null>>
// errors: 'LSP_NOT_RUNNING' | 'LSP_METHOD_NOT_ALLOWED' | 'PROJECT_NOT_FOUND' | 'SESSION_NOT_FOUND'
export type LspNotifyResponse = Result<null>;

// ---------- francois:lsp:event ----------
// Tauri event 'francois://lsp/event'.
export type LspEvent =
  | { type: 'lsp.status'; status: LspServerStatus }
  /** `textDocument/publishDiagnostics` params, URIs already rewritten to the webview's view. */
  | { type: 'lsp.diagnostics'; root: EditorRoot; language: LspLanguage; uri: string; version: number | null; diagnostics: unknown[] }
  /** `$/progress` for work-done tokens, flattened. `done: true` ends the token. */
  | {
      type: 'lsp.progress';
      root: EditorRoot;
      language: LspLanguage;
      token: string;
      title: string | null;
      message: string | null;
      percentage: number | null;
      done: boolean;
    };
// Server -> client REQUESTS are answered by the core and never reach the webview:
// workspace/configuration -> one `null` per item; client/registerCapability, client/unregisterCapability,
// window/workDoneProgress/create -> null; window/showMessageRequest -> null; workspace/applyEdit ->
// { applied: false } (v1 does not apply server-initiated edits). window/logMessage / showMessage are
// logged to the core log, not forwarded.
