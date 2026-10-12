// code-editor-agents §6 — the TOUCHED-FILES record: which session is editing which
// file, fed by the core's runtime-agnostic `file.touched` (FR-1). In memory for the
// app run only; an app reload starts clean, so no stale lock survives (§7).
//
//   turn      per session: path → kind + block ids, for the turn in flight (FR-3)
//   last      per path: the last toucher + when (FR-9), kept until that session goes
//   blocks    block → the paths it touched (FR-14 tool-row links)
//   firstLine block → the first line its edit flashed (FR-8 → FR-15)
//   unlocked  path → the sessions whose turn "Unlock anyway" waits out (FR-17)
//
// A pure reducer + selectors (tested), and a module-level runtime: ONE registration
// on the session-event router (never a second onSessionEvent — decisions
// 2026-08-17 audio-cues / 2026-08-20 transcript-scale) and a subscriber set.

import { useSyncExternalStore } from 'react';
import type { BlockId, FileTouchKind, SessionEvent, SessionId, SessionStatus } from '../../../contract/common';
import { pathKey } from '../../lib/path';
import { subscribeSessionEvents } from '../../lib/session-events';
import { useStore } from '../../lib/store';

export interface TurnTouch {
  path: string;
  kind: FileTouchKind;
  blockIds: BlockId[];
  at: number;
}

export interface AgentTouchState {
  turn: Record<SessionId, Record<string, TurnTouch>>;
  last: Record<string, { sessionId: SessionId; at: number }>;
  blocks: Record<BlockId, { sessionId: SessionId; paths: string[] }>;
  firstLine: Record<BlockId, number>;
  unlocked: Record<string, SessionId[]>;
}

export const EMPTY_TOUCH: AgentTouchState = { turn: {}, last: {}, blocks: {}, firstLine: {}, unlocked: {} };

export type StatusOf = (sessionId: SessionId) => SessionStatus | undefined;

/** FR-16: a turn is in flight (and may lock) in these statuses. */
const IN_FLIGHT: ReadonlySet<SessionStatus> = new Set<SessionStatus>(['running', 'awaiting_approval', 'awaiting_input']);
/** FR-3: leaving the turn for one of these ends it. */
const SETTLED: ReadonlySet<SessionStatus> = new Set<SessionStatus>(['idle', 'done', 'error']);

export const inFlight = (status: SessionStatus | undefined): boolean => status !== undefined && IN_FLIGHT.has(status);

function without<T>(map: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _gone, ...rest } = map;
  void _gone;
  return rest;
}

/** The turn ended (settled / cleared): drop its touches and its part in any unlock. */
function endTurn(s: AgentTouchState, sessionId: SessionId): AgentTouchState {
  const hasTurn = sessionId in s.turn;
  const touchesUnlock = Object.values(s.unlocked).some((ids) => ids.includes(sessionId));
  if (!hasTurn && !touchesUnlock) return s;
  const unlocked: Record<string, SessionId[]> = {};
  for (const [key, ids] of Object.entries(s.unlocked)) {
    const rest = ids.filter((id) => id !== sessionId);
    if (rest.length > 0) unlocked[key] = rest;
  }
  return { ...s, turn: without(s.turn, sessionId), unlocked };
}

function removeSession(s: AgentTouchState, sessionId: SessionId): AgentTouchState {
  const ended = endTurn(s, sessionId);
  const last = Object.fromEntries(Object.entries(ended.last).filter(([, v]) => v.sessionId !== sessionId));
  const gone = Object.keys(ended.blocks).filter((b) => ended.blocks[b].sessionId === sessionId);
  if (gone.length === 0 && Object.keys(last).length === Object.keys(ended.last).length) return ended;
  const blocks = { ...ended.blocks };
  const firstLine = { ...ended.firstLine };
  for (const b of gone) {
    delete blocks[b];
    delete firstLine[b];
  }
  return { ...ended, last, blocks, firstLine };
}

function touch(s: AgentTouchState, e: Extract<SessionEvent, { type: 'file.touched' }>): AgentTouchState {
  const key = pathKey(e.path);
  const mine = s.turn[e.sessionId] ?? {};
  const prev = mine[key];
  const blockIds = prev?.blockIds.includes(e.blockId) ? prev.blockIds : [...(prev?.blockIds ?? []), e.blockId];
  const block = s.blocks[e.blockId];
  const paths = block?.paths.some((p) => pathKey(p) === key) ? block.paths : [...(block?.paths ?? []), e.path];
  return {
    ...s,
    turn: { ...s.turn, [e.sessionId]: { ...mine, [key]: { path: e.path, kind: e.kind, blockIds, at: e.at } } },
    last: { ...s.last, [key]: { sessionId: e.sessionId, at: e.at } },
    blocks: { ...s.blocks, [e.blockId]: { sessionId: e.sessionId, paths } },
  };
}

