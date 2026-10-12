---
id: gitlab-integration
status: shipped
depends_on: [github-page, github-ci-logs]
contract: contract/gitlab-integration.ts
reviewed_base: ce720845b36617942d60bb0989db37830d20ac1b
reviewed_digest: 97823a67d6fc05b9
design_files:
  - https://www.figma.com/design/YEY4c6AiWq1bKYuaju9qdV/?node-id=160-15836
  - https://www.figma.com/design/YEY4c6AiWq1bKYuaju9qdV/?node-id=161-15989
  - https://www.figma.com/design/YEY4c6AiWq1bKYuaju9qdV/?node-id=162-16108
---

# GitLab integration

## Goal and scope
Provide parity with the existing GitHub repository experience for GitLab.com
and self-managed GitLab. Reuse the existing layouts, tokens and git-local
operations. No new visual layout; adapt provider labels and available actions.

## Functional requirements
1. Detect provider from the selected remote. github.com and gitlab.com are
   explicit; custom hosts use authenticated gh/glab probes. Recognizable
   GitLab hosts must remain GitLab when unauthenticated. Unknown hosts must
   not be treated as GitHub. Preserve nested GitLab namespaces and SSH/HTTPS.
2. Use bounded WSL-aware glab execution, authenticated for the actual remote
   hostname. Never persist tokens in Francois or print credentials.
3. List open/all MRs and fetch detail: author/viewer, draft/open/closed/merged,
   branches, description, files, discussions, reviewers, labels, milestone,
   mergeability, approvals when accessible and pipelines/jobs. Respect missing
   optional/paid API information; never falsely report approval or mergeability.
4. Merge only after existing UI confirmation; re-fetch and validate open,
   non-draft, clean MR, supported project merge policy, pin merge to current
   head SHA, preserve local branches/worktrees. Delete remote source only when
   explicitly checked, never default/target/fork. GitLab merge method differs
   from GitHub: do not offer a rebase as a merge operation. Unsupported update
   branch action must have honest provider-specific behavior or be hidden.
5. Link MRs with existing session/worktree behavior. New MR opens GitLab new
   MR URL with URL-encoded source branch. Commit links use /-/commit/<sha>.
6. Fetch latest relevant pipelines and jobs by commit SHA, poll pending jobs,
   inspect sanitized bounded job trace through existing logs UI (whole-job
   synthetic step is acceptable, labeled Job log, no invented step timings),
   retry failed jobs/pipeline behind current confirmation. Failed-check fix
   sessions include actual trace excerpts when available. Cancellation/manual
   states must not be shown as passed. Include pagination for jobs/discussions.
7. Local commits, branches, fetch, disk usage, prune and session creation work
   without gh/glab. Existing GitHub behavior remains compatible.
8. All product text, palette, nav, headers, detail, merge/retry dialogs and
   session cards adapt to GitLab/MR/CI vocabulary. Missing CLI/auth explanations
   name glab and correct hostname; unknown repository remains local usable.
9. Changes panel and palette Create PR actions become Create MR for GitLab.
   The agent prompt uses glab mr create for GitLab and gh pr create for GitHub,
   scoped to the actual session repository, and updates an existing request.

## Contract
Existing contract/github-page.ts request/response types and github_* commands
are retained as compatibility transport. GithubRepoInfo gains optional
provider: github | gitlab | unknown (absent means github for existing fixtures).
gh is the selected provider CLI availability using existing GhStatus vocabulary.
No new command registration required. Core dispatches all remote-backed commands
by provider; git-only commands unchanged. Errors retain existing Result/AppError
codes (GH_UNAVAILABLE/GH_FAILED) but provider-accurate messages. Inputs cwd and
positive ids/full SHA/method/step number keep existing validation. All return
shapes mirror github-page.ts. GitLab exposes only allowed merge/squash methods;
whole job trace is synthetic step 1, with step 0 allowed as whole-job fallback.
CheckRun gains optional external:boolean; true means a source-project pipeline
represented by its authoritative status and browser link, without target-scoped
job/run IDs. External checks remain visible but never drive target-repo polling.

## Surface tasks
### core
Own src-tauri and scripts/quality. Implement provider detection, glab adapter,
MR mapping/detail/merge, pipeline jobs/traces/retry, route existing commands
and commit enrichment. Test first including routing, nested namespaces,
unavailable auth, state mapping, trace sanitization, merge guard/policy/SHA.
### frontend
Own src. Implement provider-aware presentation, navigation and palette,
URLs, confirmations, logs/session cards, demo coverage and pure tests. Keep
existing shared layouts and no new design fetch required (visual reuse).

## Validation
Frontend tests/typecheck/build/quality; cargo fmt/test/clippy. Read-only live
GitLab checks if existing local credentials allow. No remote merge/retry writes
during verification. Report packaged/manual and live-provider evidence honestly.

## Open questions
None. Existing gh/glab authentication is reused; no in-app OAuth setup added.

## Remediation
- 2026-10-12 — 5 review findings, all fixed; final core and frontend verdicts SHIP.

## Verification evidence
- Frontend: 281 files, 4186 tests; production build/typecheck/ESLint passed.
- Core: 2284 unit tests and 7 integration tests; fmt/clippy passed (14 opt-in tests ignored).
- Full npm quality gate and documentation build passed.
- Real GitLab read-only adapter validation passed, including nonempty sanitized job trace.
- Browser demo: GitLab navigation/MR detail/job logs/merge dialog/commits/branches; GitHub navigation; 1440px and 900px captures.
- Browser demo has existing Cohorte null detection errors in both providers; repository interactions passed.
- Native packaged UI and real merge/retry mutations were not exercised.

- Windows CI fixture follow-up: set init.defaultBranch locally in the temporary repository; targeted regression passes with a synthetic global defaultBranch=master. Test-only patch checked against review small-diff fast path.
