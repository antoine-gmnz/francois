import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { AppError } from '../contract/common';
import type { DiffSummary, DiffFileSummary, DiffFileStatus, FileDiff, DiffHunk, DiffLine } from '../contract/diff-view';
import { diffCommit, diffGetFileDiff, diffGetSummary, diffStageAll, onDiffEvent } from './api';
import { useStore } from './store';

const C = {
  accent: 'var(--accent)',
  add: 'var(--success)',
  del: 'var(--error)',
  name: 'var(--text)',
  bright: 'var(--text-bright)',
  base: 'var(--text-muted)',
  faint: 'var(--text-faint)',
  inert: 'var(--text-disabled)',
  hint: 'var(--text-hint)',
  border: 'var(--border)',
};

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
const ROW_H = 21;
const OVERSCAN = 12; // rows rendered beyond each edge, to hide scroll blanking
const WINDOW_INITIAL = 80; // rows to render on first paint, before the scroll box is measured

interface CommitState {
  open: boolean;
  message: string;
  error: string | null;
  success: string | null; // short hash
}

export default function DiffView({ sessionId }: { sessionId: string }) {
  const focusedPane = useStore((s) => s.focusedPane);
  const mainTab = useStore((s) => s.mainTab);

  const [summary, setSummary] = useState<DiffSummary | null>(null);
  const [summaryError, setSummaryError] = useState<AppError | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  // Commit selection. We track the paths the user EXPLICITLY unchecked (not the
  // checked ones) so every newly-appearing change defaults to selected without any
  // reconciliation on summary reload — a path simply drops out of the set when the
  // user re-checks it, and stale entries are harmless.
  const [deselected, setDeselected] = useState<Set<string>>(new Set());
  const [fileDiff, setFileDiff] = useState<FileDiff | null>(null);
  const [fileDiffError, setFileDiffError] = useState<AppError | null>(null);
  const [fileDiffLoading, setFileDiffLoading] = useState(false);
  const [commit, setCommit] = useState<CommitState>({ open: false, message: '', error: null, success: null });
  const [busy, setBusy] = useState(false);
  const [summaryLoading, setSummaryLoading] = useState(false);

  const commitInputRef = useRef<HTMLInputElement>(null);
  const bodyScrollRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedPath;
  const mountedRef = useRef(true);
  const commitRef = useRef(commit); // latest commit state, read by doCommit outside any updater
  commitRef.current = commit;
  // Every getSummary emits one diff.changed echo (FR-17). We count outstanding echoes
  // so our own subscription skips them and refetches only on external changes
  // (watcher / tool.done / another surface) — otherwise getSummary would self-trigger
  // an unbounded refetch loop.
  const pendingEchoRef = useRef(0);
  // Coalesce external-broadcast refetches: while one summary load is in flight, a
  // burst of diff.changed events queues exactly ONE trailing re-run instead of
  // stacking fetches (which strobed requestBusy → the footer hints "blinked").
  const summaryInFlightRef = useRef(false);
  const refreshQueuedRef = useRef(false);

  const notRepo = summaryError?.code === 'NOT_A_GIT_REPO';
  const files = summary?.files ?? [];

  // Paths that will actually be committed (everything not explicitly unchecked).
  const selectedPaths = useMemo(() => files.filter((f) => !deselected.has(f.path)).map((f) => f.path), [files, deselected]);
  const selectedCount = selectedPaths.length;
  const allSelected = files.length > 0 && selectedCount === files.length;
  const selectedPathsRef = useRef<string[]>([]);
  selectedPathsRef.current = selectedPaths; // read by doCommit without re-creating it

  const toggleFile = useCallback((path: string) => {
    setDeselected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  // Header checkbox: all-checked → uncheck every current file, otherwise select all.
  const toggleAll = useCallback(() => {
    setDeselected((prev) => (files.length > 0 && files.every((f) => !prev.has(f.path)) ? new Set(files.map((f) => f.path)) : new Set()));
  }, [files]);

  // Load summary, preserving selection when the selected path survives (FR-19).
  const loadSummary = useCallback((sid: string) => {
    const run = () => {
      summaryInFlightRef.current = true;
      pendingEchoRef.current += 1; // a successful getSummary will broadcast one echo
      setSummaryLoading(true);
      void diffGetSummary(sid)
        .then((res) => {
          if (!res.ok) pendingEchoRef.current = Math.max(0, pendingEchoRef.current - 1); // no broadcast on error
          if (!mountedRef.current) return;
          setSummaryLoading(false);
          if (res.ok) {
            setSummary(res.data);
            setSummaryError(null);
            const prev = selectedRef.current;
            const keep = prev && res.data.files.some((f) => f.path === prev);
            setSelectedPath(keep ? prev : (res.data.files[0]?.path ?? null));
          } else {
            setSummary(null);
            setSummaryError(res.error);
            setSelectedPath(null);
          }
        })
        .catch(() => {
          pendingEchoRef.current = Math.max(0, pendingEchoRef.current - 1);
          if (mountedRef.current) setSummaryLoading(false);
        })
        .finally(() => {
          summaryInFlightRef.current = false;
          if (refreshQueuedRef.current && mountedRef.current) {
            refreshQueuedRef.current = false;
            run(); // one trailing re-run covers every broadcast that arrived mid-flight
          }
        });
    };
    run();
  }, []);

  // Hydrate + live diff.changed for this session (component is keyed by sessionId in App).
  useEffect(() => {
    mountedRef.current = true;
    let unlisten: (() => void) | undefined;
    // Register the listener BEFORE the first getSummary so that fetch's own echo is
    // guaranteed to be consumed by the counter (no mount-race stuck-at-1, N1).
    void onDiffEvent((e) => {
      if (e.type !== 'diff.changed' || e.sessionId !== sessionId) return;
      if (pendingEchoRef.current > 0) {
        pendingEchoRef.current -= 1; // our own getSummary echo — do not refetch
        return;
      }
      if (summaryInFlightRef.current) {
        refreshQueuedRef.current = true; // fold the burst into one trailing re-run
        return;
      }
      loadSummary(sessionId); // external change
    }).then((u) => {
      if (!mountedRef.current) {
        u();
        return;
      }
      unlisten = u;
      loadSummary(sessionId); // initial hydrate, now that the listener is live
    });
    return () => {
      mountedRef.current = false;
      if (unlisten) unlisten();
    };
  }, [sessionId, loadSummary]);

  // Load the selected file's diff (FR-7/8). Stale path → refresh summary (FR §7).
  useEffect(() => {
    if (!selectedPath) {
      setFileDiff(null);
      setFileDiffError(null);
      return;
    }
    const mounted = { current: true };
    setFileDiffLoading(true);
    setFileDiffError(null);
    void diffGetFileDiff(sessionId, selectedPath).then((res) => {
      if (!mounted.current) return;
      setFileDiffLoading(false);
      if (res.ok) {
        setFileDiff(res.data);
        setFileDiffError(null);
      } else {
        setFileDiff(null);
        setFileDiffError(res.error);
        if (res.error.code === 'INVALID_INPUT') loadSummary(sessionId); // stale path → refresh
      }
    });
    return () => {
      mounted.current = false;
    };
  }, [sessionId, selectedPath, loadSummary]);

  const cycle = useCallback(
    (dir: 1 | -1) => {
      if (files.length === 0) return;
      const i = files.findIndex((f) => f.path === selectedPath);
      const next = (i === -1 ? 0 : i + dir + files.length) % files.length;
      setSelectedPath(files[next].path);
    },
    [files, selectedPath],
  );

  const requestBusy = busy || summaryLoading || fileDiffLoading; // any request in flight (FR-22/23)

  const stageAll = useCallback(() => {
    if (requestBusy || notRepo || files.length === 0) return; // FR-22 inert
    setBusy(true);
    void diffStageAll(sessionId)
      .then(() => loadSummary(sessionId)) // fresh summary (FR-4 flow)
      .finally(() => {
        if (mountedRef.current) setBusy(false);
      });
  }, [requestBusy, notRepo, files.length, sessionId, loadSummary]);

  const openCommit = useCallback(() => {
    if (requestBusy || notRepo || selectedCount === 0) return; // FR-23 inert; nothing selected → nothing to commit
    setCommit({ open: true, message: '', error: null, success: null });
    requestAnimationFrame(() => commitInputRef.current?.focus());
  }, [requestBusy, notRepo, selectedCount]);

  const closeCommit = useCallback(() => setCommit({ open: false, message: '', error: null, success: null }), []);

  const doCommit = useCallback(() => {
    // Side effects live OUTSIDE any state updater so React StrictMode's double-invoke
    // of updaters can't fire the commit twice (N2). Read latest state from the ref.
    const c = commitRef.current;
    const msg = c.message.trim();
    const paths = selectedPathsRef.current;
    if (!c.open || !msg || busy || paths.length === 0) return; // FR-24 blank / no selection = no-op
    setBusy(true);
    void diffCommit(sessionId, msg, paths)
      .then((res) => {
        if (res.ok) {
          const short = res.data.commitHash.slice(0, 7);
          setCommit({ open: true, message: '', error: null, success: short }); // FR-25
          loadSummary(sessionId);
          setTimeout(() => setCommit((cur) => (cur.success === short ? { open: false, message: '', error: null, success: null } : cur)), 1800);
        } else {
          setCommit((cur) => ({ ...cur, error: res.error.message })); // FR-26, keep message + bar open
        }
      })
      .catch(() => setCommit((cur) => ({ ...cur, error: 'commit failed unexpectedly' })))
      .finally(() => {
        if (mountedRef.current) setBusy(false);
      });
  }, [busy, sessionId, loadSummary]);

  // Keyboard (FR-21/22/23/24). Active only while the DIFF tab is visible.
  useEffect(() => {
    if (mainTab !== 'diff') return;
    const onKey = (e: KeyboardEvent) => {
      if (commit.open) {
        if (e.key === 'Enter') {
          e.preventDefault();
          doCommit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          closeCommit();
        }
        return; // let all other keys type into the commit input
      }
      const ae = document.activeElement as HTMLElement | null;
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return; // FR-22/23 text-input guard
      if (e.key === 's' || e.key === 'S') {
        stageAll();
      } else if (e.key === 'c' || e.key === 'C') {
        openCommit();
      } else if (focusedPane === 'main' && e.key === 'ArrowRight') {
        e.preventDefault();
        cycle(1);
      } else if (focusedPane === 'main' && e.key === 'ArrowLeft') {
        e.preventDefault();
        cycle(-1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mainTab, focusedPane, commit.open, doCommit, closeCommit, stageAll, openCommit, cycle]);

  // ---------- render ----------

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, background: 'var(--bg-deep)' }}>
      {/* main area: vertical file selector (left) + diff body (right) */}
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {/* file list — a vertical selector (replaces the horizontal chip strip, which
            became unusable with many files). Renders nothing when empty (spec §8). */}
        {files.length > 0 && (
          <div
            className="scz"
            style={{ width: 236, flexShrink: 0, overflowY: 'auto', borderRight: `1px solid ${C.border}`, padding: '8px 6px' }}
          >
            <div
              onClick={toggleAll}
              title={allSelected ? 'deselect all' : 'select all'}
              style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '4px 8px 6px', cursor: 'pointer', color: C.base, fontSize: 10.5, textTransform: 'uppercase', letterSpacing: 0.4 }}
            >
              <Checkbox checked={allSelected} indeterminate={selectedCount > 0 && !allSelected} />
              <span>{selectedCount} of {files.length} selected</span>
            </div>
            {files.map((f) => (
              <FileRow
                key={f.path}
                f={f}
                selected={f.path === selectedPath}
                checked={!deselected.has(f.path)}
                onClick={() => setSelectedPath(f.path)}
                onToggle={() => toggleFile(f.path)}
              />
            ))}
          </div>
        )}

        {/* body */}
        <div ref={bodyScrollRef} className="scz" style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
          {notRepo ? (
            <EmptyState text="not a git repository — initialize with `git init` in the shell" />
          ) : summaryError ? (
            <EmptyState text={summaryError.message} color={C.del} />
          ) : summary && files.length === 0 ? (
            <EmptyState text="working tree clean" />
          ) : (
            <DiffBody loading={fileDiffLoading} error={fileDiffError} diff={fileDiff} scrollRef={bodyScrollRef} />
          )}
        </div>
      </div>

      {/* footer / commit bar — hidden entirely for a non-repo (nothing actionable) */}
      {!notRepo && (
        <Footer
          summary={summary}
          commit={commit}
          setMessage={(m) => setCommit((c) => ({ ...c, message: m }))}
          onCommit={doCommit}
          onCancel={closeCommit}
          onStage={stageAll}
          onOpenCommit={openCommit}
          inputRef={commitInputRef}
          stageInert={requestBusy || files.length === 0}
          commitInert={requestBusy || selectedCount === 0}
          selectedCount={selectedCount}
        />
      )}
    </div>
  );
}

