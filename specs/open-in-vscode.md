---
id: open-in-vscode
title: Open in VS Code
status: shipped
created: 2026-08-04
depends_on: [session-engine, sessions-sidebar, session-worktree, wsl-filesystem]
reviewed_base: 9082b8522037c489d6d4d8613bbac7cd72afbe4d
reviewed_digest: 2936c5f5b6914015
---

# Open in VS Code

## 1. Summary

Francois knows exactly which directory a session works in — its main checkout, or the isolated
`git worktree` it was created with, on Windows, macOS, Linux, or inside a WSL distro. Today opening
that directory in an editor means copying the path out of the sidebar by hand, and for a WSL session
the copied path (`\\wsl$\Ubuntu\…`) is the wrong one to hand a Windows editor. This feature adds an
**Open in <editor>** item to the sidebar session's right-click menu: the core detects which VS Code
family editors are actually installed, and launches the one the user picks at the session's cwd —
translating to a `vscode-remote://wsl+<distro>/…` folder URI when that cwd lives inside WSL. One
rule, borrowed verbatim from `wsl-filesystem`: **the editor follows the filesystem, never the claude
runtime.**

## 2. Goals & non-goals

**Goals**

- One click from a session row to that session's directory open in an editor, correct for a plain
  project, a worktree session, and a WSL session alike.
- Detect what is installed rather than assume: VS Code, VS Code Insiders, Cursor, Windsurf.
- Zero configuration and zero new settings surface.
- Never mutate session, git, or persisted state — this feature only spawns a process.

**Non-goals**

- Opening a **file** at a line from the DIFF tab (`code -g <file>:<line>`). Deliberately deferred.
- A command-palette entry, a status-bar button, or a Projects-modal action — the sidebar context
  menu is the only entry point this cycle.
- An editor preference, a custom command template, or a settings field of any kind.
- Editors outside the VS Code family (JetBrains, Zed, vim, …).
- Verifying that the editor actually opened. Francois reports whether the **spawn** succeeded; what
  the editor does afterwards is the editor's business (§7).
- Installing or repairing an editor's `code`-on-PATH shim.

## 3. User stories / flows

**A — plain project.** The user right-clicks a session on `D:\acme-api`. The menu reads
`Open in VS Code` · `Open in Cursor` · `Rename session` · `Remove session` — because both editors
are installed. Clicking the first closes the menu; VS Code opens on `D:\acme-api`.

**B — worktree session.** The session was created with **Isolate in worktree**, so its cwd is
`D:\.francois-worktrees\acme-api\feat-auth`. The same click opens the editor **on the worktree**, not
on the main checkout — no extra affordance, no choice to make.

**C — WSL session.** The session cwd is `\\wsl$\Ubuntu\home\u\api`. The Windows editor is launched
with `--folder-uri vscode-remote://wsl+Ubuntu/home/u/api`, so it opens as a proper Remote-WSL window
rather than crawling the same directory over 9P.

**D — nothing installed.** No VS Code family editor is on the machine. The menu shows exactly what it
shows today — `Rename session`, `Remove session` — with no dimmed item and no explanation.

**E — launch fails.** The editor was uninstalled since the app started. The menu switches to its
existing error state showing the core's message; a click anywhere dismisses it.

## 4. Functional requirements

**Detection**

- **FR-1** `session:editorList` returns the detected editors in this fixed order, which is also the
  menu order: `vscode`, `vscode-insiders`, `cursor`, `windsurf`. It is **app-scoped** — no session
  id, no cwd — and a machine with none installed resolves `ok:true` with `editors: []`, never an
  error.
- **FR-2** An editor is detected by resolving its launcher basename (`code`, `code-insiders`,
  `cursor`, `windsurf`) against `PATH` — each `PATH` entry × each `PATHEXT` extension on Windows,
  the executable bit on unix — and, when `PATH` yields nothing, against a small per-OS fallback
  table of default install locations (`%LOCALAPPDATA%\Programs\…\bin\<name>.cmd` on Windows,
  `/Applications/<App>.app/Contents/Resources/app/bin/<name>` on macOS,
  `/usr/bin` · `/usr/local/bin` · `/snap/bin` on Linux). First hit wins per editor; `EditorInfo.path`
  carries that absolute path.
