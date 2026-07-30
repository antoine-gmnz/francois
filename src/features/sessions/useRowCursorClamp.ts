import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import type { ProjectId, SessionMeta } from '../../../contract/common';

/**
 * Owns the sidebar's keyboard row cursor: clamped into range on list/selection
 * changes (FR-18), and reset to 0 on a project-scope change (projects FR-28 —
 * activeSessionId itself is left alone, so the active session stays selected
 * even when the filter hides its card, §7 case 17). Declared as two effects,
 * in this order, so the project-scope reset wins over the clamp on the same
 * render.
 */
export function useRowCursorClamp(
  visible: SessionMeta[],
  activeSessionId: string | null,
  activeProjectId: ProjectId | null,
): [number, Dispatch<SetStateAction<number>>] {
  const [rowCursor, setRowCursor] = useState(0);

  useEffect(() => {
    if (visible.length === 0) {
      setRowCursor(0);
      return;
    }
    setRowCursor((c) => {
      if (c < visible.length && visible[c]) return c;
      const activeIdx = visible.findIndex((s) => s.id === activeSessionId);
      return activeIdx >= 0 ? activeIdx : 0;
    });
  }, [visible, activeSessionId]);

  useEffect(() => {
    setRowCursor(0);
  }, [activeProjectId]);

  return [rowCursor, setRowCursor];
}
