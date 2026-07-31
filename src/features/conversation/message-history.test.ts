import { describe, expect, it } from 'vitest';
import {
  appendEntry,
  atFirstLine,
  atLastLine,
  getHistory,
  isSlashEntry,
  recallNext,
  recallPrev,
  recordSent,
  type Browse,
} from './message-history';

// message-history (spec specs/message-history.md §5). Pure half only — the
// module map is exercised through getHistory/recordSent with a unique session
// id per test, since the map is module-scoped by design (FR-11).

describe('isSlashEntry (FR-1a)', () => {
  it('is true when the first non-whitespace char is /', () => {
    expect(isSlashEntry('/clear')).toBe(true);
    expect(isSlashEntry('/review the diff')).toBe(true);
    expect(isSlashEntry('   /clear')).toBe(true);
    expect(isSlashEntry('\n\t/compact')).toBe(true);
  });

  it('is false for ordinary prompts and for a slash that is not first', () => {
    expect(isSlashEntry('run the tests')).toBe(false);
    expect(isSlashEntry('cd src/features')).toBe(false);
    expect(isSlashEntry('what about a/b?')).toBe(false);
    expect(isSlashEntry('')).toBe(false);
    expect(isSlashEntry('   ')).toBe(false);
  });
});

describe('appendEntry (FR-1/1a/1c/1d)', () => {
  it('appends a new entry as the newest (oldest first)', () => {
    expect(appendEntry([], 'one')).toEqual(['one']);
    expect(appendEntry(['one'], 'two')).toEqual(['one', 'two']);
  });

  it('does not record slash commands (FR-1a)', () => {
    const h = ['one'];
    expect(appendEntry(h, '/clear')).toEqual(['one']);
    expect(appendEntry(h, '  /review')).toEqual(['one']);
    expect(appendEntry([], '/clear')).toEqual([]);
  });

  it('collapses a consecutive duplicate of the newest entry (FR-1c)', () => {
    expect(appendEntry(['one'], 'one')).toEqual(['one']);
    expect(appendEntry(['one', 'two'], 'two')).toEqual(['one', 'two']);
  });

  it('keeps non-consecutive duplicates (FR-1c)', () => {
    expect(appendEntry(['one', 'two'], 'one')).toEqual(['one', 'two', 'one']);
  });

  it('caps at 100 entries, dropping the oldest (FR-1d)', () => {
    const full = Array.from({ length: 100 }, (_, i) => `m${i}`);
    const next = appendEntry(full, 'm100');
    expect(next).toHaveLength(100);
    expect(next[0]).toBe('m1');
    expect(next[99]).toBe('m100');
  });

  it('does not mutate the history it is given', () => {
    const h = ['one'];
    appendEntry(h, 'two');
    expect(h).toEqual(['one']);
  });

  it('distinguishes texts differing only in whitespace', () => {
    expect(appendEntry(['one'], 'one ')).toEqual(['one', 'one ']);
  });
});

describe('atFirstLine (FR-2)', () => {
  it('is true when nothing is selected and no newline precedes the caret', () => {
    expect(atFirstLine('', 0, 0)).toBe(true);
    expect(atFirstLine('hello', 0, 0)).toBe(true);
    expect(atFirstLine('hello', 5, 5)).toBe(true);
    expect(atFirstLine('line1\nline2', 3, 3)).toBe(true);
    expect(atFirstLine('line1\nline2', 5, 5)).toBe(true); // caret before the \n
  });

  it('is false once the caret sits after a newline', () => {
    expect(atFirstLine('line1\nline2', 6, 6)).toBe(false);
    expect(atFirstLine('a\nb\nc', 4, 4)).toBe(false);
  });

  it('is false while a selection is active', () => {
    expect(atFirstLine('hello', 0, 5)).toBe(false);
    expect(atFirstLine('hello', 1, 2)).toBe(false);
  });
});

