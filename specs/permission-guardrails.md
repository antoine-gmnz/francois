---
id: permission-guardrails
title: Permission guardrails — approve tool calls in-app, remember them as real Claude rules
status: frozen
created: 2026-07-24
depends_on: [session-engine, conversation-view, session-questions, command-palette]
---

# Permission guardrails — approve tool calls in-app, remember them as real Claude rules

## 1. Summary

Francois already receives a `can_use_tool` control request for every gated tool call (the stdio
control channel turned on by `session-questions`) and **throws it away**: `session-questions` FR-8
answers every non-`AskUserQuestion` ask with a blanket deny, auto-approving only direct `git`/`gh`
Bash calls when the session was created with `allowGit`. The session's only trust dials are
therefore `default`, `acceptEdits`, `plan` and `bypassPermissions` — nothing between "ask my
`~/.claude` settings about everything" and full YOLO.

This feature replaces the blanket deny with a **live approval card**. A gated call parks the turn
(the same machinery question cards use), renders the tool name, the actual input and the cwd, and
offers four actions: **Allow once · Deny once · Always allow · Always deny**. The "always" actions
write a **real rule into Claude Code's own `settings.json`** (`permissions.allow` /
`permissions.deny`), defaulting to the project-local `.claude/settings.local.json` with a per-rule
promotion to global `~/.claude/settings.json`.

The design pivot: because the rules land in Claude's own settings, **Claude enforces them upstream
of the control channel**. Once a rule exists, matching calls are decided by the CLI and never reach
Francois's card at all. The approval queue only ever shows *un-ruled* asks and quiets as the ruleset
matures. Francois is a GUI front-end for Claude Code's native permission system, not a parallel one.

A **rules editor** (command palette → "Manage permissions") is where users go to see what they have
trusted: it lists rules across both tiers and can toggle, delete, or re-tier each one.

## 2. Goals & non-goals

**Goals**

- Turn every gated `can_use_tool` request into a parked, rendered, answerable approval card in the
  SESSION transcript — replacing `session-questions` FR-8's blanket deny.
- "Always allow" / "Always deny" persist as genuine Claude Code permission rules via a **surgical
  merge**: read the settings file, touch only `permissions.allow` / `permissions.deny`, preserve
  every other key (`env`, `hooks`, `model`, `mcpServers`, unknown future keys) byte-for-byte in
  value, write back atomically.
- Generate a sensible, human-labelled Claude pattern from the actual call (`Bash(git commit:*)` —
  "git commit (any arguments) · this project").
- A rules editor that lists, toggles, deletes and re-tiers rules across the local and global tiers.
- Default to the **local** tier so a trust decision made in one repo never leaks to another.
- Exactly-once resolution per ask, hydration through remount, and cancellation when the turn dies —
  identical guarantees to `session-questions`.

**Non-goals**

- **Audit log / history panel.** We intercept every call and could record them; nobody asked to
  review history. Separate feature.
- **Watching `settings.json` for external edits.** v1 is read-on-open (the editor re-reads every
  time it opens, and every mutation returns a freshly-read list). File watching is later.
- **Hand-authoring arbitrary glob patterns.** v1 generates patterns from real calls only; a
  raw-pattern authoring UI is a power-user editor, deferred.
- **A Francois-owned safe-list** distinct from Claude's. Cards stay rare because Claude's own
  defaults already auto-allow read-only tools and because the ruleset matures — we add no second
  policy engine.
- **Multi-session / fleet triage** of pending approvals. Cards live in their session's transcript.
- **The `ask` effect.** Claude's `permissions.ask` is *read* and *displayed* by the editor (and can
  be toggled/deleted/re-tiered) but Francois never *writes* one — an ask rule is what the card
  already is.
- **`permissions.defaultMode` / `additionalDirectories` / any other settings key.** Read never,
  written never.
- **Plan-mode approval** (`ExitPlanMode`). It arrives as an ordinary `can_use_tool` and therefore
  gets an ordinary card — but no plan-specific rendering. `plan-approval` remains a future feature.

## 3. User stories / flows

1. **Walk-away run.** The user sends a task and leaves. Claude calls `Bash(npm test)`; the turn
   parks and a card appears: `PERMISSION · Bash`, the command, the cwd, four actions. The session
   stays `running` (spinner honest — the turn *is* in flight). The user returns, clicks **Always
   allow**, and the turn resumes. `.claude/settings.local.json` now contains
   `permissions.allow: ["Bash(npm test:*)"]`. Every later `npm test …` in this repo is decided by
   Claude itself and never produces a card again.
2. **Deny once.** Claude proposes `Bash(rm -rf build)`. The user clicks **Deny once**; Claude
   receives the denial text and adapts. No rule is written; the next `rm -rf` asks again.
3. **Promote to global.** The user is about to click **Always allow** on `gh pr view` and first
   flips the card's tier control from `this project` to `all projects`. The rule lands in
   `~/.claude/settings.json` instead.
4. **See what I've trusted.** ⌘K → "Manage permissions". A modal lists every rule from
   `.claude/settings.local.json` and `~/.claude/settings.json`, grouped by effect, each with its
   human label, its raw pattern, its tier and an enable toggle. The user disables
   `Bash(git push:*)`, deletes `WebFetch(domain:example.com)`, and demotes a global rule back to
   local. Each action rewrites the affected files surgically and the list re-reads from disk.
