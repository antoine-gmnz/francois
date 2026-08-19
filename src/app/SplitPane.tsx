import { Maximize2, Plus, Terminal as TerminalIcon, X } from 'lucide-react';
import { useState } from 'react';
import type { ProjectId, SessionId } from '../../contract/common';
import type { ShellId } from '../../contract/shell-terminal';
import { formatContextTokens } from '../../contract/conversation-view';
import { isBusyStatus, STATUS_COLOR, STATUS_LABEL, statusPulses } from '../../contract/fleet-board';
import AgentView from '../features/agents/AgentView';
import { agentIdFromTab, tabIdFor, tabsForSession, workflowIdFromTab } from '../features/agents/agent-tab';
import ConversationView from '../features/conversation/ConversationView';
import DiffView from '../features/diff/DiffView';
import ProjectPickerPopover from '../features/projects/ProjectPickerPopover';
import { projectMarker } from '../features/projects/projectMarker';
import WorkflowView from '../features/workflows/WorkflowView';
import { shellPaneEligibleProjects, type PaneSlot, type PaneTab } from '../lib/layoutStore';
import { useStore } from '../lib/store';
import { toneVar } from '../lib/tone';
import { BadgePill } from '../ui/BadgePill';
import { StatusDot } from '../ui/StatusDot';
import AgentTabChip from './AgentTabChip';
import EmptyPaneMessage from './EmptyPaneMessage';
import PaneHeaderMenu from './PaneHeaderMenu';
import ProjectShellPane from './ProjectShellPane';
import ShellTabView from './ShellTabView';

export interface SplitPaneProps {
  /** 0-based. Rendered 1-based in the grid chrome (FR-7) and named by ⌘<n>. */
  index: number;
  /** unbound-panes FR-4/§5: the pane's whole content, in place of sessionId/tab. */
  slot: PaneSlot;
  focused: boolean;
  /**
   * split-by-4 FR-9: the turn-5d chrome. At three panes and up a pane is ONE
   * surface — no tab strip, transcript only — and its footer carries the state
   * instead of a composer.
   */
  dense: boolean;
  home: string;
  onFocus: () => void;
  onTab: (tab: PaneTab) => void;
  /** ⤢ — FR-16: leave split, promoting this pane to the single main pane. */
  onPromote: () => void;
  /** ✕ — FR-17: drop this pane; the grid compacts. Absent ⇒ not closable. */
  onClose?: () => void;
  /** FR-11: promote this pane onto DIFF. Only offered on a settled pane. */
  onReviewDiff?: () => void;
  /** unbound-panes FR-9: turn THIS pane into a shell pane rooted at `projectId`. */
  onConvertToShell?: (projectId: ProjectId) => void;
  /** unbound-panes FR-7: record the shell spawned for THIS pane, in memory only. */
  onShellSpawned?: (shellId: ShellId) => void;
  /**
   * Explicit grid placement. The resizable grid interleaves gutter tracks with
   * the pane tracks, which defeats auto-placement above two panes — see
   * `paneGridArea`. Absent ⇒ the grid places this pane itself.
   */
  area?: { gridColumn: string; gridRow: string };
}

const TABS: readonly { id: PaneTab; label: string }[] = [
  { id: 'session', label: 'Session' },
  { id: 'diff', label: 'Diff' },
  { id: 'shell', label: 'Shell' },
];

/**
 * split-by-4 FR-7..FR-11 / unbound-panes FR-6 — one main pane. A `session`
 * slot keeps split-by-4's own header (index, status dot, name, `focus` chip or
 * status label, context tokens, ⤢ and ✕) plus either the turn-5b Session/Diff/
 * Shell strip (`dense: false`) or the turn-5d single surface (`dense: true`).
 * A `shell` slot (unbound-panes FR-6) renders a DIFFERENT header — terminal
 * glyph, project marker, project name, ✕ only, no `⤢`, no tab strip in either
 * regime — and `ProjectShellPane`'s body.
 *
 * Deliberately NOT `MainTabStrip` + `MainPaneBody`: a pane carries a *sub*-level
 * strip (sentence-case text tabs, no segmented track) and only the three tabs
 * FR-20 allows, so reusing the shell's own strip would read as two competing
 * top-level chromes.
 */
