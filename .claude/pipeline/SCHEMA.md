# PIPELINE.md profile — field reference

`/init-pipeline` fills the `yaml pipeline-profile` block in `PIPELINE.md` (from
`PIPELINE.template.md`) plus the prose sections. This documents every field and how the
generic pipeline uses it, so a stateless agent can read/regenerate the profile correctly.

## `yaml pipeline-profile` block

| Field                                | Type         | Used by                           | Meaning                                                       |
| ------------------------------------ | ------------ | --------------------------------- | ------------------------------------------------------------- |
| `name`                               | string       | all                               | Project name, used in agent prose + commit scopes.            |
| `one_liner`                          | string       | brainstorm/spec                   | One-sentence product description.                             |
| `ui_language`                        | string       | implementer, review               | Language of ALL user-facing copy.                             |
| `package_manager`                    | enum         | all                               | `pnpm`/`npm`/`yarn`/`bun`/`pip`/`cargo`/`go`.                 |
| `vcs.host`                           | enum         | release                           | `github`→use `gh`; else emit compare URL.                     |
| `vcs.remote`                         | string       | release                           | `owner/repo` for the PR/compare URL.                          |
| `vcs.default_branch`                 | string       | build, review, release            | Base branch for diffs + PRs.                                  |
| `vcs.feature_branch_prefix`          | string       | ship, isolation script            | `feature/` → branch `feature/<id>`.                           |
| `repo.layout`                        | enum         | build, audit                      | `monorepo` (many surfaces) or `single`.                       |
| `repo.workspace_tool`                | enum         | audit                             | `turborepo`/`nx`/`none`.                                      |
| `retrieval.provider`                 | enum         | init, update-pipeline, implementer | `serena` (default) / `graphify` / `none` — see §Code retrieval. |
| **`surfaces[]`**                     | list         | **build, review, refactor, init** | One per independently-built area. Grows via reconcile (below). |
| `surfaces[].key`                     | string       | build                             | Short id + review scope.                                      |
| `surfaces[].path`                    | string       | implementer                       | The ONLY tree that surface's agent may touch.                 |
| `surfaces[].label`                   | string       | build, init (`<SURFACE_LABEL>`)   | Human label + framework, e.g. `frontend (React)`.            |
| `surfaces[].agent`                   | string       | build (`subagent_type`)           | Rendered agent file name.                                     |
| `surfaces[].tools`                   | list         | init                              | Frontmatter `tools:` for the rendered agent.                  |
| `surfaces[].model`                   | enum         | init (`<SURFACE_MODEL>`)          | Frontmatter `model:` tier — `sonnet`/`haiku`/`inherit`. Default `sonnet` (implementers mostly apply a frozen contract — far cheaper than the Opus lead the dispatcher runs on, and Sonnet handles it well); `haiku` for purely mechanical surfaces (scaffolding); `inherit` only for surfaces with real design decisions worth the lead's model. |
| `surfaces[].*_cmd`                   | string       | implementer                       | test/lint/format/typecheck/build commands.                    |
| `surfaces[].test_quiet_cmd` `.lint_quiet_cmd` | string | implementer, preflight, workflows | Bridled variants agents actually run (dot reporter / `--quiet` / failures-only). `""` ⇒ `<cmd> 2>&1 \| tail -40`. See §Output discipline. |
| `surfaces[].uses_design`             | bool         | build, frontend                   | Whether this surface consumes designs.                        |
| `contract.enabled`                   | bool         | build                             | `false` ⇒ skip contract authoring (§2 of /build).             |
| `contract.mechanism`                 | enum         | build, lead                       | `shared-types-zod`/`openapi`/`protobuf`/`json-schema`/`none`. |
| `contract.path` `.ext` `.index`      | string       | build                             | Where `<feature_id>` contract is authored + barrel.           |
| `contract.authored_by`               | const `lead` | build                             | Implementers import it read-only, never edit.                 |
| `commands.*`                         | string       | all                               | Repo-wide install/dev/lint/format/typecheck/test + migrate.   |
| `commands.test_quiet` `.lint_quiet`  | string       | review, smoke, audit, workflows   | Repo-wide bridled variants — what the `/review`·`/smoke` pre-flight runs. Same fallback as the per-surface ones. |
| `rbac.enabled`                       | bool         | brainstorm, review                | Toggle RBAC personas + authz audit.                           |
| `rbac.hierarchy`                     | list         | review                            | Highest→lowest role list.                                     |
| `design.enabled`                     | bool         | build, frontend, align-ds         | `false` ⇒ design steps are no-ops.                            |
| `design.provider`                    | enum         | frontend, align-ds                | `claude-design`/`figma`/`none`.                               |
| `design.design_system_project`       | id           | align-ds, frontend                | UI-kit source of truth.                                       |
| `design.design_project`              | id           | build, frontend                   | Legacy fallback for bare-filename `design_files` only; default `none`. New specs use full `…/design/p/<projectId>?file=<file>` links that carry their own project + page (nothing to go stale on a DS rebuild). |
| `design.snapshot_dir`                | path         | align-ds                          | Committed DS snapshot for diffing.                            |
| `design.ui_kit_path` `.tokens_path`  | path         | align-ds, frontend                | Where the kit + tokens live in code.                          |
| `isolation.enabled`                  | bool         | new-feature script                | `false` ⇒ build in main checkout.                             |
| `isolation.db_per_worktree`          | bool         | new-feature script                | Create `<name>_<id>` DB per worktree.                         |
| `isolation.db_name_pattern`          | string       | new-feature script                | `<name>_<id>`.                                                |
| `isolation.port_base`                | map          | new-feature script                | `api`/`web` base ports; +slot per worktree.                   |
| `isolation.compose_file` `.registry` | path         | new-feature script                | Docker stack + slot registry.                                 |
| `gate.deny[]`                        | list         | hooks/gate.py, settings           | Command substrings hard-denied, on any branch.                |
| `gate.ask[]`                         | list         | hooks/gate.py, settings           | Command substrings that require confirm, on any branch.       |
| `gate.ask_on_default_branch[]`       | list         | hooks/gate.py                     | Confirm ONLY on `default_branch`; free on feature branches.   |
| `gate.default_branch`                | string       | hooks/gate.py                     | Protected branch (default `main`); gate resolves via git.     |
| `gate.preflight.enabled`             | bool         | hooks/gate.py, review, smoke      | Phase gate: review/smoke dispatches need a fresh preflight stamp. See §Preflight. |
| `gate.preflight.agents[]`            | list         | hooks/gate.py                     | `subagent_type`s the stamp gates (default `[review, smoke]`). |
| `gate.preflight.max_age_minutes`     | number       | hooks/gate.py                     | Stamp freshness window (default 30).                          |

