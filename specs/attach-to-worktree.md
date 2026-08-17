---
id: attach-to-worktree
title: Attach a session to an existing worktree
status: shipped
branch: feat/attach-to-worktree
created: 2026-08-13
depends_on: [session-worktree, session-engine, sessions-sidebar, projects, app-shell]
loop_pass: 0
loop_phase:
reviewed_base:
reviewed_digest:
design_files: [] # none by decision (2026-08-13): §8 brief + specs/design/attach-to-worktree.md is the design source
---

# Attach a session to an existing worktree

## 1. Summary

`session-worktree` can already open a session at a worktree it does not create — `session_create`
takes `worktree.adopt = true`, performs no git mutation, and fills provenance from
`git worktree list --porcelain`. Today that path is reachable only by accident: you have to type a
branch that happens to be checked out somewhere else, and the form offers to open a session there
(session-worktree FR-5). Every other existing worktree is invisible — trees you made by hand, trees
left behind when a session was deleted, trees a teammate's script created. This feature surfaces the
list. The New Session modal's WORKTREE group becomes a three-state mode — off · **create** ·
**attach** — and attach mode renders a picker of the repo's linked worktrees. Picking one opens the
session there, with no git mutation and no new session-side machinery: it is the existing adopt path,
finally given a door.

## 2. Goals & non-goals

**Goals**

- Every linked worktree of the chosen repo is reachable in one click from New Session.
- Attaching mutates **no** git state — no prune, no fetch, no add, no branch created.
- Nothing is hidden: a detached-HEAD tree, a locked tree and a tree whose directory is gone are all
  listed, annotated for what they are.
- Zero cost on the non-attach paths: the list rides on the probe that already runs (FR-4), so a plain
  create pays one extra `git worktree list` on a call it was making anyway.

**Non-goals**

- A worktree inventory / manager / orphan sweeper. session-worktree §7 rejected one deliberately and
  this spec does not reopen it — the picker is scoped to the chosen repo and lives inside New Session.
- New entry points. No palette command, no sidebar context-menu item, no standalone modal.
- Per-tree richness: no dirty count, no ahead/behind, no last-commit subject in the rows. Each costs
  a git invocation per tree (a `wsl.exe` spawn apiece on WSL) on a debounced path.
- Changing deletion. session-worktree FR-17..FR-20 already cover a session with `worktree`
  provenance, adopted or not, and keep their hard block on dirty/unpushed.
- Creating, moving, pruning or repairing worktrees from the picker.

## 3. User stories / flows

**Attach.** In New Session the user picks a cwd that is a git repo. The WORKTREE group shows two
chips: **Isolate in worktree** and **Attach to existing**. Clicking the second replaces the
branch/base-ref fields with a list of the repo's linked worktrees — one row per tree, showing its
branch (or `HEAD @ 1a2b3c4` when detached) and its path. Picking a row fills the session name if it
was still empty, and shows the resolved cwd underneath. Create → the session opens in that directory.

**Already in use.** A row whose directory is the cwd of a live session is annotated
`in use by "<session name>"`. It stays selectable — a read-only review session beside a working one
is a real use — and selecting it adds a one-line caution under the picker.

**Nothing to attach to.** The repo has no linked worktrees. The **Attach to existing** chip renders
disabled with the hint `no other worktrees in this repo`; **Isolate in worktree** is unaffected.

**Gone.** A row's directory was deleted outside Francois (`prunable`). It is listed, disabled, and
annotated `directory missing`.

## 4. Functional requirements

**Probe & list**

- **FR-1** `WorktreeProbeData` gains `worktrees: WorktreeListEntry[]` (§5), filled from
  `git worktree list --porcelain` on the same call session-worktree FR-1 already makes. No new IPC
  verb, no per-tree git invocation, no debounce change.
- **FR-2** The list **excludes** the main working tree — always the first `--porcelain` block — and
  any `bare` entry. Order is git's own, verbatim; the frontend does not re-sort.
- **FR-3** Each entry carries `path`, `branch` (null on detached HEAD), `head` (the full sha, null
  when git reports none), `detached`, `locked`, `prunable`. The parser must read the `HEAD <sha>`,
  `detached`, `bare`, `locked` and `prunable` lines that `worktree_list_entries` currently discards
  (`src-tauri/src/session/worktree/git.rs:140`).