describe('atLastLine (FR-5)', () => {
  it('is true when nothing is selected and no newline follows the caret', () => {
    expect(atLastLine('', 0, 0)).toBe(true);
    expect(atLastLine('hello', 0, 0)).toBe(true);
    expect(atLastLine('hello', 5, 5)).toBe(true);
    expect(atLastLine('line1\nline2', 6, 6)).toBe(true);
    expect(atLastLine('line1\nline2', 11, 11)).toBe(true);
  });

  it('is false while a newline follows the caret', () => {
    expect(atLastLine('line1\nline2', 5, 5)).toBe(false);
    expect(atLastLine('line1\nline2', 0, 0)).toBe(false);
  });

  it('is false while a selection is active', () => {
    expect(atLastLine('hello', 0, 5)).toBe(false);
    expect(atLastLine('line1\nline2', 6, 8)).toBe(false);
  });
});

describe('recallPrev (FR-3/FR-4)', () => {
  it('returns null on an empty history so the caller falls through', () => {
    expect(recallPrev([], null, '')).toBeNull();
    expect(recallPrev([], null, 'draft')).toBeNull();
  });

  it('enters browsing on the newest entry and saves the draft (FR-3)', () => {
    const res = recallPrev(['one', 'two'], null, 'half typed ');
    expect(res).toEqual({ browse: { index: 1, draft: 'half typed ' }, text: 'two', changed: true });
  });

  it('saves an empty draft when the composer was empty (FR-3)', () => {
    expect(recallPrev(['one'], null, '')).toEqual({
      browse: { index: 0, draft: '' },
      text: 'one',
      changed: true,
    });
  });

  it('steps one entry older while browsing, keeping the draft (FR-4)', () => {
    const browse: Browse = { index: 2, draft: 'd' };
    expect(recallPrev(['a', 'b', 'c'], browse, 'c')).toEqual({
      browse: { index: 1, draft: 'd' },
      text: 'b',
      changed: true,
    });
  });

  it('stays on the oldest entry without wrapping, and reports no change (FR-4)', () => {
    const browse: Browse = { index: 0, draft: 'd' };
    const res = recallPrev(['a', 'b'], browse, 'a');
    expect(res).toEqual({ browse: { index: 0, draft: 'd' }, text: 'a', changed: false });
  });

  it('does not overwrite the saved draft with the recalled text on later steps', () => {
    const first = recallPrev(['a', 'b'], null, 'mine');
    expect(first).not.toBeNull();
    const second = recallPrev(['a', 'b'], first!.browse, first!.text);
    expect(second!.browse.draft).toBe('mine');
  });

  it('does not mutate the browse state it is given', () => {
    const browse: Browse = { index: 2, draft: 'd' };
    recallPrev(['a', 'b', 'c'], browse, 'c');
    expect(browse).toEqual({ index: 2, draft: 'd' });
  });
});

describe('recallPrev — changed flag lets the caller leave the caret alone (FR-4)', () => {
  it('reports changed:true on the step that reaches the oldest entry', () => {
    const first = recallPrev(['only'], null, 'draft')!;
    expect(first).toEqual({ browse: { index: 0, draft: 'draft' }, text: 'only', changed: true });
  });

  it('reports changed:false on a repeated ArrowUp once already at the oldest entry — the caller must not move the caret', () => {
    // Simulates the user pressing ArrowUp once (reaching the oldest entry),
    // repositioning the caret inside the recalled text, then pressing ArrowUp
    // again: the second step must signal "no-op" so a caller (ConversationView)
    // knows not to touch the caret/selection at all.
    const atOldest = recallPrev(['only'], null, 'draft')!;
    expect(atOldest.changed).toBe(true);
    const repeated = recallPrev(['only'], atOldest.browse, atOldest.text)!;
    expect(repeated).toEqual({ browse: { index: 0, draft: 'draft' }, text: 'only', changed: false });
  });
});

