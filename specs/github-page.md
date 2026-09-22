---
id: github-page
status: frozen
depends_on: [app-shell, overview, session-worktree, attach-to-worktree, diff-view, projects, wsl-filesystem]
contract: contract/github-page.ts
design: Figma YEY4c6AiWq1bKYuaju9qdV — 29 `160:15836` (PRs), 30 `161:15989` (Commits), 31 `162:16108` (Branches & worktrees); light twins L29 `162:26199`, L30 `162:26607`, L31 `162:26965`
---

# github-page — the app-bar GitHub view

## 1. Goal

A third top-level destination beside **Overview** and **Sessions**: one repo's pull requests,
commits and branches/worktrees, each tied back to the session that produced it. Francois reads,
opens, updates, fixes and — behind a confirm — merges a clean PR (FR-5a); it never rewrites history,
force-pushes, or deletes a remote ref the user did not ask it to.

## 2. Scope

- **Repo in scope**: the active project's root; with no active project, the active session's cwd;
  with neither, an EmptyPane ("Open a project to see its repository").
- **Data**: git via the core (always); pull requests, reviews and checks via the GitHub CLI `gh`
  (optional). Without `gh` the PR tab explains why (`GhStatus`) and the Commits/Branches tabs still work,
  minus PR numbers and checks.
- **Session linkage**: frontend joins `SessionMeta.worktree.branch` (`src/features/github/linkage.ts`).
  No Cohorte "run" concept exists in the app — the design's `run_…` chips are **not** rendered.

## 3. Functional requirements

### Shell
- FR-1 App bar gains a **GitHub** nav pill after Sessions; `MainTab` gains `'github'`, which behaves
  like `'overview'` (app-scoped, full main pane, no session header/panel). Palette command "Open GitHub".
- FR-2 Repo header (60px): `owner/` muted + `name` strong; remote chip (`cloud` icon, `<host> · <remote>`);
  meta line `<currentBranch> · up to date | ↑n ↓m · fetched <relative>`. Right: segmented tabs
  **Pull requests** (count = open PRs) · **Commits** · **Branches** (count = non-default branches) ·
  **Checks** (disabled, title "Coming soon"); Fetch icon button (spins while fetching, calls
  `github_fetch`, then refreshes the active tab); primary **New pull request** → opens
  `<webUrl>/compare/<currentBranch>?expand=1` (disabled without `webUrl`).
- FR-3 The selected tab persists for the app run (store), not across restarts.

