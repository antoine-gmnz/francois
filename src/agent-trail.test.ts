import { describe, it, expect } from 'vitest';
import type { AgentInfo, AgentStep } from '../contract/common';
import {
  ASYNC_MARKER,
  COLLAPSED_TRAIL,
  STEP_GLYPH,
  STEP_GLYPH_COLOR,
  TRAIL_BOTTOM_THRESHOLD_PX,
  TRAIL_EMPTY_LABEL,
  activitySuffix,
  collapseTrail,
  dropsCardOnTrailError,
  earlierStepsNotice,
  expandTrail,
  isAtBottom,
  mergeStep,
  receiveTrailActivity,
  receiveTrailStep,
  showAsyncMarker,
  stepMetaColor,
  stepToolPrefix,
  toggleTrail,
} from './agent-trail';

const step = (seq: number, over: Partial<AgentStep> = {}): AgentStep => ({
  seq,
  kind: 'text',
  at: 1_700_000_000_000 + seq,
  label: `step ${seq}`,
  ...over,
});

const agent = (over: Partial<AgentInfo> = {}): AgentInfo => ({
  id: 'a1',
  sessionId: 's1',
  name: 'test-writer',
  task: 'write the tests',
  status: 'running',
  startedAt: 1_700_000_000_000,
  background: false,
  stepCount: 0,
  ...over,
});

// ---------- mergeStep (FR-20) ----------

describe('mergeStep', () => {
  it('appends an unknown seq', () => {
    const out = mergeStep([step(1), step(2)], step(3));
    expect(out.map((s) => s.seq)).toEqual([1, 2, 3]);
  });
  it('replaces a known seq in place without appending', () => {
    const out = mergeStep([step(1), step(2, { kind: 'tool', tool: 'Read' }), step(3)], step(2, { kind: 'tool', tool: 'Read', meta: '128 lines' }));
    expect(out.map((s) => s.seq)).toEqual([1, 2, 3]);
    expect(out[1].meta).toBe('128 lines');
  });
  it('inserts an out-of-order seq at its sorted position', () => {
    const out = mergeStep([step(1), step(4)], step(2));
    expect(out.map((s) => s.seq)).toEqual([1, 2, 4]);
  });
  it('does not mutate the input list', () => {
    const base = [step(1)];
    mergeStep(base, step(2));
    expect(base.map((s) => s.seq)).toEqual([1]);
  });
});

// ---------- expand / collapse (FR-19, FR-21, FR-22) ----------

describe('expandTrail / collapseTrail / toggleTrail', () => {
  it('expands onto an agent with an empty, loading, bottom-latched trail', () => {
    const t = expandTrail(COLLAPSED_TRAIL, 'a1');
    expect(t.agentId).toBe('a1');
    expect(t.loading).toBe(true);
    expect(t.hydrated).toBe(false);
    expect(t.steps).toEqual([]);
    expect(t.error).toBeNull();
    expect(t.atBottom).toBe(true);
    expect(t.reqId).toBeGreaterThan(COLLAPSED_TRAIL.reqId);
  });

  it('collapsing discards the local trail copy (FR-22)', () => {
    let t = expandTrail(COLLAPSED_TRAIL, 'a1');
    t = receiveTrailActivity(t, t.reqId, { ok: true, data: [step(1), step(2)] });
    t = collapseTrail(t);
    expect(t.agentId).toBeNull();
    expect(t.steps).toEqual([]);
    expect(t.buffer).toEqual([]);
    expect(t.loading).toBe(false);
    expect(t.error).toBeNull();
  });

  it('toggles the same agent closed and a different agent open (at most one expanded)', () => {
    const open = toggleTrail(COLLAPSED_TRAIL, 'a1');
    expect(open.agentId).toBe('a1');
    expect(toggleTrail(open, 'a1').agentId).toBeNull();
    const other = toggleTrail(open, 'a2');
    expect(other.agentId).toBe('a2');
    expect(other.loading).toBe(true);
  });

  it('re-expanding the same agent re-issues the fetch with a fresh reqId (FR-21/FR-22)', () => {
    const first = expandTrail(COLLAPSED_TRAIL, 'a1');
    const second = expandTrail(collapseTrail(first), 'a1');
    expect(second.reqId).not.toBe(first.reqId);
    expect(second.loading).toBe(true);
    expect(second.steps).toEqual([]);
  });
});

