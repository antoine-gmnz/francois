// code-editor-workspace FR-9 — "Send to <target> with this problem".

import { describe, expect, it, vi } from 'vitest';
import type { SessionStatus } from '../../../contract/common';
import {
  markerAt,
  problemActions,
  problemChip,
  problemNote,
  problemTargetTitle,
  ProblemTargets,
  SEND_PROBLEM_COMMAND,
  type ProblemMarker,
} from './problem-send';
import type { TargetSession } from './send-target';

const ERROR = 8;
const WARNING = 4;

const marker = (patch: Partial<ProblemMarker> = {}): ProblemMarker => ({
  severity: ERROR,
  message: "Property 'x' does not exist on type 'Y'.",
  code: '2339',
  startLineNumber: 3,
  startColumn: 5,
  endLineNumber: 3,
  endColumn: 10,
  ...patch,
});

describe('markerAt (FR-9 ⌘L)', () => {
  it('picks the marker whose range holds the caret', () => {
    const m = marker();
    expect(markerAt([m], 3, 5)).toBe(m);
    expect(markerAt([m], 3, 10)).toBe(m);
    expect(markerAt([m], 3, 11)).toBeNull();
    expect(markerAt([m], 4, 5)).toBeNull();
  });

  it('spans lines', () => {
    const m = marker({ startLineNumber: 2, startColumn: 8, endLineNumber: 4, endColumn: 2 });
    expect(markerAt([m], 3, 1)).toBe(m);
    expect(markerAt([m], 2, 7)).toBeNull();
    expect(markerAt([m], 4, 3)).toBeNull();
  });

  it('prefers the most severe, then the narrowest', () => {
    const warn = marker({ severity: WARNING, startColumn: 1, endColumn: 20 });
    const wide = marker({ startColumn: 1, endColumn: 20 });
    const narrow = marker({ startColumn: 4, endColumn: 8 });
    expect(markerAt([warn, wide, narrow], 3, 6)).toBe(narrow);
    expect(markerAt([warn, wide], 3, 2)).toBe(wide);
  });
});

describe('problemNote (FR-9)', () => {
  it('is the message then ts(code)', () => {
    expect(problemNote(marker())).toBe("Property 'x' does not exist on type 'Y'. ts(2339)");
  });

  it('uses the marker source when it has one, and reads an object code', () => {
    expect(problemNote(marker({ source: 'json', code: { value: '519', target: 'https://x' } }))).toBe("Property 'x' does not exist on type 'Y'. json(519)");
  });

  it('is the message alone without a code', () => {
    expect(problemNote(marker({ code: undefined }))).toBe("Property 'x' does not exist on type 'Y'.");
  });
});

describe('problemChip (FR-9)', () => {
  it("is a selection chip of the marker's lines whose note is the problem", () => {
    const lines = ['a', 'b', 'c', 'd', 'e'];
    const chip = problemChip(marker({ startLineNumber: 2, endLineNumber: 3 }), (l) => lines[l - 1], { path: '/r/a.ts', language: 'typescript', now: 9 });
    expect(chip).toMatchObject({ kind: 'selection', path: '/r/a.ts', startLine: 2, endLine: 3, snippet: 'b\nc', language: 'typescript', createdAt: 9 });
    expect(chip.note).toBe("Property 'x' does not exist on type 'Y'. ts(2339)");
  });
});

describe('problemTargetTitle (FR-9, target as code-editor-agents FR-5)', () => {
  const s = (id: string, cwd: string, status: SessionStatus = 'idle'): TargetSession => ({ id, name: `name-${id}`, cwd, status, agentRuntime: 'claude-code' });

  it('names the single same-root session', () => {
    expect(problemTargetTitle([s('a', '/r'), s('b', '/o')], '/r')).toBe('Send to name-a with this problem');
  });

  it('says "session" when a pick is needed or nobody is live', () => {
    expect(problemTargetTitle([s('a', '/r'), s('b', '/r')], '/r')).toBe('Send to session with this problem');
    expect(problemTargetTitle([], '/r')).toBe('Send to session with this problem');
  });
});

describe('problemActions (FR-9)', () => {
  it('contributes one quick fix per marker, invoking the send command', () => {
    const a = marker();
    const b = marker({ severity: WARNING, code: '6133' });
    const actions = problemActions([a, b], 'Send to s with this problem', 'file:///a.ts');
    expect(actions).toHaveLength(2);
    expect(actions[0]).toEqual({
      title: 'Send to s with this problem',
      kind: 'quickfix',
      diagnostics: [a],
      isPreferred: false,
      command: { id: SEND_PROBLEM_COMMAND, title: 'Send to s with this problem', arguments: ['file:///a.ts', a] },
    });
    expect(actions[1].diagnostics).toEqual([b]);
  });
});

describe('ProblemTargets (FR-9 registry)', () => {
  it('routes to the most recently registered or focused editor of a model', () => {
    const reg = new ProblemTargets();
    const one = { title: () => 'one', send: vi.fn() };
    const two = { title: () => 'two', send: vi.fn() };
    const offOne = reg.register('u', one);
    reg.register('u', two);
    expect(reg.get('u')).toBe(two);
    reg.focus('u', one);
    expect(reg.get('u')).toBe(one);
    offOne();
    expect(reg.get('u')).toBe(two);
    expect(reg.get('other')).toBeUndefined();
  });
});
