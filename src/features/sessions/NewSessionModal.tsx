import { useEffect, useState } from 'react';
import type { AppError, ClaudeRuntime, PermissionMode, SessionMeta } from '../../../contract/common';
import { isWslUncPath } from '../../../contract/wsl-filesystem';
import { sessionCreate } from '../../lib/api';
import { useStore } from '../../lib/store';
import { useMounted } from '../../lib/hooks/useMounted';
import { IS_WINDOWS } from '../../lib/platform';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '../../ui/Modal';
import { Button } from '../../ui/Button';
import { Chip } from '../../ui/Chip';
import { ChipGroup, type ChipOption } from '../../ui/ChipGroup';
import { ProjectField } from './ProjectField';
import { DirectoryField } from './DirectoryField';
import { NameField } from './NameField';
import { ModelField } from './ModelField';
import { useModelCatalog } from './useModelCatalog';
import { useProjectList } from './useProjectList';
import { useProjectDefaults } from './useProjectDefaults';
import { useDirectoryPicker } from './useDirectoryPicker';
import { useWorktreeGroup } from './useWorktreeGroup';
import { WorktreeField } from './WorktreeField';
import { submitErrorBanner, worktreeBranchInUsePath } from './worktree';
import './new-session-modal.css';

// PermissionMode choices (contract/common.ts): label + the plain-language consequence.
const PERMISSION_OPTIONS: { mode: PermissionMode; label: string; hint: string }[] = [
  { mode: 'default', label: 'default', hint: 'inherit your Claude settings (~/.claude)' },
  { mode: 'plan', label: 'plan', hint: 'read & plan only — never edits or runs commands' },
  { mode: 'acceptEdits', label: 'accept edits', hint: 'auto-approve file edits; other tools follow your settings' },
  { mode: 'bypassPermissions', label: 'bypass', hint: 'skip every permission check — full access' },
];

const PERMISSION_CHIP_OPTIONS: ChipOption<PermissionMode>[] = PERMISSION_OPTIONS.map((opt) => ({
  value: opt.mode,
  label: opt.label,
  danger: opt.mode === 'bypassPermissions',
}));

const RUNTIME_CHIP_OPTIONS: ChipOption<ClaudeRuntime>[] = (['native', 'wsl'] as const).map((runtime) => ({
  value: runtime,
  label: runtime,
}));

