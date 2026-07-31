# PIPELINE.md — Francois

Project: **Francois** — a desktop terminal app that orchestrates Claude Code sessions (named after Claude François, the French singer). Product description: `PROJECT.md`. Visual source of truth: `Claude Terminal.dc.html` + `screenshots/`.

> **Machine block first, prose after.** The fenced `yaml pipeline-profile` block below is the
> deterministic contract pipeline commands parse (`/build`, `/review`, …). The prose sections after it
> carry the conventions agents read — they are authoritative for anything the block abbreviates.
> Kept current by `/update-pipeline` (reconcile: new fields topped up, values never overwritten).
> Rendered agent files (`.claude/agents/frontend.md`, `core.md`) are regenerated from this profile on
> every reconcile — customize agents through §Conventions here, never by editing the agent files.

```yaml pipeline-profile
# ── identity ────────────────────────────────────────────────────────────────
name: Francois
one_liner: Native desktop terminal app (Tauri 2) that orchestrates Claude Code sessions
ui_language: English
package_manager: npm                          # frontend tooling; the Rust core builds with cargo

# ── vcs ─────────────────────────────────────────────────────────────────────
vcs:
  host: github
  remote: antoine-gmnz/francois
  default_branch: main
  feature_branch_prefix: feat/

# ── repo shape ──────────────────────────────────────────────────────────────
repo:
  layout: single
  workspace_tool: none

# ── code retrieval ──────────────────────────────────────────────────────────
retrieval:
  provider: serena                            # coexists with Cartograph (SessionStart map hook + custom global agents)

# ── surfaces ────────────────────────────────────────────────────────────────
surfaces:
  - key: frontend
    path: src
    label: frontend (React 18 + Vite + TypeScript)
    agent: frontend
    tools: [Read, Write, Edit, Bash, Grep, Glob, DesignSync, mcp__serena, mcp__cartograph__map, mcp__cartograph__query, mcp__cartograph__neighbors, mcp__cartograph__concept, mcp__cartograph__record, mcp__cartograph__stale]
    model: inherit
    test_cmd: npm test
    # Bridled variant — what agents actually RUN, so a green run costs lines, not pages.
    test_quiet_cmd: npm test -- --reporter=dot
    lint_cmd: ""                              # no eslint configured; tsc is the static gate
    lint_quiet_cmd: ""
    format_cmd: ""
    typecheck_cmd: npx tsc --noEmit
    build_cmd: npm run build
    uses_design: true
  - key: core
    path: src-tauri
    label: core (Rust / Tauri 2)
    agent: core
    tools: [Read, Write, Edit, Bash, Grep, Glob, mcp__serena, mcp__cartograph__map, mcp__cartograph__query, mcp__cartograph__neighbors, mcp__cartograph__concept, mcp__cartograph__record, mcp__cartograph__stale]
    model: inherit
    test_cmd: cd src-tauri && cargo test
    test_quiet_cmd: cd src-tauri && cargo test --quiet
    lint_cmd: ""
    lint_quiet_cmd: ""
    format_cmd: cd src-tauri && cargo fmt
    typecheck_cmd: cd src-tauri && cargo check
    build_cmd: ""                             # release builds via tauri build / CI matrix
    uses_design: false

# ── contract (the only cross-surface sync channel) ──────────────────────────
contract:
  enabled: true
  mechanism: shared-types                     # plain TS type files (no zod) — see §contract prose; Rust mirrors with serde
  path: contract
  ext: ts
  index: ""                                   # no barrel — one file per feature + common.ts
  authored_by: lead

# ── repo-wide commands ──────────────────────────────────────────────────────
commands:
  install: npm install
  dev: npm run dev:app
  lint: ""
  lint_quiet: ""
  format: ""
  typecheck: npx tsc --noEmit
  test: npm test && cd src-tauri && cargo test
  test_quiet: npm test -- --reporter=dot && cd src-tauri && cargo test --quiet
  migrate: ""                                 # no DB
  make_migration: ""

# ── rbac ────────────────────────────────────────────────────────────────────
rbac:
  enabled: false
  hierarchy: []

# ── design ──────────────────────────────────────────────────────────────────
design:
  enabled: true
  provider: claude-design
  design_system_project: "Claude terminal interface"
  design_project: none
  snapshot_dir: ""                            # local mirror lives at the repo root: Claude Terminal.dc.html + screenshots/
  direction: design-to-code
  ui_kit_path: src
  tokens_path: src/styles.css
  
# ── isolation ───────────────────────────────────────────────────────────────
isolation:
  enabled: false                              # features build in the main checkout on feat/<id> branches
  unit: git-worktree
  db_per_worktree: false
  db_name_pattern: ""
  port_base: {}
  compose_file: ""
  registry: ""

# ── gate (drives .claude/gate-config.json) ──────────────────────────────────
gate:
  default_branch: main                        # the protected branch (mirrors vcs.default_branch)
  deny:
    - "git push --force"
    - "git push -f"
  ask: []
  ask_on_default_branch:                        # free on feature branches, confirm on default_branch
    - "git commit"
    - "git push"
    - "git merge"
    - "git rebase"
    - "git reset"
  # Phase gate: review/smoke dispatches require a fresh `.claude/preflight.ok` stamp,
  # written by pipeline/scripts/preflight.sh when typecheck+tests are green — gate.py
  # "ask"s the dispatch when the stamp is missing, stale, or HEAD moved.
  preflight:
    enabled: true
    agents: [review, smoke]                   # subagent_types the stamp gates
    max_age_minutes: 30
```

