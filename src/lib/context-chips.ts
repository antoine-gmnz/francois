// code-editor-agents §6 / FR-6 / FR-7 — the per-session CONTEXT CHIPS: what the
// Code tab hands a session (a selection, a line comment, a revert note), shown as
// a strip above that session's composer and sent only with the user's next
// message (decision 2026-10-08: never into the busy-turn queue, never auto-sent).
//
// Same shape as ./pending-queue: a module map + a subscriber set, because the
// composer is keyed by sessionId and remounts, and the strip renders this state.
// Same lifetime as ./composer-draft — dropped with the session (dropDerived),
// gone on reload. Code writes it, Conversation reads it; that is why it is in lib/.

import { useSyncExternalStore } from 'react';
import type { ContextChip } from '../../contract/code-editor-agents';
import { CONTEXT_CHIP_MAX_LINES, CONTEXT_CHIPS_PER_SESSION } from '../../contract/code-editor-agents';
import { relativeTo } from './path';

const chips = new Map<string, readonly ContextChip[]>();
const listeners = new Map<string, Set<() => void>>();
const EMPTY: readonly ContextChip[] = Object.freeze([]);

export const CHIP_LIMIT_MESSAGE = `Chip limit reached (${CONTEXT_CHIPS_PER_SESSION})`;

function put(sessionId: string, next: readonly ContextChip[]): void {
  if (next.length === 0) chips.delete(sessionId);
  else chips.set(sessionId, next);
  for (const l of listeners.get(sessionId) ?? []) l();
}

export function getChips(sessionId: string): readonly ContextChip[] {
  return chips.get(sessionId) ?? EMPTY;
}

export function subscribeChips(sessionId: string, listener: () => void): () => void {
  let set = listeners.get(sessionId);
  if (!set) {
    set = new Set();
    listeners.set(sessionId, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(sessionId);
  };
}

export type AddChipResult = { ok: true } | { ok: false; reason: 'limit' };

/** FR-7: the 21st chip is refused. */
export function addChip(sessionId: string, chip: ContextChip): AddChipResult {
  const list = getChips(sessionId);
  if (list.length >= CONTEXT_CHIPS_PER_SESSION) return { ok: false, reason: 'limit' };
  put(sessionId, [...list, chip]);
  return { ok: true };
}

export function updateChipNote(sessionId: string, chipId: string, note: string): void {
  const list = getChips(sessionId);
  if (!list.some((c) => c.id === chipId)) return;
  put(sessionId, list.map((c) => (c.id === chipId ? { ...c, note } : c)));
}

export function removeChip(sessionId: string, chipId: string): void {
  const list = getChips(sessionId);
  const next = list.filter((c) => c.id !== chipId);
  if (next.length !== list.length) put(sessionId, next);
}

/** An accepted send, or the session going away. */
export function clearChips(sessionId: string): void {
  if (chips.has(sessionId)) put(sessionId, EMPTY);
}

export function useContextChips(sessionId: string): readonly ContextChip[] {
  return useSyncExternalStore(
    (onChange) => subscribeChips(sessionId, onChange),
    () => getChips(sessionId),
  );
}

// ---------- pure helpers ----------

/** FR-4/FR-7: a selection chip from its full lines; over 400 lines keeps the first 400. */
export function selectionChip(input: { path: string; startLine: number; lines: readonly string[]; language?: string; now: number }): ContextChip {
  const { lines } = input;
  const cut = lines.length > CONTEXT_CHIP_MAX_LINES;
  return {
    id: crypto.randomUUID(),
    kind: 'selection',
    path: input.path,
    startLine: input.startLine,
    endLine: input.startLine + Math.max(lines.length, 1) - 1,
    snippet: (cut ? lines.slice(0, CONTEXT_CHIP_MAX_LINES) : lines).join('\n'),
    ...(cut ? { totalLines: lines.length } : {}),
    ...(input.language ? { language: input.language } : {}),
    createdAt: input.now,
  };
}

/** FR-6: relative to the session cwd, absolute when outside it. */
export function chipPath(path: string, cwd: string): string {
  return relativeTo(path, cwd) ?? path;
}

const range = (c: ContextChip) => (c.endLine > c.startLine ? `${c.startLine}–${c.endLine}` : `${c.startLine}`);

/** `src/auth.ts:12–40` / `src/auth.ts:42`. */
export function chipLabel(chip: ContextChip, cwd: string): string {
  return `${chipPath(chip.path, cwd)}:${range(chip)}`;
}

/** "(first 400 of N lines)" when the snippet was cut, else ''. */
export function cutNote(chip: ContextChip): string {
  return chip.totalLines ? `(first ${CONTEXT_CHIP_MAX_LINES} of ${chip.totalLines} lines)` : '';
}

function fenceFor(snippet: string): string {
  const longest = Math.max(0, ...[...snippet.matchAll(/`+/g)].map((m) => m[0].length));
  return '`'.repeat(Math.max(3, longest + 1));
}

function serializeChip(chip: ContextChip, cwd: string): string {
  const what = chip.endLine > chip.startLine ? `lines ${range(chip)}` : `line ${chip.startLine}`;
  const cut = cutNote(chip);
  const out = [`\`${chipPath(chip.path, cwd)}\` ${what}${cut ? ` ${cut}` : ''}:`];
  if (chip.snippet !== undefined) {
    const fence = fenceFor(chip.snippet);
    out.push(`${fence}${chip.language ?? ''}`, chip.snippet, fence);
  }
  if (chip.note && chip.note.trim() !== '') out.push(chip.note);
  return out.join('\n');
}

/** FR-6: every chip in order, a blank line between them. */
export function serializeChips(list: readonly ContextChip[], cwd: string): string {
  return list.map((c) => serializeChip(c, cwd)).join('\n\n');
}

/** FR-6: the message text — the chips, a blank line, then what the user typed. */
export function composeWithChips(list: readonly ContextChip[], cwd: string, typed: string): string {
  if (list.length === 0) return typed;
  const head = serializeChips(list, cwd);
  return typed.trim() === '' ? head : `${head}\n\n${typed}`;
}
