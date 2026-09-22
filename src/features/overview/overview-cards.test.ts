import { describe, expect, it } from 'vitest';
import type { SessionMeta, SessionStatus } from '../../../contract/common';
import type { SessionDerived } from '../../../contract/fleet-board';
import { emptyStatusCounts, type FleetTotals } from '../../../contract/overview';
import {
  activityClock,
  activityHeading,
  askOutput,
  cardDiffStat,
  cardWhere,
  cardKind,
  cardNote,
  cardOutput,
  joinProjectNames,
  needsYou,
  overviewHeadline,
  overviewSubtitle,
  parseGroupBy,
  rankCards,
  stateCards,
} from './overview-cards';

const session = (id: string, status: SessionStatus, lastActivityAt = 0, errorMessage?: string) =>
  ({ id, status, lastActivityAt, errorMessage }) as unknown as SessionMeta;

const derived = (fileCount: number | null, runningAgentCount = 0, added: number | null = null, deleted: number | null = null): SessionDerived => ({
  fileCount,
  runningAgentCount,
  addedLines: added,
  deletedLines: deleted,
});

const totals = (patch: Partial<FleetTotals['counts']>, runningAgents = 0, sessions = 1): FleetTotals => ({
  sessions,
  activeProjects: 1,
  counts: { ...emptyStatusCounts(), ...patch },
  changedFiles: 0,
  runningAgents,
});

describe('cardKind', () => {
  it('maps the parked, busy and failed statuses directly', () => {
    expect(cardKind(session('a', 'awaiting_approval'), undefined)).toBe('approval');
    expect(cardKind(session('a', 'awaiting_input'), undefined)).toBe('question');
    expect(cardKind(session('a', 'starting'), undefined)).toBe('running');
    expect(cardKind(session('a', 'running'), undefined)).toBe('running');
    expect(cardKind(session('a', 'error'), undefined)).toBe('failed');
  });

  it('makes a settled session with uncommitted files a review card', () => {
    expect(cardKind(session('a', 'idle'), derived(3))).toBe('review');
    expect(cardKind(session('a', 'done'), derived(1))).toBe('review');
  });

  it('keeps a clean or unknown settled session quiet', () => {
    expect(cardKind(session('a', 'idle'), derived(0))).toBe('idle');
    expect(cardKind(session('a', 'idle'), derived(null))).toBe('idle');
    expect(cardKind(session('a', 'done'), undefined)).toBe('done');
  });

  it('counts only approval, question and review as needing you', () => {
    expect(['approval', 'question', 'review'].every((k) => needsYou(k as never))).toBe(true);
    expect(['running', 'failed', 'idle', 'done'].some((k) => needsYou(k as never))).toBe(false);
  });
});

describe('rankCards / stateCards', () => {
  const sessions = [
    session('fail', 'error', 50),
    session('run-old', 'running', 10),
    session('idle', 'idle', 99),
    session('run-new', 'running', 20),
    session('review', 'idle', 5),
    session('q', 'awaiting_input', 1),
    session('ask', 'awaiting_approval', 0),
  ];
  const map = new Map([['review', derived(2)]]);

  it('orders approval → question → review → running → failed → quiet, recent first', () => {
    expect(rankCards(sessions, map).map((c) => c.session.id)).toEqual(['ask', 'q', 'review', 'run-new', 'run-old', 'fail', 'idle']);
  });

  it('drops the quiet sessions from the by-state grid', () => {
    expect(stateCards(sessions, map).map((c) => c.session.id)).not.toContain('idle');
    expect(stateCards(sessions, map)).toHaveLength(6);
  });
});

describe('overviewHeadline', () => {
  it('reads singular, plural and nothing', () => {
    expect(overviewHeadline(3)).toBe('3 sessions need you');
    expect(overviewHeadline(1)).toBe('1 session needs you');
    expect(overviewHeadline(0)).toBe('Nothing needs you');
  });
});

describe('joinProjectNames', () => {
  it('joins with commas and a final "and", folding past the cap', () => {
    expect(joinProjectNames([])).toBe('');
    expect(joinProjectNames(['orbit'])).toBe('orbit');
    expect(joinProjectNames(['orbit', 'docs'])).toBe('orbit and docs');
    expect(joinProjectNames(['orbit', 'docs', 'infra'])).toBe('orbit, docs and infra');
    expect(joinProjectNames(['a', 'b', 'c', 'd'])).toBe('4 projects');
  });
});

