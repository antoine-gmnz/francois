---
id: interactive-commands
title: Interactive commands (session view)
status: shipped
created: 2026-07-22
depends_on: [session-engine, conversation-view]
design_files: [] # none by decision (2026-07-22): §8 brief is the design source
---

# Interactive commands (session view)

## 1. Summary

Claude Code's interactive built-in commands (`/usage`, `/cost`, `/context`, `/model`, `/status`, `/help`) do nothing visible in Francois today: the headless CLI answers several of them locally — as a **synthetic assistant message** (a complete top-level `assistant` stream event with `message.model === "<synthetic>"`, no `stream_event` deltas) plus the same text in the final `result` event's `result` field — and the engine's stream reader drops both on success. This feature makes those commands first-class in the SESSION tab: the engine detects synthetic command responses and renders them as typed **command cards** in the transcript, intercepts commands it can answer itself (`/model`, `/status`, `/help`) without spawning any process, runs account-level lookups (`/usage`, `/cost`) as detached side-spawns that never touch the conversation or session status, and turns the CLI's own "Unknown command: /x" / "/x isn't available in this environment." replies into visible notices instead of silence.

Ground truth this spec is built on (probed against `claude` 2.1.217, 2026-07-22): `/usage` and `/cost` (aliases) return rendered plan-limit text (`Current session: 14% used · resets Jul 22, 5:29pm (Europe/Paris)` …) with `num_turns: 0`, `duration_api_ms: 0`, `total_cost_usd: 0` — local, free, ~1s. `/context` returns a markdown context breakdown and needs the session's real thread (`--resume`) to be meaningful. `/status` returns "/status isn't available in this environment." Unknown commands return "Unknown command: /x". All of these arrive as synthetic assistant messages as described above.

## 2. Goals & non-goals

- **Goals**:
  - Never let a slash command die silently: every `/…` input produces a visible transcript response.
  - Render `/usage` & `/cost` as parsed meter cards (with raw-text fallback), fetched via a detached side-spawn that works even mid-turn and never flips session status.
  - Let `/context` run as a normal turn on the session's thread (it needs `--resume`) and render its markdown breakdown as a card.
  - Answer `/model` (clickable model-list card, or direct switch with an argument), `/status` (session snapshot card), and `/help` (supported-commands card) locally in the core — instant, no process spawn.
  - Render CLI-local responses to *any* other command (unknown, unavailable) as dim notice blocks via generic synthetic-message detection.
  - Persist command cards in the transcript buffer/durable transcript like every other block.
- **Non-goals**:
  - No client-side command palette/autocomplete in the input bar (future feature; `command-palette` owns ⌘K).
  - No interception of custom skills/commands (`/spec`, `/build`, `/compact`, …) — they pass through byte-for-byte and run as real turns, unchanged (conversation-view FR-23 stands).
  - No reimplementation of `/usage` data from an API — the headless CLI is the only data source for plan limits.
  - No live-updating cards (a card is a moment-in-time answer; re-run the command for fresh data). Exception: the model card's "current" marker, which is live-derived (FR-21).
  - `/compact` keeps its existing palette flow (`francois:session:compact`); typing `/compact` as text stays passthrough.

## 3. User stories / flows

