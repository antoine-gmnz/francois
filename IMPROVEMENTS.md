# Improvements backlog

Audit of 2026-11-25 on `feat/codex-transcript-parity` (CLI 2.1.331). Static read only — no suites
were run. **V** = verified by reading the code, **I** = inferred from grep/counts, check before acting.
Excludes what `PIPELINE.md` already tracks (hook deps, oversized files, cross-feature imports,
`large_enum_variant`).

Tick items as they land; delete this file when it is empty.

## Status — 2026-11-25 (after #203 and #204)

Done: R1, R2, R4, X1, C1, C2, C4, S2–S5. Partly done: **S1**. Everything else is open.

Hand-off notes for the next session:
- **C1 follow-up** — on CLI 2.1.331 every captured `thinking` block arrives with **empty text**
  (thinking display is omitted by default); empty blocks are dropped, so today only a transient
  "Thinking…" row shows. Find the setting that makes the CLI emit summaries (no `--help` flag;
  likely a `settings.json` key) and pass it per session, then check the collapsed block renders.
- **C4 follow-up** — `api_retry` / `compact_boundary` parsers are tested on synthetic lines only;
  capture a real one into a fixture. Retry state uses the legacy `--warn` token — confirm the tone
  against the redesign.
- **R2 follow-up** — Codex has no "known but ignored" list, so routine methods
  (`item/userMessage`, …) each log once per process; add an allow-list if the log gets noisy.
- **S1 remainder** — statuses left unchanged because the evidence was ambiguous: `process-*` (10),
  `claude-process-adapter`, `codex-process-adapter`, `legacy-runtime-scope` (landed in #145 but
  "No release is claimed"); `core-architecture-fixes` / `-wave3` (frozen, but #130 landed waves
  1–3); `session-brake` (text says shipped, no code cites it); `multi-provider-codex`,
  `codex-model-catalog`, `codex-interactive-session`.
- **Size** — `src/features/conversation/conversation-blocks.ts` is at 999/1000 lines; split it
  before the next feature touches it.
- **Not visually checked** — thinking disclosure, retry header/roster line, compaction divider,
  Context-tab Models section. Run the demo (`VITE_FRANCOIS_DEMO=1`) before trusting the layout.
- **Elsewhere** — C3 (plan tab) is in flight in `feat/plan-view-during-transcript` /
  `feat/long-session-stability`; image rendering in `feat/image-viewer`. Don't redo here.
- **Needs a human** — H1/H2 are destructive (shared stash stack); U1–U4 are product decisions.
- **Suggested next wave** — S-sized: R5, P2, R7 (verify), R3 triage, X2, D2. Then C3 once its
  branch merges, then C5. Core agents share one crate: serialise cargo
  (`specs/reports/cargo-locked.sh`, gitignored — recreate if gone), max 2–3 at once.

## 1. Areas to improve

### Robustness

