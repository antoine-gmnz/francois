// mcp — the two per-session reads pane [4] (McpPanel) and Settings / MCP
// servers (McpServersPage) share: the server list (hydrated by mcp_list, kept
// live by mcp.update) and the project's first-run approval state. Moved out of
// McpPanel.tsx so both surfaces subscribe the same way.

import { useCallback, useEffect, useState } from 'react';
import type { AppError, McpServerInfo, SessionEvent } from '../../../contract/common';
import type { McpApprovalState, McpDecision } from '../../../contract/mcp-panel';
import { mcpApprovals, mcpDecide, mcpList } from '../../lib/api';
import { subscribeSessionEvents } from '../../lib/session-events';

// ---------- server list hook ----------

export function useMcpServers(sessionId: string | null) {
  const [servers, setServers] = useState<McpServerInfo[]>([]);
  const [listError, setListError] = useState<AppError | null>(null);
  // Bumped after a decision: approving a server changes its row's status, and the
  // status is resolved in the core (against ~/.claude.json), not derivable here.
  const [reloads, setReloads] = useState(0);
  const reload = useCallback(() => setReloads((n) => n + 1), []);
  // When mcp_list last answered — the settings page's "checked 2m ago".
  const [checkedAt, setCheckedAt] = useState<number | null>(null);

  // Hydration + live mcp.update (FR-1/2/3/28).
  useEffect(() => {
    setServers([]);
    setListError(null);
    setCheckedAt(null);
    if (!sessionId) return;
    let mounted = true;
    let unlisten: (() => void) | undefined;

    // transcript-scale FR-21: through the one router subscription, scoped to
    // this session.
    void subscribeSessionEvents(sessionId, (e: SessionEvent) => {
      if (e.type !== 'mcp.update' || e.sessionId !== sessionId) return;
      setServers((prev) => {
        const i = prev.findIndex((server) => server.name === e.server.name);
        if (i === -1) return [...prev, e.server];
        const next = prev.slice();
        // runtime updates don't carry scope — keep the one mcp_list resolved.
        next[i] = { ...e.server, scope: e.server.scope ?? prev[i].scope };
        return next;
      });
    }).then((unsub) => {
      if (!mounted) unsub();
      else unlisten = unsub;
    });

    void mcpList(sessionId).then((res) => {
      if (!mounted) return; // FR-28
      if (res.ok) setServers(res.data);
      else setListError(res.error);
      setCheckedAt(Date.now());
    });

    return () => {
      mounted = false;
      if (unlisten) unlisten();
    };
  }, [sessionId, reloads]);

  return { servers, setServers, listError, reload, checkedAt };
}

// ---------- first-run approval hook ----------

/**
 * The project's MCP-consent / folder-trust state, and the one call that answers
 * it. Kept beside the server list rather than folded into it because the two
 * answer different questions: `mcp_list` says what each server IS doing,
 * `mcp_approvals` says what Claude Code will ASK before any of them can.
 */
export function useApprovals(sessionId: string | null, onDecided: () => void) {
  const [approvals, setApprovals] = useState<McpApprovalState | null>(null);
  const [deciding, setDeciding] = useState(false);
  const [decideError, setDecideError] = useState<AppError | null>(null);

  useEffect(() => {
    setApprovals(null);
    setDecideError(null);
    if (!sessionId) return;
    let mounted = true;
    void mcpApprovals(sessionId).then((res) => {
      if (mounted && res.ok) setApprovals(res.data);
    });
    return () => {
      mounted = false;
    };
  }, [sessionId]);

  const decide = useCallback(
    async (decision: McpDecision) => {
      if (!sessionId || deciding) return;
      setDeciding(true);
      setDecideError(null);
      const res = await mcpDecide(sessionId, decision);
      if (res.ok) {
        setApprovals(res.data);
        // The rows carry the approval status, so they have to be re-read too.
        onDecided();
      } else setDecideError(res.error);
      setDeciding(false);
    },
    [sessionId, deciding, onDecided],
  );

  return { approvals, decide, deciding, decideError };
}


/** What `useMcpServers` hands a surface — the settings page takes it as a prop. */
export type McpServersFeed = ReturnType<typeof useMcpServers>;
