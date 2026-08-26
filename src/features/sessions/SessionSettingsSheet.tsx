// session-settings-sheet — one component, two modes (FR-7). Create mode is
// NewSessionModal's own logic (FR-22: behaviour-identical, apart from the field
// order and PROFILE sitting after ACCOUNT), reordered per FR-7/FR-8. Edit mode
// is new: a live draft diffed against the session's current values (FR-14),
// applied in one atomic `session_update_settings` patch (FR-16).
//
// Two internal render functions, one exported component — CreateSheet and
// EditSheet share no state (a session-settings-sheet in one mode never becomes
// the other without unmounting: "New session from these ↗" hands control back
// to the parent, which swaps which one is mounted, see App.tsx) but do share
// every field subcomponent, ChipGroup option table and CSS class below.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AppError, ClaudeRuntime, PermissionMode, ResponseMode, SessionId, SessionMeta } from '../../../contract/common';
import { RESPONSE_MODE_OPTIONS } from '../../../contract/response-mode';
import { PERMISSION_MODE_OPTIONS } from '../../../contract/session-permission-mode';
import { isWslUncPath } from '../../../contract/wsl-filesystem';
import { DEFAULT_ACCOUNT_ID } from '../../../contract/multi-account';
import { projectUpdate, sessionCreate, sessionUpdateSettings } from '../../lib/api';
import { useStore } from '../../lib/store';
import { useMounted } from '../../lib/hooks/useMounted';
import { useTimedError } from '../../lib/hooks/useTimedError';
import { IS_WINDOWS } from '../../lib/platform';
import { toneVar } from '../../lib/tone';
import { STATUS_COLOR, statusPulses } from '../../../contract/fleet-board';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '../../ui/Modal';
import { Button } from '../../ui/Button';
import { Chip } from '../../ui/Chip';
import { ChipGroup, type ChipOption } from '../../ui/ChipGroup';
import { StatusDot } from '../../ui/StatusDot';
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
import { SESSION_NAME_MAX, canCommitRename, nameLength } from './rename';
import {
  SET_PROJECT_DEFAULT_COPY,
  SET_PROJECT_DEFAULT_TITLE,
  buildPatch,
  canSetProjectDefault,
  carryOverToCreate,
  changeCountLabel,
  dirtyKeys,
  draftFromSession,
  effortSupportedByModel,
  fixedAtSpawnLines,
  nextProjectDefaults,
  rebaseDraft,
  timingLine,
  type SessionSettingsCarryOver,
  type SettingsDraft,
} from './session-settings';
import './session-settings-sheet.css';

// session-permission-mode FR-8 / response-mode FR-13: the contract tables are
// the single source for label/hint/danger — no component maps a mode on its own.
const PERMISSION_CHIP_OPTIONS: ChipOption<PermissionMode>[] = PERMISSION_MODE_OPTIONS.map((opt) => ({
  value: opt.mode,
  label: opt.label,
  danger: opt.danger,
}));
const RESPONSE_CHIP_OPTIONS: ChipOption<ResponseMode>[] = RESPONSE_MODE_OPTIONS.map((opt) => ({
  value: opt.mode,
  label: opt.label,
}));
const RUNTIME_CHIP_OPTIONS: ChipOption<ClaudeRuntime>[] = (['native', 'wsl'] as const).map((runtime) => ({
  value: runtime,
  label: runtime,
}));

// CreateSheet and EditSheet render the same PERMISSIONS/RESPONSE/GIT rows —
// EditSheet wraps each in its own `field()` (dirty highlight + "was" line),
// CreateSheet renders it bare, but the row markup itself is identical.
function PermissionsRow({ value, onChange }: { value: PermissionMode; onChange: (mode: PermissionMode) => void }) {
  return (
    <div>
      <label className="new-session-modal__label">PERMISSIONS</label>
      <div className="new-session-modal__chip-row new-session-modal__chip-row--wrap">
        <ChipGroup options={PERMISSION_CHIP_OPTIONS} value={value} onChange={onChange} />
      </div>
      <div className="new-session-modal__hint new-session-modal__hint--below-chips">
        {PERMISSION_MODE_OPTIONS.find((opt) => opt.mode === value)?.hint}
      </div>
    </div>
  );
}

