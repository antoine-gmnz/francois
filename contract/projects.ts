// contract/projects.ts — projects (registry, session defaults, standards).
// Authored from specs/projects.md §5. Imports shared vocabulary from common.ts;
// never redefines it. ProjectId / ProjectDefaults live in common.ts because
// SessionMeta references ProjectId — they are re-exported here for convenience.
//
// Physical Tauri binding: francois:project:<verb> → command project_<verb>
// (snake_case), called via invoke('project_<verb>', payload) → Promise<Result<T>>.
//
// NO EVENT CHANNEL is defined here (spec §5 preamble): every project mutation is
// initiated by this app's own frontend and resolves with the new state, so a push
// channel would carry nothing the response does not. The one piece of project state
// that reaches other features — SessionMeta.projectId — rides on the existing
// `session.meta` SessionEvent.

import type {
  ProjectId,
  ProjectDefaults,
  Result,
  SessionMeta,
  SessionEvent,
} from './common';

export type { ProjectId, ProjectDefaults };

// ---------- the entity ----------

export interface ProjectMeta {
  id: ProjectId;
  /** Display name; defaults to basename(root). Trimmed, 1–80 chars. NOT unique (FR-6). */
  name: string;
  /** Absolute, normalized (FR-8) directory path. Unique across the registry. */
  root: string;
  defaults: ProjectDefaults;
  createdAt: number; // epoch ms
  /** epoch ms; refreshed when a session is created under this project (FR-20). */
  lastUsedAt: number;
  /**
   * Derived at list time by stat-ing `root` — NEVER persisted (FR-2).
   * false ⇒ the directory is gone or is not a directory. The project's Identity group
   * stays editable so the root can be corrected in place, Defaults + Standards are
   * disabled (FR-38), and it cannot back a new session (FR-23).
   */
  rootExists: boolean;
}

// ---------- standards ----------

/** The exact marker lines Francois owns inside CLAUDE.md (FR-11). Matched verbatim. */
export const STANDARDS_START = '<!-- francois:standards:start -->';
export const STANDARDS_END = '<!-- francois:standards:end -->';
/** The heading rendered as the block's first content line (FR-11). */
export const STANDARDS_HEADING = '## Coding standards';

/** Validation bounds enforced by the core BEFORE any file is opened (FR-13). */
export const MAX_RULE_LENGTH = 500;
export const MAX_RULES = 200;
export const MAX_NOTES_LENGTH = 8000;
/** Trimmed project name bounds (FR-6). */
export const MAX_PROJECT_NAME_LENGTH = 80;

/**
 * The structured content of the managed block. Rendered and parsed by the RUST CORE
 * only (it owns the file); the frontend edits this shape and never touches CLAUDE.md.
 * Rules are identified by their INDEX — the whole object is written on every change.
 *
 * Block grammar (FR-11), '\n' line endings:
 *
 *   <!-- francois:standards:start -->
 *   ## Coding standards
 *   {notes trimmed, then ONE blank line — both omitted entirely when notes is empty}
 *   - {rule 1}
 *   - {rule 2}
 *   <!-- francois:standards:end -->
 */
export interface ProjectStandards {
  /** Free-form markdown above the bullets; '' when unset. ≤ MAX_NOTES_LENGTH (FR-13). */
  notes: string;
  /**
   * Ordered rules. Each: trimmed non-empty, ≤ MAX_RULE_LENGTH, single-line (no \n or \r),
   * and containing neither STANDARDS_START nor STANDARDS_END. ≤ MAX_RULES entries.
   */
  rules: string[];
}

/** What a standards read reports about the file on disk. */
export interface StandardsRead {
  standards: ProjectStandards;
  /** <root>/CLAUDE.md exists. */
  fileExists: boolean;
  /** the managed block was found (false ⇒ `standards` is empty). */
  blockPresent: boolean;
}

// ---------- francois:project:list — frontend -> core ----------

/** No payload. */
export type ProjectListRequest = void;
/** Ordered by lastUsedAt desc, then name asc (case-insensitive) — FR-5. */
export type ProjectListData = ProjectMeta[];
/**
 * A missing/empty/corrupt projects.json yields [] and is NOT an error (FR-3).
 * ok:false error codes: 'INTERNAL'.
 */
export type ProjectListResponse = Result<ProjectListData>;

// ---------- francois:project:create — frontend -> core ----------

