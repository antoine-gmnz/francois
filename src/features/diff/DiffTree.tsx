import { Search } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { DiffFileStatus, DiffFileSummary } from '../../../contract/diff-view';
import { ListRow } from '../../ui/ListRow';
import type { DiffTreeNode, RollupState, VisibleRow } from './diff-tree';

// per-status glyph + color (spec §8 status set) — unchanged from the flat list.
const STATUS: Record<DiffFileStatus, { ch: string; color: string }> = {
  modified: { ch: 'M', color: 'var(--accent)' },
  added: { ch: 'A', color: 'var(--success)' },
  deleted: { ch: 'D', color: 'var(--error)' },
  untracked: { ch: 'U', color: 'var(--hue-blue)' },
  renamed: { ch: 'R', color: 'var(--hue-purple)' },
};

export interface DiffTreeProps {
  visibleRows: VisibleRow[];
  filter: string;
  onFilterChange: (v: string) => void;
  filterInputRef: RefObject<HTMLInputElement>;
  selectedPath: string | null;
  cursorKey: string | null;
  deselected: Set<string>;
  allSelected: boolean;
  selectedCount: number;
  totalFiles: number;
  rollup: (node: DiffTreeNode) => RollupState;
  onSelectPath: (path: string) => void;
  onToggleFile: (path: string) => void;
  onToggleAll: () => void;
  onToggleFold: (key: string) => void;
}

/** diff-navigator: the left column — filter box + collapsible folder tree, replacing
 *  the flat vertical file list (spec §8). */
export function DiffTree({
  visibleRows,
  filter,
  onFilterChange,
  filterInputRef,
  selectedPath,
  cursorKey,
  deselected,
  allSelected,
  selectedCount,
  totalFiles,
  rollup,
  onSelectPath,
  onToggleFile,
  onToggleAll,
  onToggleFold,
}: DiffTreeProps): JSX.Element {
  // FR-19: the cursor auto-scrolls into view on every move, so a filtered-out or
  // long tree never leaves the keyboard cursor invisible above/below the viewport.
  const cursorRowRef = useRef<HTMLDivElement>(null);
  // Design brief §Left column: the `/` keycap hint disappears on focus, not merely
  // once the query is non-empty.
  const [filterFocused, setFilterFocused] = useState(false);
  useEffect(() => {
    cursorRowRef.current?.scrollIntoView({ block: 'nearest' });
  }, [cursorKey]);

  return (
    <div className="scz diff-filelist">
      <div className="diff-filter">
        <Search className="diff-filter__icon" size={12} />
        <input
          ref={filterInputRef}
          className="diff-filter__input"
          value={filter}
          placeholder="filter files…"
          onChange={(e) => onFilterChange(e.target.value)}
          onFocus={() => setFilterFocused(true)}
          onBlur={() => setFilterFocused(false)}
          aria-label="filter files"
        />
        {filter === '' && !filterFocused && <span className="diff-filter__hint">/</span>}
      </div>

      <div onClick={onToggleAll} title={allSelected ? 'deselect all' : 'select all'} className="diff-filelist__header">
        <Checkbox checked={allSelected} indeterminate={selectedCount > 0 && !allSelected} />
        <span>
          {selectedCount} of {totalFiles} selected
        </span>
      </div>

      <div className="diff-tree" role="tree" aria-activedescendant={cursorKey ?? undefined}>
        {visibleRows.length === 0 && filter.trim() !== '' ? (
          <div className="diff-tree__no-match">no file matches &quot;{filter}&quot;</div>
        ) : (
          visibleRows.map((row) => {
            if (row.node.kind === 'folder') {
              const node = row.node;
              const isCursor = row.key === cursorKey;
              return (
                <FolderRow
                  key={row.key}
                  node={node}
                  depth={row.depth}
                  expanded={row.expanded}
                  cursor={isCursor}
                  rollupState={rollup(node)}
                  onToggle={() => onToggleFold(row.key)}
                  rowRef={isCursor ? cursorRowRef : undefined}
                />
              );
            }
            const file = row.node.file;
            const isCursor = row.key === cursorKey;
            return (
              <FileRow
                key={row.key}
                file={file}
                depth={row.depth}
                filter={filter}
                selected={file.path === selectedPath}
                cursor={isCursor}
                checked={!deselected.has(file.path)}
                onClick={() => onSelectPath(file.path)}
                onToggle={() => onToggleFile(file.path)}
                rowRef={isCursor ? cursorRowRef : undefined}
              />
            );
          })
        )}
      </div>
    </div>
  );
}

