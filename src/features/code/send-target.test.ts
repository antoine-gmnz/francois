// code-editor-agents FR-5 — which session a chip from the editor goes to.

import { describe, expect, it } from 'vitest';
import type { SessionStatus } from '../../../contract/common';
import { pickerItems, resolveTarget, type TargetSession } from './send-target';

const s = (id: string, cwd: string, status: SessionStatus = 'idle'): TargetSession => ({ id, name: id, cwd, status, agentRuntime: 'claude-code' });

describe('resolveTarget (FR-5)', () => {
  it('targets the one live session on this root silently', () => {
    expect(resolveTarget([s('a', 'C:\\repo'), s('b', '/other')], 'C:/repo')).toEqual({ kind: 'direct', sessionId: 'a' });
  });

  it('ignores archived and errored sessions when counting', () => {
    expect(resolveTarget([s('a', '/r'), s('old', '/r', 'done'), s('bad', '/r', 'error')], '/r')).toEqual({ kind: 'direct', sessionId: 'a' });
  });

  it('asks with a picker when several sessions share the root, same-root first', () => {
    const r = resolveTarget([s('x', '/other'), s('a', '/r'), s('b', '/r/')], '/r');
    expect(r).toEqual({ kind: 'pick', sameRoot: ['a', 'b'], others: ['x'], highlight: 'a' });
  });

  it('asks when none is on the root, and pre-highlights the remembered pick without applying it', () => {
    const r = resolveTarget([s('x', '/o1'), s('y', '/o2')], '/r', 'y');
    expect(r).toEqual({ kind: 'pick', sameRoot: [], others: ['x', 'y'], highlight: 'y' });
  });

  it('never auto-applies a remembered pick, even with one same-root session elsewhere', () => {
    const r = resolveTarget([s('a', '/r'), s('b', '/r')], '/r', 'b');
    expect(r).toMatchObject({ kind: 'pick', highlight: 'b' });
  });

  it('reports none when no session is live at all', () => {
    expect(resolveTarget([s('old', '/r', 'done')], '/r')).toEqual({ kind: 'none' });
  });
});

describe('pickerItems', () => {
  it('flattens the groups in display order', () => {
    expect(pickerItems({ kind: 'pick', sameRoot: ['a'], others: ['x', 'y'], highlight: 'x' })).toEqual(['a', 'x', 'y']);
  });
});
