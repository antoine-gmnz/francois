---
model: sonnet
description: Apply the refactor backlog for one or more domains via the surface implementer agents (TDD-first, parallel across independent surfaces), then re-verify.
argument-hint: <domain…> (one or more surface keys, "shared", or "all")
---

You are the **lead**. Refactor domain **$ARGUMENTS** to match `PIPELINE.md`, using the `/audit` backlog.

> Read `PIPELINE.md` §`surfaces` (map the domain → a surface + its agent + commands) and §`contract`.

## 1. Gather

- Read `specs/refactor-backlog.md`; select the items for `$ARGUMENTS` (`all` = every domain with
  open items).
- Map each domain to a surface. `shared` = the contract package (`contract.path`), owned by you/lead —
  refactor it directly, don't dispatch.

## 2. Dispatch the surface's implementer agent — TDD-first, stateless

Spawn the matching `<surface.agent>` with the template below. Keep it **byte-identical across loop
rounds** (only the final items slot varies — it sits at the end so repeats hit the prompt cache), and
never paste a diff — the agent computes its own, scoped to its tree:

> `subagent_type: <surface.agent>` — "Refactor pass on your surface (no feature spec). Read
> `PIPELINE.md` first. **Add the missing tests FIRST** (pin current behavior / cover the entry
> points), watch them pass, **then** refactor to clear each item. Preserve current public behavior
> unless an item marks it a bug. Migrations stay additive. Need the current state of your tree?
> Compute it yourself: `git diff <default_branch> -- <surface.path>`. Lint + format before handoff;
> return the handoff in the format your agent instructions define. Backlog items for YOUR surface
> (self-contained — clear exactly these, reading only the files they name): <the domain's open
> `- [ ]` lines verbatim, with exact file paths>."

**Parallel when domains are independent:** if the human passed several domains (or `all`), dispatch
their implementers **concurrently in a single message** — surface trees are disjoint by construction,
so parallel is safe. Exception: `shared` (the contract package) never joins a parallel batch — the
slices import it, so refactor it alone, first.

- **Preserve current public behavior** unless a finding marks it a bug/convention violation — existing
  code has no contract spec, so don't silently change shapes.
- Migrations stay **additive**; never `PIPELINE.md` §`gate.deny` commands.
- Touch only its surface; lint + format before handoff.

## 3. Verify & loop

After each agent returns: its surface's `test_cmd`/`lint_cmd`, `commands.typecheck`,
`commands.format --check` (redirect output to a file and grep it — don't print gate output into your
context). Then verify each backlog item cleared by checking its `file:line` directly — do NOT re-run
`/audit` per round (that repeats the repo-wide gates + a review dispatch you don't need); one optional
final `/audit` once ALL dispatched domains are clean is enough. Check cleared items off in
`specs/refactor-backlog.md`. Loop until each dispatched domain is clean. Verification is per-domain
even when the dispatch was parallel — one failing surface loops alone, the others don't redo work.
