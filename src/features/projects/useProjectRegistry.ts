// projects — the "read" half of ProjectsModal: the registry list, the current
// selection, the two on-disk reads it drives (model catalog, standards), and
// the Identity drafts. Owns the three effects that keep them honest against
// the core (FR-32: project_list on open/after every mutation,
// project_get_standards on every selection change). Split out of
// ProjectsModal per REFACTOR.md §6c.

import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import type { ModelInfo } from '../../../contract/common';
import type { ProjectGroup, ProjectMeta, StandardsRead } from '../../../contract/projects';
import { projectGetStandards, projectList, sessionModels } from '../../lib/api';
import { useStore } from '../../lib/store';
import { useMounted } from '../../lib/hooks/useMounted';
import { EMPTY_SECTION_ERRORS, safeCall, type ProjectSection } from './projects';

const EMPTY_READ: StandardsRead = {
  standards: { notes: '', rules: [] },
  fileExists: false,
  blockPresent: false,
};

export interface ProjectRegistry {
  projects: ProjectMeta[];
  // project-groups FR-19..FR-22: the groups block + Identity's Group selector.
  groups: ProjectGroup[];
  setGroups: (g: ProjectGroup[]) => void;
  groupError: string | null;
  setGroupError: (message: string | null) => void;
  /** non-null while the inline "+ New group" field is open; '' just after opening. */
  newGroupDraft: string | null;
  setNewGroupDraft: (v: string | null) => void;
  selectedId: string | null;
  setSelectedId: (id: string | null) => void;
  models: ModelInfo[];
  standards: StandardsRead | null;
  setStandards: (s: StandardsRead) => void;
  notes: string;
  setNotes: (n: string) => void;
  nameDraft: string;
  setNameDraft: (n: string) => void;
  rootDraft: string;
  setRootDraft: (n: string) => void;
  draftOwner: string | null;
  syncDrafts: (p: ProjectMeta | undefined) => void;
  errors: Record<ProjectSection, string | null>;
  setError: (section: ProjectSection, message: string | null) => void;
  reload: (preferId?: string | null) => Promise<void>;
  selected: ProjectMeta | null;
  rootMissing: boolean;
  rules: string[];
  alive: MutableRefObject<boolean>;
  // Standards-editor UI state (reset alongside the standards re-read below —
  // kept here, not in the sections, so the FR-32 effect stays the single
  // place that resets it).
  editIndex: number;
  setEditIndex: (i: number) => void;
  editDraft: string;
  setEditDraft: (v: string) => void;
  newRule: string;
  setNewRule: (v: string) => void;
  removeConfirm: boolean;
  setRemoveConfirm: (v: boolean) => void;
}

