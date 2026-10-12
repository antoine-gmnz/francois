// code-editor-agents FR-6/FR-7 — per-session context chips and their serialisation.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContextChip } from '../../contract/code-editor-agents';
import { CONTEXT_CHIP_MAX_LINES, CONTEXT_CHIPS_PER_SESSION } from '../../contract/code-editor-agents';
import {
  addChip,
  CHIP_LIMIT_MESSAGE,
  chipLabel,
  clearChips,
  composeWithChips,
  getChips,
  removeChip,
  selectionChip,
  serializeChips,
  subscribeChips,
  updateChipNote,
} from './context-chips';

const chip = (patch: Partial<ContextChip> = {}): ContextChip => ({
  id: crypto.randomUUID(),
  kind: 'comment',
  path: '/r/src/auth.ts',
  startLine: 42,
  endLine: 42,
  note: 'this retry never backs off',
  createdAt: 1,
  ...patch,
});

beforeEach(() => {
  clearChips('s1');
  clearChips('s2');
});

describe('per-session chip map (FR-6)', () => {
  it('adds in order, per session, and notifies only that session', () => {
    const l1 = vi.fn();
    const l2 = vi.fn();
    const off = subscribeChips('s1', l1);
    subscribeChips('s2', l2);
    const a = chip();
    const b = chip({ startLine: 1, endLine: 1 });
    addChip('s1', a);
    addChip('s1', b);
    expect(getChips('s1').map((c) => c.id)).toEqual([a.id, b.id]);
    expect(getChips('s2')).toEqual([]);
    expect(l1).toHaveBeenCalledTimes(2);
    expect(l2).not.toHaveBeenCalled();
    off();
    removeChip('s1', a.id);
    expect(l1).toHaveBeenCalledTimes(2);
    expect(getChips('s1').map((c) => c.id)).toEqual([b.id]);
  });

  it('edits a note in place and clears a session', () => {
    const a = chip();
    addChip('s1', a);
    updateChipNote('s1', a.id, 'new note');
    expect(getChips('s1')[0].note).toBe('new note');
    clearChips('s1');
    expect(getChips('s1')).toEqual([]);
  });

  it('refuses the 21st chip (FR-7)', () => {
    for (let i = 0; i < CONTEXT_CHIPS_PER_SESSION; i++) expect(addChip('s1', chip()).ok).toBe(true);
    expect(addChip('s1', chip())).toEqual({ ok: false, reason: 'limit' });
    expect(getChips('s1')).toHaveLength(20);
    expect(CHIP_LIMIT_MESSAGE).toBe('Chip limit reached (20)');
  });
});

describe('selectionChip (FR-4/FR-7)', () => {
  it('keeps the lines LF-joined with the language', () => {
    const c = selectionChip({ path: '/r/a.ts', startLine: 12, lines: ['a', 'b'], language: 'typescript', now: 5 });
    expect(c).toMatchObject({ kind: 'selection', startLine: 12, endLine: 13, snippet: 'a\nb', language: 'typescript', createdAt: 5 });
    expect(c.totalLines).toBeUndefined();
  });

  it('cuts a selection over 400 lines to its first 400 and records the total', () => {
    const lines = Array.from({ length: 900 }, (_, i) => `l${i}`);
    const c = selectionChip({ path: '/r/a.ts', startLine: 1, lines, now: 0 });
    expect(c.snippet?.split('\n')).toHaveLength(CONTEXT_CHIP_MAX_LINES);
    expect(c.totalLines).toBe(900);
    expect(c.endLine).toBe(900);
  });
});

describe('chipLabel', () => {
  it('reads path:start–end, or path:line, relative to the cwd', () => {
    expect(chipLabel(chip({ kind: 'selection', startLine: 12, endLine: 40 }), '/r')).toBe('src/auth.ts:12–40');
    expect(chipLabel(chip(), '/r')).toBe('src/auth.ts:42');
    expect(chipLabel(chip(), '/elsewhere')).toBe('/r/src/auth.ts:42');
  });
});

describe('serializeChips / composeWithChips (FR-6)', () => {
  const sel = chip({ kind: 'selection', startLine: 12, endLine: 40, snippet: 'const a = 1;', language: 'typescript', note: undefined });

  it('serialises a selection as a fenced block under its range', () => {
    expect(serializeChips([sel], '/r')).toBe('`src/auth.ts` lines 12–40:\n```typescript\nconst a = 1;\n```');
  });

  it('adds the note after the fence, and a comment chip carries its line and note', () => {
    expect(serializeChips([{ ...sel, note: 'why?' }], '/r')).toBe('`src/auth.ts` lines 12–40:\n```typescript\nconst a = 1;\n```\nwhy?');
    expect(serializeChips([chip()], '/r')).toBe('`src/auth.ts` line 42:\nthis retry never backs off');
  });

  it('says when the snippet was cut', () => {
    const cut = { ...sel, endLine: 900, startLine: 1, totalLines: 900 };
    expect(serializeChips([cut], '/r').split('\n')[0]).toBe('`src/auth.ts` lines 1–900 (first 400 of 900 lines):');
  });

  it('uses an absolute path outside the cwd and a longer fence around backticks', () => {
    const ticks = { ...sel, snippet: 'a\n```\nb', language: undefined };
    expect(serializeChips([ticks], '/other')).toBe('`/r/src/auth.ts` lines 12–40:\n````\na\n```\nb\n````');
  });

  it('joins chips in order, then a blank line, then the typed text', () => {
    const c = chip();
    expect(composeWithChips([sel, c], '/r', 'why is this wrong?')).toBe(
      `${serializeChips([sel], '/r')}\n\n${serializeChips([c], '/r')}\n\nwhy is this wrong?`,
    );
  });

  it('sends the chips alone from an empty composer, and the text alone with no chips', () => {
    expect(composeWithChips([sel], '/r', '  ')).toBe(serializeChips([sel], '/r'));
    expect(composeWithChips([], '/r', 'hi')).toBe('hi');
  });
});
