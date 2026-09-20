// model-picker (multi-provider-openai FR-21) — the pure grouping ModelPicker's
// popover renders, extracted from the component so it is covered by vitest.

import { describe, expect, it } from 'vitest';
import type { ModelInfo } from '../../../contract/common';
import {
  activeFamily,
  activeModelId,
  edgeModel,
  familyOf,
  filterModelInfos,
  groupByFamily,
  groupModelsBy,
  orderedNavigableModels,
  rankFavoritesAndRecents,
  stepModel,
} from './model-picker';

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

describe('rankFavoritesAndRecents (design brief §Flows: favorites/recents; A6 review addendum)', () => {
  it('moves favorites to the front, preserving relative order within each half (favorites only, no recentRank)', () => {
    expect(rankFavoritesAndRecents(['a', 'b', 'c', 'd'], (x) => x === 'c' || x === 'a')).toEqual(['a', 'c', 'b', 'd']);
  });

  it('returns the SAME array reference when nothing is favorited and nothing is recent', () => {
    const items = ['a', 'b'];
    expect(rankFavoritesAndRecents(items, () => false)).toBe(items);
    expect(rankFavoritesAndRecents(items)).toBe(items);
  });

  it('is a no-op ordering when everything is favorited', () => {
    expect(rankFavoritesAndRecents(['a', 'b'], () => true)).toEqual(['a', 'b']);
  });

  it('places recents after favorites, most-recent-first (recentRank: 0 = most recent)', () => {
    const rank: Record<string, number | null> = { a: null, b: 1, c: 0, d: null };
    expect(rankFavoritesAndRecents(['a', 'b', 'c', 'd'], undefined, (x) => rank[x])).toEqual(['c', 'b', 'a', 'd']);
  });

  it('sorts a model that is BOTH favorite and recent as a favorite, never duplicated into recents too', () => {
    const isFavorite = (x: string) => x === 'b';
    const rank: Record<string, number | null> = { a: 1, b: 0, c: null };
    expect(rankFavoritesAndRecents(['a', 'b', 'c'], isFavorite, (x) => rank[x])).toEqual(['b', 'a', 'c']);
  });

  it('with no recentRank supplied, behaves exactly like favorites-only ranking (non-Pi callers untouched)', () => {
    expect(rankFavoritesAndRecents(['a', 'b', 'c'], (x) => x === 'b')).toEqual(['b', 'a', 'c']);
  });
});

describe('activeModelId / activeFamily (A1: derived, not trusted, state)', () => {
  const a = model('a', 'A');
  const b = model('b', 'B');

  it('keeps the current id when it is still in the visible list', () => {
    expect(activeModelId([a, b], 'b')).toBe('b');
  });

  it('falls back to the first visible model when the current id fell out of the list', () => {
    expect(activeModelId([a, b], 'gone')).toBe('a');
  });

  it('falls back to empty for an empty list', () => {
    expect(activeModelId([], 'a')).toBe('');
  });

  it('keeps the current family when it is still present', () => {
    const families = groupByFamily([a, b]);
    expect(activeFamily(families, 'B')).toBe('B');
  });

  it('falls back to the first family when the hovered one is gone (e.g. a search keystroke removed it)', () => {
    const families = groupByFamily([a, b]);
    expect(activeFamily(families, 'gone')).toBe('A');
  });

  it('falls back to null for no families', () => {
    expect(activeFamily([], 'A')).toBeNull();
  });
});