5. **Typed message while parked.** The composer stays usable; a typed message queues (existing
   running-turn semantics). Placeholder reads
   `approve or deny the request above — typed messages will queue`.
6. **Interrupt while parked.** ⌃C kills the child; the card flips to `cancelled` (inert, dimmed) and
   stays in the transcript.
7. **Someone else edited settings.json.** The user hand-edited `~/.claude/settings.json` between app
   launches, or `claude` itself wrote a rule. The editor's read-on-open shows the current truth; any
   Francois write merges into whatever is on disk at that moment and preserves the rest of the file.
8. **allowGit session.** A session created with `allowGit` still auto-approves a direct `git`/`gh`
   Bash call with no card (pre-feature parity) — that fast path is evaluated *before* parking.
9. **bypassPermissions / acceptEdits.** Nothing changes: those modes decide upstream in the CLI, so
   no `can_use_tool` arrives (or only the un-bypassed subset does) and no card appears.

## 4. Functional requirements

**Parking the ask (core)**

- **FR-1**: `decide_control_request` gains a third outcome. Precedence, unchanged at the top:
  (a) subtype ≠ `can_use_tool` → error response (`session-questions` FR-9);
  (b) `tool_name == "AskUserQuestion"` → the question path (FR-6/FR-7 of `session-questions`);
  (c) `allow_git && tool_name == "Bash" && is_git_command(input)` → instant allow (unchanged);
  (d) **everything else → park a permission ask** (was: blanket deny).
- **FR-2**: parking mints a `blockId`, records `{requestId, toolName, input}` in the turn's
  `pending_permissions` map keyed by `blockId`, buffers + persists a `permission` block in state
  `pending`, and emits `permission.asked` carrying the `PermissionAsk` (§5.2). Multiple asks may be
  parked concurrently, each with its own card.
- **FR-3**: the `PermissionAsk` is derived purely from `(tool_name, input, cwd)` — see FR-4/FR-5.
  The raw `input` is echoed verbatim as `updatedInput` on an allow response; Francois never rewrites
  a tool's input.
- **FR-4** (**input summary**): `summary` is a one-line human rendering of the call —
  `Bash` → `input.command`; `Read`/`Edit`/`Write`/`MultiEdit`/`NotebookEdit` → `file_path` (or
  `notebook_path`); `Glob`/`Grep`/`LS` → `path`; `WebFetch` → `url`; `WebSearch` → `query`;
  anything else → `''`. `inputJson` is the whole input pretty-printed (2-space) and truncated to
  4000 chars with a `…` marker; it is what the card shows in its monospace box.
- **FR-5** (**pattern generation**), pure and unit-tested. `(tool, input, cwd)` → `(pattern, label)`:

  | tool | condition | pattern | label |
  |---|---|---|---|
  | `Bash` | `command` contains any shell metacharacter (below) | `Bash(<command verbatim>)`, or bare `Bash` when that form would be ambiguous | `run exactly this command` / `any Bash call` |
  | `Bash` | otherwise | `Bash(<prefix>:*)` | `<prefix> (any arguments)` |
  | `Read`/`Edit`/`Write`/`MultiEdit`/`NotebookEdit`/`Glob`/`Grep`/`LS` | a path key is present | `<Tool>(<path>)` | `<tool verb> <path>` |
  | `WebFetch` | `url` parses to a host | `WebFetch(domain:<host>)` | `fetch from <host>` |
  | `mcp__<server>__<tool>` | — | the tool name verbatim | `<tool> on the <server> MCP server` |
  | `mcp__<server>` | — | the tool name verbatim | `any tool on the <server> MCP server` |
  | anything else / missing key | — | `<Tool>` (bare) | `any <Tool> call` |

  `<prefix>` is the command's first whitespace token, extended with the second token when the first
  is a known subcommand-style program (`git gh npm npx pnpm yarn cargo docker kubectl go make uv
  pip pip3 poetry dotnet bundle rails terraform aws gcloud brew apt apt-get systemctl python
  python3 node deno bun`) **and** the second token does not start with `-`. `<path>` is expressed
  relative to the session cwd with `/` separators when the path is inside the cwd, otherwise
  verbatim with `/` separators (best-effort — an out-of-cwd absolute path is a weak rule, and the
  card shows the pattern before the user commits to it).

- **FR-5a** (**the shell metacharacter set**, amended Round 1): a `Bash` command containing any of
  `& | ; ` `` ` `` ` $ > < ( ) { } # !` , CR or LF takes the exact-command form. These are **single
  characters** on purpose — the original pair-based list (`&&`, `||`, `$(`) let a bare `&` through
  the *prefix* branch, so `npm test & rm -rf ~` generated `Bash(npm test:*)` labelled "npm test (any
  arguments)" and every later `npm test & <payload>` was then auto-approved by the CLI with no card.
  Over-inclusion here only ever makes a rule **narrower**, so the set errs wide.
