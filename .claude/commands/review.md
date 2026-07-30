---
model: sonnet
description: Dispatch the read-only review agent to audit the feature against its frozen spec.
argument-hint: <feature_id>
---

You are the **lead**. Dispatch the review for feature **$ARGUMENTS**.

> Read `PIPELINE.md` §`vcs.default_branch` (diff base) and the `surfaces`/`contract`/`commands` fields.
> _Skip the re-read if it's already in your context this session and unmodified since._
>
> **Kanban** (SCHEMA.md §Kanban): move card `#$ARGUMENTS` → **Review**. No-op silently if no board.
>
> **Workflow variant** (opt-in — SCHEMA.md §Workflows): on Claude Code ≥ 2.1.154 with workflows
> enabled, the human can ask to "run the review workflow" (`<core>/workflows/review.js`) instead.
> This conversational path stays the default and the fallback; `/doctor` shows which is available.

## 0. Deterministic pre-flight — no agents while red

Run the profile's mechanical gates in ONE Bash call via the shipped script
(`<core>/pipeline/scripts/preflight.sh`, `<core>` = `.claude` bundled / `~/.claude` global — probe
with `test -x`); note the epoch (`date +%s`) in the same call — §3's metrics line needs it:

```
<core>/pipeline/scripts/preflight.sh specs/reports/$ARGUMENTS.preflight.txt \
  "<commands.typecheck>" "<commands.lint_quiet, else lint>" "<commands.test_quiet, else test>"
```

- **Non-zero exit** ⇒ the script already printed the raw last-40 lines. **STOP: relay them verbatim
  and spawn NO agent** — a compiler/test failure needs `/fix` (or the human), not a review that
  rediscovers it at agent prices. This abort is the whole point of the step.
- **Zero exit** ⇒ it stamped `.claude/preflight.ok`, which the gate hook checks before letting
  `review`/`smoke` dispatches through (SCHEMA.md §Preflight). Continue.
- Script absent (older core) ⇒ run the three commands yourself, each redirected into
  `specs/reports/$ARGUMENTS.preflight.txt`, aborting on the first failure the same way.

## 1. Gather the inputs for stateless reviewers

- Confirm `specs/$ARGUMENTS.md` exists.
- **Compute the diff ONCE — `--stat` first, patches only for retained surfaces.** One call:
  `git diff <default_branch> --stat > specs/reports/$ARGUMENTS.stat.txt`, then grep that file to
  group the changed paths by `surfaces[].path` prefix (deterministic — don't reason it out file by
  file). Paths under no surface (contract file, root config) are the **`shared` remainder**: attach
  them to the most relevant surface's reviewer and say so in its dispatch. A surface with no changed
  paths gets no reviewer — and no `.diff` is ever generated for it.
- **Stage the hunks once per touched surface** (reviewers are read-only — no Bash — so the staged
  diff file is the ONLY way they can review hunks instead of re-reading whole files, and staging it
  here means N reviewers never re-run git N times). Regenerated every round:
  `git diff <default_branch> -- <surface.path> > specs/reports/$ARGUMENTS.<surface.key>.diff`
  (same gitignored buffer dir as the reports). For the surface that carries the shared remainder,
  append the remainder pathspecs to its command so its `.diff` includes them. Never print a diff into
  your own context — redirect straight to the file.

## 2. Dispatch review agents — one per touched surface, IN PARALLEL

Spawn ONE `review` agent per surface that has changed files, in a **single message** (one Task call
each, like `/build`) so they run concurrently — NEVER serially: review wall-clock must be the
slowest surface, not the sum. A diff touching a single surface ⇒ a single reviewer.

**Small-diff fast path (re-reviews only):** if a surface's staged diff is tiny (≤2 files and ≤~40
changed lines), touches no contract file, and every open finding it addresses is non-security
LOW/MEDIUM, skip the dispatch: verify the hunks yourself against the open Remediation items (did the
prescribed fixes land? — NOT a de-novo audit) and write the same REVIEW REPORT into the §3 flow.
First-round reviews, contract changes, and security findings always get a full reviewer. For each
dispatched surface:

Keep the dispatch prompt **byte-identical across features and rounds** except the variable block,
which sits at the END so every repeat hits the prompt-cache prefix:

> `subagent_type: review` — "Review one feature surface against its frozen spec. Read `PIPELINE.md`
> first (flags + the §Conventions/§Testing slice for your scope). Check spec conformance first, then
> correctness, security, conventions, RBAC/mobile-first _if the profile enables them_, and TDD
> coverage. Your dispatch names a staged diff file — read it FIRST; open a full source file only when
> a finding demands it. Emit the REVIEW REPORT in the capped format your agent instructions define —
> every finding self-sufficient (`file:line` · severity · type · one-line concrete fix), no code
> excerpts. — Variable slots: feature `$ARGUMENTS` · scope: the `<surface.key>` surface only · spec:
> `specs/$ARGUMENTS.md` (source of truth) · contract: `<contract.path>/$ARGUMENTS.<ext>` · staged
> diff: `specs/reports/$ARGUMENTS.<surface.key>.diff` · changed files (`--stat`): <list>."

§0's preflight call already gave you the wall-clock start (`date +%s` in the same call) — §3's
metrics line needs it.

## 3. Merge & relay the verdict

Merge the returned reports into **one** REVIEW REPORT (same template): findings concatenated and
re-ordered by severity, counts summed, duplicates collapsed, verdict = the worst returned
(`BLOCK` > `REVISE` > `SHIP`). Append ONE metrics line for the batch to `pipeline-metrics.jsonl`
(main-checkout path + rules in `/build` §4): `{"ts":"<ISO>","feature":"$ARGUMENTS","phase":"review","seconds":<wall-clock>,"surfaces":{"<key>":"<verdict>:<finding count>",…}}`.
In the same Bash call, chain the opt-in usage ping (`/build` §4, `phase: "review"`, results = the
merged verdict + total finding count, e.g. `"REVISE:3"`).
**Stage the full report to `specs/reports/$ARGUMENTS.md`** (overwrite) — a gitignored buffer so a
`/fix` after a `/clear` can still read the findings; the `specs/reports/` subfolder is skipped by the
non-recursive `specs/*.md` glob, so it's never mistaken for a spec (no phantom card, no bogus stage).
In chat print ONLY: the verdict, the severity-count table, a one-line digest of each CRITICAL/security
finding, and `Full report: specs/reports/$ARGUMENTS.md` — never echo the findings body into chat (it
would sit in this session's history, re-sent every turn). Then:

- **SHIP** → a SHIP verdict *is* the pipeline's statement that the feature meets its Definition of
  Done, so **tick the DoD**: in `specs/$ARGUMENTS.md` §`Acceptance criteria / DoD`, flip each `- [ ]`
  → `- [x]` for the criteria the pipeline has actually verified — spec conformance + `ui_language`
  copy (this review), tests · lint · typecheck (a green `/build`), mobile-first + runtime flows (a
  prior `/smoke`). **Leave `- [ ]` (and say which) any item whose verifying stage didn't run this
  cycle** — e.g. no `/smoke` ⇒ the mobile-first / runtime item stays open. Ticking is the lead's job
  (the reviewer is read-only). **Then stamp the freshness gate** so `/ship` can refuse to ship code
  edited after this verdict: compute `BASE=$(git merge-base <default_branch> HEAD)` and write into the
  spec front-matter `reviewed_base: $BASE` plus
  `reviewed_digest: $(git diff $BASE -- . ':(exclude)specs/' | sha256sum | cut -c1-16)` — the fingerprint
  of exactly the source you just reviewed (specs excluded, so DoD ticks + the ship status flip don't
  trip it). Then tell the human they can `/ship` — **recommend a `/clear` first**, the handoff is
  fully on disk. **SHIP with leftover LOW findings** (or LOW+MEDIUM at the human's call) does NOT
  force a fix cycle for nits: park them in `specs/refactor-backlog.md` tagged `deferred:<id>` (NOT as
  open `## Remediation` items, which would re-trigger the fix loop), keep the SHIP verdict and the
  freshness stamp, and let the human ship.
- **REVISE / BLOCK**, or any CRITICAL/HIGH/security finding → tell the human to run
  **`/fix $ARGUMENTS`** — it appends the report to the spec's `## Remediation` and re-dispatches ONLY
  the surfaces with findings. The full path (`/spec` Mode B then `/build`) remains for findings that
  change the contract in ways that ripple into clean surfaces. _The report is staged to
  `specs/reports/$ARGUMENTS.md`, so you can `/clear` before `/fix` — it reads the findings back from
  disk._