- **FR-3** The probe result is cached for the app run, **successes only**: a probe that found at
  least one editor is frozen, a probe that found none is re-run on the next call. Same policy as
  `wsl.rs`'s `WSL_UNC_ROOTS`, and for the same reason — a cold or unlucky probe must not degrade the
  whole app run.

**Target resolution — the editor follows the filesystem**

- **FR-4** The launch target is decided by `is_wsl_unc_path(session.cwd)` **alone**; the session's
  `ClaudeRuntime` is irrelevant (mirroring wsl-filesystem FR-5). A drive-letter cwd on a `wsl`-runtime
  session opens natively; a WSL UNC cwd on a `native`-runtime session opens as a remote URI.
- **FR-5** WSL UNC cwd → argv `[<editor.path>, "--folder-uri", "vscode-remote://wsl+<distro>/<path>"]`,
  where `(distro, path)` come from `wsl::wsl_unc_to_linux` and both are **percent-encoded** by a pure
  `wsl_folder_uri(distro, linux_path)`: unreserved characters (`A-Za-z0-9-._~`) pass through, `/`
  separators are preserved, every other byte becomes `%XX` over its UTF-8 encoding.
- **FR-6** Any other cwd → argv `[<editor.path>, <cwd>]`, verbatim, as a folder argument.
- **FR-7** A worktree session needs **no special handling**: `SessionMeta.cwd` already is the worktree
  path (session-worktree FR-12), so FR-6 opens the worktree and never the source repo. Pinned by a
  test so a future refactor cannot silently start resolving `worktree.sourceRepoRoot`.
- **FR-8** The spawn is an **argv array, never a shell string**, with `no_window`, null stdio, and is
  **not awaited** — the command resolves `ok` as soon as the process starts. On Windows the resolved
  launcher is typically `code.cmd`; `std::process::Command` runs `.cmd`/`.bat` through `cmd.exe`
  itself with the arguments correctly escaped (the CVE-2024-24576 fix), so the implementation must
  **not** hand-roll a `cmd /c` invocation — that would reopen the injection hole this closes.

**Menu**