- **FR-5b** (**the exact form's two escapes**, amended Round 1): a command that **ends in `:*`**
  would be re-read by Claude as a *prefix* rule (the exact-pin branch silently handing out a
  wildcard), and one containing `)` makes the pattern's closing paren ambiguous. Both degrade to the
  bare `Bash` pattern, whose label reads `any Bash call` — deliberately a rule the user is likely to
  refuse. Failing toward something obviously too broad is safe; failing toward something that *looks*
  narrow while granting more is not.
- **FR-5c** (**URL hosts**, amended Round 1): `\` is a path delimiter for host extraction — WHATWG
  URL parsing treats it as `/` in a special scheme, so `https://evil.com\@good.com/x` fetches
  **evil.com**. A host still containing `\ @ [ ] /` or whitespace after parsing yields no domain
  pattern (bare `WebFetch`) rather than a guess.

**Deciding (core)**

- **FR-6**: `francois:permissions:decide` (§5.1) takes `{sessionId, blockId, decision, tier?}`.
  `decision ∈ {allowOnce, denyOnce, allowAlways, denyAlways}`; `tier ∈ {local, global}` defaults to
  `local` and is ignored by the `*Once` decisions.
- **FR-7** (**write-first ordering**): for an `*Always` decision the rule is written to the settings
  file **before** the pending entry is claimed. A write failure resolves `SETTINGS_WRITE_FAILED`,
  claims nothing, decides nothing, writes no control_response — the card stays `pending` and the
  user can retry or fall back to a once-decision. Nothing half-applies.
- **FR-8**: after the rule write (or immediately, for a `*Once` decision) the pending entry is
  **claimed** (removed from the map — the exactly-once guarantee), the matching control_response is
  written to the child's stdin (`allow` echoes `updatedInput` verbatim; `deny` carries the FR-12
  message), the block resolves to `allowed`/`denied`, `permission.resolved` is emitted once, and the
  command resolves `ok`.
- **FR-9**: a stdin write failure (child died between park and decision) resolves the block
  `cancelled` and returns `PERMISSION_NOT_PENDING`. An unknown/already-resolved `blockId`, or a
  session with no turn in flight, returns `PERMISSION_NOT_PENDING`. An unknown session returns
  `SESSION_NOT_FOUND`. An unparseable `decision` returns `INVALID_INPUT`.
- **FR-10**: every parked ask resolves **exactly once** — `allowed`/`denied` via FR-8, or
  `cancelled` via a matching `control_cancel_request`, turn end (result, child death, interrupt,
  error) or app-exit teardown. The `cancelled` path writes a best-effort deny for a live child and
  nothing for a dead one. Both the reader-thread drain and `kill_all`'s drain cover
  `pending_permissions` exactly as they already cover `pending_questions`.
- **FR-11**: session status is **not** changed by a parked ask — the turn stays `running`.
  Send-while-running queueing is untouched.
- **FR-12**: the deny message written to the CLI is
  `Francois: the user denied this tool call.` — `session-questions`' `PERMISSION_DENY_MSG` and its
  "not supported yet" text are removed.

**Rule storage (core)**

- **FR-13** (**tiers**): `local` → `<session cwd>/.claude/settings.local.json`;
  `global` → `<claude home>/.claude/settings.json`. The claude home is the OS home directory for a
  `native` session and the **WSL home of the session's distro** for a `wsl` session (resolved once
  per distro via `wsl.exe [-d <distro>] -- printenv HOME` and mapped through the existing FR-3 UNC
  root; unresolvable → the global tier is unavailable and a global write resolves
  `SETTINGS_WRITE_FAILED`).
- **FR-14** (**surgical merge**): a write reads the file into a JSON object (missing/empty/
  unparseable → `{}` — an unparseable file is **never** overwritten; the write resolves
  `SETTINGS_WRITE_FAILED` instead), ensures `permissions` is an object, ensures the target effect
  key is an array, appends the pattern iff absent, and writes the whole document back with
  2-space-pretty JSON via temp-file + atomic rename. Every other key and every other entry is
  preserved with its original value. Removal is the same read-modify-write with an array filter; an
  effect array that becomes empty is left as `[]` (not deleted) so the shape stays stable.
- **FR-15** (**disabled rules**): Claude's settings format has no "disabled" concept, so a toggled-
  off rule is **moved out** of `settings.json` into a Francois-owned sidecar next to it —
  `<same dir>/francois-permissions.json`, shape `{ "disabled": [ { "effect", "pattern" } ] }`.
  Toggling on moves it back. Francois is the only writer of the sidecar, so it carries none of the
  three-writer risk. A missing/unparseable sidecar reads as empty.
- **FR-16** (**rule identity**): `id = "<tier>|<effect>|<pattern>"`. It is derived, never stored, and
  stable across reads — the editor's mutations address rules by it.

**Rules editor (core commands)**

- **FR-17**: `francois:permissions:list` reads both tiers fresh (settings + sidecar) and returns
  `PermissionRule[]` — enabled rules from `permissions.{allow,deny,ask}`, disabled rules from the
  sidecars, each with its generated human label (§5.3). Order: `deny` first, then `ask`, then
  `allow`; within an effect, `local` before `global`; within a tier, file order. A missing settings
  file contributes nothing (it is not created by a read).
- **FR-18**: `setEnabled` / `remove` / `setTier` each apply one surgical mutation and **return the
  freshly re-read list** (FR-17), so the editor never shows a stale view.
  `setTier` to the same tier is a no-op that still returns the list. `setTier` moves the rule
  (removing it from the source tier's settings *and* sidecar, adding it to the target tier in
  whichever of the two matches its current enabled state). An unknown `ruleId` → `RULE_NOT_FOUND`.
- **FR-19**: every editor command takes a `sessionId` (the local tier needs its cwd, the global tier
  needs its runtime); an unknown session → `SESSION_NOT_FOUND`.

**Card UI (frontend)**

