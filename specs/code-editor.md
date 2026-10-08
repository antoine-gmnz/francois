---
id: code-editor
feature_id: code-editor
title: Code tab — a minimal Monaco editor with a file explorer
status: frozen
branch: feat/code-editor
created: 2026-10-08
depends_on: [app-shell, projects, session-engine, session-worktree, open-in-vscode, wsl-filesystem, webview-hardening, command-palette]
reviewed_base:
reviewed_digest:
design_files:            # Figma "Redesign · Graphite & Signal", page 124:2, row y=16740
  - https://www.figma.com/design/YEY4c6AiWq1bKYuaju9qdV?node-id=252-25850   # 45 · Code / Editor        (L45 252:34292)
  - https://www.figma.com/design/YEY4c6AiWq1bKYuaju9qdV?node-id=252-26351   # 46 · Code / No file open  (L46 252:34681)
  # components: App bar variant Active=Code 250:29123 · Icon/code 243:25661 · note 252:34819
---

# Code tab — a minimal Monaco editor with a file explorer

## 1. Summary

**Code** is a top-level app-bar tab beside GitHub. Opening it turns the window into a small,
real editor. The left sidebar stops being the session roster and becomes a VS Code-style file
explorer over one **root**, which is a project or a session's worktree. The main column is
**Monaco**, VS Code's own editor engine. This is v1 and deliberately minimal: open, edit, save,
and see what changed. Anything deeper goes to **Open in VS Code**.

A CodeMirror variant was built and parked on `wip/code-editor-codemirror` (commit `c21a3e6`). Its
**core is reused here** (§6) with one change: requests are keyed by a root, not by a session.

## 2. Goals & non-goals

- **Goals**
  - A Code tab with an explorer tree, file tabs, Monaco editing and save.
  - Git status in the tree, and change markers against `HEAD` in the editor gutter.
  - The agent and the user never silently clobber each other's edits (§FR-12).
  - App single-key shortcuts never fire while you type in the editor (§FR-14).
- **Non-goals (v1)**
  - Creating, renaming, deleting or moving files from the tree.
  - Search across files, an integrated terminal, extensions or a debugger.
  - LSP beyond what Monaco ships in-browser: TS/JS, JSON, CSS and HTML workers. Everything else
    is syntax highlighting only.
  - Split editors, a diff/compare view, settings UI or keymap choice.
  - Sending a selection to an agent. That can come back later, through the composer.

## 3. User stories / flows