describe('orderedNavigableModels (A2/A6: keyboard order matches render order, incl. recents)', () => {
  it('concatenates families in order, favorites first within each family', () => {
    const models = [model('a', 'A'), model('b', 'A'), model('c', 'B'), model('d', 'B')];
    const families = groupByFamily(models);
    const isFavorite = (m: ModelInfo) => m.id === 'b' || m.id === 'd';
    expect(orderedNavigableModels(families, isFavorite).map((m) => m.id)).toEqual(['b', 'a', 'd', 'c']);
  });

  it('is plain family order with no isFavorite/recentRank supplied', () => {
    const models = [model('a', 'A'), model('b', 'B')];
    expect(orderedNavigableModels(groupByFamily(models)).map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('places recents after favorites, most-recent-first, within each family — same ranking the submenu renders', () => {
    // family A: a=favorite, b=recent(rank 1), c=recent(rank 0) → c, b, a
    // family B: d=nothing, e=recent(rank 0) → e, d
    const models = [model('a', 'A'), model('b', 'A'), model('c', 'A'), model('d', 'B'), model('e', 'B')];
    const families = groupByFamily(models);
    const isFavorite = (m: ModelInfo) => m.id === 'a';
    const rank: Record<string, number | null> = { b: 1, c: 0, e: 0 };
    const recentRank = (m: ModelInfo) => rank[m.id] ?? null;
    expect(orderedNavigableModels(families, isFavorite, recentRank).map((m) => m.id)).toEqual(['a', 'c', 'b', 'e', 'd']);
  });
});

describe('stepModel (A2: skips unavailable rows, wraps around)', () => {
  const available = (id: string): ModelInfo => ({ id, label: id });
  const unavailable = (id: string): ModelInfo => ({ id, label: id, descriptor: { availability: 'unavailable' } } as ModelInfo);

  it('steps forward and backward through a plain list', () => {
    const list = [available('a'), available('b'), available('c')];
    expect(stepModel(list, 'a', 1)?.id).toBe('b');
    expect(stepModel(list, 'b', -1)?.id).toBe('a');
  });

  it('wraps around at both ends', () => {
    const list = [available('a'), available('b'), available('c')];
    expect(stepModel(list, 'c', 1)?.id).toBe('a');
    expect(stepModel(list, 'a', -1)?.id).toBe('c');
  });

  it('skips unavailable rows while stepping', () => {
    const list = [available('a'), unavailable('b'), available('c')];
    expect(stepModel(list, 'a', 1)?.id).toBe('c');
    expect(stepModel(list, 'c', -1)?.id).toBe('a');
  });

  it('is null when every row is unavailable', () => {
    const list = [unavailable('a'), unavailable('b')];
    expect(stepModel(list, 'a', 1)).toBeNull();
  });

  it('is null for an empty list', () => {
    expect(stepModel([], '', 1)).toBeNull();
  });

  it('stays on the only row of a single-item list', () => {
    const list = [available('a')];
    expect(stepModel(list, 'a', 1)?.id).toBe('a');
    expect(stepModel(list, 'a', -1)?.id).toBe('a');
  });

  it('recovers when the current id is no longer in the list (the list changed under the cursor)', () => {
    const list = [available('a'), available('b'), available('c')];
    expect(stepModel(list, 'gone', 1)?.id).toBe('a');
    expect(stepModel(list, 'gone', -1)?.id).toBe('c');
  });
});

describe('edgeModel (A7: Home/End)', () => {
  const available = (id: string): ModelInfo => ({ id, label: id });
  const unavailable = (id: string): ModelInfo => ({ id, label: id, descriptor: { availability: 'unavailable' } } as ModelInfo);

  it('jumps to the first / last row', () => {
    const list = [available('a'), available('b'), available('c')];
    expect(edgeModel(list, 'start')?.id).toBe('a');
    expect(edgeModel(list, 'end')?.id).toBe('c');
  });

  it('skips unavailable edges', () => {
    const list = [unavailable('a'), available('b'), unavailable('c')];
    expect(edgeModel(list, 'start')?.id).toBe('b');
    expect(edgeModel(list, 'end')?.id).toBe('b');
  });

  it('is null for an empty list or an all-unavailable one', () => {
    expect(edgeModel([], 'start')).toBeNull();
    expect(edgeModel([unavailable('a')], 'end')).toBeNull();
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
