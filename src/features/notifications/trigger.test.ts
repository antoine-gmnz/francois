// audio-cues FR-1/FR-2/FR-3 — the shared trigger source. `deriveTrigger`'s
// derivation cases moved verbatim from notifications.test.ts (FR-1); the
// `registerTriggerSink` cases are new (FR-2/FR-3, one subscription many sinks).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionEvent, SessionMeta, SessionStatus } from '../../../contract/common';
import { deriveTrigger, type DeriveState } from './trigger';

const { listenMock } = vi.hoisted(() => ({ listenMock: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }));

const tick = () => new Promise((r) => setTimeout(r, 0));

function freshState(): DeriveState {
  return { lastStatus: new Map(), seenAsks: new Set() };
}

const permissionAsked = (sessionId: string, blockId: string, toolName = 'Bash'): SessionEvent => ({
  type: 'permission.asked',
  sessionId,
  blockId,
  ask: { toolName, summary: '', inputJson: '{}', cwd: '/repo', pattern: '', patternLabel: '' },
});
const questionAsked = (sessionId: string, blockId: string): SessionEvent => ({
  type: 'question.asked',
  sessionId,
  blockId,
  questions: [],
});
const status = (sessionId: string, s: SessionStatus): SessionEvent => ({ type: 'session.status', sessionId, status: s });
const metaOf = (id: string, s: SessionStatus): SessionMeta => ({
  id,
  name: 'x',
  cwd: '/repo',
  model: { id: 'm', label: 'M' },
  status: s,
  contextUsedTokens: 0,
  contextLimitTokens: 0,
  startedAt: 0,
  lastActivityAt: 0,
  permissionMode: 'default',
  permissionModeSince: 0,
  runtime: 'native',
  accountId: 'default',
  agentRuntime: 'claude-code',
  protocol: 'anthropic',
});

describe('deriveTrigger (FR-1, moved verbatim from notifications.test.ts)', () => {
  it('permission.asked yields an attention/approval trigger naming the tool', () => {
    const state = freshState();
    const t = deriveTrigger(permissionAsked('s1', 'b1', 'Bash'), state);
    expect(t).toEqual({ class: 'attention', kind: 'approval', sessionId: 's1', toolName: 'Bash' });
  });

  it('question.asked yields an attention/question trigger', () => {
    const state = freshState();
    const t = deriveTrigger(questionAsked('s1', 'b1'), state);
    expect(t).toEqual({ class: 'attention', kind: 'question', sessionId: 's1' });
  });

  it('the same blockId seen twice (permission) fires exactly once', () => {
    const state = freshState();
    expect(deriveTrigger(permissionAsked('s1', 'b1'), state)).not.toBeNull();
    expect(deriveTrigger(permissionAsked('s1', 'b1'), state)).toBeNull();
  });

  it('the same blockId seen twice (question) fires exactly once', () => {
    const state = freshState();
    expect(deriveTrigger(questionAsked('s1', 'b1'), state)).not.toBeNull();
    expect(deriveTrigger(questionAsked('s1', 'b1'), state)).toBeNull();
  });

  it('a running → idle transition yields a turnDone/settle trigger', () => {
    const state = freshState();
    deriveTrigger(status('s1', 'running'), state);
    const t = deriveTrigger(status('s1', 'idle'), state);
    expect(t).toEqual({ class: 'turnDone', kind: 'settle', sessionId: 's1', status: 'idle' });
  });

  it('a running → error transition yields status error; running → done yields done', () => {
    const errState = freshState();
    deriveTrigger(status('s1', 'running'), errState);
    expect(deriveTrigger(status('s1', 'error'), errState)).toEqual({
      class: 'turnDone',
      kind: 'settle',
      sessionId: 's1',
      status: 'error',
    });

    const doneState = freshState();
    deriveTrigger(status('s1', 'running'), doneState);
    expect(deriveTrigger(status('s1', 'done'), doneState)).toEqual({
      class: 'turnDone',
      kind: 'settle',
      sessionId: 's1',
      status: 'done',
    });
  });

  it('a first-observed status (no prior sighting) never yields a trigger, even idle', () => {
    const state = freshState();
    expect(deriveTrigger(status('s1', 'idle'), state)).toBeNull();
  });

  it('a repeated identical status yields no trigger the second time', () => {
    const state = freshState();
    deriveTrigger(status('s1', 'running'), state);
    expect(deriveTrigger(status('s1', 'idle'), state)).not.toBeNull();
    expect(deriveTrigger(status('s1', 'idle'), state)).toBeNull();
  });

  it('settles out of a PARKED status — an interrupted approval still notifies', () => {
    // ⌃C on an approval card goes awaiting_approval → idle without ever passing
    // through `running`. The user was waiting on that turn just the same.
    for (const parked of ['awaiting_approval', 'awaiting_input'] as const) {
      const state = freshState();
      deriveTrigger(status('s1', 'running'), state);
      deriveTrigger(status('s1', parked), state);
      expect(deriveTrigger(status('s1', 'idle'), state)).toEqual({
        class: 'turnDone',
        kind: 'settle',
        sessionId: 's1',
        status: 'idle',
      });
    }
  });

  it('settles out of `starting` — a spawn failure notifies before any stream line', () => {
    const state = freshState();
    deriveTrigger(status('s1', 'starting'), state);
    expect(deriveTrigger(status('s1', 'error'), state)).toEqual({
      class: 'turnDone',
      kind: 'settle',
      sessionId: 's1',
      status: 'error',
    });
  });

  it('does not settle on a park or an unpark — the turn is still in flight', () => {
    const state = freshState();
    deriveTrigger(status('s1', 'running'), state);
    expect(deriveTrigger(status('s1', 'awaiting_approval'), state)).toBeNull();
    expect(deriveTrigger(status('s1', 'running'), state)).toBeNull();
  });

  it('session.meta feeds the same settle map, keyed by meta.id/meta.status', () => {
    const state = freshState();
    deriveTrigger(status('s1', 'running'), state);
    const t = deriveTrigger({ type: 'session.meta', meta: metaOf('s1', 'idle') }, state);
    expect(t).toEqual({ class: 'turnDone', kind: 'settle', sessionId: 's1', status: 'idle' });
  });

  it('§5: session.error followed by session.meta{status:"error"} for the same failure fires once', () => {
    const state = freshState();
    deriveTrigger(status('s1', 'running'), state);
    const first = deriveTrigger({ type: 'session.error', sessionId: 's1', error: { code: 'INTERNAL', message: 'x' } }, state);
    expect(first).toEqual({ class: 'turnDone', kind: 'settle', sessionId: 's1', status: 'error' });
    const second = deriveTrigger({ type: 'session.meta', meta: metaOf('s1', 'error') }, state);
    expect(second).toBeNull();
  });

  it('every other event member yields null', () => {
    const state = freshState();
    expect(deriveTrigger({ type: 'session.removed', sessionId: 's1' }, state)).toBeNull();
    expect(deriveTrigger({ type: 'permission.resolved', sessionId: 's1', blockId: 'b1', state: 'allowed' }, state)).toBeNull();
    expect(deriveTrigger({ type: 'question.resolved', sessionId: 's1', blockId: 'b1', state: 'answered' }, state)).toBeNull();
  });

  it('a resolved ask never clears seenAsks — a re-emitted asked event for the same blockId still stays silent', () => {
    const state = freshState();
    deriveTrigger(permissionAsked('s1', 'b1'), state);
    deriveTrigger({ type: 'permission.resolved', sessionId: 's1', blockId: 'b1', state: 'allowed' }, state);
    expect(deriveTrigger(permissionAsked('s1', 'b1'), state)).toBeNull();
  });

  it('a muted class still updates lastStatus/seenAsks (gating is a sink’s job, not deriveTrigger’s)', () => {
    const state = freshState();
    deriveTrigger(status('s1', 'running'), state);
    deriveTrigger(status('s1', 'idle'), state);
    expect(state.lastStatus.get('s1')).toBe('idle');
  });
});

