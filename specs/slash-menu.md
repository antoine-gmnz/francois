---
id: slash-menu
title: Slash menu — "/" command autocomplete in the SESSION composer
status: shipped
created: 2026-07-22
depends_on: [session-engine, conversation-view, interactive-commands, skills-panel]
---

# Slash menu — "/" command autocomplete in the SESSION composer

## 1. Summary

Typing `/` in the SESSION composer opens a Claude Code-style autocomplete popup: every command the
session can actually run, filtered as you type, keyboard-navigable, Enter to run, Tab to complete.
Today the commands exist but are invisible — Francois intercepts five (`/usage`, `/cost`, `/model`,
`/status`, `/help`), the CLI handles the rest as pass-through turns, and skills are invocable as
`/<name>` — yet the user must know each name by heart. The core gains one merged, deduplicated
**per-session command registry** built from three sources: the intercepted built-ins (static), the
skills/commands already discovered on disk (`skills_list` machinery), and the CLI's own
`slash_commands` array from the stream-json `init` event — which the reader currently discards. The
frontend renders it as a popup anchored to the composer, reusing the palette's subsequence filter.

## 2. Goals & non-goals

**Goals**

- One IPC-served registry per session: name + description + source, deduplicated, stable order.
- Capture `slash_commands` from every `init` event so the registry reflects the session's real CLI
  (plugins, user commands, built-ins like `/compact`) after the first turn, pushed by event.
- Popup with filter-as-you-type, ↑/↓ selection, Enter = run, Tab = complete (for arguments), Esc =
  dismiss, mouse hover/click parity.
- Zero behavior change to what sending a command does — the menu only helps compose the same text
  the user could have typed blind (intercepts, queueing, pass-through all untouched).

**Non-goals**

- **Argument hints / per-command argument completion** (e.g. model ids after `/model`) — future.
- **Executing palette actions** from the slash menu — the ⌘K palette remains its own surface; no
  cross-registration either way.
- **Command history / recency ranking** — the filter rank is the palette's existing deterministic
  subsequence rank, nothing learned.
- **Editing the registry** (enabling plugins, installing skills) — that stays in the skills panel;
  the menu lists only what is runnable now (`installed: true`).
- **A menu in the DIFF/SHELL tabs or the palette input** — SESSION composer only.

## 3. User stories / flows

1. **Discover.** User types `/`. A popup rises above the composer listing every available command —
   name, dim description, dim source tag — first 8 visible, rest scroll. Typing `us` narrows to
   `/usage` (subsequence match). `↓`/`↑` move the selection (wrapping); the list scrolls to keep it
   visible.
2. **Run.** With `/usage` selected, Enter replaces the composer text with `/usage` and sends it
   immediately — identical to having typed it. The popup closes; the composer clears (normal send).
3. **Complete for arguments.** User types `/mo`, presses Tab: composer becomes `/model ` (trailing
   space), popup closes (token ended), user types `claude-haiku-4-5` and presses Enter — a normal
   send of `/model claude-haiku-4-5`.
4. **Dismiss.** Esc closes the popup and leaves the input as typed; the very next Enter sends the
   raw text. The popup reopens only when the slash token changes (typing/deleting), not on focus.
5. **Mouse.** Hovering a row selects it; clicking runs it (flow 2). Clicking outside the popup
   dismisses it (flow 4).
6. **No match.** `/zzz` filters to nothing → popup hides; Enter sends `/zzz` as typed and the CLI
   answers as it does today (pass-through).
7. **Fresh session.** Before the first turn the menu shows built-ins + installed skills. After the
   first turn's `init` arrives the CLI's own commands (e.g. `/compact`, `/clear`, plugin commands)
   appear — the open popup refreshes in place via the event.
8. **Pending question.** A parked question (session-questions) doesn't disable the composer, so the
   menu works normally; whatever is sent queues per the existing rules.

## 4. Functional requirements

**Registry (core)**

- **FR-1**: new IPC `francois:session:listCommands` (§5.1) returns the session's merged registry.
  Sources, in dedup precedence (first occurrence of a name wins):
  1. **builtin** — exactly the `help_entries()` list of `interactive-commands` (name +
     description verbatim);
  2. **skill** — `discover_skills(cwd)` entries with `installed: true`, any kind (skills and
     command files are both invoked as `/<name>`); description from `SkillInfo.description`;
  3. **cli** — the captured `slash_commands` names (FR-2), description `""`.