export interface ProjectCreateRequest {
  /** absolute path to an existing directory; normalized by the core (FR-8). */
  root: string;
  /** omit ⇒ basename(root). Trimmed, 1–MAX_PROJECT_NAME_LENGTH chars. */
  name?: string;
  /** omit ⇒ all defaults unset ("inherit"). */
  defaults?: ProjectDefaults;
}
/**
 * ok:false error codes:
 *   'INVALID_INPUT'          — root missing/not absolute/not a directory, or a bad name
 *   'PROJECT_DUPLICATE_ROOT' — another project already owns that normalized root
 *   'INTERNAL'               — projects.json could not be written
 */
export type ProjectCreateResponse = Result<ProjectMeta>;

// ---------- francois:project:update — frontend -> core ----------

export interface ProjectUpdateRequest {
  projectId: ProjectId;
  /** present ⇒ replace the name. */
  name?: string;
  /** present ⇒ replace the root (re-validated per FR-6/FR-7; self excluded from dup check). */
  root?: string;
  /**
   * present ⇒ REPLACE THE WHOLE defaults object. An omitted field inside it means
   * "inherit" — this is how a default is cleared (FR-7).
   */
  defaults?: ProjectDefaults;
}
/**
 * Changing `root` does NOT re-link, unlink, or move any session (FR-7).
 * ok:false error codes:
 *   'PROJECT_NOT_FOUND' | 'INVALID_INPUT' | 'PROJECT_DUPLICATE_ROOT' | 'INTERNAL'
 */
export type ProjectUpdateResponse = Result<ProjectMeta>;

// ---------- francois:project:remove — frontend -> core ----------

export interface ProjectRemoveRequest {
  projectId: ProjectId;
}
/**
 * Deletes the entry, then clears projectId on every session that referenced it — in the
 * in-memory engine map AND in sessions.json — emitting one `session.meta` SessionEvent
 * per affected session (FR-9). NEVER deletes, moves, or edits anything under `root`.
 * ok:false error codes: 'PROJECT_NOT_FOUND' | 'INTERNAL'
 */
export type ProjectRemoveResponse = Result<null>;

// ---------- francois:project:getStandards — frontend -> core ----------

export interface ProjectGetStandardsRequest {
  projectId: ProjectId;
}
/**
 * A missing CLAUDE.md is NOT an error — it returns
 * { standards: { notes: '', rules: [] }, fileExists: false, blockPresent: false } (FR-10).
 * A file whose markers are malformed (unterminated / duplicated START) reads as
 * blockPresent:false with empty standards; only WRITES refuse (FR-14).
 * ok:false error codes: 'PROJECT_NOT_FOUND' | 'PROJECT_ROOT_MISSING' | 'INTERNAL'
 */
export type ProjectGetStandardsResponse = Result<StandardsRead>;

// ---------- francois:project:setStandards — frontend -> core ----------

export interface ProjectSetStandardsRequest {
  projectId: ProjectId;
  /**
   * The WHOLE object. Empty rules AND empty notes REMOVES the block (and does not
   * create the file if it never existed) — FR-13.
   */
  standards: ProjectStandards;
}
/**
 * Resolves with a FRESH RE-READ of the file, not the payload it was given (FR-16).
 * ok:false error codes:
 *   'PROJECT_NOT_FOUND' | 'PROJECT_ROOT_MISSING'
 *   'INVALID_INPUT'          — rule/notes length, a multiline rule, or a marker string inside
 *   'STANDARDS_WRITE_FAILED' — malformed marker pairing (FR-14) or an I/O failure (FR-15)
 */
export type ProjectSetStandardsResponse = Result<StandardsRead>;

// ---------- consumed (owned by session-engine; pinned here for build-ability) ----------

/**
 * session_create gains an optional projectId. The core stores it VERBATIM and does NO
 * default merging (FR-19) — the frontend resolves the project and applies its defaults
 * (FR-21) so that what the user sees in the modal is exactly what is created.
 * Added error codes for this call: 'PROJECT_NOT_FOUND' | 'PROJECT_ROOT_MISSING'.
 */
export interface ProjectAwareSessionCreateRequest {
  cwd: string;
  name?: string;
  modelId?: string;
  effort?: string;
  permissionMode?: string;
  runtime?: string;
  allowGit?: boolean;
  /** NEW — the project this session belongs to; omit for unlinked. */
  projectId?: ProjectId;
}

/** projects handles exactly these SessionEvent members (to keep its link map fresh). */
export type ProjectsHandledSessionEvent = Extract<
  SessionEvent,
  { type: 'session.meta' } | { type: 'session.removed' }
>;

// ---------- pure frontend helpers (owned here, unit-tested) ----------

