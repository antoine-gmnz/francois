// design 12b ("sorted by what wants you"): the roster's SECOND grouping mode.
// Groups are STATES, not projects — so a session parked on an approval can
// never be the fourth row down behind two repos you are not looking at.
//
// roster-groups.ts (grouping by repo, with the project-groups tier above it) is
// untouched and still the other half of the toggle; this module is the state
// half, and deliberately mirrors its shape — a node list, a flattener that
// reproduces the painted order for the keyboard cursor, and its own collapse
// record.

import type { SessionMeta, SessionStatus } from '../../../contract/common';
// roster-group-tier: type-only, so this stays a compile-time-only cycle with
// group-tier.ts (which imports RosterStateNode from here) — erased by tsc,
// no runtime circular import.
import type { RosterGroupTier } from './group-tier';

/**
 * The four buckets. `attention` is everything that is stalled ON THE USER —
 * both parked states plus `error`, whose session is equally stuck and equally
 * in need of a look. `archived` is the one terminal state that asks nothing.
 */
export type SessionState = 'attention' | 'running' | 'idle' | 'archived';

/** Painted order — fixed, never data-driven: the point of the mode is that the
 *  loud group is always first. */
export const STATE_ORDER: readonly SessionState[] = ['attention', 'running', 'idle', 'archived'];

export const STATE_LABEL: Record<SessionState, string> = {
  attention: 'waiting on you',
  running: 'running',
  idle: 'idle',
  archived: 'archived',
};

/**
 * The status each heading takes its colour from, so this file never re-states
 * the contract's STATUS_COLOR map (fleet-board.ts stays the single source).
 * Note this keeps the app's own reading of the palette rather than the mock's
 * hexes: amber means "come here", so the WAITING group is amber and RUNNING
 * takes the accent — the mock has the two the other way round, which would put
 * a second, louder meaning on the accent.
 */
export const STATE_STATUS: Record<SessionState, SessionStatus> = {
  attention: 'awaiting_approval',
  running: 'running',
  idle: 'idle',
  archived: 'done',
};

/** Which bucket a status falls in. Total over SessionStatus. */
export function stateOf(status: SessionStatus): SessionState {
  switch (status) {
    case 'awaiting_approval':
    case 'awaiting_input':
    case 'error':
      return 'attention';
    case 'starting':
    case 'running':
      return 'running';
    case 'idle':
      return 'idle';
    case 'done':
      return 'archived';
    default:
      return 'idle';
  }
}

export interface RosterStateNode {
  /** `state:<state>` — its own key space, shared with nothing else. */
  key: string;
  state: SessionState;
  label: string;
  sessions: SessionMeta[];
  /** roster-group-tier: FR-7-aware group tiers for this band, or `null` when
   *  suppressed (a single tier) or absent (no tier attached at all — paint
   *  `sessions` flat, exactly as before this feature existed). */
  tiers?: RosterGroupTier[] | null;
}

export function stateGroupKey(state: SessionState): string {
  return `state:${state}`;
}

/**
 * Bucket `sessions` by state. Groups come out in STATE_ORDER (not in arrival
 * order like the repo tier — a stable position is what lets the eye go to the
 * top of the pane for "what wants me"), and EMPTY groups are dropped, so a
 * fleet with nothing parked shows no WAITING heading at all.
 *
 * Sessions keep their incoming order inside a bucket, so the roster still
 * tracks whatever order the fleet store imposes rather than inventing a second.
 */
export function groupSessionsByState(sessions: readonly SessionMeta[]): RosterStateNode[] {
  const byState = new Map<SessionState, SessionMeta[]>();
  for (const session of sessions) {
    const state = stateOf(session.status);
    const bucket = byState.get(state);
    if (bucket) bucket.push(session);
    else byState.set(state, [session]);
  }
  return STATE_ORDER.filter((state) => byState.has(state)).map((state) => ({
    key: stateGroupKey(state),
    state,
    label: STATE_LABEL[state],
    sessions: byState.get(state)!,
  }));
}

/** The painted order, flattened — what the keyboard cursor indexes (a collapsed
 *  group's rows are not on screen, so they cannot take the cursor). */
export function flattenStateGroups(
  nodes: readonly RosterStateNode[],
  collapsed: ReadonlySet<string> = new Set(),
  collapsedTiers?: ReadonlySet<string>,
): SessionMeta[] {
  const out: SessionMeta[] = [];
  for (const node of nodes) {
    if (collapsed.has(node.key)) continue;
    if (node.tiers) {
      // roster-group-tier FR-21: bands -> tiers (FR-3 order) -> sessions
      // (FR-5 order), skipping a collapsed tier's sessions entirely.
      for (const tier of node.tiers) {
        if (collapsedTiers?.has(tier.key)) continue;
        out.push(...tier.sessions);
      }
      continue;
    }
    out.push(...node.sessions);
  }
  return out;
}

// ---------- collapse record (localStorage, its own key space) ----------

export const COLLAPSED_STATES_KEY = 'francois.collapsedStateGroups';

/**
 * ARCHIVED starts collapsed (the mock shows it as a caret + a count): a finished
 * session asks nothing, and the whole point of the mode is that the rows above
 * it fit without scrolling. Only applied when NOTHING has been persisted — once
 * the user has toggled anything, their record is the whole truth.
 */
export const DEFAULT_COLLAPSED_STATES: readonly string[] = [stateGroupKey('archived')];

/** Pure, exported for tests: malformed input degrades to the default, absent
 *  input IS the default. */
export function parseCollapsedStates(raw: string | null): Set<string> {
  if (raw === null) return new Set(DEFAULT_COLLAPSED_STATES);
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set(DEFAULT_COLLAPSED_STATES);
    return new Set(parsed.filter((k): k is string => typeof k === 'string'));
  } catch {
    return new Set(DEFAULT_COLLAPSED_STATES);
  }
}

export function loadCollapsedStates(): Set<string> {
  try {
    return parseCollapsedStates(localStorage.getItem(COLLAPSED_STATES_KEY));
  } catch {
    return new Set(DEFAULT_COLLAPSED_STATES);
  }
}

export function persistCollapsedStates(keys: ReadonlySet<string>): void {
  try {
    localStorage.setItem(COLLAPSED_STATES_KEY, JSON.stringify([...keys]));
  } catch {
    /* ignore */
  }
}
