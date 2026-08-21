import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { ProjectId, SessionMeta } from '../../../contract/common';

/** What the cursor remembers between renders: where it sat, and on whom. */
export interface RowCursorAnchor {
  index: number;
  /** The cursored session's id — `null` before the cursor has ever resolved. */
  cursoredId: string | null;
}

/**
 * The framework-free core of `useRowCursorClamp`, so the resolution order is
 * unit-testable without a renderer.
 *
 * The cursor follows the *session*, not the index: when the anchored session
 * is still visible, the cursor re-derives as its new index — so a session that
 * moves between roster groups keeps the cursor instead of dropping it on
 * whatever row inherited its slot. Only when that session is gone (filtered
 * out, its group collapsed, the session ended) does it fall back to the older
 * behaviour: keep the index if it is still in range, else the active session's
 * index, else 0.
 */
export function deriveRowCursor(
  visible: readonly SessionMeta[],
  activeSessionId: string | null,
  anchor: RowCursorAnchor,
): RowCursorAnchor {
  if (visible.length === 0) return { index: 0, cursoredId: null };

  const anchored = anchor.cursoredId === null
    ? -1
    : visible.findIndex((session) => session.id === anchor.cursoredId);
  if (anchored >= 0) return { index: anchored, cursoredId: anchor.cursoredId };

  if (anchor.index < visible.length && visible[anchor.index]) {
    return { index: anchor.index, cursoredId: visible[anchor.index].id };
  }

  const activeIdx = visible.findIndex((session) => session.id === activeSessionId);
  const index = activeIdx >= 0 ? activeIdx : 0;
  return { index, cursoredId: visible[index].id };
}

/**
 * Owns the sidebar's keyboard row cursor: re-derived against the visible list
 * on every change (anchored on the cursored session — see `deriveRowCursor`),
 * and reset to 0 on a project-scope change (projects FR-28 — activeSessionId
 * itself is left alone, so the active session stays selected even when the
 * filter hides its card, §7 case 17). Declared as two effects, in this order,
 * so the project-scope reset wins over the clamp on the same render.
 */
export function useRowCursorClamp(
  visible: SessionMeta[],
  activeSessionId: string | null,
  activeProjectId: ProjectId | null,
): [number, Dispatch<SetStateAction<number>>] {
  const [anchor, setAnchor] = useState<RowCursorAnchor>({ index: 0, cursoredId: null });

  // The setter below runs from the j/k handlers, after render, and has to
  // re-anchor onto whichever session the new index lands on.
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  useEffect(() => {
    setAnchor((current) => {
      const next = deriveRowCursor(visible, activeSessionId, current);
      return next.index === current.index && next.cursoredId === current.cursoredId
        ? current
        : next;
    });
  }, [visible, activeSessionId]);

  useEffect(() => {
    setAnchor({ index: 0, cursoredId: null });
  }, [activeProjectId]);

  const setRowCursor: Dispatch<SetStateAction<number>> = (action) => {
    setAnchor((current) => {
      const index = typeof action === 'function' ? action(current.index) : action;
      const list = visibleRef.current;
      return { index, cursoredId: list[index]?.id ?? null };
    });
  };

  return [anchor.index, setRowCursor];
}
