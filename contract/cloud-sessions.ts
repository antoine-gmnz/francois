// contract/cloud-sessions.ts — specs/cloud-sessions.md
//
// Francois ADOPTS a Claude Code on the web (cloud) session: the user pastes its
// `claude.ai/code` URL or picks it from a list, chooses where it lands on disk, and it
// becomes an ordinary local Francois session carrying the cloud conversation history
// with the session's branch checked out.
//
// Adoption is a ONE-WAY PULL. After it, the cloud copy no longer receives the user's
// work. This is load-bearing: if the UI implies the phone still sees the session, users
// lose work believing it does (spec §7 #8).
//
// Mechanism: `claude --teleport <cloudId> --session-id <uuid>` driven in a core-owned
// PTY (FR-5). Teleport fetches the cloud event log, checks out the branch, then hands
// the messages to the NORMAL local REPL — so the adopted thread is an ordinary local
// session and subsequent turns resume over the usual `claude --resume` pipeline. There
// is no cloud-specific turn path.
//
// Wording note (spec §7 #4): teleport rides the same infrastructure as Remote Control,
// so the CLI's own auth errors may say "Remote Control session expired". Those are
// mapped to the CLOUD_* codes below and re-worded — the phrase "Remote Control" must
// never reach this feature's UI. It is a different object.

import type {
  AccountId,
  AppError,
  CloudSessionId,
  ProjectId,
  Result,
  SessionId,
} from './common';

/** Re-exported so this feature's modules have one import site for the id type. */
export type { CloudSessionId };

/**
 * One cloud session as the REST API describes it.
 *
 * Every field but `id` is nullable and every null is HONEST: the list endpoint is a
 * convenience, not a contract (spec §7 #3), so an absent field is rendered as absent
 * (or falls back to the short id) and is NEVER synthesized. A row that invents a title
 * or a branch is worse than a row that shows neither.
 */
export interface CloudSession {
  id: CloudSessionId;
  title: string | null; // null when the API returns none — never synthesized
  repo: string | null; // 'owner/name' when known
  branch: string | null;
  updatedAt: number | null; // epoch ms
}

// ---------- francois:cloud:list → `cloud_list` ----------

/** Omit `accountId` to use the default account (multi-account). */
export interface CloudListRequest {
  accountId?: AccountId;
}

/**
 * `degraded: true` means the fetch failed, timed out (10s) or was unparseable, and
 * `sessions` is therefore `[]`.
 *
 * FR-2 is deliberate and load-bearing: ANY non-200, parse failure, timeout or
 * unexpected shape resolves `ok:true` with `degraded:true` — the list never blocks the
 * paste path and never raises an error. Only the FR-1 auth failures below resolve as
 * errors, because those are the only ones the user can act on. This is what makes an
 * unverified endpoint shape acceptable: a wrong guess costs the list, never the feature.
 */
export interface CloudListData {
  sessions: CloudSession[];
  degraded: boolean;
}

/**
 * francois:cloud:list → `invoke('cloud_list', req): Promise<Result<CloudListData>>`
 *
 * errors: 'CLOUD_AUTH_REQUIRED' | 'CLOUD_AUTH_EXPIRED' | 'CLOUD_POLICY_DENIED'
 *       | 'CLOUD_DEVICE_UNTRUSTED' | 'INTERNAL'
 */
export type CloudListResult = Result<CloudListData>;

// ---------- francois:cloud:resolve → `cloud_resolve` ----------

/**
 * `ref` is a bare `session_…`/`cse_…` id, or a `claude.ai/code/<id>` URL with or
 * without scheme, trailing slash or query string (FR-3). Anything else ⇒ INVALID_INPUT.
 */
export interface CloudResolveRequest {
  ref: string;
  accountId?: AccountId;
}

/**
 * `session` carries null metadata when the `GET /v1/code/sessions/<id>` lookup failed —
 * resolving still succeeds, because adoption may work anyway and teleport does its own
 * validation (FR-3). `matchedProjectId` is set when `repo` matched a registered project,
 * which is what lets the modal pre-select quietly instead of guessing.
 */