export default function NewSessionModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (meta: SessionMeta) => void;
}) {
  const [cwd, setCwd] = useState('');
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  // §7 case 22: a project default naming a model the catalog no longer lists.
  // The picker falls back to its own default and we say so rather than silently
  // rewriting the project's configuration.
  const [staleModelId, setStaleModelId] = useState<string | null>(null);
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
  // RE-ARM on every mount. StrictMode runs mount → cleanup → mount on the same
  // instance, so without this the cleanup's `false` survives into the second
  // mount and any effect that guards on openRef before setState silently does
  // nothing (this is exactly what swallowed the project list).
  const openRef = useMounted();

  const { models, modelsLoading, modelId, setModelId } = useModelCatalog();

  // projects FR-30: opening the modal while the board is scoped to a project
  // starts in that project — "inside a project, a new session belongs to it".
  const activeProjectId = useStore((s) => s.activeProjectId);
  const { projects, projectId, setProjectId, recoverFromProjectError } = useProjectList(activeProjectId, openRef);

  const project = projects.find((p) => p.id === projectId) ?? null;
  const projectRootMissing = project !== null && !project.rootExists;

  useProjectDefaults({
    projectId,
    project,
    models,
    modelsLoading,
    nameTouched,
    runtimeTouched,
    setModelId,
    setEffort,
    setPermissionMode,
    setAllowGit,
    setStaleModelId,
    setRuntime,
    setCwd,
    setName,
  });

  const { picking, pickerError, applyCwd, browse } = useDirectoryPicker({
    nameTouched,
    runtimeTouched,
    setCwd,
    setName,
    setRuntime,
  });

  // session-worktree FR-1..FR-5: the "Isolate in worktree" group.
  const worktree = useWorktreeGroup({ cwd, name, openRef, modelId, projectRootMissing, submitting });

  const modelEfforts = models.find((m) => m.id === modelId)?.efforts ?? [];

  // Reset effort if the newly selected model doesn't support the current level.
  useEffect(() => {
    if (effort && !modelEfforts.includes(effort)) setEffort('');
  }, [modelId, models]); // eslint-disable-line react-hooks/exhaustive-deps

  // FR-23: a project whose root is gone blocks creation until another project
  // (or "none") is chosen — the core would reject it with PROJECT_ROOT_MISSING.
  const canCreate =
    cwd.trim() !== '' && name.trim() !== '' && modelId !== '' && !submitting && !projectRootMissing && !worktree.blocked;
  // FR-16/17: whether the picked directory is a WSL UNC path, drives the
  // auto-suggest + mismatch hints below the CLAUDE RUNTIME row.
  const cwdIsWsl = isWslUncPath(cwd);

  // Shared by the normal submit and the FR-5 recovery offer — only `cwd` and the
  // `worktree` options ever differ between the two.
  const createSession = async (overrideCwd: string, worktreeOpts?: { branch: string; baseRef: string; adopt?: boolean }) => {
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
      worktree: worktreeOpts,
    });
    if (!openRef.current) {
      // Modal was cancelled mid-flight: still real, upsert but don't force-select.
      if (res.ok) onCreated(res.data);
      return;
    }
    setSubmitting(false);
    worktree.setRecovering(false);
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
        await recoverFromProjectError();
      } else {
        const racePath = worktreeBranchInUsePath(res.error);
        if (racePath) worktree.applyRacePath(racePath);
      }
    }
  };

  const submit = async () => {
    if (!canCreate) return;
    const worktreeOpts =
      worktree.worktreeEnabled && worktree.probe?.isRepo
        ? { branch: worktree.branch.trim(), baseRef: worktree.baseRef.trim() || worktree.probe.defaultBranch || 'main' }
        : undefined;
    await createSession(cwd.trim(), worktreeOpts);
  };

  // FR-5: the branch is already checked out elsewhere — open a session there
  // instead, with NO git mutation (worktree.adopt = true).
  const openRecoverySession = async () => {
    if (!worktree.recoveryPath || !worktree.canOpenRecovery) return;
    worktree.setRecovering(true);
    await createSession(worktree.recoveryPath, { branch: worktree.branch.trim(), baseRef: worktree.baseRef.trim(), adopt: true });
  };

  // Escape-to-close and Enter-to-submit share one listener (Enter needs
  // `canCreate`, which Modal's own closeOnEscape has no equivalent for) — so
  // Modal is told closeOnEscape={false} to avoid double-handling Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      } else if (e.key === 'Enter' && canCreate) {
        const activeEl = document.activeElement as HTMLElement | null;
        if (activeEl?.tagName !== 'SELECT') {
          e.preventDefault();
          void submit();
        }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  return (
    <Modal onClose={onClose} width={480} closeOnEscape={false} closeOnBackdropClick={true}>
      <ModalHeader>
        <span className="new-session-modal__title">
          <span className="new-session-modal__title-accent">›</span> new session
        </span>
      </ModalHeader>

      <ModalBody>
        {/* projects: the project comes FIRST — picking one settles the working
            directory and every default below, so it is the decision the rest
            of the form hangs off. Hidden entirely when no project exists yet,
            so the pre-projects form is untouched until you make one. */}
        <ProjectField
          projects={projects}
          projectId={projectId}
          project={project}
          projectRootMissing={projectRootMissing}
          staleModelId={staleModelId}
          onChange={setProjectId}
        />

        {/* The DIRECTORY row exists only for an unlinked session. With a project
            selected the root IS the working directory, so an editable path here
            would be a second source of truth for the same value. */}
        {project === null && (
          <DirectoryField cwd={cwd} onChange={applyCwd} onBrowse={() => void browse()} picking={picking} pickerError={pickerError} />
        )}

        <NameField
          name={name}
          onChange={(value) => {
            setName(value);
            setNameTouched(true);
          }}
        />

        <ModelField models={models} modelId={modelId} loading={modelsLoading} onChange={setModelId} />

        {modelEfforts.length > 0 && (
          <div>
            <label className="new-session-modal__label">EFFORT</label>
            <div className="new-session-modal__chip-row new-session-modal__chip-row--wrap">
              <ChipGroup
                options={[{ value: '', label: 'default' }, ...modelEfforts.map((effort_) => ({ value: effort_, label: effort_ }))]}
                value={effort}
                onChange={setEffort}
              />
            </div>
          </div>
        )}

        <div>
          <label className="new-session-modal__label">PERMISSIONS</label>
          <div className="new-session-modal__chip-row new-session-modal__chip-row--wrap">
            <ChipGroup options={PERMISSION_CHIP_OPTIONS} value={permissionMode} onChange={setPermissionMode} />
          </div>
          <div className="new-session-modal__hint new-session-modal__hint--below-chips">
            {PERMISSION_OPTIONS.find((opt) => opt.mode === permissionMode)?.hint}
          </div>
        </div>

        <div>
          <label className="new-session-modal__label">GIT</label>
          <div className="new-session-modal__chip-row">
            <Chip selected={allowGit} onClick={() => setAllowGit((v) => !v)}>
              {allowGit ? '✓ ' : ''}allow git commands
            </Chip>
          </div>
          <div className="new-session-modal__hint new-session-modal__hint--below-chips">
            auto-approve git &amp; gh commands (commit, push, PRs) without a prompt — other tools still follow the permission setting above
          </div>
        </div>

        {IS_WINDOWS && (
          <div>
            <label className="new-session-modal__label">CLAUDE RUNTIME</label>
            <div className="new-session-modal__chip-row">
              <ChipGroup
                options={RUNTIME_CHIP_OPTIONS}
                value={runtime}
                onChange={(value) => {
                  setRuntime(value);
                  setRuntimeTouched(true);
                }}
              />
            </div>
            {/* FR-16/17: mutually exclusive, below the row — never blocks creation. */}
            {runtime === 'wsl' ? (
              <div className="new-session-modal__hint new-session-modal__hint--below-chips">
                {cwdIsWsl
                  ? 'WSL directory — claude will run inside your default distro'
                  : 'runs `claude` inside your default WSL distro (wsl.exe translates the directory)'}
              </div>
            ) : (
              cwdIsWsl && (
                <div className="new-session-modal__hint new-session-modal__hint--below-chips new-session-modal__hint--error">
                  Windows tools will access this directory over 9P — expect slow git and no live diff updates
                </div>
              )
            )}
          </div>
        )}

        <WorktreeField worktree={worktree} onOpenRecovery={() => void openRecoverySession()} />

        {submitError && <div className="form-error">{submitError.message}</div>}
      </ModalBody>

      <ModalFooter>
        <div className="new-session-modal__actions">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={!canCreate}>
            {submitting ? 'creating…' : 'Create session'}
          </Button>
        </div>
      </ModalFooter>
    </Modal>
  );
}
