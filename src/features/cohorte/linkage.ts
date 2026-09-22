// cohorte-integration FR-30 — which Cohorte run a session belongs to. Pure and
// unit-tested. Cohorte has no session id, so the link is inferred, per session
// S and run R in the same Cohorte root, by the first rule that matches:
//
//   1 launched     S's transcript ran `cohorte run|loop|build|fix|review` and
//                  printed R's id (explicitLinks, recorded by the tool rows)
//   2 worktree     S.cwd is one of R's worktrees (or a step's)
//   3 branch       S's worktree branch is R's integration or a worktree branch
//   4 base-branch  S sits in the Cohorte root itself on R's base branch, R live
//
// A session links to AT MOST ONE run: strongest rule, then a live run, then the
// latest start. Rules 1 and 4 are ORIGIN links, 2 and 3 STEP links.

import type { CohorteDetection, CohorteLinkReason, CohorteRun, CohorteSessionLink } from '../../../contract/cohorte-integration';
import type { SessionId, SessionMeta } from '../../../contract/common';

export type LinkSession = Pick<SessionMeta, 'id' | 'cwd' | 'worktree'>;

const RULE_ORDER: readonly CohorteLinkReason[] = ['launched', 'worktree', 'branch', 'base-branch'];

/** Slashes unified, trailing slash dropped, case folded where the filesystem ignores it. */
export function normalisePath(path: string, caseInsensitive: boolean): string {
  let p = path.replace(/\\/g, '/');
  while (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return caseInsensitive ? p.toLowerCase() : p;
}

export function isTerminalRun(run: Pick<CohorteRun, 'state'>): boolean {
  return run.state === 'COMPLETED' || run.state === 'CANCELLED';
}

/** The detected Cohorte detection for a start dir, tolerant of path spelling. */
export function detectionFor(
  detections: Readonly<Record<string, CohorteDetection>>,
  dir: string,
  caseInsensitive: boolean,
): CohorteDetection | null {
  const direct = detections[dir];
  if (direct) return direct;
  const want = normalisePath(dir, caseInsensitive);
  for (const [key, d] of Object.entries(detections)) {
    if (normalisePath(key, caseInsensitive) === want || normalisePath(d.startDir, caseInsensitive) === want) return d;
  }
  return null;
}

/** Whether a run id matches a ref recorded from a transcript (full id, or its first 10 chars). */
export function runMatchesRef(runId: string, ref: string): boolean {
  return ref.length >= 10 && (runId === ref || runId.startsWith(ref));
}

function runPaths(run: CohorteRun): string[] {
  const paths = run.worktrees.map((w) => w.path);
  for (const phase of run.phases) for (const step of phase.steps) if (step.worktree) paths.push(step.worktree.path);
  return paths;
}

function matchRule(
  session: LinkSession,
  run: CohorteRun,
  root: string,
  rootBranch: string | null,
  refs: readonly string[],
  ci: boolean,
): CohorteLinkReason | null {
  if (refs.some((ref) => runMatchesRef(run.runId, ref))) return 'launched';
  const cwd = normalisePath(session.cwd, ci);
  if (runPaths(run).some((p) => normalisePath(p, ci) === cwd)) return 'worktree';
  const branch = session.worktree?.branch;
  if (branch && (branch === run.git.integrationBranch || run.worktrees.some((w) => w.branch === branch))) return 'branch';
  if (
    !session.worktree &&
    cwd === normalisePath(root, ci) &&
    rootBranch !== null &&
    rootBranch === run.git.baseBranch &&
    !isTerminalRun(run)
  )
    return 'base-branch';
  return null;
}

export interface LinkInput {
  sessions: readonly LinkSession[];
  runs: readonly CohorteRun[];
  detections: Readonly<Record<string, CohorteDetection>>;
  explicitLinks: Readonly<Record<SessionId, readonly string[]>>;
  caseInsensitive: boolean;
}

/** FR-30: at most one link per session, in session order. */
export function computeLinks({ sessions, runs, detections, explicitLinks, caseInsensitive: ci }: LinkInput): CohorteSessionLink[] {
  const links: CohorteSessionLink[] = [];
  for (const session of sessions) {
    const d = detectionFor(detections, session.cwd, ci);
    if (!d || d.state !== 'detected' || !d.root) continue;
    const root = normalisePath(d.root, ci);
    const refs = explicitLinks[session.id] ?? [];
    let best: { run: CohorteRun; rule: CohorteLinkReason } | null = null;
    for (const run of runs) {
      if (normalisePath(run.projectRoot, ci) !== root) continue;
      const rule = matchRule(session, run, d.root, d.rootBranch, refs, ci);
      if (rule === null) continue;
      if (best === null || stronger({ run, rule }, best)) best = { run, rule };
    }
    if (best) {
      links.push({
        sessionId: session.id,
        projectRoot: best.run.projectRoot,
        runId: best.run.runId,
        reason: best.rule,
        role: best.rule === 'launched' || best.rule === 'base-branch' ? 'origin' : 'step',
      });
    }
  }
  return links;
}

function stronger(a: { run: CohorteRun; rule: CohorteLinkReason }, b: { run: CohorteRun; rule: CohorteLinkReason }): boolean {
  const ra = RULE_ORDER.indexOf(a.rule);
  const rb = RULE_ORDER.indexOf(b.rule);
  if (ra !== rb) return ra < rb;
  const ta = isTerminalRun(a.run);
  const tb = isTerminalRun(b.run);
  if (ta !== tb) return !ta;
  return a.run.startedAt > b.run.startedAt;
}

export function linkForSession(links: readonly CohorteSessionLink[], sessionId: SessionId): CohorteSessionLink | null {
  return links.find((l) => l.sessionId === sessionId) ?? null;
}

/** The run's origin session: its best origin link, else its first step link, else none. */
export function originSessionId(links: readonly CohorteSessionLink[], runId: string): SessionId | null {
  const mine = links.filter((l) => l.runId === runId);
  const origin =
    mine.find((l) => l.reason === 'launched') ?? mine.find((l) => l.reason === 'base-branch') ?? mine.find((l) => l.role === 'step');
  return origin?.sessionId ?? null;
}

/** Sessions linked to the run as steps (FR-86 nesting), origin excluded. */
export function stepSessionIds(links: readonly CohorteSessionLink[], runId: string): SessionId[] {
  const origin = originSessionId(links, runId);
  return links.filter((l) => l.runId === runId && l.role === 'step' && l.sessionId !== origin).map((l) => l.sessionId);
}

/** FR-68/FR-73: the session whose cwd is exactly this worktree path (rule 2), if any. */
export function sessionAtPath<S extends LinkSession>(sessions: readonly S[], path: string | undefined, ci: boolean): S | null {
  if (!path) return null;
  const want = normalisePath(path, ci);
  return sessions.find((s) => normalisePath(s.cwd, ci) === want) ?? null;
}
