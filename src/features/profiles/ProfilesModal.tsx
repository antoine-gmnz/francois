// session-profiles — the Profiles modal (FR-1..FR-11, sibling to the Projects
// modal per §3 flow 1). Two columns: the registry on the left, one profile's
// editor on the right (name, prompt, model/effort/permission mode, one Extra
// args field). There is no autosave — the extra-args denylist (FR-9) can
// refuse a save outright, so every commit is an explicit action whose failure
// is shown inline, naming the flag and the reason.

import { useEffect, useRef, useState } from 'react';
import type { AppError, ModelInfo, PermissionMode } from '../../../contract/common';
import type { SessionProfile } from '../../../contract/session-profiles';
import { profilesCreate, profilesRemove, profilesUpdate, sessionModels } from '../../lib/api';
import { useStore } from '../../lib/store';
import { useDismiss } from '../../lib/hooks/useDismiss';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '../../ui/Modal';
import { Button } from '../../ui/Button';
import { ChipGroup, type ChipOption } from '../../ui/ChipGroup';
import { ListRow } from '../../ui/ListRow';
import {
  REPLACE_MODE_NOTE,
  canSaveProfileName,
  flagAdvisoryTokens,
  isExtraArgsInvalidInput,
  loadProfiles,
  profileArgDeniedDetail,
  removeProfileConfirmText,
} from './profiles';
import '../sessions/new-session-modal.css';
import './profiles.css';

const PERMISSION_OPTIONS: ChipOption<PermissionMode | ''>[] = [
  { value: '', label: 'inherit' },
  { value: 'default', label: 'default' },
  { value: 'plan', label: 'plan' },
  { value: 'acceptEdits', label: 'accept edits' },
  { value: 'bypassPermissions', label: 'bypass', danger: true },
];

interface Draft {
  name: string;
  systemPrompt: string;
  modelId: string;
  effort: string;
  permissionMode: PermissionMode | '';
  extraArgsRaw: string;
}

const EMPTY_DRAFT: Draft = { name: '', systemPrompt: '', modelId: '', effort: '', permissionMode: '', extraArgsRaw: '' };

function draftFromProfile(p: SessionProfile): Draft {
  return {
    name: p.name,
    systemPrompt: p.systemPrompt ?? '',
    modelId: p.modelId ?? '',
    effort: p.effort ?? '',
    permissionMode: p.permissionMode ?? '',
    extraArgsRaw: p.extraArgsRaw ?? '',
  };
}

