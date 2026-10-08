---
id: ctrl-click-links
status: shipped
reviewed_base: f874d01f7579c80d5e7a6829aaea9f19b9b18c69
reviewed_digest: 01ec72a64f204997
---

# Ctrl/Cmd-click links and files

Implemented scope: session transcripts (including agent/workflow transcripts), Markdown
links, inline-code filenames, explicit paths and URLs in text/code blocks, and the
session panel's Changes file tree.

- Ctrl + primary click or Cmd + primary click opens a target externally.
- HTTP(S) links open in the default browser, without navigating the app webview.
- Existing files/folders resolve against the owning session's cwd, including worktrees.
- Files use the first detected editor in the existing detection order: VS Code,
  VS Code Insiders, Cursor, Windsurf.
- `:line[:column]` and `#Lline` references open at the requested position.
- Local `file://` links are decoded; WSL targets use the editor's remote URI routing.
- Plain clicking keeps transcript selection and the Changes panel's existing diff navigation.
- Missing files, unsupported targets, missing IDEs and launch failures show an error.
- Opening a target performs no session mutation and uses argument arrays, never shell interpolation.

Native contract: `contract/open-target.ts`; `editor_open_target({ req })`.

The xterm shell view is outside this change. There is no IDE preference selector yet.

Validation: frontend target detection/modifier/API tests; Rust temporary-file resolution
and launch-argument tests; project frontend/Rust suites and quality checks.

## Remediation

- Resolved frontend HIGH: native transport rejections are caught and shown in both link and Changes handlers.
- Resolved frontend MEDIUM: automatic links preserve balanced delimiters, covered by a regression test.
- Resolved core MEDIUM: injected dispatch tests cover request/result shapes, browser routing,
  missing sessions/files/editors, successful file positions, and launch failures.
