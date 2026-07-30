import { useEffect, useRef, useState } from 'react';
import type { AppError, ClaudeRuntime, ModelInfo, PermissionMode, SessionMeta } from '../../../contract/common';
import { isWslUncPath } from '../../../contract/wsl-filesystem';
import type { ProjectMeta } from '../../../contract/projects';
import type { WorktreeProbeData } from '../../../contract/session-worktree';
import { previewWorktreePath } from '../../../contract/session-worktree';
import { projectList, sessionCreate, sessionModels, sessionPickDirectory, sessionWorktreeProbe } from '../../lib/api';
import {
  PROJECT_ROOT_MISSING_LINE,
  applyProjectDefaults,
  baseFormValues,
  newSessionProjectOptions,
  safeCall,
} from '../projects/projects';
import { useStore } from '../../lib/store';
import { IS_WINDOWS } from '../../lib/platform';
import ModelPicker from './ModelPicker';
import {
  basenameOf,
  canOpenWorktreeRecovery,
  consumeWorktreePreset,
  defaultWorktreeBranch,
  isValidBranchName,
  liveWorktreeProbe,
  submitErrorBanner,
  worktreeBranchInUsePath,
  worktreeCreateBlocked,
} from './worktree';
import type { WorktreeProbeState } from './worktree';

// PermissionMode choices (contract/common.ts): label + the plain-language consequence.
const PERMISSION_OPTIONS: { mode: PermissionMode; label: string; hint: string }[] = [
  { mode: 'default', label: 'default', hint: 'inherit your Claude settings (~/.claude)' },
  { mode: 'plan', label: 'plan', hint: 'read & plan only — never edits or runs commands' },
  { mode: 'acceptEdits', label: 'accept edits', hint: 'auto-approve file edits; other tools follow your settings' },
  { mode: 'bypassPermissions', label: 'bypass', hint: 'skip every permission check — full access' },
];

const C = {
  accent: 'var(--accent)',
  dim: 'var(--text-dim)',
  faint: 'var(--text-faint)',
  primary: 'var(--text)',
  bright: 'var(--text-strong)',
  error: 'var(--error)',
};

const fieldStyle: React.CSSProperties = {
  background: 'var(--bg-panel)',
  border: '1px solid var(--border-2)',
  borderRadius: 4,
  height: 32,
  color: C.primary,
  fontSize: 12.5,
  fontFamily: 'inherit',
  padding: '0 10px',
  width: '100%',
  outline: 'none',
};

const labelStyle: React.CSSProperties = {
  fontSize: 10,
  color: C.dim,
  letterSpacing: '0.08em',
  marginBottom: 5,
  display: 'block',
};

