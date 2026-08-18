# Worktree isolation

Francois runs many sessions at once, but by default every session on a given project **shares one
working tree**. Two sessions on the same repo means one edits files the other is reading, DIFF
shows a mixture of both, and committing from either is a coin flip. Worktree isolation fixes
that: an optional step at session creation that gives a session its own `git worktree` — its own
checkout, on its own branch, in a sibling directory — so parallel sessions on one repo become
genuinely safe.

## Creating an isolated session

Two ways in:

- **⌘K → "New session in worktree…"** opens the New Session modal with the checkbox already
  checked.
- In the New Session modal, pick a working directory that's a git repo — an **Isolate in
  worktree** checkbox appears (it's simply absent for a non-git directory, never disabled, never
  an error).

Checking it reveals three more fields:

- **Branch** — prefilled `feat/<slug of the session name>` (or `feat/<slug of the directory name>`
  if the session has no name yet).
- **Base ref** — prefilled with the repo's default branch.
- A dim, read-only **path preview** of where the worktree will live:
  `<repo-parent>/.francois-worktrees/<repo-name>/<branch-slug>`.

Hit **Create session**. Francois prunes stale worktree admin entries, fetches (best-effort, with
a timeout), and creates the worktree on the branch you named — then opens the session there. The
tree is a **bare checkout**: no dependency install, and no gitignored local config (like
`.claude/settings.local.json` or a local `.mcp.json`) is carried over. A persistent, dismissible
banner above the SESSION transcript says so, because it means permission rules and MCP servers
can differ from the parent checkout. If the pre-create fetch failed (offline, or a slow remote
hitting the timeout), the worktree is still created and the same banner adds a line saying the
branch was forked from your **local** base ref rather than a freshly fetched one.

## Branch name already in use

Two cases the form handles inline, never as a hard error:

- **The branch already exists locally.** The form switches to "existing branch — will be checked
  out" and disables Base ref (the core ignores it and checks the branch out as-is).
- **The branch is already checked out in another worktree.** Instead of failing, the form offers
  **"Open a session in that worktree instead."** Accepting opens a session at that existing path
  with **zero git mutation** — no new worktree, no branch changes.

## What the session card shows

A worktree session's card in the roster, and the session row, show a small branch
glyph and the branch name (truncated, full value on hover). On a **main-checkout** session's DIFF
tab, a dim single line lists any live sibling worktree sessions spawned from the same repo — e.g.
`2 worktree sessions · feat/auth, feat/parser` — read-only, just so you know they exist.

## Deleting a worktree session

Removing a session that has a worktree adds one extra step: **"Also remove the worktree at
`<path>`?"**

- A **clean, fully-pushed** tree offers the checkbox (off by default) — check it and the
  directory is deleted; leave it unchecked and the directory stays on disk, just untracked by
  Francois.
- A **dirty or unpushed** tree shows the checkbox **disabled**, with the reason spelled out
  ("3 uncommitted files", "2 commits not on `origin/feat/x`"). There's no override — Francois
  will never force-remove a worktree with unsaved work in it.

In every case the **branch itself is never deleted** — only the working-tree directory, and only
when you explicitly ask for it.

## What this deliberately doesn't do

- No merge-back, rebase, or PR creation — committing and pushing stay the DIFF tab's job, same as
  any other session.
- No worktree manager, inventory, or orphan sweeper. If Francois crashes mid-create, or a dirty
  session's worktree is left behind, that directory becomes an **orphan** — untracked by
  Francois, but not silently deleted either. See
  [Troubleshooting](/reference/troubleshooting#orphaned-worktree-directories) for the manual
  cleanup.
- No copying of gitignored files (`.env`, local settings, local MCP config) into the new tree —
  by design, so the isolation is real.
- No dependency installation or a per-project "worktree setup command" — the tree is bare on
  purpose.
