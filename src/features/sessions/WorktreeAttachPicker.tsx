// WorktreeAttachPicker — attach-to-worktree §8 "Picker": the scrollable list of
// a repo's linked worktrees that replaces the branch/base-ref/preview block
// while the WORKTREE group is in `attach` mode. Layout only — every row comes
// pre-computed from `worktreeRows` (worktree.ts); this component owns
// selection interaction (click + keyboard) and the two lines below the list
// (FR-10 caution, FR-13 resolved cwd).

import type { KeyboardEvent } from 'react';
import { ListRow } from '../../ui/ListRow';
import type { WorktreeRow } from './worktree';
import './session-settings-sheet.css';

export interface WorktreeAttachPickerProps {
  rows: WorktreeRow[];
  selectedPath: string | null;
  onSelect: (path: string | null) => void;
}

export function WorktreeAttachPicker({ rows, selectedPath, onSelect }: WorktreeAttachPickerProps): JSX.Element {
  const selectedRow = rows.find((r) => r.path === selectedPath) ?? null;

  // Keyboard nav: ↑/↓ move focus to the next/previous non-disabled row,
  // wrapping; Enter selects the focused row. Disabled rows are skipped, never
  // focused. Mirrors useRowCursorClamp's behaviour in the sidebar list.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Enter') return;
    const container = e.currentTarget;
    const items = Array.from(container.querySelectorAll<HTMLElement>('[data-worktree-row]'));
    const activeIndex = items.findIndex((el) => el === document.activeElement);
    if (e.key === 'Enter') {
      if (activeIndex < 0) return;
      const idx = Number(items[activeIndex].dataset.worktreeRow);
      const row = rows[idx];
      if (row && !row.disabled) onSelect(row.path);
      return;
    }
    e.preventDefault();
    if (items.length === 0) return;
    const dir = e.key === 'ArrowDown' ? 1 : -1;
    let idx = activeIndex;
    for (let step = 0; step < items.length; step++) {
      idx = (idx + dir + items.length) % items.length;
      const rowIdx = Number(items[idx].dataset.worktreeRow);
      if (!rows[rowIdx]?.disabled) {
        items[idx].focus();
        break;
      }
    }
  };

  return (
    <div className="worktree-field">
      <div className="worktree-field__picker scz" role="listbox" aria-label="linked worktrees" onKeyDown={onKeyDown}>
        {rows.map((row, i) => (
          <ListRow
            key={row.path}
            data-worktree-row={i}
            tabIndex={row.disabled ? -1 : 0}
            role="option"
            aria-selected={row.path === selectedPath}
            aria-disabled={row.disabled}
            selected={row.path === selectedPath}
            className={`worktree-field__row${row.disabled ? ' is-disabled' : ''}`}
            onClick={() => !row.disabled && onSelect(row.path)}
          >
            <div className="worktree-field__row-line1">
              <span className="worktree-field__row-label">{row.label}</span>
              {row.note && <span className="worktree-field__row-note">{row.note}</span>}
            </div>
            <div className="worktree-field__preview worktree-field__row-path" title={row.path}>
              {row.path}
            </div>
          </ListRow>
        ))}
      </div>

      {/* FR-10: a warning, not a gate — the row stays selected and Create stays enabled. */}
      {selectedRow?.inUseBy && (
        <div className="worktree-field__caution">two sessions in one worktree share a checkout — their DIFF and commits will mix</div>
      )}

      {/* FR-13: what the DIRECTORY field above (the source repo) does not answer. */}
      {selectedRow && (
        <div className="worktree-field__preview worktree-field__resolved-cwd" title={selectedRow.path}>
          {selectedRow.path}
        </div>
      )}
    </div>
  );
}
