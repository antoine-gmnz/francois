import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { DiffFileSummary } from '../../../contract/diff-view';
import { Icon } from '../../ui/Icon';
import { ListRow } from '../../ui/ListRow';
import type { DiffTreeNode, RollupState, VisibleRow } from './diff-tree';
import { FILE_STATUS } from './file-status';
import { isReviewed } from './review-state';

// Figma "File tree" (135:5177): folders at a 10px inset, each depth 16px deeper,
// so a file under a top-level folder starts at 26px like the design.
const INDENT_BASE = 10;
const INDENT_STEP = 16;
const indent = (depth: number) => ({ paddingLeft: INDENT_BASE + depth * INDENT_STEP });

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
  reviewMarks: readonly string[];
  onSelectPath: (path: string) => void;
  onToggleFile: (path: string) => void;
  onToggleAll: () => void;
  onToggleFold: (key: string) => void;
}

/** diff-navigator: the left column — filter box + collapsible folder tree. Each
 *  file carries its status letter, a ✓ once reviewed, and (on hover, or while
 *  left out) the checkbox that decides whether `Commit…` includes it. */
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
  reviewMarks,
  onSelectPath,
  onToggleFile,
  onToggleAll,
  onToggleFold,
}: DiffTreeProps): JSX.Element {
  // FR-19: the cursor auto-scrolls into view on every move, so a filtered-out or
  // long tree never leaves the keyboard cursor invisible above/below the viewport.
  const cursorRowRef = useRef<HTMLDivElement>(null);
  // The `/` keycap hint disappears on focus, not merely once the query is non-empty.
  const [filterFocused, setFilterFocused] = useState(false);
  useEffect(() => {
    cursorRowRef.current?.scrollIntoView({ block: 'nearest' });
  }, [cursorKey]);

  return (
    <div className="scz diff-filelist">
      <div className="diff-filter">
        <Icon name="search" size={12} className="diff-filter__icon" />
        <input
          ref={filterInputRef}
          className="diff-filter__input"
          value={filter}
          placeholder="Filter files"
          onChange={(e) => onFilterChange(e.target.value)}
          onFocus={() => setFilterFocused(true)}
          onBlur={() => setFilterFocused(false)}
          aria-label="Filter files"
        />
        {filter === '' && !filterFocused && <span className="diff-filter__hint">/</span>}
      </div>

      <div
        onClick={onToggleAll}
        title={allSelected ? 'Leave every file out of the commit' : 'Include every file in the commit'}
        className="diff-filelist__header"
      >
        <Checkbox checked={allSelected} indeterminate={selectedCount > 0 && !allSelected} />
        <span>
          {selectedCount} of {totalFiles} in commit
        </span>
      </div>

      <div className="diff-tree" role="tree" aria-activedescendant={cursorKey ?? undefined}>
        {visibleRows.length === 0 && filter.trim() !== '' ? (
          <div className="diff-tree__no-match">No file matches &quot;{filter}&quot;</div>
        ) : (
          visibleRows.map((row) => {
            const isCursor = row.key === cursorKey;
            if (row.node.kind === 'folder') {
              return (
                <FolderRow
                  key={row.key}
                  node={row.node}
                  depth={row.depth}
                  expanded={row.expanded}
                  cursor={isCursor}
                  rollupState={rollup(row.node)}
                  onToggle={() => onToggleFold(row.key)}
                  rowRef={isCursor ? cursorRowRef : undefined}
                />
              );
            }
            const file = row.node.file;
            return (
              <FileRow
                key={row.key}
                file={file}
                depth={row.depth}
                filter={filter}
                selected={file.path === selectedPath}
                cursor={isCursor}
                checked={!deselected.has(file.path)}
                reviewed={isReviewed(reviewMarks, file)}
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

// The commit-selection box: filled with a check when included, hollow when left
// out, a dash when a folder is mixed.
function Checkbox({ checked, indeterminate, dim }: { checked: boolean; indeterminate?: boolean; dim?: boolean }) {
  const cls = ['diff-box', (checked || indeterminate) && 'diff-box--on', dim && 'diff-box--dim'].filter(Boolean).join(' ');
  return (
    <span className={cls} aria-hidden>
      {checked ? <Icon name="check" size={10} /> : indeterminate ? <span className="diff-box__dash" /> : null}
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
  // A folder partly left out of the commit says so; a fully included one stays quiet.
  const partial = rollupState !== 'checked';
  return (
    <div
      ref={rowRef}
      onClick={onToggle}
      title={partial ? `${node.label} — ${rollupState === 'mixed' ? 'partly' : 'not'} in commit` : node.label}
      role="treeitem"
      aria-expanded={expanded}
      id={node.key}
      className={cursor ? 'diff-tree-row diff-tree-row--folder diff-tree-row--cursor' : 'diff-tree-row diff-tree-row--folder'}
      style={indent(depth)}
    >
      <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={10} className="diff-tree-row__caret" />
      <span className="diff-tree-row__label truncate">{node.label}</span>
      {partial && <Checkbox checked={false} indeterminate={rollupState === 'mixed'} dim />}
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
  reviewed,
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
  reviewed: boolean;
  onClick: () => void;
  onToggle: () => void;
  rowRef?: RefObject<HTMLDivElement>;
}) {
  const st = FILE_STATUS[file.status] ?? FILE_STATUS.modified;
  const cls = ['diff-file-row', cursor && 'diff-tree-row--cursor', !checked && 'diff-file-row--excluded'].filter(Boolean).join(' ');
  return (
    <ListRow
      ref={rowRef}
      onClick={onClick}
      title={checked ? file.path : `${file.path} — not in commit`}
      selected={selected}
      id={file.path}
      role="treeitem"
      aria-selected={selected}
      className={cls}
      style={indent(depth)}
    >
      <span className={`diff-file-status diff-file-status--${st.tone}`}>{st.ch}</span>
      <span className="diff-file-name truncate">{renderMatch(file.name, filter)}</span>
      <span className="diff-file-row__spacer" />
      {reviewed && <Icon name="check" size={12} className="diff-file-row__reviewed" title="Reviewed" />}
      <span
        onClick={(e) => {
          e.stopPropagation(); // toggle commit selection without changing which diff is shown
          onToggle();
        }}
        className="diff-file-row__commit"
        title={checked ? 'Leave out of the commit' : 'Include in the commit'}
      >
        <Checkbox checked={checked} />
      </span>
    </ListRow>
  );
}

// FR-8: emphasize the matched substring within the basename with weight only,
// never colour.
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