1. **Open from a session.** Click **Code** in the app bar while `orbit-api` is selected. The
   explorer roots at that session's worktree, and the root picker reads `orbit-api ·
   feat/auth-retry`. With no session selected, the root is the active project, or failing that
   the first project.
2. **Switch root.** The root picker lists every project, then every open session that has a
   worktree. Picking one swaps the tree. Open tabs stay, grouped per root. Switching back
   restores that root's tabs.
3. **Browse.** Folders expand and collapse with a click or `→`/`←`. `⏎` or a click on a file opens
   it. Changed files show `M`/`A` in the status colours, and folders with changes show a dot.
4. **Edit + save.** Typing marks the tab with a dirty dot. `⌘S` saves, and `⌘W` closes the tab,
   asking Save · Discard · Cancel if it's dirty.
5. **Go to file.** `⌘P` opens a fuzzy file picker over the root's files.
6. **Agent edits the open file.**
   - Clean buffer: it reloads in place and keeps the cursor.
   - Dirty buffer: a bar reads "Changed on disk", offering **Reload** (discard mine) or **Keep
     mine** (the next save overwrites).
7. **Escape hatch.** **Open in VS Code** opens the detected editor at the current file and line.

## 4. Functional requirements

- **FR-1** The app bar gets a **Code** tab after GitHub (Figma App bar `Active=Code`). The command
  palette gets `Open Code tab` and `Go to file…`. Code has no single-key global shortcut.
- **FR-2** In the Code tab, the body is **Explorer (288px) + Editor**, with no session roster and
  no session panel. Leaving and re-entering the tab keeps the root, the open tabs, the dirty
  buffers, and each tab's cursor and scroll for the app's lifetime. None of this is persisted
  across restarts in v1.
- **FR-3** Root resolution goes through `EditorRoot` (§5). The core resolves `project` to the
  registered project root and `session` to the session's `cwd`, which is its worktree when it has
  one. The frontend never sends a raw filesystem path as a root.
- **FR-4** The tree is built in the frontend from `editor_files`: sorted, `/`-separated,
  `git ls-files --cached --others --exclude-standard`, capped at 20 000 entries. Directories
  are derived from the paths, so empty dirs are not shown. When the list is truncated, a footer
  note says so. Directories come before files, and each group is sorted case-insensitively.
- **FR-5** Git status: `editor_files` also returns `changes` (porcelain status per changed path:
  `M` modified, `A` added or untracked) and the current `branch`. A folder shows an info-coloured
  dot when any descendant has changed. The tree refreshes:
  - when the Code tab gains focus,
  - when the window regains focus,
  - after a save,
  - when the explorer's refresh button is clicked.
- **FR-6** Tabs: at most 12 open per root. Opening the 13th evicts the least recently used clean
  tab, and if every tab is dirty the open is refused with a hint. Each tab is one Monaco model
  with its own undo stack. Clicking a file that is already open focuses its tab.
- **FR-7** Editor: Monaco from the npm `monaco-editor` package, **bundled locally and lazily loaded**
  as its own chunk, with no CDN. The worker set is editor, ts, json, css and html. Minimap is on.
  The language comes from the file extension. Font is Geist Mono 13/20. The theme is generated
  from the Graphite CSS tokens at runtime with `monaco.editor.defineTheme` and re-applied
  whenever `data-theme` flips.
- **FR-8** Size, binary and encoding rules match the parked core: over 2 MiB opens read-only,
  over 10 MiB or binary is refused with an Open in VS Code hand-off, and CRLF, BOM and the
  trailing newline are preserved. The frontend sends LF text, and the core re-applies the line
  ending and BOM.
- **FR-9** Change markers: a 3px gutter decoration per line against `headText`, blue for
  modified, green for added and a red notch for deleted. They are recomputed on edit, debounced
  to 200 ms. Untracked files have no markers.
- **FR-10** The status bar (26px) shows:
  - left: the branch, then `Unsaved · ⌘S` or `Saved`;
  - right: `Ln, Col`, the indent (`Spaces: n` or `Tabs`), `UTF-8`, `LF`/`CRLF`, and the language
    name.
- **FR-11** Save (`⌘S`) is atomic and version-checked. `EDITOR_STALE` shows the FR-12 bar
  instead of overwriting.
- **FR-12** The core watches open files and emits `editor.changed` / `editor.deleted`:
  - Changed, clean buffer: reload in place, keeping the cursor and scroll.
  - Changed, dirty buffer: the "Changed on disk" bar with **Reload** and **Keep mine**. Keep mine
    rebases the buffer's version onto the version on disk.
  - Deleted: the tab name is struck through and a hint reads "Deleted on disk — ⌘S recreates it".
- **FR-13** Quitting the app or closing the window with any dirty buffer asks **Save all ·
  Discard · Cancel**. If no close-request hook exists, add one via Tauri `onCloseRequested`.
- **FR-14** While the Code tab is active, app-level **single-key** shortcuts are suppressed.
  These are the letters, digits, `[`/`]` and `?`. This holds whenever focus is anywhere inside
  the Code view: the editor, the tree or the picker. Modifier chords (`⌘K`, `⌘P`, `⌘S`, `⌘W`)
  still work. The shortcut guard also treats `contenteditable` elements as typing targets.
  *Regression this prevents:* typing `o` in the editor jumped to Overview.
- **FR-15** **Open in VS Code** calls `session_open_in_editor` with `file`/`line`, as the
  open-in-vscode FR-15 delta in §5 describes. For a `project` root, a new
  `editor_openExternal { root, file, line }` launches the editor. The button is hidden when no
  editor is detected.
- **FR-16** CSP: add `worker-src 'self' blob:` to both `csp` and `devCsp` in `tauri.conf.json`,
  because Monaco's workers need it. Nothing else changes. No `unsafe-eval` and no remote origins
  are added.

## 5. API contract

`contract/code-editor.ts`. The domain is `editor`; add it to PIPELINE.md §Domains.

```ts
import type { Result, SessionId } from './common';

export type ProjectId = string;
export type EditorRoot =
  | { kind: 'project'; projectId: ProjectId }
  | { kind: 'session'; sessionId: SessionId };

