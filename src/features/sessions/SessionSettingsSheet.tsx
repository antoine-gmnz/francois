import { reconcileCatalogModel } from '../../lib/model-catalog';
// session-settings-sheet — one component, two modes (FR-7). Create mode is the
// redesign's New task dialog (NewTaskDialog.tsx — FR-22's create logic, moved
// there and regrouped per Figma "19 · New task"). Edit mode is a live draft
// diffed against the session's current values (FR-14), applied in one atomic
// `session_update_settings` patch (FR-16).
//
// The two share no state (one never becomes the other without unmounting:
// "New session from these ↗" hands control back to the parent, which swaps
// which one is mounted, see App.tsx) but do share the field subcomponents,
// ChipGroup option tables and CSS classes.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { SessionId, SessionMeta } from '../../../contract/common';
import { STATUS_COLOR, statusPulses } from '../../../contract/fleet-board';
import { DEFAULT_ACCOUNT_ID } from '../../../contract/multi-account';
import { RESPONSE_MODE_OPTIONS } from '../../../contract/response-mode';
import { PERMISSION_MODE_OPTIONS } from '../../../contract/session-permission-mode';
import { modelPickerProviderHeading } from '../../lib/account-selection';
import { projectUpdate, sessionUpdateSettings } from '../../lib/api';
import { useModelCatalog } from '../../lib/hooks/useModelCatalog';
import { useMounted } from '../../lib/hooks/useMounted';
import { useTimedError } from '../../lib/hooks/useTimedError';
import { sessionIsRetired } from '../../lib/runtimeCapability';
import { useStore } from '../../lib/store';
import { toneVar } from '../../lib/tone';
import { Button } from '../../ui/Button';
import { ChipGroup } from '../../ui/ChipGroup';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '../../ui/Modal';
import { StatusDot } from '../../ui/StatusDot';
import { ModelField } from './ModelField';
import { NameField } from './NameField';
import { NewTaskDialog } from './NewTaskDialog';
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
  settingCapability,
  submitSettingsOnEnter,
  timingLine,
  type SessionSettingsCarryOver,
  type SettingsDraft,
} from './session-settings';
import './session-settings-sheet.css';
import { GitRow, PermissionsRow, ResponseRow } from './SharedSettingsRows';

export type SessionSettingsSheetProps =
  | { mode: 'create'; seed?: SessionSettingsCarryOver; onClose: () => void; onCreated: (meta: SessionMeta) => void }
  | { mode: 'edit'; sessionId: SessionId; onClose: () => void; onCarryOver: (seed: SessionSettingsCarryOver) => void };

