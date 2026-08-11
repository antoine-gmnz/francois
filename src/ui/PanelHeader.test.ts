import { describe, expect, it } from 'vitest';
import { panelHeaderClassName } from './PanelHeader';

describe('panelHeaderClassName', () => {
  it('adds the focused modifier only when focused', () => {
    expect(panelHeaderClassName(false)).toBe('panel-header');
    expect(panelHeaderClassName(true)).toBe('panel-header panel-header--focused');
  });
});
