// code-editor-agents FR-3 / FR-9 / FR-14..17 — the touched-files record, as a pure
// reducer over the session event stream plus its selectors.

import { describe, expect, it, vi } from 'vitest';

const router = vi.hoisted(() => ({ subscribeSessionEvents: vi.fn((_scope: string, _h: unknown) => Promise.resolve(() => {})) }));
vi.mock('../../lib/session-events', () => router);
import type { SessionEvent, SessionStatus } from '../../../contract/common';
import {
  EMPTY_TOUCH,
  getAgentTouch,
  initAgentTouch,
  recordFlashLine,
  reduceTouch,
  selectBlockTarget,
  selectChip,
  selectLockHolders,
  selectTouchedBlocks,
  unlockPath,
  type AgentTouchState,
} from './agent-touch';

const touched = (sessionId: string, blockId: string, path: string, at = 1): SessionEvent => ({
  type: 'file.touched',
  sessionId,
  blockId,
  path,
  kind: 'edit',
  at,
});
const status = (sessionId: string, s: SessionStatus): SessionEvent => ({ type: 'session.status', sessionId, status: s });
const run = (events: SessionEvent[], from: AgentTouchState = EMPTY_TOUCH) => events.reduce(reduceTouch, from);

const statuses = (m: Record<string, SessionStatus>) => (id: string) => m[id];
const A = '/r/src/auth.ts';

describe('reduceTouch (FR-3)', () => {
  it('records the path per session for the turn, dedupes block ids, and keeps the last toucher', () => {
    const s = run([touched('s1', 'b1', A, 1), touched('s1', 'b1', A, 2), touched('s1', 'b2', A, 3)]);
    expect(s.turn.s1[A]).toMatchObject({ path: A, kind: 'edit', blockIds: ['b1', 'b2'] });
    expect(s.last[A]).toEqual({ sessionId: 's1', at: 3 });
    expect(s.blocks.b1).toEqual({ sessionId: 's1', paths: [A] });
  });

  it('keys drive-letter paths case-insensitively', () => {
    const s = run([touched('s1', 'b1', 'C:/Repo/a.ts')]);
    expect(selectTouchedBlocks(s, 'c:/repo/A.TS')).toEqual(['b1']);
  });

  it.each<SessionStatus>(['idle', 'done', 'error'])('clears touched-this-turn when the session settles to %s', (to) => {
    const s = run([touched('s1', 'b1', A), status('s1', 'running'), status('s1', to)]);
    expect(s.turn.s1).toBeUndefined();
    expect(s.last[A]?.sessionId).toBe('s1'); // the last toucher outlives the turn
  });

  it('keeps the turn across running → awaiting_approval → running', () => {
    const s = run([touched('s1', 'b1', A), status('s1', 'awaiting_approval'), status('s1', 'running')]);
    expect(s.turn.s1[A]).toBeDefined();
  });

  it('clears the turn on session.meta settling too, and on session.cleared', () => {
    const meta = { type: 'session.meta', meta: { id: 's1', status: 'idle' } } as unknown as SessionEvent;
    expect(run([touched('s1', 'b1', A), meta]).turn.s1).toBeUndefined();
    expect(run([touched('s1', 'b1', A), { type: 'session.cleared', sessionId: 's1' }]).turn.s1).toBeUndefined();
  });

  it('drops everything about a removed session', () => {
    const s = run([touched('s1', 'b1', A), touched('s2', 'b2', '/r/b.ts'), { type: 'session.removed', sessionId: 's1' }]);
    expect(s.turn.s1).toBeUndefined();
    expect(s.last[A]).toBeUndefined();
    expect(s.blocks.b1).toBeUndefined();
    expect(s.last['/r/b.ts']?.sessionId).toBe('s2');
  });

  it('returns the same state for an unrelated event', () => {
    const s = run([touched('s1', 'b1', A)]);
    expect(reduceTouch(s, { type: 'assistant.done', sessionId: 's1', blockId: 'x' } as unknown as SessionEvent)).toBe(s);
  });
});

describe('locks (FR-16/FR-17)', () => {
  const live = statuses({ s1: 'running', s2: 'awaiting_input', s3: 'idle' });

  it('locks while a session with an in-flight status has the path this turn, latest toucher first', () => {
    const s = run([touched('s1', 'b1', A, 1), touched('s2', 'b2', A, 5)]);
    expect(selectLockHolders(s, A, live)).toEqual(['s2', 's1']);
    expect(selectLockHolders(s, '/r/other.ts', live)).toEqual([]);
  });

  it('does not lock for a session that is not in flight', () => {
    const s = run([touched('s3', 'b1', A)]);
    expect(selectLockHolders(s, A, live)).toEqual([]);
  });

  it('Unlock anyway holds for the turn of every current holder, despite further touches', () => {
    let s = run([touched('s1', 'b1', A)]);
    s = unlockPath(s, A, ['s1']);
    s = run([touched('s1', 'b3', A, 9)], s);
    expect(selectLockHolders(s, A, live)).toEqual([]);
    // a session not party to the unlock still locks it
    s = run([touched('s2', 'b4', A, 10)], s);
    expect(selectLockHolders(s, A, live)).toEqual(['s2']);
  });

  it('forgets the unlock once the holders turn ends, so the next turn locks again', () => {
    let s = unlockPath(run([touched('s1', 'b1', A)]), A, ['s1']);
    s = run([status('s1', 'idle'), status('s1', 'running'), touched('s1', 'b5', A)], s);
    expect(selectLockHolders(s, A, live)).toEqual(['s1']);
    expect(s.unlocked[A]).toBeUndefined();
  });
});

describe('selectChip (FR-9)', () => {
  it('is live while the last toucher is in flight with the path this turn, neutral after', () => {
    let s = run([touched('s1', 'b1', A, 7)]);
    expect(selectChip(s, A, statuses({ s1: 'running' }))).toEqual({ sessionId: 's1', at: 7, live: true });
    s = run([status('s1', 'idle')], s);
    expect(selectChip(s, A, statuses({ s1: 'idle' }))).toEqual({ sessionId: 's1', at: 7, live: false });
    expect(selectChip(s, '/r/none.ts', statuses({}))).toBeNull();
  });
});

describe('flash line + block target (FR-8/FR-14/FR-15)', () => {
  it('records the first flashed line per block, once, and resolves a block to its path and line', () => {
    let s = run([touched('s1', 'b1', A)]);
    expect(selectBlockTarget(s, 'b1')).toEqual({ sessionId: 's1', path: A, line: 1 });
    s = recordFlashLine(s, ['b1'], 40);
    s = recordFlashLine(s, ['b1'], 3);
    expect(selectBlockTarget(s, 'b1')).toEqual({ sessionId: 's1', path: A, line: 40 });
    expect(selectBlockTarget(s, 'nope')).toBeNull();
  });
});

describe('runtime wiring (FR-3)', () => {
  it('registers ONE handler on the session-event router, however often it is started', () => {
    initAgentTouch();
    initAgentTouch();
    expect(router.subscribeSessionEvents).toHaveBeenCalledTimes(1);
    expect(router.subscribeSessionEvents.mock.calls[0][0]).toBe('*');
    const handler = (router.subscribeSessionEvents.mock.calls[0] as unknown as [string, (e: SessionEvent) => void])[1];
    handler(touched('s9', 'b9', A));
    expect(getAgentTouch().last[A]?.sessionId).toBe('s9');
  });
});