export default function SplitPane(props: SplitPaneProps) {
  // The two slot kinds are two DIFFERENT components, never two branches of one:
  // each calls its own hooks, and a pane that flips kind (convert to shell, or
  // pane 0's promotion) must unmount one and mount the other. Branching inside a
  // single component would change the hook count between renders.
  const { slot } = props;
  if (slot.kind === 'shell') {
    return (
      <ShellPaneSection
        index={props.index}
        projectId={slot.projectId}
        shellId={slot.shellId}
        focused={props.focused}
        home={props.home}
        onFocus={props.onFocus}
        onClose={props.onClose}
        onShellSpawned={props.onShellSpawned}
        area={props.area}
      />
    );
  }
  return <SessionPaneSection {...props} slot={slot} />;
}

function SessionPaneSection({
  index,
  slot,
  focused,
  dense,
  home,
  onFocus,
  onTab,
  onPromote,
  onClose,
  onReviewDiff,
  onConvertToShell,
  onShellSpawned: _onShellSpawned,
  area,
}: Omit<SplitPaneProps, 'slot'> & { slot: Extract<PaneSlot, { kind: 'session' }> }) {
  const sessionId = slot.sessionId;
  const tab = slot.tab;
  const session = useStore((s) => s.sessions.find((x) => x.id === sessionId) ?? null);
  const project = useStore((s) => (session?.projectId ? s.projects.find((p) => p.id === session.projectId) : undefined));
  // The per-session diff file count fleet-board already keeps for EVERY session
  // (seeded once, then diff.changed) — the same number MainTabStrip shows, with
  // no second subscription per pane.
  const diffCount = useStore((s) => (sessionId ? (s.derived.get(sessionId)?.fileCount ?? 0) : 0));
  // fix-agent-view FR-12: THIS pane's session's dynamic tabs. `tabsForSession`
  // hands back a shared empty array for a tab-less session, so the selector is
  // referentially stable and another session's `agent.update` never re-renders
  // this pane.
  const agentTabs = useStore((s) => tabsForSession(s.agentTabs, sessionId));
  const closeAgentTab = useStore((s) => s.closeAgentTab);
  // Which dynamic body this pane shows, if any — read straight off the tab id,
  // exactly as MainPaneBody does for the single pane, so the two cannot drift.
  const agentId = agentIdFromTab(tab);
  const runId = workflowIdFromTab(tab);

  // toneVar: STATUS_COLOR is the contract's DARK hex map — the `active` tag would
  // otherwise stay acid lime on the light theme's white header (lib/tone.ts).
  const statusColor = toneVar(session ? (STATUS_COLOR[session.status] ?? 'var(--text-dim)') : 'var(--text-dim)');
  // FR-11: "finished" is the footer state that offers a diff and a close — a
  // session with no turn in flight. isBusyStatus covers the two parked states
  // too, so a pane waiting on an approval keeps the `⌘<n> to focus` hint.
  const settled = !!session && !isBusyStatus(session.status);

  return (
    <section
      onClick={onFocus}
      style={area}
      // No `split-pane--focused`: a pane looks the same focused or not, so there
      // is nothing for the modifier to select. The focus chip in the header is
      // the signal; `focused` still drives BEHAVIOUR below (who owns the
      // keyboard, FR-12) — just not appearance.
      className={['split-pane', dense ? 'split-pane--dense' : null].filter(Boolean).join(' ')}
      data-pane={index}
    >
      {/* header */}
      <div className="split-pane__header">
        {/* FR-7: the pane number, so `⌘<n>` in the footer and the status bar has
            something on screen to point at. Only in the grid — at two panes the
            positions themselves are the names (left / right). */}
        {dense && <span className="split-pane__index">{index + 1}</span>}
        <StatusDot color={statusColor} size={6} pulsing={!!session && statusPulses(session.status)} />
        {/* unbound-panes FR-14: the neutral project marker, immediately left of
            the session name — `‹repo› name`. Never accent. */}
        {project && (
          <span className="split-pane__marker" title={project.name}>
            {projectMarker(project.name)}
          </span>
        )}
        <span className="split-pane__name truncate" title={session?.name}>
          {session?.name ?? 'no session'}
        </span>
        {focused ? (
          // The ONLY thing in a pane that changes with focus. Everything else —
          // header surface, name weight, tab strip, composer — is now identical
          // in both states, so this chip is not competing with four other cues
          // for one bit. It says it in TEXT as well as colour, which matters
          // more than ever now that it is alone (design §Accessibility).
          <span className="split-pane__focus-chip">focus</span>
        ) : (
          session && (
            <span className="split-pane__status" style={{ color: statusColor }}>
              {STATUS_LABEL[session.status] ?? session.status}
            </span>
          )
        )}
        <span className="app-flex-spacer" />
        {session && <span className="split-pane__ctx">{formatContextTokens(session.contextUsedTokens)}</span>}
        {/* stopPropagation on both: the pane's own click handler would otherwise
            re-focus this pane AFTER the action has already moved focus. */}
        {/* An EMPTY grid pane has no footer to carry `close pane ✕` (that lives
            in the transcript's composer slot), so its close sits here — a pane
            you opened by mistake must be closable without leaving the grid. */}
        {dense && !session && onClose && (
          <button
            type="button"
            className="split-pane__promote"
            title="Close this pane"
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
          >
            <X size={12} strokeWidth={1.75} />
          </button>
        )}
        {/* unbound-panes FR-9 / design brief flow 4 — the `⋯` menu. Before ⤢
            so the two irreversible-ish actions (promote, close) stay rightmost. */}
        <PaneHeaderMenu index={index} kind="session" onConvertToShell={onConvertToShell} />
        <button
          type="button"
          className="split-pane__promote"
          title="Expand to full width"
          onClick={(e) => {
            e.stopPropagation();
            onPromote();
          }}
        >
          <Maximize2 size={12} strokeWidth={1.75} />
        </button>
      </div>

      {/* tab strip — a SUB level: sentence-case, no track, no accent underline.
          FR-9: the grid chrome has none; a pane there is one surface. */}
      {!dense && (
        <div className="scz split-pane__tabs">
          {TABS.map((t) => (
            <span
              key={t.id}
              onClick={() => onTab(t.id)}
              className={t.id === tab ? 'split-tab split-tab--on' : 'split-tab'}
            >
              {t.label}
              {/* FR-8: the same count, scoped to THIS pane's session — and read
                  the same either way: uncommitted files do not become less true
                  because you are looking at the other pane. */}
              {t.id === 'diff' && diffCount > 0 && <BadgePill>{diffCount}</BadgePill>}
            </span>
          ))}
          {/* fix-agent-view FR-12: THIS pane's session's agent and workflow
              tabs, after Shell and behind a divider — content, following
              chrome. Only in the two-pane regime: `dense` has no strip at all
              (FR-13), which is why `openAgentTab` refuses to open one there. */}
          {agentTabs.length > 0 && <span className="split-tab-divider" />}
          {agentTabs.map((t) => (
            <AgentTabChip
              key={tabIdFor(t)}
              tab={t}
              active={tabIdFor(t) === tab}
              onOpen={() => onTab(tabIdFor(t) as PaneTab)}
              onClose={() => closeAgentTab(t.id)}
            />
          ))}
        </div>
      )}

      {/* body */}
      <div className="split-pane__body">
        {!session ? (
          <EmptyPaneBody index={index} onConvertToShell={onConvertToShell} />
        ) : agentId !== null ? (
          // fix-agent-view FR-16: the SAME AgentView the single pane renders,
          // keyed by agent so switching tabs remounts rather than leaking the
          // previous transcript. FR-17: "Back to session" returns THIS pane.
          // Unreachable while `dense` — paneTabAt flattens a dynamic tab there.
          <AgentView key={agentId} agentId={agentId} sessionId={session.id} onBack={() => onTab('session')} />
        ) : runId !== null ? (
          <WorkflowView key={runId} runId={runId} sessionId={session.id} />
        ) : dense || tab === 'session' ? (
          <ConversationView
            key={session.id}
            sessionId={session.id}
            inert={!focused}
            onFocusRequest={onFocus}
            inertFooter={
              dense ? (
                <PaneFooter
                  index={index}
                  settled={settled}
                  diffCount={diffCount}
                  onFocus={onFocus}
                  onReviewDiff={onReviewDiff}
                  onClose={onClose}
                />
              ) : undefined
            }
          />
        ) : tab === 'diff' ? (
          <DiffView key={session.id} sessionId={session.id} />
        ) : (
          // FR-12: the keyboard belongs to ONE pane at a time — the focused one.
          // Otherwise ⌘T opens a shell in both sessions at once, and the
          // unfocused pane's terminal grabs the caret at mount, landing
          // keystrokes in the wrong session's PTY.
          <ShellTabView key={session.id} sessionId={session.id} home={home} paneFocused={focused} />
        )}
      </div>
    </section>
  );
}

