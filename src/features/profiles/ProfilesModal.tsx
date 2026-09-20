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
//
// pi-migration-rollout FR-2/FR-4: a profile now carries a `kind` discriminator,
// chosen once at CREATE time and never changed after — so the editor is really
// two typed forms (legacy / Pi) sharing this one chrome, plus a third mode,
// "reviewing a Create Pi copy", that edits a NEW Pi draft seeded from a legacy
// source without ever touching that source.

import { useEffect, useRef, useState } from 'react';
import type { AppError } from '../../../contract/common';
import type { LegacySessionProfile, PiBuiltinTool, SessionProfile } from '../../../contract/session-profiles';
import { MAX_PI_INSTRUCTION_PATHS, MAX_PI_SKILL_PATHS, PI_BUILTIN_TOOLS } from '../../../contract/session-profiles';
import { profilesCopyToPi, profilesCreate, profilesRemove, profilesUpdate, projectList } from '../../lib/api';
import { useStore } from '../../lib/store';
import { useDismiss } from '../../lib/hooks/useDismiss';
import { Button } from '../../ui/Button';
import { ChipGroup } from '../../ui/ChipGroup';
import { Chip } from '../../ui/Chip';
import { Action } from '../../ui/Action';
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
import {
  EMPTY_PI_DRAFT,
  EMPTY_TOOLS_NOTE,
  PROJECT_RESOURCES_NOTE,
  TOOL_LIST_NOTE,
  canSavePiDraft,
  invalidPaths,
  omittedExtraArgsLine,
  parsePathList,
  piCopyDraftFromLegacy,
  piDraftFromSettings,
  piSettingsFromDraft,
  piSystemPromptRequired,
  toggleTool,
  toolsSummary,
  type PiDraft,
} from './pi-profile';
import '../projects/projects.css';
import './profiles.css';

interface Draft {
  name: string;
  systemPrompt: string;
  extraArgsRaw: string;
}

const EMPTY_DRAFT: Draft = { name: '', systemPrompt: '', extraArgsRaw: '' };

function draftFromProfile(p: LegacySessionProfile): Draft {
  return {
    name: p.name,
    systemPrompt: p.systemPrompt ?? '',
    extraArgsRaw: p.extraArgsRaw ?? '',
  };
}

const PROFILE_KIND_OPTIONS = [
  { value: 'legacy' as const, label: 'Legacy (Claude)' },
  { value: 'pi' as const, label: 'Pi' },
];

const PROMPT_MODE_OPTIONS = [
  { value: 'default' as const, label: 'Default' },
  { value: 'append' as const, label: 'Append' },
  { value: 'replace' as const, label: 'Replace' },
];

const PROJECT_RESOURCES_OPTIONS = [
  { value: 'ignore' as const, label: 'Ignore' },
  { value: 'allow' as const, label: 'Allow' },
];

