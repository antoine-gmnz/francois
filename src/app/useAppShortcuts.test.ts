import { describe, expect, it } from 'vitest';
import { isSessionSettingsShortcut, sessionSettingsShortcutTarget } from './useAppShortcuts';

// useAppShortcuts() itself just wires these two pure decisions to a capture-phase
// `window` listener — there is no DOM/component renderer in this project's test
// setup (vitest, node env, no jsdom, see useDismiss.test.ts), so the predicates
// (the actual decision logic session-settings-sheet FR-19 added) are what gets
// exercised directly here.

describe('isSessionSettingsShortcut', () => {
  it('is true for ⌘, and Ctrl+,', () => {
    expect(isSessionSettingsShortcut({ metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, key: ',' })).toBe(true);
    expect(isSessionSettingsShortcut({ metaKey: false, ctrlKey: true, altKey: false, shiftKey: false, key: ',' })).toBe(true);
  });

  it('is false without a modifier', () => {
    expect(isSessionSettingsShortcut({ metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, key: ',' })).toBe(false);
  });

  it('is false with Alt or Shift held alongside the modifier', () => {
    expect(isSessionSettingsShortcut({ metaKey: true, ctrlKey: false, altKey: true, shiftKey: false, key: ',' })).toBe(false);
    expect(isSessionSettingsShortcut({ metaKey: true, ctrlKey: false, altKey: false, shiftKey: true, key: ',' })).toBe(false);
  });

  it('is false for any other key', () => {
    expect(isSessionSettingsShortcut({ metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, key: 'k' })).toBe(false);
  });
});

describe('sessionSettingsShortcutTarget', () => {
  it('opens the focused session when nothing else owns the keyboard', () => {
    expect(sessionSettingsShortcutTarget(false, false, 's1')).toBe('s1');
  });

  it('is a no-op with no focused session', () => {
    expect(sessionSettingsShortcutTarget(false, false, null)).toBeNull();
  });

  it('is suppressed while a modal owns the keyboard', () => {
    expect(sessionSettingsShortcutTarget(true, false, 's1')).toBeNull();
  });

  it('is suppressed while the palette is open', () => {
    expect(sessionSettingsShortcutTarget(false, true, 's1')).toBeNull();
  });
});
