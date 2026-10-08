// code-editor FR-14: the app-level single-key shortcut guard.
import { describe, expect, it } from 'vitest';
import { isSingleKey, isTypingTarget, suppressSingleKeyShortcut, type KeyTargetLike } from './shortcut-guard';

function el(tagName: string, opts: { editable?: boolean; inside?: string[] } = {}): KeyTargetLike {
  return {
    tagName,
    isContentEditable: opts.editable ?? false,
    closest: (sel: string) => (sel.split(',').some((s) => opts.inside?.includes(s.trim())) ? {} : null),
  };
}
const key = (k: string, mods: Partial<Record<'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey', boolean>> = {}) => ({
  key: k,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe('isTypingTarget', () => {
  it('counts inputs, textareas and selects', () => {
    for (const t of ['INPUT', 'TEXTAREA', 'SELECT']) expect(isTypingTarget(el(t))).toBe(true);
  });
  it('counts contenteditable elements (FR-14)', () => {
    expect(isTypingTarget(el('DIV', { editable: true }))).toBe(true);
  });
  it('counts the terminal', () => {
    expect(isTypingTarget(el('DIV', { inside: ['.xterm'] }))).toBe(true);
  });
  it('does not count a plain button or nothing', () => {
    expect(isTypingTarget(el('BUTTON'))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe('isSingleKey', () => {
  it('is letters, digits, [ ] ? — shifted or not — without a modifier', () => {
    for (const k of ['o', 'O', '1', '[', ']', '?']) expect(isSingleKey(key(k, { shiftKey: k === 'O' || k === '?' }))).toBe(true);
  });
  it('is never a modifier chord or a named key', () => {
    expect(isSingleKey(key('k', { metaKey: true }))).toBe(false);
    expect(isSingleKey(key('s', { ctrlKey: true }))).toBe(false);
    expect(isSingleKey(key('p', { altKey: true }))).toBe(false);
    expect(isSingleKey(key('Escape'))).toBe(false);
    expect(isSingleKey(key('ArrowDown'))).toBe(false);
  });
});

describe('suppressSingleKeyShortcut (FR-14)', () => {
  it('suppresses every single key while the Code tab is active, wherever focus is', () => {
    for (const k of ['o', 'd', 't', 'n', '1', '2', '[', ']', '?']) {
      expect(suppressSingleKeyShortcut(key(k), { mainTab: 'code', target: el('BODY') }), k).toBe(true);
    }
  });
  it('suppresses a single key typed anywhere inside the Code view', () => {
    expect(suppressSingleKeyShortcut(key('o'), { mainTab: 'session', target: el('DIV', { inside: ['.code-view'] }) })).toBe(true);
  });
  it('suppresses in a typing target outside the Code view, as before', () => {
    expect(suppressSingleKeyShortcut(key('o'), { mainTab: 'session', target: el('TEXTAREA') })).toBe(true);
    expect(suppressSingleKeyShortcut(key('o'), { mainTab: 'session', target: el('DIV', { editable: true }) })).toBe(true);
  });
  it('lets modifier chords through in the Code tab (⌘K, ⌘P, ⌘S, ⌘W)', () => {
    for (const k of ['k', 'p', 's', 'w']) expect(suppressSingleKeyShortcut(key(k, { metaKey: true }), { mainTab: 'code', target: el('TEXTAREA') })).toBe(false);
  });
  it('lets a single key through elsewhere', () => {
    expect(suppressSingleKeyShortcut(key('o'), { mainTab: 'session', target: el('BODY') })).toBe(false);
  });
});