export type FileVersion = string;           // `${mtimeMs}:${size}:${sha256-16hex}`
export type LineEnding = 'lf' | 'crlf';
export type GitChange = 'M' | 'A';

export interface EditorFile {
  root: EditorRoot;
  path: string;              // root-relative, '/'-separated
  text: string;              // UTF-8, BOM stripped, LF-normalised
  version: FileVersion;
  lineEnding: LineEnding;
  bom: boolean;
  trailingNewline: boolean;
  readOnly: boolean;
  readOnlyReason?: 'too-large' | 'permission';
  headText: string | null;   // null: untracked / not a repo
}

// francois:editor:files -> invoke('editor_files', { root })
export interface EditorFilesData {
  rootLabel: string;                       // project name or session name
  branch: string | null;                   // null: not a repo / detached shows short sha
  paths: string[];                         // sorted, capped at 20 000
  truncated: boolean;
  changes: Record<string, GitChange>;      // only changed paths
}
// errors: PROJECT_NOT_FOUND | SESSION_NOT_FOUND | INTERNAL

// francois:editor:open  -> invoke('editor_open',  { root, path })                  -> Result<EditorFile>
//   idempotent (re-reads disk, one watch). errors: PROJECT_NOT_FOUND | SESSION_NOT_FOUND |
//   EDITOR_OUTSIDE_ROOT | EDITOR_FILE_NOT_FOUND | EDITOR_BINARY | EDITOR_TOO_LARGE | INTERNAL
// francois:editor:save  -> invoke('editor_save',  { root, path, text, baseVersion, lineEnding, bom })
//                                                                                    -> Result<{ version: FileVersion }>
//   errors: … | EDITOR_STALE (detail: { version }) | EDITOR_WRITE_FAILED
// francois:editor:close -> invoke('editor_close', { root, path })                  -> Result<null>
// francois:editor:openExternal -> invoke('editor_open_external', { root, editorId, file, line? }) -> Result<null>
//   errors: … | EDITOR_NOT_FOUND | EDITOR_LAUNCH_FAILED   (reuses open-in-vscode's launcher + WSL rules)

export type EditorEvent =
  | { type: 'editor.changed'; root: EditorRoot; path: string; version: FileVersion }
  | { type: 'editor.deleted'; root: EditorRoot; path: string };
