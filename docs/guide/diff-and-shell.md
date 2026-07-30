# Diff & shell

Every session's main pane has three tabs: SESSION, DIFF, and SHELL. This page
covers the last two — the git review surface and the real terminal — plus how
both adapt when a session's working directory lives inside WSL.

## The DIFF tab

The DIFF tab is a git-review surface for the selected session's working tree.
It doesn't parse git itself in any custom way — the Rust core drives the
system `git` CLI against the session's working directory to compute
summaries, per-file diffs, staging, and commits, then pushes change
notifications to the frontend so the tab (and the DIFF tab's badge in the tab
bar) stay live without polling.

### File selector

Changed files are shown as a horizontal strip of chips above the diff body,
one chip per changed file, sorted by path. Each chip carries:

- the file's name,
- a status glyph derived from `git status --porcelain` — `modified`,
  `added`, `deleted`, `untracked`, or `renamed` (an ambiguous status code like
  `AM` resolves in the order added > renamed > deleted > modified),
- a green `+N` addition count and a red `−N` deletion count, each only shown
  when non-zero.

The first file is selected by default; `←`/`→` cycle chips (wrapping), and
clicking a chip selects it directly. Selecting a chip loads that file's diff.
Counts for untracked files come from diffing against `/dev/null` rather than
`git add -N`, so simply opening the DIFF tab never mutates the git index.

### Unified diff view

The body renders one file's unified diff at a time: hunk headers, then
add/delete/context lines with a fixed-width line-number gutter (old line
number for deletions, new line number for additions and context) and a sign
column (`+`/`-`/space). There's no side-by-side view, no intraline
highlighting, and no syntax highlighting inside diff lines in v1 — colors are
per line-kind only (hunk, add, del, ctx).

Two files render specially:

- **Binary files** show a single "binary file" placeholder row instead of
  hunks.
- **Content-free changes** (e.g. a pure rename) show a "no content changes"
  placeholder in the same slot.

Merge conflicts aren't specially handled — a conflicted file just reports as
`modified` with git's raw diff output; dedicated conflict UI is future work.

### Stage-all and commit

The footer shows aggregate stats (`+total −total across N files`) plus two
actions, available whenever the DIFF tab is focused and no text input has
focus elsewhere:

- **`s` — stage all.** Runs `git add -A` in the session's working directory.
  It's always safe to press, even with nothing to stage.
- **`c` — commit.** Opens an inline commit-message input in the footer.
  `Enter` commits the staged changes and runs `git commit -m "<message>"`;
  `Esc` discards the draft and closes the bar. A successful commit shows
  `committed <shortHash>` for a moment before the footer reverts and the
  summary refreshes. Committing with nothing staged fails with the message
  "nothing staged to commit — stage changes first" and leaves the bar open
  with the typed message intact so the user can fix it (e.g. switch to SHELL
  and `git add` specific files) and retry.

Stage/commit are the only two git actions this tab exposes — anything else
(branching, push/pull, reset, discarding changes) is done from the SHELL tab
by running `git` directly.

A session whose working directory isn't a git repository shows an empty
state ("not a git repository — initialize with `git init` in the shell")
with no chips and no stage/commit hints. A clean tree shows "working tree
clean" with `+0 −0 across 0 files` and inert hints.

### Staying responsive

Nothing about the DIFF tab is cached client-side across renders — every
`getSummary`/`getFileDiff` call re-runs git fresh, since git's own reads are
already fast. What keeps it responsive under load is how updates are
triggered rather than how they're computed:

- **Claude's own edits** are the fast path: as soon as the session's
  `Edit`/`Write` tool reports done, the core recomputes and broadcasts a
  changed-file count immediately — no debounce.
- **Filesystem watching** covers edits made outside Claude (another editor,
  a script). This is debounced (roughly 300ms after the last event in a
  burst) so a flurry of writes doesn't trigger a recompute per file.
- **Git operations for a given session are serialized** in the core, so a
  stage, a commit, and a couple of rapid summary refreshes triggered at once
  can't interleave and corrupt the index.
- Ignored paths (`.gitignore`, `.git/` itself) never trigger a recompute in
  the first place — the watcher skips them as a performance optimization,
  though the authoritative file list always comes from the git commands
  themselves, not from the watcher.

## The SHELL tab

The SHELL tab is a real, PTY-backed shell running in the session's working
directory — "the normal terminal option," so there's no need to leave
Francois to run a command by hand. It's built on `xterm.js` in the frontend
and `portable-pty` (Rust) in the core.

### One PTY per session

A session's shell process is spawned lazily — the first time that session's
SHELL tab is opened — and then stays alive and buffering output for the life
of the session, independent of which tab or which session is currently
visible. Switching away from SHELL only tears down the frontend's `xterm.js`
instance; the process itself keeps running headless. Switching back replays
the core's buffered output into a freshly mounted terminal so the screen
looks exactly like it was left. The process is only killed when its session
is removed or the app quits.

The shell itself is resolved per platform: `pwsh`/`powershell.exe` on
Windows, or `$SHELL` (falling back to `zsh`, then `bash`) on macOS/Linux, run
as an interactive login shell so `.zshrc`/`.bashrc`/PATH tooling behave
normally.

### A real terminal, not a smart one

Output is rendered live through `xterm.js` with the app's own tokens: font,
theme, and a full 16-color ANSI mapping driven entirely by the shell's own
SGR escape codes — there's no client-side parsing or recoloring layered on
top. Scrollback is 10,000 lines client-side once mounted, separate from a
smaller ring buffer the core keeps per session purely to reconstruct the
visible screen on remount.

