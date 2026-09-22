// overview-cards — the pure half of the redesigned OVERVIEW ("Graphite &
// Signal", Figma "15 · Overview" 138:6405): which sessions get a card, in what
// order, what the headline and the subtitle say, and how each card's footer and
// the activity trail read. Everything aggregational stays in
// contract/overview.ts; this file only decides the dashboard's wording and
// arrangement. Unit-tested in overview-cards.test.ts.

import type { SessionMeta, SessionStatus } from '../../../contract/common';
import type { SessionDerived } from '../../../contract/fleet-board';
import type { ActivityKind, FleetTotals } from '../../../contract/overview';
import type { StateKind } from '../../ui/state-kind';
import type { IconName } from '../../ui/icons';

/**
 * What a card is about. `review` is a settled session holding uncommitted work
 * (contract/overview's `uncommitted` reason) — the design's "Finished" card with
 * its `Review` action. `idle` / `done` are quiet sessions: they get no card in
 * the by-state view (the subtitle counts them), only in the by-project one.
 */
export type CardKind = 'approval' | 'question' | 'review' | 'running' | 'failed' | 'idle' | 'done';

export function cardKind(session: Pick<SessionMeta, 'status'>, derived: SessionDerived | undefined): CardKind {
  switch (session.status) {
    case 'awaiting_approval':
      return 'approval';
    case 'awaiting_input':
      return 'question';
    case 'starting':
    case 'running':
      return 'running';
    case 'error':
      return 'failed';
    default: {
      const files = derived?.fileCount ?? null;
      if (files != null && files > 0) return 'review';
      return session.status === 'done' ? 'done' : 'idle';
    }
  }
}

/** The card kinds that count toward "N sessions need you". */
const NEEDS_YOU: ReadonlySet<CardKind> = new Set(['approval', 'question', 'review']);

export function needsYou(kind: CardKind): boolean {
  return NEEDS_YOU.has(kind);
}

/**
 * Painted order of the by-state grid, as drawn: what is blocked on you, then
 * the finished work waiting for review, then what is running, then failures.
 */
const KIND_RANK: Record<CardKind, number> = {
  approval: 0,
  question: 1,
  review: 2,
  running: 3,
  failed: 4,
  idle: 5,
  done: 6,
};

export interface OverviewCard {
  session: SessionMeta;
  kind: CardKind;
}

/** Every session as a card, most urgent first, most recent first within a kind. */
export function rankCards(sessions: readonly SessionMeta[], derived: ReadonlyMap<string, SessionDerived>): OverviewCard[] {
  return sessions
    .map((session) => ({ session, kind: cardKind(session, derived.get(session.id)) }))
    .sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || b.session.lastActivityAt - a.session.lastActivityAt);
}

/** The by-state grid: every card except the quiet (clean idle / done) sessions. */
export function stateCards(sessions: readonly SessionMeta[], derived: ReadonlyMap<string, SessionDerived>): OverviewCard[] {
  return rankCards(sessions, derived).filter((c) => c.kind !== 'idle' && c.kind !== 'done');
}

/** "3 sessions need you" · "1 session needs you" · "Nothing needs you". */
export function overviewHeadline(count: number): string {
  if (count <= 0) return 'Nothing needs you';
  return count === 1 ? '1 session needs you' : `${count} sessions need you`;
}

