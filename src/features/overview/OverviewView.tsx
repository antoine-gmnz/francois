// overview — the OVERVIEW main tab: a cross-project dashboard of what is
// happening everywhere, shown instead of the last-selected session's transcript
// when the board is scoped to "All projects".
//
// It owns NO subscription and NO IPC call. Everything it renders is already in
// the store: the session cache, the fleet board's per-session derived figures,
// the project registry, and the activity ring buffer — all written by the ONE
// session/diff event subscription pane [1] owns. The tab is therefore free to
// mount and unmount without disturbing a thing.

import { useEffect, useMemo, useState } from 'react';
import type { SessionMeta } from '../../../contract/common';
import {
  STATUS_COLOR,
  STATUS_LABEL,
  formatRelativeTime,
  statusPulses,
  type SessionDerived,
} from '../../../contract/fleet-board';
import { formatContextTokens } from '../../../contract/conversation-view';
import { displayWslCwd } from '../../../contract/wsl-filesystem';
import {
  ACTIVITY_LABEL,
  activityTone,
  computeFleetTotals,
  filterActivityByProject,
  groupSessionsByProject,
  needsAttention,
  type ActivityEntry,
  type ActivityTone,
  type AttentionItem,
  type DerivedMap,
  type OverviewGroup,
} from '../../../contract/overview';
import { useStore } from '../../lib/store';
import { abbreviate } from '../../lib/path';
import { toneVar } from '../../lib/tone';
import { ListRow } from '../../ui/ListRow';
import { StatusDot } from '../../ui/StatusDot';
import { formatGroupSubtitle, totalsSegments, type TotalsSegment } from './overview';
import './overview.css';

// toneVar on every STATUS_COLOR read: the contract map is the DARK palette, and
// these tones sit beside literal tokens in the same record (lib/tone.ts).
const TONE_COLOR: Record<TotalsSegment['tone'], string> = {
  active: toneVar(STATUS_COLOR.running),
  blocked: toneVar(STATUS_COLOR.awaiting_approval),
  ready: 'var(--text-muted)',
  done: toneVar(STATUS_COLOR.done),
  error: toneVar(STATUS_COLOR.error),
  neutral: 'var(--text-hint)',
  accent: 'var(--accent)',
};

const ACTIVITY_TONE_COLOR: Record<ActivityTone, string> = {
  error: 'var(--error)',
  success: 'var(--success)',
  active: 'var(--accent)',
  neutral: 'var(--text-faint)',
};

