---
id: cloud-sessions
title: Cloud Sessions (adopt a Claude Code on the web session)
status: shipped
branch: feat/cloud-sessions
created: 2026-08-11
depends_on: [session-engine, durable-sessions, session-worktree, projects, multi-account, sessions-sidebar, command-palette]
loop_pass: 0
loop_phase: done
reviewed_base: 8c6f1c27386e840e2b861d961f56e885a54319ae
reviewed_digest: 8839174f70958dcc
design_files:
  - https://claude.ai/design/p/a4b15728-147c-4932-b83c-f60a5fc60db7?file=Francois%20Design%20System%20v2.dc.html
  - https://claude.ai/design/p/a4b15728-147c-4932-b83c-f60a5fc60db7?file=Francois%20Redesign.dc.html
---

# Cloud Sessions (adopt a Claude Code on the web session)

## 1. Summary

Francois **adopts** a Claude Code on the web (cloud) session: the user pastes its
`claude.ai/code` URL or picks it from a list, chooses where it lands on disk, and it becomes
an ordinary local Francois session carrying the cloud conversation history with the session's
branch checked out. Work dispatched from a phone or claude.ai comes back to the fleet view
with the transcript, DIFF, agents panel and everything else a local session gets. Adoption is
a **one-way pull** — after it, the cloud copy no longer receives the user's work.

## 2. Goals & non-goals

- **Goals**:
  - Adopt a cloud session via `claude --teleport <id>` driven in a core-owned PTY.
  - Two discovery paths: **paste** a URL/id (authoritative — must work with the list absent)
    and a **list** read from the cloud sessions REST API (convenience — degrades to empty,
    never to wrong).
  - Per-adoption landing: a fresh `git worktree` (**default**, reuses `session-worktree`) or
    the selected project's existing checkout.
  - A named, actionable failure for every documented precondition and every PTY stall point.
  - A `cloud` provenance chip so it is legible the session came from the cloud.
- **Non-goals**:
  - **Starting** a cloud session from Francois (`claude --cloud "task"`) — separate spec.
  - **Steering** a cloud session in place (`claude -p --cloud <id>`) — separate spec.
  - **Attaching** a live terminal (`claude --cloud <id>`): `--output-format stream-json` is
    unsupported with `--cloud <id>`, so attaching costs the transcript, agents panel and DIFF.
  - **Remote Control sessions on other machines** — reachable only via cross-session
    messaging, which is message-only and unavailable on native Windows.
  - Any two-way mirror; rendering teleport's TUI; answering its dialogs for the user.
  - Refreshing or writing Anthropic credentials. Francois **reads** a token, never mints one.

## 3. User stories / flows

1. **Back at the desk.** User opens the adopt modal from pane [1] or ⌘K. The list shows the
   three sessions they started on the train. They pick one, leave the landing on *worktree*,
   hit Adopt. Phases tick past; the session appears in pane [1] with a `cloud` chip, selected,
   its transcript already scrolled to the cloud conversation.
2. **Paste path.** The list is empty (token expired, offline, endpoint moved). The user pastes
   `https://claude.ai/code/session_abc…` and adoption works unchanged.
3. **Repo unknown.** The cloud session's repo matches no registered project. The modal asks
   which project to land in rather than guessing.
4. **Checkout landing.** The user picks *this project's checkout*. A confirmation names the
   branch and warns that teleport stashes uncommitted changes. Only then does adoption run.
5. **Blocked.** The account has no claude.ai login. Within seconds the modal reads
   "Cloud sessions need a claude.ai login — API key auth is not sufficient", not a spinner.

## 4. Functional requirements

**Core — auth & discovery**

- **FR-1 (token).** Read `claudeAiOauth.accessToken` + `expiresAt` from
  `<configDir>/.credentials.json`, where `<configDir>` is the adopting account's
  `CLAUDE_CONFIG_DIR` (`account::config_dir_of`), else the global `~/.claude`. On macOS, if
  the file is absent, fall back to the login keychain item `Claude Code-credentials`. A missing
  token ⇒ `CLOUD_AUTH_REQUIRED`; `expiresAt` in the past ⇒ `CLOUD_AUTH_EXPIRED`. Francois
  **never** refreshes the token — that is the CLI's job.