1. **`/usage` while idle.** User types `/usage`, Enter. A "YOU" block appears (normal send path), immediately followed by a loading command card (`▦ USAGE`, pulse). ~1s later the card fills with meters (session / week / model-week percentages + reset times) and the "What's contributing" tail as preformatted text. Session status never leaves `idle`; no turn is consumed.
2. **`/usage` mid-turn.** Same as (1) while the assistant is streaming — the card appears and fills without waiting for the turn; the streaming blocks continue below it. Status stays `running` the whole time (never because of the probe).
3. **`/cost`.** Identical to `/usage` (the CLI aliases them); the card header reads `COST`.
4. **`/context`.** Sent as a normal turn (status `running`, queued FIFO if a turn is in flight). The turn produces no streamed assistant text — the engine detects the synthetic response and renders a `CONTEXT` card: a used/limit meter parsed from the markdown plus the category/agents/skills breakdown as preformatted text. Then status returns to `idle`.
5. **`/model`** (bare). Instant card listing the model catalog; the session's current model row is marked `●`. Clicking another row calls `switchModel`; the header model label and every model card's marker update via the resulting `session.meta`. Clicking the current row does nothing.
6. **`/model opus`** (with argument). The engine resolves the argument against the catalog (id exact, else label case-insensitive); on success it switches immediately (same semantics as the palette's switch) and renders a notice card `model → Opus 4`; on failure a notice card `unknown model: opus — available: …`.
7. **`/status`.** Instant card with the session snapshot: name, cwd, model, status, runtime, permission mode, context used/limit, started time.
8. **`/help`.** Instant card listing the commands Francois handles (`/usage /cost /context /model /status /help`) with one-line descriptions, plus the footer note that other `/commands` pass through to Claude Code.
9. **Unknown command.** User types `/frobnicate`. It passes through as a turn; the CLI answers with a synthetic "Unknown command: /frobnicate"; Francois renders it as a dim notice block (~1s round-trip, no API cost).
10. **Custom skill.** User types `/spec something`. Passthrough as today — a real turn with streamed output. Nothing about this feature interferes.
11. **Relaunch.** Finalized command cards are restored with the transcript (durable-sessions). A card still loading when the app quit is gone after relaunch (only its "YOU" block remains).

## 4. Functional requirements

**Interception & grammar (core, in the `session:send` handler)**

- **FR-1**: Command detection applies to the trimmed send text. It is a command iff it is a single line (no `\n`) matching `^/([A-Za-z][A-Za-z0-9_-]*)(\s+\S.*)?$`. `command` = capture 1 lowercased; `arg` = the remainder trimmed, or absent. Multiline text or a non-matching first token is not a command (normal turn, unchanged).
- **FR-2**: The **intercept set** is exactly `usage`, `cost`, `model`, `status`, `help`. Interception happens in the core's send handler **before** the FIFO-enqueue branch (session-engine FR-18): an intercepted command never enqueues, never changes `SessionStatus`, never spawns a conversation turn, and works identically whether `status` is `running` or `idle`. Every other input — including `/context`, `/compact`, and custom skills — takes the existing passthrough turn path, unchanged.
- **FR-3**: Intercepted sends still validate exactly like any send (session-engine FR-15/16/17): unknown session → `SESSION_NOT_FOUND`; empty → `INVALID_INPUT`; `done`/`error` → `SESSION_NOT_RUNNING`. On success the call resolves `ok: true` with `{ queued: false }`.
- **FR-4**: For every intercepted command the engine, in order: emits `message.user` echoing the request's `blockId` (this clears conversation-view's queued chip), appends the user block to the transcript buffer, then runs the per-command flow below. `lastActivityAt` updates via the engine's normal every-event rule (session-engine FR-5).
- **FR-5**: For `usage`/`cost`/`status`/`help`, a present `arg` is ignored (the command runs bare).

**Detached side-spawn (`/usage`, `/cost`)**

