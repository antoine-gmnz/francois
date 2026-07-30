# Changelog

Entries are shown by `/update-pipeline` ("What's new") after a core refresh. Keep them short,
user-facing, most recent first. One `## <version> — <YYYY-MM-DD>` section per release.

## 1.3.2 — 2026-07-30

> **Re-run `npx cohorte@latest update --global` (or `update`).** This release repairs the gate
> hook registration in place — updating is what applies it.

- **1.3.0's preflight phase gate never fired on any install.** `gate.py` gates review/smoke
  dispatches on `tool_name == "Task"`, but all three installers registered the hook with
  `matcher: "Bash"` — a Task call never reached it. The `preflight` block in `gate-config.json`
  and `gate.preflight` in `PIPELINE.md` were both dead config. The matcher is now `Bash|Task`.
- **Re-installing duplicated the hook, every time.** The "already registered?" test was
  `command.endswith("gate.py")`, which is false for the Windows form `py "C:\…\gate.py"` because
  of the trailing quote — so `install.sh` and `bin/cli.js` appended another copy on each run, and
  `gate.py` ran once per copy on every Bash call (four copies seen in the wild). Registration is
  now a **reconcile**: it drops every existing `gate.py` entry and writes exactly one. Idempotent,
  it collapses the duplicates you already have, and it upgrades the stale matcher — an
  append-if-absent would have found the stale entry and skipped, pinning the bug forever.
  Unrelated hooks and every other settings key are untouched.
- **`npx cohorte update` never touched the hook at all**, so neither fix above could have reached
  you through the command you actually run to get fixes — only a full re-install rewrote it.
  `install.sh` and `install.ps1` always registered on update; this port had drifted (the same
  class of drift as 1.2.4 and 1.2.6). It now registers on both paths.
- CI installs **twice** before asserting the hook, via a new `scripts/assert-gate-hook.mjs`:
  exactly one registration, matcher covering both Bash and Task. A single install could never
  surface the duplication — which is precisely why CI stayed green while it shipped.

## 1.3.1 — 2026-07-30

- **`/cycle <feature_id> [max_rounds]`** — a launcher command for the full dev-cycle workflow,
  so you don't have to phrase the request in prose. It resolves `workflows/cycle.js`
  (bundled or global), checks the runtime is available (missing ⇒ it hands you the
  conversational `/build` → `/smoke` → `/review` path instead), sanity-checks the spec is
  frozen, launches the workflow in the background, then relays the verdict: outcome,
  contract re-authorings to eyeball, the `questions` array verbatim, and the next step
  (`/ship` on SHIP-READY, rerun `/cycle` or `/fix` otherwise). Kanban card moves included.

## 1.3.0 — 2026-07-30

**Token economy — immediate wins, no workflow needed:**

- **Deterministic pre-flight before `/review` and `/smoke`.** A shipped script
  (`pipeline/scripts/preflight.sh`) runs typecheck + lint + tests first; red ⇒ the command
  aborts with the raw last-40 lines and **spawns zero agents** — a reviewer no longer burns
  its whole run rediscovering what `tsc` printed for free. Green runs stamp
  `.claude/preflight.ok`, and `gate.py` enforces it as a **phase gate**: a review/smoke
  dispatch with a missing/stale stamp gets a confirm (`gate.preflight` in the profile).
- **Quiet commands.** New profile fields (`test_quiet_cmd`/`lint_quiet_cmd` per surface,
  `commands.test_quiet`/`lint_quiet` repo-wide) hold the bridled forms agents actually run
  (`--reporter=dot`, `--quiet`, failures-only); absent ⇒ `<cmd> 2>&1 | tail -40`.
  `/init-pipeline` now asks for them instead of storing a bare `pnpm test`;
  `/update-pipeline` tops up older profiles.
- **`/review` computes the diff once.** One `git diff --stat`, then full patches staged to
  disk only for the touched surfaces — reviewers read the artifact instead of each
  re-running git.
- **Conventions baked into rendered agents.** The implementer template gets a
  `<SURFACE_CONVENTIONS>` slice rendered at init; at runtime agents read only the profile's
  machine block. Edit conventions in `PIPELINE.md`, then `/update-pipeline` re-renders.
- **Capped reports.** Review reports: max 20 findings, one line each, zero code excerpts;
  smoke returns: max 10 ❌ lines. Dispatch prompts now keep every volatile slot (feature id,
  paths, file lists) at the END so repeats hit the prompt-cache prefix.
