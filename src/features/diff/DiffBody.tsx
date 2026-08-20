import { ExternalLink } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, RefObject } from 'react';
import type { DiffFileSummary } from '../../../contract/diff-view';
import type { FileDiffEntry } from './useDiffFeed';
import { DIFF_STATUS } from './diff-status';
import {
  ROW_H,
  buildFileRows,
  computeBlockOffsets,
  computeVisibleWindows,
  fileBlockSpec,
  filesReadAtScroll,
  isBigFile,
  type BlockOffset,
  type BodyRow,
} from './diff-body';
import type { IntralineSpan } from './intraline';

const KIND: Record<string, { bg: string; fg: string; sign: string; signFg: string; noFg: string }> = {
  hunk: { bg: 'var(--bg-elevated)', fg: 'var(--accent)', sign: '', signFg: '', noFg: '' },
  add: { bg: 'color-mix(in srgb, var(--success) 9%, transparent)', fg: 'var(--success-bright)', sign: '+', signFg: 'var(--success)', noFg: 'var(--success-dim)' },
  del: { bg: 'color-mix(in srgb, var(--error) 9%, transparent)', fg: 'var(--error-bright)', sign: '-', signFg: 'var(--error)', noFg: 'var(--error-dim)' },
  ctx: { bg: 'transparent', fg: 'var(--text-dim)', sign: ' ', signFg: 'var(--text-faint)', noFg: 'var(--text-faint)' },
  fold: { bg: 'transparent', fg: 'var(--text-muted)', sign: '', signFg: '', noFg: '' },
};

export interface DiffBodyProps {
  /** Tree order (FR-24) — every file, always (the rail's fold state never hides one). */
  files: DiffFileSummary[];
  fileDiffs: Map<string, FileDiffEntry>;
  collapsed: Set<string>;
  inCommit: Set<string>;
  readSet: Set<string>;
  /** FR-15: viewing a commit — no checkboxes anywhere, no editor link. */
  readOnly: boolean;
  notRepo: boolean;
  /** False until the first summary fetch settles — gates the "working tree clean"
   *  empty state so it never flashes ahead of real data. */
  summaryLoaded: boolean;
  summaryErrorMessage: string | null;
  scrollRef: RefObject<HTMLDivElement>;
  onToggleCollapse: (path: string) => void;
  onToggleInCommit: (path: string) => void;
  onOpenEditor: (path: string) => void;
  onExpandContext: (path: string) => void;
  onBigFile: (path: string) => void;
  onReadPaths: (paths: string[]) => void;
  onOffsetsChange: (offsets: BlockOffset[]) => void;
}

/** diff-review FR-18..FR-30: the one-scroll body — every file's sticky header +
 *  windowed diff rows, in tree order. Headers render unconditionally (cheap); only
 *  each file's own row list is windowed against the document's prefix-sum offset
 *  table (diff-body.ts), so a header stays mounted (and sticky) for as long as any
 *  of its rows are still "in play", exactly what FR-19 asks for. */
export function DiffBody({
  files,
  fileDiffs,
  collapsed,
  inCommit,
  readSet,
  readOnly,
  notRepo,
  summaryLoaded,
  summaryErrorMessage,
  scrollRef,
  onToggleCollapse,
  onToggleInCommit,
  onOpenEditor,
  onExpandContext,
  onBigFile,
  onReadPaths,
  onOffsetsChange,
}: DiffBodyProps): JSX.Element {
  const blocks = useMemo(
    () =>
      files.map((file) => {
        const entry = fileDiffs.get(file.path);
        const rows = entry?.diff && !entry.diff.binary ? buildFileRows(entry.diff) : [];
        return { file, entry, rows };
      }),
    [files, fileDiffs],
  );

  const specs = useMemo(() => blocks.map((b) => fileBlockSpec(b.file, b.rows.length, collapsed.has(b.file.path))), [blocks, collapsed]);
  const offsets = useMemo(() => computeBlockOffsets(specs), [specs]);

  useEffect(() => onOffsetsChange(offsets), [offsets, onOffsetsChange]);

  // FR-23: collapse a newly-loaded big file exactly once — never re-forces it shut
  // after the user expands it (guarded locally; `collapsed` itself lives up in
  // DiffUiState so the top-bar's `⊟ collapse read` and the caret can both touch it).
  const guardedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const b of blocks) {
      if (b.rows.length > 0 && isBigFile(b.rows.length) && !collapsed.has(b.file.path) && !guardedRef.current.has(b.file.path)) {
        guardedRef.current.add(b.file.path);
        onBigFile(b.file.path);
      }
    }
  }, [blocks, collapsed, onBigFile]);

  const [scrollState, setScrollState] = useState({ top: 0, height: 0 });
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const recompute = () => setScrollState({ top: el.scrollTop, height: el.clientHeight });
    recompute();
    el.addEventListener('scroll', recompute, { passive: true });
    const ro = new ResizeObserver(recompute);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', recompute);
      ro.disconnect();
    };
  }, [scrollRef]);

  const windows = useMemo(
    () => computeVisibleWindows(offsets, specs.map((s) => s.rowCount), scrollState.top, scrollState.height),
    [offsets, specs, scrollState],
  );

  // FR-28: read is inferred from scroll, one-way.
  useEffect(() => {
    const readNow = filesReadAtScroll(offsets, scrollState.top);
    if (readNow.length > 0) onReadPaths(readNow);
  }, [offsets, scrollState.top, onReadPaths]);

  if (notRepo) return <EmptyState text="not a git repository — initialize with `git init` in the shell" />;
  if (summaryErrorMessage) return <EmptyState text={summaryErrorMessage} color="var(--error)" />;
  if (!summaryLoaded) return <EmptyState text="loading…" />;
  if (files.length === 0) return <EmptyState text="working tree clean" />;

  return (
    <>
      {blocks.map((b, i) => (
        <FileBlock
          key={b.file.path}
          file={b.file}
          rows={b.rows}
          loading={b.entry?.loading ?? false}
          error={b.entry?.error?.message ?? null}
          binary={b.entry?.diff?.binary ?? false}
          collapsed={specs[i]!.collapsed}
          win={windows[i]!}
          checked={inCommit.has(b.file.path)}
          read={readSet.has(b.file.path)}
          readOnly={readOnly}
          onToggleCollapse={() => onToggleCollapse(b.file.path)}
          onToggleInCommit={() => onToggleInCommit(b.file.path)}
          onOpenEditor={() => onOpenEditor(b.file.path)}
          onExpandContext={() => onExpandContext(b.file.path)}
        />
      ))}
    </>
  );
}

