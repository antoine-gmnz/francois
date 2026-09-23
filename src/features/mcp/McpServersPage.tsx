// Settings / MCP servers (Figma 23 · 140:7929, light 142:16828): the project's
// MCP servers as a table — server + launch line, scope, transport, tools, status
// and the one action a row can take.
//
// The rows come from a live session of the project (mcp-settings.ts explains
// why): the focused one when it is in this project, else the project's most
// recent. The session is named under the table so the page never implies a
// config-file view it does not have.
//
// Actions are the ones the core offers today: Retry (mcp_reconnect) on a failed
// server, Approve (mcp_decide) on a `.mcp.json` server awaiting consent, and
// "Approve all" for the first-run banner. "Add server" hands off to the attach
// flow that lives in the MCP tab (the same path as ⌘K → Attach MCP server).

import { useEffect, useMemo, useState } from 'react';
import type { McpServerInfo } from '../../../contract/common';
import type { McpServerDetail } from '../../../contract/mcp-panel';
import { mcpDetail, mcpReconnect } from '../../lib/api';
import { useDelayedFlag } from '../../lib/hooks/useDelayedFlag';
import { useSessionMeta } from '../../lib/hooks/useSessionMeta';
import { sessionCapability } from '../../lib/runtimeCapability';
import { Button } from '../../ui/Button';
import { CapabilityNotice } from '../../ui/CapabilityNotice';
import { Caret } from '../../ui/Loaders';
import { SettingsCard, SettingsHeader, SettingsNote } from '../../ui/Settings';
import { StateIcon } from '../../ui/StateIcon';
import { Tab, TabGroup } from '../../ui/Tab';
import { Tag } from '../../ui/Tag';
import { approvalSummary, approveAllDecision, hasApprovalWork } from './mcp';
import {
  filterMcpServers,
  mcpCheckedLabel,
  mcpHealthSummary,
  mcpScopeCounts,
  mcpStatusView,
  type McpScopeFilter,
} from './mcp-settings';
import { useApprovals, type McpServersFeed } from './useMcpServers';
import './mcp-settings.css';

const SCOPE_TABS: { id: McpScopeFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'project', label: 'Project' },
  { id: 'user', label: 'User' },
  { id: 'local', label: 'Local' },
];

const SCOPE_LABEL: Record<string, string> = { project: 'Project', user: 'User', local: 'Local' };

export interface McpServersPageProps {
  projectName: string | null;
  sessionId: string | null;
  sessionName: string | null;
  feed: McpServersFeed;
  /** Opens the attach flow on `sessionId`. */
  onAddServer: () => void;
}

