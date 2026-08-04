# Decisions

> The project's **transverse decision journal** — the non-obvious rules a stateless agent would
> otherwise re-discover or contradict, one feature at a time. `PIPELINE.md` says *how this repo is
> built* (surfaces, commands, conventions); this file says *what was decided and why*.
>
> **Append-only. One line per decision. No prose blocks, no code.** The bound is the point: this file
> is read by `/cohorte-spec`, `/cohorte-brainstorm` and `/cohorte-audit` — the deciding stages — and by **nothing else**.
> Implementers and reviewers never read it: they work from the frozen contract, which already tells
> them what to do; handing them the rationale too would cost `surfaces × dispatches` tokens per
> feature for a fact they cannot act on.
>
> Line shape (≤ ~160 chars, `·`-separated, no wrapping):
>
> ```
> - <YYYY-MM-DD> · <area> · <the decision, imperative> — because <the reason> · <feature_id>
> ```
>
> `<area>` is a short tag, not a path: `auth`, `data`, `api`, `ui`, `deploy`, `naming`, `surfaces`…
>
> **Reversing a decision** never edits or deletes a line — append a superseding one and move the old
> one to `## Superseded`:
>
> ```
> - <YYYY-MM-DD> · <area> · <the new decision> — because <reason> · supersedes <YYYY-MM-DD> <area> · <feature_id>
> ```
>
> **Keep it bounded:** when `## Live` passes ~100 lines, move every superseded line into
> `## Superseded` (the audit trail survives; the section the deciding stages actually read stays
> short). Never summarize or merge live lines — a decision either holds or has been superseded.
>
> **What does NOT belong here:** anything the code, the tests, `PIPELINE.md` §Conventions or a spec
> already states; a feature-local choice (that lives in its spec); a task, a TODO or a finding (those
> are `## Remediation` and `specs/refactor-backlog.md`).

## Live

<!-- newest last -->

- 2026-08-04 · api · Re-keying an existing IPC domain rewrites that domain's contract file in place; never a second file for the same domain — because two files defining the same payload types is how a contract silently forks · multiple-shells
- 2026-08-04 · ui · Bare letters stay GLOBAL shortcuts; a context-local action takes a modified key (⌘X / Ctrl+Shift+X) and must be a documented PTY carve-out — because the shell forwards every unmodified key verbatim · multiple-shells

## Superseded

<!-- moved here when a line above supersedes them; never deleted -->
