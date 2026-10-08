// The app's single-key shortcut guard (code-editor FR-14). Pure, so it is unit-
// testable without a DOM: an element is read through the three members it needs.
// Regression this prevents: typing `o` in the editor jumped to Overview.

import type { MainTab } from '../lib/store';

export interface KeyTargetLike {
  tagName: string;
  isContentEditable?: boolean;
  closest(selector: string): unknown;
}

export type KeyLike = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey'>;

/** Where a keystroke is text, not a command: form fields, contenteditable, the terminal. */
export function isTypingTarget(el: KeyTargetLike | null): boolean {
  if (!el) return false;
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
  if (el.isContentEditable) return true;
  return el.closest('.xterm') !== null;
}

/** A single printable key (letters, digits, `[`/`]`, `?`, …) with no modifier chord held. Shift is allowed. */
export function isSingleKey(e: KeyLike): boolean {
  return !e.metaKey && !e.ctrlKey && !e.altKey && e.key.length === 1;
}

/**
 * FR-14: true when an app-level single-key shortcut must NOT fire — always while the
 * Code tab is active or focus is anywhere inside the Code view (editor, tree, picker),
 * and in any typing target elsewhere. Modifier chords are never suppressed here.
 */
export function suppressSingleKeyShortcut(e: KeyLike, ctx: { mainTab: MainTab; target: KeyTargetLike | null }): boolean {
  if (!isSingleKey(e)) return false;
  if (ctx.mainTab === 'code') return true;
  if (ctx.target?.closest('.code-view')) return true;
  return isTypingTarget(ctx.target);
}