describe('recallNext (FR-6)', () => {
  it('returns null when not browsing so the caller falls through', () => {
    expect(recallNext(['a', 'b'], null)).toBeNull();
    expect(recallNext([], null)).toBeNull();
  });

  it('steps one entry newer while browsing', () => {
    expect(recallNext(['a', 'b', 'c'], { index: 0, draft: 'd' })).toEqual({
      browse: { index: 1, draft: 'd' },
      text: 'b',
    });
  });

  it('exits browsing and restores the draft past the newest entry (FR-6)', () => {
    expect(recallNext(['a', 'b'], { index: 1, draft: 'half typed ' })).toEqual({
      browse: null,
      text: 'half typed ',
    });
  });

  it('restores an empty draft as the empty string (§7)', () => {
    expect(recallNext(['a'], { index: 0, draft: '' })).toEqual({ browse: null, text: '' });
  });

  it('does not mutate the browse state it is given', () => {
    const browse: Browse = { index: 0, draft: 'd' };
    recallNext(['a', 'b'], browse);
    expect(browse).toEqual({ index: 0, draft: 'd' });
  });
});

describe('a full walk (§3 flows)', () => {
  it('recalls, walks back, and comes home to the draft', () => {
    const history = ['first', 'second', 'third'];
    let browse: Browse | null = null;
    let text = 'what about the ';

    const up = () => {
      const r = recallPrev(history, browse, text);
      expect(r).not.toBeNull();
      browse = r!.browse;
      text = r!.text;
    };
    const down = () => {
      const r = recallNext(history, browse);
      expect(r).not.toBeNull();
      browse = r!.browse;
      text = r!.text;
    };

    up();
    expect(text).toBe('third');
    up();
    expect(text).toBe('second');
    up();
    expect(text).toBe('first');
    up(); // oldest — swallowed, no wrap
    expect(text).toBe('first');
    down();
    expect(text).toBe('second');
    down();
    expect(text).toBe('third');
    down();
    expect(text).toBe('what about the ');
    expect(browse).toBeNull();
  });

  it('an edit mid-walk starts a fresh walk whose draft is the edited text (FR-8)', () => {
    const history = ['first', 'second'];
    const started = recallPrev(history, null, '')!;
    expect(started.text).toBe('second');
    // FR-8: the caller drops browse on any edit; the edited text is the live draft.
    const edited = 'second, but different';
    const fresh = recallPrev(history, null, edited)!;
    expect(fresh.browse).toEqual({ index: 1, draft: edited });
    expect(recallNext(history, fresh.browse)).toEqual({ browse: null, text: edited });
  });
});

describe('the per-session store (FR-10/FR-11)', () => {
  it('starts empty for an unknown session', () => {
    expect(getHistory('sess-unknown')).toEqual([]);
  });

  it('records sent messages newest-last, per session', () => {
    recordSent('sess-a', 'one');
    recordSent('sess-a', 'two');
    recordSent('sess-b', 'other');
    expect(getHistory('sess-a')).toEqual(['one', 'two']);
    expect(getHistory('sess-b')).toEqual(['other']);
  });

  it('applies the appendEntry rules on record (FR-1a/1c/1d)', () => {
    recordSent('sess-c', 'one');
    recordSent('sess-c', 'one');
    recordSent('sess-c', '/clear');
    recordSent('sess-c', 'two');
    expect(getHistory('sess-c')).toEqual(['one', 'two']);
  });

  it('survives being read again — the map is module-scoped (FR-11)', () => {
    recordSent('sess-d', 'kept');
    expect(getHistory('sess-d')).toEqual(['kept']);
    expect(getHistory('sess-d')).toEqual(['kept']);
  });

  it('never hands out a mutable view of the stored history', () => {
    recordSent('sess-e', 'one');
    const h = getHistory('sess-e') as string[];
    expect(() => h.push('sneaky')).toThrow();
    expect(getHistory('sess-e')).toEqual(['one']);
  });
});