// per-status glyph + color for the vertical file list (spec §8 status set).
const STATUS: Record<DiffFileStatus, { ch: string; color: string }> = {
  modified: { ch: 'M', color: 'var(--accent)' },
  added: { ch: 'A', color: 'var(--success)' },
  deleted: { ch: 'D', color: 'var(--error)' },
  untracked: { ch: 'U', color: 'var(--hue-blue)' },
  renamed: { ch: 'R', color: 'var(--hue-purple)' },
};

// A small terminal-styled checkbox: an accent-filled box with a ✓ when checked, a
// hollow box when unchecked, and a dash when indeterminate (the header's mixed state).
function Checkbox({ checked, indeterminate }: { checked: boolean; indeterminate?: boolean }) {
  const on = checked || indeterminate;
  return (
    <span
      style={{
        width: 13,
        height: 13,
        flexShrink: 0,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 3,
        border: `1px solid ${on ? C.accent : C.base}`,
        background: checked ? C.accent : 'transparent',
        color: 'var(--bg-deep)',
        fontSize: 10,
        lineHeight: 1,
        userSelect: 'none',
      }}
    >
      {checked ? '✓' : indeterminate ? <span style={{ width: 6, height: 1.5, background: C.accent }} /> : ''}
    </span>
  );
}

// One row in the vertical file selector: [✓] · status glyph · filename · +add/−del.
// The checkbox toggles whether the file is committed; clicking elsewhere views its
// diff. Full repo-relative path shows on hover (title); the dir is elided to keep
// rows dense.
function FileRow({ f, selected, checked, onClick, onToggle }: { f: DiffFileSummary; selected: boolean; checked: boolean; onClick: () => void; onToggle: () => void }) {
  const st = STATUS[f.status] ?? STATUS.modified;
  return (
    <div
      onClick={onClick}
      title={f.path}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 7,
        padding: '5px 8px',
        borderRadius: 4,
        cursor: 'pointer',
        marginBottom: 1,
        background: selected ? 'var(--bg-raised)' : 'transparent',
        borderLeft: `2px solid ${selected ? C.accent : 'transparent'}`,
      }}
    >
      <span
        onClick={(e) => {
          e.stopPropagation(); // toggle selection without changing which diff is shown
          onToggle();
        }}
        style={{ display: 'inline-flex', flexShrink: 0 }}
      >
        <Checkbox checked={checked} />
      </span>
      <span style={{ width: 9, flexShrink: 0, fontSize: 9.5, fontWeight: 700, textAlign: 'center', color: st.color }}>{st.ch}</span>
      <span style={{ flex: 1, minWidth: 0, fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: selected ? C.bright : C.name }}>
        {f.name}
      </span>
      {f.additions > 0 && <span style={{ flexShrink: 0, fontSize: 10, color: C.add }}>+{f.additions}</span>}
      {f.deletions > 0 && <span style={{ flexShrink: 0, fontSize: 10, color: C.del }}>−{f.deletions}</span>}
    </div>
  );
}

