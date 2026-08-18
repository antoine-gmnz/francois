// session-profiles — the Profiles modal (FR-1..FR-11, sibling to the Projects
// modal per §3 flow 1). Two columns: the registry on the left, one profile's
// editor on the right (name, system prompt, one Extra args field).
//
// The chrome deliberately MIRRORS ProjectsModal rather than src/ui/Modal: same
// backdrop/panel, same uppercase accent title + count header, same `pj-group`
// sections, same `+ New …` control pinned under the list. The two modals are
// siblings the user moves between, so they read as one surface.
//
// It does NOT use projects' `pj-row` / 120px-label cells: every field here is
// full width under its own section header (NAME / SYSTEM PROMPT / EXTRA ARGS),
// one field per group, so the header is the label. Projects needs the gutter
// because it packs several fields into one section; this modal has three fields
// total, and the prompt among them wants the whole width.
//
// What it does NOT copy is projects' commit-on-blur: there is no autosave here,
// because the extra-args denylist (FR-9) can refuse a save outright, and an
// explicit commit is what makes that failure legible — it names the flag and the
// reason beside the field that caused it.
//
// A profile carries NO model / effort / permission mode. It is always paired
// with a project, and the project's session defaults own those three.

import { useEffect, useRef, useState } from 'react';
import type { AppError } from '../../../contract/common';
import type { SessionProfile } from '../../../contract/session-profiles';
import { profilesCreate, profilesRemove, profilesUpdate, projectList } from '../../lib/api';
import { useStore } from '../../lib/store';
import { useDismiss } from '../../lib/hooks/useDismiss';
import { Button } from '../../ui/Button';
import { ListRow } from '../../ui/ListRow';
import { RemoveControl } from '../../ui/RemoveControl';
import {
  REPLACE_MODE_NOTE,
  canSaveProfileName,
  flagAdvisoryTokens,
  isExtraArgsInvalidInput,
  loadProfiles,
  profileArgDeniedDetail,
  profileCountLabel,
  profileRowSubtitle,
  removeProfileConfirmText,
} from './profiles';
import '../projects/projects.css';
import './profiles.css';

interface Draft {
  name: string;
  systemPrompt: string;
  extraArgsRaw: string;
}

const EMPTY_DRAFT: Draft = { name: '', systemPrompt: '', extraArgsRaw: '' };