- `gate.py` also escalates every `ask` to a hard deny in unattended runs
  (`bypassPermissions`) — nobody is there to answer a prompt.

**Workflows (opt-in — conversational commands stay the default and the fallback):**

- Four deterministic multi-agent scripts for the Claude Code Workflow runtime
  (≥ 2.1.154, workflows enabled): **`workflows/cycle.js` — the full dev cycle on a frozen
  spec** (contract → parallel build → smoke ∥ review(+cross-check) → fix, looping until
  zero findings + PASS; contract changes handled in-loop by a lead-equivalent agent, human
  decisions returned in a `questions` array at the end; a clean exit ticks the DoD and
  stamps the freshness gate so `/ship` follows directly), `workflows/review.js` (preflight
  gate → one reviewer per touched surface → adversarial cross-check of CRITICAL/security
  findings → verdict only), `workflows/audit.js` (one auditor per domain, concurrent,
  prioritized backlog), `workflows/refactor.js` (big domains only: shared first, parallel
  implementers, per-domain verify + one retry). Mechanical phases route to haiku.
- New `profile-reader` agent (haiku) — phase 0 of every workflow: returns the
  `PIPELINE.md` machine block as JSON, since workflow scripts have no filesystem access.
- `/doctor` check 8 reports the workflow prerequisites and which path a session will take;
  the generated `settings.json` allow-list now covers what workflow agents need (quiet
  commands, shipped scripts, `git rev-parse`, retrieval MCP tools) so runs don't stall on
  prompts nobody is watching.
- Installers (npx CLI, install.sh, install.ps1) ship `core/workflows/` + `preflight.sh` +
  the `profile-reader` agent in both global and bundled modes; CI dry-runs assert it.
- Dashboard: new headless **Audit** action (`claude -p "/audit"` — starts without a prompt,
  no resume if the session dies) and the workflows state in the project drill-down.

## 1.2.6 — 2026-07-30

- **`npx cohorte install` never installed the `smoke` agent.** It copied only `review.md` and
  `release.md`, so `/smoke` was there but the agent it dispatches was not — the run failed
  saying `/smoke` is not installed. The shell installers always copied it; only the npm port
  drifted. It now copies every non-template agent in `core/agents/`, so nothing to keep in sync.
  Fix an affected install by re-running `npx cohorte install --global` (or `install --repo`).

## 1.2.5 — 2026-07-29

- **`.claude/pipeline.json`'s `core_version` never updated on global installs.** The installer
  bumps it in bundled mode, but a global core is shared — it cannot know which repos point at
  it, so nothing bumped the field and it drifted forever. Repos running a current core were
  still claiming `1.0.0`. `/update-pipeline` now syncs the pointer in both modes.
- `/doctor` no longer reports that drift as a broken install: a global-mode pointer lagging the
  VERSION file is ⚠️ with the one-command fix, not ❌. The core was never the problem.

## 1.2.4 — 2026-07-29

> **If you installed with `npx cohorte`, this is the release that makes 1.2.3 actually
> reach you.** Re-run `npx cohorte@latest update --global` (or `update` for a bundled core).

- **`npx cohorte install/update` shipped a core missing two scripts.** `bin/cli.js` — the
  port of `install.sh` that `npx` actually runs — copied only `scripts/*.template`, never
  `kanban-move.sh` or `telemetry-send.sh`. Since every caller chains them with `|| true`,
  the result was silent on every npx-installed machine: no kanban card moves, no telemetry
  pings, no error anywhere. The shell installers named both files explicitly and this port
  drifted from them. It now copies by a rule that needs no list to keep in sync.
- The same port never copied `CHANGELOG.md` into the core either, so `/doctor` and
  `/update-pipeline`'s "What's new" had nothing to read on npx installs. Fixed.
- CI now dry-runs `bin/cli.js` into a scratch dir and asserts the same postconditions as
  the `install.sh` dry-run. 1.2.3's guard only grepped the two shell installers — it would
  have passed this bug, because the port copies by rule rather than by name.

## 1.2.3 — 2026-07-29

