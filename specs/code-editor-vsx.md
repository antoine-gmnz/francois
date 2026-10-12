---
id: code-editor-vsx
feature_id: code-editor-vsx
title: Code editor, extensions — declarative VS Code extensions from Open VSX
status: frozen
branch: feat/code-editor-improvement
created: 2026-10-09
depends_on: [code-editor, code-editor-workspace, code-editor-lsp, webview-hardening]
design_files: []   # no frame yet — follows the Search/Source control sidebar family of Figma 52/57
---

# Code editor, extensions

## 1. Summary

An EXTENSIONS view in the Code tab's activity bar: search Open VSX, install, enable/disable and
uninstall VS Code extensions — but only their **declarative** half (languages, TextMate grammars,
snippets, language configuration). That covers syntax highlighting for any language, snippets and
editing behaviour (brackets, comments, indentation) without running any extension code. Together
with `code-editor-lsp` (language servers) it covers most of what people install language
extensions for.

Not to be confused with Francois's own `extensions` (the `ext:` plugin tabs).

## 2. Goals & non-goals

- **Goals**: Open VSX search/details/install/uninstall/enable; checksum-verified, size-capped,
  zip-slip-safe extraction of declarative files only; TextMate tokenization in Monaco
  (`vscode-textmate` + `vscode-oniguruma`); contributed languages (file association), language
  configuration and snippets.
- **Non-goals**: running extension JavaScript (no extension host) — commands, views, debuggers,
  webviews, settings; Microsoft's Marketplace (its terms forbid it); colour themes (Graphite owns
  colour); icon themes; auto-update (an update badge is enough); other registries.

## 4. Functional requirements

### Core (src-tauri, new domain `vsx/`)

- **FR-1 Registry client.** HTTPS GETs to `VSX_REGISTRY` only (ureq, already a dependency):
  `/api/-/search`, `/api/<ns>/<name>[/<version>]`, and the `files.*` URLs that response returns
  (manifest, download, sha256, icon, readme) — these may live on another host (Open VSX storage),
  so they are accepted only when they came from a registry response, never from the webview.
  Timeouts 15 s (search/details), 120 s (download). Non-2xx / network failure → `VSX_UNREACHABLE`;
  404 → `VSX_NOT_FOUND`. Icons are fetched (≤ 256 KiB) and returned as data URLs, cached on disk by
  URL under `~/.francois/vsx/cache/` (LRU ≤ 20 MiB).
- **FR-2 Details.** `vsx_details` reads the version's `package.json` (`files.manifest`) to classify
  support and count contributions; README excerpt from `files.readme` (≤ 2 KB plain text).
- **FR-3 Support.** Declarative = `contributes.languages`, `contributes.grammars`,
  `contributes.snippets` (language configuration comes through `languages[].configuration`).
  `full` = some declarative contribution and no `main`/`browser`; `partial` = declarative + code;
  `unsupported` = no declarative contribution → `vsx_install` refuses with `VSX_UNSUPPORTED`.
  Extension packs (`extensionPack`) are `unsupported` in v1.
- **FR-4 Install.** Download to a temp file streaming with a hard cap (`VSX_MAX_PACKAGE_BYTES`),
  verify the sha256 from `files.sha256` (mismatch → `VSX_INVALID_PACKAGE`), open the zip (new
  dependency: the `zip` crate, deflate only), read `extension/package.json`, then extract ONLY:
  `extension/package.json`, every path referenced by the declarative contributions, and the icon.
  Each entry path is normalised and must stay under `extension/` (no absolute paths, `..`, drive
  prefixes, or symlinks — zip-slip → `VSX_INVALID_PACKAGE`); per-file cap `VSX_MAX_FILE_BYTES`,
  total cap `VSX_MAX_EXTRACT_BYTES`. Extract into a temp dir, then rename into
  `~/.francois/vsx/<id>-<version>/` (replacing an older version of the same id), then update
  `installed.json` atomically. Nothing executable is written (no `main`/`browser` files).