// event stream: francois://editor/event
```

New `ErrorCode` members (in `common.ts`): `EDITOR_OUTSIDE_ROOT`, `EDITOR_FILE_NOT_FOUND`,
`EDITOR_BINARY`, `EDITOR_TOO_LARGE`, `EDITOR_STALE`, `EDITOR_WRITE_FAILED`. These are the same as on
the parked branch. Add `PROJECT_NOT_FOUND` only if it does not already exist.

## 6. Data & state

- **Core.** Port `src-tauri/src/editor/{files.rs,watch.rs,edit_tests.rs}` and the `mod.rs` command
  layer from `wip/code-editor-codemirror` (`git show c21a3e6:<path>`). Then:
  - Replace `sessionId` with `EditorRoot` resolution.
  - Key watches by the root (`project:<id>` / `session:<id>`).
  - Add `branch` and `changes` to `editor_files`, from `git status --porcelain=v1 -z` plus
    `git rev-parse --abbrev-ref HEAD`.
  - Add `editor_open_external`.
  - Drop a session root's watches when that session ends.
  - Keep its tests and adapt them.
- **Frontend.** The new feature lives in `src/features/code/`, with `code.css`, a zustand
  `codeStore` and Monaco models kept outside the store.
  - The store holds `root`, a `tabsByRootKey` map (each tab: `path`, `version`, `dirty`,
    `viewState`), `expandedByRootKey`, and the last `editor_files` result per root.
  - The CodeMirror frontend on the parked branch can donate its pure helpers: tab LRU, fuzzy
    ranking, the gutter line diff, and the event reducer. Its UI and CM code is not reused.

## 7. Edge cases & errors

| Case | Behaviour |
|---|---|
| Root project removed / session archived while open | Tabs for that root close; dirty ones are listed in a "Save all · Discard" prompt first |
| `editor_files` fails | Explorer shows the error inline with Retry; editor area keeps open tabs |
| Binary / too large file clicked | Toast-free inline row hint in the tree + Open in VS Code |
| `EDITOR_STALE` on save | FR-12 bar |
| WSL root | Paths via `wsl-filesystem` rules (already handled by the parked core) |
| Monaco chunk fails to load | Editor area shows "Editor failed to load" + Retry; tree still works |

## 8. Design brief

The design is Figma frames **45 · Code / Editor** and **46 · Code / No file open**, plus their
light twins L45 and L46. The frames are authoritative for layout. The token mapping:

- **Explorer.** `--bg-rail`, with a 1px `--line-subtle` rule on the right. Header (40px):
  `EXPLORER` in Geist Medium 11, letter-spacing 0.8, `--text-faint`, with three 26px icon
  buttons (new file stays disabled in v1, search opens Go to file, refresh).
- **Root picker.** 28px, `--bg-input`, radius 6. Folder icon, then the root label in Geist Medium
  12.5, then the branch icon and branch in Geist Mono 11 `--text-muted`, then a chevron.
- **Tree rows.** 26px, indented 14px per level, with a chevron and folder icon, or a file icon.
  Names are Geist Mono 12, coloured `--state-info` (M), `--state-success` (A) or
  `--text-secondary`. The selected row is `--bg-selected`. The status letter sits at the right
  in Geist Mono 11. The footer (33px, rule on top) reads `⌘P go to file`.
- **Tabs.** 36px strip on `--bg-rail`. The active tab is `--bg-terminal` with a 1.5px
  `--text-primary` top line. Each tab has a 1px rule on its right, and either a dirty dot (7px) or
  an `×` on hover. **Open in VS Code** is a ghost button at the right end.
- **Breadcrumb.** 26px, Geist Mono 11.5, `›` separators in `--text-faint`, and the last segment
  in `--text-primary`.
- **Monaco.**
  - Background `--bg-terminal`. Line numbers `--text-line-number`, and the active line number
    `--text-primary`.
  - The current line has a 1px `--bg-raised` box. Change markers use the colours in FR-9.
  - Syntax colours:
    - keywords `--hue-purple-soft`
    - strings `--hue-teal`
    - numbers `--hue-clay`
    - types and functions `--hue-blue`
    - comments `--text-faint`
    - punctuation `--text-muted`
  - The minimap's slider is `--bg-raised`.
- **Status bar.** 26px, `--bg-rail`, 1px rule on top, Geist Mono 11 `--text-faint`.
- **Empty state (46).** Centred: the `Icon/code` glyph at 48px, the root label, the line "Open a
  file from the explorer to edit it here.", and four keycap rows (⌘P · ⌘S · ⌘W · ⌘F).
- **"Changed on disk" bar** (not drawn). 40px, `--tint-attention` with a 1px
  `--tint-attention-line` bottom, the warn icon in `--state-attention`, and two Sm buttons:
  **Reload** (secondary) and **Keep mine** (primary).

## 9. Acceptance criteria

- [ ] Code tab in the app bar after GitHub; palette `Open Code tab` / `Go to file…` (FR-1)
- [ ] Explorer replaces roster; state survives leaving/re-entering the tab (FR-2)
- [ ] Root picker lists projects then session worktrees; default = selected session (FR-3, flow 1–2)
- [ ] Tree from `editor_files`, dirs first, git letters + folder dots, refresh triggers (FR-4, FR-5)
- [ ] 12-tab LRU per root; reopen focuses existing tab (FR-6)
- [ ] Monaco loads from the local bundle only, workers run under the CSP, theme flips with `data-theme` (FR-7, FR-16)
- [ ] 3 MiB read-only, 12 MiB / binary refused; CRLF+BOM round-trip byte-identical (FR-8)
- [ ] Gutter markers match `git diff HEAD` (FR-9); status bar fields correct (FR-10)
- [ ] Stale save never overwrites; agent edit on clean buffer reloads, on dirty shows the bar (FR-11, FR-12)
- [ ] Quit / window close with dirty buffers prompts (FR-13)
- [ ] Typing any letter, digit, `[`, `]`, `?` inside the Code view never triggers an app shortcut; ⌘K still opens the palette (FR-14) — unit test on the guard
- [ ] Open in VS Code lands on file:line for session and project roots (FR-15)

## Remediation
