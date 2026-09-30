// The focused session's MCP servers for the session panel's Context section:
// hydrate with `mcp_list`, then keep live on `mcp.update` — the same two sources
// the MCP main tab reads, through the one session-event router. `reload` re-reads
// after a Retry / Detach, whose outcome arrives as a status the core resolves.

import { useCallback, useEffect, useState } from 'react';
import type { AppError, McpServerInfo } from '../../../contract/common';
import { mcpList } from '../../lib/api';
import { subscribeSessionEvents } from '../../lib/session-events';
import { startMcpFeed } from './mcp-feed';

export function useSessionMcp(sessionId: string) {
  const [servers, setServers] = useState<McpServerInfo[]>([]);
  const [error, setError] = useState<AppError | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [reloads, setReloads] = useState(0);
  const reload = useCallback(() => setReloads((n) => n + 1), []);

  useEffect(() => {
    setServers([]);
    setError(null);
    setLoaded(false);
    return startMcpFeed({
      sessionId,
      subscribe: callback => subscribeSessionEvents(sessionId, callback),
      fetch: () => mcpList(sessionId),
      setServers,
      onError: setError,
      onLoaded: () => setLoaded(true),
    });
  }, [sessionId, reloads]);

  return { servers, error, loaded, reload };
}