export default function NewSessionModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (m: SessionMeta) => void;
}) {
  const [cwd, setCwd] = useState('');
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  // projects: the session's project. '' = unlinked, which restores the whole
  // pre-projects form (an explicit DIRECTORY row and no inherited defaults).
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [projectId, setProjectId] = useState('');
  // §7 case 22: a project default naming a model the catalog no longer lists.
  // The picker falls back to its own default and we say so rather than silently
  // rewriting the project's configuration.
  const [staleModelId, setStaleModelId] = useState<string | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [modelId, setModelId] = useState('');
  const [effort, setEffort] = useState(''); // '' = model default
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('default');
  const [allowGit, setAllowGit] = useState(false);
  const [runtime, setRuntime] = useState<ClaudeRuntime>('native');
  // Reset each modal open (component remounts per open — see App.tsx). Tracks
  // whether the user has explicitly clicked a runtime chip this open, so
  // FR-16's auto-suggest never clobbers a deliberate choice.
  const [runtimeTouched, setRuntimeTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<AppError | null>(null);
  const [pickerError, setPickerError] = useState<AppError | null>(null);
  const [picking, setPicking] = useState(false);
  const openRef = useRef(true);

  // session-worktree FR-1/2/3/4/5: isolate-in-worktree group. `probe` is the last
  // session_worktree_probe response for the current cwd (+ branch once typed).
  const [worktreeEnabled, setWorktreeEnabled] = useState(false);
  const [branch, setBranch] = useState('');
  const [branchTouched, setBranchTouched] = useState(false);
  const [baseRef, setBaseRef] = useState('');
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

  useEffect(() => {
    // RE-ARM on every mount. StrictMode runs mount → cleanup → mount on the same
    // instance, so without this the cleanup's `false` survives into the second
    // mount and any effect that guards on openRef before setState silently does
    // nothing (this is exactly what swallowed the project list).
    openRef.current = true;
    void sessionModels().then((res) => {
      setModelsLoading(false);
      if (res.ok) {
        setModels(res.data);
        // Seed the picker ONLY while nothing has chosen a model yet. StrictMode
        // fires this fetch twice and the second resolve lands AFTER the project
        // defaults are applied — an unconditional set here silently reverted the
        // project's model back to the catalog's first entry.
        setModelId((cur) => cur || res.data[0]?.id || '');
      }
    });
    return () => {
      openRef.current = false;
    };
  }, []);

  // projects FR-30: opening the modal while the board is scoped to a project
  // starts in that project — "inside a project, a new session belongs to it".
  const activeProjectId = useStore((s) => s.activeProjectId);
  const preselectedRef = useRef(false);

  useEffect(() => {
    void safeCall(projectList()).then((res) => {
      if (!openRef.current || !res.ok) return;
      setProjects(res.data);
      if (preselectedRef.current) return;
      preselectedRef.current = true;
      // A project whose root vanished can't back a session (FR-23) — don't
      // preselect it, or the modal opens already blocked.
      const active = res.data.find((p) => p.id === activeProjectId && p.rootExists);
      if (active) setProjectId(active.id);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const project = projects.find((p) => p.id === projectId) ?? null;
  const projectRootMissing = project !== null && !project.rootExists;

  // FR-21/FR-22: applying a project overwrites every field it declares and
  // leaves the rest at the pre-feature default. It runs ONLY on a project
  // change (tracked by appliedRef), so a manual edit afterwards always wins —
  // and it waits for the model catalog, since effort and modelId are validated
  // against it.
  const appliedRef = useRef<string | null>(null);
  useEffect(() => {
    if (modelsLoading) return;
    if (appliedRef.current === projectId) return;
    appliedRef.current = projectId;

    const base = baseFormValues(models);
    const applied = applyProjectDefaults(base, project?.defaults, { models, allowWsl: IS_WINDOWS });
    setModelId(applied.values.modelId);
    setEffort(applied.values.effort);
    setPermissionMode(applied.values.permissionMode);
    setAllowGit(applied.values.allowGit);
    setStaleModelId(applied.staleModelId);

    // Runtime: the project's explicit default wins. When it declares none, fall back
    // to the SAME WSL auto-suggest the unlinked path gets from applyCwd (FR-16) —
    // the project path sets cwd directly and so used to bypass it entirely, creating
    // a `native` session against a \\wsl.localhost\… root while the modal was already
    // rendering its own "expect slow git" warning for that path.
    if (project && project.defaults.runtime === undefined && IS_WINDOWS && !runtimeTouched) {
      setRuntime(isWslUncPath(project.root) ? 'wsl' : 'native');
    } else {
      setRuntime(applied.values.runtime);
    }

    // The project OWNS the working directory — there is no directory row while
    // one is selected, so the root is the cwd. Clearing back to '' on "none"
    // restores the pre-projects flow rather than stranding the old root.
    setCwd(project ? project.root : '');
    if (!nameTouched) setName(project ? basenameOf(project.root) : '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, project, models, modelsLoading]);

  const modelEfforts = models.find((m) => m.id === modelId)?.efforts ?? [];

  // Reset effort if the newly selected model doesn't support the current level.
  useEffect(() => {
    if (effort && !modelEfforts.includes(effort)) setEffort('');
  }, [modelId, models]); // eslint-disable-line react-hooks/exhaustive-deps

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
  }, [cwd, worktreeEnabled, branch]);

  // FR-2: branch prefills feat/<session-name-slug> (falling back to basename(cwd))
  // until hand-edited; base ref prefills the probed default branch until hand-edited.
  useEffect(() => {
    if (worktreeEnabled && !branchTouched) setBranch(defaultWorktreeBranch(name, cwd));
  }, [worktreeEnabled, name, cwd, branchTouched]);
  useEffect(() => {
    if (worktreeEnabled && !baseRefTouched && probe?.defaultBranch) setBaseRef(probe.defaultBranch);
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
  const worktreeBranchValid = isValidBranchName(branch);
  const worktreeRecoveryPath = worktreeEnabled ? (probe?.branchCheckedOutAt ?? null) : null;
  const worktreeBlocked = worktreeCreateBlocked({
    worktreeEnabled,
    probeIsRepo: probe?.isRepo ?? null,
    probing,
    probeErrored: probeError,
    branch,
    branchValid: worktreeBranchValid,
    recoveryPath: worktreeRecoveryPath,
  });

  // Shared by Browse and direct typing: keep the derived name and the FR-16
  // runtime auto-suggest in sync with the path. The suggest follows the path in
  // BOTH directions (wsl for a WSL UNC path, back to native otherwise) but only
  // while the user hasn't explicitly clicked a runtime chip this modal-open.
  const applyCwd = (path: string) => {
    setCwd(path);
    if (!nameTouched) setName(basenameOf(path));
    if (IS_WINDOWS && !runtimeTouched) setRuntime(isWslUncPath(path) ? 'wsl' : 'native');
  };

  const browse = async () => {
    if (picking) return;
    setPicking(true);
    setPickerError(null);
    const res = await sessionPickDirectory();
    setPicking(false);
    if (!res.ok) {
      setPickerError(res.error);
      return;
    }
    if (res.data === null) return; // cancelled
    applyCwd(res.data.path);
  };

  // FR-23: a project whose root is gone blocks creation until another project
  // (or "none") is chosen — the core would reject it with PROJECT_ROOT_MISSING.
  const canCreate =
    cwd.trim() !== '' &&
    name.trim() !== '' &&
    modelId !== '' &&
    !submitting &&
    !projectRootMissing &&
    !worktreeBlocked;
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
  // FR-16/17: whether the picked directory is a WSL UNC path, drives the
  // auto-suggest + mismatch hints below the CLAUDE RUNTIME row.
  const cwdIsWsl = isWslUncPath(cwd);

  // Shared by the normal submit and the FR-5 recovery offer — only `cwd` and the
  // `worktree` options ever differ between the two.
  const createSession = async (overrideCwd: string, worktree?: { branch: string; baseRef: string; adopt?: boolean }) => {
    setSubmitting(true);
    setSubmitError(null);
    const res = await sessionCreate({
      cwd: overrideCwd,
      name,
      modelId,
      effort: effort || undefined,
      permissionMode: permissionMode !== 'default' ? permissionMode : undefined,
      runtime: runtime !== 'native' ? runtime : undefined,
      allowGit: allowGit || undefined,
      // FR-19: sent verbatim; the core does no default merging, so what is on
      // screen right now is exactly what gets created.
      projectId: projectId || undefined,
      worktree,
    });
    if (!openRef.current) {
      // Modal was cancelled mid-flight: still real, upsert but don't force-select.
      if (res.ok) onCreated(res.data);
      return;
    }
    setSubmitting(false);
    setRecovering(false);
    if (res.ok) {
      onCreated(res.data);
      onClose();
    } else {
      // §7 race path: an error that becomes the FR-5 recovery offer below shows
      // ONLY that offer — `submitErrorBanner` nulls it here so the red banner
      // never even flashes on top of the amber one.
      setSubmitError(submitErrorBanner(res.error));
      // §7 case 13: the project was removed (or its root vanished) between opening
      // the modal and submitting. Re-read the registry and drop back to "— none —",
      // otherwise the select keeps offering a project that no longer exists and every
      // retry fails identically with no cue that the fix is to pick none.
      if (res.error.code === 'PROJECT_NOT_FOUND' || res.error.code === 'PROJECT_ROOT_MISSING') {
        const fresh = await safeCall(projectList());
        if (!openRef.current) return;
        if (fresh.ok) setProjects(fresh.data);
        setProjectId('');
      } else {
        // §7 "Branch checked out between probe and create (race)": the branch was
        // free at probe time but got checked out elsewhere before session_create
        // ran. Merge the core's `{ path }` into `probe.branchCheckedOutAt` so the
        // SAME recovery-offer JSX that FR-5's probe-time detection drives picks it
        // up — no dead-end error, just the recovery path arriving a beat late.
        const racePath = worktreeBranchInUsePath(res.error);
        if (racePath) {
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
        }
      }
    }
  };

  const submit = async () => {
    if (!canCreate) return;
    const worktree =
      worktreeEnabled && probe?.isRepo
        ? { branch: branch.trim(), baseRef: baseRef.trim() || probe.defaultBranch || 'main' }
        : undefined;
    await createSession(cwd.trim(), worktree);
  };

  // FR-5: the branch is already checked out elsewhere — open a session there
  // instead, with NO git mutation (worktree.adopt = true).
  const openRecoverySession = async () => {
    if (!worktreeRecoveryPath || !canOpenRecovery) return;
    setRecovering(true);
    await createSession(worktreeRecoveryPath, { branch: branch.trim(), baseRef: baseRef.trim(), adopt: true });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      } else if (e.key === 'Enter' && canCreate) {
        const ae = document.activeElement as HTMLElement | null;
        if (ae?.tagName !== 'SELECT') {
          e.preventDefault();
          void submit();
        }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(6,7,9,0.62)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: 118,
        zIndex: 20,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 480,
          // The card can grow taller than the viewport once "Isolate in worktree"
          // expands the branch/base-ref/path-preview fields (bug found via
          // screenshot: Cancel/Create went off-screen with nothing to scroll).
          // maxHeight against the overlay's own top offset (paddingTop 118) plus a
          // matching bottom margin keeps the card fully on-screen at any window
          // height; the body below scrolls internally instead.
          maxHeight: 'calc(100vh - 118px - 24px)',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--bg-panel)',
          border: '1px solid var(--bg-hover-2)',
          borderRadius: 8,
          overflow: 'hidden',
          boxShadow: '0 30px 80px -20px rgba(0,0,0,0.85)',
        }}
      >
        <div
          style={{
            padding: '14px 16px',
            borderBottom: '1px solid var(--border)',
            fontSize: 14,
            color: C.bright,
            flexShrink: 0,
          }}
        >
          <span style={{ color: C.accent }}>›</span> new session
        </div>

        <div
          className="scz"
          style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 14, overflowY: 'auto', minHeight: 0 }}
        >
          {/* projects: the project comes FIRST — picking one settles the working
              directory and every default below, so it is the decision the rest
              of the form hangs off. Hidden entirely when no project exists yet,
              so the pre-projects form is untouched until you make one. */}
          {projects.length > 0 && (
            <div>
              <label style={labelStyle}>PROJECT</label>
              <select
                style={{ ...fieldStyle, width: '100%' }}
                value={projectId}
                onChange={(e) => {
                  setProjectId(e.target.value);
                  // A project change re-applies defaults (FR-22), and the name is
                  // derived again unless it was hand-edited.
                }}
              >
                {newSessionProjectOptions(projects).map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.missing ? `${o.label} (missing)` : o.label}
                  </option>
                ))}
              </select>
              {projectRootMissing && (
                <div style={{ fontSize: 10.5, color: C.error, marginTop: 4 }}>{PROJECT_ROOT_MISSING_LINE}</div>
              )}
              {/* Where it will actually run. Deliberately a dim read-only line and
                  NOT a field — the project owns the path, so there is nothing to
                  edit here. */}
              {project && !projectRootMissing && (
                <div style={{ fontSize: 10.5, color: C.faint, marginTop: 4 }}>runs in {project.root}</div>
              )}
              {staleModelId && (
                <div style={{ fontSize: 10.5, color: C.faint, marginTop: 4 }}>
                  this project's default model ({staleModelId}) is no longer available — using the default
                </div>
              )}
            </div>
          )}

          {/* The DIRECTORY row exists only for an unlinked session. With a project
              selected the root IS the working directory, so an editable path here
              would be a second source of truth for the same value. */}
          {project === null && (
            <div>
              <label style={labelStyle}>DIRECTORY</label>
              <div style={{ display: 'flex', gap: 8 }}>
                {/* Editable, not browse-only: on some setups the native picker can't
                    reach a location (e.g. WSL's Linux section on older Windows
                    builds) — typing/pasting the path must always work as a fallback. */}
                <input
                  style={{ ...fieldStyle, flex: 1 }}
                  value={cwd}
                  placeholder="type a path or browse…"
                  onChange={(e) => applyCwd(e.target.value)}
                />
                <button onClick={browse} disabled={picking} style={btn(false)}>
                  {picking ? '…' : 'Browse…'}
                </button>
              </div>
              {pickerError && <div style={{ fontSize: 10.5, color: C.error, marginTop: 4 }}>{pickerError.message}</div>}
            </div>
          )}

          <div>
            <label style={labelStyle}>NAME</label>
            <input
              style={fieldStyle}
              value={name}
              placeholder="session name"
              onChange={(e) => {
                setName(e.target.value);
                setNameTouched(true);
              }}
            />
          </div>

          <div>
            <label style={labelStyle}>MODEL</label>
            <ModelPicker models={models} modelId={modelId} loading={modelsLoading} onChange={setModelId} />
          </div>

          {modelEfforts.length > 0 && (
            <div>
              <label style={labelStyle}>EFFORT</label>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {[{ k: 'default', v: '' }, ...modelEfforts.map((e) => ({ k: e, v: e }))].map(({ k, v }) => {
                  const sel = effort === v;
                  return (
                    <span
                      key={k}
                      onClick={() => setEffort(v)}
                      style={{
                        fontSize: 11,
                        padding: '4px 9px',
                        borderRadius: 4,
                        cursor: 'pointer',
                        border: `1px solid ${sel ? C.accent : 'var(--border-2)'}`,
                        background: sel ? 'color-mix(in srgb, var(--accent) 12%, transparent)' : 'var(--bg-panel)',
                        color: sel ? C.accent : C.dim,
                      }}
                    >
                      {k}
                    </span>
                  );
                })}
              </div>
            </div>
          )}

          <div>
            <label style={labelStyle}>PERMISSIONS</label>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {PERMISSION_OPTIONS.map(({ mode, label }) => {
                const sel = permissionMode === mode;
                const danger = mode === 'bypassPermissions';
                return (
                  <span
                    key={mode}
                    onClick={() => setPermissionMode(mode)}
                    style={{
                      fontSize: 11,
                      padding: '4px 9px',
                      borderRadius: 4,
                      cursor: 'pointer',
                      border: `1px solid ${sel ? (danger ? C.error : C.accent) : 'var(--border-2)'}`,
                      background: sel ? (danger ? 'color-mix(in srgb, var(--error) 12%, transparent)' : 'color-mix(in srgb, var(--accent) 12%, transparent)') : 'var(--bg-panel)',
                      color: sel ? (danger ? C.error : C.accent) : C.dim,
                    }}
                  >
                    {label}
                  </span>
                );
              })}
            </div>
            <div style={{ fontSize: 10.5, color: C.faint, marginTop: 5 }}>
              {PERMISSION_OPTIONS.find((o) => o.mode === permissionMode)?.hint}
            </div>
          </div>

          <div>
            <label style={labelStyle}>GIT</label>
            <div style={{ display: 'flex', gap: 6 }}>
              <span
                onClick={() => setAllowGit((v) => !v)}
                style={{
                  fontSize: 11,
                  padding: '4px 9px',
                  borderRadius: 4,
                  cursor: 'pointer',
                  border: `1px solid ${allowGit ? C.accent : 'var(--border-2)'}`,
                  background: allowGit ? 'color-mix(in srgb, var(--accent) 12%, transparent)' : 'var(--bg-panel)',
                  color: allowGit ? C.accent : C.dim,
                }}
              >
                {allowGit ? '✓ ' : ''}allow git commands
              </span>
            </div>
            <div style={{ fontSize: 10.5, color: C.faint, marginTop: 5 }}>
              auto-approve git &amp; gh commands (commit, push, PRs) without a prompt — other tools still follow the permission setting above
            </div>
          </div>

          {IS_WINDOWS && (
            <div>
              <label style={labelStyle}>CLAUDE RUNTIME</label>
              <div style={{ display: 'flex', gap: 6 }}>
                {(['native', 'wsl'] as const).map((r) => {
                  const sel = runtime === r;
                  return (
                    <span
                      key={r}
                      onClick={() => {
                        setRuntime(r);
                        setRuntimeTouched(true);
                      }}
                      style={{
                        fontSize: 11,
                        padding: '4px 9px',
                        borderRadius: 4,
                        cursor: 'pointer',
                        border: `1px solid ${sel ? C.accent : 'var(--border-2)'}`,
                        background: sel ? 'color-mix(in srgb, var(--accent) 12%, transparent)' : 'var(--bg-panel)',
                        color: sel ? C.accent : C.dim,
                      }}
                    >
                      {r}
                    </span>
                  );
                })}
              </div>
              {/* FR-16/17: mutually exclusive, below the row — never blocks creation. */}
              {runtime === 'wsl' ? (
                <div style={{ fontSize: 10.5, color: C.faint, marginTop: 5 }}>
                  {cwdIsWsl
                    ? 'WSL directory — claude will run inside your default distro'
                    : 'runs `claude` inside your default WSL distro (wsl.exe translates the directory)'}
                </div>
              ) : (
                cwdIsWsl && (
                  <div style={{ fontSize: 10.5, color: C.error, marginTop: 5 }}>
                    Windows tools will access this directory over 9P — expect slow git and no live diff updates
                  </div>
                )
              )}
            </div>
          )}

          {/* session-worktree §8 screen 1: absent entirely on a non-repo cwd (FR-1) — no
              gap, no disabled control. */}
          {probe?.isRepo && (
            <div>
              <span
                onClick={() => setWorktreeEnabled((v) => !v)}
                style={{
                  fontSize: 11,
                  padding: '4px 9px',
                  borderRadius: 4,
                  cursor: 'pointer',
                  border: `1px solid ${worktreeEnabled ? C.accent : 'var(--border-2)'}`,
                  background: worktreeEnabled ? 'color-mix(in srgb, var(--accent) 12%, transparent)' : 'var(--bg-panel)',
                  color: worktreeEnabled ? C.accent : C.dim,
                }}
              >
                {worktreeEnabled ? '✓ ' : ''}Isolate in worktree
              </span>
              <div style={{ fontSize: 10.5, color: C.faint, marginTop: 5 }}>runs this session in its own git worktree</div>

              {worktreeEnabled && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10 }}>
                  <div>
                    <label style={labelStyle}>BRANCH</label>
                    <input
                      style={{ ...fieldStyle, fontFamily: 'var(--font-mono, monospace)' }}
                      value={branch}
                      placeholder="feat/my-change"
                      onChange={(e) => {
                        setBranch(e.target.value);
                        setBranchTouched(true);
                      }}
                    />
                  </div>
                  <div>
                    <label style={labelStyle}>BASE REF</label>
                    <input
                      style={{
                        ...fieldStyle,
                        fontFamily: 'var(--font-mono, monospace)',
                        opacity: probe.branchExists ? 0.5 : 1,
                      }}
                      value={baseRef}
                      disabled={!!probe.branchExists}
                      placeholder="main"
                      onChange={(e) => {
                        setBaseRef(e.target.value);
                        setBaseRefTouched(true);
                      }}
                    />
                  </div>
                  {worktreePreview && (
                    <div
                      title={worktreePreview}
                      style={{
                        fontSize: 10.5,
                        color: C.faint,
                        fontFamily: 'var(--font-mono, monospace)',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        // design brief §"Narrow window": the path preview middle- or
                        // left-truncates rather than losing its meaningful tail to a
                        // trailing ellipsis — same intent as truncateBranchLeft's FR-13
                        // chip, applied here via the browser's own ellipsis engine since
                        // the value is a live string, not a fixed-width chip.
                        direction: 'rtl',
                        textAlign: 'left',
                      }}
                    >
                      {worktreePreview}
                    </div>
                  )}

                  {/* inline notice slot (FR-4/FR-5/FR-3) */}
                  {worktreeRecoveryPath ? (
                    <div
                      style={{
                        background: 'color-mix(in srgb, var(--warn) 10%, transparent)',
                        borderRadius: 4,
                        padding: '8px 10px',
                        fontSize: 11,
                        color: 'var(--warn)',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 6,
                      }}
                    >
                      <span>
                        <code>{branch.trim()}</code> is already checked out at{' '}
                        <code title={worktreeRecoveryPath}>{worktreeRecoveryPath}</code>
                      </span>
                      <span
                        onClick={() => canOpenRecovery && void openRecoverySession()}
                        style={{
                          color: C.accent,
                          cursor: canOpenRecovery ? 'pointer' : 'default',
                          opacity: canOpenRecovery ? 1 : 0.5,
                          fontWeight: 600,
                          alignSelf: 'flex-start',
                        }}
                      >
                        {recovering ? 'opening…' : 'Open a session there instead'}
                      </span>
                    </div>
                  ) : probe.branchExists ? (
                    <div style={{ fontSize: 10.5, color: C.faint }}>existing branch — will be checked out</div>
                  ) : (
                    branch.trim() !== '' &&
                    !worktreeBranchValid && (
                      <div style={{ fontSize: 10.5, color: C.error }}>invalid branch name</div>
                    )
                  )}
                </div>
              )}
            </div>
          )}

          {submitError && (
            <div
              style={{
                background: 'color-mix(in srgb, var(--error) 9%, transparent)',
                color: C.error,
                fontSize: 11,
                borderRadius: 4,
                padding: '8px 10px',
              }}
            >
              {submitError.message}
            </div>
          )}
        </div>

        <div
          style={{
            padding: '9px 16px',
            borderTop: '1px solid var(--border)',
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 10,
            flexShrink: 0,
          }}
        >
          <button onClick={onClose} style={btn(false, C.dim)}>
            Cancel
          </button>
          <button onClick={submit} disabled={!canCreate} style={createBtn(canCreate)}>
            {submitting ? 'creating…' : 'Create session'}
          </button>
        </div>
      </div>
    </div>
  );
}

function btn(_active: boolean, color = C.primary): React.CSSProperties {
  return {
    background: 'var(--bg-panel)',
    border: '1px solid var(--border-2)',
    borderRadius: 4,
    color,
    fontSize: 12,
    fontFamily: 'inherit',
    padding: '0 12px',
    height: 32,
    cursor: 'pointer',
  };
}

function createBtn(enabled: boolean): React.CSSProperties {
  return {
    background: enabled ? C.accent : 'var(--text-disabled)',
    border: 'none',
    borderRadius: 4,
    color: enabled ? 'var(--bg-panel)' : 'var(--text-muted)',
    fontSize: 12,
    fontFamily: 'inherit',
    fontWeight: 600,
    padding: '0 14px',
    height: 32,
    cursor: enabled ? 'pointer' : 'default',
  };
}
