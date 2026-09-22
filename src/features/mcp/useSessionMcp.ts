// The focused session's MCP servers for the session panel's Context section:
// hydrate with `mcp_list`, then keep live on `mcp.update` — the same two sources
// the MCP main tab reads, through the one session-event router. `reload` re-reads
// after a Retry / Detach, whose outcome arrives as a status the core resolves.

import { useCallback, useEffect, useState } from 'react';
import type { AppError, McpServerInfo, SessionEvent } from '../../../contract/common';
import { mcpList } from '../../lib/api';
import { subscribeSessionEvents } from '../../lib/session-events';

export function useSessionMcp(sessionId: string) {
  const [servers, setServers] = useState<McpServerInfo[]>([]);
  const [error, setError] = useState<AppError | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [reloads, setReloads] = useState(0);
  const reload = useCallback(() => setReloads((n) => n + 1), []);

  useEffect(() => {
    let mounted = true;
    let unlisten: (() => void) | undefined;
    setError(null);

    void subscribeSessionEvents(sessionId, (e: SessionEvent) => {
      if (e.type !== 'mcp.update' || e.sessionId !== sessionId) return;
      setServers((prev) => {
        const i = prev.findIndex((s) => s.name === e.server.name);
        if (i === -1) return [...prev, e.server];
        const next = prev.slice();
        // runtime updates carry no scope — keep the one mcp_list resolved.
        next[i] = { ...e.server, scope: e.server.scope ?? prev[i].scope };
        return next;
      });
    }).then((unsub) => {
      if (!mounted) unsub();
      else unlisten = unsub;
    });

    void mcpList(sessionId).then((res) => {
      if (!mounted) return;
      setLoaded(true);
      if (res.ok) setServers(res.data);
      else setError(res.error);
    });

    return () => {
      mounted = false;
      if (unlisten) unlisten();
    };
  }, [sessionId, reloads]);

  return { servers, error, loaded, reload };
}