/**
 * FR-15 — a session pane with no session yet. unbound-panes FR-9: now a
 * TWO-choice affordance — pick a session on the left, or open a shell here —
 * rather than the single "New session" prompt.
 */
function EmptyPaneBody({
  index,
  onConvertToShell,
}: {
  index: number;
  onConvertToShell?: (projectId: ProjectId) => void;
}) {
  const setNewSessionOpen = useStore((s) => s.setNewSessionOpen);
  const [picking, setPicking] = useState(false);
  const allProjects = useStore((s) => s.projects);
  const extraPanes = useStore((s) => s.extraPanes);
  // Derived in render, never inside the selector: zustand v5 compares the
  // selector result by reference, and `.filter` hands back a fresh array on
  // every call — which is an infinite re-render, not a stale read.
  const projects = shellPaneEligibleProjects(allProjects, extraPanes);

  return (
    <EmptyPaneMessage>
      {/* `.empty-pane` centers a single ROW; this stacks inside it. */}
      <div className="split-pane__empty">
        pane {index + 1} is empty
        <div className="split-pane__empty-hint">start a new session, or</div>
        <div className="split-pane__empty-choices">
          {/* Deliberately NOT stopPropagation, unlike ⤢/✕/Review diff: the click
              must also reach the pane's own handler so this pane takes focus,
              which is what routes the created session here (App's onCreated →
              FR-19). */}
          {/* Labeled for what the click actually does — opens the NEW session
              modal, not a picker over existing sessions (no such picker
              exists; fix loop round 4). */}
          <button type="button" className="split-pane__empty-choice" onClick={() => setNewSessionOpen(true)}>
            <Plus size={12} strokeWidth={2} />
            New session
          </button>
          {/* FR-8: pane 0 is always a session pane — `convertPaneToShell` is a
              no-op there, mirroring `paneMenuEntries`'s own index-0 exclusion. */}
          {index !== 0 && onConvertToShell && (
            <span className="split-pane__empty-choice-anchor">
              <button
                type="button"
                className="split-pane__empty-choice"
                onClick={(e) => {
                  e.stopPropagation();
                  if (projects.length === 1) onConvertToShell(projects[0].id);
                  else setPicking(true);
                }}
              >
                <TerminalIcon size={12} strokeWidth={2} />
                Open a shell here
              </button>
              {picking && (
                <ProjectPickerPopover
                  onPick={(projectId) => onConvertToShell(projectId)}
                  onClose={() => setPicking(false)}
                />
              )}
            </span>
          )}
        </div>
      </div>
    </EmptyPaneMessage>
  );
}