- **FR-20**: the `permission` block renders a card in the transcript: header row
  `PERMISSION` + a tool chip; the `summary` line (omitted when empty); the `inputJson` monospace
  box; a `cwd` line; then the action row. `pending` state only: four actions
  `allow once · deny once · always allow · always deny` plus a tier control showing
  `this project` / `all projects`, and a line reading the rule that "always" would write
  (`writes rule: <label>` with the raw pattern beside it).
- **FR-21**: clicking an action calls `permissions_decide` once; further clicks are ignored while in
  flight (card at `opacity:0.7`). On success the card stays in flight — the `permission.resolved`
  event flips it. On failure the message is shown **inline on the card** for 4 s and the card
  re-enables **unless** an event already resolved it (never an alert, never a stuck card).
- **FR-22**: resolved states are inert. `allowed` → accent `— allowed`; `denied` → `— denied` in the
  error color; `cancelled` → whole card `opacity:0.55` + `— cancelled`. When the decision wrote a
  rule the card shows `rule written: <label> · <tier label>` beneath the header.
- **FR-23**: while any pending permission card exists in the visible session the composer
  placeholder reads `approve or deny the request above — typed messages will queue`. A pending
  *question* card takes precedence over it (its own placeholder wins) so the two never fight.
- **FR-24**: reducer rules are keyed idempotent upserts, mirroring `question.asked`/`.resolved`:
  `permissionAsked` inserts (replay = no-op; an out-of-order resolved-first block gets its `ask`
  filled in without reviving its resolution), `permissionResolved` updates state/rule in place and
  inserts a resolved block when it arrives first.
- **FR-25**: hydration via `conversation_get_transcript` returns the block in its current state
  after any remount, exactly one per `blockId`. A block still `pending` on disk after a hard kill
  normalizes to `cancelled` on reload (a dead process has no answerable asks) — same rule the
  question block already uses.

**Rules editor UI (frontend)**

- **FR-26**: a palette command **Manage permissions** (`⚿`, enabled iff a session is active) opens a
  modal. The modal reads the list on open (FR-17) and after every mutation (FR-18).
- **FR-27**: each row shows the effect glyph (`✓` allow / `⊘` deny / `?` ask), the human label, the
  raw pattern in dim monospace, a tier chip (`project` / `global`), an enable toggle, a tier switch
  and a delete action. A disabled row renders at `opacity:0.5`.
- **FR-28**: a filter input narrows rows by substring against the label and the pattern. Empty list
  → `no permission rules yet — decide "always" on an approval card to create one`. A load or
  mutation failure shows the error inline; the modal never throws.
- **FR-29**: Escape closes the modal; so does a click on the backdrop. While the modal is open the
  app-shell single-letter global keys are suppressed (same rule the other modals follow).

## 5. API contract

Contract file: `contract/permission-guardrails.ts`; shared vocabulary in `contract/common.ts`
(placement rule identical to `session-questions` §5.3 — `common.ts` never imports from feature
files, and the `SessionEvent` union needs `PermissionAsk` / `PermissionRule`).

### 5.1 Channels

| logical channel | direction | request | success `data` | error codes |
|---|---|---|---|---|
| `francois:permissions:decide` | frontend → core | `DecidePermissionRequest` | `null` | `SESSION_NOT_FOUND` · `PERMISSION_NOT_PENDING` · `SETTINGS_WRITE_FAILED` · `INVALID_INPUT` |
| `francois:permissions:list` | frontend → core | `{ sessionId }` | `PermissionRule[]` | `SESSION_NOT_FOUND` |
| `francois:permissions:setEnabled` | frontend → core | `SetRuleEnabledRequest` | `PermissionRule[]` | `SESSION_NOT_FOUND` · `RULE_NOT_FOUND` · `SETTINGS_WRITE_FAILED` |
| `francois:permissions:remove` | frontend → core | `RemoveRuleRequest` | `PermissionRule[]` | `SESSION_NOT_FOUND` · `RULE_NOT_FOUND` · `SETTINGS_WRITE_FAILED` |
| `francois:permissions:setTier` | frontend → core | `SetRuleTierRequest` | `PermissionRule[]` | `SESSION_NOT_FOUND` · `RULE_NOT_FOUND` · `SETTINGS_WRITE_FAILED` |
| `francois:session:event` | core → frontend | — | two new `SessionEvent` members (§5.4) | — |

Physical binding: `invoke('permissions_decide' | 'permissions_list' | 'permissions_set_enabled' |
'permissions_remove' | 'permissions_set_tier', payload)`. The ask/resolved events ride the existing
`francois://session/event` channel — they are transcript blocks scoped to a session, exactly like
question cards, so they need no new event channel.

### 5.2 `contract/common.ts` amendments

```ts
export type PermissionTier = 'local' | 'global';
export type PermissionEffect = 'allow' | 'deny' | 'ask';

/** A gated tool call parked on the control channel (permission-guardrails FR-2..FR-5). */
export interface PermissionAsk {
  toolName: string;                 // verbatim from the control request
  summary: string;                  // one-line human rendering (FR-4); '' when none
  inputJson: string;                // whole tool input, pretty JSON, ≤ 4000 chars (FR-4)
  cwd: string;                      // the session's cwd
  pattern: string;                  // the Claude rule an "always" decision would write (FR-5)
  patternLabel: string;             // human reading of that pattern (FR-5)
}

/** One permission rule as it exists on disk (permission-guardrails FR-16/FR-17). */
export interface PermissionRule {
  id: string;                       // `${tier}|${effect}|${pattern}` — derived, stable
  pattern: string;                  // raw Claude pattern, e.g. 'Bash(git commit:*)'
  effect: PermissionEffect;
  tier: PermissionTier;
  enabled: boolean;                 // false ⇔ parked in the francois-permissions.json sidecar
  label: string;                    // human reading of the pattern
}
```

