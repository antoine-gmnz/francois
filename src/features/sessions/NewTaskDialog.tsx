// New task dialog — redesign "Graphite & Signal", Figma "19 · New task"
// (139:6889; light 142:15513). This is the session settings sheet's CREATE mode
// (session-settings-sheet FR-7/FR-22), moved out of SessionSettingsSheet.tsx and
// regrouped around the task:
//
//   What should the agent do?   — optional; sent as the first message once the
//                                 session exists (parked in the pending queue so
//                                 it shows until the core mints the turn)
//   Name                        — outside the fold: nearly every task sets it
//   Project · Model             — the project (or, with no project, the directory)
//   Where it works              — Current checkout / Dedicated worktree cards over
//                                 the worktree group's off / create modes, with
//                                 "attach to an existing worktree" as a link
//   Advanced                    — folded: account, profile, effort, runtime,
//                                 permissions, response, git, base ref — with a
//                                 recap of every value shown while it is closed
//
// Every state, default and guard is the create sheet's own, unchanged: project
// defaults (useProjectDefaults), the worktree group (useWorktreeGroup), the
// retired-runtime and mismatch gates, the submit error recovery paths.

import { useEffect, useRef, useState } from 'react';
import { homeDir } from '@tauri-apps/api/path';
import type { AppError, ClaudeRuntime, PermissionMode, ResponseMode, SessionMeta } from '../../../contract/common';
import { DEFAULT_ACCOUNT_ID } from '../../../contract/multi-account';
import { isWslUncPath } from '../../../contract/wsl-filesystem';
import { accountIdForSessionCreate, modelPickerProviderHeading } from '../../lib/account-selection';
import { sessionCreate, sessionSend } from '../../lib/api';
import { useModelCatalog } from '../../lib/hooks/useModelCatalog';
import { useMounted } from '../../lib/hooks/useMounted';
import { IS_WINDOWS } from '../../lib/platform';
import { profileIsRetired, accountIsRetired } from '../../lib/runtimeCapability';
import { useStore } from '../../lib/store';
import { Button } from '../../ui/Button';
import { ChipGroup } from '../../ui/ChipGroup';
import { Icon } from '../../ui/Icon';
import { IconButton } from '../../ui/IconButton';
import { Modal } from '../../ui/Modal';
import { Radio } from '../../ui/Radio';
import { recordSent } from '../../lib/message-history';
import { parkPrompt, resolvePrompt } from '../../lib/pending-queue';
import { setDraft } from '../../lib/composer-draft';
import { PROJECT_ROOT_MISSING_LINE, abbreviateRoot, newSessionProjectOptions } from '../projects/projects';
import { AccountField } from './AccountField';
import { DirectoryField } from './DirectoryField';
import { ModelCatalogStatus } from '../../ui/ModelCatalogStatus';
import ModelPicker from './ModelPicker';
import { advancedRecap, firstPrompt, isStartChord, whereCard } from './new-task';
import { modelSelectionMismatch, profileRuntimeMismatch } from './new-session-form';
import { ProfileField } from './ProfileField';
import { RUNTIME_CHIP_OPTIONS, submitSettingsOnEnter, type SessionSettingsCarryOver } from './session-settings';
import { GitRow, PermissionsRow, ResponseRow } from './SharedSettingsRows';
import { useDirectoryPicker } from './useDirectoryPicker';
import { useProjectDefaults } from './useProjectDefaults';
import { useProjectList } from './useProjectList';
import { useWorktreeGroup } from './useWorktreeGroup';
import { submitErrorBanner, worktreeBranchInUsePath } from './worktree';
import { WorktreeAttachPicker } from './WorktreeAttachPicker';
import './new-task.css';
import './session-settings-sheet.css';

/**
 * Send the task's prompt as the new session's first message. Parked in the
 * pending queue first — the core mints the transcript block when the turn
 * begins, and message.user resolves the entry — so it is visible at once. A
 * failed send hands the text to the composer's draft instead of losing it.
 */
