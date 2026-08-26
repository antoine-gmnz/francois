// overview — unit tests over every pure helper the dashboard owns
// (contract/overview.ts) plus the local presentation helpers in overview.ts.
// Node env, no DOM.

import { describe, expect, it } from 'vitest';
import type { ModelInfo, SessionMeta, SessionStatus } from '../../../contract/common';
import type { ProjectMeta } from '../../../contract/projects';
import type { SessionDerived } from '../../../contract/fleet-board';
import {
  ACTIVITY_LABEL,
  MAX_ACTIVITY,
  UNLINKED_GROUP_NAME,
  activityTone,
  appendActivity,
  computeFleetTotals,
  countByStatus,
  emptyStatusCounts,
  filterActivityByProject,
  groupSessionsByProject,
  needsAttention,
  statusTransitionKind,
  type ActivityEntry,
} from '../../../contract/overview';
import { formatGroupSubtitle, mintActivityId, totalsSegments } from './overview';

const MODEL: ModelInfo = { id: 'claude-opus-5', label: 'Opus 5' };

function session(over: Partial<SessionMeta> & { id: string }): SessionMeta {
  return {
    name: over.id,
    cwd: `D:\\${over.id}`,
    model: MODEL,
    status: 'idle',
    contextUsedTokens: 0,
    contextLimitTokens: 200_000,
    startedAt: 1_000,
    lastActivityAt: 1_000,
    permissionMode: 'default',
    permissionModeSince: 0,
    runtime: 'native',
    accountId: 'default',
    agentRuntime: 'claude-code',
    protocol: 'anthropic',
    responseMode: 'default',
    allowGit: false,
    ...over,
  };
}

function project(over: Partial<ProjectMeta> & { id: string }): ProjectMeta {
  return {
    name: over.id,
    root: `D:\\${over.id}`,
    defaults: {},
    createdAt: 1,
    lastUsedAt: 1,
    rootExists: true,
    ...over,
  };
}

const derivedMap = (entries: Record<string, Partial<SessionDerived>>): Map<string, SessionDerived> =>
  new Map(
    Object.entries(entries).map(([id, d]) => [id, { fileCount: null, runningAgentCount: 0, addedLines: null, deletedLines: null, ...d }]),
  );

// ---------- countByStatus ----------

describe('countByStatus', () => {
  it('starts every counter at zero', () => {
    expect(countByStatus([])).toEqual(emptyStatusCounts());
  });

  it('tallies each status independently', () => {
    const counts = countByStatus([
      session({ id: 'a', status: 'running' }),
      session({ id: 'b', status: 'running' }),
      session({ id: 'c', status: 'error' }),
      session({ id: 'd', status: 'done' }),
      session({ id: 'e', status: 'starting' }),
      session({ id: 'f', status: 'awaiting_approval' }),
      session({ id: 'g', status: 'awaiting_input' }),
    ]);
    expect(counts).toEqual({
      ...emptyStatusCounts(),
      running: 2,
      error: 1,
      done: 1,
      starting: 1,
      awaiting_approval: 1,
      awaiting_input: 1,
    });
  });

  it('ignores a status outside the union rather than minting a key', () => {
    const counts = countByStatus([session({ id: 'a', status: 'weird' as SessionStatus })]);
    expect(counts).toEqual(emptyStatusCounts());
  });
});

// ---------- groupSessionsByProject ----------

