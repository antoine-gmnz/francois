// code-editor-workspace: the chords the Code view takes in the capture phase, ahead of
// Monaco — ⌘S / ⌘W / ⌘P on the focused group (code-editor), ⌘\ split (FR-2),
// ⌘⇧M problems (FR-3), ⌘⇧F search (FR-12). Ctrl stands in for ⌘ off macOS.

export type CodeChord = 'save' | 'close' | 'quick-open' | 'split' | 'search' | 'problems';

export function codeChord(e: Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>): CodeChord | null {
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return null;
  const key = e.key.toLowerCase();
  if (e.shiftKey) {
    if (key === 'f') return 'search';
    if (key === 'm') return 'problems';
    return null;
  }
  if (key === 's') return 'save';
  if (key === 'w') return 'close';
  if (key === 'p') return 'quick-open';
  if (key === '\\' || e.code === 'Backslash') return 'split';
  return null;
}
