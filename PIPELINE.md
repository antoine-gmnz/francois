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
  patch_branch_prefix: fix/                  # same, for /cohorte-patch specs (kind: patch)

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
    lint_cmd: npx eslint .
    lint_quiet_cmd: npx eslint . --format compact
    format_cmd: ""                            # no prettier; eslint --fix is the autofixer
    typecheck_cmd: npx tsc --noEmit
    build_cmd: npm run build
    uses_design: true
  - key: core
    path: [src-tauri, scripts/quality]        # widened core-architecture-wave3 FR-8/FR-10: quality-rule authoring for Rust-shape checks has no other owner
    label: core (Rust / Tauri 2)
    agent: core
    tools: [Read, Write, Edit, Bash, Grep, Glob, mcp__serena, mcp__cartograph__map, mcp__cartograph__query, mcp__cartograph__neighbors, mcp__cartograph__concept, mcp__cartograph__record, mcp__cartograph__stale]
    model: inherit
    test_cmd: cd src-tauri && cargo test
    test_quiet_cmd: cd src-tauri && cargo test --quiet
    lint_cmd: cd src-tauri && cargo clippy --all-targets
    lint_quiet_cmd: cd src-tauri && cargo clippy --all-targets --quiet
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

# ── release notes (optional) ────────────────────────────────────────────────
# No per-feature note-consuming tool detected (no changesets, no note-enforcing
# CI job) — release.yml derives versions from conventional commits automatically.
release_notes:
  enabled: false                              # /cohorte-ship §2b is a no-op

# ── repo-wide commands ──────────────────────────────────────────────────────
commands:
  install: npm install
  dev: npm run dev:app
  lint: npm run quality
  lint_quiet: npm run quality
  format: cd src-tauri && cargo fmt
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
  design_system_project: "Design system extraction plan"   # a4b15728-147c-4932-b83c-f60a5fc60db7
  design_project: none
  snapshot_dir: ""                            # local mirror lives at the repo root: *.dc.html + screenshots/
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
  # Phase gate: review dispatches require a fresh `.claude/preflight.ok` stamp,
  # written by pipeline/scripts/preflight.sh when typecheck+tests are green — gate.py
  # "ask"s the dispatch when the stamp is missing, stale, or the code changed since.
  # The stamp is local: keep `.claude/preflight.ok` gitignored, never committed.
  preflight:
    enabled: true
    agents: [review]                          # subagent_types the stamp gates
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
- Source: Claude Design project **"Design system extraction plan"** (`a4b15728-147c-4932-b83c-f60a5fc60db7`), mirrored locally at the repo root. The mocks are authoritative for layout, colors, glyphs, and micro-interactions. Pull a fresh copy with the `DesignSync` tool (`list_files` / `get_file`) — the local copies go stale silently.
  - `Francois Redesign.dc.html` — the shell, variant 3a (Console chrome + Focus reading treatment + agent tabs). **The v2 identity is applied here**: turn 4 is the current shell.
  - `Francois Design System v2.dc.html` — the extracted system: surfaces, type roles, the colour families, geometry, components, and the six do/don't rules.
  - `Francois Logo.dc.html` — the mark. Turn 5a is the chosen direction, turn 6 applies it, turn 7 is the specimen sheet (size ramp, tone variants, lockups, clearspace, misuse).
  - `Claude Terminal.dc.html` (+ `screenshots/`) — the pre-v2 mock, kept for the surfaces the redesign never re-drew. Where the two disagree, the redesign wins. (Its "clyde" branding reads as "francois".)
