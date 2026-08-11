// cloud-sessions FR-7/FR-15 — the adoption runner: the ordering engine behind
// the modal's phase list. No DOM renderer is wired in this project's vitest
// setup, so the hook is a thin useEffect wrapper around this and THIS is what
// the tests prove: subscribe before adopting (an adoption that starts before
// the listener is live loses its first phases), fold every event through the
// tested reducer, and never let a late callback touch a cancelled run.

import { describe, expect, it, vi } from 'vitest';
import type { AppError, Result } from '../../../contract/common';
import type { CloudAdoptData, CloudAdoptRequest, CloudEvent } from '../../../contract/cloud-sessions';
import { startAdoption } from './adopt-runner';
import type { AdoptProgress } from './cloud-sessions';

const REF = 'session_01Mo4r8N2qZBTbU4V647cis4';

const request: CloudAdoptRequest = { ref: REF, projectId: 'p1', destination: 'worktree' };

/** A controllable subscribe/adopt pair: each promise settles only when the test
 * says so, so the ORDER the two IPC calls complete in is the thing under test. */
function harness(req: CloudAdoptRequest = request) {
  const seen: AdoptProgress[] = [];
  let emit: (e: CloudEvent) => void = () => {};
  let goLive: () => void = () => {};
  let settleAdopt: (res: Result<CloudAdoptData>) => void = () => {};
  let rejectAdopt: (err: unknown) => void = () => {};
  const unlisten = vi.fn();
  const adopt = vi.fn(
    () =>
      new Promise<Result<CloudAdoptData>>((resolve, reject) => {
        settleAdopt = resolve;
        rejectAdopt = reject;
      }),
  );
  const cancel = startAdoption({
    request: req,
    subscribe: (cb) =>
      new Promise<() => void>((resolve) => {
        emit = cb;
        goLive = () => resolve(unlisten);
      }),
    adopt,
    onProgress: (p) => seen.push(p),
  });
  return {
    seen,
    adopt,
    unlisten,
    cancel,
    emit: (e: CloudEvent) => emit(e),
    goLive: () => goLive(),
    ok: (sessionId: string) => settleAdopt({ ok: true, data: { sessionId } }),
    /** An ok:true whose payload is not the contract's shape (older core, demo backend). */
    okMalformed: () => settleAdopt({ ok: true, data: null } as unknown as Result<CloudAdoptData>),
    fail: (error: AppError) => settleAdopt({ ok: false, error }),
    reject: (err: unknown) => rejectAdopt(err),
    last: () => seen[seen.length - 1],
  };
}

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe('startAdoption', () => {
  it('reports `resolving` immediately — the modal never shows a bare spinner', () => {
    const h = harness();
    expect(h.seen).toEqual([{ ref: REF, step: 'resolving', error: null, sessionId: null }]);
  });

  it('does not adopt until the event subscription is live', async () => {
    // The window this closes: `cloud_adopt` runs for up to 180s and emits every
    // phase (FR-7). Spawning it before the listener exists drops the early ones
    // and nothing ever replays them.
    const h = harness();
    await flush();
    expect(h.adopt).not.toHaveBeenCalled();

    h.goLive();
    await flush();
    expect(h.adopt).toHaveBeenCalledWith(request);
  });

  it('folds every phase transition into the progress record', async () => {
    const h = harness();
    h.goLive();
    await flush();

    h.emit({ type: 'cloud.adopt', ref: REF, state: { phase: 'preparing' } });
    h.emit({ type: 'cloud.adopt', ref: REF, state: { phase: 'teleporting' } });
    h.emit({ type: 'cloud.adopt', ref: REF, state: { phase: 'hydrating' } });
    expect(h.seen.map((p) => p.step)).toEqual(['resolving', 'preparing', 'teleporting', 'hydrating']);
  });

  it('ignores an event for another ref without reporting anything', async () => {
    const h = harness();
    h.goLive();
    await flush();
    h.emit({ type: 'cloud.adopt', ref: 'session_other', state: { phase: 'ready', sessionId: 'x' } });
    expect(h.seen).toHaveLength(1); // still just the initial `resolving`
  });

  it('reaches `ready` from the event stream and hands over the session id', async () => {
    const h = harness();
    h.goLive();
    await flush();
    h.emit({ type: 'cloud.adopt', ref: REF, state: { phase: 'ready', sessionId: 's1' } });
    expect(h.last()).toEqual({ ref: REF, step: 'ready', error: null, sessionId: 's1' });
  });

  it('reaches `ready` from the command result when no event carried it', async () => {
    // The command is the authority on success — an event stream that dropped the
    // final phase must not leave the modal stuck on `hydrating` forever.
    const h = harness();
    h.goLive();
    await flush();
    h.emit({ type: 'cloud.adopt', ref: REF, state: { phase: 'hydrating' } });
    h.ok('s1');
    await flush();
    // The whole list ticks over to done — the command returning the session id
    // means the session exists, whatever the stream did or did not say.
    expect(h.last()).toEqual({ ref: REF, step: 'ready', error: null, sessionId: 's1' });
    expect(h.unlisten).toHaveBeenCalledTimes(1); // the run is over
  });

  it('folds a command-level refusal that never produced an event (FR-12)', async () => {
    const error: AppError = { code: 'INVALID_INPUT', message: 'confirmation required' };
    const h = harness();
    h.goLive();
    await flush();
    h.fail(error);
    await flush();
    expect(h.last()).toEqual({ ref: REF, step: 'resolving', error, sessionId: null });
    expect(h.unlisten).toHaveBeenCalledTimes(1);
  });

  it('keeps the `failed` event’s error when the command resolves ok:false afterwards', async () => {
    // The event carries the mapped, detailed error (repo names, stalled phase);
    // the command's own refusal must not overwrite it with a coarser one.
    const detailed: AppError = {
      code: 'CLOUD_REPO_MISMATCH',
      message: 'mismatch',
      detail: { sessionRepo: 'acme/api', currentRepo: 'acme/api-fork' },
    };
    const h = harness();
    h.goLive();
    await flush();
    h.emit({ type: 'cloud.adopt', ref: REF, state: { phase: 'teleporting' } });
    h.emit({ type: 'cloud.adopt', ref: REF, state: { phase: 'failed', error: detailed } });
    h.fail({ code: 'CLOUD_REPO_MISMATCH', message: 'mismatch' });
    await flush();
    expect(h.last()).toEqual({ ref: REF, step: 'teleporting', error: detailed, sessionId: null });
  });

  it('treats an ok:true with no session id as a failure, never as a silent close', async () => {
    // The modal closes on `sessionId`. A malformed success — an older core, the
    // demo backend's benign `ok(null)` — would otherwise leave the phase list
    // frozen on its last step with no error and nothing to retry.
    const h = harness();
    h.goLive();
    await flush();
    h.okMalformed();
    await flush();
    expect(h.last().sessionId).toBeNull();
    expect(h.last().error?.code).toBe('INTERNAL');
  });

  it('turns a rejected invoke into an honest failure rather than an unhandled rejection', async () => {
    const h = harness();
    h.goLive();
    await flush();
    h.reject(new Error('ipc died'));
    await flush();
    const last = h.last();
    expect(last.error?.code).toBe('INTERNAL');
    expect(last.error?.message.length).toBeGreaterThan(0);
  });

  it('cancel unsubscribes and silences every later callback', async () => {
    const h = harness();
    h.goLive();
    await flush();
    const before = h.seen.length;

    h.cancel();
    expect(h.unlisten).toHaveBeenCalledTimes(1);
    h.emit({ type: 'cloud.adopt', ref: REF, state: { phase: 'teleporting' } });
    h.ok('s1');
    await flush();
    expect(h.seen).toHaveLength(before);
  });

  it('unsubscribes a subscription that goes live after cancel, and never adopts', async () => {
    const h = harness();
    h.cancel();
    h.goLive();
    await flush();
    expect(h.unlisten).toHaveBeenCalledTimes(1);
    expect(h.adopt).not.toHaveBeenCalled();
  });

  it('cancel is idempotent — Esc twice must not unlisten twice', async () => {
    const h = harness();
    h.goLive();
    await flush();
    h.cancel();
    h.cancel();
    expect(h.unlisten).toHaveBeenCalledTimes(1);
  });
});
