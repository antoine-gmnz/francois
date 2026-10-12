---
id: code-editor-lsp
feature_id: code-editor-lsp
title: Code editor, language servers — real LSP behind the Monaco editor
status: frozen
branch: feat/code-editor-improvement
created: 2026-10-09
depends_on: [code-editor, code-editor-workspace, wsl-filesystem, extension-install]
design_files:
  - https://www.figma.com/design/YEY4c6AiWq1bKYuaju9qdV/?node-id=259-28018   # 52 · status bar "TypeScript 5.6 · ready" pill
  - https://www.figma.com/design/YEY4c6AiWq1bKYuaju9qdV/?node-id=262-28312   # 53 · completion
  - https://www.figma.com/design/YEY4c6AiWq1bKYuaju9qdV/?node-id=262-29263   # 54 · hover + quick fix + "Peek references (3)"
---

# Code editor, language servers

## 1. Summary

`code-editor-workspace` kept language intelligence to Monaco's in-browser workers, which only see
open files. This feature runs real Language Server Protocol servers from the Rust core — one per
(root, language) — and bridges them into Monaco, so types resolve across the project, go to
definition / find references / rename work across files, and Rust, Python and Go get the same
treatment as TypeScript. No new screens: the existing Figma 52–54 surfaces simply become truthful.

## 2. Goals & non-goals

- **Goals**: TS/JS via `typescript-language-server` (the tested path), plus Rust (`rust-analyzer`),
  Python (`pyright-langserver`), Go (`gopls`) through the same generic host; completion, hover,
  signature help, definition, references, rename, code actions, document symbols, formatting,
  diagnostics into the Problems panel, progress in the status bar; per-root trust; WSL roots.
- **Non-goals**: bundling or auto-installing servers; server-initiated workspace edits
  (`workspace/applyEdit`); semantic tokens, inlay hints, call hierarchy, code lens; per-server
  settings UI; more languages than the four.

## 4. Functional requirements

### Core (src-tauri, new domain `lsp/`)

- **FR-1 Host.** One child process per (root dir, language), spawned on `lsp_start`, speaking
  JSON-RPC 2.0 over stdio with `Content-Length` framing. On spawn: `initialize` (processId,
  rootUri, workspaceFolders = [root], clientInfo `Francois`, capabilities matching the providers the
  frontend registers — completion with snippets + resolve, hover markdown, signatureHelp,
  definition/typeDefinition/implementation/references, documentHighlight, documentSymbol
  hierarchical, codeAction with literal support + resolve, rename with prepare, formatting,
  publishDiagnostics with relatedInformation, window.workDoneProgress) → `initialized`. Server →
  client requests are answered by the core per the contract footer. Every spawn goes through
  `process_util` (login-shell PATH, no console window on Windows).
