---
id: remote-control
title: Remote Control (host Claude Code's native remote sessions)
status: shipped
created: 2026-07-26
depends_on: [session-engine, durable-sessions, conversation-view, app-shell]
---

# Remote Control (host Claude Code's native remote sessions)

## 1. Summary

Francois HOSTS Claude Code's native **Remote Control** for a session: it spawns an
interactive `claude [--resume <id>|--session-id <id>] --remote-control <name>` in a
PTY the core owns, learns the `claude.ai/code` session URL, and surfaces it (plus a
QR code) so the user can pick that **same Claude thread** up from their phone,
tablet, or any browser. Because `durable-sessions` persists `claudeSessionId`, the
handoff continues the real conversation rather than starting a parallel one.

## 2. Goals & non-goals

- **Goals**:
  - A per-session Remote Control toggle: start, stop, and observe the host.
  - Continue the SAME Claude thread when the session has one (`--resume`).
  - Surface the session URL (copyable) and a short `session_…` handle. QR deferred (§8).
  - Fail loudly and actionably: a host that stalls on a consent dialog or never
    registers must say so, not hang.
  - Never leak a host process — an orphan leaves a live remote session on the
    user's account after Francois exits.
- **Non-goals**:
  - **Francois as a Remote Control CLIENT.** Not possible: the relay is outbound
    HTTPS to `api.anthropic.com` with short-lived claude.ai credentials, no inbound
    port and no documented local protocol. Only Anthropic's web/mobile clients can
    drive a remote session. (§7 #1)
  - `claude remote-control` **server mode** (`--spawn=worktree`, `--capacity`):
    multi-session, but the sidecar owns its own sessions, so Francois would lose
    stream-json visibility and the transcript. Rejected for MVP.
  - Channels (an MCP `claude/channel` server) — the documented way to drive a
    session from outside. Separate feature if wanted.
  - Rendering the host's TUI, or answering its dialogs from Francois.
  - Mobile push notification config (`/config` in the CLI owns it).

## 3. User stories / flows

1. **Pick it up on the couch.** A session has been running a while. The user hits
   the Remote Control toggle; the badge shows *connecting…*, then *active* with a
   URL and QR. They scan it and continue the same conversation on their phone.
2. **Fresh session.** A session with no thread yet is remote-controlled; the core
   mints the session id, so the remote session is resumable afterwards.
3. **Blocked by consent.** The session's folder has an unapproved `.mcp.json`
   server. The host parks on the consent dialog. Within seconds the badge reads
   *failed* with "run `claude` there once and approve it, then retry".
4. **Stop.** Toggling off kills the host; the badge returns to off. Quitting
   Francois does the same for every host.

## 4. Functional requirements

**Core — host lifecycle**

- **FR-1 (PTY host).** `remote_start` spawns `claude … --remote-control <name>` in a
  PTY at 200×50. Interactive, never `-p`: Remote Control is a **silent no-op in
  print mode** — verified, `claude -p --remote-control …` is accepted, registers
  nothing and emits no URL. (§7 #2)
- **FR-2 (thread continuity).** A session with a non-empty `claudeSessionId` spawns
  `--resume <id>`; otherwise the core mints a uuid-v4 and passes `--session-id
  <uuid>` so the transcript path is known before the child speaks.
- **FR-3 (name).** `name` argument, else the Francois session name. Blank/whitespace
  is treated as absent.
- **FR-4 (runtime).** Spawn goes through `claude_invocation`, so the `wsl` runtime is
  wrapped exactly as turns are.
- **FR-5 (idempotent start).** Starting an already `starting`/`active` host returns
  the current status without spawning a second one — the CLI allows only one remote
  session per process. A `failed` host is replaced.
- **FR-6 (stop).** `remote_stop` kills the host and resolves `off`. Idempotent.
- **FR-7 (exit teardown).** `kill_all_remote` runs on `RunEvent::Exit`.

**Core — URL discovery (two independent sources, raced)**

- **FR-8 (transcript source).** Poll `~/.claude/projects/<slug>/<threadId>.jsonl` for
  `{"type":"system","subtype":"bridge_status","url":…}`, reading only bytes appended
  since the host started. `<slug>` maps every non-ASCII-alphanumeric character of the
  cwd to `-`, case preserved.
- **FR-9 (forked-thread fallback).** If a `--resume` thread was pruned the CLI forks
  a fresh id, so also scan the project dir — but **only files modified at/after the
  host started**, so the historic `bridge_status` records that accumulate in a
  long-lived project dir are never mistaken for this run's. (§7 #4)
- **FR-10 (PTY-output source).** Also match `https://claude.ai/code/session_<id>` in
  the raw PTY stream, stopping at the first non-alphanumeric character. This is the
  **only** source for a fresh session and for the `wsl` runtime. (§7 #3)
- **FR-11 (single transition).** Both sources race; the first to land promotes
  `starting` → `active` and the other is a no-op.
- **FR-12 (deadline).** No URL within 120s → `failed`. The PTY is drained
  continuously regardless; an unread master eventually blocks the child.
- **FR-13 (stall detection).** Normalize PTY output (each escape sequence → one
  space, whitespace collapsed) and match the consent dialogs — "New MCP server
  found", "Do you trust the files in this folder". On a match: fail immediately with
  the fix, and kill the child, which would otherwise wait forever for a keypress.
  Francois never auto-answers these: they are the user's trust decisions.
- **FR-14 (host death).** A host that exits before publishing a URL → `failed`. One
  that exits after going `active` keeps its URL; only `stop` clears it.

**Frontend**

- **FR-15 (fold).** `remote.status` folds into a `sessionId → state` map; `off`
  deletes the entry, and an `off` for an unknown session returns the same object so
  subscribers do not re-render for nothing.
- **FR-16 (presentation).** `starting` counts as live so the toggle flips at once;
  each phase gets a distinct badge tone; `failed` renders the reason.

## 5. API contract

`contract/remote-control.ts` (+ `REMOTE_CONTROL_FAILED` in `common.ts`'s `ErrorCode`).

- `francois:remote:start` → `remote_start({ sessionId, name? })` →
  `Result<RemoteControlStatus>` — resolves `starting`.
- `francois:remote:stop` → `remote_stop({ sessionId })` → `Result<RemoteControlStatus>`
- `francois:remote:get` → `remote_get({ sessionId })` → `Result<RemoteControlStatus>`
- `francois:remote:event` → `francois://remote/event`, payload
  `{ type: 'remote.status', sessionId, state }`.

`RemoteControlState` is tagged on `phase`: `off` | `starting{name,startedAt}` |
`active{name,startedAt,url}` | `failed{name,error}`.

## 6. Data & state

Nothing is persisted. A host is process-lifetime state in `RemoteRegistry`
(`sessionId → { killer, state, stopped, master }`); on restart every session is
`off`. The remote session itself survives on Anthropic's side only as long as the
host process does.

## 7. Edge cases & errors

1. **Francois cannot be the remote client.** Outbound-only relay, no local protocol.
   Host side is the whole feature; any spec text implying otherwise is wrong.
2. **`-p` + `--remote-control` silently does nothing.** Verified live: exit 0, a
   normal headless turn, no registration, no URL. A regression that reintroduced
   print mode here would look like success — hence the guard test.
3. **A fresh host writes no transcript.** Verified live: `--session-id` + no user
   turn ⇒ no `.jsonl` at all, so `bridge_status` never appears and only FR-10 fires.
   The historic records were appended to already-live transcripts. Both sources are
   load-bearing; neither alone is sufficient.
4. **Stale `bridge_status` records.** A project dir accumulates one per past remote
   session; the mtime gate in FR-9 is what stops the newest old one being served as
   this run's URL.
5. **Consent/trust stall.** FR-13. Print-mode turns never hit this, so it is unique
   to this feature; the words are split by cursor-forward codes, so raw substring
   matching fails — normalization is required.
6. **Eligibility.** Requires a claude.ai Pro/Max/Team/Enterprise login; API keys,
   `setup-token`/`CLAUDE_CODE_OAUTH_TOKEN`, Bedrock/Vertex/Foundry and a non-Anthropic
   `ANTHROPIC_BASE_URL` are all rejected by the CLI. Surfaces as `failed` via FR-14.
7. **`wsl` runtime.** The transcript lives inside the distro, not the Windows-side
   `~/.claude`, so FR-8/FR-9 are skipped and FR-10 carries the feature.
8. **Ultraplan** disconnects an active remote session (both occupy claude.ai/code).
   Observed as the host exiting or the remote session going away; not modelled.
9. **~10min offline** ends the remote session CLI-side; the host exits → FR-14.

## 8. Design brief

An `rc` chip in the SESSION tab header meta row with a status dot
(`idle`→`--text-disabled`, `pending`→`--warn`, `ok`→`--success`, `error`→`--error`)
and the short handle when active. Cold, the chip starts a host; live, it discloses a
popover with the full URL, a copy action, and stop. No new colors or glyphs.

**Deferred**: the QR code (§2 lists the URL as the goal; there is no QR library in
the dependency set and rendering one by hand is out of scope for MVP — copy-url
covers the phone case in one extra step). Also deferred: the pane [1] per-session
dot, which needs the sidebar row to gain a second badge slot.

## 9. Acceptance criteria

- `remote_start` on a session with a thread resumes it and reaches `active` with a
  `https://claude.ai/code/session_…` URL; the phone shows the same conversation.
- A fresh session reaches `active` too (PTY source).
- A folder with unapproved MCP consent reaches `failed` within seconds, naming the
  fix — not after 120s.
- Stop, and app exit, leave no `claude` host process behind.
- Historic `bridge_status` records in the project dir are never reported as the
  current URL.
- `cargo test` + `npm test` green; `npx tsc --noEmit` clean. The live end-to-end
  check is `cargo test -- --ignored live_pty_host_publishes_a_session_url`
  (needs auth + network; creates and tears down a real remote session).