/**
 * FR-11 — the grid chrome's footer on an UNFOCUSED pane. One composer on screen,
 * so a keystroke is never ambiguous (design §Notes): a settled pane offers its
 * diff and a close, everything else says which key focuses it.
 */
function PaneFooter({
  index,
  settled,
  diffCount,
  onFocus,
  onReviewDiff,
  onClose,
}: {
  index: number;
  settled: boolean;
  diffCount: number;
  onFocus: () => void;
  onReviewDiff?: () => void;
  onClose?: () => void;
}) {
  const stop = (fn?: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    fn?.();
  };
  return (
    <div className="pane-footer" onClick={onFocus}>
      {settled && onReviewDiff ? (
        <button type="button" className="pane-footer__diff" onClick={stop(onReviewDiff)}>
          Review diff
          {diffCount > 0 && <BadgePill>{diffCount}</BadgePill>}
        </button>
      ) : (
        <>
          <span className="pane-footer__arrow">›</span>
          <span className="pane-footer__hint">
            <span className="app-key">⌘{index + 1}</span> to focus and type
          </span>
        </>
      )}
      <span className="app-flex-spacer" />
      {onClose && (
        <button type="button" className="pane-footer__close" title="Close this pane" onClick={stop(onClose)}>
          close pane <X size={11} strokeWidth={2} />
        </button>
      )}
    </div>
  );
}