- **FR-2 (list).** `cloud_list` issues `GET https://api.anthropic.com/v1/code/sessions?limit=100`
  with `Authorization: Bearer <accessToken>`. Map each entry to `CloudSession`, keeping only
  fields the response actually carries — absent fields are `null`, never invented. **Any**
  non-200, parse failure, timeout (10s) or unexpected shape resolves `ok:true` with an empty
  list and `degraded: true` — the list never blocks the paste path or raises an error. Only
  FR-1 auth failures resolve as errors, because those are actionable.
- **FR-3 (resolve).** `cloud_resolve` normalizes a ref: a bare `session_…`/`cse_…` id, or a
  `claude.ai/code/<id>` URL with or without scheme, trailing slash or query string. Anything
  else ⇒ `INVALID_INPUT`. It then issues `GET /v1/code/sessions/<id>` to fill `repo`/`branch`
  so the modal can pre-select a project; a non-200 here resolves the ref with null metadata
  rather than failing — adoption may still succeed, teleport does its own validation.

**Core — adoption**

- **FR-4 (landing dir).** `destination: 'worktree'` creates the worktree through the existing
  `session-worktree` path (branch = the cloud session's branch when known, else
  `cloud/<shortId>`), based on the selected project's root. `destination: 'checkout'` uses the
  project root as-is. The directory exists and is a git repo **before** teleport spawns.
- **FR-5 (spawn + pre-minted id).** Mint a uuid-v4 and spawn
  `claude --teleport <cloudId> --session-id <uuid>` in a PTY at 200×50, cwd = the landing dir,
  through `claude_invocation` so the `wsl` runtime is wrapped exactly as turns are. Interactive,
  never `-p`. The pre-minted id is what makes the handoff deterministic: it is the **local**
  session teleport hydrates, and therefore the `claudeSessionId` the session resumes with.
- **FR-6 (id fallback).** `--teleport` is a hidden flag (FR-13); if no transcript appears at
  `<configDir>/projects/<slug>/<uuid>.jsonl`, fall back to the newest `.jsonl` in that dir
  **modified at/after the spawn instant** — the `remote-control` FR-9 mtime gate, for the same
  reason: a long-lived project dir is full of older transcripts. `<slug>` maps every
  non-ASCII-alphanumeric character of the cwd to `-`, case preserved. Neither source landing
  before the deadline ⇒ `CLOUD_ADOPT_FAILED`.
- **FR-7 (phases).** Emit `cloud.adopt` on every transition:
  `resolving` → `preparing` → `teleporting` → `hydrating` → `ready` | `failed{error}`.
  `preparing` covers worktree creation, `teleporting` the PTY up to branch checkout,
  `hydrating` the wait for the transcript. A silent adoption is a bug report.
- **FR-8 (stall detection).** Normalize PTY output (each escape sequence → one space,
  whitespace collapsed — raw substring matching fails because words are split by cursor-forward
  codes) and match teleport's blocking dialogs: repo mismatch ("Run claude --teleport from a
  checkout of"), host-unverified, the stash prompt, and the MCP/trust consent dialogs. On a
  match: fail immediately with the mapped code and kill the child, which would otherwise wait
  forever for a keypress. Francois never auto-answers these — they are the user's decisions.
- **FR-9 (deadline).** 180s from spawn to `ready`, and the PTY master is drained continuously
  regardless; an unread master eventually blocks the child. Timeout ⇒ `CLOUD_ADOPT_STALLED`
  naming the last phase reached.
- **FR-10 (session creation).** On `ready`, kill the PTY, then create the Francois session with
  `cwd` = landing dir, `projectId`, the account used for FR-1, `claudeSessionId` = the id from
  FR-5/FR-6, and `cloud: { cloudSessionId, adoptedAt }`. Subsequent turns resume it over the
  normal `claude --resume` pipeline — no cloud-specific turn path exists.
