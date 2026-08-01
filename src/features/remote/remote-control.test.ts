import { describe, it, expect } from 'vitest';
import type { RemoteControlState } from '../../../contract/remote-control';
import {
  applyRemoteEvent,
  applyRemoteResult,
  approvalRequiredOf,
  applyRemoteStatus,
  applySeedStatus,
  isRemoteLive,
  liveRemoteSessionIds,
  remoteDotTone,
  remoteFailure,
  remoteLabel,
  remoteSessionHandle,
  remoteStateOf,
  remoteUrlOf,
  type RemoteMap,
} from './remote-control';

const URL = 'https://claude.ai/code/session_01Mo4r8N2qZBTbU4V647cis4';

const starting: RemoteControlState = { phase: 'starting', name: 'My Project', startedAt: 1 };
const active: RemoteControlState = { phase: 'active', name: 'My Project', startedAt: 1, url: URL };
const failed: RemoteControlState = {
  phase: 'failed',
  name: 'My Project',
  error: { code: 'REMOTE_CONTROL_FAILED', message: 'no session URL before the deadline' },
};

describe('approvalRequiredOf', () => {
  const approvalFailure = (detail: unknown): RemoteControlState => ({
    phase: 'failed',
    name: 'My Project',
    error: { code: 'MCP_APPROVAL_REQUIRED', message: 'Remote Control cannot start: 1 MCP server needs approval.', detail },
  });

  it('recovers the decision the host is waiting on', () => {
    const state = approvalFailure({
      pending: ['serena'],
      approved: ['fs'],
      rejected: [],
      trustRequired: true,
      enableAllProjectMcpServers: false,
    });
    expect(approvalRequiredOf(state)).toEqual({
      pending: ['serena'],
      approved: ['fs'],
      rejected: [],
      trustRequired: true,
      enableAllProjectMcpServers: false,
    });
  });

  it('is null for every other state and error code', () => {
    expect(approvalRequiredOf(starting)).toBeNull();
    expect(approvalRequiredOf(active)).toBeNull();
    expect(approvalRequiredOf(failed)).toBeNull();
    expect(approvalRequiredOf({ phase: 'off' })).toBeNull();
  });

  it('degrades to null rather than rendering a broken button on a malformed detail', () => {
    // `detail` is `unknown` on the wire — a shape change in the core must fall
    // back to the plain error message, not throw inside the popover.
    expect(approvalRequiredOf(approvalFailure(undefined))).toBeNull();
    expect(approvalRequiredOf(approvalFailure('nope'))).toBeNull();
    expect(approvalRequiredOf(approvalFailure({ trustRequired: true }))).toBeNull();
  });

  it('drops non-string names and defaults the missing flags', () => {
    const state = approvalFailure({ pending: ['ok', 7, null] });
    expect(approvalRequiredOf(state)).toEqual({
      pending: ['ok'],
      approved: [],
      rejected: [],
      trustRequired: false,
      enableAllProjectMcpServers: false,
    });
  });
});

describe('applyRemoteEvent', () => {
  it('stores starting, then upgrades the same session to active', () => {
    let map: RemoteMap = {};
    map = applyRemoteEvent(map, { type: 'remote.status', sessionId: 's1', state: starting });
    expect(map).toEqual({ s1: starting });

    map = applyRemoteEvent(map, { type: 'remote.status', sessionId: 's1', state: active });
    expect(map).toEqual({ s1: active });
    expect(Object.keys(map)).toHaveLength(1);
  });

  it('deletes the entry on off rather than storing an off state', () => {
    const map = applyRemoteEvent({ s1: active }, { type: 'remote.status', sessionId: 's1', state: { phase: 'off' } });
    expect(map).toEqual({});
    expect('s1' in map).toBe(false);
  });

  it('returns the SAME object when off arrives for an unknown session', () => {
    // Referential stability matters: a spurious new object re-renders every
    // subscriber for nothing.
    const before: RemoteMap = { s1: active };
    const after = applyRemoteEvent(before, {
      type: 'remote.status',
      sessionId: 'ghost',
      state: { phase: 'off' },
    });
    expect(after).toBe(before);
  });

  it('never mutates the input map', () => {
    const before: RemoteMap = { s1: starting };
    const after = applyRemoteEvent(before, { type: 'remote.status', sessionId: 's2', state: active });
    expect(before).toEqual({ s1: starting });
    expect(after).toEqual({ s1: starting, s2: active });
  });

  it('keeps sessions independent', () => {
    let map: RemoteMap = {};
    map = applyRemoteEvent(map, { type: 'remote.status', sessionId: 's1', state: active });
    map = applyRemoteEvent(map, { type: 'remote.status', sessionId: 's2', state: starting });
    map = applyRemoteEvent(map, { type: 'remote.status', sessionId: 's1', state: { phase: 'off' } });
    expect(map).toEqual({ s2: starting });
  });

  it('records a failed host so the UI can surface the reason', () => {
    const map = applyRemoteEvent({}, { type: 'remote.status', sessionId: 's1', state: failed });
    expect(map.s1).toEqual(failed);
  });

  it('ignores an unrecognised event type', () => {
    const before: RemoteMap = { s1: active };
    // A future member of the union must not clobber state.
    const after = applyRemoteEvent(before, { type: 'remote.other', sessionId: 's1' } as never);
    expect(after).toBe(before);
  });
});

describe('applyRemoteStatus', () => {
  it('folds a command result the same way as an event', () => {
    const map = applyRemoteStatus({}, { sessionId: 's1', state: starting });
    expect(map).toEqual({ s1: starting });
    expect(applyRemoteStatus(map, { sessionId: 's1', state: { phase: 'off' } })).toEqual({});
  });
});