describe('overviewSubtitle', () => {
  it('reads the design line, zero segments dropped', () => {
    expect(overviewSubtitle(totals({ running: 2, idle: 3, error: 1 }, 3), ['orbit', 'docs', 'infra'])).toBe(
      '2 running with 3 subagents · 3 idle · 1 failed — across orbit, docs and infra',
    );
  });

  it('folds starting into running and omits subagents at zero', () => {
    expect(overviewSubtitle(totals({ running: 1, starting: 1 }), [])).toBe('2 running');
  });

  it('says all quiet when only waiting sessions exist, and names no projects when there are none', () => {
    expect(overviewSubtitle(totals({ awaiting_approval: 1 }), ['orbit'])).toBe('All quiet — across orbit');
    expect(overviewSubtitle(totals({}, 0, 0), [])).toBe('No sessions yet');
  });
});

describe('card footer + output', () => {
  it('counts subagents on a running card, files elsewhere, else names the model', () => {
    expect(cardNote('running', derived(4, 2), 'Opus')).toBe('2 subagents');
    expect(cardNote('running', derived(4, 0), 'Sonnet 5')).toBe('Sonnet 5');
    expect(cardNote('review', derived(1), 'Opus')).toBe('1 file');
    expect(cardNote('approval', derived(6), 'Opus')).toBe('6 files');
    expect(cardNote('failed', undefined, 'Opus')).toBe('Opus');
  });

  it('returns the diff stat only when both totals are known', () => {
    expect(cardDiffStat(derived(2, 0, 41, 12))).toEqual({ added: 41, deleted: 12 });
    expect(cardDiffStat(derived(2, 0, 41, null))).toBeNull();
    expect(cardDiffStat(undefined)).toBeNull();
  });

  it('reads the output block from the session', () => {
    expect(cardOutput('failed', { errorMessage: ' pg_dump: error ' }, undefined)).toBe('pg_dump: error');
    expect(cardOutput('failed', {}, undefined)).toBe('The turn failed.');
    expect(cardOutput('running', {}, 'Running npm test')).toBe('Running npm test');
    expect(cardOutput('running', {}, undefined)).toBeNull();
    expect(cardOutput('review', {}, 'x')).toBeNull();
  });

  it('prints a shell ask with a prompt and anything else with its lead', () => {
    expect(askOutput('Bash', 'Wants to run', 'git push')).toBe('$ git push');
    expect(askOutput('Edit', 'Wants to edit', 'charge.ts')).toBe('Wants to edit charge.ts');
    expect(askOutput('Bash', 'Wants to run', '')).toBe('Wants to run');
  });
});

describe('activity trail', () => {
  const now = new Date(2026, 8, 22, 15, 0).getTime();

  it('reads HH:MM today and a short date before', () => {
    expect(activityClock(new Date(2026, 8, 22, 9, 5).getTime(), now)).toBe('09:05');
    expect(activityClock(new Date(2026, 8, 20, 9, 5).getTime(), now)).toBe('Sep 20');
  });

  it('heads the trail "Earlier today" only when every entry is from today', () => {
    expect(activityHeading([new Date(2026, 8, 22, 1).getTime()], now)).toBe('Earlier today');
    expect(activityHeading([new Date(2026, 8, 21, 23).getTime()], now)).toBe('Recent activity');
  });
});

describe('parseGroupBy', () => {
  it('defaults to state', () => {
    expect(parseGroupBy(null)).toBe('state');
    expect(parseGroupBy('bogus')).toBe('state');
    expect(parseGroupBy('project')).toBe('project');
  });
});

describe('cardWhere', () => {
  it('names the project then the worktree branch, else the cwd leaf', () => {
    expect(cardWhere('orbit', { cwd: '/w/orbit', worktree: { branch: 'feat/x' } as never })).toBe('orbit · feat/x');
    expect(cardWhere('orbit', { cwd: 'C:\\code\\orbit' })).toBe('orbit · orbit');
    expect(cardWhere(null, { cwd: '/home/me/docs/' })).toBe('docs');
  });
});
