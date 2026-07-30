import { useCallback, useRef, useState } from 'react';
import type { DiffSummary } from '../../../contract/diff-view';
import { diffCommit, diffStageAll } from '../../lib/api';
import { useStore } from '../../lib/store';
import { DiffListBody } from './DiffListBody';
import { useDiffFeed } from './useDiffFeed';
import { useDiffKeyboard } from './useDiffKeyboard';
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
    cycle,
    fileDiff,
    fileDiffError,
    fileDiffLoading,
    loadSummary,
    mountedRef,
  } = feed;

  const [commit, setCommit] = useState<CommitState>({ open: false, message: '', error: null, success: null });
  const [busy, setBusy] = useState(false);

  const commitInputRef = useRef<HTMLInputElement>(null);
  const bodyScrollRef = useRef<HTMLDivElement>(null);
  const commitRef = useRef(commit); // latest commit state, read by doCommit outside any updater
  commitRef.current = commit;
  const selectedPathsRef = useRef<string[]>([]);
  selectedPathsRef.current = selectedPaths; // read by doCommit without re-creating it

  const requestBusy = busy || summaryLoading || fileDiffLoading; // any request in flight (FR-22/23)

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

  // Keyboard (FR-21/22/23/24). Active only while the DIFF tab is visible.
  useDiffKeyboard({
    mainTab,
    focusedPane,
    commitOpen: commit.open,
    doCommit,
    closeCommit,
    stageAll,
    openCommit,
    cycle,
  });

  // ---------- render ----------

  return (
    <div className="diff-view">
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
        onSelectPath={setSelectedPath}
        onToggleFile={toggleFile}
        onToggleAll={toggleAll}
      />

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

  return (
    <div className="diff-footer">
      <span>
        <span className="diff-color-add">+{totalAdd}</span> <span className="diff-color-del">−{totalDel}</span>
        <span> across {nFiles} files</span>
      </span>
      <span className="diff-footer__spacer" />

      {commit.open ? (
        commit.success ? (
          <span className="diff-color-add">committed {commit.success}</span>
        ) : (
          <div className="diff-commit-form">
            <div className="diff-commit-row">
              <span className="diff-commit-prompt">›</span>
              <input
                ref={inputRef}
                className="diff-commit-input"
                value={commit.message}
                placeholder="commit message…"
                onChange={(e) => setMessage(e.target.value)}
                style={{ color: commit.message ? 'var(--text-bright)' : 'var(--text-faint)' }}
              />
              <span onClick={onCommit} className="diff-commit-action">⏎ commit</span>
              <span onClick={onCancel} className="diff-commit-action">esc cancel</span>
            </div>
            {commit.error && <span className="diff-commit-error">{commit.error}</span>}
          </div>
        )
      ) : (
        <>
          <span onClick={() => !stageInert && onStage()} className={`diff-footer__hint${stageInert ? ' diff-footer__hint--inert' : ''}`}>
            [s] stage all
          </span>
          <span onClick={() => !commitInert && onOpenCommit()} className={`diff-footer__hint${commitInert ? ' diff-footer__hint--inert' : ''}`}>
            [c] commit {selectedCount > 0 ? `${selectedCount} ` : ''}…
          </span>
        </>
      )}
    </div>
  );
}
