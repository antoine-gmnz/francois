import { useEffect, useState } from 'react';
import { setPaletteDiffCount } from '../features/palette/paletteData';
import { diffGetSummary, onDiffEvent } from '../lib/api';

/**
 * DIFF-tab badge: fileCount for the active session, seeded by getSummary and
 * kept current by diff.changed events (diff-view FR-18). Also keeps the
 * palette's view-diff hint at 0 with no active session (FR-21/§7).
 *
 * Uses a LOCAL mounted guard, fresh per effect run — NOT the shared
 * `useMounted()` hook. This effect's deps are `[activeSessionId]` on a
 * component that never remounts, so a component-lifetime guard would let a
 * stale promise from the PREVIOUS session apply after a switch (see
 * REFACTOR-CONVENTIONS.md's "known gaps").
 */
export function useDiffBadge(activeSessionId: string | null): number {
  const [diffCount, setDiffCount] = useState(0);

  useEffect(() => {
    setDiffCount(0);
    setPaletteDiffCount(0);
    if (!activeSessionId) return;
    const mounted = { current: true };
    let unlisten: (() => void) | undefined;
    void diffGetSummary(activeSessionId).then((res) => {
      if (mounted.current && res.ok) {
        setDiffCount(res.data.files.length);
        setPaletteDiffCount(res.data.files.length);
      }
    });
    void onDiffEvent((e) => {
      if (e.type === 'diff.changed' && e.sessionId === activeSessionId && mounted.current) {
        setDiffCount(e.fileCount);
        setPaletteDiffCount(e.fileCount);
      }
    }).then((unsub) => {
      if (!mounted.current) unsub();
      else unlisten = unsub;
    });
    return () => {
      mounted.current = false;
      if (unlisten) unlisten();
    };
  }, [activeSessionId]);

  return diffCount;
}
