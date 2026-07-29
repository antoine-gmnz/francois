# /init-pipeline · 01 Detect the stack

### Phase 1 — Detect the stack (read-only, no questions yet)

Gather evidence, then summarize what you found. Look for:

- **Package manager & workspaces:** root `package.json` (`packageManager`, `workspaces`),
  `pnpm-workspace.yaml`, `turbo.json`, `nx.json`, `lerna.json`; lockfiles (`pnpm-lock.yaml`,
  `package-lock.json`, `yarn.lock`, `bun.lockb`); or non-JS: `pyproject.toml`/`requirements.txt`,
  `go.mod`, `Cargo.toml`, `Gemfile`, `composer.json`.
- **Surfaces (independently-built areas):** `apps/*`, `packages/*`, `services/*`, `cmd/*`, or a single
  root app. For each, detect its framework from its own `package.json`/config:
  backend markers (`adonisrc.ts`, `@adonisjs/*`, `nestjs`, `express`, `fastify`, `django`, `fastapi`,
  `rails`, `.go`), frontend markers (`vite.config.*`, `next.config.*`, `@tanstack/react-router`,
  `angular.json`, `nuxt`, `svelte`), and its test runner (`@japa/*`, `vitest`, `jest`, `playwright`,
  `pytest`, `go test`), linter/formatter (`eslint`, `prettier`, `biome`, `ruff`).
- **Split candidates (sub-surface boundaries):** inside each surface, look for a clean internal partition
  — feature modules (`src/features/*`, `src/modules/*`, `app/(group)/*`), or independent services
  (`services/*`, domain folders). Note the surface's rough size (module/file count) so a *large* surface
  with a *clean* boundary can be proposed as several specialized surfaces in Phase 2. See SCHEMA.md
  §"Specialization — when to split one surface into more agents" for the heuristic. Don't split yet — just
  flag candidates + their would-be shared-code tree.
- **Per-surface commands:** derive `test`/`lint`/`format`/`typecheck`/`build` from each surface's
  `package.json` scripts + the workspace filter syntax (e.g. `pnpm --filter <pkg> test`).
- **Contract mechanism:** a shared types/schema package (`packages/shared-types`, Zod/`z.`),
  an `openapi.*`/`swagger.*` file, `.proto` files, or none.
- **DB / migrations:** migration tooling (`node ace make:migration`, `knex`, `prisma`, `alembic`,
  `golang-migrate`), a `docker-compose.yml`, DB service.
- **Design system:** an existing `design-reference/` snapshot, `components/ui`, a DesignSync MCP
  connection, Figma links, or none.
- **Code retrieval:** is the `serena` CLI resolvable (`command -v serena`)? If not, does
  `~/.local/bin/serena` exist anyway — installed but PATH-broken (see SCHEMA.md §Code retrieval)?
  `graphify`? Is either already registered in this repo's `.mcp.json` or `claude mcp list`? (Feeds
  the retrieval question + Phase 4 wiring — default provider is `serena`.)
- **VCS:** `git remote -v` → host + `owner/repo`; the default branch (`git symbolic-ref refs/remotes/origin/HEAD` or `git branch`).
- **Existing `CLAUDE.md`** — read it; it may already state stack/conventions to fold in. **Existing
  `PIPELINE.md`** — if present, this is a re-run: load it as the starting draft and only reconcile deltas.

Print a compact **Detection Report**: layout, surfaces (with framework + commands), contract, DB,
design, vcs. Mark each field `detected` / `guessed` / `unknown`.