export interface CloudResolveData {
  session: CloudSession;
  matchedProjectId: ProjectId | null;
}

/**
 * francois:cloud:resolve → `invoke('cloud_resolve', req): Promise<Result<CloudResolveData>>`
 *
 * errors: 'INVALID_INPUT' (unparseable ref) | 'CLOUD_SESSION_NOT_FOUND'
 *       | 'CLOUD_AUTH_REQUIRED' | 'CLOUD_AUTH_EXPIRED' | 'INTERNAL'
 */
export type CloudResolveResult = Result<CloudResolveData>;

// ---------- francois:cloud:adopt → `cloud_adopt` ----------

/**
 * Where the adopted session lands on disk.
 *
 * `worktree` (the default) creates a fresh `git worktree` through the existing
 * session-worktree path — branch = the cloud session's branch when known, else
 * `cloud/<shortId>`. `checkout` uses the selected project's root as-is, which is
 * destructive: teleport stashes uncommitted changes there.
 */
export type CloudDestination = 'worktree' | 'checkout';

export interface CloudAdoptRequest {
  ref: string; // URL or bare id; normalized core-side (FR-3)
  projectId: ProjectId;
  destination: CloudDestination;
  /**
   * REQUIRED `true` when `destination === 'checkout'` (FR-12); without it ⇒
   * INVALID_INPUT. The core does NOT stash on the user's behalf — teleport does, and
   * this flag is what makes that consented.
   */
  confirmed?: boolean;
  accountId?: AccountId;
}

/** The LOCAL Francois session the adoption produced. */
export interface CloudAdoptData {
  sessionId: SessionId;
}

/**
 * francois:cloud:adopt → `invoke('cloud_adopt', req): Promise<Result<CloudAdoptData>>`
 *
 * Not re-entrant (spec §7 #9): a second `cloud_adopt` for a ref already in flight
 * returns the in-flight phase rather than spawning a second PTY.
 *
 * errors: 'INVALID_INPUT' | 'PROJECT_NOT_FOUND' | 'NOT_A_GIT_REPO'
 *       | 'CLOUD_SESSION_NOT_FOUND' | 'CLOUD_AUTH_REQUIRED' | 'CLOUD_AUTH_EXPIRED'
 *       | 'CLOUD_DEVICE_UNTRUSTED' | 'CLOUD_POLICY_DENIED' | 'CLOUD_REPO_MISMATCH'
 *       | 'CLOUD_ADOPT_STALLED' | 'CLOUD_ADOPT_FAILED'
 *       | 'WORKTREE_BRANCH_IN_USE' | 'WORKTREE_CREATE_FAILED' | 'GIT_ERROR'
 */
export type CloudAdoptResult = Result<CloudAdoptData>;

// ---------- francois:cloud:event → 'francois://cloud/event' ----------

/**
 * Adoption progress (FR-7). Emitted on EVERY transition — a silent adoption is a bug
 * report, because this takes up to 180s (FR-9) and the UI renders these steps rather
 * than a spinner (FR-15).
 *
 *   resolving   — normalizing the ref and looking up its metadata
 *   preparing   — creating the worktree / validating the landing dir
 *   teleporting — the PTY is up, through branch checkout
 *   hydrating   — waiting for the local transcript to appear
 *   ready       — the Francois session exists and is usable
 *   failed      — mapped error; the modal keeps the ref so a retry costs one click
 */
export type CloudAdoptPhase =
  | { phase: 'resolving' }
  | { phase: 'preparing' }
  | { phase: 'teleporting' }
  | { phase: 'hydrating' }
  | { phase: 'ready'; sessionId: SessionId }
  | { phase: 'failed'; error: AppError };

/** The phase names in the order they occur — the frontend renders the full list. */
export const CLOUD_ADOPT_STEPS = [
  'resolving',
  'preparing',
  'teleporting',
  'hydrating',
  'ready',
] as const;

export type CloudAdoptStep = (typeof CLOUD_ADOPT_STEPS)[number];

/** `ref` echoes the request's ref verbatim, so a listener can match its own adoption. */
export type CloudEvent = {
  type: 'cloud.adopt';
  ref: string;
  state: CloudAdoptPhase;
};
