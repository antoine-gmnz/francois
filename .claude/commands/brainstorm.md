---
description: Interactive multi-persona panel that challenges and clarifies a feature idea before speccing.
argument-hint: [one-line idea (optional)]
---

You are facilitating an **interactive brainstorm** for a new feature. This runs in the main thread — a
back-and-forth with the human, NOT a one-shot. Do not write any files — the TWO exceptions are staging
the return at Finish (`specs/reports/<feature_id>-brainstorm.md`) and moving this feature's kanban card
at Finish, when a board is configured.

> Read `PIPELINE.md` §Personas (the panel) and §`rbac` first. If `rbac.enabled`, the panel must
> pressure-test the idea so it serves **every** role, not just admins.
>
> Template paths below (`.claude/templates/…`) resolve to `~/.claude/templates/…` when the core is
> installed globally — read whichever exists.
>
> **Kanban** (SCHEMA.md §Kanban): resolve this project's board from `~/.claude/cohorte.config.yaml`
> `kanban.boards[<PIPELINE name>]`. Everything kanban below no-ops silently if none resolves.

Idea (may be empty): **$ARGUMENTS**

## Start

If the idea is empty: when a board is configured and its **Ideas** column has cards, list them (with any
sub-bullet notes as seed context) and let the human pick one — otherwise ask **"What are we building?"**.
Either way, wait. If the idea is non-empty, restate it in one line and confirm you've got it.

## Run the panel

Role-play the roundtable defined in `PIPELINE.md` §Personas — each member with a job AND a personality
who challenges the idea from their angle. They must **disagree** with each other and the human; never
just transcribe. If the profile has no personas, use a default panel (PM · skeptical senior engineer ·
UX/product designer · security). When `rbac.enabled`, ensure a voice for each role so the feature isn't
single-role.

Each round: 2–4 named personas speak, surface tensions + open questions, then **ask the human a focused
question** and wait. Iterate until the idea is genuinely clear: scope, affected roles, rough data +
screens, risks, and what's explicitly out.

## Finish

When the human is satisfied, produce the **brainstorm return** by filling
`.claude/templates/brainstorm-return.md` and **staging it to
`specs/reports/<feature_id>-brainstorm.md`** (the gitignored buffer dir — `/spec` reads it from there
when invoked with no paste). In chat print only a 3-line summary + the path. Tell them to run `/spec`
— **recommend a `/clear` first**, the return is staged on disk (pasting it remains a fallback).

**Kanban:** settle the `feature_id` (kebab-case slug) the return carries — it is the card's join key
downstream. If a board is configured, **move** the card into the **Brainstorm** column tagged
`#<feature_id>` (per §Kanban): the picked Ideas card if the human chose one, else a new card. No-op if
no board.
