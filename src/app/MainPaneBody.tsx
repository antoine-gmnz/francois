import { useCallback, type ReactNode } from 'react';
import type { SessionMeta } from '../../contract/common';
import AgentView from '../features/agents/AgentView';
import { workflowIdFromTab } from '../features/agents/agent-tab';
import ConversationView from '../features/conversation/ConversationView';
import DiffView from '../features/diff/DiffView';
import type { ExtensionId } from '../../contract/extensions';
import ExtensionView from '../features/extensions/ExtensionView';
import { extIdFromTab } from '../features/extensions/extensions';
import WorkflowView from '../features/workflows/WorkflowView';
import OverviewView from '../features/overview/OverviewView';
import type { MainTab } from '../lib/store';
import { mainPaneBranch, type MainPaneBranch } from './appShell';
import EmptyPaneMessage from './EmptyPaneMessage';
import ShellTabView from './ShellTabView';

export interface MainPaneBodyProps {
  mainTab: MainTab;
  activeAgentId: string | null;
  active: SessionMeta | null;
  home: string;
  /** fix-agent-view FR-17: what an agent tab's "Back to session" returns to. */
  setMainTab: (tab: MainTab) => void;
  /** extensions FR-13: the project name the `not available in <x>` copy names. */
  projectName: string | null;
}

/** The main pane's body: one renderer per `MainTab` (Phase 5 dispatch table),
 * with the dynamic `agent:<id>` tabs handled explicitly since they are not a
 * plain `MainTab` key the table can be built over. */
export default function MainPaneBody({ mainTab, activeAgentId, active, home, setMainTab, projectName }: MainPaneBodyProps) {
  const branch = mainPaneBranch(mainTab);
  // quality fix: a stable callback so ConversationView's `onOpenShell` prop
  // does not break the Turn/Block/ToolRow shallow-memo chain on every render.
  const openShell = useCallback(() => setMainTab('shell'), [setMainTab]);

  if (branch === 'ext') {
    // extensions FR-15: keyed by extension id, so switching extension tabs
    // remounts rather than leaking the previous one's sections. Unlike the two
    // dynamic tabs below it, this one does NOT need a session (FR-14: fleet
    // panels still load, project panels read `select a session`).
    // extIdFromTab cannot return null here: mainPaneBranch(mainTab) === 'ext'
    // and extIdFromTab share the same prefix test, so a non-null extensionId
    // is guaranteed.
    const extensionId = extIdFromTab(mainTab) as ExtensionId;
    return (
      <ExtensionView
        key={extensionId}
        extensionId={extensionId}
        root={active?.cwd ?? null}
        sessionId={active?.id ?? null}
        projectName={projectName}
      />
    );
  }

  if (branch === 'agent') {
    // agent-tab: one subagent's own conversation. Keyed by agent so
    // switching tabs remounts rather than leaking the previous state. The
    // session is always present here (FR-14 closes agent tabs when it
    // changes) — the fallback only guards a dangling id.
    return active && activeAgentId !== null ? (
      <AgentView key={activeAgentId} agentId={activeAgentId} sessionId={active.id} onBack={() => setMainTab('session')} />
    ) : (
      <EmptyPaneMessage>select a session</EmptyPaneMessage>
    );
  }

  if (branch === 'workflow') {
    // workflow-details FR-11: one `Workflow` run's agents, spans and
    // transcripts. Keyed by run so switching tabs remounts rather than leaking
    // the previous run's detail; the session is always present here (FR-13
    // closes workflow tabs when it changes).
    const runId = workflowIdFromTab(mainTab);
    return active && runId !== null ? (
      <WorkflowView key={runId} runId={runId} sessionId={active.id} />
    ) : (
      <EmptyPaneMessage>select a session</EmptyPaneMessage>
    );
  }

  const renderers: Record<Exclude<MainPaneBranch, 'agent' | 'workflow' | 'ext'>, () => ReactNode> = {
    // design 7a: the four dissolved panes are rendered by App.tsx's persistent
    // host, not here — they must not unmount on a tab switch (their feeds
    // publish the counts the roster rows read).
    panel: () => null,
    overview: () => <OverviewView home={home} />,
    session: () =>
      active ? (
        // command-inspect FR-16: this IS the `main` pane, so its own setMainTab
        // is the pane-scoped switch — no global setFocusedPane needed here.
        <ConversationView key={active.id} sessionId={active.id} onOpenShell={openShell} />
      ) : (
        <EmptyPaneMessage>
          select a session, or press <span className="app-inline-key">n</span> to start one
        </EmptyPaneMessage>
      ),
    diff: () =>
      active ? (
        <DiffView key={active.id} sessionId={active.id} />
      ) : (
        <EmptyPaneMessage>select a session to review its changes</EmptyPaneMessage>
      ),
    shell: () =>
      active ? (
        <ShellTabView key={active.id} sessionId={active.id} home={home} />
      ) : (
        <EmptyPaneMessage>select a session to open its shell</EmptyPaneMessage>
      ),
  };

  return renderers[branch]();
}