- **FR-5 Contributions.** `vsx_contributions` walks enabled installs and inlines file contents per
  the contract. Grammar `format` from the extension (`.json` → json, `.tmLanguage`/`.plist`/`.xml` →
  plist). Malformed files of one extension are skipped (logged), never failing the call.

### Frontend (src/features/code)

- **FR-6 Extensions view.** A fifth activity-bar item (the `layers`/blocks icon of the Figma 52
  rail, between Source control and Problems) shows the EXTENSIONS sidebar, same family as Search
  (Figma 57): a search input (300 ms debounce; empty = INSTALLED + POPULAR), an INSTALLED section
  (icon 28px, display name, publisher · version, enabled switch, ⋯ with Uninstall), then results
  (icon, name, verified tick, publisher, downloads `1.2M`, one-line description, Install button or
  `Installed`). Clicking a row expands its details inline: description, support badge
  (`Full` / `Syntax & snippets only` for partial, with a one-line explanation), language chips,
  contribution counts, license, "View on Open VSX" (system browser), and the README excerpt.
  `unsupported` rows show a disabled `Needs VS Code` instead of Install. Load more at the end
  (offset paging). Errors show inline with Retry.
- **FR-7 TextMate.** `vscode-textmate` + `vscode-oniguruma` (the onig wasm bundled locally via
  Vite `?url`, loaded lazily on first grammar use). A grammar registry over the contributed
  grammars (json or plist via vscode-textmate's parser), resolving embedded and injected scopes.
  For each contributed language with a grammar: `monaco.languages.setTokensProvider` with a state
  adapter (rule stack) whose tokens are the innermost TextMate scope; the Graphite Monaco theme
  gains TextMate scope rules (comment, string, constant.numeric, keyword, storage, entity.name.function,
  entity.name.type, support.function, support.type, variable, punctuation, meta.tag, entity.other.attribute-name…)
  mapped onto the existing syntax tokens so highlighting stays in-identity in both themes. A
  contributed grammar for a language Monaco already highlights replaces Monarch for it.
- **FR-8 Languages & configuration.** Contributed languages are registered with Monaco
  (`monaco.languages.register`) and consulted by `language.ts` for path → language (extensions,
  filenames, filename patterns), after the built-ins. Language configuration (JSONC parsed
  leniently) → `setLanguageConfiguration`: comments, brackets, autoClosingPairs, surroundingPairs,
  colorizedBracketPairs, folding markers, wordPattern, indentationRules, onEnterRules — string
  regexes compiled to `RegExp` (invalid ones dropped).
- **FR-9 Snippets.** Contributed snippet files (JSONC; `prefix` string or array, `body` string or
  array, `description`) → a completion provider per language offering them as
  `InsertAsSnippet` items (kind Snippet), merged with whatever LSP / built-in completion offers.
- **FR-10 Live reload.** After install / uninstall / enable / disable the frontend re-fetches
  `vsx_contributions` and re-applies: newly enabled languages/grammars register; disabled ones
  revert to plain text (dispose their providers; Monarch built-ins come back where they existed);
  open models re-tokenize (re-set their language).
- **FR-11 CSP.** The onig wasm needs `'wasm-unsafe-eval'` in `script-src` (both `csp` and `devCsp`
  in tauri.conf.json), and `img-src` gains `data:` (both too) because extension icons cross IPC as
  `data:` URLs (contract `VsxSummary.icon`). No other CSP change: the webview never talks to the registry.

## 5. Contract

`contract/code-editor-vsx.ts`; ErrorCode members in `contract/error-code.ts`.

## 7. Edge cases

- Same language contributed by two extensions: the most recently installed wins for the tokenizer;
  both configurations are merged left-to-right (later wins per key).
- A grammar that fails to compile (bad regex for oniguruma): that language falls back to plain text
  and the Extensions view shows a warning on the extension row.
- Offline: INSTALLED keeps working; search shows the unreachable error.
