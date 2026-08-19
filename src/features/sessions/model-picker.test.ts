// model-picker (multi-provider-openai FR-21) — the pure grouping ModelPicker's
// popover renders, extracted from the component so it is covered by vitest.

import { describe, expect, it } from 'vitest';
import type { ModelInfo } from '../../../contract/common';
import { familyOf, groupByFamily, reconcileModelId } from './model-picker';

const model = (id: string, label: string): ModelInfo => ({ id, label });

describe('familyOf', () => {
  it('is the label\'s first word', () => {
    expect(familyOf(model('claude-sonnet-5', 'Sonnet 5'))).toBe('Sonnet');
    expect(familyOf(model('claude-opus-5', 'Opus 5 (xhigh)'))).toBe('Opus');
  });

  it('falls back to the whole label when it has no space', () => {
    expect(familyOf(model('haiku', 'Haiku'))).toBe('Haiku');
  });
});

describe('groupByFamily (FR-21)', () => {
  it('groups models sharing a family, in first-seen family order', () => {
    const models = [
      model('claude-sonnet-5', 'Sonnet 5'),
      model('claude-opus-5', 'Opus 5'),
      model('claude-sonnet-5-thinking', 'Sonnet 5 (thinking)'),
      model('claude-haiku', 'Haiku'),
    ];
    expect(groupByFamily(models)).toEqual([
      { family: 'Sonnet', items: [models[0], models[2]] },
      { family: 'Opus', items: [models[1]] },
      { family: 'Haiku', items: [models[3]] },
    ]);
  });

  it('is empty for an empty catalog — never a fabricated group', () => {
    expect(groupByFamily([])).toEqual([]);
  });

  it('is a straight single-item group per family when every model has its own', () => {
    const models = [model('a', 'A'), model('b', 'B')];
    expect(groupByFamily(models)).toEqual([
      { family: 'A', items: [models[0]] },
      { family: 'B', items: [models[1]] },
    ]);
  });
});

describe('reconcileModelId (useModelCatalog account rekey)', () => {
  const models = [model('claude-sonnet-5', 'Sonnet 5'), model('claude-opus-5', 'Opus 5')];

  it('keeps the current id when it is still in the fetched catalog', () => {
    expect(reconcileModelId('claude-opus-5', models)).toBe('claude-opus-5');
  });

  it('falls back to the catalog\'s first entry when nothing is selected yet', () => {
    expect(reconcileModelId('', models)).toBe('claude-sonnet-5');
  });

  it('falls back to the catalog\'s first entry when the current id belonged to a different account/provider', () => {
    // e.g. switching from a Claude account (modelId 'claude-opus-5') to an
    // endpoint account whose catalog carries entirely different ids.
    expect(reconcileModelId('gpt-4o', models)).toBe('claude-sonnet-5');
  });

  it('is empty for an empty catalog — never a fabricated id', () => {
    expect(reconcileModelId('claude-opus-5', [])).toBe('');
    expect(reconcileModelId('', [])).toBe('');
  });
});
