import { Search } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { AppError } from '../../../contract/common';
import type { DiffCommitList, DiffCommitSummary, DiffFileStatus } from '../../../contract/diff-view';
import { ListRow } from '../../ui/ListRow';
import { usePaneDrag } from '../../lib/hooks/usePaneDrag';
import { descendantFileCount, type DiffTreeNode, type RollupState, type VisibleRow } from './diff-tree';
import { DIFF_STATUS } from './diff-status';

const MIN_RAIL_WIDTH = 140;
const MAX_RAIL_WIDTH = 420;
export const DEFAULT_RAIL_WIDTH = 220;

export interface DiffRailProps {
  width: number;
  onWidthChange: (w: number) => void;
  visibleRows: VisibleRow[];
  railMode: 'tree' | 'flat';
  filter: string;
  filterInputRef: RefObject<HTMLInputElement>;
  cursorKey: string | null;
  inCommit: Set<string>;
  readSet: Set<string>;
  rollup: (node: DiffTreeNode) => RollupState;
  totalFiles: number;
  checkedCount: number;
  readCount: number;
  commits: DiffCommitList | null;
  commitsError: AppError | null;
  commitsExpanded: boolean;
  viewingCommit: string | null;
  onFilterChange: (v: string) => void;
  onSetRailMode: (mode: 'tree' | 'flat') => void;
  onToggleFold: (key: string) => void;
  onJumpToFile: (path: string) => void;
  onToggleFile: (path: string) => void;
  onToggleDirectory: (node: DiffTreeNode) => void;
  onToggleReadTick: (path: string) => void;
  onSelectCommit: (hash: string) => void;
  onAltClickHead: (commit: DiffCommitSummary) => void;
  onToggleCommitsExpanded: () => void;
}

/** diff-review FR-5..FR-17, FR-32: the rail — tree/flat toggle, filter, the tree
 *  itself, the COMMITS block and the read-progress foot bar. A resizable column
 *  (default 220px) per `resizable-sidebar`; the rail is the shrinking side. */