- **FR-2**: the reader's `init` handling captures the event's `slash_commands` string array into
  the session (in-memory, replacing the previous capture; absent array → no change). When the
  captured set **changes**, the core emits one `session.commands` event carrying the **merged**
  registry (FR-1's output). No event when unchanged.
- **FR-3**: registry order: builtins first (help order), then skills (their existing discovery
  order), then cli names (init order), duplicates removed by name. Names are stored without the
  leading `/`; rendering adds it.
- **FR-4**: `listCommands` never blocks on a probe or a turn: it reads state + does the disk scan
  `skills_list` already does. Unknown session → `SESSION_NOT_FOUND`.

**Popup (frontend)**

- **FR-5**: the popup is eligible iff the composer text matches `^/\S*$` (leading slash, no
  whitespace yet — one token). It renders iff eligible **and** ≥ 1 entry matches **and** not
  dismissed (FR-9). It anchors above the composer input bar, never covering the input itself.
- **FR-6**: filtering uses the palette's `filterRank` subsequence mechanics against the token after
  `/`; empty token = full registry in FR-3 order. Row layout: `/name` + description (dim) + source
  tag (dim, right-aligned: `francois` for builtin, the skill's scope for skill, `cli` for cli).
- **FR-7**: selection: first row on open/refilter; ↑/↓ wrap; hover selects; the selected row stays
  scrolled into view. The list shows at most 8 rows' height, then scrolls.
- **FR-8**: while the popup is rendered: **Enter** replaces the input with `/name` of the selection
  and invokes the existing send path immediately; **Tab** replaces the input with `/name ` (one
  trailing space) and closes the popup (the text no longer matches FR-5); **click** = Enter.
  Enter/Tab must not reach the textarea's default handlers. All other keys behave normally
  (characters keep filtering).
- **FR-9**: **Esc** dismisses; dismissal holds until the slash token changes (edit/delete), and is
  also cleared on send or session switch. Clicking outside the popup dismisses identically. Esc
  with no popup behaves as before.
- **FR-10**: on mount and on session switch the frontend seeds via `listCommands`; it applies
  `session.commands` events for the visible session (idempotent replace). An open popup refilters
  in place on refresh; the selection resets to the first row only if the previously selected name
  vanished.
- **FR-11**: registry entries render verbatim — no relabelling, no description synthesis, no
  filtering beyond FR-6. A menu-initiated send is byte-identical to a typed one (no metadata rides
  along).
- **FR-12**: when the composer is disabled (session `done`/`error`) the popup never renders.

## 5. API contract

Contract file: `contract/slash-menu.ts`. `SlashCommandInfo` is needed by the `SessionEvent` union,
so it is **declared in `contract/common.ts`** (same placement rule as `SessionQuestion`) and
re-exported by the feature contract.

### 5.1 Channels

| logical channel | direction | request | success `data` | error codes |
|---|---|---|---|---|
| `francois:session:listCommands` | frontend → core (`invoke`) | `{ sessionId: SessionId }` | `SlashCommandInfo[]` | `SESSION_NOT_FOUND` |
| `francois:session:event` | core → frontend (`listen`) | — | new member `session.commands` (§5.3) | — |

Physical binding: `invoke('session_list_commands', { sessionId })` → `Promise<Result<SlashCommandInfo[]>>`.

### 5.2 Types

```ts
// contract/common.ts (shared vocabulary, consumed by the SessionEvent union):
export type SlashCommandSource = 'builtin' | 'skill' | 'cli';

export interface SlashCommandInfo {
  name: string; // without the leading '/'; rendering adds it
  description: string; // '' when the source provides none (cli)
  source: SlashCommandSource;
  /** skill entries only: the SkillInfo scope, shown as the source tag. */
  scope?: 'project' | 'user' | 'plugin';
}
```

```ts
// contract/slash-menu.ts:
import type { Result, SessionId } from './common';
export type { SlashCommandInfo, SlashCommandSource } from './common';

export interface ListCommandsRequest {
  sessionId: SessionId;
}
// resolves Result<SlashCommandInfo[]>; error: SESSION_NOT_FOUND
```

### 5.3 `contract/common.ts` amendment — `SessionEvent`

```ts
  | { type: 'session.commands'; sessionId: SessionId; commands: SlashCommandInfo[] } // slash-menu FR-2: merged registry after an init changed the cli set
```

No new `ErrorCode` values.

## 6. Data & state

**Core**: `Session` gains `cli_commands: Vec<String>` (in-memory; empty until the first init;
not persisted — a fresh app relearns it on the next turn, and builtins+skills cover the gap).
Merging is a pure function (`merge_commands(builtins, skills, cli)`) unit-tested in isolation.

**Frontend**: a `commandsBySession: Record<SessionId, SlashCommandInfo[]>` cache (store or
module-level like `paletteData`), seeded by FR-10. Popup state (open/dismissed/selection/filter) is
component-local to the composer. Pure logic (trigger detection, filter, completion text, selection
movement) lives in `src/slash-menu.ts` for vitest.

## 7. Edge cases & errors

| # | situation | behavior |
|---|---|---|
| 1 | `/` alone | Full registry, first row selected (FR-6). |
| 2 | Text `hello /wo` | Not eligible (no leading slash) — never a popup mid-text (FR-5). |
| 3 | `/model x` (space typed) | Token ended → popup hidden; input sends as typed (FR-5). |
| 4 | Duplicate names across sources (skill `usage`, cli `usage`) | One row — builtin wins, then skill, then cli (FR-1/3). |
| 5 | `init` with unchanged `slash_commands` | No event (FR-2). |
| 6 | `listCommands` while a turn is running | Answers from state + disk scan; never touches the turn (FR-4). |
| 7 | Event for a non-visible session | Cache updated; no UI effect until that session is shown (FR-10). |
| 8 | Selected name disappears on refresh (plugin disabled) | Selection resets to first row (FR-10). |
| 9 | Composer disabled (done/error) | No popup (FR-12); text can't be typed anyway. |
| 10 | Popup open, user clicks a transcript link | Outside click → dismiss, no send (FR-9). |
| 11 | Registry empty (no session dirs, no init yet — builtins always exist) | Unreachable: builtins are static; popup shows them. |
| 12 | WSL session | Identical — skills scan and init capture are runtime-agnostic (discovery already handles the session cwd). |

## 8. Design brief

No slash-menu treatment exists in the mock (`Claude Terminal.dc.html`); the popup inherits the
⌘K palette's row language, shrunk to an anchored dropdown. JetBrains Mono throughout; tokens from
`src/styles.css`.

### Components & states

1. **Popup container**: absolutely positioned above the composer input bar, same width as the
   input; `background:#12141a; border:1px solid #24262d; border-radius:4px; box-shadow:0 -4px 16px
   rgba(0,0,0,.35); max-height:224px; overflow-y:auto; padding:4px 0;`. Appears/disappears
   instantly — **no motion** (`src/styles.css` header rule: no transitions in always-reachable
   chrome).
2. **Row**: `display:flex; gap:8px; align-items:baseline; padding:3px 10px; cursor:pointer;
   font-size:11.5px;` — name `/usage` `color:#dfe2e8;`, description `color:#868a93; overflow:
   hidden; text-overflow:ellipsis; white-space:nowrap; flex:1;`, source tag `color:#565a63;
   font-size:9.5px; flex:0 0 auto;`. Selected row: `background:#1a1d24;` and name
   `color:#c8a15a;`. ~8 rows fit the 224px max-height.
3. **States**: hidden / open / open-scrolled; row: normal / selected (hover = selected). No
   loading state — the registry is synchronous from cache; a refresh swaps rows in place.

### Interactions

Keyboard per FR-8/9; wheel scrolls the list without moving selection; the composer keeps focus the
whole time (the popup is display-only chrome — it never takes focus, so the pane focus model and
`1`–`5` keys are untouched).

### Motion

**None.** Instant open/close/swap.

## 9. Acceptance criteria

- [ ] `session_list_commands` returns builtins+skills before any turn, with builtin descriptions
      verbatim from `help_entries()` (FR-1) — cargo test on the pure merge + command.
- [ ] Dedup precedence builtin > skill > cli, order per FR-3 — cargo test.
- [ ] Feeding the reader an `init` with `slash_commands` captures it and emits one
      `session.commands` with the merged registry; an identical second init emits nothing (FR-2).
- [ ] `session.commands` serde shape matches §5.3 exactly; `scope` omitted when absent.
- [ ] Trigger predicate: `/` and `/mo` eligible; ``, `hello /x`, `/model x` not (FR-5) — vitest.
- [ ] Filtering matches palette subsequence semantics; empty token lists all (FR-6) — vitest.
- [ ] Selection wraps both directions; refresh keeps the selected name when it survives, resets
      otherwise (FR-7, FR-10) — vitest.
- [ ] Enter sends the selected `/name` through the normal send path; Tab completes to `/name ` and
      closes; Esc dismisses until the token changes; outside click dismisses (FR-8, FR-9) — vitest
      on the pure reducer + manual check.
- [ ] A menu-run command produces byte-identical send text to typing it (FR-11).
- [ ] No popup when composer disabled (FR-12).
- [ ] No `@keyframes`/`animation`/`transition` in the popup CSS (§8).

## Remediation

### Round 1 — `/review` 2026-07-23 (verdict SHIP · 0 critical · 0 security · 5 medium · 10 low)

Two review agents (core + frontend) both returned SHIP. All findings are quality/coverage —
non-blocking — shipped **deferred, tracked**. The notable ones:

- [ ] MEDIUM · `src/ConversationView.tsx` seed effect · correctness · Seed-vs-event race: the
      mount-time `sessionListCommands` seed can overwrite a newer `session.commands` event that
      arrived while the invoke was in flight, stranding the frontend on the pre-`init` registry until
      the next remount. Guard the seed with a `cmdEventSeenRef` set in the event branch.
- [ ] MEDIUM · `src/ConversationView.tsx` selection effect · quality · FR-7's "first row on refilter"
      is applied in a passive `useEffect`, so the frame that renders the new `filtered` list still
      highlights the stale index (or nothing, when the list shrank). Use `useLayoutEffect` or derive
      a safe index during render.
- [ ] MEDIUM · `src/ConversationView.tsx` + `src/styles.css` · quality · The popup and the send-error
      banner share the same absolutely-positioned box (`bottom:100%; left/right:14px`), so a failed
      menu-initiated send (which restores `/usage` and re-opens the popup) stacks them. Wrap both in
      one flex column container.
- [ ] MEDIUM · `src-tauri/src/session.rs` `session_list_commands` · test-coverage · The command has
      no test (needs a `State<Engine>` seam). Extract `list_commands_for(&Engine, &str)` and test
      unknown-id → `SESSION_NOT_FOUND` and the builtins-lead happy path.
- [ ] MEDIUM · `src-tauri/src/session.rs` reader `init` arm · test-coverage · The
      capture→merge→emit-on-change glue is untested (only its halves are). Extract an AppHandle-free
      `init_command_capture(...) -> Option<Vec<String>>` and test absent / unchanged / changed /
      unknown-session.
- [ ] LOW · `src-tauri/src/session.rs` dedup · quality · `seen` is case-sensitive while
      `parse_command` lowercases the token, so `Status.md` renders a second row whose send is
      swallowed by the builtin intercept (edge #4 intent). Fold the dedup key to lowercase, keep the
      verbatim name in the payload.
- [ ] LOW · `src-tauri/src/session.rs` `parse_init_slash_commands` · quality · Doesn't trim or reject
      empty entries — `""`/`"/"` yield a bare `/` row that matches every filter. Trim, strip `/`,
      drop empties.
- [ ] LOW · `src-tauri/src/session.rs` init-arm scan · quality · `discover_skills` disk walk runs
      inline on the reader thread, stalling NDJSON consumption at turn start (only when the cli set
      changed). Consider moving the merge+emit off the loop.
- [ ] LOW · `src/slash-menu.ts` `commandsBySession` · quality · Never pruned on `session_remove`;
      unbounded (small) growth and a recycled id reads a stale registry. Add
      `clearSessionCommands(sessionId)`.
- [ ] LOW · `src/SlashMenu.tsx` outside-click · quality · The capture-phase dismissal also fires for
      clicks inside the composer `<textarea>` (repositioning the caret closes the menu). Skip when the
      target is the composer input.
- [ ] LOW · `src/api.ts` / `ConversationView.tsx` · quality · `sessionListCommands(...)` chain has no
      `.catch`; a transport-level reject (renamed command, deserialize mismatch) is an unhandled
      rejection + silently empty menu. Add `.catch`. (Pre-existing convention gap — `getTranscript`
      is the same.)
- [ ] LOW · `src/styles.css` `.slash-menu{max-height:224px}` · spec-conflict · 224px shows ~10 rows,
      not FR-7's 8. Pick one: `max-height:178px` or amend §8's px figure (not both).
- [ ] LOW · `src/styles.css` `.slash-name` · quality · No shrink/overflow guard; a very long
      plugin/skill command name pushes the source tag out of the popup. Add
      `flex:0 1 auto; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;`.
- [ ] LOW · `src-tauri/src/session.rs` `SlashCommandInfo.source: &'static str` · quality · No
      compile-time tie to the contract union; a typo only the serde test would catch. Optionally make
      it a `#[serde(rename_all="lowercase")]` enum (weigh against the file's `String`-for-unions
      precedent).

> **Spec wording note (no code change):** FR-2/§7#5 say the `session.commands` emit triggers "when the
> captured **set** changes"; the implementation compares the ordered `Vec`, so a same-names-different-
> order `init` re-emits. This is the **correct** behavior — FR-3 pins the cli block's order to init
> order, so a reorder genuinely changes the FR-1 output, and FR-10 makes the event an idempotent
> replace. Amend FR-2 to read "when the captured **list** (names or order) changes" on the next spec
> pass so it isn't re-litigated.
