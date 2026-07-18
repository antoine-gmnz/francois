---
id: durable-sessions
title: Durable & resumable sessions
status: shipped
created: 2026-07-18
depends_on: [session-engine, conversation-view]
---

# Durable & resumable sessions

## 1. Summary

Sessions currently live only in memory: `persist()` saves a session's
`id/name/cwd/modelId/effort`, but not its transcript (`block_buffer`) or the
in-memory `claude_session_id`. Restart the app and every session returns
amnesiac — empty conversation, no way to resume the real Claude thread. This
feature persists each session's full transcript (append-only, one `.jsonl` per
session in the app data dir) plus its `claude_session_id` and a little live
metadata, reloads them on startup with history intact, and threads the persisted
id into the next `claude -p --resume` so the actual thread continues. When Claude
has pruned that thread, the next turn falls back seamlessly to a fresh thread and
surfaces a non-blocking banner. This is the durability foundation of the
"Mission Control" roadmap (concurrent, long-lived workstreams).

## 2. Goals & non-goals

- **Goals**:
  - Persist each session's full transcript to disk (append-only `.jsonl`, one file per session) as finalized blocks stream in.
  - Persist `claude_session_id` (+ `lastActivityAt`, `contextUsedTokens`) so a restarted session resumes the real Claude thread and reloads faithfully.
  - Reload sessions on startup with their transcript rendered exactly as a live one, status `idle`.
  - Recover seamlessly when a resume fails (pruned/expired thread): auto-continue on a fresh thread and show a banner.
  - Keep all persisted data in the app data dir — never inside a session's repo `cwd`.
