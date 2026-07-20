# PIPELINE.md — Francois

Project: **Francois** — a desktop terminal app that orchestrates Claude Code sessions (named after Claude François, the French singer). Product description: `PROJECT.md`. Visual source of truth: `Claude Terminal.dc.html` + `screenshots/`.

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