export function useProjectRegistry(): ProjectRegistry {
  const setStoreProjects = useStore((s) => s.setProjects);
  // project-groups FR-11: keeps the store's roster-facing copy current too.
  const setStoreGroups = useStore((s) => s.setGroups);

  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [groups, setGroups] = useState<ProjectGroup[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [standards, setStandards] = useState<StandardsRead | null>(null);
  const [notes, setNotes] = useState('');
  const [newRule, setNewRule] = useState('');
  const [editIndex, setEditIndex] = useState(-1);
  const [editDraft, setEditDraft] = useState('');
  const [nameDraft, setNameDraft] = useState('');
  const [rootDraft, setRootDraft] = useState('');
  // Which project the Identity drafts belong to. Free-text state outlives a
  // selection change, so the commit guard needs to know whose text this is.
  const [draftOwner, setDraftOwner] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<ProjectSection, string | null>>(EMPTY_SECTION_ERRORS);
  const [removeConfirm, setRemoveConfirm] = useState(false);
  // project-groups FR-19/FR-20: the groups block's own inline errors + the
  // new-group inline field, kept alongside the rest of the modal's UI state.
  const [groupError, setGroupError] = useState<string | null>(null);
  const [newGroupDraft, setNewGroupDraft] = useState<string | null>(null);
  const alive = useMounted();

  const setError = (section: ProjectSection, message: string | null) => {
    setErrors((prev) => ({ ...prev, [section]: message }));
  };

  const syncDrafts = (p: ProjectMeta | undefined) => {
    setNameDraft(p?.name ?? '');
    setRootDraft(p?.root ?? '');
    setDraftOwner(p?.id ?? null);
  };

  // FR-32: the ONE read path — on open and after every registry mutation.
  const reload = async (preferId?: string | null): Promise<void> => {
    const res = await safeCall(projectList());
    if (!alive.current) return;
    if (!res.ok) {
      setError('list', res.error.message);
      return;
    }
    setError('list', null);
    setProjects(res.data.projects);
    setGroups(res.data.groups);
    setStoreProjects(res.data.projects); // keeps the switcher (and FR-26's fallback) honest
    setStoreGroups(res.data.groups); // project-groups: keeps the roster's tree honest
    const want = preferId !== undefined ? preferId : selectedId;
    const next = want && res.data.projects.some((p) => p.id === want) ? want : (res.data.projects[0]?.id ?? null);
    setSelectedId(next);
    // Drafts are NOT reseeded here. A selection change is handled by the effect
    // below (which also covers the list-row click, that never calls reload()), and
    // a reload with the selection UNCHANGED must leave an in-progress, unblurred
    // name/root edit alone.
  };

  useEffect(() => {
    void reload();
    void safeCall(sessionModels()).then((res) => {
      if (alive.current && res.ok) setModels(res.data);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // FR-32, second read trigger: the core edits projects.json BEHIND this modal
  // when a profile or an account is deleted, clearing every project default that
  // named it (session-profiles §A2 / multi-account §A1). Both modals can be open
  // at once — Profiles opens layered over Projects — so without this the config
  // form kept rendering a default the core had already cleared, as
  // `<id> (unavailable)`. Keyed on the two registries' identity, which changes
  // only when their own modal re-reads them.
  //
  // Safe to re-run: `reload()` deliberately does not reseed the Identity drafts
  // unless the selection changes, so an unblurred edit survives it.
  const profilesRegistry = useStore((s) => s.profiles);
  const accountsRegistry = useStore((s) => s.accounts);
  const registriesSeen = useRef(false);
  useEffect(() => {
    if (!registriesSeen.current) {
      registriesSeen.current = true; // the mount effect above already read
      return;
    }
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profilesRegistry, accountsRegistry]);

  // Reseed the Identity drafts whenever the SELECTION changes, wherever the change
  // came from. A list row sets `selectedId` directly and never goes through
  // reload(), so without this the drafts kept the PREVIOUS project's name/root
  // while `selected` already pointed at the new one — and a blur then fired
  // commitName/commitRoot, which compare the stale draft against the NEW project's
  // values, do not short-circuit, and write one project's identity onto another.
  // Reachable with no typing at all: focus the name field, click another row, click
  // away. Keyed on `selectedId` ALONE — adding `projects` would re-clobber an
  // unblurred edit on every unrelated reload (the case the reload() guard protects).
  useEffect(() => {
    syncDrafts(projects.find((p) => p.id === selectedId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  // The selected project's root, derived here (above the standards effect) because
  // that effect keys on it — a root edit must force a re-read (see below).
  const selectedRoot = projects.find((p) => p.id === selectedId)?.root ?? null;

  // FR-32: standards are re-read from disk on every selection change.
  useEffect(() => {
    setRemoveConfirm(false);
    setEditIndex(-1);
    setNewRule('');
    setError('identity', null);
    setError('defaults', null);
    setError('standards', null);
    if (selectedId === null) {
      setStandards(null);
      setNotes('');
      return;
    }
    let current = true;
    setStandards(null);
    // Clear the notes too, not just `standards`. `rules` falls back to [] via
    // `standards?.…` but `notes` is its own state, so the textarea kept rendering
    // the PREVIOUS project's text for the whole fetch (FR-32: never show cached
    // state from another entity, even in a disabled group).
    setNotes('');
    void safeCall(projectGetStandards(selectedId)).then((res) => {
      if (!current || !alive.current) return;
      if (res.ok) {
        setStandards(res.data);
        setNotes(res.data.standards.notes);
      } else {
        setStandards(EMPTY_READ);
        setNotes('');
        setError('standards', res.error.message); // e.g. PROJECT_ROOT_MISSING (§7 case 3)
      }
    });
    return () => {
      current = false;
    };
    // Keyed on the ROOT as well as the id: editing a project's root keeps the same
    // selectedId, so without this the editor kept showing the OLD root's block while
    // the footer already pointed at the new file — and the next rule edit wrote the
    // old content into the new root's CLAUDE.md.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, selectedRoot]);

  const selected = projects.find((p) => p.id === selectedId) ?? null;
  const rootMissing = selected !== null && !selected.rootExists;
  const rules = standards?.standards.rules ?? [];

  return {
    projects,
    groups,
    setGroups,
    selectedId,
    setSelectedId,
    models,
    standards,
    setStandards,
    notes,
    setNotes,
    nameDraft,
    setNameDraft,
    rootDraft,
    setRootDraft,
    draftOwner,
    syncDrafts,
    errors,
    setError,
    reload,
    selected,
    rootMissing,
    rules,
    alive,
    editIndex,
    setEditIndex,
    editDraft,
    setEditDraft,
    newRule,
    setNewRule,
    removeConfirm,
    setRemoveConfirm,
    groupError,
    setGroupError,
    newGroupDraft,
    setNewGroupDraft,
  };
}
