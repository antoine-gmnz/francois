---
id: code-editor-workspace
feature_id: code-editor-workspace
title: Code editor, workspace — split, problems, IntelliSense polish, find, quick open, search in files
status: frozen
branch: feat/code-editor-improvement
created: 2026-10-09
depends_on: [code-editor, code-editor-agents]
design_files:
  - https://www.figma.com/design/YEY4c6AiWq1bKYuaju9qdV/?node-id=259-28018   # 52 · Code / Workspace — split, problems, LSP
  - https://www.figma.com/design/YEY4c6AiWq1bKYuaju9qdV/?node-id=262-28312   # 53 · IntelliSense — completion, details, inline blame
  - https://www.figma.com/design/YEY4c6AiWq1bKYuaju9qdV/?node-id=262-29263   # 54 · Diagnostics — squiggles, hover, quick fix
  - https://www.figma.com/design/YEY4c6AiWq1bKYuaju9qdV/?node-id=264-28848   # 55 · Find & replace
  - https://www.figma.com/design/YEY4c6AiWq1bKYuaju9qdV/?node-id=264-29845   # 56 · Quick open ⌘P
  - https://www.figma.com/design/YEY4c6AiWq1bKYuaju9qdV/?node-id=264-30862   # 57 · Search in files ⌘⇧F
  - https://www.figma.com/design/YEY4c6AiWq1bKYuaju9qdV/?node-id=259-28876   # L52
  - https://www.figma.com/design/YEY4c6AiWq1bKYuaju9qdV/?node-id=262-28842   # L53
  - https://www.figma.com/design/YEY4c6AiWq1bKYuaju9qdV/?node-id=262-29800   # L54
  - https://www.figma.com/design/YEY4c6AiWq1bKYuaju9qdV/?node-id=264-29410   # L55
  - https://www.figma.com/design/YEY4c6AiWq1bKYuaju9qdV/?node-id=264-30409   # L56
  - https://www.figma.com/design/YEY4c6AiWq1bKYuaju9qdV/?node-id=264-31461   # L57
---

# Code editor, workspace

## 1. Summary

Lifts three v1 non-goals of `specs/code-editor.md` — search across files, split editors, and
the bare problem surface — and brings Monaco's built-in language features (completion, hover,
quick fix, find) into the Graphite & Signal identity. Language intelligence stays what Monaco
ships in-browser (TS/JS, JSON, CSS, HTML workers): **no external language server**.

## 2. Goals & non-goals

- **Goals**: activity bar · split editor · problems panel · language status · symbol breadcrumb ·
  inline blame · styled completion/hover/quick-fix/find widgets · "send problem to session" quick
  fix · in-editor quick open with go-to-line and symbols · search & replace in files.
- **Non-goals**: an external LSP / `tsserver` process; cross-file type resolution beyond the open
  models; OUTPUT and TERMINAL panel tabs (the SHELL tab owns terminals); more than two editor
  groups; staging/committing from the Code tab (the DIFF tab owns it); `#` workspace symbols.

## 4. Functional requirements

### Frame 52 — workspace

- **FR-1 Activity bar.** A 44px column left of the sidebar (Figma 52): Explorer, Search (⌘⇧F),
  Source control (badge = number of changed paths; click shows the SOURCE CONTROL sidebar: branch,
  then CHANGES — modified before added, each with its M/A letter; a modified file opens in Review
  against HEAD, an added one opens plainly; committing stays in the DIFF tab), Problems (badge = error+warning count across open models; click toggles the
  problems panel), and Settings pinned to the foot (opens the app Settings). The selected view
  carries `--bg-selected`. Explorer/Search swap the 288px sidebar content; clicking the selected one
  again collapses the sidebar.
- **FR-2 Split editor.** A split button (columns icon) in each group's tab strip opens the active
  file in a second group to the right (⌘\ too). At most two groups. Each group has its own tab
  strip, active tab, breadcrumb and Monaco instance; the same file open in both groups shares one
  model (one buffer, one dirty state, one undo stack). Closing a group's last tab removes the group.
  The focused group is the target of ⌘S/⌘W/⌘P and of quick open. When split, the per-group
  "Open in VS Code" collapses to an icon button (Figma 52); unsplit it keeps the labelled bordered
  button (Figma 53).
- **FR-3 Problems panel.** A bottom panel, resizable is not required (fixed ~210px), toggled with
  ⌘⇧M, the activity-bar Problems icon, or the status-bar counts. Header: `PROBLEMS <count>` tab,
  a "Filter problems…" input (substring over message/path), maximise and close. Body: one group per
  file (chevron, file icon, name, dim dir, count), one row per marker (severity icon, message,
  dim `ts(<code>)` and `[Ln l, Col c]`). Click a row → open that file in the focused group and put
  the caret on the marker. Source: Monaco markers (`monaco.editor.getModelMarkers`), live via
  `onDidChangeMarkers`, for every model the Code tab created. Errors and warnings only, plus
  info/hint rows shown with the info glyph.
- **FR-4 Status bar.** Left: branch · save state · `⚠ <warnings+errors> ⓘ <info>` counts (click
  toggles the panel). Right, before Ln/Col: for TS/JS files a language-service pill
  `● TypeScript <version> · ready` (green dot; `· loading` with a dim dot until the worker answers
  once). Version from Monaco's bundled TypeScript.