- **FR-2 Server table + resolution.** A static table per language: program name(s), args,
  initializationOptions, install hint.
  - typescript: `typescript-language-server --stdio`; look in `<root>/node_modules/.bin/` first, then
    PATH (`process_util::resolve_program`). `initializationOptions.tsserver.path` = the root's
    `node_modules/typescript/lib/tsserver.js` when present (the project's own TS version). Hint:
    `npm i -g typescript-language-server typescript`.
  - rust: `rust-analyzer`; hint `rustup component add rust-analyzer`.
  - python: `pyright-langserver --stdio`, then `basedpyright-langserver --stdio`; hint `npm i -g pyright`.
  - go: `gopls`; hint `go install golang.org/x/tools/gopls@latest`.
  A language whose binary is not found is `missing`. Resolution is re-probed on `lsp_status`
  (cache ≤ 30 s) so installing a server and clicking Retry works without a restart.
- **FR-3 Allowlist.** `lsp_request` / `lsp_notify` refuse any method outside the contract's lists
  (`LSP_METHOD_NOT_ALLOWED`). Requests time out after `LSP_REQUEST_TIMEOUT_MS`; `lsp_cancel` sends
  `$/cancelRequest`.
- **FR-4 Trust.** Starting a language server can execute project code (tsserver plugins from
  tsconfig, rust-analyzer build scripts and proc macros, gopls running `go list`). Nothing spawns for
  a root until it is trusted; trust is stored per normalised absolute root directory in
  `~/.francois/lsp-trust.json` (atomic write). Revoking stops that root's servers.
- **FR-5 Status.** `lsp_status` lists every language; every state change emits `lsp.status`.
  Version: `serverInfo.version` from the initialize result (TS: append the tsserver version read
  from `node_modules/typescript/package.json` when the project ships it, e.g. `TypeScript 5.6`).
- **FR-6 Diagnostics & progress.** `textDocument/publishDiagnostics` → `lsp.diagnostics`;
  `$/progress` (begin/report/end) → `lsp.progress`.
- **FR-7 Lifecycle.** The core tracks open documents (didOpen/didClose) per server. No open document
  for `LSP_IDLE_STOP_MS` → graceful stop (`shutdown`, `exit`, kill after 2 s). Unexpected exit →
  restart and replay `didOpen` for every open document with its last text (the core keeps the latest
  full text from didOpen/didChange); more than `LSP_MAX_RESTARTS` exits in `LSP_RESTART_WINDOW_MS` →
  `crashed` with the stderr tail as `error`. App quit stops every server. stderr is drained
  continuously (ring buffer, last 4 KiB) so a chatty server never blocks.
- **FR-8 WSL.** A root on a WSL UNC path runs the server inside WSL (`wsl.exe` with the distro +
  `--cd` as the shell/session spawns do, via `crate::wsl`), resolution probes inside WSL, and every
  `file://` URI in params, results and notifications is rewritten between
  `file://wsl.localhost/<distro>/…` and `file:///…` (deep walk over JSON strings that start with
  `file://`).

### Frontend (src/features/code)

- **FR-9 Bridge.** A hand-written adapter (no monaco-languageclient) registers Monaco providers for
  the Monaco language ids of each LspLanguage: completion (+ resolve, snippets, additionalTextEdits,
  commit characters, trigger characters from the server capabilities), hover, signature help,
  definition, type definition, implementation, references, document highlight, document symbols,
  code actions (+ resolve; actions carrying only a `command` are skipped in v1), rename (+ prepare),
  document & range formatting. Providers answer only for models whose root has a `ready` server for
  that language and return `null`/empty otherwise. Pure LSP↔Monaco converters (positions are
  0-based UTF-16 in LSP, 1-based in Monaco; CompletionItemKind, SymbolKind, DiagnosticSeverity,
  MarkupContent, TextEdit/WorkspaceEdit → Monaco edits) are unit-tested.
- **FR-10 Document sync.** For every Code-tab model of a language with a ready server: `didOpen`
  (languageId, version = model version id, full text) when the model is created or the server
  becomes ready; `didChange` full-text (no range) debounced `LSP_CHANGE_DEBOUNCE_MS`, flushed before
  any request on that model; `didSave` after a successful ⌘S; `didClose` when the model is disposed.
  Re-sent after an `lsp.status` → ready transition (restart).
- **FR-11 Built-in overlap.** While a TS server is ready for the shown root, Monaco's own TS/JS
  language features are turned off (completion, hover, definitions, references, document symbols,
  diagnostics, signature help, code actions, rename, formatting) via the typescript defaults' mode
  configuration, and restored when it is not. Other languages had no built-in intelligence.
- **FR-12 Diagnostics.** `lsp.diagnostics` → `monaco.editor.setModelMarkers(model, 'lsp', …)` for
  the matching model (owner `lsp`; code shown as `ts(2345)` for TS, the server's `source(code)`
  otherwise). Diagnostics for files with no model are kept in a map and fed to the Problems panel
  too (the panel groups them by file and opening one opens the file). The Problems panel source
  becomes markers ∪ that map.
- **FR-13 Cross-file navigation.** Definition / references / symbol results pointing at a file with
  no tab open it in the focused group with the caret on the target (Monaco editor opener), creating
  the model via the normal `openFile` path. References open Monaco's peek widget (styled like the
  hover card).
- **FR-14 Status pill.** The status bar pill (Figma 52) reads, for the active file's language:
  `● <TypeScript 5.6 | rust-analyzer 2026-09-29 | …> · ready` (green dot); `· starting` /
  `· <progress title> <n>%` (dim dot, pulsing) while starting or indexing; `· stopped`; amber
  `· not installed` (click: copies the install hint and shows it in a notice); red `· crashed`
  (click: restart). Tooltip: program path + last error. When no server applies, the v1 Monaco pill
  stays (TS only).
- **FR-15 Trust prompt.** The first time a trusted-capable file (a language with an installed
  server) is shown under an untrusted root, a slim bar above the editor (same family as the
  "Changed on disk" bar): `Language servers can run code from orbit-api (tsconfig plugins, build
  scripts).` + **Allow** (primary) + **Not now** (dismisses for the app run; the built-in Monaco
  intelligence stays). Palette: "Code: Allow language servers for this root", "Code: Revoke language
  servers for this root", "Code: Restart language server".
- **FR-16 Lifecycle from the UI.** `lsp_start` when a file of that language is shown under a trusted
  root and the server is `stopped`; no start while `missing`/`untrusted`. The frontend subscribes to
  `francois://lsp/event` once (alongside the editor event feed) and keeps statuses in a small store
  keyed by root key + language.

## 5. Contract

`contract/code-editor-lsp.ts`; ErrorCode members in `contract/common.ts`.

## 7. Edge cases

- Server answers after the model changed: results are applied only if the model version id is the
  one the request was made against (completion/hover/signature help are simply dropped otherwise).
- A root with both a tsconfig and no `node_modules`: the global `typescript-language-server` with its
  own bundled TypeScript.
- Two Code roots on the same directory (a project and a session whose cwd is that project) share one
  server per language — keyed by the normalised directory, not the EditorRoot.
- Read-only files: requests still work; formatting/rename edits are refused by Monaco's read-only.
- Server sends diagnostics for a file outside the root: ignored.
