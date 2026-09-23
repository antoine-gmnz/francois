import { describe, expect, it } from 'vitest';
import { advancedRecap, firstPrompt, isStartChord, whereCard } from './new-task';

describe('advancedRecap', () => {
  const base = {
    accountLabel: 'Personal',
    accountIsDefault: true,
    profileName: null,
    effort: '',
    defaultEffort: 'high',
    showEffort: true,
    runtime: null,
    permissionMode: 'default' as const,
    responseMode: 'default' as const,
    allowGit: false,
    baseRef: null,
  };
  const flat = (items: ReturnType<typeof advancedRecap>) => items.map((i) => `${i.label}=${i.value}${i.changed ? '*' : ''}`).join(' ');

  it('recaps every setting at its default, none marked changed', () => {
    expect(flat(advancedRecap(base))).toBe(
      'Account=Personal Profile=none Effort=default · high Permissions=default Response=default Git=ask',
    );
  });
  it('marks the settings moved off their default', () => {
    const items = advancedRecap({
      ...base,
      accountLabel: 'Work',
      accountIsDefault: false,
      profileName: 'api-default',
      effort: 'max',
      runtime: 'wsl',
      permissionMode: 'acceptEdits',
      responseMode: 'concise',
      allowGit: true,
      baseRef: 'main',
    });
    expect(flat(items)).toBe(
      'Account=Work* Profile=api-default* Effort=max* Runtime=wsl* Permissions=accept edits* Response=concise* Git=auto-approve* Base=main',
    );
  });
  it('leaves out what has no choice: effort without levels, no account', () => {
    expect(flat(advancedRecap({ ...base, accountLabel: null, showEffort: false }))).toBe('Profile=none Permissions=default Response=default Git=ask');
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