export function DiffRail(props: DiffRailProps): JSX.Element {
  const {
    width,
    onWidthChange,
    visibleRows,
    railMode,
    filter,
    filterInputRef,
    cursorKey,
    inCommit,
    readSet,
    rollup,
    totalFiles,
    checkedCount,
    readCount,
    commits,
    commitsError,
    commitsExpanded,
    viewingCommit,
    onFilterChange,
    onSetRailMode,
    onToggleFold,
    onJumpToFile,
    onToggleFile,
    onToggleDirectory,
    onToggleReadTick,
    onSelectCommit,
    onAltClickHead,
    onToggleCommitsExpanded,
  } = props;

  const cursorRowRef = useRef<HTMLDivElement>(null);
  const [filterFocused, setFilterFocused] = useState(false);
  useEffect(() => {
    cursorRowRef.current?.scrollIntoView({ block: 'nearest' });
  }, [cursorKey]);

  const { dragging, handlers } = usePaneDrag({
    axis: 'x',
    measure: (handle) => {
      const rail = handle.previousElementSibling as HTMLElement | null;
      if (!rail) return null;
      return { start: rail.getBoundingClientRect().left, size: rail.getBoundingClientRect().width };
    },
    onDrag: (pos, box) => onWidthChange(Math.min(MAX_RAIL_WIDTH, Math.max(MIN_RAIL_WIDTH, pos - box.start))),
  });

  const readPct = totalFiles > 0 ? Math.round((readCount / totalFiles) * 100) : 0;
  // FR-15: a read-only commit view has no staging affordance anywhere in the rail.
  const readOnly = viewingCommit !== null;

  return (
    <>
      <div className="diff-rail" style={{ width }}>
        <div className="diff-rail__header">
          {readOnly ? (
            <span>read-only</span>
          ) : (
            <span>
              in commit <span className="diff-rail__header-count">{checkedCount}/{totalFiles}</span>
            </span>
          )}
          <span className="diff-rail__header-spacer" />
          <div className="diff-rail__mode-toggle">
            <span
              className={railMode === 'tree' ? 'diff-rail__mode-btn diff-rail__mode-btn--active' : 'diff-rail__mode-btn'}
              onClick={() => onSetRailMode('tree')}
              title="tree"
            >
              ⌗
            </span>
            <span
              className={railMode === 'flat' ? 'diff-rail__mode-btn diff-rail__mode-btn--active' : 'diff-rail__mode-btn'}
              onClick={() => onSetRailMode('flat')}
              title="flat"
            >
              ▤
            </span>
          </div>
        </div>

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

        {/* refactor-backlog deferred:diff-navigator — closed here: a role="tree" that
            carries aria-activedescendant must itself be focusable. */}
        <div className="diff-tree" role="tree" tabIndex={0} aria-activedescendant={cursorKey ?? undefined}>
          {visibleRows.length === 0 && filter.trim() !== '' ? (
            <div className="diff-tree__no-match">no file matches &quot;{filter}&quot;</div>
          ) : (
            visibleRows.map((row) => {
              const isCursor = row.key === cursorKey;
              if (row.node.kind === 'folder') {
                const node = row.node;
                return (
                  <FolderRow
                    key={row.key}
                    node={node}
                    depth={row.depth}
                    expanded={row.expanded}
                    cursor={isCursor}
                    rollupState={rollup(node)}
                    readOnly={readOnly}
                    onToggleFold={() => onToggleFold(row.key)}
                    onToggleCheckbox={() => onToggleDirectory(node)}
                    rowRef={isCursor ? cursorRowRef : undefined}
                  />
                );
              }
              const file = row.node.file;
              return (
                <FileRow
                  key={row.key}
                  file={file}
                  depth={railMode === 'tree' ? row.depth : 0}
                  filter={filter}
                  cursor={isCursor}
                  checked={inCommit.has(file.path)}
                  read={readSet.has(file.path)}
                  readOnly={readOnly}
                  onClick={() => onJumpToFile(file.path)}
                  onToggle={() => onToggleFile(file.path)}
                  onToggleRead={() => onToggleReadTick(file.path)}
                  rowRef={isCursor ? cursorRowRef : undefined}
                />
              );
            })
          )}
        </div>

        <CommitsBlock
          commits={commits}
          error={commitsError}
          expanded={commitsExpanded}
          viewingCommit={viewingCommit}
          onSelect={onSelectCommit}
          onAltClickHead={onAltClickHead}
          onToggleExpanded={onToggleCommitsExpanded}
        />

        <div className="diff-rail__foot">
          <div className="diff-rail__foot-track">
            <div className="diff-rail__foot-fill" style={{ width: `${readPct}%` }} />
          </div>
          <span>
            {readCount}/{totalFiles} read
          </span>
        </div>
      </div>
      <div
        className={dragging ? 'diff-rail__resize diff-rail__resize--dragging' : 'diff-rail__resize'}
        {...handlers}
      />
    </>
  );
}

function Checkbox({ checked, indeterminate }: { checked: boolean; indeterminate?: boolean }) {
  const on = checked || indeterminate;
  return (
    <span
      className="diff-checkbox"
      role="checkbox"
      aria-checked={indeterminate ? 'mixed' : checked}
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
  readOnly,
  onToggleFold,
  onToggleCheckbox,
  rowRef,
}: {
  node: Extract<DiffTreeNode, { kind: 'folder' }>;
  depth: number;
  expanded: boolean;
  cursor: boolean;
  rollupState: RollupState;
  readOnly: boolean;
  onToggleFold: () => void;
  onToggleCheckbox: () => void;
  rowRef?: RefObject<HTMLDivElement>;
}) {
  return (
    <div
      ref={rowRef}
      onClick={onToggleFold}
      title={node.label}
      role="treeitem"
      aria-expanded={expanded}
      id={node.key}
      className={cursor ? 'diff-tree-row diff-tree-row--folder diff-tree-row--cursor' : 'diff-tree-row diff-tree-row--folder'}
      style={{ paddingLeft: 4 + depth * 20 }}
    >
      <span className="diff-tree-row__caret">{expanded ? '▾' : '▸'}</span>
      {!readOnly && (
        <span
          className="diff-checkbox-wrap"
          onClick={(e) => {
            e.stopPropagation();
            onToggleCheckbox();
          }}
          role="checkbox"
          aria-checked={rollupState === 'mixed' ? 'mixed' : rollupState === 'checked'}
        >
          <Checkbox checked={rollupState === 'checked'} indeterminate={rollupState === 'mixed'} />
        </span>
      )}
      <span className="diff-tree-row__label truncate">{node.label}</span>
      <span className="diff-tree-row__count">{descendantFileCount(node)}</span>
    </div>
  );
}

