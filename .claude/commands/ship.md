---
model: sonnet
description: At a SHIP verdict, dispatch the release agent to commit, push, and open the PR (with your confirmation).
argument-hint: <feature_id>
---

You are the **lead**. Ship feature **$ARGUMENTS**. This is the outward-facing gate.

> Read `PIPELINE.md` §`vcs` (host, remote, default_branch, feature_branch_prefix).
>
> **Kanban** (SCHEMA.md §Kanban) is mirrored in **explicit steps** below, not as an afterthought:
> §1 moves the card → **Ship**; §4 moves it → **Shipped** and writes the PR number. No-op silently if
> no board. Do not skip §4's move — a shipped feature whose card is stuck in an earlier column is the
> bug this ordering prevents.

## 1. Pre-flight (confirm before doing anything irreversible)

- Confirm the latest `/review` returned **SHIP** (no CRITICAL, no security). If not reviewed, or the
  verdict was REVISE/BLOCK, stop and say so.
- **Freshness gate** — the reviewed code must be exactly what ships. If the spec front-matter carries
  `reviewed_base` + `reviewed_digest`, recompute
  `git diff <reviewed_base> -- . ':(exclude)specs/' | sha256sum | cut -c1-16` and compare to
  `reviewed_digest`. **Match** ⇒ source unchanged since the SHIP verdict, proceed. **Mismatch** ⇒ source
  (or the contract) was edited after review — the verdict is **stale**: stop and tell the human to re-run
  `/review $ARGUMENTS` before shipping. Missing fields (spec predates the gate) ⇒ skip, don't block.
- **DoD gate (verify, don't tick — `/review` owns the ticking).** Read `specs/$ARGUMENTS.md`
  §`Acceptance criteria / DoD`; if any item is still `- [ ]`, list the open ones and ask the human to
  confirm shipping anyway (they may be deferred on purpose — e.g. a UI item on a backend-only feature).
  All `- [x]` ⇒ proceed silently.
- Show `git status` + `git diff --stat`; confirm the branch is `<feature_branch_prefix>$ARGUMENTS`.
- **Ask the human to confirm** they want to commit, push, and open the PR. Wait for yes.
- After the yes: **move card `#$ARGUMENTS` → the `ship` column** (SCHEMA.md §Kanban "Move a card"). No-op if no board.

## 2. Mark the spec shipped (BEFORE dispatch, so it ships in the same commit)

Once the human confirms, edit `specs/$ARGUMENTS.md` front-matter `status: → shipped` — **before**
dispatching the release agent, so the status flip is part of the tree it commits (otherwise it lands
uncommitted after the PR opens). Only flip after the human's "yes"; if they decline, leave it.

## 3. Dispatch the `release` agent

Spawn one agent (`subagent_type: release`): "Release feature `$ARGUMENTS` on branch
`<feature_branch_prefix>$ARGUMENTS`. Read `PIPELINE.md` §vcs first. Spec: `specs/$ARGUMENTS.md` (already
`status: shipped` — stage it). Write conventional commit(s), push (no force), open the PR (use `gh` if
`host: github` + available; else emit the compare URL + drafted PR body from `.claude/templates/pr-body.md`).
Stage **all** the feature's changes including `specs/$ARGUMENTS.md`. Never edit source, never force-push,
never run migrations."

## 4. Relay + move the card to Shipped (do not skip)

Print the release agent's report: commit SHA(s), pushed branch, PR URL (or compare URL + drafted body).
Confirm `specs/$ARGUMENTS.md` was committed as `status: shipped` (part of the release commit).

**Move the card to Shipped — required, and verify it actually moved.** Move card `#$ARGUMENTS` → the
`shipped` column (SCHEMA.md §Kanban "Move a card") and **append the PR number** so the line reads
`- [ ] <title> #$ARGUMENTS — PR #<num>`. Take `<num>` from the PR URL (`…/pull/13` ⇒ `13`); **always write
it when a PR was created** (the `gh` path) — it is what the dashboard turns into a PR link. If only a
compare URL was emitted (no PR yet), move the card without a number. Then verify with a **grep for
`#$ARGUMENTS`** on the board (with surrounding heading context — `grep -B20 '#$ARGUMENTS' | grep '^##'`
or an offset-limited Read around the match): exactly one card, under the `shipped` heading — never
re-read the whole board into context. No board ⇒ skip silently.

**Telemetry — the usage ping that closes the funnel.** Chain it onto the verify call above
(`/build` §4's shared form, `<phase>` = `ship`, `<seconds>` = `0` — the release agent's duration is
not the pipeline's, `<results>` = `pr` when a PR was created / `compare` when only a compare URL was
emitted). Fire it **after** the release agent reports success, never on an aborted ship — a `ship`
event must mean the feature actually left the pipeline. No board ⇒ still ping, in its own `|| true`
call. Silent no-op without consent; never ask about consent here.

## 5. After the PR — CI gate + teardown

- If `host: github` and `gh` is available, watch the PR's checks (`gh pr checks <url> --watch`) and
  report the result — the human merges only on green. A red check ⇒ back to `/fix $ARGUMENTS`.
- Once the human confirms the PR is **merged**: if `isolation.enabled`, propose the teardown —
  `scripts/remove-feature.sh $ARGUMENTS` (add `--drop-db` to also drop the feature db; kept by
  default). It removes the worktree, deletes the merged branch, frees the slot. Never run it before
  the merge is confirmed, and only with the human's go-ahead (the gate will ask anyway).
- Feature closed — **recommend a `/clear`** before starting the next one; nothing from this session
  is needed again (spec `shipped`, PR merged, board updated).