### Pull requests (frame 29)
- FR-4 Left rail 432px: filter input (client-side, matches title / #number / head), rows: state icon
  (open/draft/merged/closed), title (ellipsis), state chip right (`n check(s) failing` danger ·
  `checks passed` success · pending neutral · none when no checks), meta `#n head → base` + relative
  time, origin line: session chip (cyan, terminal icon, session name) when linked + right-aligned review
  text (`n change(s) requested` attention · `approved · ready to merge` success · `draft` faint ·
  `merged by you|<login>` faint). Selected row = `--bg-selected`. Footer hint with info icon.
- FR-5 Detail: title + `#n`, PR state chip; meta `head → base · opened <rel> by you|login · N files +a −d`,
  ghost **Open on GitHub**. Left column cards: **Checks** (rollup chip + "CI · GitHub Actions", rows with
  icon/name/duration or failure summary + ghost **View log** → detailsUrl; danger foot when a check
  failed with primary **Fix in a new session**), **Files changed** (top 4, comments/failing notes,
  `+a −d`, "N more files"; secondary **Review in François** → opens the linked session's DIFF tab,
  disabled when no linked session), **Review** card (changes-requested chip + unresolved count, newest
  comment with avatar initials, author, `path:line`, relative time, body; ghost **Reply** → comment url).
  Right column 284px: **Where this came from** (linked session card → selects that session; hidden when
  none), **Pull request** key/values (Reviewers, Labels, Milestone, Head sha, Mergeable — `blocked`
  danger), **Actions**: Merge (an open PR with mergeable = clean opens the in-app confirm, FR-5a; anything
  else opens the PR on GitHub; label `Merge · blocked by checks` + 45% opacity when mergeable ≠ clean), **Update branch from main** (`github_update_pull_branch`, disabled
  unless mergeable = behind|blocked), **Open a session on this branch** (spawns a session attached to the
  branch's worktree, or creates a worktree session on the branch), footnote.
- FR-5a **Merge in-app** (`francois:github:mergePull` → `github_merge_pull`, `gh pr merge <n> --<method>`).
  A confirm modal names `#n head → base` and the title, offers the repo's allowed methods as radios in
  the order squash · merge · rebase (GitHub's labels; the first allowed one preselected; all three when
  the repo settings can't be read), and an unchecked **Delete `<head>` on GitHub** box (hidden for a
  fork's head). The confirm button reads the chosen method. A refusal (branch protection, required
  reviews, a moved head) shows gh's error inline and leaves the modal open. On success the detail and
  the list re-fetch; the modal closes, or stays to report the branch delete. The core never passes
  `--delete-branch` (it would delete the local branch and switch the checkout); it deletes only the
  remote head through the refs API, and refuses for a fork's head, the base, or the default branch. A
  failed delete is reported beside the merge (`MergeOutcome.branchDeleteError`), never as a failed
  merge. Local branches and worktrees stay for the Branches tab's prune.
- FR-6 **Fix in a new session** spawns a session on the PR head branch whose first message names the
  failing checks and asks to fix them.

### Commits (frame 30)
- FR-7 Left rail: branch select (branch icon, ref, `N commits`, chevron → menu of local branches),
  toggle **From sessions** (filters to `byAgent`). Rows grouped by day (TODAY / YESTERDAY / date), title,
  check glyph right when checks are known for the selected commit only, meta `shortSha` + origin chip
  (session chip when the commit's ref is a session branch and the commit is agent-written; otherwise
  `by hand` for non-agent commits, `agent` neutral chip for agent commits without a linked session) +
  time (`2 h ago` today, `yesterday HH:MM`, date older). Footer hint.
- FR-8 Detail: subject, checks chip; meta `shortSha · on <branch> · in #pr · you|author, <rel>`, ghost
  **Open on GitHub**. **Origin** card when a session is linked: "Written by session <name>", secondary
  **Open transcript** (selects the session), stats (model, worktree display path); the "Your instruction"
  block shows the last user message sent before `committedAt` when that session's transcript is in memory,
  else is omitted. **Diff** card: first file path `+a −d`, `1 of N files`, **Review in François** (as FR-5),
  diff lines with line numbers (del/add tints), other files strip. Right: **Checks on this commit**
  (omitted without gh), **Commit** key/values (Parent, Signed, Branch, On main yes/no, Pull request),
  **Actions**: primary **Continue this session** (only when linked), secondary **Start a session from
  this commit** (new worktree session based at the sha), **Copy sha**; footnote.

### Branches & worktrees (frame 31)
- FR-9 Toolbar: filter input; filter chips All · With a worktree · Merged · Stale (last commit > 30 days);
  right `N worktrees · <size> on disk` (size from `github_worktree_disk_usage`, omitted when null);
  secondary **Prune merged worktrees** (opens the prune review).
- FR-10 Table columns BRANCH 300 · AHEAD / BEHIND 120 · WORKTREE 250 · SESSION 210 · PULL REQUEST 120 ·
  LAST COMMIT flex · ⋯. Default branch shows `current` pill when checked out. Ahead green / behind violet /
  zeros disabled. Worktree: folder icon + display path, or a bordered **+ Create** button
  (`github_create_worktree`). Session: state chip (`n sessions` neutral for >1; the one session's name
  tinted by its state — attention when awaiting approval/input, running cyan, else neutral), `—` none.
  PR: icon by state + `#n`, `—` none. Row click selects (highlight); ⋯ menu: Open session / Start a
  session here, Copy branch name, Open on GitHub.
- FR-11 Footer: info hint, `N branches ready to prune` (merged, not default, no session), ghost
  **Review prune** → modal listing them with checkboxes, confirm calls `github_prune`, reports outcomes.

### General
- FR-12 Loading = skeleton-less muted "Loading…" in the pane; errors inline with a Retry; everything
  themes via tokens (dark + light).
- FR-13 Demo mode (`VITE_FRANCOIS_DEMO=1`) serves the orbit fixtures from the frames.

## 4. Non-goals
Merging a PR that isn't open + clean (GitHub owns admin overrides), closing, commenting, reverting,
force-pushing, remote branch deletion outside FR-5a, the Checks tab body,
Cohorte run chips.