function FileRow({
  file,
  depth,
  filter,
  cursor,
  checked,
  read,
  readOnly,
  onClick,
  onToggle,
  onToggleRead,
  rowRef,
}: {
  file: { path: string; name: string; status: DiffFileStatus; additions: number; deletions: number };
  depth: number;
  filter: string;
  cursor: boolean;
  checked: boolean;
  read: boolean;
  readOnly: boolean;
  onClick: () => void;
  onToggle: () => void;
  onToggleRead: () => void;
  rowRef?: RefObject<HTMLDivElement>;
}) {
  const st = DIFF_STATUS[file.status] ?? DIFF_STATUS.modified;
  return (
    <ListRow
      ref={rowRef}
      onClick={onClick}
      title={file.path}
      id={file.path}
      role="treeitem"
      className={
        (cursor ? 'diff-tree-row diff-file-row diff-tree-row--cursor' : 'diff-tree-row diff-file-row') + (read ? ' diff-file-row--read' : '')
      }
      style={{ paddingLeft: 4 + depth * 20 }}
    >
      {!readOnly && (
        <span
          onClick={(e) => {
            e.stopPropagation(); // FR-8: the checkbox writes state without jumping the body
            onToggle();
          }}
          className="diff-checkbox-wrap"
          role="checkbox"
          aria-checked={checked}
        >
          <Checkbox checked={checked} />
        </span>
      )}
      <span className="diff-file-status" style={{ color: st.color }}>
        {st.ch}
      </span>
      <span className="diff-file-name truncate">{renderMatch(file.name, filter)}</span>
      {read && (
        <span
          className="diff-file-read-tick"
          onClick={(e) => {
            e.stopPropagation(); // FR-29: manual read toggle, independent of the jump
            onToggleRead();
          }}
          title="mark unread"
        >
          ✓
        </span>
      )}
      {file.additions > 0 && <span className="diff-file-stat diff-color-add">+{file.additions}</span>}
      {file.deletions > 0 && <span className="diff-file-stat diff-color-del">−{file.deletions}</span>}
    </ListRow>
  );
}

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

function CommitsBlock({
  commits,
  error,
  expanded,
  viewingCommit,
  onSelect,
  onAltClickHead,
  onToggleExpanded,
}: {
  commits: DiffCommitList | null;
  error: AppError | null;
  expanded: boolean;
  viewingCommit: string | null;
  onSelect: (hash: string) => void;
  onAltClickHead: (commit: DiffCommitSummary) => void;
  onToggleExpanded: () => void;
}) {
  const rows = commits?.commits ?? [];
  const shown = expanded ? rows : rows.slice(0, 3);
  const rest = rows.length - shown.length;

  return (
    <div className="diff-commits">
      <div className="diff-commits__header" onClick={onToggleExpanded}>
        <span className="diff-commits__title">COMMITS</span>
        {rows.length > 0 && commits?.baseBranch && (
          <span className="diff-commits__count">
            {rows.length} ahead of {commits.baseBranch}
          </span>
        )}
      </div>
      {error ? (
        <div className="diff-commits__empty">{error.message}</div>
      ) : commits === null ? null : rows.length === 0 ? (
        <div className="diff-commits__empty">{commits.baseBranch ? `nothing ahead of ${commits.baseBranch}` : 'no base branch'}</div>
      ) : (
        <>
          <div className="diff-commits__list">
            {shown.map((c) => (
              <div
                key={c.hash}
                className={c.hash === viewingCommit ? 'diff-commits__row diff-commits__row--selected' : 'diff-commits__row'}
                onClick={(e) => (c.isHead && e.altKey ? onAltClickHead(c) : onSelect(c.hash))}
                title={c.subject}
              >
                <span className="diff-commits__hash">{c.shortHash}</span>
                <span className="diff-commits__subject truncate">{c.subject}</span>
                {c.isHead ? <span className="diff-commits__head">HEAD</span> : <span className="diff-commits__age">{relativeAge(c.authoredAt)}</span>}
              </div>
            ))}
          </div>
          {rest > 0 && (
            <div className="diff-commits__expander" onClick={onToggleExpanded}>
              {rest} more · {commits?.baseBranch}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function relativeAge(authoredAt: number): string {
  const deltaMs = Date.now() - authoredAt;
  const mins = Math.floor(deltaMs / 60_000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}