- **Non-goals** (roadmap / elsewhere):
  - Fleet status board / rich glance — separate spec.
  - Desktop notifications on needs-input / done — separate spec.
  - "Stop this turn" kill switch + per-session worktree isolation — separate spec.
  - Cost / token-$ tracking.
  - Editing / replaying / branching history; cross-device sync; cloud storage.
  - **Encryption & retention of at-rest transcripts** — named follow-up (see §7); MVP ships plaintext.
  - Reconciling the persisted display transcript with Claude's own (possibly compacted) thread.
  - `cli-companion` (separately spec'd).

## 3. User stories / flows

1. **Restart and continue.** User has a session with a conversation, quits Francois, reopens it later. The session reappears in the sidebar with its **full past conversation** rendered in the SESSION tab. The user types a follow-up and sends — the turn spawns with `--resume <persistedId>`, so Claude continues the real thread as if the app never closed.
2. **Resume-fail, seamless.** User reopens a session last used days ago; Claude has since pruned that thread. The user sends a message. The turn's `--resume` fails; the core automatically re-runs the same message on a **fresh** thread, and a dismissible banner appears at the top of the conversation: *"previous thread unavailable — continuing fresh."* The shown history stays; the message completes normally; no user action required.
3. **Concurrent durability.** Several sessions across different repos each persist independently; all reload with their own history and their own `claude_session_id`.
4. **Crash mid-turn.** The app is killed while a turn is streaming. On reload the session is `idle`, all previously **completed** turns are present, and the interrupted (incomplete) turn is absent from disk. The user simply re-sends.

## 4. Functional requirements

**Backend — persistence**

- **FR-1 (transcript file).** Each session has an append-only transcript at `<app_data>/transcripts/<sessionId>.jsonl`. Each **finalized** block is appended as exactly one JSON line in the `PersistedBlock` schema (§5/§6). The directory is created on demand.
- **FR-2 (append triggers — finalized only).** A block is written when it is finalized, never per streaming delta: **user** block on send (`buf_user`); **assistant** block on `assistant.done`; **tool** block on `tool.done` (so its `meta` is included); **subagent** block on its completion. The `streaming` flag is never written (it reloads as `false`).
- **FR-3 (session record).** `persist()` additionally saves, per session in `sessions.json`: `claudeSessionId` (optional), `lastActivityAt`, and `contextUsedTokens` — keeping the existing `id/name/cwd/modelId/effort`. `status` is **not** persisted.
- **FR-4 (reload metadata).** On startup, `load_persisted` restores each session with its `claude_session_id`, `last_activity_at`, and `context_used_tokens`; `context_limit_tokens` is recomputed from the model (existing `context_limit()`); `status = 'idle'`; `current` turn = `None`.
- **FR-5 (reload transcript).** On startup, the session's `.jsonl` is read back into `block_buffer` in file order, each as a finalized `BufBlock` (`streaming = false`). `conversation_get_transcript` then serves them unchanged (via `classify_block`). A missing transcript file → empty buffer, no error.
- **FR-6 (resume threading).** A turn for a session that has a `claude_session_id` spawns `claude -p --resume <id>` (unchanged behavior). Because the id now survives restarts, the first post-restart turn resumes the real thread.
- **FR-7 (session_id capture + persist).** When the stream emits `system`/`init` with `session_id`, the core stores it on the session **and persists it** (so a mid-life id becomes durable, and a fresh id after a resume-fail is saved).
- **FR-8 (resume-fail detection).** If a `--resume <id>` turn's child process exits non-zero **before** emitting a `system`/`init` frame — i.e. Claude rejected the resume — the turn is classified as a resume-failure (as opposed to a normal turn error, which occurs after a valid `init`).
- **FR-9 (resume-fail recovery).** On a resume-failure the core: clears the session's `claude_session_id`, **re-runs the same turn text once without `--resume`** (fresh thread), captures + persists the new `session_id` from the fresh run's `init`, and emits `session.resumeFailed` for that session. The user's message completes on the fresh thread with no user action.
- **FR-10 (safe writes).** `sessions.json` is written atomically (temp + rename — existing pattern). Transcript writes are plain line appends (no whole-file rewrite).
- **FR-11 (cleanup on remove).** `session_remove` deletes the session's `<app_data>/transcripts/<sessionId>.jsonl` (best-effort; a failed delete does not fail the remove).
- **FR-12 (data location).** All persisted data lives under `app_data_dir()`; nothing is written inside a session's `cwd`.

**Frontend — conversation-view**

- **FR-13 (reloaded transcript render).** A reloaded session's `block_buffer` renders identically to a live transcript; conversation-view already hydrates via `conversation_get_transcript` on mount, so no rendering change is required beyond receiving the reloaded blocks.
- **FR-14 (resume-fail banner).** On a `session.resumeFailed` event for the currently-displayed session, conversation-view shows a **non-blocking, dismissible banner**: *"previous thread unavailable — continuing fresh."* It does not clear the transcript and does not block input. It is dismissed by the user (✕) or cleared when the user sends their **next message** (`message.user`) — not on the recovery turn's own completion, which would auto-dismiss before it could be read.

**Robustness**

- **FR-15 (partial-line tolerance).** Transcript reload skips any malformed or partial trailing JSON line (e.g. from a crash mid-append) without failing the whole session's load.
- **FR-16 (idle on reload).** No in-flight turn is auto-resumed on startup; reloaded sessions are `idle` until the user sends.

## 5. API contract

The only wire-level addition is one `SessionEvent` member in `contract/common.ts`
(events are emitted on `francois://session/event`). No new IPC commands — durability
is internal to the core; the reloaded transcript is served by the existing
`conversation_get_transcript` and sessions reload through the existing
`session_list` / `load_persisted` path.

```ts
// contract/common.ts — add to the SessionEvent union (do not redefine existing members):
//   | { type: 'session.resumeFailed'; sessionId: SessionId }
//
// Emitted by session-engine (Rust core) when a --resume turn is rejected and the
// core has transparently continued on a fresh thread (FR-9). Consumed by
// conversation-view to render the FR-14 banner. Carries no error object — it is a
// notice, not a failure; the turn itself still completes.
```

**No new error codes.** `session.resumeFailed` is an event, not an `AppError`.

**Internal on-disk schemas** (not IPC — the frontend never reads these directly; documented so the implementer builds the exact shapes):

```ts
// <app_data>/sessions.json — array of:
interface PersistedSession {
  id: string;
  name: string;
  cwd: string;
  modelId: string;
  effort?: string;
  claudeSessionId?: string;   // NEW — Claude's thread id, for --resume across restarts
  lastActivityAt: number;     // NEW — epoch ms
  contextUsedTokens: number;  // NEW — last-known usage, for a faithful header on reload
}

// <app_data>/transcripts/<sessionId>.jsonl — one finalized block per line:
interface PersistedBlock {           // mirrors BufBlock minus `streaming`
  blockId: string;
  kind: 'user' | 'assistant' | 'tool' | 'subagent';
  text: string;
  tool: string;                      // '' for non-tool blocks
  summary: string;                   // tool summary / subagent name; '' otherwise
  meta: string | null;               // tool.done meta; null otherwise
}
```

On reload each `PersistedBlock` becomes a `BufBlock { streaming: false, meta: Option<String>, … }`,
so `conversation_get_transcript` → `classify_block` yields the same `ConversationBlock[]`
(from `contract/conversation-view.ts`) the frontend already renders.

## 6. Data & state

**Rust core (per session):**
- In-memory `Session` shape is unchanged; on reload `block_buffer` is populated from disk and `claude_session_id`/`last_activity_at`/`context_used_tokens` are restored.
- New helpers: `transcripts_dir()` = `app_data_dir()/transcripts`; `transcript_path(id)`; an append function that serializes a finalized `BufBlock` → `PersistedBlock` line. Appends are per finalized block (low frequency — no debounce needed).
- `persist()` extended to write the three new `sessions.json` fields; `load_persisted()` extended to restore them and to read the `.jsonl` into `block_buffer`.
- Persistence is **best-effort**: a failed transcript append is logged and the turn continues (the in-memory buffer stays correct; only durability of that one block is lost).

**Frontend (conversation-view, per displayed session):**
- A transient `resumeFailed: boolean` (banner visibility), set on `session.resumeFailed`, cleared on dismiss or the user's next `message.user`. Not persisted.

**Persistence layout:** `sessions.json` (metadata) + `transcripts/*.jsonl` (content), both under `app_data_dir()`. No database.

**Derived (recomputed, not stored):** on reload, `status = 'idle'` and `context_limit_tokens` from the model catalog; the rendered transcript from `classify_block`.

## 7. Edge cases & errors

| Case | Behavior |
|---|---|
| App restart with a session that had a conversation | Transcript + metadata reloaded; `status = idle`; next turn resumes via `--resume` (FR-4/5/6). |
| `claude_session_id` pruned/expired at next turn | Resume-fail detected (FR-8) → clear id, re-run the turn fresh, persist new id, emit `session.resumeFailed` → banner (FR-9/14). User's message still completes. |
| Crash mid-turn | Only finalized blocks were persisted, so the incomplete turn is absent on reload; session reloads `idle`; user re-sends (FR-2/16). |
| Malformed / partial trailing `.jsonl` line | Skipped on reload; the rest of the transcript still loads (FR-15). |
| Transcript file missing but session present in `sessions.json` | Reload with an empty buffer, no crash; `--resume` still works from the persisted id (FR-5). |
| Session removed | Its `.jsonl` is deleted best-effort (FR-11). |
| Disk write failure on append | Logged; the turn is unaffected; that block is simply not durable (best-effort persistence). |
| Very large transcript | Loaded in full — accepted for v1; size caps / rotation are a follow-up. |
| **Plaintext at rest** (transcripts contain code, possibly secrets/tokens) | Accepted for MVP; **encryption + retention is a named follow-up**, not "fine." Kept in the app data dir, never the repo, to avoid accidental commit/leak (FR-12). |

## 8. Design brief

This feature is almost entirely backend; the only new UI is the **resume-fail
banner** in the SESSION tab (conversation-view). Reloaded transcripts reuse the
existing conversation row styling unchanged (reference `Claude Terminal.dc.html`
conversation region).

**Resume-fail banner** — a non-blocking notice at the top of the conversation
scroll area (or just under the tab strip), styled as an informational amber notice
(the "connecting"/warn family, not the red error family):
- Container: `background:#20222a; border-left:2px solid #c2b06a; border-radius:4px; padding:8px 11px; display:flex; align-items:center; gap:9px; margin:6px 8px;`
- Text: `font-size:11.5px; color:#a9adb6;` content: `previous thread unavailable — continuing fresh`.
- Dismiss: a `✕` on the right, `font-size:10px; color:#565a63; cursor:pointer` (also clears on the user's next message).
- Motion: subtle fade-in (~120ms); no pulse/blink.
- States: hidden (default) / visible (after `session.resumeFailed`) / dismissed.

(Acceptable alternative if simpler for the implementer: render the notice as a
single dim system row inline in the transcript instead of a floating banner —
same text and amber accent.)

## 9. Acceptance criteria

- [ ] After a full app restart, opening a session shows its **complete prior conversation** (today it is empty), rendered identically to a live transcript (FR-1/5/13).
- [ ] A follow-up message in a restarted session **resumes the real Claude thread** via the persisted `claude_session_id` (`--resume`), not a fresh one (FR-3/6/7).
- [ ] Transcript files live at `<app_data>/transcripts/<sessionId>.jsonl`, one finalized block per line in the `PersistedBlock` schema, and **nothing** is written inside the session's `cwd` (FR-1/2/12).
- [ ] Only finalized blocks are persisted; a crash mid-turn leaves the completed turns intact and the interrupted turn absent, and the session reloads `idle` (FR-2/16).
- [ ] When `--resume` is rejected, the same message transparently completes on a fresh thread, the new `session_id` is persisted, and a dismissible *"previous thread unavailable — continuing fresh"* banner appears (FR-8/9/14).
- [ ] A malformed/partial trailing line in a `.jsonl` is skipped without failing the session's reload (FR-15).
- [ ] Removing a session deletes its transcript file (FR-11).
- [ ] `contract/common.ts` gains exactly the `session.resumeFailed` `SessionEvent` member and no new IPC command; `conversation_get_transcript` and the session list/load paths are unchanged in signature (FR-5/§5).

## Remediation

(Empty until a review returns findings.)
