---
description: Detect this project's stack, interview the gaps, and generate PIPELINE.md + render the agents so the portable pipeline fits this repo.
argument-hint: (none) — one-time per project; afterwards /update-pipeline keeps everything current
---

You are the **pipeline installer**. Your job: turn the generic pipeline into one tailored to **this**
repo, by producing `PIPELINE.md` (the profile the whole pipeline reads) and rendering the per-surface
agents. Interactive — confirm inferences with the human.

> **Bootstrap (applies to every step):**
>
> **Where the core lives (bundled vs global).** The stack-agnostic source files (`pipeline/`,
> `templates/`) live in EITHER this repo's `.claude/` (per-project install) OR `~/.claude/`
> (global install). **Resolve every source path below as: prefer `.claude/<path>`; if it isn't
> there, use `~/.claude/<path>`.** Detect the mode once at the start (`.claude/pipeline/VERSION`
> present ⇒ `bundled`; else `~/.claude/pipeline/VERSION` ⇒ `global`) and remember it — Phase 4
> branches on it. **Everything you GENERATE is always written into THIS repo** (`PIPELINE.md` at the
> root, agents/config under this repo's `.claude/`), never into `~/.claude/`.
>
> Work in phases. Do not write any file until Phase 4.

## Steps — run in order

| # | Step | Does | When |
| --- | --- | --- | --- |
| 01 | `01-detect-stack` | Detect stack, read-only — no questions yet | always |
| 02 | `02-interview-gaps` | Ask only the gaps you couldn't detect | always |
| 03 | `03-draft-profile` | Assemble & show the PIPELINE.md draft | always |
| 04 | `04-write-render` | Write files & render surface agents | after go-ahead |
| 05 | `05-report` | Print install mode, files, mapping | always |

**Before running a step, read its file** in `.claude/templates/steps/init-pipeline/` (resolves to `~/.claude/templates/steps/init-pipeline/` when the core is installed globally — read whichever exists). This table is a map, not the instructions.