Two members join `SessionEvent` (emission: FR-2, FR-8/FR-10):

```ts
  | { type: 'permission.asked'; sessionId: SessionId; blockId: BlockId; ask: PermissionAsk }
  | { type: 'permission.resolved'; sessionId: SessionId; blockId: BlockId; state: 'allowed' | 'denied' | 'cancelled'; rule?: PermissionRule }
```

Three values join `ErrorCode`:

```ts
  | 'PERMISSION_NOT_PENDING' // decision arrived for an ask that is not pending
  | 'SETTINGS_WRITE_FAILED'  // settings.json could not be read-merged-written
  | 'RULE_NOT_FOUND'         // editor mutation addressed an unknown rule id
```

`ConversationBlockKind` gains `'permission'` and the `ConversationBlock` union gains
`PermissionConversationBlock`.

### 5.3 Types — `contract/permission-guardrails.ts`

```ts
import type { BlockId, PermissionAsk, PermissionRule, PermissionTier, SessionId } from './common';
export type { PermissionAsk, PermissionEffect, PermissionRule, PermissionTier } from './common';

export type PermissionDecision = 'allowOnce' | 'denyOnce' | 'allowAlways' | 'denyAlways';
export type PermissionState = 'pending' | 'allowed' | 'denied' | 'cancelled';

export interface PermissionConversationBlock {
  kind: 'permission';
  blockId: BlockId;
  isStreaming: boolean;             // true iff state === 'pending' (FR-25)
  ask: PermissionAsk;
  state: PermissionState;
  rule?: PermissionRule;            // present iff the decision wrote one (FR-22)
}

export interface DecidePermissionRequest {
  sessionId: SessionId;
  blockId: BlockId;
  decision: PermissionDecision;
  tier?: PermissionTier;            // default 'local'; ignored by the *Once decisions
}

export interface ListRulesRequest { sessionId: SessionId }
export interface SetRuleEnabledRequest { sessionId: SessionId; ruleId: string; enabled: boolean }
export interface RemoveRuleRequest { sessionId: SessionId; ruleId: string }
export interface SetRuleTierRequest { sessionId: SessionId; ruleId: string; tier: PermissionTier }
```

### 5.4 Error semantics

| condition | code | message |
|---|---|---|
| unknown session | `SESSION_NOT_FOUND` | `no such session` |
| blockId unknown / already resolved / no turn in flight | `PERMISSION_NOT_PENDING` | `that request is no longer pending` |
| unrecognized `decision` string | `INVALID_INPUT` | `unknown decision` |
| settings file unparseable, unwritable, or the global tier unresolvable | `SETTINGS_WRITE_FAILED` | `could not write <path>` (or `could not locate the global Claude settings directory`) |
| editor mutation for an id not in the fresh list | `RULE_NOT_FOUND` | `that rule no longer exists` |

### 5.5 Wire shapes (the `session-questions` §5.5 appendix is the authority for the envelope)

Inbound ask — an ordinary `can_use_tool` control request for any tool other than `AskUserQuestion`:

```json
{"type":"control_request","request_id":"<uuid>","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"npm test","description":"run the test suite"},"tool_use_id":"toolu_…"}}
```

Allow (FR-8) — `updatedInput` is the **verbatim** original input:

```json
{"type":"control_response","response":{"subtype":"success","request_id":"<same uuid>","response":{"behavior":"allow","updatedInput":{"command":"npm test","description":"run the test suite"}}}}
```

Deny (FR-8/FR-12):

```json
{"type":"control_response","response":{"subtype":"success","request_id":"<same uuid>","response":{"behavior":"deny","message":"Francois: the user denied this tool call."}}}
```

Settings file after an "always allow · this project" on `npm test`
(`<cwd>/.claude/settings.local.json` — note every pre-existing key survives):

```json
{
  "env": { "FOO": "bar" },
  "permissions": {
    "allow": ["Bash(npm test:*)"]
  }
}
```

Sidecar after toggling that rule off (`<cwd>/.claude/francois-permissions.json`); the pattern is
simultaneously removed from `settings.local.json`:

```json
{
  "disabled": [{ "effect": "allow", "pattern": "Bash(npm test:*)" }]
}
```

## 6. Data & state

**Core (Rust, `src-tauri/`)**

- New module `src-tauri/src/permissions.rs` — everything file- and pattern-shaped, and the four
  editor commands. Pure, unit-tested helpers: `generate_pattern`, `summarize_input`,
  `build_ask`, `merge_pattern`, `remove_pattern`, `rule_id`, `label_for_pattern`,
  `read_json_object`, `write_json_atomic`, sidecar read/write. `permissions.rs` never touches the
  session engine.
- `src-tauri/src/session.rs` — `TurnHandle` gains
  `pending_permissions: Arc<Mutex<HashMap<BlockId, PendingPermission { request_id, tool_name,
  input, ask }>>>`, a sibling of `pending_questions` with the same claim-to-resolve discipline.
  `BlockKind` gains `Permission` (card slot holds `{ ask, state, rule? }` — the same `card: Value`
  field reuse the question block uses). `permissions_decide` lives here (it needs the turn's stdin
  and pending map) and delegates every file operation to `permissions.rs`.