/** FR-3: fold one session event in. Returns `s` itself when nothing changed. */
export function reduceTouch(s: AgentTouchState, e: SessionEvent): AgentTouchState {
  switch (e.type) {
    case 'file.touched':
      return touch(s, e);
    case 'session.status':
      return SETTLED.has(e.status) ? endTurn(s, e.sessionId) : s;
    case 'session.meta':
      return SETTLED.has(e.meta.status) ? endTurn(s, e.meta.id) : s;
    case 'session.error':
    case 'session.cleared':
      return endTurn(s, e.sessionId);
    case 'session.removed':
      return removeSession(s, e.sessionId);
    default:
      return s;
  }
}

/** FR-17: lift the lock on `path` until the turn of every session in `holders` ends. */
export function unlockPath(s: AgentTouchState, path: string, holders: readonly SessionId[]): AgentTouchState {
  const key = pathKey(path);
  const ids = [...new Set([...(s.unlocked[key] ?? []), ...holders])];
  return { ...s, unlocked: { ...s.unlocked, [key]: ids } };
}

/** FR-8: the first flashed line, recorded once per block. */
export function recordFlashLine(s: AgentTouchState, blockIds: readonly BlockId[], line: number): AgentTouchState {
  const fresh = blockIds.filter((b) => !(b in s.firstLine));
  if (fresh.length === 0) return s;
  return { ...s, firstLine: { ...s.firstLine, ...Object.fromEntries(fresh.map((b) => [b, line])) } };
}

// ---------- selectors ----------

/** FR-16: the sessions locking `path`, latest toucher first. */
export function selectLockHolders(s: AgentTouchState, path: string, statusOf: StatusOf): SessionId[] {
  const key = pathKey(path);
  const waived = s.unlocked[key] ?? [];
  const out: Array<{ id: SessionId; at: number }> = [];
  for (const [id, paths] of Object.entries(s.turn)) {
    const t = paths[key];
    if (t && inFlight(statusOf(id)) && !waived.includes(id)) out.push({ id, at: t.at });
  }
  return out.sort((a, b) => b.at - a.at).map((h) => h.id);
}

export interface TouchChip {
  sessionId: SessionId;
  at: number;
  /** FR-9: cyan — that session's turn is in flight and touched this path. */
  live: boolean;
}

/** FR-9: the last toucher's chip for `path` (the caller also requires a git change). */
export function selectChip(s: AgentTouchState, path: string, statusOf: StatusOf): TouchChip | null {
  const key = pathKey(path);
  const last = s.last[key];
  if (!last) return null;
  return { sessionId: last.sessionId, at: last.at, live: inFlight(statusOf(last.sessionId)) && !!s.turn[last.sessionId]?.[key] };
}

/** FR-8: every block that touched `path` this turn, any session. */
export function selectTouchedBlocks(s: AgentTouchState, path: string): BlockId[] {
  const key = pathKey(path);
  return Object.values(s.turn).flatMap((paths) => paths[key]?.blockIds ?? []);
}

/** FR-14/FR-15: where a tool row's link goes — its first touched path, at its first flashed line. */
export function selectBlockTarget(s: AgentTouchState, blockId: BlockId): { sessionId: SessionId; path: string; line: number } | null {
  const b = s.blocks[blockId];
  if (!b || b.paths.length === 0) return null;
  return { sessionId: b.sessionId, path: b.paths[0], line: s.firstLine[blockId] ?? 1 };
}

// ---------- runtime ----------

let state: AgentTouchState = EMPTY_TOUCH;
const listeners = new Set<() => void>();
let started = false;

function commit(next: AgentTouchState): void {
  if (next === state) return;
  state = next;
  for (const l of listeners) l();
}

export const getAgentTouch = (): AgentTouchState => state;

/** Idempotent — CodeBackground starts it, app-wide, whether or not Code is on screen. */
export function initAgentTouch(): void {
  if (started) return;
  started = true;
  void subscribeSessionEvents('*', (e) => commit(reduceTouch(state, e)));
}

export function useAgentTouch(): AgentTouchState {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    () => state,
  );
}

/** The live status of a session, from the app store. */
export const storeStatusOf: StatusOf = (id) => useStore.getState().sessions.find((x) => x.id === id)?.status;

export function unlock(path: string, holders: readonly SessionId[]): void {
  commit(unlockPath(state, path, holders));
}

export function noteFlashLine(blockIds: readonly BlockId[], line: number): void {
  commit(recordFlashLine(state, blockIds, line));
}

export const lockHolders = (path: string): SessionId[] => selectLockHolders(state, path, storeStatusOf);
export const isLocked = (path: string): boolean => lockHolders(path).length > 0;
export const chipFor = (path: string): TouchChip | null => selectChip(state, path, storeStatusOf);
export const touchedBlocks = (path: string): BlockId[] => selectTouchedBlocks(state, path);

const SEP = '\u0000';

/** FR-14: a tool row's link target, reactive. Snapshots a string so the store stays referentially stable. */
export function useBlockTarget(blockId: BlockId): { sessionId: SessionId; path: string; line: number } | null {
  const snap = useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    () => {
      const t = selectBlockTarget(state, blockId);
      return t ? [t.sessionId, t.path, t.line].join(SEP) : '';
    },
  );
  if (snap === '') return null;
  const [sessionId, path, line] = snap.split(SEP);
  return { sessionId, path, line: Number(line) };
}