// ---------- live steps (FR-20, FR-22) ----------

describe('receiveTrailStep', () => {
  it('ignores steps for a collapsed trail or another agent (FR-22)', () => {
    expect(receiveTrailStep(COLLAPSED_TRAIL, 'a1', step(1))).toBe(COLLAPSED_TRAIL);
    const t = expandTrail(COLLAPSED_TRAIL, 'a1');
    expect(receiveTrailStep(t, 'a2', step(1))).toBe(t);
  });

  it('buffers steps that arrive before the activity response (FR-20)', () => {
    let t = expandTrail(COLLAPSED_TRAIL, 'a1');
    t = receiveTrailStep(t, 'a1', step(7));
    expect(t.steps).toEqual([]);
    expect(t.buffer.map((s) => s.seq)).toEqual([7]);
  });

  it('appends an unknown seq and replaces a known seq once hydrated (FR-20)', () => {
    let t = expandTrail(COLLAPSED_TRAIL, 'a1');
    t = receiveTrailActivity(t, t.reqId, { ok: true, data: [step(1), step(2, { kind: 'tool', tool: 'Read', label: 'src/session.rs' })] });
    t = receiveTrailStep(t, 'a1', step(3));
    expect(t.steps.map((s) => s.seq)).toEqual([1, 2, 3]);
    t = receiveTrailStep(t, 'a1', step(2, { kind: 'tool', tool: 'Read', label: 'src/session.rs', meta: '128 lines' }));
    expect(t.steps.map((s) => s.seq)).toEqual([1, 2, 3]);
    expect(t.steps[1].meta).toBe('128 lines');
  });
});

// ---------- hydration race (FR-20) ----------

describe('receiveTrailActivity', () => {
  it('orders the response by seq and clears loading', () => {
    let t = expandTrail(COLLAPSED_TRAIL, 'a1');
    t = receiveTrailActivity(t, t.reqId, { ok: true, data: [step(2), step(1)] });
    expect(t.steps.map((s) => s.seq)).toEqual([1, 2]);
    expect(t.loading).toBe(false);
    expect(t.hydrated).toBe(true);
  });

  it('applies buffered steps after the response and never lets the response overwrite them (FR-20)', () => {
    let t = expandTrail(COLLAPSED_TRAIL, 'a1');
    // seq 2 arrives live with its meta already filled…
    t = receiveTrailStep(t, 'a1', step(2, { kind: 'tool', tool: 'Read', label: 'src/session.rs', meta: '128 lines' }));
    t = receiveTrailStep(t, 'a1', step(3));
    // …while the (slightly stale) response still has seq 2 open.
    t = receiveTrailActivity(t, t.reqId, {
      ok: true,
      data: [step(1), step(2, { kind: 'tool', tool: 'Read', label: 'src/session.rs' })],
    });
    expect(t.steps.map((s) => s.seq)).toEqual([1, 2, 3]);
    expect(t.steps[1].meta).toBe('128 lines'); // buffered event wins
    expect(t.buffer).toEqual([]);
  });

  it('ignores a stale response (the card was collapsed or re-expanded meanwhile)', () => {
    const first = expandTrail(COLLAPSED_TRAIL, 'a1');
    const second = expandTrail(collapseTrail(first), 'a1');
    const after = receiveTrailActivity(second, first.reqId, { ok: true, data: [step(1)] });
    expect(after).toBe(second);
    expect(receiveTrailActivity(COLLAPSED_TRAIL, COLLAPSED_TRAIL.reqId, { ok: true, data: [step(1)] })).toBe(COLLAPSED_TRAIL);
  });

  it('stores the AppError of a failed response and stops loading (§7)', () => {
    let t = expandTrail(COLLAPSED_TRAIL, 'a1');
    t = receiveTrailActivity(t, t.reqId, { ok: false, error: { code: 'AGENT_NOT_FOUND', message: 'no such agent' } });
    expect(t.loading).toBe(false);
    expect(t.error?.message).toBe('no such agent');
    expect(t.steps).toEqual([]);
  });

  it('flags AGENT_NOT_FOUND as the only error that drops the card (§7)', () => {
    expect(dropsCardOnTrailError({ code: 'AGENT_NOT_FOUND', message: 'x' })).toBe(true);
    expect(dropsCardOnTrailError({ code: 'INTERNAL', message: 'x' })).toBe(false);
  });
});

