import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import type { AppError } from '../../../contract/common';
import type { DiffCommitList, DiffFileSummary, DiffSummary, FileDiff } from '../../../contract/diff-view';
import { diffGetFileDiff, diffGetSummary, diffListCommits, onDiffEvent } from '../../lib/api';
import { nextDiffEventAction } from './diff-events';

export interface FileDiffEntry {
  diff: FileDiff | null;
  error: AppError | null;
  loading: boolean;
}

export interface DiffFeed {
  summary: DiffSummary | null;
  summaryError: AppError | null;
  summaryLoading: boolean;
  notRepo: boolean;
  files: DiffFileSummary[];

  commits: DiffCommitList | null;
  commitsError: AppError | null;

  fileDiffs: Map<string, FileDiffEntry>;
  /** FR-26: re-fetch one file's diff with a wider `-U<n>` context, removing every
   *  fold row that context now covers. */
  requestFileContext: (path: string, context: number) => void;

  /** FR-2 `⟳` refresh. */
  reload: () => void;

  mountedRef: MutableRefObject<boolean>;
}

/**
 * Summary + commits + every changed file's diff for one session's DIFF tab
 * (spec §5/§6). `viewingCommit` (null = working tree) re-points getSummary/
 * getFileDiff at that commit's diff vs its first parent (FR-15); a read-only
 * commit view never refetches on its own — §7 "the strip is a snapshot".
 *
 * The hydrate/subscribe effect keeps the diff-view echo-swallow/coalescing guard
 * (see diff-events.ts): a plain working-tree getSummary broadcasts one diff.changed
 * echo of its own, which must be consumed rather than re-triggering a fetch. While
 * viewing a commit no working-tree getSummary happens, so any diff.changed that
 * arrives is genuinely external — it only flags `onExternalChange` (the caller sets
 * DiffUiState.workingTreeChanged) rather than refetching the frozen body (§7).
 */
