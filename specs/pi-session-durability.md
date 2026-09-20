---
id: pi-session-durability
title: Pi persistence, resume and recovery
status: in-review
branch: feat/pi-session-durability
created: 2026-09-18
depends_on: [pi-rpc-sessions, pi-transcript-events]
reviewed_base:
reviewed_digest:
design_files: []
---

# Pi persistence, resume and recovery

## 1. Summary

Reconnect to the exact Pi conversation after François restarts while keeping François
metadata and transcript projection separate from the native Pi tree. Sources:
[session-format and RPC audit](research/pi-integration-audit.md).

## 2. Goals & non-goals

- Goals: explicit identity/ownership, recoverable projection, honest missing/corrupt-session
  states, isolated project/worktree/account association and safe upgrade behaviour.
- Non-goals: lossless Claude→Pi conversion, tree editing, sync, resuming a process across
  app exit, or automatically replaying a prompt whose outcome is unknown.

## 3. User stories / flows

Quit and reopen: old transcript is visible immediately. Send: reconnect to the recorded
native session and continue its context. If that file is missing, keep history readable
and offer Retry or Create new session; a new session is a distinct sidebar item.
After a crash, pending intents appear unsent with explicit recovery wording.

## 4. Functional requirements

- FR-1: Pi writes native JSONL under `<app_data>/runtimes/pi/sessions/<francoisSessionId>/`.
  Persist the exact returned sessionId/sessionFile only after handshake validation. Use
  explicit file selection on resume, never Pi's “most recent” or a partial ID lookup.
- FR-2: François's record owns cwd, worktree, project/account IDs, pinned config reference,
  model choice, profile snapshot, label and timestamps. Pi owns messages/tree/context.
  Projection files and checkpoints are disposable derived state, never replayed as prompts.
- FR-3: Before resuming, canonicalize/validate the owned file location, exact identity,
  pinned account and working directory. Missing/mismatched/corrupt files fail resume;
  the Claude `ResumeRetry` fresh-thread fallback must never apply to Pi.
- FR-4: Resume projection from `get_entries` using its durable entry cursor and leaf ID.
  Reconstruct active-branch ancestry using parentId; preserve historical pre-compaction
  messages on that ancestry without showing abandoned branches as the current conversation.
  `get_messages` alone is insufficient for full history after compaction.
- FR-5: Map native entry ID/content index/toolCallId to stable François block IDs. At
  settled boundaries reconcile provisional live blocks with entries in ordered FIFO position,
  not text deduplication. Keep duplicate identical user messages as distinct entries.
  If identity cannot be reconciled, rebuild that projection generation before accepting input.
- FR-6: Atomically replace metadata/checkpoint files via existing fs helpers. Advance
  cursor only after projection commits. Startup detects a torn projection/checkpoint and
  rebuilds. Keep the existing capped tail and paged folded log; never load every transcript
  into the webview. A full RPC entry response above the transport cap fails explicitly;
  use a bounded streaming read of the owned native JSONL for initial rebuild, behind the
  same pinned private decoder, if RPC cannot page a large session.
- FR-7: On crash, show known durable entries plus interrupted partial display output.
  Unconfirmed submitted messages remain `delivery-unknown`; queued local drafts are unsent.
  Do not issue a model call on app startup. Reconnect/read-only reconciliation is explicit.
- FR-8: Back up native files before the first load by a newly certified Pi version, as
  Pi may migrate its format. Never downgrade a migrated file automatically; retain old
  backup and metadata version for user-directed recovery. Unsupported newer schemas stay read-only.
- FR-9: Removing a François session shuts down first, then removes its index/projection.
  Keep native conversation files for recovery; no implicit recursive deletion of Pi data.
  No generic API accepts an arbitrary replacement native file path in this MVP.

## 5. API contract

Author `contract/pi-session-durability.ts` for recovery commands; shared presentation type
goes in `common.ts` and is imported into the feature file:

```ts
interface RuntimeRecovery {
  state: 'ready' | 'disconnected' | 'missing' | 'corrupt' | 'incompatible' | 'account-missing';
  lastVerifiedAt?: number;
  message?: string;
}
interface RuntimeReconnectInput { sessionId: SessionId }
interface RuntimeNewFromSessionInput { sessionId: SessionId; name?: string }
```

`SessionMeta` gains optional `recovery: RuntimeRecovery` (present for Pi). Commands:

| Logical / Tauri command | Input → Result data | Errors |
|---|---|---|
| francois:session:reconnect / session_reconnect | RuntimeReconnectInput → SessionMeta | SESSION_NOT_FOUND, SESSION_BUSY, RUNTIME_UNAVAILABLE, RUNTIME_INCOMPATIBLE, RUNTIME_TIMEOUT, RUNTIME_PROTOCOL_ERROR, RUNTIME_SESSION_MISSING, RUNTIME_SESSION_CORRUPT, RUNTIME_ACCOUNT_MISSING, INTERNAL |
| francois:session:newFrom / session_new_from | RuntimeNewFromSessionInput → SessionMeta | same preflight errors; INVALID_INPUT |