// ---------- auto-scroll latch (FR-21) ----------

describe('isAtBottom', () => {
  it('counts within 8px of the bottom as at the bottom', () => {
    expect(TRAIL_BOTTOM_THRESHOLD_PX).toBe(8);
    expect(isAtBottom({ scrollTop: 320, clientHeight: 180, scrollHeight: 500 })).toBe(true); // exactly at bottom
    expect(isAtBottom({ scrollTop: 312, clientHeight: 180, scrollHeight: 500 })).toBe(true); // 8px up
    expect(isAtBottom({ scrollTop: 311, clientHeight: 180, scrollHeight: 500 })).toBe(false); // 9px up
  });
  it('is true for a trail shorter than its box', () => {
    expect(isAtBottom({ scrollTop: 0, clientHeight: 180, scrollHeight: 60 })).toBe(true);
  });
});

// ---------- windowed trail (FR-12, §7) ----------

describe('earlierStepsNotice', () => {
  it('reports the dropped steps when the trail is a window', () => {
    expect(earlierStepsNotice(250, 200)).toBe('… 50 earlier steps');
    expect(earlierStepsNotice(201, 200)).toBe('… 1 earlier steps');
  });
  it('is null when the trail holds every step', () => {
    expect(earlierStepsNotice(12, 12)).toBeNull();
    expect(earlierStepsNotice(0, 0)).toBeNull();
    expect(earlierStepsNotice(3, 5)).toBeNull(); // stepCount lagging the trail is never negative
  });
});

// ---------- card presentation (FR-17, §8) ----------

describe('card presentation', () => {
  it('shows the async marker only for background agents (FR-17)', () => {
    expect(showAsyncMarker(agent({ background: true }))).toBe(true);
    expect(showAsyncMarker(agent({ background: false }))).toBe(false);
    expect(ASYNC_MARKER).toBe('async');
  });

  it('renders lastActivity for every status, and nothing when absent or blank (FR-17)', () => {
    expect(activitySuffix(agent({ lastActivity: 'Read src/session.rs' }))).toBe('Read src/session.rs');
    expect(activitySuffix(agent({ status: 'done', lastActivity: 'ended with the turn' }))).toBe('ended with the turn');
    expect(activitySuffix(agent())).toBeNull();
    expect(activitySuffix(agent({ lastActivity: '   ' }))).toBeNull();
  });

  it('maps each step kind to its glyph + token colour (§8)', () => {
    expect(STEP_GLYPH).toEqual({ text: '●', tool: '⧉', notice: '·' });
    expect(STEP_GLYPH_COLOR).toEqual({
      text: 'var(--text-dim)',
      tool: 'var(--accent-2)',
      notice: 'var(--text-faint)',
    });
  });

  it('prefixes the tool name only for tool steps (§8)', () => {
    expect(stepToolPrefix(step(1, { kind: 'tool', tool: 'Read', label: 'src/session.rs' }))).toBe('Read');
    expect(stepToolPrefix(step(1, { kind: 'tool', label: 'src/session.rs' }))).toBeNull();
    expect(stepToolPrefix(step(1, { kind: 'text', label: 'hello' }))).toBeNull();
    expect(stepToolPrefix(step(1, { kind: 'notice', label: 'dispatched in background' }))).toBeNull();
  });

  it('renders the literal "error" meta in the error colour (§8)', () => {
    expect(stepMetaColor('error')).toBe('var(--error)');
    expect(stepMetaColor('128 lines')).toBe('var(--text-faint)');
  });

  it('has the empty-trail copy from §8', () => {
    expect(TRAIL_EMPTY_LABEL).toBe('no activity yet');
  });
});