- **Identity v2** (July 2026): the accent moved from amber `#e0a84e` to acid `#c3f53f`, and the diamond glyph was replaced by the three-slab offset mark. "Ready" green moved to `#4fae86` so status never reads as accent. The accent means *the live thing* — one per view.
- **Flat (turn 9a, August 2026)** — the current treatment, applied on top of 7a. **No 1px strokes, no shadows on anything in flow**: separation comes from tonal steps in the surfaces alone, which is why removing a rule always means adding a surface. Four named tiers — window `#0d0f13` · chrome `#171b22` · rails `#12161c` · canvas `#0a0b0e` — plus a recessed block `#101319`. Panes stop being cards: no window padding, no gutter, no radius, flush to the edge. Roster rows and permission choices run **full-bleed**, so a fill reads as the row rather than as a tile in it. Framed blocks (welcome, permission) become filled ones, and their notched legends become plain uppercase labels — a notch only exists to interrupt a border. The accent steps back from acid `#c3f53f` to olive `#9cb45f` so the amber that means *come here* (`#d0a45c`) wins the page. Survivors, because they are not decoration: the scrollbar thumb, the keyboard focus ring, markdown's own rules and table grid, and a shadow on floating layers (which have no surface behind them to step against).
- **Sessions pane (turn 12b, August 2026)** — pane [1] groups by **state and nothing else**: WAITING ON YOU · RUNNING · IDLE · ARCHIVED, in that fixed order, so a blocked session can never be the fourth row down. There is no grouping toggle and no repo tier — the 7a/project-groups roster body is gone, and `roster-groups.ts` survives only as the two helpers that name a session's repo. Row weight tracks what the session asks of you: a parked approval carries the ask and its **Allow / Deny inline** (answered from the roster, no need to open the session); a running row carries live elapsed + the tool in flight + its context bar; a **settled row carries what you need to decide what to do with it** — name + `idle 5h`, then its branch with a 26px context bar and the tokens used, then `+184 −52 · 6 files, uncommitted` off the working tree. Nothing repeats: the state lives in the heading (so no row has a status tag), the project is a tag shown **only when more than one is open**, the model chip appears **only when the session is off its project's default**, and the cwd moves into the row's hover title. The dissolved right column's four destinations fold from four stacked rows onto **one strip** — Agents · MCP · Skills · Flows, counts only when non-zero. Two deliberate departures from the mock: the palette reading is kept (amber `#d0a45c` means *come here* → WAITING; the accent means *the live thing* → RUNNING, where the mock has them swapped), and a **clean tree renders no third line** rather than the mock's "ready to review", which would need a commits-ahead probe the roster does not run.