// A small terminal-styled checkbox: an accent-filled box with a ✓ when checked, a
// hollow box when unchecked, and a dash when indeterminate.
function Checkbox({ checked, indeterminate, dim }: { checked: boolean; indeterminate?: boolean; dim?: boolean }) {
  const on = checked || indeterminate;
  return (
    <span
      className={dim ? 'diff-checkbox diff-checkbox--dim' : 'diff-checkbox'}
      aria-hidden={dim ? true : undefined}
      style={{ border: `1px solid ${on ? 'var(--accent)' : 'var(--text-muted)'}`, background: checked ? 'var(--accent)' : 'transparent' }}
    >
      {checked ? '✓' : indeterminate ? <span className="diff-checkbox-dash" /> : ''}
    </span>
  );
}

function FolderRow({
  node,
  depth,
  expanded,
  cursor,
  rollupState,
  onToggle,
  rowRef,
}: {
  node: Extract<DiffTreeNode, { kind: 'folder' }>;
  depth: number;
  expanded: boolean;
  cursor: boolean;
  rollupState: RollupState;
  onToggle: () => void;
  rowRef?: RefObject<HTMLDivElement>;
}) {
  return (
    <div
      ref={rowRef}
      onClick={onToggle}
      title={node.label}
      role="treeitem"
      aria-expanded={expanded}
      id={node.key}
      className={cursor ? 'diff-tree-row diff-tree-row--folder diff-tree-row--cursor' : 'diff-tree-row diff-tree-row--folder'}
      style={{ paddingLeft: 8 + depth * 12 }}
    >
      <span className="diff-tree-row__caret">{expanded ? '▾' : '▸'}</span>
      <Checkbox checked={rollupState === 'checked'} indeterminate={rollupState === 'mixed'} dim />
      <span className="diff-tree-row__label truncate">{node.label}</span>
    </div>
  );
}

function FileRow({
  file,
  depth,
  filter,
  selected,
  cursor,
  checked,
  onClick,
  onToggle,
  rowRef,
}: {
  file: DiffFileSummary;
  depth: number;
  filter: string;
  selected: boolean;
  cursor: boolean;
  checked: boolean;
  onClick: () => void;
  onToggle: () => void;
  rowRef?: RefObject<HTMLDivElement>;
}) {
  const st = STATUS[file.status] ?? STATUS.modified;
  return (
    <ListRow
      ref={rowRef}
      onClick={onClick}
      title={file.path}
      selected={selected}
      id={file.path}
      role="treeitem"
      className={cursor ? 'diff-file-row diff-tree-row--cursor' : 'diff-file-row'}
      style={{ paddingLeft: 8 + depth * 12 }}
    >
      <span
        onClick={(e) => {
          e.stopPropagation(); // toggle selection without changing which diff is shown
          onToggle();
        }}
        className="diff-checkbox-wrap"
      >
        <Checkbox checked={checked} />
      </span>
      <span className="diff-file-status" style={{ color: st.color }}>
        {st.ch}
      </span>
      <span className="diff-file-name truncate" style={{ color: selected ? 'var(--text-bright)' : 'var(--text)' }}>
        {renderMatch(file.name, filter)}
      </span>
      {file.additions > 0 && <span className="diff-file-stat diff-color-add">+{file.additions}</span>}
      {file.deletions > 0 && <span className="diff-file-stat diff-color-del">−{file.deletions}</span>}
    </ListRow>
  );
}

// FR-8/design §8: emphasize the matched substring within the basename with weight
// only, never colour — the accent slot belongs to the selected row.
function renderMatch(name: string, filter: string) {
  const query = filter.trim().toLowerCase();
  if (!query) return name;
  const idx = name.toLowerCase().indexOf(query);
  if (idx === -1) return name;
  return (
    <>
      {name.slice(0, idx)}
      <span className="diff-file-name__match">{name.slice(idx, idx + query.length)}</span>
      {name.slice(idx + query.length)}
    </>
  );
}