export function useDiffFeed(sessionId: string, viewingCommit: string | null, onExternalChange: () => void): DiffFeed {
  const [summary, setSummary] = useState<DiffSummary | null>(null);
  const [summaryError, setSummaryError] = useState<AppError | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [commits, setCommits] = useState<DiffCommitList | null>(null);
  const [commitsError, setCommitsError] = useState<AppError | null>(null);
  const [fileDiffs, setFileDiffs] = useState<Map<string, FileDiffEntry>>(new Map());

  const mountedRef = useRef(true);
  const pendingEchoRef = useRef(0);
  const summaryInFlightRef = useRef(false);
  const refreshQueuedRef = useRef(false);
  const contextRef = useRef<Map<string, number>>(new Map());
  const onExternalChangeRef = useRef(onExternalChange);
  onExternalChangeRef.current = onExternalChange;

  const notRepo = summaryError?.code === 'NOT_A_GIT_REPO';
  const files = useMemo(() => summary?.files ?? [], [summary]);

  const loadSummary = useCallback((sid: string, commit: string | null) => {
    const worktree = commit === null;
    const run = () => {
      summaryInFlightRef.current = true;
      if (worktree) pendingEchoRef.current += 1; // only a plain getSummary broadcasts an echo
      setSummaryLoading(true);
      void diffGetSummary(sid, commit ?? undefined)
        .then((res) => {
          if (!res.ok && worktree) pendingEchoRef.current = Math.max(0, pendingEchoRef.current - 1);
          if (!mountedRef.current) return;
          setSummaryLoading(false);
          if (res.ok) {
            setSummary(res.data);
            setSummaryError(null);
          } else {
            setSummary(null);
            setSummaryError(res.error);
          }
        })
        .catch(() => {
          if (worktree) pendingEchoRef.current = Math.max(0, pendingEchoRef.current - 1);
          if (mountedRef.current) setSummaryLoading(false);
        })
        .finally(() => {
          summaryInFlightRef.current = false;
          if (refreshQueuedRef.current && mountedRef.current) {
            refreshQueuedRef.current = false;
            run();
          }
        });
    };
    run();
  }, []);

  const loadCommits = useCallback((sid: string) => {
    void diffListCommits(sid).then((res) => {
      if (!mountedRef.current) return;
      if (res.ok) {
        setCommits(res.data);
        setCommitsError(null);
      } else {
        setCommits(null);
        setCommitsError(res.error);
      }
    });
  }, []);

  const fetchOne = useCallback(
    (sid: string, path: string, commit: string | null, context: number | undefined) => {
      setFileDiffs((prev) => {
        const next = new Map(prev);
        next.set(path, { diff: prev.get(path)?.diff ?? null, error: null, loading: true });
        return next;
      });
      void diffGetFileDiff(sid, path, { commit: commit ?? undefined, context }).then((res) => {
        if (!mountedRef.current) return;
        setFileDiffs((prev) => {
          const next = new Map(prev);
          next.set(path, res.ok ? { diff: res.data, error: null, loading: false } : { diff: null, error: res.error, loading: false });
          return next;
        });
      });
    },
    [],
  );

  const requestFileContext = useCallback(
    (path: string, context: number) => {
      contextRef.current.set(path, context);
      fetchOne(sessionId, path, viewingCommit, context);
    },
    [sessionId, viewingCommit, fetchOne],
  );

  const reload = useCallback(() => {
    loadSummary(sessionId, viewingCommit);
    loadCommits(sessionId);
  }, [sessionId, viewingCommit, loadSummary, loadCommits]);

  // The listener closure below is registered once per session; it reads the LATEST
  // viewingCommit through this ref rather than resubscribing on every ref switch.
  const viewingCommitLatest = useRef(viewingCommit);
  viewingCommitLatest.current = viewingCommit;

  // Hydrate + live diff.changed, once per session mount (DiffView keys this hook by
  // sessionId — see DiffView.tsx). Registers the listener BEFORE the first fetch so
  // that fetch's own echo is guaranteed to be consumed by the counter (N1 guard,
  // carried over from diff-view's original hydrate effect).
  useEffect(() => {
    mountedRef.current = true;
    let unlisten: (() => void) | undefined;
    void onDiffEvent((e) => {
      const action = nextDiffEventAction(e, sessionId, pendingEchoRef.current, summaryInFlightRef.current);
      if (action === 'ignore') return;
      if (viewingCommitLatest.current !== null) {
        // §7: a frozen commit view never refetches on its own — flag instead.
        if (action !== 'consumeEcho') onExternalChangeRef.current();
        return;
      }
      switch (action) {
        case 'consumeEcho':
          pendingEchoRef.current -= 1;
          return;
        case 'queueRefresh':
          refreshQueuedRef.current = true;
          return;
        case 'refetch':
          loadSummary(sessionId, null);
          loadCommits(sessionId);
          return;
      }
    }).then((unsub) => {
      if (!mountedRef.current) {
        unsub();
        return;
      }
      unlisten = unsub;
      loadSummary(sessionId, null);
      loadCommits(sessionId);
    });
    return () => {
      mountedRef.current = false;
      if (unlisten) unlisten();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by sessionId only; viewingCommit read via the ref above
  }, [sessionId]);

  // Re-fetch the summary whenever the viewed ref changes AFTER mount (the mount's
  // own initial fetch is handled by the hydrate effect above, always against the
  // working tree, matching viewingCommit's initial value of null).
  const didMountRef = useRef(false);
  useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true;
      return;
    }
    loadSummary(sessionId, viewingCommit);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally excludes sessionId (that's the hydrate effect's job)
  }, [viewingCommit]);

  // Fetch every current file's diff whenever the file list or the viewed ref
  // changes. Eager, not viewport-lazy — see the frontend handoff TODO.
  useEffect(() => {
    const paths = files.map((f) => f.path);
    setFileDiffs((prev) => {
      const next = new Map(prev);
      for (const key of Array.from(next.keys())) if (!paths.includes(key)) next.delete(key);
      return next;
    });
    paths.forEach((path) => fetchOne(sessionId, path, viewingCommit, contextRef.current.get(path)));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetchOne is stable; re-run only on file-list/ref identity change
  }, [files, viewingCommit, sessionId]);

  return {
    summary,
    summaryError,
    summaryLoading,
    notRepo,
    files,
    commits,
    commitsError,
    fileDiffs,
    requestFileContext,
    reload,
    mountedRef,
  };
}
