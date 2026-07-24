---
id: wsl-filesystem
title: WSL filesystem integration — git, shells & paths for WSL sessions
status: shipped
created: 2026-07-21
depends_on: [session-engine, diff-view, shell-terminal, sessions-sidebar, app-shell]
---

# WSL filesystem integration

## 1. Summary

The `wsl` claude runtime shipped in `session-engine` (v0.2.1+): a session can run
`claude` inside WSL via `wsl.exe --cd <cwd> -- claude …`. But everything *around*
the model is still Windows-native: the DIFF tab drives **Windows git**, the SHELL
tab is **one global Windows PowerShell in the home directory**, and a repo living
inside the WSL filesystem (`\\wsl$\<distro>\…`) is at best slow (9P) and at worst
broken (no file-change notifications, git ownership warnings).

This feature makes Francois genuinely usable for WSL-based users, under one
engineering rule pinned here:

> **Git follows the filesystem. The shell and claude follow the runtime.**

- **Git**: a session whose cwd is a WSL UNC path (`\\wsl$\…` / `\\wsl.localhost\…`)
  gets **WSL git** (`wsl.exe --cd <linux-path> -- git …`); a drive-letter cwd keeps
  **Windows git** — regardless of the claude runtime. Crossing 9P in either
  direction is the slow path; this rule never crosses it for git.