- **FR-9** The session context menu's default state renders one `Open in <label>` item per detected
  editor, **above** `Rename session`. With zero detected editors the group is **absent** — never
  dimmed, never explained (session-worktree FR-1's convention). The confirm and error states of the
  remove flow are unchanged and offer no open item.
- **FR-10** The editor list is fetched when a menu opens and memoized in the frontend for the app
  run (one in-flight promise, shared). While it is unresolved the group is absent — no spinner and
  no skeleton in a two-item menu.
- **FR-11** Clicking an item calls `session:openInEditor` with that `editorId`. On success the menu
  closes. On failure the menu switches to its **existing** error state (`context-menu__error`)
  rendering `error.message` verbatim. The call is a spawn, so there is no spinner and no in-flight
  state.
- **FR-12** Opening an editor performs no session mutation, emits no event, and writes nothing to
  disk — it is observable only as a running process.
- **FR-13** *(added by `diff-review` FR-44.)* `OpenInEditorRequest` carries an optional
  `path?: string`, repo-relative. When present the editor opens **that file** rather than the session
  directory — it is what the DIFF tab's per-file `↗ editor` sends. Absent ⇒ today's behaviour
  exactly. The path is resolved against the session's `cwd` and follows the same filesystem rule as
  FR-4/5/6 (`is_wsl_unc_path(session.cwd)`), so a worktree and a WSL session need no special case.

## 5. API contract

Lives in `contract/open-in-vscode.ts`; the two `ErrorCode` members below go in `contract/common.ts`.
Binding per PIPELINE.md: `francois:session:<verb>` → `invoke('session_<verb>')` → `Promise<Result<T>>`.
**No new `SessionEvent` member.**

**Added to `contract/common.ts`**

```ts
// ErrorCode gains:
//   | 'EDITOR_NOT_FOUND'      // open-in-vscode: the requested editorId is not installed (detail: { editorId })
//   | 'EDITOR_LAUNCH_FAILED'  // open-in-vscode: the launcher could not be spawned (detail: { path })
```

**`contract/open-in-vscode.ts`**

```ts
import type { SessionId } from './common';

/** The VS Code family editors Francois can detect and launch (open-in-vscode FR-1). */
export type EditorId = 'vscode' | 'vscode-insiders' | 'cursor' | 'windsurf';

export interface EditorInfo {
  id: EditorId;
  label: string; // 'VS Code' | 'VS Code Insiders' | 'Cursor' | 'Windsurf'
  path: string;  // absolute path of the resolved launcher (FR-2); shown only in the item's title
}

export interface EditorListData {
  editors: EditorInfo[]; // FR-1 probe order == menu order; [] = none installed, NOT an error
}
// invoke('session_editor_list'): Promise<Result<EditorListData>>
// no request payload — app-scoped.
// errors: 'INTERNAL' only.

export interface OpenInEditorRequest {
  sessionId: SessionId;
  editorId: EditorId;
}
// invoke('session_open_in_editor', req): Promise<Result<null>>
// errors: 'SESSION_NOT_FOUND' | 'EDITOR_NOT_FOUND' | 'EDITOR_LAUNCH_FAILED' | 'INTERNAL'

// ---------- pure frontend helper (owned here, unit-tested) ----------

/** FR-9 item copy: `Open in VS Code`, `Open in Cursor`, … */
export function editorMenuLabel(editor: EditorInfo): string;

/** FR-1 order + the id→label table, so core and frontend cannot drift. */
export const EDITOR_LABELS: Record<EditorId, string>;
export const EDITOR_ORDER: readonly EditorId[];
```

**Rust internals (not wire surface, pinned for the implementer)**

- New module `src-tauri/src/editor/`: `mod.rs` (the `EditorId`/`EditorInfo` model, the FR-3 cache,
  both `#[tauri::command]`s, registered in `main.rs`'s `generate_handler!`), `detect.rs` (FR-2 PATH
  scan + fallback table), `tests.rs`.
- `detect::candidate_paths(dirs: &[String], exts: &[&str], name: &str) -> Vec<PathBuf>` — pure, the
  tested half of FR-2; existence checking is the impure caller's job.
- `wsl_folder_uri(distro: &str, linux_path: &str) -> String` — pure, FR-5.
- `launch_argv(editor_path: &str, cwd: &str) -> Vec<String>` — pure, FR-4/5/6 in one place; the
  cargo test table covers a drive path, a UNC path, a path with spaces and non-ASCII, and a worktree
  path (FR-7).

## 6. Data & state

- **Core**: one `OnceLock<Mutex<Option<Vec<EditorInfo>>>>` holding the FR-3 detection cache. No
  persistence, no per-session state, no engine mutation.
- **Frontend**: one module-scoped memoized promise in `src/features/sessions/editors.ts` backing
  FR-10. `MenuState` gains nothing — failures reuse the existing `error` field. Nothing in
  `localStorage`, nothing in a zustand store.

## 7. Edge cases & errors

| Case | Behavior |
|---|---|
| No editor installed | `editors: []`; the menu group is absent (FR-9). Not an error. |
| Editor installed but no shim on `PATH` | FR-2's fallback table usually still finds it. If not, it is invisible — the accepted cost of the "absent, never explained" choice. |
| Editor installed **while** Francois runs | Picked up on the next menu open only if the earlier probe found nothing (FR-3). Otherwise a restart is needed. Accepted. |
| Editor uninstalled while Francois runs | The stale item stays listed; clicking it returns `EDITOR_NOT_FOUND` or `EDITOR_LAUNCH_FAILED`, shown in the menu's error state (FR-11). |
| Session cwd no longer exists | Spawn still succeeds; the editor opens an empty window on a missing folder. Francois does not pre-check — a stat on a WSL UNC path can block for seconds on a cold distro. |
| WSL distro stopped | The spawn returns immediately; the editor's Remote-WSL extension boots the distro itself. Latency is the editor's, not ours. |
| Editor lacks `vscode-remote://wsl+` support (a fork with its own remote scheme) | The editor surfaces its own error; Francois cannot intercept it, having already resolved `ok` (FR-8). Documented, not solved. |
| Path with spaces, `#`, `%`, or non-ASCII | Native: argv array carries it intact. Remote: FR-5 percent-encoding carries it intact. Both pinned by table tests. |
| `\\wsl.localhost\…` vs `\\wsl$\…` | Both recognized — FR-4 delegates to the existing `is_wsl_unc_path` / `wsl_unc_to_linux` (wsl-filesystem FR-1/2). |
| Plain UNC share (`\\server\share\repo`) | Not WSL, so FR-6: handed to the editor verbatim. |
| Non-Windows build | `is_wsl_unc_path` never matches, so FR-4 always takes the native branch; no cfg-gating beyond the FR-2 fallback table. |
| Double-click / rapid repeat clicks | Each click is one spawn; the editor itself focuses the already-open window. No debounce. |

## 8. Design brief

> full brief: `specs/design/open-in-vscode.md`

One surface, inside existing chrome: the sidebar session row's `.context-menu`. Its default state
gains one `Open in <label>` item per detected editor, above `Rename session`, in the same
`.context-menu__item` treatment (13px, same padding, same hover) with no glyph and no divider — the
non-destructive actions read first, the destructive one stays last. Zero detected editors ⇒ the group
is absent, and the menu is byte-identical to today's. The confirm and error states of the remove flow
are untouched; a failed launch reuses the existing `.context-menu__error` line.

## 9. Acceptance criteria

- [x] `session_editor_list` returns installed VS Code family editors in FR-1 order and `[]` (with
      `ok:true`) on a machine with none. (FR-1, FR-2)
- [x] The context menu shows one `Open in <label>` item per detected editor, above `Rename session`,
      and shows none at all when the list is empty. (FR-9)
- [ ] Clicking an item on a plain project opens that directory in that editor. (FR-6, FR-11)
- [x] A worktree session opens the **worktree** path, not the source repo — asserted by a core test
      over `launch_argv`. (FR-7)
- [ ] A session on `\\wsl$\<distro>\…` launches with
      `--folder-uri vscode-remote://wsl+<distro>/<path>` and opens a Remote-WSL window. (FR-4, FR-5)
- [x] A drive-letter cwd on a `wsl`-runtime session opens **natively**, and a WSL UNC cwd on a
      `native`-runtime session opens **remotely** — routing never reads the runtime. (FR-4)
- [x] Paths containing spaces and non-ASCII characters survive both branches, per the `launch_argv`
      and `wsl_folder_uri` test tables. (FR-5, FR-8)
- [ ] An uninstalled-since-startup editor surfaces `EDITOR_LAUNCH_FAILED` in the menu's existing
      error line, and the menu stays usable. (FR-11)
- [x] Opening an editor writes nothing to `sessions.json`, emits no `SessionEvent`, and leaves the
      session's status untouched. (FR-12)
- [x] No `cmd /c` string interpolation anywhere in the diff; every spawn is an argv array. (FR-8)

> Left open — these three are **runtime** flows that only `/smoke` verifies, and no `/smoke` ran this
> cycle: "Clicking an item on a plain project opens that directory" (FR-6/FR-11), "a `\\wsl$` session
> opens a Remote-WSL window" (FR-4/FR-5 — the argv/URI half *is* pinned by core tests; the window
> actually opening is not), and "an uninstalled-since-startup editor surfaces `EDITOR_LAUNCH_FAILED`
> in the menu and the menu stays usable" (FR-11).

## Remediation

(Empty until a review returns findings.)