## Stack (decided)

- **Runtime**: Tauri 2 — a **native desktop app, not a web app**. Backend "core" in Rust; frontend React 18 + Vite + TypeScript rendered in the Tauri webview.
- **Languages**: Rust (core), TypeScript `strict: true` (frontend)
- **Terminal**: xterm.js in the frontend, `portable-pty` (Rust) in the core
- **Claude Code integration**: the core spawns `claude -p --output-format stream-json --include-partial-messages` per session and parses the NDJSON event stream. (Escape hatch if stream-json proves insufficient: a Node sidecar running `@anthropic-ai/claude-agent-sdk`, bundled as a Tauri sidecar binary.)
- **Git**: system `git` CLI invoked from the Rust core (no libgit binding)
- **Frontend state**: zustand
- **Styling**: plain CSS with design tokens (from PROJECT.md §Visual design system); JetBrains Mono
- **Tests**: `cargo test` (core), vitest (frontend), WebDriver via `tauri-driver` (e2e)

## contract

- `enabled: true`
- `mechanism`: TypeScript type files in `contract/` are the **canonical payload shapes** for the frontend↔core boundary; the Rust core mirrors them with serde structs (generate bindings with `specta`/`tauri-specta` where practical, hand-mirror otherwise).
- `path`: `contract/`
- One file per feature: `contract/<feature-id>.ts`. Shared vocabulary lives in `contract/common.ts` — feature contracts **import** from it and never redefine its types. Specs name the exact types/channels; the contract files are authored at `/build` time from the frozen specs.

## design