describe('groupSessionsByProject', () => {
  const projects = [project({ id: 'p1', name: 'francois' }), project({ id: 'p2', name: 'survey' })];

  it('keeps registry order and includes projects owning no session', () => {
    const groups = groupSessionsByProject([session({ id: 's1', projectId: 'p1' })], projects);
    expect(groups.map((g) => g.name)).toEqual(['francois', 'survey']);
    expect(groups[1].sessions).toEqual([]);
    expect(groups[1].counts).toEqual(emptyStatusCounts());
  });

  it('appends the unlinked bucket last, and only when non-empty', () => {
    expect(groupSessionsByProject([session({ id: 's1', projectId: 'p1' })], projects)).toHaveLength(2);

    const groups = groupSessionsByProject(
      [session({ id: 's1', projectId: 'p1' }), session({ id: 's2' })],
      projects,
    );
    expect(groups).toHaveLength(3);
    expect(groups[2].name).toBe(UNLINKED_GROUP_NAME);
    expect(groups[2].projectId).toBeNull();
    expect(groups[2].root).toBeNull();
    expect(groups[2].sessions.map((s) => s.id)).toEqual(['s2']);
  });

  it('treats a projectId the registry does not know as unlinked (projects FR-18)', () => {
    const groups = groupSessionsByProject([session({ id: 's1', projectId: 'gone' })], projects);
    expect(groups[groups.length - 1].name).toBe(UNLINKED_GROUP_NAME);
    expect(groups[groups.length - 1].sessions.map((s) => s.id)).toEqual(['s1']);
  });

  it('sorts sessions inside a group by lastActivityAt descending', () => {
    const groups = groupSessionsByProject(
      [
        session({ id: 'old', projectId: 'p1', lastActivityAt: 10 }),
        session({ id: 'new', projectId: 'p1', lastActivityAt: 900 }),
        session({ id: 'mid', projectId: 'p1', lastActivityAt: 500 }),
      ],
      projects,
    );
    expect(groups[0].sessions.map((s) => s.id)).toEqual(['new', 'mid', 'old']);
  });

  it('scopes to one project and hides the unlinked bucket when activeProjectId is set', () => {
    const groups = groupSessionsByProject(
      [session({ id: 's1', projectId: 'p1' }), session({ id: 's2', projectId: 'p2' }), session({ id: 's3' })],
      projects,
      'p1',
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].projectId).toBe('p1');
    expect(groups[0].sessions.map((s) => s.id)).toEqual(['s1']);
  });

  it('carries rootExists through so a missing root can be flagged', () => {
    const groups = groupSessionsByProject([], [project({ id: 'p1', rootExists: false })]);
    expect(groups[0].rootExists).toBe(false);
  });

  it('does not mutate the input arrays', () => {
    const sessions = [
      session({ id: 'a', projectId: 'p1', lastActivityAt: 1 }),
      session({ id: 'b', projectId: 'p1', lastActivityAt: 2 }),
    ];
    groupSessionsByProject(sessions, projects);
    expect(sessions.map((s) => s.id)).toEqual(['a', 'b']);
  });
});

// ---------- computeFleetTotals ----------

describe('computeFleetTotals', () => {
  const projects = [project({ id: 'p1' }), project({ id: 'p2' })];

  it('is all zeroes over no groups', () => {
    expect(computeFleetTotals([], new Map())).toEqual({
      sessions: 0,
      activeProjects: 0,
      counts: emptyStatusCounts(),
      changedFiles: 0,
      runningAgents: 0,
    });
  });

  it('sums sessions, statuses, files and agents across groups', () => {
    const groups = groupSessionsByProject(
      [
        session({ id: 's1', projectId: 'p1', status: 'running' }),
        session({ id: 's2', projectId: 'p2', status: 'error' }),
        session({ id: 's3' }),
      ],
      projects,
    );
    const totals = computeFleetTotals(
      groups,
      derivedMap({
        s1: { fileCount: 4, runningAgentCount: 2 },
        s2: { fileCount: 1 },
        s3: { fileCount: null, runningAgentCount: 1 },
      }),
    );
    expect(totals.sessions).toBe(3);
    expect(totals.activeProjects).toBe(3); // p1, p2 and the unlinked bucket
    expect(totals.counts).toEqual({ ...emptyStatusCounts(), running: 1, idle: 1, error: 1 });
    expect(totals.changedFiles).toBe(5);
    expect(totals.runningAgents).toBe(3);
  });

  it('does not count a project owning no session as active', () => {
    const groups = groupSessionsByProject([session({ id: 's1', projectId: 'p1' })], projects);
    expect(computeFleetTotals(groups, new Map()).activeProjects).toBe(1);
  });

  it('treats an unknown or null fileCount as zero rather than NaN', () => {
    const groups = groupSessionsByProject([session({ id: 's1', projectId: 'p1' })], projects);
    expect(computeFleetTotals(groups, new Map()).changedFiles).toBe(0);
    expect(computeFleetTotals(groups, derivedMap({ s1: { fileCount: null } })).changedFiles).toBe(0);
  });
});

