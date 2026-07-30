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
   coherent with the VERSION file. A **global**-mode pointer lagging the VERSION file is ⚠️, not ❌:
   nothing bumped that field before 1.2.5, so the core itself is fine and only the pointer is stale
   ⇒ fix by running `/update-pipeline` (§3 syncs it now), or by editing the one field. Compare
   against `npm view cohorte version` — behind ⇒ suggest `/update-pipeline`. Read `pipeline/CHANGELOG.md` for what they're missing. The router
   commands' step files are present — `templates/steps/init-pipeline/` non-empty (a router whose
   `templates/steps/<cmd>/` dir is missing is a partial/stale install ⇒
   re-run install/update). **Shipped scripts present and executable** in `<core>/pipeline/scripts/`:
   `kanban-move.sh`, `telemetry-send.sh`, `preflight.sh`, `new-feature.sh.template`,
   `remove-feature.sh.template` — ❌ any missing one. Every caller chains these with `|| true`, so an absent script is a **silent**
   no-op (no kanban card moves, no telemetry ping, no error anywhere) — this check is the only thing
   that sees it. Also flag ❌ a `VERSION` **newer than** the other `pipeline/` files (compare mtimes):
   a version bumped without a full re-copy is a half-done update ⇒ re-run install/update.
2. **Profile.** `PIPELINE.md` exists and its `yaml pipeline-profile` block parses. Every
   `surfaces[].agent` has its `.claude/agents/<agent>.md` and every agent file has its `surfaces[]`
   entry — **no orphans either way** (SCHEMA.md rule). Each rendered agent's frontmatter `tools`
   matches its surface's `tools` (incl. `DesignSync` iff `uses_design`, retrieval MCP tools iff
   `retrieval.provider` ≠ `none`). **Model pins:** each rendered agent's frontmatter `model` matches
   its `surfaces[].model` — ❌ if missing, mismatched, or a literal `<SURFACE_MODEL>` placeholder
   (all three silently fall back to inheriting the lead session's model — often Opus — on every
   dispatch); ⚠️ any `inherit` with the note that it bills at the lead's tier. The generic agents
   (`review.md`, `release.md`, `smoke.md`, `profile-reader.md` — repo or `~/.claude/agents/`) must
   each carry their `model:` line too (sonnet/haiku/sonnet/haiku). **Command pins:** every mechanical command file
   (`build`, `review`, `fix`, `smoke`, `ship`, `audit`, `refactor`, `doctor`, `align-ds`,
   `update-pipeline`, `cycle` — in `.claude/commands/` or `~/.claude/commands/`) carries `model: sonnet` in
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
7. **Telemetry** (consent hygiene — read `~/.claude/cohorte.config.yaml` §`telemetry`). Report the
   status in one line: `disabled` / `enabled since <consent_date> · install_id <id> · endpoint <url>`
   (the install_id is the human's GDPR erasure key — see SCHEMA.md §Telemetry). Flag ❌ any
   incoherent state: `enabled: true` with no `install_id` or no `consent_date` (sending without
   recorded consent — fix: set `enabled: false` until the consent question is re-run), or a
   `telemetry:` block missing entirely on a current core (top up via `/update-pipeline`).
8. **Workflows** (the opt-in execution path — SCHEMA.md §Workflows; the conversational commands
   stay the default, so failures here are ⚠️ at most, never ❌). Report which path this machine will
   take and why:
   - **Claude Code version** ≥ 2.1.154 (`claude --version 2>/dev/null | head -1`) — older or no CLI
     on PATH ⇒ conversational only.
   - **Scripts present:** `<core>/workflows/review.js` + `audit.js` + `refactor.js` + `cycle.js` —
     missing on a current core ⇒ half-done install, re-run install/update.
   - **Phase-0 agent present:** `<agents dir>/profile-reader.md` (repo `.claude/agents/` bundled or
     `~/.claude/agents/` global) — the workflows abort without it.
   - **Workflows enabled in this session** — the `Workflow` tool is in your own toolset right now;
     absent ⇒ disabled for this session (a setting or an old client), conversational path.
   - **Preflight wiring** (used by both paths): `pipeline/scripts/preflight.sh` executable and
     `gate-config.json` carries the `preflight` block — mismatch ⇒ regenerate from the profile.
   End the check with ONE summary line, e.g.
   `workflows: available (opt-in — ask to "run the review workflow")` or
   `workflows: unavailable (<first failing prerequisite>) — conversational commands (the default)`.
9. **Specs & metrics.** Every `specs/*.md` front-matter `status` is a valid stage; `shipped` specs
   with a live worktree flagged (see 6). `.claude/pipeline-metrics.jsonl` and `specs/reports/` (the
   `/review`·`/smoke` report buffer that lets a `/fix` survive a `/clear`) are gitignored. Metrics
   belong to the **main checkout** — a `pipeline-metrics.jsonl` inside a live feature worktree is a
   stale-core sign (its lines die at teardown) ⇒ suggest appending its lines to the main checkout's
   file and deleting the stray.

## Report

Group by check, one line each: `✅|⚠️|❌ <check> — <one-line detail>`; every ⚠️/❌ followed by
`   fix: <exact command or edit>`. End with the overall count and, if anything failed, the ordered
repair sequence. Nothing failing ⇒ say the installation is healthy, and the installed core version.