- `enabled: true`
- Source: Claude Design project "Claude terminal interface", mirrored locally as `Claude Terminal.dc.html` (+ `screenshots/`). The mock is authoritative for layout, colors, glyphs, and micro-interactions. (The mock's "clyde" branding reads as "francois".)

## vcs

- `host`: `github`
- `remote`: `git@github.com:antoine-gmnz/francois.git` (`origin`)
- `default_branch`: `main`
- `feature_branch_prefix`: `feat/`
- Notes: repository initialized on the `main` branch. `/ship` requires a SHIP-verdict `/review` before it will push or open a PR.
- **CI/CD** (`.github/workflows/`):
  - `ci.yml` — pull requests: `npm run build` (tsc + vite) + `npm test` (vitest) + `cargo test`.
  - `release.yml` — **every push to `main` ships a release, with no manual step at any point.** There is one channel: main *is* the latest version. Five jobs in sequence:
    1. `gate` — `npm run build` + `npm test` + `cargo test` on Linux. Nothing is tagged until this is green, so a red main is never released.
    2. `version` — `node scripts/release/bump.mjs` picks the next semver from the **conventional commits since the last `v*` tag** (`BREAKING CHANGE`/`!` → major, `feat:` → minor, anything else including unconventional and merge commits → patch), writes it into **all five** manifests that carry a version (`package.json`, `package-lock.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`), commits `chore(release): vX.Y.Z [skip ci]`, and pushes the commit + annotated tag **atomically**. Pre-1.0 guard: while major is `0`, a breaking change bumps the *minor* — an accidental `feat!:` cannot declare 1.0 (drop the guard in `scripts/release/version.mjs` at 1.0.0).
    3. `build` — the 3-OS matrix, checked out **at the tag** (so binaries carry the version the `version` job chose), into a **draft** release. Draft is deliberate: three legs attach assets to one release, and a live release carrying two platforms out of three is worse than none.
    4. `finalize` — writes the changelog (`git log` since the previous tag) plus the install blurb, then `gh release edit --draft=false --latest`. Un-drafting is what makes the assets publicly downloadable.
    5. `npm` — dispatches `npm-publish.yml` and **watches the run**, so a refused publish turns the release run red instead of failing quietly elsewhere in the Actions tab.
    Why it cannot loop: the bump commit and tag are pushed with `GITHUB_TOKEN`, and by design GitHub does not re-trigger workflows on events it creates. `concurrency: {group: release, cancel-in-progress: false}` serialises runs and never cancels mid-flight — a cancelled run could leave a tag with no binaries. Escape hatches: `[skip release]` in a commit subject skips the run; `gh workflow run npm-publish.yml -f tag=vX.Y.Z` re-publishes by hand. **Requires** that branch protection on `main` not block `github-actions[bot]` from pushing (allow it, or the `version` job fails at the push).
    - Version logic lives in `scripts/release/version.mjs` (pure, unit-tested by `scripts/release/version.test.mjs` under `npm test`); `scripts/release/bump.mjs` is the I/O half and takes `--dry-run`.
  - `npm-publish.yml` — publishes the **`francois` npm package** (`packaging/npm/`), the primary install route: `npm i -g francois`. The package ships no binaries; its postinstall downloads the portable archives attached to a release, verifies them against sha256 digests baked into `manifest.json` at publish time, and **registers the app with the desktop** (Windows Start Menu `.lnk` + HKCU uninstall entry; macOS bundle moved to `~/Applications`; Linux `.desktop` + hicolor icon — all per-user, no elevation). This exists because SmartScreen/Gatekeeper key off the Mark-of-the-Web / `com.apple.quarantine` attribute a *browser* attaches — a CLI-fetched binary carries none, so unsigned builds install clean. **Always dispatched** with a `tag` input — never triggered by a release event, so there is exactly one publish per release and no double-publish race; it checks out the tag, asserts the tag matches `tauri.conf.json`, and publishes that version to dist-tag `latest`. The tag must point at a **published** release, because assets on a draft are not publicly downloadable — `release.yml` un-drafts before dispatching. **Credentials**: npm **trusted publishing** (OIDC, `id-token: write`) only — no token, no stored secret. That requires a trusted publisher registered on npmjs.com for the `francois` package matching **exactly** `antoine-gmnz/francois` · workflow `npm-publish.yml` · environment `npm-publish`; those are OIDC claims, and any mismatch refuses the exchange. Two consequences worth knowing: the job must write **nothing** to npm's auth config (a `_authToken` entry, including an empty one from `setup-node`, stops npm before it attempts the exchange), and the workflow is **not reusable** — a `uses:` call produces different claims, so `release.yml` dispatches it instead. Publishes with `--provenance`. On failure the publish step surfaces the real OIDC reason, which npm otherwise hides behind a bare `ENEEDAUTH`.
  - **Retired**: the rolling `dev` pre-release / `francois@dev` dist-tag and `release-main.yml`. They existed to give `main` a channel of its own; now that every push to `main` cuts a version, they were the same thing twice. `src-tauri/tauri.dev.conf.json` stays — it is what `npm run dev:app` / `npm run build:app:dev` use for a **local** side-by-side "Francois Dev" build (the overlay REPLACES the whole `app.windows` array — keep it in sync with the base window config).
  - `.github/actions/portable-archive` — composite action `release.yml` calls after `tauri-action`: packs the built app into an installer-free archive (`francois-darwin-universal.tar.gz` with the `.app`, re-signed ad-hoc since `lipo` strips the linker's signature and Apple Silicon won't run an unsigned Mach-O; `francois-win32-x64.zip` with `francois.exe`; `francois-linux-x64.tar.gz` with the AppImage) and attaches it to the release.
  - Build matrix: `windows-latest` (.exe/.msi), `macos-latest` universal .dmg (Apple Silicon + Intel), `ubuntu-22.04` (.AppImage/.deb, needs the webkit2gtk apt deps). All desktop builds are unsigned.

## Conventions

- **Logical channels**: specs and contracts name the frontend↔core interface as `francois:<domain>:<verb>` (request/response) and `francois:<domain>:event` (event streams). These names are canonical and transport-agnostic. **Physical binding on Tauri**:
  - request `francois:<domain>:<verb>` → Tauri command `<domain>_<verb>` (snake_case), called via `invoke('<domain>_<verb>', payload)` → `Promise<Result<T>>` (`Result` from `contract/common.ts`). Commands never reject for domain failures — every fallible call resolves to `Result`.
  - event stream `francois:<domain>:event` → Tauri event `francois://<domain>/event`, subscribed via `listen(...)`; payload is a tagged union with a `type` discriminator (e.g. `SessionEvent` in `contract/common.ts`).
  - Any spec text mentioning Electron/`ipcRenderer.invoke`/"main process" predates this binding and reads as: the Tauri mapping above / "Rust core".
- **Domains**: `app` · `session` · `conversation` · `diff` · `shell` · `agents` · `workflows` · `mcp` · `skills` · `palette` · `cli` · `project` · `remote` · `account`
- **IDs**: uuid-v4 strings. **Timestamps**: epoch milliseconds (`number`).
- **Feature ids**: kebab-case. Specs live in `specs/<id>.md` (template `specs/_template.md`, statuses: `draft` → `frozen` → `in-review`).
- **Naming**: types PascalCase, IPC verbs camelCase, files kebab-case.
- **Errors**: `AppError { code, message, detail? }` with codes from `ErrorCode` in `contract/common.ts`; extend the union in a feature contract only for feature-specific codes.

### Code layout

Both surfaces group by **feature**, not by technical kind. New code goes in the folder
that owns the feature — never in a new top-level file.

- **frontend** (`src/`): `src/features/<feature>/` holds that feature's components, its
  pure helpers, its tests, **and its stylesheet** together (`agents`, `commands`,
  `conversation`, `diff`, `mcp`, `overview`, `palette`, `permissions`, `projects`,
  `questions`, `remote`, `sessions`, `shell`, `skills`, `usage`).
  - **Styling is per-feature CSS + classNames, never inline `style={{}}`.** Each feature
    owns `<feature>.css` next to its components, and every component that renders those
    classes imports it directly (`import './conversation.css'`). Class names are BEM-lite:
    `block`, `block__element`, `block--modifier`. Only design **tokens** live in
    `src/styles.css`; `src/app/app.css` styles the shell. Inline `style` is acceptable
    only for a value computed at runtime (e.g. a token chosen by state).
  - **`src/ui/`** is the shared UI kit — the primitives every feature composes with
    (`Button`, `Chip`, `ChipGroup`, `ListRow`, `Modal`, `PanelHeader`, `StatusDot`,
    `BadgePill`, `EmptyPane`, `HintBar`, …). **Look here before building a component**;
    add to it only when a primitive is genuinely reusable across features.
  - **`src/lib/`** holds what every feature imports: `api.ts` (the contract-typed `invoke`
    wrappers), the zustand stores split per domain (`sessionsStore`, `projectsStore`,
    `overviewStore`, `remoteStore`, `usageStore`, `layoutStore`, `agentTabStore`, plus
    `store.ts`), shared helpers, and `src/lib/hooks/` for cross-feature hooks
    (`useDismiss`, `useTimedError`, `useElapsedClock`, …). Reach for an existing hook
    before writing a new one.
  - `src/app/` holds the shell; `main.tsx` and `styles.css` stay at the root. No barrel
    files anywhere — import the module directly.
- **core** (`src-tauri/src/`): each large domain is a module directory (`session/`,
  `diff/`, `permissions/`). Its `mod.rs` owns the **shared data model** — the types whose
  fields the whole domain touches — and declares the child modules; each child owns one
  concern plus its own `#[cfg(test)] mod tests`. Keeping the model in `mod.rs` is
  deliberate: Rust lets a child read an ancestor's private fields, so children need no
  widened visibility. Shared test fixtures live in a `#[cfg(test)] mod testutil`.
  Cross-cutting helpers that belong to no single domain are small top-level modules
  (`fs_util.rs`, `process_util.rs`, `wsl.rs`, `window.rs`, `diagnostics.rs`) — check
  these before adding a private copy inside a domain.
- **packaging** (`packaging/npm/`): the `francois` npm package — **not a surface**, so no
  agent owns it and it is not part of the contract. Plain CommonJS with **zero
  dependencies**, because it runs inside `npm install` before anything else exists;
  its tests are therefore `.mjs` reaching in through `createRequire`. `install.js`
  (postinstall) downloads + verifies + unpacks, `uninstall.js` (preuninstall) unregisters,
  `lib/platform.js` resolves the asset and the executable, `lib/desktop.js` owns the
  per-OS desktop integration, `bin/francois.js` is the launcher. `manifest.json` and
  `vendor/` are produced at publish/install time and are gitignored.
- **scripts** (`scripts/`): helpers CI runs, **not a surface** either. Plain ESM `.mjs`
  with zero dependencies, so a workflow can `node` them straight after `checkout`
  with no build and no install. Split pure-from-I/O the same way everywhere:
  `scripts/release/version.mjs` decides (and is unit-tested), `bump.mjs` touches git
  and the filesystem (and takes `--dry-run`).
- **Size**: no source file over ~1000 lines. Past that, split by concern rather than
  growing the file — and move each test with the code it covers.

## Testing — strict TDD (red → green → refactor)

- **frontend** (`vitest`, `npm test`): cover zustand stores, hooks, and the contract-typed `invoke` wrappers / event handlers (pure logic — no DOM component framework is wired). Layout and visuals are not unit-testable; the design mirror governs those.
- **scripts** (same `npm test` run — vitest's include covers `{packaging,scripts}/**/*.test.mjs`): cover the release version logic — bump decision, semver ordering, the pre-1.0 guard. The I/O half (`bump.mjs`) is proven by `node scripts/release/bump.mjs --dry-run` and by every release that runs it.
- **packaging** (same `npm test` run): cover the pure helpers only — asset/executable resolution, install-record round-trips, desktop-entry generation and shortcut paths. Anything that touches the real OS (`reg`, `WScript.Shell`, `lsregister`) takes an injectable `home`/`appData` so no test writes outside a temp dir. The download + unpack + register path is proven end-to-end in CI by `npm-publish.yml`, which runs the real postinstall on the runner before publishing.
- **core** (`cargo test` in `src-tauri`): cover command handlers against the contract shapes (serde round-trips of payloads and the tagged event unions), NDJSON stream parsing, and git operations against throwaway temp repos. No shared global state between tests.

## Feature map

| id | scope | depends on |
|---|---|---|
| `app-shell` | window chrome, grid layout, status bar, focus model, global keys, tokens | session-engine |
| `session-engine` | Claude Code process lifecycle + event stream (backend core) | — |
| `sessions-sidebar` | pane [1]: session list + new session | session-engine |
| `conversation-view` | main tab SESSION: transcript + input | session-engine |
| `diff-view` | main tab DIFF: git diff, stage, commit | session-engine |
| `shell-terminal` | main tab SHELL: PTY terminal | session-engine |
| `agents-panel` | pane [3]: subagents + progress | session-engine |
| `mcp-panel` | pane [4]: MCP server status + attach | session-engine |
| `skills-panel` | pane [5]: skills list + run | session-engine |
| `command-palette` | ⌘K modal + command registry | all UI features |
| `cli-companion` | `francois` CLI ↔ running app | session-engine |
| `session-questions` | SESSION tab: AskUserQuestion cards over the stdio control channel | session-engine, conversation-view |
| `slash-menu` | SESSION composer: "/" command autocomplete popup + per-session command registry | session-engine, conversation-view, interactive-commands, skills-panel |
| `permission-guardrails` | SESSION tab: approval cards for gated tool calls + a rules editor over Claude Code's own `settings.json` | session-engine, conversation-view, session-questions, command-palette |
| `async-agents` | pane [3]: async subagent lifecycle (real elapsed time, no spawn-ack completion) + per-agent activity trail from `parent_tool_use_id` | session-engine, agents-panel, conversation-view |
| `projects` | project registry + session defaults + standards written into `<root>/CLAUDE.md`; pane [1] switcher + Projects modal | session-engine, sessions-sidebar, fleet-board, command-palette, durable-sessions, app-shell |
| `overview` | main tab OVERVIEW: cross-project dashboard (fleet totals, needs-attention, per-project rollup, activity feed); auto-selected on "All projects" | projects, fleet-board, session-engine, sessions-sidebar, app-shell, diff-view, agents-panel, command-palette |
| `remote-control` | HOST Claude Code's native Remote Control per session (interactive `claude --remote-control` in a core-owned PTY) so the same thread continues on phone/claude.ai; URL + copy (QR deferred) | session-engine, durable-sessions, conversation-view, app-shell |
| `agent-tab` | dynamic main tabs after SHELL: click a pane [3] card to read that subagent's own conversation (per-agent block transcript, `francois:agents:transcript` + `agent.block`) | async-agents, agents-panel, conversation-view, app-shell |
| `workflow-panel` | pane [6]: `Workflow` tool runs read off the session stream — name/description/phases from the script's `meta`, live elapsed, ack + completion notice (`francois:workflows:list` + `workflow.update`) | session-engine, agents-panel, async-agents, app-shell |
| `durable-sessions` | sessions survive quit/reopen — persisted transcript, status, model, context usage; resume over `claude --resume` | session-engine, sessions-sidebar |
| `fleet-board` | per-session status cards (state, model, context usage, diff badge, agent count, last activity), keyboard-navigable | session-engine, sessions-sidebar, app-shell |
| `interactive-commands` | SESSION tab: slash commands that need a round-trip (`/model`, `/compact`, …) driven through the stdio control channel | session-engine, conversation-view |
| `message-history` | SESSION composer: recall previously sent messages with `↑`/`↓`, per session | conversation-view |
| `multi-account` | several Anthropic accounts side by side — per-account config dir (mirrored from the global `~/.claude`), account picker, per-project default account | session-engine, projects, app-shell, usage-bar |
| `session-attachments` | SESSION composer: attach files from disk or the clipboard (images included) to a turn | conversation-view, session-engine |
| `session-worktree` | open a session in a dedicated `git worktree` so its edits never touch the main checkout | session-engine, sessions-sidebar, diff-view |
| `session-rename` | rename a session's display name from the sidebar context menu or the palette; propagates over `session.meta` | session-engine, sessions-sidebar, command-palette |
| `usage-bar` | account plan limits under the system title bar — app-scoped probe + cache, reset clock | multi-account, app-shell |
| `wsl-filesystem` | Windows: git follows the filesystem, shell and `claude` follow the WSL runtime — path translation across the boundary | session-engine, shell-terminal, diff-view |
| `collapse-right-column` | per-card collapse/expand for panes [3]–[6] (click, `c`, palette), persisted | app-shell, agents-panel, mcp-panel, skills-panel |
| `mac-text-selection` | macOS: text selection + copy in the SESSION transcript | conversation-view |
| `notifications` *(frozen)* | desktop notification when a background session finishes, errors, or needs input | session-engine, app-shell |
| `session-brake` *(frozen)* | stop a running turn mid-flight | session-engine, conversation-view |
| `design-refresh` *(frozen)* | redesign to variant 3a — Console chrome + Focus reading treatment + agent tabs | app-shell, conversation-view, agent-tab |
