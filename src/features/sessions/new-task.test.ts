import { describe, expect, it } from 'vitest';
import { advancedSummary, firstPrompt, isStartChord, whereCard } from './new-task';

describe('advancedSummary', () => {
  it('states the values that say something', () => {
    expect(advancedSummary({ accountLabel: 'Work account', profileName: 'api-default', permissionMode: 'acceptEdits' })).toBe(
      'Advanced · Work account · api-default profile · accept edits',
    );
  });
  it('leaves out no profile and the default permission mode', () => {
    expect(advancedSummary({ accountLabel: 'Personal', profileName: null, permissionMode: 'default' })).toBe('Advanced · Personal');
    expect(advancedSummary({ accountLabel: null, profileName: null, permissionMode: 'bypassPermissions' })).toBe('Advanced · bypass');
  });
});

describe('whereCard', () => {
  it('maps the worktree modes onto the two cards, attach onto neither', () => {
    expect(whereCard('off')).toBe('checkout');
    expect(whereCard('create')).toBe('worktree');
    expect(whereCard('attach')).toBeNull();
  });
});

describe('isStartChord', () => {
  it('is ⌘⏎ or Ctrl+⏎, never a bare ⏎ or a composing one', () => {
    expect(isStartChord({ key: 'Enter', metaKey: true, ctrlKey: false })).toBe(true);
    expect(isStartChord({ key: 'Enter', metaKey: false, ctrlKey: true })).toBe(true);
    expect(isStartChord({ key: 'Enter', metaKey: false, ctrlKey: false })).toBe(false);
    expect(isStartChord({ key: 'Enter', metaKey: true, ctrlKey: false, isComposing: true })).toBe(false);
    expect(isStartChord({ key: 'a', metaKey: true, ctrlKey: false })).toBe(false);
  });
});

describe('firstPrompt', () => {
  it('trims, and treats blank as no prompt', () => {
    expect(firstPrompt('  fix the retry  ')).toBe('fix the retry');
    expect(firstPrompt(' \n ')).toBeNull();
  });
});
