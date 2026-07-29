---
model: sonnet
description: Diagnose the pipeline installation — core version, pointer, agents↔surfaces, hooks, gate, retrieval, design, isolation — and print the exact fix for each failure.
---

You are the **pipeline doctor**. Check every piece of wiring the pipeline depends on and report a
✅/⚠️/❌ checklist, each failure with its **exact fix command**. Diagnose read-only first; apply a
fix only with the human's go-ahead (or hand them the command).

> Wiring that worked at init rots: PATH changes, uninstalls, hand-edits, half-done updates. This is
> the one place that verifies it all.

## Checks, in order

1. **Core & pointer.** A core exists (`~/.claude/pipeline/VERSION` global, and/or
   `.claude/pipeline/VERSION` bundled); `.claude/pipeline.json` names a mode + `core_version`
   coherent with the VERSION file. Compare against `npm view cohorte version` — behind ⇒
   suggest `/update-pipeline`. Read `pipeline/CHANGELOG.md` for what they're missing. The router
   commands' step files are present — `templates/steps/init-pipeline/` non-empty (a router whose
   `templates/steps/<cmd>/` dir is missing is a partial/stale install ⇒
   re-run install/update).
2. **Profile.** `PIPELINE.md` exists and its `yaml pipeline-profile` block parses. Every
   `surfaces[].agent` has its `.claude/agents/<agent>.md` and every agent file has its `surfaces[]`
   entry — **no orphans either way** (SCHEMA.md rule). Each rendered agent's frontmatter `tools`
   matches its surface's `tools` (incl. `DesignSync` iff `uses_design`, retrieval MCP tools iff
   `retrieval.provider` ≠ `none`). **Model pins:** each rendered agent's frontmatter `model` matches
   its `surfaces[].model` — ❌ if missing, mismatched, or a literal `<SURFACE_MODEL>` placeholder
   (all three silently fall back to inheriting the lead session's model — often Opus — on every
   dispatch); ⚠️ any `inherit` with the note that it bills at the lead's tier. The generic agents
   (`review.md`, `release.md`, `smoke.md` — repo or `~/.claude/agents/`) must each carry their
   `model:` line too (sonnet/haiku/sonnet). **Command pins:** every mechanical command file
   (`build`, `review`, `fix`, `smoke`, `ship`, `audit`, `refactor`, `doctor`, `align-ds`,
   `update-pipeline` — in `.claude/commands/` or `~/.claude/commands/`) carries `model: sonnet` in
   its frontmatter — ⚠️ if missing (the lead's orchestration turn then bills at the session model,
   e.g. Opus/Fable). `brainstorm`, `spec`, and `init-pipeline` are intentionally unpinned
   (interactive — they inherit the session model).
3. **Hooks & gate.** `.claude/gate-config.json` exists and mirrors the profile's `gate` block
   (regenerate if drifted). The PreToolUse gate hook is registered **once** for the install mode
   (bundled: repo `settings.json`; global: `~/.claude/settings.json` — flag double registration,
   it double-prompts). Hook files exist at the registered paths.
4. **Retrieval** (if `retrieval.provider` ≠ `none`). Run the SCHEMA.md §Code retrieval health
   check: CLI resolvable from PATH, `.mcp.json` entry present in PATH-proof launcher form,
   `.serena/` gitignored, server actually connects.
5. **Design** (if `design.enabled`). `snapshot_dir` exists and is committed; `ui_kit_path` +
   `tokens_path` exist; if `provider: claude-design`, `DesignSync` responds (`list_projects`) and
   `design_system_project` is reachable. Recall: spec `design_files` are full
   `…/design/p/<projectId>?file=<file>` links that carry their own project + page; `design_project` is
   only a legacy fallback for old bare-filename specs (default `none`).
6. **Isolation** (if `isolation.enabled`). `scripts/new-feature.sh` + `scripts/remove-feature.sh`
   rendered (no `__TOKEN__` placeholders left). `.worktrees/slots.tsv` coherent with
   `git worktree list` — flag **stale slots** (registered but no worktree) and **zombie worktrees**
   (worktree but no slot / spec already `shipped`) ⇒ suggest `scripts/remove-feature.sh <id>`.
   When ≥2 slots are live, print the parallel-feature table (feature · worktree · ports · db ·
   branch behind main by N commits) — a worktree far behind main means its next review will diff
   against stale code ⇒ suggest rebasing it.
7. **Specs & metrics.** Every `specs/*.md` front-matter `status` is a valid stage; `shipped` specs
   with a live worktree flagged (see 6). `.claude/pipeline-metrics.jsonl` and `specs/reports/` (the
   `/review`·`/smoke` report buffer that lets a `/fix` survive a `/clear`) are gitignored.

## Report

Group by check, one line each: `✅|⚠️|❌ <check> — <one-line detail>`; every ⚠️/❌ followed by
`   fix: <exact command or edit>`. End with the overall count and, if anything failed, the ordered
repair sequence. Nothing failing ⇒ say the installation is healthy, and the installed core version.
