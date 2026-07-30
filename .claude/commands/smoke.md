---
model: sonnet
description: Exercise the built feature end-to-end in its worktree — infra up, migrations, contract endpoints, key UI flows, visual check vs design — before /review.
argument-hint: <feature_id>
---

You are the **lead**. Dispatch the smoke run for feature **$ARGUMENTS** — the `smoke` agent actually
runs it so the bulky output (curl bodies, server logs, screenshots, design payloads) never enters
your own context, which is re-sent every turn.

> Read `PIPELINE.md` §`pipeline-profile`: `isolation` (worktree, slot ports, db), `contract.path`
> and `commands`. _Skip the re-read if it's already in your context this session and unmodified since._
>
> **Kanban:** none here — `/review` owns the → **Review** move (running both duplicated it).

## 0. Deterministic pre-flight — no agents while red

Same gate as `/review` §0, run **in the feature's checkout** (§1 resolves it — resolve first, then
preflight): `<core>/pipeline/scripts/preflight.sh specs/reports/$ARGUMENTS.preflight.txt
"<commands.typecheck>" "<commands.lint_quiet, else lint>" "<commands.test_quiet, else test>"`.
Non-zero exit ⇒ the raw last-40 lines were already printed — **STOP, relay them verbatim, spawn NO
agent**: booting infra to smoke-test code that doesn't compile wastes the whole run. Zero exit ⇒
the `.claude/preflight.ok` stamp lets the gate hook pass your `smoke` dispatch. Script absent
(older core) ⇒ run the commands yourself redirected to the same file, aborting on the first failure.
Note the epoch (`date +%s`) in the same call — §3's metrics line needs it.

## 1. Resolve the checkout

With `isolation.enabled`: the sibling worktree (`../<slug>-$ARGUMENTS`, its slot's ports + db from
`.worktrees/slots.tsv`); otherwise the main checkout on the feature branch.

## 2. Dispatch ONE `smoke` agent

Keep the prompt byte-identical across features except the variable block at the END (prompt-cache
prefix):

> `subagent_type: smoke` — "Smoke-test one feature. Read `PIPELINE.md` first. Bring it up, exercise
> the contract and the §8 UI flows, stage the full SMOKE REPORT to the report buffer, tear down, and
> return only the capped verdict your agent instructions define (verdict + ❌ lines, no logs). —
> Variable slots: feature `$ARGUMENTS` · spec: `specs/$ARGUMENTS.md` · contract:
> `<contract.path>/$ARGUMENTS.<ext>` · report: `specs/reports/$ARGUMENTS.md` · checkout: `<worktree
> path or main checkout>` · ports/db: `<slot info, or defaults>`."

The gate hooks fire on the agent's Bash calls too — compose/migrate confirmations still reach the
human; that's expected.

## 3. Relay the verdict

- Print the agent's return as-is (verdict + ❌ lines + report path) — it is already minimal.
- Append ONE metrics line to `pipeline-metrics.jsonl` (main-checkout path + rules in `/build` §4,
  `phase: "smoke"`), chaining the opt-in usage ping in the same Bash call (results = `PASS` or
  `FAIL:<n>` failing flows).
- **PASS** → tell the human to run `/review $ARGUMENTS`. **FAIL** → the failures are findings: feed
  them to `/fix $ARGUMENTS`, re-run `/smoke` after. Either way the report is on disk —
  **recommend a `/clear`** before the next command.