describe('registerTriggerSink (FR-2/FR-3)', () => {
  let sessionHandler: ((e: { payload: SessionEvent }) => void) | undefined;

  beforeEach(() => {
    vi.resetModules();
    sessionHandler = undefined;
    listenMock.mockReset().mockImplementation((channel: string, cb: (e: { payload: unknown }) => void) => {
      if (channel === 'francois://session/event') sessionHandler = cb as (e: { payload: SessionEvent }) => void;
      return Promise.resolve(vi.fn());
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('subscribes to onSessionEvent exactly once, on the first registration, regardless of how many sinks register', async () => {
    const { registerTriggerSink } = await import('./trigger');
    registerTriggerSink(vi.fn());
    registerTriggerSink(vi.fn());
    registerTriggerSink(vi.fn());
    await tick();
    expect(listenMock.mock.calls.filter((c) => c[0] === 'francois://session/event')).toHaveLength(1);
  });

  it('every registered sink receives one trigger per event, in registration order', async () => {
    const { registerTriggerSink } = await import('./trigger');
    const calls: string[] = [];
    registerTriggerSink(() => calls.push('a'));
    registerTriggerSink(() => calls.push('b'));
    await tick();
    sessionHandler?.({ payload: { type: 'question.asked', sessionId: 's1', blockId: 'b1', questions: [] } });
    expect(calls).toEqual(['a', 'b']);
  });

  it('a sink that throws is caught and never blocks the others', async () => {
    const { registerTriggerSink } = await import('./trigger');
    const calls: string[] = [];
    registerTriggerSink(() => {
      throw new Error('boom');
    });
    registerTriggerSink(() => calls.push('b'));
    await tick();
    expect(() =>
      sessionHandler?.({ payload: { type: 'question.asked', sessionId: 's1', blockId: 'b1', questions: [] } }),
    ).not.toThrow();
    expect(calls).toEqual(['b']);
  });

  it('a non-trigger event reaches no sink', async () => {
    const { registerTriggerSink } = await import('./trigger');
    const sink = vi.fn();
    registerTriggerSink(sink);
    await tick();
    sessionHandler?.({ payload: { type: 'session.removed', sessionId: 's1' } });
    expect(sink).not.toHaveBeenCalled();
  });
});
