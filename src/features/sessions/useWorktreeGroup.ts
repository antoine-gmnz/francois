// useWorktreeGroup — session-worktree FR-1..FR-5 + attach-to-worktree FR-1..FR-17,
// extracted from NewSessionModal the same way useModelCatalog/useProjectDefaults/
// useDirectoryPicker were: the modal owns layout and submission, each hook owns
// one field group's state and its effects. All the decision logic itself stays
// pure in ./worktree.ts.
//
// attach-to-worktree turned the old boolean "worktreeEnabled" into a three-state
// `mode` ('off' | 'create' | 'attach'). `create` keeps every session-worktree
// behaviour (branch/baseRef/preview/recovery) unchanged; `attach` adds a
// `selectedPath` into one of `probe.worktrees`, cleared on every cwd change
// alongside the probe (spec §6) — rows are DERIVED from probe.worktrees + the
// live session roster on every render, never stored.

import { useEffect, useRef, useState, type RefObject } from 'react';
import type { SessionMeta } from '../../../contract/common';
import type { WorktreeProbeData } from '../../../contract/session-worktree';
import { previewWorktreePath } from '../../../contract/session-worktree';
import { sessionWorktreeProbe } from '../../lib/api';
import {
  attachNamePrefill,
  attachNameShouldPrefill,
  canOpenWorktreeRecovery,
  consumeWorktreePreset,
  defaultWorktreeBranch,
  isValidBranchName,
  liveWorktreeProbe,
  worktreeAttachBlocked,
  worktreeCreateBlocked,
  worktreeRows,
  type WorktreeMode,
  type WorktreeProbeState,
  type WorktreeRow,
} from './worktree';

export interface UseWorktreeGroupParams {
  cwd: string;
  name: string;
  nameTouched: boolean;
  setName: (name: string) => void;
  /** Live for as long as the modal is open — a response arriving after it closed is dropped. */
  openRef: RefObject<boolean>;
  /** canCreate's non-worktree guards, shared by the FR-5 recovery offer. */
  modelId: string;
  projectRootMissing: boolean;
  submitting: boolean;
  /** The live session roster (attach-to-worktree FR-10 "in use by"). */
  sessions: SessionMeta[];
  /** projects' path-normalization case rule (Windows: true). */
  caseInsensitive: boolean;
}

export interface UseWorktreeGroupResult {
  probe: WorktreeProbeData | null;
  mode: WorktreeMode;
  setMode: (mode: WorktreeMode) => void;
  branch: string;
  setBranch: (value: string) => void;
  baseRef: string;
  setBaseRef: (value: string) => void;
  branchValid: boolean;
  /** FR-9 path preview, null until a repo root and a branch are both known. */
  worktreePreview: string | null;
  /** FR-5: the path the branch is already checked out at, if any. */
  recoveryPath: string | null;
  recovering: boolean;
  setRecovering: (v: boolean) => void;
  /** FR-1/FR-3/attach-to-worktree FR-17: the worktree group's own half of the Create gate. */
  blocked: boolean;
  canOpenRecovery: boolean;
  /** §7 race path: merge a create-time WORKTREE_BRANCH_IN_USE into the probe. */
  applyRacePath: (path: string) => void;
  /** attach-to-worktree FR-9..FR-11: the picker rows, derived fresh every render. */
  rows: WorktreeRow[];
  /** attach-to-worktree FR-12/FR-17: the selected picker row's path. */
  selectedPath: string | null;
  selectRow: (path: string | null) => void;
  /**
   * §7 "Tree removed between probe and create": force a fresh probe of the
   * current cwd — used when a `WORKTREE_NOT_FOUND` create failure means the
   * cached probe (and its rows) are stale, rather than leaving the identical,
   * now-wrong selection retriable.
   */
  reprobe: () => void;
}

