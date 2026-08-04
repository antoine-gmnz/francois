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