/** "orbit" · "orbit and docs" · "orbit, docs and infra" · "5 projects". */
export function joinProjectNames(names: readonly string[], max = 3): string {
  if (names.length === 0) return '';
  if (names.length > max) return `${names.length} projects`;
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * The line under the headline: what is NOT asking for you, zero segments
 * dropped — "2 running with 3 subagents · 3 idle · 1 failed — across orbit,
 * docs and infra". The waiting sessions are the headline, so they are not
 * repeated here.
 */
export function overviewSubtitle(totals: FleetTotals, projectNames: readonly string[]): string {
  const c = totals.counts;
  const parts: string[] = [];
  const running = c.running + c.starting;
  if (running > 0) {
    const agents = totals.runningAgents;
    parts.push(
      agents > 0 ? `${running} running with ${agents} ${agents === 1 ? 'subagent' : 'subagents'}` : `${running} running`,
    );
  }
  if (c.idle > 0) parts.push(`${c.idle} idle`);
  if (c.done > 0) parts.push(`${c.done} done`);
  if (c.error > 0) parts.push(`${c.error} failed`);
  const body = parts.length > 0 ? parts.join(' · ') : totals.sessions === 0 ? 'No sessions yet' : 'All quiet';
  const across = joinProjectNames(projectNames);
  return across ? `${body} — across ${across}` : body;
}

/** The label beside a card's state glyph. */
export const CARD_LABEL: Record<CardKind, string> = {
  approval: 'Needs approval',
  question: 'Asked a question',
  review: 'Finished',
  running: 'Running',
  failed: 'Failed',
  idle: 'Idle',
  done: 'Done',
};

/** The Figma State glyph a card leads with. */
export const CARD_GLYPH: Record<CardKind, StateKind> = {
  approval: 'approval',
  question: 'question',
  review: 'done',
  running: 'running',
  failed: 'failed',
  idle: 'idle',
  done: 'done',
};

/** The action a card's footer names. `Allow · Deny` is rendered as two controls. */
export const CARD_ACTION: Record<CardKind, string> = {
  approval: 'Allow · Deny',
  question: 'Answer',
  review: 'Review',
  running: 'Open',
  failed: 'Open',
  idle: 'Open',
  done: 'Open',
};

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The footer's middle note: a running card counts its subagents, every other
 * card its uncommitted files — and either falls back to the model when it has
 * nothing to count (the design's "Sonnet 5").
 */
export function cardNote(kind: CardKind, derived: SessionDerived | undefined, modelLabel: string): string {
  if (kind === 'running') {
    const agents = derived?.runningAgentCount ?? 0;
    return agents > 0 ? plural(agents, 'subagent', 'subagents') : modelLabel;
  }
  const files = derived?.fileCount ?? null;
  return files != null && files > 0 ? plural(files, 'file', 'files') : modelLabel;
}

/** The footer's `+41 −12`, or null when the line totals are not known. */
export function cardDiffStat(derived: SessionDerived | undefined): { added: number; deleted: number } | null {
  if (!derived || derived.addedLines == null || derived.deletedLines == null) return null;
  return { added: derived.addedLines, deleted: derived.deletedLines };
}

/** The "Last output" block for the cards whose text is on SessionMeta itself. */
export function cardOutput(kind: CardKind, session: Pick<SessionMeta, 'errorMessage'>, activity: string | undefined): string | null {
  switch (kind) {
    case 'failed':
      return session.errorMessage?.trim() || 'The turn failed.';
    case 'running':
      return activity?.trim() || null;
    case 'question':
      return 'Asked you a question — open the session to answer.';
    default:
      return null;
  }
}

/** An approval's ask as the design prints it: a shell command gets a `$` prompt. */
export function askOutput(toolName: string, lead: string, code: string): string {
  if (code === '') return lead;
  return toolName.trim() === 'Bash' ? `$ ${code}` : `${lead} ${code}`;
}

// ---------- the activity trail ("Earlier today") ----------

/** The trail row's glyph per kind. */
export const ACTIVITY_ICON: Record<ActivityKind, IconName> = {
  'session.started': 'plus',
  'turn.finished': 'check',
  'session.done': 'check',
  'session.error': 'x',
  'session.removed': 'trash',
  'agent.finished': 'agent',
  'agent.failed': 'x',
};

/** The trail row's sentence lead (capitalised; the detail follows in mono). */
export const ACTIVITY_SENTENCE: Record<ActivityKind, string> = {
  'session.started': 'Started',
  'turn.finished': 'Finished a turn',
  'session.done': 'Done',
  'session.error': 'Failed',
  'session.removed': 'Removed',
  'agent.finished': 'Agent finished',
  'agent.failed': 'Agent failed',
};

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** `09:12` for today, `Mar 4` before that (local time). */
export function activityClock(at: number, now: number = Date.now()): string {
  const d = new Date(at);
  if (sameDay(d, new Date(now))) return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** The trail's heading: "Earlier today" while every entry is from today. */
export function activityHeading(ats: readonly number[], now: number = Date.now()): string {
  const today = new Date(now);
  return ats.every((at) => sameDay(new Date(at), today)) ? 'Earlier today' : 'Recent activity';
}

/** Statuses whose card ticks every second (a live elapsed clock). */
export function cardTicks(status: SessionStatus): boolean {
  return status === 'running' || status === 'starting';
}

// ---------- group-by (window chrome, persisted) ----------

export type OverviewGroupBy = 'state' | 'project';

export const GROUP_BY_KEY = 'francois.overviewGroupBy';

/** Anything but an exact 'project' reads as the default, by state. */
export function parseGroupBy(raw: string | null): OverviewGroupBy {
  return raw === 'project' ? 'project' : 'state';
}

/**
 * A card's second line, `orbit · feat/billing-retry`: the project (when the
 * session has one), then the worktree branch — or, in the main checkout, where
 * the roster knows no branch, the cwd's last segment.
 */
export function cardWhere(projectName: string | null, session: Pick<SessionMeta, 'cwd' | 'worktree'>): string {
  const parts = session.cwd.split(/[\\/]/).filter(Boolean);
  const place = session.worktree?.branch || parts[parts.length - 1] || session.cwd;
  return projectName ? `${projectName} · ${place}` : place;
}
