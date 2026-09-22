import { useCallback, useRef, useState } from 'react';
import type { DiffFileSummary, DiffSummary } from '../../../contract/diff-view';
import { diffCommit, diffStageAll } from '../../lib/api';
import { useStore } from '../../lib/store';
import { Button } from '../../ui/Button';
import { Meter } from '../../ui/Meter';
import { IS_WINDOWS } from '../../lib/platform';
import { siblingWorktreeSummaryLine } from '../sessions/worktree';
import { DiffListBody } from './DiffListBody';
import { reviewProgress, useDiffReviewStore, useReviewMarks, type ReviewProgress } from './review-state';
import { useDiffFeed } from './useDiffFeed';
import { useDiffKeyboard } from './useDiffKeyboard';
import { useDiffNavigator } from './useDiffNavigator';
import './diff.css';

interface CommitState {
  open: boolean;
  message: string;
  error: string | null;
  success: string | null; // short hash
}

export default function DiffView({ sessionId }: { sessionId: string }) {
  const focusedPane = useStore((s) => s.focusedPane);
  const mainTab = useStore((s) => s.mainTab);
  // session-worktree FR-15: dim, read-only sibling-worktree hint. Derived purely
  // from the session cache — no new IPC, no persistence.
  const sessions = useStore((s) => s.sessions);
  const meta = sessions.find((s) => s.id === sessionId) ?? null;
  const siblingLine = meta ? siblingWorktreeSummaryLine(meta, sessions, IS_WINDOWS) : null;

  const feed = useDiffFeed(sessionId);
  const {
    summary,
    summaryError,
    summaryLoading,
    notRepo,
    files,
    selectedPath,
    setSelectedPath,
    deselected,
    toggleFile,
    toggleAll,
    selectedPaths,
    selectedCount,
    allSelected,
    fileDiff,
    fileDiffError,
    fileDiffLoading,
    loadSummary,
    mountedRef,
  } = feed;

  // diff-navigator FR-4/5/9/17/18/19: tree fold state, filter and the keyboard
  // cursor, replacing the flat file cycle.
  const navigator = useDiffNavigator({ files, deselected, selectedPath, setSelectedPath });

  const [commit, setCommit] = useState<CommitState>({ open: false, message: '', error: null, success: null });
  const [busy, setBusy] = useState(false);

  const commitInputRef = useRef<HTMLInputElement>(null);
  const bodyScrollRef = useRef<HTMLDivElement>(null);
  const commitRef = useRef(commit); // latest commit state, read by doCommit outside any updater
  commitRef.current = commit;
  const selectedPathsRef = useRef<string[]>([]);
  selectedPathsRef.current = selectedPaths; // read by doCommit without re-creating it

  // Only a mutation (stage/commit) or a summary reload gates the footer actions. The
  // per-file diff fetch deliberately does NOT: it fires on every file click, and
  // including it made [s]/[c] go inert (and stay inert if that fetch never settled)
  // just from clicking through the file list — staging and committing are unaffected
  // by which file's diff is on screen.
  const requestBusy = busy || summaryLoading;

  const stageAll = useCallback(() => {
    if (requestBusy || notRepo || files.length === 0) return; // FR-22 inert
    setBusy(true);
    void diffStageAll(sessionId)
      .then(() => loadSummary(sessionId)) // fresh summary (FR-4 flow)
      .finally(() => {
        if (mountedRef.current) setBusy(false);
      });
  }, [requestBusy, notRepo, files.length, sessionId, loadSummary, mountedRef]);

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
  }, [busy, sessionId, loadSummary, mountedRef]);

  // Keyboard (FR-10/17/18/19). Active only while the DIFF tab is visible.
  useDiffKeyboard({
    mainTab,
    focusedPane,
    commitOpen: commit.open,
    doCommit,
    closeCommit,
    stageAll,
    openCommit,
    setFilter: navigator.setFilter,
    filterInputRef: navigator.filterInputRef,
    onCursorUp: navigator.onCursorUp,
    onCursorDown: navigator.onCursorDown,
    onCursorRight: navigator.onCursorRight,
    onCursorLeft: navigator.onCursorLeft,
    onCursorEnter: navigator.onCursorEnter,
  });

  // "Mark reviewed" (review-state.ts): in-memory, per session.
  const reviewMarks = useReviewMarks(sessionId);
  const toggleReviewedFile = useCallback((file: DiffFileSummary) => useDiffReviewStore.getState().toggle(sessionId, file), [sessionId]);
  const progress = reviewProgress(files, reviewMarks);

  // ---------- render ----------

  return (
    <div className="diff-view">
      {/* review bar (Figma 135:5161) — hidden entirely for a non-repo (nothing actionable) */}
      {!notRepo && (
        <ReviewBar
          summary={summary}
          progress={progress}
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
          totalFiles={files.length}
          hiddenChecked={navigator.hiddenChecked}
        />
      )}
      {/* session-worktree FR-15: read-only — no links, no buttons, no hover affordance.
          A truncated value always carries its full text in a title. */}
      {siblingLine && (
        <div className="diff-sibling-line" title={siblingLine}>
          {siblingLine}
        </div>
      )}
      <DiffListBody
        files={files}
        selectedPath={selectedPath}
        deselected={deselected}
        allSelected={allSelected}
        selectedCount={selectedCount}
        notRepo={notRepo}
        summaryError={summaryError}
        summary={summary}
        fileDiff={fileDiff}
        fileDiffError={fileDiffError}
        fileDiffLoading={fileDiffLoading}
        bodyScrollRef={bodyScrollRef}
        navigator={navigator}
        onSelectPath={setSelectedPath}
        onToggleFile={toggleFile}
        onToggleAll={toggleAll}
        reviewMarks={reviewMarks}
        onToggleReviewed={toggleReviewedFile}
      />
    </div>
  );
}