- [x] **R1 · No React error boundary** *[done in #203]* — a render throw blanks the whole webview. No
  `ErrorBoundary` / `componentDidCatch` anywhere in `src/`. Add one per pane (shell, transcript,
  session panel) so one broken block does not take the fleet view down. **V** · S
- [x] **R2 · Unknown stream events are dropped silently** *[done (Claude in #203; Codex native + Grok in #204)]* — `src-tauri/src/session/stream/mod.rs:232`
  (`_ => {}`), same in `adapter/codex/.../translate.rs:453` and `grok/translate.rs:281`. A CLI
  upgrade that adds an event type is invisible. Log once per unknown type to diagnostics + a
  counter. **V** · S
- [ ] **R3 · Swallowed failures in the frontend** — 30 `.catch(() => {})` sites
  (`src/app/App.tsx:243`, `src/app/useAppIdentity.ts:26,41,51`,
  `src/features/accounts/AccountLoginTerminal.tsx:76`, …) and 19 `if (!r.ok) return`. Triage:
  which are legitimately best-effort, which should reach `useTimedError` / a toast. **V** count, **I** severity · M
- [x] **R4 · Poisoned `sessions` mutex** *[done in #203 (`Engine::sessions_guard()`)]* (review F9, partial) — 6 direct
  `sessions.lock().unwrap()` left in `src-tauri/src/session/mod.rs:1498,1509,1527,1593,1626,1646`;
  `with_session_mut` is not poison-tolerant. `kill_all` (1646) runs at exit, so a poisoned lock
  skips child cleanup. **V** · S
- [ ] **R5 · OpenAI runner unwraps** — `src-tauri/src/session/adapter/openai/runner.rs:177-326`
  (`.lock().unwrap()`), `:352,356` (`.expect`), `:612`. **V** · S
- [ ] **R6 · OpenAI `Bash` tool ignores WSL on Windows** — runs `cmd.exe /C`;
  `src-tauri/src/session/adapter/openai/tools.rs:395-404` (the only real TODO in the core). **V** · M
- [ ] **R7 · Child cleanup on crash, non-Windows** — Windows job objects exist
  (`process_util/supervision.rs:303`) and the Claude/Codex adapters use them; confirm macOS/Linux
  have an equivalent (process group / `PDEATHSIG`) and that shell PTYs, remote-control and
  extension providers go through the same supervision. **I** · S to verify

### Performance

- [ ] **P1 · No transcript virtualization** — no windowing library or `content-visibility` in
  `src/`; long sessions render every block. See also the in-review `transcript-scale` spec. **V** absence, **I** impact · M
- [ ] **P2 · `load_persisted` still synchronous in `.setup()`** (review F4, partial) —
  `src-tauri/src/main.rs:105`. Transcripts already hydrate off-thread; the session index does not. **V** · S

### Architecture (core)

- [ ] **A1 · `session/` is still ~56% of the core** (61k of ~109k lines) and sits in 3 of the 5
  remaining cycles — `scripts/quality/cycle-baseline.json`: `diff<->session`,
  `permissions<->session`, `project<->session`, `session<->usage`, `account<->project`. 110
  `crate::account` references from `session/`; 110 files use `use super::*`. Review F1 — the only
  finding from `ARCHITECTURE-REVIEW-CORE.md` still fully open (F2, F3, F5–F8, F10–F12 are fixed). **V** · L

### Accessibility

- [x] **X1 · `src/ui/Modal.tsx` has no `role`, `aria-modal` or focus trap** *[done in #203]* — `aria-modal`
  appears 0 times in `src/`; only 7 ad-hoc `role="dialog"`. Fix in the primitive, every modal
  inherits it. **V** · S
- [ ] **X2 · 37 clickable `<div>`/`<span>` without `role`** — e.g.
  `src/features/agents/AgentsListBody.tsx:132`, `agents/ActivitySection.tsx:161`,
  `accounts/CredentialCard.tsx:139,270`, `src/app/SplitPane.tsx:401`,
  `conversation/Composer.tsx:210`. Some may have keyboard handlers elsewhere. **I** · M

### Design system

- [ ] **D1 · Redesign conversion incomplete** — 58 CSS files still use pre-redesign aliases
  (`--text-dim`, `--bg-panel`, `--border*`, `--accent`, …). Heaviest: `conversation.css` (141
  lines), `extensions.css` (97), `accounts.css` (56), `mcp.css` (55), `sidebar.css` (51),
  `pulls.css` (48), `workflow-detail.css` (40). Naming debt, not a visual bug — the aliases
  theme. **V** · M
- [ ] **D2 · 61 inline `style={{}}`** against the per-feature-CSS rule — `MarkdownView.tsx` (10),
  `App.tsx` (7), `AgentsListBody.tsx` (5), `McpPanel.tsx` (4), `Block.tsx` (4). Some are
  legitimately runtime-computed. **V** count · S
- [ ] **D3 · Shell not tuned for the 720px min width** — only `src/app/app-bar.css:225,231` has
  tiers (1120/840). Roster defaults to 282px; fixed widths in `github.css`, `cohorte-run.css`,
  `split-pane.css:242`; session panel unchecked. Needs a real resize pass. **I** · M

### Testing

- [ ] **T1 · No component/DOM tests and no e2e** — no testing-library, jsdom, tauri-driver or
  WebDriver in `package.json`, `vite.config.ts` or `.github/`. `PIPELINE.md` §Stack claims
  `tauri-driver` e2e: either wire a smoke test (launch → new session against the `src/demo/`
  fleet → transcript renders) or drop the claim. **V** · M
- [ ] **T2 · Thin feature coverage** (test files / source files) — `projects` 2/14, `workflows`
  2/9, `mcp` 3/11, `github` 7/27. Stores in `src/lib` are fine (51/56). **V** · M

## 2. Parts that need more work

### Unfinished features

- [ ] **U1 · `multi-provider-codex`** — in-review / in-progress, active on this branch. Finish
  and settle its status. **V**
- [ ] **U2 · 13 `provider-*` drafts not started** — agent-control, agent-observation,
  capability-parity, effective-capabilities, input-parity, mcp-runtime, model-catalogs,
  remote-continuity, session-continuity, settings-parity, tool-parity, usage-metrics,
  workflow-runtime. No contract, no commits. Decide: build, merge into fewer specs, or drop. **V**
- [ ] **U3 · `capability-registry`, `codex-interactive-session`, `grok-interactive-session`** —
  drafts, not started. **V**
- [ ] **U4 · In-review with no contract** — `codex-model-catalog`, `legacy-runtime-scope`,
  `process-runtime-decisions`, `transcript-scale`. State unclear. **V**

### Spec and doc drift

- [ ] **S1 · ~33 specs have stale statuses** — built but still `frozen`: the 11 `process-*` /
  `*-process-adapter` specs (shipped by `e5753e8b`), `app-shell`, `cli-companion`,
  `fix-agent-view`, `split-by-4`, `cohorte-integration`, `github-page`, `github-ci-logs`,
  `core-architecture-fixes`, `core-architecture-wave3`. One reconciliation pass. **I** per spec
- [x] **S2 · Pi is retired but still documented** *[done in #204 (retired-data compat code kept on purpose; `contract/pi-models-metrics.ts` still imported)]* — ~10 `pi-*` specs + contracts still
  `frozen`/`in-review`; README "Pi runtime (gated)" section (~lines 120–155) describes a runtime
  that no longer exists. Mark superseded, delete the README section and dead contracts. **V**
- [x] **S3 · `PIPELINE.md` feature map** *[done in #204]* — 33 non-shipped specs have no row (all `pi-*`,
  `process-*`, `provider-*`, `codex-*`, `github-*`, …); `multi-provider-codex` tagged in-progress
  vs spec in-review. **V**
- [x] **S4 · `ARCHITECTURE-REVIEW-CORE.md`** *[done in #204 (open F1/F4/F9 now in CONVENTIONS.md §Known backlog)]* — nothing references it and 10 of its 12 findings
  are fixed. Fold the open ones (A1, R4, P2 here) somewhere live and remove it. **V**
- [x] **S5 · Docs coverage** *[done in #204 (Cohorte left out: retired in #197)]* — check `docs/guide/accounts.md` covers Codex and endpoint
  accounts, and that README mentions GitHub and Cohorte. **I**

### Repo hygiene

- [ ] **H1 · 18 stashes**, oldest from the v0.17 era — review and drop. **V** count
- [ ] **H2 · 161 branches not merged into `main`** — mostly squash-merged leftovers; prune. **I**

## 3. Claude Code features to implement

Checked against `claude --help` (2.1.331), the changelog, the SDK docs and the repo's own captured
`session/stream/fixtures/turn.ndjson`. Paths under `src-tauri/src/` unless noted. Ranked by value.

- [x] **C1 · Thinking blocks** *[done in #204; see hand-off note on empty thinking text]* — the CLI streams `thinking` / `thinking_delta` blocks (present in
  the fixture); `session/stream/blocks.rs:68` drops them (`_ => {} // thinking etc. — ignored`).
  Render as a collapsed block in the transcript. **V** · high · S
- [x] **C2 · Per-turn cost and per-model usage** *[done (cost in #203, `modelUsage` → Context tab "Models" in #204)]* — the `result` event carries `total_cost_usd`
  and `modelUsage`; neither is read anywhere (`session/stream/lines.rs:116` takes only `usage`).
  Free data for the session panel / roster / overview totals. **V** · high · S
- [ ] **C3 · Plan mode: approval card + todo list** — no `ExitPlanMode` handling; `TodoWrite` is
  only an activity label (`src/features/sessions/activity.ts:31`). The `plan` session-panel tab id
  is reserved (`src/lib/sessionPanelStore.ts:12`) but not registered
  (`src/app/session-panel/sections.ts:58-62`) — the redesign already drew this tab. Unknown:
  whether `ExitPlanMode` currently lands on the generic permission card. **V** · high · M
- [x] **C4 · Retry / rate-limit / compaction notices** *[done (parse in #203, UI in #204); `rate_limit_event` deliberately ignored]* — `system/api_retry`, `rate_limit_event`,
  `compact_boundary` are dropped (non-init system lines return early at
  `session/stream/lines.rs:29`). A session stuck retrying looks identical to one working. Pairs
  with R2. **V** · med · S
- [ ] **C5 · Graceful interrupt + mid-turn steering** — Stop tree-kills the process
  (`session/adapter/claude_code.rs:210-218`), which per the headless docs records no result; sends
  queue FIFO (`session/commands/turn.rs:37`). Use the control-channel interrupt and allow a
  message to steer a running turn. **V** · high · L
- [ ] **C6 · Rewind / file checkpoints** — `/rewind` and SDK `rewindFiles()` /
  `enableFileCheckpointing`; nothing in Francois. Wire subtype name unconfirmed — spike first. **I** · high · L
- [ ] **C7 · Hooks** — `--include-hook-events` is never passed, hook events are dropped,
  `hook_callback` is refused (`session/control.rs:116-119`). Step 1: show hook runs in the
  transcript; step 2: a viewer over configured hooks next to the permission rules editor. **V** · med · M
- [ ] **C8 · Fork session** — `--fork-session` exists; no match in Francois. "Branch this
  session" from the roster menu, natural with worktrees. **V** · med · M
- [ ] **C9 · Claude Code plugins + marketplaces** — `claude plugin install|list|enable|disable|marketplace`;
  Francois only toggles enablement via skills (`session/skills.rs:16-19`). **V** · med · M
- [ ] **C10 · Memory viewer/editor** — CLAUDE.md is read-only in
  `src/features/mcp/ContextSection.tsx`; auto-memory (`MEMORY.md`) is not surfaced at all. **V** · med · M
- [ ] **C11 · MCP OAuth login + elicitation** — `claude mcp login` exists; every MCP status other
  than connected/failed folds to "connecting" (`session/stream/lines.rs:350-354`), so a
  needs-auth server just spins. **I** · med · M
- [ ] **C12 · First-class UI for `--add-dir`, `--agents`, `--settings`** — today only reachable
  as raw profile argv (`profiles/parse.rs:205`); no `.claude/agents` editor found. **I** · low · M

Smaller, no match in Francois: `--max-budget-usd` (per-session budget cap — cheap once C2 lands),
`--prompt-suggestions`, `--forward-subagent-text`, `--json-schema`, fast mode, scheduled tasks,
sandbox settings, agent teams.

Deliberately out: permission modes `auto` / `dontAsk` (`contract/common.ts:170-174` explains why).

Not verified either way: image/PDF tool-result rendering, web search/fetch result rendering, MCP
resources/prompts.

## Suggested order

1. Quick wins, all S: **C1, C2, C4, R1, R2, X1, R4**.
2. Housekeeping in one pass: **S1–S4, H1–H2**.
3. **C3** (plan tab — already in the mockups), then **C5**.
4. **P1** + `transcript-scale`, **T1**.
5. Decide **U2** before starting **A1** — the provider roadmap sets how `session/` should split.
