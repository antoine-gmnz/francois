---
model: sonnet
description: Audit the existing codebase (or a domain) against PIPELINE.md conventions + TDD coverage; produce a prioritized refactor backlog.
argument-hint: [path or domain, default = whole repo]
---

You are the **lead**. Audit **$ARGUMENTS** (default: whole repo) to drive it to a clean base. Read +
analyze only — no fixes (those go through `/refactor`).

> Read `PIPELINE.md` §`commands` (the mechanical gates), `surfaces`, and §Conventions.
>
> **Workflow variant** (opt-in — SCHEMA.md §Workflows): on Claude Code ≥ 2.1.154 with workflows
> enabled, the human can ask to "run the audit workflow" (`<core>/workflows/audit.js` — one auditor
> per domain, concurrent). This conversational path stays the default and the fallback.

## 1. Mechanical gates (you run these — Bash)

Run the profile's checks **scoped to `$ARGUMENTS`** when a path/domain is given (lint/format/typecheck
on that path, tests via that surface's `test_cmd`); repo-wide only for the default whole-repo audit.
Use the quiet variants (`commands.lint_quiet`/`test_quiet`, else the `2>&1 | tail -40` fallback —
SCHEMA.md §Output discipline) and redirect each command's output into
`specs/reports/audit-gates.txt` in the same call (`cmd > specs/reports/audit-gates.txt 2>&1`) so the
bulk never sits in your history, then grep it for the `file:line` of every failure:
`commands.format` in check mode (e.g. `prettier --check .` / `ruff format --check`),
`commands.lint`, `commands.typecheck`, `commands.test`.

## 2. Convention + TDD audit (dispatch `review` in audit mode)

Dispatch `review` (read-only; static prompt first, variable slot last — prompt-cache prefix):
"Audit a target against `PIPELINE.md` (no spec — **audit mode**). Check conventions (§Conventions
per surface), TDD coverage (untested entry points / modules per surface), and — if the profile
enables them — mobile-first + design-system usage. Mechanical findings from the gates: read
`specs/reports/audit-gates.txt`. Emit a prioritized refactor backlog (capped finding-line format
from your instructions), grouped by domain (one group per surface + shared). — Target: `$ARGUMENTS`
(default: whole repo)."

## 3. Write the backlog

Merge mechanical + convention findings into one prioritized backlog and **write
`specs/refactor-backlog.md`**, grouped by domain, each item:
`- [ ] <SEVERITY> · <file:line> · <rule|tdd|lint|format|type|security> · <concrete fix>`
Print a short summary (counts per domain + top items). Tell the human: refactor a domain with
`/refactor <domain>`.
