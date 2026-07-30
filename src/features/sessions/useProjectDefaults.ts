// useProjectDefaults — NewSessionModal.tsx's former :144-175 effect (FR-21/
// FR-22): applying a project overwrites every field it declares and leaves
// the rest at the pre-feature default. Runs ONLY on a project change (tracked
// by appliedRef), so a manual edit afterwards always wins.

import { useEffect, useRef } from 'react';
import type { ClaudeRuntime, ModelInfo, PermissionMode } from '../../../contract/common';
import { isWslUncPath } from '../../../contract/wsl-filesystem';
import type { ProjectMeta } from '../../../contract/projects';
import { applyProjectDefaults, baseFormValues } from '../projects/projects';
import { IS_WINDOWS } from '../../lib/platform';
import { basename } from './new-session-form';

export interface UseProjectDefaultsParams {
  projectId: string;
  project: ProjectMeta | null;
  models: ModelInfo[];
  modelsLoading: boolean;
  nameTouched: boolean;
  runtimeTouched: boolean;
  setModelId: (id: string) => void;
  setEffort: (effort: string) => void;
  setPermissionMode: (mode: PermissionMode) => void;
  setAllowGit: (allow: boolean) => void;
  setStaleModelId: (id: string | null) => void;
  setRuntime: (runtime: ClaudeRuntime) => void;
  setCwd: (cwd: string) => void;
  setName: (name: string) => void;
}

export function useProjectDefaults(params: UseProjectDefaultsParams): void {
  const {
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
  } = params;

  const appliedRef = useRef<string | null>(null);
  useEffect(() => {
    if (modelsLoading) return;
    if (appliedRef.current === projectId) return;
    appliedRef.current = projectId;

    const base = baseFormValues(models);
    const applied = applyProjectDefaults(base, project?.defaults, { models, allowWsl: IS_WINDOWS });
    setModelId(applied.values.modelId);
    setEffort(applied.values.effort);
    setPermissionMode(applied.values.permissionMode);
    setAllowGit(applied.values.allowGit);
    setStaleModelId(applied.staleModelId);

    // Runtime: the project's explicit default wins. When it declares none, fall back
    // to the SAME WSL auto-suggest the unlinked path gets from applyCwd (FR-16) —
    // the project path sets cwd directly and so used to bypass it entirely, creating
    // a `native` session against a \\wsl.localhost\… root while the modal was already
    // rendering its own "expect slow git" warning for that path.
    if (project && project.defaults.runtime === undefined && IS_WINDOWS && !runtimeTouched) {
      setRuntime(isWslUncPath(project.root) ? 'wsl' : 'native');
    } else {
      setRuntime(applied.values.runtime);
    }

    // The project OWNS the working directory — there is no directory row while
    // one is selected, so the root is the cwd. Clearing back to '' on "none"
    // restores the pre-projects flow rather than stranding the old root.
    setCwd(project ? project.root : '');
    if (!nameTouched) setName(project ? basename(project.root) : '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, project, models, modelsLoading]);
}