- **FR-11 (no orphans).** A failed or cancelled adoption kills the PTY and removes a worktree
  it created in this run (never one that already existed). Adoption PTYs are killed on
  `RunEvent::Exit`.
- **FR-12 (destructive confirm).** `destination: 'checkout'` requires `confirmed: true` in the
  request; without it ⇒ `INVALID_INPUT`. The core does not stash on the user's behalf — teleport
  does, and the confirmation is what makes that consented.
- **FR-13 (hidden-flag guard).** A test asserts `claude --teleport <id> --session-id <uuid>` is
  still accepted (no "unknown option", no "cannot be combined"). `--teleport` and `--cloud` are
  `.hideHelp()` on 2.1.222 — absent from `claude --help` — so a surface that can move without
  deprecation needs a canary.

**Frontend**

- **FR-14 (modal).** One "Adopt cloud session" modal opened from a pane [1] action next to
  "new session" and from a ⌘K command. Contents: paste field, the FR-2 list below it, a
  worktree/checkout landing toggle defaulting to **worktree**, and a project selector —
  pre-selected when `cloud_resolve` matched a project by repo, required when it did not.
- **FR-15 (progress).** The modal renders the FR-7 phase, not a spinner. `failed` renders the
  mapped message and leaves the modal open with the input intact so a retry costs one click.
- **FR-16 (provenance).** A `cloud` chip on the pane [1] row and in the SESSION header meta
  row, reusing the `rc` chip's shape. Its tooltip states the one-way rule explicitly.
- **FR-17 (degraded list).** An empty `degraded` list renders as one line — "Couldn't load your
  cloud sessions; paste a link instead" — never as an error state that hides the paste field.

## 5. API contract

`contract/cloud-sessions.ts`. New domain **`cloud`** (`remote` belongs to `remote-control`;
appended to PIPELINE.md §Domains). Shared types are imported from `contract/common.ts` and
never redefined.

```ts
import type { Result, SessionId, ProjectId, AccountId } from './common';

export type CloudSessionId = string; // 'session_…' | 'cse_…'

export interface CloudSession {
  id: CloudSessionId;
  title: string | null;      // null when the API returns none — never synthesized
  repo: string | null;       // 'owner/name' when known
  branch: string | null;
  updatedAt: number | null;  // epoch ms
}

// ---------- francois:cloud:list ----------
export interface CloudListRequest { accountId?: AccountId } // omit => default account
export interface CloudListData {
  sessions: CloudSession[];
  degraded: boolean; // true => the fetch failed/was unparseable; sessions is []
}
// invoke('cloud_list', req): Promise<Result<CloudListData>>
// errors: 'CLOUD_AUTH_REQUIRED' | 'CLOUD_AUTH_EXPIRED' | 'CLOUD_POLICY_DENIED'
//         | 'CLOUD_DEVICE_UNTRUSTED' | 'INTERNAL'
// Everything else (non-200, timeout, bad shape) => ok:true, degraded:true, sessions:[].

// ---------- francois:cloud:resolve ----------
export interface CloudResolveRequest { ref: string; accountId?: AccountId }
export interface CloudResolveData {
  session: CloudSession;              // metadata null when the lookup failed
  matchedProjectId: ProjectId | null; // repo matched a registered project
}
// invoke('cloud_resolve', req): Promise<Result<CloudResolveData>>
// errors: 'INVALID_INPUT' (unparseable ref) | 'CLOUD_SESSION_NOT_FOUND'
//         | 'CLOUD_AUTH_REQUIRED' | 'CLOUD_AUTH_EXPIRED' | 'INTERNAL'

// ---------- francois:cloud:adopt ----------
export type CloudDestination = 'worktree' | 'checkout';
export interface CloudAdoptRequest {
  ref: string;                  // URL or bare id; normalized core-side (FR-3)
  projectId: ProjectId;
  destination: CloudDestination;
  confirmed?: boolean;          // REQUIRED true when destination === 'checkout' (FR-12)
  accountId?: AccountId;
}
export interface CloudAdoptData { sessionId: SessionId }
// invoke('cloud_adopt', req): Promise<Result<CloudAdoptData>>
// errors: 'INVALID_INPUT' | 'PROJECT_NOT_FOUND' | 'NOT_A_GIT_REPO'
//         | 'CLOUD_SESSION_NOT_FOUND' | 'CLOUD_AUTH_REQUIRED' | 'CLOUD_AUTH_EXPIRED'
//         | 'CLOUD_DEVICE_UNTRUSTED' | 'CLOUD_POLICY_DENIED' | 'CLOUD_REPO_MISMATCH'
//         | 'CLOUD_ADOPT_STALLED' | 'CLOUD_ADOPT_FAILED'
//         | 'WORKTREE_BRANCH_IN_USE' | 'WORKTREE_CREATE_FAILED' | 'GIT_ERROR'

// ---------- francois:cloud:event -> 'francois://cloud/event' ----------
export type CloudAdoptPhase =
  | { phase: 'resolving' }
  | { phase: 'preparing' }
  | { phase: 'teleporting' }
  | { phase: 'hydrating' }
  | { phase: 'ready'; sessionId: SessionId }
  | { phase: 'failed'; error: AppError };

export type CloudEvent = { type: 'cloud.adopt'; ref: string; state: CloudAdoptPhase };
```

