// slash-menu FR-5..FR-10 — pure popup logic: the trigger predicate, palette-
// subsequence filtering, source tags, visibility (incl. dismissal + disabled
// composer), the dismissal hold/clear rules, selection movement with wrap,
// selection preservation across a registry refresh, completion text, and the
// popup key mapping. Pure logic only (no DOM).

import { describe, expect, it } from 'vitest';
import type { SlashCommandInfo } from '../contract/common';
import { filterRank } from './palette';
import {
  completionText,
  filterCommands,
  getSessionCommands,
  moveSelection,
  nextDismissed,
  popupKeyAction,
  popupVisible,
  refreshSelection,
  setSessionCommands,
  slashToken,
  sourceTag,
} from './slash-menu';

const cmd = (name: string, source: SlashCommandInfo['source'] = 'builtin', extra?: Partial<SlashCommandInfo>): SlashCommandInfo => ({
  name,
  description: '',
  source,
  ...extra,
});

const registry: SlashCommandInfo[] = [
  cmd('usage', 'builtin', { description: 'plan limits' }),
  cmd('cost', 'builtin'),
  cmd('model', 'builtin'),
  cmd('status', 'builtin'),
  cmd('help', 'builtin'),
  cmd('deploy', 'skill', { scope: 'project' }),
  cmd('compact', 'cli'),
];

describe('slashToken (FR-5 trigger predicate)', () => {
  it('is eligible for a lone slash and a single slash token', () => {
    expect(slashToken('/')).toBe('');
    expect(slashToken('/mo')).toBe('mo');
    expect(slashToken('/usage')).toBe('usage');
  });

  it('is not eligible for empty, mid-text, or multi-token input', () => {
    expect(slashToken('')).toBeNull();
    expect(slashToken('hello /x')).toBeNull(); // edge 2: never mid-text
    expect(slashToken('/model x')).toBeNull(); // edge 3: token ended
    expect(slashToken('/model ')).toBeNull(); // trailing space ends the token
    expect(slashToken('/mo\nde')).toBeNull(); // newline is whitespace
    expect(slashToken('x/')).toBeNull();
  });
});

describe('filterCommands (FR-6)', () => {
  it('empty token lists the full registry in FR-3 order', () => {
    expect(filterCommands(registry, '').map((c) => c.name)).toEqual([
      'usage',
      'cost',
      'model',
      'status',
      'help',
      'deploy',
      'compact',
    ]);
  });

  it('matches the palette filterRank subsequence semantics exactly', () => {
    for (const token of ['', 'us', 'mo', 'o', 'zzz', 'USAGE']) {
      expect(filterCommands(registry, token)).toEqual(filterRank(registry, token, (c) => c.name));
    }
  });

  it('ranks by first-match position (usage before status for "us")', () => {
    expect(filterCommands(registry, 'us').map((c) => c.name)).toEqual(['usage', 'status']);
  });

  it('returns [] when nothing matches (edge 6: /zzz hides the popup)', () => {
    expect(filterCommands(registry, 'zzz')).toEqual([]);
  });
});

describe('sourceTag (FR-6)', () => {
  it('tags builtin as francois, skills by their scope, cli as cli', () => {
    expect(sourceTag(cmd('usage', 'builtin'))).toBe('francois');
    expect(sourceTag(cmd('deploy', 'skill', { scope: 'project' }))).toBe('project');
    expect(sourceTag(cmd('review', 'skill', { scope: 'user' }))).toBe('user');
    expect(sourceTag(cmd('compact', 'cli'))).toBe('cli');
  });

  it('falls back to "skill" when a skill entry carries no scope', () => {
    expect(sourceTag(cmd('deploy', 'skill'))).toBe('skill');
  });
});

describe('popupVisible (FR-5/9/12)', () => {
  it('renders iff eligible, matching, not dismissed, composer enabled', () => {
    expect(popupVisible({ token: 'us', matchCount: 2, dismissedToken: null, disabled: false })).toBe(true);
    expect(popupVisible({ token: '', matchCount: 7, dismissedToken: null, disabled: false })).toBe(true);
  });

  it('never renders when not eligible or nothing matches', () => {
    expect(popupVisible({ token: null, matchCount: 7, dismissedToken: null, disabled: false })).toBe(false);
    expect(popupVisible({ token: 'zzz', matchCount: 0, dismissedToken: null, disabled: false })).toBe(false);
  });

  it('stays hidden while dismissed at the same token, reopens on a different one', () => {
    expect(popupVisible({ token: 'us', matchCount: 2, dismissedToken: 'us', disabled: false })).toBe(false);
    expect(popupVisible({ token: '', matchCount: 7, dismissedToken: '', disabled: false })).toBe(false);
    expect(popupVisible({ token: 'usa', matchCount: 1, dismissedToken: 'us', disabled: false })).toBe(true);
  });

  it('never renders when the composer is disabled (FR-12)', () => {
    expect(popupVisible({ token: '', matchCount: 7, dismissedToken: null, disabled: true })).toBe(false);
  });
});

