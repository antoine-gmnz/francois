# GitHub and GitLab repositories

The repository view follows the active project, or the active session when no
project is selected. It brings pull requests or merge requests, commits,
branches and worktrees into the same place, with links back to your sessions.

## Connect your account

Francois reuses the official CLI's existing authentication. For GitHub, install
`gh` and run `gh auth login`. For GitLab, install `glab` and run:

```sh
glab auth login --hostname gitlab.com
```

For a self-managed GitLab instance, use its hostname instead:

```sh
glab auth login --hostname gitlab.example.com
```

Authenticate in the same environment as the repository: a repository inside
WSL uses the CLI installed and authenticated inside that WSL distribution.
Francois does not ask you to paste an access token into the application.

Commits, local branches and worktrees remain available when the provider CLI
is missing or unauthenticated. The requests view explains what needs to be set up.

## Review and continue work

Select a request to see its description, changed files, discussions and CI jobs.
Requests on a session's branch link back to that session. You can open a session
on the branch, or start a fix session with failure details from available CI logs.

**New pull request** or **New merge request** opens the provider's creation page
in your browser with the current source branch selected.

## CI logs

Open a check to inspect its jobs and logs. GitHub Actions exposes individual
steps; GitLab exposes the job trace as a whole job log. Logs are bounded and
sanitized before display. Retrying failed CI requires confirmation.

For a merge request whose pipeline belongs to a fork, Francois shows the
pipeline status and a link to that source project's pipeline. Open it in
GitLab to inspect its jobs or retry them.

## Merge

The merge dialog shows the methods available for that repository. GitLab's
project merge policy governs the operation; rebasing is not offered as a GitLab
merge method. Provider permissions, approvals and branch rules still apply.

Deleting the remote source branch is an explicit option. Local branches and
worktrees remain available after a merge; use the branches view to review and
prune merged worktrees. GitLab's branch update action is omitted because it
does not provide GitHub's equivalent merge-from-base operation.
