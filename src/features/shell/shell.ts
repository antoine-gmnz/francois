// multiple-shells — pure logic for the SHELL tab's sub-tab strip: the 6-shell
// cap, the strip's visibility rule, the close/cycle neighbor selection, the
// chip label truncation, and the three PTY carve-out combos (FR-19/20/21).
// Kept framework-free so it is unit-testable without xterm.js or the DOM
// (vite.config.ts runs the frontend suite under `environment: 'node'`).

import type { ShellId, ShellInfo } from '../../../contract/shell-terminal';

/** FR-2: a session holds at most this many shells. */
export const SHELL_CAP = 6;

export function atShellCap(shells: readonly ShellInfo[]): boolean {
  return shells.length >= SHELL_CAP;
}

/** FR-11 / §8: the strip renders only once a session has more than one shell
 * — a single-shell session must stay pixel-identical to today's SHELL tab. */
export function stripVisible(shells: readonly ShellInfo[]): boolean {
  return shells.length > 1;
}

/** §8 chip label: truncated to ~18 chars with an ellipsis; full name lives in `title`. */
export function truncateShellLabel(name: string, max = 18): string {
  return name.length > max ? `${name.slice(0, max - 1)}…` : name;
}

/**
 * FR-19/§7: which shell becomes active after closing `closedId` — the
 * neighbor to its right, else its left, else null (empty state, FR-23).
 * `shells` is the roster BEFORE removal (closedId still present).
 */
export function neighborAfterClose(shells: readonly ShellInfo[], closedId: ShellId): ShellId | null {
  const i = shells.findIndex((s) => s.id === closedId);
  if (i < 0) return null;
  if (shells.length === 1) return null;
  const right = shells[i + 1];
  if (right) return right.id;
  const left = shells[i - 1];
  return left ? left.id : null;
}

/** FR-19: `⌃⇥` / `⌃⇧⇥` — cycle to the next/previous chip, wrapping. Returns
 * null when there is nothing to cycle to (0 or 1 shells, or an unknown active id). */
export function cycleShellId(shells: readonly ShellInfo[], activeId: ShellId | null, dir: 1 | -1): ShellId | null {
  if (shells.length < 2) return null;
  const i = activeId ? shells.findIndex((s) => s.id === activeId) : -1;
  if (i < 0) return shells[0].id;
  const next = (i + dir + shells.length) % shells.length;
  return shells[next].id;
}

export type ShellShortcut = 'new' | 'close' | 'next' | 'prev';

/**
 * FR-19: `⌘T`/`Ctrl+Shift+T` (new), `⌘W`/`Ctrl+Shift+W` (close),
 * `⌃⇥`/`⌃⇧⇥` (cycle) — the three PTY carve-outs (FR-20/FR-21). Pure over
 * primitive booleans so it is testable without constructing real KeyboardEvents.
 */
export function shellShortcutFor(key: string, meta: boolean, ctrl: boolean, shift: boolean): ShellShortcut | null {
  const lower = key.length === 1 ? key.toLowerCase() : key;
  const mac = meta && !ctrl && !shift;
  const win = ctrl && shift && !meta;
  if (lower === 't' && (mac || win)) return 'new';
  if (lower === 'w' && (mac || win)) return 'close';
  if (key === 'Tab' && ctrl && !meta) return shift ? 'prev' : 'next';
  return null;
}

/**
 * The byte a plain `Ctrl+<key>` puts on the PTY's stdin — `⌃C` → `ETX`, `⌃L` →
 * `FF`, and the rest. A verbatim mirror of xterm.js's own table
 * (`evaluateKeyboardEvent`'s `default:` branch, `common/input/Keyboard.ts`),
 * keyed on the same legacy `keyCode` so a non-US layout maps identically.
 *
 * Why we re-derive it rather than let xterm send it (the `⌃C interrupt` bug):
 * xterm 5.5 arms a private `_unprocessedDeadKey` flag on EVERY `Dead` or
 * `AltGraph` keydown, and only clears it on a later keydown that reaches the
 * end of `_keyDown`. Two paths return before that — a third-level shift (on
 * Windows, `ctrl+alt`, i.e. every AltGr character: `@ [ ] { } \ | ~ #` on an
 * AZERTY layout) and a bare capital letter — so the flag survives the very
 * keypress that was supposed to consume it and then stays armed through
 * ordinary typing, since an unmodified letter exits earlier still (`!result.key`).
 * The next key that DOES reach the check is swallowed. Plain characters and `⏎`
 * survive that regardless (the browser's `keypress` still delivers them), but a
 * Ctrl combo cannot: xterm's `_keyPress` refuses anything carrying `ctrlKey`.
 * Net effect: type one AltGr character, and the next `⌃C` does nothing — only
 * the second press interrupts. Forwarding the combo ourselves takes the
 * interrupt out of that state machine entirely.
 *
 * Modified combos are NOT ours: `⌃⇧…` and `⌃⌥…` return null and fall through to
 * xterm unchanged, as do the carve-outs the caller checks first (`⌃K`, `⌃⇥`).
 */
export function controlCharFor(keyCode: number, ctrl: boolean, shift: boolean, alt: boolean, meta: boolean): string | null {
  if (!ctrl || shift || alt || meta) return null;
  if (keyCode >= 65 && keyCode <= 90) return String.fromCharCode(keyCode - 64); // ⌃A–⌃Z
  if (keyCode === 32) return '\x00'; // ⌃Space → NUL
  if (keyCode >= 51 && keyCode <= 55) return String.fromCharCode(keyCode - 51 + 27); // ⌃3–⌃7 → ESC, FS, GS, RS, US
  if (keyCode === 56) return '\x7f'; // ⌃8 → DEL
  if (keyCode === 219) return '\x1b'; // ⌃[ → ESC
  if (keyCode === 220) return '\x1c'; // ⌃\ → FS
  if (keyCode === 221) return '\x1d'; // ⌃] → GS
  return null;
}
