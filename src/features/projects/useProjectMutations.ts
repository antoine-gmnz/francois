// projects — ProjectsModal's mutation logic (no Save button — FR-35). Every
// commit fires its command, a failure shows inline, and a success or failure
// alike re-reads through `reload` so the form returns to on-disk truth.
// Split out of ProjectsModal per REFACTOR.md §6c.

import { useState, type MutableRefObject } from 'react';
import type { ProjectMeta, ProjectStandards, StandardsRead } from '../../../contract/projects';
import {
  projectCreate,
  projectGetStandards,
  projectRemove,
  projectSetStandards,
  projectUpdate,
  sessionPickDirectory,
} from '../../lib/api';
import {
  canCommitIdentity,
  nextSelectionAfterRemove,
  patchDefaults,
  safeCall,
  type DefaultsKey,
  type ProjectSection,
} from './projects';

export interface ProjectMutationsDeps {
  projects: ProjectMeta[];
  selectedId: string | null;
  selected: ProjectMeta | null;
  draftOwner: string | null;
  nameDraft: string;
  rootDraft: string;
  standards: StandardsRead | null;
  notes: string;
  rules: string[];
  alive: MutableRefObject<boolean>;
  reload: (preferId?: string | null) => Promise<void>;
  syncDrafts: (p: ProjectMeta | undefined) => void;
  setStandards: (s: StandardsRead) => void;
  setNotes: (n: string) => void;
  setError: (section: ProjectSection, message: string | null) => void;
  setRemoveConfirm: (v: boolean) => void;
}

export interface ProjectMutations {
  busy: boolean;
  commitName: () => void;
  commitRoot: () => void;
  commitDefault: (key: DefaultsKey, value: string) => void;
  commitRules: (nextRules: string[]) => void;
  commitNotes: () => void;
  addProject: () => Promise<void>;
  doRemove: () => Promise<void>;
}

export function useProjectMutations(deps: ProjectMutationsDeps): ProjectMutations {
  const {
    projects,
    selectedId,
    selected,
    draftOwner,
    nameDraft,
    rootDraft,
    standards,
    notes,
    rules,
    alive,
    reload,
    syncDrafts,
    setStandards,
    setNotes,
    setError,
    setRemoveConfirm,
  } = deps;
  const [busy, setBusy] = useState(false);

  const runUpdate = async (
    patch: { name?: string; root?: string; defaults?: ProjectMeta['defaults'] },
    group: 'identity' | 'defaults',
  ) => {
    if (!selectedId) return;
    setBusy(true);
    const res = await safeCall(projectUpdate({ projectId: selectedId, ...patch }));
    if (!alive.current) return;
    setError(group, res.ok ? null : res.error.message);
    // FR-8 normalizes a root (trailing separator stripped, `.`/`..` resolved, case
    // folded), and FR-6 trims a name — so the stored value can differ from what was
    // typed. Reseed the drafts from what the core actually saved, or the inputs keep
    // showing the raw text until the user navigates away and back. Identity only:
    // a defaults change must not touch an unblurred edit.
    if (res.ok && group === 'identity') syncDrafts(res.data);
    await reload(selectedId); // success or failure: back to on-disk truth (FR-32/FR-35)
    if (alive.current) setBusy(false);
  };

  // Both guards fail CLOSED when the draft belongs to another project — see
  // canCommitIdentity. Without that, focusing the name field, clicking a different
  // row, then clicking away renamed the NEWLY selected project to the old one's name.
  const commitName = () => {
    if (!canCommitIdentity(draftOwner, selectedId, nameDraft, selected?.name)) return;
    void runUpdate({ name: nameDraft.trim() }, 'identity');
  };

  const commitRoot = () => {
    if (!canCommitIdentity(draftOwner, selectedId, rootDraft, selected?.root)) return;
    void runUpdate({ root: rootDraft.trim() }, 'identity');
  };

  const commitDefault = (key: DefaultsKey, value: string) => {
    if (!selected) return;
    void runUpdate({ defaults: patchDefaults(selected.defaults, key, value) }, 'defaults');
  };

  // FR-35: the whole standards object on every individual change; FR-16: repaint
  // from the response's fresh re-read, never from what was typed.
  const commitStandards = async (next: ProjectStandards) => {
    if (!selectedId) return;
    setBusy(true);
    const res = await safeCall(projectSetStandards(selectedId, next));
    if (!alive.current) return;
    if (res.ok) {
      setError('standards', null);
      setStandards(res.data);
      setNotes(res.data.standards.notes);
    } else {
      setError('standards', res.error.message);
      const re = await safeCall(projectGetStandards(selectedId));
      if (alive.current && re.ok) {
        setStandards(re.data);
        setNotes(re.data.standards.notes);
      }
    }
    if (alive.current) setBusy(false);
  };

  const commitRules = (nextRules: string[]) => {
    // NEVER write before the on-disk read has landed. While `standards` is null the
    // editor renders from `rules = []` and `notes = ''`, so a commit in that window
    // would replace the file's real block with whatever single rule was just typed.
    // (commitNotes has always had this guard; commitRules did not.)
    if (!standards) return;
    // A no-op edit (clamped reorder, unchanged inline edit, empty add) must not
    // rewrite CLAUDE.md — §7 case 9 makes every write lossy for hand-written
    // content inside the block.
    if (nextRules.length === rules.length && nextRules.every((r, i) => r === rules[i])) return;
    void commitStandards({ notes, rules: nextRules });
  };

  const commitNotes = () => {
    if (!standards || notes === standards.standards.notes) return;
    void commitStandards({ notes, rules });
  };

  const addProject = async () => {
    // Re-entry guard: `busy` was only set AFTER the pick resolved, so a double-click
    // opened two native directory dialogs, and a create could start while an update
    // round-trip was still in flight.
    if (busy) return;
    setBusy(true);
    const pick = await safeCall(sessionPickDirectory());
    if (!alive.current) return;
    if (!pick.ok || pick.data === null) setBusy(false);
    if (!pick.ok) {
      setError('list', pick.error.message);
      return;
    }
    if (pick.data === null) return; // cancelled
    const res = await safeCall(projectCreate({ root: pick.data.path }));
    if (!alive.current) return;
    if (res.ok) {
      setError('list', null);
      await reload(res.data.id);
    } else {
      setError('list', res.error.message); // e.g. PROJECT_DUPLICATE_ROOT (§7 case 2)
      await reload();
    }
    if (alive.current) setBusy(false);
  };

  const doRemove = async () => {
    if (!selectedId) return;
    const next = nextSelectionAfterRemove(projects, selectedId);
    setBusy(true);
    const res = await safeCall(projectRemove(selectedId));
    if (!alive.current) return;
    if (!res.ok) setError('identity', res.error.message);
    setRemoveConfirm(false);
    await reload(next);
    if (alive.current) setBusy(false);
  };

  return { busy, commitName, commitRoot, commitDefault, commitRules, commitNotes, addProject, doRemove };
}
