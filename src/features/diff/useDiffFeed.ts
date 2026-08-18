import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import type { AppError } from '../../../contract/common';
import type { DiffFileSummary, DiffSummary, FileDiff } from '../../../contract/diff-view';
import { diffGetFileDiff, diffGetSummary, onDiffEvent } from '../../lib/api';
import { nextDiffEventAction } from './diff-events';
import { firstFilePathInTreeOrder } from './diff-tree';

export interface DiffFeed {
  summary: DiffSummary | null;
  summaryError: AppError | null;
  summaryLoading: boolean;
  notRepo: boolean;
  files: DiffFileSummary[];

  selectedPath: string | null;
  setSelectedPath: (path: string | null) => void;
  deselected: Set<string>;
  toggleFile: (path: string) => void;
  toggleAll: () => void;
  selectedPaths: string[];
  selectedCount: number;
  allSelected: boolean;

  fileDiff: FileDiff | null;
  fileDiffError: AppError | null;
  fileDiffLoading: boolean;

  loadSummary: (sid: string) => void;
  /** True while DiffView is mounted — shared with the subscription effect below so
   *  commit/stage flows in DiffView can skip a setState after an async response
   *  settles post-unmount. */
  mountedRef: MutableRefObject<boolean>;
}

/**
 * Summary + selected-file-diff data for one session's DIFF tab: hydrate + live
 * diff.changed subscription, file-selection state, and vertical-list cycling.
 *
 * The hydrate effect below is intentionally NOT built on the shared
 * useHydratedSubscription hook (see REFACTOR-CONVENTIONS.md "known gaps"): it
 * registers its listener BEFORE the first getSummary specifically to count and
 * swallow that fetch's own diff.changed echo (FR-17, pendingEchoRef), and it
 * coalesces concurrent refreshes (summaryInFlightRef / refreshQueuedRef). Left
 * structurally unchanged — do not restructure this guard logic.
 */
export function useDiffFeed(sessionId: string): DiffFeed {
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
  const [summaryLoading, setSummaryLoading] = useState(false);

  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedPath;
  const mountedRef = useRef(true);
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
  const selectedPaths = useMemo(() => files.filter((file) => !deselected.has(file.path)).map((file) => file.path), [files, deselected]);
  const selectedCount = selectedPaths.length;
  const allSelected = files.length > 0 && selectedCount === files.length;

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
    setDeselected((prev) => (files.length > 0 && files.every((file) => !prev.has(file.path)) ? new Set(files.map((file) => file.path)) : new Set()));
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
            const keep = prev && res.data.files.some((file) => file.path === prev);
            // Tree order, not path order: subfolders render before same-level files, so
            // files[0] is not the first row the user sees (spec §3 story 1).
            setSelectedPath(keep ? prev : firstFilePathInTreeOrder(res.data.files));
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
      switch (nextDiffEventAction(e, sessionId, pendingEchoRef.current, summaryInFlightRef.current)) {
        case 'ignore':
          return;
        case 'consumeEcho':
          pendingEchoRef.current -= 1; // our own getSummary echo — do not refetch
          return;
        case 'queueRefresh':
          refreshQueuedRef.current = true; // fold the burst into one trailing re-run
          return;
        case 'refetch':
          loadSummary(sessionId); // external change
          return;
      }
    }).then((unsub) => {
      if (!mountedRef.current) {
        unsub();
        return;
      }
      unlisten = unsub;
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
      setFileDiffLoading(false); // a fetch in flight when the selection cleared would otherwise leave this stuck true
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
    }).catch(() => {
      // A transport-level rejection (as opposed to a Result error) must still clear the
      // in-flight flag — without this the loader stuck true forever.
      if (mounted.current) setFileDiffLoading(false);
    });
    return () => {
      mounted.current = false;
    };
  }, [sessionId, selectedPath, loadSummary]);

  return {
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
  };
}