export default function SessionSettingsSheet(props: SessionSettingsSheetProps) {
  if (props.mode === 'edit') return <EditSheet sessionId={props.sessionId} onClose={props.onClose} onCarryOver={props.onCarryOver} />;
  // Create mode is the redesign's New task dialog (NewTaskDialog.tsx).
  return <NewTaskDialog seed={props.seed} onClose={props.onClose} onCreated={props.onCreated} />;
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
  const catalogState = useModelCatalog(session?.accountId ?? DEFAULT_ACCOUNT_ID, session?.model.id ?? '', sessionIsRetired(session));
  const { models, modelsLoading } = catalogState;

  const [baseline, setBaseline] = useState<SettingsDraft | null>(session ? draftFromSession(session) : null);
  const [draft, setDraft] = useState<SettingsDraft | null>(baseline);
  const [touched, setTouched] = useState<Set<keyof SettingsDraft>>(new Set());
  useEffect(() => {
    const catalog = catalogState.catalog;
    if (!catalog) return;
    setDraft(current => {
      if (!current || current.modelId === baseline?.modelId) return current;
      const modelId = reconcileCatalogModel(current.modelId, catalog);
      if (modelId === current.modelId) return current;
      const efforts = catalog.models.find(m => m.id === modelId)?.efforts ?? [];
      return { ...current, modelId, effort: efforts.includes(current.effort) ? current.effort : '' };
    });
  }, [catalogState.catalog, baseline?.modelId]);
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
    // pi-runtime-boundary FR-4: a control the runtime cannot honour never edits the draft.
    if (!session || !settingCapability(session, key).available) return;
    setDraft((d) => (d ? { ...d, [key]: value } : d));
    setTouched((t) => {
      const next = new Set(t);
      next.add(key);
      return next;
    });
  };

  const dirty = useMemo(() => (draft && baseline ? dirtyKeys(draft, baseline) : []), [draft, baseline]);
  const timing = timingLine(dirty);
  const canApply = !sessionIsRetired(session) && draft !== null && dirty.length > 0 && !submitting && canCommitRename(draft.name, false)
    && (!dirty.includes('modelId') || models.some(m => m.id === draft.modelId))
    && (!dirty.includes('effort') || !draft.effort || (models.find(m => m.id === draft.modelId)?.efforts ?? []).includes(draft.effort));

  const attemptClose = () => {
    if (dirty.length > 0) setConfirmingClose(true);
    else onClose();
  };

  const apply = async () => {
    if (!draft || !baseline || !canApply) return;
    setSubmitting(true);
    setError(null);
    const patch = buildPatch(draft, baseline);
    // FR-4: the same guard applies to the atomic Apply payload, against the
    // session as it is now (a capability snapshot may have landed meanwhile).
    const currentSession = useStore.getState().sessions.find((s) => s.id === sessionId);
    if (!currentSession) { setSubmitting(false); return; }
    const blocked = (Object.keys(patch) as (keyof SettingsDraft)[])
      .map((key) => settingCapability(currentSession, key)).find((cap) => !cap.available);
    if (blocked) { setSubmitting(false); setError(blocked.reason ?? 'Setting unavailable.'); return; }
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
    if (!draft || !session?.projectId || !canSetProjectDefault(session)) return;
    const project = projects.find((p) => p.id === session.projectId);
    if (!project) return;
    const res = await projectUpdate({ projectId: project.id, defaults: nextProjectDefaults(project.defaults, draft, session) });
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
        submitSettingsOnEnter(e, apply);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  if (!session || !draft || !baseline) return null;

  const statusColor = toneVar(STATUS_COLOR[session.status] ?? 'var(--text-dim)');
  const fixed = fixedAtSpawnLines(session, projects, accounts);
  const selectedModel = models.find((m) => m.id === draft.modelId);
  const modelEfforts = selectedModel?.efforts ?? [];
  // §7 case 11: the catalog may not (yet) carry the session's own model.
  const catalog = models;
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

  const field = (key: keyof SettingsDraft, was: string, children: ReactNode) => {
    const capability = settingCapability(session, key);
    return (
      <fieldset disabled={!capability.available || submitting} title={capability.reason}
        className={dirty.includes(key) ? 'session-settings-sheet__field session-settings-sheet__field--changed' : 'session-settings-sheet__field'}>
        {children}
        {!capability.available && <div className="session-settings-sheet__was">{capability.reason ?? 'Setting unavailable.'}</div>}
        {dirty.includes(key) && <div className="session-settings-sheet__was">was {was}</div>}
      </fieldset>
    );
  };

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
            {!sessionIsRetired(session) && <span
              role="button"
              tabIndex={0}
              className="session-settings-sheet__fixed-carry"
              onClick={() => onCarryOver(carryOverToCreate(session, projects))}
            >
              New session from these ↗
            </span>}
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

        {/* pi-models-metrics FR-5/FR-6: a Pi session's model/effort switch is
            its OWN immediate round trip (session_switch_model/switch_effort),
            never the batched session_update_settings patch below — the Pi
            adapter's `.models()` always answers empty, so a modelId patch can
            never validate for it (see PiRunModelSwitch's own doc comment). */}
        { (
          <div className={modelEfforts.length > 0 ? 'session-settings-sheet__pair session-settings-sheet__pair--effort' : undefined}>
            {field(
              'modelId',
              session.model.label,
              <ModelField
                catalogState={catalogState}
                models={catalog}
                modelId={draft.modelId}
                loading={modelsLoading}
                onChange={onModelChange}
                providerHeading={providerHeading}
              />,
            )}
            {(modelEfforts.length > 0 || draft.effort !== '') &&
              field(
                'effort',
                baseline.effort || 'default',
                <div>
                  <label className="new-session-modal__label">EFFORT</label>
                  <div className="new-session-modal__chip-row new-session-modal__chip-row--wrap">
                    {draft.effort && !modelEfforts.includes(draft.effort) && <span>{draft.effort} · Not in the current catalogue</span>}
                    <ChipGroup
                      options={[{ value: '', label: selectedModel?.defaultEffort ? `Model default · ${selectedModel.defaultEffort}` : 'Model default' }, ...modelEfforts.map((e) => ({ value: e, label: e }))]}
                      value={draft.effort}
                      onChange={(v) => setField('effort', v)}
                    />
                  </div>
                </div>,
              )}
          </div>
        )}

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