export default function ProfilesModal({ onClose }: { onClose: () => void }): JSX.Element {
  const profiles = useStore((s) => s.profiles);
  const setProfiles = useStore((s) => s.setProfiles);

  const [selectedId, setSelectedId] = useState<string | null>(null); // null = the list has no selection; 'new' = the blank editor
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [lastSaved, setLastSaved] = useState<SessionProfile | null>(null); // for the extra-args advisory (FR-10)
  const [error, setError] = useState<AppError | null>(null);
  const [saving, setSaving] = useState(false);
  const [removeConfirm, setRemoveConfirm] = useState<string | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);

  // FR-32 (projects precedent): never trust cached state — re-read on open.
  useEffect(() => {
    void loadProfiles(setProfiles);
    void sessionModels().then((res) => {
      if (res.ok) setModels(res.data);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selected = selectedId && selectedId !== 'new' ? (profiles.find((p) => p.id === selectedId) ?? null) : null;

  const selectProfile = (p: SessionProfile) => {
    setSelectedId(p.id);
    setDraft(draftFromProfile(p));
    setLastSaved(p);
    setError(null);
    setRemoveConfirm(null);
  };

  const startNew = () => {
    setSelectedId('new');
    setDraft(EMPTY_DRAFT);
    setLastSaved(null);
    setError(null);
    setRemoveConfirm(null);
  };

  const dismissRef = useRef<HTMLDivElement>(null);
  useDismiss(dismissRef, { onEscape: onClose });

  const efforts = models.find((m) => m.id === draft.modelId)?.efforts ?? [];
  const advisory = flagAdvisoryTokens(lastSaved?.extraArgs);
  const denial = error ? profileArgDeniedDetail(error) : null;
  // §7 edge case: an unterminated quote / over-cap extra args also anchors
  // beside the field, same as a denied flag — never the generic banner.
  const extraArgsInvalidMessage = error && isExtraArgsInvalidInput(error) ? error.message : null;

  const save = async () => {
    if (!canSaveProfileName(draft.name) || saving) return;
    setSaving(true);
    setError(null);
    const payload = {
      name: draft.name.trim(),
      systemPrompt: draft.systemPrompt.trim() === '' ? undefined : draft.systemPrompt,
      modelId: draft.modelId || undefined,
      effort: draft.effort || undefined,
      permissionMode: draft.permissionMode || undefined,
      extraArgsRaw: draft.extraArgsRaw.trim() === '' ? undefined : draft.extraArgsRaw,
    };
    const res =
      selectedId && selectedId !== 'new'
        ? await profilesUpdate({ id: selectedId, ...payload })
        : await profilesCreate(payload);
    setSaving(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setLastSaved(res.data);
    setSelectedId(res.data.id);
    setDraft(draftFromProfile(res.data));
    await loadProfiles(setProfiles);
  };

  const remove = async (id: string) => {
    setRemoveConfirm(null);
    const res = await profilesRemove({ id });
    if (!res.ok) {
      setError(res.error);
      return;
    }
    if (selectedId === id) {
      setSelectedId(null);
      setDraft(EMPTY_DRAFT);
      setLastSaved(null);
    }
    await loadProfiles(setProfiles);
  };

  return (
    <Modal onClose={onClose} width={640} closeOnBackdropClick closeOnEscape={false}>
      <div ref={dismissRef}>
        <ModalHeader>
          <div className="pf-header-row">
            <span className="pf-title">
              <span className="new-session-modal__title-accent">›</span> profiles
            </span>
            <span className="pf-count">
              {profiles.length} profile{profiles.length === 1 ? '' : 's'}
            </span>
          </div>
        </ModalHeader>

        <ModalBody>
          <div className="pf-body">
            <div className="pf-list">
              <div className="pf-new" onClick={startNew}>
                + New profile
              </div>
              {profiles.map((p) => (
                <ListRow key={p.id} selected={p.id === selectedId} onClick={() => selectProfile(p)} className="pf-row">
                  <span className="pf-row-name truncate">{p.name}</span>
                  {p.systemPrompt && p.systemPrompt.trim() !== '' && <span className="pf-row-mark">replace</span>}
                </ListRow>
              ))}
              {profiles.length === 0 && <div className="pf-empty">no profiles yet</div>}
            </div>

            <div className="pf-editor">
              {selectedId === null ? (
                <div className="pf-empty">select a profile, or start a new one</div>
              ) : (
                <>
                  <div className="pf-row-field">
                    <label className="new-session-modal__label">NAME</label>
                    <input
                      className="new-session-modal__field"
                      value={draft.name}
                      onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                      placeholder="agent-architect"
                    />
                  </div>

                  <div className="pf-row-field">
                    <label className="new-session-modal__label">SYSTEM PROMPT</label>
                    <textarea
                      className="pf-textarea"
                      value={draft.systemPrompt}
                      onChange={(e) => setDraft((d) => ({ ...d, systemPrompt: e.target.value }))}
                      rows={6}
                      placeholder="replaces Claude Code's own system prompt — leave blank to keep it"
                    />
                    {draft.systemPrompt.trim() !== '' && <div className="new-session-modal__hint">{REPLACE_MODE_NOTE}</div>}
                  </div>

                  <div className="pf-row-field">
                    <label className="new-session-modal__label">MODEL</label>
                    <div className="new-session-modal__select">
                      <select
                        className="new-session-modal__field new-session-modal__field--select"
                        value={draft.modelId}
                        onChange={(e) => setDraft((d) => ({ ...d, modelId: e.target.value, effort: '' }))}
                      >
                        <option value="">inherit</option>
                        {models.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.label}
                          </option>
                        ))}
                      </select>
                      <span className="new-session-modal__select-caret">▾</span>
                    </div>
                  </div>

                  {efforts.length > 0 && (
                    <div className="pf-row-field">
                      <label className="new-session-modal__label">EFFORT</label>
                      <ChipGroup
                        options={[{ value: '', label: 'inherit' }, ...efforts.map((e) => ({ value: e, label: e }))]}
                        value={draft.effort}
                        onChange={(v) => setDraft((d) => ({ ...d, effort: v }))}
                      />
                    </div>
                  )}

                  <div className="pf-row-field">
                    <label className="new-session-modal__label">PERMISSIONS</label>
                    <ChipGroup options={PERMISSION_OPTIONS} value={draft.permissionMode} onChange={(v) => setDraft((d) => ({ ...d, permissionMode: v }))} />
                  </div>

                  <div className="pf-row-field">
                    <label className="new-session-modal__label">EXTRA ARGS</label>
                    <input
                      className="new-session-modal__field"
                      value={draft.extraArgsRaw}
                      onChange={(e) => setDraft((d) => ({ ...d, extraArgsRaw: e.target.value }))}
                      placeholder={'--add-dir "/some path" --foo'}
                    />
                    {/* FR-10: non-blocking — every flag Francois does not itself
                        model gets a quiet advisory beside it, never a block. */}
                    {advisory.length > 0 && (
                      <div className="new-session-modal__hint">not modelled by Francois — passed through verbatim: {advisory.join(', ')}</div>
                    )}
                    {/* FR-9: refused inline, NAMING the flag and the reason. */}
                    {denial && (
                      <div className="new-session-modal__hint new-session-modal__hint--error">
                        {denial.flag} — {denial.reason}
                      </div>
                    )}
                    {/* §7: an unterminated quote / over-cap raw string points at
                        the field too — not the generic banner below. */}
                    {extraArgsInvalidMessage && (
                      <div className="new-session-modal__hint new-session-modal__hint--error">{extraArgsInvalidMessage}</div>
                    )}
                  </div>

                  {error && !denial && !extraArgsInvalidMessage && <div className="form-error">{error.message}</div>}

                  <div className="pf-actions">
                    <Button variant="primary" onClick={() => void save()} disabled={!canSaveProfileName(draft.name) || saving}>
                      {saving ? 'saving…' : 'Save profile'}
                    </Button>
                    {selected &&
                      (removeConfirm === selected.id ? (
                        <>
                          <span className="pf-remove-confirm">{removeProfileConfirmText(selected.name)}</span>
                          <Button variant="ghost" onClick={() => setRemoveConfirm(null)}>
                            cancel
                          </Button>
                          <Button variant="ghost" className="pf-remove-btn" onClick={() => void remove(selected.id)}>
                            remove
                          </Button>
                        </>
                      ) : (
                        <Button variant="ghost" onClick={() => setRemoveConfirm(selected.id)}>
                          Remove
                        </Button>
                      ))}
                  </div>
                </>
              )}
            </div>
          </div>
        </ModalBody>

        <ModalFooter>
          <div className="new-session-modal__actions">
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
          </div>
        </ModalFooter>
      </div>
    </Modal>
  );
}
