---
model: sonnet
description: Apply a REVIEW REPORT (or SMOKE failures) — append it to the spec's Remediation, then re-dispatch ONLY the surfaces that have findings.
argument-hint: <feature_id> [paste REVIEW REPORT]
---

You are the **lead**. Run the fix loop for feature **$ARGUMENTS** — the scoped, cheap path after a
`REVISE`/`BLOCK` verdict. The full `/spec` (Mode B) + `/build` path still exists for review returns
that change the *contract*; `/fix` is for everything else.

> Read `PIPELINE.md` §`pipeline-profile` first: `surfaces` (paths + agent names) and `contract`.
> _Skip the re-read if it's already in your context this session and unmodified since._
>
> **Kanban** (SCHEMA.md §Kanban): move card `#$ARGUMENTS` → **Fix** on ingest (it returns to **Review**
> when `/review` re-runs). No-op silently if no board.

## 1. Ingest the report

- The report is either pasted after the feature id, the REVIEW REPORT / SMOKE failures from this
  session's last `/review` / `/smoke`, or — if the context was cleared — read from
  `specs/reports/<id>.md`, where `/review` and `/smoke` stage their last report for exactly this reason.
  If you have none of these, ask for it and wait.
- Append each finding to `specs/<id>.md` **`## Remediation`** (same format as `/spec` Mode B, under a
  dated/numbered subheading): `- [ ] <severity> · <file:line> · <type> · <concrete fix>`. Set
  `status: in-review`. Don't pull the whole spec into context for this: grep the line numbers of the
  front-matter `status:` and the `## Remediation` heading, then Read only those regions (offset/limit)
  before editing.
- **Contract check:** if any finding implies the frozen contract must change, update spec §5 and
  re-author the contract file yourself now (lead-only, per `/build` §2) — agents never edit it. If
  the contract change ripples into surfaces *without* findings, fall back to full `/build` instead
  and say so.
- **Note the epoch** (`date +%s`) in the first Bash call you make here — §3's metrics line and usage
  ping both carry `seconds`, and there is no separate timing call.

## 2. Scope the re-dispatch — only surfaces with findings

- Map every **open** (`- [ ]`) Remediation item to a surface by matching its `file:line` path against
  `surfaces[].path`. Items already checked `- [x]` (fixed in a prior round) are done — skip them, never
  re-dispatch them. Items outside every surface path (contract file, root config) are yours or go
  to the most relevant surface — say which.
- Re-dispatch **ONLY the surfaces owning ≥1 item**, in parallel, in a **single message** — the exact
  dispatch template from `/build` §3 (one byte-stable template for builds and fix loops; you do NOT
  paste a diff — the agent computes its own, scoped to its tree). Fill the template's final variable
  slot with that surface's open `- [ ]` item lines **verbatim**, so the agent needs no spec re-read to
  find its work; fill the design slot with `none` when a `uses_design` surface's open items are all
  non-visual (no DesignSync re-fetch for a type fix). Surfaces without findings are NOT re-dispatched —
  that is the point.

## 3. Integrate & check off what's fixed

When the agents return:

- **Tick the resolved items.** Each handoff's `## Remediation addressed` lists what that agent fixed
  (by `file:line`). For every Remediation item an agent reports fixed, flip its `- [ ]` → `- [x]` in
  `specs/<id>.md` and append a terse ` — fixed: <what/where>` note (the convention prior rounds already
  use). Leave genuinely-unaddressed items `- [ ]` so the next loop still sees them. This keeps the
  checkbox state honest and stops a later `/fix` from re-dispatching already-fixed items (§2). Ticking
  here is the lead's job — surface agents own only their tree, never the spec.
- **Collapse fully-resolved rounds (keep the spec bounded).** When a whole dated Remediation round is now
  entirely `- [x]`, replace its item lines with a single summary line (`- <date> — <N> findings, all
  fixed`) — the audit fact survives, but the per-item bulk stops growing the spec that every agent
  re-reads each loop. Keep any round with ≥1 still-open `- [ ]` item fully expanded (§2's skip logic
  needs those checkboxes).
- Print one status line per surface (`<key> · items fixed <n>/<m> · tests pass/fail`) — do not restate
  handoff content — and append ONE metrics line for the batch to `pipeline-metrics.jsonl`
  (see `/build` §4, `phase: "fix"`), chaining the opt-in usage ping in the same Bash call
  (results = items fixed over items found across surfaces, e.g. `"5/6"`).
- Tell the human: re-run `/smoke` if the failures were runtime ones, and `/review $ARGUMENTS` for the
  re-verdict — the re-review is what *verifies* the ticked items actually hold (a regression simply
  reappears as a new finding in the next round). **Recommend a `/clear`** — all state (spec,
  checkboxes, staged report) is on disk, and the lead's history is re-sent at input price every turn.