- `src-tauri/src/wsl.rs` — `wsl_home_unc(cwd) -> Option<String>`: the session distro's `$HOME` as a
  Windows-reachable UNC path, cached per distro alongside the existing FR-3 root cache.
- Nothing new is persisted in `sessions.json`; rules live only in the Claude settings files, pending
  entries only in memory.

**Frontend (`src/`)**

- `src/permission-card.ts` — pure card logic (pending detection, decision submit flow, tier labels,
  rule sentence, state chrome). `src/PermissionCard.tsx` — DOM assembly + card-local state.
- `src/permissions-editor.ts` — pure editor logic (filtering, ordering, effect glyphs, tier labels,
  mutation flow). `src/PermissionsModal.tsx` — the modal.
- `src/conversation-blocks.ts` gains `permissionAsked` / `permissionResolved` actions.
- `src/api.ts` gains the five `permissions*` wrappers.
- `src/store.ts` gains `permissionsOpen` + setter (the palette opens it, `App.tsx` renders it, the
  global-key guard suppresses single-letter keys while it is open).
- `src/styles.css` gains the `.pcard*` / `.prules*` classes. No `@keyframes`, `animation` or
  `transition` in either (the file-wide motion rule).

## 7. Edge cases & errors

| # | situation | behavior |
|---|---|---|
| 1 | Rule already exists in the target file | `merge_pattern` is a no-op append-if-absent; the decision still applies and the card still reports the rule (FR-14). |
| 2 | `settings.local.json` is unparseable JSON | Never overwritten. `SETTINGS_WRITE_FAILED`; nothing claimed, nothing decided (FR-7/FR-14). |
| 3 | `.claude/` does not exist | Created (`create_dir_all`) on the first write only. A read never creates anything (FR-17). |
| 4 | Global tier on a WSL session | Resolves to the distro's `$HOME/.claude/settings.json` through the UNC root; unresolvable → `SETTINGS_WRITE_FAILED` with the "could not locate" message (FR-13). |
| 5 | Two asks parked concurrently (subagent + main thread) | Two independent cards, independently keyed; deciding one does not touch the other (FR-2). |
| 6 | Decision races a `control_cancel_request` | Whichever claims the entry first wins; the loser gets `PERMISSION_NOT_PENDING` and the card already shows `cancelled` (FR-10, FR-21). |
| 7 | Child dies between park and decision | stdin write fails → block `cancelled`, `PERMISSION_NOT_PENDING` (FR-9). |
| 8 | App quits with an ask parked | `kill_all` drains `pending_permissions` before killing the child, so `cancelled` is persisted synchronously (FR-10). |
| 9 | Reload with a block still `pending` on disk | Normalized to `cancelled` (FR-25). |
| 10 | `allowGit` session, `git commit` | Auto-allowed with no card — FR-1(c) precedes FR-1(d). |
| 11 | Bash command with shell operators | Exact-command rule, no `:*` wildcard — a prefix rule on a compound command would let anything ride along (FR-5). |
| 12 | Tool input has no recognizable key | Bare tool-name pattern (`Bash`, `Foo`) and `any <Tool> call` label; the card shows the raw JSON so the user still sees exactly what they are approving (FR-4/FR-5). |
| 13 | Editor mutation on a rule someone deleted externally meanwhile | The fresh read finds no such id → `RULE_NOT_FOUND`; the list the editor then shows is current (FR-18). |
| 14 | The same pattern exists in both tiers | Two rules, two ids, both listed with their tier chip (FR-16/FR-17). |
| 15 | Effect array in settings contains a non-string | Skipped on read; preserved on write (the write only appends/filters strings). |
| 16 | Card decided from a stale UI after the turn ended | `PERMISSION_NOT_PENDING`; the card was already `cancelled` by the turn-end drain (FR-10). |

## 8. Design brief

No permission treatment exists in the mock (`Claude Terminal.dc.html`); the card inherits the
question-card visual language (`specs/session-questions.md` §8) and the app tokens
(`src/styles.css`). JetBrains Mono throughout. **Motion: none** anywhere in this feature.

### Approval card (transcript block, full width)