- **Telemetry now covers the whole funnel.** Only `/build` was actually pinging; `/smoke`,
  `/review` and `/fix` wrote their metrics line but never sent one, so consenting installs
  reported a quarter of their pipeline. Those three are fixed, and `/brainstorm`, `/spec`
  (on a landed freeze) and `/ship` join them — the seven stages of `idea → PR` now report,
  so it's finally possible to see *where* features stall. Setup and maintenance commands
  (`/doctor`, `/init-pipeline`, `/update-pipeline`, `/audit`, `/refactor`, `/align-ds`)
  deliberately never ping: the collected set stays inside what the consent text describes.
  Same data categories as before, same purpose — nothing new about you is sent, so your
  existing consent stands and nothing re-asks. The full table is in SCHEMA.md §Telemetry.
- `telemetry-send.sh` now allowlists the phase name client-side — a typo in a command file
  used to sail through and land a phantom phase in the dataset.
- `/fix` never defined a wall-clock start, so the `seconds` in its metrics line was
  undefined. It now notes the epoch like `/build` and `/review` do.
- **`/doctor` catches a half-copied core.** New check: `pipeline/scripts/` must hold every
  shipped script, and `VERSION` must not be newer than its siblings. Callers chain these
  scripts with `|| true`, so a missing one was invisible — no kanban move, no telemetry
  ping, no error. If you saw either go quiet, this is why: re-run the installer.
- CI now fails if an installer forgets to copy a `scripts/*.sh`, and the dry-run install
  asserts the scripts land executable — the root cause above, caught before release
  rather than on someone's machine.
- The npm tarball no longer ships `scripts/new-feature.sh` + `scripts/remove-feature.sh`
  — cohorte's *own* rendered isolation scripts, with this repo's ports and paths baked
  in. They claimed in their header to be excluded but never were (an explicit `files`
  whitelist wins over `.npmignore`). Only the `*.sh.template` files ship, as intended.
- Fixed `validate-core.mjs` crashing on Windows (`C:\C:\…` path), so the guard above
  actually runs locally too.

## 1.2.2 — 2026-07-29

- The reference collector moved to its own (private) deployment repo; the public repo keeps
  the collector API contract in SCHEMA.md §Telemetry. No behavior change for users.

## 1.2.1 — 2026-07-29

- Telemetry collector URL shipped as the config-template default
  (`https://telemetry.cohorte.thebidouille.fr/v1/events`) — consenting installs start
  reporting once the collector is live. Still strictly opt-in; nothing changes for anyone
  who declined (or never answered) the consent question.

## 1.2.0 — 2026-07-29

> **Opt-in anonymous telemetry, GDPR-first.** Nothing is sent unless you explicitly say yes.

- `/init-pipeline` (and `/update-pipeline` on existing installs) ask ONE consent question, once per
  machine, default **No** — both answers are recorded in `~/.claude/cohorte.config.yaml` §`telemetry`
  so you're never re-asked.
- When enabled, each pipeline phase fires a ~200-byte ping (fire-and-forget, 2s timeout, never
  blocks): core version, OS, phase, duration, per-surface result counts, and a **hash** of the
  feature id. Never sent: repo names, paths, code, spec content, IPs.
- Withdraw anytime (`telemetry.enabled: false`); erase your history anytime (`/doctor` prints your
  `install_id`; `DELETE /v1/install/<id>` on the collector drops it). Full spec: SCHEMA.md
  §Telemetry; privacy summary in the README.
- Ships a zero-dependency reference collector (`telemetry/collector.mjs` — NDJSON storage, strict
  field allowlist, erasure endpoint, stores no IPs) to self-host.
- `/doctor` reports telemetry consent state and flags incoherent configs (enabled without a
  recorded consent).
- Note: the shipped default `endpoint` is empty — telemetry stays dormant even for consenting
  installs until a collector URL ships in the config template.

## 1.1.1 — 2026-07-29

- **Fix: pipeline metrics survive worktree teardown.** With `isolation.enabled` the lead session
  runs inside the feature worktree, so metrics lines landed in the worktree's `.claude/` and were
  deleted with it — defeating their purpose (cross-feature evidence for surface splits, dashboard
  history). All phases now append to the **main checkout's** `.claude/pipeline-metrics.jsonl`,
  resolved from anywhere via `git rev-parse --git-common-dir`; `/doctor` flags a stray metrics file
  inside a worktree as a stale-core sign.

## 1.1.0 — 2026-07-29

