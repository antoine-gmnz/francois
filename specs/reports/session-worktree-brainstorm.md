# BRAINSTORM RETURN — Open session in worktree

> Paste this into `/spec`.

**feature_id:** `session-worktree`

**One-liner:** When creating a session on a git repo, optionally create a durable git worktree on a
new or existing branch and open the session there, so parallel Claude sessions each get their own
checkout instead of fighting over one working tree.

## Problem & value

Francois is built for running **many** sessions at once (`fleet-board`, `overview`, `projects` all
assume it), but every session on a given project shares one working tree. Two sessions on the same
repo means one is editing files the other is reading — diffs interleave, `DIFF` shows a mixture of
both sessions' work, and committing from either is a coin flip. Git worktrees are the native fix:
one branch, one checkout, one session. The value is that parallel work on a single repo becomes
actually safe, which is the app's whole premise.

## Scope

- **In:**
  - An **"isolate in worktree"** option in the New Session flow, offered **only when the chosen cwd
    is a git repo** (silently absent otherwise — never an error).
  - Fields: **branch** (prefilled `feat/<kebab session name>`) and **base ref** (prefilled with the
    project's default branch, editable to any ref). Branch may be new or existing.
  - Worktree location: **sibling directory outside the repo** —
    `<repo-parent>/.francois-worktrees/<repo-name>/<branch-slug>`. Never inside the repo, so no
    `.gitignore` write and `DIFF` on the main checkout stays clean.
  - **Bare checkout** semantics: no dependency install, no copying of gitignored local config. The
    session shows a one-time notice stating what did *not* come with it — dependencies are not
    installed, and local-scope config (`.claude/settings.local.json`, local `.mcp.json`) is not
    carried over, so permission rules and MCP servers may differ from the parent checkout.
  - **Explicit project link at creation**: the session records the project it was spawned from, and
    is treated as belonging to that project everywhere (sidebar grouping, Overview rollup, fleet
    totals) even though its cwd is outside the project root. Existing cwd-containment matching stays
    as the fallback for non-worktree sessions.
  - **Branch visibility**: the branch name is shown on the session card and in the status bar for
    worktree sessions, so a user with several sessions can tell which tree each `DIFF` belongs to.
  - **Already-checked-out recovery**: if the requested branch is already checked out in another
    worktree, do not error — offer to open a session in that existing worktree instead.
  - `git worktree prune` before every add, so trees deleted outside the app leave no stale admin
    entries.
  - **Prompt on session delete**: deleting a worktree session asks whether to remove the worktree.
    Clean trees offer removal; dirty or unpushed trees are kept with a warning (never force-removed
    silently).
  - A **command-palette** entry ("New session in worktree…") that opens the same form pre-checked.
  - WSL/Windows host correctness: the worktree is created on the **same host** as the repo (a Linux
    repo gets a Linux-path worktree via `wsl.exe`, never a `\\wsl$` UNC path), reusing the host
    resolution already in `src-tauri/src/diff/git.rs`.
- **Out (non-goals):**
  - Merge-back, rebase, or PR creation. Committing and pushing remain the `DIFF` tab's job.
  - A worktree manager / list / orphan sweeper. No global inventory UI in v1.
  - Dependency installation or any per-project "worktree setup command".
  - Copying gitignored files (`.env`, `.claude/settings.local.json`, local `.mcp.json`) into the tree.
  - Auto-pruning worktrees on app quit or on crash recovery. Nothing is ever deleted unprompted.
  - Ephemeral/scratch worktree mode — worktree sessions are always **durable feature branches**.

## Rough shape

- **Data:**
  - Session gains worktree provenance: whether it is a worktree session, its branch, its base ref,
    the worktree path, and the source repo root.
  - Session gains an **explicit project id** set at creation (currently the project is inferred from
    cwd containment via `findProjectForCwd`) — this is the piece that keeps worktree sessions inside
    their project's fleet/Overview rollup.
  - Project registry supplies the **default branch** used to prefill the base ref.
  - No new persisted worktree inventory (deliberately — see Out).
- **Screens:**
  - **New Session form**: checkbox *Isolate in worktree*, revealing branch + base fields; the
    resulting path is previewed. Hidden when cwd is not a git repo.
  - **Recovery state** in that form: "branch already checked out at `<path>` — open a session there?"
  - **Session card + status bar**: branch glyph + branch name for worktree sessions.
  - **First-run notice** inside the new session: what was not carried over (deps, local settings).
  - **Delete-session confirm**: extra step offering worktree removal, with dirty/unpushed state shown
    and removal blocked-by-default in that case.
  - **⌘K command**: "New session in worktree…".
- **Interface (rough):** new `francois:session:*` verbs around worktree creation, probing a cwd for
  repo-ness / default branch / existing worktrees for a branch, and removing a worktree with a
  dirty/ahead safety check. Session creation payload extends with the worktree options and the
  explicit project id. Exact names/types are settled in `/spec` against `contract/common.ts`
  (`ErrorCode` gains worktree-specific codes) and `contract/session-engine.ts`.

## Risks & open questions

- **Orphan worktrees are accepted, not solved.** With prompt-on-delete only, an app crash or a
  dirty-tree deletion leaves a directory Francois no longer knows about. The already-checked-out
  recovery path is the mitigation; `/spec` should confirm it covers the realistic cases.
- **`.git` is a file, not a directory, inside a linked worktree.** `diff/git.rs` resolves the
  worktree root and caches `cwd -> (host, root, base)`; that resolution must be verified (and
  tested) from inside a linked worktree, on both hosts.
- **Local settings divergence is a safety issue, not a convenience one.** `permission-guardrails`
  writes to `.claude/settings.local.json`, which is gitignored and therefore absent in a fresh
  worktree. The notice is the agreed mitigation — `/spec` should decide how prominent it is and
  whether it repeats.
- **Branch/path slugging**: branch names contain `/`; the directory name must be derived safely and
  collision-free, and must round-trip well enough for the recovery path.
- **Base ref freshness**: forking from a local default branch that is behind origin. Do we fetch, or
  just fork from what's on disk and say so?
- **Bare tree usability**: in this repo a fresh worktree can't `npm run dev` without an install. We
  accepted that; watch whether it makes the feature feel broken in practice.
- Open: does the main-checkout session show anything about its sibling worktree sessions? (Leaning
  no for v1.)

## Panel dissent (what was contested)

The sharpest disagreement was **who owns worktree cleanup**. Malik (engineering) argued that
creating durable directories with no inventory UI makes Francois a litter generator — orphans
accumulate invisibly and the next attempt on the same branch hits `fatal: already checked out`. He
wanted a worktrees modal listing branch/path/dirty state with explicit removal. Priya and Nadia
pushed back on surface area: a manager is a second feature, and a half-built one would be worse than
none. The decision was **prompt-on-delete only**, with Malik's `already checked out → open that
session instead` recovery plus `git worktree prune` before every add as the explicit price of
skipping the manager. `/spec` should not quietly re-add the manager, and should not paper over the
fact that crash-orphaned trees are genuinely unmanaged.

Secondary dissent: Tomás (security) does not accept "bare checkout" as neutral — he considers
`.claude/settings.local.json` a safety file, and its absence means a worktree session can run under
different permission rules than the parent. He lost the argument to copy it, and won the requirement
that the session must **say so**.
