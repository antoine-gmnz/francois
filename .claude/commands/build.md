---
model: sonnet
description: Author the contract from the frozen spec, then dispatch one implementer agent per surface in parallel.
argument-hint: <feature_id>
---

You are the **lead**. Build feature **$ARGUMENTS** from its frozen spec.

> Read `PIPELINE.md` §`pipeline-profile` first: the `surfaces` list (how many implementers to
> dispatch + their agent names), `contract` (mechanism + path), and the `design` flag. _Skip the
> re-read if it's already in your context this session and unmodified since._
>
> **Kanban** (SCHEMA.md §Kanban): once §1 confirms the frozen spec, move card `#$ARGUMENTS` →
> **Building**. No-op silently if no board is configured.

## 1. Load & check

- Check the spec front-matter FIRST — `grep '^status:' specs/$ARGUMENTS.md` (or Read with a ~15-line
  limit) — before any full read. If missing or `status` not `frozen`/`in-review`, stop — tell the human
  to run `/spec` first. Only then read the body, selectively: front-matter, §5 contract, the surface
  task sections, and `## Remediation` (fall back to a full read if the spec doesn't follow the
  template's headings).
- **Route check** — if `## Remediation` has open `- [ ]` items and none requires a contract change,
  stop and tell the human to run `/fix $ARGUMENTS` instead: it re-dispatches only the surfaces with
  findings. A full build with open items is only right when the contract change ripples into clean
  surfaces (the case `/fix` §1 falls back here for).
- **Design gate** — only if `design.enabled` and the feature has UI (some surface `uses_design`): if the
  spec front-matter `design_files` is empty, ask the human for the feature's design **links** and store
  them in `design_files`, then continue. Each entry is a full self-contained link of the form
  `https://claude.ai/design/p/<projectId>?file=<file>` — it carries its own project (the `/p/<projectId>`
  path segment) and page (the `?file=` query), so nothing needs a stored project id and the reference
  survives a design-system rebuild (a new DS ⇒ just paste the new links, no profile change). _Legacy bare
  file names still resolve against the optional `design.design_project` fallback, but new specs use links._
  Skip if the feature is backend-only / no UI.
- If this is a fix loop (`## Remediation` has unchecked items), map each open item to a surface by its
  `file:line` path — each agent gets ONLY its own surface's items, inlined in its dispatch (§3).

## 1.5 Reconcile surfaces — auto-grow / specialize agents

Map every area the spec touches (§5 contract + each surface's tasks + touched paths) onto the
`surfaces[]` in `PIPELINE.md`. Two triggers add an agent — handle them BEFORE authoring the contract:

- **Unowned area → new agent.** If the spec introduces work in a tree that falls under NO existing
  `surfaces[].path` (a genuinely new thing — a new service, a new app, a new top-level area), that work
  has no owner. Auto-detect it and propose a new surface for it.
- **Bottleneck area → specialize.** If one existing surface carries a large, cleanly-separable chunk of
  this feature (e.g. a whole new feature-module) that would dominate build time, propose splitting that
  chunk into its own specialized surface. Use the heuristic in SCHEMA.md §Specialization — only when the
  boundary is clean; skip when tangled or tiny.

For each surface to add: infer its `key`, `path`, `label`, `agent`, `tools`, `model`, `*_cmd`s, and
`uses_design` (mirror a sibling surface), show the human a one-line proposal, and on go-ahead **render it now** per
SCHEMA.md §"Rendering / reconciling a surface agent" — write the `surfaces[]` entry + §Conventions/§Testing
stanza into `PIPELINE.md`, render `.claude/agents/<agent>.md` from the implementer template, applying the
shared-code rule (shared trees get a single-owner surface; cross-slice shapes go through the contract).
This is the automatic path: you don't send the human back to `/init-pipeline`. If nothing new is needed,
say so and continue. Dispatch (§3) then covers the reconciled surface list.

## 2. Author the contract (lead-only — the single sync channel)

_Only if `contract.enabled`._ From §5 of the spec, write/update the feature's contract file at
`<contract.path>/$ARGUMENTS.<contract.ext>` in the profile's `mechanism` (e.g. Zod v4 schemas + inferred
types for `shared-types-zod`). Export it from `contract.index` if set. This is the ONLY file the agents
share; they import it read-only and must not edit it. If `contract.enabled` is false, the spec prose is
the sync channel — say so and skip. **Postcondition (if `contract.enabled`):**
`test -f <contract.path>/$ARGUMENTS.<contract.ext> && date +%s` — the contract file must exist before
you dispatch §3, or the stateless agents have nothing to build against (the epoch output is §4's
wall-clock start — no separate timing call).

## 3. Dispatch one implementer per surface — IN PARALLEL

Spawn every surface's agent in a **single message** (one Task call each) so they run concurrently —
NEVER serially: build wall-clock must be the slowest surface, not the sum. Use
the reconciled `surfaces` list from §1.5 (existing + any just-rendered). Give EACH only what a stateless
agent needs — re-supply everything every time, as **exact file paths** (spec, contract, the surface's
tree), never "find the relevant files". Keep the dispatch prompt **byte-identical across dispatches
and fix loops** except the two variable slots, which sit at the END of the prompt so every repeat hits
the prompt-cache prefix. Never paste a diff into a dispatch — the agent computes its own, scoped to its
tree. For each surface in `surfaces`:

> `subagent_type: <surface.agent>` — "Implement the **<surface.key>** surface for feature `$ARGUMENTS`.
> Read `PIPELINE.md` first. Spec: `specs/$ARGUMENTS.md`. Contract: `<contract.path>/$ARGUMENTS.<ext>`
> (import read-only). Work test-first. Touch only `<surface.path>`. Need the current state of your
> tree? Compute it yourself: `git diff <default_branch> -- <surface.path>`. Return the handoff in the
> format your agent instructions define. Design files: <the spec's `design_files` links — each
> `https://claude.ai/design/p/<projectId>?file=<file>` carries its own project + page, fetch read-only
> via `DesignSync get_file`, build mobile-first · or `none` (non-design surface, or a fix loop whose
> open items are all non-visual)>. Open Remediation items for YOUR surface (self-contained — fix
> exactly these, reading only the files they name; `none` ⇒ first build, implement the spec's tasks
> for your surface): <the surface's open `- [ ]` lines verbatim, or `none`>."

## 4. Integrate

When all return, flag any contract mismatch or failing test from the handoffs; otherwise print one
status line per surface (`<key> · tests pass/fail · <n> TODOs`) — do not restate handoff content.
Append **ONE line for the batch** to `.claude/pipeline-metrics.jsonl` (create it if absent; it must
be gitignored), computing the elapsed time in the same Bash call
(`echo "{...\"seconds\":$(($(date +%s)-<start epoch from §2>)),...}" >> …`):
`{"ts":"<ISO date>","feature":"$ARGUMENTS","phase":"build","seconds":<wall-clock>,"surfaces":{"<key>":"ok|error",…}}`
— this is the evidence SCHEMA.md §Specialization asks for before splitting a surface.
Then tell the human: run `/smoke $ARGUMENTS` to exercise the feature end-to-end (or test by hand),
then `/review $ARGUMENTS`. Do not run the app or migrations yourself here — `/smoke` is the
sanctioned path for that. **Recommend a `/clear` now** — the spec, contract and diff are all on
disk, and the lead's history is re-sent at input price on every turn it survives.