## Prose sections

- **Conventions** — per-surface rules the implementer follows and review audits.
- **Testing** — the TDD contract per surface (what a test must cover, DB isolation).
- **Design brief note** — feeds `/spec` §8 and the Claude Design step.
- **Personas** — the `/brainstorm` panel; include one per RBAC role when `rbac.enabled`.

## How the pieces reference this file

- **Agents** (`implementer`, `review`, `release`) are told at dispatch: _read `PIPELINE.md`
  §Commands / §Conventions / §Surfaces first._ They have `Read`, so they load it live.
- **Commands** (`/build`, `/review`, …) parse the `yaml pipeline-profile` block to know how
  many surfaces to dispatch, the contract mechanism, the commands, and the capability flags.
- **Hook** (`gate.py`) reads `gate.deny`/`gate.ask`/`gate.ask_on_default_branch`/`gate.default_branch`
  from a generated `.claude/gate-config.json`. The last two make git + docker free on feature branches
  but confirm-gated on the default branch (branch resolved at run time via `git rev-parse`).
- **Scripts** (`new-feature.sh`) read the `isolation` block (rendered in at init).

## Code retrieval — `retrieval.provider`

Agents spend most of their wall-clock reading the repo; a retrieval provider replaces grep-and-read
with symbol/graph queries. The flag is a **value, not a boolean**, so switching provider later is a
one-line profile change + re-running the wiring (no agent re-render needed — the guidance agents
follow is provider-agnostic: _"prefer the retrieval MCP tools over Grep/Glob + whole-file Reads"_).

| Provider | Mechanism | Freshness | Cost |
| --- | --- | --- | --- |
| `serena` (default) | live LSP symbol navigation (find symbol, references, semantic edits) | always current | none — no index |
| `graphify` | persistent tree-sitter knowledge graph over code + docs | as fresh as the last rescan | index step + re-index discipline |
| `none` | agents fall back to Grep/Glob/Read | — | — |

**Wiring (done by `/init-pipeline`, or `/update-pipeline` retroactively):**

