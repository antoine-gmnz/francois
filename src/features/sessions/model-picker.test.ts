// model-picker (multi-provider-openai FR-21) — the pure grouping ModelPicker's
// popover renders, extracted from the component so it is covered by vitest.

import { describe, expect, it } from 'vitest';
import type { ModelInfo } from '../../../contract/common';
import { familyOf, groupByFamily } from './model-picker';

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