- **Ranked topbar (turns 10a/11a/11c, August 2026)** — the session row, rebuilt. It used to pack eleven things in **source order**, so the first casualty of a narrow window was whatever happened to sit in the middle: the worktree path cropped mid-string while the controls either side of it kept their full width. **10a** declares the order instead — `src/app/topbar.ts` owns it, the row reads it — and fixes three things before anything else: the path leaves the bar (it is the least glanceable string in it, and lives on the project chip's tooltip now), the two clocks merge into one (`active 19:13` and `· 19:13` were the same number), and every control becomes 26px. Drop order, widest-first: `path → context figure → branch name → layout segments → extension labels → model chip → context bar → extension tabs`; three tiers at 1120 / 840, and everything dropped stays reachable behind `⋯`. Four controls are not in the order at all — the project chip, the status pill, the view segment and `Stop` — because their absence would be dangerous or disorienting. The session title is the only element that may shrink; everything else is `flex-shrink: 0`, which is what stops mid-string crops, and it does **not** grow (11a moves the growing to the spacer after the tab cluster, so the tabs do not slide when `Stop` appears). **11a** makes `◈` the whole plugin surface: pinned tabs to its left, every installed extension inside it, and two deliberately unalike controls per row — the pin is cosmetic and reversible, the switch turns hooks, MCP servers and skills on with it. The pin is window chrome, so it persists to `localStorage`, and a disabled extension loses its tab, its pin and its tile colour together. **11c** merges the model chip and the permission badge into one **run chip**: one panel, model over permission mode, effort *inside* the selected model's row because effort is a property of the model. Permission rows are radio — one mode is always in force — and only `bypass` gets a tinted row plus the line saying how long it has been on and in which worktree (`SessionMeta.permissionModeSince`). `PermissionModeBadge` and its popover are gone, folded into that panel. The window's `minWidth` dropped 1080 → 720 so the tiers this order describes are actually reachable; the rest of the shell was laid out for ≥1080 and has not been re-tuned for 720.

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
- **Domains**: `app` · `session` · `conversation` · `diff` · `shell` · `agents` · `workflows` · `mcp` · `skills` · `palette` · `cli` · `project` · `standards` · `profiles` · `permissions` · `remote` · `account` · `cloud` · `extensions`
- **IDs**: uuid-v4 strings. **Timestamps**: epoch milliseconds (`number`).
- **Feature ids**: kebab-case. Specs live in `specs/<id>.md` (template `specs/_template.md`, statuses: `draft` → `frozen` → `in-review`).
- **Naming**: types PascalCase, IPC verbs camelCase, files kebab-case.
- **Errors**: `AppError { code, message, detail? }` with codes from `ErrorCode` in `contract/common.ts`; extend the union in a feature contract only for feature-specific codes.

### Code layout

Both surfaces group by **feature**, not by technical kind. New code goes in the folder
that owns the feature — never in a new top-level file.

- **frontend** (`src/`): `src/features/<feature>/` holds that feature's components, its
  pure helpers, its tests, **and its stylesheet** together (`accounts`, `agents`,
  `cloud-sessions`, `commands`, `conversation`, `diff`, `extensions`, `mcp`,
  `notifications`, `overview`, `palette`, `permissions`, `profiles`, `projects`,
  `questions`, `remote`, `sessions`, `shell`, `skills`, `update`, `usage`,
  `workflows`).
  - **Styling is per-feature CSS + classNames, never inline `style={{}}`.** Each feature
    owns `<feature>.css` next to its components, and every component that renders those
    classes imports it directly (`import './conversation.css'`). Class names are BEM-lite:
    `block`, `block__element`, `block--modifier`. Only design **tokens** live in
    `src/styles.css`; `src/app/app.css` styles the shell. Inline `style` is acceptable
    only for a value computed at runtime (e.g. a token chosen by state).
  - **Icons are `lucide-react`**, imported by name (`import { Pencil } from 'lucide-react'`)
    so Vite tree-shakes the rest. They inherit `currentColor` — set the tone in the
    feature's CSS, never with a `color` prop. Unicode glyphs stay only where they are
    *typography* rather than iconography: keycaps (`⌘K`, `⏎`), disclosure carets
    (`▸`/`▾`), and the `☑`/`☐` in question options.
  - **`src/ui/`** is the shared UI kit — the primitives every feature composes with
    (`Action`, `BadgePill`, `Button`, `Chip`, `ChipGroup`, `EmptyPane`, `HintBar`,
    `ListRow`, `Logo`, `Modal`, `PanelHeader`, `RemoveControl`, `StatusDot`, …).
    **Look here before building a component**; add to it only when a primitive is
    genuinely reusable across features — a component that outgrows one feature moves
    here rather than being imported across feature folders (`Action` and
    `RemoveControl` came out of `features/projects/` that way).
  - **`src/lib/`** holds what every feature imports: `api.ts` (the contract-typed `invoke`
    wrappers), the zustand stores split per domain (`sessionsStore`, `projectsStore`,
    `profilesStore`, `overviewStore`, `remoteStore`, `usageStore`, `accountsStore`,
    `extensionsStore`, `notificationsStore`, `updateStore`, `panelCountsStore`,
    `layoutStore`, `agentTabStore`, plus `store.ts`), shared helpers, and
    `src/lib/hooks/` for cross-feature hooks
    (`useDismiss`, `useTimedError`, `useElapsedClock`, …). Reach for an existing hook
    before writing a new one.
  - `src/app/` holds the shell; `main.tsx` and `styles.css` stay at the root. No barrel
    files anywhere — import the module directly.
- **core** (`src-tauri/src/`): each large domain is a module directory (`session/`,
  `diff/`, `permissions/`, `project/`, `profiles/`, `extensions/`, `account/`,
  `shell/`, `editor/`, `update/`). Its `mod.rs` owns the **shared data model** — the types whose
  fields the whole domain touches — and declares the child modules; each child owns one
  concern plus its own `#[cfg(test)] mod tests`. Keeping the model in `mod.rs` is
  deliberate: Rust lets a child read an ancestor's private fields, so children need no
  widened visibility. Shared test fixtures live in a `#[cfg(test)] mod testutil`.
  Cross-cutting helpers that belong to no single domain are small top-level modules
  (`fs_util.rs`, `process_util.rs`, `wsl.rs`, `window.rs`, `diagnostics.rs`,
  `usage.rs`, `dnd.rs`, `ipc.rs`) — check these before adding a private copy inside a
  domain. In particular **every child spawn goes through `process_util`'s login-shell
  PATH helper**: a GUI app inherits launchd's minimal `PATH`, so a bare `argv0`
  (`claude`, an extension provider) otherwise fails to resolve for anyone whose binary
  lives in nvm/Homebrew/pnpm/cargo/`~/.local/bin` (`ext-path-resolution`).
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
  and the filesystem (and takes `--dry-run`). The one exception to the ESM rule is
  `scripts/capture/` — a PowerShell window-grabber that regenerates the README
  screenshot and GIF from the app running against the `src/demo/` fake fleet
  (`VITE_FRANCOIS_DEMO=1`). It is a local tool, never run by CI; see its README.
- **examples** (`examples/extensions/`): worked `extension.json` manifests a plugin author
  copies to start — **not a surface**, and not shipped in any build. They are not inert
  documentation either: `src-tauri/src/extensions/manifest.rs` loads
  `examples/extensions/plugin-example/` as a `cargo test` fixture, so a schema change that
  breaks the example fails the build (extension-install FR-32). Treat an example as part of
  the schema's test surface — update it in the same commit as the schema, never after.
- **Size**: no source file over ~1000 lines. Past that, split by concern rather than
  growing the file — and move each test with the code it covers.

## Testing — strict TDD (red → green → refactor)

- **frontend** (`vitest`, `npm test`): cover zustand stores, hooks, and the contract-typed `invoke` wrappers / event handlers (pure logic — no DOM component framework is wired). Layout and visuals are not unit-testable; the design mirror governs those.
- **scripts** (same `npm test` run — vitest's include covers `{packaging,scripts}/**/*.test.mjs`): cover the release version logic — bump decision, semver ordering, the pre-1.0 guard. The I/O half (`bump.mjs`) is proven by `node scripts/release/bump.mjs --dry-run` and by every release that runs it.
- **packaging** (same `npm test` run): cover the pure helpers only — asset/executable resolution, install-record round-trips, desktop-entry generation and shortcut paths. Anything that touches the real OS (`reg`, `WScript.Shell`, `lsregister`) takes an injectable `home`/`appData` so no test writes outside a temp dir. The download + unpack + register path is proven end-to-end in CI by `npm-publish.yml`, which runs the real postinstall on the runner before publishing.
- **core** (`cargo test` in `src-tauri`): cover command handlers against the contract shapes (serde round-trips of payloads and the tagged event unions), NDJSON stream parsing, and git operations against throwaway temp repos. No shared global state between tests.

## Code quality gates

`npm run quality` is the whole gate in one word — typecheck, ESLint, conventions, rustfmt, clippy. Everything below is a piece of it, and every piece runs identically on a laptop and in CI.

- **Where the policy lives.** ESLint's is `eslint.config.js` (flat config, pinned to **9.x** because ESLint 10 requires Node ≥20.19 and the hooks must run on whatever Node is already installed). Clippy's is `src-tauri/Cargo.toml` **`[lints]`** — *not* a `-D warnings` flag, because flags after `--` are appended last and would silently override every documented exception. The repo-shape rules are `scripts/quality/conventions.mjs`.
- **The ratchet.** A rule with **zero** current violations is an `error`; a rule with existing violations is a `warn` that carries its count. So new code is held to the rule while nobody is asked to pay down old debt to merge. Every clippy `allow` and every warn-level ESLint rule carries a comment saying *why* it sits there and what would clear it — an exception without a reason is a mute button.
- **The file-size ratchet is explicit.** `scripts/quality/oversized-baseline.json` lists the files already over the CLAUDE.md 1000-line cap. A file **on** the list warns; a file **not** on it that crosses the cap **fails**. Shrink the list, never grow it (`node scripts/quality/check.mjs --update-baseline` re-records it).
- **Hooks are tracked files, not a dependency.** `npm run prepare` points `core.hooksPath` at `.githooks/`, so there is no husky and reviewing a hook change is an ordinary diff. `pre-commit` lints **staged files only** and never blocks on warnings — a hook that punishes you for touching a file with pre-existing debt is a hook people disable. `pre-push` runs `tsc` + conventions. Neither runs the test suites; CI owns those. Bypass either with `--no-verify`.
- **Reports.** `npm run quality:report` writes `reports/` (gitignored): SARIF + JSON per tool, plus `summary.md`. `.github/workflows/quality.yml` uploads the SARIF to **code scanning**, so findings land inline on the PR's Files Changed tab rather than in a log, and attaches the rest as artifacts. `npm run test:coverage` writes `reports/coverage/` — published on every run, with **no threshold gate**, deliberately: a single repo-wide percentage is a number people game.
- **`quality.yml` is separate from `ci.yml`** because they answer different questions. `ci.yml` proves the code *works* (build + both suites, on both shipping OSes); `quality.yml` proves it is *clean*, once, on Linux, since linting is OS-independent.
- **Known backlog**, surfaced by the gate and deliberately not fixed in it: 13 `react-hooks/exhaustive-deps` sites (`npm run lint:deps`), `SessionEvent`/`InteractiveMsg` at ≥640 bytes per variant (`clippy::large_enum_variant`), 15 oversized files, and 63 cross-feature imports.

## Feature map

> **Read the pane numbers through design turn 7a** (commit `0f502c5`, `Francois Redesign.dc.html`):
> the right column is gone. Panes `[3]`–`[6]` (agents · mcp · skills · workflows) dissolved into the
> roster's own rows and open as **main-pane tabs** — `3`–`6` open one and toggle back to SESSION.
> Chrome is two full-bleed tiers (app row + session row); the status bar and the tab strip inside the
> main card are gone, and with the right column went `]` and `c`. Rows below keep their original
> pane wording because that is how each spec is written.

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
| `session-welcome` | SESSION tab: the framed welcome header an empty transcript shows — identity column + repo column (CLAUDE.md, branch/ahead via `francois:project:repoBrief`, sessions that finished here) | conversation-view, session-engine, projects, multi-account, app-shell |
| `multi-account` | several Anthropic accounts side by side — per-account config dir (mirrored from the global `~/.claude`), account picker, per-project default account | session-engine, projects, app-shell, usage-bar |
| `session-attachments` | SESSION composer: attach files from disk or the clipboard (images included) to a turn | conversation-view, session-engine |
| `session-worktree` | open a session in a dedicated `git worktree` so its edits never touch the main checkout | session-engine, sessions-sidebar, diff-view |
| `session-rename` | rename a session's display name from the sidebar context menu or the palette; propagates over `session.meta` | session-engine, sessions-sidebar, command-palette |
| `usage-bar` | account plan limits under the system title bar — app-scoped probe + cache, reset clock | multi-account, app-shell |
| `wsl-filesystem` | Windows: git follows the filesystem, shell and `claude` follow the WSL runtime — path translation across the boundary | session-engine, shell-terminal, diff-view |
| `collapse-right-column` *(superseded by design 7a)* | per-card collapse/expand for panes [3]–[6] (click, `c`, palette), persisted — the right column it acted on no longer exists | app-shell, agents-panel, mcp-panel, skills-panel |
| `mac-text-selection` | macOS: text selection + copy in the SESSION transcript | conversation-view |
| `notifications` | desktop notification when a session is blocked on an approval/question, or its turn finished/errored | session-engine, app-shell, session-questions, permission-guardrails, command-palette |
| `session-brake` *(frozen)* | stop a running turn mid-flight | session-engine, conversation-view |
| `design-refresh` | redesign to variant 3a — Console chrome + Focus reading treatment + agent tabs | app-shell, conversation-view, agent-tab |
| `extensions` | main-pane `ext:` tabs fed by out-of-process providers under hard caps — four declarative primitives (`key-value`, `table`, `stat-row`, `log-tail`), per-project detection with caching, per-extension toggles | app-shell, agent-tab, workflow-details, projects, command-palette, session-engine |
| `extension-install` | plugins loaded from `~/.francois/extensions/*/extension.json` instead of a compiled registry — closed detection-predicate set, consent bound to the manifest sha256, `francois ext install\|list\|remove`; amends `extensions` | extensions, cli-companion, app-shell, projects |
| `fix-agent-view` | dynamic tabs keyed by session instead of one global list — the single pane and both panes of a two-pane split render their own session's agent/workflow tabs after SHELL (the grid stays flat), and a spawned subagent adds its own chip on its first `agent.update`; supersedes agent-tab FR-14 + split-by-4 FR-20 | agent-tab, workflow-details, split-by-4, design-refresh, async-agents, agents-panel, workflow-panel, app-shell |
| `workflow-details` | main-pane tab for one `Workflow` run — its agents, phase timeline and per-agent transcripts | workflow-panel, agent-tab, async-agents, conversation-view, app-shell |
| `titlebar-project-switcher` | the project switcher lives in the system title bar, beside the plan meters | projects, design-refresh, usage-bar, overview, agent-tab, app-shell |
| `multiple-shells` | several PTY terminals per session, tabbed inside the SHELL tab | shell-terminal, session-engine, app-shell, wsl-filesystem, command-palette |
| `attach-to-worktree` | point a new session at a worktree that already exists instead of creating one | session-worktree, session-engine, sessions-sidebar, projects, app-shell |
| `open-in-vscode` | open a session's directory (or its worktree) in VS Code from the sidebar/palette | session-engine, sessions-sidebar, session-worktree, wsl-filesystem |
| `cloud-sessions` | adopt a Claude Code on the web session into the local fleet and keep the thread going | session-engine, durable-sessions, session-worktree, projects, multi-account, sessions-sidebar, command-palette |
| `self-update` | in-app update check + install, surfaced in the title bar and the palette | app-shell, command-palette, session-engine |
| `webview-hardening` | self-hosted fonts + a Content-Security-Policy on the webview — no network fetch at runtime | app-shell, shell-terminal, session-attachments, multi-account |
| `split-by-4` *(frozen)* | up to four main panes side by side, each on its own session | split-session, app-shell, sessions-sidebar, conversation-view, diff-view, shell-terminal, collapse-right-column, agent-tab, workflow-details, fleet-board |
| `session-profiles` | named, project-paired session profiles (a system prompt in replace mode + vetted raw `claude` argv) picked at spawn and snapshotted onto the session; Profiles modal as a Projects sibling (`francois:profiles:*`) | session-engine, sessions-sidebar, projects, session-welcome, command-palette, durable-sessions, multi-account |
| `ext-path-resolution` | extension providers resolve bare `argv0` against the **login-shell** PATH (`process_util`), not launchd's minimal one; relative/empty entries filtered out | extensions, extension-install |
| `project-groups` | a named parent over projects — a second tier in the pane [1] roster and the Projects modal; organising only, carries no defaults, standards or scope | projects, sessions-sidebar, session-engine, app-shell |
| `audio-cues` | short synthesized tones (Web Audio, no asset) for the two notification classes — no focus gate, one master toggle, 1.5s throttle, silent under OS Do Not Disturb (`francois:app:dndState`) | notifications, session-engine, app-shell, command-palette |
| `diff-navigator` | DIFF tab: collapsible folder tree + filter box replacing the flat file list, plus dependency-free word-level intraline emphasis; amends `diff-view` (no contract, no Rust) | diff-view, app-shell |
| `multi-provider-seam` *(in-review)* | the `SessionAdapter`/`TurnControl` trait seam between the session engine and whatever drives a turn, `ClaudeCodeAdapter` as its only implementation, the `AgentRuntime`/`ProviderProtocol`/`AccountKind` discriminators, and the `runtimeCapabilities()` table. Zero user-visible change | session-engine, multi-account, durable-sessions, permission-guardrails |
| `multi-provider-endpoint` *(in-review)* | `Account.kind: 'openai-compatible'` — endpoint accounts (label, base URL, key file, model override) added, tested, edited and removed from the Accounts modal; listable but not yet session-selectable | multi-account, multi-provider-seam, projects |
| `multi-provider-openai` *(frozen)* | `OpenAiAdapter` — a Rust-native agent loop over `POST /chat/completions` + SSE, six tools carrying Claude Code's names, every call through the existing permission gate, adapter-owned thread persistence, skill injection, and the disabled-pane treatment | multi-provider-seam, multi-provider-endpoint, permission-guardrails, durable-sessions, conversation-view |
| `multi-provider-codex` *(in-progress)* | a third `AgentRuntime` — OpenAI's `codex` CLI driving its own loop over `codex exec --json`, `codex-cli` accounts authenticated by `codex login` into a per-account `CODEX_HOME` (ChatGPT plan, no API key), permissionMode mapped onto Codex's sandbox | multi-provider-seam, multi-account, durable-sessions, session-engine, conversation-view, projects |
| `capability-registry` *(draft)* | invert skills/MCP/agents from Claude Code control surfaces into discovery adapters feeding an internal registry both runtimes read + translate; compatibility verdicts derived rather than hand-maintained | multi-provider-seam, multi-provider-openai, skills-panel, mcp-panel, agents-panel, projects, session-engine |
