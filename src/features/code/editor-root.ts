// code-editor FR-3 / flows 1–2: which root the explorer shows. A root is always
// NAMED (a project or a session) — the core resolves it to a path, never the frontend.

import type { EditorRoot } from '../../../contract/code-editor';

export type RootProject = { id: string; name: string };
export type RootSession = { id: string; name: string; projectId?: string; worktree?: { branch: string } };

export function rootKey(root: EditorRoot): string {
  return root.kind === 'project' ? `project:${root.projectId}` : `session:${root.sessionId}`;
}

const projectRoot = (projectId: string): EditorRoot => ({ kind: 'project', projectId });
const sessionRoot = (sessionId: string): EditorRoot => ({ kind: 'session', sessionId });

/**
 * Flow 1: the selected session's worktree; a selected session without one roots at
 * its project (or at itself when it has none); with no session, the active project,
 * else the first project.
 */
export function defaultRoot(ctx: {
  activeSessionId: string | null;
  activeProjectId: string | null;
  sessions: readonly RootSession[];
  projects: readonly RootProject[];
}): EditorRoot | null {
  const session = ctx.sessions.find((s) => s.id === ctx.activeSessionId);
  if (session) {
    if (session.worktree) return sessionRoot(session.id);
    if (session.projectId && ctx.projects.some((p) => p.id === session.projectId)) return projectRoot(session.projectId);
    return sessionRoot(session.id);
  }
  const project = ctx.projects.find((p) => p.id === ctx.activeProjectId) ?? ctx.projects[0];
  return project ? projectRoot(project.id) : null;
}

export interface RootOption {
  key: string;
  root: EditorRoot;
  label: string;
  branch: string | null;
}

/** Flow 2: every project, then every open session that has a worktree. */
export function rootOptions(projects: readonly RootProject[], sessions: readonly RootSession[]): RootOption[] {
  const out: RootOption[] = projects.map((p) => ({ key: `project:${p.id}`, root: projectRoot(p.id), label: p.name, branch: null }));
  for (const s of sessions) {
    if (s.worktree) out.push({ key: `session:${s.id}`, root: sessionRoot(s.id), label: s.name, branch: s.worktree.branch });
  }
  return out;
}

/** §7: false once the root's project was removed or its session went away. */
export function rootExists(root: EditorRoot, projects: readonly RootProject[], sessions: readonly RootSession[]): boolean {
  return root.kind === 'project' ? projects.some((p) => p.id === root.projectId) : sessions.some((s) => s.id === root.sessionId);
}