async function sendFirstPrompt(sessionId: string, text: string): Promise<void> {
  const blockId = crypto.randomUUID();
  parkPrompt(sessionId, blockId, text);
  const res = await sessionSend(sessionId, blockId, text).catch(() => null);
  if (res?.ok) {
    recordSent(sessionId, text);
    return;
  }
  resolvePrompt(sessionId, blockId);
  setDraft(sessionId, text);
}

/** The user's home dir, for `~/code/orbit`; '' until resolved (or with no Tauri runtime). */
function useHomeDir(): string {
  const [home, setHome] = useState('');
  useEffect(() => {
    let live = true;
    try {
      void homeDir()
        .then((h) => live && setHome(h.replace(/[\\/]+$/, '')))
        .catch(() => {});
    } catch {
      // demo build in a plain browser — no path API
    }
    return () => {
      live = false;
    };
  }, []);
  return home;
}

export function NewTaskDialog({
  seed,
  onClose,
  onCreated,
}: {
  seed?: SessionSettingsCarryOver;
  onClose: () => void;
  onCreated: (meta: SessionMeta) => void;
}) {
  const [prompt, setPrompt] = useState('');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [cwd, setCwd] = useState(seed?.projectId ? '' : (seed?.cwd ?? ''));
  const [name, setName] = useState(seed?.name ?? '');
  const [nameTouched, setNameTouched] = useState(seed?.name !== undefined);
  // §7 case 22: a project default naming a model the catalog no longer lists.
  const [staleModelId, setStaleModelId] = useState<string | null>(null);
  const [effort, setEffort] = useState(seed?.effort ?? ''); // '' = model default
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(seed?.permissionMode ?? 'default');
  const [responseMode, setResponseMode] = useState<ResponseMode>(seed?.responseMode ?? 'default');
  const [allowGit, setAllowGit] = useState(seed?.allowGit ?? false);
  const [runtime, setRuntime] = useState<ClaudeRuntime>(seed?.runtime ?? 'native');
  const [runtimeTouched, setRuntimeTouched] = useState(seed?.runtime !== undefined);
  const [accountId, setAccountId] = useState<string>(seed?.accountId ?? DEFAULT_ACCOUNT_ID);
  const [accountFromProject, setAccountFromProject] = useState(false);
  const [profileId, setProfileId] = useState(seed?.profileId ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<AppError | null>(null);
  const openRef = useMounted();
  const cwdSeededRef = useRef(false);
  const promptRef = useRef<HTMLTextAreaElement>(null);

  const accounts = useStore((s) => s.accounts);
  const providerHeading = modelPickerProviderHeading(accounts, accountId);

  const activeProjectId = useStore((s) => s.activeProjectId);
  const { projects, projectId, setProjectId, recoverFromProjectError } = useProjectList(
    activeProjectId,
    openRef,
    seed ? { projectId: seed.projectId } : undefined,
  );

  const project = projects.find((p) => p.id === projectId) ?? null;
  const projectRootMissing = project !== null && !project.rootExists;
  const [replacedDefaultProject, setReplacedDefaultProject] = useState<string | null>(null);
  const retiredDefault = !!project?.defaults.runtimeModel && replacedDefaultProject !== projectId;
  const catalogState = useModelCatalog(accountId, seed?.modelId, retiredDefault);
  const { models, modelsLoading, modelId, setModelId } = catalogState;

  // session-settings-sheet FR-13: the seeded project's root fills `cwd` once the
  // list resolves, without re-running (or being overridden by) the normal
  // project-defaults effect below.
  useEffect(() => {
    if (!seed?.projectId || cwdSeededRef.current) return;
    const p = projects.find((pr) => pr.id === seed.projectId);
    if (!p) return;
    cwdSeededRef.current = true;
    setCwd(p.root);
  }, [projects, seed?.projectId]);

  useEffect(() => {
    promptRef.current?.focus();
  }, []);

  const profiles = useStore((s) => s.profiles);
  const selectedAccount = accounts.find((a) => a.id === accountId) ?? null;
  const isPiAccount = selectedAccount !== null && accountIsRetired(selectedAccount);

  const pendingNewSessionProfileId = useStore((s) => s.pendingNewSessionProfileId);
  const setPendingNewSessionProfileId = useStore((s) => s.setPendingNewSessionProfileId);
  useEffect(() => {
    if (!pendingNewSessionProfileId) return;
    const picked = profiles.find((p) => p.id === pendingNewSessionProfileId) ?? null;
    if (!picked) return;
    setProfileId(picked.id);
    setPendingNewSessionProfileId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingNewSessionProfileId, profiles]);

  useProjectDefaults({
    accountId,
    defaultModelId: catalogState.catalog?.defaultModelId ?? null,
    projectId,
    project,
    models,
    modelsLoading,
    nameTouched,
    runtimeTouched,
    setModelId,
    setEffort,
    setPermissionMode,
    setResponseMode,
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
    seeded: seed !== undefined,
  });

  const { picking, pickerError, applyCwd, browse } = useDirectoryPicker({ nameTouched, runtimeTouched, setCwd, setName, setRuntime });

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

  const selectedModel = models.find((m) => m.id === modelId);
  const modelEfforts = selectedModel?.efforts ?? [];

  // Reset effort if the newly selected model doesn't support the current level
  // — guarded on the catalog having actually loaded, so a SEEDED effort isn't
  // cleared by the one-render window before `models` resolves (FR-13).
  useEffect(() => {
    if (modelsLoading || !catalogState.catalog) return;
    if (effort && !modelEfforts.includes(effort)) setEffort('');
  }, [modelId, models, modelsLoading]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectedProfile = profiles.find((p) => p.id === profileId) ?? null;
  const profileMismatch = profileRuntimeMismatch(selectedProfile, selectedAccount);
  const modelMismatch = modelSelectionMismatch(selectedAccount, modelId, retiredDefault ? project?.defaults.runtimeModel : undefined);
  const canCreate =
    !isPiAccount &&
    selectedAccount !== null &&
    cwd.trim() !== '' &&
    name.trim() !== '' &&
    models.some((m) => m.id === modelId) &&
    (!profileId || selectedProfile !== null) &&
    profileMismatch === null &&
    modelMismatch === null &&
    !submitting &&
    !projectRootMissing &&
    !worktree.blocked;
  const cwdIsWsl = isWslUncPath(cwd);

  const createSession = async (overrideCwd: string, worktreeOpts?: { branch: string; baseRef: string; adopt?: boolean }) => {
    if (retiredDefault || isPiAccount || profileIsRetired(selectedProfile)) return;
    setSubmitting(true);
    setSubmitError(null);
    const res = await sessionCreate({
      cwd: overrideCwd,
      name,
      modelId,
      effort: effort || undefined,
      permissionMode: permissionMode !== 'default' ? permissionMode : undefined,
      responseMode: responseMode !== 'default' ? responseMode : undefined,
      runtime: runtime !== 'native' ? runtime : undefined,
      allowGit: allowGit || undefined,
      projectId: projectId || undefined,
      worktree: worktreeOpts,
      accountId: accountIdForSessionCreate(accountId),
      profileId: profileId || undefined,
      systemPrompt: selectedProfile?.kind === 'legacy' ? selectedProfile.systemPrompt : undefined,
      extraArgs: selectedProfile?.kind === 'legacy' ? selectedProfile.extraArgs : undefined,
    });
    const text = firstPrompt(prompt);
    if (res.ok && text) void sendFirstPrompt(res.data.id, text);
    if (!openRef.current) {
      if (res.ok) onCreated(res.data);
      return;
    }
    setSubmitting(false);
    worktree.setRecovering(false);
    if (res.ok) {
      onCreated(res.data);
      onClose();
    } else {
      setSubmitError(submitErrorBanner(res.error));
      if (res.error.code === 'PROJECT_NOT_FOUND' || res.error.code === 'PROJECT_ROOT_MISSING') {
        await recoverFromProjectError();
      } else if (res.error.code === 'WORKTREE_NOT_FOUND' && worktree.mode === 'attach') {
        worktree.reprobe();
      } else {
        const racePath = worktreeBranchInUsePath(res.error);
        if (racePath) worktree.applyRacePath(racePath);
      }
    }
  };

  const submit = async () => {
    if (!canCreate) return;
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

  const openRecoverySession = async () => {
    if (!worktree.recoveryPath || !worktree.canOpenRecovery) return;
    worktree.setRecovering(true);
    await createSession(worktree.recoveryPath, { branch: worktree.branch.trim(), baseRef: worktree.baseRef.trim(), adopt: true });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      } else if (canCreate && isStartChord(e)) {
        e.preventDefault();
        void submit();
      } else if (e.key === 'Enter' && canCreate) {
        submitSettingsOnEnter(e, submit);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  const probe = worktree.probe;
  const card = whereCard(worktree.mode);
  const checkoutBranch = probe?.currentBranch ?? probe?.defaultBranch ?? null;
  const home = useHomeDir();

  return (
    <Modal onClose={onClose} width={640} closeOnEscape={false} closeOnBackdropClick={true} className="new-task-backdrop">
      <div className="new-task" role="dialog" aria-label="New task">
        <div className="new-task__head">
          <h2 className="new-task__title">New task</h2>
          <IconButton title="Close" onClick={onClose}>
            <Icon name="x" size={14} />
          </IconButton>
        </div>

        <div className="new-task__body">
          <label className="new-task__field">
            <span className="new-task__label">What should the agent do?</span>
            <textarea
              ref={promptRef}
              className="new-task__prompt"
              value={prompt}
              placeholder="Describe the task — or leave it empty to start an idle session"
              onChange={(e) => setPrompt(e.target.value)}
            />
          </label>

          <label className="new-task__field">
            <span className="new-task__label">Name</span>
            <input
              className="new-task__input"
              value={name}
              placeholder="session name"
              onChange={(e) => {
                setName(e.target.value);
                setNameTouched(true);
              }}
            />
          </label>

          <div className="new-task__pair">
            {projects.length > 0 ? (
              <div className="new-task__field new-task__field--grow">
                <span className="new-task__label">Project</span>
                <div className="new-task__select">
                  <span className="new-task__select-value">{project?.name ?? 'No project'}</span>
                  {project && <span className="new-task__select-path truncate">{abbreviateRoot(project.root, home)}</span>}
                  <Icon name="chevron-down" size={12} className="new-task__select-caret" />
                  <select
                    aria-label="Project"
                    className="new-task__select-native"
                    value={projectId}
                    onChange={(e) => {
                      setReplacedDefaultProject(null);
                      setProjectId(e.target.value);
                    }}
                  >
                    {newSessionProjectOptions(projects).map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.missing ? `${opt.label} (missing)` : opt.label}
                      </option>
                    ))}
                  </select>
                </div>
                {projectRootMissing && <span className="new-task__note new-task__note--error">{PROJECT_ROOT_MISSING_LINE}</span>}
                {staleModelId && (
                  <span className="new-task__note">This project's default model ({staleModelId}) is no longer available — using the default.</span>
                )}
              </div>
            ) : null}
            <div className="new-task__field new-task__field--model">
              <span className="new-task__label">Model</span>
              <ModelPicker models={models} modelId={modelId} loading={modelsLoading} onChange={setModelId} providerHeading={providerHeading} />
              <ModelCatalogStatus state={catalogState} />
            </div>
          </div>

          {project === null && (
            <DirectoryField cwd={cwd} onChange={applyCwd} onBrowse={() => void browse()} picking={picking} pickerError={pickerError} />
          )}

          {probe?.isRepo && (
            <div className="new-task__field">
              <span className="new-task__label">Where it works</span>
              <div role="radiogroup" aria-label="Where it works" className="new-task__where">
                <div
                  role="radio"
                  aria-checked={card === 'checkout'}
                  tabIndex={0}
                  className={card === 'checkout' ? 'new-task__option new-task__option--on' : 'new-task__option'}
                  onClick={() => worktree.setMode('off')}
                  onKeyDown={(e) => (e.key === ' ' ? (e.preventDefault(), worktree.setMode('off')) : undefined)}
                >
                  <span className="new-task__option-title">
                    <Radio on={card === 'checkout'} /> Current checkout
                  </span>
                  <span className="new-task__option-desc">
                    {checkoutBranch ? (
                      <>
                        Works directly on <code className="new-task__code">{checkoutBranch}</code>. Edits land in your working tree.
                      </>
                    ) : (
                      'Edits land in your working tree.'
                    )}
                  </span>
                </div>
                <div
                  role="radio"
                  aria-checked={card === 'worktree'}
                  tabIndex={0}
                  className={card === 'worktree' ? 'new-task__option new-task__option--on' : 'new-task__option'}
                  onClick={() => worktree.mode !== 'create' && worktree.setMode('create')}
                  onKeyDown={(e) => (e.key === ' ' && e.target === e.currentTarget ? (e.preventDefault(), worktree.setMode('create')) : undefined)}
                >
                  <span className="new-task__option-title">
                    <Radio on={card === 'worktree'} /> Dedicated worktree
                  </span>
                  <span className="new-task__option-desc">Isolated copy on a new branch. Nothing touches your checkout.</span>
                  {card === 'worktree' && (
                    <label className="new-task__branch">
                      <Icon name="branch" size={12} />
                      <input
                        aria-label="Branch"
                        className="new-task__branch-input"
                        value={worktree.branch}
                        placeholder="feat/my-change"
                        onChange={(e) => worktree.setBranch(e.target.value)}
                        onClick={(e) => e.stopPropagation()}
                      />
                    </label>
                  )}
                </div>
              </div>
              <WorktreeNotes worktree={worktree} onOpenRecovery={() => void openRecoverySession()} />
              {worktree.rows.length > 0 && (
                <button
                  type="button"
                  className="new-task__link"
                  onClick={() => worktree.setMode(worktree.mode === 'attach' ? 'off' : 'attach')}
                >
                  {worktree.mode === 'attach' ? 'Back to the checkout' : 'Or attach to an existing worktree…'}
                </button>
              )}
              {worktree.mode === 'attach' && (
                <WorktreeAttachPicker rows={worktree.rows} selectedPath={worktree.selectedPath} onSelect={worktree.selectRow} />
              )}
            </div>
          )}

          <div className="new-task__advanced">
            <button type="button" className="new-task__advanced-toggle" aria-expanded={advancedOpen} onClick={() => setAdvancedOpen(!advancedOpen)}>
              <Icon name={advancedOpen ? 'chevron-down' : 'chevron-right'} size={12} />
              Advanced
            </button>
            {!advancedOpen && (
              <button type="button" className="new-task__recap" aria-label="Advanced settings" onClick={() => setAdvancedOpen(true)}>
                {advancedRecap({
                  accountLabel: selectedAccount?.label ?? null,
                  accountIsDefault: accountId === DEFAULT_ACCOUNT_ID,
                  profileName: selectedProfile?.name ?? null,
                  effort,
                  defaultEffort: selectedModel?.defaultEffort ?? null,
                  showEffort: modelEfforts.length > 0,
                  runtime: IS_WINDOWS ? runtime : null,
                  permissionMode,
                  responseMode,
                  allowGit,
                  baseRef: worktree.mode === 'create' && probe?.isRepo ? worktree.baseRef.trim() || probe.defaultBranch || 'main' : null,
                }).map((item) => (
                  <span key={item.key} className={item.changed ? 'new-task__recap-item new-task__recap-item--changed' : 'new-task__recap-item'}>
                    <span className="new-task__recap-label">{item.label}</span>
                    <span className="new-task__recap-value">{item.value}</span>
                  </span>
                ))}
              </button>
            )}
            {advancedOpen && (
              <div className="new-task__advanced-body">
                {modelEfforts.length > 0 && (
                  <div>
                    <label className="new-session-modal__label">EFFORT</label>
                    <div className="new-session-modal__chip-row new-session-modal__chip-row--wrap">
                      <ChipGroup
                        options={[
                          { value: '', label: selectedModel?.defaultEffort ? `Model default · ${selectedModel.defaultEffort}` : 'Model default' },
                          ...modelEfforts.map((e) => ({ value: e, label: e })),
                        ]}
                        value={effort}
                        onChange={setEffort}
                      />
                    </div>
                  </div>
                )}
                {retiredDefault && (
                  <div className="new-session-modal__hint new-session-modal__hint--error">
                    Saved Pi model {project?.defaults.runtimeModel?.providerId} / {project?.defaults.runtimeModel?.modelId} · Unavailable. Choose an available account explicitly.
                  </div>
                )}
                <AccountField
                  accounts={accounts}
                  accountId={accountId}
                  unavailableDefault={retiredDefault}
                  fromProject={accountFromProject}
                  onChange={(id) => {
                    setAccountId(id);
                    setReplacedDefaultProject(projectId);
                    setAccountFromProject(false);
                  }}
                />
                <ProfileField profiles={profiles} profileId={profileId} onChange={setProfileId} accounts={accounts} accountId={accountId} />
                {IS_WINDOWS && (
                  <div>
                    <label className="new-session-modal__label">RUNTIME</label>
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
                <PermissionsRow value={permissionMode} onChange={setPermissionMode} />
                <ResponseRow value={responseMode} onChange={setResponseMode} />
                <GitRow value={allowGit} onChange={setAllowGit} />
                {worktree.mode === 'create' && probe?.isRepo && (
                  <div>
                    <label className="new-session-modal__label">BASE REF</label>
                    {/* FR-3: an existing branch is checked out as-is, so its base ref is not a choice. */}
                    <input
                      className="new-session-modal__field worktree-field__mono"
                      value={worktree.baseRef}
                      disabled={!!probe.branchExists}
                      placeholder={probe.defaultBranch ?? 'main'}
                      onChange={(e) => worktree.setBaseRef(e.target.value)}
                    />
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="new-task__footer">
          <span className={submitError ? 'new-task__footer-note new-task__footer-note--error' : 'new-task__footer-note'}>
            {submitError ? submitError.message : firstPrompt(prompt) ? 'Sent as the first message once the session starts' : 'Leave the prompt empty to start an idle session'}
          </span>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" shortcut="⌘⏎" onClick={() => void submit()} disabled={!canCreate} busy={submitting}>
            Start task
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** The worktree group's inline notices — the path preview, the branch-in-use recovery, the branch checks. */
function WorktreeNotes({ worktree, onOpenRecovery }: { worktree: ReturnType<typeof useWorktreeGroup>; onOpenRecovery: () => void }) {
  if (worktree.mode !== 'create') return null;
  const { branch, branchValid, worktreePreview, recoveryPath, recovering, canOpenRecovery, probe } = worktree;
  return (
    <>
      {worktreePreview && (
        <span className="new-task__note new-task__note--path" title={worktreePreview}>
          {worktreePreview}
        </span>
      )}
      {recoveryPath ? (
        <span className="new-task__note">
          <code className="new-task__code">{branch.trim()}</code> is already checked out at <code className="new-task__code" title={recoveryPath}>{recoveryPath}</code> —{' '}
          <button type="button" className="new-task__link" disabled={!canOpenRecovery} onClick={onOpenRecovery}>
            {recovering ? 'opening…' : 'open a session there instead'}
          </button>
        </span>
      ) : probe?.branchExists ? (
        <span className="new-task__note">Existing branch — it will be checked out.</span>
      ) : (
        branch.trim() !== '' && !branchValid && <span className="new-task__note new-task__note--error">Invalid branch name</span>
      )}
    </>
  );
}
