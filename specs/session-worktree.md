---
id: session-worktree
title: Open session in worktree
status: shipped
created: 2026-07-29
depends_on: [session-engine, sessions-sidebar, diff-view, projects, command-palette, app-shell]
reviewed_base: 1490f8561db8f846f579a15bb7cdc200621283c4
reviewed_digest: 39734f640fb27818
---

# Open session in worktree

## 1. Summary

Francois is built to run many sessions at once, but every session on a given project shares one
working tree — two sessions on the same repo means one edits files the other reads, `DIFF` shows a
mixture of both, and committing from either is a coin flip. This feature adds an optional **"isolate
in worktree"** step to session creation: when the chosen cwd is a git repo, Francois prunes stale
worktree admin entries, fetches, and creates a durable `git worktree` on a new or existing branch in
a sibling directory outside the repo, then opens the session there. One branch, one checkout, one
session. The tree is a **bare checkout** — no dependency install, no gitignored local config carried
over — and the session says so, prominently, because the missing `.claude/settings.local.json` means
its permission rules can differ from the parent checkout.

## 2. Goals & non-goals

**Goals**

- Parallel sessions on one repo become safe: independent checkouts, independent `DIFF`, independent
  commits.
- Zero new failure modes on non-git cwds — the option is simply absent.
- Never destroy uncommitted work, and never leave a half-created worktree behind.
- Correct on WSL: a Linux repo gets a Linux-path worktree, never a `\\wsl$` UNC path.

**Non-goals**

- Merge-back, rebase, PR creation. Committing and pushing stay `diff-view`'s job.
- A worktree manager / inventory / orphan sweeper. Deliberately rejected (see §7 "orphans").
- Dependency installation or a per-project "worktree setup command".
- Copying gitignored files (`.env`, `.claude/settings.local.json`, local `.mcp.json`) into the tree.
- Auto-pruning worktrees on quit or crash recovery. Nothing is deleted unprompted.
- Ephemeral/scratch worktrees — worktree sessions are always durable feature branches.
- Any change to how a session links to a project: `SessionMeta.projectId` is already set explicitly
  at creation (projects FR-19/21), so a worktree session lands in its project's sidebar group,
  fleet totals and Overview rollup with no work here.

## 3. User stories / flows

