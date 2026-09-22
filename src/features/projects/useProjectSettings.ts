// projects — the read + write halves of the project settings, wired together
// once. It was ProjectsModal's body; the redesign ("Graphite & Signal", Settings
// 22 · 140:7787) turns the modal into the Settings view's project pages, where
// the SAME registry also feeds the nav's project picker and the MCP servers page
// (which project's servers to show). So the pairing lives here, not in a page.
//
// Landing: the registry lands on its first project; settings opened while a
// project is scoped should open on THAT project — once, on the first list, so a
// later pick in the nav is never overridden.

import { useEffect, useRef } from 'react';
import { useStore } from '../../lib/store';
import { useProjectMutations, type ProjectMutations } from './useProjectMutations';
import { useProjectRegistry, type ProjectRegistry } from './useProjectRegistry';

export interface ProjectSettings {
  registry: ProjectRegistry;
  mutations: ProjectMutations;
}

export function useProjectSettings(): ProjectSettings {
  const registry = useProjectRegistry();
  const mutations = useProjectMutations({
    models: registry.models,
    projects: registry.projects,
    selectedId: registry.selectedId,
    selected: registry.selected,
    draftOwner: registry.draftOwner,
    nameDraft: registry.nameDraft,
    rootDraft: registry.rootDraft,
    standards: registry.standards,
    notes: registry.notes,
    rules: registry.rules,
    alive: registry.alive,
    reload: registry.reload,
    syncDrafts: registry.syncDrafts,
    setStandards: registry.setStandards,
    setNotes: registry.setNotes,
    setError: registry.setError,
    setRemoveConfirm: registry.setRemoveConfirm,
    setGroupError: registry.setGroupError,
    setNewGroupDraft: registry.setNewGroupDraft,
  });

  const activeProjectId = useStore((s) => s.activeProjectId);
  const landed = useRef(false);
  const { projects, setSelectedId } = registry;
  useEffect(() => {
    if (landed.current || projects.length === 0) return;
    landed.current = true;
    if (activeProjectId && projects.some((p) => p.id === activeProjectId)) setSelectedId(activeProjectId);
  }, [projects, activeProjectId, setSelectedId]);

  return { registry, mutations };
}
