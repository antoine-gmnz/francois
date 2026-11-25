---
id: token-viewer
feature_id: token-viewer
title: Token viewer — the session's context window, broken down by what fills it
status: frozen
branch: feat/token-viewer
created: 2026-11-25
depends_on: [session-engine, interactive-commands, app-shell, mcp-panel]
reviewed_base:
reviewed_digest:
design_files: []
---

# Token viewer — the session's context window, broken down by what fills it

## 1. Summary

The Claude app shows a **Context** popover: a segmented bar of the window, then one row per
category (Messages, System tools, MCP tools, System prompt, Skills, MCP server instructions,
Custom agents, Memory files) with tokens and share, then the autocompact buffer and free space,
then the deferred tool schemas, then expandable lists (MCP tools · Memory files · Custom agents),
and a freshness footer ("Updated just now. Refreshes at the end of this turn."). Francois today
shows one figure (`134K / 1M`) and a `/context` transcript card of preformatted markdown.

This feature puts that breakdown in the session panel's **Context** tab. The data comes from
Claude Code's `get_context_usage` stdio control request — verified against CLI 2.1.332: a
`claude -p --input-format stream-json --output-format stream-json --verbose [--resume <thread>]`
answers it **without a user message and without an API turn** (fixtures:
`src-tauri/src/session/stream/fixtures/context-usage-{fresh,resumed}.ndjson`).

## 2. Goals & non-goals

**Goals**
- Per-category breakdown of the focused Claude session's context window, in the Context tab.
- Refresh automatically when a turn ends; manual refresh on click; never probe during a live turn.
- Degrade quietly: non-Claude runtimes and older CLIs keep today's single `MeterRow`.

**Non-goals**
- Cumulative consumption over time, cost in currency, per-turn token counts (separate features;
  `provider-usage-metrics` owns cross-runtime counters).
- Plan limits — that is `usage-bar`.
- Acting on rows (detaching an MCP server, deleting a memory file). The rows are read-only.
- The `/context` transcript card — unchanged.
- The CLI's 10×10 `gridRows` — not carried.

## 3. User stories / flows

1. User opens the Context tab (`]` panel, Context) on an idle Claude session. Within ~2 s the
   breakdown fills in under a `CONTEXT` label; before that the section shows a one-line
   "Measuring context…" placeholder at the final height of the header row (no jump of the rest).
2. User sends a message. While the turn runs the breakdown stays as it was, the footer reads
   "Updated 3 min ago · refreshes when this turn ends". When the session goes idle the core
   probes once and the figures update.
3. User clicks the header figure (`191.5K / 1M`) → forced refresh (spinner-free: the footer reads
   "Measuring…" until the answer lands).
4. User clicks `▸ MCP tools  239` → the row expands to the tools grouped by server, each with its
   tokens; deferred tools are faint with a `deferred` note. Same for Memory files (path leaf,
   full path on hover, type) and Custom agents (agentType, source). Expansion is per-list,
   in-memory, reset when the focused session changes.
5. On a Codex/Grok/OpenAI session the Context tab footer shows today's `MeterRow` and no breakdown.

## 4. Functional requirements

**Core (`src-tauri/src/session/context_breakdown.rs`, new module; register the command)**

- FR-1 `session_context_breakdown({ sessionId, refresh? })` → `Result<ContextBreakdownResponse>`
  (`contract/token-viewer.ts`). Unknown session → `SESSION_NOT_FOUND`.
- FR-2 Non-Claude `agent_runtime` → `CONTEXT_BREAKDOWN_UNAVAILABLE`, message
  "Context breakdown is only available for Claude Code sessions."