- `serena` — requires the `serena` CLI (`uv tool install -p 3.13 serena-agent`). For day-to-day CLI
  use it should also be on PATH (`uv tool update-shell`; uv installs to `~/.local/bin`). Register at
  **project scope** so the registration is committed and portable (`--project-from-cwd` resolves the
  project at server start, so the committed entry works on every machine) — and register the
  **PATH-proof launcher**, not the bare command: Claude Code spawns MCP servers with whatever
  environment it was launched from (a stale terminal, a GUI/IDE launch that never sourced a shell
  profile), where `~/.local/bin` may be missing from PATH — a bare `serena` entry then dies with
  ENOENT and agents silently fall back to Grep/Read:

  ```sh
  claude mcp add --scope project serena -- sh -c 'exec "$(command -v serena || echo "$HOME/.local/bin/serena")" start-mcp-server --context claude-code --project-from-cwd --open-web-dashboard False'
  ```

  (Windows-native teams: no `sh` — register the bare `serena` form instead and ensure the uv tools
  dir is on PATH; keep the `--open-web-dashboard False` flag.) `--open-web-dashboard False` keeps the
  dashboard available (reachable at `http://localhost:24282/dashboard/`) but stops it popping a browser
  tab on every server start — the flag overrides the machine's `serena_config.yml`, so the behaviour is
  the same for everyone on the repo. Gitignore `.serena/` (per-machine cache/config). Optionally
  pre-index large repos once: `serena project index`.
- `graphify` — requires `uv tool install graphify` + `graphify install`; build the initial graph
  (`/graphify .`) and rescan incrementally after big changes (`--update`). See graphify.net.
- Rendered agents get the provider's MCP tools appended to their `tools:` list (e.g. `mcp__serena`
  grants the whole server); `none` ⇒ nothing appended.

**Serena health check** — run after wiring in `/init-pipeline` AND on every `/update-pipeline`
reconcile (wiring that worked once can rot: PATH changes, tool uninstalled, entry hand-edited):

1. **CLI resolves:** `command -v serena`. Fails but `~/.local/bin/serena` exists ⇒ PATH repair
   above; missing entirely ⇒ reinstall.
2. **Registered:** this repo's `.mcp.json` has the `serena` entry ⇒ else re-run the `claude mcp add`.
   If the entry is the bare `serena` form on a POSIX machine, upgrade it to the PATH-proof launcher
   above (immune to launch-environment PATH gaps). If a launcher entry predates the
   `--open-web-dashboard False` flag, append it so the dashboard no longer auto-opens a browser tab.
3. **Gitignored:** `.serena/` is in `.gitignore` ⇒ else append it.
4. **Actually connected:** the `mcp__serena` tools are exposed in the session (or `claude mcp list`
   shows serena connected). If 1–3 pass but this fails, a session restart is needed — say so
   explicitly instead of reporting success.

Report each check's result; never report Serena "wired" on registration alone.

Teammates cloning the repo get the committed `.mcp.json` and only need the provider CLI installed
and on PATH — if either is missing, the MCP server fails to start and agents silently fall back to
Grep/Read; the health check above is the diagnostic.

## Specialization — when to split one surface into more agents

`/build` dispatches ONE agent per surface, in parallel, so build wall-clock ≈ the **slowest single
surface**. More agents only build faster when they let the *slowest* surface's work run concurrently —
and only if the split is safe. The invariant that keeps parallelism safe is **one owner per tree, and
the frozen contract as the only cross-surface channel**. So specialization means carving a surface into
**smaller non-overlapping surfaces**, never pointing two agents at the same tree.

**Split a surface into specialized sub-surfaces only when BOTH hold:**

1. **It's a bottleneck** — the surface is large (many modules / high LOC) and dominates build time.
2. **The boundary is clean** — its work partitions into trees that don't share files, e.g. feature
   modules (`src/features/*`, `src/modules/*`), route groups, or independent services (`services/*`).

**Rules when splitting (non-negotiable — they preserve the invariant):**

- **Shared code gets its own surface with a single owner.** Anything two slices both touch — routing,
  global state/store, the design-system kit + tokens, shared utils — becomes its OWN surface (e.g.
  `web-shared`), owned by exactly one agent. Never let two feature-slice agents both edit shared trees.
- **Cross-slice references go through the contract**, not direct imports between slice trees. If
  `web-checkout` needs a shape produced by `api-billing`, that shape lives in the frozen contract.
- **Don't over-split.** A slice too small to hold ≥1 real task, or one with tangled boundaries, is worse
  than not splitting — the coordination + token cost (each stateless agent re-reads `PIPELINE.md` + spec)
  outweighs the parallelism. When boundaries aren't clean, keep one surface.

Coarse first, specialize on evidence: start with one `frontend` / `backend` surface each; split only a
surface that's proven slow and cleanly separable. The evidence lives in
the **main checkout's** `.claude/pipeline-metrics.jsonl` (gitignored) — one JSONL line per phase batch
(`ts`/`feature`/`phase`/`seconds`/`surfaces:{key: result}`), appended by `/build`, `/review`, `/fix`
and `/smoke`. Always the main checkout, never the feature worktree (which dies at teardown while
metrics must accumulate across features) — resolve from anywhere with
`$(dirname "$(git rev-parse --git-common-dir)")/.claude/pipeline-metrics.jsonl`. Read it before
proposing a split: split the surface that actually dominates wall-clock, not the one that feels big.

