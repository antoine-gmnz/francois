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
import { formatGroupSubtitle, totalsSegments, type TotalsSegment } from './overview';

const C = {
  accent: 'var(--accent)',
  dim: 'var(--text-dim)',
  faint: 'var(--text-faint)',
  primary: 'var(--text)',
  bright: 'var(--text-bright)',
  meta: 'var(--text-hint)',
  muted: 'var(--text-muted)',
  error: 'var(--error)',
  success: 'var(--success)',
};

const TONE_COLOR: Record<TotalsSegment['tone'], string> = {
  active: STATUS_COLOR.running,
  ready: C.muted,
  done: STATUS_COLOR.done,
  error: STATUS_COLOR.error,
  neutral: C.meta,
  accent: C.accent,
};

const ACTIVITY_TONE_COLOR: Record<ActivityTone, string> = {
  error: C.error,
  success: C.success,
  active: C.accent,
  neutral: C.faint,
};

function abbreviate(path: string, home: string): string {
  if (!path) return '';
  if (home && (path === home || path.startsWith(home + '/') || path.startsWith(home + '\\'))) {
    return '~' + path.slice(home.length);
  }
  return path;
}

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
    <div className="scz" style={{ flex: 1, overflow: 'auto', minHeight: 0, padding: '14px 16px' }}>
      {nothingAtAll ? (
        <EmptyState onNewSession={() => setNewSessionOpen(true)} onManageProjects={() => setProjectsOpen(true)} />
      ) : (
        <>
          <TotalsStrip segments={segments} totals={totals} scoped={scoped} />

          <div className="ov-split" style={{ marginTop: 16 }}>
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
    <div
      style={{
        display: 'flex',
        alignItems: 'baseline',
        flexWrap: 'wrap',
        gap: '4px 22px',
        padding: '2px 0 14px',
        borderBottom: '1px solid var(--border)',
      }}
    >
      <span style={{ fontSize: 11, letterSpacing: '0.14em', fontWeight: 700, color: C.accent, marginRight: 4 }}>
        {scoped ? 'PROJECT' : 'FLEET'}
      </span>
      <Figure value={totals.sessions} label={totals.sessions === 1 ? 'session' : 'sessions'} color={C.bright} />
      {!scoped && (
        <Figure
          value={totals.activeProjects}
          label={totals.activeProjects === 1 ? 'project' : 'projects'}
          color={C.bright}
        />
      )}
      {segments.length > 0 && <span style={{ color: 'var(--text-disabled)', fontSize: 11 }}>│</span>}
      {segments.map((s) => (
        <Figure key={s.label} value={s.value} label={s.label} color={TONE_COLOR[s.tone]} />
      ))}
      {/* An entirely quiet fleet says so, rather than leaving a bare count row. */}
      {segments.length === 0 && totals.sessions > 0 && (
        <span style={{ fontSize: 11, color: C.faint }}>all quiet</span>
      )}
    </div>
  );
}

function Figure({ value, label, color }: { value: number; label: string; color: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 5 }}>
      <span style={{ fontSize: 17, fontWeight: 500, color, lineHeight: 1 }}>{value}</span>
      <span style={{ fontSize: 10.5, color: C.faint }}>{label}</span>
    </span>
  );
}

// ---------- section shell ----------

function Section({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 10, letterSpacing: '0.14em', fontWeight: 700, color: C.dim }}>{title}</span>
        {count != null && <span style={{ fontSize: 10, color: C.faint }}>{count}</span>}
      </div>
      {children}
    </div>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 11, color: C.faint, padding: '4px 0' }}>{children}</div>;
}

// ---------- needs attention ----------