/**
 * FR-8 containment, frontend side: true when `root` equals or is an ancestor of `cwd`,
 * compared COMPONENT-WISE (so 'D:\a\bc' is NOT inside 'D:\a\b'), case-insensitively when
 * `caseInsensitive` (Windows). Both paths must already be normalized — separators
 * unified, no trailing separator. An empty `root` never contains anything.
 */
export function isPathInside(cwd: string, root: string, caseInsensitive: boolean): boolean {
  if (!cwd || !root) return false;
  const norm = (p: string) => {
    const u = p.replace(/[\\/]+/g, '/').replace(/\/+$/, '');
    return caseInsensitive ? u.toLowerCase() : u;
  };
  const c = norm(cwd);
  const r = norm(root);
  if (c === r) return true;
  return c.startsWith(r + '/');
}

/**
 * The project whose root contains `cwd`, DEEPEST (longest root) wins; projects with
 * rootExists === false are excluded. null when none match.
 *
 * NOT currently called by the new-session modal: FR-21 was amended so the project
 * SUPPLIES the cwd rather than being inferred from it. Kept (and unit-tested) as the
 * primitive a future "adopt this directory into a project" affordance needs.
 */
export function resolveProjectForCwd(
  cwd: string,
  projects: ProjectMeta[],
  caseInsensitive: boolean,
): ProjectMeta | null {
  let best: ProjectMeta | null = null;
  for (const p of projects) {
    if (!p.rootExists) continue;
    if (!isPathInside(cwd, p.root, caseInsensitive)) continue;
    if (!best || p.root.length > best.root.length) best = p;
  }
  return best;
}

/**
 * FR-5 ordering. Pure — returns a copy.
 *
 * Currently UNCALLED: every mutation re-reads `project_list`, which the core already
 * returns in this order, so there is no local re-sort to do. Kept (and tested) for a
 * future optimistic-update path — its tie-break matches the core's byte-for-byte.
 */
export function orderProjects(projects: ProjectMeta[]): ProjectMeta[] {
  return projects.slice().sort((a, b) => {
    if (b.lastUsedAt !== a.lastUsedAt) return b.lastUsedAt - a.lastUsedAt;
    // Deliberately NOT localeCompare: the core breaks this tie with a plain
    // lowercase comparison (registry.rs list_metas), and the two must agree or a
    // locally re-sorted list drifts from the next project_list.
    const an = a.name.toLowerCase();
    const bn = b.name.toLowerCase();
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
}

/**
 * FR-27: the sessions the board should render.
 * activeProjectId === null ⇒ every session, unchanged (same array reference is fine).
 */
export function filterSessionsByProject(
  sessions: SessionMeta[],
  activeProjectId: ProjectId | null,
): SessionMeta[] {
  if (activeProjectId === null) return sessions;
  return sessions.filter((s) => s.projectId === activeProjectId);
}

// ---------- shared frontend store fields owned by this feature ----------

/**
 * FR-39: the scope to return to if the new-session modal that a switch into an
 * EMPTY project opened is cancelled. `null` in `to` means "All projects" — which
 * is why this is a wrapper object and not a bare `ProjectId | null` field: the
 * absence of a pending rollback has to be distinguishable from a rollback to All.
 */
export interface ProjectSwitchRollback {
  to: ProjectId | null;
}

export interface ProjectsState {
  projects: ProjectMeta[];
  setProjects: (p: ProjectMeta[]) => void;
  /** null = "All projects" (FR-26); persisted to localStorage 'francois.activeProjectId'. */
  activeProjectId: ProjectId | null;
  setActiveProjectId: (id: ProjectId | null) => void;
  /**
   * FR-39: the USER-facing scope change — what the switcher calls. Sets
   * `activeProjectId` and then lands the user somewhere inside that scope: the
   * project's first session, or the new-session modal when it has none.
   * `setActiveProjectId` stays the plain field write (rollback, restore, demo).
   */
  switchProject: (id: ProjectId | null) => void;
  /** FR-39: non-null only while the auto-opened new-session modal is up. */
  projectSwitchRollback: ProjectSwitchRollback | null;
  /** FR-39: cancelling that modal — restores the previous scope. No-op when nothing is pending. */
  rollbackProjectSwitch: () => void;
  /** FR-39: the session WAS created — the switch stands, so drop the rollback. */
  clearProjectSwitchRollback: () => void;
  /** the Projects modal (FR-31), alongside the existing permissionsOpen. */
  projectsOpen: boolean;
  setProjectsOpen: (o: boolean) => void;
}

/** localStorage key for activeProjectId (FR-26). */
export const ACTIVE_PROJECT_STORAGE_KEY = 'francois.activeProjectId';