> **The token-economy release.** A full audit of the core (40 verified fixes) cuts the pipeline's
> consumption by an estimated 40–60% per feature, and the pipeline no longer inherits your session's
> model for orchestration. Plus: pipeline metrics in the dashboard, CI on the core, and a documented
> parallel-features workflow.

- **Byte-stable dispatches.** One dispatch template for builds AND fix loops; variable parts
  (design links, open Remediation items inlined verbatim) sit at the end so repeats hit the prompt
  cache. The lead never pastes a diff — agents compute their own, scoped to their tree. On fix
  loops, implementers no longer re-read the spec at all.
- **Reviewers read hunks, not whole files.** `/review` stages each surface's diff to
  `specs/reports/<id>.<key>.diff`; tiny re-reviews skip the dispatch entirely (fast path); the
  merged report is staged to disk with only a verdict summary printed; LOW-only findings defer to
  the refactor backlog instead of forcing a fix cycle.
- **`/smoke` is now an agent.** A new pinned `smoke` agent runs infra/curl/UI checks so logs,
  response bodies, and screenshots never enter (and re-bill in) your session's history.
- **Model pins everywhere.** The `review` agent and the 10 mechanical commands
  (build/review/fix/smoke/ship/audit/refactor/doctor/align-ds/update-pipeline) are pinned
  `model: sonnet` — orchestration runs on Sonnet even if your session runs Opus/Fable. `/doctor`
  checks agent AND command pins; the profile template's frontend example no longer suggests
  `inherit`.
- **Leaner outputs.** Handoff + review-report formats are inlined in the agent bodies (no template
  probe), templates de-boilerplated, the design brief is authored once to `specs/design/<id>.md`,
  metrics collapsed to one JSONL line per phase, and every command's closing now *recommends*
  `/clear` (all state is on disk by design).
- **Pipeline metrics in the dashboard.** New per-project panel: wall-clock per phase, fix rounds,
  and per-surface results from `.claude/pipeline-metrics.jsonl` — see which phase/surface dominates
  before tuning anything.
- **`kanban-move.sh`.** Card moves (move/create/dedupe/`--pr`) now run as a script outside the
  agent's context; installed to `<core>/pipeline/scripts/`, with the manual grep-based op as
  fallback.
- **Spec size budget.** `/spec` targets ≤~300 lines and proposes a feature split beyond that —
  every spec line is paid `surfaces × dispatches` times.
- **Parallel features documented.** README: one session per feature, worktree isolation as the
  safety mechanism, ship-then-rebase rule; `/doctor` prints the live slot table when ≥2 features
  run in parallel.
- **CI on the core.** `scripts/validate-core.mjs` + GitHub Actions: frontmatter/pin invariants,
  render placeholders, cross-references, installer coverage (would have caught the smoke-agent
  install gap this release also fixes), plus an end-to-end install dry-run.

## 1.0.0 — 2026-07-28

> **Renamed `thebidouille-agents` → `cohorte`** and cut the first stable release. The npm package,
> the CLI (`npx cohorte …`), the repo, and the user config file are all renamed. The pre-rename
> `~/.claude/thebidouille.config.yaml` and `~/.claude/thebidouille-dashboard.json` are still read as a
> fallback, so existing installs keep working — `/update-pipeline` migrates them forward on next run.

- **Repo moved to the `TheBidouilleAgency` org** (`github.com/TheBidouilleAgency/cohorte`), with a
  proper logo/brand kit under `assets/` and a dashboard favicon set.

- **The research + questionnaire capability was removed from the core.** `/research`,
  `/questionnaire`, their agents, templates and step files are extracted to a separate private repo
  and will return later as an installable Cohorte **plugin**. `update` scrubs the now-orphaned files
  from existing installs. The global config keeps only the shared Obsidian vault + the kanban mirror;
  the `research:`/`questionnaire:` config keys are gone.

- **`/ship` now reliably moves the kanban card to Shipped and writes the PR number.** The
  move-to-Shipped was a parenthetical in the command header, easy to skip — so shipped features could
  leave their card stuck in an earlier column. It is now an explicit, verify-after step (§4): move
  card `#<id>` → `shipped` **and append `PR #<num>`** (from the PR URL), then re-read the board to
  confirm. The bare `#<num>` is what the dashboard renders as a clickable PR link. SCHEMA.md §Kanban
  documents the shipped-card format. (`/ship` also moves the card → `ship` on confirm, in §1.)