function AttentionRow({ item, onClick }: { item: AttentionItem; onClick: () => void }) {
  const [hover, setHover] = useState(false);
  const isError = item.reason === 'error';
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={item.detail}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        padding: '7px 9px',
        marginBottom: 3,
        borderRadius: 4,
        cursor: 'pointer',
        background: hover ? 'var(--bg-elevated)' : 'transparent',
        // A red rail on the errors keeps the two reasons distinguishable at a
        // glance without a second colour for the merely-dirty ones.
        borderLeft: `2px solid ${isError ? C.error : 'var(--text-disabled)'}`,
      }}
    >
      <span style={{ fontSize: 11.5, color: C.primary, flexShrink: 0, maxWidth: '38%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {item.session.name}
      </span>
      <span
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: 10.5,
          color: isError ? C.error : C.meta,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {item.detail}
      </span>
      <span style={{ flexShrink: 0, fontSize: 10, color: C.faint }}>
        {formatRelativeTime(item.session.lastActivityAt)}
      </span>
    </div>
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
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 9, padding: '0 0 5px' }}>
        <span style={{ fontSize: 12, fontWeight: 500, color: group.sessions.length > 0 ? C.bright : C.muted }}>
          {group.name}
        </span>
        {!group.rootExists && <span style={{ fontSize: 9, color: C.error }}>missing</span>}
        {group.root && (
          <span
            style={{
              fontSize: 10, color: C.faint, flex: 1, minWidth: 0,
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }}
          >
            {abbreviate(group.root, home)}
          </span>
        )}
        <span style={{ flexShrink: 0, fontSize: 10, color: C.faint }}>{formatGroupSubtitle(group)}</span>
      </div>
      {group.sessions.length === 0 ? (
        <div style={{ fontSize: 10.5, color: 'var(--text-disabled)', padding: '3px 0 3px 10px' }}>—</div>
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
  const sc = STATUS_COLOR[s.status] ?? C.dim;

  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={s.status === 'error' ? s.errorMessage : displayWslCwd(s.cwd) ?? s.cwd}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        padding: '6px 9px',
        marginBottom: 2,
        borderRadius: 4,
        cursor: 'pointer',
        background: selected ? 'var(--bg-raised)' : hover ? 'var(--bg-elevated)' : 'transparent',
      }}
    >
      <span
        style={{
          width: 7, height: 7, borderRadius: '50%', flexShrink: 0, background: sc,
          animation: statusPulses(s.status) ? 'pulse 1.4s ease-in-out infinite' : 'none',
        }}
      />
      <span
        style={{
          flex: '1 1 auto', minWidth: 0, fontSize: 11.5,
          color: selected ? C.bright : C.primary,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}
      >
        {s.name}
      </span>
      {/* §8: every trailing cell is right-aligned so the rollup reads as a table. */}
      <span style={{ flexShrink: 0, fontSize: 10, color: sc, width: 44, textAlign: 'right' }}>
        {STATUS_LABEL[s.status] ?? s.status}
      </span>
      <span
        style={{
          flexShrink: 0,
          fontSize: 10,
          color: C.faint,
          width: 62,
          textAlign: 'right',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {s.model.label}
      </span>
      <span style={{ flexShrink: 0, fontSize: 10, width: 62, textAlign: 'right' }}>
        <span style={{ color: C.faint }}>ctx </span>
        <span style={{ color: C.meta }}>{formatContextTokens(s.contextUsedTokens)}</span>
      </span>
      {/* The last two cells are fixed-width so the columns line up down the whole
          rollup even when most rows have neither a diff nor an agent. */}
      <span style={{ flexShrink: 0, fontSize: 10, width: 34, textAlign: 'right', color: C.meta }}>
        {files != null && files > 0 ? `≡ ${files}` : ''}
      </span>
      <span style={{ flexShrink: 0, fontSize: 10, width: 30, textAlign: 'right', color: C.accent }}>
        {agents > 0 ? `⇉ ${agents}` : ''}
      </span>
      <span style={{ flexShrink: 0, fontSize: 10, color: C.faint, width: 30, textAlign: 'right' }}>
        {formatRelativeTime(s.lastActivityAt)}
      </span>
    </div>
  );
}

// ---------- activity feed ----------

function ActivityRow({ entry, onClick }: { entry: ActivityEntry; onClick: () => void }) {
  const [hover, setHover] = useState(false);
  const tone = ACTIVITY_TONE_COLOR[activityTone(entry.kind)];
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={entry.detail || undefined}
      style={{
        display: 'flex',
        alignItems: 'baseline',
        gap: 7,
        padding: '4px 6px',
        borderRadius: 3,
        cursor: 'pointer',
        background: hover ? 'var(--bg-elevated)' : 'transparent',
      }}
    >
      <span style={{ flexShrink: 0, fontSize: 9.5, color: C.faint, width: 26 }}>
        {formatRelativeTime(entry.at)}
      </span>
      <span
        style={{
          flex: 1, minWidth: 0, fontSize: 10.5, color: C.dim,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}
      >
        <span style={{ color: C.primary }}>{entry.sessionName}</span>{' '}
        <span style={{ color: tone }}>{ACTIVITY_LABEL[entry.kind]}</span>
        {entry.detail && <span style={{ color: C.faint }}> · {entry.detail}</span>}
      </span>
    </div>
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
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
        color: C.faint,
        fontSize: 12.5,
      }}
    >
      <div>nothing running yet</div>
      <div style={{ display: 'flex', gap: 16, fontSize: 11 }}>
        <span onClick={onNewSession} style={{ cursor: 'pointer', color: C.dim }}>
          <span style={{ color: C.accent }}>n</span> new session
        </span>
        <span onClick={onManageProjects} style={{ cursor: 'pointer', color: C.dim }}>
          <span style={{ color: C.accent }}>⊟</span> manage projects
        </span>
      </div>
    </div>
  );
}
