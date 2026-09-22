// overview — the OVERVIEW main tab, redesign "Graphite & Signal" (Figma
// "15 · Overview" 138:6405): a headline that answers "does anything need me?",
// a grid of session cards, and the activity trail underneath.
//
//   Header   "3 sessions need you" + what is not asking for you
//            (2 running with 3 subagents · 3 idle · 1 failed — across …),
//            then the project filter, By state | By project, and New task.
//   Cards    by state: every session that is doing or asking something —
//            approvals, questions, finished work to review, running, failed —
//            most urgent first (the quiet ones are counted, not carded).
//            by project: every session, carded under its project, so the old
//            per-project rollup is still one click away.
//   Trail    the activity ring buffer, "Earlier today".
//
// It owns NO subscription and NO IPC call beyond the inline approval answer
// (the same reply path the roster uses). Everything it renders is already in
// the store: the session cache, the fleet board's derived figures, the roster
// signals, the project registry, and the activity log.

import { useMemo, useRef, useState, type ReactNode } from 'react';
import type { SessionMeta } from '../../../contract/common';
import type { SessionDerived } from '../../../contract/fleet-board';
import {
  activityTone,
  computeFleetTotals,
  filterActivityByProject,
  groupSessionsByProject,
  type ActivityEntry,
  type OverviewGroup,
} from '../../../contract/overview';
import { useDismiss } from '../../lib/hooks/useDismiss';
import { useElapsedClock } from '../../lib/hooks/useElapsedClock';
import { useStore } from '../../lib/store';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { Tab, TabGroup } from '../../ui/Tab';
import { OverviewCard } from './OverviewCard';
import {
  ACTIVITY_ICON,
  ACTIVITY_SENTENCE,
  activityClock,
  activityHeading,
  cardTicks,
  GROUP_BY_KEY,
  needsYou,
  overviewHeadline,
  overviewSubtitle,
  parseGroupBy,
  rankCards,
  stateCards,
  type OverviewCard as Card,
  type OverviewGroupBy,
} from './overview-cards';
import './overview.css';

const TRAIL_LIMIT = 40;

function readGroupBy(): OverviewGroupBy {
  try {
    return parseGroupBy(localStorage.getItem(GROUP_BY_KEY));
  } catch {
    return 'state';
  }
}

// `home` is accepted for MainPaneBody's call shape; the cards show no paths.
export default function OverviewView(_props: { home: string }) {
  const sessions = useStore((s) => s.sessions);
  const projects = useStore((s) => s.projects);
  const derived = useStore((s) => s.derived);
  const activity = useStore((s) => s.activity);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const setActiveSessionId = useStore((s) => s.setActiveSessionId);
  const setMainTab = useStore((s) => s.setMainTab);
  const setFocusedPane = useStore((s) => s.setFocusedPane);
  const setNewSessionOpen = useStore((s) => s.setNewSessionOpen);
  const setProjectsOpen = useStore((s) => s.setProjectsOpen);

  const [groupBy, setGroupByState] = useState<OverviewGroupBy>(readGroupBy);
  const setGroupBy = (next: OverviewGroupBy) => {
    setGroupByState(next);
    try {
      localStorage.setItem(GROUP_BY_KEY, next);
    } catch {
      /* ignore */
    }
  };

  const groups = useMemo(
    () => groupSessionsByProject(sessions, projects, activeProjectId),
    [sessions, projects, activeProjectId],
  );
  const inScope = useMemo(() => groups.flatMap((g) => g.sessions), [groups]);
  const totals = useMemo(() => computeFleetTotals(groups, derived), [groups, derived]);
  const cards = useMemo(() => stateCards(inScope, derived), [inScope, derived]);
  const feed = useMemo(() => filterActivityByProject(activity, activeProjectId).slice(0, TRAIL_LIMIT), [activity, activeProjectId]);
  const projectNameOf = useMemo(() => {
    const names = new Map(projects.map((p) => [p.id, p.name]));
    return (s: SessionMeta) => (s.projectId ? names.get(s.projectId) ?? null : null);
  }, [projects]);

  // A running card's clock moves every second; otherwise relative ages only
  // need to age on a slow cadence (fleet-board FR-25).
  const anyTicking = inScope.some((s) => cardTicks(s.status));
  const now = useElapsedClock(true, anyTicking ? 1000 : 30_000);

  const needYouCount = cards.filter((c) => needsYou(c.kind)).length;
  const activeNames = groups.filter((g) => g.sessions.length > 0 && g.projectId !== null).map((g) => g.name);

  // Drilling in from the dashboard: select the session AND leave the tab.
  const openSession = (id: string, tab?: 'diff') => {
    setActiveSessionId(id);
    setMainTab(tab ?? 'session');
    setFocusedPane('main');
  };

  const nothingAtAll = sessions.length === 0 && projects.length === 0;

  return (
    <div className="scz ov-root">
      {nothingAtAll ? (
        <EmptyState onNewSession={() => setNewSessionOpen(true)} onManageProjects={() => setProjectsOpen(true)} />
      ) : (
        <div className="ov-main">
          <header className="ov-header">
            <div className="ov-header__title">
              <h1 className="ov-headline">{overviewHeadline(needYouCount)}</h1>
              <p className="ov-subtitle">{overviewSubtitle(totals, activeNames)}</p>
            </div>
            <ProjectFilter />
            <TabGroup label="group sessions by" className="ov-group-by">
              <Tab selected={groupBy === 'state'} onSelect={() => setGroupBy('state')}>
                By state
              </Tab>
              <Tab selected={groupBy === 'project'} onSelect={() => setGroupBy('project')}>
                By project
              </Tab>
            </TabGroup>
            <Button variant="primary" shortcut="N" title="New session · n" onClick={() => setNewSessionOpen(true)}>
              New task
            </Button>
          </header>

          {groupBy === 'state' ? (
            cards.length === 0 ? (
              <div className="ov-quiet">No session is running or waiting. Idle sessions are in the sidebar.</div>
            ) : (
              <CardGrid cards={cards} derived={derived} projectNameOf={projectNameOf} now={now} onOpen={openSession} />
            )
          ) : (
            groups.map((g) => (
              <ProjectCards
                key={g.projectId ?? '__unlinked__'}
                group={g}
                derived={derived}
                projectNameOf={projectNameOf}
                now={now}
                onOpen={openSession}
              />
            ))
          )}

          {feed.length > 0 && <Trail feed={feed} now={now} onOpen={(id) => openSession(id)} />}
        </div>
      )}
    </div>
  );
}

