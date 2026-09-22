import { useCallback, useState } from 'react';
import type { ProjectId } from '../../contract/common';
import type { ShellId } from '../../contract/shell-terminal';
import { formatContextTokens, formatElapsed } from '../../contract/conversation-view';
import { isBusyStatus } from '../../contract/fleet-board';
import AgentView from '../features/agents/AgentView';
import { agentIdFromTab, tabIdFor, tabsForSession, workflowIdFromTab } from '../lib/agent-tab';
import ConversationView from '../features/conversation/ConversationView';
import DiffView from '../features/diff/DiffView';
import ProjectPickerPopover from '../features/projects/ProjectPickerPopover';
import { projectMarker } from '../features/projects/projectMarker';
import WorkflowView from '../features/workflows/WorkflowView';
import { shellPaneEligibleProjects, type PaneSlot, type PaneTab } from '../lib/layoutStore';
import { useElapsedClock } from '../lib/hooks/useElapsedClock';
import { useStore } from '../lib/store';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { IconButton } from '../ui/IconButton';
import { StateIcon } from '../ui/StateIcon';
import AgentTabChip from './AgentTabChip';
import EmptyPaneMessage from './EmptyPaneMessage';
import PaneHeaderMenu from './PaneHeaderMenu';
import ProjectShellPane from './ProjectShellPane';
import ShellTabView from './ShellTabView';
import { PANE_TABS, paneStatusText } from './split-pane';
import './split-pane.css';

