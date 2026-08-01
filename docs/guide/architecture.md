# Architecture

Francois is a **native desktop app**, not a web app: [Tauri 2](https://v2.tauri.app/) with a
Rust core and a React + TypeScript frontend rendered in the system webview (no Electron).

## The two surfaces

| Surface | Where | What it owns |
| --- | --- | --- |
| **core** | `src-tauri/` (Rust) | Session lifecycle, spawning `claude -p --output-format stream-json --include-partial-messages` per session and parsing its NDJSON event stream, PTY management (`portable-pty`) for the SHELL tab, and git operations via the system `git` CLI. |
| **frontend** | `src/` (React 18 + TypeScript, `strict: true`) | Every pane, tab, and modal in the window. State lives in [zustand](https://github.com/pmndrs/zustand) stores; the terminal panes render with [xterm.js](https://xtermjs.org/); styling is plain CSS with design tokens — no component framework, no Tailwind. |

Each domain on the core side is a module directory (`session/`, `diff/`, `permissions/`) whose
`mod.rs` owns the shared data model and declares child modules; each child owns one concern plus
its own tests. The frontend groups by **feature**, not technical kind — `src/features/<feature>/`
holds a feature's panel, its pure helper functions, its tests **and its stylesheet** together
(`accounts`, `agents`, `commands`, `conversation`, `diff`, `mcp`, `overview`, `palette`,
`permissions`, `projects`, `questions`, `remote`, `sessions`, `shell`, `skills`, `usage`,
`workflows`). `src/ui/` is the shared UI kit every feature composes with (`Button`, `Chip`,
`ListRow`, `Modal`, `PanelHeader`, `StatusDot`, …), and `src/lib/` holds only what every feature
imports — the contract-typed `invoke` wrappers, the per-domain zustand stores, and shared hooks.
Styling is per-feature CSS plus class names, never inline styles; only design tokens live in
`src/styles.css`.

## The contract

Every payload shape crossing the frontend↔core boundary lives in `contract/` — plain TypeScript
type files, one per feature plus a shared `common.ts` — and the Rust core mirrors them with serde
structs. This is the **only** sync channel between the two surfaces; nothing is
stringly-typed IPC.

The binding on top of Tauri is a fixed naming convention:

- A request `francois:<domain>:<verb>` maps to the Tauri command `<domain>_<verb>` (snake_case),
  called as `invoke('<domain>_<verb>', payload)`, resolving to `Promise<Result<T>>`. Commands
  never reject for a domain failure — every fallible call resolves to a `Result`, so error
  handling is uniform everywhere.
- An event stream `francois:<domain>:event` maps to the Tauri event `francois://<domain>/event`,
  subscribed via `listen(...)`, with a tagged-union payload (a `type` discriminator).

Domains: `app`, `session`, `conversation`, `diff`, `shell`, `agents`, `workflows`, `mcp`,
`skills`, `palette`, `cli`, `project`, `remote`, `account`.

## How a feature gets built

Every feature ships from a **frozen spec** in `specs/<id>.md` — summary, goals/non-goals, user
flows, numbered functional requirements, the exact contract shapes, data & state, edge cases, a
design brief, and acceptance criteria. A feature moves through a disciplined pipeline: brainstorm
→ spec (frozen) → contract authored → one implementer agent per surface, in parallel, strictly
test-first → smoke-tested end to end → reviewed against the spec → shipped. The full doctrine
lives in `PIPELINE.md` at the repo root, alongside every shipped feature's spec in `specs/`.

## Testing

- **Frontend** (`vitest`, `npm test`) — covers zustand stores, hooks, and the contract-typed
  `invoke` wrappers and event handlers. Layout and visuals aren't unit-testable; the design mock
  (`Francois Redesign.dc.html`) governs those.
- **Core** (`cargo test`, run inside `src-tauri`) — covers command handlers against the contract
  shapes (serde round-trips of payloads and the tagged event unions), NDJSON stream parsing, and
  git operations against throwaway temp repos.
- **Packaging and release scripts** (same `npm test` run) — the npm package's pure helpers (asset
  resolution, install records, desktop-entry generation) and the release version logic. Anything
  touching the real OS takes an injectable home directory, so no test writes outside a temp dir.

## CI & releases

Every pull request runs `npm run build` (typecheck + Vite build) and `npm test`, plus
`cargo test`. Every push to `main` cuts a release automatically: a version bump from conventional
commits, a three-platform build (Windows, macOS universal, Linux), and a republish of the
[`francois` npm package](/reference/cli) against the new binaries — no manual step at any point.

## Where to read more

- **`PROJECT.md`** — the original product/design description, including the full visual design
  system (colors, glyphs, motion). The reference mocks live at the repo root:
  `Francois Redesign.dc.html` is the current system (variant 3a — Console chrome, the Focus
  reading treatment, agent tabs); `Claude Terminal.dc.html` is the original.
- **`PIPELINE.md`** — the complete build pipeline: stack decisions, contract conventions, code
  layout rules, testing philosophy, and CI/release mechanics.
- **`specs/`** — one frozen spec per shipped feature; the closest thing to a living functional
  spec for the whole app.
