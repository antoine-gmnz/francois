import { describe, expect, it } from 'vitest';
import { classifyToolStart, type ToolConversationBlock } from '../../../contract/conversation-view';
import type { PlanItem } from '../../../contract/common';
import { latestPlanBlockId, planStepLabel } from './plan-view';
import { compactBlocks, transcriptReducer } from './conversation-blocks';

const plan = (status: PlanItem['status']): PlanItem[] => [{ content: 'Run tests', status, activeForm: 'Running tests' }];
const planBlock = (blockId: string, items: PlanItem[]): ToolConversationBlock => ({
  ...(classifyToolStart('TodoWrite', '1 step', blockId) as ToolConversationBlock),
  plan: items,
});

describe('latestPlanBlockId', () => {
  it('is the last tool block carrying a plan', () => {
    const blocks = [planBlock('p1', plan('pending')), classifyToolStart('Read', 'a.ts', 'r1'), planBlock('p2', plan('completed'))];
    expect(latestPlanBlockId(blocks)).toBe('p2');
  });

  it('skips an empty plan and is null when no block carries one', () => {
    expect(latestPlanBlockId([planBlock('p1', plan('pending')), planBlock('p2', [])])).toBe('p1');
    expect(latestPlanBlockId([classifyToolStart('Read', 'a.ts', 'r1')])).toBeNull();
  });
});

describe('planStepLabel', () => {
  it('reads the active form only while the step is in progress', () => {
    expect(planStepLabel(plan('in_progress')[0]!)).toBe('Running tests');
    expect(planStepLabel(plan('pending')[0]!)).toBe('Run tests');
    expect(planStepLabel(plan('completed')[0]!)).toBe('Run tests');
    expect(planStepLabel({ content: 'Run tests', status: 'in_progress' })).toBe('Run tests');
  });
});

describe('conversation reducer carries the plan', () => {
  const empty = { blocks: [], windowSize: 200 };

  it('toolStart attaches the plan to the tool block', () => {
    const s = transcriptReducer(empty, { t: 'toolStart', blockId: 'p1', tool: 'TodoWrite', summary: '1 step', plan: plan('pending') });
    expect(s.blocks[0]).toMatchObject({ kind: 'tool', plan: plan('pending') });
  });

  it('toolStart without a plan leaves the key absent', () => {
    const s = transcriptReducer(empty, { t: 'toolStart', blockId: 'r1', tool: 'Read', summary: 'a.ts' });
    expect('plan' in s.blocks[0]!).toBe(false);
  });

  it('compactBlocks never merges two plan snapshots with the same summary', () => {
    const blocks = [planBlock('p1', plan('pending')), planBlock('p2', plan('in_progress'))].map((b) => ({ ...b, isStreaming: false }));
    expect(compactBlocks(blocks).map((b) => b.blockId)).toEqual(['p1', 'p2']);
  });

  it('toolDone keeps the plan', () => {
    const started = transcriptReducer(empty, { t: 'toolStart', blockId: 'p1', tool: 'TodoWrite', summary: '1 step', plan: plan('pending') });
    const done = transcriptReducer(started, { t: 'toolDone', blockId: 'p1', meta: 'done' });
    expect(done.blocks[0]).toMatchObject({ plan: plan('pending'), isStreaming: false });
  });
});
