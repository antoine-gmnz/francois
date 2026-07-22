// slash-menu §8 — the "/" autocomplete popup, anchored above the SESSION
// composer input bar. Display-only chrome: it NEVER takes focus (the composer
// keeps it — mousedown is swallowed), so the pane focus model and 1–5 keys are
// untouched. All state lives in ConversationView; this renders rows, keeps the
// selected one scrolled into view (FR-7), and reports hover/click/outside-click.

import { useEffect, useRef } from 'react';
import type { SlashCommandInfo } from '../contract/common';
import { sourceTag } from './slash-menu';

interface SlashMenuProps {
  /** Filtered registry rows, verbatim (FR-11). */
  items: SlashCommandInfo[];
  selIdx: number;
  /** Hover selects (FR-7) — fired on real pointer movement only, so wheel scrolling never moves the selection (§8). */
  onHover: (idx: number) => void;
  /** Click = Enter (FR-8): run the row's command through the normal send path. */
  onRun: (name: string) => void;
  /** Outside click dismisses identically to Esc (FR-9). */
  onDismiss: () => void;
}

export default function SlashMenu({ items, selIdx, onHover, onRun, onDismiss }: SlashMenuProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;

  // FR-9: any mousedown outside the popup dismisses (capture phase, so a
  // transcript click that stops propagation still dismisses — edge 10).
  useEffect(() => {
    const onDown = (ev: MouseEvent) => {
      const root = rootRef.current;
      if (root && !root.contains(ev.target as Node)) dismissRef.current();
    };
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, []);

  // FR-7: the selected row stays scrolled into view (max ~8 rows, then scroll).
  useEffect(() => {
    const row = rootRef.current?.children[selIdx] as HTMLElement | undefined;
    row?.scrollIntoView({ block: 'nearest' });
  }, [selIdx, items]);

  return (
    <div ref={rootRef} className="slash-menu scz" onMouseDown={(e) => e.preventDefault()}>
      {items.map((c, i) => (
        <div
          key={c.name}
          className={i === selIdx ? 'slash-row slash-row-sel' : 'slash-row'}
          onMouseMove={() => {
            if (i !== selIdx) onHover(i);
          }}
          onClick={() => onRun(c.name)}
        >
          <span className="slash-name">/{c.name}</span>
          <span className="slash-desc">{c.description}</span>
          <span className="slash-tag">{sourceTag(c)}</span>
        </div>
      ))}
    </div>
  );
}