// ---------- needsAttention ----------

describe('needsAttention', () => {
  const projects = [project({ id: 'p1' })];
  const groupsOf = (sessions: SessionMeta[]) => groupSessionsByProject(sessions, projects);

  it('lists errored sessions with their message', () => {
    const items = needsAttention(
      groupsOf([session({ id: 's1', projectId: 'p1', status: 'error', errorMessage: 'spawn failed' })]),
      new Map(),
    );
    expect(items).toHaveLength(1);
    expect(items[0].reason).toBe('error');
    expect(items[0].detail).toBe('spawn failed');
  });

  it('falls back to a generic detail when the error carries no message', () => {
    const items = needsAttention(groupsOf([session({ id: 's1', projectId: 'p1', status: 'error' })]), new Map());
    expect(items[0].detail).toBe('session failed');
  });

  it('lists a settled session that left uncommitted files, singular and plural', () => {
    const items = needsAttention(
      groupsOf([
        session({ id: 's1', projectId: 'p1', status: 'idle', lastActivityAt: 2 }),
        session({ id: 's2', projectId: 'p1', status: 'done', lastActivityAt: 1 }),
      ]),
      derivedMap({ s1: { fileCount: 1 }, s2: { fileCount: 7 } }),
    );
    expect(items.map((i) => i.detail)).toEqual(['1 uncommitted file', '7 uncommitted files']);
  });

  it('never lists a working session, even with uncommitted files', () => {
    const items = needsAttention(
      groupsOf([
        session({ id: 's1', projectId: 'p1', status: 'running' }),
        session({ id: 's2', projectId: 'p1', status: 'starting' }),
      ]),
      derivedMap({ s1: { fileCount: 9 }, s2: { fileCount: 4 } }),
    );
    expect(items).toEqual([]);
  });

  it('lists a parked session, naming which kind of answer it wants', () => {
    const items = needsAttention(
      groupsOf([
        session({ id: 's1', projectId: 'p1', status: 'awaiting_input', lastActivityAt: 2 }),
        session({ id: 's2', projectId: 'p1', status: 'awaiting_approval', lastActivityAt: 1 }),
      ]),
      new Map(),
    );
    expect(items.map((i) => i.reason)).toEqual(['approval', 'question']);
    expect(items[0].detail).toBe('waiting on an approval');
    expect(items[1].detail).toBe('waiting on an answer');
  });

  it('ranks parked sessions above errored ones — a stalled turn is unblockable now', () => {
    const items = needsAttention(
      groupsOf([
        session({ id: 's1', projectId: 'p1', status: 'error', lastActivityAt: 99 }),
        session({ id: 's2', projectId: 'p1', status: 'awaiting_input', lastActivityAt: 1 }),
        session({ id: 's3', projectId: 'p1', status: 'awaiting_approval', lastActivityAt: 2 }),
      ]),
      new Map(),
    );
    // Band order wins over recency, even though the error is the most recent.
    expect(items.map((i) => i.session.id)).toEqual(['s3', 's2', 's1']);
  });

  it('does not fall through to the uncommitted check for a parked session', () => {
    const items = needsAttention(
      groupsOf([session({ id: 's1', projectId: 'p1', status: 'awaiting_approval' })]),
      derivedMap({ s1: { fileCount: 9 } }),
    );
    expect(items).toHaveLength(1);
    expect(items[0].reason).toBe('approval');
  });

  it('ignores a clean or unknown diff count', () => {
    const items = needsAttention(
      groupsOf([session({ id: 's1', projectId: 'p1' }), session({ id: 's2', projectId: 'p1' })]),
      derivedMap({ s1: { fileCount: 0 }, s2: { fileCount: null } }),
    );
    expect(items).toEqual([]);
  });

  it('puts every error before every uncommitted item, each most-recent first', () => {
    const items = needsAttention(
      groupsOf([
        session({ id: 'dirty-new', projectId: 'p1', status: 'idle', lastActivityAt: 900 }),
        session({ id: 'err-old', projectId: 'p1', status: 'error', lastActivityAt: 10 }),
        session({ id: 'dirty-old', projectId: 'p1', status: 'idle', lastActivityAt: 20 }),
        session({ id: 'err-new', projectId: 'p1', status: 'error', lastActivityAt: 800 }),
      ]),
      derivedMap({ 'dirty-new': { fileCount: 2 }, 'dirty-old': { fileCount: 3 } }),
    );
    expect(items.map((i) => i.session.id)).toEqual(['err-new', 'err-old', 'dirty-new', 'dirty-old']);
  });

  it('reports an errored session once, not also as uncommitted', () => {
    const items = needsAttention(
      groupsOf([session({ id: 's1', projectId: 'p1', status: 'error', errorMessage: 'boom' })]),
      derivedMap({ s1: { fileCount: 4 } }),
    );
    expect(items).toHaveLength(1);
    expect(items[0].reason).toBe('error');
  });
});

