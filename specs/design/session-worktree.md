# DESIGN BRIEF — Open session in worktree (`session-worktree`)

> The "spec return". Paste into the design tool (see `PIPELINE.md` §design). This is §8 of
> `specs/session-worktree.md`, standalone.

**Goal:** When creating a session on a git repo, the user can put it in its own git worktree on a new
or existing branch — so several Claude sessions on one repo stop fighting over a single checkout —
and can always tell, at a glance, which branch a given session's `DIFF` belongs to.

**Design system:** use the existing UI kit (`src/`, tokens in `src/styles.css`). The visual source of
truth is `Claude Terminal.dc.html` + `screenshots/`. This is a **native desktop terminal app** —
JetBrains Mono throughout, dense, keyboard-first, no rounded-card web idiom. Nothing here is a new
screen; every element lands inside existing chrome.

## Screens / views

### 1. New Session modal — worktree group (primary surface)

Purpose: opt into isolation and name the branch. Sits below the existing cwd / name / model /
permission-mode controls, above the create button.

- Elements
  - **Checkbox row** `[ ] Isolate in worktree` with a one-line dim hint: *"runs this session in its
    own git worktree"*.
  - **Branch** — text input, prefilled `feat/<session-name-slug>`, monospace.
  - **Base ref** — text input, prefilled with the repo's default branch (e.g. `main`).
  - **Path preview** — dim, non-interactive, single line, middle-truncated:
    `…/.francois-worktrees/francois/feat-auth`.
  - **Inline notice slot** — one line, appears under the branch field.
- States
  - **Absent** — cwd is not a git repo. The whole group is *not rendered*; the modal must not leave a
    gap or show a disabled control.
  - **Collapsed** — checkbox unchecked; branch / base / preview hidden. Default.
  - **Expanded** — the three fields + preview visible.
  - **Probing** — cwd just changed; the checkbox row may render with the fields in a brief skeleton
    or dim state. Must not flicker on every keystroke (probe is debounced).
  - **Existing branch** — notice: *"existing branch — will be checked out"*; the Base ref input goes
    disabled/dim. Informational, not a warning.
  - **Already checked out (recovery)** — the emphasis state of this screen. Notice reads
    *"`feat/auth` is already checked out at `<path>`"* with a primary action **Open a session
    there instead**. While this is showing, the normal create action is suppressed — the user picks
    the recovery action or edits the branch name. Use the attention/amber token, not the error token:
    this is an offer, not a failure.
  - **Invalid branch** — error token, git's own reason inline (e.g. *"invalid ref name"*); create
    disabled.
  - **Creating** — the modal's existing pending state; worktree creation can take a few seconds
    because of the fetch, so the pending affordance must be visible (this is longer than a normal
    session create).

### 2. Session card (pane [1]) + status bar — branch identity

Purpose: tell sessions apart when several are open on one repo.

- Elements: a branch glyph followed by the branch name, in the card's secondary/meta row alongside
  the existing cwd/status info; the same pair in the app-shell status bar for the focused session.
- States
  - **Worktree session** — glyph + branch, truncated from the left if long (`…/feat/auth-refactor`),
    full value in the title attribute.
  - **Normal session** — nothing added. The card layout must not shift between the two.

### 3. SESSION tab — bare-checkout banner

Purpose: state plainly that this tree is not a copy of the parent checkout, including the safety
consequence. This is the one element the spec calls out as prominent-on-purpose.

- Elements: a pinned, full-width strip **above the transcript** (not a transcript block — it must not
  scroll away). Warning/attention token, one dim body paragraph, a dismiss `×` at the right.
  - Body: dependencies were **not** installed; local-scope config
    (`.claude/settings.local.json`, local `.mcp.json`) was **not** carried over, so permission rules
    and MCP servers may differ from the parent checkout.
  - Optional extra line when the fetch failed: *"could not fetch — forked from local `main`"*.
- States: **visible** · **dismissed** (gone for good for that session) · **fetch-warning variant**
  (the extra line present). Dismissal should feel deliberate — no auto-dismiss, no timer.

### 4. DIFF tab — sibling line

Purpose: on a **main-checkout** session, hint that worktree siblings exist so the user does not
wonder where the other work went.

- Elements: one dim line in the DIFF header area:
  `2 worktree sessions · feat/auth, feat/parser`. Read-only — **no links, no buttons, no hover
  affordance**. Overflow truncates the name list with an ellipsis.
- States: **hidden** (zero siblings, or this session is itself a worktree session) · **visible**.

### 5. Delete-session confirm — worktree removal step

Purpose: never destroy uncommitted work, and never silently leave a directory behind either.

- Elements: the existing confirm gains one checkbox row: `[ ] Also remove the worktree at <path>`
  (path dim, middle-truncated), default **off**.
- States
  - **Clean** — checkbox enabled, default off.
  - **Blocked** — checkbox **disabled** with the reason rendered next to it in the warning token:
    *"3 uncommitted files"* / *"2 commits not on origin/feat/auth"* (both when both apply). There is
    no override control — do not design an "I'm sure" escape hatch.
  - **Gone** — the directory no longer exists: no checkbox, one dim line *"worktree already removed"*.
  - **Checking** — a brief pending state while the dirty/unpushed probe runs.
  - **Removal failed** — after confirm: the session is gone and an error toast reports the failure.

## Flows

1. New Session → pick a repo cwd → **Isolate in worktree** appears → check it → branch + base
   prefilled, path previewed → Create → the session opens on the new branch, card shows it, banner
   sits above the transcript.
2. Same, but the typed branch already exists → the notice switches to "existing branch", base ref
   dims → Create checks it out into the new tree.
3. Same, but the branch is checked out elsewhere → recovery notice → **Open a session there
   instead** → a session opens at that path with no git mutation.
4. ⌘K → **New session in worktree…** → the modal opens with the checkbox already checked (flow 1
   from step 3 onward).
5. Delete a worktree session → confirm gains the removal checkbox → clean: check it, the directory
   goes, the branch stays → dirty: checkbox disabled with the reason, the session goes, the directory
   stays.

## Responsive

Fixed desktop app window, not mobile-first. What matters is **resize**, not breakpoints:

- **Narrow window** — the path preview, the sibling line and the branch name all middle- or
  left-truncate rather than wrap. The modal's worktree group stacks; no horizontal scrolling.
- **Wide window** — no layout change; fields keep the modal's existing max width.
- The banner is always full content width and wraps its body text.

## Data shown

Matches `specs/session-worktree.md` §5 exactly:

- Modal: `branch`, `baseRef`, previewed `worktreePath`, and from the probe — `defaultBranch`,
  `branchExists`, `branchCheckedOutAt`.
- Card / status bar: `worktree.branch`.
- Banner: fixed copy + `worktree.fetchError`, `worktree.baseRef`.
- Sibling line: count + `worktree.branch` of each sibling.
- Delete step: `worktree.path`, `dirtyCount`, `unpushedCount`, `upstream`.

## Notes / constraints

- **Copy in English** (profile `ui_language`), lowercase-terminal register consistent with the mock.
- Paths and refs are **monospace and never re-cased** — `feat/Auth` stays `feat/Auth`.
- Accessibility: the disabled removal checkbox must expose its reason to assistive tech (not
  colour-only); the banner is a live region on first render; every truncated value carries its full
  text in a title attribute.
- **Do not design a worktree manager.** No list view, no inventory modal, no per-tree remove buttons
  anywhere outside the delete-session confirm. The sibling line (screen 4) is deliberately inert —
  that restraint is a decision, not an oversight.
- Motion: reuse the modal's existing reveal for the expanded group; no new animation vocabulary.