export default function OverviewView({ home }: { home: string }) {
  const sessions = useStore((s) => s.sessions);
  const projects = useStore((s) => s.projects);
  const derived = useStore((s) => s.derived);
  const activity = useStore((s) => s.activity);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const activeSessionId = useStore((s) => s.activeSessionId);
  const setActiveSessionId = useStore((s) => s.setActiveSessionId);
  const setMainTab = useStore((s) => s.setMainTab);
  const setFocusedPane = useStore((s) => s.setFocusedPane);
  const setNewSessionOpen = useStore((s) => s.setNewSessionOpen);
  const setProjectsOpen = useStore((s) => s.setProjectsOpen);

  // Relative times ('2m', '3h') must age without an event, exactly as the fleet
  // board's cards do (fleet-board FR-25).
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => (t + 1) % 1_000_000), 30_000);
    return () => clearInterval(id);
  }, []);

  const groups = useMemo(
    () => groupSessionsByProject(sessions, projects, activeProjectId),
    [sessions, projects, activeProjectId],
  );
  const totals = useMemo(() => computeFleetTotals(groups, derived), [groups, derived]);
  const attention = useMemo(() => needsAttention(groups, derived), [groups, derived]);
  const feed = useMemo(() => filterActivityByProject(activity, activeProjectId), [activity, activeProjectId]);
  const segments = totalsSegments(totals);

  // Drilling in from the dashboard: select the session AND leave the tab, which
  // is the whole point of a row being clickable here.
  const openSession = (id: string) => {
    setActiveSessionId(id);
    setMainTab('session');
    setFocusedPane('main');
  };

  const scoped = activeProjectId !== null;
  const nothingAtAll = sessions.length === 0 && projects.length === 0;

  return (
    <div className="scz ov-root">
      {nothingAtAll ? (
        <EmptyState onNewSession={() => setNewSessionOpen(true)} onManageProjects={() => setProjectsOpen(true)} />
      ) : (
        <>
          <TotalsStrip segments={segments} totals={totals} scoped={scoped} />

          <div className="ov-split ov-content-gap">
            <div className="ov-main">
              {attention.length > 0 && (
                <Section title="NEEDS ATTENTION" count={attention.length}>
                  {attention.map((item) => (
                    <AttentionRow key={item.session.id} item={item} onClick={() => openSession(item.session.id)} />
                  ))}
                </Section>
              )}

              <Section title={scoped ? 'PROJECT' : 'PROJECTS'} count={groups.length}>
                {groups.length === 0 ? (
                  <Muted>no projects yet · ⌘K → manage projects</Muted>
                ) : (
                  groups.map((g) => (
                    <ProjectGroup
                      key={g.projectId ?? '__unlinked__'}
                      group={g}
                      home={home}
                      derived={derived}
                      activeSessionId={activeSessionId}
                      onOpen={openSession}
                    />
                  ))
                )}
              </Section>
            </div>

            <div className="ov-rail">
              <Section title="RECENT ACTIVITY" count={feed.length || undefined}>
                {feed.length === 0 ? (
                  <Muted>nothing yet this session</Muted>
                ) : (
                  feed.slice(0, 40).map((e) => (
                    <ActivityRow key={e.id} entry={e} onClick={() => openSession(e.sessionId)} />
                  ))
                )}
              </Section>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ---------- totals strip ----------

function TotalsStrip({
  segments,
  totals,
  scoped,
}: {
  segments: TotalsSegment[];
  totals: ReturnType<typeof computeFleetTotals>;
  scoped: boolean;
}) {
  return (
    <div className="ov-totals-strip">
      <span className="ov-totals-label">{scoped ? 'PROJECT' : 'FLEET'}</span>
      <Figure
        value={totals.sessions}
        label={totals.sessions === 1 ? 'session' : 'sessions'}
        color="var(--text-bright)"
      />
      {!scoped && (
        <Figure
          value={totals.activeProjects}
          label={totals.activeProjects === 1 ? 'project' : 'projects'}
          color="var(--text-bright)"
        />
      )}
      {segments.length > 0 && <span className="ov-totals-divider">│</span>}
      {segments.map((s) => (
        <Figure key={s.label} value={s.value} label={s.label} color={TONE_COLOR[s.tone]} />
      ))}
      {/* An entirely quiet fleet says so, rather than leaving a bare count row. */}
      {segments.length === 0 && totals.sessions > 0 && <span className="ov-totals-quiet">all quiet</span>}
    </div>
  );
}

function Figure({ value, label, color }: { value: number; label: string; color: string }) {
  return (
    <span className="ov-figure">
      <span className="ov-figure-value" style={{ color }}>
        {value}
      </span>
      <span className="ov-figure-label">{label}</span>
    </span>
  );
}

// ---------- section shell ----------

function Section({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  return (
    <div className="ov-section">
      <div className="ov-section-header">
        <span className="ov-section-title">{title}</span>
        {count != null && <span className="ov-section-count">{count}</span>}
      </div>
      {children}
    </div>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <div className="ov-muted">{children}</div>;
}

// ---------- needs attention ----------

/**
 * The rail + detail colour per reason. Parked sessions borrow the status colours
 * so a row here and that session's sidebar card read as the same thing; errors
 * keep red; a merely-dirty session stays neutral so it cannot shout over the two
 * bands above it.
 */
const ATTENTION_COLOR: Record<AttentionItem['reason'], string> = {
  approval: toneVar(STATUS_COLOR.awaiting_approval),
  question: toneVar(STATUS_COLOR.awaiting_input),
  error: 'var(--error)',
  uncommitted: 'var(--text-disabled)',
};

function AttentionRow({ item, onClick }: { item: AttentionItem; onClick: () => void }) {
  const [hover, setHover] = useState(false);
  const color = ATTENTION_COLOR[item.reason];
  return (
    <ListRow
      hovered={hover}
      className="ov-attention-row"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={item.detail}
      // A coloured rail keeps the reasons distinguishable at a glance, in the
      // same order needsAttention already sorted them.
      style={{ borderLeft: `2px solid ${color}` }}
    >
      <span className="ov-attention-name truncate">{item.session.name}</span>
      <span
        className="ov-attention-detail truncate"
        style={{ color: item.reason === 'uncommitted' ? 'var(--text-hint)' : color }}
      >
        {item.detail}
      </span>
      <span className="ov-attention-time">{formatRelativeTime(item.session.lastActivityAt)}</span>
    </ListRow>
  );
}

// ---------- project rollup ----------

function ProjectGroup({
  group,
  home,
  derived,
  activeSessionId,
  onOpen,
}: {
  group: OverviewGroup;
  home: string;
  derived: DerivedMap;
  activeSessionId: string | null;
  onOpen: (id: string) => void;
}) {
  return (
    <div className="ov-group">
      <div className="ov-group-header">
        <span
          className="ov-group-name"
          style={{ color: group.sessions.length > 0 ? 'var(--text-bright)' : 'var(--text-muted)' }}
        >
          {group.name}
        </span>
        {!group.rootExists && <span className="ov-group-missing">missing</span>}
        {group.root && <span className="ov-group-root truncate">{abbreviate(group.root, home)}</span>}
        <span className="ov-group-subtitle">{formatGroupSubtitle(group)}</span>
      </div>
      {group.sessions.length === 0 ? (
        <div className="ov-group-empty">—</div>
      ) : (
        group.sessions.map((s) => (
          <SessionRow
            key={s.id}
            s={s}
            d={derived.get(s.id)}
            selected={s.id === activeSessionId}
            onClick={() => onOpen(s.id)}
          />
        ))
      )}
    </div>
  );
}

function SessionRow({
  s,
  d,
  selected,
  onClick,
}: {
  s: SessionMeta;
  d: SessionDerived | undefined;
  selected: boolean;
  onClick: () => void;
}) {
  const [hover, setHover] = useState(false);
  const files = d?.fileCount ?? null;
  const agents = d?.runningAgentCount ?? 0;
  const sc = toneVar(STATUS_COLOR[s.status] ?? 'var(--text-dim)');

  return (
    <ListRow
      selected={selected}
      hovered={hover}
      className="ov-session-row"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={s.status === 'error' ? s.errorMessage : displayWslCwd(s.cwd) ?? s.cwd}
    >
      <StatusDot color={sc} size={7} pulsing={statusPulses(s.status)} />
      <span className="ov-session-name truncate" style={{ color: selected ? 'var(--text-bright)' : 'var(--text)' }}>
        {s.name}
      </span>
      {/* §8: every trailing cell is right-aligned so the rollup reads as a table. */}
      <span className="ov-session-status" style={{ color: sc }}>
        {STATUS_LABEL[s.status] ?? s.status}
      </span>
      <span className="ov-session-model truncate">{s.model.label}</span>
      <span className="ov-session-ctx">
        <span className="ov-session-ctx-label">ctx </span>
        <span className="ov-session-ctx-value">{formatContextTokens(s.contextUsedTokens)}</span>
      </span>
      {/* The last two cells are fixed-width so the columns line up down the whole
          rollup even when most rows have neither a diff nor an agent. */}
      <span className="ov-session-files">{files != null && files > 0 ? `≡ ${files}` : ''}</span>
      <span className="ov-session-agents">{agents > 0 ? `⇉ ${agents}` : ''}</span>
      <span className="ov-session-time">{formatRelativeTime(s.lastActivityAt)}</span>
    </ListRow>
  );
}

// ---------- activity feed ----------

function ActivityRow({ entry, onClick }: { entry: ActivityEntry; onClick: () => void }) {
  const [hover, setHover] = useState(false);
  const tone = ACTIVITY_TONE_COLOR[activityTone(entry.kind)];
  return (
    <ListRow
      hovered={hover}
      className="ov-activity-row"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={entry.detail || undefined}
    >
      <span className="ov-activity-time">{formatRelativeTime(entry.at)}</span>
      <span className="ov-activity-text truncate">
        <span className="ov-activity-session">{entry.sessionName}</span>{' '}
        <span style={{ color: tone }}>{ACTIVITY_LABEL[entry.kind]}</span>
        {entry.detail && <span className="ov-activity-detail"> · {entry.detail}</span>}
      </span>
    </ListRow>
  );
}

// ---------- empty state ----------

function EmptyState({
  onNewSession,
  onManageProjects,
}: {
  onNewSession: () => void;
  onManageProjects: () => void;
}) {
  return (
    <div className="ov-empty">
      <div>nothing running yet</div>
      <div className="ov-empty-actions">
        <span onClick={onNewSession} className="ov-empty-action">
          <span className="ov-empty-action-key">n</span> new session
        </span>
        <span onClick={onManageProjects} className="ov-empty-action">
          <span className="ov-empty-action-key">⊟</span> manage projects
        </span>
      </div>
    </div>
  );
}