**Added to `contract/common.ts`** — `SessionMeta.cloud?: CloudProvenance` with
`CloudProvenance { cloudSessionId: CloudSessionId; adoptedAt: number }` (presence ⇒ adopted),
and these `ErrorCode` members:

- `CLOUD_AUTH_REQUIRED` — no claude.ai token; API-key auth is not sufficient (`no_access_token`)
- `CLOUD_AUTH_EXPIRED` — token past `expiresAt`, or the API said so; run a turn or `/login`
- `CLOUD_DEVICE_UNTRUSTED` — `untrusted_device`; enrol the device with `/login`
- `CLOUD_POLICY_DENIED` — the org's `allow_remote_sessions` policy is off
- `CLOUD_SESSION_NOT_FOUND` — unknown/invalid cloud session id
- `CLOUD_REPO_MISMATCH` — teleport's `mismatch` / `not_in_repo` / `host_unverified`
  (detail: `{ sessionRepo, currentRepo }`)
- `CLOUD_ADOPT_STALLED` — a blocking dialog or the FR-9 deadline (detail: `{ phase }`)
- `CLOUD_ADOPT_FAILED` — the PTY exited without a usable local session

## 6. Data & state

- **Persisted**: only `SessionMeta.cloud` (FR-10), alongside the rest of `durable-sessions`
  state. Nothing about the cloud session itself is stored — no cached list, no token.
- **Process-lifetime (core)**: `CloudAdoptRegistry` — `ref → { killer, phase, startedAt,
  createdWorktree }`, used by FR-11 to tear down exactly what this run created.
- **Frontend**: the modal owns its own form state; the adopt phase folds into a single
  in-flight record, since only one adoption runs at a time. The resulting session enters the
  normal `sessionsStore` with no cloud-specific branch in the transcript path.

## 7. Edge cases & errors

