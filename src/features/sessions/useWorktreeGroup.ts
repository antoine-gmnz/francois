// useWorktreeGroup — session-worktree FR-1..FR-5, extracted from NewSessionModal
// the same way useModelCatalog/useProjectDefaults/useDirectoryPicker were: the
// modal owns layout and submission, each hook owns one field group's state and
// its effects. All the decision logic itself stays pure in ./worktree.ts.

import { useEffect, useRef, useState, type RefObject } from 'react';
import type { WorktreeProbeData } from '../../../contract/session-worktree';
import { previewWorktreePath } from '../../../contract/session-worktree';
import { sessionWorktreeProbe } from '../../lib/api';
import {
  canOpenWorktreeRecovery,
  consumeWorktreePreset,
  defaultWorktreeBranch,
  isValidBranchName,
  liveWorktreeProbe,
  worktreeCreateBlocked,
  type WorktreeProbeState,
} from './worktree';

export interface UseWorktreeGroupParams {
  cwd: string;
  name: string;
  /** Live for as long as the modal is open — a response arriving after it closed is dropped. */
  openRef: RefObject<boolean>;
  /** canCreate's non-worktree guards, shared by the FR-5 recovery offer. */
  modelId: string;
  projectRootMissing: boolean;
  submitting: boolean;
}

export interface UseWorktreeGroupResult {
  probe: WorktreeProbeData | null;
  worktreeEnabled: boolean;
  setWorktreeEnabled: (fn: (v: boolean) => boolean) => void;
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
  /** FR-1/FR-3: the worktree group's own half of the Create gate. */
  blocked: boolean;
  canOpenRecovery: boolean;
  /** §7 race path: merge a create-time WORKTREE_BRANCH_IN_USE into the probe. */
  applyRacePath: (path: string) => void;
}

export function useWorktreeGroup({
  cwd,
  name,
  openRef,
  modelId,
  projectRootMissing,
  submitting,
}: UseWorktreeGroupParams): UseWorktreeGroupResult {
  const [worktreeEnabled, setWorktreeEnabled] = useState(false);
  const [branch, setBranchValue] = useState('');
  const [branchTouched, setBranchTouched] = useState(false);
  const [baseRef, setBaseRefValue] = useState('');
  const [baseRefTouched, setBaseRefTouched] = useState(false);
  // The probe is stored WITH the cwd it was requested for, so `liveWorktreeProbe`
  // drops it the moment the user picks/types a different directory — repo A's
  // isRepo/branch/hint/path preview must never render for repo B during the
  // debounce + round-trip window (FR-1).
  //
  // Within one cwd it is sticky across a transient failure: `data` is ONLY ever
  // overwritten by a successful response, never nulled on error, so a checked
  // "Isolate in worktree" box (and its last known isRepo) survives a blip.
  // `errored`/`probing` track the failed/in-flight state SEPARATELY so the Create
  // gate (worktreeCreateBlocked) can block on them without touching the data.
  const [probeState, setProbeState] = useState<WorktreeProbeState | null>(null);
  const { data: probe, errored: probeError } = liveWorktreeProbe(probeState, cwd);
  const [probing, setProbing] = useState(false);
  const probeSeqRef = useRef(0);
  const [recovering, setRecovering] = useState(false);

  // command-palette FR-16: "New session in worktree…" opens this modal with the
  // checkbox pre-checked (one-shot flag, consumed once per open).
  useEffect(() => {
    if (consumeWorktreePreset()) setWorktreeEnabled(true);
  }, []);

  // FR-1: probe the candidate cwd (debounced 250ms), refreshing on cwd AND
  // branch changes so branchExists/branchCheckedOutAt/worktreePath stay current
  // while the user types. A non-repo cwd resolves isRepo:false — never an error.
  useEffect(() => {
    const c = cwd.trim();
    if (!c) {
      probeSeqRef.current += 1;
      setProbeState(null);
      setProbing(false);
      return;
    }
    const branchArg = worktreeEnabled && branch.trim() ? branch.trim() : undefined;
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
  }, [cwd, worktreeEnabled, branch, openRef]);

  // FR-2: branch prefills feat/<session-name-slug> (falling back to basename(cwd))
  // until hand-edited; base ref prefills the probed default branch until hand-edited.
  useEffect(() => {
    if (worktreeEnabled && !branchTouched) setBranchValue(defaultWorktreeBranch(name, cwd));
  }, [worktreeEnabled, name, cwd, branchTouched]);
  useEffect(() => {
    if (worktreeEnabled && !baseRefTouched && probe?.defaultBranch) setBaseRefValue(probe.defaultBranch);
  }, [worktreeEnabled, probe?.defaultBranch, baseRefTouched]);

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
  const worktreePreview = probe?.repoRoot && branch.trim() ? (probe.worktreePath ?? previewWorktreePath(probe.repoRoot, branch.trim())) : null;
  const branchValid = isValidBranchName(branch);
  const recoveryPath = worktreeEnabled ? (probe?.branchCheckedOutAt ?? null) : null;
  const blocked = worktreeCreateBlocked({
    worktreeEnabled,
    probeIsRepo: probe?.isRepo ?? null,
    probing,
    probeErrored: probeError,
    branch,
    branchValid,
    recoveryPath,
  });
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
          };
      return { cwd: key, data, errored: false };
    });
  };

  return {
    probe,
    worktreeEnabled,
    setWorktreeEnabled,
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
  };
}