1. **Container** — `.pcard`: `background:var(--bg-deep); border:1px solid var(--border);
   border-radius:4px; padding:10px 12px;`. Pending adds `border-left:2px solid var(--warn)` (amber,
   distinct from the question card's accent edge — a permission ask is a stop, not a question).
   `denied` uses `border-left-color:var(--error)`; `allowed` `var(--success)`; `cancelled` sets the whole
   card `opacity:0.55`. In-flight `opacity:0.7`.
2. **Header row** — `PERMISSION` label (`color:var(--text-faint); font-size:9.5px;
   letter-spacing:.08em;`), a tool chip (`color:var(--warn); border:1px solid var(--border-2);
   border-radius:3px; padding:0 6px; font-size:9.5px;`), then the resolved note
   (`— allowed` / `— denied` / `— cancelled`, `font-size:9.5px`, colored by state).
3. **Summary line** — the FR-4 one-liner: `color:var(--text-bright); font-size:12.5px;
   margin:8px 0 0; overflow-wrap:anywhere;`. Omitted when empty.
4. **Input box** — `.pcard-input`, same treatment as the question card's preview box:
   `background:var(--bg-app); border:1px solid var(--border); padding:8px; white-space:pre;
   overflow-x:auto; max-height:180px; overflow-y:auto; font-size:10.5px; color:var(--text-2);
   margin-top:6px;` (scrolls inside its box, never the transcript).
5. **Meta line** — `cwd <path>` in `color:var(--text-faint); font-size:10.5px; margin-top:6px;`.
6. **Rule line** (pending only) — `writes rule:` in `--text-faint`, the human label in
   `--text-bright`, the raw pattern in `--text-dim` monospace, then the tier control: two inline
   text toggles `this project` / `all projects`, the active one `color:var(--accent)`, the other
   `color:var(--text-faint); cursor:pointer`.
7. **Action row** (pending only) — right-aligned, `gap:14px`, `font-size:11px`, `cursor:pointer`:
   `allow once` (`--success`), `deny once` (`--error`), `always allow` (`--success`), `always deny`
   (`--error`). Hover raises to the bright variant; while in flight the row is inert.
8. **Rule-written line** (resolved, when a rule was written) — `rule written:` + label + tier chip,
   `font-size:10.5px; color:var(--text-dim); margin-top:6px;`.
9. **Inline error** (FR-21) — `color:var(--error); font-size:11px; margin-top:6px;`, auto-clears
   after 4 s.

### Rules editor modal

10. **Overlay** — `position:fixed; inset:0; background:rgba(0,0,0,.55); display:flex;
    align-items:center; justify-content:center; z-index:20;` (the `NewSessionModal` convention);
    click on the backdrop closes.
11. **Panel** — `background:var(--bg-panel); border:1px solid var(--border-2); border-radius:6px;
    width:min(720px, 92vw); max-height:80vh; display:flex; flex-direction:column;`. Header:
    `PERMISSION RULES` (`font-size:10px; letter-spacing:.12em; color:var(--accent)`) + the settings
    paths in `--text-faint`, then a filter input (the `NewSessionModal` field style).
12. **Row** — `display:flex; align-items:baseline; gap:10px; padding:6px 10px; border-radius:3px;`
    hover `background:var(--bg-elevated)`. Columns: effect glyph (14px, `✓` `--success` / `⊘` `--error` /
    `?` `--warn`), label (`--text-bright`, flex 1, `overflow-wrap:anywhere`), pattern
    (`--text-dim`, `font-size:10.5px`), tier chip (`project` / `global`, bordered like the tool
    chip), then the actions: the enable toggle (`◉` on / `○` off), `→ global` / `→ project`, and
    `✕`. Disabled rows `opacity:0.5`.
13. **Groups** — one `DENY` / `ASK` / `ALLOW` section label per non-empty effect
    (`font-size:9.5px; letter-spacing:.08em; color:var(--text-faint); margin:10px 0 4px;`).
14. **Empty / error** — centered dim line (FR-28); an error uses `--error`.

### Responsive

The card spans the transcript column; long commands wrap (`overflow-wrap:anywhere`) or scroll inside
the input box. The modal caps at `min(720px, 92vw)` and its list scrolls (`.scz`).

## 9. Acceptance criteria

- [ ] A `can_use_tool` fixture for `Bash` yields `ControlDecision::Permission` — no deny response —
      and parking emits exactly one `permission.asked` with the §5.2 `PermissionAsk`, plus a
      buffered + persisted `pending` block (FR-1, FR-2).
- [ ] `AskUserQuestion` still parks as a question; an unknown subtype still gets the error response;
      an `allowGit` session still auto-allows `git`/`gh` with no card (FR-1).
- [ ] `generate_pattern` table: `npm test` → `Bash(npm test:*)`; `git commit -m x` →
      `Bash(git commit:*)`; `ls` → `Bash(ls:*)`; `cd x && rm -rf y` → the exact-command form;
      `Read {file_path: <cwd>/src/a.ts}` → `Read(src/a.ts)`; `WebFetch {url}` →
      `WebFetch(domain:example.com)`; `mcp__ctx7__query` → itself; unknown tool → bare name (FR-5).
- [ ] `allowOnce` writes the §5.5 allow response with **verbatim** `updatedInput`, resolves the
      block `allowed`, emits one `permission.resolved`, returns ok (FR-8).
- [ ] `denyOnce` writes the §5.5 deny with the FR-12 message and resolves `denied` (FR-8, FR-12).
- [ ] `allowAlways` writes `Bash(npm test:*)` into `<cwd>/.claude/settings.local.json`
      `permissions.allow` **preserving** a pre-existing `env` key and a pre-existing allow entry,
      then decides; the resolved event carries the `PermissionRule` (FR-7, FR-8, FR-14).
- [ ] A settings file containing invalid JSON is never overwritten: the decision resolves
      `SETTINGS_WRITE_FAILED`, the pending entry is still pending, no control_response was written
      (FR-7, FR-14, §7 #2).
- [ ] Deciding twice → second resolves `PERMISSION_NOT_PENDING`; unknown session →
      `SESSION_NOT_FOUND`; garbage decision → `INVALID_INPUT` (§5.4).
- [ ] Turn end / interrupt / `control_cancel_request` / app exit with an ask parked → block
      `cancelled`, one `permission.resolved`, pending entry gone (FR-10).
- [ ] `permissions_list` returns enabled rules from both tiers plus sidecar-disabled ones, ordered
      deny → ask → allow and local before global, each with its derived id and label (FR-16, FR-17).
- [ ] `setEnabled(false)` removes the pattern from `settings.local.json` and adds it to the sidecar
      (and back on `true`); `remove` clears it from both; `setTier` moves it between files
      preserving `enabled` — each returning the freshly re-read list (FR-15, FR-18).
- [ ] Serde round-trips: both new event members and the `permission` block serialize to the §5.2/5.3
      shapes exactly (absent `rule` omitted, not `null`).
- [ ] Reducer: `permissionAsked` idempotent insert; `permissionResolved` updates in place; resolved
      arriving first inserts resolved and a later `permissionAsked` fills in the ask — vitest.
- [ ] Card: a pending card's four actions each call `permissions_decide` once with the right
      `decision`/`tier`; a failure shows inline and re-enables unless resolved (FR-21) — vitest on
      the pure module.
- [ ] Composer placeholder swaps while a pending permission card exists, and a pending question card
      still wins (FR-23) — vitest.
- [ ] Editor: filter matches label and pattern; rows group deny/ask/allow; an empty list shows the
      FR-28 line — vitest on the pure module.
- [ ] Hydration after remount shows `pending` while pending and the resolved state after; a
      persisted `pending` block reloads as `cancelled` (FR-25).
- [ ] No `@keyframes` / `animation` / `transition` in the `.pcard*` or `.prules*` CSS (§8).

## Remediation

### Round 1 — `/review` 2026-07-24 (core BLOCK · frontend SHIP · 1 critical · 4 security · 2 high · 10 medium · 15 low)

**All 28 findings applied in-session.** Two required amending this frozen spec rather than only the
code: the FR-5 shell-metacharacter set (now FR-5a/5b) and the `run exactly this command` label.
Re-verified after: **172 cargo tests, 258 vitest tests, `tsc --noEmit` clean, `npm run build` clean.**

- [x] CRITICAL · `permissions.rs` `SUBCOMMAND_PROGRAMS` · spec-violation · `bun` was missing from the
      FR-5 list of 30, so `bun test` generated `Bash(bun:*)` — "always allow" on a test run silently
      granting `bun install` / `bun x` / `bun run <script>`. Added; a new test now pins the **whole**
      FR-5 list rather than a sample.
- [x] SECURITY/HIGH · `permissions.rs` `SHELL_OPERATORS` · a bare `&` was not an operator, so
      `npm test & rm -rf ~` took the *prefix* branch. Replaced the pair-based list with a
      single-character set (FR-5a).
- [x] SECURITY · `permissions.rs` `exact_bash_pattern` · a command ending in `:*` was re-read by
      Claude as a prefix rule, and one containing `)` made the pattern ambiguous. Both now degrade to
      bare `Bash` (FR-5b).
- [x] SECURITY · `permissions.rs` `write_json_atomic` · the temp file was created at umask default,
      so a `0600` `~/.claude/settings.json` (which carries `env` secrets, and which this code rewrites
      wholesale) became world-readable. Now inherits the target's mode, `0600` for new files.
- [x] SECURITY · `permissions.rs` `url_host` · `\` was not a delimiter, so
      `https://evil.com\@good.com/x` reported `good.com` (FR-5c).
- [x] HIGH · test-coverage · extracted `decide_outcome`, `is_valid_tier`, `move_rule`, `park_rule`
      (permissions.rs) and `claim_pending` (session.rs) so the decision matrix, the tier move and the
      exactly-once claim are testable without `State<Engine>`/`AppHandle`. +11 core tests.
- [x] MEDIUM · `session.rs` `permissions_decide` · `tier` was unvalidated and flowed into the emitted
      `PermissionRule.tier`/`id`, minting an id `permissions_list` can never produce.
- [x] MEDIUM · `permissions.rs` `rules_of_tier` · a pattern live in settings **and** parked in the
      sidecar produced two rules with the same derived id; `locate()` took the first, so a toggle
      could hit the wrong row. Settings.json now wins and the entry lists once.
- [x] MEDIUM · `permissions.rs` `write_rule` · the sidecar error was swallowed (`let _ =`), leaving
      exactly that duplicate state while reporting success. Now propagates.
- [x] MEDIUM · `permissions.rs` `park_rule` · the disable path removed from settings before parking,
      so a mid-way failure lost the rule from both files. Order reversed to match `set_tier`.
- [x] MEDIUM · `permissions.rs` `path_relative_to_cwd` · compared on `to_lowercase()` copies but
      sliced at the original byte offset — a case-folding length change could slice off a UTF-8
      boundary and **panic on the turn's reader thread**. Now ASCII-folded with checked slicing.
- [x] MEDIUM · `Cargo.toml` · `serde_json` without `preserve_order` alphabetically reordered every
      key of the user's settings.json on each surgical write, contradicting FR-14.
- [x] MEDIUM · `PermissionsModal.tsx` · Escape was capture-phase, unlike every other modal, so one
      Escape dismissed the palette *and* closed the editor. Moved to the bubble phase (FR-29).
- [x] LOW ×15 · lost-rule trace on the peek/claim race and the stdin-fail path (the written rule now
      rides the cancelled resolution); `dirs::home_dir()`; `set_tier` validates before `locate()` and
      no longer returns an off-contract code; `run exactly this command` label; `.expect()` removed
      from `effect_array`/`write_disabled`; per-process unique temp filenames; `permissionsOpen`
      stranding guard; one live error timer + unmount cleanup; `key` collision; runtime-neutral
      settings-path label; `busy` affordance; dropped `as PermissionState`; `writesRule` now drives
      the tier control's dimmed state; `.pcard-note-cancelled`.