While the terminal has keyboard focus, every keystroke — including digits,
letters, and combinations that are global hotkeys elsewhere in the app — is
captured and forwarded byte-for-byte to the shell. That includes `⌃C`
(interrupt) and `⌃L` (clear): neither is special-cased by Francois, they're
just forwarded like any other input and handled by the shell/foreground
process exactly as they would be in any terminal. The one carve-out is
⌘K/Ctrl+K, which is never forwarded — it's left to bubble up and open the
command palette instead. Clicking outside the terminal (or the palette
opening) blurs it and restores normal global key handling with no explicit
action needed.

The footer below the terminal shows a status dot (green while the process is
alive, red once it's exited), the resolved shell's name, and the working
directory (home-abbreviated to `~` when possible), plus static `⌃C
interrupt` / `⌃L clear` hints.

### Exit and restart

If the shell process exits — the user typed `exit`, or it crashed — a dim
line appears directly in the terminal buffer: `process exited (code N) —
press ⏎ to restart`, and the footer dot turns red. In this state every key
except `⏎` is swallowed locally rather than sent anywhere. Pressing `⏎`
spawns a fresh process in the same working directory, clears the terminal,
and resumes normal input with the dot back to green. A failure to spawn in
the first place is treated the same way, substituting the error message for
the exit line.

## WSL support

Sessions can run Claude Code inside WSL, but a repo living in the WSL
filesystem (`\\wsl$\<distro>\…`) is slow or unreliable to touch from Windows
tools — no reliable file-change notifications over 9P, and possible git
ownership warnings. WSL support in Francois follows one rule:

> **Git follows the filesystem. The shell and Claude follow the runtime.**

### Git routing

Every git operation the DIFF tab makes routes purely on whether the
session's working directory is a WSL UNC path — the Claude runtime (native
vs. wsl) is irrelevant to this decision:

| Working directory | Git runs as |
|---|---|
| `\\wsl$\<distro>\…` or `\\wsl.localhost\<distro>\…` | `wsl.exe -d <distro> --cd <linux-path> -- git …` |
| A drive-letter path (e.g. `D:\acme-api`) | ordinary Windows `git …`, unchanged |

This means a WSL-runtime session working on a Windows drive-letter repo
still gets full-speed Windows git, while a native-runtime session pointed at
a `\\wsl$\…` path (a deliberate mismatch) still gets WSL git for correctness.
Staging and committing follow the same routing, and a WSL repo's commits use
the distro's own git identity, not the Windows one.

Because 9P doesn't reliably deliver filesystem change notifications, the fs
watcher is skipped entirely for WSL-filesystem repos — no watcher, no
polling. Freshness for those sessions instead comes from the same
event-driven recomputes that already exist: every Claude `Edit`/`Write`,
every time the DIFF tab is opened, and every stage/commit. Drive-letter
repos keep the normal recursive watcher regardless of which runtime the
session uses.

### Per-session shells

The SHELL tab is per-session rather than one global shell: each session gets
the shell appropriate to its own runtime, in its own working directory.

| Session runtime | Shell spawned | Working directory |
|---|---|---|
| `native` | Resolved platform shell (pwsh/PowerShell, or `$SHELL`/zsh/bash) | The session's cwd as-is (a `\\wsl$\…` cwd is legal here too — it's the user's explicit choice) |
| `wsl` | The distro's default shell, via `wsl.exe -d <distro> --cd <dir>` | The Linux-translated path for a WSL UNC cwd, or the Windows path verbatim for a drive-letter cwd (which `wsl.exe` maps under `/mnt/…`) |

The footer's shell name shows the distro name for a wsl shell (e.g.
`Ubuntu`) instead of a shell executable's basename. Switching sessions swaps
between each session's own PTY with scrollback intact, exactly like the
non-WSL case; removing a session disposes its shell; with no active session,
the SHELL tab shows "select a session to open its shell" rather than
spawning anything.

### Path handling

A single shared vocabulary — mirrored between the Rust core and the
frontend contract — detects and translates WSL UNC paths so the rest of the
app doesn't have to reimplement it:

- **Detection**: a path is recognized as WSL when it starts with `\\wsl$\` or
  `\\wsl.localhost\`, case-insensitively.
- **Translation**: `\\wsl$\Ubuntu\home\u\api` becomes the Linux path
  `/home/u/api` in the `Ubuntu` distro (backslashes flipped, prefix
  stripped); the reverse direction uses the core's own discovery of the
  default distro's UNC root (`wsl.exe -- wslpath -w /`, cached once per app
  run — deliberately avoiding `wsl.exe -l -q`'s UTF-16LE output).
- **Display**: anywhere a working directory is shown — the sidebar card, the
  session header, the shell footer — a WSL path renders compactly as
  `<distro>:/path` (e.g. `Ubuntu:/home/u/api`) instead of the raw UNC form.
  Non-WSL paths fall back to the existing `~`-abbreviation.

The new-session modal uses the same detection: picking a `\\wsl$…` directory
auto-selects the `wsl` runtime with a one-line hint, but the reverse
mismatch (native runtime against a WSL path) only shows a warning — "Windows
tools will access this directory over 9P — expect slow git and no live diff
updates" — it never blocks session creation. `wsl.exe` targets the distro
named in the path itself; there's no distro picker beyond that.
