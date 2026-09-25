// Pure diffing shared by permissions/permission-code.ts (the approval card's
// diff surface) and conversation/step-syntax.ts (the step-detail input band).
// Behaviour proven indirectly through both call sites too — see
// permission-code.test.ts's `askCodeSurface — Edit` block and
// step-syntax.test.ts's `claudeEditDiffLines` block.

import { describe, expect, it } from 'vitest';
import { diffRows, editHunks, hunkOf, parseInput, str } from './edit-diff';

describe('hunkOf', () => {
  it('trims the common head and tail off a replaced fragment', () => {
    const h = hunkOf('a\nb\nc', 'a\nB\nc');
    expect(h.removed).toEqual(['b']);
    expect(h.added).toEqual(['B']);
    expect(h.context.before).toEqual(['a']);
    expect(h.context.after).toEqual(['c']);
  });

  it('caps the context to two lines on each side', () => {
    const h = hunkOf('1\n2\n3\n4\nx\n5\n6\n7\n8', '1\n2\n3\n4\ny\n5\n6\n7\n8');
    expect(h.context.before).toEqual(['3', '4']);
    expect(h.context.after).toEqual(['5', '6']);
  });

  it('treats an empty side as no lines at all, not one empty line', () => {
    const h = hunkOf('', 'one\ntwo');
    expect(h.removed).toEqual([]);
    expect(h.added).toEqual(['one', 'two']);
  });
});

describe('diffRows', () => {
  it('lays out context, removed then added rows for a single hunk', () => {
    expect(diffRows([hunkOf('a\nb\nc', 'a\nB\nc')])).toEqual([
      { kind: 'context', text: 'a' },
      { kind: 'del', text: 'b' },
      { kind: 'add', text: 'B' },
      { kind: 'context', text: 'c' },
    ]);
  });

  it('elides a change too tall to read and says how much it dropped', () => {
    const next = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
    const rows = diffRows([hunkOf('one', next)]);
    expect(rows).toHaveLength(13); // 12 change rows + the elision
    expect(rows[12]).toEqual({ kind: 'elision', text: '29 more lines' });
  });
});

describe('editHunks', () => {
  it('reads a Write as an all-added file', () => {
    const hunks = editHunks('Write', { content: 'one\ntwo' });
    expect(hunks).toEqual([{ context: { before: [], after: [] }, removed: [], added: ['one', 'two'] }]);
  });

  it('sums every hunk of a MultiEdit', () => {
    const hunks = editHunks('MultiEdit', {
      edits: [
        { old_string: 'a', new_string: 'A' },
        { old_string: 'b\nc', new_string: 'B' },
      ],
    });
    expect(hunks).toHaveLength(2);
  });

  it('is empty when the input carries no change at all', () => {
    expect(editHunks('Edit', {})).toEqual([]);
  });
});

describe('parseInput / str', () => {
  it('parses a JSON object and reads a string field out of it', () => {
    const input = parseInput('{"file_path":"a.ts"}');
    expect(str(input, 'file_path')).toBe('a.ts');
  });

  it('is empty for unparseable or non-object JSON', () => {
    expect(parseInput('not json')).toEqual({});
    expect(parseInput('[1,2]')).toEqual({});
    expect(parseInput('')).toEqual({});
  });
});