// ---------- activity log ----------

const entry = (over: Partial<ActivityEntry> & { id: string }): ActivityEntry => ({
  at: 1_000,
  kind: 'turn.finished',
  sessionId: 's1',
  sessionName: 'core',
  detail: '',
  ...over,
});

describe('appendActivity', () => {
  it('prepends newest-first without mutating the input', () => {
    const log = [entry({ id: '1' })];
    const next = appendActivity(log, entry({ id: '2' }));
    expect(next.map((e) => e.id)).toEqual(['2', '1']);
    expect(log).toHaveLength(1);
  });

  it('caps the buffer at MAX_ACTIVITY, dropping the oldest', () => {
    let log: ActivityEntry[] = [];
    for (let i = 0; i < MAX_ACTIVITY + 25; i++) log = appendActivity(log, entry({ id: String(i) }));
    expect(log).toHaveLength(MAX_ACTIVITY);
    expect(log[0].id).toBe(String(MAX_ACTIVITY + 24));
    expect(log[log.length - 1].id).toBe(String(25));
  });
});

describe('filterActivityByProject', () => {
  const log = [entry({ id: '1', projectId: 'p1' }), entry({ id: '2' }), entry({ id: '3', projectId: 'p2' })];

  it('returns everything when unscoped', () => {
    expect(filterActivityByProject(log, null).map((e) => e.id)).toEqual(['1', '2', '3']);
  });

  it('keeps only the scoped project, excluding unlinked entries', () => {
    expect(filterActivityByProject(log, 'p1').map((e) => e.id)).toEqual(['1']);
  });
});