export interface SplitPaneProps {
  /** 0-based. Rendered 1-based in the grid chrome (FR-7) and named by ⌘<n>. */
  index: number;
  /** unbound-panes FR-4/§5: the pane's whole content, in place of sessionId/tab. */
  slot: PaneSlot;
  focused: boolean;
  /**
   * split-by-4 FR-9: the grid regime (three panes and up). The header keeps the
   * built-in tabs but drops the dynamic agent/workflow ones (`denseTab`), and an
   * unfocused pane's footer carries the state instead of a composer (FR-11).
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

/**
 * split-by-4 FR-7..FR-11 / unbound-panes FR-6 — one main pane, drawn to Figma
 * "Graphite & Signal" 13 · Split (137:6133) and 14 · Grid (137:6338).
 *
 * A `session` slot's header is ONE 40px row: state glyph, name, the live clock
 * or a state word, the underlined Conversation / Changes / Terminal tabs (plus,
 * at two panes, the session's agent/workflow tabs), then context tokens, the
 * session-panel toggle, `⋯`, maximize and close. The grid regime keeps the same
 * header — the built-in tabs included, since `denseTab` only ever flattens the
 * DYNAMIC tabs — and still trades an unfocused pane's composer for the footer
 * (FR-11: one composer on screen).
 *
 * Focus is the pane's 1px strong outline (Figma: the focused pane is the one
 * framed in line/strong); `aria-current` says it to assistive tech.
 *
 * A `shell` slot (unbound-panes FR-6) renders a DIFFERENT header — terminal
 * glyph, project marker, project name, ✕ only, no `⤢`, no tab strip in either
 * regime — and `ProjectShellPane`'s body.
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
  // quality fix: a stable callback so ConversationView's `onOpenShell` prop
  // does not break the Turn/Block/ToolRow shallow-memo chain on every render.
  const openShell = useCallback(() => onTab('shell'), [onTab]);

  // FR-11: "finished" is the footer state that offers a diff and a close — a
  // session with no turn in flight. isBusyStatus covers the two parked states
  // too, so a pane waiting on an approval keeps the `⌘<n> to focus` hint.
  const settled = !!session && !isBusyStatus(session.status);
  const status = session ? paneStatusText(session.status) : null;
  // The clock ticks only while THIS pane's turn is in flight.
  const clockNow = useElapsedClock(status?.kind === 'clock');
  const showSessionPanel = useStore((s) => s.showSessionPanel);
  const toggleSessionPanel = useStore((s) => s.toggleSessionPanel);
  // stopPropagation: the pane's own click handler would otherwise re-focus this
  // pane AFTER the action has already moved focus.
  const stop = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    fn();
  };

  return (
    <section
      onClick={onFocus}
      style={area}
      className={['split-pane', focused ? 'split-pane--focused' : null, dense ? 'split-pane--dense' : null]
        .filter(Boolean)
        .join(' ')}
      aria-current={focused || undefined}
      aria-label={`pane ${index + 1}${session ? ` — ${session.name}` : ''}`}
      data-pane={index}
    >
      <div className="split-pane__header">
        {session && <StateIcon status={session.status} size={13} />}
        {/* unbound-panes FR-14: the neutral project marker, immediately left of
            the session name — `‹repo› name`. Never accent. */}
        {project && (
          <span className="split-pane__marker" title={project.name}>
            {projectMarker(project.name)}
          </span>
        )}
        <span className="split-pane__name truncate" title={session ? `${session.name} · ⌘${index + 1}` : undefined}>
          {session?.name ?? `pane ${index + 1}`}
        </span>
        {session && status && (
          <span className={`split-pane__status split-pane__status--${status.tone}`}>
            {status.kind === 'clock' ? formatElapsed(clockNow - session.startedAt) : status.text}
          </span>
        )}

        {session && (
          <div className="split-pane__tabs" role="tablist" aria-label="pane views">
            {PANE_TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={t.id === tab}
                onClick={() => onTab(t.id)}
                className={t.id === tab ? 'split-tab split-tab--on' : 'split-tab'}
              >
                {t.label}
                {/* FR-8: the same count, scoped to THIS pane's session. */}
                {t.id === 'diff' && diffCount > 0 && <span className="split-tab__count">{diffCount}</span>}
              </button>
            ))}
            {/* fix-agent-view FR-12: THIS pane's session's agent and workflow
                tabs, after Terminal. Only in the two-pane regime: the grid
                flattens a dynamic tab (FR-13), which is why `openAgentTab`
                refuses to open one there. */}
            {!dense &&
              agentTabs.map((t) => (
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

        <span className="split-pane__spacer" />
        {session && <span className="split-pane__ctx">{formatContextTokens(session.contextUsedTokens)}</span>}
        {session && (
          <IconButton
            size={24}
            on={focused && showSessionPanel}
            title={focused && showSessionPanel ? 'Hide the session panel · ]' : 'Show the session panel · ]'}
            onClick={stop(() => {
              // The panel follows the focused pane: on an unfocused pane the
              // click focuses it (which is what shows ITS panel), and only
              // opens the panel if it was closed.
              if (!focused) onFocus();
              if (focused || !showSessionPanel) toggleSessionPanel();
            })}
          >
            <Icon name="panel-right" size={13} />
          </IconButton>
        )}
        {/* unbound-panes FR-9 / design brief flow 4 — the `⋯` menu. Before ⤢
            so the two irreversible-ish actions (promote, close) stay rightmost. */}
        <PaneHeaderMenu index={index} kind="session" onConvertToShell={onConvertToShell} />
        {session && (
          <IconButton size={24} title="Expand to full width" onClick={stop(onPromote)}>
            <Icon name="maximize" size={13} />
          </IconButton>
        )}
        {onClose && (
          <IconButton size={24} title="Close this pane" onClick={stop(onClose)}>
            <Icon name="x" size={11} />
          </IconButton>
        )}
      </div>

      {/* body */}
      <div className="split-pane__body">
        {!session ? (
          <EmptyPaneBody index={index} onConvertToShell={onConvertToShell} />
        ) : agentId !== null ? (
          // fix-agent-view FR-16: the SAME AgentView the single pane renders,
          // keyed by agent so switching tabs remounts rather than leaking the
          // previous transcript. FR-17: "Back to session" returns THIS pane.
          // Unreachable while `dense` — paneTabAt flattens a dynamic tab there.
          <AgentView
            key={agentId}
            agentId={agentId}
            sessionId={session.id}
            onBack={() => onTab('session')}
            escapeToBack={focused}
          />
        ) : runId !== null ? (
          <WorkflowView key={runId} runId={runId} sessionId={session.id} />
        ) : tab === 'session' ? (
          <ConversationView
            key={session.id}
            sessionId={session.id}
            inert={!focused}
            onFocusRequest={onFocus}
            // command-inspect FR-16: THIS pane's own tab switch — the shell
            // button's click bubbles to the section's onClick={onFocus} above,
            // so opening the shell also focuses this pane, same as the tab strip.
            onOpenShell={openShell}
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
        <div className="split-pane__empty-title">Pane {index + 1} is empty</div>
        <div className="split-pane__empty-hint">Start a new session here, or open a shell.</div>
        <div className="split-pane__empty-choices">
          {/* Deliberately NOT stopPropagation, unlike ⤢/✕/Review diff: the click
              must also reach the pane's own handler so this pane takes focus,
              which is what routes the created session here (App's onCreated →
              FR-19). */}
          {/* Labeled for what the click actually does — opens the NEW session
              modal, not a picker over existing sessions (no such picker
              exists; fix loop round 4). */}
          <Button size="sm" onClick={() => setNewSessionOpen(true)}>
            <Icon name="plus" size={12} />
            New session
          </Button>
          {/* FR-8: pane 0 is always a session pane — `convertPaneToShell` is a
              no-op there, mirroring `paneMenuEntries`'s own index-0 exclusion. */}
          {index !== 0 && onConvertToShell && (
            <span className="split-pane__empty-choice-anchor">
              <Button
                size="sm"
                variant="ghost"
                onClick={(e) => {
                  e.stopPropagation();
                  if (projects.length === 1) onConvertToShell(projects[0].id);
                  else setPicking(true);
                }}
              >
                <Icon name="terminal" size={12} />
                Open a shell here
              </Button>
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
        <Button size="sm" onClick={stop(onReviewDiff)}>
          Review changes
          {diffCount > 0 && <span className="pane-footer__count">{diffCount}</span>}
        </Button>
      ) : (
        <span className="pane-footer__hint">
          <kbd className="pane-footer__key">⌘{index + 1}</kbd> to focus and type
        </span>
      )}
      <span className="split-pane__spacer" />
      {onClose && (
        <Button size="sm" variant="ghost" title="Close this pane" onClick={stop(onClose)}>
          Close pane
        </Button>
      )}
    </div>
  );
}

/**
 * unbound-panes FR-6/FR-11 — a `kind: 'shell'` pane's whole chrome: header
 * (terminal glyph, project marker, project name, ✕ — no `⤢`, no state glyph,
 * no context tokens, no tab strip in either regime) plus `ProjectShellPane`'s
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
      className={focused ? 'split-pane split-pane--focused' : 'split-pane'}
      aria-current={focused || undefined}
      aria-label={`pane ${index + 1} — shell`}
      data-pane={index}
    >
      <div className="split-pane__header">
        {/* dense/split share the same header for a shell pane — no dense-only branch. */}
        <Icon name="terminal" size={13} className="split-pane__shell-glyph" />
        {project && (
          <span className="split-pane__marker" title={project.name}>
            {projectMarker(project.name)}
          </span>
        )}
        <span className="split-pane__name truncate" title={project ? `${project.name} · ⌘${index + 1}` : undefined}>
          {project?.name ?? 'shell'}
        </span>
        <span className="split-pane__status split-pane__status--faint">shell</span>
        <span className="split-pane__spacer" />
        {/* FR-9: `Open a shell pane beside…` only — a shell pane has nothing to
            convert, which `paneMenuEntries` already drops. */}
        <PaneHeaderMenu index={index} kind="shell" />
        {onClose && (
          <IconButton
            size={24}
            title="Close this pane"
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
          >
            <Icon name="x" size={11} />
          </IconButton>
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
