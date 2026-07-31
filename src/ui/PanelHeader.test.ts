import { describe, expect, it } from 'vitest';
import { panelHeaderClassName } from './PanelHeader';

describe('panelHeaderClassName', () => {
  it('adds the focused modifier only when focused', () => {
    expect(panelHeaderClassName(false)).toBe('panel-header');
    expect(panelHeaderClassName(true)).toBe('panel-header panel-header--focused');
  });

  it('adds the clickable modifier when a collapse handler is present (FR-16)', () => {
    expect(panelHeaderClassName(false, true)).toBe('panel-header panel-header--clickable');
    expect(panelHeaderClassName(true, true)).toBe('panel-header panel-header--focused panel-header--clickable');
  });

  it('adds the collapsed modifier when collapsed (FR-15: drops the bottom rule)', () => {
    expect(panelHeaderClassName(false, true, true)).toBe('panel-header panel-header--clickable panel-header--collapsed');
  });
});
