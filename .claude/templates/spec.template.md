---
feature_id: <slug>
title: <Feature title>
status: draft # draft → frozen → in-review → shipped
branch: <feature_branch_prefix><slug>
created: <YYYY-MM-DD>
reviewed_base: # merge-base sha at the last SHIP verdict — freshness-gate anchor (written by /review)
reviewed_digest: # sha256 (16 hex) of the reviewed source diff vs reviewed_base, specs excluded — /ship re-checks
design_files: [] # design page links — full URLs of the form https://claude.ai/design/p/<projectId>?file=<file> (each carries its own project + page); blank until designed; omit if no UI
---

# <Feature title>

## 1. Goal & user story

<one paragraph: what · who · why>

## 2. Scope

**In:** …
**Out (non-goals):** …

## 3. Roles & permissions

> Only if `PIPELINE.md` §rbac is enabled — which roles can do what; note the lowest-privilege experience.

## 4. Data model & migrations

> Additive only (never gate.deny commands). Omit if the feature has no persistence.

| table | column | type | null? | default | notes |
| ----- | ------ | ---- | ----- | ------- | ----- |
|       |        |      |       |         |       |

## 5. CONTRACT (frozen)

> The only sync channel. Complete enough to build every surface independently. Uses the profile's
> `contract.mechanism`. If `contract.enabled` is false, capture the interface precisely in prose here.

### `<METHOD> /<path>` · auth: `<middleware/role>`

- **Request** — params / query / body: `field` · type · required? · nullable? · validation
- **Success** — `<status>` · response shape
- **Errors** — `<status>` · when (422 validation · 401 · 403 · 404 · 409 …)

<repeat per endpoint/interface>

### Contract types — lead authors `<contract.path>/<slug>.<ext>` before /build

- `<slug>...Request` / `<slug>...Response` / `<slug>Base` … (sketch the schemas here)

## 6+. Surface tasks

> One subsection per surface in `PIPELINE.md` §surfaces (e.g. backend, frontend), each TDD.

### <surface.key>

- …

## 8. Design brief (the "spec return")

> Only if the project has UI. Standalone; mirrors `.claude/templates/design-brief.md`.

- **Screens / views:** …
- **Flows:** …
- **Responsive:** mobile (base) → `md:` → `lg:`
- **States:** empty · loading · error · success

## 9. Acceptance criteria / DoD

- [ ] Every contract endpoint/interface implemented exactly
- [ ] Each surface's tests (TDD) green
- [ ] `PIPELINE.md` commands.lint · typecheck · test green
- [ ] Mobile-first / responsive verified (if UI)
- [ ] User-facing copy in `ui_language`

## 10. Assumptions & open questions

- …

## Remediation

> Filled by `/spec` in review-return mode; empty otherwise. Each item:
> `[ ] <SEVERITY> · <file:line> · <spec-violation|quality|security> · <concrete fix>`