export default function McpServersPage({ projectName, sessionId, sessionName, feed, onAddServer }: McpServersPageProps) {
  const { servers, setServers, listError, reload, checkedAt } = feed;
  const { approvals, decide, deciding, decideError } = useApprovals(sessionId, reload);
  // Nothing under 300ms — a decision that settles fast never gets a caret flash.
  const showSavingCaret = useDelayedFlag(deciding, 300);
  const capability = sessionCapability(useSessionMeta(sessionId), 'mcp');
  const [filter, setFilter] = useState<McpScopeFilter>('all');
  const [details, setDetails] = useState<Record<string, McpServerDetail>>({});
  const [actionError, setActionError] = useState<string | null>(null);

  // A one-minute tick for "checked 2m ago" — text, not motion.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    setDetails({});
    setActionError(null);
    setFilter('all');
  }, [sessionId]);

  // Transport + launch line per server (mcp_detail), fetched once per name.
  const names = servers.map((s) => s.name).join('\n');
  useEffect(() => {
    if (!sessionId) return;
    let live = true;
    for (const name of names ? names.split('\n') : []) {
      if (details[name]) continue;
      void mcpDetail(sessionId, name)
        .then((res) => {
          if (live && res.ok) setDetails((prev) => ({ ...prev, [name]: res.data }));
        })
        .catch(() => {});
    }
    return () => {
      live = false;
    };
    // `details` is read to skip names already fetched; re-running on it would refetch nothing new.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, names]);

  const counts = useMemo(() => mcpScopeCounts(servers), [servers]);
  const rows = filterMcpServers(servers, filter);
  const summary = mcpHealthSummary(servers);
  const checked = mcpCheckedLabel(checkedAt, now);
  const canAdd = sessionId !== null && capability.available;

  const retry = (server: McpServerInfo) => {
    if (!sessionId) return;
    setActionError(null);
    setServers((prev) =>
      prev.map((s) => (s.name === server.name ? { ...s, status: 'connecting', toolCount: undefined, errorMessage: undefined } : s)),
    );
    void mcpReconnect(sessionId, server.name)
      .then((res) => {
        if (!res.ok) {
          setActionError(res.error.message);
          reload();
        }
      })
      .catch(() => setActionError('Could not reach the core'));
  };

  const approve = (server: McpServerInfo) =>
    void decide({ approve: [server.name], reject: [], trust: approvals?.trustRequired ?? false });

  const lede = (
    <>
      Servers the sessions in {projectName ?? 'this project'} start with. Project servers come from <code>.mcp.json</code>; user
      servers from your Claude config.
    </>
  );

  return (
    <div className="mcps-page">
      <SettingsHeader
        crumbs={[projectName ?? 'Project', 'MCP servers']}
        title="MCP servers"
        lede={lede}
        action={
          <Button
            variant="primary"
            disabled={!canAdd}
            title={canAdd ? `Attach a server to ${sessionName ?? 'this session'}` : (capability.reason ?? 'Start a session in this project first')}
            onClick={onAddServer}
          >
            Add server
          </Button>
        }
      />

      {!projectName ? (
        <SettingsNote>Pick a project in the sidebar to see its MCP servers.</SettingsNote>
      ) : !sessionId ? (
        <SettingsNote>
          No session is running in {projectName}. MCP servers are resolved per session — start one to see them here.
        </SettingsNote>
      ) : !capability.available ? (
        <CapabilityNotice reason={capability.reason ?? ''} />
      ) : (
        <>
          <div className="mcps-filters">
            <TabGroup label="Scope">
              {SCOPE_TABS.filter((t) => t.id === 'all' || t.id !== 'local' || counts.local > 0).map((t) => (
                <Tab key={t.id} selected={filter === t.id} onSelect={() => setFilter(t.id)} count={counts[t.id]}>
                  {t.label}
                </Tab>
              ))}
            </TabGroup>
            <span className="mcps-filters__spacer" />
            {summary.text && (
              <span className="mcps-summary">
                <StateIcon kind={summary.failing ? 'failed' : 'done'} size={13} />
                {[summary.text, checked].filter(Boolean).join(' · ')}
              </span>
            )}
          </div>

          {hasApprovalWork(approvals) && approvals && (
            <SettingsCard
              title={approvalSummary(approvals)}
              description={decideError?.message ?? 'Claude Code asks before it starts these. They take effect on the session’s next turn.'}
            >
              <Button variant="attention" disabled={deciding} onClick={() => void decide(approveAllDecision(approvals))}>
                {showSavingCaret ? <Caret>Saving</Caret> : 'Approve all'}
              </Button>
            </SettingsCard>
          )}

          {listError ? (
            <SettingsNote>Session unavailable — {listError.message}</SettingsNote>
          ) : (
            <div className="mcps-table" role="table" aria-label="MCP servers">
              <div className="mcps-row mcps-row--head" role="row">
                <span role="columnheader">Server</span>
                <span role="columnheader">Scope</span>
                <span role="columnheader">Transport</span>
                <span role="columnheader">Tools</span>
                <span role="columnheader">Status</span>
                <span role="columnheader" aria-label="Action" />
              </div>
              {rows.length === 0 ? (
                <div className="mcps-empty">{servers.length === 0 ? 'No MCP servers in this session.' : 'None in this scope.'}</div>
              ) : (
                rows.map((server) => (
                  <ServerRow
                    key={server.name}
                    server={server}
                    detail={details[server.name]}
                    busy={deciding}
                    onRetry={() => retry(server)}
                    onApprove={() => approve(server)}
                  />
                ))
              )}
            </div>
          )}
          {actionError && <div className="mcps-error">{actionError}</div>}
        </>
      )}

      <SettingsNote>
        {sessionName ? <>Showing the servers of {sessionName}. </> : null}
        Attach a server to a running session from <code>⌘K → Attach MCP server</code>.
      </SettingsNote>
    </div>
  );
}

function ServerRow({
  server,
  detail,
  busy,
  onRetry,
  onApprove,
}: {
  server: McpServerInfo;
  detail: McpServerDetail | undefined;
  busy: boolean;
  onRetry: () => void;
  onApprove: () => void;
}) {
  const status = mcpStatusView(server);
  const launch = detail ? (detail.transport === 'http' ? detail.url : detail.command) : undefined;
  const classes = ['mcps-row'];
  if (server.status === 'error') classes.push('mcps-row--failed');
  if (server.status === 'rejected') classes.push('mcps-row--off');
  return (
    <div className={classes.join(' ')} role="row">
      <span className="mcps-server" role="cell">
        <span className="mcps-server__name">{server.name}</span>
        {launch && (
          <span className="mcps-server__launch" title={launch}>
            {launch}
          </span>
        )}
      </span>
      <span role="cell">{server.scope && <Tag>{SCOPE_LABEL[server.scope] ?? server.scope}</Tag>}</span>
      <span className="mcps-mono mcps-mono--muted" role="cell">
        {detail?.transport ?? ''}
      </span>
      <span className="mcps-mono" role="cell">
        {server.toolCount ?? '—'}
      </span>
      <span className={`mcps-status mcps-status--${status.tone}`} role="cell" title={status.text}>
        <StateIcon kind={status.kind} size={13} />
        <span className="mcps-status__text">{status.text}</span>
      </span>
      <span className="mcps-action" role="cell">
        {server.status === 'error' && (
          <Button variant="primary" size="sm" onClick={onRetry}>
            Retry
          </Button>
        )}
        {(server.status === 'pending' || server.status === 'rejected') && (
          <Button size="sm" disabled={busy} onClick={onApprove}>
            Approve
          </Button>
        )}
      </span>
    </div>
  );
}