## Measuring cost — what's slow vs what's expensive

`pipeline-metrics.jsonl` records **wall-clock seconds** per phase batch (§Specialization) — it tells you
what's SLOW. It deliberately does NOT record tokens: the lead can't reliably read a subagent's token count
to log it. For what's EXPENSIVE, use Claude Code's own accounting:

- **`/cost`** (built-in, zero setup) — reports per-**subagent** and per-**slash-command** share of your usage
  over the last 24 h / 7 d (e.g. _"Top subagents: frontend 7 %, backend 4 % · Top skills: /build 1 %,
  /review 1 %"_). That IS the per-phase ledger — approximate (share-of-total, machine-local, not exact
  tokens). Read it to see which surface/command actually dominates the bill before you tune a `model` tier.
- **OpenTelemetry** (exact numbers + dashboards) — add an `env` block to `~/.claude/settings.json`:
  `{"env":{"CLAUDE_CODE_ENABLE_TELEMETRY":"1","OTEL_METRICS_EXPORTER":"otlp","OTEL_EXPORTER_OTLP_PROTOCOL":"http/protobuf","OTEL_EXPORTER_OTLP_ENDPOINT":"http://localhost:4318"}}`
  and point it at a collector. Metrics `claude_code.token.usage` + `claude_code.cost.usage` carry
  `session.id` + model + type (input/output/cacheRead). Subagent tokens roll into the session total;
  per-subagent attribution needs traces (`CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1`, beta).

**Lead context discipline — the silent bill.** The lead session's conversation history is re-sent as
input on EVERY turn; a session that spans spec→build→smoke→review→fix without clearing re-pays the
accumulated spec walk-through, handoffs, and reports on each turn. The pipeline is built so this is
never necessary: every phase handoff (spec, contract, diff, staged reports) lives on disk, so `/clear`
at each phase boundary is always safe — each command's closing line recommends it. Corollaries the
commands enforce: never paste a diff into a dispatch (agents compute their own, scoped); never echo a
staged report or design brief into chat; redirect bulky command output to a file and grep it.

## Output discipline — quiet commands

A test runner's default output is written for a human watching a terminal: one line per test, banners,
timing tables. An agent pays input price for every one of those lines, on every turn they survive in its
context. The profile therefore stores **two forms of each noisy command**:

- `test_cmd` / `lint_cmd` — the full form, for a human running it by hand.
- `test_quiet_cmd` / `lint_quiet_cmd` (per surface) and `commands.test_quiet` / `commands.lint_quiet`
  (repo-wide) — the **bridled** form agents actually execute: dot/failures-only reporter
  (`--reporter=dot`, `--quiet`, `-q`, `--silent`, framework equivalent) so a green run costs lines,
  not pages, and a red run prints only the failures.

Rules for every consumer (implementers, preflight, `/audit` gates, workflow agents):

1. Run the quiet variant when set.
2. Quiet variant empty/absent (older profile) ⇒ run `<full cmd> 2>&1 | tail -40` — never the bare
   command into your context.
3. Need the full log? Redirect it to a file and grep it; never print it.

`/init-pipeline` **asks** for these variants (detected defaults offered first) instead of silently
storing a bare `pnpm test` as the thing agents execute; `/update-pipeline` tops up older profiles.

## Preflight — the deterministic phase gate

`/review` and `/smoke` start by running `pipeline/scripts/preflight.sh` — a plain shell script (no
agent) that executes the profile's mechanical checks in order (typecheck → lint → tests, quiet
variants) with all output redirected to `specs/reports/<id>.preflight.txt`:

- **Any check red** ⇒ the script prints the last 40 lines raw and exits 1. The command **aborts
  there: zero agents are spawned.** A reviewer dispatched onto code that doesn't compile burns its
  whole run rediscovering what `tsc` already printed for free — the failure goes straight to the
  human (or `/fix`) instead.
- **All green** ⇒ the script stamps `.claude/preflight.ok` (`<epoch> <HEAD sha>`).

`hooks/gate.py` enforces the stamp as a **phase gate** (the `preflight` block of `gate-config.json`,
generated from `gate.preflight`): a Task dispatch of a listed `subagent_type` (default
`review`/`smoke`) with a missing/stale stamp — older than `max_age_minutes`, or HEAD moved — gets an
"ask", so a lead can't accidentally skip the gate but a human can consciously override it. The gate
hook fires for **every** agent in the session, including subagents spawned by the Workflow runtime
(they run in `acceptEdits` whatever the session mode — Write/Edit auto-approved — but Bash and Task
still pass through hooks). In `bypassPermissions` (headless runs) every gate "ask" is escalated to a
hard deny, because nobody is there to answer a prompt.