- **Branch-aware gate — git + docker run freely on feature branches, gated only on the default
  branch.** The `gate` block gains two keys: `ask_on_default_branch` (patterns confirmed *only* when
  the checked-out branch is `default_branch`) and `default_branch` (default `main`). `gate.py`
  resolves the current branch at run time (`git rev-parse`); an unknown branch (no repo / detached)
  is treated conservatively as gated. The default profile moves git (commit/push/merge/rebase/reset)
  and `docker compose` into this tier, so agents move fast on feature branches while `main` stays
  protected; DB commands (`migration:run`, `db:`, `psql`) remain always-`ask`, destructive migrations
  always-`deny`. Existing gate-configs without the new keys keep working unchanged. Re-run
  `/update-pipeline` to regenerate `gate-config.json` with the new tier.

- **New `dashboard` subcommand — a local web cockpit for the pipeline.** Run
  `npx cohorte dashboard` to open a browser view of pipeline state: a **Fleet**
  overview (global core version vs npm latest + every tracked project's freshness and health
  at a glance), a per-project drill-down that renders `/doctor` as a live checklist, the
  **Surfaces ↔ agents** map from `PIPELINE.md`, and a **Specs board** (kanban by
  `draft·frozen·in-review·shipped`). Install/update actions run the CLI and stream their output
  live. Add projects by path — the set is remembered in `~/.claude/cohorte-dashboard.json`.
  The runtime is dependency-free (node's built-in `http` serves a prebuilt React app); the
  `/doctor` checks are reimplemented in JS so they run without a Claude session. Point it at any
  pipeline-ised repo, or at nothing (it seeds the launch directory). A **folder picker** browses
  the filesystem to add projects (dirs with a `PIPELINE.md` are flagged), and a **Reset pipeline**
  action wipes a project's entire pipeline footprint (`.claude/`, `PIPELINE.md`, optionally
  `specs/`) — backed up first to `.claude.bak-<ts>/`, the shared `~/.claude` core untouched — so a
  project riddled with old-version relics can be brought back to a clean, pipeline-managed state
  (then `/init-pipeline` regenerates the profile). **Init-pipeline / Update-pipeline** buttons run
  those Claude Code commands headless (`claude -p … --dangerously-skip-permissions`) in the project
  and stream the output. The server **binds `127.0.0.1` by default** (its actions execute code);
  `--host=ADDR` exposes it with a printed security warning, `--open` launches the browser.
  Projects with a linked **Obsidian Kanban board** (config `kanban.boards`) get it rendered inline —
  columns + cards read straight from the vault markdown (local, no token; Notion is not a kanban
  source in this pipeline, only /research archival). PR references become clickable links, enriched
  with **live PR status** (open/merged/closed/draft) + date via the user's `gh` CLI (cached 60s), and
  the **Shipped** column is sorted by ship date. Cards missing an explicit `#<num>` have their PR
  **inferred from the branch** (`…/<feature_id>`), so historical boards light up too.

## 0.1.27 — 2026-07-28

- **README gains a Prerequisites section.** Spells out what a new machine actually needs: Node ≥ 18 + npm
  (the only hard requirement, for the `npx` installer) versus `uv` + the Serena CLI (optional, the default
  retrieval provider — installed separately, independent of the `npx` core install, order irrelevant, and
  the pipeline still runs without it by falling back to Grep/Read). Also documents the cloned-repo case
  (Serena registration travels in the committed `.mcp.json`; just install the CLI + restart + `/doctor`).
  The mechanics were already in `SCHEMA.md` §Code retrieval, but not in the human-facing onboarding doc.

## 0.1.26 — 2026-07-28

- **The design step now references designs by full link, not a stored project id + bare filename.** A
  `design_files` entry is a self-contained `https://claude.ai/design/p/<projectId>?file=<file>` link that
  carries its own project (`/p/<projectId>`) and page (`?file=`); agents extract both and read it via
  `DesignSync get_file(<projectId>, <file>)`. No stored `design_project` id means a design-system rebuild
  (which mints a new project id) no longer breaks every spec — you just paste the new links. `design_project`
  becomes an optional legacy fallback (default `none`) for old bare-filename specs. Updated across `/build`
  (design gate + dispatch), `/smoke`, `/spec` + the spec template, `PIPELINE.md` (§design + conventions),
  `SCHEMA.md`, and `/doctor`. Crucially, the surface-agent render step now specifies the link-based
  `<SURFACE_DESIGN_INPUT>`/`<SURFACE_TDD_STEP1>` — so `/update-pipeline` re-renders design agents to resolve
  from the link instead of the stale `get_file(design_project, <file>)`. Existing specs keep their bare
  filenames until you replace them with links.