- **FR-6**: The engine allocates a fresh `BlockId`, emits `command.started { command }`, and appends a pending command block (`isStreaming: true`, no card) to the buffer.
- **FR-7**: It then spawns a detached probe using the same invocation machinery as turns (`claude_invocation`: session `runtime` — including WSL — and session `cwd`), with args `-p "/<command>" --output-format stream-json --verbose --model <session model id>` and **no** `--resume`, no permission-mode flags. The probe is invisible to the turn lifecycle: it does not touch `status`, the queue, `claude_session_id`, or `contextUsedTokens`.
- **FR-8**: Answer extraction from the probe's stdout: the text of the first top-level `assistant` event whose `message.model === "<synthetic>"` (concatenate its `content[].text` entries); if none arrives, the final `result` event's `result` string. Trailing whitespace stripped.
- **FR-9**: The answer is parsed into a usage card (§5 parse rules). If parsing yields at least one meter → `kind: 'usage'` card (meters + tail); otherwise → `kind: 'text'` card with the raw answer. Either way the engine emits `command.output { card }` for the pending block and finalizes it in the buffer.
- **FR-10**: Probe failure — spawn error, timeout (30s, then the probe is killed), or an empty answer — finalizes the pending block with a `kind: 'notice'` card stating the failure (reuse session-engine FR-45's actionable wording for binary-not-found / not-authenticated where determinable). A pending command block is never left open.
- **FR-11**: At most **one** in-flight probe per session. An intercepted `/usage` or `/cost` while one is pending skips FR-6/7 and immediately emits `command.output` (fresh `BlockId`) with a notice card "a usage check is already running".

**Locally answered commands (`/model`, `/status`, `/help`)**

- **FR-12**: `/model` bare → one `command.output` with `kind: 'model'`: `models` = the current model catalog snapshot (same source as `francois:session:models`), `currentId` = the session's `model.id`.
- **FR-13**: `/model <arg>` → resolve `arg` against the catalog: exact `id` match first, else case-insensitive `label` match. Resolved → apply the same semantics as `francois:session:switchModel` (update `SessionMeta.model`, emit `session.meta`; in-flight turn unaffected) and emit a notice card `model → <label>`. Unresolved → notice card `unknown model: <arg>` naming the valid ids. Both instant, no status change.
- **FR-14**: `/status` → `command.output` with `kind: 'status'`, `meta` = the session's full current `SessionMeta` snapshot.
- **FR-15**: `/help` → `command.output` with `kind: 'help'` and the fixed entry list in §5.

**Synthetic-response detection on passthrough turns (`/context`, unknowns, everything CLI-local)**

- **FR-16**: During any normal turn, a top-level `assistant` stream line whose `message.model === "<synthetic>"` produces (per such line): a fresh `BlockId`, a buffered command block, and one `command.output` event. No `assistant.delta`/`assistant.done` is emitted for synthetic messages.
- **FR-17**: Card classification for a synthetic text, in order: (a) if the turn's submitted text parsed (FR-1) to command `context` → context card per FR-19; (b) if the text starts with `Unknown command: ` or contains `isn't available in this environment` → `kind: 'notice'` with the text verbatim; (c) otherwise → `kind: 'text'` with `command` = the turn's parsed command token (or `''`) and the text verbatim.
- **FR-18**: Defensive fallback: if a turn completes with `subtype: "success"`, **zero** assistant/tool blocks were emitted during it, no synthetic message was seen, and the `result` event's `result` string is non-empty → emit one `command.output` with a card classified per FR-17 from that string. (Covers CLI versions that put local-command output only in `result`.)
- **FR-19**: Context card parse: `percentUsed`/`usedLabel`/`limitLabel` from the first match of `\*\*Tokens:\*\*\s*(\S+)\s*/\s*(\S+)\s*\((\d+)%\)`; `body` = the full text normalized by removing `**` bold markers and stripping leading `#`-runs (plus one space) from heading lines; table pipes kept verbatim. If the tokens line doesn't match, `percentUsed`/`usedLabel`/`limitLabel` are `null` and the card renders body-only.

**Rendering (frontend, conversation-view's SESSION tab)**

- **FR-20**: `ConversationBlock` gains kind `'command'` (§5). Apply rules extend conversation-view FR-10's keyed idempotent upserts: `command.started` inserts a pending `CommandConversationBlock` (`isStreaming: true`, no `card`) — no-op if the `blockId` exists; `command.output` upserts the block's `card` and sets `isStreaming: false` — inserting the block if unseen (the FR-11/FR-13 instant-notice cases arrive without a `command.started`).
- **FR-21**: The model card's **current** marker is derived live from the store's `SessionMeta.model.id` — never from the card's `currentId` snapshot — so every historical model card always marks the actual current model. Clicking a non-current row invokes `francois:session:switchModel { sessionId, modelId }`; on `ok: false` the card shows the error `message` inline (dim error styling) for 4 seconds. Clicking the current row is a no-op. Rows are non-interactive when the session's `status` is `done`/`error`.
- **FR-22**: A pending command block renders the loading state (§8). Hydration (`getTranscript`) returning a pending block renders it loading as well — the engine's FR-10 guarantees it finalizes.
- **FR-23**: Cards scroll with the transcript and participate in conversation-view's pin/auto-scroll rules like any block; no special scroll behavior.

**Persistence**

- **FR-24**: Finalized command blocks persist through durable-sessions' per-session transcript JSONL exactly like other blocks, with the `card` serialized as JSON. Pending blocks are not persisted (durable-sessions appends on finalize); after a relaunch a mid-probe card is simply absent — its user block remains, and re-running the command is the recovery.

## 5. API contract

**No new IPC request/response channels and no new `ErrorCode`s.** This feature rides on `francois:session:send`, `francois:session:switchModel`, `francois:session:event`, and `francois:conversation:getTranscript`. Its contract surface is: two new `SessionEvent` members + the card vocabulary (added to `contract/common.ts`), and one new `ConversationBlock` member (defined in `contract/interactive-commands.ts`, spliced into conversation-view's union).

### Delta to `contract/common.ts` (cross-feature — flagged for the lead at /build)

The `SessionEvent` union gains two members:

```ts
  | { type: 'command.started'; sessionId: SessionId; blockId: BlockId; command: string }
  | { type: 'command.output'; sessionId: SessionId; blockId: BlockId; card: CommandCard }
```

And the shared card vocabulary (placed in `common.ts` because the engine emits it and conversation-view renders it — same precedent as `AgentInfo`):

```ts
/** One plan-limit meter parsed from the CLI's /usage output. */
export interface UsageMeter {
  label: string; // e.g. 'Current session', 'Current week (all models)'
  percentUsed: number; // 0–100 integer
  resetsAt: string; // verbatim reset text, e.g. 'Jul 22, 5:29pm (Europe/Paris)'
}

export interface HelpEntry {
  command: string; // without the leading '/', e.g. 'usage'
  description: string;
}

export type CommandCard =
  /** /usage & /cost, parsed. meters non-empty; tail = remaining lines, preformatted. */
  | { kind: 'usage'; command: 'usage' | 'cost'; meters: UsageMeter[]; tail: string }
  /** /context. percentUsed/usedLabel/limitLabel null when the tokens line didn't parse (FR-19). */
  | {
      kind: 'context';
      percentUsed: number | null;
      usedLabel: string | null; // e.g. '26.4k'
      limitLabel: string | null; // e.g. '200k'
      body: string; // normalized markdown, preformatted
    }
  /** /model bare. currentId is a snapshot; the live marker derives from SessionMeta (FR-21). */
  | { kind: 'model'; models: ModelInfo[]; currentId: string }
  /** /status. */
  | { kind: 'status'; meta: SessionMeta }
  /** /help. */
  | { kind: 'help'; entries: HelpEntry[] }
  /** Dim one-liner: unknown command, unavailable command, probe failure, model switch ack. */
  | { kind: 'notice'; text: string }
  /** Generic CLI-local output that fits no richer card. */
  | { kind: 'text'; command: string; text: string };
```

### `contract/interactive-commands.ts` (owned by this feature)

```ts
import type { BlockId, CommandCard } from './common';

/** Transcript block for a command response. Joins conversation-view's ConversationBlock union. */
export interface CommandConversationBlock {
  kind: 'command';
  blockId: BlockId;
  /** true from command.started until command.output (loading card). */
  isStreaming: boolean;
  /** Command token without the '/', '' when the source text wasn't a parsed command. */
  command: string;
  /** Absent while pending. */
  card?: CommandCard;
}
```

### Delta to `contract/conversation-view.ts` (cross-feature — flagged for the lead at /build)

```ts
import type { CommandConversationBlock } from './interactive-commands';
// ConversationBlock union gains:
//   | CommandConversationBlock
```

### Event emission summary

| Member | Emitted when |
|---|---|
| `command.started` | An intercepted `/usage` or `/cost` begins its side-spawn (FR-6) |
| `command.output` | A probe finalizes (FR-9/10), an instant local command answers (FR-11–15), a synthetic message is detected in a turn (FR-16), or the FR-18 fallback fires |

Ordering: both members obey session-engine FR-29 (per-session FIFO). `command.output` for a given `blockId` is always preceded by that block's `command.started` **iff** the flow used one (side-spawns do; instant cards and synthetic detections do not).

### Parse rules (deterministic, mirrored core-side; unit-tested)

- **Usage meter line** (applied per line of the answer): `^(.+?): (\d+)% used · resets (.+)$` (the `·` is U+00B7) → `{ label, percentUsed, resetsAt }`. `meters` = all matches in order. `tail` = the answer minus matched lines, blank-line runs collapsed to one, trimmed.
- **Context tokens line** and body normalization: per FR-19.

## 6. Data & state

**Rust core (this feature's additions to the engine):**

- Per-session: `pendingProbe?: { blockId: BlockId; child: ProcessHandle; startedAt }` — the single in-flight side-spawn (FR-11); killed on session remove and on app exit. Not persisted.
- Per-turn (reader-local): `sawSyntheticOrBlocks: bool` — whether any assistant/tool block or synthetic message was emitted this turn, for the FR-18 fallback.
- The intercept set, help entries, usage/context parse functions: static, no state.
- Buffer: `BufBlock` gains the command variant (`command`, optional `card` JSON, pending flag). Persisted on finalize via durable-sessions' existing append path (FR-24).

**Frontend (conversation-view's existing zustand slice):**

- No new slice. `blocks` now contains `CommandConversationBlock`s; apply rules per FR-20. The model card's transient switch-error text (FR-21) is component-local state (4s timer), not store state.

**Not owned here:** the model catalog (session-engine), `SessionMeta` (session-engine), transcript hydration channel (conversation-view), the ⌘K palette's Switch model/Compact actions (command-palette).

## 7. Edge cases & errors

| Case | Behavior |
|---|---|
| Intercepted command on unknown / `done` / `error` session | Normal send validation applies (FR-3): `SESSION_NOT_FOUND` / `SESSION_NOT_RUNNING`; conversation-view's FR-26 restores the input. |
| `/usage` when `claude` binary missing or not authenticated | Probe fails to spawn / exits before a usable answer → notice card with the actionable FR-45-style message (FR-10). Session unaffected — this never sets `status: 'error'`. |
| Probe hangs | 30s timeout → kill → notice card "couldn't fetch usage — timed out" (FR-10). |
| Second `/usage` while one is pending | Instant notice card "a usage check is already running" (FR-11). |
| CLI `/usage` output format drifts | Meter regex matches nothing → raw `text` card (FR-9). Never an error. |
| `/context` while a turn is in flight | Normal FIFO queueing (it is a passthrough turn); the card appears when its turn runs. |
| `/context` output missing the tokens line | Body-only context card (FR-19). |
| `/model` with unknown argument | Notice card naming valid ids (FR-13); no error result, no state change. |
| switchModel from a model card resolves `ok: false` | Inline transient error in the card, 4s (FR-21). |
| Interrupt (`francois:session:interrupt`) while a probe is in flight | Interrupt targets turns only; the probe is unaffected and finalizes normally. |
| Session removed while a probe is in flight | The probe is killed with the session; per session-engine FR-14 no event for that session is emitted afterward (the pending card dies with the registry entry). |
| App quits while a probe is in flight | Probe killed; pending block was never persisted (FR-24) — after relaunch only the user block remains. |
| Multiline input starting with `/` | Not a command (FR-1) — normal turn. |
| `/usage extra words` | Arg ignored (FR-5); runs as bare `/usage`. |
| Synthetic message arrives mid-turn alongside real streamed blocks (e.g. a future CLI behavior) | Each synthetic becomes its own card block in stream order (FR-16); FR-18's fallback does not fire (blocks were seen). |
| WSL session | Probe runs through `claude_invocation` with the session's runtime (FR-7) — same as turns. |
| Hydrating a session with a pending command block | Renders loading (FR-22); the engine finalizes it (FR-10 guarantees). |

## 8. Design brief

### Screens / regions

Main pane `[2]`, SESSION tab transcript (`Claude Terminal.dc.html:88-116`) — new block types inside the existing transcript flow. No new panes, tabs, or chrome. The input bar, header cluster, and scroll model are untouched (conversation-view).

### Components

1. **Command card** — bordered container block, full transcript width: header row (glyph + command name) + kind-specific body. Kinds: usage, context, model, status, help.
2. **Usage meter row** — label + horizontal bar + percent + reset text (inside usage/context cards).
3. **Model row** — selectable row inside the model card (current / other / disabled variants).
4. **Notice block** — NOT a card: a dim glyph-column one-liner, same layout as tool blocks.
5. **Loading card** — command card shell with pulse dot + "running…" placeholder body.

### States

- **Command card**: loading (pending) / filled / — (cards never error; failures arrive as notice blocks).
- **Usage meter**: normal (< 80%) / high (≥ 80%).
- **Model row**: current / selectable / hover / disabled (session `done`/`error`) / transient-error (card-level, 4s).
- **Notice block**: single state.

### Interactions

- Model card: click a selectable row → `switchModel`; the `●` marker moves when `session.meta` lands (live-derived, FR-21). Hover lifts row background (mock's interactive-row convention). Current row and disabled rows: `cursor: default`, no hover lift.
- All other cards and the notice block are non-interactive (consistent with transcript blocks).
- Cards participate in normal transcript scrolling/pinning; no card-local scrolling except preformatted bodies (below).

### Visual notes (exact tokens; JetBrains Mono throughout)

**Card container**: `background:#17191f; border:1px solid #24262d; border-radius:4px; padding:10px 13px;` — sits in the transcript flow full-width (like the user block, no glyph column).

**Card header**: row, gap 8px: glyph `▦` `color:#c8a15a; font-size:12px;` + command name uppercase (`USAGE`, `COST`, `CONTEXT`, `MODEL`, `STATUS`, `HELP`) `font-size:10px; letter-spacing:0.12em; color:#868a93;`. Margin-bottom 8px when a body follows.

**Loading state**: header as above with, right-aligned in the same row, a 5px dot `#c2b06a` pulsing (`pulse 1.4s ease-in-out infinite`) + `running…` `font-size:9.5px; color:#c2b06a;` (same treatment as conversation-view's queued chip). Body: `fetching…` `font-size:12px; color:#565a63;`.

**Usage meter row** (one per `UsageMeter`, stacked, gap 8px):
- Label: `font-size:11px; color:#b9bcc4; margin-bottom:3px;`
- Bar: track `height:6px; border-radius:3px; background:#24262d;` fill width `percentUsed%`, `background:#c8a15a`; `≥ 80%` → `background:#c46b62` (error red). No fill animation — renders at final width.
- Right of the bar (same row, gap 8px): percent `font-size:11px; color:#dfe2e8;` then `resets <resetsAt>` `font-size:10px; color:#565a63;`.
- Tail (below meters, margin-top 8px): `font-size:12px; color:#b9bcc4; line-height:1.5; white-space:pre-wrap;`.

**Context card**: if parsed, one meter row (label `context`, percent from `percentUsed`, right text `<usedLabel>/<limitLabel>` styled like the header cluster's used-bright/limit-faint); body below: `font-size:12px; color:#b9bcc4; line-height:1.5; white-space:pre; overflow-x:auto;` (preserves table column alignment; horizontal scroll inside the card, 8px thin scrollbar `.scz`).

**Model card rows**: `display:flex; gap:8px; padding:5px 8px; border-radius:3px;` — current: `●` `#7fa07a`, label `font-size:12px; color:#dfe2e8;`, suffix `current` `font-size:10px; color:#565a63;`; selectable: `○` `#565a63`, label `#b9bcc4`, `cursor:pointer;` hover `background:#20222a;`; disabled: selectable colors at `opacity:0.5`, no hover, `cursor:default`. Transient error line (FR-21): `font-size:10.5px; color:#c46b62;` below the rows for 4s.

**Status card**: label/value rows (`display:grid; grid-template-columns:auto 1fr; gap:3px 14px;`): labels (`name`, `cwd`, `model`, `status`, `runtime`, `permissions`, `ctx`, `started`) `font-size:10.5px; color:#565a63;`; values `font-size:12px; color:#c4c7ce;`. `ctx` value reuses conversation-view's used-bright `/`-limit-faint format. `status` value colored like the sidebar dots (running `#c8a15a`, idle `#7fa07a`, done `#565a63`, error `#c46b62`).

**Help card**: one row per entry: `/<command>` `font-size:12px; color:#c8a15a;` (fixed 90px column) + description `font-size:12px; color:#868a93;`. Footer (margin-top 8px): `other /commands are passed to Claude Code` `font-size:10.5px; color:#565a63;`.

**Notice block**: glyph-column layout identical to tool blocks (16px glyph column): glyph `▦` `color:#565a63;` body `font-size:12.5px; color:#868a93;`.

**Motion**: pulse `1.4s ease-in-out infinite` (loading dot) only. No entrance animations; cards appear like any block.

### Resize / responsive

- Cards are full transcript width; meter bars flex (`flex:1`) between label column and percent/reset text; below ~360px pane width the reset text wraps under the bar (normal wrap), never truncates.
- `white-space:pre` bodies (context/text cards) scroll horizontally inside the card — the transcript container never gains horizontal scroll.
- Model/status/help rows wrap values normally; `cwd` in the status card may wrap to multiple lines (no ellipsis — full path always readable).

## 9. Acceptance criteria

- [ ] Typing `/usage` (idle or mid-turn) renders a loading card that fills with ≥1 meter + tail within ~30s, and session `status` never changes because of it (FR-2, FR-6–9).
- [ ] `/cost` behaves identically with header `COST` (FR-2, FR-9).
- [ ] The usage probe passes no `--resume` and runs under the session's runtime and cwd, WSL included (FR-7).
- [ ] Killing the probe scenario (binary missing / timeout) yields a notice card, never a stuck loading card and never `status: 'error'` (FR-10).
- [ ] A second `/usage` while one is pending yields the "already running" notice card instantly (FR-11).
- [ ] `/context` runs as a normal turn and renders a context card with a parsed meter and preformatted breakdown; with an unparseable tokens line it renders body-only (FR-16–19).
- [ ] `/frobnicate` renders a dim "Unknown command: /frobnicate" notice block (FR-16/17).
- [ ] `/model` renders the catalog card; clicking a row switches the model and the marker follows `SessionMeta.model.id` on every model card in the transcript (FR-12, FR-21).
- [ ] `/model <unknown>` renders the unknown-model notice with valid ids; `/model <label>` switches case-insensitively (FR-13).
- [ ] `/status` and `/help` render instantly with the specified contents (FR-14/15).
- [ ] `/spec` (a custom skill) still runs as a real streamed turn — no interception (FR-2).
- [ ] `message.user` for an intercepted command echoes the request `blockId` and clears the queued chip (FR-4).
- [ ] Replaying `command.started`/`command.output` events is idempotent per conversation-view's upsert rules (FR-20).
- [ ] Finalized cards survive an app relaunch via the durable transcript; a mid-probe pending card does not (FR-24).
- [ ] The meter-line and context-tokens parse functions match the probed CLI output verbatim and fall back gracefully on non-matching input (unit tests, §5 parse rules).

## Remediation

### Round 1 — 2026-07-22 (merged review verdict: SHIP, findings to clear before /ship)

- [x] MEDIUM · src-tauri/src/session.rs:1817 · quality · `skills_run` routes through `do_send` and now gets intercepted for skills named `usage|cost|model|status|help` — add a passthrough flag to `do_send` (or a `do_send_passthrough` sibling) that skips the intercept branch, and call it from `skills_run` (spec §2 non-goal: custom skills pass through byte-for-byte).
- [x] MEDIUM · src-tauri/src/session.rs:3190-3197 · spec-violation · `/model` with a cold model cache runs `fetch_live_models()` synchronously (5s connect + 10s read timeout) inside the intercepted send — FR-12/13 require instant. When the cache is empty return `catalog()` (tier-alias fallback) directly and kick `refresh_models()` on a background thread; never fetch synchronously on this path.
- [x] MEDIUM · src/conversation-blocks.test.ts:35-121 · quality · the 8 extracted legacy reducer actions (`seed`, `optimisticUser`, `msgUser`, `delta`, `assistantDone`, `toolStart`, `toolDone`, `remove`) have zero tests, so nothing guards behavior-identity of the extraction. Add reducer tests: replay idempotence for toolStart/msgUser/assistantDone/toolDone, delta open-then-append and unseen-insert, optimisticUser duplicate guard + queued flag, remove of unknown id.
- [x] LOW · src-tauri/src/session.rs:3373-3413 · quality · watchdog/finish race: an answer fully read just before the 30s mark can be discarded for the timeout notice — check `timed_out` only in the no-parsed-answer arm (prefer the answer when one parsed).
- [x] LOW · src/conversation-blocks.ts:182 · quality · `await a.switchModel(...)` unhandled on transport-level rejection — wrap in try/catch inside `switchModelFromCard` and route the caught message through the existing `setError` + 4s `schedule` path.
- [x] LOW · src/CommandCard.tsx:55 · quality · `text` card with `command: ''` renders an empty header label — fall back to `'OUTPUT'` when the resolved label is empty.
- [x] LOW · src/conversation-blocks.ts:180-187 · quality · stale transient error survives a subsequent successful switch inside the 4s window — call `a.setError(null)` at the start of every attempt (adjust the ok:true test to assert only-null calls).
- [x] LOW · src-tauri/src/session.rs:3201-3213 · quality · mid-turn probe card may restore below later blocks after relaunch (append-on-finalize) — reviewer assessed as consistent with the existing tool-block design; FR-24 satisfied; **no change required** (optional index only if hydration order ever matters).

### Round 2 — 2026-07-22 (scoped re-review of Round 1 fixes: SHIP / SHIP)

- [x] LOW · src-tauri/src/session.rs:2405-2407 · quality · `do_send`'s doc comment was stranded above the `SendSource` enum by the fix insertion — moved back above `fn do_send` (lead-applied; comment-only).