## Rendering / reconciling a surface agent (shared procedure)

Both `/init-pipeline` (initial render) and `/build` (auto-reconcile when a spec needs a new agent) use
this exact procedure so a surface is always defined the same way. To add surface `S`:

1. **Add the `surfaces[]` entry** to `PIPELINE.md`: `key`, `path` (the disjoint tree it exclusively
   owns), `label`, `agent` (rendered file name), `tools` (add `DesignSync` only if `uses_design: true`;
   append the retrieval provider's MCP tools when `retrieval.provider` ≠ `none` — e.g. `mcp__serena`),
   `model` (tier for the rendered agent: `sonnet` (default) — the implementer mostly applies a frozen
   contract, which Sonnet does well at a fraction of the Opus-lead cost; `haiku` for purely mechanical
   scaffolding; `inherit` only when the surface makes real design decisions worth the lead's model),
   the five `*_cmd`s (derive from the surface's `package.json` / workspace
   filter, mirroring a sibling surface), and `uses_design`.
2. **Render the agent file** `.claude/agents/<agent>.md` from `pipeline/implementer.template.md`
   (resolve bundled `.claude/` vs global `~/.claude/`), substituting `<SURFACE_AGENT>`, `<SURFACE_LABEL>`,
   `<SURFACE_PATH>`, `<SURFACE_TOOLS>`, `<SURFACE_MODEL>`, `<PROJECT_NAME>`, and the surface-specific
   blocks (`<SURFACE_EXTRA_NEVER>`, `<SURFACE_DESIGN_INPUT>`, `<SURFACE_TDD_STEP1>` — leave the design
   ones empty unless `uses_design`). Fill `<SURFACE_CONVENTIONS>` with the surface's convention slice
   **baked at render time**: `PIPELINE.md` §Conventions `### Shared` + this surface's
   `### Surface: <key>` stanza + its §Testing lines, verbatim. At runtime the agent then reads only
   the profile's machine block (the fenced `yaml pipeline-profile`) — never the prose sections. The
   bake stays honest because §Conventions edits go through `/update-pipeline`, whose reconcile
   re-renders every agent (step 2 below); hand-edit the prose without re-rendering and the baked
   slice goes stale — that's the trade for not re-reading the prose on every dispatch. For a `uses_design` surface, fill them **link-based** (never with a
   stored `design_project` id — that goes stale on a DS rebuild):
   - `<SURFACE_DESIGN_INPUT>` — a 4th input bullet: _"The **feature design** — the pages this feature
     touches, listed in your dispatch's design slot as full links
     (`https://claude.ai/design/p/<projectId>?file=<file>`); a slot saying `none` means a fix loop with
     no visual work — skip DesignSync entirely. For each link, extract the `<projectId>` (the
     `/p/…` segment) and `<file>` (the `?file=` query) from the URL and read it read-only via `DesignSync
     get_file(<projectId>, <file>)`; `list_files(<projectId>)` to catch linked pages (shared nav/modals)
     this feature also changes. The link is self-contained — no stored project id. Build with the code UI
     kit (the `design_system_project`'s materialization: `@/components/ui/*` + tokens); read a primitive
     via `get_file` only if it's missing/stale in code. Mobile-first."_
   - `<SURFACE_TDD_STEP1>` — _"**Pull the feature design first** (skip if your dispatch's design slot
     says `none`): `DesignSync get_file(<projectId>, <file>)` for each link in the slot and translate
     each into the code design system (`@/components/ui/*`, `cn()` + CVA), mobile-first — never ad-hoc
     CSS. Then:"_
3. **Add a §Conventions + §Testing stanza** for `S` in `PIPELINE.md` (mirror a sibling surface; keep it
   rule-shaped). If `S` is a shared-code surface, its convention is "single owner of shared X; slices
   consume, never redefine."

Removing/merging a surface is the reverse: drop the `surfaces[]` entry, delete its agent file, fold its
conventions. Never leave an agent file with no matching `surfaces[]` entry (orphan) or vice-versa.

## Reconcile — bringing generated files up to the current core

`/init-pipeline` is **one-time per project**. Afterwards, `/update-pipeline` runs this procedure so a
core upgrade never requires re-running init — new pipeline features flow into the repo's generated
files automatically. It works because every generated artifact is a **deterministic function of
(current template × the profile's data)**; nothing needs re-detecting or re-interviewing.

1. **Profile top-up.** Diff `PIPELINE.md`'s machine block against the current
   `pipeline/PIPELINE.template.md`: every block/field the template has and the profile lacks is added
   with its documented default (e.g. `surfaces[].model: sonnet`, `retrieval.provider: serena`).
   **Ask only when a new field is a genuine human decision** (batch into ONE question set); never
   change a value the profile already sets; never rewrite the prose sections.
2. **Re-render agent frontmatter + body.** For each `surfaces[]` entry, re-render
   `.claude/agents/<agent>.md` from the current `implementer.template.md` per §Rendering above. Safe by
   doctrine: rendered agents are regenerable artifacts — hand-written rules belong in `PIPELINE.md`
   §Conventions (which reconcile never touches), NOT in agent files, where they'd be clobbered here.
3. **Additive settings patch.** Bring `.claude/settings.json` + `gate-config.json` up to the current
   init spec (missing `allow` entries, hooks per install mode) — add what's missing, never remove or
   rewrite existing/custom keys.
4. **Capability wiring.** If a top-up added a capability needing external setup (e.g. a `retrieval`
   provider whose MCP server isn't registered yet), run its wiring step from `/init-pipeline` Phase 4.
   Even when nothing new was added, re-run the provider's health check (§Code retrieval) — wiring
   rots (PATH changes, uninstalls, hand-edits) — and repair whatever fails.
5. **Global config seed.** If `~/.claude/cohorte.config.yaml` is absent, seed it from the template
   (`profile/cohorte.config.template.yaml`) so the kanban + shared-vault config has a home. Never
   clobber an existing filled file; report what was seeded.
6. **Kanban sync.** Run the §Kanban reconcile: link/create the project's board if configured, verify
   its columns, and backfill/sync cards from `specs/*.md`. See §Kanban.

Re-running `/init-pipeline` remains possible (it reconciles too) but is only *needed* when the stack
itself changes in ways `/build` §1.5 can't auto-grow (e.g. package manager or contract mechanism swap).

## Workflows — deterministic multi-agent runs (opt-in)

Three phases have a **workflow variant** — a deterministic orchestration script the Claude Code
Workflow runtime executes instead of the lead reasoning out the fan-out turn by turn:
`<core>/workflows/review.js`, `audit.js`, `refactor.js` (installed to `.claude/workflows/` bundled or
`~/.claude/workflows/` global). The conversational commands (`/review`, `/audit`, `/refactor`)
**remain the default path and the fallback** — a workflow runs only when the human explicitly asks
for it ("run the review workflow", or via the `/cycle <id>` launcher command, which resolves
`cycle.js` and invokes the runtime for them), and requires Claude Code ≥ **2.1.154** with workflows
enabled.
`/doctor` reports which path a session will take. The interactive commands (`/init-pipeline`,
`/brainstorm`, `/spec`) and the dispatch-only ones (`/build`, `/ship`) have **no** workflow variant on
purpose: they're interviews or already a single parallel dispatch — a script adds nothing.

Shared design, all three scripts:

- **Phase 0 is always `profile-reader`** — workflow scripts have no filesystem or shell access, so a
  dedicated agent (`core/agents/profile-reader.md`, haiku, read-only) reads `PIPELINE.md` and returns
  the `yaml pipeline-profile` block as JSON. Every later phase is parameterized from that object.
- **Mechanical phases run on haiku** (profile read, preflight, diff staging, report merging/writing);
  judgment phases dispatch the same pinned agents the commands use (`review` at sonnet, the surface
  implementers at their `surfaces[].model` tier) — the per-surface `model:` routing carries over.
- **Only the verdict comes back.** Bulk (diffs, reports, backlogs) is staged to the same disk
  buffers the commands use (`specs/reports/`, `specs/refactor-backlog.md`); the workflow's return is
  counts + verdict + paths.
- **`review.js`** — preflight gate (aborts red, zero agents), one `git diff --stat` staged per
  touched surface, one reviewer per surface in parallel, then an **adversarial cross-check** phase
  that tries to refute each CRITICAL/security finding before it can trigger a fix loop.
- **`audit.js`** — one auditor per domain (each surface + `shared`), concurrency capped by the
  runtime (~16), merged into the prioritized `specs/refactor-backlog.md`.
- **`refactor.js`** — big domains only (it skips domains with a handful of open items — the
  conversational `/refactor` is cheaper there): `shared` first and alone, then the other domains'
  implementers in parallel, each verified per-domain.
- **`cycle.js`** — the **full dev cycle** on a frozen spec: contract → parallel build → rounds of
  [preflight → smoke ∥ review(+cross-check) → fix on the surfaces with findings], looping until
  **zero open findings + a PASS smoke** (`maxRounds`, default 5, and the token budget are runaway
  protection, not targets). Since a workflow can't ask anything mid-run, the decisions move to the
  edges: a **readiness gate** aborts up front if the spec isn't frozen (other gaps ride along as
  deferred questions), and everything genuinely human comes back at the END in the result's
  `questions` array — empty when `/brainstorm` + `/spec` did their job. Even a finding that implies
  a **contract change stays inside the loop**: a lead-equivalent agent re-authors spec §5 + the
  contract file (exactly what conversational `/fix` §1 does — implementers still never touch it),
  the consuming surfaces re-dispatch, and the loop continues; the re-authorings are reported in the
  result's `contractChanges` for the human to review in the diff. A clean exit ticks the DoD and
  stamps the freshness gate so `/ship <id>` is a straight shot; a stopped run appends its open
  findings to the spec's `## Remediation` so a rerun of the cycle — or a conversational `/fix` —
  continues seamlessly. `/ship` itself stays outside on purpose — outward-facing and irreversible,
  it keeps its human confirmation.
  **Corollary — harden the spec:** the more `/brainstorm` + `/spec` pre-answer (edge cases, error
  envelopes, role matrix, design links), the further the cycle runs and the emptier `questions`
  comes back; a vague spec just converts into deferred questions.
- **No input mid-run.** A workflow runs to completion without questions; anything interactive
  (contract changes, human decisions) belongs to the conversational path — or, for `cycle.js`, to
  the `questions` array of its result. The gate hook still fires on workflow subagents (see
  §Preflight) — in unattended runs its asks become denies.
- **Permissions:** `/init-pipeline` and `/update-pipeline` extend the generated `settings.json`
  `allow` list with what workflow agents need (the quiet commands, the shipped
  `pipeline/scripts/*.sh`, read-only git incl. `git rev-parse`, and the retrieval provider's MCP
  tools) so a run never stalls mid-workflow on a permission prompt nobody is watching.

## Kanban — mirroring the pipeline onto an Obsidian board

An **optional, user-scoped** mirror of the dev flow: each pipeline stage moves a card across an
[Obsidian Kanban](https://github.com/mgmeyers/obsidian-kanban) board, one board per project. Config
lives in the consolidated global config `~/.claude/cohorte.config.yaml` §`kanban` (NOT in
`PIPELINE.md` — the board path points at the user's personal vault, so it is machine-specific and must
not be committed). Everything below **no-ops silently** when the config is absent, `kanban.enabled` is
false, no board is configured for the current project, or the board file is missing — the pipeline never
blocks on the board.

**Config & board resolution.** `kanban.boards` is keyed by the project's `PIPELINE.md` `name`. To resolve
the current project's board: read `name` from `PIPELINE.md`, look up `kanban.boards[name]`. Found ⇒ the
board file is `<obsidian.vault_path>/<boards[name].board>`, its columns are `boards[name].columns` if
present else `kanban.columns`. Not found ⇒ kanban off for this project.

**Card format.** A card is a Kanban list item under a `## <column>` heading:
`- [ ] <human title>  #<feature_id>`. The `#<feature_id>` tag is the join key between a card and its
`specs/<feature_id>.md`; it is how every stage finds *its* card (Grep the board for `#<id>`). Free-text
notes a human writes as sub-bullets under an Ideas card are seed context for `/brainstorm`. Never touch
the trailing `%% kanban:settings … %%` block or the `kanban-plugin: board` front-matter.

Once shipped, `/ship` appends the **PR number** to the card — `- [ ] <title> #<feature_id> — PR #<num>`.
The bare `#<num>` is what the dashboard renders as a clickable link to the GitHub PR, so `/ship` always
writes it when a PR was actually created.

**Move a card (the core op).** Use the shipped script — it does the whole op outside the agent's
context (find, dedupe, sub-notes carried along, settings block preserved):
`<core>/pipeline/scripts/kanban-move.sh <board.md> <id> <column> [--pr <num>] [--title <title>]`
where `<core>` is `~/.claude` (global install) or `.claude` (bundled) — probe with `test -x`. It
creates the card in the target column when none exists, keeps the first and drops duplicates, and
appends ` — PR #<num>` with `--pr`. **Fallback when the script is absent** (older core): do it by
hand, but never read the whole board into context — it grows with every feature ever tracked:
`grep -n` for `#<id>` and the `## ` headings to locate lines, then use offset-limited Reads +
targeted Edits around the matches. Either way: one card per `#<id>`, whole line moved tag-preserved,
card created in the target column if missing.

**Stage → column**, used both by each pipeline command (to move its card live) and by backfill:

| Pipeline moment                         | Column          |
| --------------------------------------- | --------------- |
| human drops a raw idea (manual)         | `ideas`         |
| `/brainstorm` picks it up               | `brainstorm`    |
| `/spec` opens (draft)                   | `spec`          |
| `/spec` freezes (`status: frozen`)      | `ready`         |
| `/build`                                | `building`      |
| `/smoke` · `/review`                    | `review`        |
| `/fix`                                  | `fix`           |
| `/ship` starts                          | `ship`          |
| PR opened (`status: shipped`)           | `shipped` (+ `PR #<num>` on the card) |

**Backfill / sync from specs (reconcile).** `specs/*.md` is the source of truth. For each spec, read its
`feature_id` (front-matter or filename) and `status`, map `status`→column — `frozen`→`ready`,
`in-review`→`review`, `shipped`→`shipped`, anything else / a spec with no status→`spec` — then **full
sync**: card absent ⇒ add it in that column; card present ⇒ **move it** to that column so the board
always reflects the specs (this repositions cards the human may have moved by hand). Report cards
added vs. moved vs. already-correct.

**Create a board.** When linking a project with no board file yet: write
`<obsidian.vault_path>/<folder>/Tasks.md` with the `kanban-plugin: board` front-matter, one `## <heading>`
per configured column in pipeline order, and the closing `%% kanban:settings %%` block
(`{"kanban-plugin":"board","list-collapse":[false,…]}` with one `false` per column).

## Telemetry — anonymous usage stats, strictly opt-in (GDPR-first)

Cohorte can send the maintainers anonymous usage pings so the pipeline improves where it's actually
slow. **Nothing is ever sent without explicit consent**: `/init-pipeline` (and `/update-pipeline` on
pre-telemetry installs) ask ONE question, once per machine, default **No**, and record the answer in
`~/.claude/cohorte.config.yaml` §`telemetry` (`enabled`, `install_id`, `consent_date`). The sender —
`pipeline/scripts/telemetry-send.sh` — is a silent no-op unless `enabled: true` AND `install_id` AND
`endpoint` are all set, times out at 2s, and never fails the pipeline. Callers chain it with
`|| true`, so a **missing** script is equally silent: `/doctor` check 1 verifies `pipeline/scripts/`
is fully populated.

**Which commands ping** — the seven that make up the feature funnel, and only those. The point is to
see where features stall, so every stage of `idea → PR` reports and nothing else does:

| phase | fired when | `seconds` | `results` |
| --- | --- | --- | --- |
| `brainstorm` | the return is staged | `0` | — |
| `spec` | a freeze lands (Mode A only) | `0` | `frozen` |
| `build` | after the batch metrics line | wall-clock | `ok,ok` / `error` |
| `smoke` | after the verdict | wall-clock | `PASS` / `FAIL:<n>` |
| `review` | after the merged verdict | wall-clock | `<verdict>:<count>` |
| `fix` | after the batch metrics line | wall-clock | `<fixed>/<found>` |
| `ship` | the release agent succeeded | `0` | `pr` / `compare` |

`seconds: 0` marks a phase whose duration is human thinking time, not pipeline wall-clock — the
funnel signal there is the event, not how long it took. `/doctor`, `/audit`, `/refactor`,
`/align-ds`, `/init-pipeline` and `/update-pipeline` **never** ping: they sit outside the funnel, and
keeping them out is what holds the collected set to what the consent text describes.

**What one event contains** (strict allowlist, ~200 bytes):

```json
{"v":1,"install_id":"<random uuid>","ts":"<ISO>","core_version":"1.2.0","os":"Darwin",
 "event":"phase","phase":"build","feature_hash":"<sha256[..12] of the feature id>",
 "seconds":412,"results":"ok,ok"}
```

**What is NEVER sent:** repo/project names, file paths, code, spec content, prompts, emails,
usernames, IP handling client-side. The feature id is hashed (12 hex chars) so cross-feature counts
work without revealing what is being built.

**GDPR rights, concretely:**

- **Consent** — opt-in only, recorded with a date; "No" is also recorded so nothing re-asks.
- **Withdrawal** — set `telemetry.enabled: false` in `~/.claude/cohorte.config.yaml`; effective on
  the next phase, no restart.
- **Erasure** — `/doctor` prints your `install_id`; send
  `curl -X DELETE <endpoint-origin>/v1/install/<install_id>` and the collector drops every event
  for that id (the deployed collector implements this and stores no IPs).
- **Access/portability** — events are keyed by your `install_id`; ask the operator for an export.

**Collector contract** (any implementation must honor it):
`POST /v1/events` (one JSON event, allowlisted fields) · `DELETE /v1/install/<id>` (erasure) ·
`GET /healthz`. Operators must not retain IP-bearing access logs for the ingest vhost.