- **FR-4** `worktrees` is `[]` — never absent — when `isRepo` is false or git fails. Listing is
  never an error of its own; a failed `worktree list` degrades to an empty picker.

**Mode**

- **FR-5** The WORKTREE group is a three-state mode: `off` · `create` · `attach`, rendered as two
  mutually exclusive chips. Selecting one deselects the other; clicking the selected one returns to
  `off`. session-worktree FR-1 still governs the whole group: on a non-repo cwd it is **absent**.
- **FR-6** The **Attach to existing** chip is **disabled** with the hint `no other worktrees in this
  repo` when `worktrees` is empty. It is disabled, not absent — the repo is a repo, so the concept
  applies and only the inventory is empty. (This is the one deliberate departure from FR-1's
  absent-never-disabled rule, which governs the group as a whole.)
- **FR-7** `attach` mode hides the branch, base-ref and path-preview fields entirely, and suppresses
  session-worktree FR-5's recovery offer (there is nothing to recover from — no branch is being
  created).
- **FR-8** The command palette's "New session in worktree…" (session-worktree FR-16) still opens the
  modal in `create` mode. It is unchanged by this feature.

**Picker**

- **FR-9** One row per entry: the branch name, or `HEAD @ <short sha>` when `detached` (7 chars from
  `head`; `HEAD @ ?` when `head` is null). Below it, `path`, left-truncated with the full value in
  `title` — the same treatment as the FR-9 path preview and the FR-13 branch chip.
- **FR-10** A row is annotated `in use by "<name>"` when a live session's `cwd` normalizes to its
  `path` (matching on `cwd`, not on `worktree.path`, so a session opened there without worktree
  provenance still counts). Normalization uses projects' `isPathInside`-grade case rules. The row
  stays **selectable**; selecting it shows one caution line under the picker: `two sessions in one
  worktree share a checkout — their DIFF and commits will mix`.
- **FR-11** A row with `prunable` is rendered **disabled** and annotated `directory missing`. A row
  with `locked` is selectable and annotated `locked`.
- **FR-12** Selecting a row fills the session name with the row's branch (or short sha) **only if the
  name is still empty and untouched** — same touched-flag discipline as session-worktree FR-2's
  branch prefill. It never overwrites a typed name.
- **FR-13** The resolved session cwd is shown under the picker as a dim read-only line. The modal's
  own directory field keeps showing the **source repo** — that is what the probe keys on.

**Creation**

- **FR-14** Create in `attach` mode calls `session_create` with `worktree: { branch: '', baseRef: '',
  adopt: true }` and `cwd` = the selected row's `path`. `branch`/`baseRef` are required on the wire
  and **ignored** under `adopt` (the core fills provenance from `git worktree list`) — the frontend
  sends empty strings and must not guess.
- **FR-15** The adopt arm of `resolve_worktree` no longer errors on a detached HEAD
  (`src-tauri/src/session/worktree/mod.rs:335`). It fills `branch` with the 7-char short sha and sets
  `detached: true`. It still errors `INVALID_INPUT` when no `git worktree list` entry matches the
  path, and now returns `WORKTREE_NOT_FOUND` when the matching entry is `prunable`.
- **FR-16** Every adopt-created `SessionWorktree` sets `adopted: true`. `createdBranch` stays `false`.
- **FR-17** Create is blocked while `attach` mode is on and: a probe is in flight or the last one
  errored (unchanged staleness rule), **or** no row is selected, **or** the selected `path` is absent
  from the current `worktrees` (a re-probe invalidated it). The selection is cleared on a cwd change,
  exactly as the probe is.

**Session UI**

- **FR-18** session-worktree FR-14's "nothing came along" banner is **suppressed** when
  `worktree.adopted` is true. Francois did not create the tree and makes no claim about what is in
  it; asserting that no dependencies were installed would be false for a tree the user set up by hand.
- **FR-19** The FR-13 branch chip renders `HEAD @ <short sha>` for a `detached` worktree and the
  branch name otherwise. `truncateBranchLeft` applies unchanged.
- **FR-20** Everything else session-worktree gives a worktree session applies with no work: the
  sidebar/status-bar chip (FR-13), the DIFF sibling line (FR-15), and the delete-confirm removal step
  with its dirty/unpushed hard block (FR-17..FR-20).

## 5. API contract

