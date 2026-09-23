import { useEffect, useMemo, useState } from 'react';
import type { RefObject } from 'react';
import type { AppError } from '../../../contract/common';
import type { DiffFileSummary, DiffHunk, DiffLine, DiffSummary, FileDiff } from '../../../contract/diff-view';
import { useDelayedFlag } from '../../lib/hooks/useDelayedFlag';
import { Icon } from '../../ui/Icon';
import { LoaderPane, Slabs } from '../../ui/Loaders';
import { DiffTree } from './DiffTree';
import { computeIntralineSpans, type IntralineSpan } from './intraline';
import { isReviewed } from './review-state';
import type { DiffNavigator } from './useDiffNavigator';

// Row tones live in diff.css as `.diff-row--<kind>` (Figma 135:5245: a tint/info
// hunk band, tint/success + success-text adds, tint/danger + danger-text dels).
const SIGN: Record<string, string> = { add: '+', del: '-', ctx: ' ' };

// Diff rows are single-line (white-space: pre, no wrap), so each is a fixed height:
// the design's Mono Code line, 12.5px on 22px (Figma 135:5249). That lets us window
// the body — mount only the rows in view — so a 5k-line diff stays as snappy to
// scroll/switch as a 50-line one.
// diff-navigator FR-24: this must stay exactly correct with intraline spans present.
const ROW_H = 22;
const OVERSCAN = 12; // rows rendered beyond each edge, to hide scroll blanking
const WINDOW_INITIAL = 80; // rows to render on first paint, before the scroll box is measured
const BODY_INSET = 10; // the design's top/bottom inset (the hunk band sits at y=10)

export interface DiffListBodyProps {
  files: DiffFileSummary[];
  selectedPath: string | null;
  deselected: Set<string>;
  allSelected: boolean;
  selectedCount: number;
  notRepo: boolean;
  summaryError: AppError | null;
  summary: DiffSummary | null;
  fileDiff: FileDiff | null;
  fileDiffError: AppError | null;
  fileDiffLoading: boolean;
  bodyScrollRef: RefObject<HTMLDivElement>;
  navigator: DiffNavigator;
  onSelectPath: (path: string) => void;
  onToggleFile: (path: string) => void;
  onToggleAll: () => void;
  /** The session's review marks (review-state.ts). */
  reviewMarks: readonly string[];
  onToggleReviewed: (file: DiffFileSummary) => void;
}

/** DIFF tab's main area: the navigator tree (left) + the selected file's header
 *  over the windowed diff body (right), plus their empty/error/loading states. */
export function DiffListBody({
  files,
  selectedPath,
  deselected,
  allSelected,
  selectedCount,
  notRepo,
  summaryError,
  summary,
  fileDiff,
  fileDiffError,
  fileDiffLoading,
  bodyScrollRef,
  navigator,
  onSelectPath,
  onToggleFile,
  onToggleAll,
  reviewMarks,
  onToggleReviewed,
}: DiffListBodyProps): JSX.Element {
  const selectedFile = files.find((f) => f.path === selectedPath) ?? null;
  return (
    <div className="diff-main">
      {/* navigator — a folder tree with a filter box. Renders nothing when empty. */}
      {files.length > 0 && (
        <DiffTree
          visibleRows={navigator.visibleRows}
          filter={navigator.filter}
          onFilterChange={navigator.setFilter}
          filterInputRef={navigator.filterInputRef}
          selectedPath={selectedPath}
          cursorKey={navigator.cursorKey}
          deselected={deselected}
          allSelected={allSelected}
          selectedCount={selectedCount}
          totalFiles={files.length}
          rollup={navigator.rollup}
          reviewMarks={reviewMarks}
          onSelectPath={onSelectPath}
          onToggleFile={onToggleFile}
          onToggleAll={onToggleAll}
          onToggleFold={navigator.toggleFold}
        />
      )}

      {/* diff pane — the selected file's header (Figma 135:5238) over the body */}
      <div className="diff-pane">
        {selectedFile && !notRepo && !summaryError && (
          <FileHeader
            file={selectedFile}
            reviewed={isReviewed(reviewMarks, selectedFile)}
            onToggleReviewed={() => onToggleReviewed(selectedFile)}
          />
        )}
        <div ref={bodyScrollRef} className="scz diff-body">
          {notRepo ? (
            <EmptyState text="Not a git repository — initialize it with `git init` in the shell." />
          ) : summaryError ? (
            <EmptyState text={summaryError.message} error />
          ) : summary === null ? (
            // loaders: the first hydrate — nothing to show yet, so the pane
            // owns the area (Figma "33 · Loaders" LoaderPane).
            <LoaderPane label="Reading changes…" />
          ) : files.length === 0 ? (
            <EmptyState text="Working tree clean" />
          ) : (
            <DiffBody loading={fileDiffLoading} error={fileDiffError} diff={fileDiff} scrollRef={bodyScrollRef} />
          )}
        </div>
      </div>
    </div>
  );
}

function FileHeader({ file, reviewed, onToggleReviewed }: { file: DiffFileSummary; reviewed: boolean; onToggleReviewed: () => void }) {
  return (
    <div className="diff-file-header">
      <span className="diff-file-header__path truncate" title={file.path}>
        {file.path}
      </span>
      <span className="diff-file-header__stat">
        {file.additions > 0 && <span className="diff-color-add">+{file.additions}</span>}
        {file.additions > 0 && file.deletions > 0 && ' '}
        {file.deletions > 0 && <span className="diff-color-del">−{file.deletions}</span>}
      </span>
      <span className="diff-file-header__spacer" />
      <label className="diff-mark-reviewed">
        <input type="checkbox" className="diff-mark-reviewed__input" checked={reviewed} onChange={onToggleReviewed} />
        <span className={reviewed ? 'diff-box diff-box--on' : 'diff-box'} aria-hidden>
          {reviewed && <Icon name="check" size={10} />}
        </span>
        Mark reviewed
      </label>
    </div>
  );
}

