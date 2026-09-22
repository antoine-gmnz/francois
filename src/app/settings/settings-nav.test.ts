import { describe, expect, it } from 'vitest';
import { flagsForPage, isProjectPage, isSettingsOpen, resolveSettingsPage, type SettingsFlags } from './settings-nav';

const f = (projectsOpen: boolean, accountsOpen: boolean): SettingsFlags => ({ projectsOpen, accountsOpen });

describe('isSettingsOpen', () => {
  it('is open while either page flag is set', () => {
    expect(isSettingsOpen(f(false, false))).toBe(false);
    expect(isSettingsOpen(f(true, false))).toBe(true);
    expect(isSettingsOpen(f(false, true))).toBe(true);
  });
});

describe('resolveSettingsPage', () => {
  it('opens on General for the projects flag, on Accounts for the accounts flag', () => {
    expect(resolveSettingsPage(f(false, false), f(true, false), null)).toBe('general');
    expect(resolveSettingsPage(f(false, false), f(false, true), null)).toBe('accounts');
  });

  it('a newly raised flag wins over the page on screen (⌘K → Accounts while on General)', () => {
    expect(resolveSettingsPage(f(true, false), f(true, true), 'general')).toBe('accounts');
    expect(resolveSettingsPage(f(false, true), f(true, true), 'accounts')).toBe('general');
  });

  it('keeps the project sub-page while the projects flag stays up', () => {
    expect(resolveSettingsPage(f(true, false), f(true, false), 'mcp')).toBe('mcp');
  });

  it('closes when both flags drop', () => {
    expect(resolveSettingsPage(f(true, false), f(false, false), 'mcp')).toBeNull();
  });

  it('falls back to the flag that is still up', () => {
    expect(resolveSettingsPage(f(true, true), f(false, true), 'general')).toBe('accounts');
    expect(resolveSettingsPage(f(true, true), f(true, false), 'accounts')).toBe('general');
  });
});

describe('flagsForPage', () => {
  it('sets exactly the flag that owns the page', () => {
    expect(flagsForPage('general')).toEqual(f(true, false));
    expect(flagsForPage('mcp')).toEqual(f(true, false));
    expect(flagsForPage('accounts')).toEqual(f(false, true));
  });
});

describe('the Cohorte page (cohorte-integration FR-80)', () => {
  it('is a project page, owned by the projects flag, kept while that flag stays up', () => {
    expect(isProjectPage('cohorte')).toBe(true);
    expect(flagsForPage('cohorte')).toEqual(f(true, false));
    expect(resolveSettingsPage(f(true, false), f(true, false), 'cohorte')).toBe('cohorte');
  });
});
