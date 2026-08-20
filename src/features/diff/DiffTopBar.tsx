import { ChevronsDownUp, RefreshCw } from 'lucide-react';

export interface DiffTopBarProps {
  branch: string | null;
  headShort: string | null;
  /** FR-15: the commit being viewed, if any — its shortHash for `vs <hash>^`. */
  viewingShortHash: string | null;
  totalAdd: number;
  totalDel: number;
  collapseReadInert: boolean;
  onCollapseRead: () => void;
  reloadInert: boolean;
  onReload: () => void;
}

/** diff-review FR-1..FR-4: the 34px top bar — branch (or detached hash) + the
 *  `vs <ref>` comparison on the left, totals + `⊟ collapse read` + `⟳` on the
 *  right. The old file-count chip, `[s] stage all` and the chip strip are gone. */
export function DiffTopBar({
  branch,
  headShort,
  viewingShortHash,
  totalAdd,
  totalDel,
  collapseReadInert,
  onCollapseRead,
  reloadInert,
  onReload,
}: DiffTopBarProps): JSX.Element {
  const branchLabel = branch ? branch : headShort ? `${headShort} (detached)` : '—';
  const vsLabel = viewingShortHash ? `vs ${viewingShortHash}^` : 'vs HEAD';

  return (
    <div className="diff-topbar">
      <span className="diff-topbar__branch">⑂ {branchLabel}</span>
      <span className="diff-topbar__vs">{vsLabel}</span>
      <span className="diff-topbar__spacer" />
      <span className="diff-color-add">+{totalAdd}</span>
      <span className="diff-color-del">−{totalDel}</span>
      <span
        className={collapseReadInert ? 'diff-topbar__action diff-topbar__action--inert' : 'diff-topbar__action'}
        onClick={() => !collapseReadInert && onCollapseRead()}
        title="collapse every read file to its header"
      >
        <ChevronsDownUp size={11} /> collapse read
      </span>
      <span
        className={reloadInert ? 'diff-topbar__action diff-topbar__action--inert' : 'diff-topbar__action'}
        onClick={() => !reloadInert && onReload()}
        title="refresh"
      >
        <RefreshCw size={11} />
      </span>
    </div>
  );
}
