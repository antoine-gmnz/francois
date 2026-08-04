import { describe, expect, it } from 'vitest';
import type { ShellInfo } from '../../../contract/shell-terminal';
import {
  SHELL_CAP,
  atShellCap,
  cycleShellId,
  neighborAfterClose,
  shellShortcutFor,
  stripVisible,
  truncateShellLabel,
} from './shell';

function shell(id: string, name = id): ShellInfo {
  return { id, sessionId: 's1', name, shellName: 'zsh', cwd: '/tmp', alive: true };
}

describe('atShellCap', () => {
  it('is false below the cap and true at/over it (FR-2)', () => {
    expect(atShellCap([])).toBe(false);
    expect(atShellCap(Array.from({ length: SHELL_CAP - 1 }, (_, i) => shell(String(i))))).toBe(false);
    expect(atShellCap(Array.from({ length: SHELL_CAP }, (_, i) => shell(String(i))))).toBe(true);
  });
});

describe('stripVisible', () => {
  it('hides at 0 or 1 shells, shows past that (FR-11)', () => {
    expect(stripVisible([])).toBe(false);
    expect(stripVisible([shell('a')])).toBe(false);
    expect(stripVisible([shell('a'), shell('b')])).toBe(true);
  });
});

describe('truncateShellLabel', () => {
  it('leaves short names alone', () => {
    expect(truncateShellLabel('zsh 1')).toBe('zsh 1');
  });
  it('truncates past 18 chars with an ellipsis', () => {
    const long = 'a-very-long-custom-shell-name';
    const out = truncateShellLabel(long);
    expect(out.length).toBe(18);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('neighborAfterClose', () => {
  const shells = [shell('a'), shell('b'), shell('c')];

  it('activates the neighbor to the right', () => {
    expect(neighborAfterClose(shells, 'a')).toBe('b');
  });
  it('falls back to the left when closing the last one', () => {
    expect(neighborAfterClose(shells, 'c')).toBe('b');
  });
  it('returns null when closing the only shell (empty state, FR-23)', () => {
    expect(neighborAfterClose([shell('a')], 'a')).toBe(null);
  });
  it('returns null for an unknown id', () => {
    expect(neighborAfterClose(shells, 'zzz')).toBe(null);
  });
});

describe('cycleShellId', () => {
  const shells = [shell('a'), shell('b'), shell('c')];

  it('moves forward, wrapping past the end', () => {
    expect(cycleShellId(shells, 'a', 1)).toBe('b');
    expect(cycleShellId(shells, 'c', 1)).toBe('a');
  });
  it('moves backward, wrapping past the start', () => {
    expect(cycleShellId(shells, 'b', -1)).toBe('a');
    expect(cycleShellId(shells, 'a', -1)).toBe('c');
  });
  it('returns null with fewer than 2 shells', () => {
    expect(cycleShellId([], null, 1)).toBe(null);
    expect(cycleShellId([shell('a')], 'a', 1)).toBe(null);
  });
  it('falls back to the first shell for an unknown/null active id', () => {
    expect(cycleShellId(shells, null, 1)).toBe('a');
    expect(cycleShellId(shells, 'zzz', 1)).toBe('a');
  });
});

describe('shellShortcutFor', () => {
  it('recognizes ⌘T (mac) and Ctrl+Shift+T (win/linux) as new', () => {
    expect(shellShortcutFor('t', true, false, false)).toBe('new');
    expect(shellShortcutFor('T', false, true, true)).toBe('new');
  });
  it('recognizes ⌘W / Ctrl+Shift+W as close', () => {
    expect(shellShortcutFor('w', true, false, false)).toBe('close');
    expect(shellShortcutFor('W', false, true, true)).toBe('close');
  });
  it('recognizes Ctrl+Tab / Ctrl+Shift+Tab as next/prev', () => {
    expect(shellShortcutFor('Tab', false, true, false)).toBe('next');
    expect(shellShortcutFor('Tab', false, true, true)).toBe('prev');
  });
  it('rejects a bare Cmd+Tab (no ctrl) and a bare ctrl+t (no shift)', () => {
    expect(shellShortcutFor('Tab', true, false, false)).toBe(null);
    expect(shellShortcutFor('t', false, true, false)).toBe(null);
  });
  it('is null for anything else', () => {
    expect(shellShortcutFor('a', true, false, false)).toBe(null);
    expect(shellShortcutFor('k', true, false, false)).toBe(null);
  });
});
