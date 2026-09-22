// The session panel's Changes section — redesign "Graphite & Signal", Figma
// "Session panel" (130:378), tab Changes. The working tree as a folder tree (the
// diff-navigator tree helpers, reused), a `+97 −31 in 7 files` summary with
// fold-all and filter, and a footer carrying the context meter and `Review N
// files`. Clicking a file opens the DIFF tab on that file (diff-focus.ts).
//
// Read-only on purpose: staging and committing stay in the DIFF tab, where the
// hunks are in front of you.

import { useMemo, useState } from 'react';
import type { SessionMeta } from '../../../contract/common';
import type { DiffFileSummary } from '../../../contract/diff-view';
import type { SessionPanelSectionProps } from '../../app/session-panel/sections';
import { useStore } from '../../lib/store';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { IconButton } from '../../ui/IconButton';
import { MeterRow, SidePanelBody, SidePanelEmpty, SidePanelFooter } from '../../ui/SidePanel';
import './changes-section.css';
import { requestDiffFile } from './diff-focus';
import { buildDiffTree, flattenVisibleRows, type DiffTreeNode } from './diff-tree';
import { diffStat, FILE_STATUS } from './file-status';
import { useDiffSummary } from './useDiffSummary';

/** The tab's compact figure: the uncommitted-file count the fleet sync already keeps live. */
export function ChangesBadge({ session }: { session: SessionMeta }) {
  const count = useStore((s) => s.derived.get(session.id)?.fileCount ?? null);
  return count && count > 0 ? <>{count}</> : null;
}

function folderKeys(nodes: DiffTreeNode[]): string[] {
  return nodes.flatMap((n) => (n.kind === 'folder' ? [n.key, ...folderKeys(n.children)] : []));
}

export default function ChangesSection({ session, context }: SessionPanelSectionProps) {
  const { summary, error } = useDiffSummary(session.id);
  const setMainTab = useStore((s) => s.setMainTab);
  const setFocusedPane = useStore((s) => s.setFocusedPane);
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const [filter, setFilter] = useState<string | null>(null);

  const files = useMemo(() => summary?.files ?? [], [summary]);
  const tree = useMemo(() => buildDiffTree(files), [files]);
  const rows = useMemo(() => flattenVisibleRows(tree, folded, filter ?? ''), [tree, folded, filter]);
  const allFolders = useMemo(() => folderKeys(tree), [tree]);
  const anyOpen = allFolders.some((k) => !folded.has(k));

  const openDiff = (path?: string) => {
    if (path) requestDiffFile(session.id, path);
    setFocusedPane('main');
    setMainTab('diff');
  };

  const toggleFolder = (key: string) =>
    setFolded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const notRepo = error?.code === 'NOT_A_GIT_REPO';

  return (
    <>
      {summary && files.length > 0 && (
        <div className="changes-section__summary">
          <span className="changes-section__totals">
            <span className="changes-section__add">+{summary.totalAdd}</span>
            <span className="changes-section__del"> −{summary.totalDel}</span>
          </span>
          <span className="changes-section__files">
            in {files.length} {files.length === 1 ? 'file' : 'files'}
          </span>
          <span className="changes-section__spacer" />
          <IconButton size={24} title={anyOpen ? 'Collapse all folders' : 'Expand all folders'} onClick={() => setFolded(anyOpen ? new Set(allFolders) : new Set())}>
            <Icon name={anyOpen ? 'chevron-down' : 'chevron-right'} size={12} />
          </IconButton>
          <IconButton size={24} on={filter !== null} title="Filter files" onClick={() => setFilter(filter === null ? '' : null)}>
            <Icon name="search" size={12} />
          </IconButton>
        </div>
      )}
      {filter !== null && (
        <div className="changes-section__filter">
          <input
            autoFocus
            className="changes-section__filter-input"
            placeholder="Filter files"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setFilter(null);
            }}
          />
        </div>
      )}

      <SidePanelBody className="changes-section__tree">
        {notRepo ? (
          <SidePanelEmpty>Not a git repository — nothing to track here.</SidePanelEmpty>
        ) : error ? (
          <SidePanelEmpty>Could not read the working tree: {error.message}</SidePanelEmpty>
        ) : summary === null ? null : files.length === 0 ? (
          <SidePanelEmpty>No uncommitted changes.</SidePanelEmpty>
        ) : (
          rows.map((row) =>
            row.node.kind === 'folder' ? (
              <FolderRow key={row.key} label={row.node.label} depth={row.depth} expanded={row.expanded} onToggle={() => toggleFolder(row.key)} />
            ) : (
              <FileRow key={row.key} file={row.node.file} depth={row.depth} onOpen={() => openDiff(row.key)} />
            ),
          )
        )}
      </SidePanelBody>

      <SidePanelFooter>
        {context && <MeterRow label="Context" fraction={context.fraction} figure={context.figure} />}
        {files.length > 0 && (
          <Button title="Open the Changes view · d" onClick={() => openDiff()}>
            Review {files.length} {files.length === 1 ? 'file' : 'files'}
          </Button>
        )}
      </SidePanelFooter>
    </>
  );
}

// Indent: a folder at depth d sits at 8 + 14d px; its files one step further in,
// matching the drawing (folders 8 / 22, files 38).
function FolderRow({ label, depth, expanded, onToggle }: { label: string; depth: number; expanded: boolean; onToggle: () => void }) {
  return (
    <div
      role="treeitem"
      aria-expanded={expanded}
      className={`changes-section__row changes-section__row--folder changes-section__row--d${Math.min(depth, 6)}`}
      onClick={onToggle}
      title={label}
    >
      <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={10} />
      <Icon name="folder" size={13} />
      <span className="changes-section__folder-name truncate">{label}</span>
    </div>
  );
}

function FileRow({ file, depth, onOpen }: { file: DiffFileSummary; depth: number; onOpen: () => void }) {
  const status = FILE_STATUS[file.status] ?? FILE_STATUS.modified;
  return (
    <div
      role="treeitem"
      className={`changes-section__row changes-section__row--file changes-section__row--d${Math.min(depth, 6)}`}
      onClick={onOpen}
      title={`${file.path} — open in Changes`}
    >
      <span className={`changes-section__status changes-section__status--${status.tone}`}>{status.ch}</span>
      <span className="changes-section__file-name truncate">{file.name}</span>
      <span className="changes-section__spacer" />
      <span className="changes-section__stat">{diffStat(file.additions, file.deletions)}</span>
    </div>
  );
}