function EmptyState({ text, error }: { text: string; error?: boolean }) {
  return <div className={error ? 'diff-empty-state diff-empty-state--error' : 'diff-empty-state'}>{text}</div>;
}

interface FlatRow {
  kind: string;
  oldNo: string;
  newNo: string;
  text: string;
  spans: IntralineSpan[];
}

function DiffBody({
  loading,
  error,
  diff,
  scrollRef,
}: {
  loading: boolean;
  error: AppError | null;
  diff: FileDiff | null;
  scrollRef: RefObject<HTMLDivElement>;
}) {
  // Flatten hunks (header + lines) into one fixed-height row list so the body can be
  // windowed. Cheap for small diffs, essential for huge ones. Intraline spans
  // (diff-navigator FR-20..24) are computed per hunk, in the view layer only.
  const rows = useMemo<FlatRow[]>(() => {
    if (!diff || diff.binary) return [];
    const out: FlatRow[] = [];
    for (const hunk of diff.hunks as DiffHunk[]) {
      out.push({ kind: 'hunk', oldNo: '', newNo: '', text: hunk.header, spans: [] });
      const spansByIndex = computeIntralineSpans(hunk.lines);
      (hunk.lines as DiffLine[]).forEach((line, idx) => {
        out.push({
          kind: line.kind,
          // Two gutters (Figma 135:5249): old number, then new — an add has no
          // old line and a delete no new one.
          oldNo: line.kind === 'add' ? '' : String(line.oldNo ?? ''),
          newNo: line.kind === 'del' ? '' : String(line.newNo ?? ''),
          text: line.text,
          spans: spansByIndex.get(idx) ?? [],
        });
      });
    }
    return out;
  }, [diff]);

  const [win, setWin] = useState({ start: 0, end: WINDOW_INITIAL });

  // Nothing under 300ms — a loader that flashes is worse than a beat of silence.
  const showLoadingSlabs = useDelayedFlag(loading && !diff, 300);

  // Recompute the visible window on scroll / resize.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || rows.length === 0) return;
    const recompute = () => {
      const start = Math.max(0, Math.floor(el.scrollTop / ROW_H) - OVERSCAN);
      const visible = Math.ceil(el.clientHeight / ROW_H) + OVERSCAN * 2;
      const end = Math.min(rows.length, start + visible);
      // bail out when unchanged — otherwise every scroll tick re-renders the body
      setWin((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
    };
    recompute();
    el.addEventListener('scroll', recompute, { passive: true });
    const ro = new ResizeObserver(recompute);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', recompute);
      ro.disconnect();
    };
  }, [rows.length, scrollRef]);

  // Switching files: jump back to the top and reset the window for the new content.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    setWin({ start: 0, end: WINDOW_INITIAL });
  }, [diff, scrollRef]);

  if (error) return <Placeholder text={error.message} error />;
  if (loading && !diff) return showLoadingSlabs ? <Placeholder loading /> : null;
  if (!diff) return null;
  if (diff.binary) return <Placeholder text="Binary file" />;
  if (rows.length === 0) return <Placeholder text="No content changes" />;

  const start = Math.min(win.start, rows.length);
  const end = Math.min(win.end, rows.length);
  // The spacers reserve the off-screen rows so the scrollbar length stays correct
  // — a runtime value, hence inline.
  return (
    <div
      className="diff-rows"
      style={{ paddingTop: BODY_INSET + start * ROW_H, paddingBottom: BODY_INSET + (rows.length - end) * ROW_H }}
    >
      {rows.slice(start, end).map((r, i) => (
        <Row key={start + i} row={r} />
      ))}
    </div>
  );
}

function Row({ row }: { row: FlatRow }) {
  if (row.kind === 'hunk') {
    return (
      <div className="diff-row diff-row--hunk">
        <span className="diff-row__text">{row.text}</span>
      </div>
    );
  }
  const kind = row.kind in SIGN ? row.kind : 'ctx';
  return (
    <div className={`diff-row diff-row--${kind}`}>
      <span className="diff-row__no">{row.oldNo}</span>
      <span className="diff-row__no">{row.newNo}</span>
      <span className="diff-row__sign">{SIGN[kind]}</span>
      <span className="diff-row__text">{row.spans.length > 0 ? <IntralineText text={row.text} spans={row.spans} /> : row.text}</span>
    </div>
  );
}

// diff-navigator FR-24: background-colour and colour only — no padding, border,
// margin, font-size or font-family change, so ROW_H stays exact. The row's kind
// modifier picks the tone (diff.css `.diff-row--add .diff-row__em`).
function IntralineText({ text, spans }: { text: string; spans: IntralineSpan[] }) {
  return (
    <>
      {spans.map((span, i) => (
        <span key={i} className={span.emphasis ? 'diff-row__em' : undefined}>
          {text.slice(span.start, span.end)}
        </span>
      ))}
    </>
  );
}

function Placeholder({ text, error, loading }: { text?: string; error?: boolean; loading?: boolean }) {
  if (loading) return (
    <div className="diff-placeholder diff-placeholder--loading">
      <Slabs size={16} />
    </div>
  );
  return <div className={error ? 'diff-placeholder diff-placeholder--error' : 'diff-placeholder'}>{text}</div>;
}
