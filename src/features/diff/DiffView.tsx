import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { DiffCommitSummary } from '../../../contract/diff-view';
import { diffCommit, sessionOpenInEditor } from '../../lib/api';
import { getEditorList } from '../sessions/editors';
import { useStore } from '../../lib/store';
import { IS_WINDOWS } from '../../lib/platform';
import { siblingWorktreeSummaryLine } from '../sessions/worktree';
import { DiffTopBar } from './DiffTopBar';
import { DiffRail, DEFAULT_RAIL_WIDTH } from './DiffRail';
import { DiffBody } from './DiffBody';
import { DiffCommitBlock } from './DiffCommitBlock';
import { EXPANDED_CONTEXT, offsetForPath, type BlockOffset } from './diff-body';
import { diffUiReducer, initDiffUiState, WORKTREE_REF } from './diff-state';
import { descendantFilePaths, folderRollup, treeOrderFiles, type DiffTreeNode } from './diff-tree';
import { useDiffFeed } from './useDiffFeed';
import { useDiffKeyboard } from './useDiffKeyboard';
import { useDiffNavigator } from './useDiffNavigator';
import './diff.css';

const EMPTY_READ_SET: Set<string> = new Set();

export default function DiffView({ sessionId }: { sessionId: string }) {
  const focusedPane = useStore((s) => s.focusedPane);
  const mainTab = useStore((s) => s.mainTab);
  // session-worktree FR-15: dim, read-only sibling-worktree hint. Derived purely
  // from the session cache — no new IPC, no persistence.
  const sessions = useStore((s) => s.sessions);
  const meta = sessions.find((s) => s.id === sessionId) ?? null;
  const siblingLine = meta ? siblingWorktreeSummaryLine(meta, sessions, IS_WINDOWS) : null;

  const [ui, dispatch] = useReducer(diffUiReducer, undefined, initDiffUiState);
  const onExternalChange = useCallback(() => dispatch({ type: 'flagWorkingTreeChanged' }), []);

  const feed = useDiffFeed(sessionId, ui.viewingCommit, onExternalChange);
  const { summary, summaryError, summaryLoading, notRepo, files, commits, commitsError, fileDiffs, requestFileContext, reload, mountedRef } = feed;

  // FR-1 seeding / §7 path enter-leave — only meaningful for the working tree; a
  // read-only commit view's file list never feeds the staging set.
  useEffect(() => {
    if (ui.viewingCommit !== null) return;
    dispatch({ type: 'syncFiles', paths: files.map((f) => f.path) });
  }, [files, ui.viewingCommit]);

  const orderedFiles = useMemo(() => treeOrderFiles(files), [files]);

  const bodyScrollRef = useRef<HTMLDivElement>(null);
  const offsetsRef = useRef<BlockOffset[]>([]);
  const onOffsetsChange = useCallback((offsets: BlockOffset[]) => {
    offsetsRef.current = offsets;
  }, []);

  // FR-8: jump, never switch — scrolls the body's own container to that file's
  // sticky header, changing no other state.
  const jumpToFile = useCallback((path: string) => {
    const offset = offsetForPath(offsetsRef.current, path);
    if (offset !== null && bodyScrollRef.current) bodyScrollRef.current.scrollTop = offset;
  }, []);

  const currentRef = ui.viewingCommit ?? WORKTREE_REF;
  const readSet = ui.read.get(currentRef) ?? EMPTY_READ_SET;

  const navigator = useDiffNavigator({
    files,
    inCommit: ui.inCommit,
    folded: ui.folded,
    filter: ui.filter,
    railMode: ui.railMode,
    cursorKey: ui.cursorKey,
    dispatch,
    onJumpToFile: jumpToFile,
  });

  // FR-7: the directory checkbox write — every descendant file flips to the
  // opposite of the row's current roll-up state.
  const onToggleDirectory = useCallback(
    (node: DiffTreeNode) => {
      const paths = descendantFilePaths(node);
      const checked = folderRollup(node, ui.inCommit) === 'checked';
      dispatch({ type: 'setInCommit', paths, checked: !checked });
    },
    [ui.inCommit],
  );

  const [railWidth, setRailWidth] = useState(DEFAULT_RAIL_WIDTH);

  const onOpenEditor = useCallback(
    (path: string) => {
      // FR-27: the first available editor from EDITOR_ORDER, no menu.
      void getEditorList().then((editors) => {
        if (editors.length === 0) return;
        void sessionOpenInEditor({ sessionId, editorId: editors[0]!.id, path });
      });
    },
    [sessionId],
  );

  const onExpandContext = useCallback(
    (path: string) => {
      dispatch({ type: 'setContext', path, context: EXPANDED_CONTEXT });
      requestFileContext(path, EXPANDED_CONTEXT);
    },
    [requestFileContext],
  );

  const onBigFile = useCallback((path: string) => dispatch({ type: 'ensureCollapsed', paths: [path] }), []);
  const onReadPaths = useCallback((paths: string[]) => dispatch({ type: 'markRead', paths, ref: currentRef }), [currentRef]);
  const doCollapseRead = useCallback(() => dispatch({ type: 'collapseRead', ref: currentRef }), [currentRef]);

  const onSelectCommit = useCallback((hash: string) => dispatch({ type: 'viewCommit', hash }), []);
  const onBackToWorktree = useCallback(() => dispatch({ type: 'backToWorktree' }), []);

  const headCommit = useMemo(() => commits?.commits.find((c) => c.isHead) ?? null, [commits]);

  const subjectInputRef = useRef<HTMLInputElement>(null);

  const openCommit = useCallback(() => {
    dispatch({ type: 'openCommit' });
    requestAnimationFrame(() => subjectInputRef.current?.focus());
  }, []);
  const closeCommit = useCallback(() => dispatch({ type: 'closeCommit' }), []);

  // FR-16: alt-clicking HEAD arms amend and opens the form, without switching the
  // body into the read-only commit view.
  const onAltClickHead = useCallback((commit: DiffCommitSummary) => {
    dispatch({ type: 'setAmend', amend: true, headSubject: commit.subject, headBody: commit.body });
    dispatch({ type: 'openCommit' });
    requestAnimationFrame(() => subjectInputRef.current?.focus());
  }, []);

  const onSetAmend = useCallback(
    (amend: boolean) => dispatch({ type: 'setAmend', amend, headSubject: headCommit?.subject ?? '', headBody: headCommit?.body ?? '' }),
    [headCommit],
  );

  const [busy, setBusy] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);
  // Side effects live OUTSIDE any state updater / read via refs so a double-invoke
  // can't fire the commit twice and doCommit always sees the LATEST draft/inCommit
  // without needing them in its own dependency array.
  const draftRef = useRef(ui.draft);
  draftRef.current = ui.draft;
  const inCommitRef = useRef(ui.inCommit);
  inCommitRef.current = ui.inCommit;

  const doCommit = useCallback(() => {
    const draft = draftRef.current;
    const subject = draft.subject.trim();
    const paths = [...inCommitRef.current];
    if (busy || subject === '' || paths.length === 0) return; // FR-36/FR-37: blank subject / nothing checked = no-op
    setBusy(true);
    setCommitError(null);
    void diffCommit({ sessionId, message: subject, body: draft.body.trim() || undefined, paths, amend: draft.amend })
      .then((res) => {
        if (res.ok) {
          dispatch({ type: 'commitSucceeded', paths });
          reload();
        } else {
          setCommitError(res.error.message);
        }
      })
      .catch(() => setCommitError('commit failed unexpectedly'))
      .finally(() => {
        if (mountedRef.current) setBusy(false);
      });
  }, [busy, sessionId, reload, mountedRef]);

  useDiffKeyboard({
    mainTab,
    focusedPane,
    commitOpen: ui.commitOpen,
    doCommit,
    closeCommit,
    openCommit,
    setFilter: (v) => dispatch({ type: 'setFilter', value: v }),
    filterInputRef: navigator.filterInputRef,
    onCursorUp: navigator.onCursorUp,
    onCursorDown: navigator.onCursorDown,
    onCursorRight: navigator.onCursorRight,
    onCursorLeft: navigator.onCursorLeft,
    onCursorEnter: navigator.onCursorEnter,
    onCursorSpace: navigator.onCursorSpace,
  });

  const totalFiles = files.length;
  const totalRead = readSet.size;
  const viewingShortHash = ui.viewingCommit
    ? (commits?.commits.find((c) => c.hash === ui.viewingCommit)?.shortHash ?? ui.viewingCommit.slice(0, 7))
    : null;

  return (
    <div className="diff-view">
      {siblingLine && (
        <div className="diff-sibling-line" title={siblingLine}>
          {siblingLine}
        </div>
      )}
      <DiffTopBar
        branch={summary?.branch ?? null}
        headShort={summary?.headShort ?? null}
        viewingShortHash={viewingShortHash}
        totalAdd={summary?.totalAdd ?? 0}
        totalDel={summary?.totalDel ?? 0}
        collapseReadInert={totalRead === 0}
        onCollapseRead={doCollapseRead}
        reloadInert={summaryLoading}
        onReload={reload}
      />
      <div className="diff-main">
        <DiffRail
          width={railWidth}
          onWidthChange={setRailWidth}
          visibleRows={navigator.visibleRows}
          railMode={ui.railMode}
          filter={ui.filter}
          filterInputRef={navigator.filterInputRef}
          cursorKey={ui.cursorKey}
          inCommit={ui.inCommit}
          readSet={readSet}
          rollup={navigator.rollup}
          totalFiles={totalFiles}
          checkedCount={ui.inCommit.size}
          readCount={totalRead}
          commits={commits}
          commitsError={commitsError}
          commitsExpanded={ui.commitsExpanded}
          viewingCommit={ui.viewingCommit}
          onFilterChange={(v) => dispatch({ type: 'setFilter', value: v })}
          onSetRailMode={(mode) => dispatch({ type: 'setRailMode', mode })}
          onToggleFold={(key) => dispatch({ type: 'toggleFold', key })}
          onJumpToFile={jumpToFile}
          onToggleFile={(path) => dispatch({ type: 'toggleInCommit', path })}
          onToggleDirectory={onToggleDirectory}
          onToggleReadTick={(path) => dispatch({ type: 'toggleRead', path, ref: currentRef })}
          onSelectCommit={onSelectCommit}
          onAltClickHead={onAltClickHead}
          onToggleCommitsExpanded={() => dispatch({ type: 'toggleCommitsExpanded' })}
        />
        <div ref={bodyScrollRef} className="diff-body">
          <DiffBody
            files={orderedFiles}
            fileDiffs={fileDiffs}
            collapsed={ui.collapsed}
            inCommit={ui.inCommit}
            readSet={readSet}
            readOnly={ui.viewingCommit !== null}
            notRepo={notRepo}
            summaryLoaded={summary !== null}
            summaryErrorMessage={summaryError && !notRepo ? summaryError.message : null}
            scrollRef={bodyScrollRef}
            onToggleCollapse={(path) => dispatch({ type: 'toggleCollapse', path })}
            onToggleInCommit={(path) => dispatch({ type: 'toggleInCommit', path })}
            onOpenEditor={onOpenEditor}
            onExpandContext={onExpandContext}
            onBigFile={onBigFile}
            onReadPaths={onReadPaths}
            onOffsetsChange={onOffsetsChange}
          />
        </div>
      </div>
      {!notRepo && (
        <DiffCommitBlock
          files={files}
          inCommit={ui.inCommit}
          readCount={totalRead}
          totalFiles={totalFiles}
          hiddenChecked={navigator.hiddenChecked}
          viewingCommit={ui.viewingCommit}
          viewingShortHash={viewingShortHash}
          workingTreeChanged={ui.workingTreeChanged}
          onBackToWorktree={onBackToWorktree}
          open={ui.commitOpen}
          onOpenStrip={openCommit}
          onCloseForm={closeCommit}
          draft={ui.draft}
          onDraftChange={(patch) => dispatch({ type: 'setDraft', patch })}
          onSetAmend={onSetAmend}
          headPushed={headCommit?.pushed ?? false}
          busy={busy}
          error={commitError}
          onCommit={doCommit}
          subjectInputRef={subjectInputRef}
        />
      )}
    </div>
  );
}