// ---------- header: project filter ----------

/**
 * "All projects ▾". A FILTER, not a navigation: it re-scopes the dashboard and
 * leaves you on it (setActiveProjectId), unlike the roster's scope chips, which
 * land you inside the project they pick (switchProject, projects FR-39).
 */
function ProjectFilter() {
  const projects = useStore((s) => s.projects);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const setActiveProjectId = useStore((s) => s.setActiveProjectId);
  const setProjectsOpen = useStore((s) => s.setProjectsOpen);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, { onEscape: () => setOpen(false), onOutsideClick: () => setOpen(false), enabled: open });

  const current = projects.find((p) => p.id === activeProjectId);
  const pick = (id: string | null) => {
    setOpen(false);
    setActiveProjectId(id);
  };

  return (
    <div ref={ref} className="ov-filter">
      <button
        type="button"
        className="ov-filter__button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="truncate">{current ? current.name : 'All projects'}</span>
        <Icon name="chevron-down" size={12} />
      </button>
      {open && (
        <div className="ov-filter__menu" role="listbox">
          <FilterRow selected={activeProjectId === null} onClick={() => pick(null)}>
            All projects
          </FilterRow>
          {projects.map((p) => (
            <FilterRow key={p.id} selected={p.id === activeProjectId} onClick={() => pick(p.id)}>
              {p.name}
            </FilterRow>
          ))}
          <div className="ov-filter__rule" />
          <button
            type="button"
            className="ov-filter__row"
            onClick={() => {
              setOpen(false);
              setProjectsOpen(true);
            }}
          >
            Manage projects…
          </button>
        </div>
      )}
    </div>
  );
}

function FilterRow({ selected, onClick, children }: { selected: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      className={selected ? 'ov-filter__row ov-filter__row--on' : 'ov-filter__row'}
      onClick={onClick}
    >
      <span className="truncate">{children}</span>
      {selected && <Icon name="check" size={12} />}
    </button>
  );
}

// ---------- cards ----------

interface GridProps {
  derived: ReadonlyMap<string, SessionDerived>;
  projectNameOf: (s: SessionMeta) => string | null;
  now: number;
  onOpen: (id: string, tab?: 'diff') => void;
}

function CardGrid({ cards, derived, projectNameOf, now, onOpen }: GridProps & { cards: Card[] }) {
  return (
    <div className="ov-grid">
      {cards.map(({ session, kind }) => (
        <OverviewCard
          key={session.id}
          session={session}
          kind={kind}
          derived={derived.get(session.id)}
          projectName={projectNameOf(session)}
          now={now}
          onOpen={(tab) => onOpen(session.id, tab)}
        />
      ))}
    </div>
  );
}

function ProjectCards({ group, ...grid }: GridProps & { group: OverviewGroup }) {
  const cards = rankCards(group.sessions, grid.derived);
  return (
    <section className="ov-project">
      <div className="section-label ov-project__label">
        <span className="truncate">{group.name}</span>
        {!group.rootExists && <span className="ov-project__missing">missing</span>}
        <span className="section-label__count">{group.sessions.length}</span>
      </div>
      {cards.length === 0 ? <div className="ov-quiet">No sessions in this project.</div> : <CardGrid cards={cards} {...grid} />}
    </section>
  );
}

// ---------- activity trail ----------

function Trail({ feed, now, onOpen }: { feed: ActivityEntry[]; now: number; onOpen: (id: string) => void }) {
  return (
    <section className="ov-trail">
      <div className="section-label">{activityHeading(feed.map((e) => e.at), now)}</div>
      {feed.map((e) => {
        const failed = activityTone(e.kind) === 'error';
        return (
          <button
            key={e.id}
            type="button"
            className={failed ? 'ov-event ov-event--failed' : 'ov-event'}
            title={e.detail || undefined}
            onClick={() => onOpen(e.sessionId)}
          >
            <span className="ov-event__time">{activityClock(e.at, now)}</span>
            <span className="ov-event__icon">
              <Icon name={ACTIVITY_ICON[e.kind]} size={14} />
            </span>
            <span className="ov-event__session truncate">{e.sessionName}</span>
            <span className="ov-event__text truncate">
              {ACTIVITY_SENTENCE[e.kind]}
              {e.detail && (
                <>
                  {failed ? ' — ' : ' '}
                  <span className="ov-event__detail">{e.detail}</span>
                </>
              )}
            </span>
          </button>
        );
      })}
    </section>
  );
}

// ---------- empty state ----------

function EmptyState({ onNewSession, onManageProjects }: { onNewSession: () => void; onManageProjects: () => void }) {
  return (
    <div className="ov-empty">
      <h1 className="ov-headline">Nothing running yet</h1>
      <p className="ov-subtitle">Start a session, or register the projects you work in.</p>
      <div className="ov-empty__actions">
        <Button variant="primary" shortcut="N" onClick={onNewSession}>
          New task
        </Button>
        <Button onClick={onManageProjects}>Manage projects</Button>
      </div>
    </div>
  );
}
