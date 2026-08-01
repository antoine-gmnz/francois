// remote-control (specs/remote-control.md) — pure view/reducer logic for the
// per-session Remote Control host. The core owns the process; this module owns how
// its state is folded and rendered.

import type { AppError, SessionId } from '../../../contract/common';
import type { McpApprovalState } from '../../../contract/mcp-panel';
import type { RemoteControlEvent, RemoteControlState, RemoteControlStatus } from '../../../contract/remote-control';

/** sessionId → host state. Sessions with no host are simply absent. */
export type RemoteMap = Record<SessionId, RemoteControlState>;

/**
 * Fold a remote.status event into the map. `off` DELETES the entry rather than
 * storing `{phase:'off'}` so "is anything remote-controlled?" stays a key count and
 * a stopped host leaves no residue behind.
 */
export function applyRemoteEvent(map: RemoteMap, event: RemoteControlEvent): RemoteMap {
  if (event.type !== 'remote.status') return map;
  if (event.state.phase === 'off') {
    if (!(event.sessionId in map)) return map;
    const next = { ...map };
    delete next[event.sessionId];
    return next;
  }
  return { ...map, [event.sessionId]: event.state };
}

/** Same fold, for the Result payload of remote_start / remote_stop / remote_get. */
export function applyRemoteStatus(map: RemoteMap, status: RemoteControlStatus): RemoteMap {
  return applyRemoteEvent(map, {
    type: 'remote.status',
    sessionId: status.sessionId,
    state: status.state,
  });
}

/**
 * Fold a seed response (the mount-time `remote_get`) into the map. A seed's only
 * job is to fill a hole: the command response and the event stream are
 * independent, unordered deliveries, so a seed that lands after a `remote_start`
 * or an event has already populated the entry must never clobber it (H2 #1 — a
 * stale `off` seed deleting a host that has since started).
 */
export function applySeedStatus(map: RemoteMap, status: RemoteControlStatus): RemoteMap {
  if (status.sessionId in map) return map;
  return applyRemoteStatus(map, status);
}

/**
 * Fold a start/stop command result into the map, guarded against a stale response
 * racing the event stream (H2 #2). The core's `starting` → `active` transition is
 * single-shot: once the event stream has already promoted a session to `active`, a
 * `starting` result carrying an older (or equal) `startedAt` is a late command
 * response for a spawn the UI has already moved past, and folding it would revert
 * the chip to *connecting…* with no further event ever correcting it. Deliberately
 * NOT applied in applyRemoteEvent — events arrive ordered on one channel and must
 * stay last-write-wins.
 */
export function applyRemoteResult(map: RemoteMap, status: RemoteControlStatus): RemoteMap {
  const current = map[status.sessionId];
  if (
    current?.phase === 'active' &&
    status.state.phase === 'starting' &&
    current.startedAt >= status.state.startedAt
  ) {
    return map;
  }
  return applyRemoteStatus(map, status);
}

/** Build a `failed` state from a command Result error (H5) — the popover's reason
 * line and the `error` badge tone both reuse the normal `failed` phase. */
export const remoteFailure = (name: string, error: AppError): RemoteControlState => ({
  phase: 'failed',
  name,
  error,
});

const OFF: RemoteControlState = { phase: 'off' };

export const remoteStateOf = (map: RemoteMap, sessionId: SessionId): RemoteControlState => map[sessionId] ?? OFF;

/** The URL to open or copy, when there is one. */
export const remoteUrlOf = (state: RemoteControlState): string | null =>
  state.phase === 'active' ? state.url : null;

/** True while a host exists — `starting` counts, so the toggle reads as ON at once. */
export const isRemoteLive = (state: RemoteControlState): boolean =>
  state.phase === 'starting' || state.phase === 'active';

/**
 * The claude.ai session id (`session_01AB…`) for a compact display, or null. Kept
 * separate from the URL so the UI can show a short handle without re-parsing.
 */
export function remoteSessionHandle(state: RemoteControlState): string | null {
  const url = remoteUrlOf(state);
  if (!url) return null;
  const m = /\/code\/(session_[A-Za-z0-9]+)/.exec(url);
  return m ? m[1] : null;
}

/** One-line status text for the SESSION footer / sidebar badge. */
export function remoteLabel(state: RemoteControlState): string {
  switch (state.phase) {
    case 'off':
      return 'remote control off';
    case 'starting':
      return 'remote control connecting…';
    case 'active':
      return 'remote control active';
    case 'failed':
      return `remote control failed — ${state.error.message}`;
  }
}

/** Which dot colour the badge uses: matches the mock's status vocabulary. */
export function remoteDotTone(state: RemoteControlState): 'idle' | 'pending' | 'ok' | 'error' {
  switch (state.phase) {
    case 'off':
      return 'idle';
    case 'starting':
      return 'pending';
    case 'active':
      return 'ok';
    case 'failed':
      return 'error';
  }
}

/**
 * The approval state carried by a `MCP_APPROVAL_REQUIRED` failure, or null.
 *
 * The host is a real interactive TUI, so an undecided MCP-consent or folder-trust
 * dialog parks it forever; `remote_start` refuses up front and puts the decision
 * it is waiting on in `error.detail`. Recovering it here is what lets the popover
 * offer one click instead of sending the user to pane [4] and back. Defensive
 * about the shape: `detail` is `unknown` on the wire, and a malformed one must
 * degrade to the plain error message rather than render a broken button.
 */
export function approvalRequiredOf(state: RemoteControlState): McpApprovalState | null {
  if (state.phase !== 'failed' || state.error.code !== 'MCP_APPROVAL_REQUIRED') return null;
  const d = state.error.detail as Partial<McpApprovalState> | undefined;
  if (!d || !Array.isArray(d.pending)) return null;
  return {
    pending: d.pending.filter((n): n is string => typeof n === 'string'),
    approved: Array.isArray(d.approved) ? d.approved.filter((n): n is string => typeof n === 'string') : [],
    rejected: Array.isArray(d.rejected) ? d.rejected.filter((n): n is string => typeof n === 'string') : [],
    trustRequired: d.trustRequired === true,
    enableAllProjectMcpServers: d.enableAllProjectMcpServers === true,
  };
}

/** Sessions currently reachable from a phone/browser. */
// pane [1] dot — deferred, see spec §8
export const liveRemoteSessionIds = (map: RemoteMap): SessionId[] =>
  Object.keys(map).filter((id) => isRemoteLive(map[id]));