**Create.** In the New Session modal the user picks a cwd that is a git repo. An **Isolate in
worktree** checkbox appears. Checking it reveals **Branch** (prefilled `feat/<slug of session
name>`) and **Base ref** (prefilled with the repo's default branch), plus a dim read-only preview of
the resulting path. Create → the session opens with cwd = the new worktree; its card shows the
branch; a dismissible banner at the top of `SESSION` states what did not come along.

**Existing branch.** The user types a branch that already exists locally. The form switches to
"existing branch — will be checked out; base ref ignored" and disables the base field.

**Already checked out.** The branch is checked out in another worktree. Instead of an error, the
form offers **"Open a session in that worktree instead"** with the path shown. Accepting creates the
session at that path with no git mutation.

**Delete.** Deleting a worktree session adds a step: **"Also remove the worktree at `<path>`?"**. A
clean, fully-pushed tree offers the checkbox (default off). A dirty or unpushed tree shows the
checkbox disabled with the reason ("3 uncommitted files", "2 commits not on `origin/feat/x`") — the
session is removed from Francois, the directory is kept.

**Palette.** ⌘K → "New session in worktree…" opens the same modal with the checkbox pre-checked.

## 4. Functional requirements

**Probe & form**

- **FR-1** The New Session modal calls `session:worktreeProbe` on the cwd (debounced 250 ms, and on
  every cwd change). The **Isolate in worktree** control renders only when `isRepo` is true; when
  false it is **absent**, never disabled and never an error.
- **FR-2** Checking it reveals: `branch` prefilled `feat/<kebab-slug of the session name>` (falling
  back to `feat/<kebab-slug of basename(cwd)>` when the name is empty), `baseRef` prefilled
  `probe.defaultBranch`, and a read-only preview of `worktreePath` recomputed from the current
  branch value.
- **FR-3** `branch` must be non-empty after trim and pass `git check-ref-format --branch`. The core
  re-validates and returns `INVALID_INPUT` on failure — the frontend check is a convenience only.
- **FR-4** When `probe.branchExists` is true the form states "existing branch — will be checked out"
  and disables `baseRef` (the core ignores it, FR-8).
- **FR-5** When `probe.branchCheckedOutAt` is set the form suppresses creation and offers **open a
  session in that worktree instead** — a normal `session:create` with `cwd` = that path and
  `worktree.adopt = true` (FR-12), performing **no** git mutation.

**Creation**

- **FR-6** `session:create` with `worktree` present runs, in order, against `probe.repoRoot`:
  `git worktree prune` → fetch (FR-7) → `git worktree add` (FR-8). A failure at any step creates
  **no session** and returns the mapped error (FR-11).
- **FR-7** Fetch is `git fetch --prune <remote>` with `GIT_TERMINAL_PROMPT=0` and a **20 s** timeout,
  where `<remote>` is `probe.remote`. It is **best-effort**: on failure or timeout the flow continues
  and the resulting `SessionWorktree` carries `fetched: false` + `fetchError`. When `probe.remote` is
  null (no remote configured) the fetch is **skipped silently** with `fetched: false` and no
  `fetchError`.
- **FR-8** The add is `git worktree add -b <branch> <path> <baseRef>` when the branch is new
  (`createdBranch: true`), and `git worktree add <path> <branch>` when it already exists — in the
  latter case `baseRef` is ignored entirely and echoed back verbatim.
- **FR-9** `worktreePath` = `<dirname(repoRoot)>/.francois-worktrees/<basename(repoRoot)>/<slug>`,
  where `slug` is `branch` lowercased with every character outside `[a-z0-9._-]` replaced by `-`,
  runs of `-` collapsed, leading/trailing `-` trimmed, truncated to 60 chars. A branch whose slug
  collapses to the empty string (entirely non-`[a-z0-9._-]`, e.g. CJK) falls back to the literal
  `branch`, so the worktree is always a *child* of `<basename(repoRoot)>` and never the directory
  itself. If that directory
  already exists, `-2`, `-3`, … is appended until it does not. The slug is **never parsed back** —
  recovery reads `git worktree list --porcelain`, which is authoritative.
- **FR-10** Every git invocation goes through `diff::git::git_routed` with the `GitHost` derived
  **once** from the raw session cwd (`GitHost::of`, wsl-filesystem FR-5). For a WSL repo, `repoRoot`
  and `worktreePath` are **Linux** paths and the session's cwd is stored in the host's dialect —
  never a `\\wsl$` UNC path.
- **FR-11** On any failure the core best-effort reverses what it did (`git worktree remove --force`
  on a created path, `git branch -D` on a branch it created and nothing else uses) before returning
  the error. A failure of the reversal is logged, not surfaced.
- **FR-12** A successful create stores `SessionWorktree` on `SessionMeta` (§5) and persists it with
  the session. `worktree.adopt = true` (FR-5) skips FR-6 entirely and fills the provenance from
  `git worktree list --porcelain` for that path.

**Session UI**

- **FR-13** For a session with `worktree`, the sessions-sidebar card and the app-shell status bar
  render a branch glyph + `worktree.branch`, truncated with the full value in the title attribute.
- **FR-14** A **persistent dismissible banner** pinned above the `SESSION` transcript states: no
  dependencies were installed, and local-scope config (`.claude/settings.local.json`, local
  `.mcp.json`) was not carried over, so permission rules and MCP servers may differ from the parent
  checkout. When `fetchError` is set it also states "could not fetch — forked from local `<baseRef>`".
  Dismissal is per session and persists in `localStorage` under `WORKTREE_NOTICE_STORAGE_KEY`; the
  banner never returns for that session.
- **FR-15** On a **main-checkout** session's `DIFF` tab, a dim single line lists live sibling
  worktree sessions: `N worktree sessions · feat/auth, feat/parser`. It is read-only (no navigation,
  no actions) and derived purely in the frontend by `siblingWorktreeSessions` (§5) — no new IPC and
  no persistence. Absent when the count is 0 or the session is itself a worktree session.
- **FR-16** The command palette registers **"New session in worktree…"**, opening the New Session
  modal with the checkbox pre-checked. It is listed unconditionally; if the chosen cwd turns out not
  to be a repo, FR-1 simply hides the control.

**Deletion**

- **FR-17** Removing a session that has `worktree` inserts a confirm step offering worktree removal.
  A session without `worktree` is removed exactly as today.
- **FR-18** That step first calls `session:worktreeStatus`, which reports `dirty` (any uncommitted
  or untracked change) and `unpushed` (commits not present on the branch's upstream; `true` when the
  branch has no upstream **and** has commits not reachable from `baseRef`).
- **FR-19** `dirty || unpushed` **hard-blocks** removal: the checkbox is disabled with the reason
  rendered. There is no override — Francois never runs `git worktree remove --force` on user request.
- **FR-20** With removal confirmed, `session:worktreeRemove` runs `git worktree remove <path>` then
  `git worktree prune` against `sourceRepoRoot`. The branch is **never** deleted. If removal fails,
  the session is still removed and the error is surfaced as a toast.

**Correctness**

- **FR-21** `diff/git.rs` must resolve `(host, root, base)` correctly from inside a **linked**
  worktree, where `.git` is a file rather than a directory — covered by a test on each host that
  creates a real worktree in a temp repo and asserts `repo_info` returns the worktree's own root.

## 5. API contract

Lives in `contract/session-worktree.ts`; the two shared additions below go in `contract/common.ts`.
Binding per PIPELINE.md: `francois:session:<verb>` → `invoke('session_<verb>')` → `Promise<Result<T>>`.

**Added to `contract/common.ts`**

```ts
/** Worktree provenance for a session created with isolation (session-worktree FR-12). */
export interface SessionWorktree {
  branch: string;          // the checked-out branch, verbatim
  baseRef: string;         // the ref it was forked from; echoed verbatim, ignored when createdBranch is false
  path: string;            // absolute worktree path, in the HOST's dialect (FR-10)
  sourceRepoRoot: string;  // absolute root of the repo this tree belongs to, host dialect
  createdBranch: boolean;  // false ⇒ the branch already existed, or the tree was adopted (FR-5)
  fetched: boolean;        // a fetch ran and succeeded (FR-7)
  fetchError?: string;     // one-line reason; absent when fetched, or when there is no remote
}

// SessionMeta gains:
//   /** Present ⇔ this session runs in a Francois-created or Francois-adopted git worktree. */
//   worktree?: SessionWorktree;

// ErrorCode gains:
//   | 'WORKTREE_BRANCH_IN_USE'  // the branch is already checked out at another path (detail: { path })
//   | 'WORKTREE_CREATE_FAILED'  // prune/add failed; the core reversed what it did (FR-11)
//   | 'WORKTREE_DIRTY'          // removal refused: uncommitted changes or unpushed commits (FR-19)
//   | 'WORKTREE_NOT_FOUND'      // no worktree registered at that path
```

No new `SessionEvent` members: worktree provenance rides on the existing `session.meta` snapshot.

**`contract/session-worktree.ts`**

```ts
import type { Result, SessionId, SessionMeta, SessionWorktree } from './common';

// ---------- francois:session:worktreeProbe ----------
export interface WorktreeProbeRequest {
  cwd: string;      // absolute; the candidate session cwd
  branch?: string;  // when present, branchExists / branchCheckedOutAt are filled for it
}
export interface WorktreeProbeData {
  isRepo: boolean;             // false ⇒ every other field is null/false; NOT an error
  repoRoot: string | null;     // host dialect (FR-10)
  defaultBranch: string | null;// origin/HEAD → else the repo's init.defaultBranch → else 'main'
  currentBranch: string | null;// null on detached HEAD
  remote: string | null;       // 'origin' when present, else the first remote, else null
  branchExists: boolean;       // request.branch resolves to a local branch
  branchCheckedOutAt: string | null; // path of the worktree holding it (FR-5); null when free
  worktreePath: string | null; // FR-9 for request.branch; null when branch is absent
}
// invoke('session_worktree_probe', req): Promise<Result<WorktreeProbeData>>
// errors: 'INVALID_INPUT' (cwd not absolute / not a directory) | 'GIT_ERROR' | 'INTERNAL'
// A non-repo cwd resolves ok:true with isRepo:false — never NOT_A_GIT_REPO.

// ---------- extends francois:session:create ----------
/** Added to SessionCreateInput (contract/session-engine.ts) as `worktree?: WorktreeCreateOptions`. */
export interface WorktreeCreateOptions {
  branch: string;   // non-empty after trim; must pass `git check-ref-format --branch` (FR-3)
  baseRef: string;  // ignored when the branch already exists or adopt is true (FR-8)
  /** true ⇒ adopt the existing worktree at `cwd`; no prune, no fetch, no add (FR-5/FR-12). */
  adopt?: boolean;
}
// invoke('session_create', { ...SessionCreateInput, worktree }): Promise<Result<SessionMeta>>
//   resolved SessionMeta.worktree is present on success.
// added errors: 'NOT_A_GIT_REPO' | 'INVALID_INPUT' | 'WORKTREE_BRANCH_IN_USE' |
//               'WORKTREE_CREATE_FAILED' | 'GIT_ERROR'

// ---------- francois:session:worktreeStatus ----------
export interface WorktreeStatusRequest { sessionId: SessionId }
export interface WorktreeStatusData {
  dirty: boolean;
  dirtyCount: number;    // changed + untracked entries (0 when clean)
  unpushed: boolean;
  unpushedCount: number; // commits ahead of upstream, or ahead of baseRef when no upstream (FR-18)
  // Sentinel: `unpushed: true` with `unpushedCount: 0` means push status could NOT be determined
  // (no upstream and no reliable baseRef). Removal still hard-blocks (FR-19), but every reason
  // string must say "push status unknown", never "0 commits".
  upstream: string | null; // e.g. 'origin/feat/x'; null when the branch has none
}
// invoke('session_worktree_status', req): Promise<Result<WorktreeStatusData>>
// errors: 'SESSION_NOT_FOUND' | 'WORKTREE_NOT_FOUND' (session has no worktree, or the path is gone)
//       | 'GIT_ERROR' | 'INTERNAL'

// ---------- francois:session:worktreeRemove ----------
export interface WorktreeRemoveRequest { sessionId: SessionId }
// invoke('session_worktree_remove', req): Promise<Result<null>>
//   Runs `git worktree remove <path>` then `git worktree prune`. NEVER --force, NEVER deletes the
//   branch. Re-checks FR-18 server-side and refuses with WORKTREE_DIRTY.
// errors: 'SESSION_NOT_FOUND' | 'WORKTREE_NOT_FOUND' | 'WORKTREE_DIRTY' | 'GIT_ERROR' | 'INTERNAL'

// ---------- pure frontend helpers (owned here, unit-tested) ----------

/** FR-9, frontend side — must match the core byte-for-byte (both are tested against the same table). */
export function worktreeSlug(branch: string): string;

/** FR-9 preview path. `repoRoot` in the host dialect; separator inferred from it. */
export function previewWorktreePath(repoRoot: string, branch: string): string;

/**
 * FR-15. Sessions whose `worktree.sourceRepoRoot` contains `session.cwd` — i.e. the worktree
 * sessions spawned from the repo this main-checkout session sits in. Returns [] when `session`
 * itself has a `worktree`. Uses projects' `isPathInside` for normalization.
 */
export function siblingWorktreeSessions(
  session: SessionMeta,
  all: SessionMeta[],
  caseInsensitive: boolean,
): SessionMeta[];

/** localStorage key for FR-14 dismissals; value is a JSON array of SessionId. */
export const WORKTREE_NOTICE_STORAGE_KEY = 'francois.worktreeNoticeDismissed';
```

## 6. Data & state

- **Core**: `SessionWorktree` is stored on the in-memory `SessionMeta` and persisted with the session
  in `sessions.json` (durable-sessions). A persisted `worktree` whose `path` no longer exists is
  **kept** — the session still opens (its cwd is simply gone, existing behavior), and
  `worktreeStatus` returns `WORKTREE_NOT_FOUND`. There is **no** separate worktree inventory file.
- **Core**: no new cache. `diff::git::REPO_CACHE` already keys on cwd, so a worktree session caches
  its own root independently of the main checkout (FR-21 covers the resolution).
- **Frontend**: New Session modal holds `worktreeEnabled`, `branch`, `baseRef`, and the last
  `WorktreeProbeData`. The dismissed-notice set lives in `localStorage`
  (`WORKTREE_NOTICE_STORAGE_KEY`). The sibling line (FR-15) is derived, never stored.

## 7. Edge cases & errors

| Case | Behavior |
|---|---|
| cwd is not a git repo | Checkbox absent (FR-1). `worktreeProbe` still resolves `ok:true, isRepo:false`. |
| cwd is a repo with no commits | Allowed. `defaultBranch` falls back to `init.defaultBranch`/`main`; the add runs against the unborn HEAD and, if git refuses, maps to `WORKTREE_CREATE_FAILED` with git's stderr as the message. |
| Branch name invalid | `INVALID_INPUT`; the form shows git's own reason inline. |
| Branch already checked out (probe) | Recovery offer (FR-5) — never an error. |
| Branch checked out between probe and create (race) | `WORKTREE_BRANCH_IN_USE` with `detail: { path }`; the form transitions to the same recovery offer. |
| Target path exists | Suffixed `-2`, `-3`, … (FR-9). |
| Fetch fails / times out / no remote | Worktree still created; `fetched:false` + `fetchError` surfaced in the banner (FR-7/FR-14). |
| `worktree add` fails | No session; core reverses (FR-11); `WORKTREE_CREATE_FAILED`. |
| Worktree dir deleted outside Francois | `worktreeStatus` → `WORKTREE_NOT_FOUND`; the delete step offers no removal and says the tree is already gone. `git worktree prune` before every add (FR-6) clears the stale admin entry. |
| Dirty or unpushed on delete | Hard block (FR-19), directory kept. |
| `worktree remove` fails | Session removed anyway, error toast (FR-20). |
| **Orphans** | **Accepted, not solved.** A crash mid-create, or deleting a dirty session, leaves a directory Francois no longer tracks. The mitigations are exactly `prune`-before-add plus the already-checked-out recovery — there is deliberately no inventory UI, and this spec must not grow one. |

## 8. Design brief

> full brief: `specs/design/session-worktree.md`

Five surfaces, all inside existing chrome: the **New Session modal** gains a checkbox that reveals a
branch field, a base-ref field, a dim path preview, and an inline recovery/existing-branch notice;
the **session card** and **status bar** gain a branch glyph + name; the `SESSION` tab gains a
**persistent dismissible warning banner**; the `DIFF` tab of a main-checkout session gains one dim
sibling line; the **delete-session confirm** gains a removal checkbox with a disabled-with-reason
state. Tokens, glyphs and motion come from `Claude Terminal.dc.html`.

## 9. Acceptance criteria

- [x] On a non-git cwd the worktree control never appears, and nothing errors. (FR-1)
- [x] On a git cwd, checking the box prefills `feat/<session-name-slug>` + the default branch and
      previews a path under `<repo-parent>/.francois-worktrees/<repo-name>/`. (FR-2, FR-9)
- [x] Creating with a new branch produces a real worktree, and `git worktree list` in the source repo
      shows it on that branch. (FR-6, FR-8)
- [x] Creating with an already-checked-out branch offers to open a session at the existing path, and
      accepting mutates no git state. (FR-5) — the MEDIUM staleness bug flagged in the prior review
      round (recovery offer lagging a branch-field edit) is fixed and verified this round
      (`canOpenWorktreeRecovery` gate); no other issue found in this flow.
- [ ] With the network down, creation still succeeds and the banner says the fetch failed. (FR-7, FR-14) — **open**: no `/smoke` run this cycle to confirm the live runtime flow.
- [x] A forced `worktree add` failure leaves no session, no directory, and no stray branch. (FR-11)
- [x] The worktree session's `DIFF` shows only its own changes; the main checkout's `DIFF` is
      unaffected by them. (FR-21)
- [ ] `repo_info` returns the linked worktree's own root from inside it, on native and WSL. (FR-21) — **open**: native path covered by an automated test; the WSL path is only exercised by an `#[ignore]`d manual test, not verified this cycle.
- [ ] The branch name appears on the session card and in the status bar. (FR-13) — **open**: visual/runtime, no `/smoke` this cycle.
- [ ] The banner survives scrolling and a tab switch, and stays dismissed after dismissal. (FR-14) — **open**: dismissal persistence logic is unit-tested, but the live scroll/tab-switch behavior needs `/smoke`.
- [x] A main-checkout session with two worktree siblings shows `2 worktree sessions · <branches>`;
      a worktree session shows nothing. (FR-15)
- [ ] ⌘K → "New session in worktree…" opens the modal pre-checked. (FR-16) — **open**: live palette interaction, no `/smoke` this cycle.
- [x] Deleting a clean worktree session with removal checked deletes the directory and leaves the
      branch intact. (FR-17, FR-20)
- [x] Deleting a dirty worktree session cannot remove the directory, and the reason is shown. (FR-19)
- [ ] A WSL repo yields a Linux-path worktree and a session whose git ops all route through the same
      distro. (FR-10) — **open**: GitHost routing verified by code review + native tests; the live WSL flow needs `/smoke`.

## Remediation

### 2026-07-30 — review round 8 (1 finding, human-reported post-ship)

- [x] HIGH · `src/features/sessions/NewSessionModal.tsx:444-467` · quality (spec-violation, design brief) · The modal overlay (`alignItems: 'flex-start'`, fixed `paddingTop: 118`) and the card itself have no `maxHeight`/`overflowY` — the card grows unbounded with content. With **Isolate in worktree** checked, the Branch/Base ref/path-preview fields push the card taller than the viewport on ordinary window sizes, and since nothing scrolls, the Cancel/Create session buttons go off-screen and become **unreachable** (confirmed via screenshot: buttons visible at one window height, gone at another with the checkbox on). Fix: give the card a viewport-relative `maxHeight` (e.g. `calc(100vh - <paddingTop> - <bottom margin>)`) and `overflowY: 'auto'`, so the form scrolls internally and the action buttons stay reachable regardless of window height or which optional fields are expanded. — fixed: card given `maxHeight: calc(100vh - 118px - 24px)` + flex column; header/footer `flexShrink: 0`; form body `overflowY: 'auto'`, `minHeight: 0`, `className="scz"` — same pattern as `ProjectsModal.tsx`.

### 2026-07-30 — review round 1 (8 findings)

- 2026-07-30 — 8 findings (3 CRITICAL, 1 HIGH, 3 MEDIUM, 1 LOW), all fixed. core: `session_create` reordered so `resolve_worktree` runs last (FR-11 orphan), `compute_status` fail-safe `unpushed` when `created_branch` is false (FR-19 bypass), leading-`-` `base_ref` rejected, command-layer tests via `worktree_status_impl`/`worktree_remove_impl`. frontend: `contract/session-worktree.test.ts` slug/path parity table, sidebar remove no longer dead-ends on a status-check error, `worktreeBlocked` gated on `probe?.isRepo`, preview prefers `probe.worktreePath`.

### 2026-07-30 — review round 2 (8 findings)

- 2026-07-30 — 8 findings (2 CRITICAL, 1 HIGH, 3 MEDIUM, 2 LOW), all fixed. core: stored `Session::worktree_distro` captured at creation and threaded through `worktree_status_impl`/`worktree_remove_impl`/`claude_invocation` instead of re-deriving `GitHost` from a Linux-dialect `cwd` (FR-10 routing), leading-`-` `branch` rejected, `session_worktree_probe` rejects a non-absolute `cwd`, persistence round-trip + end-to-end probe tests, `#[ignore]`d manual live-WSL linked-worktree `repo_info` test. frontend: sticky probe state (`probing`/`probeError` + sequence guard) with a pure `worktreeCreateBlocked` helper so a transient probe failure can no longer silently drop isolation, `ConversationView` fetch-warning wrapper `span`→`div`. lead/contract: `worktree?: WorktreeCreateOptions` added to `SessionCreateInput` and `api.ts` sources it via `Pick<>`.

### 2026-07-30 — review round 3 (9 findings)

- 2026-07-30 — 9 findings (2 CRITICAL, 1 HIGH, 3 MEDIUM, 3 LOW), all fixed. core: new `adopt_host(cwd, adopt)` routes the FR-5 bare-Linux-path adopt case to the WSL default distro and `session_create`'s FR-7 precheck validates via `worktree::path_exists` instead of `std::fs::metadata` (same misclassification also fixed inside `resolve_worktree`); `worktree.rs` split into `session/worktree/mod.rs` (types, pure helpers, commands) + `session/worktree/git.rs` (git-shell helpers) with tests moved alongside; WSL fetch now invokes `… -- env GIT_TERMINAL_PROMPT=0 git fetch --prune <remote>` so FR-7 holds inside the distro; adopt with no matching `git worktree list` entry (or detached HEAD) returns `INVALID_INPUT` instead of fabricating provenance; blank `base_ref` rejected `INVALID_INPUT` in the new-branch arm; `path_exists`'s WSL branch gained a 5s spawn+poll timeout. frontend: `worktreeCreateBlocked` splits `probeIsRepo === null` (still blocks) from confirmed `false` (unblocks a plain create, per FR-1) with the two test cases corrected; `openRecoverySession` gated on a new `canOpenRecovery` mirroring `canCreate` plus `!recovering`, with the link dimmed/no-op while disabled; `ConversationView` hoists `fetchWarning`.

### 2026-07-30 — review round 5 (6 findings)

- 2026-07-30 — 6 findings (3 MEDIUM, 3 LOW), all fixed. core: `resolve_worktree` re-probes the branch via a new `probe_branch` helper immediately before `git worktree add` — after the up-to-20s fetch, not only before it — and remaps git's own "already used by worktree at '<path>'" stderr to `WORKTREE_BRANCH_IN_USE`, so the §7 probe→create race that opens during the fetch window still reaches FR-5's recovery offer (reversal keeps `created_branch: false`, never deleting a foreign branch); a pure `removal_block_reason` renders the `unpushed: true / count: 0` sentinel as "push status unknown — no upstream configured"; `worktree_slug` mirrors the contract's `WORKTREE_SLUG_FALLBACK` (`branch`) before the `-2`/`-3` suffix search; duplicated FR-9 comment tail dropped from `commands.rs`. frontend: the New Session probe is now cwd-keyed (`WorktreeProbeState { cwd, data, errored }` read through a pure `liveWorktreeProbe`), so a cwd change invalidates the previous repo's probe in the same render — no stale `isRepo`/branch/hint/path and no FR-1 gap during the debounce window, while the within-cwd sticky behaviour survives; `worktreeRemovalBlockReason` gained the same unknown-push sentinel branch; the remove-worktree checkbox derives from the functional-update parameter. lead/contract: `worktreeSlug` falls back to the newly exported `WORKTREE_SLUG_FALLBACK` on an empty slug (parity table + spec FR-9 updated) and `WorktreeStatusData` documents `unpushed: true && unpushedCount === 0` as the canonical "push status unknown" sentinel (mirrored into spec §5).

### 2026-07-30 — review round 6 (7 findings)

- [x] CRITICAL · `src-tauri/src/session/worktree/git.rs:284-296` · spec-violation/correctness · `path_exists`'s WSL arm passed a `\wsl$\…` UNC path verbatim to `test -e` inside the distro, so FR-7's cwd precheck failed for **every** WSL session (regressing plain WSL creation, making FR-10 unreachable). — fixed: new pure `wsl_test_argv(distro, path)` routes through `wsl_cd_target` before `test -e` (`worktree/git.rs:276-314`); argv regression test (UNC vs. bare-Linux) at `worktree/git.rs:521-549`, mirroring `diff/git.rs`'s since wsl.exe can't run in CI.
- [x] LOW · `src-tauri/src/session/worktree/git.rs:374-379` · quality · A failed `rev-list` against a *real* upstream was indistinguishable from the genuine no-upstream sentinel, so the block reason claimed "no upstream configured". — fixed: `removal_block_reason` now branches on `status.upstream` and renders `push status unknown — could not compare with <upstream>` (`worktree/mod.rs:581-601`); test at `worktree/tests.rs:137-155`. `compute_status`'s `(true, 0)` wire sentinel deliberately left intact (contract/spec §5).
- [x] LOW · `src-tauri/src/session/worktree/mod.rs:70-76` · spec-violation (minor) · `base_ref` carried `#[serde(default)]` against a contract-required `baseRef`, coercing an omitted field to `""`. — fixed: `#[serde(default)]` dropped (`worktree/mod.rs:67-82`, only `adopt` stays optional); serde round-trip test at `worktree/tests.rs:157-181`. Verified the frontend always sends `baseRef`, so no live caller breaks.
- [x] MEDIUM · `src/features/sessions/NewSessionModal.tsx:342-386,775-787` · spec-violation · §7's probe→create race stacked the raw `WORKTREE_BRANCH_IN_USE` red banner on top of FR-5's amber recovery offer. — fixed: new pure `submitErrorBanner` (`features/sessions/worktree.ts:130-140`) suppresses the error *at set time* when the race error carries a usable `detail.path`, so the red banner can't even flash for a frame (`NewSessionModal.tsx:353`); a path-less `WORKTREE_BRANCH_IN_USE` still surfaces as an error. Test at `features/sessions/worktree.test.ts:373-393`.
- [x] LOW · `src/features/diff/DiffView.tsx:417-433` · quality · Truncated FR-15 sibling line carried no `title`, violating the design brief §Notes. — fixed: `title={siblingLine}` at `features/diff/DiffView.tsx:300-302`.
- [x] LOW · `src/features/conversation/ConversationView.tsx:358,365` · quality · Dead `var(--warn, #d9a441)` fallback matching neither theme's real token. — fixed: bare `var(--warn)` at `ConversationView.tsx:355-356`, plus the same dead fallback in `NewSessionModal.tsx:737,741` and `Sidebar.tsx:600`; zero `d9a441` occurrences remain in `src`.
- [x] LOW · `.gitignore:9-11`, `CLAUDE.md:3`, `PIPELINE.md:31-38` · quality · **lead-owned, commit hygiene — no code change.** Ignoring `.claude/pipeline-metrics.jsonl`, the `thebidouille-agents`→`cohorte` rename, and the `gate.ask`→`ask_on_default_branch` split trace to nothing in this spec; they are pipeline-tooling churn bundled into the feature diff. — fixed: split into commit `9daf27e` ("chore: refresh cohorte pipeline core to 1.2.2") on `feat/session-worktree`, ahead of the feature commit.

### 2026-07-30 — review round 4 (4 findings)

- 2026-07-30 — 4 findings (2 CRITICAL, 2 LOW), all fixed. core: `resolve_worktree` now discards a `remote_name` starting with `-` (treated as "no usable remote") and `fetch_with_timeout` inserts a `--` separator before the positional remote in both the native and WSL argv, closing the git-argument-injection class for `remote` the way round 3 closed it for `branch`/`base_ref`, with a regression test writing a hostile `[remote "--upload-pack=…"]` section straight into `.git/config`; the two `#[cfg(test)]` blocks moved out of `mod.rs` into a sibling `session/worktree/tests.rs` (mod.rs 597 / tests.rs 567 / git.rs 486 lines, all under the ~1000-line cap). frontend: new pure `worktreeBranchInUsePath` helper narrows `AppError.detail` and `createSession`'s error branch merges the race-time `WORKTREE_BRANCH_IN_USE` path into `probe.branchCheckedOutAt`, so §7's probe→create race reuses FR-5's recovery offer instead of dead-ending on a red banner; the duplicate local `basename()` dropped for the shared `basenameOf`.

### 2026-07-30 — review round 7 (2 findings)

- [x] MEDIUM · `src/features/sessions/NewSessionModal.tsx:274,320,408-411,754` · spec-violation · `worktreeRecoveryPath` (FR-5's "already checked out" offer) is derived straight from the cwd-scoped `probe` (`liveWorktreeProbe` only invalidates on **cwd** change, not on **branch** change — see `src/features/sessions/worktree.ts:105-111`). When the user edits the `branch` field, `probing` flips `true` immediately (blocking plain `Create` via `worktreeCreateBlocked`), but `canOpenRecovery` (line 320) and the "Open a session there instead" `onClick` (line 754) check only `name`/`modelId`/`projectRootMissing`/`submitting`/`recovering` — never `probing` or `probeError`. — fixed: new pure `canOpenWorktreeRecovery(state)` (`features/sessions/worktree.ts:87-120`) mirrors `worktreeCreateBlocked`'s staleness rule (blocks while `probing`/`probeErrored`), wired into `NewSessionModal.tsx`'s `canOpenRecovery`. Test: 5 new cases in `features/sessions/worktree.test.ts`.
- [x] MEDIUM · `src/features/sessions/NewSessionModal.tsx:719-733`, `src/features/diff/DiffView.tsx:299-315` · spec-violation · The design brief (`specs/design/session-worktree.md` §"Narrow window") requires the worktree path preview and the DIFF sibling line to middle- or left-truncate long values (so the meaningful tail stays visible), the same way the FR-13 branch chip is deliberately left-truncated via `truncateBranchLeft`. Both instead use plain right-ellipsis CSS, cutting off the tail rather than the front. — fixed: `direction: 'rtl'; textAlign: 'left'` added alongside the existing `nowrap`/`overflow`/`ellipsis` on `worktreePreview` (`NewSessionModal.tsx`) and `siblingLine` (`DiffView.tsx`), left-truncating via the browser's own ellipsis engine. No unit test — pure CSS/visual change, layout is not unit-tested per §Testing.
