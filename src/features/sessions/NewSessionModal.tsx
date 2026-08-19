import { useEffect, useState } from 'react';
import type { AppError, ClaudeRuntime, PermissionMode, SessionMeta } from '../../../contract/common';
import { PERMISSION_MODE_OPTIONS } from '../../../contract/session-permission-mode';
import { isWslUncPath } from '../../../contract/wsl-filesystem';
import { sessionCreate } from '../../lib/api';
import { useStore } from '../../lib/store';
import { useMounted } from '../../lib/hooks/useMounted';
import { IS_WINDOWS } from '../../lib/platform';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '../../ui/Modal';
import { Button } from '../../ui/Button';
import { Chip } from '../../ui/Chip';
import { ChipGroup, type ChipOption } from '../../ui/ChipGroup';
import { DEFAULT_ACCOUNT_ID } from '../../../contract/multi-account';
import { accountIdForSessionCreate, modelPickerProviderHeading } from '../accounts/accounts';
import { AccountField } from './AccountField';
import { ProfileField } from './ProfileField';
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

// session-permission-mode FR-8: PERMISSION_MODE_OPTIONS (contract) is now the
// single source for the label/hint/danger flag — no component maps a mode to
// a label or a hint on its own.
const PERMISSION_CHIP_OPTIONS: ChipOption<PermissionMode>[] = PERMISSION_MODE_OPTIONS.map((opt) => ({
  value: opt.mode,
  label: opt.label,
  danger: opt.danger,
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
  // multi-account FR-18: the account this session will be bound to for life.
  // Seeded from the app default and re-seeded from the project's (FR-20) by
  // useProjectDefaults below.
  const [accountId, setAccountId] = useState<string>(DEFAULT_ACCOUNT_ID);
  const [accountFromProject, setAccountFromProject] = useState(false);
  // session-profiles FR-15/FR-18: '' = no profile. The picked profile's
  // systemPrompt/extraArgs are NOT re-edited here — session_create reads them
  // straight off the live registry entry at submit time.
  const [profileId, setProfileId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<AppError | null>(null);
  // RE-ARM on every mount. StrictMode runs mount → cleanup → mount on the same
  // instance, so without this the cleanup's `false` survives into the second
  // mount and any effect that guards on openRef before setState silently does
  // nothing (this is exactly what swallowed the project list).
  const openRef = useMounted();

  // multi-account: hydrated app-wide by App.tsx's account feed — the modal
  // never reads the registry itself.
  const accounts = useStore((s) => s.accounts);

  // multi-provider-openai FR-18/FR-21: the catalog is keyed on the selected
  // account, not a session (there is none yet) — switching accounts here
  // refetches and repopulates it with that account's own models.
  const { models, modelsLoading, modelId, setModelId } = useModelCatalog(accountId);
  // FR-21: the picker's neutral group heading — the selected account's own
  // label, never `agentRuntime`/`protocol` (see modelPickerProviderHeading).
  const providerHeading = modelPickerProviderHeading(accounts, accountId);

  // projects FR-30: opening the modal while the board is scoped to a project
  // starts in that project — "inside a project, a new session belongs to it".
  const activeProjectId = useStore((s) => s.activeProjectId);
  const { projects, projectId, setProjectId, recoverFromProjectError } = useProjectList(activeProjectId, openRef);

  const project = projects.find((p) => p.id === projectId) ?? null;
  const projectRootMissing = project !== null && !project.rootExists;

  // session-profiles: hydrated app-wide by App.tsx at boot — same pattern.
  const profiles = useStore((s) => s.profiles);

  // palette FR-24 "New session with profile…": a one-shot preselect consumed
  // once, then cleared, so re-opening the modal later never re-applies it.
  const pendingNewSessionProfileId = useStore((s) => s.pendingNewSessionProfileId);
  const setPendingNewSessionProfileId = useStore((s) => s.setPendingNewSessionProfileId);
  useEffect(() => {
    if (!pendingNewSessionProfileId) return;
    const picked = profiles.find((p) => p.id === pendingNewSessionProfileId) ?? null;
    if (!picked) return; // registry not hydrated yet — retry once it is
    setProfileId(picked.id);
    setPendingNewSessionProfileId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingNewSessionProfileId, profiles]);

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
    accounts,
    setAccountId,
    setAccountFromProject,
    profiles,
    setProfileId,
    pendingProfileId: pendingNewSessionProfileId,
  });

  const { picking, pickerError, applyCwd, browse } = useDirectoryPicker({
    nameTouched,
    runtimeTouched,
    setCwd,
    setName,
    setRuntime,
  });

  // session-worktree FR-1..FR-5 + attach-to-worktree FR-1..FR-17: the WORKTREE group.
  const sessions = useStore((s) => s.sessions);
  const worktree = useWorktreeGroup({
    cwd,
    name,
    nameTouched,
    setName,
    openRef,
    modelId,
    projectRootMissing,
    submitting,
    sessions,
    caseInsensitive: IS_WINDOWS,
  });

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
      // multi-account FR-18/FR-19: bound at creation and never changed after,
      // sent verbatim — see accountIdForSessionCreate for why the built-in
      // 'default' id is never special-cased into an omitted field.
      accountId: accountIdForSessionCreate(accountId),
      // session-profiles FR-15/FR-18: profileId rides regardless of any edit
      // to the fields it pre-filled — the chip records where the session came
      // from, the RESOLVED values (read live off the registry) are the truth.
      profileId: profileId || undefined,
      systemPrompt: profiles.find((p) => p.id === profileId)?.systemPrompt,
      extraArgs: profiles.find((p) => p.id === profileId)?.extraArgs,
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
      } else if (res.error.code === 'WORKTREE_NOT_FOUND' && worktree.mode === 'attach') {
        // §7 "Tree removed between probe and create": surface the error AND
        // re-probe, so the stale (now-wrong) row can't be retried identically.
        worktree.reprobe();
      } else {
        const racePath = worktreeBranchInUsePath(res.error);
        if (racePath) worktree.applyRacePath(racePath);
      }
    }
  };

  const submit = async () => {
    if (!canCreate) return;
    // attach-to-worktree FR-14: `branch`/`baseRef` stay required on the wire and
    // are IGNORED under `adopt` — the core fills provenance from `git worktree
    // list`. The frontend never guesses them; it sends ''.
    if (worktree.mode === 'attach' && worktree.selectedPath) {
      await createSession(worktree.selectedPath, { branch: '', baseRef: '', adopt: true });
      return;
    }
    const worktreeOpts =
      worktree.mode === 'create' && worktree.probe?.isRepo
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
        // attach-to-worktree: a focused picker row owns Enter first — this
        // listener runs in the capture phase, ahead of WorktreeAttachPicker's
        // own bubble-phase handler, so without this guard Enter would submit
        // with the STALE previous selectedPath before the row's onSelect runs.
        if (activeEl?.tagName !== 'SELECT' && activeEl?.dataset.worktreeRow === undefined) {
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

        <ModelField
          models={models}
          modelId={modelId}
          loading={modelsLoading}
          onChange={setModelId}
          providerHeading={providerHeading}
        />

        {/* multi-account FR-31: directly after MODEL, joining the tab order there */}
        <AccountField
          accounts={accounts}
          accountId={accountId}
          fromProject={accountFromProject}
          onChange={(id) => {
            setAccountId(id);
            setAccountFromProject(false);
          }}
        />

        {/* session-profiles: right after ACCOUNT. A profile contributes a name,
            a system prompt and extra args only — the model / effort / permission
            controls below belong to the PROJECT and are left untouched. */}
        <ProfileField profiles={profiles} profileId={profileId} onChange={setProfileId} />

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
            {PERMISSION_MODE_OPTIONS.find((opt) => opt.mode === permissionMode)?.hint}
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