1. **Hidden flags.** `--teleport [session]` ("Resume a teleport session, optionally specify
   session ID") and `--cloud [description|session_id|url]` are `.hideHelp()` on 2.1.222 —
   documented on the web, absent from `--help`. FR-13 is the canary.
2. **The handoff is by pre-minted id, not by parsing.** Teleport fetches the cloud event log,
   checks out the branch, then hands the messages to the **normal local REPL** — so the
   adopted thread is an ordinary local session. `--session-id` is accepted alongside
   `--teleport` (verified at parse time on 2.1.222). FR-6 exists because that is a hidden
   surface, not because the primary path is doubtful.
3. **The REST list is a convenience, not a contract.** The exact required headers beyond
   `Authorization` (the CLI also sends `X-Trusted-Device-Token` in some paths) were **not**
   verified live. FR-2's degrade-to-empty rule is what makes that acceptable: a wrong guess
   costs the list, never the feature. Confirm during build with one authenticated call.
4. **Auth errors wear Remote Control wording.** Teleport rides the same infrastructure, so the
   CLI may say "Remote Control session expired" / "Access denied". Map to the FR-codes above
   and render honest text — never surface the word "Remote Control" in this feature's UI.
5. **Eligibility mirrors Remote Control.** claude.ai Pro/Max/Team/Enterprise login; API keys,
   `setup-token`/`CLAUDE_CODE_OAUTH_TOKEN`, Bedrock/Vertex/Foundry and a non-Anthropic
   `ANTHROPIC_BASE_URL` are all rejected ⇒ `CLOUD_AUTH_REQUIRED`.
6. **Four preconditions, four named failures**: same claude.ai account (FR-1), clean git state
   (FR-12's confirmation), a checkout of the *same* repository — not a fork
   (`CLOUD_REPO_MISMATCH`), and the branch pushed to the remote (`CLOUD_ADOPT_FAILED` with
   teleport's own reason in `detail`).
7. **`wsl` runtime.** The transcript lives inside the distro, so FR-6's paths resolve against
   the distro's `$HOME`, not the Windows-side `~/.claude`. `claude_invocation` handles the
   wrapping (FR-5).
8. **One-way is load-bearing.** If the UI implies the phone still sees the session, users lose
   work believing it does — hence FR-16's tooltip, not a footnote.
9. **Adoption is not re-entrant.** A second `cloud_adopt` for a ref already in the registry
   returns the in-flight phase rather than spawning a second PTY.

## 8. Design brief

The "Adopt cloud session" modal (paste field → degraded-tolerant list → landing toggle →
project selector → phase progress) plus a `cloud` provenance chip on the pane [1] row and the
SESSION header, shaped exactly like the existing `rc` chip. No new colors, tokens or glyphs —
the chip reuses the status-dot family and the modal reuses `Modal`/`ListRow`/`Chip` from
`src/ui/`.

> full brief: specs/design/cloud-sessions.md

## 9. Acceptance criteria

- [ ] Pasting a `claude.ai/code/<id>` URL **or** a bare `session_…` id, with the list empty,
      adopts the session: it appears in pane [1] with the cloud transcript and a `cloud` chip. (FR-3, FR-5, FR-10)
- [ ] The adopted session takes a normal turn afterwards over `claude --resume` with no
      cloud-specific path, and survives quit/reopen with its provenance. (FR-10)
- [x] Landing defaults to a fresh worktree; the branch is the cloud session's when known. (FR-4, FR-14)
- [x] `destination: 'checkout'` without `confirmed: true` is refused with `INVALID_INPUT`. (FR-12)
- [x] A revoked/expired token surfaces `CLOUD_AUTH_EXPIRED` with actionable text in seconds — not after the deadline. (FR-1)
- [x] A non-200 or unparseable list response yields `ok:true, degraded:true, sessions:[]`, and the paste field still works. (FR-2, FR-17)
- [x] A repo-mismatch dialog fails the adoption within seconds naming both repos, and leaves no PTY and no worktree behind. (FR-8, FR-11)
- [x] `cargo test` + `npm test` green; `npx tsc --noEmit` clean. Live check:
      `cargo test -- --ignored live_teleport_adopts_a_cloud_session` (needs auth, network and a real cloud session).

> **Ticked by `/cohorte-review` round 2 (2026-08-11)** on the evidence the pipeline actually has:
> a green preflight (`cargo test` + `npm test` + `npx tsc --noEmit`) plus the round-2 review's
> spec-conformance pass. The test backing each ticked criterion:
> `landing.rs::the_worktree_branch_is_the_cloud_sessions_when_known` +
> `a_worktree_landing_checks_out_the_cloud_sessions_branch_before_teleport_spawns` ·
> `adopt.rs::INVALID_INPUT` confirm cases · `auth.rs` + `api.rs` `CLOUD_AUTH_EXPIRED` cases ·
> `api.rs::list_result(CloudFetch::{NotFound,Degraded})` + `cloud-sessions.test.ts` degraded cases ·
> `detect.rs::a_repo_mismatch_dialog_fails_with_both_repos` +
> `landing.rs::a_failed_adoption_removes_the_worktree_it_created_and_keeps_one_it_did_not`.
>
> **Left open on purpose — nothing in the pipeline runs the app:** the first two criteria (an
> end-to-end adopt showing transcript + `cloud` chip in pane [1]; the adopted session taking a real
> turn over `claude --resume`). The quit/reopen provenance half of criterion 2 *is* covered by
> `persistence.rs::cloud_provenance_round_trips_through_a_persisted_record`, but the turn itself is
> not. The `--ignored` live check named in the last criterion was **not run** (needs auth, network
> and a real cloud session) — the checkbox reflects the three mechanical gates only.

## Remediation

### 2026-08-11 · round 1 (REVIEW REPORT — REVISE · 8 findings, 2 blocking)

> **All 8 closed.** Round 2 (`/cohorte-review`, SHIP) re-read each item against the code and
> confirmed the prescribed fix landed and is test-covered — see the per-item evidence in
> `specs/reports/cloud-sessions.md` §Round-2 verification. No item was closed on assertion alone.

- [x] CRITICAL · `src-tauri/src/session/cloud/api.rs:505` · spec-violation · `cloud_resolve` returns `err(code, message)` for any `CloudFetch::Actionable` result from the `GET /v1/code/sessions/<id>` lookup (403 `untrusted_device`/`policy`, 401 body), contradicting FR-3 ("a non-200 here resolves the ref with null metadata rather than failing — adoption may still succeed, teleport does its own validation") and leaking `CLOUD_DEVICE_UNTRUSTED`/`CLOUD_POLICY_DENIED`, which are not in `cloud_resolve`'s documented error union (`contract/cloud-sessions.ts:106-107`). **Fix:** make that branch fall through to a null-metadata `CloudSession` exactly like the `CloudFetch::Degraded` arm; keep `return err(...)` only for the FR-1 token precheck (`cloud_token_for`) a few lines above.

- [x] CRITICAL · `src-tauri/src/session/cloud/adopt.rs:429` + `src-tauri/src/session/cloud/api.rs:400-409` + `src-tauri/src/session/cloud/detect.rs:67` · spec-violation · `cloud_adopt` can never produce `CLOUD_DEVICE_UNTRUSTED`/`CLOUD_POLICY_DENIED` even though the contract lists both as valid adopt errors (`contract/cloud-sessions.ts:149`) and §2 Goal demands "a named, actionable failure for every documented precondition": `lookup_cloud_session` discards `CloudFetch::Actionable` into `None`, and `teleport_block` has no matcher for device/policy dialog text — so an untrusted device or policy-denied org fails only as a generic `CLOUD_ADOPT_STALLED`/`CLOUD_ADOPT_FAILED` after the full wait instead of "within seconds". **Fix:** surface the `CloudFetch::Actionable` result from the pre-spawn session lookup (or a dedicated pre-check) as an immediate `AdoptError`, and/or add PTY dialog matchers for the device/policy wording in `teleport_block`.

- [x] HIGH · `src/features/cloud-sessions/AdoptCloudSessionModal.tsx:154-158,345-347` · spec-violation · `specs/design/cloud-sessions.md` §Screens ("Cancel becomes Abort") and §Notes ("Esc cancels (and aborts an in-flight adoption)") require Escape/Cancel to abort a running adoption, but `close()` only unsubscribes from the event stream and the button reads "Run in background" — code and frozen design brief disagree. **Fix:** the contract exposes no cancel channel (no `cloud_cancel`/abort verb in `contract/cloud-sessions.ts`), and adding one is a contract change that would ripple into surfaces with no findings; the code is the honest side. Amend the design brief to match. — fixed: lead · `specs/design/cloud-sessions.md` §Screens in-flight state + §Notes Keyboard now specify "Run in background" and state there is deliberately no Abort. No code change; no contract change.

- [x] MEDIUM · `contract/cloud-sessions.ts:107,150` / `src-tauri/src/session/cloud/api.rs:324` · spec-violation · `CLOUD_SESSION_NOT_FOUND` is documented as a possible error for both `cloud_resolve` and `cloud_adopt`, but no code path ever returns it — `classify_api_error` never maps a 404 to it, so it is unreachable contract code. **Fix:** map a definitive 404 on the single-session lookup to `CLOUD_SESSION_NOT_FOUND` (lead decision: keep the contract as frozen and make the code reach it — do NOT remove it from the unions, and do not edit `contract/cloud-sessions.ts`). Note this interacts with finding 1: `cloud_resolve` still resolves null-metadata rather than erroring for the *Actionable* 403/401 case; only a definitive 404 becomes `CLOUD_SESSION_NOT_FOUND`.

- [x] MEDIUM · `src-tauri/src/session/cloud/detect.rs:97,106,118` · spec-violation · the stash/MCP/trust `CloudBlock`s set `detail: None`, but the contract documents `CLOUD_ADOPT_STALLED`'s `detail` as `{ phase }` (`contract/common.ts`) — only the FR-9 timeout path (`adopt.rs:858-865`) includes it, so a dialog-triggered stall loses the phase a frontend renderer expects. **Fix:** thread the current phase into these `CloudBlock`s too (e.g. have `cloud_feed`/`teleport_block` take the current phase and set `detail: Some(json!({"phase": phase}))`).

- [x] MEDIUM · `src-tauri/src/project/registry.rs:421,438` · quality · `session_seed` and `project_roots` — new cross-domain lookups that gate `cloud_adopt`'s `PROJECT_NOT_FOUND` and every default applied to the created session — have zero unit tests; the existing `mod tests` at line 463 covers neither. **Fix:** add tests for a known id (field mapping), an unknown id (`None`), and `project_roots` on an empty and a non-empty registry.

- [x] LOW · `src/features/cloud-sessions/AdoptCloudSessionModal.tsx:167,192` (+ `src/app/App.tsx`) · quality · `App.tsx` passes a fresh inline `onClose={() => setAdoptCloudOpen(false)}` on every render, and `onClose` is a dependency of the "ready session" `useEffect([readySessionId, onClose])`; an App re-render during the async `sessionList()` round-trip re-runs the effect and can re-issue the fetch or re-call `setActiveSessionId`/`setMainTab`/`onClose` more than once. **Fix:** wrap `onClose` in `useCallback` where `App.tsx` renders `AdoptCloudSessionModal`, or read it through a ref inside the effect instead of listing it as a dependency.

- [x] LOW · `src/features/cloud-sessions/AdoptCloudSessionModal.tsx:197-225` · quality · the Esc/Enter/Arrow keydown `useEffect` has no dependency array, so it detaches and re-attaches a capture-phase `window` listener on every render. **Fix:** give the effect an explicit dependency array (`enabled`, `inFlight`, `cursor`, `list.sessions`, `submit`, `close`, `pick`) so it only re-subscribes when one of those changes.

**Deferred (not dispatched)** — reviewer-classified out of scope:

- LOW · `src-tauri/src/session/cloud/auth.rs:81` · quality · `eligibility_block` reads the raw process environment (`std::env::var`) regardless of the adopting account's `config_dir`, so per-account Bedrock/Vertex/base-URL routing can't be distinguished between accounts. Out of scope: per-account provider env routing is a `multi-account` concern, and today all accounts share one process environment.
