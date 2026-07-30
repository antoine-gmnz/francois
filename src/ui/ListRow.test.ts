import { describe, expect, it } from 'vitest';
import { listRowClassName } from './ListRow';

describe('listRowClassName', () => {
  it('is just the base class when neither selected nor hovered', () => {
    expect(listRowClassName(false, false)).toBe('list-row');
  });

  it('selected wins over hovered', () => {
    expect(listRowClassName(true, true)).toBe('list-row list-row--selected');
  });

  it('falls back to hovered when not selected', () => {
    expect(listRowClassName(false, true)).toBe('list-row list-row--hovered');
  });

  it('appends an extra className last', () => {
    expect(listRowClassName(true, false, 'agent-card')).toBe('list-row list-row--selected agent-card');
    expect(listRowClassName(false, false, 'agent-card')).toBe('list-row agent-card');
  });
});
