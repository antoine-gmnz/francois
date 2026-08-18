// projects — keeps the STORE's registry copy in step with the core: one read on
// mount, and one more whenever the Projects modal closes (the modal is the only
// other writer). `setProjects` also reconciles activeProjectId (FR-26 / §7 case
// 16), so this is what makes a restored scope survive a relaunch.
//
// Lives on whichever component is always mounted and owns the switcher — the
// titlebar (UsageBar) — with pane [1]'s ProjectSwitcher sharing it for the case
// where that strip is mounted too. Both firing is harmless (same read, last
// write wins), which is why the effect is deliberately idempotent.

import { useEffect } from 'react';
import { projectList } from '../../lib/api';
import { useStore } from '../../lib/store';
import { useMounted } from '../../lib/hooks/useMounted';
import { safeCall } from './projects';

export function useProjectRegistrySync(): void {
  const setProjects = useStore((s) => s.setProjects);
  // project-groups FR-11: the roster's second tier, fed by the same read.
  const setGroups = useStore((s) => s.setGroups);
  const projectsOpen = useStore((s) => s.projectsOpen);
  const mounted = useMounted();

  useEffect(() => {
    // While the modal is open it owns the registry (useProjectRegistry re-reads
    // after every write); re-reading here would race its optimistic state. The
    // false→false first run covers the initial load, so there is deliberately no
    // separate mount fetch — that duplicated every read, ×2 again under
    // StrictMode: four project_list calls per app start.
    if (projectsOpen) return;
    void safeCall(projectList()).then((res) => {
      if (!mounted.current || !res.ok) return;
      setProjects(res.data.projects);
      setGroups(res.data.groups);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectsOpen]);
}