function ReviewBar({
  summary,
  progress,
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
  totalFiles,
  hiddenChecked,
}: {
  summary: DiffSummary | null;
  progress: ReviewProgress;
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
  totalFiles: number;
  hiddenChecked: number;
}) {
  const totalAdd = summary?.totalAdd ?? 0;
  const totalDel = summary?.totalDel ?? 0;
  const nFiles = summary?.files.length ?? 0;
  // "Commit…" commits the files ticked in the tree; say how many when it is not all of them.
  const commitLabel = selectedCount > 0 && selectedCount < totalFiles ? `Commit ${selectedCount}…` : 'Commit…';

  return (
    <div className="diff-review-bar">
      <span className="diff-review-bar__stat">
        <span className="diff-color-add">+{totalAdd}</span> <span className="diff-color-del">−{totalDel}</span>
      </span>
      <span className="diff-review-bar__count">
        {nFiles} {nFiles === 1 ? 'file' : 'files'} · {progress.reviewed} reviewed
      </span>
      {nFiles > 0 && (
        <Meter
          fraction={progress.fraction}
          width={120}
          className="diff-review-bar__meter"
          title={`${progress.reviewed} of ${progress.total} files reviewed`}
        />
      )}
      {/* diff-navigator FR-26: a statement, not an alarm — nothing is blocked. */}
      {hiddenChecked > 0 && <span className="diff-review-bar__hidden">{hiddenChecked} in commit but hidden by the filter</span>}
      <span className="diff-review-bar__spacer" />

      {commit.open ? (
        commit.success ? (
          <span className="diff-review-bar__committed">Committed {commit.success}</span>
        ) : (
          <div className="diff-commit-form">
            <div className="diff-commit-row">
              <input
                ref={inputRef}
                className="diff-commit-input"
                value={commit.message}
                placeholder="Commit message"
                aria-label="Commit message"
                onChange={(e) => setMessage(e.target.value)}
              />
              <Button variant="ghost" onClick={onCancel} shortcut="esc">
                Cancel
              </Button>
              <Button variant="primary" onClick={onCommit} disabled={commit.message.trim() === ''} shortcut="⏎">
                Commit
              </Button>
            </div>
            {commit.error && <span className="diff-commit-error">{commit.error}</span>}
          </div>
        )
      ) : (
        <>
          <Button onClick={onStage} disabled={stageInert} title="Stage all  [s]">
            Stage all
          </Button>
          <Button variant="primary" onClick={onOpenCommit} disabled={commitInert} title="Commit the files ticked in the tree  [c]">
            {commitLabel}
          </Button>
        </>
      )}
    </div>
  );
}