describe('nextDismissed (FR-9 dismissal state machine)', () => {
  it('holds while the token stays exactly the dismissed one', () => {
    expect(nextDismissed('us', 'us')).toBe('us');
    expect(nextDismissed('', '')).toBe('');
  });

  it('clears when the token changes (typing/deleting)', () => {
    expect(nextDismissed('us', 'usa')).toBeNull();
    expect(nextDismissed('us', 'u')).toBeNull();
    expect(nextDismissed('us', '')).toBeNull();
  });

  it('clears when the text stops being a slash token (send clears the input)', () => {
    expect(nextDismissed('us', null)).toBeNull();
    expect(nextDismissed('', null)).toBeNull();
  });

  it('stays clear when never dismissed', () => {
    expect(nextDismissed(null, 'us')).toBeNull();
    expect(nextDismissed(null, null)).toBeNull();
  });
});

describe('moveSelection (FR-7 wrap)', () => {
  it('moves down and up within bounds', () => {
    expect(moveSelection(5, 0, 1)).toBe(1);
    expect(moveSelection(5, 3, -1)).toBe(2);
  });

  it('wraps in both directions', () => {
    expect(moveSelection(5, 4, 1)).toBe(0);
    expect(moveSelection(5, 0, -1)).toBe(4);
    expect(moveSelection(1, 0, 1)).toBe(0);
    expect(moveSelection(1, 0, -1)).toBe(0);
  });

  it('is safe on an empty list', () => {
    expect(moveSelection(0, 0, 1)).toBe(0);
    expect(moveSelection(0, 0, -1)).toBe(0);
  });
});

describe('refreshSelection (FR-10 registry refresh)', () => {
  const filtered = [cmd('usage'), cmd('status'), cmd('compact', 'cli')];

  it('keeps the previously selected name when it survives the refresh', () => {
    expect(refreshSelection(filtered, 'status')).toBe(1);
    expect(refreshSelection(filtered, 'compact')).toBe(2);
  });

  it('resets to the first row when the selected name vanished (edge 8)', () => {
    expect(refreshSelection(filtered, 'deploy')).toBe(0);
    expect(refreshSelection(filtered, null)).toBe(0);
    expect(refreshSelection([], 'usage')).toBe(0);
  });
});

describe('completionText (FR-8/11)', () => {
  it('Enter runs the bare /name — byte-identical to typing it', () => {
    expect(completionText('usage', 'run')).toBe('/usage');
  });

  it('Tab completes to /name with one trailing space (token ends, popup closes)', () => {
    expect(completionText('model', 'complete')).toBe('/model ');
    expect(slashToken(completionText('model', 'complete'))).toBeNull();
  });
});

describe('popupKeyAction (FR-8/9)', () => {
  it('maps navigation and action keys while the popup is rendered', () => {
    expect(popupKeyAction('ArrowDown', false)).toBe('down');
    expect(popupKeyAction('ArrowUp', false)).toBe('up');
    expect(popupKeyAction('Enter', false)).toBe('run');
    expect(popupKeyAction('Tab', false)).toBe('complete');
    expect(popupKeyAction('Escape', false)).toBe('dismiss');
  });

  it('lets every other key behave normally (characters keep filtering)', () => {
    expect(popupKeyAction('a', false)).toBeNull();
    expect(popupKeyAction('Backspace', false)).toBeNull();
    expect(popupKeyAction('Enter', true)).toBeNull(); // shift+enter = newline as before
    expect(popupKeyAction('Tab', true)).toBeNull();
  });
});

describe('commandsBySession cache (spec §6, FR-10 / edge 7)', () => {
  it('returns [] for an unseeded session and the stored registry after a set', () => {
    expect(getSessionCommands('s-unseeded')).toEqual([]);
    setSessionCommands('s-1', registry);
    expect(getSessionCommands('s-1')).toEqual(registry);
  });

  it('replaces idempotently on repeated sets (FR-10)', () => {
    setSessionCommands('s-2', registry);
    const next = [cmd('usage'), cmd('clear', 'cli')];
    setSessionCommands('s-2', next);
    setSessionCommands('s-2', next);
    expect(getSessionCommands('s-2')).toEqual(next);
  });
});