export default function ProfilesModal({ onClose }: { onClose: () => void }): JSX.Element {
  const profiles = useStore((s) => s.profiles);
  const setProfiles = useStore((s) => s.setProfiles);

  const [selectedId, setSelectedId] = useState<string | null>(null); // null = the list has no selection; 'new' = the blank editor
  const [newKind, setNewKind] = useState<'legacy' | 'pi'>('legacy'); // FR-2: the CREATE-time choice, fixed once saved
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [piDraft, setPiDraft] = useState<PiDraft>(EMPTY_PI_DRAFT);
  // FR-4: set while reviewing a "Create Pi copy" of the legacy profile named
  // here — a NEW Pi draft, decoupled from `selectedId`'s own editor, so the
  // source profile is never touched until (if) the review is saved.
  const [copySource, setCopySource] = useState<LegacySessionProfile | null>(null);
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
      if (first.kind === 'pi') setPiDraft(piDraftFromSettings(first.name, first.settings));
      else setDraft(draftFromProfile(first));
      setLastSaved(first);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selected = selectedId && selectedId !== 'new' ? (profiles.find((p) => p.id === selectedId) ?? null) : null;
  const reviewingCopy = copySource !== null;
  const activeKind: 'legacy' | 'pi' | null = reviewingCopy ? 'pi' : selectedId === 'new' ? newKind : (selected?.kind ?? null);

  const selectProfile = (p: SessionProfile) => {
    chosenRef.current = true;
    setSelectedId(p.id);
    setCopySource(null);
    if (p.kind === 'pi') setPiDraft(piDraftFromSettings(p.name, p.settings));
    else setDraft(draftFromProfile(p));
    setLastSaved(p);
    setError(null);
    setRemoveConfirm(null);
  };

  const startNew = () => {
    chosenRef.current = true;
    setSelectedId('new');
    setNewKind('legacy');
    setCopySource(null);
    setDraft(EMPTY_DRAFT);
    setPiDraft(EMPTY_PI_DRAFT);
    setLastSaved(null);
    setError(null);
    setRemoveConfirm(null);
  };

  // FR-4: opens the review step for a Create Pi copy of `source`, seeded from
  // its name and user-authored prompt only — the source stays selected and
  // untouched underneath.
  const startCreatePiCopy = (source: LegacySessionProfile) => {
    setCopySource(source);
    setPiDraft(piCopyDraftFromLegacy(source));
    setError(null);
  };

  const cancelCopy = () => {
    setCopySource(null);
    setError(null);
  };

  const dismissRef = useRef<HTMLDivElement>(null);
  useDismiss(dismissRef, { onEscape: onClose });

  const confirmingRemove = !reviewingCopy && selected !== null && removeConfirm === selected.id;
  const advisory = flagAdvisoryTokens(lastSaved && lastSaved.kind === 'legacy' ? lastSaved.extraArgs : undefined);
  const denial = error ? profileArgDeniedDetail(error) : null;
  // §7 edge case: an unterminated quote / over-cap extra args also anchors
  // beside the field, same as a denied flag — never the generic banner.
  const extraArgsInvalidMessage = error && isExtraArgsInvalidInput(error) ? error.message : null;

  const canSave = activeKind === 'pi' ? canSavePiDraft(piDraft) : activeKind === 'legacy' ? canSaveProfileName(draft.name) : false;

  const save = async () => {
    if (!canSave || saving) return;
    setSaving(true);
    setError(null);

    if (reviewingCopy && copySource) {
      const res = await profilesCopyToPi({ id: copySource.id, name: piDraft.name.trim(), settings: piSettingsFromDraft(piDraft) });
      setSaving(false);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setCopySource(null);
      setSelectedId(res.data.id);
      setPiDraft(piDraftFromSettings(res.data.name, res.data.settings));
      setLastSaved(res.data);
      await loadProfiles(setProfiles);
      return;
    }

    if (activeKind === 'pi') {
      const payload = { kind: 'pi' as const, name: piDraft.name.trim(), settings: piSettingsFromDraft(piDraft) };
      const res =
        selectedId && selectedId !== 'new' ? await profilesUpdate({ id: selectedId, ...payload }) : await profilesCreate(payload);
      setSaving(false);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setLastSaved(res.data);
      setSelectedId(res.data.id);
      if (res.data.kind === 'pi') setPiDraft(piDraftFromSettings(res.data.name, res.data.settings));
      await loadProfiles(setProfiles);
      return;
    }

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
    if (res.data.kind === 'legacy') setDraft(draftFromProfile(res.data));
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
      setPiDraft(EMPTY_PI_DRAFT);
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
                {reviewingCopy && copySource && (
                  <div className="pj-footer-note pf-copy-banner">
                    <span>
                      Create Pi copy of <strong>{copySource.name}</strong> — “{copySource.name}” is kept unchanged
                    </span>
                    {omittedExtraArgsLine(copySource) && (
                      <span>omitted (not translated): {omittedExtraArgsLine(copySource)}</span>
                    )}
                  </div>
                )}

                {selectedId === 'new' && !reviewingCopy && (
                  <div className="pj-group">
                    <span className="pj-group-label">KIND</span>
                    <div className="pf-chip-row">
                      <ChipGroup options={PROFILE_KIND_OPTIONS} value={newKind} onChange={setNewKind} />
                    </div>
                  </div>
                )}

                {/* One field per group, each full width under its own section
                    header — the header IS the label, so this modal uses no
                    `pj-row` / 120px gutter at all. Every hint and inline error
                    therefore sits flush with the field it belongs to. */}
                <div className="pj-group">
                  <span className="pj-group-label">NAME</span>
                  <input
                    className="pj-input pf-field"
                    value={activeKind === 'pi' ? piDraft.name : draft.name}
                    onChange={(e) =>
                      activeKind === 'pi'
                        ? setPiDraft((d) => ({ ...d, name: e.target.value }))
                        : setDraft((d) => ({ ...d, name: e.target.value }))
                    }
                    placeholder="agent-architect"
                  />
                </div>

                {activeKind === 'pi' ? (
                  <PiSettingsFields draft={piDraft} setDraft={setPiDraft} />
                ) : (
                  <>
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

                    {/* FR-4: a saved legacy profile may spin off a reviewed Pi
                        copy without changing itself. Not offered for a brand-new,
                        unsaved draft — there's nothing to copy yet. */}
                    {selected && selected.kind === 'legacy' && (
                      <Action color="var(--text-muted)" hoverColor="var(--text)" onClick={() => startCreatePiCopy(selected)}>
                        Create Pi copy…
                      </Action>
                    )}
                  </>
                )}

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
                brings it straight back.

                Reviewing a Create Pi copy replaces Remove with a plain Cancel —
                there is nothing to remove yet, only a pending draft to discard. */}
            {selectedId !== null && (
              <div className="pf-footer">
                {reviewingCopy ? (
                  <>
                    <Button variant="primary" onClick={() => void save()} disabled={!canSave || saving}>
                      {saving ? 'saving…' : 'Save Pi copy'}
                    </Button>
                    <Button variant="ghost" onClick={cancelCopy}>
                      Cancel
                    </Button>
                  </>
                ) : (
                  <>
                    {!confirmingRemove && (
                      <Button variant="primary" onClick={() => void save()} disabled={!canSave || saving}>
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
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * pi-migration-rollout §5/§7 — the typed Pi settings editor. Shared by the
 * three places that render one: an existing Pi profile, a brand-new Pi draft
 * (KIND = Pi), and a Create Pi copy review — all three are just a `PiDraft`
 * plus its setter, so this component doesn't know or care which.
 */
function PiSettingsFields({ draft, setDraft }: { draft: PiDraft; setDraft: (update: (d: PiDraft) => PiDraft) => void }) {
  const instructionPaths = parsePathList(draft.instructionPathsText);
  const skillPaths = parsePathList(draft.skillPathsText);
  const badInstructionPaths = invalidPaths(instructionPaths);
  const badSkillPaths = invalidPaths(skillPaths);

  return (
    <>
      <div className="pj-group">
        <span className="pj-group-label">PROMPT MODE</span>
        <div className="pf-chip-row">
          <ChipGroup
            options={PROMPT_MODE_OPTIONS}
            value={draft.systemPromptMode}
            onChange={(systemPromptMode) => setDraft((d) => ({ ...d, systemPromptMode }))}
          />
        </div>
        {draft.systemPromptMode === 'default' && (
          <div className="pj-footer-note">Pi uses its own default prompt — no override is sent.</div>
        )}
      </div>

      {piSystemPromptRequired(draft.systemPromptMode) && (
        <div className="pj-group">
          <span className="pj-group-label">SYSTEM PROMPT</span>
          <textarea
            className="pj-input pj-textarea pf-field pf-prompt"
            value={draft.systemPrompt}
            onChange={(e) => setDraft((d) => ({ ...d, systemPrompt: e.target.value }))}
            rows={6}
            placeholder={draft.systemPromptMode === 'replace' ? "replaces Pi's own system prompt" : "appended to Pi's own system prompt"}
          />
        </div>
      )}

      <div className="pj-group">
        <span className="pj-group-label">INSTRUCTION FILES</span>
        <textarea
          className="pj-input pj-textarea pf-field pf-paths"
          value={draft.instructionPathsText}
          onChange={(e) => setDraft((d) => ({ ...d, instructionPathsText: e.target.value }))}
          rows={3}
          placeholder={'one absolute path per line'}
        />
        <div className="pj-footer-note">
          up to {MAX_PI_INSTRUCTION_PATHS} absolute paths, read once at launch ({instructionPaths.length}/{MAX_PI_INSTRUCTION_PATHS})
        </div>
        {badInstructionPaths.length > 0 && <div className="pj-inline-error">not absolute: {badInstructionPaths.join(', ')}</div>}
      </div>

      <div className="pj-group">
        <span className="pj-group-label">SKILLS</span>
        <textarea
          className="pj-input pj-textarea pf-field pf-paths"
          value={draft.skillPathsText}
          onChange={(e) => setDraft((d) => ({ ...d, skillPathsText: e.target.value }))}
          rows={3}
          placeholder={'one absolute path per line'}
        />
        <div className="pj-footer-note">
          up to {MAX_PI_SKILL_PATHS} absolute paths, validated before spawn ({skillPaths.length}/{MAX_PI_SKILL_PATHS})
        </div>
        {badSkillPaths.length > 0 && <div className="pj-inline-error">not absolute: {badSkillPaths.join(', ')}</div>}
      </div>

      <div className="pj-group">
        <span className="pj-group-label">TOOLS</span>
        <div className="pf-chip-row">
          {PI_BUILTIN_TOOLS.map((tool: PiBuiltinTool) => (
            <Chip
              key={tool}
              selected={draft.tools.includes(tool)}
              onClick={() => setDraft((d) => ({ ...d, tools: toggleTool(d.tools, tool) }))}
            >
              {tool}
            </Chip>
          ))}
        </div>
        <div className="pj-footer-note">
          <span>{TOOL_LIST_NOTE}</span>
          <span>{draft.tools.length === 0 ? EMPTY_TOOLS_NOTE : `allowed: ${toolsSummary(draft.tools)}`}</span>
        </div>
      </div>

      <div className="pj-group">
        <span className="pj-group-label">PROJECT RESOURCES</span>
        <div className="pf-chip-row">
          <ChipGroup
            options={PROJECT_RESOURCES_OPTIONS}
            value={draft.projectResources}
            onChange={(projectResources) => setDraft((d) => ({ ...d, projectResources }))}
          />
        </div>
        <div className="pj-footer-note">{PROJECT_RESOURCES_NOTE}</div>
      </div>
    </>
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
        {/* pi-migration-rollout FR-2: the kind is the identity you can never edit
            back into — surfaced beside the name, not buried in the subtitle. */}
        {profile.kind === 'pi' && <span className="pf-kind-tag">PI</span>}
      </div>
      {/* The role at a glance. No `replace` badge here: carrying a system prompt
          is the POINT of a profile, so nearly every row would wear one and it
          would distinguish nothing. It stays on the session chip, where "this
          thread has no CLAUDE.md doctrine" is real information (FR-22). */}
      <span className="truncate pj-project-root">{profileRowSubtitle(profile)}</span>
    </ListRow>
  );
}
