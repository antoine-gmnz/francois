// ProjectField — NewSessionModal.tsx's former :307-340. The project comes
// FIRST — picking one settles the working directory and every default below,
// so it is the decision the rest of the form hangs off. Renders nothing when
// no project exists yet, so the pre-projects form is untouched until you
// make one.

import { PROJECT_ROOT_MISSING_LINE, newSessionProjectOptions } from '../projects/projects';
import type { ProjectMeta } from '../../../contract/projects';

export interface ProjectFieldProps {
  projects: ProjectMeta[];
  projectId: string;
  project: ProjectMeta | null;
  projectRootMissing: boolean;
  staleModelId: string | null;
  onChange: (projectId: string) => void;
}

export function ProjectField({
  projects,
  projectId,
  project,
  projectRootMissing,
  staleModelId,
  onChange,
}: ProjectFieldProps): JSX.Element | null {
  if (projects.length === 0) return null;
  return (
    <div>
      <label className="new-session-modal__label">PROJECT</label>
      <select
        className="new-session-modal__field"
        value={projectId}
        onChange={(e) => {
          onChange(e.target.value);
          // A project change re-applies defaults (FR-22), and the name is
          // derived again unless it was hand-edited.
        }}
      >
        {newSessionProjectOptions(projects).map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.missing ? `${opt.label} (missing)` : opt.label}
          </option>
        ))}
      </select>
      {projectRootMissing && (
        <div className="new-session-modal__hint new-session-modal__hint--error">{PROJECT_ROOT_MISSING_LINE}</div>
      )}
      {/* Where it will actually run. Deliberately a dim read-only line and
          NOT a field — the project owns the path, so there is nothing to
          edit here. */}
      {project && !projectRootMissing && <div className="new-session-modal__hint">runs in {project.root}</div>}
      {staleModelId && (
        <div className="new-session-modal__hint">
          this project's default model ({staleModelId}) is no longer available — using the default
        </div>
      )}
    </div>
  );
}
