import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties, RefObject } from 'react';
import type { AppError } from '../../../contract/common';
import type { DiffFileSummary, DiffHunk, DiffLine, DiffSummary, FileDiff } from '../../../contract/diff-view';
import { DiffTree } from './DiffTree';
import { computeIntralineSpans, type IntralineSpan } from './intraline';
import type { DiffNavigator } from './useDiffNavigator';

// per-kind diff-row tokens (spec §8 dstyle table)
const KIND: Record<string, { bg: string; fg: string; sign: string; signFg: string; noFg: string }> = {
  hunk: { bg: 'var(--bg-elevated)', fg: 'var(--accent)', sign: '', signFg: '', noFg: '' },
  add: { bg: 'color-mix(in srgb, var(--success) 9%, transparent)', fg: 'var(--success-bright)', sign: '+', signFg: 'var(--success)', noFg: 'var(--success-dim)' },
  del: { bg: 'color-mix(in srgb, var(--error) 9%, transparent)', fg: 'var(--error-bright)', sign: '-', signFg: 'var(--error)', noFg: 'var(--error-dim)' },
  ctx: { bg: 'transparent', fg: 'var(--text-dim)', sign: ' ', signFg: 'var(--text-faint)', noFg: 'var(--text-faint)' },
};

// Diff rows are single-line (white-space: pre, no wrap), so each is a fixed height:
// fontSize 12 × lineHeight 1.75 = 21px. That lets us window the body — mount only the
// rows in view — so a 5k-line diff stays as snappy to scroll/switch as a 50-line one.
// diff-navigator FR-24: this must stay exactly correct with intraline spans present.
const ROW_H = 21;
const OVERSCAN = 12; // rows rendered beyond each edge, to hide scroll blanking
const WINDOW_INITIAL = 80; // rows to render on first paint, before the scroll box is measured

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
}

/** DIFF tab's main area: the navigator tree (left) + the windowed diff body
 *  (right), plus their empty/error/loading states. */
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
}: DiffListBodyProps): JSX.Element {
  return (
    <div className="diff-main">
      {/* navigator — a folder tree with a filter box (replaces the flat vertical
          list). Renders nothing when empty (spec §8). */}
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
          onSelectPath={onSelectPath}
          onToggleFile={onToggleFile}
          onToggleAll={onToggleAll}
          onToggleFold={navigator.toggleFold}
        />
      )}

      {/* body */}
      <div ref={bodyScrollRef} className="scz diff-body">
        {notRepo ? (
          <EmptyState text="not a git repository — initialize with `git init` in the shell" />
        ) : summaryError ? (
          <EmptyState text={summaryError.message} color="var(--error)" />
        ) : summary && files.length === 0 ? (
          <EmptyState text="working tree clean" />
        ) : (
          <DiffBody loading={fileDiffLoading} error={fileDiffError} diff={fileDiff} scrollRef={bodyScrollRef} />
        )}
      </div>
    </div>
  );
}

function EmptyState({ text, color }: { text: string; color?: string }) {
  return (
    <div className="diff-empty-state" style={color ? { color } : undefined}>
      {text}
    </div>
  );
}

interface FlatRow {
  kind: string;
  no: string;
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
      out.push({ kind: 'hunk', no: '', text: hunk.header, spans: [] });
      const spansByIndex = computeIntralineSpans(hunk.lines);
      (hunk.lines as DiffLine[]).forEach((line, idx) => {
        out.push({
          kind: line.kind,
          no: line.kind === 'del' ? String(line.oldNo ?? '') : String(line.newNo ?? ''),
          text: line.text,
          spans: spansByIndex.get(idx) ?? [],
        });
      });
    }
    return out;
  }, [diff]);

  const [win, setWin] = useState({ start: 0, end: WINDOW_INITIAL });

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

  if (error) return <Placeholder text={error.message} color="var(--error)" />;
  if (loading && !diff) return <Placeholder text="loading…" />;
  if (!diff) return null;
  if (diff.binary) return <Placeholder text="binary file" />;
  if (rows.length === 0) return <Placeholder text="no content changes" />;

  const start = Math.min(win.start, rows.length);
  const end = Math.min(win.end, rows.length);
  // 8px matches the original body padding; the spacers reserve the off-screen rows so
  // the scrollbar length stays correct.
  return (
    <div className="diff-rows" style={{ paddingTop: 8 + start * ROW_H, paddingBottom: 8 + (rows.length - end) * ROW_H }}>
      {rows.slice(start, end).map((r, i) => (
        <Row key={start + i} kind={r.kind} no={r.no} text={r.text} spans={r.spans} />
      ))}
    </div>
  );
}

function Row({ kind, no, text, spans }: { kind: string; no: string; text: string; spans: IntralineSpan[] }) {
  const k = KIND[kind] ?? KIND.ctx;
  return (
    <div className="diff-row" style={{ '--row-bg': k.bg } as CSSProperties}>
      <span className="diff-row__no" style={{ color: k.noFg }}>{no}</span>
      <span className="diff-row__sign" style={{ color: k.signFg }}>{k.sign}</span>
      <span className="diff-row__text" style={{ color: k.fg }}>
        {spans.length > 0 ? <IntralineText text={text} spans={spans} kind={kind} /> : text}
      </span>
    </div>
  );
}

// diff-navigator FR-24: background-colour and colour only — no padding, border,
// margin, font-size or font-family change, so ROW_H stays exact.
function IntralineText({ text, spans, kind }: { text: string; spans: IntralineSpan[]; kind: string }) {
  const bg = kind === 'del' ? 'color-mix(in srgb, var(--error) 22%, transparent)' : 'color-mix(in srgb, var(--success) 22%, transparent)';
  const fg = kind === 'del' ? 'var(--error-bright)' : 'var(--success-bright)';
  return (
    <>
      {spans.map((span, i) => (
        <span key={i} style={span.emphasis ? { background: bg, color: fg } : undefined}>
          {text.slice(span.start, span.end)}
        </span>
      ))}
    </>
  );
}

function Placeholder({ text, color }: { text: string; color?: string }) {
  return <div className="diff-placeholder" style={color ? { color } : undefined}>{text}</div>;
}