function EmptyState({ text, color }: { text: string; color?: string }) {
  return (
    <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12.5, color: color ?? C.faint, textAlign: 'center', padding: '0 24px' }}>
      {text}
    </div>
  );
}

interface FlatRow {
  kind: string;
  no: string;
  text: string;
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
  // windowed. Cheap for small diffs, essential for huge ones.
  const rows = useMemo<FlatRow[]>(() => {
    if (!diff || diff.binary) return [];
    const out: FlatRow[] = [];
    for (const h of diff.hunks as DiffHunk[]) {
      out.push({ kind: 'hunk', no: '', text: h.header });
      for (const l of h.lines as DiffLine[]) {
        out.push({ kind: l.kind, no: l.kind === 'del' ? String(l.oldNo ?? '') : String(l.newNo ?? ''), text: l.text });
      }
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

  if (error) return <Placeholder text={error.message} color={C.del} />;
  if (loading && !diff) return <Placeholder text="loading…" />;
  if (!diff) return null;
  if (diff.binary) return <Placeholder text="binary file" />;
  if (rows.length === 0) return <Placeholder text="no content changes" />;

  const start = Math.min(win.start, rows.length);
  const end = Math.min(win.end, rows.length);
  // 8px matches the original body padding; the spacers reserve the off-screen rows so
  // the scrollbar length stays correct.
  return (
    <div
      style={{
        paddingTop: 8 + start * ROW_H,
        paddingBottom: 8 + (rows.length - end) * ROW_H,
        fontSize: 12,
        lineHeight: `${ROW_H}px`,
      }}
    >
      {rows.slice(start, end).map((r, i) => (
        <Row key={start + i} kind={r.kind} no={r.no} text={r.text} />
      ))}
    </div>
  );
}

function Row({ kind, no, text }: { kind: string; no: string; text: string }) {
  const k = KIND[kind] ?? KIND.ctx;
  return (
    <div style={{ display: 'flex', background: k.bg, padding: '0 12px' }}>
      <span style={{ width: 34, flexShrink: 0, textAlign: 'right', paddingRight: 12, fontSize: 10.5, userSelect: 'none', color: k.noFg }}>{no}</span>
      <span style={{ width: 12, flexShrink: 0, userSelect: 'none', color: k.signFg }}>{k.sign}</span>
      <span style={{ whiteSpace: 'pre', color: k.fg }}>{text}</span>
    </div>
  );
}

function Placeholder({ text, color }: { text: string; color?: string }) {
  return <div style={{ padding: '16px 14px', fontSize: 12, color: color ?? C.faint }}>{text}</div>;
}

function Footer({
  summary,
  commit,
  setMessage,
  onCommit,
  onCancel,
  onStage,
  onOpenCommit,
  inputRef,
  stageInert,
  commitInert,
  selectedCount,
}: {
  summary: DiffSummary | null;
  commit: CommitState;
  setMessage: (m: string) => void;
  onCommit: () => void;
  onCancel: () => void;
  onStage: () => void;
  onOpenCommit: () => void;
  inputRef: React.RefObject<HTMLInputElement>;
  stageInert: boolean;
  commitInert: boolean;
  selectedCount: number;
}) {
  const totalAdd = summary?.totalAdd ?? 0;
  const totalDel = summary?.totalDel ?? 0;
  const nFiles = summary?.files.length ?? 0;
  const hintColor = (inert: boolean) => (inert ? C.inert : C.hint);

  return (
    <div style={{ padding: '10px 14px', borderTop: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', gap: 14, fontSize: 11, color: C.base, flexShrink: 0 }}>
      <span>
        <span style={{ color: C.add }}>+{totalAdd}</span> <span style={{ color: C.del }}>−{totalDel}</span>
        <span style={{ color: C.base }}> across {nFiles} files</span>
      </span>
      <span style={{ flex: 1 }} />

      {commit.open ? (
        commit.success ? (
          <span style={{ color: C.add }}>committed {commit.success}</span>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1, minWidth: 0, alignItems: 'flex-end' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, alignSelf: 'stretch', justifyContent: 'flex-end' }}>
              <span style={{ color: C.accent, fontSize: 13 }}>›</span>
              <input
                ref={inputRef}
                className="diff-commit-input"
                value={commit.message}
                placeholder="commit message…"
                onChange={(e) => setMessage(e.target.value)}
                style={{ flex: 1, maxWidth: 320, minWidth: 80, border: 'none', outline: 'none', background: 'transparent', fontFamily: 'inherit', fontSize: 12.5, color: commit.message ? C.bright : C.faint }}
              />
              <span onClick={onCommit} style={{ color: C.hint, cursor: 'pointer' }}>⏎ commit</span>
              <span onClick={onCancel} style={{ color: C.hint, cursor: 'pointer' }}>esc cancel</span>
            </div>
            {commit.error && <span style={{ color: C.del, fontSize: 10.5 }}>{commit.error}</span>}
          </div>
        )
      ) : (
        <>
          <span onClick={() => !stageInert && onStage()} style={{ color: hintColor(stageInert), cursor: stageInert ? 'default' : 'pointer' }}>
            [s] stage all
          </span>
          <span onClick={() => !commitInert && onOpenCommit()} style={{ color: hintColor(commitInert), cursor: commitInert ? 'default' : 'pointer' }}>
            [c] commit {selectedCount > 0 ? `${selectedCount} ` : ''}…
          </span>
        </>
      )}
    </div>
  );
}