function ResponseRow({ value, onChange }: { value: ResponseMode; onChange: (mode: ResponseMode) => void }) {
  return (
    <div>
      <label className="new-session-modal__label">RESPONSE</label>
      <div className="new-session-modal__chip-row new-session-modal__chip-row--wrap">
        <ChipGroup options={RESPONSE_CHIP_OPTIONS} value={value} onChange={onChange} />
      </div>
      {/* FR-9: PERMISSIONS and RESPONSE alike get a consequence hint under the row. */}
      <div className="new-session-modal__hint new-session-modal__hint--below-chips">
        {RESPONSE_MODE_OPTIONS.find((opt) => opt.mode === value)?.hint}
      </div>
    </div>
  );
}

function GitRow({ value, onChange }: { value: boolean; onChange: (allow: boolean) => void }) {
  return (
    <div>
      <label className="new-session-modal__label">GIT</label>
      <div className="new-session-modal__chip-row">
        <Chip selected={value} onClick={() => onChange(!value)}>
          {value ? '✓ ' : ''}allow git commands
        </Chip>
      </div>
      <div className="new-session-modal__hint new-session-modal__hint--below-chips">
        auto-approve git &amp; gh commands (commit, push, PRs) without a prompt — other tools still follow the permission setting above
      </div>
    </div>
  );
}

export type SessionSettingsSheetProps =
  | { mode: 'create'; seed?: SessionSettingsCarryOver; onClose: () => void; onCreated: (meta: SessionMeta) => void }
  | { mode: 'edit'; sessionId: SessionId; onClose: () => void; onCarryOver: (seed: SessionSettingsCarryOver) => void };

export default function SessionSettingsSheet(props: SessionSettingsSheetProps) {
  if (props.mode === 'edit') return <EditSheet sessionId={props.sessionId} onClose={props.onClose} onCarryOver={props.onCarryOver} />;
  return <CreateSheet seed={props.seed} onClose={props.onClose} onCreated={props.onCreated} />;
}

// ============================================================================
// Create mode
// ============================================================================

