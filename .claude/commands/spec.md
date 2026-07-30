---
description: Interactively capture a frozen feature spec (or apply a review return) into specs/<id>.md.
argument-hint: [paste brainstorm return OR review report]
---

You run the **spec** step in the main thread — interactive, with the human. Pasted input below:

**$ARGUMENTS**

> Read `PIPELINE.md` first: `contract` (mechanism/path — so §5 names the right schema types),
> `design.enabled` (whether §8 matters), and §Conventions. Use `specs/_template.md` as the section list.
>
> Template paths below (`.claude/templates/…`) resolve to `~/.claude/templates/…` when the core is
> installed globally — read whichever exists.
>
> **Kanban** (SCHEMA.md §Kanban): when the spec opens, move card `#<feature_id>` → **Spec**; on freeze
> (`status: frozen`, Mode A) → **Ready to build**. No-op silently if no board is configured.

Detect the mode from the pasted content:

## Mode A — new spec (input is a brainstorm return, or empty)

1. If empty, look for a staged brainstorm return first — `specs/reports/*-brainstorm.md` (where
   `/brainstorm` stages its output); one match ⇒ read it and confirm, several ⇒ ask which. None ⇒
   ask the human to paste the return (or describe the feature) and wait.
2. Derive a `feature_id` (kebab-case slug). Confirm it.
2b. **Size budget — a spec is a contract, not a novel.** Target ≤ ~300 lines; hard-think at 500.
   Every implementer re-reads the whole spec on every first build, so each extra line is paid
   `surfaces × dispatches` times. If the feature genuinely needs more, that's the signal it is TWO
   features: propose a split (e.g. `<id>-core` + `<id>-admin`, each independently shippable, the
   second consuming the first's contract) and let the human pick. Trim the usual bloat before
   writing: exhaustive UI walkthroughs (the design brief carries those), restated conventions
   (PIPELINE.md carries those), speculative edge cases nobody asked for.
3. Walk the human through each section of `specs/_template.md`, **section by section**, with focused
   questions. The critical one is **§5 API CONTRACT** — pin down every endpoint/interface (method, path,
   auth/role, request fields with types/validation, success envelope + data shape, and every error case),
   and name the exact schema/types that will live in the contract file (`contract.path/<id>.<ext>` in the
   profile's `mechanism`). Don't move on until frontend and backend could each build from it with zero
   further questions. _If `contract.enabled` is false, capture the interface precisely in prose instead._
4. Capture the **design brief** content (only if `design.enabled` / the feature has UI): screens,
   states, components, responsive notes — it will be authored to `specs/design/<id>.md` in step 6;
   spec §8 carries only a short summary + the pointer `> full brief: specs/design/<id>.md` (so
   non-design surfaces never re-read the full brief on every dispatch).
4b. **New-surface heads-up.** If the feature clearly introduces an area no existing `surfaces[].path`
   owns (a new service/app/top-level module), note it in the spec (a line in the relevant task section:
   `> needs new surface: <proposed key/path>`). Don't render agents here — `/build` §1.5 auto-reconciles
   it. This is just so the human isn't surprised when `/build` proposes a new agent.
5. When the human validates, **freeze**: write `specs/<id>.md` (`status: frozen`, front-matter filled).
   Create the file — do not ask the human to. **Postcondition:** `grep -q '^status: frozen' specs/<id>.md`
   — if it fails the freeze didn't land; fix it before pointing the human at `/build`. Chain the
   opt-in usage ping onto the postcondition's Bash call (`/build` §4's shared form, `<phase>` =
   `spec`, `<seconds>` = `0` — interactive time, not pipeline wall-clock, `<results>` = `frozen`).
   Ping only on a **landed** freeze, so the funnel counts specs that exist, not attempts. Mode B does
   not ping — it re-enters an already-counted spec, and `/fix` covers that loop. Silent no-op without
   consent; never ask about consent here.
6. Author the **design brief** — `specs/design/<id>.md`, rendered via
   `.claude/templates/design-brief.md` (resolves to `~/.claude/templates/…` on a global install).
   _Only if `design.enabled` / the feature has UI; skip entirely for a backend-only feature._
   - **Write it to `specs/design/<id>.md`** (the authored artifact, versioned with the spec; spec §8
     holds the summary + pointer). Create the file — do not ask the human to. Keep it in the
     `specs/design/` subfolder, **not** `specs/<id>....md`: the `specs/*.md` glob that drives the
     kanban backfill and `/doctor` is non-recursive, so a brief in the subfolder never gets mistaken
     for a spec (no phantom card, no bogus stage). Overwrite it on every freeze.
   - Print ONLY the path + a one-line summary — never echo the brief into chat (it would sit in this
     session's history; echo it only if the human asks). Tell the human: copy it from
     `specs/design/<id>.md` into the design tool (if any — typically a fresh design project for this
     feature), then run `/build <id>` and hand its design gate the resulting page link(s) — a full
     `https://claude.ai/design/p/<projectId>?file=<file>` link carries its own project + page, no
     profile change needed. (They can also paste the links into the spec's `design_files` themselves.)
     **Recommend a `/clear` before `/build`** — the frozen spec + `specs/design/<id>.md` are the whole
     handoff.

## Mode B — review return (input is a REVIEW REPORT)

1. Read the report — pasted as input, or (whenever nothing is pasted) read from
   `specs/reports/<id>.md`, where `/review` stages its last report. Identify `feature_id` from its
   header; open `specs/<id>.md`.
2. Append each finding to the spec's **`## Remediation`**, one per line:
   `- [ ] <severity> · <file:line> · <spec-violation|quality|security> · <concrete fix>`
   (Keep prior items; add the new round under a dated/numbered subheading.)
3. If a finding implies the **contract** must change, update §5 and flag it so the lead re-authors the
   contract file.
4. Set `status: in-review`. Tell the human to run `/build <id>` to re-dispatch fresh agents.
   **Recommend a `/clear` before `/build`** — the spec is the whole handoff.

In both modes the spec is the single source of truth; agents are stateless and read only it + the diff.