## 0.1.25 — 2026-07-27

- **`research-agent` defaults to `sonnet`** instead of silently inheriting the session model (Opus). Its
  work — MAP / ANALYSE / SYNTHESISE of pre-extracted text — is extraction-and-summary that Sonnet handles
  well at a fraction of the cost, and `/cost` showed it was one of the two heaviest subagents. The fixed
  agents were never tiered like the surfaces; this closes the biggest gap. If cross-cutting synthesis ever
  needs more, the `/research` SYNTHESISE dispatch can override the model for just that pass.
- **README documents the `/clear`-safe loop** as the top token lever — since all pipeline state lives on
  disk, `/clear`-ing between stages sheds the accumulated main-thread context (long >150k sessions are
  expensive even cached), with the safe-to-clear boundary shown for the whole `/spec → … → /ship` loop.

## 0.1.24 — 2026-07-27

- **The dev loop is now `/clear`-safe between every stage.** All pipeline state already lives on disk
  (spec, contract, diff, Remediation checkboxes, freshness stamp), so you can `/clear` between commands
  to shed the accumulated main-thread context and cut token cost — each command reloads everything from
  disk. Every command now marks its handoff as safe to `/clear` before the next step.
- **`/review` and `/smoke` stage their report to `specs/reports/<id>.md`** (a gitignored buffer in its own
  subfolder, like `specs/design/`) — the one context-coupling that a `/clear` used to break. `/fix` and
  `/spec` Mode B read the report back from disk when the context was cleared. `/init-pipeline` gitignores
  the buffer; `/doctor` reports it. The non-recursive `specs/*.md` glob skips the subfolder, so it never
  shows up as a phantom kanban card or spec.

## 0.1.23 — 2026-07-26

- **Cheaper dev loop by default — implementers now default to `sonnet`, not the Opus lead.** A surface
  agent mostly applies a frozen contract, which Sonnet handles well at a fraction of the cost;
  `/init-pipeline` and reconcile now default `surfaces[].model` to `sonnet`, keeping `haiku` for purely
  mechanical scaffolding and `inherit` only for surfaces with real design decisions. The fixed `release`
  and `questionnaire-validator` agents drop to `haiku`, `questionnaire-writer` to `sonnet`. Existing
  projects pick this up on the next `/update-pipeline` (agents re-render; a `model` you set by hand is kept).
- **Stateless agents read a *slice* of `PIPELINE.md`, not the whole file.** The implementer and reviewer
  now load the machine block + only the `### Shared` and their own `### Surface:` convention stanza
  (+ §Testing), never the other surfaces' prose — less context re-read on every parallel dispatch.
- **Leaner fix loops.** On a `/fix` re-dispatch, a surface agent works from the self-contained open
  Remediation items + the diff and reads only the files those findings name — no longer re-reading the
  whole (growing) spec or re-exploring its tree.
