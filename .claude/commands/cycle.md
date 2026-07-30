---
model: sonnet
description: Launch the full dev-cycle workflow (contract → build → smoke ∥ review → fix, until zero findings) for a frozen spec; relay its verdict + deferred questions.
argument-hint: <feature_id> [max_rounds]
---

You are the **lead**. Launch the full dev-cycle **workflow** for feature **$ARGUMENTS** — the
deterministic script does the orchestration (SCHEMA.md §Workflows, `cycle.js`); your job is only to
start it and relay its result. Do NOT run the phases yourself here — that's the conversational path
(`/build` → `/smoke` → `/review` → `/fix`), which remains the fallback below.

> **Kanban** (SCHEMA.md §Kanban): move card `#<feature_id>` → **Building** at launch. No-op silently
> if no board.

## 1. Resolve & check (fail fast, before spending anything)

- Parse `$ARGUMENTS`: the first token is `<feature_id>`, an optional second numeric token is
  `<max_rounds>` (the workflow defaults to 5).
- Resolve the script: `.claude/workflows/cycle.js` if it exists, else `~/.claude/workflows/cycle.js`
  (`test -f`). **Missing both** ⇒ the core predates 1.3.0 or is half-copied: tell the human to run
  `/update-pipeline`, and stop.
- **Workflow runtime available?** If the `Workflow` tool is not in your toolset (Claude Code
  < 2.1.154 or workflows disabled), say so and hand over the conversational path instead:
  `/build <feature_id>` → `/smoke` → `/review` → `/fix` — same phases, interactive. Stop.
- Quick spec sanity (the workflow re-checks properly — this just saves a doomed launch):
  `grep '^status:' specs/<feature_id>.md` must say `frozen` or `in-review`; otherwise tell the human
  to run `/spec` first, and stop.

## 2. Launch

Call the `Workflow` tool: `scriptPath: <resolved cycle.js path>`,
`args: {"feature": "<feature_id>", "maxRounds": <max_rounds, omit if not given>}`.
It runs in the background — tell the human it's off and what it will do (build, then smoke ∥ review
→ fix rounds until zero findings + PASS; no questions mid-run), and that `/workflows` shows live
progress. Then END YOUR TURN — never poll, never sleep; the completion notification re-wakes you.

## 3. Relay the result (when the task notification arrives)

The workflow returns only a verdict object — the bulk is already on disk
(`specs/reports/<feature_id>.md`, spec `## Remediation`). Print, without re-reading any of it into
context:

- `outcome` · rounds used · review verdict · smoke result.
- `contractChanges` if any — flag them explicitly: the loop re-authored the frozen contract
  lead-style; the human should eyeball those hunks in the diff.
- **The `questions` array, verbatim** — this is the human's inbox from the run (empty when the spec
  pre-answered everything). Each one is a decision to make, usually by sharpening the spec.
- The `next` line: **SHIP-READY** ⇒ `/ship <feature_id>` (DoD ticked + freshness stamped — ship is a
  straight shot, its human confirmation stays). **STOPPED** ⇒ answer the questions, then rerun
  `/cycle <feature_id>` (it picks up from the spec's Remediation) or finish conversationally with
  `/fix <feature_id>` + `/review <feature_id>`.
- **Kanban:** outcome SHIP-READY ⇒ move card → **Review** (the cycle's last verdict is a review);
  otherwise → **Fix**. No-op silently if no board.
- **Recommend a `/clear`** — everything the next command needs is on disk.