describe('applySeedStatus', () => {
  it('fills a hole for a session with no entry yet', () => {
    const map = applySeedStatus({}, { sessionId: 's1', state: active });
    expect(map).toEqual({ s1: active });
  });

  it('a seed does not resurrect off over a live entry', () => {
    // Mount race (H2 #1): remote_get is in flight cold, the user starts a host, the
    // event stream records it — then the stale seed response lands with `off`. The
    // seed must never delete a live entry it did not create.
    const before: RemoteMap = { s1: starting };
    const after = applySeedStatus(before, { sessionId: 's1', state: { phase: 'off' } });
    expect(after).toBe(before);
    expect(after).toEqual({ s1: starting });
  });

  it('still fills a hole with an off seed for an untouched session', () => {
    // off already means "absent" (FR-15), so nothing to fill — but the call must
    // not throw and must return an equivalent empty map.
    expect(applySeedStatus({}, { sessionId: 's1', state: { phase: 'off' } })).toEqual({});
  });
});

describe('applyRemoteResult', () => {
  it('a stale starting never demotes active', () => {
    // The core's starting → active transition is single-shot: a late `remote_start`
    // response carrying an older (or equal) startedAt must not revert the chip to
    // connecting with no further event to correct it (H2 #2).
    const before: RemoteMap = { s1: active };
    const stale: RemoteControlState = { phase: 'starting', name: 'My Project', startedAt: 0 };
    const after = applyRemoteResult(before, { sessionId: 's1', state: stale });
    expect(after).toBe(before);
    expect(after).toEqual({ s1: active });
  });

  it('a stale starting with the same startedAt is also dropped', () => {
    const before: RemoteMap = { s1: active };
    const same: RemoteControlState = { phase: 'starting', name: 'My Project', startedAt: 1 }; // active.startedAt === 1
    expect(applyRemoteResult(before, { sessionId: 's1', state: same })).toBe(before);
  });

  it('a fresher starting still folds normally over a non-active state', () => {
    const map = applyRemoteResult({}, { sessionId: 's1', state: starting });
    expect(map).toEqual({ s1: starting });
  });

  it('folds active/failed/off results through, same as applyRemoteStatus', () => {
    expect(applyRemoteResult({ s1: starting }, { sessionId: 's1', state: active })).toEqual({ s1: active });
    expect(applyRemoteResult({ s1: active }, { sessionId: 's1', state: failed })).toEqual({ s1: failed });
    expect(applyRemoteResult({ s1: active }, { sessionId: 's1', state: { phase: 'off' } })).toEqual({});
  });
});

describe('remoteFailure', () => {
  it('builds a failed state carrying the error', () => {
    const err = { code: 'PTY_ERROR' as const, message: 'could not spawn' };
    expect(remoteFailure('', err)).toEqual({ phase: 'failed', name: '', error: err });
  });
});

describe('selectors', () => {
  it('reports off for a session with no host', () => {
    expect(remoteStateOf({}, 's1')).toEqual({ phase: 'off' });
    expect(remoteStateOf({ s1: active }, 's1')).toEqual(active);
  });

  it('returns the SAME off object across calls, so subscribers do not re-render for nothing', () => {
    expect(remoteStateOf({}, 's1')).toBe(remoteStateOf({ s2: active }, 's1'));
  });

  it('exposes the url only while active', () => {
    expect(remoteUrlOf(active)).toBe(URL);
    expect(remoteUrlOf(starting)).toBeNull();
    expect(remoteUrlOf(failed)).toBeNull();
    expect(remoteUrlOf({ phase: 'off' })).toBeNull();
  });

  it('treats starting as live so the toggle flips immediately', () => {
    expect(isRemoteLive(starting)).toBe(true);
    expect(isRemoteLive(active)).toBe(true);
    expect(isRemoteLive(failed)).toBe(false);
    expect(isRemoteLive({ phase: 'off' })).toBe(false);
  });

  it('extracts the short session handle from the url', () => {
    expect(remoteSessionHandle(active)).toBe('session_01Mo4r8N2qZBTbU4V647cis4');
    expect(remoteSessionHandle(starting)).toBeNull();
    // A URL that does not carry a session id must not yield a bogus handle.
    expect(
      remoteSessionHandle({ phase: 'active', name: 'n', startedAt: 1, url: 'https://claude.ai/code' }),
    ).toBeNull();
  });

  it('extracts the handle even with a trailing slash or query string', () => {
    // Regression: the regex used to be `$`-anchored, so anything after the id
    // (trailing slash, `?x=1`) silently dropped the whole match.
    expect(
      remoteSessionHandle({
        phase: 'active',
        name: 'n',
        startedAt: 1,
        url: 'https://claude.ai/code/session_01AB/?x=1',
      }),
    ).toBe('session_01AB');
  });

  it('labels every phase, surfacing the failure reason', () => {
    expect(remoteLabel({ phase: 'off' })).toBe('remote control off');
    expect(remoteLabel(starting)).toBe('remote control connecting…');
    expect(remoteLabel(active)).toBe('remote control active');
    expect(remoteLabel(failed)).toContain('no session URL before the deadline');
  });

  it('maps each phase to a distinct badge tone', () => {
    expect(remoteDotTone({ phase: 'off' })).toBe('idle');
    expect(remoteDotTone(starting)).toBe('pending');
    expect(remoteDotTone(active)).toBe('ok');
    expect(remoteDotTone(failed)).toBe('error');
  });

  it('lists only the live sessions', () => {
    const map: RemoteMap = { s1: active, s2: starting, s3: failed };
    expect(liveRemoteSessionIds(map).sort()).toEqual(['s1', 's2']);
    expect(liveRemoteSessionIds({})).toEqual([]);
  });
});
