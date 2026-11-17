// claude-project-health — probe on session open/switch (the view stays mounted
// behind `display: none`, so "switch" is `visible` turning true), never per
// render. Renders the per-session cache immediately, then the fresh answer.

import { useCallback, useEffect, useState } from 'react';
import type { ClaudeProjectHealth } from '../../../contract/claude-project-health';
import { cachedProjectHealth, probeProjectHealth } from './project-health';

export function useProjectHealth(sessionId: string, visible: boolean) {
  const [health, setHealth] = useState<ClaudeProjectHealth | null>(() => cachedProjectHealth(sessionId));

  useEffect(() => {
    if (!visible) return;
    let live = true;
    setHealth(cachedProjectHealth(sessionId));
    probeProjectHealth(sessionId)
      .then((h) => live && setHealth(h))
      .catch(() => {
        /* a failed probe shows nothing new */
      });
    return () => {
      live = false;
    };
  }, [sessionId, visible]);

  /** Re-read the cache after an action that updated it (the trust click). */
  const refresh = useCallback(() => setHealth(cachedProjectHealth(sessionId)), [sessionId]);

  return { health, refresh };
}
