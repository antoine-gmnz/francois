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
    lint_cmd: ""                              # no eslint configured; tsc is the static gate
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
    lint_cmd: ""
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
  format: ""
  typecheck: npx tsc --noEmit
  test: npm test && cd src-tauri && cargo test
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
  deny:
    - "git push --force"
    - "git push -f"
  ask:
    - "git commit"
    - "git push"
    - "git merge"
    - "git rebase"
    - "git reset"
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
  - `release-main.yml` — every push to `main`: test gate + Linux compile check (`prepare` job), then (if green) a `publish` matrix building installers for **Windows / macOS (universal) / Linux** and refreshing the rolling **`dev`** pre-release (always tracks latest main). Dev-channel builds pass `--config src-tauri/tauri.dev.conf.json` → they install as **Francois Dev** (`com.francois.dev`) with a separate data dir, coexisting with a stable install. Local equivalents: `npm run dev:app` / `npm run build:app:dev`. (The overlay REPLACES the whole `app.windows` array — keep it in sync with the base window config.)
  - `release.yml` — a `v*` tag (or manual run): the same 3-OS matrix into a versioned draft release (the stable channel). Version comes from `tauri.conf.json`.
  - Build matrix: `windows-latest` (.exe/.msi), `macos-latest` universal .dmg (Apple Silicon + Intel), `ubuntu-22.04` (.AppImage/.deb, needs the webkit2gtk apt deps). All desktop builds are unsigned.

## Conventions

- **Logical channels**: specs and contracts name the frontend↔core interface as `francois:<domain>:<verb>` (request/response) and `francois:<domain>:event` (event streams). These names are canonical and transport-agnostic. **Physical binding on Tauri**:
  - request `francois:<domain>:<verb>` → Tauri command `<domain>_<verb>` (snake_case), called via `invoke('<domain>_<verb>', payload)` → `Promise<Result<T>>` (`Result` from `contract/common.ts`). Commands never reject for domain failures — every fallible call resolves to `Result`.
  - event stream `francois:<domain>:event` → Tauri event `francois://<domain>/event`, subscribed via `listen(...)`; payload is a tagged union with a `type` discriminator (e.g. `SessionEvent` in `contract/common.ts`).
  - Any spec text mentioning Electron/`ipcRenderer.invoke`/"main process" predates this binding and reads as: the Tauri mapping above / "Rust core".
- **Domains**: `app` · `session` · `conversation` · `diff` · `shell` · `agents` · `mcp` · `skills` · `palette` · `cli`
- **IDs**: uuid-v4 strings. **Timestamps**: epoch milliseconds (`number`).
- **Feature ids**: kebab-case. Specs live in `specs/<id>.md` (template `specs/_template.md`, statuses: `draft` → `frozen` → `in-review`).
- **Naming**: types PascalCase, IPC verbs camelCase, files kebab-case.
- **Errors**: `AppError { code, message, detail? }` with codes from `ErrorCode` in `contract/common.ts`; extend the union in a feature contract only for feature-specific codes.

## Testing — strict TDD (red → green → refactor)

- **frontend** (`vitest`, `npm test`): cover zustand stores, hooks, and the contract-typed `invoke` wrappers / event handlers (pure logic — no DOM component framework is wired). Layout and visuals are not unit-testable; the design mirror governs those.
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
