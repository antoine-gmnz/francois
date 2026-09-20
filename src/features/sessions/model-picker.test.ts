// model-picker (multi-provider-openai FR-21) — the pure grouping ModelPicker's
// popover renders, extracted from the component so it is covered by vitest.

import { describe, expect, it } from 'vitest';
import type { ModelInfo } from '../../../contract/common';
import { familyOf, filterModelInfos, groupByFamily, groupModelsBy, sortFavoritesFirst } from './model-picker';

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

describe('groupModelsBy (pi-models-metrics §5)', () => {
  it('groups by an arbitrary key, first-seen order — the building block groupByFamily uses', () => {
    const anthropic = { id: 'a', label: 'Sonnet 5', descriptor: { ref: { providerId: 'anthropic', modelId: 'sonnet' } } } as ModelInfo;
    const ollama = { id: 'b', label: 'Sonnet 5', descriptor: { ref: { providerId: 'ollama', modelId: 'sonnet' } } } as ModelInfo;
    // FR-1: identical modelId under two providers stays two distinct rows —
    // grouping by providerId (not family/label) keeps them apart.
    const groups = groupModelsBy([anthropic, ollama], (m) => m.descriptor!.ref.providerId);
    expect(groups).toEqual([
      { family: 'anthropic', items: [anthropic] },
      { family: 'ollama', items: [ollama] },
    ]);
  });
});

describe('filterModelInfos (design brief §Flows: search provider and model labels)', () => {
  const sonnet = { id: 'a', label: 'Sonnet 5', descriptor: { ref: { providerId: 'anthropic', modelId: 'claude-sonnet-5' } } } as ModelInfo;
  const llama = { id: 'b', label: 'Llama 3', descriptor: { ref: { providerId: 'ollama', modelId: 'llama3' } } } as ModelInfo;

  it('is a no-op for a blank query', () => {
    expect(filterModelInfos([sonnet, llama], '')).toEqual([sonnet, llama]);
    expect(filterModelInfos([sonnet, llama], '   ')).toEqual([sonnet, llama]);
  });

  it('matches the display label', () => {
    expect(filterModelInfos([sonnet, llama], 'sonnet')).toEqual([sonnet]);
  });

  it('matches the provider id even when it is not in the label', () => {
    expect(filterModelInfos([sonnet, llama], 'ollama')).toEqual([llama]);
  });

  it('matches the exact model id', () => {
    expect(filterModelInfos([sonnet, llama], 'llama3')).toEqual([llama]);
  });

  it('is case-insensitive', () => {
    expect(filterModelInfos([sonnet, llama], 'ANTHROPIC')).toEqual([sonnet]);
  });

  it('falls back to runtimeModel when there is no descriptor (a merged unavailable row)', () => {
    const gone = { id: 'c', label: 'gpt-4o', runtimeModel: { providerId: 'openai-compat', modelId: 'gpt-4o' } } as ModelInfo;
    expect(filterModelInfos([gone], 'openai-compat')).toEqual([gone]);
  });

  it('matches nothing for a query no field carries', () => {
    expect(filterModelInfos([sonnet, llama], 'xyz')).toEqual([]);
  });
});

describe('sortFavoritesFirst (design brief §Flows: favorites)', () => {
  it('moves favorites to the front, preserving relative order within each half', () => {
    expect(sortFavoritesFirst(['a', 'b', 'c', 'd'], (x) => x === 'c' || x === 'a')).toEqual(['a', 'c', 'b', 'd']);
  });

  it('returns the SAME array reference when nothing is favorited', () => {
    const items = ['a', 'b'];
    expect(sortFavoritesFirst(items, () => false)).toBe(items);
  });

  it('is a no-op ordering when everything is favorited', () => {
    expect(sortFavoritesFirst(['a', 'b'], () => true)).toEqual(['a', 'b']);
  });
});

// Viewport geometry and scroll behavior are tested independently of visual layout.
import { modelPickerPlacement, revealModelOption } from './model-picker';
import { vi } from 'vitest';

describe('catalogue access', () => {
  it('keeps both columns inside a 720px window', () => {
    const rect = modelPickerPlacement({ left: 120, top: 300, bottom: 332, width: 480 }, 720, 600);
    expect(rect.left).toBeGreaterThanOrEqual(8);
    expect(rect.left + rect.width).toBeLessThanOrEqual(712);
    expect(rect.top + rect.maxHeight).toBeLessThanOrEqual(592);
  });
  it('opens above a low trigger and bounds long lists', () => {
    const rect = modelPickerPlacement({ left: 680, top: 550, bottom: 582, width: 480 }, 720, 600);
    expect(rect.top).toBeLessThan(550);
    expect(rect.maxHeight).toBeLessThanOrEqual(360);
    expect(rect.left + rect.width).toBeLessThanOrEqual(712);
  });
  it('reveals the active family and model during long-list navigation', () => {
    const family = { scrollIntoView: vi.fn() };
    const option = { scrollIntoView: vi.fn() };
    const root = { querySelector: vi.fn().mockReturnValueOnce(family).mockReturnValueOnce(option) };
    revealModelOption(root as unknown as HTMLElement);
    expect(family.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
    expect(option.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
  });
});