Extends `contract/session-worktree.ts` and `contract/common.ts` — no new domain, no second file for
the `session` domain (decisions 2026-08-04 · api).

**`contract/common.ts` — `SessionWorktree` gains two optional fields**

```ts
export interface SessionWorktree {
  // … existing fields unchanged …
  /** FR-15: the tree has a detached HEAD; `branch` carries the 7-char short sha, not a ref. */
  detached?: boolean;
  /** FR-16: the tree was adopted, not created by Francois (suppresses the FR-14 banner). */
  adopted?: boolean;
}
```

No new `ErrorCode` members. No new `SessionEvent` members — provenance still rides `session.meta`.

**`contract/session-worktree.ts`**

```ts
/** FR-1/FR-3: one linked worktree of the probed repo, from `git worktree list --porcelain`. */
export interface WorktreeListEntry {
  path: string;           // absolute, host dialect (session-worktree FR-10)
  branch: string | null;  // null on detached HEAD
  head: string | null;    // full sha; null when git reports none (unborn HEAD)
  detached: boolean;
  locked: boolean;
  prunable: boolean;      // the directory is gone; FR-11 disables the row
}

export interface WorktreeProbeData {
  // … existing fields unchanged …
  /** FR-1/FR-2: linked worktrees, main checkout and bare entries excluded. [] when isRepo is
   *  false or `git worktree list` failed — never absent, never an error. Git's own order. */
  worktrees: WorktreeListEntry[];
}

/** FR-14. `branch` and `baseRef` stay required on the wire and are IGNORED under `adopt`. */
// WorktreeCreateOptions is unchanged.
// invoke('session_create', { cwd: <entry.path>, worktree: { branch: '', baseRef: '', adopt: true } })
// added error under adopt: 'WORKTREE_NOT_FOUND' (the entry is prunable — FR-15)
```

**Pure frontend helpers** — `src/features/sessions/worktree.ts`, unit-tested. Nothing here is
mirrored by the core, so none of it belongs in the contract file.

```ts
export type WorktreeMode = 'off' | 'create' | 'attach';

/** FR-9/FR-10/FR-11: one picker row, ready to render. */
export interface WorktreeRow {
  path: string;
  /** branch name, or `HEAD @ 1a2b3c4` when detached (`HEAD @ ?` when head is null). */
  label: string;
  /** FR-10: the live session already sitting in this directory, if any. */
  inUseBy: string | null;
  locked: boolean;
  /** FR-11: prunable ⇒ the row is disabled. */
  disabled: boolean;
  /** `directory missing` · `locked` · `in use by "x"`, joined with ` · `; '' when none apply. */
  note: string;
}

/** FR-9..FR-11. `sessions` is the live roster; `caseInsensitive` mirrors projects' path rules. */
export function worktreeRows(
  entries: WorktreeListEntry[],
  sessions: SessionMeta[],
  caseInsensitive: boolean,
): WorktreeRow[];

/** FR-12: the name to prefill from a selected row — the row's label. */
export function attachNamePrefill(row: WorktreeRow): string;

/** FR-17: the attach half of the Create gate. Mirrors `worktreeCreateBlocked`'s staleness rule. */
export interface WorktreeAttachGateState {
  mode: WorktreeMode;
  probing: boolean;
  probeErrored: boolean;
  selectedPath: string | null;
  rows: WorktreeRow[];
  caseInsensitive: boolean;
}
export function worktreeAttachBlocked(state: WorktreeAttachGateState): boolean;

/** FR-19: the chip/status-bar label for a session's worktree. */
export function worktreeChipLabel(worktree: SessionWorktree): string;
```

`worktreeCreateBlocked` keeps its current signature and semantics; the modal's gate becomes
`worktreeCreateBlocked(…) || worktreeAttachBlocked(…)`, each governing its own mode.

## 6. Data & state

- **Core**: no new state, no new cache, no new persistence. `WtEntry`
  (`src-tauri/src/session/worktree/git.rs:131`) gains `head`/`detached`/`locked`/`prunable`/`bare`;
  `worktree_list_entries` fills them. `SessionWorktree`'s two new fields persist with the session in
  `sessions.json` exactly like the existing ones, and a session persisted before this feature reads
  back with both absent (⇒ falsy) — correct for every pre-existing session.
