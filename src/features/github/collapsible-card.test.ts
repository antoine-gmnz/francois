import { describe, expect, it } from 'vitest';
import { parseCollapsedSections, toggleCollapsedSection } from './collapsible-card';

describe('parseCollapsedSections', () => {
  it('defaults to open (empty record) when nothing is stored', () => {
    expect(parseCollapsedSections(null)).toEqual({});
  });

  it('defaults to open on malformed JSON', () => {
    expect(parseCollapsedSections('{not json')).toEqual({});
  });

  it('defaults to open on a non-object value', () => {
    expect(parseCollapsedSections('42')).toEqual({});
    expect(parseCollapsedSections('["description"]')).toEqual({});
    expect(parseCollapsedSections('null')).toEqual({});
  });

  it('keeps only true entries', () => {
    expect(parseCollapsedSections('{"description":true,"checks":false,"files":"yes"}')).toEqual({ description: true });
  });
});

describe('toggleCollapsedSection', () => {
  it('collapses an open (absent) section', () => {
    expect(toggleCollapsedSection({}, 'description')).toEqual({ description: true });
  });

  it('opens a collapsed section by omitting it, not storing false', () => {
    expect(toggleCollapsedSection({ description: true }, 'description')).toEqual({});
  });

  it('leaves other sections untouched', () => {
    expect(toggleCollapsedSection({ checks: true }, 'description')).toEqual({ checks: true, description: true });
  });
});
