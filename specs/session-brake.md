---
id: session-brake
title: Session brake — stop turn & worktree isolation
status: frozen
created: 2026-07-19
depends_on: [session-engine, conversation-view, sessions-sidebar, durable-sessions]
---

# Session brake — stop turn & worktree isolation

## 1. Summary

Two safety controls for long-lived, unattended Claude Code sessions, shipped
together because both are "brakes" on a running session. **(1) Stop turn** — a
kill switch that halts the currently streaming turn without destroying the
session: it reuses the engine's existing interrupt mechanism (set
`TurnHandle.interrupted`, kill the turn's `claude` child) so `run_reader`'s
`was_interrupted` path finishes the turn as `idle` with the transcript preserved.
A **Stop** control (button + Esc hotkey) appears in the conversation view only
while the session is `running`, and the same `francois:session:stop` command is
referenceable by the fleet board for a per-session stop. **(2) Worktree
isolation** — an optional flag at session creation that runs the session in a
dedicated `git worktree` on its own branch, so the session's edits never touch
the main working tree and are trivial to review or discard. When isolation is
requested and the cwd is a git repo, the core adds a worktree under the app data
dir, points the session's cwd at it, records the branch/path on the session, and
best-effort removes the worktree when the session is removed (leaving the branch
for review).

## 2. Goals & non-goals

- **Goals**:
  - Add `francois:session:stop` → `session_stop(sessionId)` that aborts the
    in-flight turn and lands the session `idle`, history intact, reusing the
    `run_reader` `was_interrupted` completion path (no `session.error`).
  - Surface a **Stop** control (button + hotkey) in the SESSION tab, visible only
    while `status === 'running'`, that the fleet board can also invoke.
  - Add an optional `isolate` flag to session creation that runs the session in a
    dedicated git worktree + branch under `<app_data>/worktrees/<sessionId>`.
  - Expose the worktree branch + path on `SessionMeta` so the UI can indicate the
    session is isolated; persist it so it survives restart (durable-sessions).
  - Best-effort cleanup of the worktree on `session_remove`, keeping the branch.
  - Reuse existing `ErrorCode`s only (`SESSION_NOT_FOUND`, `SESSION_NOT_RUNNING`,
    `NOT_A_GIT_REPO`, `GIT_ERROR`) — no new error codes, no new events.