export function useWorktreeGroup({
  cwd,
  name,
  nameTouched,
  setName,
  openRef,
  modelId,
  projectRootMissing,
  submitting,
  sessions,
  caseInsensitive,
}: UseWorktreeGroupParams): UseWorktreeGroupResult {
  const [mode, setMode] = useState<WorktreeMode>('off');
  const [branch, setBranchValue] = useState('');
  const [branchTouched, setBranchTouched] = useState(false);
  const [baseRef, setBaseRefValue] = useState('');
  const [baseRefTouched, setBaseRefTouched] = useState(false);
  // The probe is stored WITH the cwd it was requested for, so `liveWorktreeProbe`
  // drops it the moment the user picks/types a different directory — repo A's
  // isRepo/branch/hint/path preview/worktrees must never render for repo B during
  // the debounce + round-trip window (FR-1).
  //
  // Within one cwd it is sticky across a transient failure: `data` is ONLY ever
  // overwritten by a successful response, never nulled on error, so a checked
  // mode (and its last known isRepo) survives a blip. `errored`/`probing` track
  // the failed/in-flight state SEPARATELY so the Create gate
  // (worktreeCreateBlocked/worktreeAttachBlocked) can block on them without
  // touching the data.
  const [probeState, setProbeState] = useState<WorktreeProbeState | null>(null);
  const { data: probe, errored: probeError } = liveWorktreeProbe(probeState, cwd);
  const [probing, setProbing] = useState(false);
  const probeSeqRef = useRef(0);
  // §7 "Tree removed between probe and create": bumped by `reprobe()` below to
  // force the FR-1 effect to re-fire without a cwd/branch change.
  const [reprobeNonce, setReprobeNonce] = useState(0);
  const [recovering, setRecovering] = useState(false);
  // attach-to-worktree FR-17/§6: cleared on every cwd change, alongside the probe.
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  // command-palette FR-16: "New session in worktree…" opens this modal with the
  // mode pre-set to 'create' (one-shot flag, consumed once per open).
  useEffect(() => {
    if (consumeWorktreePreset()) setMode('create');
  }, []);

  // FR-1: probe the candidate cwd (debounced 250ms), refreshing on cwd AND
  // branch changes so branchExists/branchCheckedOutAt/worktreePath stay current
  // while the user types. A non-repo cwd resolves isRepo:false — never an error.
  // attach-to-worktree FR-1: the SAME call also fills `worktrees` — no per-mode
  // branching here, so a plain create pays exactly this one extra list.
  useEffect(() => {
    const c = cwd.trim();
    if (!c) {
      probeSeqRef.current += 1;
      setProbeState(null);
      setProbing(false);
      return;
    }
    const branchArg = mode === 'create' && branch.trim() ? branch.trim() : undefined;
    const seq = (probeSeqRef.current += 1);
    setProbing(true);
    const t = setTimeout(() => {
      void sessionWorktreeProbe({ cwd: c, branch: branchArg }).then((res) => {
        // A stale response (superseded by a later cwd/branch change while this
        // one was in flight) must never clobber the current probe/error state.
        if (!openRef.current || probeSeqRef.current !== seq) return;
        setProbing(false);
        if (res.ok) {
          setProbeState({ cwd: c, data: res.data, errored: false });
        } else {
          // A transient failure never nulls the data for THIS cwd — see the
          // state comment above. Only the error flag moves.
          setProbeState((s) => (s && s.cwd === c ? { ...s, errored: true } : { cwd: c, data: null, errored: true }));
        }
      });
    }, 250);
    return () => clearTimeout(t);
  }, [cwd, mode, branch, openRef, reprobeNonce]);

  // attach-to-worktree §6: the selection is cleared on every cwd change,
  // exactly as the probe is (separate effect so it fires on cwd ALONE, not on
  // every branch keystroke like the probe re-fetch above).
  useEffect(() => {
    setSelectedPath(null);
  }, [cwd]);

  // FR-2: branch prefills feat/<session-name-slug> (falling back to basename(cwd))
  // until hand-edited; base ref prefills the probed default branch until hand-edited.
  useEffect(() => {
    if (mode === 'create' && !branchTouched) setBranchValue(defaultWorktreeBranch(name, cwd));
  }, [mode, name, cwd, branchTouched]);
  useEffect(() => {
    if (mode === 'create' && !baseRefTouched && probe?.defaultBranch) setBaseRefValue(probe.defaultBranch);
  }, [mode, probe?.defaultBranch, baseRefTouched]);

  // FR-9 preview, recomputed from the current branch value; null until a repo root
  // is known. Recovery (FR-5) suppresses the normal create action entirely.
  //
  // Prefers the core's own `probe.worktreePath` (computed against the real
  // filesystem, so it already reflects a `-2`/`-3`/… collision suffix per §7
  // "Target path exists") over the pure client-side `previewWorktreePath`, which
  // can only ever guess the un-suffixed path. The probe only fills `worktreePath`
  // when `branch` was sent with the request (FR-1), so the client-side computation
  // remains the fallback for the gap between typing a branch and the debounced
  // probe returning.
  const worktreePreview =
    mode === 'create' && probe?.repoRoot && branch.trim()
      ? (probe.worktreePath ?? previewWorktreePath(probe.repoRoot, branch.trim()))
      : null;
  const branchValid = isValidBranchName(branch);
  const recoveryPath = mode === 'create' ? (probe?.branchCheckedOutAt ?? null) : null;

  // attach-to-worktree FR-9..FR-11: rows are derived fresh every render — never
  // stored — from the probe's worktrees plus the live roster.
  const rows = worktreeRows(probe?.worktrees ?? [], sessions, caseInsensitive);

  const createBlocked = worktreeCreateBlocked({
    worktreeEnabled: mode === 'create',
    probeIsRepo: probe?.isRepo ?? null,
    probing,
    probeErrored: probeError,
    branch,
    branchValid,
    recoveryPath,
  });
  const attachBlocked = worktreeAttachBlocked({
    mode,
    probing,
    probeErrored: probeError,
    selectedPath,
    rows,
    caseInsensitive,
  });
  const blocked = createBlocked || attachBlocked;

  // FR-5 recovery offer shares canCreate's non-worktree guards (name/model/project-root/
  // in-flight submit) plus its own re-entrancy guard so a double-click can't fire twice.
  // It also shares worktreeCreateBlocked's probe-staleness guard: liveWorktreeProbe only
  // invalidates on a cwd change, not a branch change, so a branch edit must block the
  // recovery offer (via `probing`/`probeError`) exactly like it blocks plain Create —
  // otherwise the amber card can stay clickable while showing a stale branch's path.
  const canOpenRecovery = canOpenWorktreeRecovery({
    name,
    modelId,
    projectRootMissing,
    submitting,
    recovering,
    probing,
    probeErrored: probeError,
  });

  // §7 "Branch checked out between probe and create (race)": the branch was free
  // at probe time but got checked out elsewhere before session_create ran. Merge
  // the core's `{ path }` into `probe.branchCheckedOutAt` so the SAME
  // recovery-offer JSX that FR-5's probe-time detection drives picks it up — no
  // dead-end error, just the recovery path arriving a beat late.
  const applyRacePath = (racePath: string) => {
    const key = cwd.trim();
    setProbeState((s) => {
      const known = s && s.cwd === key ? s.data : null;
      const data: WorktreeProbeData = known
        ? { ...known, branchExists: true, branchCheckedOutAt: racePath }
        : {
            isRepo: true,
            repoRoot: null,
            defaultBranch: null,
            currentBranch: null,
            remote: null,
            branchExists: true,
            branchCheckedOutAt: racePath,
            worktreePath: null,
            worktrees: [],
          };
      return { cwd: key, data, errored: false };
    });
  };

  // attach-to-worktree FR-12: fills the session name from the row's label only
  // if the name is still empty AND untouched — never overwrites a typed name,
  // nor an untouched name already filled by useProjectDefaults/useDirectoryPicker
  // (project/directory basename).
  const selectRow = (path: string | null) => {
    setSelectedPath(path);
    if (path === null || !attachNameShouldPrefill(name, nameTouched)) return;
    const row = rows.find((r) => r.path === path);
    if (row) setName(attachNamePrefill(row));
  };

  // §7 "Tree removed between probe and create": a `WORKTREE_NOT_FOUND` create
  // failure means the cached probe (`rows`, `worktree.blocked`) is stale — set
  // `probing` immediately so blocked flips true right away (no window where the
  // identical, now-wrong row is retriable), then bump `reprobeNonce` to re-fire
  // the FR-1 effect with no cwd/branch change of its own.
  const reprobe = () => {
    setProbing(true);
    setReprobeNonce((n) => n + 1);
  };

  return {
    probe,
    mode,
    setMode,
    branch,
    setBranch: (value: string) => {
      setBranchValue(value);
      setBranchTouched(true);
    },
    baseRef,
    setBaseRef: (value: string) => {
      setBaseRefValue(value);
      setBaseRefTouched(true);
    },
    branchValid,
    worktreePreview,
    recoveryPath,
    recovering,
    setRecovering,
    blocked,
    canOpenRecovery,
    applyRacePath,
    rows,
    selectedPath,
    selectRow,
    reprobe,
  };
}