- **Freshness gate at `/ship`.** `/review` now fingerprints the reviewed source (`reviewed_base` +
  `reviewed_digest` in the spec front-matter) at a SHIP verdict, and `/ship` re-checks it — refusing to
  ship if any source or contract file changed after the review, so a verdict can't go stale unnoticed.
  Specs are excluded (DoD ticks + the ship status flip don't trip it); a spec predating the gate skips it.
- **Big commands lazy-load their steps (progressive disclosure).** `/init-pipeline`, `/research` and
  `/questionnaire` are now thin routers (a bootstrap block + a steps table) that read each step from
  `templates/steps/<command>/NN-*.md` as they reach it, instead of one monolithic body — the branchy
  commands (esp. `/research`) no longer pull an unused branch into context. Pure re-partition, verified
  token-for-token identical to the old bodies. No installer change (steps ride the existing `templates/` copy).
- **Machine-checkable postconditions on the two silent-failure gates** — `/spec` freeze asserts
  `status: frozen` actually landed; `/build` asserts the contract file exists before dispatching agents.
- **`/review` lets git group the diff by surface** (`git diff --name-only -- <path>` + an `:(exclude)`
  remainder) instead of the lead reasoning it out file by file — deterministic and cheaper.
- **`/fix` collapses fully-resolved Remediation rounds** to a one-line summary, so the spec every agent
  re-reads stops growing unbounded across fix loops (rounds with any open item stay expanded).
- **New SCHEMA § "Measuring cost"** — documents `/cost` (built-in per-subagent + per-command usage share)
  and the OTEL `settings.json` env block (`claude_code.token.usage` / `cost.usage`) for exact numbers.

## 0.1.22 — 2026-07-26

- **`/spec` exports a standalone design brief** — for a UI feature, freezing the spec now also writes
  §8 (the "spec return") to its own `specs/design/<id>.md`, in addition to printing the copy-paste
  block. One `.md` you can open, share, or drop straight into the design tool instead of scrolling back
  through the chat — regenerated on every freeze so it never drifts from the spec. Lives in the
  `specs/design/` subfolder on purpose, so the non-recursive `specs/*.md` glob (kanban backfill,
  `/doctor`) never mistakes it for a spec. Backend-only features are unaffected.

## 0.1.21 — 2026-07-24

- **Reliable local-PDF reading for `/research`** — subagent nodes often lack a PDF renderer (no
  poppler), which made research-agents silently fall back to a web copy of the document — fine for a
  public PDF, a silent fabrication risk for a private one. `/research` now **extracts the PDF to
  per-page text ONCE up front** (pure-Python `pypdf` in a throwaway venv — no system deps) and agents
  read that text, never the binary PDF. A local read that fails now returns a loud `===READ-FAILED===`
  instead of reconstructing from the web; the orchestrator re-extracts or surfaces it. Adds a
  scanned-PDF guard (no text layer ⇒ stop, needs OCR).

## 0.1.20 — 2026-07-24

- **`/fix` now checks off resolved Remediation items** — the lead flips `- [ ]` → `- [x]` (with a
  short "fixed" note) for every item the surface agents report addressed in their handoff, and skips
  already-`[x]` items when scoping the re-dispatch. Fixes two long-standing quirks: a spec whose
  Remediation looked permanently open even after fixes landed, and a later `/fix` re-sending
  already-fixed items from earlier rounds to the agents.
- **`/review` now ticks the §9 DoD at a SHIP verdict** — a SHIP verdict is the pipeline's statement
  that the feature is done, so the lead checks off each Acceptance-criteria item its verifying stage
  actually covered (conformance/copy = review, tests/lint/types = build, mobile-first/runtime = smoke),
  leaving open any whose stage didn't run. `/ship` gains a matching gate: it lists any still-open DoD
  item and asks before shipping (it never ticks — that's `/review`'s job).

## 0.1.19 — 2026-07-24

- **Research decoupled from the questionnaire** — `/research` now dispatches a dedicated, standalone
  **`research-agent`** (an autonomous research assistant that extracts everything important in the
  source) instead of the old bi-mode `questionnaire-researcher`. The report no longer carries any
  "future questionnaire" framing: the domain-brief `goal` is a research objective, and the brief
  template is renamed `research-brief.md`. The blueprint step moves to its own **`questionnaire-architect`**
  agent, dispatched by `/questionnaire`. New Notion archive databases are titled « Recherche ». Update
  scrubs the retired `questionnaire-researcher` agent and old template automatically.
- **Multi-pass research for large sources** — `/research` now maps a big PDF into a reading plan, runs
  one deep `research-agent` pass **per segment in parallel**, synthesises the cross-cutting sections,
  and assembles a single report. Report length scales with the source (no fixed word-count cap), so a
  dense thesis or state-of-the-art gets exhaustive coverage instead of being compressed into one pass.
  Small sources and URLs still take the single-pass path.

## 0.1.18 — 2026-07-22

- **Consolidated global config** — the research/questionnaire settings move from
  `~/.claude/questionnaire.config.yaml` into one `~/.claude/cohorte.config.yaml` with
  `obsidian` / `research` / `questionnaire` / `kanban` sections and a shared `obsidian.vault_path`.
  The old file is still read as a fallback; `/update-pipeline` migrates it for you. The `npx`
  installer now offers a quick interactive setup on a TTY.
- **Obsidian kanban mirror** — an optional per-project board mirrors the pipeline
  (`/brainstorm`…`/ship`): each stage moves the feature's card across columns
  (Ideas → Brainstorm → Spec → Ready to build → Building → Review → Fix → Ship → Shipped).
  `/brainstorm` can pick an idea straight from the *Ideas* column; `/init-pipeline` creates + links
  a board (keyed by the project's `PIPELINE.md` name); `/update-pipeline` links/repairs it and
  **backfills existing `specs/` onto the board**, syncing each card to its spec's status. Enable it
  via `/init-pipeline` (new project) or `/update-pipeline` (existing) — no hand-editing.

## 0.1.17 — 2026-07-22

- **Serena dashboard no longer auto-opens** — the per-repo Serena launcher `/init-pipeline` wires now
  passes `--open-web-dashboard False`. The dashboard stays available (`http://localhost:24282/dashboard/`)
  but no longer pops a browser tab on every server start. The flag overrides each machine's
  `serena_config.yml`, so behaviour is uniform across the team; `/update-pipeline`'s health check appends
  the flag to launcher entries that predate it.

## 0.1.16 — 2026-07-22

- **Obsidian store: research and questionnaires split** — research notes land in
  `obsidian_research_folder` (default `Recherches/`, with `_sources/`), and a derived questionnaire
  is now a **separate note** in `obsidian_questionnaire_folder` (default `Questionnaires/`),
  wikilinked both ways with the research note. Statut lifecycle: the research note stays
  `Recherche`; the questionnaire note carries `À relire` / `Bloqué` / `Approuvé`. (Replaces
  0.1.15's single `obsidian_folder` key.) Notion store unchanged — one page per run.

## 0.1.15 — 2026-07-22

- **Obsidian store for research runs** — the research/questionnaire capability gains a `store:`
  switch in `~/.claude/questionnaire.config.yaml`: `notion` (default, unchanged) or `obsidian` —
  each run becomes a markdown note in `<vault>/<obsidian_folder>/` with frontmatter properties
  (`run_id`, `sujet`, `cadre`, `statut`, `date`), source PDFs copied to `_sources/` for provenance.
  No MCP needed; the vault path is asked once on first `/research`, then saved. Old Notion runs stay
  readable — pass their URL to `/questionnaire`.

## 0.1.14 — 2026-07-22

- **`/fix`** — scoped fix loop: appends a REVIEW REPORT (or `/smoke` failures) to the spec's
  `## Remediation` and re-dispatches ONLY the surfaces with findings, instead of the full
  paste-into-`/spec` + full `/build` round-trip.
- **`/smoke`** — end-to-end verification between `/build` and `/review`: infra up in the feature
  worktree, migrations, real contract endpoints via curl (incl. RBAC denials), spec §8 UI flows
  mobile-first, optional screenshot diff against the Claude Design pages.
- **`/doctor`** — installation diagnostic: core/pointer versions, agents↔surfaces orphans, hooks &
  gate config, retrieval health, design wiring, stale worktree slots — each failure with its exact fix.
- **Dispatch metrics** — `/build`, `/review`, `/fix`, `/smoke` append per-agent JSONL evidence to
  `.claude/pipeline-metrics.jsonl` (gitignored); SCHEMA §Specialization now points at it.
- **`/ship`** — watches the PR's CI checks (`gh pr checks --watch`) and, after the merge is
  confirmed, proposes `scripts/remove-feature.sh` (worktree + slot teardown, db kept by default).
- **`/init-pipeline`** — generates `.github/workflows/pipeline-ci.yml` from the profile's commands
  (with go-ahead) and gitignores the metrics sink.
- **CHANGELOG** — this file; shipped with the core, shown by `/update-pipeline` after an update.

## 0.1.13 — 2026-07-22

- **`/review` is parallel** — one review agent per touched surface in a single dispatch (wall-clock =
  slowest surface, not the sum); the lead merges the reports, worst verdict wins.
- **Review agent reads less** — `mcp__serena` in its toolset (harmlessly absent when a project has no
  retrieval provider) and a diff-hunks-first reading rule instead of whole-file reads.

## 0.1.12 — 2026-07-22

- **Per-feature design projects** — spec `design_files` now accepts full Claude Design links, each
  carrying its own project id (extracted at `/build`'s design gate); the profile's `design_project`
  becomes an optional fallback. Design each feature in a fresh project and just paste the link.

## 0.1.11 and earlier

Pre-changelog releases: serena wiring made PATH-proof and health-checked (0.1.9–0.1.11), OIDC npm
trusted publishing (since 0.1.4). See `git log` for details.
