// remote-control: the store slice that holds sessionId → host state.

import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from './store';

const URL = 'https://claude.ai/code/session_01Mo4r8N2qZBTbU4V647cis4';

describe('store.mergeRemote', () => {
  beforeEach(() => {
    useStore.setState({ remote: {} });
  });

  it('starts empty', () => {
    expect(useStore.getState().remote).toEqual({});
  });

  it('records a starting host and then its url', () => {
    const { mergeRemote } = useStore.getState();
    mergeRemote({ sessionId: 's1', state: { phase: 'starting', name: 'n', startedAt: 1 } });
    expect(useStore.getState().remote.s1).toEqual({ phase: 'starting', name: 'n', startedAt: 1 });

    mergeRemote({ sessionId: 's1', state: { phase: 'active', name: 'n', startedAt: 1, url: URL } });
    expect(useStore.getState().remote.s1).toEqual({ phase: 'active', name: 'n', startedAt: 1, url: URL });
  });

  it('drops the entry when a host stops, leaving no residue', () => {
    const { mergeRemote } = useStore.getState();
    mergeRemote({ sessionId: 's1', state: { phase: 'active', name: 'n', startedAt: 1, url: URL } });
    mergeRemote({ sessionId: 's1', state: { phase: 'off' } });
    expect(useStore.getState().remote).toEqual({});
  });

  it('keeps concurrent hosts independent', () => {
    const { mergeRemote } = useStore.getState();
    mergeRemote({ sessionId: 's1', state: { phase: 'active', name: 'a', startedAt: 1, url: URL } });
    mergeRemote({ sessionId: 's2', state: { phase: 'starting', name: 'b', startedAt: 2 } });
    mergeRemote({ sessionId: 's1', state: { phase: 'off' } });

    const { remote } = useStore.getState();
    expect(Object.keys(remote)).toEqual(['s2']);
    expect(remote.s2).toEqual({ phase: 'starting', name: 'b', startedAt: 2 });
  });

  it('keeps a failed host so the chip can show the reason', () => {
    useStore.getState().mergeRemote({
      sessionId: 's1',
      state: { phase: 'failed', name: 'n', error: { code: 'REMOTE_CONTROL_FAILED', message: 'nope' } },
    });
    const state = useStore.getState().remote.s1;
    expect(state.phase).toBe('failed');
    if (state.phase === 'failed') expect(state.error.message).toBe('nope');
  });
});

describe('store.mergeRemoteSeed', () => {
  beforeEach(() => {
    useStore.setState({ remote: {} });
  });

  it('fills a hole', () => {
    useStore.getState().mergeRemoteSeed({ sessionId: 's1', state: { phase: 'active', name: 'n', startedAt: 1, url: URL } });
    expect(useStore.getState().remote.s1).toEqual({ phase: 'active', name: 'n', startedAt: 1, url: URL });
  });

  it('never overwrites a live entry the event stream already populated (H2 #1)', () => {
    // Seed races a start: the event stream (mergeRemote) records `starting` first,
    // then the stale `off` seed response lands. It must not delete the entry.
    useStore.getState().mergeRemote({ sessionId: 's1', state: { phase: 'starting', name: 'n', startedAt: 1 } });
    useStore.getState().mergeRemoteSeed({ sessionId: 's1', state: { phase: 'off' } });
    expect(useStore.getState().remote.s1).toEqual({ phase: 'starting', name: 'n', startedAt: 1 });
  });
});

describe('store.mergeRemoteResult', () => {
  beforeEach(() => {
    useStore.setState({ remote: {} });
  });

  it('folds a fresh result normally', () => {
    useStore.getState().mergeRemoteResult({ sessionId: 's1', state: { phase: 'starting', name: 'n', startedAt: 1 } });
    expect(useStore.getState().remote.s1).toEqual({ phase: 'starting', name: 'n', startedAt: 1 });
  });

  it('drops a stale starting result that would demote an already-active session (H2 #2)', () => {
    useStore.getState().mergeRemote({ sessionId: 's1', state: { phase: 'active', name: 'n', startedAt: 1, url: URL } });
    useStore.getState().mergeRemoteResult({ sessionId: 's1', state: { phase: 'starting', name: 'n', startedAt: 1 } });
    expect(useStore.getState().remote.s1).toEqual({ phase: 'active', name: 'n', startedAt: 1, url: URL });
  });
});
