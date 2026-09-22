import { describe, expect, it, vi } from 'vitest';
import type { SessionMeta } from '../../contract/common';
import { runtimeCapabilities } from '../../contract/multi-provider-seam';
import { observeRequestEvent, requestReplyAvailable, submitRequestReply } from './request-replies';

const native = (id: string): SessionMeta => ({ id, agentRuntime: 'codex', status: 'running', runtimeGeneration: 'one', effectiveCapabilities: { ...runtimeCapabilities('codex'), permissions: { available: true } } } as SessionMeta);

describe('live request reply authority', () => {
  it('does not activate a historical card from capability/status alone', () => {
    expect(requestReplyAvailable(native('history'), 'old')).toBe(false);
  });
  it('shares one claim across panes and prevents resolved replay from reopening it', async () => {
    const meta = native('panes');
    const event = { type: 'question.asked', sessionId: meta.id, blockId: 'q', questions: [] } as const;
    observeRequestEvent({ ...event, questions: [] }, meta);
    expect(requestReplyAvailable(meta, 'q')).toBe(true);
    let finish!: (result: { ok: true; data: null }) => void;
    const write = vi.fn(() => new Promise<{ ok: true; data: null }>(resolve => { finish = resolve; }));
    const first = submitRequestReply(meta, 'q', write);
    await submitRequestReply(meta, 'q', write);
    expect(write).toHaveBeenCalledTimes(1);
    observeRequestEvent({ type: 'question.resolved', sessionId: meta.id, blockId: 'q', state: 'cancelled' }, meta);
    finish({ ok: true, data: null });
    await first;
    observeRequestEvent({ ...event, questions: [] }, meta);
    expect(requestReplyAvailable(meta, 'q')).toBe(false);
  });
  it('invalidates replies across Stop, generation replacement and retired runtime', async () => {
    const meta = native('stopped');
    observeRequestEvent({ type: 'question.asked', sessionId: meta.id, blockId: 'q', questions: [] }, meta);
    observeRequestEvent({ type: 'session.status', sessionId: meta.id, status: 'idle' }, meta);
    const write = vi.fn();
    await submitRequestReply(meta, 'q', write);
    expect(write).not.toHaveBeenCalled();
    expect(requestReplyAvailable({ ...meta, runtimeGeneration: 'two' }, 'q')).toBe(false);
    expect(requestReplyAvailable({ ...meta, agentRuntime: 'pi' }, 'q')).toBe(false);
  });
  it('keeps a failed response closed when a runtime stop notification won the race', async () => {
    const meta = native('runtime-stop');
    observeRequestEvent({ type: 'question.asked', sessionId: meta.id, blockId: 'q', questions: [] }, meta);
    let finish!: (result: { ok: false; error: { code: 'INTERNAL'; message: string } }) => void;
    const pending = submitRequestReply(meta, 'q', () => new Promise(resolve => { finish = resolve; }));
    observeRequestEvent({ type: 'runtime.event', sessionId: meta.id, generation: 'one', sequence: 1, at: 0, event: { kind: 'run.state', state: 'stopping' } }, meta);
    finish({ ok: false, error: { code: 'INTERNAL', message: 'stopped' } });
    await pending;
    expect(requestReplyAvailable(meta, 'q')).toBe(false);
  });
  it('retains legacy live-card behavior without optional native evidence', () => {
    expect(requestReplyAvailable({ ...native('legacy'), agentRuntime: 'claude-code', runtimeGeneration: undefined }, 'q')).toBe(true);
  });
});