function CreateSheet({
  seed,
  onClose,
  onCreated,
}: {
  seed?: SessionSettingsCarryOver;
  onClose: () => void;
  onCreated: (meta: SessionMeta) => void;
}) {
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

  const accounts = useStore((s) => s.accounts);
  const { models, modelsLoading, modelId, setModelId } = useModelCatalog(accountId, seed?.modelId);
  const providerHeading = modelPickerProviderHeading(accounts, accountId);

  const activeProjectId = useStore((s) => s.activeProjectId);
  const { projects, projectId, setProjectId, recoverFromProjectError } = useProjectList(
    activeProjectId,
    openRef,
    seed ? { projectId: seed.projectId } : undefined,
  );

  const project = projects.find((p) => p.id === projectId) ?? null;
  const projectRootMissing = project !== null && !project.rootExists;

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

  const profiles = useStore((s) => s.profiles);

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

  const modelEfforts = models.find((m) => m.id === modelId)?.efforts ?? [];

  // Reset effort if the newly selected model doesn't support the current level
  // — guarded on the catalog having actually loaded, so a SEEDED effort isn't
  // cleared by the one-render window before `models` resolves (FR-13).
  useEffect(() => {
    if (modelsLoading) return;
    if (effort && !modelEfforts.includes(effort)) setEffort('');
  }, [modelId, models, modelsLoading]); // eslint-disable-line react-hooks/exhaustive-deps

  const canCreate =
    cwd.trim() !== '' && name.trim() !== '' && modelId !== '' && !submitting && !projectRootMissing && !worktree.blocked;
  const cwdIsWsl = isWslUncPath(cwd);

  const createSession = async (overrideCwd: string, worktreeOpts?: { branch: string; baseRef: string; adopt?: boolean }) => {
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
      systemPrompt: profiles.find((p) => p.id === profileId)?.systemPrompt,
      extraArgs: profiles.find((p) => p.id === profileId)?.extraArgs,
    });
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
      } else if (e.key === 'Enter' && canCreate) {
        const activeEl = document.activeElement as HTMLElement | null;
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
        <div className="session-settings-sheet__title-row">
          <span className="new-session-modal__title">
            <span className="new-session-modal__title-accent">›</span> new session
          </span>
          {project && <span className="new-session-modal__hint">defaults from {project.name}</span>}
        </div>
      </ModalHeader>

      <ModalBody>
        {/* FR-7/FR-8: PROJECT+NAME share one row. */}
        <div className="session-settings-sheet__pair session-settings-sheet__pair--even">
          <ProjectField
            projects={projects}
            projectId={projectId}
            project={project}
            projectRootMissing={projectRootMissing}
            staleModelId={staleModelId}
            onChange={setProjectId}
          />
          <NameField
            name={name}
            onChange={(value) => {
              setName(value);
              setNameTouched(true);
            }}
          />
        </div>

        {project === null && (
          <DirectoryField cwd={cwd} onChange={applyCwd} onBrowse={() => void browse()} picking={picking} pickerError={pickerError} />
        )}

        {/* FR-7/FR-8: EFFORT joins MODEL's row, fixed width, right — and renders no
            track at all when the model advertises none, per the existing rule. */}
        <div className={modelEfforts.length > 0 ? 'session-settings-sheet__pair session-settings-sheet__pair--effort' : undefined}>
          <ModelField models={models} modelId={modelId} loading={modelsLoading} onChange={setModelId} providerHeading={providerHeading} />
          {modelEfforts.length > 0 && (
            <div>
              <label className="new-session-modal__label">EFFORT</label>
              <div className="new-session-modal__chip-row new-session-modal__chip-row--wrap">
                <ChipGroup
                  options={[{ value: '', label: 'default' }, ...modelEfforts.map((e) => ({ value: e, label: e }))]}
                  value={effort}
                  onChange={setEffort}
                />
              </div>
            </div>
          )}
        </div>

        <AccountField
          accounts={accounts}
          accountId={accountId}
          fromProject={accountFromProject}
          onChange={(id) => {
            setAccountId(id);
            setAccountFromProject(false);
          }}
        />

        <ProfileField profiles={profiles} profileId={profileId} onChange={setProfileId} />

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

        <WorktreeField worktree={worktree} onOpenRecovery={() => void openRecoverySession()} />

        {submitError && <div className="form-error">{submitError.message}</div>}
      </ModalBody>

      <ModalFooter>
        <div className="new-session-modal__actions">
          <span className="session-settings-sheet__foot-hint">⏎ create</span>
          <span className="app-flex-spacer" />
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

// ============================================================================
// Edit mode
// ============================================================================

function EditSheet({
  sessionId,
  onClose,
  onCarryOver,
}: {
  sessionId: SessionId;
  onClose: () => void;
  onCarryOver: (seed: SessionSettingsCarryOver) => void;
}) {
  const session = useStore((s) => s.sessions.find((x) => x.id === sessionId) ?? null);
  const projects = useStore((s) => s.projects);
  const setProjects = useStore((s) => s.setProjects);
  const accounts = useStore((s) => s.accounts);
  const { models, modelsLoading } = useModelCatalog(session?.accountId ?? DEFAULT_ACCOUNT_ID);

  const [baseline, setBaseline] = useState<SettingsDraft | null>(session ? draftFromSession(session) : null);
  const [draft, setDraft] = useState<SettingsDraft | null>(baseline);
  const [touched, setTouched] = useState<Set<keyof SettingsDraft>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [confirmingClose, setConfirmingClose] = useState(false);
  const { error, setError, schedule } = useTimedError();
  const { error: defaultError, setError: setDefaultError, schedule: scheduleDefaultError } = useTimedError();
  const alive = useMounted();
  const sessionRef = useRef(session);

  // FR-18: a live session.meta rebases the baseline; untouched fields follow,
  // touched fields hold the user's pending value.
  useEffect(() => {
    if (!session || sessionRef.current === session) return;
    sessionRef.current = session;
    const nextBaseline = draftFromSession(session);
    setBaseline(nextBaseline);
    setDraft((cur) => (cur ? rebaseDraft(cur, nextBaseline, touched) : nextBaseline));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  // §7 case 7: the session was removed while the sheet was open.
  useEffect(() => {
    if (session === null) onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  const setField = <K extends keyof SettingsDraft>(key: K, value: SettingsDraft[K]) => {
    setDraft((d) => (d ? { ...d, [key]: value } : d));
    setTouched((t) => {
      const next = new Set(t);
      next.add(key);
      return next;
    });
  };

  const dirty = useMemo(() => (draft && baseline ? dirtyKeys(draft, baseline) : []), [draft, baseline]);
  const timing = timingLine(dirty);
  const canApply = draft !== null && dirty.length > 0 && !submitting && canCommitRename(draft.name, false);

  const attemptClose = () => {
    if (dirty.length > 0) setConfirmingClose(true);
    else onClose();
  };

  const apply = async () => {
    if (!draft || !baseline || !canApply) return;
    setSubmitting(true);
    setError(null);
    const patch = buildPatch(draft, baseline);
    const res = await sessionUpdateSettings({ sessionId, patch });
    if (!alive.current) return;
    setSubmitting(false);
    if (res.ok) onClose();
    else {
      setError(res.error.message);
      schedule(() => setError(null), 4000);
    }
  };

  const setProjectDefault = async () => {
    if (!draft || !session?.projectId) return;
    const project = projects.find((p) => p.id === session.projectId);
    if (!project) return;
    const res = await projectUpdate({ projectId: project.id, defaults: nextProjectDefaults(project.defaults, draft) });
    if (!alive.current) return;
    if (res.ok) setProjects(projects.map((p) => (p.id === res.data.id ? res.data : p)));
    else {
      setDefaultError(res.error.message);
      scheduleDefaultError(() => setDefaultError(null), 4000);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && canApply && !confirmingClose) {
        const activeEl = document.activeElement as HTMLElement | null;
        if (activeEl?.tagName !== 'SELECT' && activeEl?.tagName !== 'TEXTAREA') {
          e.preventDefault();
          void apply();
        }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  if (!session || !draft || !baseline) return null;

  const statusColor = toneVar(STATUS_COLOR[session.status] ?? 'var(--text-dim)');
  const fixed = fixedAtSpawnLines(session, projects, accounts);
  const modelEfforts = models.find((m) => m.id === draft.modelId)?.efforts ?? session.model.efforts ?? [];
  // §7 case 11: the catalog may not (yet) carry the session's own model.
  const catalog = models.length > 0 ? models : [session.model];
  const providerHeading = modelPickerProviderHeading(accounts, session.accountId);

  // Model swap correctness (§7 case 22 parity with CreateSheet's own reset
  // effect, lines 253-256): a model whose `efforts` don't include the current
  // draft effort clears it in the same update, so Apply never sends a
  // modelId/effort pair the picked model doesn't support.
  const onModelChange = (id: string) => {
    const nextEfforts = catalog.find((m) => m.id === id)?.efforts ?? [];
    setField('modelId', id);
    if (draft.effort && !effortSupportedByModel(draft.effort, nextEfforts)) setField('effort', '');
  };

  const field = (key: keyof SettingsDraft, was: string, children: ReactNode) => (
    <div className={dirty.includes(key) ? 'session-settings-sheet__field session-settings-sheet__field--changed' : 'session-settings-sheet__field'}>
      {children}
      {dirty.includes(key) && <div className="session-settings-sheet__was">was {was}</div>}
    </div>
  );

  return (
    <Modal onClose={attemptClose} width={480} closeOnEscape={true} closeOnBackdropClick={true}>
      <ModalHeader>
        <div className="session-settings-sheet__header">
          <StatusDot color={statusColor} size={7} pulsing={statusPulses(session.status)} />
          <span className="session-settings-sheet__header-name truncate">{session.name}</span>
          <span className="session-settings-sheet__header-id">{session.id}</span>
          <span className="session-settings-sheet__header-word">settings</span>
        </div>
      </ModalHeader>

      <ModalBody>
        <div className="session-settings-sheet__fixed">
          <div className="session-settings-sheet__fixed-heading">▣ FIXED AT SPAWN</div>
          {fixed.map((line) => (
            <div key={line.label} className="session-settings-sheet__fixed-row">
              <span className="session-settings-sheet__fixed-label">{line.label}</span>
              <span className="session-settings-sheet__fixed-value" title={line.title ?? line.value}>
                {line.value}
              </span>
            </div>
          ))}
          <div className="session-settings-sheet__fixed-foot">
            <span>The checkout and the runtime are decided when the session starts.</span>
            <span
              role="button"
              tabIndex={0}
              className="session-settings-sheet__fixed-carry"
              onClick={() => onCarryOver(carryOverToCreate(session, projects))}
            >
              New session from these ↗
            </span>
          </div>
        </div>

        {field(
          'name',
          baseline.name,
          <NameField
            name={draft.name}
            onChange={(value) => setField('name', value)}
          />,
        )}
        {draft.name.trim() !== '' && nameLength(draft.name) > SESSION_NAME_MAX && (
          <div className="new-session-modal__hint new-session-modal__hint--error">name is too long</div>
        )}

        <div className={modelEfforts.length > 0 ? 'session-settings-sheet__pair session-settings-sheet__pair--effort' : undefined}>
          {field(
            'modelId',
            session.model.label,
            <ModelField
              models={catalog}
              modelId={draft.modelId}
              loading={modelsLoading}
              onChange={onModelChange}
              providerHeading={providerHeading}
            />,
          )}
          {modelEfforts.length > 0 &&
            field(
              'effort',
              baseline.effort || 'default',
              <div>
                <label className="new-session-modal__label">EFFORT</label>
                <div className="new-session-modal__chip-row new-session-modal__chip-row--wrap">
                  <ChipGroup
                    options={[{ value: '', label: 'default' }, ...modelEfforts.map((e) => ({ value: e, label: e }))]}
                    value={draft.effort}
                    onChange={(v) => setField('effort', v)}
                  />
                </div>
              </div>,
            )}
        </div>

        {field(
          'permissionMode',
          PERMISSION_MODE_OPTIONS.find((o) => o.mode === baseline.permissionMode)?.label ?? baseline.permissionMode,
          <PermissionsRow value={draft.permissionMode} onChange={(v) => setField('permissionMode', v)} />,
        )}

        {field(
          'responseMode',
          RESPONSE_MODE_OPTIONS.find((o) => o.mode === baseline.responseMode)?.label ?? baseline.responseMode,
          <ResponseRow value={draft.responseMode} onChange={(v) => setField('responseMode', v)} />,
        )}

        {field(
          'allowGit',
          baseline.allowGit ? 'on' : 'off',
          <GitRow value={draft.allowGit} onChange={(v) => setField('allowGit', v)} />,
        )}

      </ModalBody>

      <ModalFooter>
        {confirmingClose ? (
          <div className="session-settings-sheet__confirm">
            <span>discard unsaved changes?</span>
            <span className="app-flex-spacer" />
            <Button variant="ghost" onClick={() => setConfirmingClose(false)}>
              Keep editing
            </Button>
            <Button variant="primary" onClick={onClose}>
              Discard
            </Button>
          </div>
        ) : (
          <div className="session-settings-sheet__foot">
            <div className="session-settings-sheet__foot-status">
              {dirty.length > 0 && <span className="session-settings-sheet__foot-count">{changeCountLabel(dirty.length)}</span>}
              {timing && <span className="session-settings-sheet__foot-timing">{timing}</span>}
              {defaultError && <span className="session-settings-sheet__foot-timing">{defaultError}</span>}
              {error && <span className="session-settings-sheet__foot-timing">{error}</span>}
            </div>
            <span className="app-flex-spacer" />
            {canSetProjectDefault(session) && (
              <span
                role="button"
                tabIndex={0}
                className="session-settings-sheet__foot-default"
                title={SET_PROJECT_DEFAULT_TITLE}
                onClick={() => void setProjectDefault()}
              >
                {SET_PROJECT_DEFAULT_COPY}
              </span>
            )}
            <div className="session-settings-sheet__foot-actions">
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button variant="primary" onClick={() => void apply()} disabled={!canApply}>
                {submitting ? 'applying…' : 'Apply'}
              </Button>
            </div>
          </div>
        )}
      </ModalFooter>
    </Modal>
  );
}
