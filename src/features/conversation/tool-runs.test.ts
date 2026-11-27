// compactBlocks — render-time merge of duplicate consecutive tool rows.
// Moved with the code from conversation-blocks.test.ts.

import { describe, expect, it } from 'vitest';
import type { RuntimeToolCall } from '../../../contract/common';
import { classifyToolStart, type ConversationBlock } from '../../../contract/conversation-view';
import { compactBlocks } from './tool-runs';
import { runtimeToolBlock } from './runtime-tool-blocks';

function runtimeTool(overrides: Partial<RuntimeToolCall> = {}): RuntimeToolCall {
  return {
    id: 'call-1',
    name: 'Read',
    status: 'pending',
    inputText: '',
    outputText: '',
    inputTruncated: false,
    outputTruncated: false,
    ...overrides,
  };
}

describe('compactBlocks (render-time merge of duplicate consecutive tool rows)', () => {
  const tool = (blockId: string, name: string, summary: string, meta?: string): ConversationBlock => ({
    ...classifyToolStart(name, summary, blockId),
    isStreaming: meta === undefined,
    ...(meta !== undefined ? { meta } : {}),
  });

  it('merges consecutive edits of the same file, summing the +N −M metas', () => {
    const out = compactBlocks([
      tool('t1', 'Edit', 'src/a.ts', '+3 −1'),
      tool('t2', 'Edit', 'src/a.ts', '+5 −2'),
    ]);
    expect(out).toHaveLength(1);
    const b = out[0];
    if (b.kind !== 'tool') throw new Error('expected tool block');
    expect(b.blockId).toBe('t2'); // newest block keys the row
    expect(b.meta).toBe('+8 −3');
  });

  it('accumulates across a run of three', () => {
    const out = compactBlocks([
      tool('t1', 'Edit', 'src/a.ts', '+3 −1'),
      tool('t2', 'Edit', 'src/a.ts', '+5 −2'),
      tool('t3', 'Edit', 'src/a.ts', '+2 −0'),
    ]);
    expect(out).toHaveLength(1);
    const b = out[0];
    if (b.kind !== 'tool') throw new Error('expected tool block');
    expect(b.meta).toBe('+10 −3');
  });

  it('keeps the last meta when metas are not line-change shaped', () => {
    const out = compactBlocks([
      tool('t1', 'Read', 'src/a.ts', '50 lines'),
      tool('t2', 'Read', 'src/a.ts', '412 lines'),
    ]);
    expect(out).toHaveLength(1);
    const b = out[0];
    if (b.kind !== 'tool') throw new Error('expected tool block');
    expect(b.meta).toBe('412 lines');
  });

  it('does not merge different files or different tools', () => {
    const out = compactBlocks([
      tool('t1', 'Edit', 'src/a.ts', '+3 −1'),
      tool('t2', 'Edit', 'src/b.ts', '+5 −2'),
      tool('t3', 'Write', 'src/b.ts', '12 lines'),
    ]);
    expect(out).toHaveLength(3);
  });

  it('does not merge across an intervening non-tool block', () => {
    const assistant: ConversationBlock = {
      kind: 'assistant',
      blockId: 'a1',
      isStreaming: false,
      glyph: '●',
      glyphColor: '#8b93a3',
      bodyColor: '#c3c9d4',
      text: 'now the second edit',
    };
    const out = compactBlocks([
      tool('t1', 'Edit', 'src/a.ts', '+3 −1'),
      assistant,
      tool('t2', 'Edit', 'src/a.ts', '+5 −2'),
    ]);
    expect(out).toHaveLength(3);
  });

  it('never merges an error row (errors stay visible and break the run)', () => {
    const out = compactBlocks([
      tool('t1', 'Edit', 'src/a.ts', '+3 −1'),
      tool('t2', 'Edit', 'src/a.ts', 'error'),
      tool('t3', 'Edit', 'src/a.ts', '+5 −2'),
    ]);
    expect(out).toHaveLength(3);
  });

  it('never merges a hook-refused row, whose meta is the reason rather than "error"', () => {
    const base = tool('t2', 'Bash', 'echo DENYME', 'stub-gate: DENYME is forbidden');
    if (base.kind !== 'tool') throw new Error('expected tool block');
    const refused: ConversationBlock = { ...base, tone: 'hookRefusal' };
    const out = compactBlocks([tool('t1', 'Bash', 'echo DENYME', '1 line'), refused, tool('t3', 'Bash', 'echo DENYME', '1 line')]);
    expect(out).toHaveLength(3);
  });

  // A Pi row decides from `execution.status`, a plain Claude row from an
  // exact `error` meta — the two runtimes never share a rule. Claude's metas
  // are free-form (tools.rs: a Task row's is the first line of the subagent's
  // own result), so a WORD match on them would break a run on prose that
  // merely mentions a failure.
  it('merges consecutive Claude rows whose free-form meta merely mentions failure', () => {
    const out = compactBlocks([
      tool('t1', 'Read', 'src/a.ts', '2 unknown symbols'),
      tool('t2', 'Read', 'src/a.ts', '3 unknown symbols'),
    ]);
    expect(out).toHaveLength(1);
    const b = out[0];
    if (b.kind !== 'tool') throw new Error('expected tool block');
    expect(b.meta).toBe('3 unknown symbols');
  });

  it('merges consecutive Claude rows whose meta says “cancelled” inside a sentence', () => {
    const out = compactBlocks([
      tool('t1', 'Read', 'src/a.ts', 'the run was cancelled upstream'),
      tool('t2', 'Read', 'src/a.ts', 'the run was cancelled upstream'),
    ]);
    expect(out).toHaveLength(1);
  });

  it('never merges a Pi runtime tool whose call did not settle cleanly (pi-transcript-events §3)', () => {
    // Same execution id on both rows, so ONLY the status can break the run.
    for (const status of ['failed', 'cancelled', 'unknown'] as const) {
      const out = compactBlocks([
        runtimeToolBlock('t1', runtimeTool({ id: 'call-1', inputText: 'src/a.ts', status })),
        runtimeToolBlock('t2', runtimeTool({ id: 'call-1', inputText: 'src/a.ts', status: 'succeeded' })),
      ]);
      expect(out).toHaveLength(2);
    }
  });

  it('does not merge Pi tool rows whose execution IDs differ', () => {
    const out = compactBlocks([
      runtimeToolBlock('t1', runtimeTool({ id: 'call-1', name: 'Read', inputText: 'src/a.ts' })),
      runtimeToolBlock('t2', runtimeTool({ id: 'call-2', name: 'Read', inputText: 'src/a.ts' })),
    ]);
    expect(out).toHaveLength(2);
  });

  it('a still-streaming newest edit keeps the run total and the streaming state', () => {
    const out = compactBlocks([
      tool('t1', 'Edit', 'src/a.ts', '+3 −1'),
      tool('t2', 'Edit', 'src/a.ts'),
    ]);
    expect(out).toHaveLength(1);
    const b = out[0];
    if (b.kind !== 'tool') throw new Error('expected tool block');
    expect(b.blockId).toBe('t2');
    expect(b.isStreaming).toBe(true);
    expect(b.meta).toBe('+3 −1');
  });

  it('leaves subagent blocks alone even with identical names', () => {
    const out = compactBlocks([
      tool('t1', 'Task', 'explorer', 'done in 4s'),
      tool('t2', 'Task', 'explorer', 'done in 2s'),
    ]);
    expect(out).toHaveLength(2);
  });
});

describe('compactBlocks preserves block identity for untouched blocks (mac-text-selection FR-4)', () => {
  it('returns the same object references for blocks it does not merge', () => {
    // compactBlocks runs on every ConversationView render, right before the
    // key={b.blockId} map to <Block>. If it recreated non-merged blocks the
    // reconciler would still key them the same, but keeping reference identity
    // here is the cheapest guarantee that unrelated re-renders stay no-ops.
    const user: ConversationBlock = { kind: 'user', blockId: 'u1', isStreaming: false, text: 'hi' };
    const assistant: ConversationBlock = {
      kind: 'assistant',
      blockId: 'a1',
      isStreaming: true,
      glyph: '●',
      glyphColor: '#c3f53f',
      bodyColor: '#e6e9ef',
      text: 'Hello',
    };
    const out = compactBlocks([user, assistant]);
    expect(out[0]).toBe(user);
    expect(out[1]).toBe(assistant);
  });
});