describe('statusTransitionKind', () => {
  it('records error and done from any prior status', () => {
    expect(statusTransitionKind('running', 'error')).toBe('session.error');
    expect(statusTransitionKind(undefined, 'error')).toBe('session.error');
    expect(statusTransitionKind('idle', 'done')).toBe('session.done');
  });

  it('records a finished turn only when the session had a turn in flight', () => {
    expect(statusTransitionKind('running', 'idle')).toBe('turn.finished');
    expect(statusTransitionKind(undefined, 'idle')).toBeNull();
    expect(statusTransitionKind('done', 'idle')).toBeNull();
  });

  it('counts a turn interrupted while parked as finished', () => {
    // ⌃C on an approval card goes awaiting_* → idle without passing through
    // `running`; that is a finished turn like any other.
    expect(statusTransitionKind('awaiting_approval', 'idle')).toBe('turn.finished');
    expect(statusTransitionKind('awaiting_input', 'idle')).toBe('turn.finished');
    expect(statusTransitionKind('starting', 'idle')).toBe('turn.finished');
  });

  it('never records the start of a turn, or a park/unpark — they would drown the feed', () => {
    expect(statusTransitionKind('idle', 'running')).toBeNull();
    expect(statusTransitionKind('idle', 'starting')).toBeNull();
    expect(statusTransitionKind('starting', 'running')).toBeNull();
    expect(statusTransitionKind('running', 'awaiting_approval')).toBeNull();
    expect(statusTransitionKind('awaiting_approval', 'running')).toBeNull();
  });

  it('ignores a no-op transition', () => {
    expect(statusTransitionKind('error', 'error')).toBeNull();
  });
});

describe('activityTone', () => {
  it('maps every kind to a tone, tinting failures red and completions green', () => {
    for (const kind of Object.keys(ACTIVITY_LABEL) as (keyof typeof ACTIVITY_LABEL)[]) {
      expect(activityTone(kind)).toMatch(/^(error|success|active|neutral)$/);
    }
    expect(activityTone('session.error')).toBe('error');
    expect(activityTone('agent.failed')).toBe('error');
    expect(activityTone('session.done')).toBe('success');
    expect(activityTone('session.removed')).toBe('neutral');
  });
});

// ---------- local presentation helpers ----------

describe('mintActivityId', () => {
  it('is unique even for entries minted within the same millisecond', () => {
    const ids = new Set([mintActivityId(5), mintActivityId(5), mintActivityId(5)]);
    expect(ids.size).toBe(3);
  });
});

describe('totalsSegments', () => {
  it('drops zero-valued segments so the strip never reads "0 error"', () => {
    const segs = totalsSegments({
      sessions: 2,
      activeProjects: 1,
      counts: { ...emptyStatusCounts(), running: 2 },
      changedFiles: 0,
      runningAgents: 0,
    });
    expect(segs.map((s) => s.label)).toEqual(['active']);
    expect(segs[0].value).toBe(2);
  });

  it('orders segments active → waiting → ready → done → error → files → agents', () => {
    const segs = totalsSegments({
      sessions: 5,
      activeProjects: 2,
      counts: { ...emptyStatusCounts(), running: 1, awaiting_approval: 1, idle: 1, done: 1, error: 1 },
      changedFiles: 6,
      runningAgents: 3,
    });
    expect(segs.map((s) => s.label)).toEqual(['active', 'waiting', 'ready', 'done', 'error', 'files', 'agents']);
  });

  it('folds starting into "active" — a fleet total of "1 starting" is noise', () => {
    const segs = totalsSegments({
      sessions: 3,
      activeProjects: 1,
      counts: { ...emptyStatusCounts(), running: 1, starting: 2 },
      changedFiles: 0,
      runningAgents: 0,
    });
    expect(segs.map((s) => s.label)).toEqual(['active']);
    expect(segs[0].value).toBe(3);
  });

  it('folds both parked states into one "waiting" segment', () => {
    const segs = totalsSegments({
      sessions: 3,
      activeProjects: 1,
      counts: { ...emptyStatusCounts(), awaiting_approval: 2, awaiting_input: 1 },
      changedFiles: 0,
      runningAgents: 0,
    });
    expect(segs.map((s) => s.label)).toEqual(['waiting']);
    expect(segs[0].value).toBe(3);
  });

  it('is empty when nothing at all is happening', () => {
    expect(
      totalsSegments({
        sessions: 0,
        activeProjects: 0,
        counts: emptyStatusCounts(),
        changedFiles: 0,
        runningAgents: 0,
      }),
    ).toEqual([]);
  });
});