/**
 * unbound-panes FR-6/FR-11 — a `kind: 'shell'` pane's whole chrome: header
 * (index, terminal glyph, project marker, project name, ✕ — no `⤢`, no status
 * dot, no context tokens, no tab strip in either regime) plus `ProjectShellPane`'s
 * body. Rendered identically in `split` and `grid`.
 */
function ShellPaneSection({
  index,
  projectId,
  shellId,
  focused,
  home,
  onFocus,
  onClose,
  onShellSpawned,
  area,
}: {
  index: number;
  projectId: ProjectId;
  shellId: ShellId | null;
  focused: boolean;
  home: string;
  onFocus: () => void;
  onClose?: () => void;
  onShellSpawned?: (shellId: ShellId) => void;
  area?: { gridColumn: string; gridRow: string };
}) {
  const project = useStore((s) => s.projects.find((p) => p.id === projectId));

  return (
    <section
      onClick={onFocus}
      style={area}
      className="split-pane"
      data-pane={index}
    >
      <div className="split-pane__header">
        {/* dense/split share the same header for a shell pane — no dense-only branch. */}
        <span className="split-pane__index">{index + 1}</span>
        <TerminalIcon size={12} strokeWidth={1.75} className="split-pane__shell-glyph" />
        {project && (
          <span className="split-pane__marker" title={project.name}>
            {projectMarker(project.name)}
          </span>
        )}
        <span className="split-pane__name truncate" title={project?.name}>
          {project?.name ?? 'shell'}
        </span>
        {focused && <span className="split-pane__focus-chip">focus</span>}
        <span className="app-flex-spacer" />
        {/* FR-9: `Open a shell pane beside…` only — a shell pane has nothing to
            convert, which `paneMenuEntries` already drops. */}
        <PaneHeaderMenu index={index} kind="shell" />
        {onClose && (
          <button
            type="button"
            className="split-pane__promote"
            title="Close this pane"
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
          >
            <X size={12} strokeWidth={1.75} />
          </button>
        )}
        {/* unbound-panes FR-6: no `⤢` on a shell pane — promoting to a
            sessionless full-width app is out of scope. */}
      </div>
      <div className="split-pane__body">
        <ProjectShellPane
          projectId={projectId}
          shellId={shellId}
          focused={focused}
          home={home}
          onSpawned={(id) => onShellSpawned?.(id)}
          onClose={onClose}
        />
      </div>
    </section>
  );
}