- **Frontend**: `useWorktreeGroup` replaces its `worktreeEnabled: boolean` with `mode: WorktreeMode`
  and adds `selectedPath: string | null`, cleared on every cwd change alongside the probe. Rows are
  **derived** from `probe.worktrees` + the live roster on each render — never stored.

## 7. Edge cases & errors

| Case | Behavior |
|---|---|
| cwd is not a git repo | Whole WORKTREE group absent (session-worktree FR-1). |
| Repo has no linked worktrees | **Attach to existing** disabled + hint (FR-6). |
| `git worktree list` fails | `worktrees: []` ⇒ same as the empty case. Never an error (FR-4). |
| Detached HEAD | Listed as `HEAD @ <sha>`, attachable; provenance carries `detached: true` (FR-15). |
| Unborn HEAD (`head` null) | Listed as `HEAD @ ?`, attachable; the session opens, git ops behave as they do in any commit-less repo. |
| Locked worktree | Selectable, annotated `locked` (FR-11). Francois runs no git mutation, so the lock is irrelevant to attaching. |
| Prunable (directory gone) | Row disabled (FR-11). If picked via a race, `session_create` returns `WORKTREE_NOT_FOUND` (FR-15) and the form re-probes. |
| Tree already has a live session | Selectable, annotated, caution line on selection (FR-10). Never blocked. |
| Tree removed between probe and create | `WORKTREE_NOT_FOUND` or `INVALID_INPUT` from the adopt arm; the form surfaces it and re-probes. |
| cwd changed while a row is selected | Selection cleared with the probe; Create blocked until a new row is picked (FR-17). |
| WSL repo | Paths come back Linux-dialect from `git worktree list` run inside the distro; `adopt_host` already routes a bare-Linux adopt path to the WSL default distro (session-worktree round-3 remediation). Unchanged. |

## 8. Design brief

> full brief: `specs/design/attach-to-worktree.md`

One surface, inside existing chrome: the New Session modal's **WORKTREE** group. Its single
"Isolate in worktree" chip becomes a two-chip mutually-exclusive row; the second chip swaps the
branch/base-ref/preview block for a scrollable picker of worktree rows (label + left-truncated path +
annotation), a caution line, and a dim resolved-cwd line. Everything else in the modal is untouched.
Tokens, glyphs and motion from `Francois Redesign.dc.html` / `Francois Design System v2.dc.html`.

## 9. Acceptance criteria

- [ ] On a repo with linked worktrees, **Attach to existing** lists every one of them except the main
      checkout, in git's order. (FR-1, FR-2)
- [ ] On a repo with none, the chip is disabled with `no other worktrees in this repo`, and
      **Isolate in worktree** still works. (FR-6)
- [ ] Picking a row and creating opens the session in that directory, and `git worktree list` /
      `git status` in the source repo are byte-identical before and after. (FR-14)
- [ ] A detached-HEAD tree lists as `HEAD @ <sha>`, attaches, and its session chip reads the same.
      (FR-9, FR-15, FR-19)
- [ ] A tree whose directory was deleted lists disabled with `directory missing`, and cannot be
      picked. (FR-11)
- [ ] A tree that already has a live session lists with `in use by "<name>"`, is still selectable,
      and shows the caution line when selected. (FR-10)
- [ ] Picking a row fills an empty session name with the branch, and never overwrites a typed one.
      (FR-12)
- [ ] Changing the cwd clears the selection and re-blocks Create. (FR-17)
- [ ] An attached session shows **no** "nothing came along" banner; a Francois-created one still
      does. (FR-18)
- [ ] An attached session's DIFF shows only that tree's changes, and it appears in the main
      checkout's sibling line. (FR-20)
- [ ] Deleting an attached clean session offers worktree removal; a dirty one hard-blocks. (FR-20)
- [ ] A pre-existing worktree session (persisted before this feature) reads back with no `detached`
      / `adopted` and behaves exactly as before. (§6)

## Remediation

### 2026-08-13 — review round 1

- 2026-08-13 — 8 findings (1 CRITICAL, 1 HIGH, 3 MEDIUM, 3 LOW), all closed.
  One was a **false positive, deliberately not changed**: the `scz` class on `.worktree-field__picker`
  is the shared thin-scrollbar utility (`src/styles.css:522`) used by every scrollable list in the app —
  removing it regresses the picker's scrollbar.