- **Shell**: the SHELL tab becomes **per-session**. A `wsl`-runtime session gets the
  distro's default shell in the session cwd; a `native` session gets
  pwsh/PowerShell in the session cwd (today's global home-dir shell is replaced).
- **Paths**: one vocabulary for WSL UNC detection/translation, shared by core
  (Rust) and frontend (`contract/wsl-filesystem.ts`): `\\wsl$\Ubuntu\home\u\api`
  ⇄ `/home/u/api`, displayed compactly as `Ubuntu:/home/u/api`.

Scope decisions (frozen with the human): per-session shells **included**; DIFF
liveness for WSL-fs repos is **event-driven only** (no watcher, no polling);
directory↔runtime mismatch gets a **hint + auto-suggest** (never a block);
**default distro only** (`wsl.exe` bare, no distro picker).

## 2. Goals & non-goals

- **Goals**:
  - DIFF tab (summary, per-file diff, stage, commit) works correctly and fast for
    repos inside the WSL filesystem, by running git *inside* WSL for those repos.
  - SHELL tab becomes per-session: right shell (runtime-driven), right directory
    (session cwd), per-session scrollback; empty state when no session is active.
  - One pure, tested path vocabulary: detect WSL UNC paths, translate UNC⇄Linux,
    render the compact `<distro>:/path` display form.
  - New-session modal: picking a `\\wsl$…` directory auto-selects the `wsl`
    runtime (still editable) with a one-line explanation; the reverse mismatch
    (native runtime + WSL path) warns but never blocks.
  - Honest liveness: WSL-fs repos get no fs-watcher (9P notifications are
    unreliable); freshness comes from tool.done recomputes, DIFF tab activation,
    and stage/commit — each already a full recompute.
  - All of it with **no new IPC channel, event member, or ErrorCode** (§5).
- **Non-goals**:
  - A distro picker (`wsl` = the default distro; multi-distro is future).
  - Polling watchers for WSL-fs repos (revisit only if event-driven proves
    insufficient in practice).
  - Running git in-process (libgit) or over SSH/remotes.
  - Any behavior change for native-runtime sessions on drive-letter paths — the
    entire existing matrix stays byte-identical for them.
  - CRLF/line-ending policy management, `.gitattributes` advice, credential setup
    inside the distro (surfaced as ordinary git errors if wrong).
  - Persisting shell scrollback across app restarts (rings stay in-memory, as
    shell-terminal specifies).

## 3. User stories / flows

**A — WSL repo, end to end.** A user keeps `~/projects/api` inside Ubuntu. They
create a session, browse to `\\wsl$\Ubuntu\home\u\projects\api` — the modal flips
the runtime to `wsl` with a hint ("WSL directory — claude will run inside your
default distro"). The card shows `Ubuntu:/home/u/projects/api`. Claude edits
files; the DIFF badge updates on every edit (tool.done). Opening DIFF lists files
via WSL git in well under a second; staging and committing use the distro's git
identity. The SHELL tab is bash (their default shell) already in
`/home/u/projects/api`.

**B — Windows repo, wsl runtime.** A session on `D:\acme-api` runs claude in WSL
(the user's claude lives there). Git stays Windows git — DIFF is exactly as fast
as a native session; the shell is the distro shell in `/mnt/d/acme-api`. Nothing
about diff behavior changed for this session.

**C — Mismatch warning.** The user picks `\\wsl$\Ubuntu\home\u\api` but flips the
runtime back to `native`. The modal keeps a visible warning: "Windows tools will
access this directory over 9P — expect slow git and no live diff updates." They
can create anyway; nothing blocks.

**D — Per-session shells.** Two sessions: `api` (wsl, `\\wsl$\…`) and `infra`
(native, `D:\infra`). Switching the sidebar selection while the SHELL tab is open
swaps between the bash PTY (scrollback intact) and the PowerShell PTY (scrollback
intact). Removing `api` kills its PTY. With no sessions, the SHELL tab shows
"select a session to open its shell".

## 4. Functional requirements

**Path vocabulary (shared, pure)**

- **FR-1 (detection).** `isWslUncPath(p)` recognizes `\\wsl$\<distro>\…` and
  `\\wsl.localhost\<distro>\…` (case-insensitive prefixes, both slash styles
  tolerated on input). Everything else — including `/mnt/...`-style strings and
  drive letters — is false. Mirrored in Rust as `is_wsl_unc_path`.
- **FR-2 (translation).** `wslUncToLinux(p)` → `{ distro, path }`:
  `\\wsl$\Ubuntu\home\u\api` → `{ distro: 'Ubuntu', path: '/home/u/api' }`
  (backslashes flipped, prefix stripped, root `\\wsl$\Ubuntu` → `/`). Returns
  null for non-WSL paths. Rust mirror `wsl_unc_to_linux`. The reverse
  (`linux → UNC`) exists only in Rust and uses FR-3's discovered UNC root.
- **FR-3 (UNC root discovery, Rust).** The core resolves the default distro's UNC
  root **once per app run** via `wsl.exe -- wslpath -w /` (output like
  `\\wsl.localhost\Ubuntu\`), cached in a `OnceLock`. This deliberately avoids
  parsing `wsl.exe -l -q` (UTF-16LE output trap). On failure the cache holds
  `None` and WSL-dependent operations surface their ordinary errors (§7).
- **FR-4 (display form).** `displayWslCwd(p)` renders a WSL UNC path as
  `<distro>:<linuxPath>` (e.g. `Ubuntu:/home/u/api`); non-WSL paths return null
  (caller falls back to the existing `~`-abbreviation). Consumed by the sidebar
  card cwd line, the App title/meta, and the shell footer. Pure, vitest-tested.

**Git under the filesystem rule (diff domain)**

- **FR-5 (routing).** Every git operation in the diff domain routes on
  `is_wsl_unc_path(cwd)` alone (the claude runtime is irrelevant):
  - WSL UNC cwd → `wsl.exe --cd <linux-dir> -- git <args…>` (linux-dir via FR-2).
  - Otherwise → `git <args…>` with `current_dir(cwd)` (unchanged).
  The existing `git()` runner grows a routing wrapper; argv arrays, no shell
  strings (diff-view FR-13 unchanged).
- **FR-6 (repo root & base).** For WSL repos, `rev-parse --show-toplevel` returns
  a **Linux** root; `REPO_CACHE` stores it verbatim (keyed by the session cwd as
  today) and all subsequent targeted ops run `wsl.exe --cd <linux-root> -- git …`.
  Parsers are unchanged — porcelain/numstat already emit repo-relative
  forward-slash paths.
- **FR-7 (untracked counts).** For WSL repos, `untracked_counts` translates
  `<linux-root>/<path>` to `<uncRoot><path>` (FR-3) and keeps counting lines
  **in-process** over the UNC file — no per-file git spawns (preserving the
  round-3 perf fix).
- **FR-8 (no watcher over 9P).** `watch_session` is a **no-op** when
  `is_wsl_unc_path(cwd)`: 9P does not deliver reliable change notifications, and
  a dead watcher must not pretend otherwise. Freshness for those sessions:
  - every Edit/Write `tool.done` recompute (unchanged, covers claude's edits),
  - DIFF tab activation (the view remounts per tab switch and re-hydrates —
    pinned here as load-bearing behavior),
  - post-stage/post-commit refreshes (unchanged).
  Drive-letter repos keep the recursive watcher regardless of runtime.
- **FR-9 (stage/commit).** `stage_all`/`commit` follow FR-5 routing; commit
  identity/hooks are the **distro's** git config for WSL repos (documented, not
  managed). Error text passes through as GIT_ERROR exactly as today.

**Per-session shells (runtime rule)**

- **FR-10 (per-session PTY).** The SHELL tab shows the **active session's** shell.
  `shell_ensure(sessionId)` resolves the session's `(cwd, runtime)` from the
  engine (SESSION_NOT_FOUND if absent — replaces today's home-dir fallback); the
  Registry stays keyed by session id (already true). The global
  `DEFAULT_SESSION_ID` shell is removed.
- **FR-11 (spawn matrix).**
  - `native` runtime → existing `resolve_shell()` (pwsh/PowerShell/zsh/bash per
    platform), `current_dir = cwd`. A WSL UNC cwd is legal here (pwsh supports
    UNC cwd) — it's the user's explicit mismatch choice (story C).
  - `wsl` runtime → `wsl.exe --cd <dir>` launching the distro's default shell,
    where `<dir>` is the FR-2 Linux translation for WSL UNC cwds and the Windows
    path verbatim for drive-letter cwds (wsl.exe maps it to `/mnt/…`).
  - Both spawns keep the PTY plumbing (portable-pty), ring buffer, and event
    contract byte-identical.
- **FR-12 (shell identity).** `EnsureData.shellName` reports the distro name for
  wsl shells (from FR-3's UNC root, e.g. `Ubuntu`) and the existing basename for
  native shells. The footer renders `● <shellName> · <cwd display>` using FR-4.
- **FR-13 (lifecycle).** First SHELL view of a session ensures its PTY lazily;
  switching sessions swaps terminals with scrollback replay (existing ring
  semantics); `session_remove` disposes that session's shell (kill + drop —
  wired from the remove path); app exit kills all (unchanged). Shell exit shows
  the existing exit banner; re-ensure restarts it.
- **FR-14 (environment).** Interactive tools inside a wsl shell must see a sane
  terminal (`TERM=xterm-256color` effective; colors/cursor keys work). The
  implementation may rely on ConPTY defaults or forward via `WSLENV` — the
  acceptance test is behavioral, not mechanism-pinned.
- **FR-15 (empty state).** No active session → SHELL tab renders
  `select a session to open its shell` (same styling as the SESSION tab's empty
  state); no PTY is spawned.

**New-session modal**

- **FR-16 (auto-suggest).** When the picked directory satisfies `isWslUncPath`,
  the modal sets runtime = `wsl` (only if the user hasn't explicitly touched the
  runtime chips this open) and shows: `WSL directory — claude will run inside
  your default distro`. Editable as ever.
- **FR-17 (mismatch warning).** If runtime is `native` while the directory is a
  WSL UNC path, show the persistent hint: `Windows tools will access this
  directory over 9P — expect slow git and no live diff updates`. Creation is
  never blocked (INVALID_INPUT is NOT added for this).
- **FR-18 (non-Windows).** All of FR-16/17 and the runtime row remain
  Windows-only UI; behavior elsewhere unchanged.

## 5. API contract

**No new IPC command, no new event member, no new ErrorCode.** The feature
changes *behavior* behind existing channels and adds one frontend-shared pure
vocabulary file.

### Channels consumed/affected (all pre-existing)

| Channel | Binding | Behavioral delta here |
|---|---|---|
| `francois:session:create` | `session_create` | none in shape; FR-16/17 are modal-side |
| `francois:diff:getSummary` / `getFileDiff` / `stageAll` / `commit` | `diff_*` | FR-5 routing: WSL-fs repos execute via `wsl.exe -- git` |
| `francois:diff:event` | `francois://diff/event` | unchanged shape; emission for WSL-fs repos driven by tool.done/stage/commit only (FR-8) |
| `francois:shell:ensure` / `write` / `resize` / `dispose` | `shell_*` | FR-10–15: per-session semantics; `EnsureData` **shape unchanged** (`shellName` now carries the distro name for wsl shells); SESSION_NOT_FOUND (existing code) for unknown ids |
| `francois://shell/event` | event | unchanged (`shell.data` / `shell.exit`, per session id) |

### `contract/wsl-filesystem.ts` (new, frontend-shared pure vocabulary)

```ts
// contract/wsl-filesystem.ts — wsl-filesystem (specs/wsl-filesystem.md).
// Pure path vocabulary shared by the modal hint, cwd displays, and tests.
// NO IPC channels, NO event members, NO ErrorCodes are defined here. The Rust
// core mirrors these two predicates/transforms (is_wsl_unc_path, wsl_unc_to_linux).

/** True for \\wsl$\<distro>\… and \\wsl.localhost\<distro>\… (case-insensitive). */
export function isWslUncPath(p: string): boolean;

/** \\wsl$\Ubuntu\home\u\api → { distro: 'Ubuntu', path: '/home/u/api' }; null if not WSL UNC. */
export function wslUncToLinux(p: string): { distro: string; path: string } | null;

/** Compact display form: 'Ubuntu:/home/u/api'; null if not WSL UNC (caller falls back to ~-abbreviation). */
export function displayWslCwd(p: string): string | null;
```

Implementations live in the contract file (they are pure), with
`contract/wsl-filesystem.test.ts` covering: both UNC prefixes, case-insensitivity,
distro extraction, root-only paths (`\\wsl$\Ubuntu` → `/`), trailing separators,
non-WSL inputs (drive letters, plain UNC shares `\\server\share`, `/mnt/c/...`
strings), and display-form composition.

### Rust internals (not wire surface, pinned for the implementer)

- `is_wsl_unc_path(&str) -> bool`, `wsl_unc_to_linux(&str) -> Option<(String, String)>`
  — unit-tested mirrors of the contract helpers.
- `wsl_unc_root() -> Option<&'static str>` — FR-3 cache (`wsl.exe -- wslpath -w /`).
- `Engine::runtime_of(session_id) -> Option<String>` — alongside the existing `cwd_of`.
- diff.rs `git()` grows the FR-5 routing (same GitOut envelope; `wsl.exe` spawns
  get CREATE_NO_WINDOW like every other spawn).

## 6. Data & state

- **No persistence changes.** `cwd` + `runtime` already persist per session
  (sessions.json). Nothing new is written.
- **Rust:** `WSL_UNC_ROOT: OnceLock<Option<String>>` (FR-3); the diff domain's
  existing per-session `GIT_LOCKS`/`REPO_CACHE`/`RECOMPUTES` are untouched in
  shape — `REPO_CACHE` values may now hold Linux roots for WSL repos.
- **Shell registry:** unchanged structure (`Registry: Mutex<HashMap<sessionId,
  ShellEntry>>`); entries now exist only for real sessions; `session_remove`
  additionally calls the dispose path (FR-13).
- **Frontend:** `ShellTerminal` mounts with `sessionId = activeSessionId`
  (keyed remount per session, mirroring ConversationView/DiffView); shellStore
  already keys state per session id. Modal: one `runtimeTouched` boolean backing
  FR-16's only-if-untouched auto-flip.

## 7. Edge cases & errors

| Case | Behavior |
|---|---|
| Distro stopped (cold `\\wsl$` access or first `wsl.exe` op) | The op blocks a few seconds while WSL boots — surfaced by existing busy states; no special handling. |
| `wsl.exe` missing entirely | Session create with `wsl` runtime already fails eagerly (SPAWN_FAILED, shipped). Diff ops on a WSL-fs repo fail as GIT_ERROR with the spawn error text; shell ensure fails PTY_ERROR. No new codes. |
| FR-3 root discovery fails (`wslpath` error) | Cache = None → FR-7 falls back to `wsl.exe --cd <root> -- git diff --no-index --numstat` per untracked file (correct, slower — the pre-round-3 shape, WSL-only); FR-12 shellName falls back to `wsl`. Log once via panic-log-adjacent eprintln, don't error the session. |
| `wsl -l`-style UTF-16 output | Never parsed — FR-3 uses `wslpath` inside the distro (UTF-8) by design. |
| Native git over `\\wsl$` (story C mismatch) | Unchanged legacy behavior; git's `dubious ownership` / slowness surface as ordinary GIT_ERROR text. The FR-17 warning exists precisely to make this a knowing choice. |
| WSL repo external edits (from inside WSL, outside Francois) | No watcher (FR-8) → badge stale until the next tool.done, DIFF activation, or stage/commit. Accepted trade-off (frozen decision). |
| `session_remove` while its shell is open | Shell disposed (FR-13); frontend terminal unmounts with the session switch; no orphan PTY. |
| Rapid session switching on SHELL tab | Each switch replays that session's ring (existing semantics); PTYs stay alive in the background — bounded by session count. |
| `\\wsl.localhost` vs `\\wsl$` | Both recognized everywhere (FR-1); the FR-3 root is used verbatim for reverse translation, whichever form Windows returns. |
| Paths with spaces/unicode in distro or path segments | Argv-array spawning (never shell strings) keeps them intact end-to-end; translation is pure string slicing on separators. |
| Non-Windows build | `is_wsl_unc_path` never matches real paths there; FR-5 always routes native; wsl runtime already rejected at create (shipped). Zero dead-code paths need cfg-gating beyond what exists. |

## 8. Design brief

### Screens / regions

No new regions. Touched: the SHELL tab body + footer (mock `<!-- SHELL -->`
region), the new-session modal (below the CLAUDE RUNTIME row), and the sidebar
card cwd line / SESSION header meta (display form only).

### Components

- **ShellEmpty** (new state, not component): centered 12.5px `#565a63` text
  `select a session to open its shell` — identical styling to the SESSION tab's
  no-session state.
- **Shell footer** (existing): `● <shellName> · <cwd>` where wsl shells show the
  distro name and the FR-4 display path — e.g. `● Ubuntu · Ubuntu:/home/u/api`
  → collapse duplication: footer shows `● Ubuntu · /home/u/api` (when
  shellName === distro, the display path drops its `<distro>:` prefix).
- **Modal hints** (existing hint style, 10.5px):
  - auto-suggest info: color `#565a63` — `WSL directory — claude will run inside your default distro`
  - mismatch warning: color `#c46b62` — `Windows tools will access this directory over 9P — expect slow git and no live diff updates`
- **Cwd displays**: sidebar card line 2 and anywhere cwd is abbreviated render
  `Ubuntu:/home/u/api` via `displayWslCwd`, same faint `#565a63`, same ellipsis
  rules.

### States

- SHELL tab: per-session live terminal / exited (existing banner) / **no-session
  empty** (new).
- Modal runtime row: native / wsl (existing chips) + info hint / warning hint
  (mutually exclusive, below the row).

### Interactions

- Selecting a session while SHELL is open swaps terminals instantly (ring
  replay, no animation — matches app convention).
- Browse-pick of a `\\wsl$` directory flips the runtime chip to `wsl` unless the
  user already clicked a runtime chip in this modal-open (FR-16); flipping chips
  manually afterwards shows/hides the FR-17 warning live.

### Visual notes

All existing tokens; no new colors, sizes, or motion. Warning hint uses the
existing error red `#c46b62`; info hints faint `#565a63`; JetBrains Mono
throughout.

### Resize / responsive

Cwd display strings ellipsis-truncate exactly like current cwd lines; the shell
footer never wraps (existing rules). No other changes.

## 9. Acceptance criteria

- [ ] `contract/wsl-filesystem.ts` exports exactly `isWslUncPath`,
  `wslUncToLinux`, `displayWslCwd` (pure, implemented, vitest-covered incl. both
  UNC prefixes + negatives); Rust mirrors are cargo-tested (FR-1/2, §5).
- [ ] A session on a `\\wsl$…` repo: DIFF summary/file-diff/stage/commit all
  execute via `wsl.exe … -- git` (verifiable in tests via the routing fn), show
  correct counts, and commit with the distro's identity (FR-5/6/9).
- [ ] `untracked_counts` for WSL repos reads via the translated UNC path
  in-process — zero per-file git spawns on the happy path (FR-7).
- [ ] `watch_session` no-ops for WSL UNC cwds; drive-letter repos keep the
  watcher; DIFF re-hydrates on tab activation for all sessions (FR-8).
- [ ] SHELL tab is per-session: correct shell per runtime (distro shell in the
  session dir for wsl — incl. `/mnt/…` for drive cwds; pwsh in the session dir
  for native), scrollback survives session switches, remove disposes the PTY,
  no-session shows the empty state (FR-10–15).
- [ ] `EnsureData.shellName` = distro name for wsl shells; footer renders
  `● <name> · <path>` per §8 (FR-12).
- [ ] Modal: picking a WSL directory auto-selects `wsl` + info hint (unless
  runtime was touched); native+WSL-path shows the 9P warning; creation never
  blocked (FR-16/17).
- [ ] Sidebar cards and headers display WSL cwds as `<distro>:/path` (FR-4).
- [ ] No new IPC command, event member, or ErrorCode anywhere in the diff (§5).
- [ ] Existing matrix untouched: native-runtime drive-letter sessions produce
  byte-identical git invocations and shell spawns to v0.2.1 (regression: cargo
  tests for the routing/invocation fns).

## Remediation

**2026-07-24 — multi-distro correctness (user report: "the path is never correct").**
The frozen "default distro only" scope hid a correctness hole: every `wsl.exe`
spawn was bare, so it targeted the machine's **default** distro even when the
session cwd's UNC path named another one (canonical case: `docker-desktop` as
default after a Docker Desktop install) — `--cd <linux-path>` then pointed into
the wrong distro for git, the shell, and claude alike. Amendments, all
behavior-only (§5 still holds — no new IPC/event/ErrorCode):

- **Distro targeting**: a WSL UNC cwd now spawns `wsl.exe -d <distro> --cd
  <linux-path>` everywhere (`wsl::wsl_base_args`; `GitHost::Wsl` carries the
  distro). The distro comes from the path itself — still no distro picker.
  Drive-letter cwds with the wsl runtime keep targeting the default distro
  (no distro information exists).
- **FR-3 root cache** is now per-distro and only caches successes — a probe
  failing during a cold WSL boot retries on the next call instead of degrading
  the whole app run. FR-12's `shellName` for a UNC cwd is read purely from the
  path (no probe).
- **Readable wsl.exe errors**: wsl.exe reports its own failures in UTF-16LE (the
  `wsl -l -q` trap, but on spawn output); `wsl::decode_wsl_output` sniffs NULs
  and decodes, so GIT_ERROR text for a bad distro/path is no longer garbage.
- **Modal directory field is editable** (type/paste a path, Browse still
  offered) — on setups where the native picker can't reach `\\wsl$`, typing is
  the fallback. FR-16's auto-suggest now follows typed paths in both directions
  while the runtime chips are untouched. `session_pickDirectory` returns
  INVALID_INPUT (existing code) instead of a silent cancel when the picked item
  has no filesystem path (shell-namespace nodes).
- `ShellTerminal` takes a required `sessionId`; the dead `DEFAULT_SESSION_ID`
  fallback (pre-FR-10 global shell) is deleted.
