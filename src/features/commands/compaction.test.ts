import { describe, expect, it } from 'vitest';
import { commandFromCard, transcriptReducer } from '../conversation/conversation-blocks';
import { compactionLabel } from './compaction';

describe('compactionLabel (audit C4)', () => {
  it('names the trigger and the context size it started from', () => {
    expect(compactionLabel({ kind: 'compaction', trigger: 'auto', preTokens: 150_000 })).toBe('Context compacted · auto · 150K tokens before');
  });

  it('drops the size when the CLI did not report one', () => {
    expect(compactionLabel({ kind: 'compaction', trigger: 'manual' })).toBe('Context compacted · manual');
    expect(compactionLabel({ kind: 'compaction', trigger: 'manual', preTokens: 0 })).toBe('Context compacted · manual');
  });

  it('answers the /compact command token', () => {
    expect(commandFromCard({ kind: 'compaction', trigger: 'auto' })).toBe('compact');
  });

  it('lands mid-turn as its own block between two tool rows', () => {
    let state = transcriptReducer({ blocks: [], windowSize: 200 }, { t: 'toolStart', blockId: 't1', tool: 'Read', summary: 'a.ts' });
    state = transcriptReducer(state, { t: 'commandOutput', blockId: 'c1', card: { kind: 'compaction', trigger: 'auto', preTokens: 1000 } });
    state = transcriptReducer(state, { t: 'toolStart', blockId: 't2', tool: 'Read', summary: 'b.ts' });
    expect(state.blocks.map((b) => [b.blockId, b.kind])).toEqual([
      ['t1', 'tool'],
      ['c1', 'command'],
      ['t2', 'tool'],
    ]);
    const divider = state.blocks[1];
    expect(divider.kind === 'command' && divider.card?.kind).toBe('compaction');
    expect(divider.isStreaming).toBe(false);
  });
});
