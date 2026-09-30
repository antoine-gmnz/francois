import type { Dispatch, SetStateAction } from 'react';
import type { AppError, McpServerInfo, Result, SessionEvent } from '../../../contract/common';
import { startHydratedSubscription } from '../../lib/hooks/useHydratedSubscription';

interface McpFeedOptions {
  sessionId: string;
  subscribe: (callback: (event: SessionEvent) => void) => Promise<() => void>;
  fetch: () => Promise<Result<McpServerInfo[]>>;
  setServers: Dispatch<SetStateAction<McpServerInfo[]>>;
  onError: (error: AppError) => void;
  onLoaded: () => void;
}

/** Both MCP views use the same subscription-before-snapshot ordering. */
export function startMcpFeed({ sessionId, subscribe, fetch, setServers, onError, onLoaded }: McpFeedOptions): () => void {
  let fetchError: AppError | null = null;
  return startHydratedSubscription({
    subscribe,
    fetchInitial: async () => {
      const result = await fetch();
      if (!result.ok) fetchError = result.error;
      return result;
    },
    isRelevant: event => event.type === 'mcp.update' && event.sessionId === sessionId,
    onHydrated: rows => { setServers(rows); onLoaded(); },
    onEvent: event => {
      if (event.type !== 'mcp.update') return;
      setServers(previous => {
        const index = previous.findIndex(row => row.name === event.server.name);
        if (index === -1) return [...previous, event.server];
        const next = previous.slice();
        next[index] = { ...event.server, scope: event.server.scope ?? previous[index].scope };
        return next;
      });
    },
    onError: message => { onError(fetchError ?? { code: 'INTERNAL', message }); onLoaded(); },
  });
}
