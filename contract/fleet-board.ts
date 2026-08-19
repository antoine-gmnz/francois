// contract/fleet-board.ts — fleet-board (pane [1], the Mission Control status board).
// Evolves sessions-sidebar's row list into a per-session status card. Frontend-only:
// NO IPC command, NO francois://…/event member, NO ErrorCode is defined here — the
// board aggregates the already-existing channels listed in specs/fleet-board.md §5.
// Imports shared vocabulary from common.ts; never redefines it. This file is the
// single source of the status→label/colour map and the relative-time formatter
// (both pure, frontend-only). Context tokens are formatted with formatContextTokens
// from contract/conversation-view.ts (imported at the call site, not duplicated).

import type { SessionId, SessionStatus, SessionEvent } from './common';

// ---------- consumed session-event members ----------
// fleet-board subscribes to francois:session:event and handles exactly these
// members; every other SessionEvent member is ignored by this feature (FR-3/FR-5).
export type FleetHandledSessionEvent = Extract<
  SessionEvent,
  | { type: 'session.meta' }
  | { type: 'session.status' }
  | { type: 'session.removed' }
  | { type: 'context.usage' }
  | { type: 'agent.update' }
>;

// ---------- per-session derived aggregate (in-memory, frontend-only) ----------
/**
 * The two figures the board derives per session ON TOP of its cached SessionMeta.
 * status / model / contextUsedTokens / contextLimitTokens / lastActivityAt come
 * straight from SessionMeta (common.ts) and are deliberately NOT duplicated here.
 */
export interface SessionDerived {
  /**
   * Uncommitted-file count for the session's cwd (FR-6):
   *   null  = unknown — no diff.changed seen yet and the diff_get_summary seed has
   *           not resolved (or the cwd is not a git repo)  → render NO diff badge.
   *   0     = known-clean                                   → render NO diff badge.
   *   > 0   = render the count pill.
   * Seeded once via the existing francois:diff:getSummary read on first appearance,
   * then kept live by francois:diff:event `diff.changed`.
   */
  fileCount: number | null;
  /** This session's subagents currently in status 'running' (FR-5). 0 when none. */
  runningAgentCount: number;
  /**
   * design 12b: the working tree's line totals, for the settled row's third line
   * (`+184 −52 · 6 files, uncommitted`). Same source as `fileCount` — the
   * `diff_get_summary` read — but NOT kept live by `diff.changed`, which carries
   * only a count: they are refreshed when the session SETTLES, which is the only
   * state whose row renders them. null ⇒ unknown, render no totals.
   */
  addedLines: number | null;
  deletedLines: number | null;
}

// ---------- status presentation (single source; frontend-only) ----------
/**
 * Every SessionStatus, in lifecycle order. Exhaustive — a `switch` or a test that
 * iterates this is what catches a new status added to common.ts.
 */
export const SESSION_STATUSES: readonly SessionStatus[] = [
  'starting',
  'running',
  'awaiting_approval',
  'awaiting_input',
  'idle',
  'done',
  'error',
];

/**
 * The board relabels the backend SessionStatus values. `idle` stays "ready" — a
 * session that merely finished its turn is not asking for anything. The two
 * `awaiting_*` labels are the ones that DO ask, and they name what they want
 * ("approval" / "question") rather than a generic "blocked", because the action
 * the user has to take differs.
 */
export const STATUS_LABEL: Record<SessionStatus, string> = {
  starting: 'starting',
  running: 'active',
  awaiting_approval: 'approval',
  awaiting_input: 'question',
  idle: 'ready',
  done: 'done',
  error: 'error',
};

/**
 * Dot fill + status-line colour per status (tokens from PROJECT.md's palette).
 * Acid (`#c3f53f`) stays reserved for `running` — the design system's "one live
 * thing per view" rule — so `starting` takes a muted acid and the two blocked
 * states take the warm family, which reads as "you" without reading as failure.
 */
export const STATUS_COLOR: Record<SessionStatus, string> = {
  starting: '#8ea84a',
  running: '#c3f53f',
  awaiting_approval: '#e0a84e',
  awaiting_input: '#d4c46f',
  idle: '#4fae86',
  done: '#8b93a3',
  error: '#d1685e',
};

/**
 * The dot pulses while the session is DOING something — spawning or streaming.
 * A blocked session deliberately does not pulse: it is not working, it is
 * waiting on the user, and `statusNeedsAttention` is what marks that instead.
 */
export function statusPulses(status: SessionStatus): boolean {
  return status === 'running' || status === 'starting';
}

/**
 * True while the session is parked on the user (approval or question). These are
 * the sessions a fleet scan must land on first — the turn is stalled until the
 * user acts, so the card gets the attention treatment rather than a pulse.
 */
export function statusNeedsAttention(status: SessionStatus): boolean {
  return status === 'awaiting_approval' || status === 'awaiting_input';
}

/**
 * True whenever a turn is in flight — including the two parked states, whose
 * claude process is very much alive. Every "is this session busy?" check must go
 * through this: `status === 'running'` silently treats a session waiting on an
 * approval as free, which would let a second turn spawn on top of it.
 */
export function isBusyStatus(status: SessionStatus): boolean {
  return (
    status === 'starting' ||
    status === 'running' ||
    status === 'awaiting_approval' ||
    status === 'awaiting_input'
  );
}

/** True for the statuses that end a session for good — it accepts no more turns. */
export function isTerminalStatus(status: SessionStatus): boolean {
  return status === 'done' || status === 'error';
}

// ---------- relative time (pure; FR-13) ----------
/**
 * Compact relative-time token for a card's last-activity label — 'now', '45s',
 * '2m', '3h', '5d'. No 'ago' suffix (the card is space-constrained). A future
 * `then` (clock skew) clamps to 'now'. `now` defaults to Date.now().
 */
export function formatRelativeTime(then: number, now: number = Date.now()): string {
  const ms = Math.max(0, now - then);
  const s = Math.floor(ms / 1000);
  if (s < 10) return 'now';
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

// ---------- derived-map helper (pure) ----------
/** runningAgentCount from a session's tracked agent-status map (FR-5). */
export function countRunning(agents: ReadonlyMap<string, SessionStatus>): number {
  let n = 0;
  for (const st of agents.values()) if (st === 'running') n++;
  return n;
}

export type { SessionId };