- **FR-5 Symbol breadcrumb.** The breadcrumb appends the innermost enclosing symbol at the caret
  (`… › callback.ts › handleCallback`), from Monaco's document symbols for languages that have a
  provider (TS/JS, JSON, CSS, HTML); recomputed ≤ 300 ms after a caret move or edit.

### Frame 53 — IntelliSense

- **FR-6 Completion.** Monaco's suggest widget, details pane open by default
  (`suggest.showStatusBar`, details expanded), styled per Figma 53: `--bg-raised` surface,
  `--line-subtle` border, 8px radius, Geist Mono 13px rows, selected row `--bg-selected`, matched
  characters in `--text-primary` weight 600, type column dim right-aligned, details pane in Geist
  with the signature in Geist Mono, status bar hint `⏎ / ⇥ accept · ^Space toggle details`.
- **FR-7 Inline blame.** After the caret line's content, dim `Author, <relative time> · <summary>`
  (Figma 53), from `editor_blame`, fetched ≤ 400 ms after the caret settles on a line, cached per
  (path, version, line). Hidden while the buffer is dirty on that line, for untracked files, and
  when the call returns null. Toggle in the palette: "Code: Toggle inline blame" (default on).

### Frame 54 — diagnostics

- **FR-8 Squiggles & hover.** Monaco's error/warning squiggles and hover widget, styled per
  Figma 54: problem line (severity glyph + message + `ts(code)`), then the type signature in a
  `--bg-input` band, then the quick fixes, then the footer links — all inside one `--bg-raised`
  card. Gutter lightbulb drawn as the sparkle glyph in `--text-secondary`.
- **FR-9 Send problem to session.** Every marker contributes one extra code action
  `Send to <target> with this problem` (target label as code-editor-agents FR-5) bound to ⌘L
  when the caret is on a marker and nothing is selected. It hands the session a selection chip of
  the marker's line(s) whose note is the marker message + `ts(code)`, through the existing
  `useChipSender` path (same picker, same "Added" pill).

### Frame 55 — find & replace

- **FR-10** Monaco's find widget (⌘F, ⌥⌘F replace), styled per Figma 55: `--bg-raised`, 8px radius,
  inputs `--bg-input`, toggles Aa / ab / .* and preserve-case AB, `2 of 5` counter, ↑ ↓ ✕; the
  current match outlined in `--state-info`, others filled with a muted wash. No new behaviour.

### Frame 56 — quick open

- **FR-11** ⌘P replaces the Go-to-file modal with a 600px palette dropping from the top of the
  editor area (Figma 56), the rest of the editor dimmed. Input with search glyph and a right
  `in <rootLabel>` scope label. Empty query: RECENTLY OPENED (recent files) then FILES; typed query:
  RECENTLY OPENED (recent files that match) then FILES (the rest, fuzzy-ranked). Rows: file icon,
  name with the fuzzy hits in `--text-primary`, dim directory; the selected row `--bg-selected`.
  Footer hints: `⏎ open · ⌘⏎ open to the side · :42 go to line · @ symbol`.
  - `⏎` opens in the focused group; `⌘⏎` opens in the other group (creating the split).
  - `:N[:C]` → "Go to line N" row; ⏎ moves the caret in the active file.
  - `@query` → the active file's document symbols, fuzzy-filtered; ⏎ reveals the symbol.

### Frame 57 — search in files

- **FR-12** ⌘⇧F (or the activity-bar Search) shows the SEARCH sidebar (Figma 57): query input
  with Aa / ab / .* toggles, replace input with AB (preserve case) and a Replace All button
  (enabled when there are results), "files to include" input, `N results in M files` summary,
  then results grouped by file (chevron, file icon, name, dim dir, count pill), one row per match
  with the preview and the match bold. Search runs 300 ms after the last keystroke; a newer query
  cancels the older one's rendering (stale responses are dropped). Click a match → open the file in
  the focused group, caret on the match, match selected. `truncated` shows "Showing the first
  results — refine the search." An invalid regex shows the error message under the input.
- **FR-13** Replace All asks once ("Replace N matches in M files?") then calls `editor_replace`
  with every result file that has no dirty buffer (open clean tabs send their `version`). Files
  with dirty buffers are skipped and named in a notice. Afterwards the search re-runs.
- **FR-14** Core: `editor_search` walks the same path list as `editor_files`, skips binary and
  over-cap files, matches per line with the `regex` crate (literal queries escaped; whole-word via
  `\b…\b`; case-insensitive via `(?i)`), and stops at the caps in the contract. Include globs are
  matched by a small in-crate glob matcher (`*`, `**`, `?`, comma-separated, bare folder =
  `folder/**`). Runs off the async runtime (`spawn_blocking`).
- **FR-15** Core: `editor_replace` re-reads each target, checks `baseVersion` when given, replaces
  every match (preserve-case per contract), and writes with editor_save's atomic writer, keeping
  line ending, BOM and trailing newline. Its own writes are not suppressed from the watcher — open
  clean tabs reload through `editor.changed`.
- **FR-16** Core: `editor_blame` per contract.

## 5. Contract

`contract/code-editor-workspace.ts`.

## 7. Edge cases

- Split with a dirty file in both groups: one dirty dot per tab strip, one save.
- Closing a dirty tab that is also open in the other group closes only that group's tab, no prompt.
- Problems from models whose tab was closed disappear (the model is disposed).
- Search on a non-repo root uses the `.gitignore`-honouring walk, like `editor_files`.