- **Non-goals** (elsewhere / follow-up):
  - Fleet status board and its per-session controls — `fleet-board` (sibling
    spec); this spec only makes `session_stop` reusable by it.
  - Desktop notifications on stop / needs-input — `notifications` (sibling spec).
  - Pausing/resuming a turn, or a soft "finish current tool then stop" — Stop is a
    hard kill of the current turn only.
  - Committing, merging, rebasing, deleting, or diffing the isolation branch from
    Francois; managing worktrees created outside Francois. (The DIFF tab already
    renders the worktree's own diff because it watches the session cwd.)
  - Retroactively isolating an existing non-isolated session, or de-isolating an
    isolated one.
  - Consolidating/removing the pre-existing `session_interrupt` command (see §5
    and Open questions).

## 3. User stories / flows

1. **Stop a runaway turn.** A session is `running` — the assistant is streaming or
   a tool is executing. A **Stop** control is visible in the conversation input
   bar. The user clicks it (or presses **Esc** with the SESSION tab focused and no
   modal/palette open). The turn's `claude` child is killed; any open block is
   closed (`assistant.done` for text, `tool.done` with `meta: "interrupted"` for a
   tool); the session transitions `running → idle`; the transcript keeps every
   finalized block. The Stop control disappears. The user can immediately send a
   new message.
2. **Stop clears queued follow-ups.** The user had queued two follow-up messages
   while the turn ran (queue badge on those blocks). Pressing Stop aborts the
   current turn **and** discards the pending queue, so the session lands `idle`
   and nothing else auto-starts. (This is the kill-switch contract; it differs
   from a plain interrupt — see §4/§7 and Open questions.)
3. **Stop when nothing is running (defensive).** The Stop control is only rendered
   while `running`, so this is a race (e.g. the turn just finished). If a stop
   still reaches the core for a non-running session it resolves `ok:false` with
   `SESSION_NOT_RUNNING`; the UI ignores it silently (the session is already
   idle, which is the desired end state).
4. **Create an isolated session.** In the new-session modal the user picks a repo
   directory, then toggles **Isolate** on ("run in a dedicated git worktree"). On
   Create, the core verifies the cwd is a git repo, runs `git worktree add
   <app_data>/worktrees/<id> -b francois/<name>-<shortid>`, and creates the
   session with its cwd set to that worktree. The session header shows a branch
   badge (e.g. `⑂ francois/acme-api-1a2b3c4d`). Everything the session edits lands
   in the worktree/branch; the user's main checkout is untouched.
5. **Isolate requested on a non-repo.** The user toggles Isolate but the chosen
   directory is not inside a git repo. Create fails with `NOT_A_GIT_REPO`; the
   modal shows the error inline and no session is created. The user either turns
   Isolate off or picks a repo.
6. **Review then discard an isolated session.** When done, the user removes the
   isolated session. The core best-effort runs `git worktree remove --force` +
   `git worktree prune`, deleting the worktree checkout but **leaving the branch**
   (which holds the commits) so the user can inspect/merge/delete it later from
   their own git tooling.

## 4. Functional requirements

**Stop turn — backend**

- **FR-1 (command).** `francois:session:stop` → command `session_stop(sessionId)`
  resolves `Result<null>`. It never rejects across the bridge (§5).
- **FR-2 (unknown session).** `session_stop` on an unknown `sessionId` →
  `ok:false` `SESSION_NOT_FOUND`.
- **FR-3 (not running).** `session_stop` when `status !== 'running'` (`idle`,
  `done`, or `error`) → `ok:false` `SESSION_NOT_RUNNING`; nothing is killed and no
  event is emitted. (This is the deliberate difference from the existing internal
  `session_interrupt`, which is a silent no-op in the same state — see §5.)
- **FR-4 (kill mechanism).** `session_stop` when `status === 'running'` sets the
  session's `TurnHandle.interrupted` flag to `true` (`Ordering::SeqCst`) and calls
  `kill()` on the turn's shared `Child`, exactly as `session_interrupt` /
  `session_remove` / `kill_all` already do. It then resolves `ok:true` with
  `null`. It does **not** itself emit events or mutate `status`; completion is
  owned by the turn's reader thread (FR-6).
- **FR-5 (clear queue).** Before killing, `session_stop` clears the session's
  pending send `queue` (drops all queued `(blockId, text)` entries) so that
  `finish_turn` finds an empty queue and routes the session to `idle` rather than
  auto-starting a queued turn. A cleared queued block was never sent, so no
  `message.user`/removal event is owed for it (the client's optimistic queued
  blocks are reconciled by the normal transcript, which never contained them).
- **FR-6 (reader completion — reuse `was_interrupted`).** The turn's `run_reader`
  observes the killed child, reads `was_interrupted = true`, closes any open block
  (`assistant.done`, or `tool.done` with `meta: "interrupted"`), emits
  `context.usage` if a usage figure is available, and calls
  `finish_turn(errored=false)`. With the queue empty (FR-5) this emits
  `session.status: 'idle'`. No `session.error` is emitted — a stop is a normal,
  non-error completion. This path is the engine's existing interrupt behavior;
  `session_stop` adds no new completion code.
- **FR-7 (resume-retry window).** If the stop lands during a rejected-`--resume`
  retry (durable-sessions FR-8/9), `was_interrupted = true` suppresses the
  resume-fail re-run (`is_resume_fail` already requires `!was_interrupted`), so a
  stopped turn is never transparently re-run. The session lands `idle`.
- **FR-8 (idempotent under races).** A second `session_stop` (or a `session_stop`
  arriving after the turn already ended) sees `status !== 'running'` and returns
  `SESSION_NOT_RUNNING` (FR-3); killing an already-exited child is harmless.

**Stop turn — frontend (conversation-view)**

- **FR-9 (Stop control visibility).** The conversation view renders a **Stop**
  control iff the displayed session's live `status === 'running'`. It is hidden
  for `idle`/`done`/`error`. Visibility tracks the same `status` state the view
  already maintains from `session.status`/`session.meta` events.
- **FR-10 (Stop action).** Activating Stop calls `session_stop(sessionId)`. On
  `ok:true` no local mutation is needed — the incoming `session.status: 'idle'`
  (and any block-closure events) update the view. On `ok:false`
  `SESSION_NOT_RUNNING` the view ignores it (already idle); any other error is
  shown via the existing transient send-error affordance.
- **FR-11 (hotkey).** With the SESSION tab active, the conversation focused, the
  session `running`, and no modal or command palette open, **Esc** triggers Stop.
  When those conditions are not all met, the Esc handler does nothing and does not
  `preventDefault`, so modal/palette Esc handling is unaffected.

**Worktree isolation — backend**

- **FR-12 (isolate param).** `francois:session:create` accepts an optional
  `isolate?: boolean` (default `false`/absent → today's non-isolated behavior,
  unchanged). Mirrored in `NewSessionRequest` and `SessionCreateInput` (§5).
- **FR-13 (repo precondition).** When `isolate === true`, the core first verifies
  the cwd is inside a git working tree (`git rev-parse
  --is-inside-work-tree` == `true`). If not → `ok:false` `NOT_A_GIT_REPO` and **no
  session is created** (nothing persisted, no worktree, no watcher).
- **FR-14 (worktree creation).** On a valid repo the core resolves the repo root
  (`git rev-parse --show-toplevel`) and runs, as an argv array (never a shell
  string): `git worktree add <worktreePath> -b <branch>` from the repo root, where
  - `worktreePath = <app_data_dir>/worktrees/<sessionId>` (absolute; `sessionId`
    is the freshly minted uuid and passes the existing `valid_session_id` guard,
    so the path cannot escape the worktrees dir and cannot pre-exist);
  - `branch = francois/<slug(name)>-<shortId>` with `slug(name)` = the session
    name lowercased, every run of non-`[a-z0-9]` chars replaced by a single `-`,
    leading/trailing `-` trimmed, empty → `session`, capped at 32 chars; and
    `shortId` = the first 8 chars of `sessionId` (the uuid's first group). This
    yields a valid, collision-resistant git ref.
- **FR-15 (cwd redirection).** On successful worktree add the session is created
  with `cwd = worktreePath` (so turns, the diff watcher, and the SHELL/DIFF tabs
  all operate inside the worktree) and `isolation = { branch, worktreePath }`
  recorded on the session (internally also the source repo root — FR-19).
- **FR-16 (creation failure).** If `git worktree add` exits non-zero (unborn HEAD
  / empty repo, branch or path collision, permission, etc.) → `ok:false`
  `GIT_ERROR` with git's trimmed stderr in the message, and **no session is
  created**. The claude-binary check (existing FR-9 of session-engine) runs
  **before** worktree creation so a missing/broken CLI never leaves an orphan
  worktree.
- **FR-17 (meta exposure).** `SessionMeta` carries `isolation?: SessionIsolation`
  (`{ branch, worktreePath }`), present iff the session is isolated. It is emitted
  in every `session.meta` for that session and returned by `session_list` /
  `session_create`.
- **FR-18 (persistence).** The persisted session record (durable-sessions
  `sessions.json`) gains the isolation fields (branch, worktree path, source repo
  root). On reload the session is restored isolated, with its cwd already equal to
  the worktree path (persisted `cwd`), so the diff watcher and transcript resume
  against the worktree with no special-casing. Records without isolation fields
  load as non-isolated (backward compatible).
- **FR-19 (cleanup on remove).** `session_remove` for an isolated session, after
  its existing teardown (interrupt in-flight turn, delete transcript, unwatch),
  best-effort removes the worktree from the recorded source repo root:
  `git worktree remove --force <worktreePath>` then `git worktree prune`. If
  `worktree remove` fails, fall back to `std::fs::remove_dir_all(worktreePath)`
  then `git worktree prune`. **The branch is never deleted** (it holds the work).
  Any failure here is logged and does not fail the remove (the session is still
  removed and `session.removed` still emitted).
- **FR-20 (process safety).** Every git invocation uses an argv array via a
  `Command::new("git")` runner (mirroring `diff.rs::git`), with `stdin` null,
  captured stdout/stderr/exit-code, and `CREATE_NO_WINDOW` on Windows (no console
  flash). No cwd, name, branch, or path is ever interpolated into a shell string.

**Worktree isolation — frontend**

- **FR-21 (isolate toggle).** The new-session modal (`NewSessionModal`) shows an
  **Isolate** toggle (default off). Its value flows into the `NewSessionRequest`
  as `isolate`. On a `NOT_A_GIT_REPO` or `GIT_ERROR` create failure the modal
  shows the error inline via the existing `submitError` affordance and stays open.
- **FR-22 (isolation indicator).** When a session's `meta.isolation` is present,
  the SESSION tab header shows a branch badge (branch name, accent-colored, with a
  branch glyph). Non-isolated sessions show no badge (today's layout unchanged).

## 5. API contract

Lives in `contract/session-brake.ts` (new), with small additions to three
existing contract files. Shared types are imported from `contract/common.ts` and
never redefined. Physical Tauri binding per PIPELINE.md: request
`francois:session:stop` → command `session_stop`; the isolation flag rides the
existing `francois:session:create` → `session_create`. **No new events. No new
`ErrorCode`s** — `SESSION_NOT_FOUND`, `SESSION_NOT_RUNNING`, `NOT_A_GIT_REPO`,
`GIT_ERROR` are already in the `ErrorCode` union in `common.ts`.

### 5.1 New channel — `francois:session:stop`

| Channel | Command | Request | `Result<T>` data | Error codes |
|---|---|---|---|---|
| `francois:session:stop` | `session_stop` | `SessionStopInput` | `null` | `SESSION_NOT_FOUND`, `SESSION_NOT_RUNNING` |

Semantics: FR-1..FR-8. `ok:true`/`data:null` = the running turn was interrupted
and the queue cleared; the session heads to `idle` via the reader thread. It
emits no events of its own (completion events come from `run_reader`/`finish_turn`
on `francois://session/event`, which every consumer already handles).

> Relationship to the existing `session_interrupt`: the core already has
> `session_interrupt(sessionId)` (registered in `main.rs`, contract in
> `session-engine.ts`) that performs the identical interrupt+kill but is a silent
> **no-op** returning `ok:true`/`null` when the session is not running, and has no
> frontend wrapper or UI. `session_stop` is the user-facing kill switch with the
> stricter `SESSION_NOT_RUNNING` contract and queue-clear (FR-3/FR-5). Implement
> `session_stop` as its own command reusing the same interrupt primitive; leave
> `session_interrupt` in place for this feature. Whether to later fold the two
> together is an Open question, not a blocker.

### 5.2 `contract/session-brake.ts` (author verbatim)

```ts
// contract/session-brake.ts — session-brake (stop turn + worktree isolation).
// Authored from specs/session-brake.md §5. Imports shared vocabulary from
// common.ts and never redefines it.
//
// Physical Tauri binding (PIPELINE.md):
//   francois:session:stop → command `session_stop` (Result<null>, never rejects).
//   Worktree isolation has NO channel of its own: it rides francois:session:create
//   via the new optional `isolate` flag (SessionCreateInput / NewSessionRequest),
//   and surfaces on SessionMeta.isolation (all in common.ts / session-engine.ts /
//   sessions-sidebar.ts — see §5.3/§5.4). No new events. No new ErrorCode.

import type { SessionId, Result, SessionIsolation } from './common';

// ---------- francois:session:stop ----------

/** francois:session:stop — frontend -> core. Interrupt the running turn's claude
 *  child WITHOUT removing the session; the turn finishes `idle`, transcript kept. */
export interface SessionStopInput {
  sessionId: SessionId;
}
// invoke('session_stop', req: SessionStopInput): Promise<Result<null>>
//   ok:true  data:null  — turn interrupted + queue cleared; session heads to idle.
//   ok:false SESSION_NOT_FOUND    — no such session.
//   ok:false SESSION_NOT_RUNNING  — session status !== 'running' (nothing to stop).
export type SessionStopResponse = Result<null>;

// ---------- worktree isolation (types added to common.ts, re-exported for callers) ----------
// See §5.3: SessionIsolation + SessionMeta.isolation live in common.ts.
// See §5.4: SessionCreateInput.isolate (session-engine.ts) and
//           NewSessionRequest.isolate (sessions-sidebar.ts).
export type { SessionIsolation };
```

### 5.3 Additions to `contract/common.ts`

```ts
// ---------- session isolation (session-brake) ----------

/** A session running in a dedicated git worktree on its own branch (session-brake). */
export interface SessionIsolation {
  /** the branch checked out in the worktree, e.g. 'francois/acme-api-1a2b3c4d'. */
  branch: string;
  /** absolute path of the worktree; also the session's `cwd` when isolated. */
  worktreePath: string;
}

// SessionMeta gains ONE optional field (append; do not reorder existing fields):
//   isolation?: SessionIsolation; // present iff the session runs in a git worktree
```

`SessionMeta` after the edit (only the new line is added):

```ts
export interface SessionMeta {
  id: SessionId;
  name: string;
  cwd: string;                // === isolation.worktreePath when isolated
  model: ModelInfo;
  status: SessionStatus;
  contextUsedTokens: number;
  contextLimitTokens: number;
  startedAt: number;
  lastActivityAt: number;
  errorMessage?: string;
  isolation?: SessionIsolation; // NEW (session-brake) — absent = non-isolated
}
```

### 5.4 Additions to `session-engine.ts` and `sessions-sidebar.ts`

```ts
// contract/session-engine.ts — SessionCreateInput gains one optional field:
export interface SessionCreateInput {
  cwd: string;
  name?: string;
  modelId?: string;
  effort?: string;
  isolate?: boolean; // NEW (session-brake) — run in a dedicated git worktree; default false
}

// contract/sessions-sidebar.ts — NewSessionRequest gains the same field:
export interface NewSessionRequest {
  cwd: string;
  name: string;
  modelId: string;
  effort?: string;
  isolate?: boolean; // NEW (session-brake) — forwarded verbatim to session_create
}
```

### 5.5 Rust core signatures (mirrors)

```rust
// session_stop — new command (register in main.rs invoke_handler alongside session_interrupt).
#[tauri::command]
pub fn session_stop(app: AppHandle, engine: State<'_, Engine>, session_id: String)
    -> IpcResult<Option<()>>;
// SESSION_NOT_FOUND if absent; SESSION_NOT_RUNNING if status != "running";
// else clear queue, set TurnHandle.interrupted, kill child, ok(None). (FR-2..FR-6)

// session_create — extend the existing signature with one optional arg:
pub fn session_create(
    app: AppHandle, engine: State<'_, Engine>,
    cwd: String, name: Option<String>, model_id: Option<String>,
    effort: Option<String>,
    isolate: Option<bool>,     // NEW
) -> IpcResult<Value>;

// Internal isolation record carried on Session (serialized subset in SessionMeta.meta()):
struct Isolation { branch: String, worktree_path: String, source_repo: String }
// SessionMeta serializes only { branch, worktreePath } as `isolation`
// (skip_serializing_if = "Option::is_none"); `source_repo` stays internal/persisted.

// git runner in session.rs, mirroring diff.rs::git (argv array; CREATE_NO_WINDOW on Windows):
fn git(cwd: &str, args: &[&str]) -> std::io::Result<GitOut>; // { code, stdout, stderr }
```

Git command sequence (argv arrays; FR-13/14/19/20):

```
# precondition (FR-13)
git -C <cwd>  rev-parse --is-inside-work-tree      # expect stdout "true", else NOT_A_GIT_REPO
git -C <cwd>  rev-parse --show-toplevel            # -> source_repo (repo root)

# create (FR-14) — run from source_repo
git -C <source_repo> worktree add <worktreePath> -b <branch>   # non-zero -> GIT_ERROR (stderr)

# cleanup on remove (FR-19) — run from source_repo; both best-effort
git -C <source_repo> worktree remove --force <worktreePath>    # on fail: fs::remove_dir_all(<worktreePath>)
git -C <source_repo> worktree prune
```

The frontend API layer (`src/api.ts`) adds `sessionStop(sessionId) =>
ipc<Result<null>>('session_stop', { sessionId })`; `sessionCreate` already
forwards the whole `NewSessionRequest`, so `isolate` needs no wrapper change.
Both frontend and backend build from this section with no further questions.

## 6. Data & state

**Rust core (`session.rs`):**
- `struct Session` gains `isolation: Option<Isolation>` (`Isolation { branch,
  worktree_path, source_repo }`). `meta()` maps it to the public
  `Option<SessionMeta.isolation>` exposing only `branch` + `worktreePath`.
- `session_stop`: takes the sessions lock; `SESSION_NOT_FOUND` / `SESSION_NOT_RUNNING`
  guards; then `s.queue.clear()`, `turn.interrupted.store(true, SeqCst)`,
  `turn.child.lock().unwrap().kill()`; releases the lock; `ok(None)`. All
  completion/emission stays in the existing `run_reader` → `finish_turn`.
- `session_create`: after the cwd-is-dir check and the `claude --version` check,
  if `isolate == Some(true)` run the FR-13/14 git sequence; on success set
  `cwd = worktreePath` and `isolation = Some(...)` before building the `Session`;
  on git failure return the error and insert nothing. Non-isolated path unchanged.
- `session_remove`: unchanged teardown, plus the FR-19 best-effort worktree
  removal when `isolation` is `Some`, using the recorded `source_repo`.
- `worktrees_dir()` = `app_data_dir()/worktrees`; `worktree_path(id)` =
  `worktrees_dir()/<id>` guarded by the existing `valid_session_id`.
- Pure helpers `slug(name)` and `branch_name(name, session_id)` are unit-tested
  (see §9).

**Persistence (durable-sessions `sessions.json`):**
- `persist()` writes three added fields per record when isolated: the branch,
  worktree path, and source repo root (e.g. `"isolation": { "branch", "worktreePath",
  "sourceRepo" }`, or three flat keys — implementer's choice, internal schema).
- `parse_session_record` reads them back into `Isolation`; absent → `None`
  (backward compatible). Persisted `cwd` already equals the worktree path for an
  isolated session, so reload needs no path rewriting.

**Frontend:**
- `NewSessionModal`: new `isolate: boolean` state (default `false`), included in
  the `NewSessionRequest` passed to `sessionCreate`.
- `ConversationView`: Stop visibility is derived from the existing `status` state
  (no new store field). The isolation badge reads `meta.isolation` from the store.
- No new zustand store slice; `SessionMeta.isolation` flows through the existing
  session meta the store already holds.

**Derived (not stored):** Stop-control visibility (`status === 'running'`); the
branch badge (`meta.isolation`); the branch name is computed once at create time
and thereafter read from meta.

## 7. Edge cases & errors

| Case | Behavior |
|---|---|
| `stop` on unknown `sessionId` | `ok:false` `SESSION_NOT_FOUND` (FR-2). |
| `stop` when `idle`/`done`/`error` | `ok:false` `SESSION_NOT_RUNNING`; nothing killed, no events (FR-3). UI (which only renders Stop while running) ignores it. |
| `stop` while a turn streams text | Child killed; open text block closed with `assistant.done`; session → `idle` (FR-4/6). The partial assistant text is kept in the live view but, like a crash mid-turn (durable-sessions), was never finalized so it is absent on reload. |
| `stop` while a tool executes | Open tool block closed with `tool.done meta:"interrupted"`; session → `idle` (FR-6). |
| `stop` with queued follow-ups | Queue cleared first, so no queued turn auto-starts; session → `idle` (FR-5). Queued blocks were never sent → no transcript/event debt. |
| `stop` during a resume-retry | `was_interrupted` suppresses the resume-fail re-run; session → `idle` (FR-7). |
| Double `stop` / `stop` racing turn end | Second call sees non-running → `SESSION_NOT_RUNNING`; killing an exited child is harmless (FR-8). |
| `isolate` on a non-repo cwd | `ok:false` `NOT_A_GIT_REPO`; no session, no worktree (FR-13). Modal shows the error. |
| `git worktree add` fails (empty/unborn-HEAD repo, permission, disk) | `ok:false` `GIT_ERROR` with git's stderr; no session created (FR-16). |
| Branch or worktree-path collision | Path is keyed by the fresh session uuid (cannot pre-exist); branch carries the 8-char id suffix (collision astronomically unlikely). If git still reports a collision, it surfaces as `GIT_ERROR` and no session is created — the user retries (a new uuid yields a new name). |
| cwd is a **subdirectory** of the repo | `rev-parse --show-toplevel` resolves the repo root; the worktree is added from there and branches from the repo's current HEAD. |
| cwd is **already a linked worktree** | Supported: `worktree add` targets the shared repository via the common dir; the new branch is created from the cwd worktree's HEAD. |
| Remove isolated session, branch has unmerged commits | `worktree remove --force` removes the checkout regardless; the **branch is kept** so the work is recoverable (FR-19). |
| `worktree remove` fails on remove | Fall back to `fs::remove_dir_all(worktreePath)` + `prune`; if that also fails, log and proceed — the session is still removed (FR-19). |
| Reload of an isolated session (durable-sessions) | Restored isolated with cwd = worktree path; diff watcher + transcript resume against the worktree; `status = 'idle'` (FR-18). |
| Worktree dir manually deleted out-of-band before remove | `worktree remove --force` errors → `fs::remove_dir_all` no-ops → `prune` reconciles git's metadata; remove still succeeds. |
| `isolate` omitted / `false` | Exactly today's non-isolated create; `SessionMeta.isolation` absent (FR-12). |

## 8. Design brief

Self-contained brief for the design step. Palette from the mock (`Claude Terminal.dc.html`)
and existing components: accent `#c8a15a`; error/red family `#c46b62`; status
colors running `#d0a45c`, idle `#6b7079`; surfaces `#16171c`/`#191b21`/`#1a1c22`;
borders `#24262d`/`#2a2c33`/`#34363f`; text `#c4c7ce` (primary), `#868a93` (dim),
`#565a63` (faint). Font: JetBrains Mono (inherited).

### Stop control (conversation-view — SESSION tab)

Reference region: the conversation **input bar** (mock lines ~110–114 — the row
with the `›` prompt, placeholder, and right-aligned `⌘K palette` hint;
`ConversationView.tsx` renders this at the bottom of the transcript column). The
Stop control sits at the right end of that bar, left of (or replacing, while
running) the `⌘K palette` hint.

- **Appearance**: a compact pill/button, `font-size:10.5–11px`, `padding:3px 9px`,
  `border-radius:4px`, glyph `■` (stop square) + label `stop`, with the Esc hint
  `⎋` shown faintly after the label (e.g. `■ stop ⎋`). Idle style: `border:1px
  solid #2a2c33; background:#1a1c22; color:#c46b62` (red family signals a
  destructive/halting action). Hover: `background:rgba(196,107,98,0.12);
  border-color:#c46b62`. Active/press: brief `background:rgba(196,107,98,0.20)`.
  Do not use the accent gold here — gold is the "go"/prompt color; stop is red.
- **States**:
  - *hidden* — `status !== 'running'` (default for idle/done/error). The bar shows
    only the `⌘K palette` hint, exactly as today.
  - *visible/enabled* — `status === 'running'`: the pill is shown; the input
    `textarea` remains usable (queuing) but the Stop pill is the salient control.
  - *pressed* — momentary; then the incoming `session.status: 'idle'` hides it.
- **Motion**: fade/slide-in ~120ms when it appears (match the resume-fail banner's
  `fadeIn 120ms ease-out`); no pulse/blink. It simply unmounts when the session
  leaves `running`.
- **Hotkey**: **Esc** (FR-11) when SESSION tab active + conversation focused +
  running + no modal/palette open. Optionally show `⎋` in the pill as the hint.
- **Responsive**: the pill is fixed-content and right-aligned; on a narrow main
  column the input `textarea` flexes and the pill keeps its intrinsic width. Never
  wraps to a second row.

### Isolation indicator (conversation-view header)

Reference region: the SESSION tab **header meta row** (mock lines ~80–86 — the
right-aligned `Sonnet 4.5 · ctx 48.2K/200K · 02:14` cluster). When
`meta.isolation` is present, prepend a branch badge to that cluster:

- Glyph `⑂` (or `⎇`) + branch name, `font-size:10.5px; color:#c8a15a`
  (accent), truncated with ellipsis if long (`max-width:~180px; overflow:hidden;
  text-overflow:ellipsis; white-space:nowrap`), `title` = full branch. A faint
  `·` separates it from the model, matching the existing separators.
- Absent for non-isolated sessions (row unchanged). Optionally, the sidebar
  session row (mock line ~62, `{{ s.status }} · {{ s.model }}`) may append the
  same small `⑂` glyph for isolated sessions; header badge is the required surface.

### Isolate toggle (NewSessionModal)

Reference region: the new-session modal body (`NewSessionModal.tsx`, mock modal at
lines ~254+), placed as a new labeled field after MODEL/EFFORT and before the
submit-error area.

- **Layout**: `label` `ISOLATE` in the existing `labelStyle` (10px, dim,
  letter-spaced), then a single toggle row: a small switch/checkbox + inline
  helper text `run in a dedicated git worktree — edits stay off your main branch`
  (`font-size:10.5px; color:#565a63`).
- **Toggle styling** (reuse the effort-pill idiom for visual consistency): a
  pill/checkbox that reads `off` by default (`border:1px solid #2a2c33;
  background:#1a1c22; color:#868a93`) and `on` when selected (`border-color:
  #c8a15a; background:rgba(200,161,90,0.12); color:#c8a15a`) — the same
  selected/unselected treatment the EFFORT pills already use.
- **States**: off (default) / on. No client-side git detection is required; if the
  cwd is not a repo, Create returns `NOT_A_GIT_REPO` and the existing
  `submitError` block (red `#c46b62` on `rgba(196,107,98,0.09)`) shows the message
  inline and the modal stays open (FR-21). (Optional enhancement: a faint helper
  line noting the directory must be a git repo.)
- **Motion**: instant toggle; no animation beyond the existing modal transitions.

### Fleet board note

`fleet-board` (sibling) may render a per-session Stop on its session cards; it
should call the same `session_stop(sessionId)` command with identical semantics
(FR-1..FR-8) and the same red/`#c46b62` treatment. No additional backend surface
is needed for it.

## 9. Acceptance criteria

- [ ] `francois:session:stop` → `session_stop(sessionId)` exists, is registered in
  `main.rs`, and resolves `Result<null>` without ever rejecting (FR-1, §5).
- [ ] `session_stop` returns `SESSION_NOT_FOUND` for an unknown id and
  `SESSION_NOT_RUNNING` when the session is not `running`, emitting nothing in the
  latter case (FR-2/FR-3).
- [ ] `session_stop` on a running session kills the turn's child via the existing
  `TurnHandle.interrupted` + `kill()` primitive, clears the pending queue, and the
  session reaches `idle` through `run_reader`'s `was_interrupted` → `finish_turn`
  path with **no** `session.error` and the transcript's finalized blocks intact
  (FR-4/FR-5/FR-6).
- [ ] A stop landing during a resume-retry does not trigger a resume-fail re-run
  (FR-7); a double/late stop is harmless and returns `SESSION_NOT_RUNNING` (FR-8).
- [ ] The conversation view shows the Stop control **only** while the session is
  `running`, activating it calls `session_stop`, and **Esc** triggers it without
  breaking modal/palette Esc when a modal/palette is open (FR-9/FR-10/FR-11).
- [ ] `session_create` accepts `isolate?: boolean`; omitted/`false` is byte-for-byte
  today's behavior with `SessionMeta.isolation` absent (FR-12).
- [ ] With `isolate: true` on a non-repo cwd, create returns `NOT_A_GIT_REPO` and
  creates nothing; the modal surfaces the error (FR-13/FR-21).
- [ ] With `isolate: true` on a git repo, the core runs `git worktree add
  <app_data>/worktrees/<id> -b francois/<slug>-<shortid>` (argv array), sets the
  session cwd to the worktree, and `SessionMeta.isolation = { branch, worktreePath }`
  is emitted/returned (FR-14/FR-15/FR-17). A `git worktree add` failure returns
  `GIT_ERROR` and creates nothing (FR-16).
- [ ] `slug`/`branch_name` unit tests pass: names are lowercased, non-alphanumerics
  collapse to single `-`, empty → `session`, capped at 32 chars, and the branch is
  `francois/<slug>-<8charId>` (a valid git ref).
- [ ] An isolated session survives restart: reloaded isolated with cwd = worktree
  path, diff/transcript resuming against the worktree; records lacking isolation
  fields load as non-isolated (FR-18).
- [ ] Removing an isolated session best-effort runs `git worktree remove --force`
  + `git worktree prune` (fs fallback on failure), **keeps the branch**, and never
  fails the remove (FR-19).
- [ ] All git calls use argv arrays via a `Command::new("git")` runner with
  `CREATE_NO_WINDOW` on Windows; no shell strings (FR-20).
- [ ] `contract/session-brake.ts` exists and imports shared types from `common.ts`;
  `common.ts` gains `SessionIsolation` + `SessionMeta.isolation?`; `session-engine.ts`
  `SessionCreateInput` and `sessions-sidebar.ts` `NewSessionRequest` each gain
  `isolate?: boolean`; the `ErrorCode` union is unchanged (§5).

## Open questions

1. **Consolidate `session_stop` with the pre-existing `session_interrupt`?** The
   engine already ships `session_interrupt` (same kill primitive, no-op when idle,
   keeps the queue, no UI). This spec adds `session_stop` (stricter
   `SESSION_NOT_RUNNING`, clears queue, the UI surface). Options: (a) keep both,
   `session_interrupt` internal/legacy (spec'd default); (b) make `session_stop`
   the sole command and delete `session_interrupt`; (c) have `session_stop`
   delegate to `session_interrupt` internally. Chosen for build: (a).
2. **Does Stop clear the queue?** Spec'd yes (FR-5 — kill-switch = full stop). If
   the product wants Stop to only abort the current turn and let queued messages
   continue (matching a plain interrupt), drop FR-5. Confirm intent.
3. **Isolation branch base ref.** Branches from the cwd/repo current HEAD (git
   default). If sessions should always branch from the default branch
   (e.g. `origin/main`) regardless of the checked-out HEAD, that needs an explicit
   base — out of scope as spec'd.
4. **Branch retention policy on remove.** Spec keeps the branch (recoverable work).
   If users expect removing a session to also delete its branch, add an opt-in
   "delete branch too" affordance (destructive) later.

## Remediation

(Empty until a review returns findings.)
