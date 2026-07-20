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
}

// ---------- status presentation (single source; frontend-only) ----------
/**
 * The board relabels the four backend SessionStatus values. There is deliberately
 * NO "needs input" state: a session that finished its turn is `idle` — i.e.
 * ready/waiting for the user (§1/§2, FR-9).
 */
export const STATUS_LABEL: Record<SessionStatus, string> = {
  running: 'active',
  idle: 'ready',
  done: 'done',
  error: 'error',
};

/** Dot fill + status-line colour per status (tokens from PROJECT.md's palette). */
export const STATUS_COLOR: Record<SessionStatus, string> = {
  running: '#d0a45c',
  idle: '#6b7079',
  done: '#7fa07a',
  error: '#c46b62',
};

/** True only for `running` — the sole status whose dot pulses (FR-9). */
export function statusPulses(status: SessionStatus): boolean {
  return status === 'running';
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
