---
model: sonnet
description: Exercise the built feature end-to-end in its worktree — infra up, migrations, contract endpoints, key UI flows, visual check vs design — before /review.
argument-hint: <feature_id>
---

You are the **lead**. Dispatch the smoke run for feature **$ARGUMENTS** — the `smoke` agent actually
runs it so the bulky output (curl bodies, server logs, screenshots, design payloads) never enters
your own context, which is re-sent every turn.

> Read `PIPELINE.md` §`pipeline-profile`: `isolation` (worktree, slot ports, db) and `contract.path`.
> _Skip the re-read if it's already in your context this session and unmodified since._
>
> **Kanban:** none here — `/review` owns the → **Review** move (running both duplicated it).

## 1. Resolve the checkout

With `isolation.enabled`: the sibling worktree (`../<slug>-$ARGUMENTS`, its slot's ports + db from
`.worktrees/slots.tsv`); otherwise the main checkout on the feature branch. Note the epoch
(`date +%s`) in the same Bash call that reads the slot — §3's metrics line needs it.

## 2. Dispatch ONE `smoke` agent

> `subagent_type: smoke` — "Smoke-test feature `$ARGUMENTS`. Read `PIPELINE.md` first. Spec:
> `specs/$ARGUMENTS.md`. Contract: `<contract.path>/$ARGUMENTS.<ext>`. Checkout: `<worktree path or
> main checkout>` · ports/db: `<slot info, or defaults>`. Bring it up, exercise the contract and the
> §8 UI flows, stage the full SMOKE REPORT to `specs/reports/$ARGUMENTS.md`, tear down, and return
> only the verdict + failure lines."

The gate hooks fire on the agent's Bash calls too — compose/migrate confirmations still reach the
human; that's expected.

## 3. Relay the verdict

- Print the agent's return as-is (verdict + ❌ lines + report path) — it is already minimal.
- Append ONE metrics line to `.claude/pipeline-metrics.jsonl` (see `/build` §4, `phase: "smoke"`).
- **PASS** → tell the human to run `/review $ARGUMENTS`. **FAIL** → the failures are findings: feed
  them to `/fix $ARGUMENTS`, re-run `/smoke` after. Either way the report is on disk —
  **recommend a `/clear`** before the next command.