describe('formatGroupSubtitle', () => {
  const projects = [project({ id: 'p1', name: 'francois', root: 'D:\\francois' })];

  it('reads "no sessions" for an empty project', () => {
    const [g] = groupSessionsByProject([], projects);
    expect(formatGroupSubtitle(g)).toBe('no sessions');
  });

  it('pluralises the session count and appends live status', () => {
    const [g] = groupSessionsByProject(
      [
        session({ id: 's1', projectId: 'p1', status: 'running' }),
        session({ id: 's2', projectId: 'p1', status: 'error' }),
      ],
      projects,
    );
    expect(formatGroupSubtitle(g)).toBe('2 sessions · 1 active · 1 error');
  });

  it('says just the count when everything is merely ready', () => {
    const [g] = groupSessionsByProject([session({ id: 's1', projectId: 'p1', status: 'idle' })], projects);
    expect(formatGroupSubtitle(g)).toBe('1 session');
  });

  it('calls out parked sessions before errors, folding both kinds into "waiting"', () => {
    const [g] = groupSessionsByProject(
      [
        session({ id: 's1', projectId: 'p1', status: 'awaiting_approval' }),
        session({ id: 's2', projectId: 'p1', status: 'awaiting_input' }),
        session({ id: 's3', projectId: 'p1', status: 'error' }),
      ],
      projects,
    );
    expect(formatGroupSubtitle(g)).toBe('3 sessions · 2 waiting · 1 error');
  });

  it('counts a starting session as active', () => {
    const [g] = groupSessionsByProject(
      [
        session({ id: 's1', projectId: 'p1', status: 'starting' }),
        session({ id: 's2', projectId: 'p1', status: 'running' }),
      ],
      projects,
    );
    expect(formatGroupSubtitle(g)).toBe('2 sessions · 2 active');
  });
});

// ---------- gaps named by review ----------

describe('review-named gaps', () => {
  const entry = (id: string): ActivityEntry => ({
    id: `a-${id}`,
    at: Number(id.replace(/\D/g, '')) || 0,
    kind: 'session.started',
    sessionId: id,
    sessionName: id,
    detail: '',
  });

  it('appendActivity at EXACTLY the cap keeps the cap and evicts the oldest', () => {
    // the existing suite only covers "exceeded by 25" — the boundary itself is
    // where an off-by-one in the `>` vs `>=` truncation would hide
    const full = Array.from({ length: MAX_ACTIVITY }, (_, i) => entry(`s${MAX_ACTIVITY - 1 - i}`));
    expect(full).toHaveLength(MAX_ACTIVITY);

    const next = appendActivity(full, entry('newest'));
    expect(next).toHaveLength(MAX_ACTIVITY);
    expect(next[0].sessionId).toBe('newest');
    // the previously-oldest entry is gone, everything else shifted by one
    expect(next.map((e) => e.sessionId)).not.toContain('s0');
    expect(next[1].sessionId).toBe(`s${MAX_ACTIVITY - 1}`);

    // one BELOW the cap must not truncate
    const nearly = full.slice(0, MAX_ACTIVITY - 1);
    expect(appendActivity(nearly, entry('x'))).toHaveLength(MAX_ACTIVITY);
  });

  it('activityTone maps each kind to its EXACT tone', () => {
    // asserting the exact value, not just membership of the tone union — a
    // copy-paste swap between two kinds passes a regex check but not this
    expect(activityTone('session.started')).toBe('active');
    expect(activityTone('turn.finished')).toBe('active');
    expect(activityTone('session.error')).toBe('error');
  });

  it('groupSessionsByProject keeps a scoped project that owns NO session', () => {
    // FR-20: "including projects owning no session" — only covered unscoped before
    const projects = [project({ id: 'p1', name: 'alpha' }), project({ id: 'p2', name: 'bravo' })];
    const sessions = [session({ id: 's1', projectId: 'p1' })];

    const scoped = groupSessionsByProject(sessions, projects, 'p2');
    expect(scoped).toHaveLength(1);
    expect(scoped[0].projectId).toBe('p2');
    expect(scoped[0].sessions).toEqual([]);
  });
});