- FR-3 **Never probe while a turn is live** (status running / awaiting approval / question, or any
  child owning the session's stdin). Return the cache with `stale: true` (or `breakdown: null`).
- FR-4 Cache per session (in-memory, not persisted): `{ breakdown, measuredAt }`. A cached value is
  **fresh** iff `measuredAt` is after the session's last turn end and after the last model change.
  `refresh: false` + fresh cache → return it without probing. Otherwise probe.
- FR-5 Probe: spawn through the same path `usage_probe.rs` uses (account config dir, session
  runtime incl. WSL, session cwd, login-shell PATH via `process_util`):
  `claude -p --input-format stream-json --output-format stream-json --verbose --model <model>`
  plus `--resume <claude_session_id>` iff the session has one. **No permission flags, no prompt.**
  Write one line
  `{"type":"control_request","request_id":"<uuid>","request":{"subtype":"get_context_usage"}}`,
  read stdout lines until the `control_response` whose `response.request_id` matches, then close
  stdin and kill/reap the child. Other lines (hooks, system) are ignored.
- FR-6 Watchdog 20 s → kill, `CONTEXT_BREAKDOWN_UNAVAILABLE` "Timed out measuring context."
  `response.subtype == "error"` → `CONTEXT_BREAKDOWN_UNAVAILABLE` "This Claude Code version cannot
  report a context breakdown — update Claude Code." Child exits before answering / spawn fails →
  `CONTEXT_BREAKDOWN_UNAVAILABLE` with a short reason. A failed probe leaves the previous cache
  intact.
- FR-7 Single flight per session: a second call while a probe runs waits for that probe's result
  (or returns the cache with `stale: true` — implementer's choice, documented); never two children.
  The probe never touches session status, queue, `claude_session_id`, or `contextUsedTokens`.
- FR-8 Parse leniently (pure fn, unit-tested against both fixtures): `categories[]` →
  `ContextCategory` (drop rows whose `kind` is not one of the four; `id` null if absent;
  `isDeferred: true` with no `kind` → `deferred`); `mcpTools`, `memoryFiles`, `agents`,
  `skills.skillFrontmatter` default to `[]`; missing numbers → reject only if `maxTokens` is
  missing/zero or `categories` is absent (→ `CONTEXT_BREAKDOWN_UNAVAILABLE` "Unexpected context
  report."). `autoCompactThreshold` null when `isAutoCompactEnabled` is false.
- FR-9 `stale` = cache exists and (a turn is live, or a turn ended / model changed after
  `measuredAt`).
- FR-10 Add `CONTEXT_BREAKDOWN_UNAVAILABLE` to `contract/error-code.ts` and the Rust `ErrorCode`
  mirror. Serde structs mirror `contract/token-viewer.ts` (camelCase) with round-trip tests.
- FR-11 `fake-claude.cjs` answers `get_context_usage` with the resumed fixture's response (so
  product tests can drive the probe), and an env/arg switch to answer `error` instead.

**Frontend (`src/features/context/` new feature folder; wire into `ContextSection`)**

- FR-12 `sessionContextBreakdown(sessionId, refresh?)` in `src/lib/api.ts`.
- FR-13 Hook `useContextBreakdown(session)`: fetch on mount and on session change; refetch with
  `refresh: false` when the session's status transitions into idle from a live status; expose
  `{ data, error, loading, refresh }`. Drop answers for a session that is no longer focused.
- FR-14 Pure helpers (`context-breakdown.ts`, vitest): row ordering & grouping
  (in-window rows sorted by tokens desc · then buffer, free · then deferred), share =
  tokens / maxTokens formatted `12.4 %`-style per locale-independent `x.y%`, deferred rows show
  `—` for share, compact token labels (`123.8K`, `1M`, `85`) reusing the existing formatter if
  one exists (`src/lib` — look before writing), category → colour-class mapping by `id`
  (unknown id → neutral), MCP tools grouped by server with per-server totals, path leaf.
- FR-15 `ContextBreakdown.tsx` renders in the Context tab **above** the MCP servers block:
  header (`CONTEXT` label, `19% used`, `191.5K / 1M` clickable → refresh), segmented bar
  (one segment per in-window row + buffer; free is the track), the category rows, a spacer,
  buffer + free rows, a spacer, deferred rows, then the three expandable lists (only those with
  ≥1 entry), then the footer.
- FR-16 Footer copy: `Updated just now` / `Updated N min ago` (re-rendered by the existing
  elapsed-clock hook), `· refreshes when this turn ends` while a turn is live, `Measuring…`
  while loading. Error → the message in faint text with a `Retry` link; the last good
  breakdown, if any, stays rendered above it.
- FR-17 When the session's runtime is not Claude, or the call returned
  `CONTEXT_BREAKDOWN_UNAVAILABLE` with no breakdown ever loaded, render nothing (the existing
  footer `MeterRow` remains). When a breakdown is shown, the footer `MeterRow` is hidden
  (no duplicate figure).

## 5. API contract

`contract/token-viewer.ts` (canonical — do not restate here). Error code added to
`contract/error-code.ts`: `'CONTEXT_BREAKDOWN_UNAVAILABLE' // token-viewer: probe failed,
timed out, CLI refused get_context_usage, or non-Claude runtime`.

Wire (CLI, verified 2.1.332): request
`{"type":"control_request","request_id":ID,"request":{"subtype":"get_context_usage"}}` (optional
`"detail":"summary"|"full"`; omit it). Reply
`{"type":"control_response","response":{"subtype":"success","request_id":ID,"response":{…}}}`.

## 6. Data & state

- Core: per-session in-memory cache + single-flight slot; last-turn-end and last-model-change
  timestamps (reuse existing fields if the session already records them). Not persisted — a
  restored session measures on first open.
- Frontend: hook-local state only; expansion state component-local. No store.

## 7. Edge cases & errors

| Case | Behaviour |
|---|---|
| Fresh session, never sent a message | Probe without `--resume`; shows the baseline (system prompt, tools, skills…) |
| Turn live, no cache | `breakdown: null, stale: true` → placeholder "Measured when this turn ends" |
| Old CLI (`error` reply) | FR-6 message; FR-17 fallback if nothing was ever loaded |
| WSL session | Same spawn path as usage probe; memory-file paths are WSL paths, shown verbatim |
| Hooks print lines before answering | Ignored (FR-5) |
| `maxTokens` 0/absent | `CONTEXT_BREAKDOWN_UNAVAILABLE` "Unexpected context report." |
| Session deleted mid-probe | Probe result discarded; child killed |
| Unknown category id | Neutral colour, CLI `name` verbatim |

## 8. Design brief

Graphite & Signal; colour here is **categorical**, not state, so it lives in
`src/features/context/context.css` as category classes built from existing tokens (never the
`--state-*` tokens, which mean state): messages `--hue-blue`, system_tools `--hue-purple`, mcp_tools `--hue-teal`,
system_prompt `--hue-slate`, skills/agents/memory/mcp_instructions `--text-faint`,
buffer `--bg-strong`, free = bar track `--bg-selected`, deferred rows: dot `--bg-strong`, text
`--text-faint`. Rows: 8px square dot, name (Geist, `--text-secondary`, truncates), tokens and
share right-aligned in Geist Mono (`--text-muted`), share in `--text-primary`. Header figure in
Geist Mono. Bar 4px tall, 1px gaps between segments, radius 2px, segment widths via inline
`style` (runtime-computed — allowed). Expandable lists use the `▸`/`▾` caret, count right-aligned
faint. Compose with `src/ui/SidePanel.tsx` primitives (`SidePanelLabel`, rows in the
`context-row` rhythm already used by `ContextSection`). No new Figma frame exists; match the
Claude app screenshot's structure in this identity, both themes.

## 9. Acceptance criteria

- [ ] Context tab on an idle Claude session shows the category rows with tokens + share summing
      (in-window + buffer + free) to the window (FR-14/15).
- [ ] Deferred rows show `—` for share and are visually subordinate (FR-14).
- [ ] After a turn ends the figures refresh without user action; during a turn no probe spawns
      (FR-3/13) — covered by a core test that a live session returns the cache with `stale`.
- [ ] Clicking the header figure forces a probe (FR-15).
- [ ] MCP tools / Memory files / Custom agents expand and list their entries (FR-15).
- [ ] Old CLI / timeout / non-Claude → readable message or the legacy MeterRow, never a crash
      (FR-6/17).
- [ ] Parser unit-tested on both fixtures, incl. a drifted payload (FR-8); serde round-trip (FR-10).
- [ ] `npm test`, `npx tsc --noEmit`, `npx eslint .`, `cargo test`, `cargo clippy --all-targets`
      green.

## Remediation

(Empty until a review returns findings.)