function draftFromProfile(p: SessionProfile): Draft {
  return {
    name: p.name,
    systemPrompt: p.systemPrompt ?? '',
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

  // Set as soon as the user picks a row or starts a new profile, so the open-time
  // read below never yanks the selection out from under a click that beat it.
  const chosenRef = useRef(false);

  // FR-32 (projects precedent): never trust cached state — re-read on open, and
  // land on the FIRST profile the way ProjectsModal lands on the first project
  // (`useProjectRegistry.reload`'s `res.data[0]?.id ?? null`). Opening onto the
  // "select a profile" placeholder collapsed the panel to a sliver, and made the
  // common case — one profile, go edit it — cost a click.
  useEffect(() => {
    void loadProfiles((list) => {
      setProfiles(list);
      const first = list[0];
      if (chosenRef.current || !first) return;
      setSelectedId(first.id);
      setDraft(draftFromProfile(first));
      setLastSaved(first);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selected = selectedId && selectedId !== 'new' ? (profiles.find((p) => p.id === selectedId) ?? null) : null;

  const selectProfile = (p: SessionProfile) => {
    chosenRef.current = true;
    setSelectedId(p.id);
    setDraft(draftFromProfile(p));
    setLastSaved(p);
    setError(null);
    setRemoveConfirm(null);
  };

  const startNew = () => {
    chosenRef.current = true;
    setSelectedId('new');
    setDraft(EMPTY_DRAFT);
    setLastSaved(null);
    setError(null);
    setRemoveConfirm(null);
  };

  const dismissRef = useRef<HTMLDivElement>(null);
  useDismiss(dismissRef, { onEscape: onClose });

  const confirmingRemove = selected !== null && removeConfirm === selected.id;
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
    // The core also cleared this profile from every project that named it as its
    // default, so the projects registry we hold is now stale — re-read it rather
    // than leaving the switcher and the Projects modal describing a default that
    // no longer exists.
    const projectsRes = await projectList();
    if (projectsRes.ok) {
      useStore.getState().setProjects(projectsRes.data.projects);
      useStore.getState().setGroups(projectsRes.data.groups);
    }
  };

  return (
    <div onClick={onClose} className="pj-backdrop">
      <div onClick={(e) => e.stopPropagation()} className="pj-panel pf-panel" ref={dismissRef}>
        {/* header — the PROJECTS header, verbatim in structure */}
        <div className="pj-header">
          <span className="pj-title">PROFILES</span>
          <div className="pj-header-right">
            <span className="pj-count">{profileCountLabel(profiles.length)}</span>
            {/* the sibling link back, mirroring projects' "Profiles…" */}
            <button
              type="button"
              className="pj-profiles-link"
              onClick={() => {
                onClose();
                useStore.getState().setProjectsOpen(true);
              }}
            >
              Projects…
            </button>
          </div>
        </div>

        <div className="pj-body">
          {/* left: the registry */}
          <div className="pj-list">
            <div className="scz pj-list-scroll">
              {profiles.length === 0 ? (
                <div className="pj-empty">no profiles yet</div>
              ) : (
                profiles.map((p) => (
                  <ProfileRow
                    key={p.id}
                    profile={p}
                    selected={p.id === selectedId}
                    onClick={() => selectProfile(p)}
                  />
                ))
              )}
            </div>
            <div className="pj-new-project" onClick={startNew}>
              + New profile
            </div>
          </div>

          {/* right: the editor column — the scrolling form plus its own footer,
              so the footer aligns with the fields it acts on instead of running
              under the list. */}
          <div className="pf-editor-col">
            {selectedId === null ? (
              <div className="pj-config pf-config-empty">
                <div className="pj-empty">select a profile, or start a new one</div>
              </div>
            ) : (
              <div className="scz pj-config" style={saving ? { opacity: 0.6, pointerEvents: 'none' } : undefined}>
                {/* One field per group, each full width under its own section
                    header — the header IS the label, so this modal uses no
                    `pj-row` / 120px gutter at all. Every hint and inline error
                    therefore sits flush with the field it belongs to. */}
                <div className="pj-group">
                  <span className="pj-group-label">NAME</span>
                  <input
                    className="pj-input pf-field"
                    value={draft.name}
                    onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                    placeholder="agent-architect"
                  />
                </div>

                <div className="pj-group">
                  <span className="pj-group-label">SYSTEM PROMPT</span>
                  <textarea
                    className="pj-input pj-textarea pf-field pf-prompt"
                    value={draft.systemPrompt}
                    onChange={(e) => setDraft((d) => ({ ...d, systemPrompt: e.target.value }))}
                    rows={6}
                    placeholder="replaces Claude Code's own system prompt — leave blank to keep it"
                  />
                  {draft.systemPrompt.trim() !== '' && <div className="pj-footer-note">{REPLACE_MODE_NOTE}</div>}
                </div>

                <div className="pj-group">
                  <span className="pj-group-label">EXTRA ARGS</span>
                  <input
                    className="pj-input pf-field"
                    value={draft.extraArgsRaw}
                    onChange={(e) => setDraft((d) => ({ ...d, extraArgsRaw: e.target.value }))}
                    placeholder={'--add-dir "/some path" --foo'}
                  />
                  {/* FR-10: non-blocking — every flag Francois does not itself
                      model gets a quiet advisory beside it, never a block. */}
                  {advisory.length > 0 && (
                    <div className="pj-footer-note">
                      not modelled by Francois — passed through verbatim: {advisory.join(', ')}
                    </div>
                  )}
                  {/* FR-9: refused inline, NAMING the flag and the reason. */}
                  {denial && (
                    <div className="pj-inline-error">
                      {denial.flag} — {denial.reason}
                    </div>
                  )}
                  {/* §7: an unterminated quote / over-cap raw string points at the
                      field too — not the generic banner below. */}
                  {extraArgsInvalidMessage && <div className="pj-inline-error">{extraArgsInvalidMessage}</div>}
                </div>

                {error && !denial && !extraArgsInvalidMessage && <div className="pj-inline-error">{error.message}</div>}
              </div>
            )}

            {/* Footer — last child of the EDITOR COLUMN, not of the panel: it acts
                on the form beside it, so it starts where the form starts rather
                than running under the list and reading as part of `+ New profile`.
                Outside the scroller, though, so the save stays reachable no matter
                how far a long system prompt has been scrolled.

                The explicit save this modal needs (see the header comment) sits
                left, projects' own confirm-in-place Remove right. While a removal
                is being confirmed the save is HIDDEN, not disabled: the bar is
                asking one destructive yes/no question, and a second primary action
                beside it competes for the eye and invites the wrong click. Cancel
                brings it straight back. */}
            {selectedId !== null && (
              <div className="pf-footer">
                {!confirmingRemove && (
                  <Button variant="primary" onClick={() => void save()} disabled={!canSaveProfileName(draft.name) || saving}>
                    {saving ? 'saving…' : 'Save profile'}
                  </Button>
                )}
                {selected && (
                  <RemoveControl
                    confirmText={removeProfileConfirmText(selected.name)}
                    confirming={confirmingRemove}
                    onConfirm={() => setRemoveConfirm(selected.id)}
                    onCancel={() => setRemoveConfirm(null)}
                    onRemove={() => void remove(selected.id)}
                  />
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ProfileRow({
  profile,
  selected,
  onClick,
}: {
  profile: SessionProfile;
  selected: boolean;
  onClick: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <ListRow
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      selected={selected}
      hovered={hover}
      className="pj-project-row"
      style={{ borderLeft: selected ? '2px solid var(--accent)' : '2px solid transparent' }}
    >
      <div className="pj-project-row-top">
        <span className={`truncate pj-project-name${selected ? ' pj-project-name--selected' : ''}`}>
          {profile.name}
        </span>
      </div>
      {/* The role at a glance. No `replace` badge here: carrying a system prompt
          is the POINT of a profile, so nearly every row would wear one and it
          would distinguish nothing. It stays on the session chip, where "this
          thread has no CLAUDE.md doctrine" is real information (FR-22). */}
      <span className="truncate pj-project-root">{profileRowSubtitle(profile)}</span>
    </ListRow>
  );
}
