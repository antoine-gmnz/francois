import type { Result, SessionEvent, SessionMeta } from '../../contract/common';
import { requestNeedsLiveGeneration, sessionCapability } from './runtimeCapability';

type ReplyState = 'pending' | 'submitting' | 'closed';
interface SessionRequests { generation?: string; requests: Map<string, ReplyState> }
// Only live event delivery grants native reply authority. Hydration never populates this map.
const sessions = new Map<string, SessionRequests>();

function forSession(meta: SessionMeta): SessionRequests {
  const current = sessions.get(meta.id);
  if (current && current.generation === meta.runtimeGeneration) return current;
  const next = { generation: meta.runtimeGeneration, requests: new Map<string, ReplyState>() };
  sessions.set(meta.id, next);
  return next;
}

export function invalidateRequestReplies(sessionId: string): void {
  const state = sessions.get(sessionId);
  if (state) for (const id of state.requests.keys()) state.requests.set(id, 'closed');
}

export function observeRequestEvent(event: SessionEvent, meta: SessionMeta | null | undefined): void {
  if (event.type === 'session.removed') { sessions.delete(event.sessionId); return; }
  if (event.type === 'session.meta') meta = event.meta;
  if (!meta) return;
  const state = forSession(meta);
  const status = event.type === 'session.status' ? event.status : event.type === 'session.meta' ? meta.status : undefined;
  const stopped = event.type === 'runtime.event' && event.event.kind === 'run.state' && ['idle', 'stopping', 'failed'].includes(event.event.state);
  if (stopped || status === 'idle' || status === 'done' || status === 'error' || event.type === 'session.cleared') {
    invalidateRequestReplies(meta.id);
  }
  if (event.type === 'permission.asked' || event.type === 'question.asked') {
    if (!state.requests.has(event.blockId)) state.requests.set(event.blockId, 'pending');
  }
  if (event.type === 'permission.resolved' || event.type === 'question.resolved') state.requests.set(event.blockId, 'closed');
}

export function requestReplyAvailable(meta: SessionMeta | null | undefined, blockId: string): boolean {
  if (!meta || meta.status === 'done' || meta.status === 'error' || !sessionCapability(meta, 'permissions').available) return false;
  const state = sessions.get(meta.id);
  const entry = state && state.generation === meta.runtimeGeneration ? state.requests.get(blockId) : undefined;
  if (requestNeedsLiveGeneration(meta)) return meta.status !== 'idle' && !!meta.runtimeGeneration && entry === 'pending';
  return entry === undefined || entry === 'pending';
}

export function requestReplyPending(meta: SessionMeta | null | undefined, blockId: string): boolean {
  if (requestReplyAvailable(meta, blockId)) return true;
  if (!meta || meta.status === 'idle' || meta.status === 'done' || meta.status === 'error' || !sessionCapability(meta, 'permissions').available) return false;
  const current = sessions.get(meta.id);
  return current?.generation === meta.runtimeGeneration && current?.requests.get(blockId) === 'submitting';
}

/** Claim synchronously across transcript/roster panes; successful writes await the resolved event. */
export async function submitRequestReply(meta: SessionMeta | null | undefined, blockId: string, send: () => Promise<Result<null>>): Promise<Result<null>> {
  if (!meta || !requestReplyAvailable(meta, blockId)) return { ok: false, error: { code: 'RUNTIME_UNSUPPORTED', message: 'This request is no longer available.' } };
  const state = forSession(meta);
  state.requests.set(blockId, 'submitting');
  try {
    const result = await send();
    if (!result.ok && state.requests.get(blockId) === 'submitting') state.requests.set(blockId, 'pending');
    return result;
  } catch (error) {
    if (state.requests.get(blockId) === 'submitting') state.requests.set(blockId, 'pending');
    throw error;
  }
}
