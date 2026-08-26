// useProjectList — NewSessionModal.tsx's former :117-134 project-list fetch
// + FR-30 preselect, plus the submit()-time recovery branch (:247-252) that
// re-reads the registry and drops back to "— none —" when the selected
// project vanished mid-flight (§7 case 13).

import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import type { ProjectId } from '../../../contract/common';
import type { ProjectMeta } from '../../../contract/projects';
import { projectList } from '../../lib/api';
import { safeCall } from '../projects/projects';

export interface UseProjectListResult {
  projects: ProjectMeta[];
  projectId: string;
  setProjectId: (id: string) => void;
  /** §7 case 13: re-reads the registry and resets to "— none —". Called from
   * submit() when the core rejects with PROJECT_NOT_FOUND / PROJECT_ROOT_MISSING. */
  recoverFromProjectError: () => Promise<void>;
}

export function useProjectList(
  activeProjectId: ProjectId | null,
  openRef: MutableRefObject<boolean>,
  /**
   * session-settings-sheet FR-13: "New session from these ↗" carries the
   * source session's project (or none, §7 case 12) over explicitly — present
   * (even with an empty `projectId`) means "skip the FR-30 active-project
   * preselect below; this choice is already deliberate".
   */
  seed?: { projectId?: string },
): UseProjectListResult {
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [projectId, setProjectId] = useState(seed?.projectId ?? '');
  // projects FR-30: opening the modal while the board is scoped to a project
  // starts in that project — "inside a project, a new session belongs to it".
  const preselectedRef = useRef(seed !== undefined);

  useEffect(() => {
    void safeCall(projectList()).then((res) => {
      if (!openRef.current || !res.ok) return;
      setProjects(res.data.projects);
      if (preselectedRef.current) return;
      preselectedRef.current = true;
      // A project whose root vanished can't back a session (FR-23) — don't
      // preselect it, or the modal opens already blocked.
      const active = res.data.projects.find((p) => p.id === activeProjectId && p.rootExists);
      if (active) setProjectId(active.id);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const recoverFromProjectError = async () => {
    const fresh = await safeCall(projectList());
    if (!openRef.current) return;
    if (fresh.ok) setProjects(fresh.data.projects);
    setProjectId('');
  };

  return { projects, projectId, setProjectId, recoverFromProjectError };
}