function FileBlock({
  file,
  rows,
  loading,
  error,
  binary,
  collapsed,
  win,
  checked,
  read,
  readOnly,
  onToggleCollapse,
  onToggleInCommit,
  onOpenEditor,
  onExpandContext,
}: {
  file: DiffFileSummary;
  rows: BodyRow[];
  loading: boolean;
  error: string | null;
  binary: boolean;
  collapsed: boolean;
  win: { startRow: number; endRow: number };
  checked: boolean;
  read: boolean;
  readOnly: boolean;
  onToggleCollapse: () => void;
  onToggleInCommit: () => void;
  onOpenEditor: () => void;
  onExpandContext: () => void;
}) {
  const st = DIFF_STATUS[file.status] ?? DIFF_STATUS.modified;
  const big = isBigFile(rows.length);

  return (
    <div className={collapsed ? 'diff-file-block diff-file-block--collapsed' : 'diff-file-block'}>
      <div
        className={read ? 'diff-file-header diff-file-header--read' : 'diff-file-header'}
        aria-expanded={!collapsed}
        title={file.path}
      >
        <span className="diff-file-header__caret" onClick={onToggleCollapse} role="button" aria-label={collapsed ? 'expand file' : 'collapse file'}>
          {collapsed ? '▸' : '▾'}
        </span>
        <span className="diff-file-header__status" style={{ color: st.color }}>
          {st.ch}
        </span>
        <span className="diff-file-header__path truncate">
          {file.dir && <span className="diff-file-header__dir">{file.dir}/</span>}
          <span className="diff-file-header__name">{file.name}</span>
        </span>
        {file.additions > 0 && <span className="diff-color-add">+{file.additions}</span>}
        {file.deletions > 0 && <span className="diff-color-del">−{file.deletions}</span>}
        {collapsed && big && <span className="diff-file-header__hint">{rows.length} lines · expand</span>}
        <span className="diff-file-header__spacer" />
        {!readOnly && file.status !== 'deleted' && (
          <span className="diff-file-header__editor" onClick={onOpenEditor} role="button">
            <ExternalLink size={11} /> editor
          </span>
        )}
        {!readOnly && (
          <label className="diff-file-header__checkbox" onClick={(e) => e.stopPropagation()}>
            <input type="checkbox" checked={checked} onChange={onToggleInCommit} />
            in commit
          </label>
        )}
      </div>
      {!collapsed && (
        <div className="diff-rows" style={{ paddingTop: win.startRow * ROW_H, paddingBottom: (rows.length - win.endRow) * ROW_H }}>
          {loading && rows.length === 0 && <Placeholder text="loading…" />}
          {!loading && error && <Placeholder text={error} color="var(--error)" />}
          {!loading && !error && binary && <Placeholder text="binary file" />}
          {!loading && !error && !binary && rows.length === 0 && <Placeholder text="no content changes" />}
          {rows.slice(win.startRow, win.endRow).map((r, i) =>
            r.kind === 'fold' ? (
              <FoldRow key={win.startRow + i} count={r.foldCount ?? 0} onClick={onExpandContext} />
            ) : (
              <Row key={win.startRow + i} kind={r.kind} no={r.no} text={r.text} spans={r.spans} />
            ),
          )}
        </div>
      )}
    </div>
  );
}

function FoldRow({ count, onClick }: { count: number; onClick: () => void }) {
  return (
    <div className="diff-fold-row" onClick={onClick}>
      ⋯ {count} unchanged lines
    </div>
  );
}

function Row({ kind, no, text, spans }: { kind: string; no: string; text: string; spans: IntralineSpan[] }) {
  const k = KIND[kind] ?? KIND.ctx!;
  return (
    <div className="diff-row" style={{ '--row-bg': k.bg } as CSSProperties}>
      <span className="diff-row__no" style={{ color: k.noFg }}>
        {no}
      </span>
      <span className="diff-row__sign" style={{ color: k.signFg }}>
        {k.sign}
      </span>
      <span className="diff-row__text" style={{ color: k.fg }}>
        {spans.length > 0 ? <IntralineText text={text} spans={spans} kind={kind} /> : text}
      </span>
    </div>
  );
}

// diff-navigator FR-24 (carried over): background-colour and colour only — no
// padding, border, margin, font-size or font-family change, so ROW_H stays exact.
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
  return (
    <div className="diff-placeholder" style={color ? { color } : undefined}>
      {text}
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