`newFrom` copies only validated cwd/project/account/profile/model settings into a new
session ID, with no messages or native resume anchor. It never auto-sends the prior prompt.
Existing `session.meta` publishes recovery status on the existing event channel.
Add `SESSION_BUSY`, `RUNTIME_SESSION_MISSING`, `RUNTIME_SESSION_CORRUPT`,
`RUNTIME_ACCOUNT_MISSING` to existing ErrorCode if absent. Native file path stays core-private.

Core-only persisted shape (not IPC):

```ts
interface PiResumeRecord {
  schemaVersion: 1;
  nativeSessionId: string;
  nativeSessionFile: string;
  accountId: AccountId;
  configDir: string;
  cwd: string;
  piVersion: string;
  lastEntryId: string | null;
  leafId: string | null;
  projectionVersion: number;
}
```

Existing records with no Pi discriminator follow existing runtime migrations. Native
entries are decoded only inside the private adapter; no direct Pi DTO contract.

## 6. Data & state

No SQL migration: code currently owns `sessions.json` and per-session transcript JSONL.
Pi resume record is nested under the matching session record; write after successful
connection before any first prompt. Native and display writes cannot be one transaction;
entry identity + rebuild is the recovery mechanism. An in-memory process handle is never saved.

Expected files: `session/persistence.rs`, new `adapter/pi/{persistence,recovery}.rs`,
`session/commands/lifecycle.rs`, transcript pager, `ResumeFailBanner.tsx`, sessions store.

## 7. Edge cases & errors

Deleted account never falls back to the default Claude/Pi account. Moved cwd/worktree
blocks resume with an actionable path error, without deleting history. Damaged final
native line is diagnosed by Pi/private reader; François does not “repair” the native file.
Wrong leaf / stale cursor rebuilds; corrupt parent chains fail with readable cached history.
Disk full: report persistence failure and block further submission until ownership metadata
can be saved; never advertise a successfully durable new session whose anchor was lost.

## 8. Design brief

Recovery banner shows one cause and Retry/Create new session; distinguish unsent drafts
from delivery-unknown prompts without asserting what the model executed.
> full brief: specs/design/pi-session-durability.md

## 9. Acceptance criteria

- [ ] Restart and send resumes the same native ID and remembered context (FR-1–3).
- [ ] Compaction and branch fixtures rebuild correctly without abandoned-branch leakage (FR-4).
- [ ] Duplicate text, missed final events and torn checkpoints reconcile without duplicate rows (FR-5–6).
- [ ] Missing/corrupt files never trigger automatic fresh-thread prompt execution (FR-3/7).
- [ ] Version transition takes a backup; incompatible format stays readable through cache (FR-8).
- [ ] Session removal retains native data and never removes an unrelated file (FR-9).
- [ ] Temp-dir persistence tests, fake-process resume tests and real certified Pi restart test pass.

## Remediation

### 2026-09-19 — round 1 (lead integration check, pre-review)

- 2026-09-19 — 3 findings (2 HIGH / 1 MEDIUM), all fixed (Pi child env isolation via `pi_account_env` + `exact_env`; `pi_execution_preflight` gate before reconnect validation/spawn; RUNTIME_UNSUPPORTED for non-Pi sessions)

### 2026-09-20 — round 2 (PR #142 review)

**Decision — a rebuild MERGES, it does not replace (amends FR-4/FR-5).** Pi's entries are the
authority for *messages* only; they carry no execution rows and none of François's own notices.
A successful rebuild therefore:

1. Rebuilds the User/Assistant blocks from the active-branch ancestry, exactly as FR-4/FR-5 say.
   A rebuilt block whose id matches a block already on disk **starts from that block** — it keeps
   its `at`, its attachments and every other local field; only `text` and `nativeEntryId` come
   from the entry. A rebuild never re-stamps history with "now".
2. Keeps every **local-only** block (any kind the entries cannot produce — Tool/execution, Notice,
   …). Each is anchored to the nearest message block that PRECEDES it in the transcript on disk
   and is re-inserted right after that anchor, relative order preserved. A local-only block with
   no preceding message stays at the head.
3. Drops a local-only block only when its anchor did not survive the rebuild — i.e. it belonged
   to an abandoned branch, which FR-4 already keeps out of the current conversation.
4. Appends the delivery-unknown notice (FR-7) at most ONCE per unconfirmed user block: since
   notices now survive, a Retry must find the existing one rather than add another. The same
   notice is appended, non-destructively and with the same dedupe, on the keep-local path (a
   session whose FIRST message never reached Pi), which used to get none.

"Projection files are disposable derived state" (FR-2) still holds for what can be re-derived
from Pi. Execution rows and notices cannot, so they are not disposable.

**Declared gaps — not closed in PR #142** (no Pi session can be created in that build, so
neither is reachable): nothing yet writes the FIRST `PiResumeRecord` (`PiResumeRecord::new` and
`Engine::connect_runtime` have no production caller), and FR-1's owned directory
`<app_data>/runtimes/pi/sessions/<id>/` is never created nor handed to Pi. Acceptance criterion
1 is therefore met by no code until the first-connect wiring lands in its own PR.
